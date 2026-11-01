// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m05 — one project folder by any spelling: the coordinator, recovery and the registry's
// ABOUTME: update treat a case variant or a symlink of it as the folder itself (E5 F12).
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateProject, runMigrate } from '../../src/cli/migrate';
import { migrationCoordinatorPath } from '../../src/cli/migrate-exclusion';
import { JOURNAL } from '../../src/cli/migrate-store';
import type { CliIo } from '../../src/cli/core';
import { LEGACY } from '../../src/intelligence/legacy-compat';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

let tmp: string;
let root: string;
let home: string;
let link: string;
/** The same folder with its name's case changed, where the filesystem folds case. */
let variant: string | null;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-spellings-'));
  root = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  seedLegacyMigrationStore(root);
  link = path.join(tmp, 'link');
  fs.symlinkSync(root, link);
  variant = fs.existsSync(path.join(tmp, 'PROJECT')) ? path.join(tmp, 'PROJECT') : null;
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const spellings = () => [link, ...(variant ? [variant] : [])];

/** ps shows no runtime, so the machine's own sessions do not decide these tests. */
function quietMachine(): void {
  const spawnSync = childProcess.spawnSync;
  jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
    command: string,
    args: string[],
    opts: any
  ) => {
    const result = spawnSync(command, args, opts);
    return command === 'ps' ? { ...result, stdout: '' } : result;
  }) as any);
}

describe('one coordinator, one recovery and one registry row set for every spelling', () => {
  it('gives every spelling of the folder one coordinator', () => {
    for (const spelling of spellings())
      expect(migrationCoordinatorPath(spelling)).toBe(migrationCoordinatorPath(root));
  });

  it('recovers a move one spelling began, through each other spelling', async () => {
    for (const [began, recovers] of [
      ...spellings().map((spelling) => [spelling, root]),
      ...spellings().map((spelling) => [root, spelling]),
    ]) {
      // A move that died after its folder rename, as its journal records it through one spelling.
      const source = path.join(began, LEGACY.recordDirectory);
      const destination = path.join(began, 'rbook');
      fs.renameSync(path.join(root, LEGACY.recordDirectory), path.join(root, 'rbook'));
      fs.mkdirSync(path.join(root, '.rbook-migration.lock'));
      fs.writeFileSync(
        path.join(root, JOURNAL),
        JSON.stringify({
          pid: 2147483647,
          source,
          destination,
          phase: 'folder',
          originalIgnore: null,
          ignoreMode: 0o644,
          backup: path.join(destination, 'db/snapshots/backup.sqlite'),
          journalMode: 'delete',
        })
      );
      // 4.9.0 answered "Invalid recovery paths" and left every client refusing the project.
      const recovered = await migrateProject({
        projectRoot: recovers,
        env: { HOME: home },
        apply: true,
        checkProcesses: false,
      });
      expect({ began, recovers, success: recovered.success, error: recovered.error }).toEqual({
        began,
        recovers,
        success: true,
        error: undefined,
      });
      expect(fs.existsSync(path.join(root, 'rbook/db/rbook.sqlite'))).toBe(true);
      // Back to the old layout for the next pair.
      fs.rmSync(path.join(root, '.rbook-migration-pending.json'), { force: true });
      fs.renameSync(path.join(root, 'rbook'), path.join(root, LEGACY.recordDirectory));
      fs.renameSync(
        path.join(root, LEGACY.recordDirectory, 'db/rbook.sqlite'),
        path.join(root, LEGACY.recordDirectory, 'db', LEGACY.databaseFile)
      );
    }
  });

  it('refuses a journal that names another folder, renaming nothing (round 2)', async () => {
    // Only this folder, by any spelling, is the journal's to recover; another one's never is.
    const elsewhere = path.join(tmp, 'elsewhere');
    seedLegacyMigrationStore(elsewhere);
    fs.mkdirSync(path.join(root, '.rbook-migration.lock'));
    fs.writeFileSync(
      path.join(root, JOURNAL),
      JSON.stringify({
        pid: 2147483647,
        source: path.join(elsewhere, LEGACY.recordDirectory),
        destination: path.join(elsewhere, 'rbook'),
        phase: 'folder',
        originalIgnore: null,
        ignoreMode: 0o644,
        backup: path.join(elsewhere, 'rbook/db/snapshots/backup.sqlite'),
        journalMode: 'delete',
      })
    );
    const result = await migrateProject({
      projectRoot: root,
      env: { HOME: home },
      apply: true,
      checkProcesses: false,
    });
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('Invalid recovery paths') },
    });
    expect(fs.existsSync(path.join(elsewhere, LEGACY.recordDirectory))).toBe(true);
    expect(fs.existsSync(path.join(elsewhere, 'rbook'))).toBe(false);
    expect(fs.existsSync(path.join(root, LEGACY.recordDirectory))).toBe(true);
  });

  it('marks every registry row naming the folder seen, by any spelling, with no config folder set', async () => {
    quietMachine();
    const config = path.join(home, '.config/rbook');
    fs.mkdirSync(config, { recursive: true });
    const registry = new Database(path.join(config, 'project-graph.sqlite'));
    registry.exec(
      'CREATE TABLE projects(store_path TEXT,last_seen_at INTEGER,archived_at INTEGER)'
    );
    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    for (const stored of [root, ...spellings(), other, path.join(tmp, 'gone')])
      registry.prepare('INSERT INTO projects VALUES (?,1,2)').run(stored);
    registry.close();
    let stdout = '';
    const io: CliIo = {
      // --project names the root; neither RBOOK_CONFIG_DIR nor CMOS_CONFIG_DIR is set.
      env: { HOME: home },
      cwd: tmp,
      readStdin: async () => '',
      stdout: (text) => (stdout += text),
      stderr: () => undefined,
    };
    expect(await runMigrate(['--apply', '--project', root], io)).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ success: true, data: { moved: true } });
    const read = new Database(path.join(config, 'project-graph.sqlite'), { readonly: true });
    const rows = read
      .prepare('SELECT store_path, last_seen_at, archived_at FROM projects')
      .all() as Array<{ store_path: string; last_seen_at: number; archived_at: number | null }>;
    read.close();
    const seen = rows.filter((row) => row.archived_at === null).map((row) => row.store_path);
    expect(seen).toEqual([root, ...spellings()]);
    expect(
      rows.filter((row) => row.archived_at === null).every((row) => row.last_seen_at > 1)
    ).toBe(true);
    expect(rows.filter((row) => row.archived_at !== null)).toEqual([
      { store_path: other, last_seen_at: 1, archived_at: 2 },
      { store_path: path.join(tmp, 'gone'), last_seen_at: 1, archived_at: 2 },
    ]);
  });
});
