// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Client re-sharing checks library capability before upload and preserves local admission atomically.
// ABOUTME: Actual MCP/HTTP fixtures keep each copy and record under an owned temporary home.
import { afterEach, expect, it, jest } from '@jest/globals';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import * as copyKeys from '../../src/tools/rbook/replica-copy-keys';
import { peerHealth } from '../../src/tools/rbook/record-peers';
import { readReplicaIdentity } from '../../src/tools/rbook/replica-identity';
import {
  recoveryClients,
  required,
  type RecoveryClientFixture,
} from '../helpers/hosted-recovery-client';
import { onCopy } from '../helpers/shared-copies';

let active: RecoveryClientFixture | undefined;
afterEach(async () => {
  jest.restoreAllMocks();
  await active?.dispose();
  active = undefined;
});

async function movedBack() {
  active = await recoveryClients();
  required(await active.tool(active.owner, 'rbook_project', { action: 'move', to: 'owner' }));
  return active;
}

it('keeps the former referee route on move-back so the next share has exact provenance', async () => {
  const fixture = await movedBack();
  const peers = await onCopy(fixture.fixture.tmp, fixture.owner, (client) => peerHealth(client));
  expect(
    peers.some((peer) => peer.route && 'ended' in peer.route && peer.route.ended === true)
  ).toBe(true);
});

it('refuses a re-share before upload when the referee library is older than4.5.0', async () => {
  const fixture = await movedBack();
  const original = global.fetch;
  jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
    const response = await original(url, options);
    if (String(url).endsWith('/api/projects/me')) {
      const body = (await response.json()) as {
        data?: { projects?: Array<{ referee?: { version?: string } }> };
        projects?: Array<{ referee?: { version?: string } }>;
      };
      for (const project of (body.data ?? body).projects ?? [])
        if (project.referee) project.referee.version = '4.4.0';
      return new Response(JSON.stringify(body), { status: response.status });
    }
    return response;
  });
  const upload = jest.spyOn(DashboardClient.prototype, 'relayRefereeCall');
  const result = await fixture.tool(fixture.owner, 'rbook_project', {
    action: 'share',
    via: 'dashboard',
    confirm: true,
  });
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/4\.5\.0/);
  expect(upload.mock.calls.filter(([, call]) => call.kind === 'upload')).toHaveLength(0);
});

it('refuses an old move-back referee before admitting or taking a successor', async () => {
  active = await recoveryClients();
  const fixture = active;
  const before = await fixture.replica(fixture.owner);
  const original = global.fetch;
  jest.spyOn(global, 'fetch').mockImplementation(async (url, options) => {
    const response = await original(url, options);
    if (String(url).endsWith('/api/projects/me')) {
      const body = (await response.json()) as {
        data?: { projects?: Array<{ referee?: { version?: string } }> };
        projects?: Array<{ referee?: { version?: string } }>;
      };
      for (const project of (body.data ?? body).projects ?? [])
        if (project.referee) project.referee.version = '4.1.0';
      return new Response(JSON.stringify(body), { status: response.status });
    }
    return response;
  });
  const calls = jest.spyOn(DashboardClient.prototype, 'relayPeerCall');
  const result = await fixture.tool(fixture.owner, 'rbook_project', {
    action: 'move',
    to: 'owner',
  });
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/4\.2\.0/);
  expect(
    calls.mock.calls.some(
      ([, call]) => call.method === 'admitSuccessor' || call.method === 'moveBack'
    )
  ).toBe(false);
  expect(await fixture.replica(fixture.owner)).toBe(before);
});

it('rolls back the admitted referee and route if the pending answer cannot be persisted', async () => {
  const fixture = await movedBack();
  // This source host implements re-sharing before the package's release version is bumped.
  // Reach admission, rather than accidentally passing on the earlier old-version refusal.
  jest.spyOn(DashboardClient.prototype, 'refereeCapabilities').mockResolvedValue({
    success: true,
    data: { version: '4.5.0', recordProtocol: 2 },
  });
  const before = await onCopy(fixture.fixture.tmp, fixture.owner, (client) => ({
    log: client.getMany<{ change_id: string }>(
      'SELECT change_id FROM record_changes ORDER BY change_id'
    ).data,
    peers: peerHealth(client),
    replica: readReplicaIdentity(client, { fresh: true }),
  }));
  const original = copyKeys.writeCopyKey;
  let injected = 0;
  jest.spyOn(copyKeys, 'writeCopyKey').mockImplementation((client, key, value) => {
    if (key === copyKeys.COPY_KEYS.dashboardShare && value !== null) {
      injected += 1;
      throw new Error('owned pending-key fault');
    }
    original(client, key, value);
  });
  const result = await fixture.tool(fixture.owner, 'rbook_project', {
    action: 'share',
    via: 'dashboard',
    confirm: true,
  });
  expect(injected).toBe(1);
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain('owned pending-key fault');
  const after = await onCopy(fixture.fixture.tmp, fixture.owner, (client) => ({
    log: client.getMany<{ change_id: string }>(
      'SELECT change_id FROM record_changes ORDER BY change_id'
    ).data,
    peers: peerHealth(client),
    replica: readReplicaIdentity(client, { fresh: true }),
  }));
  expect(after).toEqual(before);
});
