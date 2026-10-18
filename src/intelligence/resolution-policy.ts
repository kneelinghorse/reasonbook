// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m01 — the shared rules behind "which project is this call about": the cwd walk-up,
// ABOUTME: the narrow contextless test, the per-server --project-root, and the ephemeral-path test.

/**
 * Resolution policy (s92-m01).
 *
 * Both resolvers — `resolveSenderContext` (dispatch) and the deprecated
 * `resolveProjectRootEnhanced` (direct `RbookDatabaseClient.create` callers) — read these rules
 * from here so the two cannot drift apart. The module is a leaf: it imports nothing from the tool
 * layer, so either resolver can depend on it without an import cycle.
 *
 * The rule the module encodes: never act on a project the caller did not name. A folder that is
 * not a Reasonbook project is a real working folder, and a call made there is refused rather than routed
 * somewhere else. Only a CONTEXTLESS call — one whose server has no idea where the user is — may use
 * a configured default.
 *
 * @module intelligence/resolution-policy
 */

import { getSetting, resolveRecordPaths } from './legacy-compat';
import { existsSync, realpathSync, statSync } from 'fs';
import os from 'os';
import path from 'path';

/**
 * The directory the running server was installed into: one level above `dist/intelligence` in a
 * build, one level above `src/intelligence` under ts-jest. Re-exported by `sender-context.ts`.
 */
export const SERVER_INSTALL_ROOT = path.resolve(__dirname, '..', '..');

/** Extra ephemeral locations, separated by `path.delimiter` (`:` on POSIX). */
export const RBOOK_EPHEMERAL_PATHS_ENV = 'RBOOK_EPHEMERAL_PATHS';

/** The CLI flag that pins one server config to one project (the Claude Desktop recipe). */
export const PROJECT_ROOT_ARG = '--project-root';

/** Where a Reasonbook store was found. */
export interface EnclosingStore {
  /** The project root: the directory holding `rbook/db/`. */
  readonly root: string;
  /** Whether `rbook/db/rbook.sqlite` exists under it (false = a store whose database is gone). */
  readonly hasDatabase: boolean;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function physical(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** True when `a` and `b` name the same directory, by spelling or by physical location. */
export function isSameDirectory(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b) || physical(a) === physical(b) || sameInode(a, b);
}

/**
 * s96-m01 (#629): realpath does not fold macOS's /System/Volumes/Data spelling of a folder into
 * /Users/…, so two spellings of one folder are also compared by device and inode.
 */
function sameInode(a: string, b: string): boolean {
  try {
    const [left, right] = [statSync(a), statSync(b)];
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/** True when `child` is `parent` or lies under it (by resolved spelling). */
function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * The Reasonbook store rooted exactly at `dir`, or null. The marker is `rbook/db/` — the directory a Reasonbook
 * project keeps its database in — never a bare `rbook/`. A folder named `rbook` is common in source
 * trees (this repository has `src/tools/rbook/`) and in notes (`rbook/` holding papers); treating
 * one as a project would route a call to the folder above it and offer to create a nested
 * project there (critic finding, s92-m01 build review).
 */
export function storeAt(dir: string): EnclosingStore | null {
  const resolved = resolveRecordPaths(dir);
  const dbDir = path.join(resolved.directory, 'db');
  if (!isDirectory(dbDir)) return null;
  return { root: path.resolve(dir), hasDatabase: existsSync(resolved.dbPath) };
}

/**
 * Walk up from `startDir` to the nearest directory holding a Reasonbook store (`rbook/db/`, see
 * {@link storeAt}), the way git finds `.git`. A store whose database file is gone still ends the
 * walk: it is the project the caller is standing in, and continuing past it would route the call
 * to an outer project.
 *
 * CEILING: the walk never examines `$HOME` or the filesystem root unless it started there. A
 * store someone initialised in their home directory must not capture every folder beneath it —
 * that would be the singleton defect again, one level up. `$HOME` is compared by spelling AND by
 * physical location, so a symlinked spelling of the home directory cannot slip past the ceiling.
 */
export function findEnclosingStore(
  startDir: string,
  options: { homeDir?: string } = {}
): EnclosingStore | null {
  const start = path.resolve(startDir);
  const home = path.resolve(options.homeDir ?? os.homedir());
  const startsAtHome = isSameDirectory(start, home);
  const underHome =
    !startsAtHome && (isWithin(start, home) || isWithin(physical(start), physical(home)));

  let dir = start;
  for (;;) {
    const found = storeAt(dir);
    if (found) return found;
    const parent = path.dirname(dir);
    if (parent === dir || parent === path.parse(parent).root) return null;
    if (underHome && isSameDirectory(parent, home)) return null;
    dir = parent;
  }
}

/**
 * A CONTEXTLESS directory tells the server nothing about where the user is working: the
 * filesystem root, `$HOME`, or the server's own install root. Claude Desktop launches servers
 * from one of these. Any other directory without a store is a real working folder that simply
 * is not a Reasonbook project, and calls there are refused rather than defaulted.
 */
export function isContextlessDirectory(
  dir: string,
  options: { homeDir?: string; installRoot?: string } = {}
): boolean {
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return true;
  if (isSameDirectory(resolved, options.homeDir ?? os.homedir())) return true;
  return isSameDirectory(resolved, options.installRoot ?? SERVER_INSTALL_ROOT);
}

/**
 * Read `--project-root <dir>` or `--project-root=<dir>` from a server's argv. The flag lives in
 * ONE server config, so unlike the pre-s53 `RBOOK_PROJECT_ROOT` fallback it cannot leak into every
 * harness that shares a machine. Returns the resolved path, or undefined when absent or empty.
 */
export function parseProjectRootArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === PROJECT_ROOT_ARG) {
      const value = argv[i + 1];
      return value && !value.startsWith('--') ? path.resolve(value) : undefined;
    }
    if (arg.startsWith(`${PROJECT_ROOT_ARG}=`)) {
      const value = arg.slice(PROJECT_ROOT_ARG.length + 1);
      return value ? path.resolve(value) : undefined;
    }
  }
  return undefined;
}

let serverProjectRoot: string | undefined;

/** Record the `--project-root` this server was started with (set once by `src/index.ts`). */
export function setServerProjectRoot(dir: string | undefined): void {
  serverProjectRoot = dir ? path.resolve(dir) : undefined;
}

/** The `--project-root` this server was started with, if any. */
export function getServerProjectRoot(): string | undefined {
  return serverProjectRoot;
}

/**
 * Locations whose stores are scratch by nature: the realpath of `os.tmpdir()`, `/tmp` and
 * `/private/tmp`, plus any paths in `RBOOK_EPHEMERAL_PATHS`. `os.tmpdir()` alone is not enough:
 * on macOS it is `/var/folders/…/T`, while agent scratchpads live under `/private/tmp/…`
 * (feedback #41's store was `/private/tmp/claude-501/…/scratchpad/…`).
 */
export function defaultEphemeralRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = [os.tmpdir(), '/tmp', '/private/tmp'];
  const extra = getSetting(RBOOK_EPHEMERAL_PATHS_ENV, env);
  if (extra) {
    roots.push(...extra.split(path.delimiter).filter((entry) => entry.trim().length > 0));
  }
  const expanded = new Set<string>();
  for (const root of roots) {
    expanded.add(path.resolve(root));
    expanded.add(physical(root));
  }
  return [...expanded];
}

/**
 * True when a store path lies under an ephemeral location. A pure path test: it does not require
 * the store to exist, so a registry row can be judged after its scratch directory is gone.
 */
export function isEphemeralStorePath(
  storePath: string,
  roots: readonly string[] = defaultEphemeralRoots()
): boolean {
  const spellings = new Set([path.resolve(storePath), physical(storePath)]);
  return roots.some((root) => [...spellings].some((spelling) => isWithin(spelling, root)));
}
