// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Single fail-loud private-evidence scope for tests that are also copied to the public mirror.
// ABOUTME: Derives exclusions from the mirror script and identity from Git tracked state; never duplicates lists.

/**
 * `scripts/mirror-to-public.sh` mirrors `tests/` but removes its `PRIVATE_PATHS` and
 * `DOCS_EXCLUDES`. A test that needs one of those inputs therefore has two honest outcomes: run in
 * a complete private checkout, or print its reason and register a skipped scope in the structural
 * public mirror. Any missing evidence in a non-mirror checkout is a real defect and throws while
 * the test module is being declared.
 *
 * Exclusion and identity are deliberately separate. `all` remains the leak/removal authority;
 * identity comes from excluded paths tracked in the checkout's HEAD or index. Runtime-created,
 * untracked directory containers therefore cannot impersonate private source evidence.
 *
 * The shell file is parsed as a deliberately small literal-array language. It is never sourced or
 * evaluated: expanding that language silently would turn executable shell into test input.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { describe as jestDescribe, it as jestIt } from '@jest/globals';

const DEFAULT_REPO_ROOT = path.resolve(__dirname, '../..');
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._/-]+$/;
const SAFE_REVISION = /^[A-Za-z0-9][A-Za-z0-9._~^/-]*$/;

type StringMap = Readonly<Record<string, string>>;
type ResolvedMap<T extends StringMap> = { readonly [K in keyof T]: string };

export interface MirrorExclusions {
  readonly privatePaths: readonly string[];
  readonly docsExcludes: readonly string[];
  readonly all: readonly string[];
}

export interface PrivateEvidenceOptions<
  Paths extends StringMap = Record<string, never>,
  Revisions extends StringMap = Record<string, never>,
> {
  readonly reason: string;
  readonly paths?: Paths;
  readonly revisions?: Revisions;
}

export interface PrivateEvidence<Paths extends StringMap, Revisions extends StringMap> {
  readonly relativePaths: Paths;
  readonly paths: ResolvedMap<Paths>;
  readonly revisions: ResolvedMap<Revisions>;
  readonly availableRelativePaths: readonly string[];
  readonly isPublicMirror: boolean;
  describe(name: string, body: () => void): void;
}

function finishToken(tokens: string[], token: string, arrayName: string): string {
  if (token.length === 0) return '';
  if (!SAFE_RELATIVE_PATH.test(token)) {
    throw new Error(
      `${arrayName} contains unsupported shell syntax or path characters in ${JSON.stringify(token)}`
    );
  }
  if (path.posix.isAbsolute(token)) {
    throw new Error(`${arrayName} contains an absolute path: ${token}`);
  }
  const segments = token.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`${arrayName} contains a non-normal path: ${token}`);
  }
  if (path.posix.normalize(token) !== token) {
    throw new Error(`${arrayName} contains a non-normal path: ${token}`);
  }
  tokens.push(token);
  return '';
}

/** Parse one literal shell array without executing the shell source. */
function parseLiteralShellArray(source: string, arrayName: string): string[] {
  const assignment = new RegExp(`^[ \\t]*${arrayName}[ \\t]*=[ \\t]*\\(`, 'gm');
  const matches = [...source.matchAll(assignment)];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${arrayName}=(...) assignment; found ${matches.length}`);
  }

  const match = matches[0];
  const start = (match.index ?? 0) + match[0].length;
  const tokens: string[] = [];
  let token = '';
  let quote: "'" | '"' | null = null;
  let inComment = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (inComment) {
      if (char === '\n') inComment = false;
      continue;
    }
    if (quote !== null) {
      if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      if (token.length > 0) {
        throw new Error(
          `${arrayName} uses adjacent quoted/unquoted token syntax, which is unsupported`
        );
      }
      quote = char;
      continue;
    }
    if (char === '#' && token.length === 0) {
      inComment = true;
      continue;
    }
    if (char === ')') {
      token = finishToken(tokens, token, arrayName);
      const remainder = source.slice(
        index + 1,
        source.indexOf('\n', index + 1) < 0 ? undefined : source.indexOf('\n', index + 1)
      );
      if (!/^[ \\t]*(?:#.*)?$/.test(remainder)) {
        throw new Error(`${arrayName} has unsupported content after its closing parenthesis`);
      }
      if (tokens.length === 0) throw new Error(`${arrayName} must not be empty`);
      if (new Set(tokens).size !== tokens.length) {
        throw new Error(`${arrayName} contains duplicate paths`);
      }
      return tokens;
    }
    if (/\s/.test(char)) {
      token = finishToken(tokens, token, arrayName);
      continue;
    }
    if (char === '(') {
      throw new Error(`${arrayName} contains nested or dynamic parenthesis syntax`);
    }
    token += char;
  }

  if (quote !== null) throw new Error(`${arrayName} contains an unclosed quote`);
  throw new Error(`${arrayName} has no closing parenthesis`);
}

/** Derive the two authoritative removal sets from the mirror implementation. */
export function parseMirrorExclusions(source: string): MirrorExclusions {
  const privatePaths = parseLiteralShellArray(source, 'PRIVATE_PATHS');
  const docsExcludes = parseLiteralShellArray(source, 'DOCS_EXCLUDES');
  const all = [...privatePaths, ...docsExcludes];
  if (new Set(all).size !== all.length) {
    throw new Error('PRIVATE_PATHS and DOCS_EXCLUDES overlap; every exclusion needs one owner');
  }
  return { privatePaths, docsExcludes, all };
}

export function readMirrorExclusions(repoRoot = DEFAULT_REPO_ROOT): MirrorExclusions {
  const scriptPath = path.join(repoRoot, 'scripts', 'mirror-to-public.sh');
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Mirror implementation not found at ${scriptPath}`);
  }
  return parseMirrorExclusions(fs.readFileSync(scriptPath, 'utf8'));
}

export function isMirrorExcluded(relativePath: string, exclusions: MirrorExclusions): boolean {
  const normalized = relativePath.split(path.sep).join('/');
  return exclusions.all.some(
    (excluded) => normalized === excluded || normalized.startsWith(`${excluded}/`)
  );
}

function mapValues<Input extends StringMap>(
  input: Input,
  mapper: (value: string, key: string) => string
): ResolvedMap<Input> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, mapper(value, key)])
  ) as ResolvedMap<Input>;
}

function resolveRevision(repoRoot: string, revision: string): string | null {
  if (!SAFE_REVISION.test(revision) || revision.startsWith('-')) {
    throw new Error(`Unsupported git revision syntax: ${JSON.stringify(revision)}`);
  }
  try {
    const resolved = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

/** s106-m05 (#1738): the excluded tree's listing passed execFileSync's 1 MiB default; the mirror uses 64 MiB. */
const GIT_LISTING_BUFFER = 64 * 1024 * 1024;

function splitNullTerminated(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

/** Return concise exclusion roots represented in the checkout's committed or staged tree. */
function trackedMirrorMarkers(repoRoot: string, exclusions: MirrorExclusions): string[] {
  try {
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (fs.realpathSync(gitRoot) !== fs.realpathSync(repoRoot)) {
      throw new Error(`git root ${gitRoot} does not equal requested repository root ${repoRoot}`);
    }
    const pathspec = ['--', ...exclusions.all];
    const indexed = splitNullTerminated(
      execFileSync('git', ['ls-files', '-z', '--cached', ...pathspec], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: GIT_LISTING_BUFFER,
      })
    );
    const committed = splitNullTerminated(
      execFileSync('git', ['ls-tree', '-rz', '--name-only', 'HEAD', ...pathspec], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: GIT_LISTING_BUFFER,
      })
    );
    const tracked = new Set([...indexed, ...committed]);
    return exclusions.all.filter((excluded) =>
      [...tracked].some((file) => file === excluded || file.startsWith(`${excluded}/`))
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Private-evidence routing could not run git ls-files --cached and git ls-tree HEAD in ` +
        `${repoRoot}. Run tests from a Git checkout whose root matches repoRoot. ${detail}`
    );
  }
}

/**
 * Declare a test scope whose evidence exists only in the private source checkout.
 *
 * `repoRoot` is injectable solely so the contract suite can force private-missing and genuine-
 * mirror states without moving real project files. Normal callers must omit it.
 */
export function requiresPrivateEvidence<
  const Paths extends StringMap = Record<string, never>,
  const Revisions extends StringMap = Record<string, never>,
>(
  options: PrivateEvidenceOptions<Paths, Revisions>,
  repoRoot = DEFAULT_REPO_ROOT
): PrivateEvidence<Paths, Revisions> {
  const reason = options.reason.trim();
  if (reason.length === 0) throw new Error('Private evidence requires a printed reason');

  const relativePaths = (options.paths ?? {}) as Paths;
  const requestedRevisions = (options.revisions ?? {}) as Revisions;
  if (Object.keys(relativePaths).length + Object.keys(requestedRevisions).length === 0) {
    throw new Error('Private evidence requires at least one path or git revision');
  }

  const root = path.resolve(repoRoot);
  const exclusions = readMirrorExclusions(root);
  for (const [key, relativePath] of Object.entries(relativePaths)) {
    const segments = relativePath.split('/');
    if (
      !SAFE_RELATIVE_PATH.test(relativePath) ||
      path.posix.isAbsolute(relativePath) ||
      path.posix.normalize(relativePath) !== relativePath ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      throw new Error(`Private evidence path ${key} is not a safe relative path: ${relativePath}`);
    }
    if (!isMirrorExcluded(relativePath, exclusions)) {
      throw new Error(
        `Private evidence path ${key}=${relativePath} is not removed by mirror-to-public.sh`
      );
    }
  }

  const paths = mapValues(relativePaths, (relativePath) => path.resolve(root, relativePath));
  const availableRelativePaths = Object.entries(paths)
    .filter(([, absolutePath]) => fs.existsSync(absolutePath))
    .map(([key]) => relativePaths[key]);
  const presentMirrorMarkers = trackedMirrorMarkers(root, exclusions);
  const isPublicMirror = presentMirrorMarkers.length === 0;

  const missingPaths = Object.entries(paths)
    .filter(([, absolutePath]) => !fs.existsSync(absolutePath))
    .map(([key]) => `${key}=${relativePaths[key]}`);
  const resolvedRevisionEntries = Object.entries(requestedRevisions).map(
    ([key, revision]) => [key, resolveRevision(root, revision)] as const
  );
  const missingRevisions = resolvedRevisionEntries
    .filter(([, resolved]) => resolved === null)
    .map(([key]) => `${key}=${requestedRevisions[key]}`);
  const missing = [...missingPaths, ...missingRevisions];

  if (missing.length > 0 && !isPublicMirror) {
    throw new Error(
      `Private evidence is missing outside the structural public mirror: ${missing.join(', ')}. ` +
        `Tracked excluded roots in HEAD/index: ${presentMirrorMarkers.join(', ') || '(none)'}. ` +
        reason
    );
  }

  const revisions = Object.fromEntries(
    resolvedRevisionEntries
      .filter((entry): entry is readonly [string, string] => entry[1] !== null)
      .map(([key, resolved]) => [key, resolved])
  ) as ResolvedMap<Revisions>;
  const skip = missing.length > 0 && isPublicMirror;
  if (skip) {
    process.stderr.write(
      `[public mirror] SKIP private evidence: ${reason} Missing: ${missing.join(', ')}. ` +
        'Exclusions came from scripts/mirror-to-public.sh and none are tracked in HEAD/index.\n'
    );
  }

  return {
    relativePaths,
    paths,
    revisions,
    availableRelativePaths,
    isPublicMirror,
    describe(name: string, body: () => void): void {
      if (!skip) {
        jestDescribe(name, body);
        return;
      }
      // `describe.skip(name, body)` still invokes body while Jest builds the test tree. Supply our
      // own safe body so declaration-time private reads cannot escape the scope.
      jestDescribe.skip(`${name} [public mirror]`, () => {
        jestIt.skip(`PUBLIC MIRROR — ${reason}`, () => undefined);
      });
    },
  };
}
