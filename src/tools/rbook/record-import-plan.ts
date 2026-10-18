// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What an import would do (ADR s96 §9): every row of the copy matched or brought in, its values in the record's
// ABOUTME: ids, each differing field classified against the base, and each link compared once its ends are known.

import Database from 'better-sqlite3';
import type { RbookDatabaseClient } from './client';
import { canonicalJson, encodeValue } from './record-capture';
import { RECORD_COLUMNS, RECORDED_TABLES, type SharedTable } from './record-columns';
import { classifyField, columnsOf, history, readAll, readColumn } from './record-import-fields';
import { translated, type IdMaps } from './record-import-ids';
import type { ImportCopy, Marker } from './record-import-copy';
import { assignIds, holdBack, type Assigned, type Brought } from './record-import-assign';
import { emptyPlan, planLinks } from './record-import-links';
import {
  idOf,
  matchTables,
  tableRows,
  targetRows,
  timeMs,
  type PlanContext,
  type Row,
  type RowMatching,
} from './record-import-match';
import { mergeContext } from './record-standing';
import { readReplicaIdentity, recordedProjectId } from './replica-identity';

export { COMPARED } from './record-import-fields';

/** The times a copy-side change can carry, for the flag on a field archiving would drop. */
const TIMES = [
  'created_at',
  'started_at',
  'completed_at',
  'updated_at',
  'resolved_at',
  'archived_at',
];
/** Rows that name others first, so every row a reference names is matched before it is read. */
const ROW_TABLES = RECORDED_TABLES.filter((table) => !RECORD_COLUMNS[table].link);

export interface CopyRow {
  /** The row's id as the copy names it: a number, a text id, or a link's pair. */
  readonly id: string;
  /** Its id in this record once brought in, and its stable id; empty for a row left out. */
  readonly to: string;
  readonly stable: string;
  /** Its values, each reference and citation in this record's ids. */
  readonly values: Readonly<Row>;
  readonly at: string | null;
}

export interface FieldChange {
  readonly table: SharedTable;
  /** The row's id in this record. */
  readonly id: string;
  /** The record's stable id for the row, so the write names it whatever its local id; a link has none. */
  readonly stable: string;
  readonly field: string;
  /** The copy's value, in this record's ids. */
  readonly copy: unknown;
  readonly owner: unknown;
  /** What applying writes: the copy's value, or for appended text the record's with the copy's addition. */
  readonly write: unknown;
  /** The copy's row carries a time after the marker: likely the copy's own change. */
  readonly afterMarker: boolean;
  /** The base holds the row, so the field was classified against it. */
  readonly based: boolean;
}

/** A reference to a row the record will not hold. */
export interface LeftOutReference {
  /** `<table>:<id>` of the row that holds it, as the copy names it. */
  readonly row: string;
  readonly column: string;
  /** `<table>:<id>` of the row it names. */
  readonly names: string;
  /** Brought in without it, a link left out, or (false) a matched row's field the record keeps. */
  readonly brought: boolean;
  /** The row it names waits on an earlier import, so the record keeps its own value until then. */
  readonly waits?: boolean;
  /** A citation in a row brought in, which keeps the number the copy wrote. */
  readonly cites?: boolean;
  /** A matched row's: the copy's row carries a time after the marker, so likely the copy's change. */
  readonly afterMarker?: boolean;
}

export interface TablePlan {
  readonly table: SharedTable;
  readonly absent: boolean;
  /** Compared columns the copy's own schema lacked: the record's value stands. */
  readonly lacked: readonly string[];
  readonly copyRows: number;
  readonly targetRows: number;
  readonly identical: number;
  /** Fields only the record changed: its value stands. */
  readonly ownerChanged: number;
  /** Fields whose copy value the record has held since sharing, and changed since: its value stands. */
  readonly heldBefore: number;
  readonly copyChanged: readonly FieldChange[];
  readonly conflicts: readonly FieldChange[];
  /** Fields already in conflict in the record: left alone until that conflict is settled. */
  readonly inConflict: readonly FieldChange[];
  /** Of the fields in conflict, those whose copy value is already a candidate: an earlier import's. */
  readonly alreadyRaised: readonly FieldChange[];
  /** Flags set in the record and clear in the copy, with no base to tell: an added flag wins, the record's. */
  readonly flagKept: readonly FieldChange[];
  /** A matched link's fields the copy holds differently: a link merges whole, so the record's stand. */
  readonly linkDiffers: readonly FieldChange[];
  readonly own: readonly CopyRow[];
  readonly deletedOnOwner: readonly CopyRow[];
  /** The rows deleted on the owner that `--include` brings in. */
  readonly included: readonly CopyRow[];
  /** Own rows whose text id the record holds for another row: each takes `<id>~i<block>`. */
  readonly createdOnBoth: readonly string[];
  readonly leftOut: readonly LeftOutReference[];
  readonly broughtTwice: readonly string[];
  /** Copy rows an earlier import brought in whose create is not live yet: not brought again. */
  readonly waiting: readonly string[];
  /** Copy rows a create the record has not taken holds, whoever wrote it: they wait on it. */
  readonly waitingOnCreate: readonly string[];
  /** The copy's own rows a row an import brought in may be, alike but for their citation numbers. */
  readonly perhapsIn: ReadonlyArray<{ readonly id: string; readonly as: readonly string[] }>;
  /** The copy's own rows that name a waiting row, with the first one each names: they wait with it. */
  readonly heldBack: ReadonlyArray<{ readonly id: string; readonly names: string }>;
  /** The copy's ids of the rows the record holds too. */
  readonly inRecord: readonly string[];
  readonly ownerOnly: number;
}

export interface ImportPlan {
  readonly base: string | null;
  readonly marker: Marker | null;
  readonly tables: readonly TablePlan[];
}

/** The base's rows of a table, by id. */
function baseIndex(baseDb: Database.Database | null, table: SharedTable): Map<string, Row> {
  return new Map((baseDb ? tableRows(baseDb, table) : []).map((row) => [idOf(table, row), row]));
}

/** Every shared table of the copy against the record this client holds, with no write. */
export function planImport(
  copy: ImportCopy,
  target: RbookDatabaseClient,
  base: string | null,
  marker: Marker | null,
  include: ReadonlySet<string> = new Set()
): ImportPlan {
  const copyDb = new Database(copy.dbPath, { readonly: true });
  const baseDb = base ? new Database(base, { readonly: true, fileMustExist: true }) : null;
  try {
    const identity = readReplicaIdentity(target);
    if (!identity) throw new Error('Only a copy of a shared record takes in an import.');
    const replicas = readAll<{ replica: string }>(
      target,
      'SELECT DISTINCT replica_id AS replica FROM record_changes',
      []
    ).map((row) => row.replica);
    const ctx: PlanContext = {
      copy,
      copyDb,
      target,
      projectId: recordedProjectId(target),
      ownReplica: identity.replicaId,
      block: identity.block,
      replicas: [...new Set([...replicas, identity.replicaId])].sort(),
      markerMs: timeMs(marker?.createdAt),
      include,
      merge: mergeContext(target),
    };
    // Every row first, so a reference, a link's end or a citation reads in this record's ids, and
    // every row that waits is known before any id is given.
    const matchings = matchTables(ctx, ROW_TABLES);
    const valuesOf = new Map(ROW_TABLES.map((table) => [table, columnsOf(copy, table).values]));
    const { held: heldBack, waits } = holdBack(ctx, matchings, (table, row) =>
      valuesOf.get(table)!(row)
    );
    const assigned = new Map(
      ROW_TABLES.map((table) => [
        table,
        assignIds(ctx, matchings.get(table)!, heldBack.get(table)!),
      ])
    );
    const ids = new Map<SharedTable, Map<string, string | null>>();
    for (const [table, matching] of matchings) {
      const map = new Map<string, string | null>();
      for (const { row, other } of matching.matched) map.set(idOf(table, row), String(other.id));
      const { own, deletedOnOwner } = assigned.get(table)!;
      // A row left out as perhaps in the record already has no id here either, until it is included.
      for (const row of matching.unmatched) if (row.perhaps) map.set(row.id, null);
      for (const row of [...own, ...deletedOnOwner]) map.set(row.id, row.to || null);
      ids.set(table, map);
    }
    const held = new Map(
      ROW_TABLES.map((table) => [
        table,
        new Set(matchings.get(table)!.targets.map((row) => String(row.id))),
      ])
    );
    const holds = (table: SharedTable, id: string) => held.get(table)?.has(id) ?? false;
    const tables = RECORDED_TABLES.map((table) => {
      if (!copy.columns.has(table)) return emptyPlan(table, targetRows(target, table).length);
      if (RECORD_COLUMNS[table].link) return planLinks(ctx, table, ids, holds, waits);
      return planRows(ctx, matchings.get(table)!, assigned.get(table)!, heldBack.get(table)!, {
        ids,
        holds,
        waits,
        base: baseIndex(baseDb, table),
      });
    });
    return { base, marker, tables };
  } finally {
    copyDb.close();
    baseDb?.close();
  }
}

interface Lookups {
  readonly ids: IdMaps;
  readonly holds: (table: SharedTable, id: string) => boolean;
  readonly waits: (table: SharedTable, id: string) => boolean;
  readonly base: ReturnType<typeof baseIndex>;
}

function planRows(
  ctx: PlanContext,
  matching: RowMatching,
  assigned: Assigned,
  heldBack: ReadonlyMap<string, string>,
  { ids, holds, waits, base }: Lookups
): TablePlan {
  const table = matching.table;
  const { compared, lacked, values: valuesOf } = columnsOf(ctx.copy, table);
  const log = history(ctx.target, table, ctx.merge);
  const leftOut: LeftOutReference[] = [];
  // No row brought in names a row that waits: each that does was held back before ids were given.
  const brought = (rows: readonly Brought[]): CopyRow[] =>
    rows.map(({ row, id, to, stable, at }) => {
      const { values, unheld, cites } = translated(table, valuesOf(row), ids, holds, waits);
      if (to)
        leftOut.push(
          ...unheld.map((entry) => ({ row: `${table}:${id}`, ...entry, brought: true })),
          ...cites.map((entry) => ({ row: `${table}:${id}`, ...entry, brought: true, cites: true }))
        );
      return { id, to, stable, values: { ...values, id: to || values.id }, at };
    });
  let identical = 0;
  let ownerChanged = 0;
  let heldBefore = 0;
  const [copyChanged, conflicts, inConflict, alreadyRaised, flagKept]: FieldChange[][] = [
    [],
    [],
    [],
    [],
    [],
  ];
  for (const { row, other } of matching.matched) {
    const raw = valuesOf(row);
    const read = translated(table, raw, ids, holds, waits);
    const values = { ...read.values };
    const same = (column: string, value: unknown) =>
      canonicalJson(value ?? null) === canonicalJson(other[column] ?? null);
    const named = (column: string) =>
      RECORD_COLUMNS[table].references.find((reference) => reference.column === column)?.table;
    const latest = Math.max(...TIMES.map((column) => timeMs(row[column]) ?? 0));
    const afterMarker = ctx.markerMs !== null && latest > ctx.markerMs;
    // A field both stores hold alike is no difference where it names a row the record does not hold
    // either; a number the record has given another row is one, though it reads the same.
    const unheld = read.unheld.filter((entry) => {
      const to = named(entry.column);
      if (
        entry.waits ||
        !same(entry.column, raw[entry.column]) ||
        (to && holds(to, String(raw[entry.column])))
      )
        return true;
      values[entry.column] = other[entry.column];
      return false;
    });
    const skipped = new Set(unheld.map((entry) => entry.column));
    const here = `${table}:${idOf(table, row)}`;
    leftOut.push(...unheld.map((entry) => ({ row: here, ...entry, brought: false, afterMarker })));
    const stable = String(other.stable_event_id ?? '');
    // By the record's id: a row the base holds never takes another id after it, since renames and
    // renumbering move only rows created since sharing. Never by text, which either side may reword.
    const baseRow = base.get(idOf(table, other));
    let differs = skipped.size > 0;
    for (const field of compared) {
      if (skipped.has(field)) continue;
      if (canonicalJson(values[field] ?? null) === canonicalJson(other[field] ?? null)) continue;
      differs = true;
      const key = `${stable}\u0000${field}`;
      const encoded = canonicalJson(encodeValue(ctx.target, table, field, values[field]));
      const held = log.held.get(key)?.has(encoded);
      // The base read as its own store keeps the column; one it lacks cannot tell either side. The
      // values an earlier import brought are never a base: an older copy, or a sibling with the same
      // identity, would read as changed only on the copy and overwrite the record.
      const base = baseRow ? readColumn(table, baseRow, field) : undefined;
      const change = (write: unknown): FieldChange => ({
        table,
        id: String(other.id),
        stable,
        field,
        copy: values[field],
        owner: other[field],
        write,
        afterMarker,
        based: base !== undefined,
      });
      // A field in conflict is left alone: raised already, when the copy's value is a candidate.
      if (log.open.has(key)) {
        (log.candidates.get(key)?.has(encoded) ? alreadyRaised : inConflict).push(
          change(values[field])
        );
        continue;
      }
      const verdict = classifyField({
        table,
        field,
        copy: values[field],
        owner: other[field],
        base,
        root: log.roots.has(key) ? log.roots.get(key) : other[field],
        heldBefore: held ?? false,
        appendsLogged: log.appends.get(key) ?? new Set(),
      });
      if (verdict.kind === 'owner') ownerChanged += 1;
      else if (verdict.kind === 'held') heldBefore += 1;
      else if (verdict.kind === 'kept') flagKept.push(change(other[field]));
      else if (verdict.kind === 'copy') copyChanged.push(change(verdict.write));
      else if (verdict.kind === 'raise') conflicts.push(change(verdict.write));
      // A citation of a row left out, in a text applying writes or raises, keeps the copy's number.
      if (verdict.kind === 'copy' || verdict.kind === 'raise')
        leftOut.push(
          ...read.cites
            .filter((entry) => entry.column === field)
            .map((entry) => ({ row: here, ...entry, brought: false, cites: true, afterMarker }))
        );
    }
    if (!differs) identical += 1;
  }
  const matched = new Set(matching.matched.map(({ other }) => other));
  const own = brought(assigned.own);
  const deletedOnOwner = brought(assigned.deletedOnOwner);
  return {
    table,
    absent: false,
    lacked,
    copyRows: matching.rows.length,
    targetRows: matching.targets.length,
    identical,
    ownerChanged,
    heldBefore,
    copyChanged,
    conflicts,
    inConflict,
    alreadyRaised,
    flagKept,
    linkDiffers: [],
    own,
    deletedOnOwner,
    included: deletedOnOwner.filter((row) => row.to),
    createdOnBoth: assigned.createdOnBoth,
    leftOut,
    broughtTwice: matching.broughtTwice,
    waiting: matching.waiting,
    waitingOnCreate: matching.waitingOnCreate,
    perhapsIn: matching.perhapsIn,
    heldBack: [...heldBack].map(([id, names]) => ({ id, names })),
    inRecord: matching.matched.map(({ row }) => idOf(table, row)),
    ownerOnly: matching.targets.filter((row) => !matched.has(row)).length,
  };
}
