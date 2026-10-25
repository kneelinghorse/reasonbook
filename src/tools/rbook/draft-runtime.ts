// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — a draft's runtime half: the operator's words, offer counts, windows and session starts,
// ABOUTME: kept per store under <configDir>/runtime/drafts, keyed by hashes, never committed or uploaded.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

import { ensureLateColumn } from './draft-runtime-excerpts';
import { runtimeDir } from './harness-session';
import { safeDestination, targetForStore, type TelemetryTarget } from './local-telemetry';
import { draftRuntimeFile, draftStoreKey, plainSqliteFile, sqliteFileSet } from './store-key';

// s97-m01: the key lives in a dependency-free leaf, so the signals library finds this same file.
export { draftStoreKey };

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

export const STARTS_KEPT = 200;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS starts (at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_declines (draft_id INTEGER PRIMARY KEY, at INTEGER NOT NULL);
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

/** s97-m01: the folder that holds every store's draft runtime on this machine. */
export function draftRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(runtimeDir(env), 'drafts');
}

export function draftRuntimePath(storeKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return draftRuntimeFile(draftRuntimeDir(env), storeKey);
}

function requireSafe(file: string, target: TelemetryTarget): boolean {
  return sqliteFileSet(file).every(
    (name) => safeDestination(name, target) && plainSqliteFile(name)
  );
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
  let directory: string | undefined;
  if (options.readonly) {
    try {
      directory = draftRuntimeDir(env);
      fs.statSync(directory);
    } catch (error) {
      // No runtime can exist here yet. Recheck on every call so a later hook is visible.
      if (directory !== undefined && (error as NodeJS.ErrnoException | null)?.code === 'ENOENT')
        return null;
      // Preserve the original identity-first handling of config and other filesystem errors.
    }
  }
  const target = targetForStore(dbPath);
  if (!target) return null;
  const storeKey = draftStoreKey(target);
  const file =
    directory === undefined
      ? draftRuntimePath(storeKey, env)
      : draftRuntimeFile(directory, storeKey);
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
    try {
      db.transaction(() => {
        db.exec(SCHEMA);
        ensureLateColumn(db);
      }).immediate();
    } catch (error) {
      db.close();
      throw error;
    }
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

/** Retain a decline until the store settles it; never keep its words or renew its first time. */
export function retainDeclines(runtime: DraftRuntime, ids: readonly number[], at: number): void {
  const retain = runtime.db.prepare(`INSERT INTO pending_declines (draft_id, at) VALUES (?, ?)
    ON CONFLICT(draft_id) DO NOTHING`);
  runtime.db.transaction(() => {
    for (const id of ids) retain.run(id, at);
  })();
}

/** Store-local decline protection survives session cleanup; old read-only runtimes have none. */
export function pendingDeclines(
  runtime: DraftRuntime
): Array<{ readonly id: number; readonly at: number }> {
  if (!has(runtime, 'pending_declines')) return [];
  return runtime.db
    .prepare('SELECT draft_id AS id, at FROM pending_declines ORDER BY draft_id')
    .all() as Array<{ readonly id: number; readonly at: number }>;
}

/** Call only once the store durably declined the draft or authoritatively ended its pending state. */
export function clearPendingDeclines(runtime: DraftRuntime, ids: readonly number[]): void {
  const clear = runtime.db.prepare('DELETE FROM pending_declines WHERE draft_id = ?');
  runtime.db.transaction(() => {
    for (const id of ids) clear.run(id);
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

export {
  carryShown,
  peekShown,
  readShown,
  restoreShown,
  setShown,
  takeShown,
  takeKept,
  takeKeptWithTimes,
  pruneAllRuntimes,
  PRUNE_FILES_MAX,
} from './draft-runtime-shown';

export {
  bindExcerpt,
  bindWindow,
  closeWindow,
  openWindow,
  readExcerpt,
  EXCERPT_TTL_MS,
  EXCERPT_MAX,
  type StoredExcerpt,
} from './draft-runtime-excerpts';
