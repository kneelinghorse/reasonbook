// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The replay check (ADR s96 §4): the live log's changes the replay base lacks, applied in order to a scratch
// ABOUTME: copy of the base, must reproduce every recorded column of every shared row and every recorded identity key.

import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { canonicalJson } from './record-capture';
import { decodeCaptureElement, decodeCaptures, encodeCaptures } from './record-capture-refs';
import {
  IDENTITY_KEYS,
  PROJECT_ENTITY,
  RECORD_COLUMNS,
  RECORDED_TABLES,
  type SharedTable,
} from './record-columns';

interface LoggedChange {
  readonly change_id: string;
  readonly kind: string;
  readonly entity: string;
  readonly entity_id: string | null;
  readonly field: string | null;
  readonly value: string | null;
}

export interface ReplayReport {
  /** How many changes the base lacked and the replay applied. */
  readonly applied: number;
  /** Each recorded column or identity key the replay did not reproduce. */
  readonly mismatches: readonly string[];
}

type Db = Database.Database;

const idOf =
  (db: Db) =>
  (table: 'missions' | 'sprints', stable: string): string | null => {
    const row = db.prepare(`SELECT id FROM ${table} WHERE stable_event_id = ?`).get(stable) as
      | { id: unknown }
      | undefined;
    return row ? String(row.id) : null;
  };
const stableOfIn =
  (db: Db) =>
  (table: 'missions' | 'sprints', id: string): string | null => {
    const row = db
      .prepare(`SELECT stable_event_id AS stable FROM ${table} WHERE id = ?`)
      .get(id) as { stable: string | null } | undefined;
    return row?.stable ?? null;
  };

/** A change's reference back to this store's id: the row that holds the stable id. */
function decode(db: Db, table: SharedTable, column: string, value: unknown): unknown {
  if (table === 'sessions' && column === 'captures') return decodeCaptures(value, idOf(db));
  const reference = RECORD_COLUMNS[table].references.find((ref) => ref.column === column);
  if (!reference || value === null || typeof value !== 'object') return value ?? null;
  if ('unresolved' in (value as object)) {
    const raw = (value as { unresolved: unknown }).unresolved;
    // The change was written when no row had this id, so a row that has it now makes it wrong.
    if (db.prepare(`SELECT 1 FROM ${reference.table} WHERE id = ?`).get(raw))
      throw new Error(`${table}.${column} is logged unresolved, but names a row the replay holds`);
    return raw;
  }
  const row = db
    .prepare(`SELECT id FROM ${reference.table} WHERE stable_event_id = ?`)
    .get((value as { ref: string }).ref) as { id: unknown } | undefined;
  if (!row) throw new Error(`${table}.${column} names a row the replay has not created`);
  return row.id;
}

/** A row's value for comparison: a reference as the stable id it names. */
function encode(db: Db, table: SharedTable, column: string, raw: unknown): unknown {
  if (table === 'sessions' && column === 'captures') return encodeCaptures(raw, stableOfIn(db));
  const reference = RECORD_COLUMNS[table].references.find((ref) => ref.column === column);
  if (!reference || raw === null || raw === undefined) return raw ?? null;
  const row = db
    .prepare(`SELECT stable_event_id AS stable FROM ${reference.table} WHERE id = ?`)
    .get(raw) as { stable: string | null } | undefined;
  return row?.stable ? { ref: row.stable } : { unresolved: raw };
}

/** An array column's append, as the app makes it: the element pushed and the array written again. */
function appended(current: unknown, element: unknown): string {
  const items: unknown[] = typeof current === 'string' && current ? JSON.parse(current) : [];
  return JSON.stringify([...items, element]);
}

function applyChange(db: Db, change: LoggedChange): void {
  const value: unknown = change.value === null ? null : JSON.parse(change.value);
  if (change.entity === PROJECT_ENTITY) {
    if (change.kind !== 'set' || !change.field) return;
    const [scope, key] = change.field.split(/\.(.*)/s);
    if (scope === 'identity')
      db.prepare(
        "UPDATE contexts SET content = json_set(content, ?, json(?)) WHERE id = 'project_identity'"
      ).run(`$.${key}`, canonicalJson(value));
    else if (value === null) db.prepare('DELETE FROM metadata WHERE key = ?').run(key);
    else db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
    return;
  }
  const table = change.entity as SharedTable;
  const classes = RECORD_COLUMNS[table];
  if (!classes) throw new Error(`${change.entity} is not a shared table`);
  if (change.kind === 'create' || change.kind === 'link') {
    const values = value as Record<string, unknown>;
    const columns = classes.recorded.filter((column) => column !== 'stable_event_id');
    const names = columns.map((column) => `"${column}"`);
    const holders = columns.map(() => '?');
    const params = columns.map((column) => decode(db, table, column, values[column] ?? null));
    if (!classes.link) {
      // A logged row takes its stable id from the change and this copy's next per-store sequence.
      names.push('stable_event_id', 'origin_seq');
      holders.push('?', `(SELECT COALESCE(MAX(origin_seq), 0) + 1 FROM ${table})`);
      params.push(change.entity_id);
    }
    db.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${holders.join(', ')})`).run(
      ...params
    );
  } else if (change.kind === 'unlink') {
    const values = value as Record<string, unknown>;
    db.prepare(
      `DELETE FROM ${table} WHERE ${classes.key.map((column) => `"${column}" = ?`).join(' AND ')}`
    ).run(...classes.key.map((column) => decode(db, table, column, values[column] ?? null)));
  } else if (change.kind === 'set' && change.field) {
    db.prepare(`UPDATE ${table} SET "${change.field}" = ? WHERE stable_event_id = ?`).run(
      decode(db, table, change.field, value),
      change.entity_id
    );
  } else if (change.kind === 'append' && change.field) {
    const field = `"${change.field}"`;
    if (classes.arrayAppends.includes(change.field)) {
      const row = db
        .prepare(`SELECT ${field} AS current FROM ${table} WHERE stable_event_id = ?`)
        .get(change.entity_id) as { current: unknown } | undefined;
      db.prepare(`UPDATE ${table} SET ${field} = ? WHERE stable_event_id = ?`).run(
        appended(row?.current, decodeCaptureElement(value, idOf(db))),
        change.entity_id
      );
    } else
      db.prepare(
        `UPDATE ${table} SET ${field} = COALESCE(${field}, '') || ? WHERE stable_event_id = ?`
      ).run(value, change.entity_id);
  } else throw new Error(`a ${change.kind} change is not one the replay applies`);
}

/** Two stored values are the same only when equal: a reference as the stable id it names. */
function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

function rowsOf(db: Db, table: SharedTable): Map<string, Record<string, unknown>> {
  const classes = RECORD_COLUMNS[table];
  const rows = db
    .prepare(`SELECT ${classes.recorded.map((column) => `"${column}"`).join(', ')} FROM ${table}`)
    .all() as Array<Record<string, unknown>>;
  const keyed = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const encoded = Object.fromEntries(
      classes.recorded.map((column) => [column, encode(db, table, column, row[column])])
    );
    const key = classes.link
      ? classes.key.map((column) => canonicalJson(encoded[column])).join('|')
      : String(row.stable_event_id);
    keyed.set(key, encoded);
  }
  return keyed;
}

function compare(live: Db, replayed: Db): string[] {
  const mismatches: string[] = [];
  for (const table of RECORDED_TABLES) {
    const was = rowsOf(live, table);
    const is = rowsOf(replayed, table);
    for (const [key, row] of was) {
      const other = is.get(key);
      if (!other) {
        mismatches.push(`${table} ${key}: in the store, not reproduced by the replay`);
        continue;
      }
      for (const column of RECORD_COLUMNS[table].recorded)
        if (!same(row[column], other[column]))
          mismatches.push(
            `${table} ${key} ${column}: the store holds ${canonicalJson(row[column])}, the replay ${canonicalJson(other[column])}`
          );
    }
    for (const key of is.keys())
      if (!was.has(key)) mismatches.push(`${table} ${key}: made by the replay, not in the store`);
  }
  const document = (db: Db): Record<string, unknown> =>
    JSON.parse(
      (
        db.prepare("SELECT content FROM contexts WHERE id = 'project_identity'").get() as
          | { content: string }
          | undefined
      )?.content ?? '{}'
    ) as Record<string, unknown>;
  const [liveDoc, replayedDoc] = [document(live), document(replayed)];
  // ADR §4 compares the identity's keys as canonical JSON, so a reordered key is never a change.
  for (const key of IDENTITY_KEYS.document)
    if (!same(liveDoc[key], replayedDoc[key]))
      mismatches.push(`project identity ${key}: not reproduced by the replay`);
  const meta = (db: Db, key: string): unknown =>
    (
      db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value ?? null;
  for (const key of IDENTITY_KEYS.metadata)
    if (!same(meta(live, key), meta(replayed, key)))
      mismatches.push(`metadata ${key}: not reproduced by the replay`);
  return mismatches;
}

/**
 * Replay the store's log onto its replay base, on a scratch copy without the triggers, and
 * report what the replay did not reproduce: a change it could not apply is a mismatch too. The
 * store itself is only read, in one read transaction.
 */
export function replayCheck(storePath: string, replayBase: string): ReplayReport {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'rbook-replay-'));
  const scratchPath = path.join(folder, 'replay.sqlite');
  copyFileSync(replayBase, scratchPath);
  const replayed = new Database(scratchPath);
  const live = new Database(storePath, { readonly: true });
  try {
    const triggers = replayed
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND (name LIKE 'record\\_guard\\_%' ESCAPE '\\' OR name LIKE 'record\\_capture\\_%' ESCAPE '\\')"
      )
      .all() as Array<{ name: string }>;
    for (const { name } of triggers) replayed.exec(`DROP TRIGGER "${name}"`);
    replayed.pragma('foreign_keys = OFF');
    const known = new Set(
      (replayed.prepare('SELECT change_id FROM record_changes').all() as LoggedChange[]).map(
        (change) => change.change_id
      )
    );
    return live.transaction(() => {
      const changes = (
        live
          .prepare('SELECT * FROM record_changes ORDER BY replica_id, replica_seq')
          .all() as LoggedChange[]
      ).filter((change) => !known.has(change.change_id));
      const failures: string[] = [];
      replayed.transaction(() => {
        for (const change of changes)
          try {
            applyChange(replayed, change);
          } catch (error) {
            failures.push(
              `change ${change.change_id} (${change.kind} ${change.entity} ${change.entity_id ?? ''} ${change.field ?? ''}): ${error instanceof Error ? error.message : String(error)}`
            );
          }
      })();
      return { applied: changes.length, mismatches: [...failures, ...compare(live, replayed)] };
    })();
  } finally {
    live.close();
    replayed.close();
    rmSync(folder, { recursive: true, force: true });
  }
}
