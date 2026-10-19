// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Settling a conflicted field (ADR s96 §5): lists each open conflict with its candidates in this copy's ids,
// ABOUTME: and records a settle that names every head as seen; lineage and identity settle only on the owner's copy.

import type { RbookDatabaseClient } from './client';
import { canonicalJson, encodeValue } from './record-capture';
import { recordOwnChanges } from './record-changes';
import {
  IDENTITY_KEYS,
  PROJECT_ENTITY,
  RECORD_COLUMNS,
  ROOT_HEAD,
  type SharedTable,
} from './record-columns';
import { isRecordedStore } from './record-guards';
import { decodeValue } from './record-materialize';
import { appendsCoveredBy, entityState } from './record-merge';
import { mergeContext, writesAsOwner } from './record-standing';
import { underApplyToken } from './record-token';
import { recordedProjectId, REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';

export interface ConflictCandidate {
  /** The value as this copy shows it: a reference is this copy's id of the row it names. */
  readonly value: unknown;
  readonly author: string | null;
  readonly at: string;
  readonly changeId: string;
}

export interface OpenConflict {
  readonly table: string;
  /** The row's id as this copy names it: a decision number, a mission id; null for the project. */
  readonly recordId: string | null;
  readonly field: string;
  /** The value reads show until it is settled: the latest candidate. */
  readonly provisional: unknown;
  readonly candidates: readonly ConflictCandidate[];
  /** Only the owner's copy settles a lineage fork or the project identity (ADR s96 §5). */
  readonly ownerOnly: boolean;
}

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): void {
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

const ownerOnly = (entity: string, field: string): boolean =>
  entity === PROJECT_ENTITY || (entity === 'strategic_decisions' && field === 'superseded_by');

const shown = (
  client: RbookDatabaseClient,
  entity: string,
  field: string,
  value: unknown
): unknown =>
  entity === PROJECT_ENTITY ? value : decodeValue(client, entity as SharedTable, field, value);

/**
 * s96-m14 (ADR s96 §9): the field's root, when it stands as a head beside an import's sets: the
 * shared record's value from before the import, read in the merge's order (record-merge.ts rootOf).
 * A listed row exists, so its create, if it has one, is live: the create's value comes first, then
 * the root this copy kept for a baseline row. Both lookups use the log's entity index; working out
 * standing here instead made a long list slower than a hook's deadline.
 */
function rootCandidate(
  client: RbookDatabaseClient,
  entity: string,
  entityId: string,
  field: string
): ConflictCandidate[] {
  if (
    !rows(
      client,
      'SELECT 1 FROM record_heads WHERE entity = ? AND entity_id = ? AND field = ? AND change_id = ?',
      [entity, entityId, field, ROOT_HEAD]
    ).length
  )
    return [];
  const [create] = rows<{ value: string }>(
    client,
    "SELECT value FROM record_changes WHERE entity = ? AND entity_id = ? AND kind = 'create' LIMIT 1",
    [entity, entityId]
  );
  let encoded: unknown;
  if (create) {
    const values = JSON.parse(create.value) as Record<string, unknown>;
    encoded = field in values ? values[field] : null;
  } else {
    const [kept] = rows<{ value: string | null }>(
      client,
      'SELECT value FROM record_roots WHERE entity = ? AND entity_id = ? AND field = ?',
      [entity, entityId, field]
    );
    if (!kept) return [];
    encoded = JSON.parse(kept.value ?? 'null');
  }
  return [
    { value: shown(client, entity, field, encoded), author: null, at: '', changeId: ROOT_HEAD },
  ];
}

/** Every field in conflict on this copy, with its candidates, oldest conflict first. */
export function openConflicts(client: RbookDatabaseClient): OpenConflict[] {
  if (!isRecordedStore(client)) return [];
  return rows<{ entity: string; entity_id: string; field: string }>(
    client,
    'SELECT entity, entity_id, field FROM record_conflicts ORDER BY julianday(detected_at), entity, entity_id, field'
  ).map(({ entity, entity_id, field }) => {
    const heads = rows<{
      change_id: string;
      value: string;
      author_name: string | null;
      hlc: string;
    }>(
      client,
      `SELECT c.change_id, c.value, c.author_name, c.hlc FROM record_heads h
         JOIN record_changes c ON c.change_id = h.change_id
        WHERE h.entity = ? AND h.entity_id = ? AND h.field = ?
        ORDER BY c.hlc, c.change_id`,
      [entity, entity_id, field]
    );
    const root = rootCandidate(client, entity, entity_id, field);
    const candidates = [
      ...root,
      ...heads.map((head) => ({
        value: shown(client, entity, field, JSON.parse(head.value)),
        author: head.author_name,
        at: head.hlc,
        changeId: head.change_id,
      })),
    ];
    const [row] =
      entity === PROJECT_ENTITY
        ? []
        : rows<{ id: unknown; value: unknown }>(
            client,
            `SELECT id, "${field}" AS value FROM ${entity} WHERE stable_event_id = ?`,
            [entity_id]
          );
    return {
      table: entity,
      recordId: row ? String(row.id) : null,
      field,
      // s96-m14: what reads show, which an import's conflict keeps as the shared record's value and
      // which, for appended text, carries the additions that follow the value kept.
      provisional: row
        ? row.value
        : candidates.length
          ? candidates[candidates.length - 1].value
          : null,
      candidates,
      ownerOnly: ownerOnly(entity, field),
    };
  });
}

export interface SettleInput {
  readonly table: string;
  readonly recordId?: string | null;
  readonly field: string;
  readonly value: unknown;
}

/**
 * Keep one value for a conflicted field: a `settle` change names every head as seen, so it becomes
 * the field's one head on every copy that applies it (ADR s96 §5). The row takes the value at once.
 */
export function settleField(client: RbookDatabaseClient, input: SettleInput): OpenConflict {
  const project = input.table === 'project';
  const entity = project ? PROJECT_ENTITY : input.table;
  if (!project && (!(entity in RECORD_COLUMNS) || RECORD_COLUMNS[entity as SharedTable].link))
    throw new ReplicaRefusal({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${input.table} is not a table whose fields can be in conflict.`,
      suggestion:
        'Name one of the tables rbook_db(action="conflicts") lists, or "project" for the project identity.',
    });
  const [row] = project
    ? []
    : rows<{ stable: string }>(
        client,
        `SELECT stable_event_id AS stable FROM ${entity} WHERE id = ?`,
        [input.recordId]
      );
  const entityId = project ? recordedProjectId(client) : row?.stable;
  const conflict = openConflicts(client).find(
    (open) =>
      open.table === entity &&
      open.field === input.field &&
      (project || open.recordId === String(input.recordId))
  );
  if (!entityId || !conflict)
    throw new ReplicaRefusal({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        `${input.table} ${input.recordId ?? ''}'s ${input.field} is not in conflict, so there is nothing to settle.`.replace(
          '  ',
          ' '
        ),
      suggestion:
        'Write the field as usual, or list what is in conflict with rbook_db(action="conflicts").',
    });
  const ctx = mergeContext(client);
  if (conflict.ownerOnly && !writesAsOwner(client, ctx))
    throw new ReplicaRefusal({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `Only the owner's copy settles ${project ? 'the project identity' : 'a decision lineage fork'}.`,
      suggestion: "Ask the owner to settle it from the owner's copy.",
    });
  // A settle keeps one of the values copies wrote; any other value is a plain write, after it.
  const kept = canonicalJson(input.value);
  if (!conflict.candidates.some((candidate) => canonicalJson(candidate.value) === kept))
    throw new ReplicaRefusal({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${kept} is not one of the values ${conflict.recordId ? `${input.table} ${conflict.recordId}` : 'the project identity'}'s ${input.field} holds, so it cannot settle it.`,
      suggestion:
        'Keep one of the values rbook_db(action="conflicts") lists, then write the field as usual if it needs another.',
      validValues: conflict.candidates.map((candidate) => canonicalJson(candidate.value)),
    });
  const encoded = project
    ? input.value
    : encodeValue(client, entity as SharedTable, input.field, input.value);
  // s96-m14: a settle of an appended field covers only the additions the value it keeps had
  // applied; every other addition follows it, as the merge reads it, so none is dropped.
  const classes = project ? null : RECORD_COLUMNS[entity as SharedTable];
  const appended =
    !!classes &&
    (classes.appends.includes(input.field) || classes.arrayAppends.includes(input.field));
  const covers = appended
    ? appendsCoveredBy(
        client,
        ctx,
        entity,
        entityId,
        conflict.candidates
          .filter((candidate) => canonicalJson(candidate.value) === kept)
          .map((candidate) => candidate.changeId)
      )
    : undefined;
  // Under the merge's token, after the copy check (record-token.ts): a copy it refuses settles
  // nothing, however it was opened.
  const done = client.writeTransaction(() =>
    underApplyToken(client, () => {
      if (project) writeIdentityField(client, input.field, encoded);
      else
        run(client, `UPDATE ${entity} SET "${input.field}" = ? WHERE stable_event_id = ?`, [
          decodeValue(client, entity as SharedTable, input.field, encoded),
          entityId,
        ]);
      recordOwnChanges(client, [
        {
          kind: 'settle',
          entity,
          entityId,
          field: input.field,
          value: canonicalJson(encoded),
          covers,
        },
      ]);
      if (appended) {
        const merged = entityState(client, mergeContext(client), entity, entityId).fields.find(
          (state) => state.field === input.field
        )?.value;
        if (merged && 'json' in merged)
          run(client, `UPDATE ${entity} SET "${input.field}" = ? WHERE stable_event_id = ?`, [
            decodeValue(client, entity as SharedTable, input.field, merged.json),
            entityId,
          ]);
      }
      run(client, 'DELETE FROM record_conflicts WHERE entity = ? AND entity_id = ? AND field = ?', [
        entity,
        entityId,
        input.field,
      ]);
    })
  );
  if (!done.success) throw new ReplicaRefusal(done.error!);
  return conflict;
}

function writeIdentityField(client: RbookDatabaseClient, field: string, value: unknown): void {
  const [scope, key] = field.split(/\.(.*)/s);
  if (scope === 'identity' && (IDENTITY_KEYS.document as readonly string[]).includes(key))
    run(
      client,
      "UPDATE contexts SET content = json_set(content, ?, json(?)) WHERE id = 'project_identity'",
      [`$.${key}`, canonicalJson(value)]
    );
  else if (scope === 'metadata' && (IDENTITY_KEYS.metadata as readonly string[]).includes(key))
    run(
      client,
      'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      [key, String(value)]
    );
  else throw new Error(`${field} is not a recorded field of the project identity`);
}
