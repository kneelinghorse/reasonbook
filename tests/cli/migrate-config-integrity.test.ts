// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m01, build round 3 (verifier A): once a config move renamed its folder, a registry that fails its
// ABOUTME: integrity check keeps the guard, and a registry kept out of WAL is named with its own cause.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { migrateConfig } from '../../src/cli/migrate-config';
import { LEGACY } from '../../src/intelligence/legacy-compat';

let tmp: string;
let home: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-config-integrity-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('config: the integrity check still runs once a folder was renamed (round-3 verifier A)', () => {
  const guard =
    require('../../src/cli/migrate-guard') as typeof import('../../src/cli/migrate-guard');
  const source = () => path.join(home, '.config', LEGACY.configDirectory);
  const destination = () => path.join(home, '.config', 'rbook');
  const guards = () =>
    fs.readdirSync(path.join(home, '.config')).filter((n) => n.startsWith('.rbook-config'));
  /** Seeds a WAL registry, lets `crash` shape a crashed move, then makes every check after a rename report damage. */
  function setup(crash?: () => void): void {
    jest.spyOn(guard, 'assertNoRecordProcesses').mockImplementation(() => {});
    fs.mkdirSync(source(), { recursive: true });
    const db = new Database(path.join(source(), 'project-graph.sqlite'));
    db.pragma('journal_mode = WAL');
    db.exec("CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('kept')");
    db.close();
    crash?.();
    let renamed = false;
    const rename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to);
      if ([source(), destination()].includes(String(to))) renamed = true;
    });
    const pragma = Database.prototype.pragma;
    jest.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      opts?: any
    ): any {
      if (renamed && sql === 'integrity_check') return 'simulated: page 3 damaged';
      return pragma.call(this, sql, opts);
    });
  }

  it('a move whose registry fails the check after its rename renames back, checks again and keeps the guard', async () => {
    setup();
    const result = await migrateConfig({ HOME: home }, true);
    expect(result.error?.code).toBe('MIGRATION_RECOVERY_REQUIRED');
    // The first failure is the move's check at the destination, the second the catch's check after renaming back.
    expect(result.error?.message).toBe(
      'Integrity check failed for project-graph.sqlite; Integrity check failed for project-graph.sqlite'
    );
    expect(guards()).toHaveLength(2);
    expect(fs.existsSync(source())).toBe(true);
    expect(fs.existsSync(destination())).toBe(false);
  });

  it('recovery of a move that had renamed its folder checks the registry after renaming back, and keeps the guard', async () => {
    setup(() => {
      const d = new Database(path.join(source(), 'project-graph.sqlite'));
      d.pragma('journal_mode = DELETE');
      d.close();
      fs.writeFileSync(
        path.join(home, '.config/.rbook-config-migration.json'),
        JSON.stringify({
          pid: 2147483647,
          source: source(),
          destination: destination(),
          modes: { 'project-graph.sqlite': 'wal' },
          phase: 'prepared',
        })
      );
      fs.mkdirSync(path.join(home, '.config/.rbook-config-migration.lock'));
      fs.renameSync(source(), destination());
    });
    const result = await migrateConfig({ HOME: home }, true);
    // Recovery itself refuses; no move follows it in this call.
    expect(result.error?.code).toBe('MIGRATION_REFUSED');
    expect(result.error?.message).toBe('Integrity check failed for project-graph.sqlite');
    expect(guards()).toHaveLength(2);
    expect(fs.existsSync(source())).toBe(true);
    expect(fs.existsSync(destination())).toBe(false);
  });

  it('names the cause when a registry cannot go back to WAL for a reason other than a lock (note 1)', async () => {
    jest.spyOn(guard, 'assertNoRecordProcesses').mockImplementation(() => {});
    fs.mkdirSync(source(), { recursive: true });
    const seed = new Database(path.join(source(), 'project-graph.sqlite'));
    seed.pragma('journal_mode = WAL');
    seed.close();
    // Nothing is renamed: the move refuses at its last open-file check, after the switch from WAL.
    let checks = 0;
    jest.spyOn(guard, 'assertNoOpenFiles').mockImplementation(() => {
      if (++checks === 2) throw new Error('simulated: a file is open');
    });
    const pragma = Database.prototype.pragma;
    jest.spyOn(Database.prototype, 'pragma').mockImplementation(function (
      this: Database.Database,
      sql: string,
      opts?: any
    ): any {
      if (sql === 'journal_mode = WAL')
        throw Object.assign(new Error('database disk image is malformed'), {
          code: 'SQLITE_CORRUPT',
        });
      return pragma.call(this, sql, opts);
    });
    const result = await migrateConfig({ HOME: home }, true);
    expect(result.error?.code).toBe('MIGRATION_REFUSED');
    expect(result.error?.message).toContain(
      'stayed in rollback-journal mode: putting it back in WAL failed (SQLITE_CORRUPT)'
    );
    expect(result.error?.message).not.toContain('another program held');
    expect(guards()).toHaveLength(0);
  });
});
