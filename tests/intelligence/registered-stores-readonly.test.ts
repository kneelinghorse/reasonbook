// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Fleet discovery reads only the existing registry, including older schemas, without side effects.
// ABOUTME: Real SQLite fixtures prove absent, malformed and independently locked registries stay distinguishable.

import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listRegisteredStoresReadOnly } from '../../src/intelligence/registered-stores-readonly';
import { fastestOfFive } from '../helpers/fastest-of-five';

let root: string;
let configDir: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-registry-read-'));
  configDir = path.join(root, 'config');
  file = path.join(configDir, 'project-graph.sqlite');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function seed(): void {
  fs.mkdirSync(configDir);
  const db = new Database(file);
  db.exec(`CREATE TABLE projects (
    project_id TEXT PRIMARY KEY, store_path TEXT, name TEXT, registered_at INTEGER,
    last_seen_at INTEGER, schema_version INTEGER, archived_at INTEGER
  ); CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value TEXT);`);
  const now = Date.now();
  const insert = db.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?,?)');
  insert.run('older', path.join(root, 'older'), 'Older store', now, now - 1, 1, null);
  insert.run('recent', path.join(root, 'recent'), 'Recent store', now, now, 1, null);
  insert.run('archived', path.join(root, 'archived'), 'Archived store', now, now, 1, now);
  db.close();
}

it('an absent registry produces an empty snapshot without creating a directory or database', () => {
  expect(listRegisteredStoresReadOnly({ RBOOK_CONFIG_DIR: configDir })).toEqual([]);
  expect(fs.existsSync(configDir)).toBe(false);
});

it('explicit environment wins with the process environment unset; legacy columns do not require migration', () => {
  seed();
  const previous = process.env.RBOOK_CONFIG_DIR;
  delete process.env.RBOOK_CONFIG_DIR;
  try {
    const before = fs.readFileSync(file);
    const rows = listRegisteredStoresReadOnly({ RBOOK_CONFIG_DIR: configDir });
    expect(rows.map((row) => row.project_id)).toEqual(['recent', 'older']);
    expect(rows.every((row) => row.last_synced_at === null)).toBe(true);
    expect(fs.readFileSync(file)).toEqual(before);
    const verify = new Database(file, { readonly: true, fileMustExist: true });
    expect(verify.prepare('SELECT * FROM registry_meta').all()).toEqual([]);
    expect(verify.prepare('PRAGMA table_info(projects)').all()).toHaveLength(7);
    verify.close();
  } finally {
    if (previous !== undefined) process.env.RBOOK_CONFIG_DIR = previous;
  }
});

it('does not cache absence when a registry is created later', () => {
  expect(listRegisteredStoresReadOnly({ RBOOK_CONFIG_DIR: configDir })).toEqual([]);
  seed();
  expect(listRegisteredStoresReadOnly({ RBOOK_CONFIG_DIR: configDir })).toHaveLength(2);
});

it('a malformed existing registry surfaces failure instead of an authoritative empty fleet', () => {
  fs.mkdirSync(configDir);
  fs.writeFileSync(file, 'not a SQLite database');
  expect(() => listRegisteredStoresReadOnly({ RBOOK_CONFIG_DIR: configDir })).toThrow();
});

it('a registry held by another process fails promptly without waiting out the hook deadline', async () => {
  seed();
  let child: ChildProcess | undefined;
  try {
    child = spawn(
      process.execPath,
      [
        '-e',
        `
      const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const db = new Database(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE');
      process.send('locked');
      process.on('message', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
    `,
        file,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
    );
    await new Promise<void>((resolve, reject) => {
      child!.once('message', () => resolve());
      child!.once('error', reject);
      child!.once('exit', (code) => reject(new Error(`Lock holder exited early: ${code}`)));
    });
    expect(
      await fastestOfFive(() => {
        const start = Date.now();
        expect(() => listRegisteredStoresReadOnly({ RBOOK_CONFIG_DIR: configDir })).toThrow(
          /locked|busy/i
        );
        return Date.now() - start;
      }, 500)
    ).toBeLessThan(500);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.send('release');
      await exited;
    }
  }
});
