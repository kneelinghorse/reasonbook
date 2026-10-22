// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A dashboard delivery never wedges honest own work behind foreign streams missing after recovery.
// ABOUTME: Only the outgoing authority relay may forward every stream; ordinary and successor copies stay scoped.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { dashboardPeer } from '../../../src/tools/rbook/record-dashboard-peer';
import { exchange, type Hello } from '../../../src/tools/rbook/record-exchange';
import type { LoggedChange, MergeContext } from '../../../src/tools/rbook/record-standing';

const route = { kind: 'dashboard' as const, url: 'http://127.0.0.1:54321', projectId: 'project' };
let before: string | undefined;
beforeEach(() => {
  before = process.env.RBOOK_DASHBOARD_URL;
  process.env.RBOOK_DASHBOARD_URL = route.url;
});
afterEach(() => {
  jest.restoreAllMocks();
  if (before === undefined) delete process.env.RBOOK_DASHBOARD_URL;
  else process.env.RBOOK_DASHBOARD_URL = before;
});

const change = (replica: string): LoggedChange =>
  ({
    replica_id: replica,
    replica_seq: 1,
    txn_id: replica,
    change_id: replica,
    protocol_version: 1,
  }) as LoggedChange;

async function transport(input: { own?: string; authority?: string; remoteAuthority?: string }) {
  const own = input.own ?? 'own';
  const ctx = {
    ownReplica: own,
    authority: input.authority ?? 'referee',
    members: new Map([
      [own, { replicaId: own, previous: 'old-own', block: 1, role: 'editor' }],
      ['old-own', { replicaId: 'old-own', block: 2, role: 'editor' }],
    ]),
  } as unknown as MergeContext;
  const hello = {
    protocol: 1,
    projectId: 'project',
    block: 0,
    epoch: 1,
    pending: null,
    blocks: { own: 1, referee: 0 },
    marks: {},
    admitted: {},
    cuts: {},
    unseen: [],
    members: ['own', 'referee', 'old-own'],
    removed: [],
    refusal: null,
    replicaId: 'referee',
    authority: input.remoteAuthority ?? 'referee',
  } as Hello;
  const deliveries: LoggedChange[][] = [];
  const client = {
    refereeRequestLimit: async () => ({ success: true, data: 1024 * 1024 }),
    relayPeerCall: async (_id: string, call: { method: string; params: unknown }) => {
      const changes = (call.params as { changes?: LoggedChange[] })?.changes;
      if (changes) deliveries.push(changes);
      return {
        success: true,
        data: {
          status: 200,
          body: {
            success: true,
            data:
              call.method === 'hello'
                ? hello
                : call.method === 'chains'
                  ? {}
                  : call.method === 'changesSince'
                    ? []
                    : {
                        stored: changes?.length ?? 0,
                        duplicates: 0,
                        judged: 0,
                        recomputed: 0,
                        held: 0,
                        conflicts: 0,
                        checks: 0,
                        folded: 0,
                        newlyLive: [],
                        notes: [],
                        newerProtocol: 0,
                      },
          },
        },
      };
    },
  } as unknown as DashboardClient;
  jest.spyOn(DashboardClient, 'fromEnvForProject').mockResolvedValue({
    success: true,
    data: { client, keySource: 'user-scoped', matchedProjectRoot: null },
  });
  const options = {
    projectRoot: '/unused',
    replicaIdNow: async () => own,
    contextNow: async () => ctx,
  };
  const peer = await dashboardPeer(route, options);
  await peer.hello();
  return { peer, deliveries, hello };
}

describe('dashboard stream ownership', () => {
  it('sends own and predecessor streams while leaving absent foreign changes local', async () => {
    const { peer, deliveries } = await transport({});
    const input = [change('own'), change('foreign'), change('old-own')];
    const delivered = await peer.apply(input);
    expect(delivered.success).toBe(true);
    expect(deliveries.flat().map((row) => row.replica_id)).toEqual(['own', 'old-own']);
    expect(input.map((row) => row.replica_id)).toEqual(['own', 'foreign', 'old-own']);
  });

  it('does not exempt an owner-role member or a completed handover from the filter', async () => {
    const { peer, deliveries } = await transport({ own: 'former-authority' });
    await peer.apply([change('former-authority'), change('foreign')]);
    expect(deliveries.flat().map((row) => row.replica_id)).toEqual(['former-authority']);
  });

  it('preserves the outgoing authority relay while the referee still follows that authority', async () => {
    const { peer, deliveries } = await transport({ authority: 'own', remoteAuthority: 'own' });
    await peer.apply([change('own'), change('foreign')]);
    expect(deliveries.flat().map((row) => row.replica_id)).toEqual(['own', 'foreign']);
  });

  it('the exchange reports only actually stored deliveries, not filtered foreign entries', async () => {
    const { peer, deliveries, hello } = await transport({});
    const near = {
      ...peer,
      name: 'local',
      hello: async () => ({ ...hello, replicaId: 'own', block: 1 }),
      changesSince: async () => [change('own'), change('foreign'), change('old-own')],
    };
    const result = await exchange(near, peer);
    expect(result.success).toBe(true);
    expect(result.data?.sent).toBe(2);
    expect(deliveries[0].map((row) => row.replica_id)).toEqual(['own', 'old-own']);
  });
});
