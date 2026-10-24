// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real SQLite and a loopback dashboard verify uploads, registration, WAL and failed-upload state.
// ABOUTME: RBOOK_UPLOAD_FIXTURE optionally supplies a real-store copy for the mission's positive-fire receipt.

import Database from 'better-sqlite3';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { createHash } from 'crypto';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import {
  triggerCheckpointBackfill,
  __drainCheckpointBackfill,
} from '../../../src/tools/rbook/checkpoint-backfill';
import {
  __resetDashboardUploadScheduler,
  readDashboardUploadStatus,
} from '../../../src/tools/rbook/dashboard-upload-scheduler';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { closeUploadReceipt } from '../../../src/tools/rbook/dashboard-upload-receipt';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import { rbookDbBackfill } from '../../../src/tools/rbook/rbook-db-backfill';
import { call } from '../../helpers/replica-fixture';

let root: string;
let dbPath: string;
let writer: Database.Database;
let graph: ProjectGraphRegistry;
let server: http.Server;
let requests: Array<{ url: string; body: Buffer; contentType: string }>;
let failStatus: number;
let listingStatus: number;
let listingUser: string;
let listedId: string | null;
let projectKeyDead: boolean;
let retryAfter: string | undefined;
const keys = [
  'RBOOK_CONFIG_DIR',
  'RBOOK_CHECKPOINT_SYNC',
  'RBOOK_DASHBOARD_API_KEY',
  'RBOOK_DASHBOARD_URL',
  'RBOOK_AGENT_ROLE',
  'RBOOK_PROJECT_ROOT',
] as const;
let previous: Record<string, string | undefined>;
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

beforeEach(async () => {
  previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-loopback-upload-'));
  dbPath = seedRbookDb(root, {
    projectId: 'upload-test',
    projectName: 'Upload Test',
    slug: 'upload-test',
    owner: 'tester',
    dashboardUsername: 'tester',
    dashboardProjectId: 'remote-test',
    rbookAddress: 'rbook://tester/upload-test',
  });
  if (process.env.RBOOK_UPLOAD_FIXTURE) {
    fs.rmSync(dbPath);
    const original = new Database(process.env.RBOOK_UPLOAD_FIXTURE, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await original.backup(dbPath);
    } finally {
      original.close();
    }
  }
  writer = new Database(dbPath);
  const metadata = writer.prepare(
    'INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  );
  for (const [key, value] of Object.entries({
    project_id: 'upload-test',
    project_name: 'Upload Test',
    dashboard_registered: 'true',
    dashboard_slug: 'upload-test',
    owner: 'tester',
    dashboard_username: 'tester',
    dashboard_project_id: 'remote-test',
  }))
    metadata.run(key, value);
  // A copied private fixture has its own address. Align only identity metadata with the loopback double.
  const identity = writer
    .prepare("SELECT content FROM contexts WHERE id='project_identity'")
    .get() as { content: string };
  writer.prepare("UPDATE contexts SET content=? WHERE id='project_identity'").run(
    JSON.stringify({
      ...JSON.parse(identity.content),
      project_id: 'upload-test',
      project_name: 'Upload Test',
      [LEGACY.identityAddressKey]: `${LEGACY.addressScheme}tester/upload-test`,
    })
  );
  writer.pragma('journal_mode = WAL');
  writer.exec('CREATE TABLE IF NOT EXISTS upload_witness(value TEXT)');
  writer.prepare('INSERT INTO upload_witness VALUES (?)').run('WAL included');
  ProjectGraphRegistry.resetInstance();
  graph = await ProjectGraphRegistry.create({
    configDir: path.join(root, 'config'),
    ephemeralRoots: [],
    now: () => Date.now(),
  });
  graph.register({ project_id: 'upload-test', store_path: root, name: 'Upload Test' });
  RbookDetector.resetInstance();
  requests = [];
  failStatus = 0;
  listingStatus = 0;
  listingUser = 'tester';
  listedId = 'remote-test';
  projectKeyDead = false;
  retryAfter = undefined;
  process.env.RBOOK_CONFIG_DIR = path.join(root, 'config');
  CredentialStore.resetInstance();
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (data: Buffer) => chunks.push(data));
    req.on('end', () => {
      const url = req.url ?? '';
      requests.push({
        url,
        body: Buffer.concat(chunks),
        contentType: String(req.headers['content-type'] ?? ''),
      });
      res.setHeader('content-type', 'application/json');
      if (
        (projectKeyDead && req.headers.authorization === 'Bearer project-key') ||
        (url === '/api/projects/me' && listingStatus)
      ) {
        res.statusCode = listingStatus || 401;
        res.end(JSON.stringify({ success: false, error: 'auth unavailable' }));
      } else if (url === '/api/projects/me')
        res.end(
          JSON.stringify({
            data: {
              user: { id: 'user-tester', username: listingUser },
              projects: listedId
                ? [
                    {
                      id: listedId,
                      slug: 'upload-test',
                      name: 'Upload Test',
                      owner: listingUser,
                      isOwner: true,
                    },
                  ]
                : [],
            },
          })
        );
      else if (failStatus) {
        res.statusCode = failStatus;
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        res.end(
          JSON.stringify({
            success: false,
            error: 'loopback refusal',
            code: failStatus === 410 ? 'PROJECT_DELETED' : 'FORBIDDEN',
          })
        );
      } else if (url === '/api/projects/register-new')
        res.end(
          JSON.stringify({
            data: { projectId: 'remote-test', slug: 'upload-test', reregistered: false },
          })
        );
      else
        res.end(
          JSON.stringify({
            data: { success: true, counts: { witness: 1 }, errors: [], durationMs: 1 },
          })
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.RBOOK_DASHBOARD_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.RBOOK_DASHBOARD_API_KEY = 'loopback-test-key';
  process.env.RBOOK_CHECKPOINT_SYNC = 'on';
  delete process.env.RBOOK_AGENT_ROLE;
  delete process.env.RBOOK_PROJECT_ROOT;
});

afterEach(async () => {
  await __drainCheckpointBackfill();
  await __resetDashboardUploadScheduler();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  writer.close();
  jest.restoreAllMocks();
  CredentialStore.resetInstance();
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  fs.rmSync(root, { recursive: true, force: true });
  for (const key of keys)
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
});

function assertSnapshot(request: (typeof requests)[number]): void {
  const boundary = /boundary=(.+)$/.exec(request.contentType)![1];
  const start = request.body.indexOf(Buffer.from('SQLite format 3\0'));
  const end = request.body.indexOf(Buffer.from(`\r\n--${boundary}`), start);
  expect(start).toBeGreaterThan(0);
  const snapshot = path.join(root, 'received.sqlite');
  fs.writeFileSync(snapshot, request.body.subarray(start, end));
  const db = new Database(snapshot, { readonly: true });
  try {
    expect(db.prepare('SELECT value FROM upload_witness').pluck().get()).toBe('WAL included');
  } finally {
    db.close();
  }
}

it.each(['off', 'false', '0', 'no', 'OFF'])(
  'manual backfill honors RBOOK_CHECKPOINT_SYNC=%s without any dashboard request or store write',
  async (value) => {
    process.env.RBOOK_CHECKPOINT_SYNC = value;
    const before = [hash(dbPath), hash(dbPath + '-wal')];
    const result = await rbookDbBackfill({ projectRoot: root, force: true });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CHECKPOINT_SYNC_DISABLED');
    expect(result.error?.message).toContain('RBOOK_CHECKPOINT_SYNC');
    expect(requests).toHaveLength(0);
    expect([hash(dbPath), hash(dbPath + '-wal')]).toEqual(before);
  }
);

it('manual backfill with uploads enabled sends a usable SQLite copy to the loopback dashboard', async () => {
  // A close may follow a WAL commit without a checkpoint; manual uploads must include it too.
  const result = await rbookDbBackfill({ projectRoot: root });
  expect(result.success).toBe(true);
  const uploaded = requests.filter((r) => r.url === '/api/sync/sqlite-backfill');
  expect(uploaded).toHaveLength(1);
  assertSnapshot(uploaded[0]!);
});

it.each(['named', 'unnamed'])(
  'the never-uploaded backfill remedy registers and uploads a %s project through an explicit MCP session close',
  async (naming) => {
    writer.exec(
      "DELETE FROM metadata WHERE key IN ('dashboard_slug', 'dashboard_registered', 'dashboard_project_id')"
    );
    if (naming === 'unnamed') {
      writer.exec("UPDATE metadata SET value = '' WHERE key = 'project_name'");
      writer.exec(
        "UPDATE contexts SET content = json_set(content, '$.project_name', '') WHERE id = 'project_identity'"
      );
    }
    delete process.env.RBOOK_CHECKPOINT_SYNC;
    const refused = await rbookDbBackfill({ projectRoot: root });
    expect(refused.error?.code).toBe('DASHBOARD_NOT_UPLOADED');
    expect(refused.error?.suggestion).toContain('rbook_session(action="complete"');
    expect(requests).toHaveLength(0);
    if (naming === 'unnamed') {
      expect(refused.error?.suggestion).toContain(
        'rbook_project(action="init", projectRoot="<project folder>", projectName="<project name>")'
      );
      const named = await call('rbook_project', {
        action: 'init',
        projectRoot: root,
        projectName: 'Upload Test',
      });
      expect(named.success).toBe(true);
      expect(
        writer.prepare("SELECT value FROM metadata WHERE key = 'project_name'").pluck().get()
      ).toBe('Upload Test');
      expect(
        writer.prepare("SELECT value FROM metadata WHERE key = 'project_id'").pluck().get()
      ).toBe('upload-test');
      expect(
        writer
          .prepare(
            "SELECT json_extract(content, '$.project_name') FROM contexts WHERE id = 'project_identity'"
          )
          .pluck()
          .get()
      ).toBe('Upload Test');
      expect(
        writer
          .prepare(
            "SELECT json_extract(content, '$.project_id') FROM contexts WHERE id = 'project_identity'"
          )
          .pluck()
          .get()
      ).toBe('upload-test');
    }
    const started = await call('rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'Upload to the dashboard',
      projectRoot: root,
    });
    expect(started.success).toBe(true);
    expect(requests.some((request) => request.url === '/api/sync/sqlite-backfill')).toBe(false);
    const completed = await call('rbook_session', {
      action: 'complete',
      sessionId: started.data!.sessionId,
      summary: 'Uploaded the project to the dashboard',
      projectRoot: root,
    });
    expect(completed.success).toBe(true);
    await __drainCheckpointBackfill();
    expect(requests.filter((request) => request.url === '/api/projects/register-new')).toHaveLength(
      1
    );
    const uploaded = requests.filter((request) => request.url === '/api/sync/sqlite-backfill');
    expect(uploaded).toHaveLength(1);
    assertSnapshot(uploaded[0]!);
  }
);

it('a stored device-code project key uploads when the sync switch and environment key are unset', async () => {
  await useProjectKey();
  delete process.env.RBOOK_CHECKPOINT_SYNC;
  delete process.env.RBOOK_DASHBOARD_API_KEY;
  await triggerCheckpointBackfill({ projectRoot: root, force: false });
  const uploaded = requests.filter((r) => r.url === '/api/sync/sqlite-backfill');
  expect(uploaded).toHaveLength(1);
  assertSnapshot(uploaded[0]!);
  expect(graph.readUploadState('upload-test')?.lastOutcome).toBe('success');
});

it('a foreign store without metadata has a no-store close receipt and sends nothing', async () => {
  writer.exec('DROP TABLE metadata');
  expect(await closeUploadReceipt(root)).toMatchObject({ started: false, why: 'no-store' });
  expect(requests).toHaveLength(0);
});

it('two uploads use a real snapshot, include WAL rows and leave source sha256 unchanged', async () => {
  const before = [hash(dbPath), hash(dbPath + '-wal')];
  for (let n = 0; n < 2; n++) await triggerCheckpointBackfill({ projectRoot: root, force: false });
  const uploaded = requests.filter((r) => r.url === '/api/sync/sqlite-backfill');
  expect(uploaded).toHaveLength(2);
  for (const request of uploaded) assertSnapshot(request);
  expect([hash(dbPath), hash(dbPath + '-wal')]).toEqual(before);
  expect(graph.readUploadState('upload-test')).toMatchObject({
    firstOwedAt: null,
    lastOutcome: 'success',
  });
});

it('automatic upload cannot register a store, while explicit registration preserves localDbPath and WAL', async () => {
  writer.prepare("DELETE FROM metadata WHERE key='dashboard_registered'").run();
  graph.markUploadOwed('upload-test', Date.now() - 300001);
  await triggerCheckpointBackfill({ projectRoot: root, force: false, automatic: true });
  expect(requests).toHaveLength(0);
  await triggerCheckpointBackfill({ projectRoot: root, force: false });
  const registered = requests.find((r) => r.url === '/api/projects/register-new');
  expect(registered).toBeDefined();
  assertSnapshot(registered!);
  expect(registered!.body.toString()).toContain(`name="localDbPath"\r\n\r\n${dbPath}`);
});

it.each([402, 403])(
  'HTTP %i stops automatic retries and remains visible until explicit success',
  async (status) => {
    failStatus = status;
    graph.markUploadOwed('upload-test', Date.now() - 300001);
    await triggerCheckpointBackfill({ projectRoot: root, force: false, automatic: true });
    expect(graph.readUploadState('upload-test')?.blocked).toBe(true);
    expect(await readDashboardUploadStatus(root)).toMatch(/paused/);
    const count = requests.length;
    await triggerCheckpointBackfill({ projectRoot: root, force: false, automatic: true });
    expect(requests).toHaveLength(count);
    failStatus = 0;
    await triggerCheckpointBackfill({ projectRoot: root, force: false });
    expect(graph.readUploadState('upload-test')).toMatchObject({
      blocked: false,
      lastOutcome: 'success',
      lastError: null,
    });
  }
);

it('manual success records the upload and clears a prior pause so the dashboard status is honest', async () => {
  const lease = graph.claimUpload('upload-test', true)!;
  graph.finishUpload('upload-test', lease, { success: false, blocked: true, error: 'HTTP 401' });
  const result = await rbookDbBackfill({ projectRoot: root });
  expect(result.success).toBe(true);
  expect(graph.readUploadState('upload-test')).toMatchObject({
    blocked: false,
    lastOutcome: 'success',
    leaseToken: null,
  });
  expect(await readDashboardUploadStatus(root)).not.toContain('paused');
});

it('a failed upload whose fresh key probe succeeds stays retryable instead of requiring another close', async () => {
  failStatus = 401;
  await triggerCheckpointBackfill({ projectRoot: root, force: false });
  expect(graph.readUploadState('upload-test')?.blocked).toBe(false);
});

async function useProjectKey(): Promise<void> {
  delete process.env.RBOOK_DASHBOARD_API_KEY;
  const store = await CredentialStore.create();
  const issuedAt = new Date(Date.now() - 1000).toISOString();
  await store.upsertUserScopedKey('parent', {
    key: 'owner-key',
    label: 'test',
    issuedAt,
    lastUsedAt: issuedAt,
  });
  await store.upsertProjectKey(root, {
    key: 'project-key',
    keyId: 'project',
    parentKeyId: 'parent',
    label: 'test',
    issuedAt,
    lastUsedAt: issuedAt,
  });
}

it.each(['user', 'project'])(
  'a %s key cannot send an old store into a replacement, and all later entry points remain held',
  async (key) => {
    if (key === 'project') {
      await useProjectKey();
      projectKeyDead = true;
    }
    listedId = 'replacement-id';
    await triggerCheckpointBackfill({ projectRoot: root, force: false });
    expect(graph.readUploadState('upload-test')).toMatchObject({
      blocked: true,
      pauseReason: 'replaced',
    });
    expect(
      requests.filter((r) => r.url.includes('sqlite-backfill') || r.url.includes('register'))
    ).toHaveLength(0);
    const seen = requests.length;
    await triggerCheckpointBackfill({ projectRoot: root, force: false });
    await triggerCheckpointBackfill({ projectRoot: root, force: false, automatic: true });
    expect((await rbookDbBackfill({ projectRoot: root })).error?.code).toBe('UPLOAD_HELD');
    expect(requests).toHaveLength(seen);
    expect(await closeUploadReceipt(root)).toMatchObject({ started: false, why: 'replaced' });
    expect(
      writer.prepare("SELECT value FROM metadata WHERE key='dashboard_project_id'").pluck().get()
    ).toBe('remote-test');
  }
);

it.each(['user', 'project'])(
  'deletion requires an owner-authenticated 410 for the %s key and survives every explicit request',
  async (key) => {
    if (key === 'project') {
      await useProjectKey();
      projectKeyDead = true;
    }
    listedId = null;
    failStatus = 410;
    await triggerCheckpointBackfill({ projectRoot: root, force: false });
    expect(graph.readUploadState('upload-test')).toMatchObject({
      blocked: true,
      pauseReason: 'deleted',
    });
    expect(requests.filter((r) => r.url === '/api/sync/sqlite-backfill')).toHaveLength(1);
    const seen = requests.length;
    await triggerCheckpointBackfill({ projectRoot: root, force: false });
    expect((await rbookDbBackfill({ projectRoot: root })).error?.code).toBe('UPLOAD_HELD');
    expect(requests).toHaveLength(seen);
    expect(await closeUploadReceipt(root)).toMatchObject({ started: false, why: 'deleted' });
  }
);

it('a missing id on the listing followed by a successful confirming upload clears the suspicion', async () => {
  await useProjectKey();
  projectKeyDead = true;
  listedId = null;
  await triggerCheckpointBackfill({ projectRoot: root, force: false });
  expect(graph.readUploadState('upload-test')).toMatchObject({
    blocked: false,
    lastOutcome: 'success',
    authFirstFailedAt: null,
  });
});

it('another account with a same-name project or a tombstone cannot hold this store', async () => {
  listingUser = 'someone-else';
  listedId = 'another-id';
  failStatus = 410;
  await triggerCheckpointBackfill({ projectRoot: root, force: false });
  expect(graph.readUploadState('upload-test')).toMatchObject({ blocked: false, pauseReason: null });
  expect(requests.filter((r) => r.url === '/api/sync/sqlite-backfill')).toHaveLength(0);
});

it('an outage becomes suspect, then paused, then clears through a real registry probe without a new close', async () => {
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  listingStatus = 401;
  await triggerCheckpointBackfill({ projectRoot: root, force: false });
  expect(graph.readUploadState('upload-test')).toMatchObject({
    blocked: false,
    authFirstFailedAt: now,
  });
  now += 15 * 60000;
  await triggerCheckpointBackfill({ projectRoot: root, force: false, automatic: true });
  expect(graph.readUploadState('upload-test')).toMatchObject({
    blocked: true,
    pauseReason: 'auth',
  });
  listingStatus = 0;
  now += 60 * 60000;
  await triggerCheckpointBackfill({ projectRoot: root, force: false, automatic: true });
  expect(graph.readUploadState('upload-test')).toMatchObject({
    blocked: false,
    lastOutcome: 'success',
    firstOwedAt: null,
  });
});

it('an explicit outage attempt happens once, owed debt honors max(step, Retry-After), and success resets backoff', async () => {
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  failStatus = 503;
  retryAfter = '30';
  await triggerCheckpointBackfill({ projectRoot: root, force: false });
  expect(graph.readUploadState('upload-test')?.nextAttemptAt).toBe(now + 60000);
  const count = requests.length;
  now += 30000;
  await triggerCheckpointBackfill({ projectRoot: root, force: false, automatic: true });
  expect(requests).toHaveLength(count);
  now += 30000;
  failStatus = 0;
  await triggerCheckpointBackfill({ projectRoot: root, force: false, automatic: true });
  expect(graph.readUploadState('upload-test')).toMatchObject({
    lastOutcome: 'success',
    failureCount: 0,
    nextAttemptAt: null,
  });
});

it.each(['off', 'review', 'signed-out'])(
  'the %s gate also prevents probes on an old auth pause',
  async (gate) => {
    const lease = graph.claimUpload('upload-test', true)!;
    graph.finishUpload(
      'upload-test',
      lease,
      { success: false, blocked: true, error: 'HTTP 401' },
      Date.now() - 61 * 60000
    );
    if (gate === 'off') process.env.RBOOK_CHECKPOINT_SYNC = 'off';
    if (gate === 'review') process.env.RBOOK_AGENT_ROLE = 'review';
    if (gate === 'signed-out') delete process.env.RBOOK_DASHBOARD_API_KEY;
    await triggerCheckpointBackfill({ projectRoot: root, force: false, automatic: true });
    expect(requests).toHaveLength(0);
  }
);
