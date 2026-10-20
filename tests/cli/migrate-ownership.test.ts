// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A concurrent recovery cannot steal the active migrator's guard or invalidate its journal.
// ABOUTME: New-name package seeds still render valid paths for an unmoved legacy record and config.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import childProcess from 'child_process';
import Database from 'better-sqlite3';
import { once } from 'events';
import { migrateProject } from '../../src/cli/migrate';
import { JOURNAL } from '../../src/cli/migrate-store';
import { migrationCoordinatorPath } from '../../src/cli/migrate-exclusion';
import { LEGACY } from '../../src/intelligence/legacy-compat';
import { planDocumentEdits } from '../../src/cli/migrate-docs';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

let tmp: string;
let root: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migration-ownership-'));
  root = path.join(tmp, 'project');
  seedLegacyMigrationStore(root);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('migration coordination survives competing recovery', () => {
  it('refuses a second process before it can remove the first recovery owner guard', async () => {
    const file = migrationCoordinatorPath(root);
    const journal = path.join(root, JOURNAL);
    const stale = JSON.stringify({
      pid: 2147483647,
      source: path.join(root, LEGACY.recordDirectory),
      destination: path.join(root, 'rbook'),
      phase: 'prepared',
    });
    fs.writeFileSync(journal, stale);
    const lock = path.join(root, '.rbook-migration.lock');
    fs.mkdirSync(lock);
    const child = childProcess.spawn(
      process.execPath,
      [
        '-e',
        'const DB=require(process.argv[1]);const db=new DB(process.argv[2]);db.exec("BEGIN EXCLUSIVE");process.stdout.write("ready");setInterval(()=>{},1000);',
        require.resolve('better-sqlite3'),
        file,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await once(child.stdout!, 'data');
      const result = await migrateProject({
        projectRoot: root,
        env: { HOME: tmp },
        apply: true,
        checkProcesses: false,
      });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('Another migration owns');
      expect(fs.readFileSync(journal, 'utf8')).toBe(stale);
      expect(fs.existsSync(lock)).toBe(true);
      const alias = path.join(tmp, 'alias');
      fs.symlinkSync(root, alias);
      expect(migrationCoordinatorPath(alias)).toBe(file);
    } finally {
      child.kill();
      await once(child, 'exit');
    }
  });
});

describe('a shipped renamed seed does not move paths in docs-only mode', () => {
  it('refreshes owned prose and identifiers while rendering the actual legacy project and config paths', () => {
    const seed = path.join(tmp, 'renamed-seed');
    fs.mkdirSync(path.join(seed, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(seed, 'tiers'));
    fs.writeFileSync(
      path.join(seed, 'templates/AGENTS-no-hooks.md'),
      '<!-- Reasonbook hook-less block -->'
    );
    const oldText = `# ${LEGACY.proseName}\nRead ${LEGACY.recordDirectory}/docs/guide.md and ${LEGACY.recordDirectory}/db/${LEGACY.databaseFile}.\nProfile: ~/.config/${LEGACY.configDirectory}/profile.md.\nCall ${LEGACY.toolPrefix}review.\n`;
    const newText =
      '# Reasonbook\nRead rbook/docs/guide.md and rbook/db/rbook.sqlite.\nProfile: ~/.config/rbook/profile.md.\nCall rbook_review.\n';
    fs.writeFileSync(path.join(seed, 'tiers/build.md'), newText);
    const record = path.join(root, LEGACY.recordDirectory);
    fs.mkdirSync(path.join(record, 'tiers'));
    fs.writeFileSync(path.join(record, 'tiers/build.md'), oldText);
    const levels =
      require('../../src/tools/rbook/level-files') as typeof import('../../src/tools/rbook/level-files');
    jest.spyOn(levels, 'resolveSeedPath').mockReturnValue(seed);
    const config = path.join(tmp, '.config', LEGACY.configDirectory);
    const result = planDocumentEdits(root, record, false, config);
    const guide = result.edits.find((edit) => edit.file.endsWith('tiers/build.md'))!.after;
    expect(guide).toContain('# Reasonbook');
    expect(guide).toContain(`${LEGACY.recordDirectory}/docs/guide.md`);
    expect(guide).toContain(`${LEGACY.recordDirectory}/db/${LEGACY.databaseFile}`);
    expect(guide).toContain(`${config}/profile.md`);
    expect(guide).toContain('rbook_review');
    expect(guide).not.toContain('rbook/docs/guide.md');
    expect(guide).not.toContain('.config/reasonbook');
  });
});

describe('offline cutover rejects cached paths before any handle opens', () => {
  it('names a live 4.x runtime holding only a path and never renames its database', async () => {
    const runtime = path.join(tmp, 'runtime');
    fs.mkdirSync(path.join(runtime, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(runtime, 'package.json'),
      JSON.stringify({ name: '@aquex/reasonbook', version: '4.0.0' })
    );
    const entry = path.join(runtime, 'dist/bin.js');
    fs.writeFileSync(
      entry,
      'const DB=require(process.argv[2]);const cached=process.argv[3];process.stdout.write("ready");process.stdin.once("data",()=>{const db=new DB(cached,{fileMustExist:true});db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)").run("cached-path-writer","survived");db.close();process.exit(0);});'
    );
    const oldDb = path.join(root, LEGACY.recordDirectory, 'db', LEGACY.databaseFile);
    const child = childProcess.spawn(
      process.execPath,
      [entry, require.resolve('better-sqlite3'), oldDb],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    try {
      await once(child.stdout!, 'data');
      const guard =
        require('../../src/cli/migrate-guard') as typeof import('../../src/cli/migrate-guard');
      expect(() => guard.assertNoOpenFiles(path.join(root, LEGACY.recordDirectory))).not.toThrow();
      const spawnSync = childProcess.spawnSync;
      jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
        command: string,
        args: string[],
        opts: any
      ) => {
        const result = spawnSync(command, args, opts);
        if (command !== 'ps') return result;
        return {
          ...result,
          stdout: String(result.stdout)
            .split('\n')
            .filter((line) => line.trim().startsWith(`${child.pid} `))
            .join('\n'),
        };
      }) as any);
      const inspect = guard.assertNoRecordProcesses;
      const inspected = jest.spyOn(guard, 'assertNoRecordProcesses').mockImplementation(() => {
        expect(fs.existsSync(path.join(root, '.rbook-migration.lock'))).toBe(true);
        inspect();
      });
      const result = await migrateProject({ projectRoot: root, env: { HOME: tmp }, apply: true });
      // s100-m02: this failed once in a full suite with no message kept, and 0 of 14 runs under two
      // concurrent suites reproduced it; a failure now prints the whole answer.
      expect({ success: result.success, error: result.error }).toEqual({
        success: false,
        error: expect.objectContaining({ message: expect.stringContaining(String(child.pid)) }),
      });
      expect(inspected).toHaveBeenCalled();
      expect(fs.existsSync(oldDb)).toBe(true);
      expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
      const done = once(child, 'exit');
      child.stdin!.write('continue');
      expect((await done)[0]).toBe(0);
      const db = new Database(oldDb, { readonly: true });
      expect(
        db.prepare("SELECT value FROM metadata WHERE key = 'cached-path-writer'").get()
      ).toEqual({ value: 'survived' });
      db.close();
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    }
  });
});

describe('supported global and plugin launch forms stay offline', () => {
  it.each([
    'hooks/install-worker.mjs',
    'server/install-worker.mjs',
    'hooks/installing-server.mjs',
    'server/disabled-server.mjs',
    'bin/reasonbook',
  ])('recognizes a cached-path runtime launched at %s', (relative) => {
    const plugin = path.join(tmp, 'plugin');
    fs.mkdirSync(path.join(plugin, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(plugin, '.claude-plugin/plugin.json'),
      JSON.stringify({ name: 'reasonbook', version: '4.0.0' })
    );
    const guard =
      require('../../src/cli/migrate-guard') as typeof import('../../src/cli/migrate-guard');
    jest.spyOn(childProcess, 'spawnSync').mockReturnValue({
      pid: 0,
      output: [],
      stdout: `2147483647 node ${path.join(plugin, relative)}\n`,
      stderr: '',
      status: 0,
      signal: null,
    });
    expect(() => guard.assertNoRecordProcesses()).toThrow('Process 2147483647');
  });
});
