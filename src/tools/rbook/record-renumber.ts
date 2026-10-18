// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Renumbering a copy's own creates into a fresh block (ADR s96 §3, §7): a renumber change's id map, applied to
// ABOUTME: each create when it is written, and the in-place rename of a row already here with every reference to it.

import type { RbookDatabaseClient } from './client';
import {
  REPLICA_ENTITY,
  txnStanding,
  type LoggedChange,
  type MergeContext,
} from './record-standing';
import { BLOCK_SIZE, BLOCK_TABLES, blockRange } from './replica-identity';

/** The integer-keyed shared tables, whose ids a renumber moves; session ids clash by the alias rule. */
export const NUMBERED: ReadonlySet<string> = BLOCK_TABLES;

/** How each numbered table is named elsewhere in a store (s96-m13's universe 4). */
const NAMED_AS: Readonly<
  Record<string, { readonly link?: string; readonly proposal?: string; readonly vec?: string }>
> = {
  strategic_decisions: { link: 'decision', proposal: 'd', vec: 'decisions_vec.decision_id' },
  learnings: { link: 'learning', proposal: 'l', vec: 'learnings_vec.learning_id' },
  constraints: { proposal: 'c' },
  next_steps: {},
};

export interface RenumberRow {
  readonly entity: string;
  readonly entityId: string;
  readonly id: number;
}
/** A renumber change's value: the block its replica moves to, and each own create's id there. */
export interface RenumberValue {
  readonly block: number;
  readonly rows: readonly RenumberRow[];
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

const tablePresent = (client: RbookDatabaseClient, table: string): boolean =>
  rows(client, "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [table]).length > 0;

/** The rows a renumber change moves. */
export function renumberRows(change: Pick<LoggedChange, 'kind' | 'value'>): RenumberRow[] {
  if (change.kind !== 'renumber' || !change.value) return [];
  return [...((JSON.parse(change.value) as Partial<RenumberValue>).rows ?? [])];
}

/**
 * The id a create takes on this copy: the one its own replica's latest live renumber gives it, else
 * the id it was created with. A renumber covers only its own replica's creates.
 */
export function numberedId(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  create: LoggedChange
): number {
  for (const change of rows<LoggedChange>(
    client,
    "SELECT * FROM record_changes WHERE kind = 'renumber' AND entity = ? AND replica_id = ? ORDER BY replica_seq DESC",
    [REPLICA_ENTITY, create.replica_id]
  )) {
    const row = renumberRows(change).find(
      (moved) => moved.entity === create.entity && moved.entityId === create.entity_id
    );
    if (row && txnStanding(client, ctx, change.txn_id).state === 'live') return Number(row.id);
  }
  return Number((JSON.parse(create.value ?? '{}') as { id?: unknown }).id);
}

/**
 * Rename a numbered row in place: the row is written again under its new id, so its full-text
 * entry follows, then every reference universe 4 names, and its vector row is dropped so it is
 * embedded again. Runs under the merge's token.
 */
export function renameNumberedRow(
  client: RbookDatabaseClient,
  table: string,
  stableId: string,
  from: number,
  to: number
): void {
  const columns = rows<{ name: string; hidden: number }>(
    client,
    `SELECT name, hidden FROM pragma_table_xinfo('${table}')`
  )
    .filter((column) => column.hidden === 0)
    .map((column) => column.name);
  const [row] = rows<Record<string, unknown>>(
    client,
    `SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM ${table} WHERE stable_event_id = ?`,
    [stableId]
  );
  if (!row) return;
  // superseded_by is a foreign key that a delete sets to NULL, even with the merge's checks
  // deferred: the decisions that name this one are read before its row is written again.
  const superseded =
    table === 'strategic_decisions'
      ? rows<{ id: number }>(client, 'SELECT id FROM strategic_decisions WHERE superseded_by = ?', [
          from,
        ]).map((named) => named.id)
      : [];
  run(client, `DELETE FROM ${table} WHERE stable_event_id = ?`, [stableId]);
  const moved: Record<string, unknown> = { ...row, id: to };
  if ('last_embedded_hash' in moved) moved.last_embedded_hash = null;
  run(
    client,
    `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((column) => moved[column] ?? null)
  );
  if (superseded.length)
    run(
      client,
      `UPDATE strategic_decisions SET superseded_by = ? WHERE id IN (${superseded.map(() => '?').join(', ')})`,
      [to, ...superseded]
    );
  const named = NAMED_AS[table] ?? {};
  if (named.link && tablePresent(client, 'record_links')) {
    // The row's own citations move with it. A citation of it is text that names its old number, so
    // it no longer names this row: the merge's link repair links it to the row that holds the
    // number, as a copy that reads the text afresh does, and every copy holds the same links.
    run(client, 'UPDATE record_links SET from_id = ? WHERE from_kind = ? AND from_id = ?', [
      to,
      named.link,
      from,
    ]);
    run(client, 'DELETE FROM record_links WHERE to_kind = ? AND to_id = ?', [named.link, from]);
  }
  if (named.proposal && tablePresent(client, 'proposals'))
    run(client, 'UPDATE proposals SET record_id = ? WHERE record_id = ?', [
      `${named.proposal}:${to}`,
      `${named.proposal}:${from}`,
    ]);
  if (named.vec) {
    const [vecTable, key] = named.vec.split('.');
    if (tablePresent(client, vecTable))
      try {
        run(client, `DELETE FROM ${vecTable} WHERE ${key} = ?`, [from]);
      } catch {
        // The vector extension is not loaded here; the row is embedded again under its new id.
      }
  }
}

/**
 * Before a numbered create is written at `id`: a row of another create holding it moves first to the
 * id its own renumber gives it. Two creates claiming one id with no renumber are refused loudly.
 */
export function makeRoomForNumber(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  table: string,
  id: number,
  stableId: string,
  depth = 0
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
  const moved = create ? numberedId(client, ctx, create) : id;
  if (moved === id || depth > 8)
    throw new Error(
      `${table} ${id} is claimed by two rows and no renumber moves either, so this merge stops.`
    );
  makeRoomForNumber(client, ctx, table, moved, holder.stable, depth + 1);
  renameNumberedRow(client, table, holder.stable, id, moved);
}

/** The next free id of each numbered table in `block`, as this copy holds it. */
function allocator(client: RbookDatabaseClient, block: number): (table: string) => number {
  const { low, high } = blockRange(block);
  const next = new Map<string, number>();
  return (table) => {
    if (!next.has(table)) {
      const [top] = rows<{ top: number | null }>(
        client,
        `SELECT MAX(id) AS top FROM ${table} WHERE id BETWEEN ? AND ?`,
        [low, high]
      );
      next.set(table, (top?.top ?? low - 1) + 1);
    }
    const id = next.get(table)!;
    if (id > high) throw new Error(`${table}: block ${block} is full, so nothing was renumbered.`);
    next.set(table, id + 1);
    return id;
  };
}

/**
 * The renumber of this copy's own creates into `block` (ADR s96 §7): each create of a numbered table
 * gets the next free id there, in the order given. The caller records it as a `renumber` change in
 * its own stream and writes the rows, under the merge's token.
 */
export function planRenumber(
  client: RbookDatabaseClient,
  input: { readonly block: number; readonly creates: readonly LoggedChange[] }
): RenumberValue {
  const nextId = allocator(client, input.block);
  return {
    block: input.block,
    rows: input.creates
      .filter((create) => NUMBERED.has(create.entity) && create.entity_id)
      .map((create) => ({
        entity: create.entity,
        entityId: create.entity_id!,
        id: nextId(create.entity),
      })),
  };
}

/** When a replica was admitted, by the hybrid clock, with its id after it: the later of two renumbers. */
function admitted(ctx: MergeContext, replicaId: string): string {
  const known = ctx.members.get(replicaId) ?? ctx.unseen.get(replicaId);
  return `${known?.admittedAt ?? ''}\u0000${replicaId}`;
}

/**
 * Why a transaction waits for a renumber, or null (ADR s96 §7): in a block two replicas hold, a
 * create of the later-admitted one whose id a live create of the other already claims waits until a
 * renumber moves one of them. Every copy finds the same, so none writes two rows for one id.
 */
export function numberClash(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  changes: readonly LoggedChange[]
): string | null {
  if (!ctx.clashedBlocks.size) return null;
  for (const create of changes) {
    if (create.kind !== 'create' || !NUMBERED.has(create.entity)) continue;
    const id = numberedId(client, ctx, create);
    const block = Math.floor((id - 1) / BLOCK_SIZE);
    if (!ctx.clashedBlocks.has(block)) continue;
    const mine = admitted(ctx, create.replica_id);
    for (const other of rows<LoggedChange>(
      client,
      "SELECT * FROM record_changes WHERE kind = 'create' AND entity = ? AND replica_id <> ? AND CAST(json_extract(value, '$.id') AS INTEGER) = ?",
      [create.entity, create.replica_id, id]
    ))
      if (
        admitted(ctx, other.replica_id) < mine &&
        numberedId(client, ctx, other) === id &&
        txnStanding(client, ctx, other.txn_id).state === 'live'
      )
        return `waits for a renumber: block ${block} is held by two copies, and the other claims this ${create.entity} id ${id}`;
  }
  return null;
}
