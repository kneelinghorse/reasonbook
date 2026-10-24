// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m10 — a connection opening a SQLite file another connection is writing must still connect.
// ABOUTME: SQLite refuses a concurrent switch to WAL at once, without its busy wait, so opens retry it.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { enableWal } from '../../../src/tools/rbook/sqlite-busy';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { seedRbookDb } from '../../helpers/seedRbookDb';

let tmp: string;
const workers: Worker[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-wal-race-'));
});
afterEach(async () => {
  ProjectGraphRegistry.resetInstance();
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

function deleteModeFile(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = DELETE');
  db.exec('CREATE TABLE IF NOT EXISTS held (x)');
  db.close();
}

/**
 * A second connection, on a worker thread, takes the write reservation (BEGIN IMMEDIATE) and keeps
 * it for holdMs. While it does, a plain switch to WAL answers SQLITE_BUSY at once: SQLite does not
 * call the busy handler for that lock. Two processes opening one new or delete-mode file together
 * meet the same refusal, which is how sprint-99's lifecycle-decoupling.test.ts:437 failed on CI.
 * Resolves when the holder has committed and closed.
 */
function holdReservation(file: string, holdMs: number): Promise<void> {
  const held = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `const { workerData } = require('worker_threads');
     const Database = require(workerData.driver);
     const db = new Database(workerData.file);
     db.exec('BEGIN IMMEDIATE');
     Atomics.store(workerData.held, 0, 1);
     Atomics.notify(workerData.held, 0);
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
     db.exec('COMMIT');
     db.close();`,
    { eval: true, workerData: { driver: require.resolve('better-sqlite3'), file, held, holdMs } }
  );
  workers.push(worker);
  const released = new Promise<void>((resolve, reject) => {
    worker.once('exit', () => resolve());
    worker.once('error', reject);
  });
  if (Atomics.wait(held, 0, 0, 10000) === 'timed-out')
    throw new Error('the holder never took the reservation');
  return released;
}

describe('switching to WAL while another connection writes', () => {
  it('a plain switch fails at once; enableWal waits for the writer and switches', async () => {
    const file = path.join(tmp, 'store.sqlite');
    deleteModeFile(file);
    const released = holdReservation(file, 300);
    const db = new Database(file, { timeout: 5000 });
    try {
      // Why the helper exists: the 5 s busy timeout is never consulted for this lock.
      expect(() => db.pragma('journal_mode = WAL')).toThrow(/database is locked/);
      enableWal(db, 5000);
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      db.close();
      await released;
    }
  });

  it('gives up with SQLITE_BUSY once its budget is spent, never earlier', async () => {
    const file = path.join(tmp, 'store.sqlite');
    deleteModeFile(file);
    const released = holdReservation(file, 1500);
    const db = new Database(file, { timeout: 5000 });
    const started = Date.now();
    try {
      expect(() => enableWal(db, 150)).toThrow(expect.objectContaining({ code: 'SQLITE_BUSY' }));
      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    } finally {
      db.close();
      await released;
    }
  });

  it('the project registry opens while another connection is writing a new registry', async () => {
    const configDir = path.join(tmp, 'config');
    const file = path.join(configDir, 'project-graph.sqlite');
    deleteModeFile(file);
    const released = holdReservation(file, 300);
    const registry = await ProjectGraphRegistry.create({ configDir });
    expect(registry.list()).toEqual([]);
    ProjectGraphRegistry.resetInstance();
    await released;
    const db = new Database(file, { readonly: true });
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });

  it('a delete-mode project store opens while another connection is writing it', async () => {
    const dbPath = seedRbookDb(path.join(tmp, 'project'), { projectId: 'wal-race' });
    const seeded = new Database(dbPath);
    seeded.pragma('journal_mode = DELETE');
    seeded.close();
    const released = holdReservation(dbPath, 300);
    const opened = await RbookDatabaseClient.create({ dbPath });
    expect(opened.error).toBeUndefined();
    opened.data?.close();
    await released;
  });

  it('init waits for a concurrent writer before switching the project store to WAL', async () => {
    const projectRoot = path.join(tmp, 'init-project');
    const dbPath = seedRbookDb(projectRoot, { projectId: 'init-wal-race' });
    const seeded = new Database(dbPath);
    seeded.pragma('journal_mode = DELETE');
    seeded.close();
    // A newly opened store has the same DELETE-mode switch as this initialized fixture. Reads
    // can proceed under the reservation, but a plain journal-mode switch refuses immediately.
    const released = holdReservation(dbPath, 1000);
    try {
      const initialized = await rbookProjectInit({ projectRoot });
      expect(initialized.error).toBeUndefined();
      expect(initialized.data?.projectId).toBe('init-wal-race');
    } finally {
      await released;
    }
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    db.close();
  });
});
