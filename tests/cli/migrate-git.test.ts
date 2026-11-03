// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m01 — a move off the old folder in a real git repository keeps every ignored file ignored, judged
// ABOUTME: by its deciding rule, and leaves git's index holding every tracked file under its new path, as git mv does.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import childProcess from 'child_process';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateProject } from '../../src/cli/migrate';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { gitSees } from '../../src/cli/migrate-git';
import { cutoverSeams, JOURNAL, PENDING } from '../../src/cli/migrate-store';
import { LEGACY } from '../../src/intelligence/legacy-compat';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

const OLD = LEGACY.recordDirectory;
const STORE = LEGACY.databaseFile;
/** The record .gitignore the old seed wrote, which 6 of this Mac's 8 git repositories still hold. */
const OLD_SEED = `db/${STORE}\nSESSIONS.jsonl\ndist/\ntelemetry/events/*.jsonl\ntelemetry/events/*.json\nruntime/boomerang/\n\n**/__pycache__/\n**/*.pyc\n\n.DS_Store\n`;
const HANG_GUARD_MS = 120_000;

let tmp: string;
let home: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-git-')));
  home = path.join(tmp, 'home');
  fs.mkdirSync(path.join(home, '.config', 'git'), { recursive: true });
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** The live environment migrate's git and the tests' git share: a scratch HOME, no system config. */
const env = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, '.config'),
  GIT_CONFIG_NOSYSTEM: '1',
});
function g(cwd: string, args: string[], input?: string): string {
  // Paths print as they are, so a non-ASCII one compares as written.
  const run = childProcess.spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    encoding: 'utf8',
    input,
    env: {
      ...env(),
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`);
  return run.stdout;
}
const lines = (out: string) => out.split('\n').filter(Boolean);

interface Repo {
  readonly top: string;
  readonly root: string;
  /** The project root from the top level, with a trailing slash, or ''. */
  readonly prefix: string;
  /** The old folder from the top level, as git names it. */
  readonly old: string;
}

/**
 * A git repository holding a legacy record: ignores and their files are committed, files are not
 * unless track names them, and every path is from the top level.
 */
function repo(
  spec: {
    prefix?: string;
    ignores?: Record<string, string>;
    files?: Record<string, string>;
    track?: string[];
    recordIgnore?: string | null;
    /** The old folder spelled CMOS on disk, and so in the index. */
    upper?: boolean;
  } = {}
): Repo {
  const top = path.join(tmp, 'repo');
  fs.mkdirSync(top);
  g(top, ['init', '-q', '-b', 'main']);
  const prefix = spec.prefix ?? '';
  const root = path.join(top, prefix);
  seedLegacyMigrationStore(root);
  let folder: string = OLD;
  if (spec.upper) {
    folder = OLD.toUpperCase();
    fs.renameSync(path.join(root, OLD), path.join(root, 'case-swap'));
    fs.renameSync(path.join(root, 'case-swap'), path.join(root, folder));
  }
  const old = `${prefix}${folder}`;
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(top, rel)), { recursive: true });
    fs.writeFileSync(path.join(top, rel), text);
  };
  const record = spec.recordIgnore === null ? [] : [`${old}/.gitignore`];
  if (spec.recordIgnore !== null) write(`${old}/.gitignore`, spec.recordIgnore ?? OLD_SEED);
  for (const [rel, text] of Object.entries(spec.ignores ?? {})) write(rel, text);
  for (const [rel, text] of Object.entries(spec.files ?? {})) write(rel, text);
  const track = [...Object.keys(spec.ignores ?? {}), ...record, ...(spec.track ?? [])];
  if (track.length) g(top, ['add', '-f', '--', ...track]);
  g(top, ['commit', '-q', '--allow-empty', '-m', 'base']);
  return { top, root, prefix, old };
}

const move = (root: string, apply = true) =>
  migrateProject({ projectRoot: root, env: env(), apply, checkProcesses: false });
/** A file's path under the old folder, as it is after the move: the store gets its new name. */
const moved = (r: Repo, file: string) => {
  const rel = file.slice(r.old.length + 1);
  return `${r.prefix}rbook/${rel === `db/${STORE}` ? 'db/rbook.sqlite' : rel}`;
};
// Each names its folder literally, so a folder spelled with glob characters matches only itself.
const ignoredUnder = (r: Repo, folder: string) =>
  lines(
    g(r.top, ['--literal-pathspecs', 'ls-files', '-o', '-i', '--exclude-standard', '--', folder])
  );
const visibleUnder = (r: Repo, folder: string) =>
  lines(g(r.top, ['--literal-pathspecs', 'ls-files', '-o', '--exclude-standard', '--', folder]));
const indexUnder = (r: Repo, folder: string) =>
  lines(g(r.top, ['--literal-pathspecs', 'ls-files', '--', folder]));
const read = (r: Repo, rel: string) => fs.readFileSync(path.join(r.top, rel), 'utf8');
const guardsLeft = (r: Repo) =>
  fs.readdirSync(r.root).filter((name) => name.startsWith('.rbook-migration'));

/** What a move must keep: each ignored file ignored, each tracked file in the index, at its new path. */
function snapshot(r: Repo) {
  return { ignored: ignoredUnder(r, r.old), tracked: indexUnder(r, r.old) };
}
function expectKept(r: Repo, before: ReturnType<typeof snapshot>) {
  const ignored = new Set(ignoredUnder(r, `${r.prefix}rbook`));
  const tracked = new Set(indexUnder(r, `${r.prefix}rbook`));
  expect({
    exposed: before.ignored.map((file) => moved(r, file)).filter((file) => !ignored.has(file)),
    dropped: before.tracked.map((file) => moved(r, file)).filter((file) => !tracked.has(file)),
    leftInIndex: indexUnder(r, r.old),
  }).toEqual({ exposed: [], dropped: [], leftInIndex: [] });
}
async function expectMoved(r: Repo) {
  const before = snapshot(r);
  const result = await move(r.root);
  expect({ success: result.success, error: result.error }).toEqual({
    success: true,
    error: undefined,
  });
  expect(fs.existsSync(path.join(r.root, 'rbook/db/rbook.sqlite'))).toBe(true);
  expectKept(r, before);
  return result;
}
const caseInsensitive = () => {
  const probe = path.join(tmp, 'probe-case');
  fs.writeFileSync(probe, '');
  return fs.existsSync(path.join(tmp, 'PROBE-CASE'));
};

describe('the ignore rules: anchored twins, and nothing outside the universe', () => {
  it("keeps TraceLab's negation shape: a re-included file stays re-included under rbook/", async () => {
    // Without a twin for the negation, artifacts/ would hide rbook/reports/**/artifacts/.
    const r = repo({
      ignores: { '.gitignore': `artifacts/\n!${OLD}/reports/**/artifacts/\n` },
      files: { [`${OLD}/reports/run/artifacts/a.txt`]: 'a\n' },
    });
    expect(visibleUnder(r, OLD)).toContain(`${OLD}/reports/run/artifacts/a.txt`);
    await expectMoved(r);
    expect(visibleUnder(r, 'rbook')).toContain('rbook/reports/run/artifacts/a.txt');
    expect(read(r, '.gitignore')).toBe(
      `artifacts/\n!${OLD}/reports/**/artifacts/\n!/rbook/reports/**/artifacts/\n`
    );
  });

  it("leaves a subfolder's .gitignore byte-identical: git applies it only below its own folder", async () => {
    const nested = `${OLD}/x\n`;
    const r = repo({
      ignores: { '.gitignore': `${OLD}/db/snapshots/\n`, 'sub/.gitignore': nested },
    });
    await expectMoved(r);
    expect(read(r, 'sub/.gitignore')).toBe(nested);
  });

  it('anchors the twin of an unanchored rule: a nested vendor folder stays ignored, src/rbook/ visible', async () => {
    const r = repo({
      ignores: { '.gitignore': `${OLD}/\n` },
      files: { [`vendor/${OLD}/f`]: 'f\n', 'src/rbook/index.ts': 'x\n' },
    });
    await expectMoved(r);
    expect(ignoredUnder(r, 'vendor')).toEqual([`vendor/${OLD}/f`]);
    expect(visibleUnder(r, 'src')).toEqual(['src/rbook/index.ts']);
    expect(read(r, '.gitignore')).toBe(`${OLD}/\n/rbook/\n`);
  });

  it("twins a rule naming the store twice, so a backup under the store's old name stays ignored", async () => {
    const r = repo({
      ignores: { '.gitignore': `${OLD}/db/${STORE}*\n` },
      files: { [`${OLD}/db/${STORE}.1.bak`]: 'bak\n' },
    });
    await expectMoved(r);
    expect(ignoredUnder(r, 'rbook/db')).toContain(`rbook/db/${STORE}.1.bak`);
    expect(read(r, '.gitignore')).toBe(
      `${OLD}/db/${STORE}*\n/rbook/db/${STORE}*\n/rbook/db/rbook.sqlite*\n`
    );
  });

  it('adds no twin already present, and twins in each ancestor too', async () => {
    const r = repo({
      prefix: 'sub/proj/',
      ignores: {
        '.gitignore': `sub/proj/${OLD}/db/snapshots/\n`,
        'sub/.gitignore': `proj/${OLD}/telemetry/\n`,
        'sub/proj/.gitignore': `${OLD}/jobs/\n/rbook/jobs/\n`,
      },
      files: {
        [`sub/proj/${OLD}/jobs/cv.pdf`]: 'cv\n',
        [`sub/proj/${OLD}/telemetry/t.json`]: '{}\n',
      },
    });
    await expectMoved(r);
    expect(read(r, 'sub/proj/.gitignore')).toBe(`${OLD}/jobs/\n/rbook/jobs/\n`);
    expect(read(r, 'sub/.gitignore')).toBe(`proj/${OLD}/telemetry/\n/proj/rbook/telemetry/\n`);
    expect(read(r, '.gitignore')).toBe(
      `sub/proj/${OLD}/db/snapshots/\n/sub/proj/rbook/db/snapshots/\n`
    );
  });

  it('a non-git project gets its twins and no git step', async () => {
    const root = path.join(tmp, 'plain');
    seedLegacyMigrationStore(root);
    fs.writeFileSync(path.join(root, '.gitignore'), `${OLD}/db/snapshots/\n`);
    const spawnSync = childProcess.spawnSync;
    const commands: string[] = [];
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) => {
      commands.push(command);
      return spawnSync(command, args, opts);
    }) as any);
    const result = await move(root);
    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(
      `${OLD}/db/snapshots/\n/rbook/db/snapshots/\n`
    );
    expect(commands).not.toContain('git');
  });

  it("names the store's SQLite sidecars when git tracks them, since leaving WAL deletes them", async () => {
    // system.systems tracks both; an ordinary commit after the move records their deletion.
    const r = repo({
      files: { [`${OLD}/db/${STORE}-wal`]: '', [`${OLD}/db/${STORE}-shm`]: '' },
      track: [`${OLD}/db/${STORE}-wal`, `${OLD}/db/${STORE}-shm`],
    });
    const result = await move(r.root);
    expect(result.success).toBe(true);
    expect(result.data?.left.join('\n')).toContain(
      `git tracks the store's SQLite sidecars (${OLD}/db/${STORE}-shm, ${OLD}/db/${STORE}-wal)`
    );
    // The index keeps them under the new folder, as git mv would.
    expect(indexUnder(r, 'rbook/db')).toEqual([`rbook/db/${STORE}-shm`, `rbook/db/${STORE}-wal`]);
  });

  it('never writes through a symlinked root .gitignore, which git does not read, and says so', async () => {
    const r = repo({ files: { 'shared-ignore': `${OLD}/db/snapshots/\n` } });
    fs.symlinkSync('shared-ignore', path.join(r.top, '.gitignore'));
    const result = await expectMoved(r);
    expect(read(r, 'shared-ignore')).toBe(`${OLD}/db/snapshots/\n`);
    expect(result.data?.left.join('\n')).toContain('is a symlink');
  });
});

describe('the deciding-rule backstop', () => {
  it('refuses a bare cmos*/ rule, which no twin covers, and restores the .gitignore byte-identical', async () => {
    const rootIgnore = `${OLD}/db/snapshots/\n${OLD}*/\n`;
    const r = repo({ ignores: { '.gitignore': rootIgnore } });
    const dry = await move(r.root, false);
    expect(dry.data?.blocked).toEqual([expect.stringContaining('visible to git')]);
    const result = await move(r.root);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('rbook/db/rbook.sqlite');
    expect(read(r, '.gitignore')).toBe(rootIgnore);
    expect(fs.existsSync(path.join(r.root, OLD, 'db', STORE))).toBe(true);
    expect(fs.existsSync(path.join(r.root, 'rbook'))).toBe(false);
    expect(guardsLeft(r)).toEqual([]);
  });

  it('says when git can see the backup a refused move left, and not when a rule ignores it (build critic A, note 6)', async () => {
    // The old seed ignores only the store, so a refused move's full copy of it sits untracked and
    // visible: the next git add -A would commit it.
    const visible = repo({
      ignores: { '.gitignore': `${OLD}*/private/\n` },
      files: { [`${OLD}/private/a.txt`]: 'a\n' },
    });
    const refused = await move(visible.root);
    expect(refused.success).toBe(false);
    expect(refused.error?.message).toContain('git can see it');
    fs.rmSync(path.join(tmp, 'repo'), { recursive: true, force: true });
    const ignored = repo({
      ignores: { '.gitignore': `${OLD}*/private/\n${OLD}/db/snapshots/\n` },
      files: { [`${OLD}/private/a.txt`]: 'a\n' },
    });
    const quiet = await move(ignored.root);
    expect(quiet.success).toBe(false);
    expect(quiet.error?.message).toContain('The attempt left a backup');
    expect(quiet.error?.message).not.toContain('git can see it');
  });

  it("refuses nothing the record's own rules keep ignored: the store, SESSIONS.jsonl, pytest's cache, the backup", async () => {
    const r = repo({
      files: {
        [`${OLD}/SESSIONS.jsonl`]: '{}\n',
        [`${OLD}/.pytest_cache/.gitignore`]: '# Created by pytest automatically.\n*\n',
        [`${OLD}/.pytest_cache/v/cache/lastfailed`]: '{}\n',
      },
    });
    expect((await move(r.root, false)).data?.blocked).toEqual([]);
    await expectMoved(r);
    expect(ignoredUnder(r, 'rbook')).toEqual(
      expect.arrayContaining([
        'rbook/SESSIONS.jsonl',
        'rbook/.pytest_cache/v/cache/lastfailed',
        'rbook/db/rbook.sqlite',
        expect.stringMatching(/^rbook\/db\/snapshots\/pre-migrate-.*\.sqlite$/),
      ])
    );
  });

  it('refuses a store db/.gitignore that negates *.sqlite and names only the old store', async () => {
    const r = repo({ files: { [`${OLD}/db/.gitignore`]: `!*.sqlite\n${STORE}\n` } });
    expect((await move(r.root, false)).data?.blocked).toEqual([
      expect.stringContaining('rbook/db/rbook.sqlite'),
    ]);
    expect((await move(r.root)).error?.message).toContain('rbook/db/rbook.sqlite');
  });

  it('refuses nothing falsely for a project below its top level', async () => {
    const r = repo({
      prefix: 'sub/proj/',
      files: { [`sub/proj/${OLD}/SESSIONS.jsonl`]: '{}\n', 'top.txt': 'top\n' },
      track: ['top.txt'],
    });
    expect((await move(r.root, false)).data?.blocked).toEqual([]);
    await expectMoved(r);
    // --full-name: the index step touched no entry outside the project.
    expect(indexUnder(r, 'top.txt')).toEqual(['top.txt']);
    expect(lines(g(r.top, ['diff', '--cached', '--name-status', '-M', '--', 'top.txt']))).toEqual(
      []
    );
  });

  it("does not lose an owner's edit to the root .gitignore made during the backstop", async () => {
    const r = repo({
      ignores: { '.gitignore': `${OLD}/db/snapshots/\n${OLD}*/private/\n` },
      files: { [`${OLD}/private/key.txt`]: 'k\n' },
    });
    const spawnSync = childProcess.spawnSync;
    let edited = false;
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) => {
      if (command === 'git' && args[0] === 'check-ignore' && !edited) {
        edited = true;
        fs.appendFileSync(path.join(r.top, '.gitignore'), 'owner-edit/\n');
      }
      return spawnSync(command, args, opts);
    }) as any);
    const result = await move(r.root);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('rbook/private/key.txt');
    expect(read(r, '.gitignore')).toContain('owner-edit/');
    expect(result.error?.message).toContain('changed after migrate added its rbook/ lines');
  });

  it('refuses a file whose deciding rule -v cannot name, as in a non-cone sparse checkout', async () => {
    // The record's .gitignore is skip-worktree and off disk; git reads its rule from the index.
    const r = repo({
      recordIgnore: `${OLD_SEED}secret.txt\n`,
      files: { [`${OLD}/n.md`]: 'n\n' },
      track: [`${OLD}/n.md`],
    });
    g(r.top, ['sparse-checkout', 'set', '--no-cone', '/*', `!/${OLD}/.gitignore`]);
    expect(fs.existsSync(path.join(r.root, OLD, '.gitignore'))).toBe(false);
    fs.writeFileSync(path.join(r.root, OLD, 'secret.txt'), 'k\n');
    expect(ignoredUnder(r, OLD)).toContain(`${OLD}/secret.txt`);
    const result = await move(r.root);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('rbook/secret.txt');
    // Rollback removed the file migrate wrote, so the sparse checkout is as it was.
    expect(fs.existsSync(path.join(r.root, OLD, '.gitignore'))).toBe(false);
    expect(ignoredUnder(r, OLD)).toContain(`${OLD}/secret.txt`);
  });
});

describe('the dry run judges in a temporary repository holding every ignore source', () => {
  it('names each true exposure it is shown, so it fails if it checks nothing', async () => {
    const shapes: Array<[string, Parameters<typeof repo>[0], (r: Repo) => void, string]> = [
      [
        'a cmos*/private/ rule',
        {
          ignores: { '.gitignore': `${OLD}*/private/\n` },
          files: { [`${OLD}/private/a.txt`]: 'a\n' },
        },
        () => {},
        'rbook/private/a.txt',
      ],
      [
        'an info/exclude line',
        { files: { [`${OLD}/secret/a.txt`]: 'a\n' } },
        (r) => fs.appendFileSync(path.join(r.top, '.git/info/exclude'), `${OLD}/secret/\n`),
        'rbook/secret/a.txt',
      ],
      [
        'a store db/.gitignore negating *.sqlite',
        { files: { [`${OLD}/db/.gitignore`]: `!*.sqlite\n${STORE}\n` } },
        () => {},
        'rbook/db/rbook.sqlite',
      ],
    ];
    for (const [name, spec, arrange, exposed] of shapes) {
      fs.rmSync(path.join(tmp, 'repo'), { recursive: true, force: true });
      const r = repo(spec);
      arrange(r);
      const result = await move(r.root, false);
      expect({ name, blocked: result.data?.blocked }).toEqual({
        name,
        blocked: [expect.stringContaining(exposed)],
      });
    }
  });

  it(
    "names no false path where migrate's lines decide, or only info/exclude, core.excludesFile or a case-folded rule ignores",
    async () => {
      const shapes: Array<[string, Parameters<typeof repo>[0], (r: Repo) => void]> = [
        // A6's W1 to W4: an outside rule decides now, migrate's db/snapshots/ or WAL lines after.
        [
          'W1, info/exclude',
          { files: { [`${OLD}/db/snapshots/old-1.sqlite`]: 's\n' } },
          (r) => fs.appendFileSync(path.join(r.top, '.git/info/exclude'), `${OLD}/db/snapshots/\n`),
        ],
        [
          'W2, core.excludesFile and the WAL pair',
          { files: { [`${OLD}/db/${STORE}-wal`]: '', [`${OLD}/db/${STORE}-shm`]: '' } },
          (r) => {
            fs.writeFileSync(
              path.join(tmp, 'excludes'),
              `${OLD}/db/*.sqlite-wal\n${OLD}/db/*.sqlite-shm\n`
            );
            g(r.top, ['config', 'core.excludesFile', path.join(tmp, 'excludes')]);
          },
        ],
        [
          'W3, cmos*/db/snapshots/',
          {
            ignores: { '.gitignore': `${OLD}*/db/snapshots/\n` },
            files: { [`${OLD}/db/snapshots/old-1.sqlite`]: 's\n' },
          },
          () => {},
        ],
        [
          'W4, an ancestor **/cmos/db/snapshots/',
          {
            prefix: 'sub/proj/',
            ignores: { '.gitignore': `**/${OLD}/db/snapshots/\n` },
            files: { [`sub/proj/${OLD}/db/snapshots/old-1.sqlite`]: 's\n' },
          },
          () => {},
        ],
        [
          'only info/exclude *.tmp',
          { files: { [`${OLD}/a.tmp`]: 't\n' } },
          (r) => fs.appendFileSync(path.join(r.top, '.git/info/exclude'), '*.tmp\n'),
        ],
        [
          'only core.excludesFile *.tmp',
          { files: { [`${OLD}/a.tmp`]: 't\n' } },
          (r) => {
            fs.writeFileSync(path.join(tmp, 'excludes'), '*.tmp\n');
            g(r.top, ['config', 'core.excludesFile', path.join(tmp, 'excludes')]);
          },
        ],
        [
          'a case-folded *.TMP under core.ignorecase',
          { ignores: { '.gitignore': '*.TMP\n' }, files: { [`${OLD}/a.tmp`]: 't\n' } },
          (r) => g(r.top, ['config', 'core.ignorecase', 'true']),
        ],
        [
          "pytest's self-ignoring cache",
          {
            files: {
              [`${OLD}/.pytest_cache/.gitignore`]: '*\n',
              [`${OLD}/.pytest_cache/v/x`]: '{}\n',
            },
          },
          () => {},
        ],
      ];
      for (const [name, spec, arrange] of shapes) {
        fs.rmSync(path.join(tmp, 'repo'), { recursive: true, force: true });
        const r = repo(spec);
        arrange(r);
        const before = snapshot(r);
        expect(before.ignored.length).toBeGreaterThan(0);
        expect({ name, blocked: (await move(r.root, false)).data?.blocked }).toEqual({
          name,
          blocked: [],
        });
        // And the move agrees: nothing becomes visible.
        const result = await move(r.root);
        expect({ name, success: result.success, error: result.error }).toEqual({
          name,
          success: true,
          error: undefined,
        });
        expectKept(r, before);
      }
    },
    HANG_GUARD_MS
  );

  it('previews every twin and writes nothing', async () => {
    const r = repo({ ignores: { '.gitignore': `${OLD}/db/snapshots/\n${OLD}/jobs/\n` } });
    const before = read(r, '.gitignore');
    const result = await move(r.root, false);
    expect(result.data?.twins).toEqual([
      `${path.join(r.top, '.gitignore')}: /rbook/db/snapshots/`,
      `${path.join(r.top, '.gitignore')}: /rbook/jobs/`,
    ]);
    expect(result.data?.changed).toContain(path.join(r.top, '.gitignore'));
    expect(read(r, '.gitignore')).toBe(before);
    expect(fs.existsSync(path.join(r.root, 'rbook'))).toBe(false);
  });
});

describe('round 8 (#922): ignore sources inside the record, and the live environment', () => {
  it.each([
    [
      'an absolute core.excludesFile inside the record',
      (r: Repo) =>
        g(r.top, ['config', 'core.excludesFile', path.join(r.root, OLD, 'local.ignore')]),
    ],
    [
      'a relative core.excludesFile inside the record',
      (r: Repo) => g(r.top, ['config', 'core.excludesFile', `${OLD}/local.ignore`]),
    ],
    [
      'an info/exclude linked into the record',
      (r: Repo) => {
        fs.rmSync(path.join(r.top, '.git/info/exclude'), { force: true });
        fs.symlinkSync(`../../${OLD}/local.ignore`, path.join(r.top, '.git/info/exclude'));
      },
    ],
  ])('refuses %s before any write, in the move and its dry run', async (_shape, arrange) => {
    const r = repo({
      files: { [`${OLD}/local.ignore`]: '*.tmp\n', [`${OLD}/a.tmp`]: 't\n', 'other/b.tmp': 'b\n' },
    });
    arrange(r);
    expect(ignoredUnder(r, 'other')).toEqual(['other/b.tmp']);
    const dry = await move(r.root, false);
    expect(dry.data?.blocked).toEqual([expect.stringContaining('inside the record folder')]);
    const result = await move(r.root);
    expect(result.error?.message).toContain('inside the record folder');
    expect(fs.existsSync(path.join(r.root, 'rbook'))).toBe(false);
    expect(guardsLeft(r)).toEqual([]);
  });

  it('moves the control: a core.excludesFile at the top level, relative', async () => {
    const r = repo({ files: { 'local.ignore': '*.tmp\n', [`${OLD}/a.tmp`]: 't\n' } });
    g(r.top, ['config', 'core.excludesFile', 'local.ignore']);
    // Resolved against the live top level, it decides here and in the temporary repository alike.
    expect((await move(r.root, false)).data?.blocked).toEqual([]);
    await expectMoved(r);
  });

  it("uses git's default excludes file in the live environment when the key is unset", async () => {
    fs.writeFileSync(path.join(home, '.config', 'git', 'ignore'), '*.tmp\n');
    const r = repo({ files: { [`${OLD}/a.tmp`]: 't\n' } });
    expect(ignoredUnder(r, OLD)).toContain(`${OLD}/a.tmp`);
    expect((await move(r.root, false)).data?.blocked).toEqual([]);
    await expectMoved(r);
  });

  it('copies an unset core.ignorecase as false, naming the true exposure it makes', async () => {
    const r = repo({
      ignores: { '.gitignore': `${OLD}*/private/\n` },
      recordIgnore: `${OLD_SEED}Private/\n`,
      files: { [`${OLD}/private/a.txt`]: 'a\n' },
    });
    g(r.top, ['config', '--unset', 'core.ignorecase']);
    expect((await move(r.root, false)).data?.blocked).toEqual([
      expect.stringContaining('rbook/private/a.txt'),
    ]);
    expect((await move(r.root)).error?.message).toContain('rbook/private/a.txt');
  });

  it("leaves a negation in the record's .gitignore as it is, so a re-included file stays as it was", async () => {
    // Rewritten, !db/cmos.sqlite.bak became !db/*.sqlite.bak and re-included every backup.
    const r = repo({
      recordIgnore: `${OLD_SEED}*.bak\n!db/${STORE}.bak\n`,
      files: { [`${OLD}/db/x.sqlite.bak`]: 'x\n', [`${OLD}/db/${STORE}.bak`]: 'kept\n' },
    });
    expect(visibleUnder(r, OLD)).toContain(`${OLD}/db/${STORE}.bak`);
    await expectMoved(r);
    expect(ignoredUnder(r, 'rbook/db')).toContain('rbook/db/x.sqlite.bak');
    expect(visibleUnder(r, 'rbook/db')).toContain(`rbook/db/${STORE}.bak`);
    expect(fs.readFileSync(path.join(r.root, 'rbook/.gitignore'), 'utf8')).toContain(
      `!db/${STORE}.bak\n`
    );
  });
});

describe('the index records the move as git mv does', () => {
  it('renames exactly the tracked entries, with their blobs, and nothing else', async () => {
    const r = repo({
      ignores: { '.gitignore': `${OLD}/db/snapshots/\n${OLD}/jobs/\n` },
      files: {
        [`${OLD}/jobs/resume.pdf`]: 'tracked under an ignored folder\n',
        [`${OLD}/db/snapshots/kept.sqlite`]: 'a tracked snapshot\n',
        [`${OLD}/notes.md`]: 'notes\n',
        'other.txt': 'other\n',
      },
      track: [
        `${OLD}/jobs/resume.pdf`,
        `${OLD}/db/snapshots/kept.sqlite`,
        `${OLD}/db/${STORE}`,
        `${OLD}/notes.md`,
        'other.txt',
      ],
    });
    const blobs = (prefix: string) =>
      Object.fromEntries(
        lines(g(r.top, ['ls-files', '-s', '--', prefix])).map((line) => {
          const [meta, file] = line.split('\t');
          return [file.slice(prefix.length + 1), meta];
        })
      );
    const before = blobs(OLD);
    fs.writeFileSync(path.join(r.top, OLD, 'notes.md'), 'notes, edited and not staged\n');
    fs.writeFileSync(path.join(r.top, 'other.txt'), 'other, staged\n');
    g(r.top, ['add', 'other.txt']);
    const staged = lines(g(r.top, ['ls-files', '-s', '--', 'other.txt']));
    fs.writeFileSync(path.join(r.top, OLD, 'scratch.txt'), 'untracked\n');
    await expectMoved(r);
    const after = blobs('rbook');
    // Every entry keeps its mode and blob, the store under its new name; the record's .gitignore
    // carries migrate's lines; the old folder is gone from the index.
    const { '.gitignore': ignoreBefore, [`db/${STORE}`]: store, ...rest } = before;
    expect(after).toEqual({ ...rest, 'db/rbook.sqlite': store, '.gitignore': expect.any(String) });
    expect(after['.gitignore']).not.toEqual(ignoreBefore);
    expect(g(r.top, ['show', ':rbook/.gitignore'])).toContain('db/snapshots/pre-migrate-*.sqlite');
    expect(lines(g(r.top, ['diff', '--cached', '--name-status', '-M']))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^R100\t/), 'M\tother.txt'])
    );
    // The untracked file stays untracked, the unstaged edit unstaged, the staged change staged.
    expect(indexUnder(r, 'rbook/scratch.txt')).toEqual([]);
    expect(lines(g(r.top, ['diff', '--name-only']))).toContain('rbook/notes.md');
    expect(lines(g(r.top, ['ls-files', '-s', '--', 'other.txt']))).toEqual(staged);
    // The root .gitignore's twins are in its index blob, so restoring it keeps them.
    expect(g(r.top, ['show', ':.gitignore'])).toBe(
      `${OLD}/db/snapshots/\n/rbook/db/snapshots/\n${OLD}/jobs/\n/rbook/jobs/\n`
    );
    g(r.top, ['restore', '.gitignore']);
    expect(read(r, '.gitignore')).toContain('/rbook/jobs/');
  });

  it.each([
    ['git add -A && git commit', ['add-all']],
    ['git commit -a', ['commit-a']],
    ['a plain git commit', ['plain']],
  ])(
    'after the move, %s keeps every tracked file and commits no ignored one',
    async (_how, [form]) => {
      const r = repo({
        ignores: { '.gitignore': `${OLD}/jobs/\n` },
        files: {
          [`${OLD}/jobs/resume.pdf`]: 'tracked\n',
          [`${OLD}/jobs/new.pdf`]: 'ignored\n',
          [`${OLD}/notes.md`]: 'n\n',
        },
        track: [`${OLD}/jobs/resume.pdf`, `${OLD}/notes.md`],
      });
      const tracked = indexUnder(r, OLD).map((file) => moved(r, file));
      await expectMoved(r);
      if (form === 'add-all') g(r.top, ['add', '-A']);
      g(r.top, ['commit', '-q', ...(form === 'commit-a' ? ['-a'] : []), '-m', 'move']);
      const committed = lines(g(r.top, ['ls-tree', '-r', '--name-only', 'HEAD']));
      expect(tracked.filter((file) => !committed.includes(file))).toEqual([]);
      expect(committed.filter((file) => file.startsWith(`${OLD}/`))).toEqual([]);
      expect(committed).not.toContain('rbook/jobs/new.pdf');
      expect(committed).not.toContain('rbook/db/rbook.sqlite');
    }
  );

  it('after a plain commit of the move, stash, restore and reset --hard expose nothing, the ancestors included', async () => {
    const r = repo({
      prefix: 'sub/proj/',
      ignores: {
        '.gitignore': `sub/proj/${OLD}/db/snapshots/\n`,
        'sub/.gitignore': `proj/${OLD}/telemetry/\n`,
        'sub/proj/.gitignore': `${OLD}/jobs/\n`,
      },
      files: {
        [`sub/proj/${OLD}/jobs/cv.pdf`]: 'cv\n',
        [`sub/proj/${OLD}/telemetry/t.json`]: '{}\n',
        [`sub/proj/${OLD}/db/snapshots/s.sqlite`]: 's\n',
      },
    });
    const before = snapshot(r);
    await expectMoved(r);
    for (const file of ['.gitignore', 'sub/.gitignore', 'sub/proj/.gitignore'])
      expect(g(r.top, ['show', `:${file}`])).toContain('rbook/');
    g(r.top, ['commit', '-q', '-m', 'move']);
    for (const step of [
      ['stash'],
      ['stash', 'pop'],
      ['restore', '.'],
      ['reset', '-q', '--hard', 'HEAD'],
    ]) {
      if (step[1] === 'pop' && !lines(g(r.top, ['stash', 'list'])).length) continue;
      g(r.top, step);
      expectKept(r, before);
    }
  });

  it("carries migrate's lines in a tracked record .gitignore's blob, so stash and restore keep the store ignored", async () => {
    const r = repo({ files: { [`${OLD}/notes.md`]: 'n\n' }, track: [`${OLD}/notes.md`] });
    await expectMoved(r);
    g(r.top, ['commit', '-q', '-m', 'move']);
    g(r.top, ['restore', '.']);
    expect(ignoredUnder(r, 'rbook/db')).toEqual(
      expect.arrayContaining(['rbook/db/rbook.sqlite', expect.stringMatching(/pre-migrate-/)])
    );
    fs.writeFileSync(path.join(r.top, 'rbook', 'notes.md'), 'edited\n');
    g(r.top, ['stash']);
    expect(ignoredUnder(r, 'rbook/db')).toContain('rbook/db/rbook.sqlite');
    expect(visibleUnder(r, 'rbook')).toEqual([]);
  });

  it('gives an unmerged root .gitignore no blob twin, and leaves it unmerged', async () => {
    const r = repo({ ignores: { '.gitignore': `${OLD}/db/snapshots/\n` } });
    fs.appendFileSync(path.join(r.top, '.gitignore'), 'mine/\n');
    g(r.top, ['stash']);
    fs.appendFileSync(path.join(r.top, '.gitignore'), 'theirs/\n');
    g(r.top, ['commit', '-qam', 'theirs']);
    childProcess.spawnSync('git', ['stash', 'pop'], { cwd: r.top, env: env() });
    expect(lines(g(r.top, ['ls-files', '-u', '--', '.gitignore'])).length).toBeGreaterThan(1);
    const result = await move(r.root);
    expect(result.success).toBe(true);
    expect(lines(g(r.top, ['ls-files', '-u', '--', '.gitignore'])).length).toBeGreaterThan(1);
    expect(result.data?.left.join('\n')).toContain('keep the /rbook/ lines when you resolve it');
  });

  it.each([
    ['--skip-worktree', 'S'],
    ['--assume-unchanged', 'h'],
  ])('gives a root .gitignore flagged %s no blob twin, and keeps its flag', async (flag, tag) => {
    const r = repo({ ignores: { '.gitignore': `${OLD}/db/snapshots/\n` } });
    g(r.top, ['update-index', flag, '.gitignore']);
    const blob = g(r.top, ['ls-files', '-s', '--', '.gitignore']);
    const result = await move(r.root);
    expect(result.success).toBe(true);
    expect(g(r.top, ['ls-files', '-s', '--', '.gitignore'])).toBe(blob);
    expect(g(r.top, ['ls-files', '-v', '--', '.gitignore'])[0]).toBe(tag);
    expect(result.data?.left.join('\n')).toContain('in the working tree only');
  });

  it('refuses a submodule under the folder before any rename, and its dry run lists it', async () => {
    const r = repo();
    const head = g(r.top, ['rev-parse', 'HEAD']).trim();
    g(r.top, ['update-index', '--add', '--cacheinfo', `160000,${head},${OLD}/vendor/lib`]);
    expect((await move(r.root, false)).data?.blocked).toEqual([
      expect.stringContaining('holds a submodule'),
    ]);
    const result = await move(r.root);
    expect(result.error?.message).toContain('holds a submodule');
    expect(fs.existsSync(path.join(r.root, 'rbook'))).toBe(false);
    expect(guardsLeft(r)).toEqual([]);
  });

  it('refuses a work tree where git cannot run, naming git, and the dry run lists it', async () => {
    const r = repo();
    const spawnSync = childProcess.spawnSync;
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) =>
      command === 'git'
        ? {
            pid: 0,
            output: [],
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            status: null,
            signal: null,
            error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }),
          }
        : spawnSync(command, args, opts)) as any);
    expect((await move(r.root, false)).data?.blocked).toEqual([
      expect.stringContaining('git cannot run'),
    ]);
    const result = await move(r.root);
    expect(result.error?.message).toContain('git cannot run');
    expect(fs.existsSync(path.join(r.root, OLD, 'db', STORE))).toBe(true);
    expect(guardsLeft(r)).toEqual([]);
  });
});

describe('the index step waits, and a retry finishes it', () => {
  const pendingSteps = (r: Repo) =>
    JSON.parse(fs.readFileSync(path.join(r.root, PENDING), 'utf8')) as {
      steps: string[];
      folder: string;
    };

  it.each([
    [
      'a merge in progress',
      (r: Repo) =>
        fs.writeFileSync(path.join(r.top, '.git/MERGE_HEAD'), g(r.top, ['rev-parse', 'HEAD'])),
      (r: Repo) => fs.rmSync(path.join(r.top, '.git/MERGE_HEAD')),
    ],
    [
      'a stale index.lock',
      (r: Repo) => fs.writeFileSync(path.join(r.top, '.git/index.lock'), ''),
      (r: Repo) => fs.rmSync(path.join(r.top, '.git/index.lock')),
    ],
    [
      'a skip-worktree entry',
      (r: Repo) => g(r.top, ['update-index', '--skip-worktree', `${OLD}/notes.md`]),
      (r: Repo) => g(r.top, ['update-index', '--no-skip-worktree', `${OLD}/notes.md`]),
    ],
    [
      'an assume-unchanged entry',
      (r: Repo) => g(r.top, ['update-index', '--assume-unchanged', `${OLD}/notes.md`]),
      (r: Repo) => g(r.top, ['update-index', '--no-assume-unchanged', `${OLD}/notes.md`]),
    ],
    [
      'an intent-to-add entry',
      (r: Repo) => {
        fs.writeFileSync(path.join(r.top, OLD, 'later.md'), 'later\n');
        g(r.top, ['add', '-N', `${OLD}/later.md`]);
      },
      (r: Repo) => g(r.top, ['rm', '-q', '--cached', `${OLD}/later.md`]),
    ],
  ])(
    '%s leaves the follow-up pending, and a later migrate --apply completes it',
    async (_state, arrange, clear) => {
      const r = repo({ files: { [`${OLD}/notes.md`]: 'n\n' }, track: [`${OLD}/notes.md`] });
      arrange(r);
      const result = await move(r.root);
      expect(result.success).toBe(true);
      expect(result.data?.left.join('\n')).toContain("Git's index still lists the record");
      expect(pendingSteps(r).steps).toEqual(['the git index']);
      expect(indexUnder(r, OLD)).toContain(`${OLD}/notes.md`);
      clear(r);
      const retry = await move(r.root);
      expect({ success: retry.success, error: retry.error }).toEqual({
        success: true,
        error: undefined,
      });
      expect(fs.existsSync(path.join(r.root, PENDING))).toBe(false);
      expect(indexUnder(r, OLD)).toEqual([]);
      expect(indexUnder(r, 'rbook')).toContain('rbook/notes.md');
    }
  );

  it('a step cut partway leaves both paths, never neither; the retry finishes without overwriting a staged change', async () => {
    const r = repo({
      files: { [`${OLD}/notes.md`]: 'n\n', [`${OLD}/plan.md`]: 'p\n' },
      track: [`${OLD}/notes.md`, `${OLD}/plan.md`],
    });
    const spawnSync = childProcess.spawnSync;
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) => {
      if (command !== 'git' || args[0] !== 'update-index' || args[1] !== '-z')
        return spawnSync(command, args, opts);
      // The parent dies with half its input applied: additions come first, so both paths remain.
      const input = fs.readFileSync(opts.stdio[0]).toString('utf8').split('\0').filter(Boolean);
      const prefix = input.slice(0, Math.ceil(input.length / 2));
      spawnSync(command, args, { ...opts, stdio: undefined, input: `${prefix.join('\0')}\0` });
      return {
        pid: 0,
        output: [],
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('killed'),
        status: null,
        signal: 'SIGKILL',
      };
    }) as any);
    const cut = await move(r.root);
    jest.restoreAllMocks();
    expect(cut.success).toBe(false);
    expect(indexUnder(r, OLD).sort()).toEqual([
      `${OLD}/.gitignore`,
      `${OLD}/notes.md`,
      `${OLD}/plan.md`,
    ]);
    expect(indexUnder(r, 'rbook').sort()).toEqual([
      'rbook/.gitignore',
      'rbook/notes.md',
      'rbook/plan.md',
    ]);
    expect(fs.existsSync(path.join(r.root, PENDING))).toBe(true);
    // The owner stages a change at a new path before retrying.
    fs.writeFileSync(path.join(r.top, 'rbook', 'notes.md'), 'the owner, staged\n');
    g(r.top, ['add', 'rbook/notes.md']);
    const ownerBlob = g(r.top, ['ls-files', '-s', '--', 'rbook/notes.md']);
    const retry = await move(r.root);
    expect({ success: retry.success, error: retry.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(indexUnder(r, OLD)).toEqual([]);
    expect(g(r.top, ['ls-files', '-s', '--', 'rbook/notes.md'])).toBe(ownerBlob);
    expect(fs.existsSync(path.join(r.root, PENDING))).toBe(false);
  });

  it('a stale lock with registration failing in the same run keeps the marker, and the retry runs the step', async () => {
    const r = repo({ files: { [`${OLD}/notes.md`]: 'n\n' }, track: [`${OLD}/notes.md`] });
    const db = new Database(path.join(r.root, OLD, 'db', STORE));
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_project_id', 'p-1')"
    ).run();
    db.close();
    fs.writeFileSync(path.join(r.top, '.git/index.lock'), '');
    // The dashboard refuses the path update, as a project key might (E1); no request leaves this process.
    jest.spyOn(DashboardClient, 'fromEnvForProject').mockResolvedValue({
      success: false,
      error: { code: 'NO_KEY', message: 'no key for this project' },
    } as any);
    const result = await move(r.root);
    jest.restoreAllMocks();
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Dashboard path update remains pending');
    expect(pendingSteps(r).folder).toBe(OLD);
    fs.rmSync(path.join(r.top, '.git/index.lock'));
    const store = new Database(path.join(r.root, 'rbook/db/rbook.sqlite'));
    store.prepare("DELETE FROM metadata WHERE key = 'dashboard_project_id'").run();
    store.close();
    const retry = await move(r.root);
    expect({ success: retry.success, error: retry.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(indexUnder(r, OLD)).toEqual([]);
    expect(fs.existsSync(path.join(r.root, PENDING))).toBe(false);
  });

  it('a crash between the committed journal and the marker leaves the step to the retry', async () => {
    const r = repo({ files: { [`${OLD}/notes.md`]: 'n\n' }, track: [`${OLD}/notes.md`] });
    const rename = fs.renameSync;
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith(PENDING)) throw new Error('simulated crash before the marker');
      rename(from, to);
    });
    expect((await move(r.root)).success).toBe(false);
    jest.restoreAllMocks();
    expect(fs.existsSync(path.join(r.root, PENDING))).toBe(false);
    const journal = JSON.parse(fs.readFileSync(path.join(r.root, JOURNAL), 'utf8'));
    expect(journal.phase).toBe('committed');
    fs.writeFileSync(path.join(r.root, JOURNAL), JSON.stringify({ ...journal, pid: 2147483647 }));
    const retry = await move(r.root);
    expect({ success: retry.success, error: retry.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(indexUnder(r, OLD)).toEqual([]);
    expect(indexUnder(r, 'rbook')).toContain('rbook/notes.md');
  });

  it('an upper-case folder on a case-insensitive file system moves, and a case mismatch with the index waits', async () => {
    if (!caseInsensitive()) return;
    const upper = repo({
      upper: true,
      ignores: { '.gitignore': `${OLD}/db/snapshots/\n` },
      files: { [`${OLD.toUpperCase()}/notes.md`]: 'n\n' },
      track: [`${OLD.toUpperCase()}/notes.md`],
    });
    await expectMoved(upper);
    expect(read(upper, '.gitignore')).toBe(`${OLD}/db/snapshots/\n/rbook/db/snapshots/\n`);
    fs.rmSync(path.join(tmp, 'repo'), { recursive: true, force: true });
    // The index says cmos/ while the disk says CMOS: the step stays pending, naming the case.
    const r = repo({ files: { [`${OLD}/notes.md`]: 'n\n' }, track: [`${OLD}/notes.md`] });
    fs.renameSync(path.join(r.root, OLD), path.join(r.root, 'case-swap'));
    fs.renameSync(path.join(r.root, 'case-swap'), path.join(r.root, OLD.toUpperCase()));
    const result = await move(r.root);
    expect(result.success).toBe(true);
    expect(result.data?.left.join('\n')).toContain('in another case');
    expect(fs.existsSync(path.join(r.root, PENDING))).toBe(true);
  });
});

describe('build critic B, round 1: what the first build missed', () => {
  /** shared.ignore at the top holds *.tmp; one ignored file sits in the record and one outside it. */
  const sharedSpec = () => ({
    files: { 'shared.ignore': '*.tmp\n', [`${OLD}/a.tmp`]: 'a\n', 'other/b.tmp': 'b\n' },
  });

  it.each([
    [
      'a relative core.excludesFile naming a link stored in the record',
      (r: Repo) => {
        fs.symlinkSync('../shared.ignore', path.join(r.root, OLD, 'link.ignore'));
        g(r.top, ['config', 'core.excludesFile', `${OLD}/link.ignore`]);
      },
    ],
    [
      'an absolute core.excludesFile naming a link stored in the record',
      (r: Repo) => {
        fs.symlinkSync('../shared.ignore', path.join(r.root, OLD, 'link.ignore'));
        g(r.top, ['config', 'core.excludesFile', path.join(r.root, OLD, 'link.ignore')]);
      },
    ],
    [
      'a core.excludesFile reached by .. from the record',
      (r: Repo) => g(r.top, ['config', 'core.excludesFile', `${OLD}/../shared.ignore`]),
    ],
    [
      'an info/exclude linked to a link stored in the record',
      (r: Repo) => {
        fs.symlinkSync('../shared.ignore', path.join(r.root, OLD, 'link.ignore'));
        fs.rmSync(path.join(r.top, '.git/info/exclude'), { force: true });
        fs.symlinkSync(`../../${OLD}/link.ignore`, path.join(r.top, '.git/info/exclude'));
      },
    ],
    [
      'a folder link in the record that core.excludesFile goes through',
      (r: Repo) => {
        fs.mkdirSync(path.join(r.top, 'conf'));
        fs.copyFileSync(path.join(r.top, 'shared.ignore'), path.join(r.top, 'conf', 'x.ignore'));
        fs.symlinkSync('../conf', path.join(r.root, OLD, 'conf'));
        g(r.top, ['config', 'core.excludesFile', `${OLD}/conf/x.ignore`]);
      },
    ],
    [
      'a config file the repository includes from the record',
      (r: Repo) => {
        fs.writeFileSync(
          path.join(r.root, OLD, 'git.config'),
          `[core]\n\texcludesFile = ${path.join(r.top, 'shared.ignore')}\n`
        );
        g(r.top, ['config', 'include.path', `../${OLD}/git.config`]);
      },
    ],
  ])('refuses an ignore source reached through the record: %s (B1)', async (_shape, arrange) => {
    const r = repo(sharedSpec());
    arrange(r);
    expect(ignoredUnder(r, 'other')).toEqual(['other/b.tmp']);
    expect((await move(r.root, false)).data?.blocked).toEqual([
      expect.stringContaining('record folder'),
    ]);
    const result = await move(r.root);
    expect(result.error?.message).toContain('record folder');
    expect(ignoredUnder(r, 'other')).toEqual(['other/b.tmp']);
    expect(fs.existsSync(path.join(r.root, 'rbook'))).toBe(false);
  });

  it("refuses git's default excludes file inside the record, as an XDG_CONFIG_HOME there makes it", async () => {
    const r = repo(sharedSpec());
    fs.mkdirSync(path.join(r.root, OLD, 'xdg', 'git'), { recursive: true });
    fs.copyFileSync(
      path.join(r.top, 'shared.ignore'),
      path.join(r.root, OLD, 'xdg', 'git', 'ignore')
    );
    const result = await migrateProject({
      projectRoot: r.root,
      env: { ...env(), XDG_CONFIG_HOME: path.join(r.root, OLD, 'xdg') },
      apply: true,
      checkProcesses: false,
    });
    expect(result.error?.message).toContain('inside the record folder');
  });

  it('refuses a core.excludesFile that names a file only the move creates, under rbook/ (note 8)', async () => {
    const r = repo({ files: { [`${OLD}/local.ignore`]: '*.draft\n', 'other/plan.draft': 'p\n' } });
    g(r.top, ['config', 'core.excludesFile', 'rbook/local.ignore']);
    expect(visibleUnder(r, 'other')).toEqual(['other/plan.draft']);
    const result = await move(r.root);
    expect(result.error?.message).toContain('the move creates');
    expect(visibleUnder(r, 'other')).toEqual(['other/plan.draft']);
  });

  it('waits, naming them, when the index already holds entries at the new name on the run that moves (note 1)', async () => {
    const r = repo({
      files: { rbook: 'a file once named rbook\n', [`${OLD}/notes.md`]: 'n\n' },
      track: ['rbook', `${OLD}/notes.md`],
    });
    fs.rmSync(path.join(r.top, 'rbook'));
    const result = await move(r.root);
    expect(result.success).toBe(true);
    expect(result.data?.left.join('\n')).toContain(
      "already held 1 entry at the new folder's name before the move"
    );
    // Nothing outside the move was staged: the deleted file is not staged as deleted.
    expect(lines(g(r.top, ['diff', '--cached', '--name-status']))).toEqual([]);
    g(r.top, ['rm', '-q', '--cached', 'rbook']);
    const retry = await move(r.root);
    expect({ success: retry.success, error: retry.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(indexUnder(r, 'rbook')).toContain('rbook/notes.md');
    expect(fs.existsSync(path.join(r.root, PENDING))).toBe(false);
  });

  it('twins a line in a non-ASCII folder above the record, and a first line after a byte-order mark (note 2)', async () => {
    const r = repo({
      prefix: 'é/proj/',
      ignores: {
        '.gitignore': `é/proj/${OLD}/jobs/\n`,
        'é/proj/.gitignore': `\uFEFF${OLD}/cache/\n`,
      },
      files: { [`é/proj/${OLD}/jobs/cv.pdf`]: 'cv\n', [`é/proj/${OLD}/cache/c.bin`]: 'c\n' },
    });
    // A line naming the folder in info/exclude, which migrate does not edit, is named in left; it
    // names a file that is not there, so the backstop has nothing to refuse (round-2 verifier B,
    // notes 6 and 7).
    fs.appendFileSync(path.join(r.top, '.git/info/exclude'), `é/proj/${OLD}/not-there/\n`);
    const dry = await move(r.root, false);
    expect(dry.data?.twins).toEqual(
      expect.arrayContaining([`${path.join(r.top, '.gitignore')}: /é/proj/rbook/jobs/`])
    );
    expect(dry.data?.left.join('\n')).toContain(`(é/proj/${OLD}/not-there/)`);
    await expectMoved(r);
    expect(read(r, '.gitignore')).toBe(`é/proj/${OLD}/jobs/\n/é/proj/rbook/jobs/\n`);
    expect(read(r, 'é/proj/.gitignore')).toBe(`\uFEFF${OLD}/cache/\n/rbook/cache/\n`);
  });

  it('adds a twin right after its line, whatever stands elsewhere in the file, so rules keep their order (note 3)', async () => {
    const r = repo({
      ignores: { '.gitignore': `!/rbook/keep.log\n${OLD}/*.log\n!${OLD}/keep.log\n` },
      files: { [`${OLD}/keep.log`]: 'k\n', [`${OLD}/run.log`]: 'r\n' },
    });
    expect(visibleUnder(r, OLD)).toContain(`${OLD}/keep.log`);
    await expectMoved(r);
    expect(visibleUnder(r, 'rbook')).toContain('rbook/keep.log');
    expect(ignoredUnder(r, 'rbook')).toContain('rbook/run.log');
  });

  it("compares every .gitignore before writing any twin, so an owner's edit refuses with none written (note 4)", async () => {
    const r = repo({
      prefix: 'sub/proj/',
      ignores: { '.gitignore': `sub/proj/${OLD}/x/\n`, 'sub/proj/.gitignore': `${OLD}/y/\n` },
    });
    const seams = { ...cutoverSeams };
    // The owner edits the top .gitignore after migrate planned and before it writes the twins.
    cutoverSeams.beforeFinalCheck = () =>
      fs.appendFileSync(path.join(r.top, '.gitignore'), 'owner-edit/\n');
    try {
      const result = await move(r.root);
      expect(result.error?.message).toContain('changed while migrate was moving the record');
    } finally {
      Object.assign(cutoverSeams, seams);
    }
    expect(read(r, 'sub/proj/.gitignore')).toBe(`${OLD}/y/\n`);
    expect(read(r, '.gitignore')).toBe(`sub/proj/${OLD}/x/\nowner-edit/\n`);
  });

  it("names the snapshots git sees now that migrate's db/snapshots/ line will ignore (note 5)", async () => {
    const r = repo({ files: { [`${OLD}/db/snapshots/s1.sqlite`]: 's\n' } });
    expect(visibleUnder(r, OLD)).toContain(`${OLD}/db/snapshots/s1.sqlite`);
    const result = await expectMoved(r);
    expect(result.data?.left.join('\n')).toContain(`become ignored: ${OLD}/db/snapshots/s1.sqlite`);
  });

  it('a retry of a move an older release made writes the twins into the working tree too (note 6)', async () => {
    const r = repo({
      ignores: { '.gitignore': `${OLD}/jobs/\n` },
      files: { [`${OLD}/notes.md`]: 'n\n' },
      track: [`${OLD}/notes.md`],
    });
    // 4.10.0's move: both renames, no twins, and its marker.
    fs.renameSync(path.join(r.root, OLD), path.join(r.root, 'rbook'));
    fs.renameSync(path.join(r.root, 'rbook/db', STORE), path.join(r.root, 'rbook/db/rbook.sqlite'));
    fs.mkdirSync(path.join(r.root, 'rbook/jobs'));
    fs.writeFileSync(path.join(r.root, 'rbook/jobs/new.pdf'), 'cv\n');
    fs.writeFileSync(
      path.join(r.root, PENDING),
      JSON.stringify({ remaining: 'documents and registration' })
    );
    expect(visibleUnder(r, 'rbook')).toContain('rbook/jobs/new.pdf');
    const retry = await move(r.root);
    expect({ success: retry.success, error: retry.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(read(r, '.gitignore')).toBe(`${OLD}/jobs/\n/rbook/jobs/\n`);
    expect(g(r.top, ['show', ':.gitignore'])).toBe(`${OLD}/jobs/\n/rbook/jobs/\n`);
    expect(ignoredUnder(r, 'rbook')).toContain('rbook/jobs/new.pdf');
    expect(indexUnder(r, 'rbook')).toContain('rbook/notes.md');
  });

  it('leaves the step pending for an unmerged entry under the folder, which it never resolves (note 10)', async () => {
    const r = repo({ files: { [`${OLD}/notes.md`]: 'base\n' }, track: [`${OLD}/notes.md`] });
    fs.writeFileSync(path.join(r.root, OLD, 'notes.md'), 'mine\n');
    g(r.top, ['stash']);
    fs.writeFileSync(path.join(r.root, OLD, 'notes.md'), 'theirs\n');
    g(r.top, ['commit', '-qam', 'theirs']);
    childProcess.spawnSync('git', ['stash', 'pop'], { cwd: r.top, env: env() });
    expect(lines(g(r.top, ['ls-files', '-u', '--', `${OLD}/notes.md`])).length).toBe(3);
    const result = await move(r.root);
    expect(result.data?.left.join('\n')).toContain('has a merge conflict');
    expect(lines(g(r.top, ['ls-files', '-u', '--', `${OLD}/notes.md`])).length).toBe(3);
    expect(fs.existsSync(path.join(r.root, PENDING))).toBe(true);
  });

  it.each([
    ['a rebase', 'rebase-merge', 'dir'],
    ['a rebase or am', 'rebase-apply', 'dir'],
    ['a cherry-pick', 'CHERRY_PICK_HEAD', 'file'],
    ['a revert', 'REVERT_HEAD', 'file'],
    ['a bisect', 'BISECT_LOG', 'file'],
  ])('leaves the step pending while %s is in progress (note 10)', async (what, name, kind) => {
    const r = repo({ files: { [`${OLD}/notes.md`]: 'n\n' }, track: [`${OLD}/notes.md`] });
    const state = path.join(r.top, '.git', name);
    if (kind === 'dir') fs.mkdirSync(state);
    else fs.writeFileSync(state, `${g(r.top, ['rev-parse', 'HEAD'])}`);
    const result = await move(r.root);
    expect(result.data?.left.join('\n')).toContain(`${what} is in progress`);
    expect(indexUnder(r, OLD)).toContain(`${OLD}/notes.md`);
  });

  it('renames only the project in a path with glob characters, and not a sibling they would match (note 10)', async () => {
    // A tracked file p1zx/cmos is what p[1]*x/cmos matches as a glob (round-2 verifier B, note 10).
    const r = repo({
      prefix: 'p[1]*x/',
      files: {
        [`p[1]*x/${OLD}/notes.md`]: 'n\n',
        [`p1zx/${OLD}`]: 'a file named like the folder\n',
      },
      track: [`p[1]*x/${OLD}/notes.md`, `p1zx/${OLD}`],
    });
    await expectMoved(r);
    expect(lines(g(r.top, ['--literal-pathspecs', 'ls-files', '--', `p1zx/${OLD}`]))).toEqual([
      `p1zx/${OLD}`,
    ]);
    expect(lines(g(r.top, ['diff', '--cached', '--name-status', '--', `p1zx/${OLD}`]))).toEqual([]);
  });

  it("keeps a symlinked record .gitignore's index entry as it is, saying its lines are in the working tree only (note 10)", async () => {
    const r = repo({
      recordIgnore: null,
      files: { 'record.ignore': `db/${STORE}\n`, [`${OLD}/notes.md`]: 'n\n' },
      track: [`${OLD}/notes.md`, 'record.ignore'],
    });
    fs.symlinkSync('../record.ignore', path.join(r.root, OLD, '.gitignore'));
    g(r.top, ['add', `${OLD}/.gitignore`]);
    g(r.top, ['commit', '-qm', 'link']);
    const entry = g(r.top, ['ls-files', '-s', '--', `${OLD}/.gitignore`]).split('\t')[0];
    const result = await move(r.root);
    expect(result.success).toBe(true);
    expect(g(r.top, ['ls-files', '-s', '--', 'rbook/.gitignore']).split('\t')[0]).toBe(entry);
    expect(result.data?.left.join('\n')).toContain('working tree only (mode 120000)');
    expect(read(r, 'record.ignore')).toBe(`db/${STORE}\n`);
  });
});

describe("round-2 verifier A's notes: git's view of a backup", () => {
  it('gitSees says whether git sees an untracked file, and nothing outside a work tree', () => {
    const r = repo({
      ignores: { '.gitignore': 'hidden/\n' },
      files: { 'hidden/a.sqlite': 'h\n', 'seen/b.sqlite': 's\n' },
    });
    expect(gitSees(r.root, path.join(r.top, 'seen', 'b.sqlite'), env())).toBe(true);
    expect(gitSees(r.root, path.join(r.top, 'hidden', 'a.sqlite'), env())).toBe(false);
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'c.sqlite'), 'c\n');
    expect(gitSees(plain, path.join(plain, 'c.sqlite'), env())).toBe(false);
  });
});

describe('round-2 verifier B: the twins are written whole', () => {
  it('a twin write that fails keeps its own cause, and names a file it could not put back (round 3, note 2)', async () => {
    const r = repo({
      prefix: 'sub/proj/',
      ignores: { '.gitignore': `sub/proj/${OLD}/y/\n`, 'sub/proj/.gitignore': `${OLD}/x/\n` },
    });
    const write = fs.writeFileSync;
    jest.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, data: any, options: any) => {
      if (path.dirname(String(file)) === r.top && String(file).includes('.gitignore')) {
        // The owner saves the project's .gitignore after migrate twinned it.
        fs.appendFileSync(path.join(r.top, 'sub/proj/.gitignore'), 'saved.log\n');
        throw Object.assign(new Error('simulated: permission denied'), { code: 'EACCES' });
      }
      return write(file, data, options);
    }) as any);
    const result = await move(r.root);
    jest.restoreAllMocks();
    expect(result.error?.message).toContain('simulated: permission denied');
    expect(result.error?.message).toContain(
      `${path.join(r.top, 'sub/proj/.gitignore')} changed after migrate added its rbook/ lines`
    );
  });

  it('a twin write that fails puts back the .gitignore files written before it (note 3)', async () => {
    const r = repo({
      prefix: 'sub/proj/',
      ignores: { '.gitignore': `sub/proj/${OLD}/y/\n`, 'sub/proj/.gitignore': `${OLD}/x/\n` },
    });
    const write = fs.writeFileSync;
    // The root's write fails, after the project's own .gitignore was written.
    jest.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, data: any, options: any) => {
      if (path.dirname(String(file)) === r.top && String(file).includes('.gitignore'))
        throw Object.assign(new Error('simulated: permission denied'), { code: 'EACCES' });
      return write(file, data, options);
    }) as any);
    const result = await move(r.root);
    jest.restoreAllMocks();
    expect(result.error?.message).toContain('simulated: permission denied');
    expect(read(r, 'sub/proj/.gitignore')).toBe(`${OLD}/x/\n`);
    expect(read(r, '.gitignore')).toBe(`sub/proj/${OLD}/y/\n`);
  });

  it('a write cut short leaves the .gitignore as it was, never empty (B2)', async () => {
    const rootIgnore = `${OLD}/db/snapshots/\nkeys.secret\n`;
    const r = repo({ ignores: { '.gitignore': rootIgnore }, files: { 'keys.secret': 'k\n' } });
    // The process dies after the file it writes was truncated and before its bytes land. Only the
    // root's writes are cut: the record's own .gitignore, written first, is journalled.
    const write = fs.writeFileSync;
    jest.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, data: any, options: any) => {
      if (
        path.dirname(String(file)) === r.top &&
        path.basename(String(file)).startsWith('.gitignore')
      ) {
        write(file, '');
        throw new Error('simulated: killed mid-write');
      }
      return write(file, data, options);
    }) as any);
    const result = await move(r.root);
    jest.restoreAllMocks();
    expect(result.success).toBe(false);
    expect(read(r, '.gitignore')).toBe(rootIgnore);
    expect(ignoredUnder(r, 'keys.secret')).toEqual(['keys.secret']);
  });

  it('a retry where git cannot run leaves the index step pending, and finishes its other follow-ups', async () => {
    // Settled item 9: git that cannot run is a pending state, never a refusal of the retry.
    const r = repo({ files: { [`${OLD}/notes.md`]: 'n\n' }, track: [`${OLD}/notes.md`] });
    fs.renameSync(path.join(r.root, OLD), path.join(r.root, 'rbook'));
    fs.renameSync(path.join(r.root, 'rbook/db', STORE), path.join(r.root, 'rbook/db/rbook.sqlite'));
    fs.writeFileSync(
      path.join(r.root, PENDING),
      JSON.stringify({ remaining: 'documents and registration' })
    );
    const spawnSync = childProcess.spawnSync;
    jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
      command: string,
      args: string[],
      opts: any
    ) =>
      command === 'git'
        ? {
            pid: 0,
            output: [],
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            status: null,
            signal: null,
            error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }),
          }
        : spawnSync(command, args, opts)) as any);
    const retry = await move(r.root);
    jest.restoreAllMocks();
    expect({ success: retry.success, error: retry.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(retry.data?.left.join('\n')).toContain('git cannot run');
    expect(retry.data?.left.join('\n')).toContain(
      'do not commit with git add -A or git commit -a: either would commit files under rbook/'
    );
    expect(JSON.parse(fs.readFileSync(path.join(r.root, PENDING), 'utf8')).steps).toEqual([
      'the ignore rules',
      'the git index',
    ]);
  });
});
