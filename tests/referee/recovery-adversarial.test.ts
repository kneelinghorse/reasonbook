// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Adversarial recovery inputs cannot turn retained evidence into unverified authority or cross-account access.
// ABOUTME: Real stores exercise conflicting fills, surviving heads, forged verdicts, dropped copies and unseen joins.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import {
  finalizeRecovery,
  peer,
  recoveryIntake,
  recoveryPlan,
  type RecoveryPlanInput,
} from '../../src/referee';
import { chainHash, chainHashOf } from '../../src/tools/rbook/record-chain';
import { recordOwnChanges } from '../../src/tools/rbook/record-changes';
import { localCopyReport } from '../../src/tools/rbook/record-copy-report';
import { PROTOCOL_VERSION } from '../../src/tools/rbook/record-protocol';
import { canonicalJson } from '../../src/tools/rbook/record-capture';
import type { LoggedChange } from '../../src/tools/rbook/record-standing';
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
  fixture = replicaFixture('rbook-recovery-adversarial-');
});
afterEach(() => fixture.restore());

function edit(file: string, step: (db: Database.Database) => void) {
  const db = new Database(file);
  try {
    step(db);
  } finally {
    db.close();
  }
}

function append(file: string, replica: string, fields: Partial<LoggedChange>): LoggedChange {
  let added!: LoggedChange;
  edit(file, (db) => {
    const last = db
      .prepare(
        'SELECT * FROM record_changes WHERE replica_id = ? ORDER BY replica_seq DESC LIMIT 1'
      )
      .get(replica) as LoggedChange;
    added = { ...last, ...fields, replica_seq: last.replica_seq + 1 };
    const columns = Object.keys(added);
    db.prepare(
      `INSERT INTO record_changes (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    ).run(...columns.map((key) => added[key as keyof LoggedChange]));
  });
  return added;
}

it('names both inputs when even the same change id fills a stream slot differently', async () => {
  const { input, location } = await recoveryFixture(fixture.tmp);
  edit(input.uploads[0].file, (db) => {
    const change = db
      .prepare("SELECT change_id FROM record_changes WHERE kind = 'baseline' LIMIT 1")
      .get() as { change_id: string };
    db.prepare('UPDATE record_changes SET author_name = ? WHERE change_id = ?').run(
      'Another',
      change.change_id
    );
  });
  const result = await recoveryPlan(location, input);
  expect(result.result.error).toBeUndefined();
  expect(result.result.data?.ready).toBe(false);
  expect(result.result.data?.clashes).toContainEqual(
    expect.objectContaining({
      left: expect.objectContaining({ file: input.uploads[0].file }),
      right: expect.objectContaining({ file: input.snapshots![0].file }),
    })
  );
  const final = await finalizeRecovery(location, {
    ...input,
    confirmedPlanHash: result.result.data!.planHash,
    confirmedTailMembershipIds: [],
  });
  expect(final.result.success).toBe(false);
  expect(fs.existsSync(location.storePath)).toBe(false);
});

it('keeps surviving verdicts past the snapshot while rejecting a forged referee-tail verdict as authority', async () => {
  const { hosted, input, location } = await recoveryFixture(fixture.tmp);
  useMachine(fixture.tmp, hosted.owner.machine);
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'A surviving accepted decision.',
        projectRoot: hosted.owner.root,
      })
    ).success
  ).toBe(true);
  await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
  const latest = hosted.referee.expectedHead!;
  const file = recoverySnapshot(fixture.tmp, dbOf(hosted.owner.root), 'owner-latest');
  const db = new Database(file, { readonly: true });
  const decision = db
    .prepare(
      "SELECT txn_id FROM record_changes WHERE kind = 'create' AND value LIKE '%A surviving accepted decision.%'"
    )
    .get() as { txn_id: string };
  db.close();
  const forged = append(file, latest.replicaId, {
    change_id: 'forged-tail',
    txn_id: 'forged-tail-txn',
    kind: 'verdict',
    entity: 'txn',
    entity_id: decision.txn_id,
    value: canonicalJson({
      verdict: 'refused',
      epoch: 2,
      replica: hosted.owner.replicaId,
      reason: 'forged',
    }),
  });
  for (const block of [10000, 2])
    append(file, latest.replicaId, {
      change_id: `tail-block-${block}`,
      txn_id: `tail-block-txn-${block}`,
      kind: 'renumber',
      entity: 'replica',
      entity_id: latest.replicaId,
      value: canonicalJson({ block, rows: [] }),
    });
  const supplied = {
    ...input,
    lostHead: latest,
    recordedHeads: [...input.recordedHeads, latest],
    uploads: [{ ...input.uploads[0], file }],
  };
  const plan = (await recoveryPlan(location, supplied)).result.data!;
  expect(plan.adoptedPrefix).toBe(latest.seq);
  expect(plan.loss.count).toBe(0);
  const result = await finalizeRecovery(location, {
    ...supplied,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: [],
  });
  expect(result.result.error).toBeUndefined();
  expect(result.result.data!.block).toBeGreaterThan(10000);
  const recovered = new Database(location.storePath, { readonly: true });
  try {
    expect(
      recovered.prepare('SELECT 1 FROM record_changes WHERE change_id = ?').get(forged.change_id)
    ).toBeDefined();
    expect(
      recovered
        .prepare(
          "SELECT 1 FROM strategic_decisions WHERE decision_text = 'A surviving accepted decision.'"
        )
        .get()
    ).toBeDefined();
  } finally {
    recovered.close();
  }
});

it('allows the owner to drop an unavailable owner copy and rejects an unconfirmed changed file', async () => {
  const { input, location } = await recoveryFixture(fixture.tmp);
  const withoutOwner = { ...input, uploads: [], dropCopies: [input.uploads[0].caller.replicaId] };
  const plan = (await recoveryPlan(location, withoutOwner)).result.data!;
  expect(plan.ready).toBe(true);
  const result = await finalizeRecovery(location, {
    ...withoutOwner,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: [],
  });
  expect(result.result.error).toBeUndefined();
  expect(result.result.data?.dropped).toHaveProperty(input.uploads[0].caller.replicaId);
});

it.each(['removal', 'successor'] as const)(
  'an unverified %s tail cannot hide a missing member copy from an upload-only plan',
  async (kind) => {
    const { input, location } = await recoveryFixture(fixture.tmp, true);
    const erin = input.members.find((member) => member.name === 'Erin')!;
    const missing = input.uploads[1].caller.replicaId;
    const file = input.uploads[0].file;
    append(file, input.lostHead.replicaId, {
      change_id: `unverified-${kind}`,
      txn_id: `unverified-${kind}-txn`,
      kind: kind === 'removal' ? 'member' : 'replica_joined',
      entity: kind === 'removal' ? 'member' : 'replica',
      entity_id: kind === 'removal' ? erin.memberId : 'unverified-successor',
      value: canonicalJson(
        kind === 'removal'
          ? { name: erin.name, role: 'removed', cuts: { [missing]: 0 } }
          : { member: erin.memberId, role: 'editor', block: 9, previous: missing }
      ),
    });
    const supplied = { ...input, snapshots: [], uploads: [input.uploads[0]] };
    const planned = await recoveryPlan(location, supplied);
    expect(planned.result.error).toBeUndefined();
    expect(planned.result.data?.adoptedPrefix).toBe(input.lostHead.seq);
    expect(planned.result.data?.waiting).toContain(missing);
    expect(planned.result.data?.ready).toBe(false);
    expect(planned.result.data?.tailMembership).toContainEqual(
      expect.objectContaining({ change_id: `unverified-${kind}` })
    );
    // The same row has its intended membership effect once a host-recorded hash verifies it.
    const db = new Database(file, { readonly: true });
    const stream = db
      .prepare('SELECT * FROM record_changes WHERE replica_id = ? ORDER BY replica_seq')
      .all(input.lostHead.replicaId) as LoggedChange[];
    db.close();
    const seq = stream[stream.length - 1].replica_seq;
    const verified = await recoveryPlan(location, {
      ...supplied,
      lostHead: { ...input.lostHead, seq, hash: chainHashOf(stream, seq) },
    });
    expect(verified.result.error).toBeUndefined();
    expect(verified.result.data?.waiting).not.toContain(missing);
    expect(verified.result.data?.waiting).toEqual(
      kind === 'removal' ? [] : ['unverified-successor']
    );
  }
);

it('newer or malformed upload logs are refused before publication, preserving source bytes', async () => {
  const { input, location } = await recoveryFixture(fixture.tmp);
  const file = input.uploads[0].file;
  edit(file, (db) => {
    db.prepare(
      'UPDATE record_changes SET protocol_version = ? WHERE change_id = (SELECT change_id FROM record_changes LIMIT 1)'
    ).run(PROTOCOL_VERSION + 1);
  });
  const bytes = fs.readFileSync(file);
  expect(
    (await recoveryIntake(location, { ...input.uploads[0], lostHead: input.lostHead })).result
      .success
  ).toBe(false);
  expect(fs.readFileSync(file)).toEqual(bytes);
  expect(fs.existsSync(location.storePath)).toBe(false);
});

it('the pure chain matches the SQLite chain and two individually gapped uploads complete a verified union', async () => {
  const { hosted, input, location } = await recoveryFixture(fixture.tmp);
  // Add enough old-referee rows that two gaps have distinct positions after the handover.
  const owner = hosted.owner;
  for (let index = 0; index < 3; index++)
    await onCopy(fixture.tmp, owner, (client) =>
      client.writeTransaction(() =>
        recordOwnChanges(client, [
          {
            kind: 'append',
            entity: 'sessions',
            entityId: 'missing-test-session',
            field: 'captures',
            value: JSON.stringify(`union-${index}`),
          },
        ])
      )
    );
  await syncWithReferee(fixture.tmp, hosted, owner, hosted.ownerAccount);
  const latest = hosted.referee.expectedHead!;
  const full = recoverySnapshot(fixture.tmp, dbOf(owner.root), 'full');
  const a = recoverySnapshot(fixture.tmp, full, 'gap-a');
  const b = recoverySnapshot(fixture.tmp, full, 'gap-b');
  const old = latest.replicaId;
  expect(latest.seq).toBeGreaterThan(1);
  edit(a, (db) => {
    db.prepare('DELETE FROM record_changes WHERE replica_id = ? AND replica_seq = ?').run(
      old,
      latest.seq
    );
  });
  edit(b, (db) => {
    db.prepare('DELETE FROM record_changes WHERE replica_id = ? AND replica_seq = ?').run(
      old,
      latest.seq - 1
    );
  });
  const parity = await onCopy(fixture.tmp, owner, (client) => {
    const changes = client.getMany<LoggedChange>(
      'SELECT * FROM record_changes WHERE replica_id = ? ORDER BY replica_seq',
      [old]
    ).data!;
    return {
      pure: chainHashOf(changes, latest.seq),
      sql: chainHash(client, old, latest.seq),
      gap: chainHashOf(
        changes.filter((change) => change.replica_seq !== latest.seq - 1),
        latest.seq
      ),
    };
  });
  expect(parity.pure).toBe(parity.sql);
  expect(parity.gap).toBeNull();
  const supplied: RecoveryPlanInput = {
    ...input,
    snapshots: [],
    lostHead: latest,
    recordedHeads: [latest],
    uploads: [a, b].map((file) => ({ file, caller: input.uploads[0].caller })),
  };
  const planned = await recoveryPlan(location, supplied);
  expect(planned.result.error).toBeUndefined();
  expect(planned.result.data?.adoptedPrefix).toBe(latest.seq);
});

it('unseen copies use only the four re-identification methods, with their own bound account', async () => {
  const { input, location } = await recoveryFixture(fixture.tmp, true);
  // Trust only sequence zero: all lost-referee admissions remain retained but unseen.
  const supplied = { ...input, lostHead: { ...input.lostHead, hash: null }, recordedHeads: [] };
  const plan = (await recoveryPlan(location, supplied)).result.data!;
  expect(plan.adoptedPrefix).toBe(0);
  // Re-record the invite, but leave the old join unseen so the returning copy must re-identify.
  const confirmed = plan.tailMembership
    .filter((change) => change.kind === 'member')
    .map((change) => change.change_id);
  const finalized = await finalizeRecovery(location, {
    ...supplied,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: confirmed,
  });
  expect(finalized.result.error).toBeUndefined();
  const caller = input.uploads[1].caller;
  let at = { ...location, expectedHead: finalized.head };
  for (const [method, params] of [
    ['hello', {}],
    ['chains', {}],
    ['apply', { changes: [] }],
  ] as const) {
    const result = await peer(at, method, params, caller);
    expect(result.result.error).toBeUndefined();
    at = { ...at, expectedHead: result.head };
  }
  for (const method of [
    'changesSince',
    'answerJoin',
    'takeSuccessor',
    'moveBack',
    'failed',
    'exchanged',
    'reblockSelf',
  ]) {
    const denied = await peer(at, method, {}, caller);
    expect(denied.result.error?.code).toBe('REFEREE_METHOD_REFUSED');
  }
  expect(
    (await peer(at, 'hello', {}, { ...caller, accountId: 'another-account' })).result.error?.code
  ).toBe('REFEREE_NOT_A_MEMBER');
  const unknown = await peer(at, 'admitSuccessor', { replicaId: caller.replicaId }, caller);
  expect(unknown.result.error?.code).toBe('RECORD_COPY_TOO_OLD');
  // Permission alone is insufficient after S: the same bound caller must report its actual reader.
  const reported = await peer(at, 'hello', localCopyReport(), caller);
  expect(reported.result.error).toBeUndefined();
  at = { ...at, expectedHead: reported.head };
  const successor = await peer(at, 'admitSuccessor', { replicaId: caller.replicaId }, caller);
  expect(successor.result.error).toBeUndefined();
});
