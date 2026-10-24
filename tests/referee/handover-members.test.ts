// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A move back and re-share preserves dashboard account identities for present and removed members.
// ABOUTME: Carried metadata is validated before publication and cannot change a pending handover on retry.
import Database from 'better-sqlite3';
import { afterAll, beforeAll, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { applyJoinAnswer, createReferee, invite, members, peer, remove } from '../../src/referee';
import { replicaMarks } from '../../src/tools/rbook/record-apply';
import { localCopyReport } from '../../src/tools/rbook/record-copy-report';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { answerJoin } from '../../src/tools/rbook/record-join';
import { confirmOwner, handOver } from '../../src/tools/rbook/record-moves';
import { inviteMember, listMembers, removeMember } from '../../src/tools/rbook/record-membership';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import { takeSuccessor, type Successor } from '../../src/tools/rbook/record-successor';
import { dbOf, replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import {
  ask,
  callerOf,
  hostProject,
  joinThroughReferee,
  refereeAt,
  syncWithReferee,
  type Hosted,
} from '../helpers/referee-fixture';
import { onCopy, ownerCopy, read, type Copy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
let hosted: Hosted;
let erin: Copy;
let upload: string;
let bindings: Array<{ memberId: string; accountId: string }>;
let serial = 0;
beforeAll(async () => {
  fixture = replicaFixture('rbook-carried-members-');
  hosted = await hostProject(fixture.tmp);
  await joinThroughReferee(fixture.tmp, hosted, 'Darryl', 'acct-darryl');
  erin = await joinThroughReferee(fixture.tmp, hosted, 'Erin', 'acct-erin');
  expect((await ask(hosted.referee, (at) => remove(at, { accountId: 'acct-erin' }))).success).toBe(
    true
  );
  expect(
    (
      await ask(hosted.referee, (at) =>
        invite(at, { accountId: 'acct-waiting', name: 'Waiting', role: 'editor' })
      )
    ).success
  ).toBe(true);
  const listed = await ask(hosted.referee, (at) => members(at));
  bindings = listed.data!.map((member) => ({
    memberId: member.memberId,
    accountId: member.accountId!,
  }));
  await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
  const owner = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
  const admitted = await ask(hosted.referee, (at) =>
    peer(at, 'admitSuccessor', { replicaId: owner.replicaId }, owner)
  );
  expect(admitted.success).toBe(true);
  const held = await onCopy(
    fixture.tmp,
    hosted.owner,
    (client) => replicaMarks(client)[owner.replicaId] ?? 0
  );
  const taken = await onCopy(fixture.tmp, hosted.owner, (client) =>
    takeSuccessor(client, {
      successor: admitted.data as Successor,
      reason: 'move-back',
      authorityReceived: held,
      cut: held,
    })
  );
  expect(taken.success).toBe(true);
  const successor = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
  const reported = await ask(hosted.referee, (at) =>
    peer(at, 'hello', localCopyReport(), successor)
  );
  expect(reported.error).toBeUndefined();
  expect((await ask(hosted.referee, (at) => peer(at, 'moveBack', {}, successor))).success).toBe(
    true
  );
  await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
  expect((await onCopy(fixture.tmp, hosted.owner, (client) => confirmOwner(client))).success).toBe(
    true
  );
  await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
  upload = path.join(fixture.tmp, 'reshare.sqlite');
  await buildFreshCopy(dbOf(hosted.owner.root), upload);
});
afterAll(() => fixture.restore());

function input(extra: Record<string, unknown> = {}) {
  return {
    copyFile: upload,
    ownerAccountId: hosted.ownerAccount,
    members: bindings,
    formerRefereeReplicaIds: [hosted.refereeReplica],
    ...extra,
  };
}
function accounts(file: string) {
  const db = new Database(file, { readonly: true });
  try {
    return db
      .prepare(
        'SELECT member_id AS memberId, account_id AS accountId FROM referee_accounts ORDER BY member_id'
      )
      .all();
  } finally {
    db.close();
  }
}

it('carries exact present and removed identities; same-account removed re-invite succeeds and another account cannot take its name', async () => {
  const referee = refereeAt(fixture.tmp, `again-${++serial}`);
  const before = fs.readFileSync(upload);
  const made = await ask(referee, (at) => createReferee(at, input()));
  expect(made.error).toBeUndefined();
  expect(accounts(referee.storePath)).toEqual(
    [...bindings].sort((a, b) => a.memberId.localeCompare(b.memberId))
  );
  const answered = await onCopy(fixture.tmp, hosted.owner, (client) =>
    answerJoin(client, made.data!.joinRequest, 'Owner')
  );
  expect((await ask(referee, (at) => applyJoinAnswer(at, answered.data!))).success).toBe(true);
  const next = { referee };
  await syncWithReferee(fixture.tmp, next, hosted.owner, hosted.ownerAccount);
  expect(
    (
      await onCopy(fixture.tmp, hosted.owner, (client) =>
        handOver(client, { to: referee.expectedHead!.replicaId })
      )
    ).success
  ).toBe(true);
  await syncWithReferee(fixture.tmp, next, hosted.owner, hosted.ownerAccount);
  await syncWithReferee(fixture.tmp, next, hosted.owner, hosted.ownerAccount);
  const wrong = await ask(referee, (at) =>
    invite(at, { accountId: 'another-account', name: 'Erin', role: 'editor' })
  );
  expect(wrong.error?.code).toBe('REFEREE_NAME_TAKEN');
  const unknownReader = await ask(referee, (at) =>
    invite(at, { accountId: 'acct-erin', name: 'Erin', role: 'editor' })
  );
  expect(unknownReader.error?.code).toBe('RECORD_COPY_TOO_OLD');
  const held = read(erin, 'SELECT * FROM record_changes ORDER BY change_id');
  expect((await syncWithReferee(fixture.tmp, next, erin, 'acct-erin')).removed).toBe(true);
  expect(read(erin, 'SELECT * FROM record_changes ORDER BY change_id')).toEqual(held);
  const restored = await ask(referee, (at) =>
    invite(at, { accountId: 'acct-erin', name: 'Erin', role: 'editor' })
  );
  expect(restored.data).toMatchObject({
    memberId: bindings.find((row) => row.accountId === 'acct-erin')!.memberId,
    role: 'editor',
    invited: true,
  });
  expect(fs.readFileSync(upload)).toEqual(before);
});

it('retries the same canonical binding/history contract, but refuses silent rebinding or history replacement', async () => {
  const referee = refereeAt(fixture.tmp, `retry-${++serial}`);
  const made = await createReferee(referee, input());
  expect(made.result.error).toBeUndefined();
  const again = await createReferee(
    referee,
    input({ members: [...bindings].reverse().filter((row) => row.memberId !== 'owner') })
  );
  expect(again).toEqual(made);
  for (const extra of [
    {
      members: bindings.map((row) =>
        row.accountId === 'acct-erin' ? { ...row, accountId: 'replacement' } : row
      ),
    },
    { formerRefereeReplicaIds: [] },
  ]) {
    const refused = await createReferee(referee, input(extra));
    expect(refused.result.error?.code).toBe('REFEREE_EXISTS');
    expect(accounts(referee.storePath)).toEqual(
      [...bindings].sort((a, b) => a.memberId.localeCompare(b.memberId))
    );
  }
});

it.each([
  'missing-present',
  'foreign-member',
  'foreign-referee',
  'current-referee',
  'duplicate-member',
  'duplicate-account',
  'wrong-owner',
  'owner-account',
  'null-members',
  'null-history',
  'empty-account',
])(
  'refuses %s without source mutation, a published store, or a leaked per-attempt registry',
  async (kind) => {
    const nonowner = bindings.find((row) => row.accountId === 'acct-darryl')!;
    const extras: Record<string, Record<string, unknown>> = {
      'missing-present': { members: bindings.filter((row) => row !== nonowner) },
      'foreign-member': {
        members: [...bindings, { memberId: 'foreign', accountId: 'foreign-account' }],
      },
      'foreign-referee': { formerRefereeReplicaIds: ['foreign'] },
      'current-referee': {
        formerRefereeReplicaIds: [
          await onCopy(fixture.tmp, hosted.owner, (client) => mergeContext(client).ownReplica),
        ],
      },
      'duplicate-member': { members: [...bindings, nonowner] },
      'duplicate-account': {
        members: bindings.map((row) =>
          row.accountId === 'acct-erin' ? { ...row, accountId: nonowner.accountId } : row
        ),
      },
      'wrong-owner': {
        members: bindings.map((row) =>
          row.memberId === 'owner' ? { ...row, accountId: 'other-owner' } : row
        ),
      },
      'owner-account': {
        members: bindings.map((row) =>
          row.memberId !== 'owner' ? { ...row, accountId: hosted.ownerAccount } : row
        ),
      },
      'null-members': { members: null },
      'null-history': { formerRefereeReplicaIds: null },
      'empty-account': {
        members: bindings.map((row) => (row === nonowner ? { ...row, accountId: '' } : row)),
      },
    };
    const at = {
      ...refereeAt(fixture.tmp, `refused-${++serial}`),
      configDir: path.join(fixture.tmp, `isolated-${serial}`),
    };
    const before = fs.readFileSync(upload);
    const refused = await createReferee(at, input(extras[kind]));
    expect(refused.result.success).toBe(false);
    expect(refused.result.error?.suggestion).toBeTruthy();
    expect(fs.existsSync(at.storePath)).toBe(false);
    expect(fs.readFileSync(upload)).toEqual(before);
    const registries = path.join(at.configDir, 'referees');
    expect(fs.existsSync(registries) ? fs.readdirSync(registries) : []).toEqual([]);
    if (!['missing-present', 'foreign-member', 'foreign-referee', 'current-referee'].includes(kind))
      expect(refused.result.error?.code).toBe('REFEREE_MALFORMED');
    if (kind === 'foreign-member' || kind === 'foreign-referee')
      expect(refused.result.error?.message).toContain('foreign');
    if (kind === 'current-referee') expect(refused.result.error?.message).toMatch(/former/);
    if (kind === 'missing-present') {
      expect(refused.result.error?.message).toContain('Darryl');
      expect(refused.result.error?.suggestion).toMatch(/carried.*bindings/i);
    }
  }
);

it('a newly invited SSH member with no copies cannot pass the replica test vacuously', async () => {
  // Work on the immutable upload under its current identity, never the already moved live fixture.
  const root = path.join(fixture.tmp, `ssh-${++serial}`);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  fs.copyFileSync(upload, dbOf(root));
  const copy = { root, machine: `ssh-${serial}` };
  const invited = await onCopy(
    fixture.tmp,
    copy,
    (client) => inviteMember(client, { name: 'SSH newcomer' }),
    { replicaCheck: false }
  );
  expect(invited.success).toBe(true);
  const got = await onCopy(fixture.tmp, copy, (client) => listMembers(client), {
    replicaCheck: false,
  });
  expect(got.find((row) => row.name === 'SSH newcomer')?.replicas).toEqual([]);
  const refused = await createReferee(
    refereeAt(fixture.tmp, `ssh-referee-${serial}`),
    input({
      copyFile: dbOf(root),
      members: [...bindings, { memberId: invited.data!.memberId, accountId: 'acct-ssh' }],
    })
  );
  expect(refused.result.error?.message).toContain('SSH newcomer');
  expect(refused.result.error?.suggestion).toMatch(/sharing.*directly.*remove/i);
  expect(refused.result.success).toBe(false);
});

it('removed carried bindings remain valid without former-referee provenance, and omitted removed bindings need not block', async () => {
  const root = path.join(fixture.tmp, `all-removed-${++serial}`);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  fs.copyFileSync(upload, dbOf(root));
  const copy = { root, machine: `all-removed-${serial}` };
  await onCopy(
    fixture.tmp,
    copy,
    (client) => {
      for (const member of listMembers(client).filter(
        (member) => member.memberId !== 'owner' && member.role !== 'removed'
      ))
        expect(removeMember(client, member.name).success).toBe(true);
    },
    { replicaCheck: false }
  );
  const kept = await createReferee(
    refereeAt(fixture.tmp, `removed-kept-${serial}`),
    input({ copyFile: dbOf(root), formerRefereeReplicaIds: [] })
  );
  expect(kept.result.error).toBeUndefined();
  const omitted = await createReferee(
    refereeAt(fixture.tmp, `removed-omitted-${serial}`),
    input({ copyFile: dbOf(root), formerRefereeReplicaIds: [], members: [] })
  );
  expect(omitted.result.error).toBeUndefined();
});

it('a legacy pending owner-only store retries without metadata, but cannot acquire carried bindings by retry', async () => {
  const owner = await ownerCopy(fixture.tmp, `legacy-${++serial}`);
  const copyFile = path.join(fixture.tmp, `legacy-${serial}.sqlite`);
  await buildFreshCopy(dbOf(owner.root), copyFile);
  const at = refereeAt(fixture.tmp, `legacy-${serial}`);
  const made = await createReferee(at, { copyFile, ownerAccountId: 'legacy-owner' });
  expect(made.result.error).toBeUndefined();
  const db = new Database(at.storePath);
  db.prepare("DELETE FROM referee_state WHERE key='creation_members'").run();
  db.close();
  const again = await createReferee(at, { copyFile, ownerAccountId: 'legacy-owner' });
  expect(again).toEqual(made);
  const refused = await createReferee(at, {
    copyFile,
    ownerAccountId: 'legacy-owner',
    members: [{ memberId: 'another', accountId: 'another' }],
  });
  expect(refused.result.error?.code).toBe('REFEREE_EXISTS');
  expect(accounts(at.storePath)).toEqual([{ memberId: 'owner', accountId: 'legacy-owner' }]);
});
