// ABOUTME: Sprint 69 m03 — the single shared helper every firehose-table INSERT
// ABOUTME: Routes through to stamp the 6 per-row genesis columns (s68 ADR §1/§2, as
// amended s69-m03). Centralizing the stamp turns the ~21-site call-site sweep
// into mechanical splices and gives the AST coverage test a sharp target.

import type Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import type { RbookDatabaseClient } from './client';
import { GENESIS_TYPE_BY_TABLE, type FirehoseTable } from '../../types/event-types';
import {
  ensureAuthorNameColumns,
  ensureAuthorNamespaceColumns,
  ensureFirehoseEventColumns,
} from './schema-migrations';
import { isRecordedStore } from './record-guards';
import { allocateRowId, takeReplicaSeq } from './replica-identity';
import { replicaWriteRefusal } from './replica-check';
import { authorForWrite, userAuthorForWrite, type WriteAuthor } from './author-name';
export { getProjectId } from './project-id';

/**
 * s96-m01 (ADR s96 §2): one monotonic factory per process, so ids minted in one millisecond still
 * sort in minting order; plain `ulid(now)` orders about half of such pairs backwards (fact 30).
 */
const mintStableId = monotonicFactory();

/** The 6 genesis columns, in canonical order, stamped on every firehose row. */
export const GENESIS_COLUMN_NAMES = [
  'project_id',
  'stable_event_id',
  'occurred_at',
  'origin_seq',
  'event_type',
  'schema_version',
] as const;

/** s96-m02 (ADR s96 §10): who wrote a row, stamped with the genesis columns where a table has them. */
const AUTHOR_COLUMNS = ['author_name', 'author_user_id'] as const;
type AuthorColumn = (typeof AUTHOR_COLUMNS)[number];

const authorColumnsSeen = new WeakMap<RbookDatabaseClient, Map<string, readonly AuthorColumn[]>>();

/** The author columns `table` has, read once per client and table. */
function authorColumnsOf(client: RbookDatabaseClient, table: string): readonly AuthorColumn[] {
  let tables = authorColumnsSeen.get(client);
  if (!tables) authorColumnsSeen.set(client, (tables = new Map()));
  let found = tables.get(table);
  if (!found) {
    const info = client.getMany<{ name: string }>(`PRAGMA table_info('${table}')`, []);
    const names = new Set(info.success ? (info.data ?? []).map((column) => column.name) : []);
    found = AUTHOR_COLUMNS.filter((column) => names.has(column));
    tables.set(table, found);
  }
  return found;
}

function authorValues(columns: readonly AuthorColumn[], author: WriteAuthor): unknown[] {
  return columns.map((column) => (column === 'author_name' ? author.name : author.userId));
}

export interface GenesisStamp {
  /** Column names to splice into the INSERT column list. */
  columns: readonly string[];
  /** '?, ?, …' placeholders matching `columns`, to splice into VALUES. */
  placeholders: string;
  /** Bound values matching `columns`, to append to the params array. */
  values: unknown[];
}

/**
 * s84-m03 — PRAGMA column-presence guard. True when `table` has `column`. Used by the
 * foreign-row read-time framing surfaces to read a row's `project_id` ONLY when the
 * column exists, so an ancient/un-migrated store (no `project_id` column) degrades to a
 * NULL row project_id (→ rendered bare) instead of throwing on `SELECT project_id`.
 * Never throws — a failed PRAGMA returns false. Mirrors the existing local copies in
 * decision-memory.ts / rbook-context-view.ts, DRY'd for the ~6 m03 SELECT surfaces.
 */
export function tableHasColumn(
  client: RbookDatabaseClient,
  table: string,
  column: string
): boolean {
  const res = client.getMany<{ name: string }>(`PRAGMA table_info('${table}')`, []);
  return res.success && !!res.data?.some((c) => c.name === column);
}

/**
 * Produce the 6 genesis-stamp columns for a row INSERT into a firehose table
 * (s68 ADR §1 + §2, as amended s69-m03). Splice `columns` into the INSERT column
 * list, `placeholders` into VALUES, and append `values` to the params array:
 *
 * ```ts
 * const pid = getProjectId(client);
 * const g = genesisColumns(client, 'strategic_decisions', pid);
 * client.execute(
 *   `INSERT INTO strategic_decisions (decision_text, created_at, ${g.columns.join(', ')})
 *    VALUES (?, ?, ${g.placeholders})`,
 *   [text, now, ...g.values]
 * );
 * ```
 *
 * Stamps: `project_id` (passed in), `stable_event_id` (fresh monotonic ULID, app-side —
 * SQLite has no ULID function), `occurred_at` (now ms), `origin_seq` (per-table
 * MAX+1; synchronous single-writer per process), `event_type` (the table's
 * genesis verb from GENESIS_TYPE_BY_TABLE — explicit, no DEFAULT), `schema_version`
 * (1).
 *
 * Lazily runs the firehose column migration (idempotent, fast metadata-marker
 * short-circuit) so the columns exist before the INSERT — the point-of-use ensure
 * pattern the rest of the codebase uses. A handler that wraps its genesis write in
 * a transaction must call `ensureFirehoseEventColumns` at its entry (before the
 * transaction) instead, because the 12-step rebuild cannot run inside one; the
 * migration's own loud abort surfaces that case.
 *
 * @param stampedAt injectable clock (defaults to Date.now(), read after the migrations) for
 *   deterministic tests.
 */
/**
 * The point-of-use migrations a genesis stamp needs: idempotent, and a metadata-marker read once
 * applied. s96-m03: the change helper runs them before it takes its token, since a migration never
 * holds it (ADR s96 §4).
 */
export function ensureGenesisSchema(client: RbookDatabaseClient, table?: FirehoseTable): void {
  // Lazy point-of-use migration (idempotent; fast metadata-marker no-op once applied).
  ensureFirehoseEventColumns(client);
  // s69-m04 — settle the author_* namespace (session_id→author_session_id rename +
  // nullable author_user_id/user_id) at the same point of use. Marker-gated no-op
  // once applied; all transaction-safe ALTERs (no 12-step rebuild), so it is safe
  // here even when the caller is mid-transaction (e.g. sprint closeout snapshots).
  ensureAuthorNamespaceColumns(client);
  // s96-m02 — author_name, under its own marker; plain ALTERs as well, safe mid-transaction.
  ensureAuthorNameColumns(client);
  if (!table) return;

  // A store-wide marker covers only the tables present when it was written. Constraints and
  // next steps may be created later; never return a stamp their INSERT cannot persist.
  const required = [...GENESIS_COLUMN_NAMES, ...AUTHOR_COLUMNS];
  const missingColumns = (): string[] => {
    const info = client.getMany<{ name: string }>(`PRAGMA table_info('${table}')`, []);
    if (!info.success)
      throw new Error(`Could not inspect ${table}'s genesis columns: ${info.error?.message}`);
    const present = new Set((info.data ?? []).map((column) => column.name));
    // Reuse this schema read for the author stamp below.
    let tables = authorColumnsSeen.get(client);
    if (!tables) authorColumnsSeen.set(client, (tables = new Map()));
    tables.set(
      table,
      AUTHOR_COLUMNS.filter((column) => present.has(column))
    );
    return required.filter((column) => !present.has(column));
  };
  if (!missingColumns().length) return;
  if (client.inTransaction)
    throw new Error(`Prepare ${table}'s genesis schema before starting a transaction.`);
  ensureFirehoseEventColumns(client, { everyTable: true });
  ensureAuthorNamespaceColumns(client, { everyTable: true });
  ensureAuthorNameColumns(client, { everyTable: true });
  authorColumnsSeen.delete(client);
  const missing = missingColumns();
  if (missing.length)
    throw new Error(`Could not prepare ${table}'s genesis schema; missing ${missing.join(', ')}.`);
}

export function genesisColumns(
  client: RbookDatabaseClient,
  table: FirehoseTable,
  projectId: string,
  stampedAt?: number
): GenesisStamp {
  const eventType = GENESIS_TYPE_BY_TABLE[table];
  if (!eventType) {
    throw new Error(`genesisColumns: "${table}" is not a firehose table with a genesis verb.`);
  }
  ensureGenesisSchema(client, table);
  // The row's time is taken once the migrations have run, so a row written by the call that began
  // recording authors is never older than that start (`author_names_since`).
  const now = stampedAt ?? Date.now();

  const seqRow = client.getOne<{ next: number }>(
    `SELECT COALESCE(MAX(origin_seq), 0) + 1 AS next FROM ${table}`,
    []
  );
  const originSeq = seqRow.success && seqRow.data ? seqRow.data.next : 1;

  // s96-m01 (ADR s96 §3): on a shared store a new decision, learning, next step or constraint takes
  // the next id in this copy's block, and every create takes the copy's next sequence. An unshared
  // store gets exactly the columns it always did.
  // A copy whose write will be refused takes nothing, so a refused attempt never moves it forward.
  const refused = replicaWriteRefusal(client) !== null;
  const id = refused ? undefined : allocateRowId(client, table);
  // s96-m03: on a recorded store the change helper takes one sequence per change instead.
  if (!refused && !isRecordedStore(client)) takeReplicaSeq(client, table);
  // s96-m02: stamp the author columns verified by this table's schema preparation.
  const authorColumns = authorColumnsOf(client, table);
  const columns = [...GENESIS_COLUMN_NAMES, ...authorColumns, ...(id === undefined ? [] : ['id'])];
  return {
    columns,
    placeholders: columns.map(() => '?').join(', '),
    values: [
      projectId,
      mintStableId(now),
      now,
      originSeq,
      eventType,
      1,
      ...(authorColumns.length ? authorValues(authorColumns, authorForWrite(client)) : []),
      ...(id === undefined ? [] : [id]),
    ],
  };
}

/**
 * s96-m01: the genesis stamp for an INSERT through a raw connection, as project init writes its first
 * sprint and missions before any client exists. Stamped at the insert, a row keeps one stable id
 * on every copy; left for the lazy backfill, each copy of a store zipped before its first write
 * would mint a different one (inventory §3.3). Empty when the table predates the genesis columns,
 * so an old store's insert stays as it was and its migration stamps the row later.
 */
export function rawGenesisColumns(
  db: Database.Database,
  table: FirehoseTable,
  projectId: string,
  now: number = Date.now()
): GenesisStamp {
  const present = new Set(
    (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  if (!GENESIS_COLUMN_NAMES.every((name) => present.has(name)))
    return { columns: [], placeholders: '', values: [] };
  const { next } = db
    .prepare(`SELECT COALESCE(MAX(origin_seq), 0) + 1 AS next FROM ${table}`)
    .get() as { next: number };
  // s96-m02: a raw write has no copy name to consult; the user's name or the sign-in's.
  const authorColumns = AUTHOR_COLUMNS.filter((column) => present.has(column));
  const columns = [...GENESIS_COLUMN_NAMES, ...authorColumns];
  return {
    columns,
    placeholders: columns.map(() => '?').join(', '),
    values: [
      projectId,
      mintStableId(now),
      now,
      next,
      GENESIS_TYPE_BY_TABLE[table],
      1,
      ...(authorColumns.length ? authorValues(authorColumns, userAuthorForWrite()) : []),
    ],
  };
}
