// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Recovery must preserve the member names and roles the owner confirmed before it judges or publishes.
// ABOUTME: Real removal and retained-tail controls prevent reviving missing members through a stale authority cut.
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import { finalizeRecovery, members, peer, recoveryPlan, remove } from '../../src/referee';
import * as judge from '../../src/tools/rbook/record-judge';
import { dbOf, replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { recoveryFixture, recoverySnapshot } from '../helpers/recovery-fixture';
import { ask, syncWithReferee } from '../helpers/referee-fixture';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-recovery-membership-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

it.each(['unselected-tail', 'selected-tail', 'verified-head'] as const)(
  '%s never revives a confirmed removed member whose copy did not arrive',
  async (mode) => {
    const { hosted, extra, input, location } = await recoveryFixture(fixture.tmp, true);
    const removed = await ask(hosted.referee, (at) => remove(at, { accountId: 'acct-erin' }));
    expect(removed.success).toBe(true);
    const listed = await ask(hosted.referee, (at) => members(at));
    expect(listed.success).toBe(true);
    await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
    const file = recoverySnapshot(fixture.tmp, dbOf(hosted.owner.root), 'owner-after-removal');
    const supplied = {
      ...input,
      members: listed.data!.map(({ memberId, name, role, accountId }) => ({
        memberId,
        name,
        role,
        accountId: accountId!,
      })),
      uploads: [{ ...input.uploads[0], file }],
      ...(mode === 'verified-head'
        ? { lostHead: hosted.referee.expectedHead!, recordedHeads: [hosted.referee.expectedHead!] }
        : {}),
    };
    const planned = await recoveryPlan(location, supplied);
    expect(planned.result.error).toBeUndefined();
    const plan = planned.result.data!;
    expect(plan.ready).toBe(true);
    expect(plan.members.find((member) => member.name === 'Erin')?.role).toBe('removed');
    const bytes = fs.readFileSync(file);
    const judging = jest.spyOn(judge, 'judgeUnjudged');
    const final = await finalizeRecovery(location, {
      ...supplied,
      confirmedPlanHash: plan.planHash,
      confirmedTailMembershipIds:
        mode === 'selected-tail'
          ? plan.tailMembership
              .filter((change) => change.kind === 'member')
              .map((change) => change.change_id)
          : [],
    });
    expect(final.result.error).toBeUndefined();
    expect(judging).toHaveBeenCalled();
    expect(final.result.data?.members.find((member) => member.name === 'Erin')?.role).toBe(
      'removed'
    );
    const read = await peer(
      { ...location, expectedHead: final.head },
      'changesSince',
      {},
      { accountId: 'acct-erin', replicaId: extra[0].replicaId }
    );
    expect(read.result.error?.code).toBe('REFEREE_MEMBER_REMOVED');
    expect(fs.readFileSync(file)).toEqual(bytes);
  }
);

it.each(['name', 'role', 'missing'] as const)(
  'a confirmed %s difference refuses renamed identities but recovers lost role and admission changes',
  async (mode) => {
    const { input, location } = await recoveryFixture(fixture.tmp, true);
    const confirmed = input.members.map((member) =>
      member.name === 'Erin'
        ? {
            ...member,
            ...(mode === 'name' ? { name: 'Morgan' } : mode === 'role' ? { role: 'owner' } : {}),
          }
        : member
    );
    if (mode === 'missing')
      confirmed.push({
        memberId: 'missing-member',
        name: 'Missing Person',
        role: 'editor',
        accountId: 'missing-account',
      });
    const supplied = { ...input, members: confirmed };
    const planned = await recoveryPlan(location, supplied);
    expect(planned.result.error).toBeUndefined();
    const judging = jest.spyOn(judge, 'judgeUnjudged');
    const final = await finalizeRecovery(location, {
      ...supplied,
      confirmedPlanHash: planned.result.data!.planHash,
      confirmedTailMembershipIds: [],
    });
    if (mode === 'name') {
      expect(final.result.success).toBe(false);
      expect(final.result.error?.message).toContain('Morgan');
      expect(final.result.error?.suggestion).toMatch(/name|identity/i);
      expect(judging).not.toHaveBeenCalled();
      expect(fs.existsSync(location.storePath)).toBe(false);
    } else {
      expect(final.result.error).toBeUndefined();
      expect(judging).toHaveBeenCalled();
      expect(final.result.data?.members).toEqual(confirmed);
    }
  }
);
