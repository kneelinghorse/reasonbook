// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real MCP clients over HTTP recover membership changes only the lost referee retained.
// ABOUTME: The host must publish effective roles and preserve invited member identities.
import { afterEach, expect, it } from '@jest/globals';
import type { StreamHead, RecoveryPlan, RecoveryMember } from '../../src/referee';
import { request } from '../helpers/referee-http';
import {
  RECOVERY_PROJECT,
  RECOVERY_TOKENS,
  recoveryClients,
  required,
  type RecoveryClientFixture,
} from '../helpers/hosted-recovery-client';
import type { Copy } from '../helpers/shared-copies';

interface RecoveryView {
  recoveryId: string;
  state: string;
  lostHead: StreamHead;
  plan: RecoveryPlan;
}
let h: RecoveryClientFixture | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});
const relay = `/api/relay/projects/${RECOVERY_PROJECT}`;
const owner = RECOVERY_TOKENS.owner;
async function converge(copies: Copy[]) {
  for (let pass = 0; pass < 2; pass++) for (const copy of copies) required(await h!.sync(copy));
}
const view = async () =>
  required((await request<RecoveryView>(h!.server, `${relay}/recovery`, { token: owner })).body);
const confirm = (plan: RecoveryView) =>
  request<{ members: RecoveryMember[] }>(h!.server, `${relay}/recovery/confirm`, {
    token: owner,
    json: {
      recoveryId: plan.recoveryId,
      confirmedPlanHash: plan.plan.planHash,
      confirmedTailMembershipIds: [],
      dropMembers: [],
    },
  });

async function recoverAfter(change: () => Promise<void>, erinUploads: boolean) {
  h = await recoveryClients();
  const darryl = await h.join('darryl');
  const erin = await h.join('erin');
  await converge([h.owner, darryl, erin]);
  await h.control('snapshot');
  await change(); // a membership change the referee writes; no copy syncs after it
  await h.control('lose');
  // The owner's and darryl's 4.6.1 clients are answered REFEREE_RECOVERING and upload by themselves.
  await h.sync(h.owner);
  await h.sync(darryl);
  // In (a) erin is still a member, so the plan waits for her copy until it uploads; in (b) she is removed and cannot.
  if (erinUploads) await h.sync(erin);
  const plan = await view();
  expect(plan.plan.ready).toBe(true);
  expect(plan.plan.tailMembership).toEqual([]);
  const finalized = await confirm(plan);
  expect(finalized.body.error).toBeUndefined();
  expect(finalized.status).toBe(200);
  const returned = required(finalized.body).members;
  if (!erinUploads) {
    expect(returned.find((member) => member.name === 'erin')?.role).toBe('removed');
    const read = await request(h.server, `${relay}/peer`, {
      token: RECOVERY_TOKENS.erin,
      json: { method: 'changesSince', replicaId: await h.replica(erin), params: {} },
    });
    expect(read.body.error?.code).toBe('REFEREE_MEMBER_REMOVED');
  } else {
    const frank = plan.plan.members.find((member) => member.name === 'frank')!;
    expect(returned.find((member) => member.name === 'frank')?.memberId).toBe(frank.memberId);
    const repeat = await request<{ memberId: string; invited: boolean }>(
      h.server,
      `/api/test/projects/${RECOVERY_PROJECT}/shares`,
      {
        token: owner,
        json: { accountId: 'acct-frank', name: 'frank', role: 'editor' },
      }
    );
    expect(required(repeat.body)).toMatchObject({ memberId: frank.memberId, invited: false });
  }
}

it('a lost removal finishes and the removed member receives no changes', async () => {
  await recoverAfter(async () => {
    const removed = await request(
      h!.server,
      `/api/test/projects/${RECOVERY_PROJECT}/shares/acct-erin`,
      {
        token: owner,
        method: 'DELETE',
      }
    );
    expect(removed.status).toBe(200);
  }, false);
});

it('a lost invite finishes without changing the invitee identity', async () => {
  await recoverAfter(async () => {
    const invited = await request(h!.server, `/api/test/projects/${RECOVERY_PROJECT}/shares`, {
      token: owner,
      json: { accountId: 'acct-frank', name: 'frank', role: 'editor' },
    });
    expect(invited.status).toBe(200);
  }, true);
});
