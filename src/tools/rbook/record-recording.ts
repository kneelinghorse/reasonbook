// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Which clients write a shared record's change log, and the change helper's mark on its transaction: while it
// ABOUTME: records, the client refuses scripts and transaction verbs, so the token and the stage are never committed.

import type { RbookDatabaseClient } from './client';
import { isSharedStore, REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolError } from './types';

const recordedStores = new WeakMap<RbookDatabaseClient, boolean>();
/** Clients inside the change helper's transaction; a nested call joins it. */
const recording = new WeakSet<RbookDatabaseClient>();
/**
 * s96-m13: clients whose transaction holds the merge's token, marked by the merge itself, so a token
 * row that damage left in a file is never taken for the merge's own (critics, round 4).
 */
const merging = new WeakSet<RbookDatabaseClient>();

/** Whether this store keeps the change log: a copy of a shared record that its share step set up. */
export function isRecordedStore(client: RbookDatabaseClient): boolean {
  const known = recordedStores.get(client);
  if (known !== undefined) return known;
  let recorded = false;
  if (isSharedStore(client)) {
    const table = client.getOne<{ present: number }>(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'record_changes'"
    );
    // An unreadable schema fails closed: the store is treated as recorded, so the guards decide.
    recorded = !table.success || Boolean(table.data);
  }
  recordedStores.set(client, recorded);
  return recorded;
}

/** Forget what this client learned, after this process set up or repaired the store's change log. */
export function forgetRecordedStore(client: RbookDatabaseClient): void {
  recordedStores.delete(client);
}

/** The change helper marks its transaction, so the check and the client know whose token it is. */
export function beginRecording(client: RbookDatabaseClient): void {
  recording.add(client);
}
export function endRecording(client: RbookDatabaseClient): void {
  recording.delete(client);
}
export function isRecording(client: RbookDatabaseClient): boolean {
  return recording.has(client);
}

/** The merge marks its transaction while it holds its token (record-token.ts, record-apply.ts). */
export function beginMerging(client: RbookDatabaseClient): void {
  merging.add(client);
}
export function endMerging(client: RbookDatabaseClient): void {
  merging.delete(client);
}
export function isMerging(client: RbookDatabaseClient): boolean {
  return merging.has(client);
}

/** A statement that begins, commits or ends a transaction; a savepoint's ROLLBACK TO is not one. */
const TRANSACTION_VERB = /^\s*(?:BEGIN|COMMIT|END|ROLLBACK\b(?!\s+(?:TRANSACTION\s+)?TO\b))/i;
/**
 * What a statement may start with that hides its verb from TRANSACTION_VERB: comments, and the
 * empty statements SQLite skips before it (`;COMMIT` runs a COMMIT).
 */
const LEADING_COMMENTS = /^(?:\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|;))*/;

/**
 * While the change helper records, the transaction is its own (ADR s96 §6). A script through `raw`
 * is refused, since quoted text can hide a verb from any pattern; a single statement through
 * `execute` is refused when it would begin, commit, end or roll back a transaction.
 */
export function refusedWhileRecording(
  client: RbookDatabaseClient,
  sql: string,
  via: 'execute' | 'raw'
): RbookToolError | null {
  if (!recording.has(client)) return null;
  if (via === 'execute' && !TRANSACTION_VERB.test(sql.replace(LEADING_COMMENTS, ''))) return null;
  return {
    code: REPLICA_ERROR_CODES.WRITE_REFUSED,
    message:
      via === 'raw'
        ? "A recorded write runs inside the change helper's transaction, so it runs single statements: a script could begin, commit or roll back a transaction."
        : "A recorded write runs inside the change helper's transaction, so it cannot begin, commit or roll back a transaction itself.",
    suggestion:
      'Throw from the write to roll it back; the helper commits it with every change recorded.',
  };
}
