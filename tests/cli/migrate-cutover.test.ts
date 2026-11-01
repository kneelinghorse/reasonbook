// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m05 — a record moves under its held lock while other processes run: a handle opened mid-move
// ABOUTME: loses nothing, a server started mid-move starts, and a second migrate by any spelling waits.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LEGACY } from '../../src/intelligence/legacy-compat';
import { getServerVersion } from '../../src/server-version';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';
import { RawStdioServer } from '../helpers/raw-stdio-server';
import {
  prepareUploadServerSources,
  uploadServerSourceLoader,
} from '../helpers/upload-server-source';

const REPO = path.resolve(__dirname, '../..');
/** s98-m08's guard for process fixtures under two concurrent full suites. */
const HANG_GUARD_MS = 300_000;

let compiled: string;
let tmp: string;
let root: string;
let oldDb: string;

beforeAll(() => {
  compiled = prepareUploadServerSources(REPO, ['src/index.ts', 'src/cli.ts']);
}, HANG_GUARD_MS);
afterAll(() => {
  if (compiled) fs.rmSync(compiled, { recursive: true, force: true });
});
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-cutover-'));
  root = path.join(tmp, 'project');
  oldDb = seedLegacyMigrationStore(root);
  fs.mkdirSync(path.join(tmp, 'home'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const isolated = (): Record<string, string> => ({
  PATH: process.env.PATH ?? path.dirname(process.execPath),
  // One temporary folder for every child, so all of them find one migration coordinator.
  TMPDIR: os.tmpdir(),
  HOME: path.join(tmp, 'home'),
  RBOOK_CONFIG_DIR: path.join(tmp, 'config'),
  RBOOK_CHECKPOINT_SYNC: 'off',
  RBOOK_SHARED_SYNC: 'off',
});

/** A child process running repository source, as a separate program would run the built one. */
function bootstrap(name: string, body: string): string {
  const file = path.join(tmp, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${uploadServerSourceLoader(compiled)}\n${body}\n`);
  return file;
}

interface Exit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `reasonbook migrate --apply --project <spelling>` in its own process. With a seam, it stops between
 * its final open-file check and its first rename until the test resumes it. ps shows it only the
 * processes named, so the machine's other sessions do not decide a test.
 */
function migrator(spelling: string, options: { seam?: boolean; watch?: number[] } = {}) {
  const seam = fs.mkdtempSync(path.join(tmp, 'seam-'));
  const file = bootstrap(
    'migrator/run.cjs',
    `const childProcess = require('child_process');
const watched = (process.env.TEST_PS_PIDS || '').split(',').filter(Boolean);
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  const result = realSpawnSync(command, args, options);
  if (command !== 'ps') return result;
  const lines = String(result.stdout).split('\\n');
  return { ...result, stdout: lines.filter((line) => watched.some((pid) => line.trim().startsWith(pid + ' '))).join('\\n') };
};
const seam = process.env.TEST_SEAM_DIR;
if (seam) {
  require(${JSON.stringify(path.join(REPO, 'src/cli/migrate-store.ts'))}).cutoverSeams.beforeRename = () => {
    fs.writeFileSync(path.join(seam, 'paused'), String(process.pid));
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + ${HANG_GUARD_MS};
    while (!fs.existsSync(path.join(seam, 'resume'))) {
      if (Date.now() > deadline) throw new Error('the test never resumed the move');
      Atomics.wait(sleeper, 0, 0, 20);
    }
  };
}
require(${JSON.stringify(path.join(REPO, 'src/cli/migrate.ts'))})
  .runMigrate(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    readStdin: async () => '',
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text + '\\n'),
  })
  .then((code) => process.exit(code));`
  );
  const child = spawn(process.execPath, [file, '--apply', '--project', spelling], {
    cwd: tmp,
    env: {
      ...isolated(),
      ...(options.seam ? { TEST_SEAM_DIR: seam } : {}),
      TEST_PS_PIDS: (options.watch ?? []).join(','),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += String(chunk)));
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const exit = new Promise<Exit>((resolve) =>
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  );
  let done = false;
  void exit.then(() => (done = true));
  /** Resolves once the move waits at its seam; fails, saying why, if it ends first. */
  const paused = async () => {
    const deadline = Date.now() + HANG_GUARD_MS;
    while (!fs.existsSync(path.join(seam, 'paused'))) {
      if (done) throw new Error(`the move ended before its seam: ${JSON.stringify(await exit)}`);
      if (Date.now() > deadline) throw new Error('the move never reached its seam');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  return { exit, paused, resume: () => fs.writeFileSync(path.join(seam, 'resume'), '') };
}

/** A server whose command line and manifest are a 4.x runtime's, as the process check reads them. */
function server(launch: { readonly cwd?: string; readonly args?: string[] } = {}): RawStdioServer {
  const folder = path.join(tmp, 'runtime');
  fs.mkdirSync(path.join(folder, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(folder, 'package.json'),
    JSON.stringify({ name: '@aquex/reasonbook', version: getServerVersion() })
  );
  const entry = bootstrap(
    'runtime/dist/index.js',
    // The server's own arguments reach it, --project-root among them.
    `require(${JSON.stringify(path.join(REPO, 'src/index.ts'))}).runServer(process.argv.slice(2));`
  );
  // RBOOK_PROJECT_ROOT keeps the repository's .env out, which names the live dashboard.
  return new RawStdioServer(
    entry,
    launch.cwd ?? tmp,
    { ...isolated(), RBOOK_PROJECT_ROOT: root },
    launch.args ?? [],
    HANG_GUARD_MS
  );
}

async function initialize(child: RawStdioServer): Promise<void> {
  await child.request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 's108-m05', version: '1' },
  });
  child.notify('notifications/initialized');
}

const status = (child: RawStdioServer) =>
  child.request('tools/call', { name: 'rbook_status', arguments: { projectRoot: root } });

function journalMode(file: string, mode: string): void {
  const db = new Database(file);
  db.pragma(`journal_mode = ${mode}`);
  db.close();
}

/** What a move must keep: every row of every table, by content, and a store SQLite calls sound. */
function contents(file: string): {
  tables: Record<string, { rows: number; sha256: string }>;
  integrity: unknown;
} {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    return {
      tables: Object.fromEntries(
        names.map(({ name }) => {
          const rows = db
            .prepare(`SELECT * FROM "${name}"`)
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

/** What happens to a write through this handle: 'ok', or SQLite's error code. */
function attempt(db: Database.Database, marker: string) {
  const code = (write: () => unknown): string => {
    try {
      write();
      return 'ok';
    } catch (error) {
      return (error as { code?: string }).code ?? String(error);
    }
  };
  return {
    wal: code(() => db.pragma('journal_mode = WAL')),
    write: code(() =>
      db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(marker, 'kept')
    ),
  };
}

const moved = () => path.join(root, 'rbook/db/rbook.sqlite');

describe('a move holds its lock from the backup through both renames', () => {
  it.each(['delete', 'wal'])(
    'a handle another process opens mid-move in a %s store can write nothing, so nothing is lost',
    async (mode) => {
      journalMode(oldDb, mode);
      const before = contents(oldDb);
      const move = migrator(root, { seam: true });
      await move.paused();
      // This process is the other program: it opens the record after the move's last open-file
      // check, where 4.9.0 had closed its own handle and a WAL write went to a file left behind.
      const other = new Database(oldDb, { timeout: 0, fileMustExist: true });
      const during = attempt(other, 'written-during-the-move');
      move.resume();
      const exit = await move.exit;
      // Taken before anything else opens the moved store: what the move left in its folder.
      const left = fs.readdirSync(path.join(root, 'rbook', 'db')).sort();
      const after = attempt(other, 'written-after-the-move');
      let read: number | string;
      try {
        read = (other.prepare('SELECT count(*) AS n FROM metadata').get() as { n: number }).n;
      } catch (error) {
        read = (error as { code?: string }).code ?? String(error);
      }
      other.close();
      const kept = new Database(moved(), { readonly: true });
      const markers = kept
        .prepare("SELECT key FROM metadata WHERE key LIKE 'written-%' ORDER BY key")
        .all()
        .map((row) => (row as { key: string }).key);
      const mode2 = kept.pragma('journal_mode', { simple: true });
      kept.close();
      const claimed = [
        ...(during.write === 'ok' ? ['written-during-the-move'] : []),
        ...(after.write === 'ok' ? ['written-after-the-move'] : []),
      ];
      // Afterwards a delete store's late handle reads the moved file and every write fails with
      // DBMOVED. A WAL store is back in WAL mode once the move ends, so the handle meets a log it
      // cannot open beside the old path, and its reads fail too: as loudly, and nothing is kept.
      const late =
        mode === 'wal'
          ? { wal: 'SQLITE_IOERR_FSTAT', write: 'SQLITE_IOERR_FSTAT', read: 'SQLITE_IOERR_FSTAT' }
          : {
              wal: 'SQLITE_READONLY_DBMOVED',
              write: 'SQLITE_READONLY_DBMOVED',
              read: before.tables.metadata.rows,
            };
      expect({
        exit: exit.code,
        during,
        after: { ...after, read },
        lost: claimed.filter((key) => !markers.includes(key)),
      }).toEqual({
        exit: 0,
        during: { wal: 'SQLITE_BUSY', write: 'SQLITE_BUSY' },
        after: late,
        lost: [],
      });
      // The move kept every row and the store's journal mode, and left nothing under the old name: a
      // WAL store's switch, made under the exclusive mode, once left cmos.sqlite-journal (round 1).
      // A WAL store keeps its own -wal and -shm, which the ignore rules the move writes cover.
      expect(left.filter((name) => !/^rbook\.sqlite(?:-wal|-shm)?$/.test(name))).toEqual([
        'snapshots',
      ]);
      expect(contents(moved())).toEqual(before);
      expect(mode2).toBe(mode);
      expect(fs.existsSync(path.join(root, LEGACY.recordDirectory))).toBe(false);
    },
    HANG_GUARD_MS
  );

  it.each([
    ['from a folder outside the project', {}],
    ['from its working folder in the project', { cwd: 'project' }],
    ['with --project-root, as Claude Desktop launches it', { args: ['--project-root'] }],
  ] as const)(
    'a server started mid-move %s answers, refuses the record until the move ends, then serves it',
    async (_how, launch) => {
      const move = migrator(root, { seam: true });
      await move.paused();
      const child = server({
        ...('cwd' in launch ? { cwd: root } : {}),
        ...('args' in launch ? { args: ['--project-root', root] } : {}),
      });
      try {
        // 4.9.0's server exited here with [FATAL]: its startup detection threw on the guard, and
        // with --project-root so did its check of that folder (round 1).
        await initialize(child);
        const tools = (await child.request('tools/list')) as { tools: Array<{ name: string }> };
        expect(tools.tools.map((tool) => tool.name)).toContain('rbook_status');
        const during = await status(child);
        expect(during.structuredContent?.success ?? false).toBe(false);
        // A refusal that names the move and says what to do, not a fault to report.
        expect(JSON.stringify(during)).toContain('migration is in progress');
        expect(JSON.stringify(during)).toContain('Retry the call once the move ends');
        expect(JSON.stringify(during)).not.toContain('unhandled internal error');
        move.resume();
        expect((await move.exit).code).toBe(0);
        const after = await status(child);
        expect(after.structuredContent).toMatchObject({ success: true });
        expect(fs.existsSync(moved())).toBe(true);
      } finally {
        await child.close();
      }
      expect(child.stderr).not.toContain('[FATAL]');
      expect(child.stderr).not.toContain('[P0]');
    },
    HANG_GUARD_MS
  );

  it(
    'a 4.x server running before the move keeps running through it, and the check lets it',
    async () => {
      const child = server();
      try {
        await initialize(child);
        expect((await status(child)).structuredContent).toMatchObject({ success: true });
        // ps shows the move this server, so the process check must read its manifest and let it be.
        const exit = await migrator(root, { watch: [child.child.pid!] }).exit;
        expect({ code: exit.code, stdout: exit.stdout }).toMatchObject({ code: 0 });
        expect((await status(child)).structuredContent).toMatchObject({ success: true });
        expect(fs.existsSync(moved())).toBe(true);
      } finally {
        await child.close();
      }
    },
    HANG_GUARD_MS
  );

  it(
    'a session-start hook during a move exits 0, prints nothing to the session, and writes nothing',
    async () => {
      const before = contents(oldDb);
      const move = migrator(root, { seam: true });
      await move.paused();
      const hook = spawn(
        process.execPath,
        [
          bootstrap(
            'hook/run.cjs',
            // main, as the shipped bin runs a hook: an error is one line and exit 0.
            `require(${JSON.stringify(path.join(REPO, 'src/cli.ts'))}).main(process.argv.slice(2));`
          ),
          'hook',
          'session-start',
          '--project-root',
          root,
        ],
        { cwd: root, env: isolated(), stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      hook.stdout.on('data', (chunk) => (stdout += String(chunk)));
      hook.stderr.on('data', (chunk) => (stderr += String(chunk)));
      hook.stdin.end(JSON.stringify({ session_id: 's108-m05-hook', source: 'startup' }));
      const code = await new Promise<number | null>((resolve) => hook.once('close', resolve));
      move.resume();
      expect((await move.exit).code).toBe(0);
      expect({ code, stdout }).toEqual({ code: 0, stdout: '' });
      expect(stderr.trim().split('\n')).toEqual([
        expect.stringContaining('migration is in progress'),
      ]);
      expect(contents(moved())).toEqual(before);
    },
    HANG_GUARD_MS
  );
});

describe('a second migrate by any spelling waits for the first; another project need not', () => {
  it(
    'refuses the same project by a symlink and a case variant, and moves a different one meanwhile',
    async () => {
      const elsewhere = path.join(tmp, 'elsewhere');
      seedLegacyMigrationStore(elsewhere);
      const link = path.join(tmp, 'link');
      fs.symlinkSync(root, link);
      const variant = path.join(tmp, 'PROJECT');
      // A case-sensitive filesystem has no second spelling to try.
      const spellings = [link, ...(fs.existsSync(variant) ? [variant] : [])];
      const first = migrator(root, { seam: true });
      await first.paused();
      for (const spelling of spellings) {
        const second = await migrator(spelling).exit;
        expect({ spelling, code: second.code, stdout: second.stdout }).toMatchObject({
          spelling,
          code: 1,
          stdout: expect.stringContaining('Another migration owns this project'),
        });
      }
      expect((await migrator(elsewhere).exit).code).toBe(0);
      expect(fs.existsSync(path.join(elsewhere, 'rbook/db/rbook.sqlite'))).toBe(true);
      first.resume();
      expect((await first.exit).code).toBe(0);
      expect(fs.existsSync(moved())).toBe(true);
      expect(fs.existsSync(path.join(root, LEGACY.recordDirectory))).toBe(false);
    },
    HANG_GUARD_MS
  );
});
