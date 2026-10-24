// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Durable upload debt survives processes and is cleared only by its current lease holder.
// ABOUTME: Generation comparisons preserve writes racing a snapshot, even within one millisecond.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { fork, spawnSync } from 'child_process';
import * as ts from 'typescript';
import {
  ensureUploadColumns,
  markUploadOwed,
  claimUpload,
  finishUpload,
  readUploadState,
  renewUploadLease,
  claimUploadProbe,
  finishUploadProbe,
} from '../../src/intelligence/project-upload-state';

let db: Database.Database;
let now: number;
beforeEach(() => {
  now = Date.now();
  db = new Database(':memory:');
  db.exec(
    'CREATE TABLE projects(project_id TEXT PRIMARY KEY, archived_at INTEGER, last_synced_at INTEGER)'
  );
  db.prepare('INSERT INTO projects(project_id) VALUES (?)').run('one');
  ensureUploadColumns(db);
});
afterEach(() => db.close());

it('migrates old rows with no pending upload and can be repeated', () => {
  ensureUploadColumns(db);
  expect(readUploadState(db, 'one')).toMatchObject({
    firstOwedAt: null,
    generation: 0,
    blocked: false,
  });
  expect(claimUpload(db, 'one', now, false)).toBeNull();
});

it('waits for five quiet minutes, with a thirty-minute ceiling under continuous writes', () => {
  markUploadOwed(db, 'one', now);
  expect(claimUpload(db, 'one', now + 299999, false)).toBeNull();
  for (let minutes = 4; minutes < 30; minutes += 4)
    markUploadOwed(db, 'one', now + minutes * 60000);
  expect(claimUpload(db, 'one', now + 1799999, false)).toBeNull();
  expect(claimUpload(db, 'one', now + 1800000, false)).not.toBeNull();
});

it('allows one holder, and a stale holder cannot clear its replacement', () => {
  markUploadOwed(db, 'one', now);
  const first = claimUpload(db, 'one', now, true)!;
  expect(claimUpload(db, 'one', now, true)).toBeNull();
  const next = claimUpload(db, 'one', now + 300001, true)!;
  expect(next.token).not.toBe(first.token);
  expect(finishUpload(db, 'one', first, now + 300002, { success: true })).toBe(false);
  expect(readUploadState(db, 'one')?.leaseToken).toBe(next.token);
});

it('retains a write after claim even when the timestamp is identical', () => {
  markUploadOwed(db, 'one', now);
  const lease = claimUpload(db, 'one', now, true)!;
  markUploadOwed(db, 'one', now);
  expect(finishUpload(db, 'one', lease, now + 10, { success: true })).toBe(true);
  expect(readUploadState(db, 'one')).toMatchObject({
    firstOwedAt: now,
    generation: 2,
    lastSyncedAt: now + 10,
  });
  const next = claimUpload(db, 'one', now + 11, true)!;
  finishUpload(db, 'one', next, now + 12, { success: true });
  expect(readUploadState(db, 'one')?.firstOwedAt).toBeNull();
});

it('a recovered auth probe resumes automatic debt without an explicit upload', () => {
  markUploadOwed(db, 'one', now);
  const first = claimUpload(db, 'one', now, true)!;
  finishUpload(db, 'one', first, now + 1, {
    success: false,
    error: 'x'.repeat(700),
    blocked: true,
  });
  expect(readUploadState(db, 'one')?.lastError).toHaveLength(500);
  expect(claimUpload(db, 'one', now + 600000, false)).toBeNull();
  const probe = claimUploadProbe(db, 'one', now + 3600001)!;
  expect(finishUploadProbe(db, 'one', probe, now + 3600002, { recovered: true })).toBe(true);
  const automatic = claimUpload(db, 'one', now + 3600003, false)!;
  expect(automatic).not.toBeNull();
  finishUpload(db, 'one', automatic, now + 3600004, { success: true });
  expect(readUploadState(db, 'one')).toMatchObject({
    blocked: false,
    lastError: null,
    firstOwedAt: null,
  });
});

it('starts the next debt window at the first raced write, avoiding a perpetual minute-by-minute cap', () => {
  markUploadOwed(db, 'one', now);
  const lease = claimUpload(db, 'one', now + 1800000, false)!;
  markUploadOwed(db, 'one', now + 1800010);
  markUploadOwed(db, 'one', now + 1800020);
  finishUpload(db, 'one', lease, now + 1800030, { success: true });
  expect(readUploadState(db, 'one')?.firstOwedAt).toBe(now + 1800010);
  expect(claimUpload(db, 'one', now + 1860000, false)).toBeNull();
});

it('renews only a live matching lease and leaves missing/archived projects alone', () => {
  const lease = claimUpload(db, 'one', now, true)!;
  expect(renewUploadLease(db, 'one', lease.token, now + 60000)).toBe(true);
  expect(renewUploadLease(db, 'one', 'wrong', now + 60000)).toBe(false);
  expect(markUploadOwed(db, 'missing', now)).toBe(false);
  db.prepare('UPDATE projects SET archived_at=?').run(now);
  expect(markUploadOwed(db, 'one', now)).toBe(false);
});

it.each(['unclaimed', 'crashed'])(
  'two processes contend for one %s lease and only its holder sends',
  async (initial) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-race-'));
    const database = path.join(directory, 'registry.sqlite');
    markUploadOwed(db, 'one', now - 300001);
    if (initial === 'crashed') {
      const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5000 });
      expect(child.status).toBe(0);
      const lease = claimUpload(db, 'one', now, false)!;
      db.prepare('UPDATE projects SET upload_lease_holder=?').run(
        `${lease.token}:${child.pid}@${os.hostname()}`
      );
    }
    await db.backup(database);
    const implementation = path.join(directory, 'state.cjs');
    fs.writeFileSync(
      implementation,
      ts.transpileModule(
        fs.readFileSync(path.resolve('src/intelligence/project-upload-state.ts'), 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
      ).outputText
    );
    fs.writeFileSync(
      path.join(directory, 'project-upload-reader.js'),
      ts.transpileModule(
        fs.readFileSync(path.resolve('src/intelligence/project-upload-reader.ts'), 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
      ).outputText
    );
    const worker = path.join(directory, 'worker.cjs');
    fs.writeFileSync(
      worker,
      `
    const Database = require(process.argv[2]);
    const state = require('./state.cjs');
    const db = new Database(process.argv[3], {timeout:5000});
    process.send('ready');
    process.once('message', () => {
      state.ensureUploadColumns(db);
      const lease = state.claimUpload(db, 'one', Date.now(), false);
      if (!lease) { db.close(); process.exit(0); }
      require('http').get(process.env.RBOOK_DASHBOARD_URL, res => {
        res.resume(); res.on('end', () => { state.finishUpload(db, 'one', lease, Date.now(), {success:true}); db.close(); process.exit(0); });
      }).on('error', () => process.exit(1));
    });
  `
    );
    let uploads = 0;
    const server = http.createServer((_req, response) => {
      uploads++;
      response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const children = [0, 1].map(() =>
      fork(worker, [require.resolve('better-sqlite3'), database], {
        silent: true,
        env: {
          ...process.env,
          RBOOK_CONFIG_DIR: directory,
          RBOOK_DASHBOARD_URL: `http://127.0.0.1:${address.port}`,
        },
      })
    );
    const exits = children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.once('exit', (code) =>
            code === 0 ? resolve() : reject(new Error(`lease worker exited ${code}`))
          );
          child.once('error', reject);
        })
    );
    try {
      await Promise.all(
        children.map(
          (child) => new Promise<void>((resolve) => child.once('message', () => resolve()))
        )
      );
      for (const child of children) child.send('go');
      await Promise.all(exits);
      expect(uploads).toBe(1);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
);
