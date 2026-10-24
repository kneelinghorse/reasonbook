// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 (design §Who may call what) — every row of the per-call table, refused when a caller may not and
// ABOUTME: fired on real stores when it may: forged replicas, the referee's own replica, owner-only kinds, removed members.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { monotonicFactory } from 'ulid';
import {
  members,
  migrate,
  peer,
  peers,
  remove,
  REFEREE_ERROR_CODES,
  waiting,
  type Caller,
} from '../../src/referee';
import { PROTOCOL_VERSION } from '../../src/tools/rbook/record-changes';
import { exchange } from '../../src/tools/rbook/record-exchange';
import { admitSuccessor } from '../../src/tools/rbook/record-admit-successor';
import { handOver } from '../../src/tools/rbook/record-moves';
import { changesSince } from '../../src/tools/rbook/record-since';
import type { LoggedChange } from '../../src/tools/rbook/record-standing';
import { call, replicaFixture, useMachine, type ReplicaFixture } from '../helpers/replica-fixture';
import {
  ask,
  callerOf,
  hostProject,
  joinedReferee,
  joinThroughReferee,
  refereePeer,
  syncWithReferee,
  type Hosted,
  type Referee,
} from '../helpers/referee-fixture';
import { copyPeer, onCopy, read, type Copy } from '../helpers/shared-copies';

const mint = monotonicFactory();
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-who-');
});
afterEach(() => fixture.restore());

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const viaPeer = (referee: Referee, method: string, params: unknown, caller: Caller) =>
  ask(referee, (location) => peer(location, method, params, caller));

/** What the referee's own file holds, read as a page would. */
function onReferee<T>(referee: Referee, sql: string, params: unknown[] = []): T[] {
  const db = new Database(referee.storePath, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
const stored = (referee: Referee): number =>
  onReferee<{ n: number }>(referee, 'SELECT count(*) AS n FROM record_changes')[0].n;

/** The changes a copy holds that the referee lacks: what its next exchange sends. */
async function pendingOf(copy: Copy, referee: Referee): Promise<LoggedChange[]> {
  const marks = Object.fromEntries(
    onReferee<{ replica_id: string; seq: number }>(
      referee,
      'SELECT replica_id, max(replica_seq) AS seq FROM record_changes GROUP BY replica_id'
    ).map((row) => [row.replica_id, row.seq])
  );
  return onCopy(fixture.tmp, copy, (client) => changesSince(client, marks), {
    replicaCheck: false,
  });
}

/** A change written in `copy`'s own next slot, as a forger would write it into its log. */
async function forgedOwn(
  copy: Copy,
  replicaId: string,
  fields: Partial<LoggedChange>
): Promise<LoggedChange> {
  const [last] = read<LoggedChange>(
    copy,
    'SELECT * FROM record_changes WHERE replica_id = ? ORDER BY replica_seq DESC LIMIT 1',
    [replicaId]
  );
  // A copy that has written nothing yet forges its first change on another one's shape.
  const [shape] = read<LoggedChange>(
    copy,
    'SELECT * FROM record_changes ORDER BY rowid DESC LIMIT 1'
  );
  return {
    ...(last ?? shape),
    change_id: mint(),
    txn_id: mint(),
    replica_id: replicaId,
    replica_seq: (last?.replica_seq ?? 0) + 1,
    author_name: copy.name,
    author_user_id: null,
    base: null,
    ...fields,
  } as LoggedChange;
}

async function hostedWithDarryl(): Promise<{
  hosted: Hosted;
  darryl: Copy;
  owner: Caller;
  d: Caller;
}> {
  const hosted = await hostProject(fixture.tmp);
  const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
  return {
    hosted,
    darryl,
    owner: await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount),
    d: await callerOf(fixture.tmp, darryl, 'acct-darryl'),
  };
}

describe('who may call what (s97-m09)', () => {
  it("hello, chains and changesSince serve any member's own copy, and nothing else's", async () => {
    const { hosted, owner, d } = await hostedWithDarryl();
    const { referee } = hosted;
    const said = await viaPeer(referee, 'hello', { recordProtocol: PROTOCOL_VERSION }, d);
    expect(said.data).toMatchObject({
      replicaId: hosted.refereeReplica,
      authority: hosted.refereeReplica,
      recordProtocol: PROTOCOL_VERSION,
    });
    expect((await viaPeer(referee, 'chains', { [hosted.refereeReplica]: 1 }, d)).data).toEqual({
      [hosted.refereeReplica]: expect.any(String),
    });
    expect((await viaPeer(referee, 'changesSince', {}, d)).error?.code).toBe(
      REFEREE_ERROR_CODES.READS_OLD_PROTOCOL
    );
    expect((await viaPeer(referee, 'hello', { reads: 2 }, d)).success).toBe(true);
    expect(Array.isArray((await viaPeer(referee, 'changesSince', {}, d)).data)).toBe(true);
    const strangers: Caller[] = [
      { accountId: 'acct-darryl', replicaId: owner.replicaId },
      { accountId: hosted.ownerAccount, replicaId: hosted.refereeReplica },
      { accountId: 'acct-nobody', replicaId: d.replicaId },
      { accountId: 'acct-darryl', replicaId: mint() },
    ];
    for (const stranger of strangers)
      for (const [method, params] of [
        ['hello', {}],
        ['chains', {}],
        ['changesSince', {}],
      ] as const)
        expect({
          stranger,
          method,
          code: (await viaPeer(referee, method, params, stranger)).error?.code,
        }).toEqual({
          stranger,
          method,
          code: REFEREE_ERROR_CODES.NOT_A_MEMBER,
        });
  }, 180000);

  it("apply takes in only the caller's own changes and its predecessors', and judges whatever flags a member sends", async () => {
    const { hosted, darryl, owner, d } = await hostedWithDarryl();
    const { referee } = hosted;
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Darryl decided this.' });
    await on(hosted.owner, 'rbook_decisions', {
      action: 'record',
      content: 'The owner decided this.',
    });
    const darrylsChanges = await pendingOf(darryl, referee);
    const ownersChanges = await pendingOf(hosted.owner, referee);
    const before = stored(referee);
    for (const [caller, changes] of [
      [owner, darrylsChanges],
      [d, ownersChanges],
    ] as const) {
      const refused = await viaPeer(referee, 'apply', { changes }, caller);
      expect(refused.error?.code).toBe(REFEREE_ERROR_CODES.FORGED_REPLICA);
    }
    expect(stored(referee)).toBe(before);
    // A member cannot have its delivery left unjudged, nor taken as a catch-up.
    const taken = await viaPeer(
      referee,
      'apply',
      { changes: darrylsChanges, judge: false, catchUp: true },
      d
    );
    expect(taken.error).toBeUndefined();
    expect(taken.data).toMatchObject({ stored: darrylsChanges.length, judged: expect.any(Number) });
    expect((taken.data as { judged: number }).judged).toBeGreaterThan(0);
    expect(
      onReferee(
        referee,
        "SELECT count(*) AS n FROM record_changes WHERE kind = 'verdict' AND json_extract(value, '$.replica') = ?",
        [d.replicaId]
      )
    ).toEqual([{ n: (taken.data as { judged: number }).judged }]);
    // A predecessor's changes come with its successor: the copy re-identified, its old stream follows it.
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl wrote this before re-identifying.',
    });
    const older = await pendingOf(darryl, referee);
    const successor = await viaPeer(referee, 'admitSuccessor', { replicaId: d.replicaId }, d);
    expect(successor.error).toBeUndefined();
    const next: Caller = {
      accountId: 'acct-darryl',
      replicaId: (successor.data as { replicaId: string }).replicaId,
    };
    expect((await viaPeer(referee, 'apply', { changes: older }, next)).error).toBeUndefined();
    expect((await viaPeer(referee, 'apply', { changes: ownersChanges }, next)).error?.code).toBe(
      REFEREE_ERROR_CODES.FORGED_REPLICA
    );
  }, 180000);

  it("a change stamped with the referee's own replica is refused from everyone, the owner's account and the relay included", async () => {
    const { hosted, darryl, owner, d } = await hostedWithDarryl();
    const { referee } = hosted;
    const [own] = onReferee<LoggedChange>(
      referee,
      'SELECT * FROM record_changes WHERE replica_id = ? ORDER BY replica_seq DESC LIMIT 1',
      [hosted.refereeReplica]
    );
    const forged = { ...own, change_id: mint(), txn_id: mint(), replica_seq: own.replica_seq + 1 };
    const before = stored(referee);
    for (const caller of [owner, d])
      expect((await viaPeer(referee, 'apply', { changes: [forged] }, caller)).error?.code).toBe(
        REFEREE_ERROR_CODES.FORGED_REPLICA
      );
    expect(stored(referee)).toBe(before);
    void darryl;
    // During a handover in, the owner's relay may carry every replica's changes but the referee's.
    const joined = await joinedReferee(fixture.tmp, { name: 'second' });
    const [relayed] = onReferee<LoggedChange>(
      joined.referee,
      'SELECT * FROM record_changes ORDER BY rowid DESC LIMIT 1'
    );
    const relayCaller = await callerOf(fixture.tmp, joined.owner, joined.ownerAccount);
    const stamped = {
      ...relayed,
      change_id: mint(),
      txn_id: mint(),
      replica_id: joined.refereeReplica,
      replica_seq: 1,
    };
    expect(
      (await viaPeer(joined.referee, 'apply', { changes: [stamped] }, relayCaller)).error?.code
    ).toBe(REFEREE_ERROR_CODES.FORGED_REPLICA);
  }, 180000);

  it("a member's owner-only change is refused and never forwarded; the outgoing authority's relay carries its own", async () => {
    const { hosted, darryl, owner, d } = await hostedWithDarryl();
    const { referee } = hosted;
    const before = stored(referee);
    for (const kind of ['baseline', 'authority', 'member', 'replica_joined', 'verdict']) {
      const forged = await forgedOwn(darryl, d.replicaId, {
        kind,
        entity:
          kind === 'verdict'
            ? 'txn'
            : kind === 'member'
              ? 'member'
              : kind === 'baseline'
                ? 'project'
                : 'replica',
        entity_id: mint(),
        field: null,
        value: JSON.stringify({
          name: 'Mallory',
          role: 'owner',
          block: 999,
          epoch: 99,
          authority: d.replicaId,
          previous: hosted.refereeReplica,
          move: 'handover',
          verdict: 'accepted',
        }),
      });
      expect({
        kind,
        code: (await viaPeer(referee, 'apply', { changes: [forged] }, d)).error?.code,
      }).toEqual({
        kind,
        code: REFEREE_ERROR_CODES.OWNER_ONLY,
      });
    }
    expect(stored(referee)).toBe(before);
    const forwarded = await viaPeer(referee, 'changesSince', {}, owner);
    expect(
      (forwarded.data as LoggedChange[]).filter(
        (change) => change.replica_id === d.replicaId && change.kind === 'member'
      )
    ).toEqual([]);
    // The relay of the handover in carried the owner's baseline and the move itself: both are the referee's now.
    expect(
      onReferee(
        referee,
        "SELECT kind FROM record_changes WHERE replica_id = ? AND kind IN ('baseline', 'authority') ORDER BY rowid",
        [owner.replicaId]
      )
    ).toEqual([{ kind: 'baseline' }, { kind: 'authority' }]);
  }, 180000);

  it("admitSuccessor serves only the caller's own replica, and the successor keeps the caller's account", async () => {
    const { hosted, owner, d } = await hostedWithDarryl();
    const { referee } = hosted;
    expect(
      (await viaPeer(referee, 'admitSuccessor', { replicaId: owner.replicaId }, d)).error?.code
    ).toBe(REFEREE_ERROR_CODES.METHOD_REFUSED);
    const admitted = await viaPeer(referee, 'admitSuccessor', { replicaId: d.replicaId }, d);
    expect(admitted.error).toBeUndefined();
    const successor = (admitted.data as { replicaId: string }).replicaId;
    expect(
      (await viaPeer(referee, 'hello', {}, { accountId: 'acct-darryl', replicaId: successor }))
        .error
    ).toBeUndefined();
    expect(
      (
        await viaPeer(
          referee,
          'hello',
          {},
          { accountId: hosted.ownerAccount, replicaId: successor }
        )
      ).error?.code
    ).toBe(REFEREE_ERROR_CODES.NOT_A_MEMBER);
  }, 180000);

  it('takeSuccessor serves only the outgoing authority while the referee is still its member', async () => {
    const { hosted, owner, d } = await hostedWithDarryl();
    for (const caller of [owner, d])
      expect((await viaPeer(hosted.referee, 'takeSuccessor', {}, caller)).error?.code).toBe(
        REFEREE_ERROR_CODES.METHOD_REFUSED
      );
    // Positive fire: during a handover in, the owner admits the referee at a fresh block and it moves there.
    const joined = await joinedReferee(fixture.tmp, { name: 'second' });
    await syncWithReferee(fixture.tmp, joined, joined.owner, joined.ownerAccount);
    const admitted = await onCopy(fixture.tmp, joined.owner, (client) =>
      admitSuccessor(client, { replicaId: joined.refereeReplica, sameId: true })
    );
    expect(admitted.error).toBeUndefined();
    await syncWithReferee(fixture.tmp, joined, joined.owner, joined.ownerAccount);
    const relay = await callerOf(fixture.tmp, joined.owner, joined.ownerAccount);
    const taken = await viaPeer(
      joined.referee,
      'takeSuccessor',
      { successor: admitted.data, reason: 'block', authorityReceived: null },
      relay
    );
    expect(taken.error).toBeUndefined();
    expect((await viaPeer(joined.referee, 'hello', {}, relay)).data).toMatchObject({
      block: admitted.data!.block,
    });
  }, 180000);

  it('moveBack, confirmOwner, reblockSelf and every method the dashboard calls directly are refused through peer', async () => {
    const { hosted, owner } = await hostedWithDarryl();
    for (const method of [
      'moveBack',
      'confirmOwner',
      'reblockSelf',
      'invite',
      'setRole',
      'remove',
      'createReferee',
      'migrate',
      'rememberPeers',
      'joinRequest',
      'joinApply',
      'somethingNew',
    ])
      expect({
        method,
        code: (await viaPeer(hosted.referee, method, {}, owner)).error?.code,
      }).toEqual({
        method,
        code: REFEREE_ERROR_CODES.METHOD_REFUSED,
      });
    // Called directly, as the dashboard calls them, they work.
    expect((await ask(hosted.referee, (location) => migrate(location))).data).toEqual({
      schema: null,
      guardsRebuilt: false,
    });
  }, 180000);

  it('confirmOwner runs inside the outgoing authority’s catch-up, never at a caller’s word', async () => {
    const joined = await joinedReferee(fixture.tmp);
    await syncWithReferee(fixture.tmp, joined, joined.owner, joined.ownerAccount);
    expect(
      (
        await onCopy(fixture.tmp, joined.owner, (client) =>
          handOver(client, { to: joined.refereeReplica })
        )
      ).error
    ).toBeUndefined();
    const caught = await syncWithReferee(fixture.tmp, joined, joined.owner, joined.ownerAccount);
    expect(caught.caughtUp).toMatchObject({
      copy: 'remote',
      epoch: 2,
      authority: joined.refereeReplica,
    });
    const relay = await callerOf(fixture.tmp, joined.owner, joined.ownerAccount);
    expect((await viaPeer(joined.referee, 'hello', {}, relay)).data).toMatchObject({
      authority: joined.refereeReplica,
      epoch: 2,
      pending: null,
    });
  }, 180000);

  it("failed and exchanged report only about the caller's own copy, a removed member's included", async () => {
    const { hosted, darryl, owner, d } = await hostedWithDarryl();
    const hostedCopies = async (_: Hosted) => ({ darryl });
    const { referee } = hosted;
    expect(
      (
        await viaPeer(
          referee,
          'exchanged',
          { replicaId: d.replicaId, marks: { [d.replicaId]: 1 }, digest: null },
          d
        )
      ).error
    ).toBeUndefined();
    // The sync-state view reads what the referee saw, never what a copy reports of itself.
    const states = (await ask(referee, (location) => peers(location))).data!;
    const before = states.find((state) => state.replicaId === d.replicaId)!;
    expect(before).toMatchObject({
      lastCallAt: expect.any(String),
      servedThrough: expect.any(Object),
    });
    expect(before).not.toHaveProperty('marks');
    await syncWithReferee(fixture.tmp, hosted, (await hostedCopies(hosted)).darryl, 'acct-darryl');
    const after = (await ask(referee, (location) => peers(location))).data!.find(
      (state) => state.replicaId === d.replicaId
    )!;
    expect(after.lastServedAt).not.toBeNull();
    expect(after.waitingForIt).toBe(0);
    for (const method of ['failed', 'exchanged'])
      expect(
        (await viaPeer(referee, method, { replicaId: owner.replicaId, error: 'x', marks: {} }, d))
          .error?.code
      ).toBe(REFEREE_ERROR_CODES.METHOD_REFUSED);
    expect(
      (await ask(referee, (location) => remove(location, { accountId: 'acct-darryl' }))).error
    ).toBeUndefined();
    expect(
      (
        await viaPeer(
          referee,
          'exchanged',
          { replicaId: d.replicaId, marks: { [d.replicaId]: 1 }, digest: { mark: 1, hash: null } },
          d
        )
      ).error
    ).toBeUndefined();
    expect(
      (
        await viaPeer(
          referee,
          'failed',
          { replicaId: d.replicaId, error: 'my exchange stopped' },
          d
        )
      ).error
    ).toBeUndefined();
  }, 180000);

  it('answerJoin admits only an account holding an active share, for the replica its request names', async () => {
    const { hosted, darryl, d } = await hostedWithDarryl();
    const request = {
      format: 'reasonbook-join-request',
      protocol: 1,
      projectId: 'p-shared',
      replicaId: mint(),
      nonce: 'n',
      marks: {},
    };
    expect(
      (
        await viaPeer(hosted.referee, 'answerJoin', request, {
          accountId: 'acct-nobody',
          replicaId: request.replicaId,
        })
      ).error?.code
    ).toBe(REFEREE_ERROR_CODES.NOT_A_MEMBER);
    expect(
      (
        await viaPeer(hosted.referee, 'answerJoin', request, {
          accountId: 'acct-darryl',
          replicaId: mint(),
        })
      ).error?.code
    ).toBe(REFEREE_ERROR_CODES.MALFORMED);
    await ask(hosted.referee, (location) => remove(location, { accountId: 'acct-darryl' }));
    expect(
      (
        await viaPeer(hosted.referee, 'answerJoin', request, {
          accountId: 'acct-darryl',
          replicaId: request.replicaId,
        })
      ).error?.code
    ).toBe(REFEREE_ERROR_CODES.NOT_A_MEMBER);
    void darryl;
    void d;
  }, 180000);

  it('a removed member is served hello, chains, apply (quarantined), failed and exchanged, so its exchange reaches the cut', async () => {
    const { hosted, darryl, d } = await hostedWithDarryl();
    const { referee } = hosted;
    const removed = await ask(referee, (location) =>
      remove(location, { accountId: 'acct-darryl' })
    );
    expect(removed.data).toMatchObject({
      role: 'removed',
      cuts: { [d.replicaId]: expect.any(Number) },
    });
    await on(hosted.owner, 'rbook_decisions', {
      action: 'record',
      content: 'Written after Darryl left.',
    });
    await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl wrote this after his removal.',
    });
    const report = await exchange(
      copyPeer(fixture.tmp, darryl),
      refereePeer(fixture.tmp, referee, darryl, 'acct-darryl')
    );
    expect(report.error).toBeUndefined();
    expect(report.data).toMatchObject({ removed: true, received: 0 });
    expect(report.data!.sent).toBeGreaterThan(0);
    const quarantined = (await ask(referee, (location) => waiting(location))).data!.filter(
      (txn) => txn.replicaId === d.replicaId
    );
    expect(quarantined.every((txn) => txn.state === 'quarantined')).toBe(true);
    expect(quarantined.length).toBeGreaterThan(0);
    expect(
      read(
        darryl,
        "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'Written after Darryl left.'"
      )
    ).toEqual([{ n: 0 }]);
    expect((await viaPeer(referee, 'changesSince', {}, d)).error?.code).toBe(
      REFEREE_ERROR_CODES.REMOVED
    );
    const listed = (await ask(referee, (location) => members(location))).data!;
    expect(listed.find((member) => member.accountId === 'acct-darryl')).toMatchObject({
      role: 'removed',
    });
  }, 180000);
});
