// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Removes abandoned upload, share, join, import and replay copies from the temporary folder.
// ABOUTME: Only day-old directories owned by this user qualify; links and unverifiable owners stay.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { isUploadCopyName } from '../../intelligence/legacy-compat';

const RECORD_COPY_PREFIXES = [
  'reasonbook-upload-',
  'reasonbook-join-',
  'rbook-import-',
  'rbook-replay-',
];
const STALE_COPY_MS = 24 * 60 * 60 * 1000;

export interface RecordCopySweepOptions {
  readonly tmpdir?: string;
  readonly now?: number;
  readonly lstat?: (file: string) => Pick<fs.Stats, 'isDirectory' | 'uid' | 'mtimeMs'>;
  /** Without a user id (Windows), ownership cannot be checked, so everything is kept. */
  readonly uid?: number;
}

/**
 * Direct children only, checked with lstat so a symlink is never followed. The existing upload
 * rule applies to every record copy: owned by this user and at least 24 hours old. Best effort;
 * an unreadable or unremovable copy stays and its error is reported. No upload setting gates this.
 */
export function sweepStaleRecordCopies(options: RecordCopySweepOptions = {}): string[] {
  const uid = 'uid' in options ? options.uid : process.getuid?.();
  if (uid === undefined) return [];
  const tmp = options.tmpdir ?? os.tmpdir();
  const now = options.now ?? Date.now();
  const lstat = options.lstat ?? fs.lstatSync;
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(tmp);
  } catch (error) {
    report(`Could not list ${tmp} for old record copies`, error);
    return removed;
  }
  for (const name of names) {
    if (!isUploadCopyName(name) && !RECORD_COPY_PREFIXES.some((prefix) => name.startsWith(prefix)))
      continue;
    const directory = path.join(tmp, name);
    try {
      const stat = lstat(directory);
      if (!stat.isDirectory() || stat.uid !== uid || now - stat.mtimeMs < STALE_COPY_MS) continue;
      fs.rmSync(directory, { recursive: true, force: true });
      removed.push(directory);
    } catch (error) {
      report(`Could not remove the old record copy ${directory}`, error);
    }
  }
  return removed;
}

function report(message: string, error: unknown): void {
  process.stderr.write(
    `[RECORD] ${message}: ${error instanceof Error ? error.message : String(error)}\n`
  );
}
