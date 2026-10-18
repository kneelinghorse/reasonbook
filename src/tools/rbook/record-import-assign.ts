// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The ids a copy's rows take as an import brings them in (ADR s96 §9), once every row that waits is known: a row
// ABOUTME: naming one that waits, down any chain, waits with it and takes none, so the write gives each row its planned id.

import type { SharedTable } from './record-columns';
import { namesWaiting, NUMBERED } from './record-import-ids';
import type { PlanContext, Row, RowMatching, Unmatched } from './record-import-match';
import { blockRange } from './replica-identity';

/** A row of the copy that is not in the record: its id there and the stable id it takes. */
export interface Brought {
  readonly row: Row;
  readonly id: string;
  readonly to: string;
  readonly stable: string;
  readonly at: string | null;
}

/** The ids a table's rows brought in take, once every row that waits is known. */
export interface Assigned {
  readonly own: readonly Brought[];
  /** Rows dated at or before the marker: deleted on the owner. Only an included one has ids. */
  readonly deletedOnOwner: readonly Brought[];
  /** Own rows whose text id the record holds for another row: each takes `<id>~i<block>`. */
  readonly createdOnBoth: readonly string[];
}

/** The next numbers of the importer's block, as `allocateRowId` gives them in the write. */
function numbering(ctx: PlanContext, table: string): () => number {
  const { low, high } = blockRange(ctx.block);
  const top = ctx.target.getOne<{ top: number | null }>(
    `SELECT MAX(id) AS top FROM ${table} WHERE id BETWEEN ? AND ?`,
    [low, high]
  );
  if (!top.success) throw new Error(top.error?.message ?? `${table}: the block could not be read`);
  let next = (top.data?.top ?? low - 1) + 1;
  return () => next++;
}

/** A row the import would bring in: its own, or one left out that --include names. */
const brings = (ctx: PlanContext, table: SharedTable, row: Unmatched) =>
  (!row.deleted && !row.perhaps) || ctx.include.has(`${table}:${row.id}`);

/**
 * The rows the import would bring in that name a row that waits, by a reference or a citation: each
 * waits with it, and so does a row that names one of them, down any chain, before any id is given.
 * Each maps to the first waiting row it names, as `<table>:<id>`.
 */
export function holdBack(
  ctx: PlanContext,
  matchings: ReadonlyMap<SharedTable, RowMatching>,
  valuesOf: (table: SharedTable, row: Row) => Row
): {
  readonly held: ReadonlyMap<SharedTable, ReadonlyMap<string, string>>;
  readonly waits: (table: SharedTable, id: string) => boolean;
} {
  const waiting = new Map(
    [...matchings].map(([table, m]) => [table, new Set([...m.waiting, ...m.waitingOnCreate])])
  );
  const held = new Map([...matchings].map(([table]) => [table, new Map<string, string>()]));
  const waits = (table: SharedTable, id: string) =>
    (waiting.get(table)?.has(id) ?? false) || (held.get(table)?.has(id) ?? false);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [table, matching] of matchings)
      for (const row of matching.unmatched) {
        if (held.get(table)!.has(row.id) || !brings(ctx, table, row)) continue;
        const names = namesWaiting(table, valuesOf(table, row.row), waits);
        if (!names) continue;
        held.get(table)!.set(row.id, names);
        grew = true;
      }
  }
  return { held, waits };
}

/**
 * Give each row brought in its ids, in the copy's order: the next numbers of the importer's block,
 * its own text id, or `<id>~i<block>` for a text id the record holds for another row. The `i` keeps
 * it apart from every id the alias rule gives (ADR s96 §3). A row that waits takes none, so the
 * numbers the write gives match these.
 */
export function assignIds(
  ctx: PlanContext,
  matching: RowMatching,
  held: ReadonlyMap<string, string>
): Assigned {
  const table = matching.table;
  const taken = new Set(matching.targets.map((row) => String(row.id)));
  const next = NUMBERED.has(table) ? numbering(ctx, table) : null;
  const own: Brought[] = [];
  const deletedOnOwner: Brought[] = [];
  const createdOnBoth: string[] = [];
  for (const row of matching.unmatched) {
    if (held.has(row.id) || !brings(ctx, table, row)) {
      if (row.deleted)
        deletedOnOwner.push({ row: row.row, id: row.id, to: '', stable: '', at: row.at });
      continue;
    }
    let to = row.id;
    if (next) to = String(next());
    else if (row.clash || taken.has(row.id)) {
      createdOnBoth.push(row.id);
      to = `${row.id}~i${ctx.block}`;
      for (let n = 2; taken.has(to); n += 1) to = `${row.id}~i${ctx.block}-${n}`;
    }
    taken.add(to);
    const brought = { row: row.row, id: row.id, to, stable: row.stable, at: row.at };
    (row.deleted ? deletedOnOwner : own).push(brought);
  }
  return { own, deletedOnOwner, createdOnBoth };
}
