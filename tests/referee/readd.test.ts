// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s100-m01 (the sprint-97 review's finding 8): re-adding a removed member judges each change it made while removed,
// ABOUTME: in clock order and under its new role, so an owner-only edit an editor made is refused, never applied.
import Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import { invite, peer, remove, setRole, type Caller } from '../../src/referee';
import { handOver } from '../../src/tools/rbook/record-moves';
import type { LoggedChange } from '../../src/tools/rbook/record-standing';
import { call, replicaFixture, useMachine, type ReplicaFixture } from '../helpers/replica-fixture';
import {
  ask,
  callerOf,
  joinedReferee,
  joinThroughReferee,
  syncWithReferee,
  type Hosted,
  type Referee,
} from '../helpers/referee-fixture';
import { onCopy, read, type Copy } from '../helpers/shared-copies';

const mint = monotonicFactory();
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-readd-');
});
afterEach(() => fixture.restore());

function onReferee<T>(referee: Referee, sql: string, params: unknown[] = []): T[] {
  const db = new Database(referee.storePath, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const viaPeer = (referee: Referee, method: string, params: unknown, caller: Caller) =>
  ask(referee, (location) => peer(location, method, params, caller));

/** The project type the referee's record holds now. */
const typeOn = (referee: Referee): string | undefined =>
  onReferee<{ value: string }>(
    referee,
    "SELECT json_extract(content, '$.tier') AS value FROM contexts WHERE id = 'project_identity'"
  )[0]?.value;

/** Every verdict the referee recorded on a transaction, oldest first. */
const verdictsOn = (referee: Referee, txn: string): string[] =>
  onReferee<{ value: string }>(
    referee,
    "SELECT value FROM record_changes WHERE kind = 'verdict' AND entity_id = ? ORDER BY rowid",
    [txn]
  ).map((row) => JSON.parse(row.value).verdict);

/**
 * darryl's copy, joined through the referee, and a way to deliver a project-identity edit under its
 * replica: what any client may send, since the referee cannot tell an honest client from a forged one.
 */
async function withDarryl(hosted: Hosted) {
  const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
  await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
  const [shape] = read<LoggedChange>(
    hosted.owner,
    "SELECT * FROM record_changes WHERE entity = 'project' ORDER BY rowid DESC LIMIT 1"
  );
  const caller = await callerOf(fixture.tmp, darryl, 'acct-darryl');
  const lastSeq = () =>
    onReferee<{ seq: number | null }>(
      hosted.referee,
      'SELECT max(replica_seq) AS seq FROM record_changes WHERE replica_id = ?',
      [caller.replicaId]
    )[0].seq ?? 0;
  const identityEdit = (tier: string): LoggedChange => ({
    ...shape,
    change_id: mint(),
    txn_id: mint(),
    replica_id: caller.replicaId,
    replica_seq: lastSeq() + 1,
    author_name: 'darryl',
    author_user_id: null,
    hlc: `${String(Date.now()).padStart(13, '0')}-000000`,
    value: JSON.stringify(tier),
    base: JSON.stringify([shape.change_id]),
  });
  const deliver = async (change: LoggedChange) => {
    const answer = await viaPeer(hosted.referee, 'apply', { changes: [change] }, caller);
    expect(answer.success).toBe(true);
    return change.txn_id;
  };
  return { darryl, caller, identityEdit, deliver };
}

/** A hosted project whose owner set its type before the handover, so a type edit has a base. */
async function hosted(): Promise<Hosted> {
  const joined = await joinedReferee(fixture.tmp);
  await on(joined.owner, 'rbook_project', { action: 'update', projectType: 'managed' });
  await syncWithReferee(fixture.tmp, joined, joined.owner, joined.ownerAccount);
  const moved = await onCopy(fixture.tmp, joined.owner, (client) =>
    handOver(client, { to: joined.refereeReplica })
  );
  expect(moved.success).toBe(true);
  await syncWithReferee(fixture.tmp, joined, joined.owner, joined.ownerAccount);
  await syncWithReferee(fixture.tmp, joined, joined.owner, joined.ownerAccount);
  expect(typeOn(joined.referee)).toBe('managed');
  return joined;
}

describe('re-adding a removed member (s100-m01, settled item 8)', () => {
  it('judges again what an editor made while removed: its identity edit is refused, its decision accepted', async () => {
    const project = await hosted();
    const { darryl, identityEdit, deliver } = await withDarryl(project);
    expect(
      (await ask(project.referee, (at) => remove(at, { accountId: 'acct-darryl' }))).success
    ).toBe(true);
    // Removed, the decision darryl goes on recording is set aside, and so is an identity edit sent
    // after it under darryl's replica.
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Recorded while removed.' });
    await syncWithReferee(fixture.tmp, project, darryl, 'acct-darryl');
    const [decided] = onReferee<{ txn_id: string }>(
      project.referee,
      "SELECT txn_id FROM record_changes WHERE entity = 'strategic_decisions' AND kind = 'create' AND value LIKE '%Recorded while removed.%'"
    );
    expect(verdictsOn(project.referee, decided.txn_id)).toEqual(['quarantined']);
    const forged = await deliver(identityEdit('general'));
    expect(verdictsOn(project.referee, forged)).toEqual(['quarantined']);

    // Shared with again as an editor: each is judged as an editor's change would be.
    const readded = await ask(project.referee, (at) =>
      invite(at, { accountId: 'acct-darryl', name: 'darryl', role: 'editor' })
    );
    expect(readded.success).toBe(true);
    expect(verdictsOn(project.referee, forged)).toEqual(['quarantined', 'refused']);
    expect(typeOn(project.referee)).toBe('managed');
    expect(verdictsOn(project.referee, decided.txn_id)).toEqual(['quarantined', 'accepted']);
    expect(
      onReferee<{ n: number }>(
        project.referee,
        "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text LIKE 'Recorded while removed.%'"
      )[0].n
    ).toBe(1);
  }, 600000);

  it('re-added as an owner, the identity edit an owner-role member made while removed is accepted', async () => {
    const project = await hosted();
    const { identityEdit, deliver } = await withDarryl(project);
    expect(
      (await ask(project.referee, (at) => setRole(at, { accountId: 'acct-darryl', role: 'owner' })))
        .success
    ).toBe(true);
    await ask(project.referee, (at) => remove(at, { accountId: 'acct-darryl' }));
    const edit = await deliver(identityEdit('general'));
    expect(verdictsOn(project.referee, edit)).toEqual(['quarantined']);
    await ask(project.referee, (at) =>
      invite(at, { accountId: 'acct-darryl', name: 'darryl', role: 'owner' })
    );
    // A dashboard's referee takes the identity from an owner-role copy (record-judge.ts).
    expect(verdictsOn(project.referee, edit)).toEqual(['quarantined', 'accepted']);
    expect(typeOn(project.referee)).toBe('general');
  }, 600000);

  it('an owner-role member re-added as an editor has its identity edit refused', async () => {
    const project = await hosted();
    const { identityEdit, deliver } = await withDarryl(project);
    await ask(project.referee, (at) => setRole(at, { accountId: 'acct-darryl', role: 'owner' }));
    await ask(project.referee, (at) => remove(at, { accountId: 'acct-darryl' }));
    const edit = await deliver(identityEdit('general'));
    await ask(project.referee, (at) =>
      invite(at, { accountId: 'acct-darryl', name: 'darryl', role: 'editor' })
    );
    expect(verdictsOn(project.referee, edit)).toEqual(['quarantined', 'refused']);
    expect(typeOn(project.referee)).toBe('managed');
  }, 600000);
});
