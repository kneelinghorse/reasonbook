// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Which record row each row of a copy is (ADR s96 §9), in passes over every table: a stable id, an earlier import's
// ABOUTME: id or a natural key, then a numbered row's text and time in the record's ids, then a create not live yet.

import type Database from 'better-sqlite3';
import type { RbookDatabaseClient } from './client';
import { RECORD_COLUMNS, type SharedTable } from './record-columns';
import type { ImportCopy } from './record-import-copy';
import {
  entityStates,
  importedStable,
  keyOf,
  maskedText,
  TEXT,
  textInRecord,
  walkImports,
  type IdMaps,
} from './record-import-ids';
import { txnStanding, type MergeContext, type StandingState } from './record-standing';
import { storedTimeMs } from './stored-time';

export type Row = Record<string, unknown>;

/** A row's own time, the first of these it holds (old missions lack `created_at`). */
const OWN_TIME: Readonly<Partial<Record<SharedTable, readonly string[]>>> = {
  strategic_decisions: ['created_at'],
  learnings: ['created_at'],
  missions: ['created_at', 'started_at', 'completed_at'],
  sessions: ['started_at'],
  next_steps: ['created_at'],
  constraints: ['created_at'],
  session_missions: ['linked_at'],
};

export interface PlanContext {
  readonly copy: ImportCopy;
  readonly copyDb: Database.Database;
  readonly target: RbookDatabaseClient;
  readonly projectId: string;
  readonly ownReplica: string;
  readonly block: number;
  /** Every copy of the record whose changes this copy holds, its own included, sorted. */
  readonly replicas: readonly string[];
  readonly markerMs: number | null;
  /** Rows labelled deleted on the owner, or perhaps in the record, to bring in anyway, as `<table>:<id>`. */
  readonly include: ReadonlySet<string>;
  readonly merge: MergeContext;
}

/** A row of the copy no pass matched, before it is given ids. */
export interface Unmatched {
  readonly row: Row;
  readonly id: string;
  readonly at: string | null;
  /** Dated at or before the marker, and not perhaps in the record: deleted on the owner. */
  readonly deleted: boolean;
  /** Perhaps in the record already (`perhapsIn`), so left out unless --include names it. */
  readonly perhaps: boolean;
  /** A text id created on both copies, which takes `<id>~i<block>`. */
  readonly clash: boolean;
  /** The stable id it takes if brought in: the first attempt this copy's log never named. */
  readonly stable: string;
}

export interface RowMatching {
  readonly table: SharedTable;
  readonly rows: readonly Row[];
  readonly targets: readonly Row[];
  readonly matched: ReadonlyArray<{ readonly row: Row; readonly other: Row }>;
  /** Copy rows two copies of the record each brought in before they synced. */
  readonly broughtTwice: readonly string[];
  /** Copy rows an earlier import brought in whose create is not live yet: it may still be taken. */
  readonly waiting: readonly string[];
  /** Copy rows a create not live yet holds, by natural key or text and time, whoever wrote it. */
  readonly waitingOnCreate: readonly string[];
  /**
   * The copy's rows a row an import brought in may be, alike but for their citation numbers, with
   * the record's ids of every row each may be (none for a create not live yet): each is left out
   * unless --include names it.
   */
  readonly perhapsIn: ReadonlyArray<{ readonly id: string; readonly as: readonly string[] }>;
  readonly unmatched: readonly Unmatched[];
}

export function tableRows(db: Database.Database, table: string): Row[] {
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  } catch {
    return [];
  }
}

export function targetRows(client: RbookDatabaseClient, table: string): Row[] {
  const read = client.getMany<Row>(`SELECT * FROM ${table}`);
  if (!read.success) throw new Error(read.error?.message ?? `${table} could not be read`);
  return read.data ?? [];
}

export function idOf(table: SharedTable, row: Row): string {
  return RECORD_COLUMNS[table].key.map((column) => String(row[column])).join('|');
}

export function ownTime(table: SharedTable, row: Row): string | null {
  for (const column of OWN_TIME[table] ?? []) {
    const value = row[column];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

export function timeMs(time: unknown): number | null {
  const parsed = storedTimeMs(typeof time === 'string' ? time : null);
  return Number.isNaN(parsed) ? null : parsed;
}

interface Logged {
  readonly id: string;
  readonly kind: string;
  readonly txn: string;
}

/** A row of the copy as the passes see it: matched, waiting, or neither yet. */
interface Working {
  readonly row: Row;
  readonly id: string;
  readonly clash: boolean;
  readonly fresh: () => string;
  other?: Row;
  waiting: boolean;
  onCreate?: boolean;
}

interface Pass {
  readonly table: SharedTable;
  readonly rows: readonly Row[];
  readonly targets: readonly Row[];
  readonly logged: readonly Logged[];
  readonly states: ReadonlyMap<string, StandingState>;
  readonly working: readonly Working[];
  readonly broughtTwice: string[];
  /** The masked keys of the creates not live yet, for the rows the dry run says they may be. */
  readonly pendingMasked: Set<string>;
}

/** A numbered row's text in this record's ids, with its creation time: the same for the same row. */
function contentKey(table: SharedTable, row: Row, ids: IdMaps): string | null {
  const at = timeMs(row.created_at);
  const text = textInRecord(table, row, ids);
  return at !== null && text ? `${at}\u0000${text}` : null;
}

/** The same with each single-id citation's number masked: alike for rows that differ only there. */
function maskedKey(table: SharedTable, row: Row): string | null {
  const at = timeMs(row.created_at);
  const text = maskedText(table, row);
  return at !== null && text ? `${at}\u0000${text}` : null;
}

/** By a stable id both held, then the id an earlier import gave the row on any copy, then by key. */
function firstPass(ctx: PlanContext, table: SharedTable): Pass {
  const rows = ctx.copy.columns.has(table) ? tableRows(ctx.copyDb, table) : [];
  const targets = targetRows(ctx.target, table);
  const ownStable = ctx.copy.ownStable.get(table) ?? new Set<string>();
  const byStable = new Map(targets.map((row) => [String(row.stable_event_id ?? ''), row]));
  const byKey = new Map(targets.map((row) => [keyOf(table, row), row]));
  const read = ctx.target.getMany<Logged>(
    'SELECT entity_id AS id, kind, txn_id AS txn FROM record_changes WHERE entity = ? AND entity_id IS NOT NULL',
    [table]
  );
  if (!read.success) throw new Error(read.error?.message ?? 'the change log could not be read');
  const logged = read.data ?? [];
  const states = entityStates(logged, (txn) => txnStanding(ctx.target, ctx.merge, txn).state);
  const madeAfter = (row: Row) => {
    const at = timeMs(ownTime(table, row));
    return ctx.markerMs !== null && at !== null && at > ctx.markerMs;
  };
  const broughtTwice: string[] = [];
  const working = rows.map((row): Working => {
    const stable = typeof row.stable_event_id === 'string' ? row.stable_event_id : null;
    const id = idOf(table, row);
    // A row's identities: its own stable id, and its natural key, which an import of the copy from
    // before it had stable ids derived from. A row's creation time never moves, so each import
    // derives the same stable id from either.
    const identities = [
      ...(stable && ownStable.has(stable) ? [stable] : []),
      `key:${keyOf(table, row)}`,
    ];
    const created = timeMs(row.created_at) ?? 0;
    const derive = (identity: string, replica: string) => (attempt: number) =>
      importedStable(ctx.projectId, table, identity, replica, attempt, created);
    const fresh = () => {
      const walk = walkImports(derive(identities[0], ctx.ownReplica), byStable, states);
      return derive(identities[0], ctx.ownReplica)('next' in walk ? walk.next : 0);
    };
    let other = stable && ownStable.has(stable) ? byStable.get(stable) : undefined;
    let waiting = false;
    if (!other) {
      const earlier = new Set<Row>();
      for (const replica of ctx.replicas)
        for (const identity of identities) {
          const walk = walkImports(derive(identity, replica), byStable, states);
          if ('waiting' in walk) waiting = true;
          if ('found' in walk) {
            earlier.add(walk.found);
            break;
          }
        }
      if (earlier.size > 1)
        broughtTwice.push(`${id} as ${[...earlier].map((row) => String(row.id)).join(' and ')}`);
      other = [...earlier][0];
    }
    let clash = false;
    if (!other) {
      other = byKey.get(keyOf(table, row));
      // Two different stable ids, each row made after the copy: one text id created on both copies.
      if (
        other &&
        !TEXT[table] &&
        stable &&
        ownStable.has(stable) &&
        other.stable_event_id &&
        other.stable_event_id !== stable &&
        madeAfter(row) &&
        madeAfter(other)
      ) {
        clash = true;
        other = undefined;
      }
    }
    return { row, id, clash, fresh, other, waiting };
  });
  return { table, rows, targets, logged, states, working, broughtTwice, pendingMasked: new Set() };
}

/**
 * A numbered row whose text, in this record's ids, and creation time a record row no other copy row
 * matched holds: the same row, which an import of another version of this copy renumbered, its
 * citations rewritten. A citation may name a row matched only here, so the pass runs until no more
 * match. Each record row is matched once.
 */
function matchByContent(
  passes: ReadonlyMap<SharedTable, Pass>,
  ids: Map<SharedTable, Map<string, string | null>>
): void {
  const none: IdMaps = new Map();
  const tables = [...passes].filter(([table]) => TEXT[table]);
  // Each free record row's text as it stands, which never moves.
  const free = new Map(
    tables.map(([table, pass]) => {
      const taken = new Set(pass.working.flatMap((entry) => (entry.other ? [entry.other] : [])));
      const rows = pass.targets.filter((row) => !taken.has(row));
      return [table, rows.map((row) => ({ row, key: contentKey(table, row, none) }))] as const;
    })
  );
  for (let found = true; found; ) {
    found = false;
    for (const [table, pass] of tables)
      for (const entry of pass.working) {
        if (entry.other || entry.clash) continue;
        const key = contentKey(table, entry.row, ids);
        const other = key ? free.get(table)!.find((candidate) => candidate.key === key) : undefined;
        if (!other) continue;
        entry.other = other.row;
        ids.get(table)!.set(entry.id, String(other.row.id));
        free.set(
          table,
          free.get(table)!.filter((candidate) => candidate !== other)
        );
        found = true;
      }
  }
}

/**
 * The copy's numbered rows that a row created since sharing, or a create not live yet, holds in the
 * same moment but for its citation numbers: perhaps the same row, which an import of another version
 * renumbered, its citations in a cycle no pass can start. Alike but for numbers is no proof, so
 * nothing pairs them; the dry run names each, with every record row it may be (none: a create).
 */
function perhapsIn(pass: Pass): Array<{ id: string; as: string[] }> {
  if (!TEXT[pass.table]) return [];
  const created = new Set(
    pass.logged.filter((change) => change.kind === 'create').map((change) => change.id)
  );
  const taken = new Set(pass.working.flatMap((entry) => (entry.other ? [entry.other] : [])));
  const twins = new Map<string, string[]>();
  for (const row of pass.targets) {
    const masked =
      !taken.has(row) && created.has(String(row.stable_event_id ?? ''))
        ? maskedKey(pass.table, row)
        : null;
    if (masked) twins.set(masked, [...(twins.get(masked) ?? []), String(row.id)]);
  }
  return pass.working.flatMap((entry) => {
    if (entry.other || entry.waiting || entry.onCreate || entry.clash) return [];
    const masked = maskedKey(pass.table, entry.row);
    const as = masked ? (twins.get(masked) ?? (pass.pendingMasked.has(masked) ? [] : null)) : null;
    return as ? [{ id: entry.id, as }] : [];
  });
}

/**
 * A row no pass matched that a create in the log, not live yet, holds as the record would match it
 * once live: by natural key, or a numbered row by its text and creation time. The row waits on that
 * create rather than coming in beside it. Nothing shows whether it is an import of this copy, which a
 * walk could not derive, or a member's own write, so the dry run says only that it waits on it.
 */
function waitOnCreates(ctx: PlanContext, pass: Pass, ids: IdMaps): void {
  const none: IdMaps = new Map();
  const keys = new Set<string>();
  const contents = new Set<string>();
  for (const change of pass.logged) {
    const state = pass.states.get(change.id);
    if (change.kind !== 'create' || state === 'live' || state === 'refused') continue;
    const [create] =
      ctx.target.getMany<{ value: string }>(
        "SELECT value FROM record_changes WHERE entity = ? AND entity_id = ? AND kind = 'create' LIMIT 1",
        [pass.table, change.id]
      ).data ?? [];
    const values = JSON.parse(create?.value ?? '{}') as Row;
    keys.add(keyOf(pass.table, values));
    const masked = maskedKey(pass.table, values);
    if (masked) pass.pendingMasked.add(masked);
    const content = contentKey(pass.table, values, none);
    if (content) contents.add(content);
  }
  for (const entry of pass.working) {
    if (entry.other || entry.waiting || entry.clash) continue;
    const content = contentKey(pass.table, entry.row, ids);
    if (keys.has(keyOf(pass.table, entry.row)) || (content && contents.has(content)))
      entry.onCreate = true;
  }
}

/**
 * Match every table's rows (no link table's), in passes, before any id is given: a stable id both
 * held, the id an earlier import gave the row on any copy of the record, or its natural key; then a
 * numbered row's text and creation time; then a create not live yet, which the row waits on.
 */
export function matchTables(
  ctx: PlanContext,
  tables: readonly SharedTable[]
): Map<SharedTable, RowMatching> {
  const passes = new Map(tables.map((table) => [table, firstPass(ctx, table)]));
  const ids = new Map<SharedTable, Map<string, string | null>>(
    [...passes].map(([table, pass]) => [
      table,
      new Map<string, string | null>(
        pass.working.flatMap((entry) =>
          entry.other ? [[entry.id, String(entry.other.id)] as const] : []
        )
      ),
    ])
  );
  matchByContent(passes, ids);
  for (const pass of passes.values()) waitOnCreates(ctx, pass, ids);
  return new Map(
    [...passes].map(([table, pass]) => {
      const matched = pass.working.filter((entry) => entry.other);
      const rest = pass.working.filter((entry) => !entry.other);
      const perhaps = new Map(perhapsIn(pass).map((row) => [row.id, row.as]));
      const unmatched = rest
        .filter((entry) => !entry.waiting && !entry.onCreate)
        .map((entry): Unmatched => {
          const at = ownTime(table, entry.row);
          const atMs = timeMs(at);
          const dated = ctx.markerMs !== null && atMs !== null && atMs <= ctx.markerMs;
          // One dated before the marker that an import of another version brought back is perhaps in.
          return {
            row: entry.row,
            id: entry.id,
            at,
            deleted: dated && !perhaps.has(entry.id),
            perhaps: perhaps.has(entry.id),
            clash: entry.clash,
            stable: entry.fresh(),
          };
        });
      return [
        table,
        {
          table,
          rows: pass.rows,
          targets: pass.targets,
          matched: matched.map((entry) => ({ row: entry.row, other: entry.other! })),
          broughtTwice: pass.broughtTwice,
          waiting: rest.filter((entry) => entry.waiting).map((entry) => entry.id),
          waitingOnCreate: rest
            .filter((entry) => !entry.waiting && entry.onCreate)
            .map((entry) => entry.id),
          perhapsIn: unmatched
            .filter((row) => row.perhaps)
            .map((row) => ({ id: row.id, as: perhaps.get(row.id)! })),
          unmatched,
        },
      ];
    })
  );
}
