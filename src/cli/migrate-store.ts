// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Holds the record's exclusive lock and a migration guard while it backs up and renames it.
// ABOUTME: A durable journal rolls an interrupted cutover back without overwriting another writer.
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { LEGACY } from '../intelligence/legacy-compat';
import { acquireMigrationExclusion } from './migrate-exclusion';
import { assertNoOpenFiles, assertNoRecordProcesses } from './migrate-guard';

export const JOURNAL = '.rbook-migration.json';
export const PENDING = '.rbook-migration-pending.json';
const LOCK = '.rbook-migration.lock';
interface Journal {
  readonly pid: number;
  readonly source: string;
  readonly destination: string;
  readonly originalIgnore: string | null;
  readonly ignoreMode: number;
  readonly backup: string;
  readonly journalMode: string;
  phase: 'prepared' | 'folder' | 'database' | 'committed';
}

/**
 * s108-m05: whether a record may have synced with a peer, which is what a 4.1 to 4.9 server's sync
 * list remembers: it keeps a project it once saw shared, after its route is forgotten (round 3).
 * Only a readable store with no record_peers table, which a record's first peer makes and no
 * release drops, never did.
 */
export function mayHaveSynced(dbPath: string): boolean {
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 250 });
    return Boolean(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'record_peers'").get()
    );
  } catch {
    // Not read, so not known never to have synced.
    return true;
  } finally {
    db?.close();
  }
}

/** s108-m05: a test-only seam between a move's final open-file check and its first rename. */
export const cutoverSeams = { beforeRename: (): void => undefined };

/** Flush each phase before its rename, so recovery sees an intent even after a process crash. */
export function writeMigrationState(file: string, data: unknown): void {
  const temporary = `${file}.tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
function release(root: string): void {
  fs.rmSync(path.join(root, JOURNAL), { force: true });
  fs.rmSync(path.join(root, LOCK), { recursive: true, force: true });
}
function verify(file: string, journalMode: string): void {
  const db = new Database(file, { fileMustExist: true, timeout: 0 });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new Error(`Integrity check failed at ${file}`);
    if (journalMode === 'wal') db.pragma('journal_mode = WAL');
  } finally {
    db.close();
  }
}
function rollback(root: string, journal: Journal): void {
  const { source, destination } = journal;
  if (fs.existsSync(source) && fs.existsSync(destination))
    throw new Error(
      `Recovery cannot overwrite ${source} or ${destination}; both exist. Retained ${path.join(root, JOURNAL)} and the migration guard.`
    );
  const current = fs.existsSync(destination) ? destination : source;
  assertNoOpenFiles(current);
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
  if (journal.originalIgnore === null) fs.rmSync(ignore, { force: true });
  else {
    fs.writeFileSync(ignore, journal.originalIgnore);
    fs.chmodSync(ignore, journal.ignoreMode);
  }
  verify(path.join(source, 'db', LEGACY.databaseFile), journal.journalMode);
  release(root);
}

/** A crashed owner is recovered first; a living owner is never interrupted. */
export function recoverMigration(root: string, coordinated = false): boolean {
  const release = coordinated ? () => {} : acquireMigrationExclusion(root);
  try {
    return recoverOwnedMigration(root);
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

function recoverOwnedMigration(root: string): boolean {
  const file = path.join(root, JOURNAL);
  const lock = path.join(root, LOCK);
  if (!fs.existsSync(file) && !fs.existsSync(lock)) return false;
  const ownerFile = path.join(lock, 'owner.json');
  const owner = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Journal) : null;
  const pid =
    owner?.pid ??
    (fs.existsSync(ownerFile)
      ? (JSON.parse(fs.readFileSync(ownerFile, 'utf8')) as { pid: number }).pid
      : null);
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
      verify(path.join(journal.destination, 'db', 'rbook.sqlite'), journal.journalMode);
      writeMigrationState(path.join(root, PENDING), {
        backup: journal.backup,
        remaining: 'documents and registration',
      });
      release(root);
    } else rollback(root, journal);
  } else release(root);
  return true;
}

export function moveRecord(root: string, checkProcesses = true): { backup: string } {
  const source = path.join(root, LEGACY.recordDirectory);
  const destination = path.join(root, 'rbook');
  const file = path.join(root, JOURNAL);
  const lock = path.join(root, LOCK);
  if (fs.existsSync(source) && fs.existsSync(destination))
    throw new Error(
      'Refusing migration because both record folders exist; inspect them before retrying.'
    );
  if (fs.lstatSync(source).isSymbolicLink())
    throw new Error(`Refusing a symlinked record directory: ${source}`);
  // s108-m05 (round 2): the rename would overwrite a store already named rbook.sqlite in the old
  // folder, and a journal or log under that name would be applied to the moved store when it opens.
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const stray = path.join(source, 'db', `rbook.sqlite${suffix}`);
    // lstat, so a link there, even one to nothing, is not replaced unseen (round 3).
    if (fs.lstatSync(stray, { throwIfNoEntry: false }))
      throw new Error(
        `Refusing migration because ${stray} already exists and the move would overwrite or apply it; inspect it before retrying.`
      );
  }
  fs.mkdirSync(lock);
  writeMigrationState(path.join(lock, 'owner.json'), { pid: process.pid });
  let journal: Journal | undefined;
  // s108-m05: one connection holds the record's exclusive lock from the backup through both renames,
  // so a handle any process opens meanwhile can write nothing (E5 F8). Copying or reading the file
  // another way in this process would silently drop that lock, so the backup is VACUUM INTO.
  let held: Database.Database | undefined;
  const letGo = () => {
    if (held?.open) held.close();
  };
  try {
    const dbPath = path.join(source, 'db', LEGACY.databaseFile);
    // A 4.1 to 4.9 server that syncs a record ends at a sync during its move (round 2), so a record
    // that may ever have synced waits for every runtime (round 3).
    if (checkProcesses) assertNoRecordProcesses(mayHaveSynced(dbPath) ? 'shared' : 'pre-guard');
    assertNoOpenFiles(source);
    if (fs.lstatSync(dbPath).nlink > 1)
      throw new Error(`Refusing a hardlinked database: ${dbPath}`);
    if (fs.lstatSync(dbPath).isSymbolicLink())
      throw new Error(`Refusing a symlinked database: ${dbPath}`);
    held = new Database(dbPath, { fileMustExist: true, timeout: 0 });
    const backupRelative = path.join('db', 'snapshots', `pre-migrate-${randomUUID()}.sqlite`);
    const journalMode = String(held.pragma('journal_mode', { simple: true }));
    const checkpoint = held.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
    if (checkpoint.some((row) => row.busy !== 0))
      throw new Error('Database checkpoint is busy; close all clients before migration.');
    // The switch from WAL comes first: made under the exclusive mode, its rollback journal would
    // stay until the close, which comes after the renames and no longer finds it (round 1).
    const beside = (suffix: string) => fs.existsSync(`${dbPath}${suffix}`);
    const [hadWal, hadJournal] = [beside('-wal'), beside('-journal')];
    held.pragma('journal_mode = DELETE');
    held.pragma('locking_mode = EXCLUSIVE');
    held.exec('BEGIN EXCLUSIVE; COMMIT;');
    const wal = `${dbPath}-wal`;
    if (fs.existsSync(wal) && fs.statSync(wal).size !== 0)
      throw new Error(`Uncheckpointed WAL remains at ${wal}; nothing was moved.`);
    // From the switch to the lock another process could switch the store back to WAL or leave a
    // journal, which would stay behind under the old name; the move refuses instead (round 2).
    if (
      String(held.pragma('journal_mode', { simple: true })) !== 'delete' ||
      (!hadWal && beside('-wal')) ||
      (!hadJournal && beside('-journal'))
    )
      throw new Error(
        'Another process used the record as the move began; nothing was moved. Retry once it is done.'
      );
    fs.mkdirSync(path.join(source, 'db', 'snapshots'), { recursive: true });
    held.prepare('VACUUM INTO ?').run(path.join(source, backupRelative));
    const ignore = path.join(source, '.gitignore');
    journal = {
      pid: process.pid,
      source,
      destination,
      originalIgnore: fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : null,
      ignoreMode: fs.existsSync(ignore) ? fs.statSync(ignore).mode & 0o7777 : 0o644,
      backup: path.join(destination, backupRelative),
      journalMode,
      phase: 'prepared',
    };
    writeMigrationState(file, journal);
    const original = journal.originalIgnore ?? '';
    let updated = original.split(`db/${LEGACY.databaseFile}`).join('db/*.sqlite');
    for (const pattern of [
      'db/*.sqlite',
      'db/*.sqlite-wal',
      'db/*.sqlite-shm',
      'db/snapshots/pre-migrate-*.sqlite',
    ]) {
      // Last matching rule wins: an earlier copy may be followed by a negation.
      updated += `${updated && !updated.endsWith('\n') ? '\n' : ''}${pattern}\n`;
    }
    fs.writeFileSync(ignore, updated);
    // Nothing but this process's held connection may have the record open now.
    assertNoOpenFiles(source, process.pid);
    cutoverSeams.beforeRename();
    journal.phase = 'folder';
    writeMigrationState(file, journal);
    fs.renameSync(source, destination);
    journal.phase = 'database';
    writeMigrationState(file, journal);
    fs.renameSync(
      path.join(destination, 'db', LEGACY.databaseFile),
      path.join(destination, 'db', 'rbook.sqlite')
    );
    letGo();
    verify(path.join(destination, 'db', 'rbook.sqlite'), journalMode);
    journal.phase = 'committed';
    writeMigrationState(file, journal);
    writeMigrationState(path.join(root, PENDING), {
      backup: journal.backup,
      remaining: 'documents and registration',
    });
    release(root);
    return { backup: journal.backup };
  } catch (error) {
    // Rollback's own open-file check must not find this process's handle.
    letGo();
    if (journal && journal.phase !== 'committed') {
      try {
        rollback(root, journal);
      } catch (recovery) {
        throw new Error(
          `${(error as Error).message}; recovery failed: ${(recovery as Error).message}`
        );
      }
    } else if (!journal) release(root);
    throw error;
  }
}
