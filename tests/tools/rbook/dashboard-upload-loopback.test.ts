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
import { readDashboardUploadStatus } from '../../../src/tools/rbook/dashboard-upload-scheduler';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import { rbookDbBackfill } from '../../../src/tools/rbook/rbook-db-backfill';

let root: string;
let dbPath: string;
let writer: Database.Database;
let graph: ProjectGraphRegistry;
let server: http.Server;
let requests: Array<{ url: string; body: Buffer; contentType: string }>;
let failStatus: number;
const keys = [
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
  });
  graph.register({ project_id: 'upload-test', store_path: root, name: 'Upload Test' });
  RbookDetector.resetInstance();
  requests = [];
  failStatus = 0;
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
      if (url === '/api/projects/me')
        res.end(
          JSON.stringify({
            data: {
              projects: [
                { id: 'remote-test', slug: 'upload-test', name: 'Upload Test', owner: 'tester' },
              ],
            },
          })
        );
      else if (failStatus) {
        res.statusCode = failStatus;
        res.end(JSON.stringify({ error: 'loopback refusal' }));
      } else if (url === '/api/projects/register')
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  writer.close();
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
  // Manual backfill currently reads the main file directly; its separate WAL omission is recorded.
  writer.pragma('wal_checkpoint(TRUNCATE)');
  const result = await rbookDbBackfill({ projectRoot: root });
  expect(result.success).toBe(true);
  const uploaded = requests.filter((r) => r.url === '/api/sync/sqlite-backfill');
  expect(uploaded).toHaveLength(1);
  assertSnapshot(uploaded[0]!);
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
  const registered = requests.find((r) => r.url === '/api/projects/register');
  expect(registered).toBeDefined();
  assertSnapshot(registered!);
  expect(registered!.body.toString()).toContain(`name="localDbPath"\r\n\r\n${dbPath}`);
});

it.each([401, 402, 403])(
  'HTTP %i stops automatic retries and remains visible until explicit success',
  async (status) => {
    failStatus = status;
    graph.markUploadOwed('upload-test', Date.now() - 300001);
    await triggerCheckpointBackfill({ projectRoot: root, force: false, automatic: true });
    expect(graph.readUploadState('upload-test')?.blocked).toBe(true);
    expect(await readDashboardUploadStatus(root)).toMatch(/failed.*automatic uploads paused/);
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
