// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Serializes migration and recovery across processes without a stale-lock ownership race.
// ABOUTME: SQLite releases this runtime-only lock on process death; its file is never unlinked.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';

export function migrationCoordinatorPath(root: string): string {
  // s108-m05: one folder by device and inode, so every spelling of it (a case variant, a symlink,
  // macOS's /System/Volumes/Data firmlink) shares one coordinator; a typed realpath kept the case.
  const folder = fs.statSync(root);
  const canonical = `${folder.dev}:${folder.ino}`;
  const owner = process.getuid?.() ?? os.userInfo().username;
  const directory = path.join(os.tmpdir(), `reasonbook-migration-locks-${owner}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error(`Unsafe migration coordination directory: ${directory}`);
  const file = path.join(
    directory,
    `${createHash('sha256').update(canonical).digest('hex')}.sqlite`
  );
  if (fs.existsSync(file)) {
    const state = fs.lstatSync(file);
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.nlink !== 1 ||
      (process.getuid && state.uid !== process.getuid())
    )
      throw new Error(`Unsafe migration coordinator: ${file}`);
  }
  return file;
}

/** Hold through reading/recovering the journal and releasing that attempt's filesystem guard. */
export function acquireMigrationExclusion(root: string): () => void {
  let db: Database.Database | undefined;
  try {
    db = new Database(migrationCoordinatorPath(root), { timeout: 0 });
    db.exec('BEGIN EXCLUSIVE');
    const owned = db;
    return () => {
      if (owned.open) owned.close();
    };
  } catch (error) {
    db?.close();
    throw new Error(
      `Another migration owns this project, or its coordinator is unavailable: ${(error as Error).message}. Retry after that migration finishes.`
    );
  }
}
