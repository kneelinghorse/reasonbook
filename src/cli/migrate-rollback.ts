// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Rolls an interrupted or refused move back by its journal, never overwriting another writer, and lets a
// ABOUTME: crashed owner's guard go; a move that renamed nothing needs no open-file check to release it (#913).
import fs from 'fs';
import path from 'path';
import { LEGACY } from '../intelligence/legacy-compat';
import { acquireMigrationExclusion } from './migrate-exclusion';
import { assertNoOpenFiles } from './migrate-guard';
import {
  cutoverSeams,
  JOURNAL,
  LOCK,
  pendingAfterCommit,
  PENDING,
  release,
  writeMigrationState,
  type Journal,
} from './migrate-state';
import { gitSees } from './migrate-git';
import { restoreWal, verify } from './migrate-wal';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * s109-m01 (#913): nothing has moved while the journal says prepared, only the old folder exists,
 * and it holds no store under the new name; rollback then needs no open-file check, which a late
 * opener failed, leaving the guard so every client refused the project. Anything else may have
 * moved, so rollback still refuses while a program holds the record.
 */
function nothingRenamed({ phase, source, destination }: Journal): boolean {
  return (
    phase === 'prepared' &&
    fs.existsSync(source) &&
    !fs.existsSync(destination) &&
    !fs.lstatSync(path.join(source, 'db', 'rbook.sqlite'), { throwIfNoEntry: false })
  );
}

export function rollback(root: string, journal: Journal): string[] {
  const { source, destination } = journal;
  if (fs.existsSync(source) && fs.existsSync(destination))
    throw new Error(
      `Recovery cannot overwrite ${source} or ${destination}; both exist. Retained ${path.join(root, JOURNAL)} and the migration guard.`
    );
  const current = fs.existsSync(destination) ? destination : source;
  const unmoved = nothingRenamed(journal);
  if (!unmoved) assertNoOpenFiles(current);
  const oldFile = path.join(current, 'db', LEGACY.databaseFile);
  const newFile = path.join(current, 'db', 'rbook.sqlite');
  if (fs.existsSync(newFile)) {
    if (fs.existsSync(oldFile))
      throw new Error(
        `Recovery will not overwrite ${oldFile}; retained ${path.join(root, JOURNAL)}.`
      );
    fs.renameSync(newFile, oldFile);
  }
  if (current === destination) fs.renameSync(destination, source);
  const ignore = path.join(source, '.gitignore');
  if (journal.ignoreEdited !== false) {
    if (journal.originalIgnore === null) fs.rmSync(ignore, { force: true });
    else {
      fs.writeFileSync(
        ignore,
        journal.originalIgnoreBytes !== undefined
          ? Buffer.from(journal.originalIgnoreBytes, 'base64')
          : journal.originalIgnore
      );
      fs.chmodSync(ignore, journal.ignoreMode);
    }
  }
  cutoverSeams.beforeRollbackVerify();
  const store = path.join(source, 'db', LEGACY.databaseFile);
  // s109-m01: a store another program keeps in rollback-journal mode no longer keeps the guard.
  // When nothing moved, the mover wrote no row (it switched the mode and copied the store into its
  // backup), so only the mode is put back: an integrity check a late writer's lock outlasts would
  // keep the guard (build critic A, B1).
  const notes = unmoved
    ? journal.journalMode === 'wal'
      ? restoreWal(store)
      : []
    : verify(store, journal.journalMode);
  release(root);
  return notes;
}

/**
 * A crashed owner is recovered first; a living owner is never interrupted. s109-m01: what recovery
 * could not do, such as putting the store back in WAL, joins notes.
 */
export function recoverMigration(
  root: string,
  coordinated = false,
  notes: string[] = [],
  /** What it found but did not fail at, such as a backup git can see. */
  info: string[] = notes
): boolean {
  const release = coordinated ? () => {} : acquireMigrationExclusion(root);
  try {
    return recoverOwnedMigration(root, notes, info);
  } finally {
    release();
  }
}

/**
 * s108-m05: the journal's folders sit in this root by device and inode, so a move begun through one
 * spelling of the folder recovers through any other (E5 F12), as the coordinator matches them.
 */
function namesRoot(journal: Journal, root: string): boolean {
  if (typeof journal.source !== 'string' || typeof journal.destination !== 'string') return false;
  const parent = path.dirname(journal.source);
  if (
    path.basename(journal.source) !== LEGACY.recordDirectory ||
    journal.destination !== path.join(parent, 'rbook')
  )
    return false;
  try {
    const [recorded, current] = [fs.statSync(parent), fs.statSync(root)];
    return recorded.dev === current.dev && recorded.ino === current.ino;
  } catch {
    return false;
  }
}

function recoverOwnedMigration(root: string, notes: string[], info: string[]): boolean {
  const file = path.join(root, JOURNAL);
  const lock = path.join(root, LOCK);
  if (!fs.existsSync(file) && !fs.existsSync(lock)) return false;
  const ownerFile = path.join(lock, 'owner.json');
  const owner = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Journal) : null;
  // Read leniently: beside a journal it only adds the store's mode, and damage to it must not keep
  // a guard a journal can release (round-2 verifier A, note 4).
  let guardOwner: { pid?: number; journalMode?: string } | null = null;
  try {
    guardOwner = fs.existsSync(ownerFile) ? JSON.parse(fs.readFileSync(ownerFile, 'utf8')) : null;
  } catch {
    guardOwner = null;
  }
  const pid = owner?.pid ?? guardOwner?.pid ?? null;
  if (!pid || !Number.isInteger(pid) || isAlive(pid))
    throw new Error(
      `Migration guard at ${lock} has a live or unknown owner; no files were changed.`
    );
  if (owner) {
    if (!namesRoot(owner, root))
      throw new Error(`Invalid recovery paths in ${file}; no files were changed.`);
    // Recovery works through this call's spelling of the folders the journal named.
    const journal: Journal = {
      ...owner,
      source: path.join(root, LEGACY.recordDirectory),
      destination: path.join(root, 'rbook'),
    };
    if (journal.phase === 'committed') {
      const moved = path.join(journal.destination, 'db', 'rbook.sqlite');
      notes.push(...verify(moved, journal.journalMode));
      writeMigrationState(path.join(root, PENDING), pendingAfterCommit(journal));
      release(root);
    } else {
      notes.push(...rollback(root, journal));
      // A crashed move's backup sits under the old folder again; say so when git can see it, since
      // the restored .gitignore may not ignore it (round-2 verifier A, note 2).
      const backup = path.join(journal.source, path.relative(journal.destination, journal.backup));
      if (fs.existsSync(backup))
        info.push(
          `The interrupted move left a backup, ${backup}; it may be deleted once the record has moved.${
            gitSees(root, backup)
              ? ' git can see it, so git add -A would commit a copy of the record: delete it, or ignore db/snapshots/, before you commit.'
              : ''
          }`
        );
    }
  } else {
    // s109-m01: a move that died after the switch from WAL and before its journal (during the
    // backup, say) wrote the store's mode beside its pid, so the store goes back to WAL here (build
    // critic A, note 3); nothing was renamed, so no open-file check stands in the way.
    const store = path.join(root, LEGACY.recordDirectory, 'db', LEGACY.databaseFile);
    if (guardOwner?.journalMode === 'wal' && fs.existsSync(store)) notes.push(...restoreWal(store));
    release(root);
  }
  return true;
}
