// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Which fields of a recalled row hold values from copies that had not seen each other (s96-m12, ADR s96 §5),
// ABOUTME: light enough for the prompt hook, so recall marks a provisional value rather than show it as settled.

import type Database from 'better-sqlite3';
import type { RbookDatabaseClient } from './client';

/** Reads rows, through a client or a raw connection, so the CLI's read-only paths can ask too. */
export type RowQuery = <T>(sql: string, params?: readonly unknown[]) => T[];

export function clientQuery(client: RbookDatabaseClient): RowQuery {
  return <T>(sql: string, params: readonly unknown[] = []): T[] => {
    const read = client.getMany<T>(sql, [...params]);
    if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
    return read.data ?? [];
  };
}

/** A raw connection's reads, for the CLI paths that open the store themselves. */
export function rawQuery(db: Database.Database): RowQuery {
  return <T>(sql: string, params: readonly unknown[] = []): T[] =>
    db.prepare(sql).all(...params) as T[];
}

/** The fields in conflict on each of these rows, by row id; none off a shared record. */
export function conflictedFields(
  query: RowQuery,
  table: 'strategic_decisions' | 'learnings',
  ids: readonly number[]
): Map<number, string[]> {
  const found = new Map<number, string[]>();
  if (
    !ids.length ||
    !query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'record_conflicts'").length
  )
    return found;
  for (const row of query<{ id: number; field: string }>(
    `SELECT t.id, k.field FROM record_conflicts k JOIN ${table} t ON t.stable_event_id = k.entity_id
      WHERE k.entity = ? AND t.id IN (${ids.map(() => '?').join(', ')}) ORDER BY t.id, k.field`,
    [table, ...ids]
  ))
    found.set(row.id, [...(found.get(row.id) ?? []), row.field]);
  return found;
}

/** A recalled row's mark when a field it shows is provisional; bare, naming no field, when room is short. */
export function conflictMark(fields: readonly string[] | undefined, bare = false): string {
  // Bounded, so a mark never takes a recalled preview's room (the surfaces critic).
  if (!fields?.length) return '';
  if (bare) return '[in conflict] ';
  return `[in conflict: ${fields[0]}${fields.length > 1 ? ` +${fields.length - 1}` : ''}] `;
}

export const CONFLICT_POINTER = 'A value in conflict is provisional: rbook_db(action="conflicts").';

/** Recalled decisions and learnings, each with the fields in conflict on it when it has any. */
export function markConflicts<
  T extends { readonly kind: 'decision' | 'learning'; readonly id: number },
>(query: RowQuery, items: readonly T[]): Array<T & { readonly conflicts?: readonly string[] }> {
  const ids = (kind: T['kind']) =>
    items.filter((item) => item.kind === kind).map((item) => item.id);
  const marks = {
    decision: conflictedFields(query, 'strategic_decisions', ids('decision')),
    learning: conflictedFields(query, 'learnings', ids('learning')),
  };
  return items.map((item) => {
    const conflicts = marks[item.kind].get(item.id);
    return conflicts ? { ...item, conflicts } : item;
  });
}
