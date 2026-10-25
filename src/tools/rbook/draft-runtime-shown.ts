// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps shown draft identifiers until draft expiry, without retaining operator words.
// ABOUTME: All read, carry and prune paths use the same local starts and seven-day lifetime.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { DraftRuntime } from './draft-runtime';
import { EXCERPT_TTL_MS } from './draft-runtime-excerpts';
import { runtimeDir } from './harness-session';
import { safeDestination } from './local-telemetry';
import { DRAFT_EXPIRY_DAYS, DRAFT_EXPIRY_STARTS } from './proposals';

function has(db: Database.Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

/** Strictly older than seven days or three starts strictly after the row's showing. */
function expired(db: Database.Database, table: 'shown' | 'kept'): string {
  return `at < ?${has(db, 'starts') ? ` OR (SELECT COUNT(*) FROM starts WHERE starts.at > ${table}.at) >= ${DRAFT_EXPIRY_STARTS}` : ''}`;
}

function cutoff(now: number): number {
  return now - DRAFT_EXPIRY_DAYS * 86_400_000;
}

/** The drafts the session's latest reply put to the operator (Stop), replacing the previous set. */
export function setShown(
  runtime: DraftRuntime,
  session: string,
  ids: readonly number[],
  now: number
): void {
  runtime.db
    .prepare(
      `INSERT INTO shown (session, draft_ids, at) VALUES (?, ?, ?)
       ON CONFLICT(session) DO UPDATE SET draft_ids = excluded.draft_ids, at = excluded.at`
    )
    .run(session, JSON.stringify(ids), now);
}

/** Restore an unanswered decline only if no newer Stop supplied another shown set. */
export function restoreShown(runtime: DraftRuntime, session: string, shown: ShownDrafts): void {
  runtime.db
    .prepare(
      `INSERT INTO shown (session, draft_ids, at) VALUES (?, ?, ?)
    ON CONFLICT(session) DO NOTHING`
    )
    .run(session, JSON.stringify(shown.ids), shown.at);
}

/** Take (read and clear) what the latest reply showed: one message answers one reply. */
export function takeShown(runtime: DraftRuntime, session: string, now: number): number[] {
  const ids = peekShown(runtime, session, now);
  if (has(runtime.db, 'shown'))
    runtime.db.prepare('DELETE FROM shown WHERE session = ?').run(session);
  return ids;
}

/**
 * s97-m12 (learning #481; critic round 2): a reply's drafts that no operator message took, as when
 * the harness's own prompt opened the next turn, are kept, each with the time it was first shown,
 * when the next reply's Stop replaces the shown set. They expire with that time, never refreshed.
 */
export function carryShown(runtime: DraftRuntime, session: string, now: number): void {
  if (!has(runtime.db, 'shown') || !has(runtime.db, 'kept')) return;
  const row = runtime.db.prepare('SELECT at FROM shown WHERE session = ?').get(session) as
    | { at: number }
    | undefined;
  const keep = runtime.db.prepare(
    'INSERT INTO kept (session, draft_id, at) VALUES (?, ?, ?) ON CONFLICT(session, draft_id) DO NOTHING'
  );
  runtime.db.transaction(() => {
    runtime.db.prepare(`DELETE FROM kept WHERE ${expired(runtime.db, 'kept')}`).run(cutoff(now));
    if (row) for (const id of peekShown(runtime, session, now)) keep.run(session, id, row.at);
  })();
}

export interface KeptDraft {
  readonly id: number;
  readonly at: number;
}

/** Consume each retained showing once, preserving its original time for late-answer audit. */
export function takeKeptWithTimes(
  runtime: DraftRuntime,
  session: string,
  now: number
): KeptDraft[] {
  if (!has(runtime.db, 'kept')) return [];
  return runtime.db.transaction(() => {
    const rows = runtime.db
      .prepare(
        `SELECT draft_id AS id, at FROM kept WHERE session = ? AND NOT (${expired(runtime.db, 'kept')})`
      )
      .all(session, cutoff(now)) as KeptDraft[];
    runtime.db.prepare('DELETE FROM kept WHERE session = ?').run(session);
    return rows;
  })();
}

/** Consume the kept draft identifiers; words remain under their separate two-hour limit. */
export function takeKept(runtime: DraftRuntime, session: string, now: number): number[] {
  return takeKeptWithTimes(runtime, session, now).map((row) => row.id);
}

export interface ShownDrafts {
  readonly ids: number[];
  readonly at: number;
}

/** Original showing time distinguishes a late answer without extending the identifier lifetime. */
export function readShown(runtime: DraftRuntime, session: string, now: number): ShownDrafts | null {
  if (!has(runtime.db, 'shown')) return null;
  const row = runtime.db
    .prepare(
      `SELECT draft_ids, at FROM shown WHERE session = ? AND NOT (${expired(runtime.db, 'shown')})`
    )
    .get(session, cutoff(now)) as { draft_ids: string; at: number } | undefined;
  if (!row) return null;
  try {
    const ids: unknown = JSON.parse(row.draft_ids);
    return Array.isArray(ids)
      ? { ids: ids.filter((id): id is number => Number.isInteger(id)), at: row.at }
      : null;
  } catch {
    return null;
  }
}

/** Read the latest shown identifiers without consuming them. */
export function peekShown(runtime: DraftRuntime, session: string, now: number): number[] {
  return readShown(runtime, session, now)?.ids ?? [];
}

/** How many store files a session start prunes, at most. */
export const PRUNE_FILES_MAX = 50;

/**
 * Prune words and windows after two hours, and shown identifiers only at draft expiry,
 * in every store's own runtime using its own starts table. Best effort: a file that cannot be opened is skipped. Returns the files pruned.
 */
export function pruneAllRuntimes(env: NodeJS.ProcessEnv, now: number): number {
  const dir = path.join(runtimeDir(env), 'drafts');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{32}\.sqlite$/.test(name));
  } catch {
    return 0;
  }
  let pruned = 0;
  for (const name of names.slice(0, PRUNE_FILES_MAX)) {
    const file = path.join(dir, name);
    let db: Database.Database | undefined;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || !safeDestination(file)) continue;
      db = new Database(file, { fileMustExist: true, timeout: 50 });
      for (const table of ['excerpts', 'windows', 'shown', 'kept'] as const) {
        const present = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table);
        if (!present) continue;
        if (table === 'shown' || table === 'kept')
          db.prepare(`DELETE FROM ${table} WHERE ${expired(db, table)}`).run(cutoff(now));
        else db.prepare(`DELETE FROM ${table} WHERE at <= ?`).run(now - EXCERPT_TTL_MS);
      }
      pruned++;
    } catch {
      // A held or damaged file is left for the next start.
    } finally {
      db?.close();
    }
  }
  return pruned;
}
