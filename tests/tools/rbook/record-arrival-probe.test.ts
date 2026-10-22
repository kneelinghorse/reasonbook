// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Invert the immutable plan-time hosted claim probe after the record switches to arrival ordering.
// ABOUTME: A later backdated or offline claim must leave the earlier accepted mission id unchanged.
import Database from 'better-sqlite3';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import {
  call,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { hostProject, joinThroughReferee, syncWithReferee } from '../../helpers/referee-fixture';
import { read, type Copy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
let restoreProtocol: () => void;
beforeEach(() => {
  fixture = replicaFixture('rbook-arrival-probe-');
  // Every fixture copy uses the read-2 release; no old copy is bypassed by this test seam.
  restoreProtocol = upgradeRecordProtocolForTesting(2);
});
afterEach(() => {
  restoreProtocol();
  fixture.restore();
});

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 15));

function refereeRows(storePath: string, sql: string, params: unknown[] = []) {
  const db = new Database(storePath, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

/** The create of a mission id by one replica, with its txn and hlc, as a copy's log holds it. */
const createOf = (copy: Pick<Copy, 'root'>, id: string, replica: string) =>
  read<{ change_id: string; txn_id: string; hlc: string; entity_id: string }>(
    copy,
    "SELECT change_id, txn_id, hlc, entity_id FROM record_changes WHERE kind = 'create' AND entity = 'missions' AND json_extract(value, '$.id') = ? AND replica_id = ?",
    [id, replica]
  )[0];

it('a back-dated claim through the referee loses to the owner copy that reached the referee first', async () => {
  const hosted = await hostProject(fixture.tmp);
  const owner = hosted.owner;
  await on(owner, 'rbook_sprint', {
    action: 'add',
    sprintId: 'p-sprint',
    title: 'P',
    status: 'Active',
  });
  await syncWithReferee(fixture.tmp, hosted, owner, hosted.ownerAccount);
  const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
  await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
  const ownerReplica = read<{ value: string }>(
    owner,
    "SELECT value FROM metadata WHERE key = 'replica_id'"
  )[0].value;
  const admitted = read<{ hlc: string }>(
    darryl,
    "SELECT hlc FROM record_changes WHERE kind = 'replica_joined' AND entity_id = ?",
    [darryl.replicaId]
  )[0].hlc;

  // 1. The owner's copy creates p-m01 and reaches the referee first.
  await pause();
  await on(owner, 'rbook_mission', {
    action: 'add',
    missionId: 'p-m01',
    name: 'Owner first',
    sprintId: 'p-sprint',
  });
  await syncWithReferee(fixture.tmp, hosted, owner, hosted.ownerAccount);
  // 2. darryl, not synced since, creates p-m01 later, then edits its own copy to back-date that transaction.
  await pause();
  await on(darryl, 'rbook_mission', {
    action: 'add',
    missionId: 'p-m01',
    name: 'Darryl later',
    sprintId: 'p-sprint',
  });
  const theirs = createOf(darryl, 'p-m01', darryl.replicaId);
  const ours = createOf(owner, 'p-m01', ownerReplica);
  const forged = `${String(Number(admitted.slice(0, 13)) + 1).padStart(13, '0')}-000000`;
  expect(forged > admitted && forged < ours.hlc).toBe(true);
  const db = new Database(`${darryl.root}/rbook/db/rbook.sqlite`);
  db.prepare('UPDATE record_changes SET hlc = ? WHERE txn_id = ?').run(forged, theirs.txn_id);
  db.close();
  // 3. darryl syncs: intake takes it (after its admission, not a week ahead), and the referee judges it.
  const sent = await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
  await syncWithReferee(fixture.tmp, hosted, owner, hosted.ownerAccount);
  const idOn = (rows: Array<Record<string, unknown>>, stable: string) =>
    rows.find((row) => row.stable_event_id === stable)?.id;
  const onReferee = refereeRows(
    hosted.referee.storePath,
    "SELECT id, stable_event_id FROM missions WHERE id LIKE 'p-m01%'"
  );
  const onOwner = read<Record<string, unknown>>(
    owner,
    "SELECT id, stable_event_id FROM missions WHERE id LIKE 'p-m01%'"
  );
  // The positions the referee gave each transaction in its own stream: its verdicts' sequences.
  const verdicts = refereeRows(
    hosted.referee.storePath,
    "SELECT replica_seq, entity_id, json_extract(value, '$.verdict') AS verdict FROM record_changes WHERE kind = 'verdict' AND replica_id = ? AND entity_id IN (?, ?)",
    [hosted.refereeReplica, ours.txn_id, theirs.txn_id]
  );
  const position = (txn: string) => verdicts.find((row) => row.entity_id === txn)?.replica_seq;
  // The same positions, read from the owner's copy: every copy holds the referee's stream.
  const ownerVerdicts = read<{ replica_seq: number; entity_id: string }>(
    owner,
    "SELECT replica_seq, entity_id FROM record_changes WHERE kind = 'verdict' AND replica_id = ? AND entity_id IN (?, ?)",
    [hosted.refereeReplica, ours.txn_id, theirs.txn_id]
  );
  console.log(
    JSON.stringify(
      {
        sent: sent.sent,
        admitted,
        forged,
        ownerHlc: ours.hlc,
        referee: {
          owner: idOn(onReferee, ours.entity_id),
          darryl: idOn(onReferee, theirs.entity_id),
        },
        ownerCopy: {
          owner: idOn(onOwner, ours.entity_id),
          darryl: idOn(onOwner, theirs.entity_id),
        },
        positions: { owner: position(ours.txn_id), darryl: position(theirs.txn_id) },
        ownerCopyPositions: ownerVerdicts,
        verdicts,
      },
      null,
      1
    )
  );
  // After S: the counted first acceptance keeps the id despite the later create's forged clock.
  expect(idOn(onReferee, theirs.entity_id)).toBe(`p-m01~${darryl.block}`);
  expect(idOn(onReferee, ours.entity_id)).toBe('p-m01');
  expect(idOn(onOwner, ours.entity_id)).toBe('p-m01');
  expect(idOn(onOwner, theirs.entity_id)).toBe(`p-m01~${darryl.block}`);
  // The referee's stream already orders them by arrival: the owner's verdict comes first.
  expect(Number(position(ours.txn_id))).toBeLessThan(Number(position(theirs.txn_id)));
  expect(ownerVerdicts.length).toBe(2);
});

it('an honest offline create that reaches the referee later preserves the accepted established id', async () => {
  const hosted = await hostProject(fixture.tmp);
  const owner = hosted.owner;
  await on(owner, 'rbook_sprint', {
    action: 'add',
    sprintId: 'q-sprint',
    title: 'Q',
    status: 'Active',
  });
  await syncWithReferee(fixture.tmp, hosted, owner, hosted.ownerAccount);
  const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
  await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
  const ownerReplica = read<{ value: string }>(
    owner,
    "SELECT value FROM metadata WHERE key = 'replica_id'"
  )[0].value;
  // darryl writes first, offline; the owner writes later and syncs first, and works on it.
  await pause();
  await on(darryl, 'rbook_mission', {
    action: 'add',
    missionId: 'q-m01',
    name: 'Darryl offline',
    sprintId: 'q-sprint',
  });
  await pause();
  await on(owner, 'rbook_mission', {
    action: 'add',
    missionId: 'q-m01',
    name: 'Owner online',
    sprintId: 'q-sprint',
  });
  await syncWithReferee(fixture.tmp, hosted, owner, hosted.ownerAccount);
  const before = refereeRows(
    hosted.referee.storePath,
    "SELECT id, stable_event_id FROM missions WHERE id LIKE 'q-m01%'"
  );
  await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
  await syncWithReferee(fixture.tmp, hosted, owner, hosted.ownerAccount);
  const ours = createOf(owner, 'q-m01', ownerReplica);
  const after = refereeRows(
    hosted.referee.storePath,
    "SELECT id, stable_event_id FROM missions WHERE id LIKE 'q-m01%'"
  );
  const onOwner = read<Record<string, unknown>>(
    owner,
    "SELECT id, stable_event_id FROM missions WHERE id LIKE 'q-m01%'"
  );
  const aliases = read<Record<string, unknown>>(
    owner,
    "SELECT * FROM record_aliases WHERE plain_id = 'q-m01'"
  );
  console.log(
    JSON.stringify({ before, after, onOwner, aliases, ownerStable: ours.entity_id }, null, 1)
  );
  expect(before.find((row) => row.stable_event_id === ours.entity_id)?.id).toBe('q-m01');
  expect(after.find((row) => row.stable_event_id === ours.entity_id)?.id).toBe('q-m01');
  expect(onOwner.find((row) => row.stable_event_id === ours.entity_id)?.id).toBe('q-m01');
});
