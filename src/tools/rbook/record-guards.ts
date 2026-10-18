// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The shared record's write guarantee (ADR s96 §4, §6): its tables, the guard triggers that abort a write
// ABOUTME: made without the change helper's token, the capture triggers that stage each change, and their checks.

import { IDENTITY_KEYS, RECORD_COLUMNS, RECORDED_TABLES, type SharedTable } from './record-columns';

/** The token a change helper's transaction holds; no other connection ever sees it (ADR §6). */
export const TOKEN_TABLE = 'record_write_token';
/** Each change staged by the capture triggers, turned into `record_changes` before the token goes. */
export const STAGE_TABLE = 'record_staged';
/**
 * s96-m12: the merge's token. The guards let the rows a merge writes through, and the captures record
 * none of them, since each is a change already in the log.
 */
export const APPLY_TOKEN_TABLE = 'record_apply_token';
/** The log's own tables: losing one loses the record, so only a backup restores it. */
export const LOG_TABLES = [
  'record_changes',
  'record_heads',
  'record_conflicts',
  'record_roots',
] as const;
export const CHANGE_KINDS = [
  'create',
  'set',
  'append',
  'link',
  'unlink',
  'settle',
  'alias',
  'renumber',
  'replica_joined',
  'member',
  'authority',
  'verdict',
  'baseline',
] as const;

const LOG_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS record_changes (
  change_id TEXT PRIMARY KEY,
  txn_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  replica_id TEXT NOT NULL,
  replica_seq INTEGER NOT NULL,
  author_name TEXT,
  author_user_id TEXT,
  hlc TEXT NOT NULL,
  protocol_version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (${CHANGE_KINDS.map((kind) => `'${kind}'`).join(', ')})),
  entity TEXT NOT NULL,
  entity_id TEXT,
  field TEXT,
  value TEXT,
  base TEXT,
  UNIQUE (project_id, replica_id, replica_seq)
);
CREATE INDEX IF NOT EXISTS record_changes_entity ON record_changes (entity, entity_id, field);
CREATE INDEX IF NOT EXISTS record_changes_txn ON record_changes (txn_id);
CREATE INDEX IF NOT EXISTS record_changes_create ON record_changes (entity_id) WHERE kind = 'create';
CREATE INDEX IF NOT EXISTS record_changes_replica ON record_changes (replica_id, replica_seq);
CREATE TABLE IF NOT EXISTS record_heads (
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  change_id TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id, field, change_id)
);
CREATE TABLE IF NOT EXISTS record_conflicts (
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  PRIMARY KEY (entity, entity_id, field)
);
CREATE TABLE IF NOT EXISTS record_roots (
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (entity, entity_id, field)
);`;

/**
 * s96-m12: the merge's derived state, which every recompute writes again: each transaction that is not
 * live and why, and the text ids renamed by the alias rule.
 */
export const DERIVED_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS record_txn_state (
  txn_id TEXT PRIMARY KEY,
  replica_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'held', 'refused', 'quarantined')),
  cause TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS record_aliases (
  entity TEXT NOT NULL,
  renamed_id TEXT NOT NULL,
  plain_id TEXT NOT NULL,
  stable_event_id TEXT NOT NULL,
  renamed_at TEXT NOT NULL,
  PRIMARY KEY (entity, renamed_id)
);`;

/** The token and the stage hold nothing at rest, so the repair may make them again. */
export const TRANSIENT_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS ${TOKEN_TABLE} (txn_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ${APPLY_TOKEN_TABLE} (txn_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS ${STAGE_TABLE} (
  seq INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  row_id INTEGER,
  op TEXT NOT NULL,
  field TEXT,
  old_value,
  new_value
);`;

const NO_TOKEN = `NOT EXISTS (SELECT 1 FROM ${TOKEN_TABLE}) AND NOT EXISTS (SELECT 1 FROM ${APPLY_TOKEN_TABLE})`;
/** Captures stage only inside the helper's transaction; a write that passes freely stages nothing. */
const HAS_TOKEN = `EXISTS (SELECT 1 FROM ${TOKEN_TABLE})`;
const quoted = (text: string): string => `'${text.replace(/'/g, "''")}'`;
const list = (values: readonly string[]): string => values.map(quoted).join(', ');

/** The upgrade remedy an older server, or any write outside the helper, is aborted with (ADR §6). */
export function UNRECORDED_MESSAGE(target: string): string {
  return (
    `RECORD_WRITE_UNRECORDED: ${target} on this shared record was written outside its change log. ` +
    'Reasonbook 4.1.0 or later records every change: upgrade with npm install -g @aquex/reasonbook@latest.'
  );
}
export const IMMUTABLE_MESSAGE =
  'RECORD_IDENTITY_IMMUTABLE: project_id and created_at never change on a shared record, whose change log is routed by project_id.';
export const IDENTITY_INVALID_MESSAGE =
  'RECORD_IDENTITY_INVALID: on a shared record the project identity is plain JSON naming each of its keys once.';

const abort = (message: string): string => `SELECT RAISE(ABORT, ${quoted(message)});`;
const changed = (columns: readonly string[]): string =>
  columns.map((column) => `OLD."${column}" IS NOT NEW."${column}"`).join(' OR ');
const json = (columns: readonly string[], row: 'NEW' | 'OLD'): string =>
  `json_object(${columns.map((column) => `'${column}', ${row}."${column}"`).join(', ')})`;

/**
 * A shared table's guards and captures. The update triggers name no column list: SQLite matches
 * `UPDATE OF` by name, so `SET rowid = …` on an integer-keyed table would pass one. They compare
 * the recorded columns instead, so a per-copy column still changes freely.
 */
function tableTriggers(table: SharedTable): Record<string, string> {
  const classes = RECORD_COLUMNS[table];
  const recorded = classes.recorded;
  const message = abort(UNRECORDED_MESSAGE(table));
  const stage = `INSERT INTO ${STAGE_TABLE} (entity, row_id, op, field, old_value, new_value)`;
  const captureUpdate = classes.link
    ? `${stage} SELECT '${table}', NEW.rowid, 'unlink', NULL, ${json(recorded, 'OLD')}, NULL;\n  ${stage} SELECT '${table}', NEW.rowid, 'link', NULL, NULL, ${json(recorded, 'NEW')};`
    : recorded
        .map(
          (column) =>
            `${stage} SELECT '${table}', NEW.rowid, 'set', '${column}', OLD."${column}", NEW."${column}" WHERE OLD."${column}" IS NOT NEW."${column}";`
        )
        .join('\n  ');
  return {
    [`record_guard_${table}_insert`]: `CREATE TRIGGER record_guard_${table}_insert BEFORE INSERT ON ${table} WHEN ${NO_TOKEN} BEGIN ${message} END`,
    [`record_guard_${table}_update`]: `CREATE TRIGGER record_guard_${table}_update BEFORE UPDATE ON ${table} WHEN ${NO_TOKEN} AND (${changed(recorded)}) BEGIN ${message} END`,
    [`record_guard_${table}_delete`]: `CREATE TRIGGER record_guard_${table}_delete BEFORE DELETE ON ${table} WHEN ${NO_TOKEN} BEGIN ${message} END`,
    [`record_capture_${table}_insert`]: `CREATE TRIGGER record_capture_${table}_insert AFTER INSERT ON ${table} WHEN ${HAS_TOKEN} BEGIN\n  ${stage} SELECT '${table}', NEW.rowid, '${classes.link ? 'link' : 'create'}', NULL, NULL, ${classes.link ? json(recorded, 'NEW') : 'NULL'};\nEND`,
    [`record_capture_${table}_update`]: `CREATE TRIGGER record_capture_${table}_update AFTER UPDATE ON ${table} WHEN ${HAS_TOKEN} AND (${changed(recorded)}) BEGIN\n  ${captureUpdate}\nEND`,
    [`record_capture_${table}_delete`]: `CREATE TRIGGER record_capture_${table}_delete AFTER DELETE ON ${table} WHEN ${HAS_TOKEN} BEGIN\n  ${stage} SELECT '${table}', OLD.rowid, '${classes.link ? 'unlink' : 'delete'}', NULL, ${json(recorded, 'OLD')}, NULL;\nEND`,
  };
}

/** Whether an identity document is not a plain JSON object; json_valid accepts no JSON5. */
export function identityUnreadable(content: string): string {
  return `json_valid(${content}) IS NOT 1 OR json_type(${content}) IS NOT 'object'`;
}

/**
 * Whether an identity document is not plain JSON naming each recorded or immutable key once: SQLite
 * reads a repeated key's first value and the app its last, and the app cannot parse JSON5.
 * json_each runs only on text json_valid accepted.
 */
export function identityInvalid(content: string): string {
  return `${identityUnreadable(content)} OR EXISTS (SELECT 1 FROM json_each(${content}) WHERE key IN (${list([...IDENTITY_KEYS.document, ...IDENTITY_KEYS.immutable])}) GROUP BY key HAVING count(*) > 1)`;
}

/**
 * The identity document's guards compare each key's JSON text, so a per-copy key changes freely.
 * SQLite reads a repeated key's first value and the app its last, so the document must be plain
 * JSON naming each recorded or immutable key once, even with the token.
 */
function identityTriggers(): Record<string, string> {
  const current = (key: string): string =>
    `(SELECT content -> '$.${key}' FROM contexts WHERE id = 'project_identity')`;
  const recordedChanged = (from: (key: string) => string): string =>
    IDENTITY_KEYS.document
      .map((key) => `${from(key)} IS NOT NEW.content -> '$.${key}'`)
      .join(' OR ');
  const immutableChanged = (from: (key: string) => string): string =>
    IDENTITY_KEYS.immutable
      .map((key) => `${from(key)} IS NOT NEW.content -> '$.${key}'`)
      .join(' OR ');
  const invalid = identityInvalid('NEW.content');
  const old = (key: string): string => `OLD.content -> '$.${key}'`;
  const guard = (condition: { immutable: string; recorded: string }): string =>
    `SELECT CASE WHEN ${invalid} THEN RAISE(ABORT, ${quoted(IDENTITY_INVALID_MESSAGE)}) WHEN ${condition.immutable} THEN RAISE(ABORT, ${quoted(IMMUTABLE_MESSAGE)}) WHEN ${NO_TOKEN} AND (${condition.recorded}) THEN RAISE(ABORT, ${quoted(UNRECORDED_MESSAGE('the project identity'))}) END;`;
  const stage = `INSERT INTO ${STAGE_TABLE} (entity, row_id, op, field, old_value, new_value)`;
  return {
    record_guard_identity_insert: `CREATE TRIGGER record_guard_identity_insert BEFORE INSERT ON contexts WHEN NEW.id = 'project_identity' AND EXISTS (SELECT 1 FROM contexts WHERE id = 'project_identity') BEGIN ${guard({ immutable: immutableChanged(current), recorded: recordedChanged(current) })} END`,
    record_guard_identity_update: `CREATE TRIGGER record_guard_identity_update BEFORE UPDATE OF id, content ON contexts WHEN OLD.id = 'project_identity' OR NEW.id = 'project_identity' BEGIN ${guard({ immutable: `NEW.id IS NOT OLD.id OR ${immutableChanged(old)}`, recorded: recordedChanged(old) })} END`,
    record_guard_identity_delete: `CREATE TRIGGER record_guard_identity_delete BEFORE DELETE ON contexts WHEN OLD.id = 'project_identity' BEGIN ${abort(IMMUTABLE_MESSAGE)} END`,
    // An insert's new content is read when the change is recorded, so an ignored insert records none.
    record_capture_identity_insert: `CREATE TRIGGER record_capture_identity_insert BEFORE INSERT ON contexts WHEN NEW.id = 'project_identity' AND ${HAS_TOKEN} BEGIN\n  ${stage} SELECT 'project', NULL, 'identity', NULL, (SELECT content FROM contexts WHERE id = 'project_identity'), NULL;\nEND`,
    record_capture_identity_update: `CREATE TRIGGER record_capture_identity_update AFTER UPDATE OF content ON contexts WHEN NEW.id = 'project_identity' AND OLD.content IS NOT NEW.content AND ${HAS_TOKEN} BEGIN\n  ${stage} SELECT 'project', NULL, 'identity', NULL, OLD.content, NULL;\nEND`,
  };
}

/** The metadata identity keys: recorded keys need the token, and immutable keys never change. */
function metadataTriggers(): Record<string, string> {
  const recorded = list(IDENTITY_KEYS.metadata);
  const immutable = list(IDENTITY_KEYS.immutable);
  const current = `(SELECT value FROM metadata WHERE key = NEW.key)`;
  const unrecorded = quoted(UNRECORDED_MESSAGE('the project identity'));
  const stage = `INSERT INTO ${STAGE_TABLE} (entity, row_id, op, field, old_value, new_value)`;
  return {
    // A recorded key is guarded even when absent, so no write adds one unrecorded; an immutable key
    // may only be written with the value it holds.
    record_guard_metadata_insert: `CREATE TRIGGER record_guard_metadata_insert BEFORE INSERT ON metadata WHEN (NEW.key IN (${immutable}) AND EXISTS (SELECT 1 FROM metadata WHERE key = NEW.key AND value IS NOT NEW.value)) OR (NEW.key IN (${recorded}) AND ${NO_TOKEN} AND ${current} IS NOT NEW.value) BEGIN SELECT CASE WHEN NEW.key IN (${immutable}) THEN RAISE(ABORT, ${quoted(IMMUTABLE_MESSAGE)}) ELSE RAISE(ABORT, ${unrecorded}) END; END`,
    record_guard_metadata_update: `CREATE TRIGGER record_guard_metadata_update BEFORE UPDATE OF key, value ON metadata WHEN (OLD.key IN (${immutable}, ${recorded}) OR NEW.key IN (${immutable}, ${recorded})) AND (OLD.key IS NOT NEW.key OR OLD.value IS NOT NEW.value) BEGIN SELECT CASE WHEN OLD.key IN (${immutable}) OR NEW.key IN (${immutable}) THEN RAISE(ABORT, ${quoted(IMMUTABLE_MESSAGE)}) WHEN ${NO_TOKEN} THEN RAISE(ABORT, ${unrecorded}) END; END`,
    record_guard_metadata_delete: `CREATE TRIGGER record_guard_metadata_delete BEFORE DELETE ON metadata WHEN OLD.key IN (${immutable}, ${recorded}) BEGIN SELECT CASE WHEN OLD.key IN (${immutable}) THEN RAISE(ABORT, ${quoted(IMMUTABLE_MESSAGE)}) WHEN ${NO_TOKEN} THEN RAISE(ABORT, ${unrecorded}) END; END`,
    record_capture_metadata_insert: `CREATE TRIGGER record_capture_metadata_insert BEFORE INSERT ON metadata WHEN NEW.key IN (${recorded}) AND ${HAS_TOKEN} BEGIN\n  ${stage} SELECT 'project', NULL, 'metadata', NEW.key, ${current}, NULL;\nEND`,
    record_capture_metadata_update: `CREATE TRIGGER record_capture_metadata_update AFTER UPDATE OF value ON metadata WHEN NEW.key IN (${recorded}) AND OLD.value IS NOT NEW.value AND ${HAS_TOKEN} BEGIN\n  ${stage} SELECT 'project', NULL, 'metadata', NEW.key, OLD.value, NULL;\nEND`,
    record_capture_metadata_delete: `CREATE TRIGGER record_capture_metadata_delete AFTER DELETE ON metadata WHEN OLD.key IN (${recorded}) AND ${HAS_TOKEN} BEGIN\n  ${stage} SELECT 'project', NULL, 'metadata', OLD.key, OLD.value, NULL;\nEND`,
  };
}

/** Every trigger a shared record carries, by name, as `sqlite_master` keeps its SQL. */
export function expectedTriggers(): Readonly<Record<string, string>> {
  return {
    ...Object.assign({}, ...RECORDED_TABLES.map(tableTriggers)),
    ...identityTriggers(),
    ...metadataTriggers(),
  };
}

const TRIGGER_NAMES =
  "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'record\\_guard\\_%' ESCAPE '\\' OR name LIKE 'record\\_capture\\_%' ESCAPE '\\')";

/** Create the record tables, the token table, the stage and every trigger; inside the caller's transaction. */
export function installRecordGuards(run: (sql: string) => void): void {
  run(LOG_TABLES_SQL);
  run(TRANSIENT_TABLES_SQL);
  run(DERIVED_TABLES_SQL);
  for (const sql of Object.values(expectedTriggers())) run(sql);
}

export interface GuardState {
  readonly missing: readonly string[];
  readonly altered: readonly string[];
  readonly unexpected: readonly string[];
  readonly leftoverTokens: number;
  readonly leftoverStaged: number;
  /** Shared or log tables the copy no longer has. */
  readonly missingTables: readonly string[];
  /** The token or the stage, which the repair may make again. */
  readonly missingTransient: readonly string[];
  /** `table.column` of a recorded column a shared table no longer has. */
  readonly missingColumns: readonly string[];
  /** `table.column` of a column in no class, which would be unguarded and unrecorded. */
  readonly unclassifiedColumns: readonly string[];
}

/** The columns of each shared table that no class names (ADR §4); empty when every column is classified. */
export function unclassifiedColumns(query: <T>(sql: string) => T[]): string[] {
  return RECORDED_TABLES.flatMap((table) => {
    const classes = RECORD_COLUMNS[table];
    const known = new Set([
      ...classes.recorded,
      ...classes.perCopyLocal,
      ...classes.perCopyDerived,
    ]);
    return query<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
      .map((column) => column.name)
      .filter((name) => !known.has(name))
      .map((name) => `${table}.${name}`);
  });
}

/**
 * What the copy holds against the recorded set (ADR §6). Inside the helper's own transaction the
 * token and the stage are its own, so they are not counted.
 */
export function readGuardState(
  query: <T>(sql: string) => T[],
  options: { readonly insideHelper?: boolean } = {}
): GuardState {
  const expected = expectedTriggers();
  const present = new Map(
    query<{ name: string; sql: string }>(TRIGGER_NAMES).map((row) => [row.name, row.sql])
  );
  const tables = new Set(
    query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map(
      (row) => row.name
    )
  );
  const missingTransient = [TOKEN_TABLE, APPLY_TOKEN_TABLE, STAGE_TABLE].filter(
    (name) => !tables.has(name)
  );
  const count = (table: string): number =>
    options.insideHelper || !tables.has(table)
      ? 0
      : (query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)[0]?.n ?? 0);
  const missingColumns = RECORDED_TABLES.filter((table) => tables.has(table)).flatMap((table) => {
    const columns = new Set(
      query<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).map((c) => c.name)
    );
    return RECORD_COLUMNS[table].recorded
      .filter((column) => !columns.has(column))
      .map((column) => `${table}.${column}`);
  });
  return {
    missing: Object.keys(expected).filter((name) => !present.has(name)),
    altered: Object.keys(expected).filter(
      (name) => present.has(name) && present.get(name) !== expected[name]
    ),
    unexpected: [...present.keys()].filter((name) => !(name in expected)),
    leftoverTokens: count(TOKEN_TABLE) + count(APPLY_TOKEN_TABLE),
    leftoverStaged: count(STAGE_TABLE),
    missingTables: [...RECORDED_TABLES, ...LOG_TABLES].filter((name) => !tables.has(name)),
    missingTransient,
    missingColumns,
    unclassifiedColumns: unclassifiedColumns(query).filter((name) =>
      tables.has(name.split('.')[0])
    ),
  };
}

/**
 * What would fix the copy: a repair rebuilds the guards and records what was staged; a restore is
 * the only remedy for a lost table or recorded column; an upgrade, for columns this version does
 * not know. Null when the guard is whole.
 */
export type GuardRemedy = 'repair' | 'restore' | 'upgrade';
export function guardRemedy(state: GuardState): GuardRemedy | null {
  if (state.missingTables.length || state.missingColumns.length) return 'restore';
  if (state.unclassifiedColumns.length) return 'upgrade';
  return guardProblems(state).length ? 'repair' : null;
}

/** Every way the guard state is not whole, in words. */
export function guardProblems(state: GuardState): string[] {
  const problems: string[] = [];
  if (state.missingTables.length)
    problems.push(`missing tables: ${state.missingTables.join(', ')}`);
  if (state.missingColumns.length)
    problems.push(`missing recorded columns: ${state.missingColumns.join(', ')}`);
  if (state.unclassifiedColumns.length)
    problems.push(`columns this version does not know: ${state.unclassifiedColumns.join(', ')}`);
  if (state.missingTransient.length)
    problems.push(`missing guard tables: ${state.missingTransient.join(', ')}`);
  if (state.missing.length) problems.push(`missing triggers: ${state.missing.join(', ')}`);
  if (state.altered.length) problems.push(`changed triggers: ${state.altered.join(', ')}`);
  if (state.unexpected.length) problems.push(`unknown triggers: ${state.unexpected.join(', ')}`);
  if (state.leftoverTokens) problems.push(`${state.leftoverTokens} leftover write token(s)`);
  if (state.leftoverStaged)
    problems.push(`${state.leftoverStaged} staged change(s) never recorded`);
  return problems;
}

/**
 * Rebuild the guard tables and every trigger from the recorded set, and clear a leftover token.
 * The caller records what was staged first, under the same write lock.
 */
export function rebuildRecordGuards(
  run: (sql: string) => void,
  query: <T>(sql: string) => T[]
): void {
  run(TRANSIENT_TABLES_SQL);
  run(DERIVED_TABLES_SQL);
  for (const { name } of query<{ name: string }>(TRIGGER_NAMES))
    run(`DROP TRIGGER IF EXISTS "${name}"`);
  run(`DELETE FROM ${TOKEN_TABLE}`);
  run(`DELETE FROM ${APPLY_TOKEN_TABLE}`);
  for (const sql of Object.values(expectedTriggers())) run(sql);
}

// The recording state and the client's refusal while recording live in record-recording.ts.
export {
  beginMerging,
  beginRecording,
  endMerging,
  endRecording,
  forgetRecordedStore,
  isMerging,
  isRecordedStore,
  isRecording,
  refusedWhileRecording,
} from './record-recording';
