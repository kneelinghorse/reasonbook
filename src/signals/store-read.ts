// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read helpers for the signals over one store's read-only handle: which columns a table has, stored times,
// ABOUTME: Completed sprints' closes, and the citation reader's interface, all without writing or migrating anything.

import type Database from 'better-sqlite3';

import type { RecordLinkReader } from '../tools/rbook/record-link-store';
import type { RbookToolResult } from '../tools/rbook/types';
import { storedTimeMs } from '../tools/rbook/stored-time';

export const DAY_MS = 86_400_000;

/** A table's columns, or an empty set when the table is absent: absence is checked, never assumed. */
export function columnsOf(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** A stored time as an instant, or NaN where SQLite's julianday() would read NULL. */
export function timeOf(value: unknown): number {
  return storedTimeMs(typeof value === 'string' ? value : null);
}

/** Is a status, matched as the server matches it without regard to case, one of these? */
export function statusIs(value: unknown, status: string): boolean {
  return typeof value === 'string' && value.toUpperCase() === status.toUpperCase();
}

/**
 * The close times, oldest first, of Completed sprints whose recorded end_date is at or before
 * `nowMs`: the closes the lease and the review age count. `exactStatus` keeps the lease's own
 * predicate (status = 'Completed' as written, next-step-lease.ts CLOSES_SURVIVED_SQL); the review
 * age matches the status without regard to case (staleness-detection.ts closedSql).
 */
export function closesAtOrBefore(
  db: Database.Database,
  nowMs: number,
  exactStatus: boolean
): Array<{ id: string; endMs: number }> {
  const columns = columnsOf(db, 'sprints');
  if (!columns.has('status') || !columns.has('end_date')) return [];
  const rows = db.prepare('SELECT id, status, end_date FROM sprints').all() as Array<{
    id: string;
    status: unknown;
    end_date: unknown;
  }>;
  return rows
    .filter((row) => (exactStatus ? row.status === 'Completed' : statusIs(row.status, 'Completed')))
    .map((row) => ({ id: String(row.id), endMs: timeOf(row.end_date) }))
    .filter((row) => Number.isFinite(row.endMs) && row.endMs <= nowMs)
    .sort((a, b) => a.endMs - b.endMs || a.id.localeCompare(b.id));
}

/** How many of `closes` (oldest first) fall strictly after `anchorMs`. */
export function closesAfter(closes: ReadonlyArray<{ endMs: number }>, anchorMs: number): number {
  let count = 0;
  for (const close of closes) if (close.endMs > anchorMs) count += 1;
  return count;
}

/** The citation reader's interface over a read-only handle, so the project's own reader runs here. */
export function linkReader(db: Database.Database, storePath: string): RecordLinkReader {
  const fail = <T>(error: unknown): RbookToolResult<T> => ({
    success: false,
    error: {
      code: 'DB_QUERY_FAILED',
      message: error instanceof Error ? error.message : String(error),
    },
  });
  return {
    path: storePath,
    getOne<T>(sql: string, params?: unknown): RbookToolResult<T | undefined> {
      try {
        const statement = db.prepare(sql);
        const row = (params === undefined ? statement.get() : statement.get(params)) as
          | T
          | undefined;
        return { success: true, data: row };
      } catch (error) {
        return fail(error);
      }
    },
    getMany<T>(sql: string, params?: unknown): RbookToolResult<T[]> {
      try {
        const statement = db.prepare(sql);
        const rows = (params === undefined ? statement.all() : statement.all(params)) as T[];
        return { success: true, data: rows };
      } catch (error) {
        return fail(error);
      }
    },
  } as RecordLinkReader;
}
