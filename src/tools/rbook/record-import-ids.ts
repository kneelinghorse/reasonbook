// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The ids an import gives the copy's rows (ADR s96 §9): a stable id each importing copy derives from the copy's
// ABOUTME: row, so any later plan finds what an import brought in, and the copy's values in the record's ids.

import { createHash } from 'crypto';
import { citationSpans } from './decision-citations';
import { RECORD_COLUMNS, type SharedTable } from './record-columns';
import type { StandingState } from './record-standing';

type Row = Record<string, unknown>;

export const NUMBERED: ReadonlySet<string> = new Set([
  'strategic_decisions',
  'learnings',
  'next_steps',
  'constraints',
]);

/** The text an integer id is matched with: the same number with other text is another row. */
export const TEXT: Readonly<Partial<Record<SharedTable, string>>> = {
  strategic_decisions: 'decision_text',
  learnings: 'content',
  next_steps: 'content',
  constraints: 'content',
};

/** The text fields whose citations the link extractor reads, and so the import rewrites. */
const TEXT_FIELDS: Readonly<Partial<Record<SharedTable, readonly string[]>>> = {
  strategic_decisions: [
    'decision_text',
    'context_text',
    'alternatives',
    'consequences',
    'deciders',
  ],
  learnings: ['content'],
};
/** The numbered table each citation prefix names. */
const CITED: Readonly<Record<string, SharedTable>> = {
  d: 'strategic_decisions',
  l: 'learnings',
  c: 'constraints',
  n: 'next_steps',
};

const hash = (text: unknown) =>
  createHash('sha256')
    .update(String(text ?? ''))
    .digest('hex');

/** A row's natural key (universe 1): a number with its text's hash, a text id, or a link's pair. */
export function keyOf(table: SharedTable, row: Row): string {
  const classes = RECORD_COLUMNS[table];
  if (classes.link) return classes.key.map((column) => String(row[column])).join('|');
  const text = TEXT[table];
  return text ? `${row.id}:${hash(row[text])}` : String(row.id);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The stable id an import on `replica` gives a copy's row, on its `attempt`-th import there: shaped
 * as a ULID, its time the row's own and its rest a hash of the project, the table, the row's
 * identity (its own stable id, or its natural key) and the replica. A later plan on any copy of
 * the record derives it again, so it finds the row instead of bringing it in twice.
 */
export function importedStable(
  projectId: string,
  table: SharedTable,
  identity: string,
  replica: string,
  attempt: number,
  timeMs: number
): string {
  const digest = createHash('sha256')
    .update(['rbook-import', projectId, table, identity, replica, String(attempt)].join('\u0000'))
    .digest();
  let time = Number.isFinite(timeMs) && timeMs > 0 ? Math.floor(timeMs) : 0;
  let head = '';
  for (let index = 0; index < 10; index += 1) {
    head = CROCKFORD[time % 32] + head;
    time = Math.floor(time / 32);
  }
  // Sixteen characters from the digest's first 80 bits.
  const bit = (k: number) => (digest[k >> 3] >> (7 - (k & 7))) & 1;
  let tail = '';
  for (let char = 0; char < 16; char += 1) {
    let value = 0;
    for (let b = 0; b < 5; b += 1) value = (value << 1) | bit(char * 5 + b);
    tail += CROCKFORD[value];
  }
  return head + tail;
}

/** What the walk over one copy's imports of a row found. */
export type Walk =
  | { readonly found: Row }
  /** An earlier import's create the record holds but has not taken: it may yet be. */
  | { readonly waiting: true }
  /** None, so a new import on this copy takes this attempt, the first the log never named. */
  | { readonly next: number };

/**
 * The row an earlier import on one copy brought in for an identity: the first attempt whose id the
 * table holds. An attempt whose create was refused is passed; one that waits for a verdict, is held
 * or quarantined may yet be taken, so the row waits on it instead of being brought in again.
 */
export function walkImports(
  derive: (attempt: number) => string,
  byStable: ReadonlyMap<string, Row>,
  states: ReadonlyMap<string, StandingState>
): Walk {
  for (let attempt = 0; ; attempt += 1) {
    const found = byStable.get(derive(attempt));
    if (found) return { found };
    const state = states.get(derive(attempt));
    if (state === undefined) return { next: attempt };
    if (state !== 'refused') return { waiting: true };
  }
}

/**
 * Each entity id among a table's logged changes: its create's standing, or held when changes to it
 * arrived before its create, which may yet arrive.
 */
export function entityStates(
  changes: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly txn: string }>,
  standing: (txn: string) => StandingState
): Map<string, StandingState> {
  const states = new Map<string, StandingState>();
  for (const change of changes)
    if (change.kind === 'create') states.set(change.id, standing(change.txn));
  for (const change of changes) if (!states.has(change.id)) states.set(change.id, 'held');
  return states;
}

/**
 * Each copy row's id in this record, by table: a matched row's id, a row brought in's new id, and
 * null for a row the import leaves out.
 */
export type IdMaps = ReadonlyMap<SharedTable, ReadonlyMap<string, string | null>>;

/** The rows a text cites one at a time, as `rewriteCitations` reads them: a table and the copy's id. */
function citedRows(text: string): Array<{ readonly table: SharedTable; readonly id: string }> {
  return citationSpans(text).flatMap((span) => {
    const table = span.prefix ? CITED[span.prefix] : undefined;
    return table && span.ids.length === 1 ? [{ table, id: String(span.ids[0]) }] : [];
  });
}

/** A numbered row's text in this record's ids, as an import that brought it in wrote it. */
export function textInRecord(table: SharedTable, row: Readonly<Row>, ids: IdMaps): string | null {
  const field = TEXT[table];
  const text = field ? row[field] : null;
  if (typeof text !== 'string' || !text) return null;
  return TEXT_FIELDS[table]?.includes(field!) ? rewriteCitations(text, ids) : text;
}

/**
 * The first row a copy row names, by a reference or a single-id citation, that waits on an earlier
 * import, as `<table>:<id>`: a row brought in that names one waits with it.
 */
export function namesWaiting(
  table: SharedTable,
  values: Readonly<Row>,
  waits: (table: SharedTable, id: string) => boolean
): string | null {
  for (const reference of RECORD_COLUMNS[table].references) {
    const value = values[reference.column];
    if (value !== null && value !== undefined && waits(reference.table, String(value)))
      return `${reference.table}:${String(value)}`;
  }
  for (const field of TEXT_FIELDS[table] ?? []) {
    const text = values[field];
    const cited =
      typeof text === 'string'
        ? citedRows(text).find((row) => waits(row.table, row.id))
        : undefined;
    if (cited) return `${cited.table}:${cited.id}`;
  }
  return null;
}

/** Each single-id citation's number replaced with what `to` gives for its row, if anything. */
function mapCitations(
  text: string,
  to: (table: SharedTable, id: string) => string | null | undefined
): string {
  let out = text;
  for (const span of [...citationSpans(text)].sort((a, b) => b.start - a.start)) {
    const table = span.prefix ? CITED[span.prefix] : undefined;
    if (!table || span.ids.length !== 1) continue;
    const from = String(span.ids[0]);
    const replacement = to(table, from);
    if (!replacement || replacement === from) continue;
    const piece = out.slice(span.start, span.end);
    const at = piece.lastIndexOf(from);
    if (at < 0) continue;
    out =
      out.slice(0, span.start) +
      piece.slice(0, at) +
      replacement +
      piece.slice(at + from.length) +
      out.slice(span.end);
  }
  return out;
}

/** A single-id citation of a row whose id moved takes its new id; a range keeps its numbers. */
export function rewriteCitations(text: string, ids: IdMaps): string {
  return mapCitations(text, (table, id) => ids.get(table)?.get(id));
}

/**
 * A numbered row's text with each single-id citation's number masked, so two texts that differ only
 * there read alike; null for a table whose citations an import never rewrites, where they cannot.
 */
export function maskedText(table: SharedTable, row: Readonly<Row>): string | null {
  const field = TEXT[table];
  const text = field ? row[field] : null;
  if (typeof text !== 'string' || !text || !TEXT_FIELDS[table]?.includes(field!)) return null;
  return mapCitations(text, () => '#');
}

export interface Unheld {
  readonly column: string;
  /** `<table>:<id>` of the row it names. */
  readonly names: string;
  /** The row it names waits on an earlier import that is not live yet. */
  readonly waits?: boolean;
}

/**
 * A copy row's values in this record's ids: each reference takes the id of the row it names here,
 * and each citation the number. A reference to a row the record will not hold is emptied and
 * listed, as the schema's own delete rules would leave it; one to a row that waits, and a text
 * citing one, is listed as waiting.
 */
export function translated(
  table: SharedTable,
  values: Readonly<Row>,
  ids: IdMaps,
  holds: (table: SharedTable, id: string) => boolean,
  waits: (table: SharedTable, id: string) => boolean = () => false
): {
  readonly values: Row;
  readonly unheld: readonly Unheld[];
  /** Single-id citations of a row the import leaves out, which keep the number the copy wrote. */
  readonly cites: readonly Unheld[];
} {
  const out: Row = { ...values };
  const unheld: Unheld[] = [];
  const cites: Unheld[] = [];
  for (const reference of RECORD_COLUMNS[table].references) {
    const value = out[reference.column];
    if (value === null || value === undefined) continue;
    const named = String(value);
    // A row an earlier import brought in that is not live yet has no id here to name.
    if (waits(reference.table, named)) {
      out[reference.column] = null;
      unheld.push({ column: reference.column, names: `${reference.table}:${named}`, waits: true });
      continue;
    }
    const map = ids.get(reference.table);
    const to = map?.get(named);
    // A row the copy does not hold, which the record does: the copy deleted it, and it stays.
    if (to === undefined && !map?.has(named) && holds(reference.table, named)) continue;
    if (to === undefined || to === null) {
      out[reference.column] = null;
      unheld.push({ column: reference.column, names: `${reference.table}:${named}` });
      continue;
    }
    out[reference.column] = NUMBERED.has(reference.table) ? Number(to) : to;
  }
  for (const field of TEXT_FIELDS[table] ?? []) {
    const text = out[field];
    if (typeof text !== 'string') continue;
    // A row that waits has no number here yet, so a text citing one waits with it.
    const cited = citedRows(text).find((row) => waits(row.table, row.id));
    if (cited) unheld.push({ column: field, names: `${cited.table}:${cited.id}`, waits: true });
    else out[field] = rewriteCitations(text, ids);
    for (const row of citedRows(text))
      if (ids.get(row.table)?.get(row.id) === null)
        cites.push({ column: field, names: `${row.table}:${row.id}` });
  }
  return { values: out, unheld, cites };
}
