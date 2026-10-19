// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The change helper (ADR s96 §4, §6): on a shared record it runs a write under the write lock holding the
// ABOUTME: token, and records every change in the same transaction; a solo store runs the write as it always did.

import { monotonicFactory } from 'ulid';
import { authorForWrite } from './author-name';
import type { RbookDatabaseClient } from './client';
import { createSuccess } from './errors';
import { ensureGenesisSchema } from './genesis-columns';
import { draftsFromStage } from './record-capture';
import {
  APPLY_TOKEN_TABLE,
  beginRecording,
  CHANGE_KINDS,
  endRecording,
  isRecordedStore,
  isRecording,
  rebuildRecordGuards,
  STAGE_TABLE,
  TOKEN_TABLE,
  TRANSIENT_TABLES_SQL,
} from './record-guards';
import { IMPORT_BASE, RECORD_COLUMNS, type SharedTable } from './record-columns';
import { mergeContext, txnStanding } from './record-standing';
import { guardBroken } from './replica-check';
import {
  readReplicaIdentity,
  recordedProjectId,
  ReplicaRefusal,
  sharedStoreWrite,
  takeReplicaSeqs,
} from './replica-identity';
import type { RbookToolResult } from './types';

/** The change log's wire version (ADR s96 §4). */
export const PROTOCOL_VERSION = 1;
/** Per-copy metadata: this copy's hybrid logical clock, `<13-digit ms>-<6-digit counter>`. */
export const HLC_KEY = 'replica_hlc';
/** The largest count a reading's six digits hold. */
const HLC_COUNT_MAX = 999_999;

const mintId = monotonicFactory();
/** The transaction id of each client's current SQLite transaction, by its serial. */
const transactionIds = new WeakMap<RbookDatabaseClient, { serial: number; txnId: string }>();
/** The clock reading of each client's current transaction: one per transaction (ADR s96 §4). */
const clocks = new WeakMap<RbookDatabaseClient, { txnId: string; hlc: string }>();

/** One id for everything one SQLite transaction records, however many helper calls it makes. */
function transactionId(client: RbookDatabaseClient): string {
  const serial = client.transactionSerial;
  const known = transactionIds.get(client);
  if (known && known.serial === serial) return known.txnId;
  const txnId = mintId();
  transactionIds.set(client, { serial, txnId });
  return txnId;
}

export { isRecordedStore };

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): void {
  const result = client.execute(sql, params);
  if (!result.success) throw new Error(result.error?.message ?? `could not run: ${sql}`);
}

function runScript(client: RbookDatabaseClient, sql: string): void {
  const result = client.raw(sql);
  if (!result.success) throw new Error(result.error?.message ?? `could not run: ${sql}`);
}

class RolledBack extends Error {}

/**
 * A token or a staged change already in the store when the helper takes the write lock was left by
 * a write outside the helper, so this one is refused: the copy check judges it once per client,
 * and this covers a client opened without that check (ADR s96 §6).
 */
function refuseLeftovers(client: RbookDatabaseClient): void {
  const left = client.getOne<{ tokens: number; staged: number }>(
    `SELECT (SELECT count(*) FROM ${TOKEN_TABLE}) + (SELECT count(*) FROM ${APPLY_TOKEN_TABLE}) AS tokens, (SELECT count(*) FROM ${STAGE_TABLE}) AS staged`
  );
  if (!left.success) throw new Error(left.error?.message ?? 'the write token could not be read');
  const tokens = left.data?.tokens ?? 0;
  const staged = left.data?.staged ?? 0;
  if (tokens || staged)
    throw new ReplicaRefusal(
      guardBroken(
        [`${tokens} leftover write token(s)`, `${staged} staged change(s) never recorded`],
        'repair'
      )
    );
}

/**
 * A drop-in for `client.writeTransaction` at a converted site: a write transaction on every store,
 * and on a shared record one that holds the token and records every change it made before the
 * token goes (ADR s96 §4, §6). A nested call runs as a savepoint inside the recording one. While
 * it records, the client refuses a statement that would begin, commit or roll back a transaction,
 * so the token and the stage are never committed.
 */
export function recordedTransaction<T>(
  client: RbookDatabaseClient,
  fn: () => T
): RbookToolResult<T> {
  if (!isRecordedStore(client) || isRecording(client)) return client.writeTransaction(fn);
  return client.writeTransaction(() => {
    // Nested in a deferred transaction, the write lock is not held, so nothing could be numbered.
    if (!client.inWriteTransaction)
      throw new Error(
        "A recorded write takes the store's write lock, so it cannot run inside a deferred transaction."
      );
    // ADR s96 §4: a migration never holds the token, so a create's point-of-use migrations run
    // first, under this lock; the guards then abort any shared row they would change.
    ensureGenesisSchema(client);
    const serial = client.transactionSerial;
    const txnId = transactionId(client);
    refuseLeftovers(client);
    run(client, `INSERT INTO ${TOKEN_TABLE} (txn_id) VALUES (?)`, [txnId]);
    beginRecording(client);
    try {
      const result = fn();
      // The client refuses a transaction verb while recording; this is the backstop.
      if (!client.inWriteTransaction || client.transactionSerial !== serial)
        throw new Error(
          'A recorded write ended its own transaction, so its changes were not recorded.'
        );
      recordChanges(client, txnId, draftsFromStage(client, recordedProjectId(client)));
      run(client, `DELETE FROM ${STAGE_TABLE}`);
      run(client, `DELETE FROM ${TOKEN_TABLE} WHERE txn_id = ?`, [txnId]);
      return result;
    } finally {
      endRecording(client);
    }
  });
}

/**
 * A write that ran without a transaction before s96-m03: on a shared record it is a recorded
 * transaction; on any other store it runs exactly as it did, with no transaction, and a throw
 * still propagates.
 */
export function recordedChange<T>(client: RbookDatabaseClient, fn: () => T): RbookToolResult<T> {
  return isRecordedStore(client) ? recordedTransaction(client, fn) : createSuccess(fn());
}

/**
 * Run a write to the shared tables that returns its own result. On a shared record it is a
 * recorded transaction, rolled back when the result fails. Any other store runs it as s96-m01's
 * `sharedStoreWrite` does: exactly as before on a solo store.
 */
export function recordedWrite<T>(
  client: RbookDatabaseClient,
  write: () => RbookToolResult<T>
): RbookToolResult<T> {
  if (!isRecordedStore(client)) return sharedStoreWrite(client, write);
  let inner: RbookToolResult<T> | undefined;
  const outer = recordedTransaction(client, () => {
    inner = write();
    if (!inner.success) throw new RolledBack();
  });
  if (inner && !inner.success) return inner;
  if (!outer.success || !inner) return outer as unknown as RbookToolResult<T>;
  return inner;
}

/** One statement as a recorded write: the converted sites' single UPDATEs, INSERTs and DELETEs. */
export function recordedExecute(
  client: RbookDatabaseClient,
  sql: string,
  params: unknown[] = []
): ReturnType<RbookDatabaseClient['execute']> {
  return recordedWrite(client, () => client.execute(sql, params));
}

/**
 * s96-m12: move this copy's clock past every reading it received, so a later local write orders
 * after what this copy has already seen (a hybrid logical clock).
 */
export function advanceClock(client: RbookDatabaseClient, received: string): void {
  const stored = client.getOne<{ value: string }>(
    "SELECT value FROM metadata WHERE key = 'replica_hlc'"
  );
  if (String(stored.data?.value ?? '') >= received) return;
  // A literal key, so the schema-version census reads it as a clock and never as the label.
  run(
    client,
    "INSERT INTO metadata (key, value) VALUES ('replica_hlc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [received]
  );
}

/** s96-m12: record changes this copy authors outside a captured write, such as a verdict, in this transaction. */
export function recordOwnChanges(
  client: RbookDatabaseClient,
  changes: readonly RecordedChange[]
): void {
  recordChanges(client, transactionId(client), changes);
}

/**
 * This transaction's clock reading (ADR s96 §5 orders by it): advanced once per transaction under
 * the write lock, and written on every call, since a rolled-back savepoint takes a write with it.
 */
function transactionHlc(client: RbookDatabaseClient, txnId: string): string {
  const known = clocks.get(client);
  let hlc = known?.txnId === txnId ? known.hlc : '';
  if (!hlc) {
    const stored = client.getOne<{ value: string }>(
      "SELECT value FROM metadata WHERE key = 'replica_hlc'"
    );
    const [lastMs, lastCount] = String(stored.data?.value ?? '0-0')
      .split('-')
      .map(Number);
    const now = Date.now();
    const ms = Number.isFinite(lastMs) && lastMs >= now ? lastMs : now;
    const next = ms === lastMs && Number.isFinite(lastCount) ? lastCount + 1 : 0;
    // s97-m09: past six digits the count carries into the milliseconds, so every reading keeps its
    // width and orders alike as text and as numbers on every copy (critics, round 2).
    const [at, count] = next > HLC_COUNT_MAX ? [ms + 1, 0] : [ms, next];
    hlc = `${String(at).padStart(13, '0')}-${String(count).padStart(6, '0')}`;
    clocks.set(client, { txnId, hlc });
  }
  // A literal key, so the schema-version census reads it as a clock and never as the label.
  run(
    client,
    "INSERT INTO metadata (key, value) VALUES ('replica_hlc', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [hlc]
  );
  return hlc;
}

export interface RecordedChange {
  readonly kind: (typeof CHANGE_KINDS)[number];
  readonly entity: string;
  readonly entityId: string | null;
  readonly field: string | null;
  readonly value: string | null;
  /** s96-m14: the additions a settle covers, those the value it keeps had applied; else every live one. */
  readonly covers?: readonly string[];
}

const HEAD_KINDS: ReadonlySet<string> = new Set(['set', 'settle', 'link', 'unlink']);

/** s96-m14: the fields whose next recorded set is an import's, by client (ADR s96 §9). */
const importSets = new WeakMap<RbookDatabaseClient, Set<string>>();
const fieldKey = (entity: string, entityId: string, field: string): string =>
  JSON.stringify([entity, entityId, field]);

/**
 * Mark a field so its next recorded set is an import's: its base names IMPORT_BASE, for the root it
 * never saw, instead of the heads this copy holds, and the merge then keeps both values.
 */
export function markImportSet(
  client: RbookDatabaseClient,
  entity: string,
  entityId: string,
  field: string
): void {
  const marks = importSets.get(client) ?? new Set<string>();
  marks.add(fieldKey(entity, entityId, field));
  importSets.set(client, marks);
}

/** Drop every mark the import left, when its write ends: a capture that appended consumes none. */
export function clearImportSets(client: RbookDatabaseClient): void {
  importSets.delete(client);
}

function takesImportBase(client: RbookDatabaseClient, change: RecordedChange): boolean {
  if (change.kind !== 'set' || !change.entityId || !change.field) return false;
  return (
    importSets.get(client)?.delete(fieldKey(change.entity, change.entityId, change.field)) ?? false
  );
}

function heads(client: RbookDatabaseClient, change: RecordedChange): string[] {
  if (!change.entityId) return [];
  const rows = client.getMany<{ change_id: string }>(
    'SELECT change_id FROM record_heads WHERE entity = ? AND entity_id = ? AND field = ? ORDER BY change_id',
    [change.entity, change.entityId, change.field ?? '']
  );
  if (!rows.success) throw new Error(rows.error?.message ?? 'the heads could not be read');
  return (rows.data ?? []).map((row) => row.change_id);
}

/**
 * s96-m12: the appends a replace of an append field covers, which are every live one: the text it
 * replaces holds them, so a merge never adds them again after it (ADR s96 §5).
 */
function coveredAppends(client: RbookDatabaseClient, change: RecordedChange): string[] {
  if (!change.entityId || !change.field || (change.kind !== 'set' && change.kind !== 'settle'))
    return [];
  const classes = RECORD_COLUMNS[change.entity as SharedTable];
  if (!classes?.appends.includes(change.field) && !classes?.arrayAppends.includes(change.field))
    return [];
  const appends = client.getMany<{ change_id: string; txn_id: string }>(
    "SELECT change_id, txn_id FROM record_changes WHERE entity = ? AND entity_id = ? AND field = ? AND kind = 'append' ORDER BY change_id",
    [change.entity, change.entityId, change.field]
  );
  if (!appends.success) throw new Error(appends.error?.message ?? 'the appends could not be read');
  if (!appends.data?.length) return [];
  const ctx = mergeContext(client);
  return appends.data
    .filter((append) => txnStanding(client, ctx, append.txn_id).state === 'live')
    .map((append) => append.change_id);
}

/**
 * Write one transaction's changes to the log: each takes the copy's next sequence and the
 * transaction's clock reading, names the heads it saw in `base`, and becomes its field's head.
 * An append leaves the heads, since appends merge as a set (ADR s96 §5).
 */
export function recordChanges(
  client: RbookDatabaseClient,
  txnId: string,
  changes: readonly RecordedChange[],
  author: { readonly name: string | null; readonly userId: string | null } = authorForWrite(client)
): void {
  if (changes.length === 0) return;
  // Read under the write lock: another process may have re-identified the copy since it opened.
  const identity = readReplicaIdentity(client, { fresh: true });
  if (!identity) throw new Error('Only a copy of a shared record keeps a change log.');
  const projectId = recordedProjectId(client);
  const hlc = transactionHlc(client, txnId);
  const firstSeq = takeReplicaSeqs(client, changes.length);
  changes.forEach((change, index) => {
    const changeId = mintId();
    const base =
      change.kind === 'append' || change.kind === 'create'
        ? []
        : takesImportBase(client, change)
          ? [IMPORT_BASE]
          : [...heads(client, change), ...(change.covers ?? coveredAppends(client, change))];
    run(
      client,
      `INSERT INTO record_changes (change_id, txn_id, project_id, replica_id, replica_seq, author_name,
         author_user_id, hlc, protocol_version, kind, entity, entity_id, field, value, base)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        changeId,
        txnId,
        projectId,
        identity.replicaId,
        firstSeq + index,
        author.name,
        author.userId,
        hlc,
        PROTOCOL_VERSION,
        change.kind,
        change.entity,
        change.entityId,
        change.field,
        change.value,
        JSON.stringify(base),
      ]
    );
    // s96-m12: heads are kept for what merges as a field, a set or settle and a link's state; a
    // verdict, a membership change or the baseline is no field, and no copy merges it as one.
    if (change.entityId && HEAD_KINDS.has(change.kind)) {
      const field = change.field ?? '';
      run(client, 'DELETE FROM record_heads WHERE entity = ? AND entity_id = ? AND field = ?', [
        change.entity,
        change.entityId,
        field,
      ]);
      run(
        client,
        'INSERT INTO record_heads (entity, entity_id, field, change_id) VALUES (?, ?, ?, ?)',
        [change.entity, change.entityId, field, changeId]
      );
    }
  });
}

/**
 * `reasonbook repair --guard` (ADR s96 §6), inside the caller's write transaction: the token and
 * the stage are made again if lost, what was staged is recorded as changes with no author, and the
 * guards are rebuilt with the token cleared. Returns how many changes it recorded.
 */
export function repairRecordGuards(client: RbookDatabaseClient): number {
  runScript(client, TRANSIENT_TABLES_SQL);
  const drafts = draftsFromStage(client, recordedProjectId(client));
  // Whoever repairs did not make these changes, so they carry no author: "author not recorded".
  recordChanges(client, transactionId(client), drafts, { name: null, userId: null });
  run(client, `DELETE FROM ${STAGE_TABLE}`);
  rebuildRecordGuards(
    (sql) => runScript(client, sql),
    <T>(sql: string) => {
      const rows = client.getMany<T>(sql);
      if (!rows.success) throw new Error(rows.error?.message ?? `could not read: ${sql}`);
      return rows.data ?? [];
    }
  );
  return drafts.length;
}
