// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Hosted recovery alone may confirm itself, under all six settled conditions and the existing chain rules.
// ABOUTME: Real logs keep rejected moves and diagnostic remedies; explicit confirmation repairs routing before peer selection.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { monotonicFactory } from 'ulid';
import { applyRemote, replicaMarks } from '../../../src/tools/rbook/record-apply';
import type { AuthorityValue } from '../../../src/tools/rbook/record-authority';
import {
  considerHostedRecovery,
  hostedRecoveryPeer,
  rebindRecoveryRoutes,
} from '../../../src/tools/rbook/record-dashboard-recovery-moves';
import { clientPeer } from '../../../src/tools/rbook/record-exchange';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { peerHealth, recordExchanged, rememberPeer } from '../../../src/tools/rbook/record-peers';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import { mergeContext, type LoggedChange } from '../../../src/tools/rbook/record-standing';
import { recordedProjectId } from '../../../src/tools/rbook/replica-identity';
import { changesSince } from '../../../src/tools/rbook/record-since';
import { predecessorsOf } from '../../../src/tools/rbook/record-lineage';
import {
  call,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, type Copy } from '../../helpers/shared-copies';

const mint = monotonicFactory();
const route = {
  kind: 'dashboard' as const,
  url: 'http://127.0.0.1:54321',
  projectId: 'dash-project',
};
let fixture: ReplicaFixture;
let owner: Copy;
let member: Copy;
beforeEach(async () => {
  fixture = replicaFixture('rbook-recovery-conditions-');
  owner = await ownerCopy(fixture.tmp);
  member = await joinedCopy(fixture.tmp, owner, 'member', 'Darryl');
  await onCopy(fixture.tmp, member, (client) => rememberPeer(client, owner.replicaId, { route }));
});
afterEach(() => fixture.restore());
const on = <T>(run: Parameters<typeof onCopy<T>>[2]) =>
  onCopy(fixture.tmp, member, run, { replicaCheck: false });

async function candidate(edit: Partial<AuthorityValue> = {}): Promise<LoggedChange> {
  const authority = mint();
  return on((client) => {
    const ctx = mergeContext(client);
    return {
      change_id: mint(),
      txn_id: mint(),
      project_id: recordedProjectId(client),
      replica_id: authority,
      replica_seq: 1,
      author_name: 'Owner',
      author_user_id: null,
      hlc: `${Date.now()}-000000`,
      protocol_version: 1,
      kind: 'authority',
      entity: 'replica',
      entity_id: authority,
      field: null,
      base: null,
      value: JSON.stringify({
        epoch: 2,
        authority,
        previous: owner.replicaId,
        move: 'recovery',
        block: 9,
        cut: ctx.prefixOf(owner.replicaId),
        members: ['Darryl'],
        ...edit,
      }),
    } as LoggedChange;
  });
}
async function receive(change: LoggedChange, previous = owner.replicaId) {
  return on((client) => {
    const applied = applyRemote(client, [change], { judge: false, catchUp: true });
    expect(applied.success).toBe(true);
    return considerHostedRecovery(client, previous, [change]);
  });
}

it('confirms a fresh hosted recovery and rekeys the exact dashboard route', async () => {
  const change = await candidate();
  expect(await receive(change)).toEqual([]);
  const authority = JSON.parse(change.value!).authority as string;
  await on((client) => rebindRecoveryRoutes(client));
  expect(await on((client) => mergeContext(client).authority)).toBe(authority);
  expect(
    await on((client) =>
      peerHealth(client)
        .filter((peer) => peer.route)
        .map((peer) => peer.replicaId)
    )
  ).toEqual([authority]);
});

it('an ended route does not auto-confirm a recovery when explicitly probed again', async () => {
  const change = await candidate();
  const ended = { ...route, ended: true as const };
  await on((client) => rememberPeer(client, owner.replicaId, { route: ended }));
  const open = <T>(step: Parameters<typeof onCopy<T>>[2]) => on(step);
  const peer = await hostedRecoveryPeer(clientPeer('member', open, open), open, ended);
  const applied = await peer.apply([change], { judge: false, catchUp: true });
  expect(applied.success).toBe(true);
  expect(await on((client) => mergeContext(client).epoch)).toBe(1);
  expect(await on((client) => mergeContext(client).pending?.change.change_id)).toBe(
    change.change_id
  );
});

it.each([
  ['move', { move: 'handover' }],
  ['epoch', { epoch: 3 }],
  ['previous', { previous: 'unrelated-referee' }],
  ['membership', { members: [] }],
  ['membership', { dropped: { placeholder: 0 } }],
  ['cut', { cut: 0 }],
] as const)('holds and names the failed %s condition', async (condition, patch) => {
  const edited = 'dropped' in patch ? { dropped: { [member.replicaId]: 0 } } : patch;
  const change = await candidate(edited);
  const failures = await receive(change);
  expect(failures.join(' ')).toMatch(new RegExp(condition, 'i'));
  expect(await on((client) => mergeContext(client).epoch)).toBe(1);
  const review = JSON.stringify(await on((client) => sharedRecordReview(client)));
  expect(review).toMatch(new RegExp(condition, 'i'));
  expect(review).toContain('--confirm-owner');
});

it('names a previously admitted authority even when the existing chain excludes it', async () => {
  const change = await candidate({ authority: owner.replicaId });
  expect((await receive(change)).join(' ')).toMatch(/authority.*admitted/i);
  expect(await on((client) => mergeContext(client).epoch)).toBe(1);
});

it('explicit confirmation of a held cut keeps the route reachable on the next sync', async () => {
  const change = await candidate({ cut: 0 });
  await receive(change);
  expect((await on((client) => confirmOwner(client))).success).toBe(true);
  await on((client) => rebindRecoveryRoutes(client));
  expect(
    await on((client) =>
      peerHealth(client)
        .filter((peer) => peer.route)
        .map((peer) => peer.replicaId)
    )
  ).toEqual([JSON.parse(change.value!).authority]);
  expect(JSON.stringify(await on((client) => sharedRecordReview(client)))).not.toContain(
    'cut condition'
  );
});

it('rekeys a route across two recoveries explicitly confirmed before the next sync', async () => {
  const first = await candidate();
  const firstAuthority = JSON.parse(first.value!).authority as string;
  const second = await candidate({ epoch: 3, previous: firstAuthority, block: 10, cut: 1 });
  const lastAuthority = JSON.parse(second.value!).authority as string;
  await on((client) => {
    expect(applyRemote(client, [first, second], { judge: false, catchUp: true }).success).toBe(
      true
    );
    expect(confirmOwner(client).success).toBe(true);
    expect(confirmOwner(client).success).toBe(true);
    expect(mergeContext(client).authority).toBe(lastAuthority);
    rebindRecoveryRoutes(client);
    expect(
      peerHealth(client)
        .filter((peer) => peer.route)
        .map((peer) => peer.replicaId)
    ).toEqual([lastAuthority]);
    expect(peerHealth(client).find((peer) => peer.replicaId === lastAuthority)?.route).toEqual(
      route
    );
  });
});

it('MCP review retains the named condition and confirmation remedy', async () => {
  await receive(await candidate({ members: [] }));
  useMachine(fixture.tmp, member.machine);
  const result = await call('rbook_review', { projectRoot: member.root });
  expect(result.success).toBe(true);
  expect(JSON.stringify(result)).toMatch(/membership condition/);
  expect(JSON.stringify(result)).toContain('--confirm-owner');
});

it('review counts unsent foreign changes separately from own pending changes', async () => {
  useMachine(fixture.tmp, member.machine);
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'Own work must not be blocked by missing foreign evidence.',
        projectRoot: member.root,
      })
    ).success
  ).toBe(true);
  const expected = await on((client) => {
    const ctx = mergeContext(client);
    const own = new Set([ctx.ownReplica, ...predecessorsOf(ctx, ctx.ownReplica)]);
    return changesSince(client, {}).filter((change) => !own.has(change.replica_id)).length;
  });
  expect(expected).toBeGreaterThan(0);
  const review = await on((client) => sharedRecordReview(client));
  expect(review?.peers?.join(' ')).toContain(`${expected} foreign changes kept local`);
});

it('keeps potentially relayed foreign rows in the pending count until an outgoing handover is observed', async () => {
  const referee = await joinedCopy(fixture.tmp, owner, 'referee', 'Owner');
  useMachine(fixture.tmp, member.machine);
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'Foreign work travels with the outgoing handover.',
        projectRoot: member.root,
      })
    ).success
  ).toBe(true);
  const rows = await on((client) => changesSince(client, {}));
  await onCopy(fixture.tmp, owner, (client) => {
    expect(applyRemote(client, rows).success).toBe(true);
    rememberPeer(client, referee.replicaId, { route });
    expect(handOver(client, { to: referee.replicaId }).success).toBe(true);
    const pending = changesSince(client, {}).length;
    const before = sharedRecordReview(client)?.peers?.join(' ') ?? '';
    expect(before).toContain(`${pending} pending`);
    expect(before).toContain('foreign changes may relay during handover');
    expect(before).not.toContain('kept local (not sent)');
    // The next review can use ordinary send-filter counts once the last observed marks cover the move.
    recordExchanged(client, referee.replicaId, {
      marks: { [owner.replicaId]: replicaMarks(client)[owner.replicaId] },
    });
    const after = sharedRecordReview(client)?.peers?.join(' ') ?? '';
    expect(after).toContain('foreign changes kept local (not sent)');
    expect(after).not.toContain('may relay');
  });
});

it('MCP review names every failed condition together within its line cap', async () => {
  await receive(
    await candidate({
      move: 'handover',
      epoch: 3,
      previous: 'another',
      authority: owner.replicaId,
      members: [],
      cut: 0,
    })
  );
  useMachine(fixture.tmp, member.machine);
  const review = JSON.stringify(await call('rbook_review', { projectRoot: member.root }));
  for (const condition of ['move', 'epoch', 'previous', 'authority', 'membership', 'cut'])
    expect(review).toContain(`${condition} condition`);
  expect(review).toContain('--confirm-owner');
});

it('a hosted handover stays explicit and its old guard note disappears after confirmation', async () => {
  const next = await joinedCopy(fixture.tmp, owner, 'next-owner', 'Owner');
  expect(
    (await onCopy(fixture.tmp, owner, (client) => handOver(client, { to: next.replicaId }))).success
  ).toBe(true);
  const marks = await on(replicaMarks);
  const changes = await onCopy(fixture.tmp, owner, (client) => changesSince(client, marks));
  await on((client) => {
    expect(applyRemote(client, changes, { judge: false, catchUp: true }).success).toBe(true);
    expect(considerHostedRecovery(client, owner.replicaId, changes).join(' ')).toContain(
      'move condition'
    );
    expect(confirmOwner(client).success).toBe(true);
  });
  expect(JSON.stringify(await on(sharedRecordReview))).not.toContain('condition failed');
});

it('reconsiders an already-held valid recovery when the later delivery has no new rows', async () => {
  const change = await candidate();
  await on((client) => {
    expect(applyRemote(client, [change], { judge: false, catchUp: true }).success).toBe(true);
    expect(mergeContext(client).epoch).toBe(1);
    expect(considerHostedRecovery(client, owner.replicaId, [])).toEqual([]);
    expect(mergeContext(client).epoch).toBe(2);
  });
});

it('refuses a new remote authority row claiming this copy’s own authorship before the chain can apply it', async () => {
  const change = await candidate({ authority: member.replicaId });
  const ownSeq = await on((client) => replicaMarks(client)[member.replicaId] ?? 0);
  const claim = {
    ...change,
    replica_id: member.replicaId,
    entity_id: member.replicaId,
    replica_seq: ownSeq + 1,
  };
  const near = await hostedRecoveryPeer(clientPeer('local', on, on), on, route);
  const answer = await near.apply([claim], { judge: false, catchUp: true });
  expect(answer.success).toBe(false);
  expect(answer.error?.message).toMatch(/authority condition/i);
  expect(await on((client) => mergeContext(client).epoch)).toBe(1);
  expect(JSON.stringify(await on(sharedRecordReview))).toContain('authority condition');
});
