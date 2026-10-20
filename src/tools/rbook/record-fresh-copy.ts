// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A fresh store holding only a shared record (s97-m09, design §R1): our own schema, each shared table's rows
// ABOUTME: with their recorded columns, the change log and the identity keys, read from a source opened as data only.

import Database from 'better-sqlite3';
import { existsSync, renameSync, rmSync } from 'fs';
import { RbookDatabaseClient } from './client';
import { DECISION_SHAPE_MARKER } from './decision-shape-migration';
import { createError, createSuccess } from './errors';
import { attachWarnings } from './format-warnings';
import { CONFIRMED_KEY } from './record-authority';
import { HLC_KEY, PROTOCOL_VERSION } from './record-changes';
import { IDENTITY_KEYS, RECORD_COLUMNS, RECORDED_TABLES } from './record-columns';
import { installRecordGuards, LOG_TABLES } from './record-guards';
import { changeProblem, readingProblem, readingTime, runsAhead } from './record-intake';
import { mergeContext, txnStanding, type LoggedChange } from './record-standing';
import { COPY_KEYS, writeCopyKey } from './replica-copy-keys';
import { REPLICA_ERROR_CODES, REPLICA_KEYS } from './replica-identity';
import { RBOOK_SCHEMA } from './schema';
import { AUTHOR_NAMES_SINCE_KEY } from './schema-migrations';
import { prepareForSharing, type SharingReadiness } from './sharing-preconditions';
import type { RbookToolResult } from './types';

/** A source that is not a copy of a shared record this version can read; nothing was built. */
export class FreshCopyRefused extends Error {
  /** What the person can do about it, when it is not uploading the owner's own live copy again. */
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'FreshCopyRefused';
    this.remedy = remedy;
  }
}

export interface FreshCopy {
  readonly projectId: string;
  /** The source copy's own replica, whose identity the fresh copy keeps until it joins. */
  readonly replicaId: string;
  readonly rows: Readonly<Record<string, number>>;
  readonly changes: number;
  /** Rows naming a row the copy does not hold, under our schema's foreign keys; kept as the source had them. */
  readonly danglingReferences: number;
  /** What the schema's own migrations said as they made the copy's schema current. */
  readonly warnings: readonly string[];
}

/** The tables a fresh copy is read from, each checked to be a plain table before any is read. */
const SOURCE_TABLES = ['metadata', 'contexts', ...RECORDED_TABLES, ...LOG_TABLES] as const;

/** The log tables copied as they are; record_txn_state is worked out again, never copied. */
const COPIED_LOG_TABLES = [
  ...LOG_TABLES.filter((table) => table !== 'record_changes'),
  'record_aliases',
];
const LOGGED = [
  'change_id',
  'txn_id',
  'project_id',
  'replica_id',
  'replica_seq',
  'author_name',
  'author_user_id',
  'hlc',
  'protocol_version',
  'kind',
  'entity',
  'entity_id',
  'field',
  'value',
  'base',
] as const;
/** The metadata a copy of the record needs: the project's own keys, its identity, clock and moves. */
const METADATA_KEYS = [
  'project_id',
  'created_at',
  ...IDENTITY_KEYS.metadata,
  REPLICA_KEYS.id,
  REPLICA_KEYS.block,
  REPLICA_KEYS.seq,
  HLC_KEY,
  CONFIRMED_KEY,
  AUTHOR_NAMES_SINCE_KEY,
];
/** The working-memory documents every store holds, empty in a fresh copy: they are each copy's own. */
const OWN_CONTEXTS: Readonly<Record<string, string>> = {
  master_context: 'rbook/context/master_context.json',
  project_context: 'rbook/context/project_context.json',
};

/**
 * Drop the search index our schema and its migrations make: a copy carries none, and the member's
 * own server builds it on first use (fts5-retriever.ts ensures it). Any other index left fails loud.
 */
function dropSearchIndex(target: Target): void {
  for (const { name } of target
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'decisions\\_fts\\_%' ESCAPE '\\'"
    )
    .all() as Array<{ name: string }>)
    target.exec(`DROP TRIGGER "${name}"`);
  target.exec('DROP TABLE IF EXISTS decisions_fts');
  // The decision schema counts the index as its own: without the marker, the copy's first decision
  // write makes both again, as on any store that predates them (decision-shape-migration.ts).
  target.prepare('DELETE FROM metadata WHERE key = ?').run(DECISION_SHAPE_MARKER);
  const left = target
    .prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%VIRTUAL TABLE%'")
    .all() as Array<{ name: string }>;
  if (left.length)
    throw new Error(
      `A fresh copy holds a search index it should not: ${left.map((t) => t.name).join(', ')}.`
    );
}

type Row = Record<string, unknown>;

/**
 * The source, opened read-only as data: no client, no extension, and trusted_schema off, so a
 * function its schema names cannot run (design §R1: an upload's schema, triggers and views are
 * never run as code). Each table read is checked to be a plain table without generated columns.
 */
class Source {
  private readonly db: Database.Database;
  constructor(file: string) {
    if (!existsSync(file)) throw new FreshCopyRefused(`There is no store at ${file}.`);
    try {
      this.db = new Database(file, { readonly: true, fileMustExist: true });
      this.db.pragma('trusted_schema = OFF');
      const integrity = this.db.pragma('quick_check', { simple: true });
      if (integrity !== 'ok') throw new Error(String(integrity));
    } catch (error) {
      throw new FreshCopyRefused(
        `The store at ${file} cannot be read as a Reasonbook store: ${error instanceof Error ? error.message : String(error)}.`
      );
    }
  }
  /** The columns of a plain table, or null when it is absent; anything else refuses the source. */
  columns(table: string): Set<string> | null {
    const object = this.db
      .prepare('SELECT type FROM sqlite_master WHERE name = ? COLLATE NOCASE')
      .get(table) as { type: string } | undefined;
    if (!object) return null;
    if (object.type !== 'table')
      throw new FreshCopyRefused(`${table} is a ${object.type} in that store, not a table.`);
    const info = this.db.prepare(`PRAGMA table_xinfo("${table}")`).all() as Array<{
      name: string;
      hidden: number;
    }>;
    if (info.some((column) => column.hidden === 2 || column.hidden === 3))
      throw new FreshCopyRefused(`${table} has computed columns in that store, which no copy has.`);
    return new Set(info.map((column) => column.name));
  }
  required(table: string): Set<string> {
    const columns = this.columns(table);
    if (!columns) throw new FreshCopyRefused(`That store has no ${table} table.`);
    return columns;
  }
  rows(sql: string, params: unknown[] = []): IterableIterator<Row> {
    return this.db.prepare(sql).iterate(...params) as IterableIterator<Row>;
  }
  all(sql: string, params: unknown[] = []): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  /** Every read runs inside one read transaction, so the copy is of one moment of the source. */
  snapshot<T>(read: () => T): T {
    this.db.exec('BEGIN');
    try {
      return read();
    } finally {
      this.db.exec('COMMIT');
    }
  }
  close(): void {
    this.db.close();
  }
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): void {
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

/**
 * The copy is written through its own plain connection: it is no copy of a shared record until its
 * rows are in, and a client would judge it as one once its identity keys were (replica-check.ts).
 */
type Target = Database.Database;

function insert(target: Target, table: string, row: Row): void {
  const columns = Object.keys(row);
  target
    .prepare(
      `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    )
    .run(...columns.map((column) => row[column]));
}

async function engineClient(file: string): Promise<RbookDatabaseClient> {
  const opened = await RbookDatabaseClient.create({
    dbPath: file,
    registerProject: false,
    replicaCheck: false,
    loadVec: false,
  });
  if (!opened.success || !opened.data)
    throw new Error(opened.error?.message ?? 'the fresh store could not be opened');
  return opened.data;
}

/** The project identity document's recorded and fixed keys; per-copy keys are each copy's own. */
function identityDocument(source: Source): string {
  source.required('contexts');
  const [row] = source.all("SELECT content FROM contexts WHERE id = 'project_identity'");
  let document: Row;
  try {
    document = JSON.parse(String(row?.content)) as Row;
  } catch {
    throw new FreshCopyRefused("That store's project identity is not JSON.");
  }
  if (!document || typeof document !== 'object' || Array.isArray(document))
    throw new FreshCopyRefused("That store's project identity is not a JSON object.");
  const kept = [...IDENTITY_KEYS.document, ...IDENTITY_KEYS.immutable, 'identity_contract_version'];
  return JSON.stringify(
    Object.fromEntries(kept.filter((key) => key in document).map((key) => [key, document[key]]))
  );
}

function copyMetadata(source: Source, target: Target): Map<string, string> {
  source.required('metadata');
  const held = new Map<string, string>();
  for (const row of source.rows(
    `SELECT key, value FROM metadata WHERE key IN (${METADATA_KEYS.map(() => '?').join(', ')})`,
    METADATA_KEYS
  ))
    held.set(String(row.key), String(row.value));
  for (const key of ['project_id', REPLICA_KEYS.id, REPLICA_KEYS.block])
    if (!held.get(key)?.trim())
      throw new FreshCopyRefused(
        `That store holds no ${key}, so it is no copy of a shared record.`
      );
  const write = target.prepare(
    'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
  );
  for (const [key, value] of held) write.run(key, value);
  // Our schema stamps its own creation time; a source that kept none gets none invented for it.
  if (!held.has('created_at'))
    target.prepare("DELETE FROM metadata WHERE key = 'created_at'").run();
  return held;
}

function copyContexts(source: Source, target: Target): void {
  const write = target.prepare(
    'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)'
  );
  const now = new Date().toISOString();
  write.run(
    'project_identity',
    'rbook/contexts/project-identity.json',
    identityDocument(source),
    now
  );
  // A decision names the document it was taken in; each one named is made, empty, as its own.
  const named = source
    .all('SELECT DISTINCT context_id FROM strategic_decisions WHERE context_id IS NOT NULL')
    .map((row) => String(row.context_id));
  for (const id of new Set([...Object.keys(OWN_CONTEXTS), ...named]))
    if (id !== 'project_identity')
      write.run(id, OWN_CONTEXTS[id] ?? `rbook/context/${id}.json`, '{}', now);
}

function copySharedRows(source: Source, target: Target): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of RECORDED_TABLES) {
    const present = source.required(table);
    const classes = RECORD_COLUMNS[table];
    const missing = classes.recorded.filter((column) => !present.has(column));
    if (missing.length)
      throw new FreshCopyRefused(
        `That store's ${table} lacks recorded columns: ${missing.join(', ')}.`
      );
    const columns = [
      ...classes.recorded,
      ...(present.has('origin_seq') && !classes.link ? ['origin_seq'] : []),
    ];
    let count = 0;
    for (const row of source.rows(
      `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${table}" ORDER BY rowid`
    )) {
      insert(target, table, row);
      count += 1;
    }
    counts[table] = count;
  }
  return counts;
}

function copyLog(
  source: Source,
  target: Target,
  projectId: string,
  untrusted: boolean,
  referee: boolean
): number {
  const present = source.required('record_changes');
  const missing = LOGGED.filter((column) => !present.has(column));
  if (missing.length)
    throw new FreshCopyRefused(`That store's change log lacks columns: ${missing.join(', ')}.`);
  let count = 0;
  for (const change of source.rows(
    `SELECT ${LOGGED.join(', ')} FROM record_changes ORDER BY rowid`
  )) {
    // s100-m01 (settled item 6): a log written in a newer record protocol is not this version's to
    // build a copy from: its rows were made by rules this version lacks.
    const version = (change as { protocol_version?: unknown }).protocol_version;
    if (untrusted && typeof version === 'number' && version > PROTOCOL_VERSION)
      throw new FreshCopyRefused(
        `That store's change log is written in record protocol ${version}, newer than this version's ${PROTOCOL_VERSION}, so no copy is built from it.`,
        referee
          ? 'The dashboard upgrades its Reasonbook engine; share the project through it once it has.'
          : 'Upgrade Reasonbook on this machine, then join again: npm install -g @aquex/reasonbook@latest.'
      );
    // An upload is checked change by change; a copy of this host's own referee store is not, since
    // a check its own engine could fail would stop every copy it hands out.
    const problem = untrusted ? changeProblem(change, projectId) : null;
    if (problem) throw new FreshCopyRefused(`That store's change log is not whole: ${problem}.`);
    insert(target, 'record_changes', change);
    count += 1;
  }
  if (!count)
    throw new FreshCopyRefused('That store holds no change log, so it is no shared record.');
  for (const table of COPIED_LOG_TABLES) {
    const present = source.columns(table);
    if (!present) {
      if (table === 'record_aliases') continue;
      throw new FreshCopyRefused(`That store has no ${table} table.`);
    }
    // Only the columns our own table has: a column the source added is not ours to copy.
    const ours = (target.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
      .map((column) => column.name)
      .filter((column) => present.has(column));
    for (const row of source.rows(
      `SELECT ${ours.map((column) => `"${column}"`).join(', ')} FROM "${table}"`
    ))
      insert(target, table, row);
  }
  return count;
}

/** Each transaction's standing, worked out on the copy from its own log, never taken on trust. */
function rebuildStandings(client: RbookDatabaseClient): void {
  const ctx = mergeContext(client);
  const txns = client.getMany<{ txn_id: string }>('SELECT DISTINCT txn_id FROM record_changes');
  if (!txns.success) throw new Error(txns.error?.message ?? 'the transactions could not be read');
  for (const { txn_id } of txns.data ?? []) {
    const standing = txnStanding(client, ctx, txn_id);
    if (standing.state === 'live') continue;
    const [first] =
      client.getMany<Pick<LoggedChange, 'replica_id'>>(
        'SELECT replica_id FROM record_changes WHERE txn_id = ? LIMIT 1',
        [txn_id]
      ).data ?? [];
    run(
      client,
      'INSERT INTO record_txn_state (txn_id, replica_id, state, cause) VALUES (?, ?, ?, ?)',
      [txn_id, first?.replica_id ?? '', standing.state, standing.cause ?? '']
    );
  }
}

/**
 * The moves this copy applies, written as confirmed: a fresh copy that later takes its own identity
 * keeps the chain of owner copies its source applied, its source's own moves included.
 */
function confirmChain(client: RbookDatabaseClient, held: ReadonlyMap<string, string>): void {
  let confirmed: unknown = [];
  try {
    confirmed = JSON.parse(held.get(CONFIRMED_KEY) ?? '[]');
  } catch {
    confirmed = [];
  }
  const ids = new Set(
    Array.isArray(confirmed) ? confirmed.filter((id) => typeof id === 'string') : []
  );
  for (const term of mergeContext(client).terms) if (term.change) ids.add(term.change.change_id);
  writeCopyKey(client, COPY_KEYS.confirmedMoves, JSON.stringify([...ids]));
}

/**
 * Our schema at the current shape on the file being built, with each shared table's unique
 * stable-id index; the migrations that make it so say what they did on the answer.
 */
async function prepareFresh(file: string): Promise<RbookToolResult<SharingReadiness>> {
  const client = await engineClient(file);
  try {
    const warnings: string[] = [];
    const result = ((): RbookToolResult<SharingReadiness> => {
      const readiness = prepareForSharing(client);
      warnings.push(...readiness.warnings);
      if (!readiness.ready)
        return createError<SharingReadiness>({
          code: REPLICA_ERROR_CODES.WRITE_REFUSED,
          message: `A fresh copy's schema could not be made current: ${readiness.problems.join(' ')}`,
          suggestion: 'Upgrade Reasonbook on this machine, then build the copy again.',
        });
      return createSuccess(readiness);
    })();
    return attachWarnings(result, warnings);
  } finally {
    client.close();
  }
}

/**
 * Build a fresh store at `destPath` holding only the shared record of the store at `sourcePath`
 * (design §R1): our schema, the shared tables' rows with every recorded column, the change log,
 * each transaction's standing worked out again, and the identity keys and metadata the engine needs.
 * No feedback, session timeline, usage statistics, proposals, snapshots or search index is copied.
 * The file is built beside `destPath` and renamed into place, so a failed build leaves nothing.
 */
export async function buildFreshCopy(
  sourcePath: string,
  destPath: string,
  options: {
    /** An upload from another machine, such as the owner's at a handover in: every change is checked. */
    readonly untrusted?: boolean;
    /**
     * s100-m01: the fresh store becomes a referee's, so its clock may run no further ahead than intake
     * takes in. A join's first copy keeps the referee's own reading, which every copy writes at.
     */
    readonly referee?: boolean;
  } = {}
): Promise<FreshCopy> {
  if (existsSync(destPath)) throw new Error(`${destPath} already holds a store.`);
  const building = `${destPath}.building-${process.pid}-${Date.now()}`;
  const source = new Source(sourcePath);
  let target: Target | null = null;
  let client: RbookDatabaseClient | null = null;
  try {
    target = new Database(building);
    target.exec(RBOOK_SCHEMA);
    target.close();
    target = null;
    // Our schema at the current shape, with each shared table's unique stable-id index.
    const prepared = await prepareFresh(building);
    if (!prepared.success)
      throw new Error(prepared.error?.message ?? 'the fresh store was not prepared');
    target = new Database(building);
    dropSearchIndex(target);
    target.pragma('foreign_keys = OFF');
    const writer = target;
    const built = source.snapshot(() =>
      writer.transaction(() => {
        // Every object read is checked to be a plain table before any of them is read, so no view
        // or computed column of an upload runs, not even one a later check would refuse.
        for (const table of SOURCE_TABLES) source.required(table);
        source.columns('record_aliases');
        const held = copyMetadata(source, writer);
        const projectId = held.get('project_id')!;
        // An upload's own clock must read as a clock, and no further ahead than intake takes in: the
        // referee store keeps it, and every copy's next writes would carry it (critics, round 3).
        const clock = held.get(HLC_KEY);
        const reading = clock === undefined ? null : readingProblem(clock);
        if (options.untrusted && reading)
          throw new FreshCopyRefused(
            `That store's ${reading}, so it cannot hand its record to a referee: its next writes would carry it.`
          );
        if (options.referee && clock !== undefined && runsAhead(clock, Date.now()))
          throw new FreshCopyRefused(
            `That store's clock reads ${readingTime(clock)}, more than a week ahead, so it cannot hand its record to a referee yet: every copy would take that clock.`,
            'Share it through the dashboard once that date is within a week, or share it directly over SSH meanwhile; nothing on the copy changes.'
          );
        copyContexts(source, writer);
        const rows = copySharedRows(source, writer);
        installRecordGuards((sql) => writer.exec(sql));
        const changes = copyLog(
          source,
          writer,
          projectId,
          options.untrusted === true,
          options.referee === true
        );
        return { held, projectId, rows, changes };
      })()
    );
    target.close();
    target = null;
    client = await engineClient(building);
    const derived = client.writeTransaction(() => {
      confirmChain(client!, built.held);
      rebuildStandings(client!);
    });
    if (!derived.success)
      throw new Error(derived.error?.message ?? 'the standings were not worked out');
    const dangling = client.getMany('PRAGMA foreign_key_check');
    const integrity = client.getOne<{ integrity_check: string }>('PRAGMA integrity_check');
    if (integrity.data?.integrity_check !== 'ok')
      throw new Error(
        `the fresh store failed its integrity check: ${integrity.data?.integrity_check}`
      );
    // One self-contained file, with no write-ahead log beside it, to send or to serve.
    client.pragma('journal_mode = DELETE');
    client.close();
    client = null;
    renameSync(building, destPath);
    return {
      projectId: built.projectId,
      replicaId: built.held.get(REPLICA_KEYS.id)!,
      rows: built.rows,
      changes: built.changes,
      danglingReferences: dangling.data?.length ?? 0,
      warnings: prepared.warnings ?? [],
    };
  } finally {
    target?.close();
    client?.close();
    source.close();
    for (const suffix of ['', '-wal', '-shm', '-journal'])
      rmSync(`${building}${suffix}`, { force: true });
  }
}
