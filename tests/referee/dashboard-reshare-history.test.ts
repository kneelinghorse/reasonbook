// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Re-sharing uses retained dashboard provenance, including applied hosted recovery predecessors.
// ABOUTME: A legacy erased route safely refuses by member name; live recovery then move-back retains eligibility.
import { afterEach, expect, it, jest } from '@jest/globals';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { forgetPeers } from '../../src/tools/rbook/record-peers';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import {
  RECOVERY_PROJECT,
  RECOVERY_TOKENS,
  recoveryClients,
  required,
  type RecoveryClientFixture,
} from '../helpers/hosted-recovery-client';
import { request } from '../helpers/referee-http';
import { onCopy } from '../helpers/shared-copies';

let active: RecoveryClientFixture | undefined;
afterEach(async () => {
  jest.restoreAllMocks();
  await active?.dispose();
  active = undefined;
});

it('names the stranded member and sends no upload when an older client erased all former-referee route provenance', async () => {
  active = await recoveryClients();
  const fixture = active;
  await fixture.join('darryl');
  required(await fixture.sync(fixture.owner));
  required(await fixture.tool(fixture.owner, 'rbook_project', { action: 'move', to: 'owner' }));
  await onCopy(fixture.fixture.tmp, fixture.owner, (client) => forgetPeers(client));
  const upload = jest.spyOn(DashboardClient.prototype, 'relayRefereeCall');
  const result = await fixture.tool(fixture.owner, 'rbook_project', {
    action: 'share',
    via: 'dashboard',
    confirm: true,
  });
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/darryl.*not proved/i);
  expect(result.error?.suggestion).toMatch(/older client erased.*history/i);
  expect(upload).not.toHaveBeenCalled();
});

it('re-shares after hosted recovery and move-back using the proved recovery predecessor for member admission', async () => {
  active = await recoveryClients();
  const fixture = active;
  const member = await fixture.join('darryl');
  for (let pass = 0; pass < 2; pass += 1) {
    required(await fixture.sync(fixture.owner));
    required(await fixture.sync(member));
  }
  await fixture.control('snapshot');
  await fixture.control('lose');
  await fixture.sync(fixture.owner);
  await fixture.sync(member);
  const view = required(
    (
      await request<{ recoveryId: string; plan: { ready: boolean; planHash: string } }>(
        fixture.server,
        `/api/relay/projects/${RECOVERY_PROJECT}/recovery`,
        { token: RECOVERY_TOKENS.owner }
      )
    ).body
  );
  expect(view.plan.ready).toBe(true);
  required(
    (
      await request(fixture.server, `/api/relay/projects/${RECOVERY_PROJECT}/recovery/confirm`, {
        token: RECOVERY_TOKENS.owner,
        json: {
          recoveryId: view.recoveryId,
          confirmedPlanHash: view.plan.planHash,
          confirmedTailMembershipIds: [],
        },
      })
    ).body
  );
  for (let pass = 0; pass < 2; pass += 1) {
    required(await fixture.sync(fixture.owner));
    required(await fixture.sync(member));
  }
  const initial = await onCopy(fixture.fixture.tmp, member, (client) => mergeContext(client).epoch);
  required(await fixture.tool(fixture.owner, 'rbook_project', { action: 'move', to: 'owner' }));
  // The reference engine runs this source; advertise the release that ships this capability.
  const original = global.fetch;
  jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
    const response = await original(url, options);
    if (String(url).endsWith('/api/projects/me')) {
      const body = (await response.json()) as {
        data?: { projects?: Array<{ referee?: { version?: string } }> };
        projects?: Array<{ referee?: { version?: string } }>;
      };
      for (const project of (body.data ?? body).projects ?? [])
        if (project.referee) project.referee.version = '4.5.0';
      return new Response(JSON.stringify(body), { status: response.status });
    }
    return response;
  });
  required(
    await fixture.tool(fixture.owner, 'rbook_project', {
      action: 'share',
      via: 'dashboard',
      confirm: true,
    })
  );
  required(await fixture.sync(member));
  expect(await onCopy(fixture.fixture.tmp, member, (client) => mergeContext(client).epoch)).toBe(
    initial
  );
  required(await fixture.sync(member, true));
  expect(await onCopy(fixture.fixture.tmp, member, (client) => mergeContext(client).epoch)).toBe(
    initial + 1
  );
  required(await fixture.sync(member, true));
  expect(await onCopy(fixture.fixture.tmp, member, (client) => mergeContext(client).epoch)).toBe(
    initial + 2
  );
  required(
    await fixture.tool(member, 'rbook_decisions', {
      action: 'record',
      content: 'A recovered project accepts the same carried member after re-share.',
    })
  );
  required(await fixture.sync(member));
});
