// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — a draft's runtime half: the operator's words, offer counts, windows and session starts,
// ABOUTME: kept per store under <configDir>/runtime/drafts, keyed by hashes, never committed or uploaded.

import Database from 'better-sqlite3';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { runtimeDir } from './harness-session';
import { safeDestination, targetForStore, type TelemetryTarget } from './local-telemetry';

/**
 * WHY OUTSIDE THE STORE (#1188; build plan B1). The operator's reply is the approval's evidence,
 * but it is the operator's words, not a record: the hook keeps it here for at most
 * {@link EXCERPT_TTL_MS}, and only a `fromDraft` record copies it into the decision it approves.
 * Session starts are counted here too, so a draft's 3-start expiry needs no write to the store at
 * session start (the opener only reads, s93-m11).
 *
 * ONE FILE PER STORE, `<configDir>/runtime/drafts/<store key>.sqlite`, the key hashing the project
 * id and the store's NATIVE real path ({@link draftStoreKey}): a hook handed `cwd` and a server
 * handed a project root typed in another letter case must find the same file on a
 * case-insensitive disk, or every approval would silently read agent-attested (the plan critic,
 * N14). Every row is keyed by the 16-hex harness session hash; no raw harness id, transcript path
 * or prompt reaches it beyond the operator's message itself.
 *
 * WHAT A REPLY SHOWED (the plan critic, B1). Stop records the drafts the reply just put to the
 * operator: the ones its Would record lines created or repeated, and pending ones it named by id.
 * The next message binds only to those, so an operator's "proceed" or "no" never lands on a draft
 * they were not shown.
 *
 * THE SESSION MATCH IS THE LOOKUP. Words stored under one session can only be found by a lookup
 * under that session, so a recording server linked to another conversation (or to none) finds
 * nothing and records `agent-attested`.
 */

export const EXCERPT_TTL_MS = 2 * 60 * 60 * 1000;
export const EXCERPT_MAX = 1000;
export const STARTS_KEPT = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS starts (at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS session_state (session TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS offers (session TEXT NOT NULL, draft_id INTEGER NOT NULL,
  count INTEGER NOT NULL, PRIMARY KEY (session, draft_id));
CREATE TABLE IF NOT EXISTS excerpts (session TEXT NOT NULL, draft_id INTEGER NOT NULL,
  message TEXT NOT NULL, reply TEXT NOT NULL, window_size INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (session, draft_id));
CREATE TABLE IF NOT EXISTS windows (session TEXT PRIMARY KEY, draft_ids TEXT NOT NULL,
  open INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS shown (session TEXT PRIMARY KEY, draft_ids TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kept (session TEXT NOT NULL, draft_id INTEGER NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (session, draft_id));
CREATE TABLE IF NOT EXISTS scans (session TEXT NOT NULL, file TEXT NOT NULL, scanned INTEGER NOT NULL,
  outside INTEGER, PRIMARY KEY (session, file));`;

const SESSION_TABLES = [
  'session_state',
  'offers',
  'excerpts',
  'windows',
  'shown',
  'kept',
  'scans',
] as const;

export interface DraftRuntime {
  readonly db: Database.Database;
  readonly storeKey: string;
  readonly path: string;
  close(): void;
}

export function draftRuntimePath(storeKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeDir(env), 'drafts', `${storeKey}.sqlite`);
}

/** The project id and the store's native real path, hashed (see the module note on letter case). */
export function draftStoreKey(target: TelemetryTarget): string {
  let real = path.resolve(target.dbPath);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    // A store that cannot be resolved keys by its resolved path; it will not open anyway.
  }
  return createHash('sha256').update(`${target.projectId}\0${real}`).digest('hex').slice(0, 32);
}

function requireSafe(file: string, target: TelemetryTarget): boolean {
  for (const name of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    if (!safeDestination(name, target)) return false;
    try {
      const stat = fs.lstatSync(name);
      if (!stat.isFile() || stat.nlink !== 1) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
  }
  return true;
}

/**
 * The store's draft runtime, or null: the store's identity cannot be read, the destination is
 * unsafe (inside a repository or a project, or linked), or `readonly` and nothing was written yet.
 */
export function openDraftRuntime(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly readonly?: boolean; readonly timeoutMs?: number } = {}
): DraftRuntime | null {
  const target = targetForStore(dbPath);
  if (!target) return null;
  const storeKey = draftStoreKey(target);
  const file = draftRuntimePath(storeKey, env);
  if (!requireSafe(file, target)) return null;
  const timeout = options.timeoutMs ?? 100;
  let db: Database.Database;
  if (options.readonly) {
    if (!fs.existsSync(file)) return null;
    db = new Database(file, { readonly: true, fileMustExist: true, timeout });
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (!requireSafe(file, target)) return null;
    db = new Database(file, { timeout });
    db.exec(SCHEMA);
  }
  return { db, storeKey, path: file, close: () => db.close() };
}

function tables(runtime: DraftRuntime): Set<string> {
  return new Set(
    (
      runtime.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name)
  );
}

function has(runtime: DraftRuntime, table: string): boolean {
  return tables(runtime).has(table);
}

/** A non-compact session start: counted, and the session's earlier offers, words and window dropped. */
export function recordSessionStart(runtime: DraftRuntime, session: string, now: number): void {
  runtime.db.transaction(() => {
    runtime.db.prepare('INSERT INTO starts (at) VALUES (?)').run(now);
    runtime.db
      .prepare(
        'DELETE FROM starts WHERE rowid NOT IN (SELECT rowid FROM starts ORDER BY at DESC LIMIT ?)'
      )
      .run(STARTS_KEPT);
    for (const table of ['offers', 'excerpts', 'windows', 'shown', 'kept'])
      runtime.db.prepare(`DELETE FROM ${table} WHERE session = ?`).run(session);
    runtime.db
      .prepare(
        'INSERT INTO session_state (session, started_at) VALUES (?, ?) ON CONFLICT(session) DO UPDATE SET started_at = excluded.started_at'
      )
      .run(session, now);
  })();
}

/** SessionEnd: everything kept for the session goes. */
export function endDraftSession(runtime: DraftRuntime, session: string): void {
  runtime.db.transaction(() => {
    for (const table of SESSION_TABLES)
      runtime.db.prepare(`DELETE FROM ${table} WHERE session = ?`).run(session);
  })();
}

/** Session starts recorded strictly after `sinceMs`. */
export function startsSince(runtime: DraftRuntime, sinceMs: number): number {
  if (!has(runtime, 'starts')) return 0;
  return (
    runtime.db.prepare('SELECT COUNT(*) AS n FROM starts WHERE at > ?').get(sinceMs) as {
      n: number;
    }
  ).n;
}

export function sessionStartedAt(runtime: DraftRuntime, session: string): number | null {
  if (!has(runtime, 'session_state')) return null;
  const row = runtime.db
    .prepare('SELECT started_at FROM session_state WHERE session = ?')
    .get(session) as { started_at: number } | undefined;
  return row?.started_at ?? null;
}

/**
 * Only drafts-hook creates these rows; SessionEnd removes them. A first draft has no start marker,
 * so shown/words/window also prove hook presence. Query failures propagate, never attest approval.
 */
export function hasHookSession(runtime: DraftRuntime, session: string): boolean {
  const present = tables(runtime);
  return ['session_state', 'shown', 'windows', 'excerpts'].some(
    (table) =>
      present.has(table) &&
      Boolean(runtime.db.prepare(`SELECT 1 FROM ${table} WHERE session = ? LIMIT 1`).get(session))
  );
}

export function offerCounts(runtime: DraftRuntime, session: string): Map<number, number> {
  if (!has(runtime, 'offers')) return new Map();
  return new Map(
    (
      runtime.db
        .prepare('SELECT draft_id, count FROM offers WHERE session = ?')
        .all(session) as Array<{
        draft_id: number;
        count: number;
      }>
    ).map((row) => [row.draft_id, row.count])
  );
}

export function bumpOffers(runtime: DraftRuntime, session: string, ids: readonly number[]): void {
  const bump = runtime.db.prepare(
    `INSERT INTO offers (session, draft_id, count) VALUES (?, ?, 1)
     ON CONFLICT(session, draft_id) DO UPDATE SET count = count + 1`
  );
  runtime.db.transaction(() => {
    for (const id of ids) bump.run(session, id);
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
  const words = message.slice(0, EXCERPT_MAX);
  const keep = runtime.db.prepare(
    `INSERT INTO excerpts (session, draft_id, message, reply, window_size, at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(session, draft_id) DO UPDATE SET message = excluded.message, reply = excluded.reply,
       window_size = excluded.window_size, at = excluded.at`
  );
  runtime.db.transaction(() => {
    runtime.db.prepare('DELETE FROM excerpts WHERE at <= ?').run(now - EXCERPT_TTL_MS);
    for (const id of ids) keep.run(session, id, words, reply, ids.length, now);
    for (const id of earlier)
      keep.run(session, id, words, 'other', ids.length + earlier.length, now);
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
      'SELECT message, reply, window_size AS windowSize, at FROM excerpts WHERE session = ? AND draft_id = ?'
    )
    .get(session, draftId) as StoredExcerpt | undefined;
  return row && row.at > now - EXCERPT_TTL_MS ? row : null;
}

export interface ScanState {
  /** Per file (a hash of its path, never the path: it carries the raw session id). */
  readonly files: ReadonlyMap<
    string,
    { readonly scanned: number; readonly outside: number | null }
  >;
}

export function readScans(runtime: DraftRuntime, session: string): ScanState {
  if (!has(runtime, 'scans')) return { files: new Map() };
  const rows = runtime.db
    .prepare('SELECT file, scanned, outside FROM scans WHERE session = ?')
    .all(session) as Array<{ file: string; scanned: number; outside: number | null }>;
  return {
    files: new Map(rows.map((row) => [row.file, { scanned: row.scanned, outside: row.outside }])),
  };
}

export function saveScan(
  runtime: DraftRuntime,
  session: string,
  file: string,
  state: { readonly scanned: number; readonly outside: number | null }
): void {
  runtime.db
    .prepare(
      `INSERT INTO scans (session, file, scanned, outside) VALUES (?, ?, ?, ?)
       ON CONFLICT(session, file) DO UPDATE SET scanned = excluded.scanned, outside = excluded.outside`
    )
    .run(session, file, state.scanned, state.outside);
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

/** Take (read and clear) what the latest reply showed: one message answers one reply. */
export function takeShown(runtime: DraftRuntime, session: string, now: number): number[] {
  const ids = peekShown(runtime, session, now);
  if (has(runtime, 'shown')) runtime.db.prepare('DELETE FROM shown WHERE session = ?').run(session);
  return ids;
}

/**
 * s97-m12 (learning #481; critic round 2): a reply's drafts that no operator message took, as when
 * the harness's own prompt opened the next turn, are kept, each with the time it was first shown,
 * when the next reply's Stop replaces the shown set. They expire with that time, never refreshed.
 */
export function carryShown(runtime: DraftRuntime, session: string, now: number): void {
  if (!has(runtime, 'shown') || !has(runtime, 'kept')) return;
  const row = runtime.db.prepare('SELECT at FROM shown WHERE session = ?').get(session) as
    | { at: number }
    | undefined;
  const keep = runtime.db.prepare(
    'INSERT INTO kept (session, draft_id, at) VALUES (?, ?, ?) ON CONFLICT(session, draft_id) DO NOTHING'
  );
  runtime.db.transaction(() => {
    runtime.db.prepare('DELETE FROM kept WHERE at <= ?').run(now - EXCERPT_TTL_MS);
    if (row) for (const id of peekShown(runtime, session, now)) keep.run(session, id, row.at);
  })();
}

/** Take (read and clear) the drafts kept from earlier replies, while their first showing is young. */
export function takeKept(runtime: DraftRuntime, session: string, now: number): number[] {
  if (!has(runtime, 'kept')) return [];
  const rows = runtime.db
    .prepare('SELECT draft_id, at FROM kept WHERE session = ?')
    .all(session) as Array<{ draft_id: number; at: number }>;
  runtime.db.prepare('DELETE FROM kept WHERE session = ?').run(session);
  return rows.filter((row) => row.at > now - EXCERPT_TTL_MS).map((row) => row.draft_id);
}

/** What the latest reply showed, read without taking it. */
export function peekShown(runtime: DraftRuntime, session: string, now: number): number[] {
  if (!has(runtime, 'shown')) return [];
  const row = runtime.db
    .prepare('SELECT draft_ids, at FROM shown WHERE session = ?')
    .get(session) as { draft_ids: string; at: number } | undefined;
  if (!row || row.at <= now - EXCERPT_TTL_MS) return [];
  try {
    const ids = JSON.parse(row.draft_ids) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

/** How many store files a session start prunes, at most. */
export const PRUNE_FILES_MAX = 50;

/**
 * Drop the operator's words, windows and shown sets older than the TTL in every store's draft
 * runtime, so a crash leaves nothing past two hours once any session starts anywhere (the plan
 * critic, N6). Best effort: a file that cannot be opened is skipped. Returns the files pruned.
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
      const cutoff = now - EXCERPT_TTL_MS;
      for (const table of ['excerpts', 'windows', 'shown', 'kept']) {
        const present = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table);
        if (present) db.prepare(`DELETE FROM ${table} WHERE at <= ?`).run(cutoff);
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
