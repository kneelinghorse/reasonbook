// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m10 (design §R2) — copies exchange through the reference server, in its own process, with the client's own
// ABOUTME: dashboard peer: the 4.1.0 checks, paging both ways, a transaction too large, the dashboard down, a newer copy.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { PassThrough } from 'stream';
import { CredentialStore } from '../../src/intelligence/credential-store';
import { writeUserAuthor } from '../../src/intelligence/user-author';
import { PROTOCOL_VERSION } from '../../src/tools/rbook/record-changes';
import { currentWriteProtocol } from '../../src/tools/rbook/record-protocol-state';
import { dashboardPeer } from '../../src/tools/rbook/record-dashboard-peer';
import type { DashboardRoute } from '../../src/tools/rbook/record-dashboard-route';
import {
  exchange,
  type ExchangeReport,
  type Hello,
  type Peer,
} from '../../src/tools/rbook/record-exchange';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import {
  answerJoin,
  applyJoin,
  requestJoin,
  type JoinAnswer,
  type JoinRequest,
} from '../../src/tools/rbook/record-join';
import { handOver } from '../../src/tools/rbook/record-moves';
import { nextTryAt, peerHealth, rememberPeer } from '../../src/tools/rbook/record-peers';
import { sharedRecordReview } from '../../src/tools/rbook/record-review';
import { storeOpener, syncPeers } from '../../src/tools/rbook/record-sync';
import {
  __resetSharedSyncScheduler,
  __runSharedSync,
  __sharedSyncTargets,
} from '../../src/tools/rbook/record-sync-scheduler';
import { serveSync, wirePeer } from '../../src/tools/rbook/record-wire';
import { readReplicaIdentity } from '../../src/tools/rbook/replica-identity';
import {
  recordNetworkFailures,
  request,
  spawnRefereeServer,
  type RunningServer,
} from '../helpers/referee-http';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import { copyPeer, onCopy, ownerCopy, read, type Copy } from '../helpers/shared-copies';

const PROJECT = 'proj-dash';
const TOKENS = { owner: 'tok-owner', darryl: 'tok-darryl', erin: 'tok-erin' } as const;
const ACCOUNTS = { owner: 'acct-owner', darryl: 'acct-darryl', erin: 'acct-erin' } as const;
/** Small, so a few dozen decisions take several pages and one long one takes more than a page. */
const LIMIT = 256 * 1024;

let fixture: ReplicaFixture;
let server: RunningServer;
let volume: string;

function startServer(
  port?: number,
  options: { publishLimit?: boolean } = {}
): Promise<RunningServer> {
  return spawnRefereeServer(path.join(fixture.tmp, `server-${port ?? 'first'}-${Date.now()}`), {
    ...options,
    root: volume,
    accounts: {
      [TOKENS.owner]: ACCOUNTS.owner,
      [TOKENS.darryl]: ACCOUNTS.darryl,
      [TOKENS.erin]: ACCOUNTS.erin,
    },
    projects: { [PROJECT]: { ownerAccountId: ACCOUNTS.owner } },
    requestLimit: LIMIT,
    ...(port ? { port } : {}),
  });
}

/** s98-m08: what the network said when a dashboard call failed (see recordNetworkFailures). */
let network: ReturnType<typeof recordNetworkFailures>;
beforeAll(() => {
  network = recordNetworkFailures();
});
beforeEach(() => {
  network.failures.length = 0;
});
afterAll(() => network.restore());

let switchWas: string | undefined;
let dashboardWas: string | undefined;
beforeEach(async () => {
  switchWas = process.env.RBOOK_SHARED_SYNC;
  dashboardWas = process.env.RBOOK_DASHBOARD_URL;
  delete process.env.RBOOK_SHARED_SYNC;
  fixture = replicaFixture('rbook-dash-');
  volume = path.join(fixture.tmp, 'volume');
  server = await startServer();
  // This machine's dashboard is the reference server: it signs in to no other (critics, round 1).
  process.env.RBOOK_DASHBOARD_URL = server.url;
});
afterEach(async () => {
  await server.stop();
  __resetSharedSyncScheduler();
  if (switchWas === undefined) delete process.env.RBOOK_SHARED_SYNC;
  else process.env.RBOOK_SHARED_SYNC = switchWas;
  if (dashboardWas === undefined) delete process.env.RBOOK_DASHBOARD_URL;
  else process.env.RBOOK_DASHBOARD_URL = dashboardWas;
  fixture.restore();
});

const route = (): DashboardRoute => ({ kind: 'dashboard', url: server.url, projectId: PROJECT });

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

/** A machine signed in to the reference server: a user key in that machine's own credential store. */
async function signIn(machine: string, token: string): Promise<void> {
  useMachine(fixture.tmp, machine);
  const at = new Date().toISOString();
  await (
    await CredentialStore.create()
  ).upsertUserScopedKey(`key-${machine}`, {
    key: token,
    label: machine,
    issuedAt: at,
    lastUsedAt: at,
  });
}

/** What sharing or joining through the dashboard leaves a copy with (s97-m11): a sign-in and the referee's route. */
async function routed(copy: Copy, refereeReplica: string, token: string): Promise<void> {
  await signIn(copy.machine, token);
  await onCopy(
    fixture.tmp,
    copy,
    (client) => rememberPeer(client, refereeReplica, { route: route() }),
    { replicaCheck: false }
  );
}

/** One sync, as `reasonbook sync` runs it from the project folder. */
function syncNow(copy: Copy, options: { readonly auto?: boolean } = {}) {
  useMachine(fixture.tmp, copy.machine);
  const dbPath = dbOf(copy.root);
  return syncPeers(storeOpener(dbPath), {
    unchecked: storeOpener(dbPath, { replicaCheck: false }),
    projectRoot: copy.root,
    ...options,
  });
}

async function synced(copy: Copy): Promise<ExchangeReport> {
  const result = await syncNow(copy);
  if (!result.success)
    throw new Error(
      `${copy.name}: ${JSON.stringify(result.error)}; the network said: ${network.failures.join(' | ') || 'nothing'}; reference server: ${JSON.stringify(server.diagnostics())}`
    );
  return result.data!.peers[0].report!;
}

/** The handover in over the routes, every exchange through the owner's own dashboard peer. */
async function handIn(): Promise<{ owner: Copy; refereeReplica: string; caught: ExchangeReport }> {
  const owner = await ownerCopy(fixture.tmp);
  await on(owner, 'rbook_decisions', {
    action: 'record',
    content: 'Decided before the dashboard held it.',
  });
  const upload = path.join(fixture.tmp, 'upload.sqlite');
  await buildFreshCopy(dbOf(owner.root), upload);
  const created = await request<{ joinRequest: JoinRequest }>(
    server,
    `/api/relay/projects/${PROJECT}/referee`,
    {
      token: TOKENS.owner,
      body: fs.readFileSync(upload),
      headers: { 'content-type': 'application/octet-stream' },
    }
  );
  expect(created.status).toBe(200);
  const joinRequest = created.body.data!.joinRequest;
  const answer = await onCopy(fixture.tmp, owner, (client) =>
    answerJoin(client, joinRequest, 'Owner')
  );
  const applied = await request(server, `/api/relay/projects/${PROJECT}/referee/answer`, {
    token: TOKENS.owner,
    json: { answer: answer.data },
  });
  expect(applied.status).toBe(200);
  await routed(owner, joinRequest.replicaId, TOKENS.owner);
  await synced(owner);
  expect(
    (await onCopy(fixture.tmp, owner, (client) => handOver(client, { to: joinRequest.replicaId })))
      .error
  ).toBeUndefined();
  const caught = await synced(owner);
  await synced(owner);
  return { owner, refereeReplica: joinRequest.replicaId, caught };
}

/** A member joined from a downloaded first copy, routed to the referee. */
async function join(name: 'darryl' | 'erin', refereeReplica: string): Promise<Copy> {
  const [token, accountId] = [TOKENS[name], ACCOUNTS[name]];
  const shared = await request(server, `/api/test/projects/${PROJECT}/shares`, {
    token: TOKENS.owner,
    json: { accountId, name, role: 'editor' },
  });
  expect(shared.status).toBe(200);
  const response = await fetch(`${server.url}/api/relay/projects/${PROJECT}/first-copy`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const root = path.join(fixture.tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  fs.writeFileSync(dbOf(root), Buffer.from(await response.arrayBuffer()));
  const place = { name, root, machine: `machine-${name}`, replicaId: '', block: -1 };
  useMachine(fixture.tmp, place.machine);
  writeUserAuthor(name);
  const asked = await onCopy(fixture.tmp, place, (client) => requestJoin(client), {
    replicaCheck: false,
  });
  const answered = await request<JoinAnswer>(server, `/api/relay/projects/${PROJECT}/peer`, {
    token,
    json: { method: 'answerJoin', params: asked.data, replicaId: asked.data!.replicaId },
  });
  expect(answered.status).toBe(200);
  const applied = await onCopy(
    fixture.tmp,
    place,
    (client) => applyJoin(client, answered.body.data!),
    { replicaCheck: false }
  );
  expect(applied.error).toBeUndefined();
  const copy = { ...place, replicaId: applied.data!.replicaId, block: applied.data!.block };
  await routed(copy, refereeReplica, token);
  return copy;
}

const decisions = (copy: Copy, like: string): number =>
  read<{ n: number }>(
    copy,
    'SELECT count(*) AS n FROM strategic_decisions WHERE decision_text LIKE ?',
    [like]
  )[0].n;

const requests = async () =>
  (
    await request<{ calls: Record<string, number>; largestRequest: number }>(
      server,
      `/api/test/projects/${PROJECT}/requests`,
      { token: TOKENS.owner }
    )
  ).body.data!;

/** A copy's own peer, saying something else in its hello or of its chains. */
function saying(
  copy: Copy,
  change: {
    hello?: (hello: Hello) => Hello;
    chains?: (at: Record<string, string | null>) => Record<string, string | null>;
  }
): Peer {
  const peer = copyPeer(fixture.tmp, copy);
  return {
    ...peer,
    hello: async () => (change.hello ?? ((hello: Hello) => hello))(await peer.hello()),
    chains: async (at) => (change.chains ?? ((held) => held))(await peer.chains(at)),
  };
}

async function peerOf(
  copy: Copy,
  options: { recordProtocol?: number; maxStreamBytes?: number } = {}
): Promise<Peer> {
  useMachine(fixture.tmp, copy.machine);
  return dashboardPeer(route(), {
    projectRoot: copy.root,
    replicaIdNow: () =>
      onCopy(
        fixture.tmp,
        copy,
        (client) => readReplicaIdentity(client, { fresh: true })!.replicaId,
        {
          replicaCheck: false,
        }
      ),
    recordProtocolNow: () =>
      onCopy(fixture.tmp, copy, currentWriteProtocol, { replicaCheck: false }),
    ...options,
  });
}

describe('the dashboard transport (s97-m10)', () => {
  it('copies exchange through the dashboard with the 4.1.0 checks: epochs, chains, pairing and refusals', async () => {
    const { owner, refereeReplica, caught } = await handIn();
    // The move to the referee's copy went through the dashboard peer, behind an epoch and caught up.
    expect(caught.caughtUp).toMatchObject({
      copy: 'remote',
      epoch: 2,
      authority: refereeReplica,
      confirmed: true,
    });
    const darryl = await join('darryl', refereeReplica);
    await on(owner, 'rbook_decisions', {
      action: 'record',
      content: 'The owner, through the dashboard.',
    });
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl, through the dashboard.',
    });
    await synced(owner);
    const darrylSync = await synced(darryl);
    await synced(owner);
    for (const copy of [owner, darryl]) expect(decisions(copy, '%through the dashboard.')).toBe(2);
    // Both copies hash the referee's stream alike up to the mark both hold.
    expect(darrylSync.digest.hash).toEqual(expect.any(String));
    // The exchange's own checks run unchanged against the dashboard peer.
    const remote = await peerOf(darryl);
    const otherProject = await exchange(
      saying(darryl, { hello: (hello) => ({ ...hello, projectId: 'another-project' }) }),
      remote
    );
    expect(otherProject.error?.message).toMatch(/holds project/);
    const twoOwners = await exchange(
      saying(darryl, { hello: (hello) => ({ ...hello, authority: darryl.replicaId }) }),
      remote
    );
    expect(twoOwners.error?.code).toBe('RECORD_AUTHORITY_DIFFERS');
    const forkedChain = await exchange(
      saying(darryl, {
        chains: (held) => ({ ...held, [refereeReplica]: 'f'.repeat(64) }),
      }),
      remote
    );
    expect(forkedChain.error?.code).toBe('RECORD_AUTHORITY_DIFFERS');
    // Darryl's copy is untouched by the refused exchanges, and syncs on.
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl, after the refusals.',
    });
    await synced(darryl);
    await synced(owner);
    expect(decisions(owner, 'Darryl, after the refusals.')).toBe(1);
  }, 600000);

  it('pages both ways by whole transactions, and refuses here a transaction no page can carry', async () => {
    const { owner, refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    // More than the referee's least page (1 MiB) in all, so both directions take several pages.
    const text = (index: number) => `Paged decision ${index}: ${'x'.repeat(50_000)}`;
    for (let index = 0; index < 25; index += 1)
      await on(darryl, 'rbook_decisions', { action: 'record', content: text(index) });
    const before = await requests();
    await synced(darryl);
    const sent = await requests();
    expect(sent.calls.apply - (before.calls.apply ?? 0)).toBeGreaterThan(1);
    expect(sent.largestRequest).toBeLessThanOrEqual(LIMIT);
    await synced(owner);
    const received = await requests();
    expect(received.calls.changesSince - sent.calls.changesSince).toBeGreaterThan(1);
    expect(decisions(owner, 'Paged decision %')).toBe(25);
    // One transaction larger than a page stays here with what follows it, said with its code and
    // remedy; what came before it goes, and this copy still takes in everyone else's changes.
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Before the large one.' });
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: `Too large: ${'y'.repeat(LIMIT)}`,
    });
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'After the large one.' });
    await on(owner, 'rbook_decisions', { action: 'record', content: 'The owner, meanwhile.' });
    await synced(owner);
    const refused = await syncNow(darryl);
    expect(refused.error).toMatchObject({
      code: 'RECORD_TRANSACTION_TOO_LARGE',
      suggestion: expect.stringMatching(/stays on this copy with what this copy wrote after it/),
    });
    await synced(owner);
    expect({
      before: decisions(owner, 'Before the large one.'),
      large: decisions(owner, 'Too large:%'),
      after: decisions(owner, 'After the large one.'),
      meanwhile: decisions(darryl, 'The owner, meanwhile.'),
    }).toEqual({ before: 1, large: 0, after: 0, meanwhile: 1 });
    // Shown in the review, and not waited out: the dashboard itself is answering.
    const review = await onCopy(fixture.tmp, darryl, (client) => sharedRecordReview(client), {
      replicaCheck: false,
    });
    expect(JSON.stringify(review)).toMatch(/last error: Transaction .* bytes of changes/);
    expect(JSON.stringify(review)).not.toMatch(/failing since/);
  }, 600000);

  it('with the dashboard down, writes go on, the review names the failure and its start, and the next sync catches up', async () => {
    const { owner, refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    const port = Number(new URL(server.url).port);
    await server.stop();
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Written while the dashboard was down.',
    });
    const down = await syncNow(darryl);
    expect(down.error?.message).toMatch(/could not be reached/);
    const review = await onCopy(fixture.tmp, darryl, (client) => sharedRecordReview(client), {
      replicaCheck: false,
    });
    expect(JSON.stringify(review)).toMatch(
      /the dashboard \(127\.0\.0\.1:\d+\): .*failing since \d+ min ago \(1 try\).*last error: .*could not be reached/
    );
    // A sync no person started waits the failure out; one a person starts tries at once.
    const waited = await syncNow(darryl, { auto: true });
    expect(waited.data?.peers[0].nextTryAt).toEqual(expect.any(String));
    server = await startServer(port);
    await synced(darryl);
    await synced(owner);
    expect(decisions(owner, 'Written while the dashboard was down.')).toBe(1);
    const after = await onCopy(fixture.tmp, darryl, (client) => sharedRecordReview(client), {
      replicaCheck: false,
    });
    expect(JSON.stringify(after)).not.toMatch(/failing since/);
  }, 600000);

  it('a copy newer than the referee is refused at the exchange, and keeps its changes', async () => {
    const { owner, refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    await on(darryl, 'rbook_decisions', { action: 'record', content: 'Written on a newer copy.' });
    // The referee refuses it at its hello, with its code and remedy, which a sync answers with.
    await expect(
      exchange(
        copyPeer(fixture.tmp, darryl),
        await peerOf(darryl, { recordProtocol: PROTOCOL_VERSION + 1 })
      )
    ).rejects.toMatchObject({
      refusal: {
        code: 'REFEREE_PROTOCOL_NEWER',
        suggestion: expect.stringMatching(/stay safe on your copy/),
      },
    });
    await synced(owner);
    expect(decisions(owner, 'Written on a newer copy.')).toBe(0);
    expect(decisions(darryl, 'Written on a newer copy.')).toBe(1);
  }, 600000);

  it('a copy whose project the dashboard referees answers no SSH sync, and tells a 4.1.0 copy how to re-attach', async () => {
    const { owner } = await handIn();
    // The 4.1.0 near end shows a far end's error as `<name>: <message>`; its code is today's (record-wire.ts).
    const requests = new PassThrough();
    const answers = new PassThrough();
    const served = serveSync(
      requests,
      answers,
      (step) => onCopy(fixture.tmp, owner, step),
      {},
      (step) => onCopy(fixture.tmp, owner, step, { replicaCheck: false })
    );
    const near = await wirePeer('the owner machine', answers, requests, () => requests.end());
    // A 4.1.0 copy sends no hello of its own; returning copies get the dashboard re-attach remedy.
    await expect(near.hello()).rejects.toThrow(
      /the owner machine: This project is shared through the dashboard .*install Reasonbook 4\.5\.0 or later where you are syncing from, then run reasonbook join --dashboard .*Copies already attached sync with reasonbook sync\. Over SSH this copy takes in only a catch-up .*Reasonbook 4\.2\.1 or later on both machines/
    );
    near.close();
    await served;
  }, 600000);
});

/** A stand-in Reasonbook entry that writes the arguments it was started with, as a hook starts one. */
function fakeEntry(): { readonly bin: string; readonly marker: string } {
  const dist = path.join(fixture.tmp, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const marker = path.join(fixture.tmp, 'launched.json');
  fs.writeFileSync(
    path.join(dist, 'bin.js'),
    `const fs = require('fs');\n` +
      `const marker = ${JSON.stringify(marker)}, temporary = marker + '.' + process.pid + '.tmp';\n` +
      `fs.writeFileSync(temporary, JSON.stringify(process.argv.slice(2)));\n` +
      `fs.renameSync(temporary, marker);\n`
  );
  fs.writeFileSync(path.join(dist, 'cli.js'), '');
  return { bin: path.join(dist, 'bin.js'), marker };
}

/**
 * The sync a hook launched, as the fake entry recorded it. s98-m08: a launched process can take
 * seconds to start on a loaded machine, so a launch gets 20 s; a check that nothing launched keeps
 * 3 s, which the launch it guards against would have used.
 */
async function launched(marker: string, waitMs = 20_000): Promise<unknown> {
  for (const until = Date.now() + waitMs; !fs.existsSync(marker) && Date.now() < until; )
    await new Promise((resolve) => setTimeout(resolve, 50));
  return fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
}

async function hook(copy: Copy, event: string): Promise<void> {
  useMachine(fixture.tmp, copy.machine);
  await runCli(['hook', event, '--format', 'text'], {
    env: process.env,
    cwd: copy.root,
    // s98-m08: room load cannot spend (#1558); a hook that ran out of its deadline launched nothing.
    startedAtMs: Date.now() + 20_000,
    readStdin: async () =>
      JSON.stringify({ cwd: copy.root, session_id: `hook-${event}`, source: 'startup' }),
    stdout: () => undefined,
    stderr: () => undefined,
  });
}

async function cli(copy: Copy, argv: string[]): Promise<{ code: number; stderr: string[] }> {
  useMachine(fixture.tmp, copy.machine);
  const stderr: string[] = [];
  const io: CliIo = {
    env: process.env,
    cwd: copy.root,
    readStdin: async () => '',
    stdout: () => undefined,
    stderr: (line) => {
      stderr.push(line);
    },
  };
  return { code: await runCli(argv, io), stderr };
}

describe('what the dashboard peer says when it cannot exchange (s97-m10)', () => {
  it('a sign-in the dashboard refuses, none at all, a project it does not know, or no project folder', async () => {
    const { refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    await signIn(darryl.machine, 'tok-wrong');
    expect((await syncNow(darryl)).error?.message).toMatch(/did not accept this machine's sign-in/);
    // No sign-in on this machine at all, and none in its environment either.
    const saved = [
      'RBOOK_DASHBOARD_API_KEY',
      'RBOOK_DASHBOARD_USER',
      'RBOOK_DASHBOARD_PASSWORD',
    ].map((key) => [key, process.env[key]] as const);
    for (const [key] of saved) delete process.env[key];
    try {
      useMachine(fixture.tmp, darryl.machine);
      fs.rmSync(path.join(process.env.RBOOK_CONFIG_DIR!, 'credentials.json'), { force: true });
      expect((await syncNow(darryl)).error?.message).toMatch(/has no sign-in for the dashboard/);
    } finally {
      for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
    }
    await signIn(darryl.machine, TOKENS.darryl);
    await onCopy(
      fixture.tmp,
      darryl,
      (client) =>
        rememberPeer(client, refereeReplica, { route: { ...route(), projectId: 'nope' } }),
      { replicaCheck: false }
    );
    expect((await syncNow(darryl)).error?.message).toMatch(/knows no such shared project/);
    await routed(darryl, refereeReplica, TOKENS.darryl);
    useMachine(fixture.tmp, darryl.machine);
    const dbPath = dbOf(darryl.root);
    const folderless = await syncPeers(storeOpener(dbPath), {
      unchecked: storeOpener(dbPath, { replicaCheck: false }),
    });
    expect(folderless.error?.message).toMatch(/named no project folder/);
    expect((await syncNow(darryl)).success).toBe(true);
  }, 600000);

  it('a sync that holds back a transaction too large ends a failing streak: the dashboard answered', async () => {
    const { refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    const port = Number(new URL(server.url).port);
    await server.stop();
    for (const attempt of [1, 2]) expect((await syncNow(darryl)).success).toBe(false);
    server = await startServer(port);
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: `Too large: ${'y'.repeat(LIMIT)}`,
    });
    expect((await syncNow(darryl)).error?.code).toBe('RECORD_TRANSACTION_TOO_LARGE');
    const health = await onCopy(
      fixture.tmp,
      darryl,
      (client) => peerHealth(client).find((peer) => peer.replicaId === refereeReplica)!,
      { replicaCheck: false }
    );
    expect({
      failures: health.failures,
      since: health.failingSince,
      ok: health.lastOkAt !== null,
      next: nextTryAt(health),
    }).toEqual({ failures: 0, since: null, ok: true, next: null });
  }, 600000);

  it('a sync past the most it takes in from the stream applies what came, and the next takes up the rest', async () => {
    const { owner, refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    for (let index = 0; index < 25; index += 1)
      await on(darryl, 'rbook_decisions', {
        action: 'record',
        content: `Streamed decision ${index}: ${'x'.repeat(50_000)}`,
      });
    await synced(darryl);
    const capped = await peerOf(owner, { maxStreamBytes: 1 });
    expect((await exchange(copyPeer(fixture.tmp, owner), capped)).error).toBeUndefined();
    const first = decisions(owner, 'Streamed decision %');
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(25);
    expect((await exchange(copyPeer(fixture.tmp, owner), capped)).error).toBeUndefined();
    expect(decisions(owner, 'Streamed decision %')).toBe(25);
  }, 600000);

  it('a dashboard that publishes no limit refuses a page as too large, and says the limit it holds', async () => {
    const { refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    const port = Number(new URL(server.url).port);
    await server.stop();
    server = await startServer(port, { publishLimit: false });
    for (let index = 0; index < 60; index += 1)
      await on(darryl, 'rbook_decisions', {
        action: 'record',
        content: `Unpaged decision ${index}: ${'x'.repeat(6000)}`,
      });
    expect((await syncNow(darryl)).error?.message).toMatch(
      new RegExp(`refused a request as too large \\(its limit is ${LIMIT} bytes\\)`)
    );
  }, 600000);

  it('a far copy writing a newer record protocol is not refused for that alone: only the referee refuses a newer copy', async () => {
    const { refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    const remote = await peerOf(darryl);
    // Design §Versions: the dashboard deploys first, so an older copy keeps syncing with a newer referee.
    const olderHere = await exchange(copyPeer(fixture.tmp, darryl), {
      ...remote,
      hello: async () => ({ ...(await remote.hello()), recordProtocol: PROTOCOL_VERSION + 1 }),
    });
    expect(olderHere.error).toBeUndefined();
    // A page asked for as one byte still holds at least a mebibyte at the referee.
    const page = await request<{ changes: unknown[]; more: boolean }>(
      server,
      `/api/relay/projects/${PROJECT}/peer`,
      {
        token: TOKENS.darryl,
        json: {
          method: 'changesSince',
          params: { marks: {}, maxBytes: 1 },
          replicaId: darryl.replicaId,
        },
      }
    );
    expect(page.status).toBe(200);
    expect(page.body.data!.changes.length).toBeGreaterThan(1);
  }, 600000);
});

/** Credentials in the environment, cleared for a test and put back after it. */
function withoutEnvCredentials(): () => void {
  const keys = ['RBOOK_DASHBOARD_API_KEY', 'RBOOK_DASHBOARD_USER', 'RBOOK_DASHBOARD_PASSWORD'];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  return () => {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
}

describe("where this machine's sign-in goes, and what a bundle cannot carry (s97-m10 critics, round 1)", () => {
  it('a route naming another dashboard, or one not over HTTPS, gets no sign-in and no request; a password is never sent', async () => {
    const { refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    // A copy carried from elsewhere can name any dashboard: one this machine does not use hears nothing.
    let heard = 0;
    const decoy = http.createServer((request, response) => {
      heard += 1;
      response.end('{}');
    });
    await new Promise<void>((resolve) => decoy.listen(0, '127.0.0.1', resolve));
    const decoyUrl = `http://127.0.0.1:${(decoy.address() as { port: number }).port}`;
    try {
      await onCopy(
        fixture.tmp,
        darryl,
        (client) => rememberPeer(client, refereeReplica, { route: { ...route(), url: decoyUrl } }),
        { replicaCheck: false }
      );
      expect((await syncNow(darryl)).error?.message).toMatch(
        /sends the dashboard \(127\.0\.0\.1:\d+\) no sign-in, since its route names 127\.0\.0\.1:\d+, and this machine signs in only to 127\.0\.0\.1:\d+/
      );
      expect(heard).toBe(0);
    } finally {
      await new Promise((resolve) => decoy.close(resolve));
    }
    // Plain HTTP is for this machine alone.
    process.env.RBOOK_DASHBOARD_URL = 'http://dashboard.example';
    await onCopy(
      fixture.tmp,
      darryl,
      (client) =>
        rememberPeer(client, refereeReplica, {
          route: { ...route(), url: 'http://dashboard.example' },
        }),
      { replicaCheck: false }
    );
    expect((await syncNow(darryl)).error?.message).toMatch(/is not reached over HTTPS/);
    process.env.RBOOK_DASHBOARD_URL = server.url;
    // A machine that signs in with a password only sends none in a sync.
    await routed(darryl, refereeReplica, TOKENS.darryl);
    useMachine(fixture.tmp, darryl.machine);
    fs.rmSync(path.join(process.env.RBOOK_CONFIG_DIR!, 'credentials.json'), { force: true });
    const restore = withoutEnvCredentials();
    process.env.RBOOK_DASHBOARD_USER = 'darryl@example.com';
    process.env.RBOOK_DASHBOARD_PASSWORD = 'not-to-be-sent';
    try {
      expect((await syncNow(darryl)).error?.message).toMatch(
        /with a password, which Reasonbook does not send to it/
      );
    } finally {
      restore();
    }
  }, 600000);

  it('a copy whose project the dashboard referees opens no SSH channel, keeps its dashboard route, and takes no route naming a place on the dashboard', async () => {
    const { refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    // Refused before any connection: no far copy can stand in for the referee (critics, round 2).
    const ssh = await cli(darryl, [
      'sync',
      '--project-root',
      darryl.root,
      '--ssh',
      'nowhere.invalid',
      '--remote-root',
      '/x',
    ]);
    expect({ code: ssh.code, said: ssh.stderr.join(' ') }).toEqual({
      code: 1,
      said: expect.stringMatching(/so this copy opens no SSH channel to another copy/),
    });
    await expect(
      onCopy(
        fixture.tmp,
        darryl,
        (client) =>
          rememberPeer(client, refereeReplica, { route: { host: 'darryl-mac', root: '/x' } }),
        { replicaCheck: false }
      )
    ).rejects.toMatchObject({ refusal: { code: 'RECORD_EXCHANGE_REFUSED' } });
    // A route that names a place on the configured dashboard sends nothing there.
    await onCopy(
      fixture.tmp,
      darryl,
      (client) =>
        rememberPeer(client, refereeReplica, {
          route: { ...route(), url: `${server.url}/api/projects/${PROJECT}/archive?` },
        }),
      { replicaCheck: false }
    );
    const before = await requests();
    expect((await syncNow(darryl)).error?.message).toMatch(/names a place on the dashboard/);
    expect(await requests()).toEqual(before);
  }, 600000);

  it('a copy whose project the dashboard referees writes and takes in no bundle', async () => {
    const { refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    for (const verb of [
      ['--bundle-out', path.join(fixture.tmp, 'out.json')],
      ['--bundle-in', path.join(fixture.tmp, 'in.json')],
    ]) {
      const ran = await cli(darryl, ['sync', '--project-root', darryl.root, ...verb]);
      expect({ verb: verb[0], code: ran.code, said: ran.stderr.join(' ') }).toEqual({
        verb: verb[0],
        code: 1,
        said: expect.stringMatching(/so its copies carry no bundles/),
      });
    }
    expect(fs.existsSync(path.join(fixture.tmp, 'out.json'))).toBe(false);
  }, 600000);
});

describe('what starts a sync through the dashboard (s97-m10)', () => {
  it('session start and end, the timer and a person each run the exchange; RBOOK_SHARED_SYNC=off stops all but the person', async () => {
    const { owner, refereeReplica } = await handIn();
    const darryl = await join('darryl', refereeReplica);
    // The hooks of a copy whose only route is the dashboard's start its sync, marked as no person's.
    const { bin, marker } = fakeEntry();
    const entry = process.argv[1];
    process.argv[1] = bin;
    try {
      for (const event of ['session-start', 'session-end']) {
        fs.rmSync(marker, { force: true });
        await hook(darryl, event);
        expect(await launched(marker)).toEqual(['sync', '--project-root', darryl.root, '--auto']);
      }
      // The sync a hook starts, run here as it runs there.
      await on(darryl, 'rbook_decisions', { action: 'record', content: 'Synced by a hook.' });
      expect((await cli(darryl, ['sync', '--project-root', darryl.root, '--auto'])).code).toBe(0);
      // The timer: a tool call hands the copy to it, and each tick syncs it.
      await on(darryl, 'rbook_decisions', { action: 'record', content: 'Synced by the timer.' });
      expect(__sharedSyncTargets()).toContain(darryl.root);
      await __runSharedSync(darryl.root);
      // A person, at the terminal and through the MCP tool.
      await on(darryl, 'rbook_decisions', { action: 'record', content: 'Synced on demand.' });
      expect((await cli(darryl, ['sync', '--project-root', darryl.root])).code).toBe(0);
      await on(darryl, 'rbook_decisions', { action: 'record', content: 'Synced by the tool.' });
      await on(darryl, 'rbook_project', { action: 'sync' });
      await synced(owner);
      expect(decisions(owner, 'Synced %')).toBe(4);
      // Off: the hooks start nothing and the timer syncs nothing; a person's sync still runs.
      process.env.RBOOK_SHARED_SYNC = 'off';
      fs.rmSync(marker, { force: true });
      await hook(darryl, 'session-end');
      expect(await launched(marker, 3_000)).toBeNull();
      await on(darryl, 'rbook_decisions', { action: 'record', content: 'Written while off.' });
      await __runSharedSync(darryl.root);
      await synced(owner);
      expect(decisions(owner, 'Written while off.')).toBe(0);
      expect((await cli(darryl, ['sync', '--project-root', darryl.root])).code).toBe(0);
      await synced(owner);
      expect(decisions(owner, 'Written while off.')).toBe(1);
    } finally {
      process.argv[1] = entry;
    }
  }, 600000);
});
