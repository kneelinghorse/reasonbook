// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m05's real-store fire: copies of two of this machine's registered stores move under a live
// ABOUTME: 4.x server, keep every row, and mark seen each copied registry row that names them by any spelling.
import { afterAll, beforeAll, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import childProcess from 'child_process';
import { createHash } from 'crypto';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateProject } from '../../src/cli/migrate';
import { cutoverSeams } from '../../src/cli/migrate-store';
import { LEGACY, resolveConfigDirectory } from '../../src/intelligence/legacy-compat';
import { getServerVersion } from '../../src/server-version';
import { requiresPrivateEvidence } from '../helpers/public-mirror';
import { RawStdioServer } from '../helpers/raw-stdio-server';
import {
  prepareUploadServerSources,
  uploadServerSourceLoader,
} from '../helpers/upload-server-source';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The fire copies two of this machine's registered stores, found through its registry, which a public mirror's machine does not have.",
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

const REPO = path.resolve(__dirname, '../..');
const HANG_GUARD_MS = 300_000;
let tmp: string;
let compiled: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-real-store-'));
  compiled = prepareUploadServerSources(REPO, ['src/index.ts']);
}, HANG_GUARD_MS);
afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  if (compiled) fs.rmSync(compiled, { recursive: true, force: true });
});

/** Every ordinary table's rows, by count and content, and SQLite's verdict; a virtual table is its shadows. */
function contents(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    return {
      tables: Object.fromEntries(
        names.map(({ name }) => {
          const rows = db
            .prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`)
            .all()
            .map((row) => JSON.stringify(row))
            .sort();
          return [
            name,
            {
              rows: rows.length,
              sha256: createHash('sha256').update(rows.join('\n')).digest('hex'),
            },
          ];
        })
      ),
      integrity: db.pragma('integrity_check', { simple: true }),
    };
  } finally {
    db.close();
  }
}

PRIVATE.describe('s108-m05 real-store fire: two real stores move under a live 4.x server', () => {
  it(
    'keeps every row of both, and marks seen the registry rows naming them by exact and other spellings',
    async () => {
      // The real registry is read once, into a copy: never written, and never the whole folder.
      const realConfig = resolveConfigDirectory({ HOME: os.homedir() }, os.homedir(), {
        quiet: true,
      });
      const config = path.join(tmp, 'config');
      fs.mkdirSync(config);
      const registryFile = path.join(config, 'project-graph.sqlite');
      const real = new Database(path.join(realConfig, 'project-graph.sqlite'), {
        readonly: true,
        fileMustExist: true,
      });
      real.prepare('VACUUM INTO ?').run(registryFile);
      real.close();
      const registry = new Database(registryFile);
      const columns = registry.prepare('PRAGMA table_info(projects)').all() as Array<{
        name: string;
        notnull: number;
      }>;
      // The columns the update writes, as E5 confirmed them on this machine.
      expect(
        Object.fromEntries(
          columns
            .filter((c) => ['store_path', 'last_seen_at', 'archived_at'].includes(c.name))
            .map((c) => [c.name, c.notnull])
        )
      ).toEqual({ store_path: 1, last_seen_at: 1, archived_at: 0 });
      const roots = (
        registry
          .prepare('SELECT DISTINCT store_path FROM projects WHERE archived_at IS NULL')
          .all() as Array<{ store_path: string }>
      )
        .map((row) => row.store_path)
        .sort();
      const legacy = roots.filter(
        (root) =>
          fs.existsSync(path.join(root, LEGACY.recordDirectory, 'db', LEGACY.databaseFile)) &&
          !fs.existsSync(path.join(root, 'rbook'))
      );
      // The legacy stores this sprint is for, while any remain; any registered store after that.
      const current = roots.filter((root) =>
        fs.existsSync(path.join(root, 'rbook/db/rbook.sqlite'))
      );
      const sources = [
        ...legacy.map((root) => path.join(root, LEGACY.recordDirectory, 'db', LEGACY.databaseFile)),
        ...current.map((root) => path.join(root, 'rbook/db/rbook.sqlite')),
      ].slice(0, 2);
      expect(sources).toHaveLength(2);

      // Each copy in a project folder of its own, in the old layout, one in WAL mode and one not.
      const copies = sources.map((source, i) => {
        const root = path.join(tmp, `store-${i}`);
        const file = path.join(root, LEGACY.recordDirectory, 'db', LEGACY.databaseFile);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const read = new Database(source, { readonly: true, fileMustExist: true });
        read.prepare('VACUUM INTO ?').run(file);
        read.close();
        const db = new Database(file);
        // No dashboard is told about a copy (round 6's N1): the update reads these keys.
        db.prepare("DELETE FROM metadata WHERE key LIKE 'dashboard%'").run();
        db.pragma(`journal_mode = ${i === 0 ? 'WAL' : 'DELETE'}`);
        db.close();
        return { root, file, mode: i === 0 ? 'wal' : 'delete' };
      });

      // Two real rows per copy: one names it exactly, one by a symlink, or a case variant where the
      // filesystem folds case, so a match by string alone would leave a row unseen (round 7's N1).
      const rows = registry
        .prepare('SELECT rowid AS id FROM projects ORDER BY rowid LIMIT 4')
        .all() as Array<{ id: number }>;
      expect(rows).toHaveLength(4);
      const spelled: string[] = [];
      copies.forEach((copy, i) => {
        const variant = path.join(tmp, `STORE-${i}`);
        let other = variant;
        if (!fs.existsSync(variant)) {
          other = path.join(tmp, `link-${i}`);
          fs.symlinkSync(copy.root, other);
        }
        spelled.push(copy.root, other);
      });
      const repoint = registry.prepare(
        'UPDATE projects SET store_path = ?, last_seen_at = 1, archived_at = 2 WHERE rowid = ?'
      );
      rows.forEach((row, i) => repoint.run(spelled[i], row.id));
      const untouched = () =>
        registry
          .prepare(
            `SELECT rowid AS id, store_path, last_seen_at, archived_at FROM projects WHERE rowid NOT IN (${rows
              .map((row) => row.id)
              .join(',')}) ORDER BY rowid`
          )
          .all();
      const othersBefore = untouched();
      registry.close();

      // A live server whose command line and manifest are a 4.x runtime's, isolated from the
      // dashboard: scratch HOME and config, no RBOOK_ or CMOS_ dashboard variables, and
      // RBOOK_PROJECT_ROOT keeping the repository's .env out (round 7's N3).
      const runtime = path.join(tmp, 'runtime');
      fs.mkdirSync(path.join(runtime, 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(runtime, 'package.json'),
        JSON.stringify({ name: '@aquex/reasonbook', version: getServerVersion() })
      );
      const entry = path.join(runtime, 'dist/index.js');
      fs.writeFileSync(
        entry,
        `${uploadServerSourceLoader(compiled)}\nrequire(${JSON.stringify(path.join(REPO, 'src/index.ts'))}).runServer([]);\n`
      );
      const home = path.join(tmp, 'home');
      fs.mkdirSync(home);
      const env = {
        PATH: process.env.PATH ?? path.dirname(process.execPath),
        TMPDIR: os.tmpdir(),
        HOME: home,
        RBOOK_CONFIG_DIR: config,
        RBOOK_CHECKPOINT_SYNC: 'off',
        RBOOK_SHARED_SYNC: 'off',
      };
      const server = new RawStdioServer(
        entry,
        tmp,
        { ...env, RBOOK_PROJECT_ROOT: copies[0].root },
        [],
        HANG_GUARD_MS
      );
      try {
        await server.request('initialize', {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 's108-m05-fire', version: '1' },
        });
        server.notify('notifications/initialized');
        const status = () =>
          server.request('tools/call', {
            name: 'rbook_status',
            arguments: { projectRoot: copies[0].root },
          });
        expect((await status()).structuredContent).toMatchObject({ success: true });
        const spawnSync = childProcess.spawnSync;
        let inspectedServer = 0;
        jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
          command: string,
          args: string[],
          opts: any
        ) => {
          const result = spawnSync(command, args, opts);
          if (command !== 'ps') return result;
          const lines = String(result.stdout)
            .split('\n')
            .filter((line) => line.trim().startsWith(`${server.child.pid} `));
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain(entry);
          inspectedServer += 1;
          return { ...result, stdout: lines.join('\n') };
        }) as any);
        for (const copy of copies) {
          const before = contents(copy.file);
          // Keep the owned server's real ps row, as migrate-cutover does. Other clients can
          // legitimately refuse a move (including an old plugin path removed by an update),
          // so their ambient state must not decide this live 4.x server's positive fire.
          const result = await migrateProject({ projectRoot: copy.root, env, apply: true });
          expect({ mode: copy.mode, success: result.success, error: result.error }).toEqual({
            mode: copy.mode,
            success: true,
            error: undefined,
          });
          const moved = path.join(copy.root, 'rbook/db/rbook.sqlite');
          // Nothing left under the old name beside the moved store (round 1).
          expect(
            fs
              .readdirSync(path.dirname(moved))
              .filter((name) => !/^rbook\.sqlite(?:-wal|-shm)?$/.test(name))
          ).toEqual(['snapshots']);
          expect(contents(moved)).toEqual(before);
          const db = new Database(moved, { readonly: true });
          expect(db.pragma('journal_mode', { simple: true })).toBe(copy.mode);
          db.close();
        }
        expect(inspectedServer).toBeGreaterThanOrEqual(copies.length);
        expect((await status()).structuredContent).toMatchObject({ success: true });
      } finally {
        jest.restoreAllMocks();
        await server.close();
      }

      const after = new Database(registryFile, { readonly: true });
      const seen = after
        .prepare(
          `SELECT store_path, last_seen_at, archived_at FROM projects WHERE rowid IN (${rows
            .map((row) => row.id)
            .join(',')}) ORDER BY rowid`
        )
        .all() as Array<{ store_path: string; last_seen_at: number; archived_at: number | null }>;
      expect(seen.map((row) => [row.store_path, row.archived_at, row.last_seen_at > 1])).toEqual(
        spelled.map((spelling) => [spelling, null, true])
      );
      const reread = new Database(registryFile, { readonly: true });
      const othersAfter = reread
        .prepare(
          `SELECT rowid AS id, store_path, last_seen_at, archived_at FROM projects WHERE rowid NOT IN (${rows
            .map((row) => row.id)
            .join(',')}) ORDER BY rowid`
        )
        .all();
      reread.close();
      after.close();
      expect(othersAfter).toEqual(othersBefore);
    },
    HANG_GUARD_MS
  );

  it(
    'a late reader of a copy of the largest real store: refused before any rename, its guard released, every row kept (s109-m01, #913)',
    async () => {
      // A reader that keeps its read, in a WAL and a DELETE copy, and one that ends within the
      // clients' 5 s busy timeout, which the switch back to WAL waits out.
      for (const [mode, brief] of [
        ['wal', false],
        ['wal', true],
        ['delete', false],
      ] as const) {
        const copy = largestStoreCopy(`late-${mode}${brief ? '-brief' : ''}`, mode);
        const before = contents(copy.file);
        const signals = fs.mkdtempSync(path.join(tmp, 'opener-'));
        let child: childProcess.ChildProcess | undefined;
        const wait = (name: string) => {
          const sleeper = new Int32Array(new SharedArrayBuffer(4));
          const deadline = Date.now() + 60_000;
          while (!fs.existsSync(path.join(signals, name))) {
            if (Date.now() > deadline) throw new Error(`the late reader never wrote ${name}`);
            Atomics.wait(sleeper, 0, 0, 20);
          }
        };
        const seams = { ...cutoverSeams };
        cutoverSeams.beforeFinalCheck = () => {
          child = childProcess.spawn(
            process.execPath,
            [
              '-e',
              'const [file, signals, sqlite, brief] = process.argv.slice(1);const fs = require("fs");' +
                'const db = new (require(sqlite))(file, { timeout: 60000 });fs.writeFileSync(signals + "/ready", "");' +
                'db.exec("BEGIN");db.prepare("SELECT count(*) FROM sqlite_master").get();fs.writeFileSync(signals + "/reading", "");' +
                'if (brief === "1") setTimeout(() => db.exec("COMMIT"), 1500);setInterval(() => {}, 1000);',
              copy.file,
              signals,
              require.resolve('better-sqlite3'),
              brief ? '1' : '0',
            ],
            { stdio: 'ignore' }
          );
          wait('ready');
        };
        cutoverSeams.beforeRollbackVerify = () => wait('reading');
        try {
          const result = await migrateProject({
            projectRoot: copy.root,
            env: { PATH: process.env.PATH, HOME: path.join(tmp, 'home') },
            apply: true,
            checkProcesses: false,
          });
          expect({ mode, brief, success: result.success }).toEqual({ mode, brief, success: false });
          expect(result.error?.message).toContain(`open by process ${child?.pid}`);
          expect(result.error?.message).not.toContain('recovery failed');
          expect(
            fs.readdirSync(copy.root).filter((name) => name.startsWith('.rbook-migration'))
          ).toEqual([]);
          const held = mode === 'wal' && !brief;
          expect(result.error?.message.includes('stays in rollback-journal mode')).toBe(held);
        } finally {
          Object.assign(cutoverSeams, seams);
          if (child && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, 'exit');
            child.kill();
            await exited;
          }
        }
        const after = new Database(copy.file, { readonly: true });
        expect(after.pragma('journal_mode', { simple: true })).toBe(
          mode === 'wal' && !brief ? 'delete' : mode
        );
        after.close();
        expect(contents(copy.file)).toEqual(before);
      }
    },
    HANG_GUARD_MS
  );

  it(
    'a copy of the largest real store given a sync peer refuses while a 4.x runtime runs, and never makes its guard (s109-m01, #915)',
    async () => {
      // No store on this machine has had a peer (E1), so one is planted in the copy.
      const copy = largestStoreCopy('peered', 'wal');
      const db = new Database(copy.file);
      db.exec(
        'CREATE TABLE IF NOT EXISTS record_peers (replica_id TEXT PRIMARY KEY, name TEXT, route TEXT)'
      );
      db.prepare(
        "INSERT OR REPLACE INTO record_peers (replica_id, name) VALUES ('peer', 'Peer')"
      ).run();
      db.close();
      const runtime = path.join(tmp, 'peer-runtime');
      fs.mkdirSync(path.join(runtime, 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(runtime, 'package.json'),
        JSON.stringify({ name: '@aquex/reasonbook', version: getServerVersion() })
      );
      const spawnSync = childProcess.spawnSync;
      jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
        command: string,
        args: string[],
        opts: any
      ) => {
        const result = spawnSync(command, args, opts);
        return command === 'ps'
          ? { ...result, stdout: `2147483646 node ${path.join(runtime, 'dist/index.js')}\n` }
          : result;
      }) as any);
      const made: string[] = [];
      const mkdirSync = fs.mkdirSync;
      jest.spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, opts?: any) => {
        made.push(String(target));
        return mkdirSync(target, opts);
      }) as any);
      try {
        const result = await migrateProject({
          projectRoot: copy.root,
          env: { PATH: process.env.PATH, HOME: path.join(tmp, 'home') },
          apply: true,
        });
        expect(result).toMatchObject({
          success: false,
          error: { message: expect.stringContaining('has had a sync peer') },
        });
        expect(made.filter((target) => target.endsWith('.rbook-migration.lock'))).toEqual([]);
        expect(fs.existsSync(copy.file)).toBe(true);
      } finally {
        jest.restoreAllMocks();
      }
    },
    HANG_GUARD_MS
  );
});

/** The largest registered store on this machine, copied by VACUUM INTO into a legacy project of its own. */
function largestStoreCopy(name: string, mode: 'wal' | 'delete'): { root: string; file: string } {
  const realConfig = resolveConfigDirectory({ HOME: os.homedir() }, os.homedir(), { quiet: true });
  const registry = new Database(path.join(realConfig, 'project-graph.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  const roots = (
    registry
      .prepare('SELECT DISTINCT store_path FROM projects WHERE archived_at IS NULL')
      .all() as Array<{ store_path: string }>
  ).map((row) => row.store_path);
  registry.close();
  const stores = roots
    .flatMap((root) => [
      path.join(root, LEGACY.recordDirectory, 'db', LEGACY.databaseFile),
      path.join(root, 'rbook/db/rbook.sqlite'),
    ])
    .filter((file) => fs.existsSync(file))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  expect(stores.length).toBeGreaterThan(0);
  const root = path.join(tmp, name);
  const file = path.join(root, LEGACY.recordDirectory, 'db', LEGACY.databaseFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const read = new Database(stores[0], { readonly: true, fileMustExist: true });
  read.prepare('VACUUM INTO ?').run(file);
  read.close();
  const db = new Database(file);
  // No dashboard is told about a copy: the move's follow-up reads these keys.
  db.prepare("DELETE FROM metadata WHERE key LIKE 'dashboard%'").run();
  db.pragma(`journal_mode = ${mode}`);
  db.close();
  return { root, file };
}
