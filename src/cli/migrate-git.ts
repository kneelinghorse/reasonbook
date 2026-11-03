// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Runs git for migrate without a shell, and finds the work tree a project's record folder sits in.
// ABOUTME: A git that cannot run inside a work tree is an error to report; none turns a step off quietly.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { LEGACY } from '../intelligence/legacy-compat';

/** The variables that point git at another repository; migrate's git reads the folder it runs in. */
const LOCATION = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
];

/**
 * The environment migrate's git runs in: the live one, so its config and default excludes file are
 * the repository's own (round 8, note 2), less any variable naming another repository. With no PATH,
 * as in a test's environment, git is found on this process's PATH.
 */
export function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of LOCATION) delete out[name];
  if (out.PATH === undefined && process.env.PATH !== undefined) out.PATH = process.env.PATH;
  return out;
}

export interface GitRun {
  readonly status: number | null;
  /** Decoded as latin1, so a file's bytes pass through unchanged. */
  readonly stdout: string;
  readonly stderr: string;
}

/** git's answer, or a thrown error naming git when it cannot run at all. */
export function runGit(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input?: string | Buffer | number
): GitRun {
  const result = spawnSync('git', [...args], {
    cwd,
    env,
    maxBuffer: 1 << 30,
    ...(typeof input === 'number'
      ? { stdio: [input, 'pipe', 'pipe'] }
      : input !== undefined
        ? { input }
        : {}),
  });
  if (result.error)
    throw new Error(`git cannot run here (${result.error.message}); install git or fix PATH.`);
  return {
    status: result.status,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout.toString('latin1') : '',
    stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : '',
  };
}

/** git's stdout when it succeeds; any other exit is an error naming the command and git's words. */
export function git(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  input?: string | Buffer | number,
  okStatuses: readonly number[] = [0]
): string {
  const run = runGit(cwd, args, env, input);
  if (run.status === null || !okStatuses.includes(run.status))
    throw new Error(
      `git ${args[0]} failed in ${cwd}: ${run.stderr.trim().split('\n')[0] || `exit ${run.status}`}`
    );
  return run.stdout;
}

/** NUL-separated output, as paths: git writes them as UTF-8, which every macOS name is. */
export const nulPaths = (out: string): string[] =>
  Buffer.from(out, 'latin1').toString('utf8').split('\0').filter(Boolean);

export interface GitContext {
  /** The work tree's top level, as git names it. */
  readonly top: string;
  /** The project root relative to the top level, with a trailing slash, or ''. */
  readonly prefix: string;
  /** The effective core.ignorecase: unset is false (round 8, note 3). */
  readonly ignorecase: boolean;
  readonly env: NodeJS.ProcessEnv;
}

/** The nearest folder at or above root that holds a .git entry, as git looks for one. */
export function gitMarker(root: string): string | null {
  for (let folder = path.resolve(root); ; folder = path.dirname(folder)) {
    if (fs.lstatSync(path.join(folder, '.git'), { throwIfNoEntry: false })) return folder;
    if (path.dirname(folder) === folder) return null;
  }
}

/**
 * The work tree a project sits in, or null when none holds it. A .git entry at the root or above
 * means git must answer: a git that cannot run there refuses (s109-m01, settled item 8). Only git's
 * own "not a git repository" reads as no work tree, which nothing in it can then expose.
 */
export function gitContext(root: string, env: NodeJS.ProcessEnv): GitContext | null {
  if (!gitMarker(root)) return null;
  const environment = gitEnvironment(env);
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree'], environment);
  if (inside.status !== 0) {
    if (/not a git repository/i.test(inside.stderr)) return null;
    throw new Error(
      `git cannot read the repository holding ${root}: ${inside.stderr.trim().split('\n')[0]}`
    );
  }
  if (inside.stdout.trim() !== 'true') return null;
  const top = Buffer.from(
    git(root, ['rev-parse', '--show-toplevel'], environment).trim(),
    'latin1'
  ).toString('utf8');
  const prefix = Buffer.from(
    git(root, ['rev-parse', '--show-prefix'], environment).trim(),
    'latin1'
  ).toString('utf8');
  const ignorecase =
    git(top, ['config', '--bool', '--get', 'core.ignorecase'], environment, undefined, [0, 1])
      .trim()
      .toLowerCase() === 'true';
  return { top, prefix, ignorecase, env: environment };
}

/**
 * The old record folder's spelling on disk, which git is given as it is: an upper-case CMOS under
 * core.ignorecase is found that way (A3, note 2).
 */
export function folderOnDisk(root: string): string {
  const names = fs.readdirSync(root);
  return names.includes(LEGACY.recordDirectory)
    ? LEGACY.recordDirectory
    : (names.find((name) => name.toLowerCase() === LEGACY.recordDirectory) ??
        LEGACY.recordDirectory);
}

/** A path under git's directory, as git resolves it for this work tree (linked worktrees too). */
export function gitPath(context: GitContext, name: string): string {
  return path.resolve(
    context.top,
    Buffer.from(
      git(context.top, ['rev-parse', '--git-path', name], context.env).trim(),
      'latin1'
    ).toString('utf8')
  );
}

/** A pathspec that matches only the path it names. */
export const literal = (spec: string) => `:(literal)${spec}`;

export interface IndexEntry {
  readonly mode: string;
  readonly sha: string;
  readonly stage: string;
  readonly path: string;
}

/** git ls-files -s -z entries. */
export function stagedEntries(context: GitContext, spec: string): IndexEntry[] {
  return nulPaths(
    git(context.top, ['ls-files', '-s', '-z', '--full-name', '--', spec], context.env)
  ).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, sha, stage] = line.slice(0, tab).split(' ');
    return { mode, sha, stage, path: line.slice(tab + 1) };
  });
}

/**
 * Whether git sees an untracked file under a project: false outside a work tree, and true when git
 * cannot answer, so a warning is given rather than dropped. check-ignore takes paths, from the cwd.
 */
export function gitSees(root: string, file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (!gitContext(root, env)) return false;
    const answer = runGit(
      root,
      ['check-ignore', '-q', '--', path.relative(root, file)],
      gitEnvironment(env)
    );
    return answer.status !== 0;
  } catch {
    return true;
  }
}
