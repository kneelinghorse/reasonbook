// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Claim arrival positions survive switching, handover and temporary holds on real recorded stores.
// ABOUTME: Earlier accepted names stay reserved while provisional or uncounted claims cannot displace them.
import Database from 'better-sqlite3';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { aliasedId } from '../../../src/tools/rbook/record-alias';
import { applyRemote, changesSince } from '../../../src/tools/rbook/record-apply';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { countedVerdicts } from '../../../src/tools/rbook/record-positions';
import { recoverAuthorityCore } from '../../../src/tools/rbook/record-recovery-core';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import {
  mergeContext,
  txnStanding,
  type LoggedChange,
} from '../../../src/tools/rbook/record-standing';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read, sync, type Copy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
let restoreProtocol: (() => void) | undefined;
beforeEach(() => {
  fixture = replicaFixture('rbook-arrival-order-');
  restoreProtocol = upgradeRecordProtocolForTesting(1);
});
afterEach(() => {
  restoreProtocol?.();
  restoreProtocol = undefined;
  fixture.restore();
});
async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(JSON.stringify(answer.error));
  return answer;
}
const mission = (copy: Copy, id: string) =>
  ok(copy, 'rbook_mission', { action: 'add', missionId: id, name: copy.name });
const createOf = (copy: Copy, id: string, replica = copy.replicaId) =>
  read<LoggedChange>(
    copy,
    "SELECT * FROM record_changes WHERE kind = 'create' AND entity = 'missions' AND json_extract(value, '$.id') = ? AND replica_id = ?",
    [id, replica]
  )[0];
const idOf = (copy: Copy, stable: string) =>
  read<{ id: string }>(copy, 'SELECT id FROM missions WHERE stable_event_id = ?', [stable])[0]?.id;
function backdate(copy: Copy, txn: string, age = 60_000) {
  const db = new Database(dbOf(copy.root));
  try {
    db.prepare('UPDATE record_changes SET hlc = ? WHERE txn_id = ?').run(
      `${String(Date.now() - age).padStart(13, '0')}-000000`,
      txn
    );
  } finally {
    db.close();
  }
}
async function switchToTwo(owner: Copy, copies: readonly Copy[]) {
  restoreProtocol?.();
  restoreProtocol = upgradeRecordProtocolForTesting(2);
  await onCopy(fixture.tmp, owner, (client) => {
    for (const copy of copies)
      rememberCopyReport(client, copy.replicaId, { libraryVersion: '4.5.0', reads: 2 });
  });
  await ok(owner, 'rbook_decisions', {
    action: 'record',
    content: 'All participating copies can read protocol two.',
  });
  expect(
    read(owner, 'SELECT 1 FROM record_changes WHERE replica_id = ? AND protocol_version = 2', [
      owner.replicaId,
    ]).length
  ).toBeGreaterThan(0);
  for (const copy of copies) await sync(fixture.tmp, owner, copy);
}

it('preserves the old clock winner across S and keeps a later backdated claim behind it', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const early = await joinedCopy(fixture.tmp, owner, 'early');
  const late = await joinedCopy(fixture.tmp, owner, 'late');
  await mission(owner, 'old-id');
  await mission(early, 'old-id');
  const earlier = createOf(early, 'old-id');
  backdate(early, earlier.txn_id);
  await sync(fixture.tmp, early, owner);
  expect(idOf(owner, earlier.entity_id!)).toBe('old-id');
  const established = read(owner, 'SELECT id, stable_event_id FROM missions ORDER BY id');
  // Keep late offline with the old namespace while the switch is recorded by the owner.
  restoreProtocol?.();
  restoreProtocol = upgradeRecordProtocolForTesting(2);
  await onCopy(fixture.tmp, owner, (client) => {
    for (const copy of [early, late])
      rememberCopyReport(client, copy.replicaId, { libraryVersion: '4.5.0', reads: 2 });
  });
  await ok(owner, 'rbook_decisions', {
    action: 'record',
    content: 'Switch after names were established.',
  });
  expect(read(owner, 'SELECT id, stable_event_id FROM missions ORDER BY id')).toEqual(established);
  await mission(late, 'old-id');
  const arrivedLate = createOf(late, 'old-id');
  backdate(late, arrivedLate.txn_id, 120_000);
  await sync(fixture.tmp, late, owner);
  expect(idOf(owner, earlier.entity_id!)).toBe('old-id');
  expect(idOf(owner, arrivedLate.entity_id!)).toBe(`old-id~${late.block}`);
});

it('keeps the first accepted member claim in its original position after that member becomes authority', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const next = await joinedCopy(fixture.tmp, owner, 'next', 'Owner');
  const other = await joinedCopy(fixture.tmp, owner, 'other');
  await switchToTwo(owner, [next, other]);
  await mission(next, 'handover-id');
  await mission(other, 'handover-id');
  backdate(other, createOf(other, 'handover-id').txn_id);
  await sync(fixture.tmp, next, owner);
  await sync(fixture.tmp, other, owner);
  const accepted = createOf(owner, 'handover-id', next.replicaId);
  expect(idOf(owner, accepted.entity_id!)).toBe('handover-id');
  await sync(fixture.tmp, owner, next);
  const moved = await onCopy(fixture.tmp, owner, (client) =>
    handOver(client, { to: next.replicaId })
  );
  expect(moved.success).toBe(true);
  await sync(fixture.tmp, owner, next);
  const confirmed = await onCopy(
    fixture.tmp,
    next,
    (client) => confirmOwner(client, { changeId: moved.data!.changeId }),
    { replicaCheck: false }
  );
  expect(confirmed.success).toBe(true);
  expect(idOf(next, accepted.entity_id!)).toBe('handover-id');
  expect(
    await onCopy(fixture.tmp, next, (client) => aliasedId(client, mergeContext(client), accepted))
  ).toBe('handover-id');
});

async function heldClaim() {
  const owner = await ownerCopy(fixture.tmp);
  const member = await joinedCopy(fixture.tmp, owner, 'member');
  await switchToTwo(owner, [member]);
  await mission(member, 'held-id');
  const claim = createOf(member, 'held-id');
  const sent = (await onCopy(fixture.tmp, member, (client) => changesSince(client, {})))
    .filter((change) => change.replica_id === member.replicaId)
    .map((change) =>
      change.change_id === claim.change_id
        ? { ...change, base: JSON.stringify(['not-here-yet']) }
        : change
    );
  expect(
    (await onCopy(fixture.tmp, owner, (client) => applyRemote(client, sent, { judge: false })))
      .success
  ).toBe(true);
  await onCopy(
    fixture.tmp,
    owner,
    (client) => {
      const appended = client.writeTransaction(() =>
        recordOwnChanges(client, [
          {
            kind: 'verdict',
            entity: 'txn',
            entityId: claim.txn_id,
            field: null,
            value: JSON.stringify({
              verdict: 'accepted',
              reason: null,
              epoch: mergeContext(client).epoch,
              replica: member.replicaId,
            }),
          },
        ])
      );
      expect(appended.success).toBe(true);
    },
    { replicaCheck: false }
  );
  await mission(owner, 'held-id');
  return { owner, member, claim, own: createOf(owner, 'held-id') };
}

it('an accepted claim held for a missing base reserves its arrival position', async () => {
  const { owner, claim, own } = await heldClaim();
  await onCopy(fixture.tmp, owner, (client) => {
    const ctx = mergeContext(client);
    expect(txnStanding(client, ctx, claim.txn_id).state).toBe('held');
    expect(aliasedId(client, ctx, own)).toBe('held-id~0');
  });
});

it('a verdict beyond a gap in its authority stream does not reserve an accepted position', async () => {
  const { owner, claim, own } = await heldClaim();
  const db = new Database(dbOf(owner.root));
  try {
    const last = (
      db
        .prepare('SELECT max(replica_seq) AS n FROM record_changes WHERE replica_id = ?')
        .get(owner.replicaId) as { n: number }
    ).n;
    db.prepare(
      "UPDATE record_changes SET replica_seq = ? WHERE kind = 'verdict' AND entity_id = ?"
    ).run(last + 2, claim.txn_id);
  } finally {
    db.close();
  }
  await onCopy(
    fixture.tmp,
    owner,
    (client) => {
      expect(aliasedId(client, mergeContext(client), own)).toBe('held-id');
    },
    { replicaCheck: false }
  );
});

it('a local provisional create waits behind accepted claims even when its clock is earlier', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const member = await joinedCopy(fixture.tmp, owner, 'member');
  await switchToTwo(owner, [member]);
  await mission(member, 'provisional-id');
  const provisional = createOf(member, 'provisional-id');
  backdate(member, provisional.txn_id);
  await mission(owner, 'provisional-id');
  const accepted = createOf(owner, 'provisional-id');
  await sync(fixture.tmp, owner, member);
  await onCopy(fixture.tmp, member, (client) => {
    const ctx = mergeContext(client);
    expect(countedVerdicts(client, ctx, provisional.txn_id)).toEqual([]);
    expect(txnStanding(client, ctx, provisional.txn_id).state).toBe('live');
    expect(aliasedId(client, ctx, accepted)).toBe('provisional-id');
    expect(aliasedId(client, ctx, provisional)).toBe(`provisional-id~${member.block}`);
  });
  expect(idOf(member, provisional.entity_id!)).toBe(`provisional-id~${member.block}`);
});

it('recovery retains acceptance inside the cut and rejudges a later claim after that position', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const early = await joinedCopy(fixture.tmp, owner, 'early', 'Early');
  const late = await joinedCopy(fixture.tmp, owner, 'late', 'Late');
  await switchToTwo(owner, [early, late]);
  await mission(early, 'recovery-id');
  await mission(late, 'recovery-id');
  const first = createOf(early, 'recovery-id');
  const second = createOf(late, 'recovery-id');
  backdate(late, second.txn_id);
  await sync(fixture.tmp, early, owner);
  await sync(fixture.tmp, late, owner);
  const cut = await onCopy(
    fixture.tmp,
    owner,
    (client) => countedVerdicts(client, mergeContext(client), first.txn_id)[0].seq
  );
  const recovered = await recoverAuthorityCore(
    (step) => onCopy(fixture.tmp, owner, step, { replicaCheck: false }),
    [],
    {
      previous: owner.replicaId,
      block: 3,
      ownerName: 'Owner',
      members: ['Early', 'Late'],
      cuts: () => ({}),
      cut,
      recomputeAll: true,
    },
    ProjectGraphRegistry.getInstance()
  );
  expect(recovered.success).toBe(true);
  await onCopy(
    fixture.tmp,
    owner,
    (client) => {
      const ctx = mergeContext(client);
      expect(countedVerdicts(client, ctx, first.txn_id).map((item) => item.epoch)).toEqual([1]);
      expect(countedVerdicts(client, ctx, second.txn_id).map((item) => item.epoch)).toEqual([2]);
      expect(aliasedId(client, ctx, first)).toBe('recovery-id');
      expect(aliasedId(client, ctx, second)).toBe(`recovery-id~${late.block}`);
    },
    { replicaCheck: false }
  );
  expect(idOf(owner, first.entity_id!)).toBe('recovery-id');
});

it('an unjudged authority write stays implicitly live after the switch', async () => {
  const owner = await ownerCopy(fixture.tmp);
  await switchToTwo(owner, []);
  await mission(owner, 'authority-id');
  const claim = createOf(owner, 'authority-id');
  await onCopy(fixture.tmp, owner, (client) => {
    const ctx = mergeContext(client);
    expect(countedVerdicts(client, ctx, claim.txn_id)).toEqual([]);
    expect(txnStanding(client, ctx, claim.txn_id).state).toBe('live');
    expect(aliasedId(client, ctx, claim)).toBe('authority-id');
  });
});
