// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Atomically adds nullable decision fields and upgrades only owned decision FTS objects.
// ABOUTME: A version marker commits last; failed or read-only attempts never claim readiness.

import type { RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import type { MigrationResult } from './schema-migrations';
import { DECISION_TEXT_FIELDS } from './decision-fields';
import { asLazyRepair, callMayWrite } from './tool-call-context';

const SHAPE_COLUMNS = [
  ...DECISION_TEXT_FIELDS,
  'approval_mode',
  'approval_draft',
  'approval_words',
];
const MARKER = 'decision_shape_columns';
type NormalizeSql = (sql: string) => string;
interface SchemaObject {
  type: string;
  sql: string | null;
}
interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

/** Both supported definitions remain readable; only the write migration replaces the old one. */
export function decisionFtsDefinition(rich: boolean): {
  createSql: string;
  triggers: { name: string; sql: string }[];
} {
  const fields = ['decision_text', ...(rich ? DECISION_TEXT_FIELDS : [])];
  const columns = fields.join(', ');
  const values = (prefix: string): string => fields.map((field) => `${prefix}.${field}`).join(', ');
  return {
    createSql: `CREATE VIRTUAL TABLE decisions_fts USING fts5(
      ${columns}, content='strategic_decisions', content_rowid='id'
    )`,
    triggers: [
      {
        name: 'decisions_fts_insert',
        sql: `CREATE TRIGGER decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
        INSERT INTO decisions_fts(rowid, ${columns}) VALUES (new.id, ${values('new')}); END`,
      },
      {
        name: 'decisions_fts_delete',
        sql: `CREATE TRIGGER decisions_fts_delete AFTER DELETE ON strategic_decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, ${columns}) VALUES('delete', old.id, ${values('old')}); END`,
      },
      {
        name: 'decisions_fts_update',
        sql: `CREATE TRIGGER decisions_fts_update AFTER UPDATE OF ${columns} ON strategic_decisions BEGIN
        INSERT INTO decisions_fts(decisions_fts, rowid, ${columns}) VALUES('delete', old.id, ${values('old')});
        INSERT INTO decisions_fts(rowid, ${columns}) VALUES (new.id, ${values('new')}); END`,
      },
    ],
  };
}

function requireSuccess<T>(result: RbookToolResult<T>, step: string): T | undefined {
  if (!result.success)
    throw new Error(
      `${step}: ${result.error?.code ?? 'DB_ERROR'} — ${result.error?.message ?? 'unknown'}`
    );
  return result.data;
}

function object(client: RbookDatabaseClient, name: string): SchemaObject | undefined {
  return requireSuccess(
    client.getOne<SchemaObject>('SELECT type, sql FROM sqlite_master WHERE name = ?', [name]),
    `${name} schema read`
  );
}

function matches(
  row: SchemaObject | undefined,
  type: string,
  sql: string,
  normalize: NormalizeSql
): boolean {
  return row?.type === type && normalize(row.sql ?? '') === normalize(sql);
}

function inspect(
  client: RbookDatabaseClient,
  normalize: NormalizeSql
): {
  missingColumns: string[];
  rich: boolean;
  fts: SchemaObject | undefined;
  triggers: Map<string, SchemaObject | undefined>;
} {
  if (object(client, 'strategic_decisions')?.type !== 'table')
    throw new Error('strategic_decisions source table is missing or not a table');
  const columns = requireSuccess(
    client.getMany<Column>('PRAGMA table_info(strategic_decisions)'),
    'strategic_decisions column read'
  );
  if (!columns?.some((c) => c.name === 'id') || !columns.some((c) => c.name === 'decision_text'))
    throw new Error('strategic_decisions source columns are missing');
  for (const column of columns.filter((c) => SHAPE_COLUMNS.includes(c.name))) {
    if (
      column.type.toUpperCase() !== 'TEXT' ||
      column.notnull !== 0 ||
      (column.dflt_value !== null && !/^\(?\s*NULL\s*\)?$/i.test(column.dflt_value))
    )
      throw new Error(
        `Existing ${column.name} is not nullable TEXT with a NULL default; leaving its definition untouched`
      );
  }
  const missingColumns = SHAPE_COLUMNS.filter((name) => !columns.some((c) => c.name === name));
  const legacy = decisionFtsDefinition(false);
  const current = decisionFtsDefinition(true);
  const fts = object(client, 'decisions_fts');
  if (
    fts &&
    !matches(fts, 'table', legacy.createSql, normalize) &&
    !matches(fts, 'table', current.createSql, normalize)
  )
    throw new Error(
      'Existing decisions_fts has an unrecognized or foreign definition; leaving it untouched'
    );
  const triggers = new Map<string, SchemaObject | undefined>();
  for (const [index, spec] of current.triggers.entries()) {
    const existing = object(client, spec.name);
    if (
      existing &&
      !matches(existing, 'trigger', spec.sql, normalize) &&
      !matches(existing, 'trigger', legacy.triggers[index].sql, normalize)
    )
      throw new Error(
        `Existing ${spec.name} has an unrecognized or foreign definition; leaving it untouched`
      );
    triggers.set(spec.name, existing);
  }
  return {
    missingColumns,
    fts,
    triggers,
    rich:
      missingColumns.length === 0 &&
      matches(fts, 'table', current.createSql, normalize) &&
      current.triggers.every((spec) =>
        matches(triggers.get(spec.name), 'trigger', spec.sql, normalize)
      ),
  };
}

/** Caller runs this before its own transaction; BEGIN failure never rolls back a caller's work. */
export function migrateDecisionShapeColumns(
  client: RbookDatabaseClient,
  normalize: NormalizeSql
): MigrationResult & { ready: boolean } {
  const none = {
    columnsAdded: [],
    indexesCreated: [],
    rowsUpdated: 0,
    alreadyCurrent: false,
    ready: false,
  };
  let begun = false;
  try {
    const readMarker = (): string | undefined => {
      const value = requireSuccess(
        client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [MARKER]),
        `${MARKER} read`
      )?.value;
      if (value !== undefined && value !== '1')
        throw new Error(
          `Unrecognized ${MARKER} version ${value}; use a compatible server before recording`
        );
      return value;
    };
    if (readMarker() === '1') {
      if (!inspect(client, normalize).rich)
        throw new Error(
          `${MARKER}=1 disagrees with the decision schema; repair the schema before recording`
        );
      return { ...none, ready: true, alreadyCurrent: true, warnings: [] };
    }
    if (!callMayWrite())
      throw new Error('decision shape migration is deferred to a write; this call is read-only');
    return asLazyRepair(() => {
      requireSuccess(client.raw('BEGIN IMMEDIATE'), 'decision shape write lock');
      begun = true;
      // A different process may have completed the migration while this connection waited.
      const marker = readMarker();
      const state = inspect(client, normalize);
      if (marker === '1') {
        if (!state.rich) throw new Error(`${MARKER}=1 disagrees with the decision schema`);
        requireSuccess(client.raw('COMMIT'), 'decision shape commit');
        begun = false;
        return { ...none, ready: true, alreadyCurrent: true, warnings: [] };
      }
      const current = decisionFtsDefinition(true);
      for (const name of state.missingColumns)
        requireSuccess(
          client.raw(`ALTER TABLE strategic_decisions ADD COLUMN ${name} TEXT`),
          `add ${name}`
        );
      const replaceTable = !matches(state.fts, 'table', current.createSql, normalize);
      const indexesCreated: string[] = [];
      for (const spec of current.triggers) {
        const existing = state.triggers.get(spec.name);
        if (existing && (replaceTable || !matches(existing, 'trigger', spec.sql, normalize)))
          requireSuccess(client.raw(`DROP TRIGGER ${spec.name}`), `drop owned ${spec.name}`);
      }
      if (replaceTable) {
        if (state.fts)
          requireSuccess(client.raw('DROP TABLE decisions_fts'), 'drop owned decisions_fts');
        requireSuccess(client.raw(current.createSql), 'create rich decisions_fts');
      }
      for (const spec of current.triggers) {
        if (
          replaceTable ||
          !matches(state.triggers.get(spec.name), 'trigger', spec.sql, normalize)
        ) {
          requireSuccess(client.raw(spec.sql), `create ${spec.name}`);
          indexesCreated.push(spec.name);
        }
      }
      requireSuccess(
        client.raw("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')"),
        'decision shape FTS rebuild'
      );
      const count = requireSuccess(
        client.getOne<{ count: number }>('SELECT COUNT(*) AS count FROM strategic_decisions'),
        'decision shape rebuilt row count'
      );
      if (typeof count?.count !== 'number')
        throw new Error('decision shape rebuilt row count unavailable');
      requireSuccess(
        client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [MARKER, '1']),
        `${MARKER} stamp`
      );
      requireSuccess(client.raw('COMMIT'), 'decision shape commit');
      begun = false;
      return {
        columnsAdded: state.missingColumns,
        indexesCreated,
        rowsUpdated: count.count,
        alreadyCurrent: false,
        ready: true,
        warnings: [],
      };
    });
  } catch (error) {
    const warnings = [
      `Decision shape migration failed: ${error instanceof Error ? error.message : String(error)}. Retry this write after resolving the schema or database error.`,
    ];
    if (begun) {
      const rollback = client.raw('ROLLBACK');
      if (!rollback.success)
        warnings.push(
          `Decision shape rollback failed: ${rollback.error?.message ?? 'unknown database error'}`
        );
    }
    return { ...none, warnings };
  }
}

/** s97-m09: the marker a fresh copy clears with its search index, so the first write makes both again. */
export { MARKER as DECISION_SHAPE_MARKER };
