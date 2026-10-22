// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Recovery boundary fixtures cover foreign schemas, null logs, busy files and explicit registry configuration.
// ABOUTME: The same positive path creates referee state before judging owner-role edits and preserves source bytes.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { spawn } from 'child_process';
import { once } from 'events';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { finalizeRecovery, recoveryIntake, recoveryPlan } from '../../src/referee';
import { recordOwnChanges } from '../../src/tools/rbook/record-changes';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import { recoveryFixture, recoverySnapshot } from '../helpers/recovery-fixture';
import { syncWithReferee } from '../helpers/referee-fixture';
import { onCopy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-recovery-boundaries-');
});
afterEach(() => fixture.restore());

it('an upload-only foreign member stream is attributed even when the owner upload is the selected base', async () => {
  const { hosted, extra, input, location } = await recoveryFixture(fixture.tmp, true);
  const member = extra[0];
  useMachine(fixture.tmp, member.machine);
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'Member work on the owner backup.',
        projectRoot: member.root,
      })
    ).success
  ).toBe(true);
  await syncWithReferee(fixture.tmp, hosted, member, 'acct-erin');
  await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
  const file = recoverySnapshot(fixture.tmp, dbOf(hosted.owner.root), 'owner-with-member');
  const supplied = {
    ...input,
    snapshots: [],
    uploads: [{ ...input.uploads[0], file }],
    lostHead: hosted.referee.expectedHead!,
    recordedHeads: [hosted.referee.expectedHead!],
    dropCopies: [member.replicaId],
  };
  const planned = await recoveryPlan(location, supplied);
  expect(planned.result.error).toBeUndefined();
  expect(planned.result.data?.thirdPartyStreams).toContainEqual(
    expect.objectContaining({
      replicaId: member.replicaId,
      accountId: hosted.ownerAccount,
      fromSeq: 1,
    })
  );
});

it('a NULL optional log field and absent legacy alias table survive without mutating the uploaded schema', async () => {
  const { input, location } = await recoveryFixture(fixture.tmp);
  const file = input.uploads[0].file;
  const db = new Database(file);
  try {
    db.exec('DROP TABLE record_aliases');
    expect(
      (
        db
          .prepare('SELECT count(*) AS n FROM record_changes WHERE author_user_id IS NULL')
          .get() as { n: number }
      ).n
    ).toBeGreaterThan(0);
  } finally {
    db.close();
  }
  const bytes = fs.readFileSync(file);
  expect(
    (await recoveryIntake(location, { ...input.uploads[0], lostHead: input.lostHead })).result
      .success
  ).toBe(true);
  expect(fs.readFileSync(file)).toEqual(bytes);
  const foreign = path.join(fixture.tmp, 'foreign.sqlite');
  const other = new Database(foreign);
  other.exec('CREATE TABLE unrelated (id INTEGER)');
  other.close();
  expect(
    (
      await recoveryIntake(location, {
        ...input.uploads[0],
        file: foreign,
        lostHead: input.lostHead,
      })
    ).result.success
  ).toBe(false);
});

it('a missing required table and virtual source slot refuse without publishing or altering the source', async () => {
  const { input, location } = await recoveryFixture(fixture.tmp);
  for (const mode of ['missing', 'virtual']) {
    const file = recoverySnapshot(fixture.tmp, input.uploads[0].file, mode);
    const db = new Database(file);
    try {
      db.exec('DROP TABLE record_aliases');
      if (mode === 'virtual')
        db.exec("CREATE VIRTUAL TABLE record_aliases USING fts5(alias, content='missing_content')");
      else db.exec('DROP TABLE record_changes');
    } finally {
      db.close();
    }
    const bytes = fs.readFileSync(file);
    expect(
      (await recoveryIntake(location, { ...input.uploads[0], file, lostHead: input.lostHead }))
        .result.success
    ).toBe(false);
    expect(fs.readFileSync(file)).toEqual(bytes);
  }
  expect(fs.existsSync(location.storePath)).toBe(false);
});

it('a real second process holding the input lock causes a refusal and leaves no published store', async () => {
  const { input, location } = await recoveryFixture(fixture.tmp);
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const D=require('better-sqlite3');const db=new D(process.argv[1]);db.exec('BEGIN EXCLUSIVE');process.stdout.write('locked');process.stdin.once('data',()=>{db.exec('ROLLBACK');db.close();process.exit(0)});`,
      input.uploads[0].file,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  try {
    await once(child.stdout, 'data');
    const refused = await recoveryIntake(location, {
      ...input.uploads[0],
      lostHead: input.lostHead,
    });
    expect(refused.result.success).toBe(false);
    expect(refused.result.error?.message).toMatch(/locked/i);
    expect(fs.existsSync(location.storePath)).toBe(false);
  } finally {
    child.stdin.write('release');
    await once(child, 'exit');
  }
});

it('explicit config works with ENV unset and referee tables exist before an owner-role edit is rejudged', async () => {
  const { hosted, input, location } = await recoveryFixture(fixture.tmp);
  await onCopy(fixture.tmp, hosted.owner, (client) =>
    client.writeTransaction(() =>
      recordOwnChanges(client, [
        {
          kind: 'set',
          entity: 'project',
          entityId: location.projectId,
          field: 'metadata.project_type',
          value: '"managed"',
        },
      ])
    )
  );
  const file = recoverySnapshot(fixture.tmp, dbOf(hosted.owner.root), 'owner-unjudged');
  const supplied = { ...input, uploads: [{ ...input.uploads[0], file }] };
  const plan = (await recoveryPlan(location, supplied)).result.data!;
  delete process.env.RBOOK_CONFIG_DIR;
  const result = await finalizeRecovery(location, {
    ...supplied,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: [],
  });
  expect(result.result.error).toBeUndefined();
  const db = new Database(location.storePath, { readonly: true });
  try {
    expect(db.prepare("SELECT value FROM metadata WHERE key = 'project_type'").get()).toEqual({
      value: 'managed',
    });
    expect(
      db.prepare('SELECT account_id FROM referee_accounts WHERE member_id = ?').get('owner')
    ).toEqual({ account_id: input.ownerAccountId });
    const verdict = db
      .prepare(
        "SELECT json_extract(v.value, '$.verdict') AS verdict FROM record_changes v JOIN record_changes c ON c.txn_id = v.entity_id WHERE c.entity = 'project' AND c.field = 'metadata.project_type' AND v.kind = 'verdict'"
      )
      .get();
    expect(verdict).toEqual({ verdict: 'accepted' });
  } finally {
    db.close();
  }
  expect(fs.existsSync(path.join(location.configDir, 'referees'))).toBe(true);
});

it('changing accepted bytes after the owner reviewed a plan invalidates confirmation', async () => {
  const { input, location } = await recoveryFixture(fixture.tmp);
  const plan = (await recoveryPlan(location, input)).result.data!;
  const db = new Database(input.uploads[0].file);
  db.pragma('user_version = 91');
  db.close();
  const result = await finalizeRecovery(location, {
    ...input,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: [],
  });
  expect(result.result.success).toBe(false);
  expect(result.result.error?.message).toMatch(/plan changed/i);
  expect(fs.existsSync(location.storePath)).toBe(false);
});

it('snapshot selection refuses locale date prose instead of interpreting it through host-local Date.parse', async () => {
  const { input, location } = await recoveryFixture(fixture.tmp);
  const planned = await recoveryPlan(location, {
    ...input,
    snapshots: [{ ...input.snapshots![0], takenAt: new Date().toUTCString() }],
  });
  expect(planned.result.success).toBe(false);
  expect(planned.result.error?.message).toMatch(/capture time/);
});
