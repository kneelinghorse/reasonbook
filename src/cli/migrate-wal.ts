// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Puts a moved or refused store back in WAL within the clients' busy timeout (s109-m01, #913), and says
// ABOUTME: so when another program holds it, which leaves it in rollback-journal mode instead of keeping a guard.
import Database from 'better-sqlite3';
import { enableWal } from '../tools/rbook/sqlite-busy';

/** The clients' busy timeout (client.ts), which putting a store back in WAL waits within. */
export const CLIENT_BUSY_MS = 5_000;

const HELD = 'another program held it when migrate put it back in WAL';

/** s109-m01 (#913): what a refusal or a result says when a store could not go back to WAL. */
export const staysInRollbackJournal = (file: string, reason: string = HELD): string =>
  `${file} stays in rollback-journal mode: ${reason}. Each Reasonbook client switches it back when it next opens the record${
    reason === HELD ? ', and may fail to open it until that program ends' : ''
  }.`;

/**
 * Puts a store back in WAL within the clients' busy timeout; null when it is, else why not. A lock
 * another program holds is the expected cause; any other error is named as itself, so a damaged
 * store is never blamed on another program (round-2 verifier A, note 3).
 */
export function walFailure(db: Database.Database): string | null {
  try {
    enableWal(db, CLIENT_BUSY_MS);
    return String(db.pragma('journal_mode', { simple: true })).toLowerCase() === 'wal'
      ? null
      : 'SQLite kept it in another mode when migrate put it back in WAL';
  } catch (error) {
    const code = (error as { code?: string }).code ?? '';
    return ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(code)
      ? HELD
      : `putting it back in WAL failed (${code || (error as Error).message})`;
  }
}

/** The store is sound and, when it was WAL, back in WAL; else the note saying it stays out of WAL. */
export function verify(file: string, journalMode: string): string[] {
  // s109-m01 (#913): the clients' busy timeout, where 4.10.0 waited 0 ms and kept the guard.
  const db = new Database(file, { fileMustExist: true, timeout: CLIENT_BUSY_MS });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok')
      throw new Error(`Integrity check failed at ${file}`);
    const failure = journalMode === 'wal' ? walFailure(db) : null;
    return failure ? [staysInRollbackJournal(file, failure)] : [];
  } finally {
    db.close();
  }
}

/**
 * After a refusal that took a WAL store out of WAL: puts it back, or says why it could not. Never
 * throws, so a guard is released whatever the store's state (round-2 verifier A, note 4).
 */
export function restoreWal(file: string): string[] {
  let db: Database.Database;
  try {
    db = new Database(file, { fileMustExist: true, timeout: CLIENT_BUSY_MS });
  } catch (error) {
    return [
      staysInRollbackJournal(
        file,
        `migrate could not open it to put it back in WAL (${(error as Error).message})`
      ),
    ];
  }
  try {
    const failure = walFailure(db);
    return failure ? [staysInRollbackJournal(file, failure)] : [];
  } finally {
    db.close();
  }
}
