// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Offline rename recovery keeps the only valid store reachable after interrupted cutover.
// ABOUTME: Guard and config fixtures prove refusal, no overwrite, owned-text protection and retry.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';
import childProcess from 'child_process';
import { once } from 'events';
import { migrateProject, runMigrate } from '../../src/cli/migrate';
import { migrateConfig } from '../../src/cli/migrate-config';
import {
  assertModernClients,
  assertNoRecordProcesses,
  assertNoOpenFiles,
} from '../../src/cli/migrate-guard';
import { cutoverSeams, JOURNAL, PENDING, recoverMigration } from '../../src/cli/migrate-store';
import { LEGACY, resolveRecordPaths } from '../../src/intelligence/legacy-compat';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

let tmp: string;
let root: string;
let home: string;
let oldDb: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migration-recovery-'));
  root = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  oldDb = seedLegacyMigrationStore(root);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const options = () => ({
  projectRoot: root,
  env: { HOME: home },
  apply: true,
  checkProcesses: false,
});
function deadOwner(): void {
  const file = path.join(root, JOURNAL);
  const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
  journal.pid = 2147483647;
  fs.writeFileSync(file, JSON.stringify(journal));
}

describe('recoverable project cutover', () => {
  it('keeps the guard after blocked rollback, then a later process recovers before a successful retry', async () => {
    const rename = fs.renameSync;
    const fail = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (
        String(to).endsWith('/rbook.sqlite') ||
        String(to) === path.join(root, LEGACY.recordDirectory)
      )
        throw new Error('simulated interrupted move');
      rename(from, to);
    });
    const first = await migrateProject(options());
    fail.mockRestore();
    expect(first.success).toBe(false);
    expect(first.error?.message).toContain('recovery failed');
    expect(() => resolveRecordPaths(root)).toThrow('recovery');
    expect(() => recoverMigration(root)).toThrow('live or unknown owner');
    deadOwner();
    expect(recoverMigration(root)).toBe(true);
    expect(fs.existsSync(oldDb)).toBe(true);
    expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
    expect((await migrateProject(options())).success).toBe(true);
  });
  it('never overwrites a newly created legacy directory during recovery', async () => {
    const oldDirectory = path.join(root, LEGACY.recordDirectory);
    fs.renameSync(oldDirectory, path.join(root, 'rbook'));
    fs.mkdirSync(oldDirectory);
    const marker = path.join(oldDirectory, 'owner.txt');
    fs.writeFileSync(marker, 'Other writer');
    fs.writeFileSync(
      path.join(root, JOURNAL),
      JSON.stringify({
        pid: 2147483647,
        source: oldDirectory,
        destination: path.join(root, 'rbook'),
        phase: 'folder',
      })
    );
    expect(() => recoverMigration(root)).toThrow('both exist');
    expect(fs.readFileSync(marker, 'utf8')).toBe('Other writer');
    expect(fs.existsSync(path.join(root, JOURNAL))).toBe(true);
  });
  it('commits the filesystem once, records failed document work, and finishes on retry', async () => {
    const rules = path.join(root, 'AGENTS.md');
    fs.writeFileSync(rules, `Use ${LEGACY.toolPrefix}review.\n`);
    const rename = fs.renameSync;
    const fail = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === rules) throw new Error('document write unavailable');
      rename(from, to);
    });
    const result = await migrateProject(options());
    fail.mockRestore();
    expect(result.success).toBe(false);
    expect(result.error?.suggestion).toContain('new store is intact');
    expect(fs.existsSync(oldDb)).toBe(false);
    expect(fs.existsSync(path.join(root, PENDING))).toBe(true);
    expect(resolveRecordPaths(root).dbPath).toBe(path.join(root, 'rbook/db/rbook.sqlite'));
    const retry = await migrateProject(options());
    expect(retry.success).toBe(true);
    expect(retry.data?.moved).toBe(false);
    expect(fs.readFileSync(rules, 'utf8')).toBe('Use rbook_review.\n');
    expect(fs.existsSync(path.join(root, PENDING))).toBe(false);
  });
  it('detects a real external SQLite reader and leaves its record unchanged', async () => {
    const child = childProcess.spawn(
      process.execPath,
      [
        '-e',
        'const DB=require(process.argv[1]);const db=new DB(process.argv[2]);db.prepare("SELECT 1").get();process.stdout.write("ready");setInterval(()=>{},1000);',
        require.resolve('better-sqlite3'),
        oldDb,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await once(child.stdout!, 'data');
      const result = await migrateProject(options());
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain(String(child.pid));
      expect(fs.existsSync(oldDb)).toBe(true);
      expect(fs.existsSync(path.join(root, JOURNAL))).toBe(false);
    } finally {
      child.kill();
      await once(child, 'exit');
    }
  });
});

/** Waits, holding this thread, until a file the child writes exists. */
function waitFor(file: string, what: string): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`the late opener never ${what}`);
    Atomics.wait(sleeper, 0, 0, 20);
  }
}

/**
 * Another program that opens the record between the move's first and last open-file checks: a
 * holder keeps only a file descriptor; a reader begins a read transaction as soon as the mover lets
 * go and keeps it, which keeps a WAL store's switch back to WAL from taking its lock.
 */
function lateOpener(
  kind: 'holder' | 'reader' | 'brief reader' | 'brief writer' | 'brief exclusive' | 'held writer',
  file: string
) {
  const signals = fs.mkdtempSync(path.join(tmp, 'opener-'));
  // A brief reader or writer ends its transaction 1.5 s after it begins, within the clients' 5 s
  // busy timeout. A reader's lock calls the busy handler; a writer's reservation refuses the switch
  // to WAL at once, so only enableWal's retries wait it out (decision #1361).
  // An exclusive one blocks even a read, such as rollback's integrity check, which only the
  // connection's busy timeout waits out.
  // A held writer takes the exclusive lock, writes a row, and commits only when told (build critic
  // A, B1): its lock outlasts every busy timeout.
  const begin =
    kind === 'brief writer'
      ? 'db.exec("BEGIN IMMEDIATE");'
      : kind === 'brief exclusive'
        ? 'db.exec("BEGIN EXCLUSIVE");'
        : kind === 'held writer'
          ? 'db.exec("BEGIN EXCLUSIVE");db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (\'late-writer\', \'kept\')").run();'
          : 'db.exec("BEGIN");db.prepare("SELECT count(*) AS n FROM metadata").get();';
  const body =
    kind === 'holder'
      ? 'require("fs").openSync(file, "r");require("fs").writeFileSync(ready, "");'
      : 'const db = new (require(sqlite))(file, { timeout: 60000 });require("fs").writeFileSync(ready, "");' +
        `${begin}require("fs").writeFileSync(reading, "");` +
        (kind.startsWith('brief') ? 'setTimeout(() => db.exec("COMMIT"), 1500);' : '') +
        (kind === 'held writer'
          ? 'setInterval(() => { if (require("fs").existsSync(ready + ".commit")) { db.exec("COMMIT"); process.exit(0); } }, 20);'
          : '');
  let child: childProcess.ChildProcess | undefined;
  return {
    pid: () => child?.pid,
    /** Starts it and waits, holding this thread, until it has the record open. */
    open: () => {
      child = childProcess.spawn(
        process.execPath,
        [
          '-e',
          `const [file, ready, reading, sqlite] = process.argv.slice(1);${body}setInterval(() => {}, 1000);`,
          file,
          path.join(signals, 'ready'),
          path.join(signals, 'reading'),
          require.resolve('better-sqlite3'),
        ],
        { stdio: 'ignore' }
      );
      waitFor(path.join(signals, 'ready'), 'opened the record');
    },
    reading: () => waitFor(path.join(signals, 'reading'), 'began its read'),
    /** A held writer commits its row and exits. */
    commit: async () => {
      if (!child || child.exitCode !== null) return;
      const exited = once(child, 'exit');
      fs.writeFileSync(path.join(signals, 'ready.commit'), '');
      await exited;
    },
    stop: async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    },
  };
}

describe('a move refused before any rename releases its guard (s109-m01, #913)', () => {
  const seams = { ...cutoverSeams };
  afterEach(() => {
    Object.assign(cutoverSeams, seams);
  });

  it.each([
    ['wal', 'holder'],
    ['wal', 'reader'],
    ['wal', 'brief reader'],
    ['wal', 'brief writer'],
    ['wal', 'brief exclusive'],
    ['delete', 'holder'],
    ['delete', 'brief exclusive'],
    ['delete', 'reader'],
  ] as const)(
    'a %s store with a late %s: no guard is left, every row is kept, and the store is back in its mode or the refusal says not',
    async (mode, kind) => {
      const db = new Database(oldDb);
      db.pragma(`journal_mode = ${mode}`);
      const before = db.prepare('SELECT key, value FROM metadata ORDER BY key').all();
      db.close();
      const opener = lateOpener(kind, oldDb);
      const branches: string[] = [];
      // It opens the record after the move's first check, so the final check refuses the move.
      cutoverSeams.beforeFinalCheck = () => {
        branches.push('final check');
        opener.open();
      };
      // The reader holds its read before rollback puts the store back in its mode.
      cutoverSeams.beforeRollbackVerify = () => {
        branches.push('rollback verify');
        if (kind !== 'holder') opener.reading();
      };
      try {
        const result = await migrateProject(options());
        expect(result.success).toBe(false);
        // The final check refused it, naming the opener; rollback did not refuse again.
        expect(result.error?.message).toContain(`open by process ${opener.pid()}`);
        expect(result.error?.message).not.toContain('recovery failed');
        expect(branches).toEqual(['final check', 'rollback verify']);
        // The refusal names the backup the attempt left.
        const backups = fs
          .readdirSync(path.join(root, LEGACY.recordDirectory, 'db', 'snapshots'))
          .filter((name) => /^pre-migrate-.*\.sqlite$/.test(name));
        expect(backups).toHaveLength(1);
        expect(result.error?.message).toContain(backups[0]);
        // No guard is left, so every client opens the project.
        expect(fs.readdirSync(root).filter((name) => name.startsWith('.rbook-migration'))).toEqual(
          []
        );
        expect(resolveRecordPaths(root).dbPath).toBe(oldDb);
        const held = mode === 'wal' && kind === 'reader';
        if (held) expect(result.error?.message).toContain('stays in rollback-journal mode');
        else expect(result.error?.message).not.toContain('rollback-journal mode');
        await opener.stop();
        const after = new Database(oldDb, { readonly: true });
        expect(after.pragma('journal_mode', { simple: true })).toBe(held ? 'delete' : mode);
        expect(after.prepare('SELECT key, value FROM metadata ORDER BY key').all()).toEqual(before);
        after.close();
      } finally {
        await opener.stop();
      }
    },
    120_000
  );

  it.each(['wal', 'delete'])(
    'a %s store with a late writer holding its exclusive lock: the guard goes, and the writer keeps its row (build critic A, B1)',
    async (mode) => {
      const db = new Database(oldDb);
      db.pragma(`journal_mode = ${mode}`);
      db.close();
      const opener = lateOpener('held writer', oldDb);
      cutoverSeams.beforeFinalCheck = () => opener.open();
      cutoverSeams.beforeRollbackVerify = () => opener.reading();
      try {
        const result = await migrateProject(options());
        expect(result.success).toBe(false);
        expect(result.error?.message).toContain(`open by process ${opener.pid()}`);
        expect(result.error?.message).not.toContain('recovery failed');
        expect(fs.readdirSync(root).filter((name) => name.startsWith('.rbook-migration'))).toEqual(
          []
        );
        expect(result.error?.message.includes('stays in rollback-journal mode')).toBe(
          mode === 'wal'
        );
        await opener.commit();
        const after = new Database(oldDb, { readonly: true });
        expect(after.prepare("SELECT value FROM metadata WHERE key = 'late-writer'").get()).toEqual(
          {
            value: 'kept',
          }
        );
        after.close();
      } finally {
        await opener.stop();
      }
    },
    120_000
  );

  it('a phase whose journal write fails leaves rollback reading the phase on disk (build critic A, note 10)', async () => {
    // A late holder opened after the final check, and the journal's write of phase "folder" failing:
    // rollback must read "prepared", renamed nothing, and so release the guard.
    const opener = lateOpener('holder', oldDb);
    cutoverSeams.beforeRename = () => opener.open();
    const rename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (
        String(to) === path.join(root, JOURNAL) &&
        JSON.parse(fs.readFileSync(String(from), 'utf8')).phase === 'folder'
      )
        throw Object.assign(new Error('simulated: no space left for the journal'), {
          code: 'ENOSPC',
        });
      rename(from, to);
    });
    try {
      const result = await migrateProject(options());
      jest.restoreAllMocks();
      expect(result.error?.message).toContain('no space left for the journal');
      expect(result.error?.message).not.toContain('recovery failed');
      expect(fs.readdirSync(root).filter((name) => name.startsWith('.rbook-migration'))).toEqual(
        []
      );
      expect(fs.existsSync(oldDb)).toBe(true);
    } finally {
      jest.restoreAllMocks();
      await opener.stop();
    }
  });

  it('a retry whose recovery cannot put the store back in WAL refuses, leaving no guard (s109-m01)', async () => {
    // A move that died after its journal said prepared, its WAL store left in rollback-journal mode,
    // and a reader holding it: recovery releases the guard, and the retry moves nothing, saying why.
    fs.mkdirSync(path.join(root, '.rbook-migration.lock'));
    fs.writeFileSync(
      path.join(root, JOURNAL),
      JSON.stringify({
        pid: 2147483647,
        source: path.join(root, LEGACY.recordDirectory),
        destination: path.join(root, 'rbook'),
        phase: 'prepared',
        originalIgnore: null,
        ignoreMode: 0o644,
        backup: path.join(root, 'rbook/db/snapshots/backup.sqlite'),
        journalMode: 'wal',
      })
    );
    const reader = lateOpener('reader', oldDb);
    reader.open();
    reader.reading();
    try {
      const result = await migrateProject(options());
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('stays in rollback-journal mode');
      expect(result.error?.message).toContain('Recovery released the migration guard');
      expect(fs.readdirSync(root).filter((name) => name.startsWith('.rbook-migration'))).toEqual(
        []
      );
      expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
    } finally {
      await reader.stop();
    }
  });

  it('keeps the open-file check when the old folder already holds a store under the new name', () => {
    // Fooling the nothing-renamed test: phase prepared, both folders as they were, but rbook.sqlite
    // beside the store, as a rename half done by hand would leave it.
    fs.copyFileSync(oldDb, path.join(root, LEGACY.recordDirectory, 'db', 'rbook.sqlite'));
    fs.mkdirSync(path.join(root, '.rbook-migration.lock'));
    fs.writeFileSync(
      path.join(root, JOURNAL),
      JSON.stringify({
        pid: 2147483647,
        source: path.join(root, LEGACY.recordDirectory),
        destination: path.join(root, 'rbook'),
        phase: 'prepared',
        originalIgnore: null,
        ignoreMode: 0o644,
        backup: path.join(root, 'rbook/db/snapshots/backup.sqlite'),
        journalMode: 'delete',
      })
    );
    const inspected: string[] = [];
    const spawnSync = childProcess.spawnSync;
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) => {
      if (command === 'lsof') inspected.push(args[args.length - 1]);
      return spawnSync(command, args, opts);
    }) as any);
    expect(() => recoverMigration(root)).toThrow('will not overwrite');
    expect(inspected).toEqual([path.join(root, LEGACY.recordDirectory)]);
  });

  it('recovers a move that died before its journal, putting its WAL store back in WAL (build critic A, note 3)', () => {
    // Killed during the backup: only the guard, whose owner file holds the store's mode.
    const db = new Database(oldDb);
    db.pragma('journal_mode = DELETE');
    db.close();
    fs.mkdirSync(path.join(root, '.rbook-migration.lock'));
    fs.writeFileSync(
      path.join(root, '.rbook-migration.lock', 'owner.json'),
      JSON.stringify({ pid: 2147483647, journalMode: 'wal' })
    );
    expect(recoverMigration(root)).toBe(true);
    expect(fs.existsSync(path.join(root, '.rbook-migration.lock'))).toBe(false);
    const after = new Database(oldDb, { readonly: true });
    expect(after.pragma('journal_mode', { simple: true })).toBe('wal');
    after.close();
  });

  it('keeps the open-file check when the journal is past prepared, though both folders look unmoved', () => {
    // A crash after the journal said "folder" may have renamed nothing, or renamed and been undone
    // by hand; rollback does not assume which, so it still asks lsof (fooling the nothing-renamed test).
    fs.mkdirSync(path.join(root, '.rbook-migration.lock'));
    fs.writeFileSync(
      path.join(root, JOURNAL),
      JSON.stringify({
        pid: 2147483647,
        source: path.join(root, LEGACY.recordDirectory),
        destination: path.join(root, 'rbook'),
        phase: 'folder',
        originalIgnore: null,
        ignoreMode: 0o644,
        backup: path.join(root, 'rbook/db/snapshots/backup.sqlite'),
        journalMode: 'delete',
      })
    );
    const inspected: string[] = [];
    const spawnSync = childProcess.spawnSync;
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) => {
      if (command === 'lsof') inspected.push(args[args.length - 1]);
      return spawnSync(command, args, opts);
    }) as any);
    expect(recoverMigration(root)).toBe(true);
    expect(inspected).toEqual([path.join(root, LEGACY.recordDirectory)]);
  });
});

describe('migration owns only its known text', () => {
  it('leaves an edited hookless block byte-for-byte and prints the replacement', async () => {
    const block = `${LEGACY.blockStart}\nOur exception: use ${LEGACY.toolPrefix}review less often.\n${LEGACY.blockEnd}\n`;
    fs.writeFileSync(path.join(root, 'AGENTS.md'), block);
    const result = await migrateProject({ ...options(), docsOnly: true });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe(block);
    expect(result.data?.left.join('\n')).toContain('edited by hand');
  });
  it('rewrites the MCP entry and package while leaving unrelated server configuration intact', async () => {
    const file = path.join(root, '.mcp.json');
    const other = {
      command: 'node',
      args: ['/other/server.js'],
      env: { PROJECT_LABEL: 'user prose' },
    };
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          [LEGACY.command]: {
            command: 'npx',
            args: ['-y', LEGACY.packageName, '--project-root', root],
          },
          other,
        },
      })
    );
    expect((await migrateProject({ ...options(), docsOnly: true })).success).toBe(true);
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(config.mcpServers.rbook.args).toContain('@aquex/reasonbook');
    expect(config.mcpServers[LEGACY.command]).toBeUndefined();
    expect(config.mcpServers.other).toEqual(other);
  });
  it('refuses pinned pre-4 MCP packages rather than publishing an invalid renamed version', async () => {
    const file = path.join(root, '.mcp.json');
    const before = JSON.stringify({
      mcpServers: { [LEGACY.command]: { command: 'npx', args: [`${LEGACY.packageName}@3.5.0`] } },
    });
    fs.writeFileSync(file, before);
    const result = await migrateProject({ ...options(), docsOnly: true });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('pre-4.x');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
  it('refuses invalid flags before touching either folder', async () => {
    const errors: string[] = [];
    for (const args of [
      ['--apply=false'],
      ['--unknown'],
      ['--project'],
      ['--config', '--docs-only'],
    ])
      expect(
        await runMigrate(args, {
          cwd: root,
          env: { HOME: home },
          stdout: () => {},
          stderr: (s) => errors.push(s),
          readStdin: async () => '',
        })
      ).toBe(1);
    expect(errors).toHaveLength(4);
    expect(fs.existsSync(oldDb)).toBe(true);
  });
});

describe('quiescence is evidence, not a checkpoint assumption', () => {
  it('refuses when OS handle inspection is unavailable', () => {
    jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
      pid: 0,
      output: [],
      stdout: '',
      stderr: '',
      status: null,
      signal: null,
      error: new Error('missing lsof'),
    });
    expect(() => assertNoOpenFiles(root)).toThrow('Cannot establish that no other process');
  });
  it('refuses an old configured Codex plugin and malformed installed-plugin metadata', () => {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(
      path.join(home, '.codex/config.toml'),
      `[plugins."${LEGACY.recordDirectory}@${LEGACY.recordDirectory}"]\nenabled = true\n`
    );
    expect(() => assertModernClients(home)).toThrow('legacy plugin');
    fs.rmSync(path.join(home, '.codex/config.toml'));
    fs.mkdirSync(path.join(home, '.claude/plugins'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude/plugins/installed_plugins.json'), '{ invalid');
    expect(() => assertModernClients(home)).toThrow();
  });
  it('the config move refuses even a current on-disk version, which a record move lets run', () => {
    const packageDir = path.join(tmp, 'runtime');
    fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: '@aquex/reasonbook', version: '4.0.0' })
    );
    fs.writeFileSync(path.join(packageDir, 'dist/.build-manifest.json'), '{}');
    const date = new Date(Date.now() - 60_000);
    const started = `${date.toDateString().slice(0, -5)} ${date.toTimeString().slice(0, 8)} ${date.getFullYear()}`;
    jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
      pid: 0,
      output: [],
      stdout: `2147483647 node ${packageDir}/dist/index.js\n`,
      stderr: '',
      status: 0,
      signal: null,
    });
    // Every server holds the registry open for its life (E5 F11). A record's move relies on the
    // in-project guard every 4.x release checks, with its lock held through the renames (s108-m05).
    expect(() => assertNoRecordProcesses()).toThrow('record runtime');
    expect(() => assertNoRecordProcesses('pre-guard')).not.toThrow();
  });
  it('previews config without opening its registry or creating a backup', async () => {
    const config = path.join(home, '.config', LEGACY.configDirectory);
    fs.mkdirSync(config, { recursive: true });
    const file = path.join(config, 'project-graph.sqlite');
    const db = new Database(file);
    db.exec('CREATE TABLE witness(value TEXT)');
    db.close();
    const bytes = fs.readFileSync(file);
    expect(await migrateConfig({ HOME: home }, false)).toMatchObject({
      success: true,
      data: { dryRun: true, moved: false },
    });
    expect(fs.readdirSync(config)).toEqual(['project-graph.sqlite']);
    expect(fs.readFileSync(file)).toEqual(bytes);
  });
});

describe('owned seed files and registration follow-ups', () => {
  it('refreshes an unedited hookless block and seed guide, but keeps user guide prose', async () => {
    const seed = path.resolve(__dirname, '../../rbook-seed');
    const block = fs.readFileSync(path.join(seed, 'templates/AGENTS-no-hooks.md'), 'utf8');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), block);
    fs.mkdirSync(path.join(root, LEGACY.recordDirectory, 'tiers'), { recursive: true });
    const guide = path.join(root, LEGACY.recordDirectory, 'tiers/build.md');
    fs.copyFileSync(path.join(seed, 'tiers/build.md'), guide);
    const edited = path.join(root, LEGACY.recordDirectory, 'tiers/general.md');
    fs.writeFileSync(
      edited,
      `${LEGACY.proseName} is our chosen name here. Call ${LEGACY.toolPrefix}review; see ${LEGACY.recordDirectory}/notes.\n`
    );
    const result = await migrateProject({ ...options(), docsOnly: true });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain(
      '<!-- Reasonbook hook-less block'
    );
    expect(fs.readFileSync(guide, 'utf8')).not.toMatch(
      new RegExp(`\\b${LEGACY.proseName}\\b|\\b${LEGACY.toolPrefix}[a-z]`)
    );
    expect(fs.readFileSync(edited, 'utf8')).toBe(
      `${LEGACY.proseName} is our chosen name here. Call rbook_review; see ${LEGACY.recordDirectory}/notes.\n`
    );
  });
  it('finishes the move of a store with no metadata table, owing no follow-up', async () => {
    // s108-m05 (round 1): such a store moved, then every retry failed on the missing table, and
    // its pending follow-up never cleared.
    const db = new Database(oldDb);
    db.exec('DROP TABLE metadata');
    db.close();
    const result = await migrateProject(options());
    expect({ success: result.success, error: result.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(fs.existsSync(path.join(root, 'rbook/db/rbook.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(root, PENDING))).toBe(false);
  });
  it('refuses a hardlinked database before making a backup', async () => {
    fs.linkSync(oldDb, path.join(tmp, 'shared.sqlite'));
    const result = await migrateProject(options());
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('hardlinked');
    expect(fs.existsSync(path.join(root, LEGACY.recordDirectory, 'db/snapshots'))).toBe(false);
  });
});

describe('cutover phase boundaries preserve committed data', () => {
  it('refuses a failed checkpoint before any move and preserves its committed witness', async () => {
    const pragma = Database.prototype.pragma;
    const fail = jest.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      opts?: any
    ): any {
      if (sql === 'wal_checkpoint(TRUNCATE)') throw new Error('simulated busy checkpoint');
      return pragma.call(this, sql, opts);
    });
    const result = await migrateProject(options());
    fail.mockRestore();
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('checkpoint');
    expect(fs.existsSync(oldDb)).toBe(true);
    expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
    const db = new Database(oldDb, { readonly: true });
    expect(db.prepare("SELECT value FROM metadata WHERE key='project_id'").get()).toBeDefined();
    db.close();
  });
  it.each(['', '-journal'])(
    'refuses a legacy folder already holding rbook.sqlite%s, overwriting and applying nothing (round 2)',
    async (suffix) => {
      // The rename would overwrite a store under the new name, and open the moved store over a
      // journal under it; 4.9.0 overwrote it, and neither copy kept its rows.
      const stray = path.join(root, LEGACY.recordDirectory, 'db', `rbook.sqlite${suffix}`);
      fs.writeFileSync(stray, 'a stray file the move must not touch');
      const result = await migrateProject(options());
      expect(result).toMatchObject({
        success: false,
        error: { message: expect.stringContaining('already exists') },
      });
      expect(fs.readFileSync(stray, 'utf8')).toBe('a stray file the move must not touch');
      expect(fs.existsSync(oldDb)).toBe(true);
      expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
      expect(fs.existsSync(path.join(root, '.rbook-migration.lock'))).toBe(false);
    }
  );
  it('refuses a link to nothing where the moved store goes, and leaves the link (round 3)', async () => {
    // existsSync follows a link, so one to nothing read as absent and the rename replaced it.
    const stray = path.join(root, LEGACY.recordDirectory, 'db', 'rbook.sqlite');
    fs.symlinkSync(path.join(tmp, 'nowhere.sqlite'), stray);
    const result = await migrateProject(options());
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('already exists') },
    });
    expect(fs.readlinkSync(stray)).toBe(path.join(tmp, 'nowhere.sqlite'));
    expect(fs.existsSync(oldDb)).toBe(true);
  });
  it('refuses when another program switches the store to WAL as the move takes its lock (round 2)', async () => {
    // From the switch to DELETE until the exclusive lock, nothing is locked; a WAL switch there
    // would leave a log under the old name, so the move refuses and moves nothing.
    const pragma = Database.prototype.pragma;
    const spy = jest.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      opts?: any
    ): any {
      const result = pragma.call(this, sql, opts);
      if (sql === 'journal_mode = DELETE') {
        const other = new Database(oldDb);
        pragma.call(other, 'journal_mode = WAL');
        other.close();
      }
      return result;
    });
    const result = await migrateProject(options());
    spy.mockRestore();
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('Another process used the record') },
    });
    expect(fs.existsSync(oldDb)).toBe(true);
    expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.rbook-migration.lock'))).toBe(false);
    const db = new Database(oldDb, { readonly: true });
    expect(db.prepare("SELECT value FROM metadata WHERE key='project_id'").get()).toBeDefined();
    db.close();
  });
  it('rolls back after the database filename changed, without losing rows or ignore rules', async () => {
    const ignore = path.join(root, LEGACY.recordDirectory, '.gitignore');
    fs.writeFileSync(ignore, 'custom/\n');
    const rename = fs.renameSync;
    const fail = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).endsWith('/rbook.sqlite')) throw new Error('failure after database rename');
    });
    const result = await migrateProject(options());
    fail.mockRestore();
    expect(result.success).toBe(false);
    expect(fs.readFileSync(ignore, 'utf8')).toBe('custom/\n');
    const db = new Database(oldDb, { readonly: true });
    expect(db.prepare("SELECT value FROM metadata WHERE key='project_id'").get()).toBeDefined();
    db.close();
    expect(fs.existsSync(path.join(root, JOURNAL))).toBe(false);
  });
  it.each(['database', 'committed'])(
    'recovers a crashed %s phase by preserving the valid committed rows',
    (phase) => {
      const source = path.join(root, LEGACY.recordDirectory);
      const destination = path.join(root, 'rbook');
      fs.renameSync(source, destination);
      fs.renameSync(
        path.join(destination, 'db', LEGACY.databaseFile),
        path.join(destination, 'db/rbook.sqlite')
      );
      fs.mkdirSync(path.join(root, '.rbook-migration.lock'));
      fs.writeFileSync(
        path.join(root, JOURNAL),
        JSON.stringify({
          pid: 2147483647,
          source,
          destination,
          phase,
          originalIgnore: null,
          ignoreMode: 0o644,
          backup: path.join(destination, 'db/snapshots/backup.sqlite'),
          journalMode: 'delete',
        })
      );
      expect(recoverMigration(root)).toBe(true);
      const file = phase === 'committed' ? path.join(destination, 'db/rbook.sqlite') : oldDb;
      const db = new Database(file, { readonly: true });
      expect(db.prepare("SELECT value FROM metadata WHERE key='project_id'").get()).toBeDefined();
      db.close();
      expect(fs.existsSync(path.join(root, PENDING))).toBe(phase === 'committed');
    }
  );
  it('a refusal between the switch from WAL and the journal puts a WAL store back in WAL (s109-m01)', async () => {
    // The backup failed after the move had switched the store to rollback-journal mode; 4.10.0
    // released its guard and left the store in that mode, saying nothing.
    const db = new Database(oldDb);
    db.pragma('journal_mode = WAL');
    db.close();
    const prepare = Database.prototype.prepare;
    jest.spyOn(Database.prototype, 'prepare').mockImplementation(function (
      this: Database.Database,
      sql: string
    ): any {
      if (sql === 'VACUUM INTO ?') throw new Error('simulated full disk during the backup');
      return prepare.call(this, sql);
    });
    const result = await migrateProject(options());
    jest.restoreAllMocks();
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('simulated full disk') },
    });
    const after = new Database(oldDb, { readonly: true });
    expect(after.pragma('journal_mode', { simple: true })).toBe('wal');
    after.close();
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.rbook-migration'))).toEqual([]);
  });
  it('commits a move whose store cannot be put back in WAL after both renames, and says so (s109-m01)', async () => {
    // 4.10.0 rolled the completed move back when the switch back to WAL failed.
    const db = new Database(oldDb);
    db.pragma('journal_mode = WAL');
    db.close();
    const pragma = Database.prototype.pragma;
    let renamed = false;
    const rename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to).endsWith('/rbook.sqlite')) renamed = true;
    });
    jest.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      opts?: any
    ): any {
      if (renamed && sql === 'journal_mode = WAL')
        throw Object.assign(new Error('simulated: another program holds the store'), {
          code: 'SQLITE_IOERR',
        });
      return pragma.call(this, sql, opts);
    });
    const result = await migrateProject(options());
    jest.restoreAllMocks();
    expect({ success: result.success, error: result.error, moved: result.data?.moved }).toEqual({
      success: true,
      error: undefined,
      moved: true,
    });
    expect(result.data?.left.join('\n')).toContain('rollback-journal mode');
    expect(fs.existsSync(path.join(root, 'rbook/db/rbook.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(root, LEGACY.recordDirectory))).toBe(false);
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.rbook-migration'))).toEqual([]);
  });
  it('verifies a record with a real vec0 virtual table after moving its filename', async () => {
    const { loadVecExtension } = await import('../../src/tools/rbook/vec-loader');
    const db = new Database(oldDb);
    loadVecExtension(db);
    db.exec('CREATE VIRTUAL TABLE migration_vector USING vec0(embedding float[4])');
    db.close();
    const result = await migrateProject(options());
    expect(result).toMatchObject({ success: true, data: { moved: true } });
  });
});

describe("round-2 verifier A's notes: what no test pinned", () => {
  it("verify waits out a brief exclusive lock within the clients' busy timeout, then puts the store back in WAL", async () => {
    // After both renames and in a rollback that renamed, verify opens the store itself: 4.10.0's
    // 0 ms there made its integrity check fail at once under another program's brief lock.
    const { verify } = await import('../../src/cli/migrate-wal');
    const opener = lateOpener('brief exclusive', oldDb);
    opener.open();
    opener.reading();
    try {
      expect(verify(oldDb, 'wal')).toEqual([]);
      const db = new Database(oldDb, { readonly: true });
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      db.close();
    } finally {
      await opener.stop();
    }
  }, 60_000);

  it("writes the store's journal mode beside the guard's pid before it switches the store", async () => {
    const db = new Database(oldDb);
    db.pragma('journal_mode = WAL');
    db.close();
    const seams = { ...cutoverSeams };
    let owner: unknown;
    cutoverSeams.beforeFinalCheck = () => {
      owner = JSON.parse(
        fs.readFileSync(path.join(root, '.rbook-migration.lock', 'owner.json'), 'utf8')
      );
    };
    try {
      const result = await migrateProject(options());
      expect(result.success).toBe(true);
      // The record's .gitignore is named where it is after the move.
      expect(result.data?.left).toContain(
        `${path.join(root, 'rbook', '.gitignore')}: migrate added its store and backup lines.`
      );
    } finally {
      Object.assign(cutoverSeams, seams);
    }
    expect(owner).toEqual({ pid: process.pid, journalMode: 'wal' });
  });

  it('names the backup under rbook/ when a rollback after the rename cannot finish', async () => {
    // The store's own rename fails, and a program holding it keeps rollback from moving the folder
    // back: the guard stays, and the refusal still says where the attempt's backup is.
    const opener = lateOpener('holder', oldDb);
    const seams = { ...cutoverSeams };
    cutoverSeams.beforeRename = () => opener.open();
    const rename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith(path.join('rbook', 'db', 'rbook.sqlite')))
        throw new Error('simulated: the store could not be renamed');
      rename(from, to);
    });
    try {
      const result = await migrateProject(options());
      jest.restoreAllMocks();
      expect(result.error?.message).toContain('recovery failed');
      expect(result.error?.message).toMatch(
        new RegExp(`The attempt left a backup, ${path.join(root, 'rbook', 'db', 'snapshots')}`)
      );
    } finally {
      jest.restoreAllMocks();
      Object.assign(cutoverSeams, seams);
      await opener.stop();
    }
  });

  it('a recovery reads a damaged owner file beside its journal leniently, and still releases the guard', () => {
    fs.mkdirSync(path.join(root, '.rbook-migration.lock'));
    fs.writeFileSync(path.join(root, '.rbook-migration.lock', 'owner.json'), '{ not json');
    fs.writeFileSync(
      path.join(root, JOURNAL),
      JSON.stringify({
        pid: 2147483647,
        source: path.join(root, LEGACY.recordDirectory),
        destination: path.join(root, 'rbook'),
        phase: 'prepared',
        originalIgnore: null,
        ignoreMode: 0o644,
        backup: path.join(root, 'rbook/db/snapshots/backup.sqlite'),
        journalMode: 'delete',
      })
    );
    expect(recoverMigration(root)).toBe(true);
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.rbook-migration'))).toEqual([]);
  });
});
