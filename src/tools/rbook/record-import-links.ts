// SPDX-License-Identifier: Apache-2.0
// ABOUTME: An import's link tables (ADR s96 §9), planned once every row an end names is matched: a link whose end the record
// ABOUTME: will not hold is left out, as the schema's cascade would leave it, and the rest match by their ends in its ids.

import { canonicalJson, encodeValue } from './record-capture';
import { RECORD_COLUMNS, type SharedTable } from './record-columns';
import { columnsOf, COMPARED } from './record-import-fields';
import { keyOf, translated, type IdMaps } from './record-import-ids';
import {
  idOf,
  ownTime,
  tableRows,
  targetRows,
  timeMs,
  type PlanContext,
  type Row,
} from './record-import-match';
import type { CopyRow, FieldChange, LeftOutReference, TablePlan } from './record-import-plan';
import { txnStanding } from './record-standing';

/** A table the copy never had: every compared column lacked, and every row the record's alone. */
export function emptyPlan(table: SharedTable, targetRows: number): TablePlan {
  return {
    table,
    absent: true,
    lacked: [...COMPARED[table]],
    copyRows: 0,
    targetRows,
    identical: 0,
    ownerChanged: 0,
    heldBefore: 0,
    copyChanged: [],
    conflicts: [],
    inConflict: [],
    alreadyRaised: [],
    flagKept: [],
    linkDiffers: [],
    own: [],
    deletedOnOwner: [],
    included: [],
    createdOnBoth: [],
    leftOut: [],
    broughtTwice: [],
    waiting: [],
    waitingOnCreate: [],
    perhapsIn: [],
    heldBack: [],
    inRecord: [],
    ownerOnly: targetRows,
  };
}

/**
 * A link table, once every row its ends name is matched: a link with an end the record will not
 * hold is left out, as the schema's cascade would leave it, and the rest match by their ends here.
 */
export function planLinks(
  ctx: PlanContext,
  table: SharedTable,
  ids: IdMaps,
  holds: (table: SharedTable, id: string) => boolean,
  waits: (table: SharedTable, id: string) => boolean
): TablePlan {
  const { compared, lacked, values: valuesOf } = columnsOf(ctx.copy, table);
  const rows = tableRows(ctx.copyDb, table);
  const targets = targetRows(ctx.target, table);
  const byKey = new Map(targets.map((row) => [keyOf(table, row), row]));
  const matched = new Set<Row>();
  const plan = emptyPlan(table, targets.length);
  // A link the record removed since sharing: its log holds a live unlink of the pair.
  const unlinked = new Set(
    (
      ctx.target.getMany<{ id: string; txn: string }>(
        "SELECT entity_id AS id, txn_id AS txn FROM record_changes WHERE entity = ? AND kind = 'unlink'",
        [table]
      ).data ?? []
    )
      .filter((change) => txnStanding(ctx.target, ctx.merge, change.txn).state === 'live')
      .map((change) => change.id)
  );
  const logged = (values: Row) =>
    RECORD_COLUMNS[table].key
      .map((column) => canonicalJson(encodeValue(ctx.target, table, column, values[column])))
      .join('|');
  const [linkDiffers, own, deletedOnOwner, leftOut]: [
    FieldChange[],
    CopyRow[],
    CopyRow[],
    LeftOutReference[],
  ] = [[], [], [], []];
  let identical = 0;
  const heldBack: Array<{ id: string; names: string }> = [];
  const inRecord: string[] = [];
  for (const row of rows) {
    const id = idOf(table, row);
    const raw = valuesOf(row);
    const read = translated(table, raw, ids, holds, waits);
    const { unheld } = read;
    const named = (column: string) =>
      RECORD_COLUMNS[table].references.find((reference) => reference.column === column)!.table;
    // A link the record holds with the same ends is the same link, though an end names a row the
    // record does not hold: its other ends read in the record's ids, and that end as the copy wrote it.
    const ends = { ...read.values };
    for (const entry of unheld) ends[entry.column] = raw[entry.column];
    const dangling =
      unheld.length > 0 &&
      unheld.every(
        (entry) => !entry.waits && !holds(named(entry.column), String(raw[entry.column]))
      );
    const alike = dangling ? byKey.get(keyOf(table, ends)) : undefined;
    const values = alike ? ends : read.values;
    // A link to a row that waits on an earlier import waits with it.
    const waiting = alike ? undefined : unheld.find((entry) => entry.waits);
    if (waiting) {
      heldBack.push({ id, names: waiting.names });
      continue;
    }
    if (unheld.length && !alike) {
      leftOut.push(...unheld.map((entry) => ({ row: `${table}:${id}`, ...entry, brought: true })));
      continue;
    }
    const pair = keyOf(table, values);
    const other = byKey.get(pair);
    if (other) {
      matched.add(other);
      inRecord.push(id);
      const differs = compared.filter(
        (field) => canonicalJson(values[field] ?? null) !== canonicalJson(other[field] ?? null)
      );
      for (const field of differs)
        linkDiffers.push({
          table,
          id: pair,
          stable: '',
          field,
          copy: values[field],
          owner: other[field],
          write: values[field],
          afterMarker: false,
          based: false,
        });
      if (!differs.length) identical += 1;
      continue;
    }
    const at = ownTime(table, row);
    const atMs = timeMs(at);
    const deleted =
      unlinked.has(logged(values)) ||
      (ctx.markerMs !== null && atMs !== null && atMs <= ctx.markerMs);
    const brought = !deleted || ctx.include.has(`${table}:${id}`);
    (deleted ? deletedOnOwner : own).push({ id, to: brought ? pair : '', stable: '', values, at });
  }
  return {
    ...plan,
    absent: false,
    lacked,
    copyRows: rows.length,
    identical,
    linkDiffers,
    own,
    deletedOnOwner,
    included: deletedOnOwner.filter((row) => row.to),
    leftOut,
    heldBack,
    inRecord,
    ownerOnly: targets.filter((row) => !matched.has(row)).length,
  };
}
