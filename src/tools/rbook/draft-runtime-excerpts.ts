// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Stores short-lived operator evidence separately from the direct-record approval window.
// ABOUTME: Late evidence remains conservative across old runtime schemas and old hook writers.
import type Database from 'better-sqlite3';
import type { DraftRuntime } from './draft-runtime';

export const EXCERPT_TTL_MS = 2 * 60 * 60 * 1000;
export const EXCERPT_MAX = 1000;

function hasLate(db: Database.Database): boolean {
  return (db.prepare('PRAGMA table_info(excerpts)').all() as Array<{ name: string }>).some(
    (column) => column.name === 'late'
  );
}

/** Called inside openDraftRuntime's immediate transaction, so concurrent hooks check after locking. */
export function ensureLateColumn(db: Database.Database): void {
  if (hasLate(db)) return;
  try {
    db.exec('ALTER TABLE excerpts ADD COLUMN late INTEGER NOT NULL DEFAULT 0');
  } catch (error) {
    if (!(error instanceof Error) || !/duplicate column name/i.test(error.message) || !hasLate(db))
      throw error;
  }
}

function has(runtime: DraftRuntime, table: string): boolean {
  return Boolean(
    runtime.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

/** Store words only. A late answer never grants a direct-record window. */
export function bindExcerpt(
  runtime: DraftRuntime,
  session: string,
  ids: readonly number[],
  message: string,
  reply: string,
  now: number,
  options: { readonly late?: boolean; readonly windowSize?: number } = {}
): void {
  const keep = runtime.db
    .prepare(`INSERT INTO excerpts (session, draft_id, message, reply, window_size, at, late)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session, draft_id) DO UPDATE SET message = excluded.message,
    reply = excluded.reply, window_size = excluded.window_size, at = excluded.at, late = excluded.late`);
  runtime.db.transaction(() => {
    runtime.db.prepare('DELETE FROM excerpts WHERE at <= ?').run(now - EXCERPT_TTL_MS);
    for (const id of ids)
      keep.run(
        session,
        id,
        message.slice(0, EXCERPT_MAX),
        reply,
        options.windowSize ?? ids.length,
        now,
        options.late ? 1 : 0
      );
  })();
}

/**
 * Bind the operator's message to the drafts it answers: their words (cut to 1,000 characters),
 * its class and the window's size per draft, and the window itself, open until the turn ends.
 * Older words of every session are pruned here.
 */
export function bindWindow(
  runtime: DraftRuntime,
  session: string,
  ids: readonly number[],
  message: string,
  reply: string,
  now: number,
  /** s97-m12: drafts shown before the latest reply: the words bind them only as 'other'. */
  earlier: readonly number[] = []
): void {
  runtime.db.transaction(() => {
    bindExcerpt(runtime, session, ids, message, reply, now);
    bindExcerpt(runtime, session, earlier, message, 'other', now, {
      windowSize: ids.length + earlier.length,
    });
    runtime.db
      .prepare(
        `INSERT INTO windows (session, draft_ids, open, at) VALUES (?, ?, 1, ?)
         ON CONFLICT(session) DO UPDATE SET draft_ids = excluded.draft_ids, open = 1, at = excluded.at`
      )
      .run(session, JSON.stringify(ids), now);
  })();
}

/** The turn ended (Stop): the window no longer takes records without fromDraft as answers. */
export function closeWindow(runtime: DraftRuntime, session: string): void {
  runtime.db.prepare('UPDATE windows SET open = 0 WHERE session = ?').run(session);
}

/** The drafts the session's latest message was bound to, while its turn runs and within the TTL. */
export function openWindow(runtime: DraftRuntime, session: string, now: number): number[] {
  if (!has(runtime, 'windows')) return [];
  const row = runtime.db
    .prepare('SELECT draft_ids, open, at FROM windows WHERE session = ?')
    .get(session) as { draft_ids: string; open: number; at: number } | undefined;
  if (!row || row.open !== 1 || row.at <= now - EXCERPT_TTL_MS) return [];
  try {
    const ids = JSON.parse(row.draft_ids) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

export interface StoredExcerpt {
  readonly message: string;
  readonly reply: string;
  readonly windowSize: number;
  readonly at: number;
  readonly late: boolean;
}

/** The operator's words for a draft in a session, if younger than the TTL. */
export function readExcerpt(
  runtime: DraftRuntime,
  session: string,
  draftId: number,
  now: number
): StoredExcerpt | null {
  if (!has(runtime, 'excerpts')) return null;
  const row = runtime.db
    .prepare(
      `SELECT message, reply, window_size AS windowSize, at, ${hasLate(runtime.db) ? 'late' : '0'} AS late FROM excerpts WHERE session = ? AND draft_id = ?`
    )
    .get(session, draftId) as (Omit<StoredExcerpt, 'late'> & { late: number }) | undefined;
  return row && row.at > now - EXCERPT_TTL_MS ? { ...row, late: row.late === 1 } : null;
}
