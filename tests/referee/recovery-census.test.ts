// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Recovery reconciles a fresh host census without reviving removed members.
// ABOUTME: Real stores prove lost invites retain identity and the recovery move advertises effective roles.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import {
  finalizeRecovery,
  invite,
  members,
  peer,
  recoveryPlan,
  remove,
  type FinalizeRecoveryInput,
  type RecoveryMember,
  type RecoveryPlanInput,
} from '../../src/referee';
import { localCopyReport } from '../../src/tools/rbook/record-copy-report';
import { dbOf, replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { recoveryFixture, recoverySnapshot } from '../helpers/recovery-fixture';
import { ask, syncWithReferee } from '../helpers/referee-fixture';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-lens9-opt5-');
});
afterEach(() => fixture.restore());

const census = (
  listed: ReadonlyArray<{ memberId: string; name: string; role: string; accountId: string | null }>
): RecoveryMember[] =>
  listed.map(({ memberId, name, role, accountId }) => ({
    memberId,
    name,
    role,
    accountId: accountId!,
  }));

it('option 5: a lost removal and a lost invite both publish with the census membership', async () => {
  const { hosted, extra, input, location } = await recoveryFixture(fixture.tmp, true);
  const before = hosted.referee.expectedHead!;
  expect((await ask(hosted.referee, (at) => remove(at, { accountId: 'acct-erin' }))).success).toBe(
    true
  );
  expect(
    (
      await ask(hosted.referee, (at) =>
        invite(at, { accountId: 'acct-frank', name: 'Frank', role: 'editor' })
      )
    ).success
  ).toBe(true);
  const frozen = census((await ask(hosted.referee, (at) => members(at))).data!);
  const frank = frozen.find((m) => m.name === 'Frank')!;
  const lostHead = hosted.referee.expectedHead!;
  const supplied: RecoveryPlanInput = {
    ...input,
    lostHead,
    recordedHeads: [before, lostHead],
    members: frozen,
    uploads: [input.uploads[0]],
  };
  const planned = await recoveryPlan(location, supplied);
  expect(planned.result.error).toBeUndefined();
  const plan = planned.result.data!;
  expect(plan.ready).toBe(true);
  expect(plan.memberReconciliation).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        memberId: frank.memberId,
        action: 'write',
        fromRole: null,
        role: 'editor',
      }),
      expect.objectContaining({
        name: 'Erin',
        action: 'write',
        fromRole: 'editor',
        role: 'removed',
      }),
    ])
  );
  const final = await finalizeRecovery(location, {
    ...supplied,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: [],
  } as FinalizeRecoveryInput);
  expect(final.result.error).toBeUndefined();
  const roles = Object.fromEntries(final.result.data!.members.map((m) => [m.name, m.role]));
  expect(roles).toMatchObject({ Erin: 'removed', Frank: 'editor' });
  const recovered = { ...location, expectedHead: final.head };
  // Erin, calling as a 4.6.x copy does, is refused as removed.
  const caller = { accountId: 'acct-erin', replicaId: extra[0].replicaId };
  const greeted = await peer(
    recovered,
    'hello',
    { ...localCopyReport(), recordProtocol: 2 },
    caller
  );
  const read = await peer({ ...location, expectedHead: greeted.head }, 'changesSince', {}, caller);
  expect(read.result.error?.code).toBe('REFEREE_MEMBER_REMOVED');
  // Frank keeps the member id the host bound before the loss; a repeat invite answers his existing member.
  const again = await invite(
    { ...location, expectedHead: read.head },
    { accountId: 'acct-frank', name: 'Frank' }
  );
  expect(again.result.data).toMatchObject({ invited: false, memberId: frank.memberId });
  // The recovery move's member list (what each member's client checks, settled item 5) names Frank, not Erin.
  const db = new Database(location.storePath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT value FROM record_changes WHERE kind = 'authority' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as { value: string };
    const value = JSON.parse(row.value) as { move: string; members: string[] };
    expect(value.move).toBe('recovery');
    expect(value.members).toContain('Frank');
    expect(value.members).not.toContain('Erin');
  } finally {
    db.close();
  }
});

it('a lost readmission keeps a verified removal, including the move and returned census', async () => {
  const { hosted, extra, input, location } = await recoveryFixture(fixture.tmp, true);
  expect((await ask(hosted.referee, (at) => remove(at, { accountId: 'acct-erin' }))).success).toBe(
    true
  );
  const removedHead = hosted.referee.expectedHead!;
  const snapshot = recoverySnapshot(fixture.tmp, hosted.referee.storePath, 'after-removal');
  // Only the lost store sees the later re-invite. Recovery cannot replay that readmission.
  expect(
    (await ask(hosted.referee, (at) => invite(at, { accountId: 'acct-erin', name: 'Erin' })))
      .success
  ).toBe(true);
  const frozen = census((await ask(hosted.referee, (at) => members(at))).data!);
  const erin = frozen.find((member) => member.name === 'Erin')!;
  const supplied = {
    ...input,
    members: frozen,
    uploads: [input.uploads[0]],
    lostHead: hosted.referee.expectedHead!,
    recordedHeads: [removedHead, hosted.referee.expectedHead!],
    snapshots: [{ file: snapshot, takenAt: new Date().toISOString() }],
  };
  const plan = (await recoveryPlan(location, supplied)).result.data!;
  expect(plan.ready).toBe(true);
  expect(plan.memberReconciliation).toContainEqual(
    expect.objectContaining({
      memberId: erin.memberId,
      action: 'keep_removed',
      fromRole: 'removed',
      role: 'removed',
    })
  );
  const final = await finalizeRecovery(location, {
    ...supplied,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: [],
  });
  expect(final.result.error).toBeUndefined();
  expect(final.result.data!.members.find((member) => member.memberId === erin.memberId)?.role).toBe(
    'removed'
  );
  const read = await peer(
    { ...location, expectedHead: final.head },
    'changesSince',
    {},
    { accountId: 'acct-erin', replicaId: extra[0].replicaId }
  );
  expect(read.result.error?.code).toBe('REFEREE_MEMBER_REMOVED');
  const db = new Database(location.storePath, { readonly: true });
  try {
    const row = db
      .prepare(
        "SELECT value FROM record_changes WHERE kind='authority' ORDER BY rowid DESC LIMIT 1"
      )
      .get() as { value: string };
    expect(JSON.parse(row.value).members).not.toContain('Erin');
  } finally {
    db.close();
  }
});

it('changing the census after review invalidates confirmation before publication', async () => {
  const { input, location } = await recoveryFixture(fixture.tmp, true);
  const plan = (await recoveryPlan(location, input)).result.data!;
  const changed = {
    ...input,
    members: input.members.map((member) =>
      member.name === 'Erin' ? { ...member, role: 'owner' } : member
    ),
  };
  expect((await recoveryPlan(location, changed)).result.data!.planHash).not.toBe(plan.planHash);
  const final = await finalizeRecovery(location, {
    ...changed,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: [],
  });
  expect(final.result.success).toBe(false);
  expect(final.result.error?.message).toMatch(/plan changed/);
});

it('a selected tail removal cannot be silently undone to match an active census', async () => {
  const { hosted, input, location } = await recoveryFixture(fixture.tmp, true);
  expect((await ask(hosted.referee, (at) => remove(at, { accountId: 'acct-erin' }))).success).toBe(
    true
  );
  await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
  const file = recoverySnapshot(fixture.tmp, dbOf(hosted.owner.root), 'tail-removal');
  const supplied = { ...input, uploads: [{ ...input.uploads[0], file }, input.uploads[1]] };
  const plan = (await recoveryPlan(location, supplied)).result.data!;
  expect(plan.ready).toBe(true);
  const selected = plan.tailMembership
    .filter((change) => change.kind === 'member')
    .map((change) => change.change_id);
  expect(selected.length).toBeGreaterThan(0);
  const final = await finalizeRecovery(location, {
    ...supplied,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: selected,
  });
  expect(final.result.success).toBe(false);
  expect(final.result.error?.message).toMatch(/cannot re-admit/);
  expect(final.head).toBeNull();
});
