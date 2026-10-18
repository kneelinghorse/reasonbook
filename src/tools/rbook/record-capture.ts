// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Turns what the capture triggers staged in one transaction into change drafts (ADR s96 §4): one create per
// ABOUTME: new row, a set or append per changed column, links and unlinks, and the project identity's changed keys.

import type { RbookDatabaseClient } from './client';
import {
  IDENTITY_KEYS,
  PROJECT_ENTITY,
  RECORD_COLUMNS,
  identityField,
  metadataField,
  type SharedTable,
} from './record-columns';
import { encodeCaptureElement, encodeCaptures, type StableOf } from './record-capture-refs';
import { STAGE_TABLE } from './record-guards';
import { refuseUnlessAuthority } from './record-standing';
import { DAMAGED_COPY_REMEDY } from './replica-check';
import { REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';

export interface ChangeDraft {
  readonly kind: 'create' | 'set' | 'append' | 'link' | 'unlink';
  readonly entity: string;
  readonly entityId: string;
  readonly field: string | null;
  /** The change's value as JSON text. */
  readonly value: string;
}

interface StagedRow {
  readonly entity: string;
  readonly row_id: number | null;
  readonly op: string;
  readonly field: string | null;
  readonly old_value: unknown;
  readonly new_value: unknown;
}

/** JSON with object keys sorted at every depth, so a reordered key is never a change (ADR §4). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  return value;
}

/** A shared record keeps every row, so a delete cannot be recorded (ADR s96 §4). */
function deleteRefused(table: string): never {
  throw new ReplicaRefusal({
    code: REPLICA_ERROR_CODES.WRITE_REFUSED,
    message: `A shared record keeps every ${table} row, so this write, which deletes one, cannot be recorded.`,
    suggestion: 'Change its status instead: a shared record never deletes a row.',
  });
}

/**
 * s96-m12 (ADR s96 §5): a plain write to a field that holds values from copies that had not seen
 * each other is refused; only a settle, which names every one of them, writes it.
 */
function refuseConflicted(
  client: RbookDatabaseClient,
  entity: string,
  entityId: string,
  field: string,
  named: string
): void {
  const open = one<{ present: number }>(
    client,
    'SELECT 1 AS present FROM record_conflicts WHERE entity = ? AND entity_id = ? AND field = ?',
    [entity, entityId, field]
  );
  if (!open) return;
  throw new ReplicaRefusal({
    code: REPLICA_ERROR_CODES.FIELD_IN_CONFLICT,
    message: `${named}'s ${field} holds values from copies that had not seen each other, so a plain write to it is refused until it is settled.`,
    suggestion:
      'List the values with rbook_db(action="conflicts"), then keep one with rbook_db(action="settle", table, recordId, field, value).',
  });
}

/** Every row of a shared record has a stable id (s96-m01); one without is damage. */
function stableIdMissing(table: string): never {
  throw new ReplicaRefusal({
    code: REPLICA_ERROR_CODES.WRITE_REFUSED,
    message: `A ${table} row on this shared record has no stable id, so its change cannot be recorded.`,
    suggestion: `Every row of a shared record has a stable id, so this copy is damaged. ${DAMAGED_COPY_REMEDY}`,
  });
}

function one<T>(client: RbookDatabaseClient, sql: string, params: unknown[]): T | undefined {
  const row = client.getOne<T>(sql, params);
  if (!row.success) throw new Error(row.error?.message ?? `could not read: ${sql}`);
  return row.data ?? undefined;
}

/** A reference is written as the stable id of the row it names, or kept as it is when that row is gone. */
export function encodeValue(
  client: RbookDatabaseClient,
  table: SharedTable,
  column: string,
  raw: unknown
): unknown {
  // s96-m12: a capture names its mission and sprint by local id, kept in the log as stable ids.
  if (table === 'sessions' && column === 'captures') return encodeCaptures(raw, stableOf(client));
  const reference = RECORD_COLUMNS[table].references.find((ref) => ref.column === column);
  if (!reference || raw === null || raw === undefined) return raw ?? null;
  const row = one<{ stable: string | null }>(
    client,
    `SELECT stable_event_id AS stable FROM ${reference.table} WHERE id = ?`,
    [raw]
  );
  return row?.stable ? { ref: row.stable } : { unresolved: raw };
}

/**
 * s96-m12: keep a field's value from before its first change, for a row the baseline holds, so the field
 * returns to it when every change to it is refused (ADR s96 §5). A row the log created has its create.
 */
export function keepRoot(
  client: RbookDatabaseClient,
  entity: string,
  entityId: string,
  field: string,
  encoded: unknown
): void {
  const kept = client.execute(
    'INSERT INTO record_roots (entity, entity_id, field, value) VALUES (?, ?, ?, ?) ON CONFLICT (entity, entity_id, field) DO NOTHING',
    [entity, entityId, field, canonicalJson(encoded)]
  );
  if (!kept.success) throw new Error(kept.error?.message ?? 'the field root could not be kept');
}

/** Keep the root when the log holds no change to this field and no create of this row yet. */
export function keepRootIfFirst(
  client: RbookDatabaseClient,
  entity: string,
  entityId: string,
  field: string,
  encoded: unknown
): void {
  const earlier = one<{ present: number }>(
    client,
    "SELECT 1 AS present FROM record_changes WHERE entity = ? AND entity_id = ? AND (field = ? OR kind = 'create') LIMIT 1",
    [entity, entityId, field]
  );
  if (!earlier) keepRoot(client, entity, entityId, field, encoded);
}

function linkDraft(
  client: RbookDatabaseClient,
  table: SharedTable,
  kind: 'link' | 'unlink',
  values: Record<string, unknown>
): ChangeDraft {
  const classes = RECORD_COLUMNS[table];
  const encoded = Object.fromEntries(
    classes.recorded.map((column) => [column, encodeValue(client, table, column, values[column])])
  );
  const entityId = classes.key.map((column) => canonicalJson(encoded[column])).join('|');
  return { kind, entity: table, entityId, field: null, value: canonicalJson(encoded) };
}

/** A text that extends the old one is one append of its suffix (ADR §5); anything else is a set. */
function textAppend(old: unknown, now: unknown): string[] | null {
  if (typeof now !== 'string' || (old !== null && old !== undefined && typeof old !== 'string'))
    return null;
  const before = old ?? '';
  return now.length > before.length && now.startsWith(before)
    ? [JSON.stringify(now.slice(before.length))]
    : null;
}

/** A JSON array that extends the old one is one append per new element; anything else is a set. */
function arrayAppend(old: unknown, now: unknown): unknown[] | null {
  const parse = (text: unknown): unknown[] | null => {
    if (text === null || text === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(String(text));
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const was = parse(old);
  const is = parse(now);
  if (!was || !is || is.length <= was.length) return null;
  if (was.some((item, index) => canonicalJson(item) !== canonicalJson(is[index]))) return null;
  return is.slice(was.length);
}

/** Look up a mission's or a sprint's stable id by this copy's id. */
export function stableOf(client: RbookDatabaseClient): StableOf {
  return (table, id) =>
    one<{ stable: string | null }>(
      client,
      `SELECT stable_event_id AS stable FROM ${table} WHERE id = ?`,
      [id]
    )?.stable ?? null;
}

interface RowChanges {
  readonly table: SharedTable;
  readonly rowId: number;
  created: boolean;
  deleted: boolean;
  readonly fields: Map<string, unknown>;
}

/** The drafts for every change staged in this transaction, in the order each was first staged. */
export function draftsFromStage(client: RbookDatabaseClient, projectId: string): ChangeDraft[] {
  const staged = client.getMany<StagedRow>(`SELECT * FROM ${STAGE_TABLE} ORDER BY seq`);
  if (!staged.success)
    throw new Error(staged.error?.message ?? 'the staged changes could not be read');
  const order: Array<RowChanges | ChangeDraft | 'identity' | string> = [];
  const rows = new Map<string, RowChanges>();
  let identityBefore: { value: unknown } | null = null;
  const metadataBefore = new Map<string, unknown>();
  for (const entry of staged.data ?? []) {
    if (entry.entity === PROJECT_ENTITY) {
      if (entry.op === 'identity' && !identityBefore) {
        identityBefore = { value: entry.old_value };
        order.push('identity');
      } else if (entry.op === 'metadata' && entry.field && !metadataBefore.has(entry.field)) {
        metadataBefore.set(entry.field, entry.old_value);
        order.push(`metadata:${entry.field}`);
      }
      continue;
    }
    const table = entry.entity as SharedTable;
    if (RECORD_COLUMNS[table].link) {
      const values = JSON.parse(String(entry.op === 'link' ? entry.new_value : entry.old_value));
      order.push(linkDraft(client, table, entry.op === 'link' ? 'link' : 'unlink', values));
      continue;
    }
    const key = `${table}:${entry.row_id}`;
    let row = rows.get(key);
    if (!row) {
      row = {
        table,
        rowId: Number(entry.row_id),
        created: false,
        deleted: false,
        fields: new Map(),
      };
      rows.set(key, row);
      order.push(row);
    }
    if (entry.op === 'create') row.created = true;
    else if (entry.op === 'delete') row.deleted = true;
    else if (entry.field && !row.fields.has(entry.field))
      row.fields.set(entry.field, entry.old_value);
  }
  return order.flatMap((item) => {
    if (typeof item === 'string')
      return item === 'identity'
        ? identityDrafts(client, projectId, identityBefore?.value)
        : metadataDraft(client, projectId, item.slice('metadata:'.length), metadataBefore);
    return 'kind' in item ? [item] : rowDrafts(client, item);
  });
}

function rowDrafts(client: RbookDatabaseClient, row: RowChanges): ChangeDraft[] {
  const classes = RECORD_COLUMNS[row.table];
  if (row.deleted) deleteRefused(row.table);
  const current = one<Record<string, unknown>>(
    client,
    `SELECT ${classes.recorded.map((column) => `"${column}"`).join(', ')} FROM ${row.table} WHERE rowid = ?`,
    [row.rowId]
  );
  const entityId = current?.stable_event_id;
  if (!current || typeof entityId !== 'string' || !entityId) stableIdMissing(row.table);
  if (row.created) {
    const value = Object.fromEntries(
      classes.recorded
        .filter((column) => column !== 'stable_event_id')
        .map((column) => [column, encodeValue(client, row.table, column, current[column])])
    );
    return [
      { kind: 'create', entity: row.table, entityId, field: null, value: canonicalJson(value) },
    ];
  }
  const drafts: ChangeDraft[] = [];
  for (const [field, old] of row.fields) {
    const now = current[field];
    if (canonicalJson(old ?? null) === canonicalJson(now ?? null)) continue;
    keepRootIfFirst(client, row.table, entityId, field, encodeValue(client, row.table, field, old));
    const appended = classes.appends.includes(field)
      ? textAppend(old, now)
      : classes.arrayAppends.includes(field)
        ? arrayAppend(old, now)?.map((item) =>
            JSON.stringify(encodeCaptureElement(item, stableOf(client)))
          )
        : null;
    if (appended)
      for (const value of appended)
        drafts.push({ kind: 'append', entity: row.table, entityId, field, value });
    else {
      refuseConflicted(client, row.table, entityId, field, `${row.table} ${String(current.id)}`);
      drafts.push({
        kind: 'set',
        entity: row.table,
        entityId,
        field,
        value: canonicalJson(encodeValue(client, row.table, field, now)),
      });
    }
  }
  return drafts;
}

function parseDocument(text: unknown): Record<string, unknown> {
  try {
    const parsed: unknown = typeof text === 'string' ? JSON.parse(text) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function identityDrafts(
  client: RbookDatabaseClient,
  projectId: string,
  before: unknown
): ChangeDraft[] {
  const was = parseDocument(before);
  const is = parseDocument(
    one<{ content: string }>(
      client,
      "SELECT content FROM contexts WHERE id = 'project_identity'",
      []
    )?.content
  );
  const changed = IDENTITY_KEYS.document.filter(
    (key) => canonicalJson(was[key] ?? null) !== canonicalJson(is[key] ?? null)
  );
  if (changed.length) refuseUnlessAuthority(client, 'the project identity');
  return changed.map((key) => {
    refuseConflicted(client, PROJECT_ENTITY, projectId, identityField(key), 'the project identity');
    keepRootIfFirst(client, PROJECT_ENTITY, projectId, identityField(key), was[key] ?? null);
    return {
      kind: 'set' as const,
      entity: PROJECT_ENTITY,
      entityId: projectId,
      field: identityField(key),
      value: canonicalJson(is[key] ?? null),
    };
  });
}

function metadataDraft(
  client: RbookDatabaseClient,
  projectId: string,
  key: string,
  before: Map<string, unknown>
): ChangeDraft[] {
  const now = one<{ value: string }>(client, 'SELECT value FROM metadata WHERE key = ?', [
    key,
  ])?.value;
  const was = before.get(key);
  if ((was ?? null) === (now ?? null)) return [];
  refuseUnlessAuthority(client, 'the project identity');
  refuseConflicted(client, PROJECT_ENTITY, projectId, metadataField(key), 'the project identity');
  keepRootIfFirst(client, PROJECT_ENTITY, projectId, metadataField(key), was ?? null);
  return [
    {
      kind: 'set',
      entity: PROJECT_ENTITY,
      entityId: projectId,
      field: metadataField(key),
      value: canonicalJson(now ?? null),
    },
  ];
}
