// SPDX-License-Identifier: Apache-2.0
// ABOUTME: An existing shared copy re-attaches only to its retained dashboard ID and the same record.
// ABOUTME: Explicit attachment preserves its replica and local writes, downloads no replacement, and registers it.
import { afterEach, expect, it, jest } from '@jest/globals';
import { runJoinDashboard } from '../../../src/cli/dashboard';
import * as joinModule from '../../../src/tools/rbook/record-dashboard-join';
import { formatSharedProjectForLLM } from '../../../src/tools/rbook/rbook-project-shared';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import * as registration from '../../../src/intelligence/project-resolution';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { createSuccess } from '../../../src/tools/rbook/errors';
import { peerHealth } from '../../../src/tools/rbook/record-peers';
import {
  recoveryClients,
  required,
  type RecoveryClientFixture,
} from '../../helpers/hosted-recovery-client';
import { onCopy } from '../../helpers/shared-copies';

let active: RecoveryClientFixture | undefined;
afterEach(async () => {
  jest.restoreAllMocks();
  await active?.dispose();
  active = undefined;
});
const address = 'rbook://owner/recovery';

it('reattaches an existing member copy without replacing its identity or its unsent decision', async () => {
  active = await recoveryClients();
  const fixture = active;
  const member = await fixture.join('darryl');
  const own = await fixture.replica(member);
  required(
    await fixture.tool(member, 'rbook_decisions', {
      action: 'record',
      content: 'Keep this unsent decision while reattaching.',
    })
  );
  await onCopy(fixture.fixture.tmp, member, () =>
    ProjectGraphRegistry.getInstance().unregisterStore(member.root)
  );
  const download = jest.spyOn(DashboardClient.prototype, 'downloadFirstCopy');
  const result = await fixture.tool<joinModule.DashboardJoined>(member, 'rbook_project', {
    action: 'join',
    via: 'dashboard',
    project: address,
  });
  expect(result.success).toBe(true);
  expect(result.data?.reattached?.replicaId).toBe(own);
  expect(await fixture.replica(member)).toBe(own);
  expect(download).not.toHaveBeenCalled();
  const kept = await onCopy(fixture.fixture.tmp, member, (client) => ({
    decision: client.getOne<{ n: number }>(
      "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'Keep this unsent decision while reattaching.'"
    ).data?.n,
    registered: ProjectGraphRegistry.getInstance().getByStorePath(member.root),
  }));
  expect(kept.decision).toBe(1);
  expect(kept.registered).toBeTruthy();
  const rendered = formatSharedProjectForLLM('join', result);
  expect(rendered).toMatch(/Re-attached this copy.*keeping its identity/);
  expect(rendered).not.toMatch(/Joined through|undefined|Confirm each held move/);
  jest.spyOn(joinModule, 'joinThroughDashboard').mockResolvedValue(result);
  const output: string[] = [];
  const errors: string[] = [];
  expect(
    await runJoinDashboard(
      address,
      {},
      {
        cwd: member.root,
        env: process.env,
        readStdin: async () => '',
        stdout: (text) => {
          output.push(text);
        },
        stderr: (text) => {
          errors.push(text);
        },
      }
    )
  ).toBe(0);
  expect(output.join(' ')).toMatch(/Re-attached this copy.*keeping its identity/);
  expect(output.join(' ')).not.toMatch(/Joined through|undefined|Confirm each held move/);
  expect(errors).toEqual([]);
});

it('never treats the same address re-registered under a new dashboard ID as its retained route', async () => {
  active = await recoveryClients();
  const fixture = active;
  const member = await fixture.join('darryl');
  const before = await onCopy(fixture.fixture.tmp, member, (client) => peerHealth(client));
  jest
    .spyOn(DashboardClient.prototype, 'resolveAddress')
    .mockResolvedValue(
      createSuccess({ resolved: { projectId: 'replacement-dashboard-id' } }) as never
    );
  const relay = jest.spyOn(DashboardClient.prototype, 'relayPeerCall');
  const download = jest.spyOn(DashboardClient.prototype, 'downloadFirstCopy');
  const result = await fixture.tool(member, 'rbook_project', {
    action: 'join',
    via: 'dashboard',
    project: address,
  });
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/dashboard.*id|retained.*project/i);
  expect(relay).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
  expect(await onCopy(fixture.fixture.tmp, member, (client) => peerHealth(client))).toEqual(before);
});

it('refuses a different record served at its retained dashboard ID before any apply or replacement', async () => {
  active = await recoveryClients();
  const fixture = active;
  const member = await fixture.join('darryl');
  const before = await onCopy(fixture.fixture.tmp, member, (client) => peerHealth(client));
  const original = DashboardClient.prototype.relayPeerCall;
  const calls = jest
    .spyOn(DashboardClient.prototype, 'relayPeerCall')
    .mockImplementation(async function (this: DashboardClient, projectId, call) {
      const response = await original.call(this, projectId, call);
      if (call.method === 'hello' && response.success && response.data) {
        const body = response.data.body as { data?: { projectId?: string } };
        if (body.data) body.data.projectId = 'different-record-id';
      }
      return response;
    });
  const result = await fixture.tool(member, 'rbook_project', {
    action: 'join',
    via: 'dashboard',
    project: address,
  });
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/different-record-id|different.*record/);
  expect(
    calls.mock.calls.some(([, call]) => call.method === 'apply' || call.method === 'answerJoin')
  ).toBe(false);
  expect(await onCopy(fixture.fixture.tmp, member, (client) => peerHealth(client))).toEqual(before);
});

it('keeps a newly joined copy if local list registration fails after admission', async () => {
  active = await recoveryClients();
  jest
    .spyOn(registration, 'registerResolvedProjectStore')
    .mockRejectedValue(new Error('owned registry write failure'));
  const member = await active.join('darryl');
  expect(await active.replica(member)).toEqual(expect.any(String));
  const result = await active.tool(member, 'rbook_project', {
    action: 'join',
    via: 'dashboard',
    project: address,
  });
  expect(result.success).toBe(true);
  expect(result.warnings?.join(' ')).toMatch(
    /registry write failure.*join --dashboard|join --dashboard.*registry write failure/
  );
});
