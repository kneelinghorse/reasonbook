// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m01 — whether a dashboard record's Local Database Path names a store, by folder identity:
// ABOUTME: a fixed store-path tail compared exactly, and the folder before it by device and inode.

import * as path from 'path';
import { LEGACY } from '../../intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';

export type StoreTail = readonly [string, string, string];

/** The two fixed store paths under a project folder. */
export const STORE_TAILS: { readonly current: StoreTail; readonly legacy: StoreTail } = {
  current: ['rbook', 'db', 'rbook.sqlite'],
  legacy: [LEGACY.recordDirectory, 'db', LEGACY.databaseFile],
};

// This platform's separators: Windows records carry `\` (checkpoint-registration.ts sends path.join
// output) and Windows takes `/` too; on POSIX a `\` is part of a name, so it never splits one.
const SEP = process.platform === 'win32' ? '[\\\\/]' : '/';
const NAME = process.platform === 'win32' ? '[^\\\\/]*' : '[^/]*';
const LAST_THREE = new RegExp(`^(.*)${SEP}(${NAME})${SEP}(${NAME})${SEP}(${NAME})$`);
/** Splits a recorded path into its segments, as this module reads them. */
export const SEPARATORS = new RegExp(SEP);

/**
 * Whether `recorded` is an absolute path whose last three segments equal one of `tails`, compared
 * case-sensitively, and whose folder before them is `storeRoot` by ProjectGraphRegistry.isSameFolder
 * (device and inode where both exist, #629), so a case-variant or symlinked spelling of the folder
 * still ties. The dashboard stores any string as a record's path, so:
 * - a relative path never qualifies: stripped of its tail it would resolve to the working folder;
 * - comparing segments, not a string suffix, refuses `<x>/notrbook/db/rbook.sqlite` for a store at
 *   `<x>/not`;
 * - an upper-case tail is refused, which is safe: registration records the lower-case path;
 * - a `..` in the folder is refused, since it can follow a symlink somewhere the text does not say.
 */
export function recordNamesStoreFolder(
  recorded: unknown,
  storeRoot: string,
  tails: readonly StoreTail[]
): boolean {
  if (typeof recorded !== 'string') return false;
  const match = LAST_THREE.exec(recorded);
  if (!match) return false;
  const [, folder, first, second, file] = match;
  if (!tails.some(([a, b, c]) => first === a && second === b && file === c)) return false;
  // A relative folder would resolve against the working folder, and the filesystem root ('') or a
  // bare drive ('C:') names no project folder.
  if (!folder || !path.isAbsolute(folder)) return false;
  // Critic round 1, F2: isSameFolder resolves the path as text before it compares inodes, so a `..`
  // after a symlink would be collapsed there while the system follows the link first, and the record
  // would tie to a store whose file it does not name.
  if (folder.split(SEPARATORS).includes('..')) return false;
  return ProjectGraphRegistry.isSameFolder(folder, storeRoot);
}

/** The fixed store tail a database file's path ends in, or null when it is neither layout. */
export function storeTailOf(storeDbPath: string): StoreTail | null {
  const resolved = path.resolve(storeDbPath);
  const file = path.basename(resolved);
  const second = path.basename(path.dirname(resolved));
  const first = path.basename(path.dirname(path.dirname(resolved)));
  return (
    [STORE_TAILS.current, STORE_TAILS.legacy].find(
      ([a, b, c]) => first === a && second === b && file === c
    ) ?? null
  );
}

/**
 * The exact tie (s110 settled items 1 and 6): `recorded` names this store's own file, on this
 * store's own layout. A record naming the folder's other layout, such as Aquex-mcp's second record
 * (`<root>/cmos/db/cmos.sqlite` while the store is on `rbook/`), does not tie.
 */
export function storeRecordedAt(recorded: unknown, storeDbPath: string): boolean {
  const own = storeTailOf(storeDbPath);
  if (!own) return false;
  return recordNamesStoreFolder(recorded, path.resolve(storeDbPath, '..', '..', '..'), [own]);
}
