// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Shares the bounded source-file population between build manifests and freshness checks.
// ABOUTME: Hashes the selected paths and bytes so identical checkouts do not look like source edits.

import { promises as fs } from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

const SRC_EXTENSIONS = new Set(['.ts', '.tsx', '.js']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.next']);
export const SRC_WALK_CAP = 5000;

export interface SrcFileMtime {
  readonly relativePath: string;
  readonly mtimeMs: number;
}

/**
 * Walk src/ collecting (relativePath, mtime) for .ts/.tsx/.js files. Skips
 * node_modules / dist / .git / coverage / .next. Caps at SRC_WALK_CAP files
 * to avoid pathological repos. Returns [] when src/ is missing.
 *
 * `strict` (s107-m04, the freshness check): an entry that cannot be read for any reason but its
 * being gone or a symlink cycle throws, since a newer file behind it would otherwise read as
 * fresh. The manifest generator keeps the lenient walk, so a build is never refused for it.
 */
export async function collectSrcMtimes(
  projectRoot: string,
  options: { readonly strict?: boolean } = {}
): Promise<SrcFileMtime[]> {
  const srcDir = path.join(projectRoot, 'src');
  // Gone (ENOENT, ENOTDIR) or a symlink cycle's repeat (ELOOP: its deeper paths hold files
  // already seen) are skipped even when strict; every other read error is the check failing.
  const skip = (error: unknown): void => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (options.strict && code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw error;
  };
  let exists = false;
  try {
    const stat = await fs.stat(srcDir);
    exists = stat.isDirectory();
  } catch (error) {
    skip(error);
    return [];
  }
  if (!exists) return [];

  const results: SrcFileMtime[] = [];
  const stack: string[] = [srcDir];
  while (stack.length > 0 && results.length < SRC_WALK_CAP) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = (await fs.readdir(dir)).sort();
    } catch (error) {
      skip(error);
      continue;
    }
    for (const name of entries) {
      if (results.length >= SRC_WALK_CAP) break;
      const fullPath = path.join(dir, name);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(fullPath);
      } catch (error) {
        // Permission error / symlink to nowhere — skipped, unless the walk is strict.
        skip(error);
        continue;
      }
      if (stat.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        stack.push(fullPath);
      } else if (stat.isFile()) {
        const ext = path.extname(name);
        if (!SRC_EXTENSIONS.has(ext)) continue;
        results.push({
          relativePath: path.relative(projectRoot, fullPath),
          mtimeMs: stat.mtimeMs,
        });
      }
    }
  }
  return results;
}

/** Hash exactly the walk's population, with paths and byte lengths framing each file. */
export async function hashSrcFiles(
  projectRoot: string,
  files: readonly SrcFileMtime[]
): Promise<string> {
  const hash = createHash('sha256');
  for (const relativePath of files.map((file) => file.relativePath).sort()) {
    const content = await fs.readFile(path.join(projectRoot, relativePath));
    hash.update(JSON.stringify([relativePath, content.length]) + '\n');
    hash.update(content);
  }
  return hash.digest('hex');
}
