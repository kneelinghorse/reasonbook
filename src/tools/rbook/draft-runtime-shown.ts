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
  now: number,
  currentQuestion = false,
  standingSetting = false
): void {
  if (currentQuestion || standingSetting) forgetShownAnswers(runtime, session, ids);
  runtime.db
    .prepare(
      `INSERT INTO shown (session, draft_ids, at) VALUES (?, ?, ?)
       ON CONFLICT(session) DO UPDATE SET draft_ids = excluded.draft_ids, at = excluded.at`
    )
    .run(
      session,
      JSON.stringify(
        currentQuestion ? { question: ids[0] } : standingSetting ? { standing: ids[0] } : ids
      ),
      now
    );
}

/** A re-asked or unconfirmed choice cannot borrow an earlier answer in this session. */
export function forgetShownAnswers(
  runtime: DraftRuntime,
  session: string,
  ids: readonly number[]
): void {
  if (!ids.length) return;
  const encoded = JSON.stringify(ids);
  runtime.db
    .prepare(
      `DELETE FROM excerpts WHERE session = ? AND reply <> 'decline'
    AND draft_id IN (SELECT value FROM json_each(?))`
    )
    .run(session, encoded);
  runtime.db
    .prepare(
      `UPDATE windows SET open = 0 WHERE session = ? AND open = 1
    AND EXISTS (SELECT 1 FROM json_each(windows.draft_ids)
      WHERE value IN (SELECT value FROM json_each(?)))`
    )
    .run(session, encoded);
}

/** Consume shorthand authority even on failure. A legacy standing showing can still receive a decline. */
export function clearCurrentQuestion(runtime: DraftRuntime, session: string): void {
  runtime.db
    .prepare(
      `UPDATE shown SET draft_ids = CASE WHEN json_type(draft_ids, '$.standing') = 'integer'
           THEN json_array(json_extract(draft_ids, '$.standing')) ELSE '[]' END
       WHERE session = ? AND CASE WHEN json_valid(draft_ids) THEN
         json_type(draft_ids, '$.question') = 'integer' OR json_type(draft_ids, '$.standing') = 'integer' END`
    )
    .run(session);
}

/** Restore an unanswered decline only if no newer Stop supplied another shown set. */
export function restoreShown(runtime: DraftRuntime, session: string, shown: ShownDrafts): void {
  runtime.db
    .prepare(
      `INSERT INTO shown (session, draft_ids, at) VALUES (?, ?, ?)
    ON CONFLICT(session) DO NOTHING`
    )
    .run(
      session,
      JSON.stringify(shown.currentQuestion ? { question: shown.ids[0] } : shown.ids),
      shown.at
    );
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
  const keep = runtime.db.prepare(
    'INSERT INTO kept (session, draft_id, at) VALUES (?, ?, ?) ON CONFLICT(session, draft_id) DO NOTHING'
  );
  runtime.db.transaction(() => {
    runtime.db.prepare(`DELETE FROM kept WHERE ${expired(runtime.db, 'kept')}`).run(cutoff(now));
    const showing = readShown(runtime, session, now);
    if (showing && !showing.currentQuestion)
      for (const id of showing.ids) keep.run(session, id, showing.at);
  })();
}

/** s109-m02: drafts a reply's Settled lines name leave the kept set, settled or not. */
export function dropKept(runtime: DraftRuntime, session: string, ids: readonly number[]): void {
  if (!ids.length || !has(runtime.db, 'kept')) return;
  runtime.db
    .prepare(
      `DELETE FROM kept WHERE session = ? AND draft_id IN (${ids.map(() => '?').join(', ')})`
    )
    .run(session, ...ids);
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
  /** Only the next timely reply can answer an ordinary question. Legacy arrays can be carried. */
  readonly currentQuestion?: true;
  /** This Stop received one complete standing proposal in the current assistant message. */
  readonly standingSetting?: true;
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
    if (Array.isArray(ids))
      return { ids: ids.filter((id): id is number => Number.isInteger(id)), at: row.at };
    // Older clients already leave unknown shown values unbound. A current-only question cannot
    // become a carried or late excerpt and later be mistaken for an answer in another turn.
    const tagged = ids as { question?: unknown; standing?: unknown } | null;
    const standing = tagged?.standing;
    if (typeof standing === 'number' && Number.isSafeInteger(standing) && standing > 0)
      return row.at <= now && row.at > now - EXCERPT_TTL_MS
        ? { ids: [standing], at: row.at, standingSetting: true }
        : { ids: [standing], at: row.at };
    const id = tagged?.question;
    return typeof id === 'number' &&
      Number.isSafeInteger(id) &&
      id > 0 &&
      row.at <= now &&
      row.at > now - EXCERPT_TTL_MS
      ? {
          ids: [id],
          at: row.at,
          currentQuestion: true,
        }
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
      for (const table of ['excerpts', 'windows', 'shown', 'kept', 'unkept'] as const) {
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
