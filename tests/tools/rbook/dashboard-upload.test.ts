// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Snapshot uploads include committed WAL writes without changing their source store.
// ABOUTME: Explicit and automatic attempts share durable leases and surface real failures locally.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { UPLOAD_LEASE_MS } from '../../../src/intelligence/project-upload-state';
import {
  readUploadProject,
  __resetDashboardUploadLifecycle,
  withUploadLease,
  withUploadSnapshot,
} from '../../../src/tools/rbook/dashboard-upload';

let root: string;
let config: string;
let database: string;
let graph: ProjectGraphRegistry;
let writer: Database.Database;
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-'));
  config = path.join(root, 'config');
  fs.mkdirSync(path.join(root, 'rbook', 'db'), { recursive: true });
  database = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  writer = new Database(database);
  writer.pragma('journal_mode = WAL');
  writer.exec(
    'CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE witness(value TEXT)'
  );
  const add = writer.prepare('INSERT INTO metadata VALUES (?,?)');
  add.run('project_id', 'upload-test');
  add.run('project_name', 'Upload Test');
  add.run('dashboard_registered', 'true');
  writer.prepare('INSERT INTO witness VALUES (?)').run('committed in WAL');
  ProjectGraphRegistry.resetInstance();
  graph = await ProjectGraphRegistry.create({ configDir: config, ephemeralRoots: [] });
  graph.register({ project_id: 'upload-test', store_path: root, name: 'Upload Test' });
});
afterEach(() => {
  jest.restoreAllMocks();
  __resetDashboardUploadLifecycle();
  writer.close();
  ProjectGraphRegistry.resetInstance();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(['expired', 'replaced'] as const)(
  'does not report recovery when a successful send has a %s lease',
  async (change) => {
    const first = graph.claimUpload('upload-test', true)!;
    graph.finishUpload('upload-test', first, { success: false, pauseReason: 'auth' });
    const outcome = await withUploadLease(root, true, async () => {
      const future = Date.now() + UPLOAD_LEASE_MS + 1;
      if (change === 'replaced')
        expect(graph.claimUpload('upload-test', true, future)).not.toBeNull();
      else
        jest
          .spyOn(graph, 'finishUpload')
          .mockImplementation((id, lease, result) =>
            ProjectGraphRegistry.prototype.finishUpload.call(graph, id, lease, result, future)
          );
      return { success: true };
    });
    expect(outcome).toMatchObject({ success: false });
    expect(outcome?.error).toContain('could not be committed');
    expect(graph.readUploadState('upload-test')).toMatchObject({
      blocked: true,
      pauseReason: 'auth',
      lastSyncedAt: null,
    });
  }
);

it('uploads a consistent WAL-inclusive backup twice and never changes the source bytes', async () => {
  const before = [digest(database), digest(database + '-wal')];
  let temp = '';
  for (let n = 0; n < 2; n++) {
    await withUploadSnapshot(database, async (file) => {
      temp = file;
      expect(file).not.toBe(database);
      const snapshot = new Database(file, { readonly: true });
      try {
        expect(snapshot.prepare('SELECT value FROM witness').pluck().get()).toBe(
          'committed in WAL'
        );
      } finally {
        snapshot.close();
      }
    });
    expect(fs.existsSync(temp)).toBe(false);
    expect([digest(database), digest(database + '-wal')]).toEqual(before);
  }
});

it('only registered stores qualify for automatic work, without inventing registration', () => {
  expect(readUploadProject(root)?.registered).toBe(true);
  writer.prepare("DELETE FROM metadata WHERE key='dashboard_registered'").run();
  expect(readUploadProject(root)?.registered).toBe(false);
});

it('a foreign store and NULL registration remain inactive, and later table creation is noticed', () => {
  writer.exec('DROP TABLE metadata');
  expect(readUploadProject(root)).toBeNull();
  writer.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)');
  writer.prepare('INSERT INTO metadata VALUES (?,?)').run('project_id', 'upload-test');
  writer.prepare('INSERT INTO metadata VALUES (?,?)').run('dashboard_registered', null);
  expect(readUploadProject(root)?.registered).toBe(false);
  writer.prepare("UPDATE metadata SET value='true' WHERE key='dashboard_registered'").run();
  expect(readUploadProject(root)?.registered).toBe(true);
});

it('an explicit attempt leaves durable debt on failure and reports a capped error', async () => {
  await withUploadLease(root, true, async () => ({
    success: false,
    error: 'denied',
    blocked: true,
  }));
  expect(graph.readUploadState('upload-test')).toMatchObject({
    blocked: true,
    lastOutcome: 'failed',
    lastError: 'denied',
  });
  expect(graph.readUploadState('upload-test')?.firstOwedAt).not.toBeNull();
  let ran = false;
  await withUploadLease(root, false, async () => {
    ran = true;
    return { success: true };
  });
  expect(ran).toBe(false);
  await withUploadLease(root, true, async () => ({ success: true }));
  expect(graph.readUploadState('upload-test')).toMatchObject({
    blocked: false,
    firstOwedAt: null,
    lastOutcome: 'success',
  });
});

it('a racing mark stays owed after a successful snapshot upload', async () => {
  await withUploadLease(root, true, async () => {
    graph.markUploadOwed('upload-test');
    return { success: true };
  });
  expect(graph.readUploadState('upload-test')?.firstOwedAt).not.toBeNull();
});

// s96-m01 (#629): macOS reaches one folder as /Users/… and as /System/Volumes/Data/…; realpath does
// not fold the two, so the guard compares device and inode too.
const DATA_VOLUME = '/System/Volumes/Data';
const itOnMac = process.platform === 'darwin' && fs.existsSync(DATA_VOLUME) ? it : it.skip;
itOnMac('accepts a registry row that names the store by its Data volume spelling', async () => {
  const spelled = DATA_VOLUME + fs.realpathSync.native(root);
  graph.register({ project_id: 'upload-test', store_path: spelled, name: 'Upload Test' });
  expect(graph.get('upload-test')?.store_path).toBe(spelled);
  let ran = false;
  await withUploadLease(root, true, async () => {
    ran = true;
    return { success: true };
  });
  expect(ran).toBe(true);
});
