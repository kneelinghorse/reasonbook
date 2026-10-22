// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Re-share a moved-back project through the real client and reference HTTP host without losing members.
// ABOUTME: Preserve account identities across host restart and reconcile revoked grants before accepting writes.
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import path from 'path';
import { CredentialStore } from '../../src/intelligence/credential-store';
import { writeUserAuthor } from '../../src/intelligence/user-author';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import { peerHealth } from '../../src/tools/rbook/record-peers';
import { __resetSharedSyncScheduler } from '../../src/tools/rbook/record-sync-scheduler';
import { request, spawnRefereeServer, type RunningServer } from '../helpers/referee-http';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import { onCopy, read, type Copy } from '../helpers/shared-copies';
import type { HostedMember } from '../../src/referee';

const PROJECT = 'proj-share';
const ADDRESS = 'rbook://derek/shared';
const TOKENS = { owner: 'tok-owner', darryl: 'tok-darryl', other: 'tok-other' } as const;
const ACCOUNTS = { owner: 'acct-owner', darryl: 'acct-darryl', other: 'acct-other' } as const;
let fixture: ReplicaFixture;
let server: RunningServer;
let saved: Record<string, string | undefined>;

function startServer(port?: number) {
  const config = {
    root: path.join(fixture.tmp, 'volume'),
    accounts: Object.fromEntries(
      Object.keys(TOKENS).map((key) => [
        TOKENS[key as keyof typeof TOKENS],
        ACCOUNTS[key as keyof typeof ACCOUNTS],
      ])
    ),
    projects: { [PROJECT]: { ownerAccountId: ACCOUNTS.owner } },
    addresses: { 'derek/shared': PROJECT },
    requestLimit: 256 * 1024,
    reportedLibraryVersion: '4.5.0',
    port,
  };
  return spawnRefereeServer(path.join(fixture.tmp, 'server'), config);
}
beforeEach(async () => {
  saved = Object.fromEntries(
    ['RBOOK_DASHBOARD_URL', 'RBOOK_SHARED_SYNC', 'RBOOK_DASHBOARD_SHARING'].map((key) => [
      key,
      process.env[key],
    ])
  );
  delete process.env.RBOOK_SHARED_SYNC;
  process.env.RBOOK_DASHBOARD_SHARING = 'on';
  fixture = replicaFixture('rbook-reshare-');
  server = await startServer();
  process.env.RBOOK_DASHBOARD_URL = server.url;
});
afterEach(async () => {
  await server.stop();
  __resetSharedSyncScheduler();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fixture.restore();
});
async function signIn(copy: Copy, token: string) {
  useMachine(fixture.tmp, copy.machine);
  writeUserAuthor(copy.name);
  const at = new Date().toISOString();
  await (
    await CredentialStore.create()
  ).upsertUserScopedKey(`key-${copy.machine}`, {
    key: token,
    label: copy.machine,
    issuedAt: at,
    lastUsedAt: at,
  });
}
async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  return call(tool, { ...args, projectRoot: copy.root });
}
async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  const result = await on(copy, tool, args);
  if (!result.success) throw new Error(JSON.stringify(result));
  return result;
}
async function invite(accountId = ACCOUNTS.darryl as string, name = 'darryl') {
  return request<HostedMember>(server, `/api/test/projects/${PROJECT}/shares`, {
    token: TOKENS.owner,
    json: { accountId, name, role: 'editor' },
  });
}
async function sharedPair() {
  const owner: Copy = {
    name: 'Owner',
    root: project(fixture.tmp, 'owner'),
    machine: 'owner',
    replicaId: '',
    block: 0,
  };
  const db = new Database(dbOf(owner.root));
  db.prepare("INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', ?)").run(PROJECT);
  db.close();
  await signIn(owner, TOKENS.owner);
  await ok(owner, 'rbook_project', { action: 'share', via: 'dashboard', confirm: true });
  const invited = await invite();
  expect(invited.status).toBe(200);
  const darryl: Copy = {
    name: 'darryl',
    root: path.join(fixture.tmp, 'darryl'),
    machine: 'darryl',
    replicaId: '',
    block: -1,
  };
  await signIn(darryl, TOKENS.darryl);
  await ok(darryl, 'rbook_project', { action: 'join', via: 'dashboard', project: ADDRESS });
  await ok(darryl, 'rbook_decisions', { action: 'record', content: 'Kept before moving back.' });
  await ok(darryl, 'rbook_project', { action: 'sync' });
  const referee = await onCopy(fixture.tmp, owner, (client) => mergeContext(client).authority);
  return { owner, darryl, memberId: invited.body.data!.memberId, referee };
}
const savedProject = () =>
  JSON.parse(readFileSync(path.join(fixture.tmp, 'volume', 'server-state.json'), 'utf8'))[
    PROJECT
  ] as {
    shared: boolean;
    members: HostedMember[];
    formerRefereeReplicaIds?: string[];
  };
const stateOf = (copy: Copy) =>
  onCopy(
    fixture.tmp,
    copy,
    (client) => {
      const ctx = mergeContext(client);
      return {
        authority: ctx.authority,
        epoch: ctx.epoch,
        pending: ctx.pending?.value.epoch ?? null,
        replicaId: ctx.ownReplica,
      };
    },
    { replicaCheck: false }
  );

it('keeps bindings and actual former referee ids through archive and host restart', async () => {
  const { owner, memberId, referee } = await sharedPair();
  await ok(owner, 'rbook_project', { action: 'move', to: 'owner' });
  expect(savedProject()).toMatchObject({
    shared: false,
    formerRefereeReplicaIds: [referee],
    members: expect.arrayContaining([
      expect.objectContaining({ memberId, accountId: ACCOUNTS.darryl }),
    ]),
  });
  const port = Number(new URL(server.url).port);
  await server.stop();
  server = await startServer(port);
  await ok(owner, 'rbook_project', { action: 'share', via: 'dashboard', confirm: true });
  const repeated = await invite();
  expect(repeated.status).toBe(200);
  expect(repeated.body.data!.memberId).toBe(memberId);
  const wrongAccount = await invite(ACCOUNTS.other);
  expect(wrongAccount.body.error?.code).toBe('REFEREE_NAME_TAKEN');
}, 120000);

it('inverts the original repro: route revives, both held moves need confirmation, and the same member writes', async () => {
  const { owner, darryl, memberId, referee } = await sharedPair();
  const initialEpoch = (await stateOf(darryl)).epoch;
  await ok(owner, 'rbook_project', { action: 'move', to: 'owner' });
  await on(darryl, 'rbook_project', { action: 'sync' });
  const ended = await onCopy(fixture.tmp, darryl, (client) => peerHealth(client), {
    replicaCheck: false,
  });
  expect(ended.find((row) => row.replicaId === referee)?.route).toMatchObject({
    kind: 'dashboard',
    projectId: PROJECT,
    ended: true,
  });
  await ok(owner, 'rbook_project', { action: 'share', via: 'dashboard', confirm: true });
  const reinvited = await invite();
  expect(reinvited.status).toBe(200);
  expect(reinvited.body.data!.memberId).toBe(memberId);
  await ok(darryl, 'rbook_project', { action: 'sync' });
  expect((await stateOf(darryl)).pending).toBe(initialEpoch + 1);
  await ok(darryl, 'rbook_project', { action: 'sync', confirmOwner: true });
  expect((await stateOf(darryl)).epoch).toBe(initialEpoch + 1);
  expect((await stateOf(darryl)).pending).toBe(initialEpoch + 2);
  await ok(darryl, 'rbook_project', { action: 'sync', confirmOwner: true });
  expect((await stateOf(darryl)).epoch).toBe(initialEpoch + 2);
  expect((await stateOf(darryl)).pending).toBeNull();
  const identity = (await stateOf(darryl)).replicaId;
  await ok(darryl, 'rbook_project', { action: 'join', via: 'dashboard', project: ADDRESS });
  expect((await stateOf(darryl)).replicaId).toBe(identity);
  await ok(darryl, 'rbook_decisions', { action: 'record', content: 'Accepted after re-sharing.' });
  await ok(darryl, 'rbook_project', { action: 'sync' });
  await ok(owner, 'rbook_project', { action: 'sync' });
  for (const text of ['Kept before moving back.', 'Accepted after re-sharing.'])
    expect(
      read<{ n: number }>(
        owner,
        'SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = ?',
        [text]
      )[0].n
    ).toBe(1);
}, 120000);

it('removes a grant revoked while unshared at first authority reconciliation before the member can write', async () => {
  const { owner, darryl, memberId } = await sharedPair();
  await ok(owner, 'rbook_project', { action: 'move', to: 'owner' });
  const revoked = await request(server, `/api/test/projects/${PROJECT}/shares/${ACCOUNTS.darryl}`, {
    token: TOKENS.owner,
    method: 'DELETE',
  });
  expect(revoked.status).toBe(200);
  await ok(darryl, 'rbook_decisions', {
    action: 'record',
    content: 'Offline after grant revocation.',
  });
  await ok(owner, 'rbook_project', { action: 'share', via: 'dashboard', confirm: true });
  const members = await request<HostedMember[]>(server, `/api/test/projects/${PROJECT}/members`, {
    token: TOKENS.owner,
  });
  expect(members.body.data!.find((row) => row.memberId === memberId)?.role).toBe('removed');
  await on(darryl, 'rbook_project', { action: 'sync' });
  await ok(owner, 'rbook_project', { action: 'sync' });
  expect(savedProject().members.find((row) => row.memberId === memberId)?.role).toBe('removed');
  expect(
    read<{ n: number }>(
      owner,
      'SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = ?',
      ['Offline after grant revocation.']
    )[0].n
  ).toBe(0);
}, 120000);
