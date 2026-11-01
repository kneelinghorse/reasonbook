// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m05's real-store fire: copies of two of this machine's registered stores move under a live
// ABOUTME: 4.x server, keep every row, and mark seen each copied registry row that names them by any spelling.
import { afterAll, beforeAll, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import childProcess from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateProject } from '../../src/cli/migrate';
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
        const temporary = [os.tmpdir(), fs.realpathSync(os.tmpdir())];
        jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
          command: string,
          args: string[],
          opts: any
        ) => {
          const result = spawnSync(command, args, opts);
          if (command !== 'ps') return result;
          const keep = (line: string) =>
            line.trim().startsWith(`${server.child.pid} `) ||
            !temporary.some((folder) => line.includes(folder));
          return { ...result, stdout: String(result.stdout).split('\n').filter(keep).join('\n') };
        }) as any);
        for (const copy of copies) {
          const before = contents(copy.file);
          // The real process list, this machine's sessions included: only a runtime older than
          // 4.0 may refuse the move, and this server must not. Other test files' fixtures, run
          // from the temporary folder by a parallel run, are left out (round 3).
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
});
