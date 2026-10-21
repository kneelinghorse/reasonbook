// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A store's identity for its per-machine runtime files: the project id it records and its native real path.
// ABOUTME: Dependency-free, so the draft runtime, telemetry and the signals library key a store the same way.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * WHY A LEAF (s97-m01). The signals library counts a draft as pending only while fewer than three
 * sessions have started since it was drafted, and those starts live in the draft runtime's file,
 * found by {@link draftStoreKey}. The library must find the same file the hook writes, so both
 * call this one function; and the library may load nothing heavier than this module to do it.
 */

/** The metadata keys a store's project id is read from: the first one present wins. */
export const STORE_ID_METADATA_KEYS = ['project_id', 'dashboard_slug', 'project_name'] as const;

/** The project id of a store whose metadata names none. */
export const UNKNOWN_STORE_PROJECT = 'unknown-project';

export interface StoreTarget {
  readonly projectId: string;
  readonly dbPath: string;
}

/** The project id a store records, read through `value` by {@link STORE_ID_METADATA_KEYS}. */
export function storeProjectId(value: (key: string) => unknown): string {
  for (const key of STORE_ID_METADATA_KEYS) {
    const found = value(key);
    if (typeof found === 'string' && found) return found;
  }
  return UNKNOWN_STORE_PROJECT;
}

/**
 * The project id and the store's NATIVE real path, hashed: a hook handed `cwd` and a server handed
 * a project root typed in another letter case find the same file on a case-insensitive disk.
 */
export function draftStoreKey(target: StoreTarget): string {
  let real = path.resolve(target.dbPath);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    // A store that cannot be resolved keys by its resolved path; it will not open anyway.
  }
  return createHash('sha256').update(`${target.projectId}\0${real}`).digest('hex').slice(0, 32);
}

/** The draft runtime's file for a store key, inside a machine's drafts folder. */
export function draftRuntimeFile(draftsDir: string, storeKey: string): string {
  return path.join(draftsDir, `${storeKey}.sqlite`);
}

/** A SQLite file and the sidecars it may have beside it. */
export function sqliteFileSet(file: string): string[] {
  return [file, `${file}-journal`, `${file}-wal`, `${file}-shm`];
}

/**
 * Whether a runtime file and each sidecar present are plain files with one name: the plain-file
 * half of the rule the draft runtime's own open applies (draft-runtime.ts requireSafe, which also
 * refuses a location inside a repository or a project). The signals library applies this half
 * only. A missing sidecar is fine; a link, a folder or a second name is not.
 */
export function plainSqliteFiles(file: string): boolean {
  return sqliteFileSet(file).every(plainSqliteFile);
}

/** One name of {@link sqliteFileSet}: absent, or a plain file with one name. */
export function plainSqliteFile(name: string): boolean {
  try {
    const stat = fs.lstatSync(name);
    return stat.isFile() && stat.nlink === 1;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
