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
import { JOURNAL, PENDING, recoverMigration } from '../../src/cli/migrate-store';
import {
  LEGACY,
  resolveConfigDirectory,
  resolveRecordPaths,
} from '../../src/intelligence/legacy-compat';
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

describe('shared config cutover', () => {
  const guard =
    require('../../src/cli/migrate-guard') as typeof import('../../src/cli/migrate-guard');
  function seedConfig(): { source: string; destination: string; recovery: string } {
    const source = path.join(home, '.config', LEGACY.configDirectory);
    fs.mkdirSync(source, { recursive: true });
    const db = new Database(path.join(source, 'project-graph.sqlite'));
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('registry survives')");
    db.close();
    fs.writeFileSync(path.join(source, 'profile.md'), 'Operator preferences');
    jest.spyOn(guard, 'assertNoRecordProcesses').mockImplementation(() => {});
    return {
      source,
      destination: path.join(home, '.config/rbook'),
      recovery: path.join(home, '.config/.rbook-config-migration.json'),
    };
  }
  it('moves offline registry and credentials together, then does nothing on a second apply', async () => {
    const { source, destination } = seedConfig();
    const result = await migrateConfig({ HOME: home }, true);
    expect(result).toMatchObject({ success: true, data: { moved: true } });
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(destination, 'profile.md'), 'utf8')).toBe(
      'Operator preferences'
    );
    const db = new Database(path.join(destination, 'project-graph.sqlite'), { readonly: true });
    expect(db.prepare('SELECT value FROM witness').get()).toEqual({ value: 'registry survives' });
    db.close();
    expect((await migrateConfig({ HOME: home }, true)).data?.moved).toBe(false);
  });
  it('recovers a config move whose rollback was interrupted before retrying', async () => {
    const { source, destination, recovery } = seedConfig();
    const rename = fs.renameSync;
    const failed = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === source && String(to) === destination) {
        rename(from, to);
        throw new Error('interrupted after rename');
      }
      if (String(from) === destination && String(to) === source)
        throw new Error('rollback interrupted');
      rename(from, to);
    });
    expect((await migrateConfig({ HOME: home }, true)).success).toBe(false);
    failed.mockRestore();
    const receipt = JSON.parse(fs.readFileSync(recovery, 'utf8'));
    receipt.pid = 2147483647;
    fs.writeFileSync(recovery, JSON.stringify(receipt));
    expect((await migrateConfig({ HOME: home }, true)).success).toBe(true);
    expect(fs.existsSync(path.join(destination, 'project-graph.sqlite'))).toBe(true);
    expect(fs.existsSync(recovery)).toBe(false);
  });
  /** A program that keeps a file in the folder open, as lsof sees it, and its stop. */
  async function holder(file: string) {
    const ready = path.join(tmp, `held-${path.basename(file)}`);
    const child = childProcess.spawn(
      process.execPath,
      [
        '-e',
        'require("fs").openSync(process.argv[1], "r");require("fs").writeFileSync(process.argv[2], "");setInterval(() => {}, 1000);',
        file,
        ready,
      ],
      { stdio: 'ignore' }
    );
    while (!fs.existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 20));
    return async () => {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    };
  }
  const mode = (file: string) => {
    const db = new Database(file, { readonly: true });
    try {
      return db.pragma('journal_mode', { simple: true });
    } finally {
      db.close();
    }
  };

  it('recovers an interrupted move that renamed nothing without an open-file check, so its guard goes (s109-m01, #913)', async () => {
    // A program holding a registry kept 4.10.0's guard, which refuses every client's shared config.
    const { source, destination, recovery } = seedConfig();
    const registry = path.join(source, 'project-graph.sqlite');
    const db = new Database(registry);
    db.pragma('journal_mode = DELETE');
    db.close();
    const lock = path.join(home, '.config/.rbook-config-migration.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(
      recovery,
      JSON.stringify({
        pid: 2147483647,
        source,
        destination,
        modes: { 'project-graph.sqlite': 'wal' },
        phase: 'prepared',
      })
    );
    const stop = await holder(registry);
    try {
      const result = await migrateConfig({ HOME: home }, true);
      // The move itself still refuses on the holder; recovery before it released the guard.
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('open by process');
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.existsSync(recovery)).toBe(false);
      expect(mode(registry)).toBe('wal');
    } finally {
      await stop();
    }
  });

  it('puts back in WAL a registry a refused move had switched, and moves none (s109-m01)', async () => {
    const { source, destination } = seedConfig();
    const second = new Database(path.join(source, 'tasks.sqlite'));
    second.pragma('journal_mode = WAL');
    second.exec('CREATE TABLE t (v TEXT)');
    second.close();
    const copy = fs.copyFileSync;
    jest.spyOn(fs, 'copyFileSync').mockImplementation((from, to, flags) => {
      if (String(from).endsWith('tasks.sqlite'))
        throw new Error('simulated full disk at the second backup');
      copy(from, to, flags);
    });
    const result = await migrateConfig({ HOME: home }, true);
    jest.restoreAllMocks();
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('simulated full disk') },
    });
    expect(result.error?.message).not.toContain('rollback-journal mode');
    expect(mode(path.join(source, 'project-graph.sqlite'))).toBe('wal');
    expect(mode(path.join(source, 'tasks.sqlite'))).toBe('wal');
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.existsSync(path.join(home, '.config/.rbook-config-migration.lock'))).toBe(false);
  });

  it('commits a config move whose registry cannot go back to WAL after the rename, naming it where it is (s109-m01)', async () => {
    const { source, destination } = seedConfig();
    let renamed = false;
    const rename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if (String(to) === destination) renamed = true;
    });
    const pragma = Database.prototype.pragma;
    jest.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      opts?: any
    ): any {
      if (renamed && sql === 'journal_mode = WAL')
        throw Object.assign(new Error('simulated: another program holds the registry'), {
          code: 'SQLITE_IOERR',
        });
      return pragma.call(this, sql, opts);
    });
    const result = await migrateConfig({ HOME: home }, true);
    jest.restoreAllMocks();
    expect(result).toMatchObject({ success: true, data: { moved: true } });
    expect(result.data?.left).toEqual([
      expect.stringContaining(
        `${path.join(destination, 'project-graph.sqlite')} stayed in rollback-journal mode`
      ),
    ]);
    expect(fs.existsSync(source)).toBe(false);
  });

  it('does not move shared config while any configured legacy 1.x build remains', async () => {
    const { source } = seedConfig();
    fs.writeFileSync(
      path.join(home, '.claude.json'),
      JSON.stringify({
        mcpServers: { old: { command: 'npx', args: [`${LEGACY.packageName}@1.0.1`] } },
      })
    );
    const result = await migrateConfig({ HOME: home }, true);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('legacy build');
    expect(fs.existsSync(source)).toBe(true);
  });
});

/** Waits, holding this thread, until a file the child writes exists. */
function waitForSignal(file: string): void {
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`never ${file}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}

describe('config: a late writer holding a registry exclusive (s109-m01, round-2 verifier A, B1-config)', () => {
  const guard =
    require('../../src/cli/migrate-guard') as typeof import('../../src/cli/migrate-guard');
  it.each(['refusal before the rename', 'recovery that renamed nothing'])(
    '%s: the guard goes, clients open the shared config, and the writer keeps its row',
    async (shape) => {
      jest.spyOn(guard, 'assertNoRecordProcesses').mockImplementation(() => {});
      const source = path.join(home, '.config', LEGACY.configDirectory);
      fs.mkdirSync(source, { recursive: true });
      const registry = path.join(source, 'project-graph.sqlite');
      const db = new Database(registry);
      db.pragma('journal_mode = WAL');
      db.exec("CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('kept')");
      db.close();
      const signals = fs.mkdtempSync(path.join(tmp, 'writer-'));
      let writer: childProcess.ChildProcess | undefined;
      const start = () => {
        writer = childProcess.spawn(
          process.execPath,
          [
            '-e',
            'const [f, s, q] = process.argv.slice(1);const db = new (require(q))(f, { timeout: 60000 });require("fs").writeFileSync(s + "/ready", "");db.exec("BEGIN EXCLUSIVE");db.prepare("INSERT INTO witness VALUES (\'late-writer\')").run();require("fs").writeFileSync(s + "/locked", "");setInterval(() => { if (require("fs").existsSync(s + "/commit")) { db.exec("COMMIT"); db.close(); process.exit(0); } }, 20);',
            registry,
            signals,
            require.resolve('better-sqlite3'),
          ],
          { stdio: 'ignore' }
        );
        waitForSignal(path.join(signals, 'ready'));
      };
      const spawnSync = childProcess.spawnSync;
      jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
        command: string,
        args: string[],
        opts: any
      ) => {
        // The final check runs once the writer holds the registry's exclusive lock.
        if (command === 'lsof' && writer) waitForSignal(path.join(signals, 'locked'));
        return spawnSync(command, args, opts);
      }) as any);
      if (shape.startsWith('refusal')) {
        const copy = fs.copyFileSync;
        jest.spyOn(fs, 'copyFileSync').mockImplementation((from, to, flags) => {
          if (String(from) === registry && !writer) start();
          copy(from, to, flags);
        });
      } else {
        const d = new Database(registry);
        d.pragma('journal_mode = DELETE');
        d.close();
        fs.writeFileSync(
          path.join(home, '.config/.rbook-config-migration.json'),
          JSON.stringify({
            pid: 2147483647,
            source,
            destination: path.join(home, '.config/rbook'),
            modes: { 'project-graph.sqlite': 'wal' },
            phase: 'prepared',
          })
        );
        fs.mkdirSync(path.join(home, '.config/.rbook-config-migration.lock'));
        start();
        waitForSignal(path.join(signals, 'locked'));
      }
      try {
        const result = await migrateConfig({ HOME: home }, true);
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('MIGRATION_REFUSED');
        expect(result.error?.message).toContain('stayed in rollback-journal mode');
        expect(
          fs.readdirSync(path.join(home, '.config')).filter((n) => n.startsWith('.rbook-config'))
        ).toEqual([]);
        expect(() => resolveConfigDirectory({ HOME: home }, home)).not.toThrow();
      } finally {
        if (writer && writer.exitCode === null) {
          const exited = once(writer, 'exit');
          fs.writeFileSync(path.join(signals, 'commit'), '');
          await exited;
        }
      }
      const after = new Database(registry, { readonly: true });
      expect(after.prepare("SELECT value FROM witness WHERE value = 'late-writer'").get()).toEqual({
        value: 'late-writer',
      });
      after.close();
    },
    120_000
  );
});
