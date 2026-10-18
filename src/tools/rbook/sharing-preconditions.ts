// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What a store needs before it is shared (ADR s96 §2, design §s96-m01): its schema at the current
// ABOUTME: shape, every shared table present, and stable ids present and unique, held by unique indexes.

import Database from 'better-sqlite3';
import { FIREHOSE_TABLES } from '../../types/event-types';
import type { RbookDatabaseClient } from './client';
import { RECORD_COLUMNS, RECORDED_TABLES } from './record-columns';
import { SHARED_TABLES } from './replica-identity';
import { RBOOK_SCHEMA } from './schema';
import {
  ensureAuthorNameColumns,
  ensureAuthorNamespaceColumns,
  ensureDecisionShapeColumns,
  ensureFirehoseEventColumns,
  ensureConstraintEvergreen,
  ensureConstraintReviewTimestamp,
  ensureImplicitSessionColumns,
  ensureLearningsTable,
  ensureReviewTimestamps,
} from './schema-migrations';

export interface SharingReadiness {
  readonly ready: boolean;
  readonly tablesCreated: readonly string[];
  /** s96-m14: recorded columns no migration had added, as `<table>.<column>`. */
  readonly columnsAdded: readonly string[];
  readonly indexesCreated: readonly string[];
  /** Why the store cannot be shared yet, counted per table. */
  readonly problems: readonly string[];
  readonly warnings: readonly string[];
}

/** The base schema's own statements for each table, so a missing one is made as new stores make it. */
function baseTableStatements(): Map<string, string[]> {
  const statements = new Map<string, string[]>();
  const add = (table: string, statement: string) =>
    statements.set(table, [...(statements.get(table) ?? []), statement]);
  for (const match of RBOOK_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\n\);/g))
    add(match[1], match[0]);
  for (const match of RBOOK_SCHEMA.matchAll(
    /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS \w+\s+ON (\w+)\s*\([^;]*\);/g
  ))
    add(match[1], match[0]);
  return statements;
}

/**
 * s96-m14: each recorded column a table still lacks once the named migrations ran, added as the base
 * schema defines it. Some joined the base schema with no migration of their own, as decisions'
 * `source_chunk_ids` did, so a store made before them could never be shared (the import's class).
 */
function addRecordedColumns(
  client: RbookDatabaseClient,
  base: ReadonlyMap<string, string[]>
): string[] {
  const added: string[] = [];
  const shape = new Database(':memory:');
  try {
    for (const table of RECORDED_TABLES) {
      const present = new Set(
        rows<{ name: string }>(client, `SELECT name FROM pragma_table_info('${table}')`).map(
          (column) => column.name
        )
      );
      const missing = RECORD_COLUMNS[table].recorded.filter((column) => !present.has(column));
      const create = base.get(table)?.find((statement) => statement.startsWith('CREATE TABLE'));
      if (!missing.length || !create) continue;
      shape.exec(create);
      const defined = new Map(
        (
          shape.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
          }>
        ).map((column) => [column.name, column])
      );
      for (const column of missing) {
        const definition = defined.get(column);
        // A column the base schema lacks too stays missing, and the share step names it.
        if (!definition) continue;
        const fallback =
          definition.dflt_value === null
            ? ''
            : ` DEFAULT ${definition.dflt_value}${definition.notnull ? ' NOT NULL' : ''}`;
        run(
          client,
          `ALTER TABLE ${table} ADD COLUMN "${column}" ${definition.type}${fallback}`,
          `${table}.${column} could not be added`
        );
        added.push(`${table}.${column}`);
      }
    }
  } finally {
    shape.close();
  }
  return added;
}

function tableNames(client: RbookDatabaseClient): Set<string> {
  const rows = client.getMany<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  );
  if (!rows.success) throw new Error(rows.error?.message ?? 'The schema could not be read.');
  return new Set((rows.data ?? []).map((row) => row.name));
}

function run(client: RbookDatabaseClient, sql: string, what: string): void {
  const done = client.raw(sql);
  if (!done.success) throw new Error(`${what}: ${done.error?.message ?? 'unknown error'}`);
}

function rows<T>(client: RbookDatabaseClient, sql: string): T[] {
  const read = client.getMany<T>(sql);
  if (!read.success) throw new Error(read.error?.message ?? `${sql} could not be read.`);
  return read.data ?? [];
}

/** The names of the table's indexes that are unique on exactly its stable id, and on nothing else. */
function stableIdIndexes(client: RbookDatabaseClient, table: string): Map<string, boolean> {
  const found = new Map<string, boolean>();
  for (const index of rows<{ name: string; unique: number }>(
    client,
    `PRAGMA index_list('${table}')`
  )) {
    const columns = rows<{ name: string }>(client, `PRAGMA index_info('${index.name}')`);
    found.set(
      index.name,
      index.unique === 1 && columns.length === 1 && columns[0].name === 'stable_event_id'
    );
  }
  return found;
}

/** Whether the table has an index unique on exactly its stable id (ADR s96 §2). */
export function hasStableIdIndex(client: RbookDatabaseClient, table: string): boolean {
  return [...stableIdIndexes(client, table).values()].includes(true);
}

/**
 * Bring a store to what sharing needs, or say why it cannot be shared. s96-m13's share calls this
 * before s96-m03's share step, which checks the same. It refuses rather than repairs duplicate or missing stable ids, because a row's
 * stable id is its identity on every copy (ADR s96 §2) and a guessed one would split a record.
 */
export function prepareForSharing(client: RbookDatabaseClient): SharingReadiness {
  const tablesCreated: string[] = [];
  const present = tableNames(client);
  const base = baseTableStatements();
  for (const table of SHARED_TABLES) {
    if (present.has(table)) continue;
    const statements = base.get(table);
    if (!statements) throw new Error(`The base schema does not define the shared table ${table}.`);
    for (const statement of statements) run(client, statement, `${table} could not be made`);
    tablesCreated.push(table);
  }

  const warnings: string[] = [];
  const problems: string[] = [];
  // Called by name, so the migration-warning census sees each one. Every table is checked, not
  // only the markers: a table made after a marker was set lacks that migration's columns.
  warnings.push(
    ...(ensureFirehoseEventColumns(client, { everyTable: true }).warnings ?? []),
    ...(ensureAuthorNamespaceColumns(client, { everyTable: true }).warnings ?? []),
    ...(ensureAuthorNameColumns(client, { everyTable: true }).warnings ?? []),
    ...(ensureImplicitSessionColumns(client).warnings ?? []),
    // s96-m03: the review and evergreen columns are recorded, so a copy is guarded only with them.
    ...(ensureReviewTimestamps(client).warnings ?? []),
    ...(ensureLearningsTable(client).warnings ?? []),
    ...(ensureConstraintReviewTimestamp(client).warnings ?? []),
    ...(ensureConstraintEvergreen(client).warnings ?? [])
  );
  const shape = ensureDecisionShapeColumns(client);
  warnings.push(...(shape.warnings ?? []));
  if (!shape.ready) problems.push('strategic_decisions: its columns are not at the current shape.');
  const columnsAdded = addRecordedColumns(client, base);

  for (const table of FIREHOSE_TABLES) {
    const counts = client.getOne<{ duplicates: number; missing: number }>(
      `SELECT count(stable_event_id) - count(DISTINCT stable_event_id) AS duplicates,
              count(*) - count(stable_event_id) AS missing
         FROM ${table}`
    );
    if (!counts.success || !counts.data)
      throw new Error(counts.error?.message ?? `${table}: its stable ids could not be counted.`);
    const { duplicates, missing } = counts.data;
    if (duplicates)
      problems.push(`${table}: ${duplicates} duplicate stable id${duplicates === 1 ? '' : 's'}.`);
    if (missing)
      problems.push(`${table}: ${missing} row${missing === 1 ? ' has' : 's have'} no stable id.`);
    const name = `idx_${table}_stable_event_id_unique`;
    if (stableIdIndexes(client, table).get(name) === false)
      problems.push(
        `${table}: an index named ${name} exists but is not unique on stable_event_id.`
      );
  }

  const indexesCreated: string[] = [];
  if (!problems.length) {
    for (const table of FIREHOSE_TABLES) {
      if (hasStableIdIndex(client, table)) continue;
      const name = `idx_${table}_stable_event_id_unique`;
      run(
        client,
        `CREATE UNIQUE INDEX ${name} ON ${table} (stable_event_id)`,
        `${table}'s unique stable-id index could not be made`
      );
      indexesCreated.push(name);
    }
  }
  return {
    ready: problems.length === 0,
    tablesCreated,
    columnsAdded,
    indexesCreated,
    problems,
    warnings,
  };
}
