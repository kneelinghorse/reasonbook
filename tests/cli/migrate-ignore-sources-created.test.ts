// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m01, build round 3 (verifier B): config and ignore files git would open only once the move creates
// ABOUTME: rbook/, spelled as git spells them, refuse; otherwise an ignored file outside the record becomes visible.
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-sources-created-')));
  home = path.join(tmp, 'home');
  xdg = path.join(home, '.config');
  fs.mkdirSync(path.join(xdg, 'git'), { recursive: true });
  // git's default excludes file ignores *.tmp, so other/b.tmp is ignored before migrate runs.
  fs.writeFileSync(path.join(xdg, 'git', 'ignore'), '*.tmp\n');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const env = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: xdg,
  GIT_CONFIG_NOSYSTEM: '1',
});
function g(cwd: string, args: string[], environment: NodeJS.ProcessEnv = env()): string {
  const run = childProcess.spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...environment,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@e',
    },
  });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}
/** A legacy record at root (the top level, or below it); cmos/a.tmp and other/b.tmp exist. */
function repo(prefix = ''): { top: string; root: string } {
  const top = path.join(tmp, 'repo');
  fs.mkdirSync(top);
  g(top, ['init', '-q', '-b', 'main']);
  const root = path.join(top, prefix);
  seedLegacyMigrationStore(root);
  for (const [rel, text] of Object.entries({
    [`${prefix}${OLD}/a.tmp`]: 'a\n',
    'other/b.tmp': 'b\n',
    'empty.ignore': '',
  })) {
    fs.mkdirSync(path.dirname(path.join(top, rel)), { recursive: true });
    fs.writeFileSync(path.join(top, rel), text);
  }
  g(top, ['commit', '-q', '--allow-empty', '-m', 'base']);
  return { top, root };
}
const ignoredOther = (top: string, environment: NodeJS.ProcessEnv) =>
  g(top, ['ls-files', '-o', '-i', '--exclude-standard', '--', 'other'], environment)
    .split('\n')
    .filter(Boolean);
/** A config file in the record that, once git reads it after the move, replaces the excludes file. */
const replacing = (top: string, root: string, name: string) => {
  fs.mkdirSync(path.dirname(path.join(root, OLD, name)), { recursive: true });
  fs.writeFileSync(
    path.join(root, OLD, name),
    `[core]\n\texcludesFile = ${path.join(top, 'empty.ignore')}\n`
  );
};
const caseInsensitive = () => {
  fs.writeFileSync(path.join(tmp, 'probe-case'), '');
  return fs.existsSync(path.join(tmp, 'PROBE-CASE'));
};
const link = (target: string, at: string) => {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
};

type Arrange = (top: string, root: string) => NodeJS.ProcessEnv | void;
const shapes: Array<[string, string, Arrange]> = [
  [
    '~/.gitconfig, a dangling link into rbook/',
    '',
    (top, root) => {
      replacing(top, root, 'global.config');
      link(path.join(root, 'rbook/global.config'), path.join(home, '.gitconfig'));
    },
  ],
  [
    '$HOME/.config/git/config with XDG_CONFIG_HOME unset, a dangling link into rbook/',
    '',
    (top, root) => {
      replacing(top, root, 'global.config');
      link(path.join(root, 'rbook/global.config'), path.join(xdg, 'git', 'config'));
      const unset: NodeJS.ProcessEnv = { ...env() };
      delete unset.XDG_CONFIG_HOME;
      return unset;
    },
  ],
  [
    "the repository's .git/config, a dangling link into rbook/",
    '',
    (top, root) => {
      replacing(top, root, 'repo.config');
      fs.rmSync(path.join(top, '.git/config'));
      link('../rbook/repo.config', path.join(top, '.git/config'));
    },
  ],
  [
    'an include given on the command line (GIT_CONFIG_COUNT) of a file under rbook/',
    '',
    (top, root) => {
      replacing(top, root, 'git.config');
      return {
        ...env(),
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'include.path',
        GIT_CONFIG_VALUE_0: path.join(root, 'rbook/git.config'),
      };
    },
  ],
  [
    'an include relative to .git/ with a .. after a link, which lands in rbook/ (project below the top level)',
    'proj/',
    (top, root) => {
      replacing(top, root, 'git.config');
      fs.mkdirSync(path.join(root, 'inner'));
      link('../proj/inner', path.join(top, '.git/lnk'));
      g(top, ['config', 'include.path', 'lnk/../rbook/git.config']);
    },
  ],
  [
    'XDG_CONFIG_HOME spelled with a .. after a dangling link into rbook/, whose git/config overrides the system file',
    '',
    (top, root) => {
      replacing(top, root, 'git/config');
      fs.mkdirSync(path.join(root, OLD, 'inner'));
      link('rbook/inner', path.join(root, 'lnk'));
      fs.writeFileSync(path.join(tmp, 'system.config'), '[core]\n\texcludesFile = shared.ignore\n');
      fs.writeFileSync(path.join(top, 'shared.ignore'), '*.tmp\n');
      const system: NodeJS.ProcessEnv = {
        ...env(),
        XDG_CONFIG_HOME: `${root}/lnk/..`,
        GIT_CONFIG_SYSTEM: path.join(tmp, 'system.config'),
      };
      delete system.GIT_CONFIG_NOSYSTEM;
      return system;
    },
  ],
  [
    // Passes on d0fef343 too: git's own expansion of ~/ must keep finding it.
    'an include spelled ~/, through a dangling link in HOME into rbook/',
    '',
    (top, root) => {
      replacing(top, root, 'git.config');
      link(path.join(root, 'rbook'), path.join(home, 'lnk'));
      g(top, ['config', 'include.path', '~/lnk/git.config']);
    },
  ],
  [
    'an include of ../RBOOK/git.config with core.ignorecase=false on a case-insensitive disk',
    '',
    (top, root) => {
      if (!caseInsensitive()) return { SKIP: '1' };
      replacing(top, root, 'git.config');
      g(top, ['config', 'core.ignorecase', 'false']);
      g(top, ['config', 'include.path', '../RBOOK/git.config']);
    },
  ],
];

describe('ignore sources only the move creates, spelled as git opens them (build round 3, B1)', () => {
  it.each(shapes)('refuses %s', async (_shape, prefix, arrange) => {
    const { top, root } = repo(prefix);
    const environment = arrange(top, root) ?? env();
    if (environment.SKIP) return;
    expect(ignoredOther(top, environment)).toEqual(['other/b.tmp']);
    const dry = await migrateProject({
      projectRoot: root,
      env: environment,
      apply: false,
      checkProcesses: false,
    });
    expect(dry.data?.blocked?.length).toBe(1);
    const moved = await migrateProject({
      projectRoot: root,
      env: environment,
      apply: true,
      checkProcesses: false,
    });
    expect(moved.success).toBe(false);
    expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
    // The file outside the record stays ignored.
    expect(ignoredOther(top, environment)).toEqual(['other/b.tmp']);
  });

  it('refuses core.precomposeUnicode set by a config included from the record (macOS)', async () => {
    if (process.platform !== 'darwin') return;
    const { top, root } = repo();
    const NFD = 'cafe\u0301';
    const NFC = 'caf\u00e9';
    // The folder's name on disk is NFD; the rule names it in NFC, which git matches only while it
    // precomposes the names it reads.
    fs.mkdirSync(path.join(top, 'other', NFD), { recursive: true });
    fs.writeFileSync(path.join(top, 'other', NFD, 'x.txt'), 'x\n');
    fs.writeFileSync(path.join(top, '.gitignore'), `other/${NFC}/\n`);
    fs.writeFileSync(path.join(root, OLD, 'git.config'), '[core]\n\tprecomposeUnicode = true\n');
    g(top, ['config', 'core.precomposeunicode', 'false']);
    g(top, ['config', 'include.path', `../${OLD}/git.config`]);
    const ignored = () =>
      g(top, [
        '-c',
        'core.quotePath=false',
        'ls-files',
        '-o',
        '-i',
        '--exclude-standard',
        '--',
        'other',
      ])
        .split('\n')
        .filter(Boolean)
        .map((p) => p.normalize('NFC'))
        .filter((p) => p.startsWith(`other/${NFC}/`));
    expect(ignored()).toEqual([`other/${NFC}/x.txt`]);
    const moved = await migrateProject({
      projectRoot: root,
      env: env(),
      apply: true,
      checkProcesses: false,
    });
    expect(moved.error?.message).toContain('through the record folder');
    expect(ignored()).toEqual([`other/${NFC}/x.txt`]);
  });

  it('moves a project whose own and global config files are ordinary, with an include of a file outside', async () => {
    const { top, root } = repo();
    fs.writeFileSync(path.join(home, '.gitconfig.local'), '[user]\n\tname = someone\n');
    fs.writeFileSync(
      path.join(home, '.gitconfig'),
      '[include]\n\tpath = ~/.gitconfig.local\n[includeIf "gitdir:~/work/"]\n\tpath = ~/.gitconfig-work\n'
    );
    const moved = await migrateProject({
      projectRoot: root,
      env: env(),
      apply: true,
      checkProcesses: false,
    });
    expect({ success: moved.success, error: moved.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(ignoredOther(top, env())).toEqual(['other/b.tmp']);
  });
});
