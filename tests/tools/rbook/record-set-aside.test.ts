// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Setting aside one replica is an explicit preview/apply operation on the current authority.
// ABOUTME: Real stores prove the cut is held once, its member remains active, and every prior cut survives.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { setAsideReplica } from '../../../src/tools/rbook/record-set-aside';
import { listMembers, removeMember } from '../../../src/tools/rbook/record-membership';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import {
  call,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read, sync, type Copy } from '../../helpers/shared-copies';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-set-aside-');
});
afterEach(() => fixture.restore());
const changes = (copy: Copy) => read(copy, 'SELECT * FROM record_changes ORDER BY rowid');

it('previews by default, applies only explicitly, and repeats retain the original cut', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const first = await joinedCopy(fixture.tmp, owner, 'one', 'Erin');
  const second = await joinedCopy(fixture.tmp, owner, 'two', 'Erin');
  const before = changes(owner);
  const preview = await onCopy(fixture.tmp, owner, (client) =>
    setAsideReplica(client, { replicaId: first.replicaId })
  );
  expect(preview.success).toBe(true);
  expect(preview.data).toMatchObject({
    memberName: 'Erin',
    replicaId: first.replicaId,
    block: first.block,
    cut: 0,
    dryRun: true,
    alreadySetAside: false,
    lastExchangeAt: null,
  });
  expect(changes(owner)).toEqual(before);
  const applied = await onCopy(fixture.tmp, owner, (client) =>
    setAsideReplica(client, { replicaId: first.replicaId, dryRun: false })
  );
  expect(applied.success).toBe(true);
  expect(applied.data).toMatchObject({
    dryRun: false,
    cut: 0,
    setAsideCuts: { [first.replicaId]: 0 },
  });
  expect(changes(owner).length).toBe(before.length + 1);
  useMachine(fixture.tmp, first.machine);
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'Late tail before repeat.',
        projectRoot: first.root,
      })
    ).success
  ).toBe(true);
  await sync(fixture.tmp, first, owner);
  expect(
    read(owner, 'SELECT * FROM record_txn_state WHERE replica_id = ? AND state = ?', [
      first.replicaId,
      'quarantined',
    ]).length
  ).toBeGreaterThan(0);
  const after = changes(owner);
  const repeated = await onCopy(fixture.tmp, owner, (client) =>
    setAsideReplica(client, { replicaId: first.replicaId, dryRun: false })
  );
  expect(repeated.success).toBe(true);
  expect(repeated.data).toMatchObject({ alreadySetAside: true, cut: 0 });
  expect(changes(owner)).toEqual(after);
  const both = await onCopy(fixture.tmp, owner, (client) =>
    setAsideReplica(client, { replicaId: second.replicaId, dryRun: false })
  );
  expect(both.data?.setAsideCuts).toEqual({ [first.replicaId]: 0, [second.replicaId]: 0 });
  const known = await onCopy(fixture.tmp, owner, (client) => ({
    ctx: mergeContext(client),
    people: listMembers(client),
  }));
  expect(known.ctx.members.get(first.replicaId)).toMatchObject({ role: 'editor', cut: 0 });
  expect(known.people.find((member) => member.name === 'Erin')?.role).toBe('editor');
  expect(known.ctx.setAsideCuts.get(applied.data!.memberId)).toEqual(both.data!.setAsideCuts);
});

it.each(['own', 'unknown', 'removed', 'member-caller'] as const)(
  'refuses %s without a member change',
  async (mode) => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joinedCopy(fixture.tmp, owner, 'one', 'Erin');
    if (mode === 'removed')
      expect(
        (await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Erin'))).success
      ).toBe(true);
    await sync(fixture.tmp, owner, member);
    const caller = mode === 'member-caller' ? member : owner;
    const target =
      mode === 'own' ? owner.replicaId : mode === 'unknown' ? 'unknown-replica' : member.replicaId;
    const before = changes(caller);
    const answer = await onCopy(fixture.tmp, caller, (client) =>
      setAsideReplica(client, { replicaId: target, dryRun: false })
    );
    expect(answer.success).toBe(false);
    expect(answer.error?.suggestion).toEqual(expect.any(String));
    expect(changes(caller)).toEqual(before);
  }
);
