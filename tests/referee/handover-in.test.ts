// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 (design §R1, D6) — the handover in through the referee library: the owner's upload becomes a fresh
// ABOUTME: referee store, it joins as the owner's other copy, catches up, confirms the move itself, and then referees.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import path from 'path';
import {
  applyJoinAnswer,
  createReferee,
  members,
  peer,
  REFEREE_ERROR_CODES,
  remove,
  waiting,
} from '../../src/referee';
import { RECORD_COLUMNS, RECORDED_TABLES } from '../../src/tools/rbook/record-columns';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { answerJoin } from '../../src/tools/rbook/record-join';
import { listMembers } from '../../src/tools/rbook/record-membership';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import {
  ask,
  hostProject,
  joinThroughReferee,
  refereeAt,
  syncWithReferee,
} from '../helpers/referee-fixture';
import { onCopy, ownerCopy, read, recordedState, type Copy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-referee-');
});
afterEach(() => fixture.restore());

function rowsOf(file: string, sql: string): Array<Record<string, unknown>> {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(sql).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

/** recordedState for a store at a path of its own, as the referee's is. */
function recordedStateOf(file: string): Record<string, unknown> {
  const state: Record<string, unknown> = {
    conflicts: rowsOf(
      file,
      'SELECT entity, entity_id, field FROM record_conflicts ORDER BY 1, 2, 3'
    ),
  };
  for (const table of RECORDED_TABLES) {
    const columns = RECORD_COLUMNS[table].recorded.map((column) => `"${column}"`).join(', ');
    state[table] = rowsOf(file, `SELECT ${columns} FROM ${table} ORDER BY ${columns}`);
  }
  return state;
}

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

describe('the handover in (s97-m09)', () => {
  it("ends with the referee as the authority, the owner's copy an owner-role member, and nothing lost", async () => {
    const hosted = await hostProject(fixture.tmp);
    const owner = await onCopy(fixture.tmp, hosted.owner, (client) => {
      const ctx = mergeContext(client);
      return {
        authority: ctx.authority,
        epoch: ctx.epoch,
        role: ctx.members.get(ctx.ownReplica)?.role,
      };
    });
    expect(owner).toEqual({ authority: hosted.refereeReplica, epoch: 2, role: 'owner' });
    const listed = await ask(hosted.referee, (location) => members(location));
    expect(listed.data).toEqual([
      expect.objectContaining({ memberId: 'owner', accountId: 'acct-owner', role: 'owner' }),
    ]);
    expect(listed.data![0].replicas.map((replica) => replica.replicaId)).toEqual([
      hosted.owner.replicaId,
    ]);
    expect((await ask(hosted.referee, (location) => waiting(location))).data).toEqual([]);
    // Nothing lost: every recorded value the owner's copy holds, the referee holds too.
    expect(recordedStateOf(hosted.referee.storePath)).toEqual(recordedState(hosted.owner));
  }, 120000);

  it("a first copy carries the referee's standings: a removed member's quarantined changes stay so for a joiner", async () => {
    const hosted = await hostProject(fixture.tmp);
    const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Before Darryl left.' });
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    await ask(hosted.referee, (location) => remove(location, { accountId: 'acct-darryl' }));
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'After Darryl left.' });
    await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    const standings =
      'SELECT txn_id, replica_id, state, cause FROM record_txn_state ORDER BY txn_id';
    const refereeStandings = rowsOf(hosted.referee.storePath, standings);
    expect(refereeStandings.length).toBeGreaterThan(0);
    expect(refereeStandings.every((row) => row.state === 'quarantined')).toBe(true);
    const erin = await joinThroughReferee(fixture.tmp, hosted, 'erin', 'acct-erin');
    expect(read(erin, standings)).toEqual(refereeStandings);
    expect(
      read(
        erin,
        "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'After Darryl left.'"
      )
    ).toEqual([{ n: 0 }]);
  }, 180000);

  it('createReferee answered again: a retry before the join gets the same request, and the join completes', async () => {
    const joinedLate = await (async () => {
      const owner = await ownerCopy(fixture.tmp);
      const referee = refereeAt(fixture.tmp);
      const upload = path.join(fixture.tmp, 'upload.sqlite');
      await buildFreshCopy(dbOf(owner.root), upload);
      const first = await createReferee(referee, {
        copyFile: upload,
        ownerAccountId: 'acct-owner',
      });
      expect(first.result.error).toBeUndefined();
      // The answer is lost; the dashboard retries, and another account cannot take it over.
      const other = await createReferee(referee, {
        copyFile: upload,
        ownerAccountId: 'acct-mallory',
      });
      expect(other.result.error?.code).toBe(REFEREE_ERROR_CODES.EXISTS);
      const again = await createReferee(referee, {
        copyFile: upload,
        ownerAccountId: 'acct-owner',
      });
      expect(again.result.data!.joinRequest).toEqual(first.result.data!.joinRequest);
      expect(again.head).toEqual(first.head);
      referee.expectedHead = again.head;
      const answer = await onCopy(fixture.tmp, owner, (client) =>
        answerJoin(client, again.result.data!.joinRequest, 'Owner')
      );
      return ask(referee, (location) => applyJoinAnswer(location, answer.data!));
    })();
    expect(joinedLate.error).toBeUndefined();
  }, 120000);

  it("a member joins through it, and a member's change counts for everyone once the referee accepts it", async () => {
    const hosted = await hostProject(fixture.tmp);
    const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl decided this through the referee.',
    });
    const sent = await syncWithReferee(fixture.tmp, hosted, darryl, 'acct-darryl');
    // The decision and the session its record opened: each transaction judged, none left waiting.
    expect(sent.judged).toBe(sent.sent);
    expect(sent.sent).toBeGreaterThanOrEqual(1);
    expect((await ask(hosted.referee, (location) => waiting(location))).data).toEqual([]);
    await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
    expect(
      read(
        hosted.owner,
        "SELECT decision_text FROM strategic_decisions WHERE decision_text LIKE 'Darryl%'"
      )
    ).toEqual([{ decision_text: 'Darryl decided this through the referee.' }]);
    expect(recordedState(hosted.owner)).toEqual(recordedState(darryl));
    const names = await onCopy(fixture.tmp, hosted.owner, (client) =>
      listMembers(client).map((m) => [m.name, m.role])
    );
    expect(names).toEqual([
      ['Owner', 'owner'],
      ['darryl', 'editor'],
    ]);
    void peer;
  }, 120000);
});
