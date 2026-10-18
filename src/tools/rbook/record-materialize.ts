// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Writes an entity's merged state into this copy's tables under the merge's token (ADR s96 §5): the row, its
// ABOUTME: references as this copy's ids, its heads and conflicts, and each field's root before its first change.

import type { RbookDatabaseClient } from './client';
import { canonicalJson, encodeValue } from './record-capture';
import { CaptureRowMissing, decodeCaptures } from './record-capture-refs';
import { IDENTITY_KEYS, PROJECT_ENTITY, RECORD_COLUMNS, type SharedTable } from './record-columns';
import { aliasedId, noteAlias, renameRow, TEXT_KEYED, type TextKeyed } from './record-alias';
import type { EntityState, FieldState } from './record-merge';
import type { LoggedChange, MergeContext } from './record-standing';
import { PEER_OWNER_PREFIX } from './peer-sessions';
import { makeRoomForNumber, NUMBERED, numberedId, renameNumberedRow } from './record-renumber';

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): number {
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
  return done.data?.changes ?? 0;
}

/** A row a change names that this copy has not written yet; the recompute writes it first and retries. */
export class MissingRowError extends Error {}

/** A recorded value as this copy stores it: a reference becomes the local id of the row it names. */
export function decodeValue(
  client: RbookDatabaseClient,
  table: SharedTable,
  column: string,
  value: unknown
): unknown {
  if (table === 'sessions' && column === 'captures')
    try {
      return decodeCaptures(value, (target, stable) => {
        const [row] = rows<{ id: string }>(
          client,
          `SELECT id FROM ${target} WHERE stable_event_id = ?`,
          [stable]
        );
        return row ? String(row.id) : null;
      });
    } catch (error) {
      if (error instanceof CaptureRowMissing) throw new MissingRowError(error.message);
      throw error;
    }
  const reference = RECORD_COLUMNS[table].references.find((ref) => ref.column === column);
  if (!reference || value === null || typeof value !== 'object') return value ?? null;
  if ('unresolved' in (value as object)) return (value as { unresolved: unknown }).unresolved;
  const stable = (value as { ref: string }).ref;
  const [row] = rows<{ id: unknown }>(
    client,
    `SELECT id FROM ${reference.table} WHERE stable_event_id = ?`,
    [stable]
  );
  if (!row)
    throw new MissingRowError(`${table}.${column} names ${stable}, which this copy does not hold`);
  return row.id;
}

/** The current value of a field as a change would carry it, for its root. */
export function currentEncoded(
  client: RbookDatabaseClient,
  entity: string,
  entityId: string,
  field: string
): unknown {
  if (entity === PROJECT_ENTITY) {
    const [scope, key] = field.split(/\.(.*)/s);
    if (scope === 'identity') {
      const [row] = rows<{ content: string }>(
        client,
        "SELECT content FROM contexts WHERE id = 'project_identity'"
      );
      const document = row ? (JSON.parse(row.content) as Record<string, unknown>) : {};
      return document[key] ?? null;
    }
    const [row] = rows<{ value: string }>(client, 'SELECT value FROM metadata WHERE key = ?', [
      key,
    ]);
    return row?.value ?? null;
  }
  const table = entity as SharedTable;
  const [row] = rows<Record<string, unknown>>(
    client,
    `SELECT "${field}" AS value FROM ${table} WHERE stable_event_id = ?`,
    [entityId]
  );
  return row ? encodeValue(client, table, field, row.value) : null;
}

function replaceHeads(client: RbookDatabaseClient, state: EntityState, field: FieldState): void {
  run(client, 'DELETE FROM record_heads WHERE entity = ? AND entity_id = ? AND field = ?', [
    state.entity,
    state.entityId,
    field.field,
  ]);
  for (const head of field.heads)
    run(
      client,
      'INSERT INTO record_heads (entity, entity_id, field, change_id) VALUES (?, ?, ?, ?)',
      [state.entity, state.entityId, field.field, head]
    );
  if (field.conflict)
    run(
      client,
      'INSERT INTO record_conflicts (entity, entity_id, field, detected_at) VALUES (?, ?, ?, ?) ON CONFLICT (entity, entity_id, field) DO NOTHING',
      [state.entity, state.entityId, field.field, new Date().toISOString()]
    );
  else
    run(client, 'DELETE FROM record_conflicts WHERE entity = ? AND entity_id = ? AND field = ?', [
      state.entity,
      state.entityId,
      field.field,
    ]);
}

function materializeProject(client: RbookDatabaseClient, state: EntityState): void {
  for (const field of state.fields) {
    replaceHeads(client, state, field);
    if (!('json' in field.value)) continue;
    const [scope, key] = field.field.split(/\.(.*)/s);
    if (scope === 'identity' && (IDENTITY_KEYS.document as readonly string[]).includes(key))
      run(
        client,
        "UPDATE contexts SET content = json_set(content, ?, json(?)) WHERE id = 'project_identity'",
        [`$.${key}`, canonicalJson(field.value.json)]
      );
    else if (scope === 'metadata' && (IDENTITY_KEYS.metadata as readonly string[]).includes(key)) {
      if (field.value.json === null) run(client, 'DELETE FROM metadata WHERE key = ?', [key]);
      else
        run(
          client,
          'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
          [key, String(field.value.json)]
        );
    }
  }
}

function materializeLink(client: RbookDatabaseClient, state: EntityState): void {
  const table = state.entity as SharedTable;
  const classes = RECORD_COLUMNS[table];
  const [field] = state.fields;
  const values = (('json' in field.value ? field.value.json : null) ?? {}) as Record<
    string,
    unknown
  >;
  // Every reference is decoded before anything is written, so a missing parent leaves no trace. A
  // link that should not exist and names a row this copy does not hold cannot be here either: there
  // is nothing to remove, and a live one waits for its parents (found by s96-m12's engine critic).
  let key: unknown[];
  try {
    key = classes.key.map((column) =>
      decodeValue(client, table, column, state.exists ? values[column] : keyPart(state, column))
    );
  } catch (error) {
    if (state.exists || !(error instanceof MissingRowError)) throw error;
    replaceHeads(client, state, field);
    return;
  }
  const columns = classes.recorded;
  const decoded = state.exists
    ? columns.map((column) => decodeValue(client, table, column, values[column] ?? null))
    : [];
  replaceHeads(client, state, field);
  const where = classes.key.map((column) => `"${column}" = ?`).join(' AND ');
  const present = rows(client, `SELECT 1 FROM ${table} WHERE ${where}`, key).length > 0;
  if (!state.exists) {
    if (present) run(client, `DELETE FROM ${table} WHERE ${where}`, key);
    return;
  }
  if (present)
    run(
      client,
      `UPDATE ${table} SET ${columns.map((column) => `"${column}" = ?`).join(', ')} WHERE ${where}`,
      [...decoded, ...key]
    );
  else
    run(
      client,
      `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      decoded
    );
}

/** Move a row that holds `id` but is not `stableId` to its own aliased id, so `id` is free. */
function makeRoomFor(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  table: TextKeyed,
  id: string,
  stableId: string
): void {
  const [holder] = rows<{ stable: string }>(
    client,
    `SELECT stable_event_id AS stable FROM ${table} WHERE id = ? AND stable_event_id IS NOT ?`,
    [id, stableId]
  );
  if (!holder) return;
  const [create] = rows<LoggedChange>(
    client,
    "SELECT * FROM record_changes WHERE kind = 'create' AND entity_id = ?",
    [holder.stable]
  );
  const moved = create ? aliasedId(client, ctx, create) : id;
  if (moved === id)
    throw new Error(`${table} ${id} is claimed by two rows that the alias rule cannot tell apart`);
  renameRow(client, table, holder.stable, id, moved);
}

/** A link's key column, read back from its entity id (the pair's canonical JSON, joined by `|`). */
function keyPart(state: EntityState, column: string): unknown {
  const classes = RECORD_COLUMNS[state.entity as SharedTable];
  const parts = state.entityId.split('|');
  return JSON.parse(parts[classes.key.indexOf(column)] ?? 'null');
}

/**
 * Write an entity's merged state: create the row when its create is live, update what changed,
 * remove a created row whose create is not live, and replace its heads and conflicts.
 */
export function materializeEntity(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  state: EntityState
): void {
  if (state.entity === PROJECT_ENTITY) return materializeProject(client, state);
  const table = state.entity as SharedTable;
  if (RECORD_COLUMNS[table].link) return materializeLink(client, state);
  const [row] = rows<Record<string, unknown>>(
    client,
    `SELECT rowid AS rowid_, * FROM ${table} WHERE stable_event_id = ?`,
    [state.entityId]
  );
  // Every reference is decoded before anything is written, so a missing parent leaves no trace.
  const decoded = new Map<string, unknown>();
  if (state.exists)
    for (const field of state.fields)
      if ('json' in field.value)
        decoded.set(field.field, decodeValue(client, table, field.field, field.value.json));
  for (const field of state.fields) replaceHeads(client, state, field);
  if (!state.exists) {
    if (row) run(client, `DELETE FROM ${table} WHERE stable_event_id = ?`, [state.entityId]);
    if (TEXT_KEYED.has(table))
      run(client, 'DELETE FROM record_aliases WHERE entity = ? AND stable_event_id = ?', [
        table,
        state.entityId,
      ]);
    return;
  }
  // ADR s96 §3: a created mission or sprint takes the id the alias rule gives it, and a row that
  // holds that id is moved to its own first.
  if (TEXT_KEYED.has(table) && state.create) {
    const id = aliasedId(client, ctx, state.create);
    makeRoomFor(client, ctx, table as TextKeyed, id, state.entityId);
    if (row && row.id !== id) {
      renameRow(client, table as TextKeyed, state.entityId, String(row.id), id);
      row.id = id;
    }
    decoded.set('id', id);
    if (!row) noteAlias(client, table as TextKeyed, state.entityId, id);
  }
  // s96-m13 (ADR s96 §7): a create of a numbered table takes the id its replica's renumber gives it,
  // and a row that holds that id is moved to its own first.
  if (NUMBERED.has(table) && state.create) {
    const id = numberedId(client, ctx, state.create);
    makeRoomForNumber(client, ctx, table, id, state.entityId);
    if (row && Number(row.id) !== id) {
      renameNumberedRow(client, table, state.entityId, Number(row.id), id);
      row.id = id;
    }
    decoded.set('id', id);
  }
  if (!row) {
    const names = [...decoded.keys(), 'stable_event_id'];
    const values = [...decoded.values(), state.entityId];
    const holders = names.map(() => '?');
    names.push('origin_seq');
    holders.push(`(SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM ${table})`);
    // ADR s96 §5: a peer's session carries an owner key no local process matches, so it is never
    // adopted and never closed by idle reconcile.
    if (table === 'sessions' && state.create && state.create.replica_id !== ctx.ownReplica) {
      names.push('owner_key', 'implicit');
      holders.push('?', '0');
      values.push(`${PEER_OWNER_PREFIX}${state.create.replica_id}`);
    }
    run(
      client,
      `INSERT INTO ${table} (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${holders.join(', ')})`,
      values
    );
    return;
  }
  const changed = [...decoded.entries()].filter(
    ([column, value]) => canonicalJson(row[column] ?? null) !== canonicalJson(value ?? null)
  );
  if (changed.length)
    run(
      client,
      `UPDATE ${table} SET ${changed.map(([column]) => `"${column}" = ?`).join(', ')} WHERE stable_event_id = ?`,
      [...changed.map(([, value]) => value), state.entityId]
    );
}
