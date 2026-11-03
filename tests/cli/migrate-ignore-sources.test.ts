// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m01, build round 2 (verifier B): config includes and links that reach the record folder, or the
// ABOUTME: rbook/ folder the move creates, refuse; otherwise an ignored file outside the record becomes visible.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateProject } from '../../src/cli/migrate';
import { LEGACY } from '../../src/intelligence/legacy-compat';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

const OLD = LEGACY.recordDirectory;
let tmp: string;
let home: string;
let xdg: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-sources-')));
  home = path.join(tmp, 'home');
  xdg = path.join(home, '.config');
  fs.mkdirSync(path.join(xdg, 'git'), { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const env = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: xdg,
  GIT_CONFIG_NOSYSTEM: '1',
});
function g(cwd: string, args: string[]): string {
  const run = childProcess.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...env(),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@e',
    },
  });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}
/** A legacy record at the top level; cmos/a.tmp and other/b.tmp exist, and files names the rest. */
function repo(files: Record<string, string>): string {
  const top = path.join(tmp, 'repo');
  fs.mkdirSync(top);
  g(top, ['init', '-q', '-b', 'main']);
  seedLegacyMigrationStore(top);
  for (const [rel, text] of Object.entries({
    [`${OLD}/a.tmp`]: 'a\n',
    'other/b.tmp': 'b\n',
    ...files,
  })) {
    fs.mkdirSync(path.dirname(path.join(top, rel)), { recursive: true });
    fs.writeFileSync(path.join(top, rel), text);
  }
  g(top, ['commit', '-q', '--allow-empty', '-m', 'base']);
  return top;
}
const ignoredOther = (top: string) =>
  g(top, ['ls-files', '-o', '-i', '--exclude-standard', '--', 'other']).split('\n').filter(Boolean);

describe('ignore sources reached through the record or the folder the move creates (build round 2, B1)', () => {
  it.each([
    [
      'an include of an include, the inner one absolute: the record file includes the one that sets core.excludesFile',
      (top: string) => {
        fs.writeFileSync(path.join(top, 'shared.ignore'), '*.tmp\n');
        fs.writeFileSync(
          path.join(top, 'inc3.config'),
          `[core]\n\texcludesFile = ${path.join(top, 'shared.ignore')}\n`
        );
        fs.writeFileSync(
          path.join(top, OLD, 'inc2.config'),
          `[include]\n\tpath = ${path.join(top, 'inc3.config')}\n`
        );
        g(top, ['config', 'include.path', `../${OLD}/inc2.config`]);
      },
    ],
    [
      'an include of a config only the move creates, under rbook/, which replaces the default excludes file',
      (top: string) => {
        fs.writeFileSync(path.join(xdg, 'git', 'ignore'), '*.tmp\n');
        fs.writeFileSync(path.join(top, 'empty.ignore'), '');
        fs.writeFileSync(
          path.join(top, OLD, 'git.config'),
          '[core]\n\texcludesFile = empty.ignore\n'
        );
        g(top, ['config', 'include.path', '../rbook/git.config']);
      },
    ],
    [
      'an info/exclude linked to a file only the move creates, under rbook/, holding a negation',
      (top: string) => {
        fs.writeFileSync(path.join(xdg, 'git', 'ignore'), '*.tmp\n');
        fs.writeFileSync(path.join(top, OLD, 'local.ignore'), '!*.tmp\n');
        fs.rmSync(path.join(top, '.git/info/exclude'), { force: true });
        fs.symlinkSync('../../rbook/local.ignore', path.join(top, '.git/info/exclude'));
      },
    ],
  ])('refuses %s', async (_shape, arrange) => {
    const top = repo({});
    arrange(top);
    expect(ignoredOther(top)).toEqual(['other/b.tmp']);
    const dry = await migrateProject({
      projectRoot: top,
      env: env(),
      apply: false,
      checkProcesses: false,
    });
    expect(dry.data?.blocked?.length).toBe(1);
    const moved = await migrateProject({
      projectRoot: top,
      env: env(),
      apply: true,
      checkProcesses: false,
    });
    expect(moved.success).toBe(false);
    expect(fs.existsSync(path.join(top, 'rbook'))).toBe(false);
    // The file outside the record stays ignored.
    expect(ignoredOther(top)).toEqual(['other/b.tmp']);
  });

  it("refuses round 1's XS6 for a project below a non-ASCII folder, whose config origin git prints quoted", async () => {
    const top = path.join(tmp, 'repo');
    fs.mkdirSync(top);
    g(top, ['init', '-q', '-b', 'main']);
    const root = path.join(top, 'é');
    seedLegacyMigrationStore(root);
    fs.writeFileSync(path.join(top, 'shared.ignore'), '*.tmp\n');
    fs.mkdirSync(path.join(top, 'other'));
    fs.writeFileSync(path.join(top, 'other/b.tmp'), 'b\n');
    fs.writeFileSync(
      path.join(root, OLD, 'git.config'),
      `[core]\n\texcludesFile = ${path.join(top, 'shared.ignore')}\n`
    );
    g(top, ['config', 'include.path', `../é/${OLD}/git.config`]);
    g(top, ['commit', '-q', '--allow-empty', '-m', 'base']);
    expect(ignoredOther(top)).toEqual(['other/b.tmp']);
    const moved = await migrateProject({
      projectRoot: root,
      env: env(),
      apply: true,
      checkProcesses: false,
    });
    expect(moved.error?.message).toContain('through the record folder');
    expect(ignoredOther(top)).toEqual(['other/b.tmp']);
  });

  it("refuses git's default excludes file reached through the record by .., as XDG_CONFIG_HOME spells it", async () => {
    const top = repo({ 'xdgx/git/ignore': '*.tmp\n' });
    const through = { ...env(), XDG_CONFIG_HOME: `${top}/${OLD}/../xdgx` };
    const ignored = () =>
      childProcess
        .spawnSync('git', ['ls-files', '-o', '-i', '--exclude-standard', '--', 'other'], {
          cwd: top,
          env: through,
          encoding: 'utf8',
        })
        .stdout.split('\n')
        .filter(Boolean);
    expect(ignored()).toEqual(['other/b.tmp']);
    const moved = await migrateProject({
      projectRoot: top,
      env: through,
      apply: true,
      checkProcesses: false,
    });
    expect(moved.error?.message).toContain('through the record folder');
    expect(ignored()).toEqual(['other/b.tmp']);
  });

  it('moves a project whose record holds a config file with unrelated settings only', async () => {
    const top = repo({
      [`${OLD}/git.config`]: '[user]\n\tname = someone\n',
      'shared.ignore': '*.tmp\n',
    });
    g(top, ['config', 'include.path', `../${OLD}/git.config`]);
    g(top, ['config', 'core.excludesFile', 'shared.ignore']);
    const moved = await migrateProject({
      projectRoot: top,
      env: env(),
      apply: true,
      checkProcesses: false,
    });
    expect({ success: moved.success, error: moved.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(ignoredOther(top)).toEqual(['other/b.tmp']);
  });
});
