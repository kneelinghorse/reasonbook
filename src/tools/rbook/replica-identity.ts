// SPDX-License-Identifier: Apache-2.0
// ABOUTME: One identity on every copy of a shared record (ADR s96 §2, §3, §9): each copy's replica id, number
// ABOUTME: block and sequence, ids allocated in the block under the write lock, and this machine's mark.

import { statSync } from 'fs';
import path from 'path';
import { monotonicFactory } from 'ulid';
import { LEGACY } from '../../intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { RbookDatabaseClient } from './client';
import { RBOOK_ERROR_CODES } from './errors';
import { markPeerSessions } from './peer-sessions';
import { sharingSchemaBehind } from './schema-migrations';
import type { RbookToolError, RbookToolResult } from './types';

/**
 * The shared record's refusal codes. They live here rather than in errors.ts, which the retrieval
 * contract seals as a parser source (tests/fixtures/retrieval-quality-contract.json).
 */
export const REPLICA_ERROR_CODES = {
  NOT_JOINED: 'REPLICA_NOT_JOINED',
  RESTORED: 'REPLICA_RESTORED',
  SECOND_COPY: 'REPLICA_SECOND_COPY',
  UNCHECKED: 'REPLICA_UNCHECKED',
  BLOCK_FULL: 'REPLICA_BLOCK_FULL',
  /** s96-m03 (ADR s96 §6): the guards, their column lists or the token table are not intact. */
  GUARD_BROKEN: 'RECORD_GUARD_BROKEN',
  /** s96-m03: a write the change log cannot record, such as deleting a shared row. */
  WRITE_REFUSED: 'RECORD_WRITE_REFUSED',
  /** s96-m12 (ADR s96 §7): a replica's sequence slot holds a different change on the two copies. */
  SLOT_CLASH: 'RECORD_SLOT_CLASH',
  /** s96-m12 (ADR s96 §5): a plain write to a field whose concurrent values are not settled. */
  FIELD_IN_CONFLICT: 'FIELD_IN_CONFLICT',
  /** s96-m13 (ADR s96 §7): two copies that cannot exchange: another project, protocol or star. */
  EXCHANGE_REFUSED: 'RECORD_EXCHANGE_REFUSED',
  /** s96-m13 (ADR s96 §7): two replicas hold one block. */
  BLOCK_CLASH: 'RECORD_BLOCK_CLASH',
  /** s96-m13 (ADR s96 §7, §8): the authority's own stream differs between two copies. */
  AUTHORITY_DIFFERS: 'RECORD_AUTHORITY_DIFFERS',
} as const;
const REPLICA_CODES: ReadonlySet<string> = new Set(Object.values(REPLICA_ERROR_CODES));

/**
 * A refusal thrown from inside a write, so the answer carries its own code and remedy rather than
 * a failed query's (the client's error handler passes it through).
 */
export class ReplicaRefusal extends Error {
  constructor(readonly refusal: RbookToolError) {
    super(refusal.message);
    this.name = 'ReplicaRefusal';
  }
}

/** The refusal a thrown error carries, if it is one of the shared record's; duck-typed across realms. */
export function carriedRefusal(error: unknown): RbookToolError | null {
  const refusal = (error as { refusal?: RbookToolError } | null)?.refusal;
  return refusal && REPLICA_CODES.has(refusal.code) ? refusal : null;
}

/** Whether an answer's error is one of the shared record's refusals. */
export function isReplicaRefusal(error: RbookToolError | undefined): boolean {
  return error !== undefined && REPLICA_CODES.has(error.code);
}

/** Block k holds ids k × 1,000,000 + 1 through (k + 1) × 1,000,000 (ADR s96 §3). */
export const BLOCK_SIZE = 1_000_000;

/** The tables a shared record logs (ADR s96 §4); a write to one is refused on an unconfirmed copy. */
export const SHARED_TABLES: ReadonlySet<string> = new Set([
  'strategic_decisions',
  'learnings',
  'missions',
  'sprints',
  'sessions',
  'next_steps',
  'constraints',
  'mission_dependencies',
  'session_missions',
]);

/** The integer-keyed shared tables, whose new rows take ids in the copy's block (ADR s96 §3). */
export const BLOCK_TABLES: ReadonlySet<string> = new Set([
  'strategic_decisions',
  'learnings',
  'next_steps',
  'constraints',
]);

/** Per-copy metadata keys: never recorded, never shared (ADR s96 §4). */
export const REPLICA_KEYS = {
  id: 'replica_id',
  block: 'replica_block',
  seq: 'replica_seq',
  /** s96-m02: the author name an invite gave this copy (ADR s96 §10); s96-m13's join sets it. */
  author: 'replica_author',
} as const;
const KEYS = REPLICA_KEYS;

export interface ReplicaIdentity {
  readonly replicaId: string;
  readonly block: number;
}

/** The store's metadata could not be read, so whether it is a copy of a shared record is unknown. */
export class StoreUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreUnreadableError';
  }
}

const identities = new WeakMap<RbookDatabaseClient, ReplicaIdentity | null>();
/** Clients whose open transaction took a sequence, so its commit moves this machine's mark. */
const tookSeq = new WeakSet<RbookDatabaseClient>();
const mintReplicaId = monotonicFactory();

export function blockRange(block: number): { readonly low: number; readonly high: number } {
  return { low: block * BLOCK_SIZE + 1, high: (block + 1) * BLOCK_SIZE };
}

/** The project root a store file sits in (`<root>/rbook/db/rbook.sqlite`), or its own folder. */
export function storeFolder(dbPath: string): string {
  const db = path.dirname(path.resolve(dbPath));
  const record = path.dirname(db);
  return path.basename(db) === 'db' &&
    ['rbook', LEGACY.recordDirectory].includes(path.basename(record))
    ? path.dirname(record)
    : db;
}

export function fileIdentity(dbPath: string): { readonly device: number; readonly inode: number } {
  const stat = statSync(dbPath);
  return { device: stat.dev, inode: stat.ino };
}

function metadataValue(client: RbookDatabaseClient, key: string): string | null {
  const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  if (!row.success) {
    // A store with no metadata table predates sharing, so it is unshared; any other failure is loud.
    if (row.error?.code === RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH) return null;
    throw new StoreUnreadableError(
      `metadata ${key} could not be read: ${row.error?.message ?? 'unknown error'}`
    );
  }
  const value = row.data?.value?.trim();
  return value ? value : null;
}

/**
 * This copy's replica identity, or null for an unshared store, read once per client unless `fresh`.
 * A store holding a replica id with no valid block is refused rather than read as unshared.
 */
export function readReplicaIdentity(
  client: RbookDatabaseClient,
  options: { readonly fresh?: boolean } = {}
): ReplicaIdentity | null {
  if (!options.fresh && identities.has(client)) return identities.get(client) ?? null;
  const replicaId = metadataValue(client, KEYS.id);
  let identity: ReplicaIdentity | null = null;
  if (replicaId) {
    // Number(null) is 0, so a missing block would read as block 0; it is damage, not block 0.
    const stored = metadataValue(client, KEYS.block);
    const block = stored === null ? NaN : Number(stored);
    if (!Number.isInteger(block) || block < 0)
      throw new Error(`replica ${replicaId} has no valid number block; its identity is damaged.`);
    identity = { replicaId, block };
  }
  identities.set(client, identity);
  return identity;
}

/** Forget a client's identity, so its next read is fresh (after this process re-identifies it). */
export function forgetReplicaIdentity(client: RbookDatabaseClient): void {
  identities.delete(client);
}

export function recordedProjectId(client: RbookDatabaseClient): string {
  const projectId = metadataValue(client, 'project_id');
  if (!projectId) throw new Error('A shared record needs a recorded project_id.');
  return projectId;
}

export function currentSeq(client: RbookDatabaseClient): number {
  const seq = Number(metadataValue(client, KEYS.seq) ?? 0);
  if (!Number.isInteger(seq) || seq < 0) throw new Error(`replica_seq is not a sequence: ${seq}`);
  return seq;
}

/**
 * One per-copy key; the schema-version census reads each caller's key, so they are named below and
 * in replica-copy-keys.ts (s96-m13), its one other caller.
 */
export function writeReplicaKey(client: RbookDatabaseClient, key: string, value: string): void {
  const result = client.execute(
    'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
  if (!result.success) throw new Error(result.error?.message ?? `${key} was not written`);
}

function writeIdentity(client: RbookDatabaseClient, identity: ReplicaIdentity, seq: number): void {
  const written = client.writeTransaction(() => {
    writeReplicaKey(client, REPLICA_KEYS.id, identity.replicaId);
    writeReplicaKey(client, REPLICA_KEYS.block, String(identity.block));
    writeReplicaKey(client, REPLICA_KEYS.seq, String(seq));
  });
  if (!written.success)
    throw new Error(written.error?.message ?? 'The replica identity was not written.');
}

/**
 * Give this store a replica identity in `block` and bind it to this folder on this machine.
 * Internal: s96-m03's share step calls it for the first authority (block 0), and s96-m13's join for
 * a member, with the block the authority assigns.
 */
export function establishReplica(
  client: RbookDatabaseClient,
  input: { readonly block: number; readonly replicaId?: string; readonly previous?: string },
  registry: ProjectGraphRegistry = ProjectGraphRegistry.getInstance()
): ReplicaIdentity {
  if (!Number.isInteger(input.block) || input.block < 0)
    throw new Error(`A number block is a whole number from 0: ${input.block}`);
  const behind = sharingSchemaBehind(client);
  if (behind)
    throw new Error(
      `This store is not ready to share: ${behind}. prepareForSharing makes it ready, and a copy takes its identity only after that.`
    );
  const identity = { replicaId: input.replicaId ?? mintReplicaId(), block: input.block };
  const projectId = recordedProjectId(client);
  writeIdentity(client, identity, 0);
  // s96-m12: the sessions still open on the copy this store came from stay that copy's. A copy that
  // re-identifies keeps every session as it was, classified when the store first took an identity.
  if (input.previous === undefined) markPeerSessions(client, identity.replicaId);
  registry.bindReplica({
    replicaId: identity.replicaId,
    projectId,
    storePath: storeFolder(client.path),
    ...fileIdentity(client.path),
    seqMark: 0,
  });
  identities.set(client, identity);
  return identity;
}

/** Whether this store is a copy of a shared record; a damaged identity counts, so it fails closed. */
export function isSharedStore(client: RbookDatabaseClient): boolean {
  try {
    return readReplicaIdentity(client) !== null;
  } catch {
    return true;
  }
}

class RolledBack extends Error {}

/**
 * Run one create of a shared table under the write lock on a shared store, so its id and sequence
 * roll back with a failed insert. An unshared store runs it exactly as it always did.
 */
export function sharedStoreWrite<T>(
  client: RbookDatabaseClient,
  write: () => RbookToolResult<T>
): RbookToolResult<T> {
  if (!isSharedStore(client)) return write();
  let inner: RbookToolResult<T> | undefined;
  const outer = client.writeTransaction(() => {
    inner = write();
    if (!inner.success) throw new RolledBack();
  });
  if (inner && !inner.success) return inner;
  if (!outer.success || !inner) return outer as unknown as RbookToolResult<T>;
  return inner;
}

/** ADR s96 §3: a shared store numbers its creates under BEGIN IMMEDIATE, never a deferred lock. */
function requireWriteTransaction(client: RbookDatabaseClient, table: string): void {
  if (!client.inWriteTransaction)
    throw new Error(
      `${table}: a shared record numbers its creates under the store's write lock, so this insert must run in a write transaction.`
    );
}

/**
 * The id for a new row of `table` in this copy's block (ADR s96 §3), under the caller's write
 * transaction; undefined on an unshared store, which keeps SQLite's own numbering.
 */
export function allocateRowId(client: RbookDatabaseClient, table: string): number | undefined {
  const identity = readReplicaIdentity(client);
  if (!identity || !BLOCK_TABLES.has(table)) return undefined;
  requireWriteTransaction(client, table);
  const { low, high } = blockRange(identity.block);
  const top = client.getOne<{ top: number | null }>(
    `SELECT MAX(id) AS top FROM ${table} WHERE id BETWEEN ? AND ?`,
    [low, high]
  );
  if (!top.success) throw new Error(top.error?.message ?? `${table}: the block could not be read`);
  const next = (top.data?.top ?? low - 1) + 1;
  if (next > high)
    throw new ReplicaRefusal({
      code: REPLICA_ERROR_CODES.BLOCK_FULL,
      message: `${table}: number block ${identity.block} (${low} to ${high}) is full, so this copy cannot number another row in it.`,
      suggestion:
        'Sync the copy so it re-identifies; it then numbers its new records in a fresh block.',
    });
  return next;
}

/**
 * Take the next replica sequence for a create of a shared table, in one statement under the write
 * lock, so two writers never share one and a failed create rolls its sequence back; undefined on an
 * unshared store. s96-m03 extends it to every recorded change.
 */
export function takeReplicaSeq(client: RbookDatabaseClient, table: string): number | undefined {
  const identity = readReplicaIdentity(client);
  if (!identity || !SHARED_TABLES.has(table)) return undefined;
  requireWriteTransaction(client, table);
  const taken = client.getOne<{ value: string }>(
    `UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ? RETURNING value`,
    [KEYS.seq]
  );
  const seq = Number(taken.data?.value);
  if (!taken.success || !Number.isInteger(seq))
    throw new Error(taken.error?.message ?? 'The replica sequence could not be taken.');
  tookSeq.add(client);
  return seq;
}

/**
 * s96-m03: take the next `count` replica sequences for the changes one transaction records, in one
 * statement under the write lock, so the change log's sequence stays contiguous (ADR s96 §4).
 * Returns the first; a rolled-back transaction gives them back.
 */
export function takeReplicaSeqs(client: RbookDatabaseClient, count: number): number {
  if (!readReplicaIdentity(client))
    throw new Error('Only a copy of a shared record takes sequences.');
  requireWriteTransaction(client, 'record_changes');
  const taken = client.getOne<{ value: string }>(
    `UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = 'replica_seq' RETURNING value`,
    [count]
  );
  const last = Number(taken.data?.value);
  if (!taken.success || !Number.isInteger(last))
    throw new Error(taken.error?.message ?? 'The replica sequence could not be taken.');
  tookSeq.add(client);
  return last - count + 1;
}

/**
 * After the outermost commit: this machine's mark follows the sequence the store now holds, read
 * back after the commit, so a rolled-back savepoint can never leave the mark ahead of the file.
 * A failure leaves the mark behind, the safe side, and is reported on stderr.
 */
export function flushReplicaMark(client: RbookDatabaseClient): void {
  if (!tookSeq.has(client)) return;
  tookSeq.delete(client);
  try {
    const identity = readReplicaIdentity(client, { fresh: true });
    if (identity)
      ProjectGraphRegistry.getInstance().advanceReplicaMark(identity.replicaId, currentSeq(client));
  } catch (error) {
    process.stderr.write(
      `[Reasonbook] this machine could not record how far the copy at ${storeFolder(client.path)} has written: ${
        error instanceof Error ? error.message : String(error)
      }. Its next write's check moves the mark forward.\n`
    );
  }
}

/** After a rollback: the sequence the transaction took was never written. */
export function discardReplicaMark(client: RbookDatabaseClient): void {
  tookSeq.delete(client);
}
