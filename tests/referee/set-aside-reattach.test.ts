// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A direct owner copy cut before the first hosted share must be able to follow the dashboard re-attach remedy.
// ABOUTME: Real HTTP/account binding and unchanged local writes distinguish first attachment from re-share provenance.
import http from 'http';
import path from 'path';
import Database from 'better-sqlite3';
import { runJoinDashboard } from '../../src/cli/dashboard';
import { CredentialStore } from '../../src/intelligence/credential-store';
import * as serverVersion from '../../src/server-version';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { joinThroughDashboard } from '../../src/tools/rbook/record-dashboard-join';
import * as joinModule from '../../src/tools/rbook/record-dashboard-join';
import { isDashboardRoute } from '../../src/tools/rbook/record-dashboard-route';
import { shareThroughDashboard } from '../../src/tools/rbook/record-dashboard-share';
import { setAsideReplica } from '../../src/tools/rbook/record-set-aside';
import { confirmOwner } from '../../src/tools/rbook/record-moves';
import { peerHealth, rememberPeer } from '../../src/tools/rbook/record-peers';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import { storeOpener } from '../../src/tools/rbook/record-sync';
import { __resetSharedSyncScheduler } from '../../src/tools/rbook/record-sync-scheduler';
import { readReplicaIdentity } from '../../src/tools/rbook/replica-identity';
import { formatSharedProjectForLLM } from '../../src/tools/rbook/rbook-project-shared';
import { request } from '../helpers/referee-http';
import { startRefereeServer } from '../helpers/referee-server';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, sync, type Copy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
let server: http.Server | undefined;
let savedUrl: string | undefined;
beforeEach(() => {
  fixture = replicaFixture('rbook-first-share-return-');
  savedUrl = process.env.RBOOK_DASHBOARD_URL;
  // Simulated candidate reports only; this test does not assert the installed package's version.
  jest.spyOn(serverVersion, 'getServerVersion').mockReturnValue('4.5.0');
});
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve()))
    );
  server = undefined;
  __resetSharedSyncScheduler();
  jest.restoreAllMocks();
  if (savedUrl === undefined) delete process.env.RBOOK_DASHBOARD_URL;
  else process.env.RBOOK_DASHBOARD_URL = savedUrl;
  fixture.restore();
});

async function signIn(copy: Copy, token = 'owner-token') {
  useMachine(fixture.tmp, copy.machine);
  const at = new Date().toISOString();
  await (
    await CredentialStore.create()
  ).upsertUserScopedKey('owner', {
    key: token,
    label: 'Owner',
    issuedAt: at,
    lastUsedAt: at,
  });
}

async function firstShare(cut = true) {
  const owner = await ownerCopy(fixture.tmp);
  const returning = await joinedCopy(fixture.tmp, owner, 'returning', 'Owner');
  if (cut)
    await onCopy(fixture.tmp, owner, (client) => {
      const applied = setAsideReplica(client, { replicaId: returning.replicaId, dryRun: false });
      expect(applied.success).toBe(true);
      expect(applied.data?.cut).toBe(0);
    });
  const hosted = await startRefereeServer({
    root: path.join(fixture.tmp, 'host'),
    accounts: { 'owner-token': 'owner-account', 'other-token': 'other-account' },
    projects: { 'first-share': { ownerAccountId: 'owner-account' } },
    addresses: { 'owner/first-share': 'first-share' },
    reportedLibraryVersion: '4.5.0',
  });
  server = hosted.server;
  const url = `http://127.0.0.1:${hosted.port}`;
  process.env.RBOOK_DASHBOARD_URL = url;
  await signIn(owner);
  const shared = await shareThroughDashboard(
    storeOpener(dbOf(owner.root)),
    storeOpener(dbOf(owner.root), { replicaCheck: false }),
    dbOf(owner.root),
    { projectId: 'first-share', confirm: true }
  );
  expect(shared.success).toBe(true);
  await signIn(returning);
  return { owner, returning, url };
}

const snapshot = (copy: Copy) =>
  onCopy(fixture.tmp, copy, (client) => ({
    replica: readReplicaIdentity(client, { fresh: true }),
    changes: client.getMany('SELECT change_id FROM record_changes ORDER BY change_id').data,
    peers: peerHealth(client),
  }));

async function attach(copy: Copy) {
  useMachine(fixture.tmp, copy.machine);
  return call('rbook_project', {
    action: 'join',
    via: 'dashboard',
    project: 'rbook://owner/first-share',
    projectRoot: copy.root,
  });
}

it('attaches a returning first-share cut owner copy without downloading or replacing its store', async () => {
  const { returning, url } = await firstShare();
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'Unsent after the copy was set aside.',
        projectRoot: returning.root,
      })
    ).success
  ).toBe(true);
  const before = await onCopy(fixture.tmp, returning, (client) => ({
    replica: readReplicaIdentity(client, { fresh: true }),
    changes: client.getMany('SELECT change_id FROM record_changes ORDER BY change_id').data,
    dashboardRoutes: peerHealth(client).filter((peer) => isDashboardRoute(peer.route)),
  }));
  expect(before.dashboardRoutes).toEqual([]);
  // Independent real authenticated hello demonstrates the account owns this known replica.
  const remote = await request<{
    projectId: string;
    replicaId: string;
    authority: string;
    cuts: Record<string, number>;
  }>({ url }, '/api/relay/projects/first-share/peer', {
    token: 'owner-token',
    json: { method: 'hello', replicaId: returning.replicaId, params: { recordProtocol: 1 } },
  });
  expect(remote.body.success).toBe(true);
  expect(remote.body.data?.projectId).toBe('p-shared');
  expect(remote.body.data?.replicaId).toBe(remote.body.data?.authority);
  expect(remote.body.data?.cuts[returning.replicaId]).toBe(0);
  const calls = jest.spyOn(DashboardClient.prototype, 'relayPeerCall');
  const download = jest.spyOn(DashboardClient.prototype, 'downloadFirstCopy');
  useMachine(fixture.tmp, returning.machine);
  const attached = await joinThroughDashboard({
    folder: returning.root,
    address: 'rbook://owner/first-share',
  });
  expect(download).not.toHaveBeenCalled();
  const after = await onCopy(fixture.tmp, returning, (client) => ({
    replica: readReplicaIdentity(client, { fresh: true }),
    changes: client.getMany('SELECT change_id FROM record_changes ORDER BY change_id').data,
  }));
  expect(after.replica).toEqual(before.replica);
  for (const row of before.changes ?? []) expect(after.changes).toContainEqual(row);
  expect(attached.success).toBe(true);
  expect(remote.body.data?.cuts[returning.replicaId]).toBe(0);
  expect(calls.mock.calls.some(([, sent]) => sent.method === 'hello')).toBe(true);
  const pending = await onCopy(fixture.tmp, returning, mergeContext, { replicaCheck: false });
  expect(pending.pending?.value.authority).toBe(remote.body.data?.authority);
  expect(pending.authority).not.toBe(remote.body.data?.authority);
  const routes = await onCopy(fixture.tmp, returning, peerHealth, { replicaCheck: false });
  expect(
    routes.some(
      (peer) =>
        peer.replicaId === remote.body.data?.authority &&
        isDashboardRoute(peer.route) &&
        peer.route.url === url &&
        peer.route.projectId === 'first-share'
    )
  ).toBe(true);
  useMachine(fixture.tmp, returning.machine);
  const confirmed = await call('rbook_project', {
    action: 'sync',
    confirmOwner: true,
    projectRoot: returning.root,
  });
  expect(confirmed.success).toBe(true);
  // Confirmation is a separate explicit operation, not an exchange. Re-attaching again must
  // now take the cut copy's successor and report the identity actually kept by that exchange.
  const returned = await joinThroughDashboard({
    folder: returning.root,
    address: 'rbook://owner/first-share',
  });
  expect(returned.success).toBe(true);
  const resumed = await onCopy(fixture.tmp, returning, mergeContext, { replicaCheck: false });
  expect(resumed.pending).toBeNull();
  expect(resumed.authority).toBe(remote.body.data?.authority);
  expect(resumed.ownReplica).not.toBe(returning.replicaId);
  expect(resumed.members.get(returning.replicaId)?.cut).toBe(0);
  const retained = await snapshot(returning);
  for (const row of before.changes ?? []) expect(retained.changes).toContainEqual(row);
  expect(download).not.toHaveBeenCalled();
  expect(returned.data?.sync?.reidentified).toBeDefined();
  const host = new Database(
    path.join(fixture.tmp, 'host', 'referee', 'first-share', 'rbook.sqlite'),
    { readonly: true }
  );
  try {
    expect(
      host
        .prepare('SELECT decision_text FROM strategic_decisions WHERE decision_text = ?')
        .all('Unsent after the copy was set aside.')
    ).toEqual([]);
    const states = host
      .prepare(
        'SELECT state FROM record_txn_state WHERE txn_id IN (SELECT DISTINCT txn_id FROM record_changes WHERE replica_id = ?)'
      )
      .all(returning.replicaId) as { state: string }[];
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((row) => row.state === 'quarantined')).toBe(true);
  } finally {
    host.close();
  }
  const rendered = formatSharedProjectForLLM('join', returned);
  jest.spyOn(joinModule, 'joinThroughDashboard').mockResolvedValue(returned);
  const output: string[] = [];
  const errors: string[] = [];
  expect(
    await runJoinDashboard(
      'rbook://owner/first-share',
      {},
      {
        cwd: returning.root,
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
  expect(errors).toEqual([]);
  expect({
    returnedIdentity: returned.data?.reattached,
    mcpClaimsUnchanged: rendered.includes('keeping its identity'),
    cliClaimsUnchanged: output.join(' ').includes('keeping its identity'),
  }).toEqual({
    returnedIdentity: { replicaId: retained.replica!.replicaId, block: retained.replica!.block },
    mcpClaimsUnchanged: false,
    cliClaimsUnchanged: false,
  });
  expect(rendered).toContain(retained.replica!.replicaId);
  expect(output.join(' ')).toContain(retained.replica!.replicaId);
});

it('reports the successor when the first dashboard attachment follows a separately confirmed move', async () => {
  const { owner, returning } = await firstShare();
  // The owner can carry the same recorded move to this copy before it has a dashboard route.
  await sync(fixture.tmp, owner, returning);
  expect(
    (await onCopy(fixture.tmp, returning, confirmOwner, { replicaCheck: false })).success
  ).toBe(true);
  const before = await snapshot(returning);
  expect(before.peers.filter((peer) => isDashboardRoute(peer.route))).toEqual([]);
  const download = jest.spyOn(DashboardClient.prototype, 'downloadFirstCopy');
  useMachine(fixture.tmp, returning.machine);
  const attached = await joinThroughDashboard({
    folder: returning.root,
    address: 'rbook://owner/first-share',
  });
  expect(attached.success).toBe(true);
  expect(attached.data?.sync?.reidentified).toBeDefined();
  expect(download).not.toHaveBeenCalled();
  const after = await snapshot(returning);
  expect(after.replica!.replicaId).not.toBe(before.replica!.replicaId);
  expect(attached.data?.reattached).toEqual(after.replica);
  for (const row of before.changes ?? []) expect(after.changes).toContainEqual(row);
  expect(
    after.peers.some(
      (peer) => isDashboardRoute(peer.route) && peer.route.projectId === 'first-share'
    )
  ).toBe(true);
});

it.each([
  'wrong-account',
  'unadmitted-replica',
  'wrong-record',
  'noncut',
  'removed',
  'null-cut',
  'negative-cut',
  'fractional-cut',
] as const)(
  'refuses first attachment for %s after authenticated identity checks and preserves the existing store',
  async (mode) => {
    const { returning } = await firstShare(mode !== 'noncut');
    const copy =
      mode === 'unadmitted-replica' ? await ownerCopy(fixture.tmp, 'unknown') : returning;
    await signIn(copy, mode === 'wrong-account' ? 'other-token' : 'owner-token');
    const before = await snapshot(copy);
    const original = DashboardClient.prototype.relayPeerCall;
    const relayed = jest
      .spyOn(DashboardClient.prototype, 'relayPeerCall')
      .mockImplementation(async function (this: DashboardClient, projectId, sent) {
        const answer = await original.call(this, projectId, sent);
        if (sent.method === 'hello' && answer.success && answer.data) {
          const body = answer.data.body as {
            data?: { projectId: string; removed: string[]; cuts: Record<string, number | null> };
          };
          if (body.data && mode === 'wrong-record') body.data.projectId = 'another-record';
          if (body.data && mode === 'removed') body.data.removed = [copy.replicaId];
          if (body.data && mode === 'null-cut') body.data.cuts[copy.replicaId] = null;
          if (body.data && mode === 'negative-cut') body.data.cuts[copy.replicaId] = -1;
          if (body.data && mode === 'fractional-cut') body.data.cuts[copy.replicaId] = 0.5;
        }
        return answer;
      });
    const download = jest.spyOn(DashboardClient.prototype, 'downloadFirstCopy');
    const result = await attach(copy);
    expect(result.success).toBe(false);
    expect(relayed.mock.calls.some(([, sent]) => sent.method === 'hello')).toBe(true);
    expect(relayed.mock.calls.some(([, sent]) => sent.method !== 'hello')).toBe(false);
    expect(download).not.toHaveBeenCalled();
    expect(await snapshot(copy)).toEqual(before);
  }
);

it.each([false, true])(
  'never bypasses mismatching prior dashboard provenance, ended=%s',
  async (ended) => {
    const { owner, returning } = await firstShare();
    await onCopy(fixture.tmp, returning, (client) =>
      rememberPeer(client, owner.replicaId, {
        route: {
          kind: 'dashboard',
          url: 'https://original.example',
          projectId: 'original-project',
          ...(ended ? { ended: true as const } : {}),
        },
      })
    );
    const before = await snapshot(returning);
    const relay = jest.spyOn(DashboardClient.prototype, 'relayPeerCall');
    const result = await attach(returning);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/retained route/);
    expect(relay).not.toHaveBeenCalled();
    expect(await snapshot(returning)).toEqual(before);
  }
);
