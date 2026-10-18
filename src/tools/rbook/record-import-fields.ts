// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Which fields an import compares and how it classifies one the copy holds differently (ADR s96 §9): against the
// ABOUTME: base, the values the record has held, and for appended text what each side added; a later review comes in.

import type { RbookDatabaseClient } from './client';
import { canonicalJson } from './record-capture';
import { decodeCaptureElement } from './record-capture-refs';
import {
  GENESIS,
  IMPORT_BASE,
  RECORD_COLUMNS,
  RECORDED_TABLES,
  type SharedTable,
} from './record-columns';
import type { ImportCopy } from './record-import-copy';
import type { Row } from './record-import-match';
import { decodeValue } from './record-materialize';
import { mergeContext, txnStanding, type MergeContext } from './record-standing';
import { storedTimeMs } from './stored-time';

/** A mission's or sprint's id here from its stable id, as a capture names it. */
const localIdOf =
  (client: RbookDatabaseClient) =>
  (table: 'missions' | 'sprints', stable: string): string | null => {
    const read = client.getOne<{ id: unknown }>(
      `SELECT id FROM ${table} WHERE stable_event_id = ?`,
      [stable]
    );
    return read.success && read.data ? String(read.data.id) : null;
  };

/** The genesis stamp's generated columns and a derived column: never compared. */
const NOT_COMPARED: ReadonlySet<string> = new Set([
  ...GENESIS.filter((column) => !column.startsWith('author_')),
  'source_chunk_ids',
]);

/** Universe 1 of the build note: each table's compared columns. */
export const COMPARED: Readonly<Record<SharedTable, readonly string[]>> = Object.fromEntries(
  RECORDED_TABLES.map((table) => {
    const classes = RECORD_COLUMNS[table];
    const skip = new Set([...classes.key, ...classes.perCopyLocal, ...classes.perCopyDerived]);
    return [
      table,
      classes.recorded.filter((column) => !skip.has(column) && !NOT_COMPARED.has(column)),
    ];
  })
) as unknown as Record<SharedTable, readonly string[]>;

/** The one rename among the schema migrations (universe 2): a decision's or learning's session. */
const RENAMED: Readonly<Partial<Record<SharedTable, Readonly<Record<string, string>>>>> = {
  strategic_decisions: { author_session_id: 'session_id' },
  learnings: { author_session_id: 'session_id' },
};

/**
 * A column's value in a row of a copy or of the base, under the name that store keeps it: a renamed
 * column's old name while the store keeps it, even beside a new one the share step added empty, and
 * the new name once the schema step renamed it. Undefined when the row holds the column under neither.
 */
export function readColumn(table: SharedTable, row: Row, column: string): unknown {
  const old = RENAMED[table]?.[column];
  if (old && old in row) return row[old];
  return column in row ? row[column] : undefined;
}

/** The copy's compared columns of a table, each read under the name its store keeps it. */
export function columnsOf(copy: ImportCopy, table: SharedTable) {
  const held = copy.columns.get(table) ?? new Set<string>();
  const heldColumn = (column: string) =>
    held.has(column) || held.has(RENAMED[table]?.[column] ?? '');
  const compared = COMPARED[table].filter(heldColumn);
  const lacked = COMPARED[table].filter((column) => !heldColumn(column));
  const values = (row: Row): Row =>
    Object.fromEntries(
      [...RECORD_COLUMNS[table].key, ...compared].map((column) => [
        column,
        readColumn(table, row, column),
      ])
    );
  return { compared, lacked, values };
}

export function readAll<T>(client: RbookDatabaseClient, sql: string, params: unknown[]): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

/**
 * What the record's log holds for one table's fields, live changes only: every value each field
 * has held, its value from before any change, in this copy's ids, and its additions, as JSON of
 * what reads show. A change no longer live was never the record's, so it counts for nothing.
 */
export function history(
  client: RbookDatabaseClient,
  table: SharedTable,
  ctx: MergeContext = mergeContext(client)
) {
  const held = new Map<string, Set<string>>();
  const appends = new Map<string, Set<string>>();
  const roots = new Map<string, unknown>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) =>
    map.set(key, (map.get(key) ?? new Set()).add(value));
  const decoded = (field: string, value: unknown) =>
    decodeValue(client, table, field, value === undefined ? null : value);
  for (const change of readAll<{
    entity_id: string;
    txn_id: string;
    kind: string;
    field: string | null;
    value: string;
  }>(
    client,
    "SELECT entity_id, txn_id, kind, field, value FROM record_changes WHERE entity = ? AND kind IN ('create', 'set', 'settle', 'append')",
    [table]
  )) {
    if (txnStanding(client, ctx, change.txn_id).state !== 'live') continue;
    if (change.kind === 'create') {
      const values = JSON.parse(change.value) as Record<string, unknown>;
      for (const [field, value] of Object.entries(values)) {
        add(held, `${change.entity_id}\u0000${field}`, canonicalJson(value));
        roots.set(`${change.entity_id}\u0000${field}`, decoded(field, value));
      }
    } else if (change.kind === 'append') {
      const item = JSON.parse(change.value) as unknown;
      const shown = RECORD_COLUMNS[table].arrayAppends.includes(change.field ?? '')
        ? decodeCaptureElement(item, localIdOf(client))
        : item;
      add(appends, `${change.entity_id}\u0000${change.field}`, canonicalJson(shown));
    } else add(held, `${change.entity_id}\u0000${change.field}`, change.value);
  }
  for (const root of readAll<{ entity_id: string; field: string; value: string | null }>(
    client,
    'SELECT entity_id, field, value FROM record_roots WHERE entity = ?',
    [table]
  )) {
    const key = `${root.entity_id}\u0000${root.field}`;
    add(held, key, root.value ?? 'null');
    if (!roots.has(key)) roots.set(key, decoded(root.field, JSON.parse(root.value ?? 'null')));
  }
  const open = new Set(
    readAll<{ entity_id: string; field: string }>(
      client,
      'SELECT entity_id, field FROM record_conflicts WHERE entity = ?',
      [table]
    ).map((row) => `${row.entity_id}\u0000${row.field}`)
  );
  // The values an import's own sets hold among each open conflict's heads: an earlier import's raise.
  const candidates = new Map<string, Set<string>>();
  for (const head of readAll<{
    entity_id: string;
    field: string;
    value: string | null;
    base: string | null;
  }>(
    client,
    'SELECT h.entity_id, h.field, c.value, c.base FROM record_heads h JOIN record_changes c ON c.change_id = h.change_id WHERE h.entity = ?',
    [table]
  )) {
    const key = `${head.entity_id}\u0000${head.field}`;
    const imported = ((JSON.parse(head.base ?? '[]') as string[] | null) ?? []).includes(
      IMPORT_BASE
    );
    if (open.has(key) && imported && head.value !== null) add(candidates, key, head.value);
  }
  return { held, appends, roots, open, candidates };
}

/** A review takes the later value (ADR s96 §5), so the copy's comes in only when it is later. */
const LATER_FIELDS: ReadonlySet<string> = new Set(['last_reviewed_at']);
/** Flags merge with an added flag winning (ADR s96 §5), as record-merge.ts reads them. */
const FLAG_FIELDS: ReadonlySet<string> = new Set(['evergreen']);
/** A row's author: one the copy never recorded is no other author, so the record's stands. */
const AUTHOR_FIELDS: ReadonlySet<string> = new Set(['author_name', 'author_user_id']);

export interface FieldInput {
  readonly table: SharedTable;
  readonly field: string;
  /** The copy's value, in the record's ids. */
  readonly copy: unknown;
  readonly owner: unknown;
  /** The base's value; undefined when the base holds no such row or column. */
  readonly base: unknown;
  /** The record's value from before any change since sharing. */
  readonly root: unknown;
  /** The record has held the copy's value since sharing: an earlier import's, or one it changed. */
  readonly heldBefore: boolean;
  /** Each addition the log holds for the field, as canonical JSON. */
  readonly appendsLogged: ReadonlySet<string>;
}

export type FieldVerdict =
  | { readonly kind: 'same' }
  /** Only the record changed it: its value stands. */
  | { readonly kind: 'owner' }
  /** The record has held the copy's value since sharing and changed it since: its value stands. */
  | { readonly kind: 'held' }
  /** A flag set in the record and clear in the copy, which an added flag outweighs (ADR s96 §5). */
  | { readonly kind: 'kept' }
  /** Only the copy changed it: a plain write of `write`. */
  | { readonly kind: 'copy'; readonly write: unknown }
  /** Both changed it, or nothing can tell: raised with the copy's value. */
  | { readonly kind: 'raise'; readonly write: unknown };

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** An appended field's value as text, or as a list of items; null when it is neither. */
type Run = string | unknown[];
function runOf(value: unknown, array: boolean): Run | null {
  if (!array) return value === null || value === undefined ? '' : String(value);
  if (value === null || value === undefined || value === '') return [];
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
const extendsRun = (whole: Run, start: Run): boolean =>
  typeof whole === 'string'
    ? whole.startsWith(start as string)
    : start.length <= whole.length &&
      (start as unknown[]).every((item, index) => same(item, whole[index]));
const holdsRun = (whole: Run, part: Run): boolean =>
  part.length > 0 &&
  (typeof whole === 'string'
    ? whole.includes(part as string)
    : whole.some((_, at) => (part as unknown[]).every((item, i) => same(item, whole[at + i]))));

/**
 * An appended field (ADR s96 §5 merges it as additions): the copy's value that extends the
 * record's is written as an addition, and what both added after a common start is kept from both,
 * the record's first. An addition the record holds, or once appended, is not written again. Null
 * leaves the field to the plain rules.
 */
function appended(input: FieldInput, array: boolean): FieldVerdict | null {
  const [copy, owner] = [runOf(input.copy, array), runOf(input.owner, array)];
  if (copy === null || owner === null) return null;
  if (input.base !== undefined && (same(input.copy, input.base) || same(input.owner, input.base)))
    return null;
  if (owner.length && extendsRun(copy, owner)) return { kind: 'copy', write: input.copy };
  if (copy.length && extendsRun(owner, copy)) return { kind: 'owner' };
  // A common start both added to; with none, both wrote the field from empty, which is raised.
  const start = runOf(input.base !== undefined ? input.base : input.root, array);
  if (!start?.length || !extendsRun(copy, start) || !extendsRun(owner, start)) return null;
  const added = copy.slice(start.length);
  const logged =
    typeof added === 'string'
      ? input.appendsLogged.has(canonicalJson(added))
      : added.every((item) => input.appendsLogged.has(canonicalJson(item)));
  if (logged || holdsRun(owner.slice(start.length), added)) return { kind: 'owner' };
  return {
    kind: 'copy',
    write:
      typeof added === 'string'
        ? (owner as string) + added
        : JSON.stringify([...(owner as unknown[]), ...added]),
  };
}

/** A field the copy holds differently from the record, classified. */
export function classifyField(input: FieldInput): FieldVerdict {
  if (same(input.copy, input.owner)) return { kind: 'same' };
  if (AUTHOR_FIELDS.has(input.field) && (input.copy === null || input.copy === undefined))
    return { kind: 'owner' };
  if (LATER_FIELDS.has(input.field)) {
    const [copy, owner] = [storedTimeMs(input.copy as string), storedTimeMs(input.owner as string)];
    return Number.isNaN(copy) || (!Number.isNaN(owner) && copy <= owner)
      ? { kind: 'owner' }
      : { kind: 'copy', write: input.copy };
  }
  // The base showing only the record changed it says so first; then the record's own history.
  if (input.base !== undefined && same(input.copy, input.base)) return { kind: 'owner' };
  if (input.heldBefore) return { kind: 'held' };
  if (FLAG_FIELDS.has(input.field)) {
    if (input.base !== undefined && same(input.owner, input.base))
      return { kind: 'copy', write: input.copy };
    // Between changes that did not see each other an added flag wins (ADR s96 §5), so a flag is
    // never raised: the copy's comes in when it adds one, and one it cleared is kept as the record's.
    return input.copy ? { kind: 'copy', write: input.copy } : { kind: 'kept' };
  }
  const classes = RECORD_COLUMNS[input.table];
  const kind = classes.appends.includes(input.field)
    ? 'text'
    : classes.arrayAppends.includes(input.field)
      ? 'array'
      : null;
  const added = kind ? appended(input, kind === 'array') : null;
  if (added) return added;
  if (input.base === undefined) return { kind: 'raise', write: input.copy };
  if (same(input.copy, input.base)) return { kind: 'owner' };
  if (same(input.owner, input.base)) return { kind: 'copy', write: input.copy };
  return { kind: 'raise', write: input.copy };
}
