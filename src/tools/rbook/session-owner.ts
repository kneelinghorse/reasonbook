// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m03 — whose session a write belongs to: the caller's explicit session, else its own implicit
// ABOUTME: session, opened lazily. Also the facts reconcile decides on.

import { isDirectoryEdition } from '../../edition';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { performance } from 'perf_hooks';
import { currentCodexRequest } from '../../codex-request-context';

import type { RbookDatabaseClient } from './client';
import { RBOOK_ERROR_CODES } from './errors';
import { genesisColumns, getProjectId, tableHasColumn } from './genesis-columns';
import { harnessKeyAppliesTo, harnessSessionHash, linkedHarness } from './harness-session';
import type { RbookToolError } from './types';
import { checkWrite } from './write-guard';
import { storedTimeMs } from './stored-time';
import { hasHookSession, openDraftRuntime } from './draft-runtime';
import { recordedWrite } from './record-changes';
import { readReplicaIdentity } from './replica-identity';
import { PEER_OWNER_PREFIX } from './peer-sessions';

/**
 * WHY (aquex.ai message 9b183348 item 4; s92 design, m03). A capture with no open session was
 * refused with SESSION_NOT_ACTIVE, and neither rbook_review nor rbook_agent_onboard opens one, so the
 * first capture of most conversations failed. No harness has an open/close ritual of its own. Since
 * 3.2.0 a write that names no session lands in an IMPLICIT session the server opens for the calling
 * process.
 *
 * THE CALLER'S SESSION, in order:
 *   1. an active EXPLICIT session the caller started (its owner key);
 *   2. otherwise an active keyless explicit session, which absorbs every caller's writes as the
 *      project's one explicit session did before 3.3.0;
 *   3. otherwise the caller's own active implicit session;
 *   4. otherwise, for a write, a new implicit session owned by the caller.
 * No lookup ever returns another caller's implicit session, or another harness session's explicit
 * one.
 *
 * WHO A CALLER IS. `ext:<hash>` for a harness session: the hook CLI keys by the hash of its stdin
 * session id, and since s93-m01 an MCP server whose harness linked a session (SessionStart's
 * runtime file, harness-session.ts) writes into that session too, in the conversation's own store,
 * so one harness session is one Reasonbook session there across server restarts and `/clear` (decision
 * #1189). In any other store, and for a server with no link,
 * `pid:<host>:<pid>:<start>`, where host is a short hash of the hostname (never the name) and start
 * is this process's start time in ms, so a reused pid is a different owner.
 *
 * WHICH EXPLICIT SESSIONS CARRY A KEY (s93-m01). Only one started inside a harness session: it
 * belongs to that conversation, absorbs only its writes, and closes when the harness session ends
 * (SessionEnd, `/clear` included). One started by a pid-keyed caller stays keyless, because a pid
 * key names a server process, not a conversation: a keyed one would be orphaned by the restart
 * every build requires (the m01 build critic, B1).
 *
 * NO SPRINT. A process outlives sprints, so an implicit session carries no sprint_id. Every row it
 * writes resolves its own sprint when it is written, as any untagged write does, instead of
 * inheriting the sprint that was open when its process started.
 */

/** An implicit session idle longer than this is closed by reconcile, whoever owns it. */
export const IMPLICIT_SESSION_IDLE_HOURS = 12;

const HOUR_MS = 60 * 60 * 1000;

export interface SessionOwner {
  /** Stored in `sessions.owner_key`. */
  key: string;
  kind: 'external' | 'process';
  pid: number;
}

/** The PID namespace this process lives in, where the OS exposes one (Linux); else empty. */
function pidNamespace(): string {
  try {
    return fs.readlinkSync('/proc/self/ns/pid');
  } catch {
    return '';
  }
}

/**
 * A short, stable id for "the PID space this process can probe". The hostname alone is not that:
 * WSL2 beside Windows, or containers sharing the host's name, see different processes under one
 * hostname, and probing a pid from the wrong space would read a live owner as dead. Platform and
 * the PID namespace keep those apart. The hostname itself is never stored.
 */
export const THIS_HOST_ID = createHash('sha256')
  .update([os.hostname(), process.platform, pidNamespace()].join('\0'))
  .digest('hex')
  .slice(0, 12);

const PROCESS_STARTED_MS = Math.round(performance.timeOrigin);

let externalOwnerId: string | null = null;
let ownerOverride: SessionOwner | null = null;

/**
 * Key this process's sessions by a harness session (the hook CLI: stdin `session_id`). The raw id
 * is hashed here, through the one shared helper, so it never reaches the store.
 */
export function setExternalSessionOwner(id: string | null): void {
  const trimmed = id?.trim();
  externalOwnerId = trimmed ? harnessSessionHash(trimmed) : null;
}

/** Test seam: act as another owner. Shipped code never calls it. */
export function setSessionOwnerForTesting(owner: SessionOwner | null): void {
  ownerOverride = owner;
}

/** The owner key a process with this pid and start time has on this host. */
export function processOwnerKey(pid: number, startedMs: number, hostId = THIS_HOST_ID): string {
  return `pid:${hostId}:${pid}:${startedMs}`;
}

/**
 * Who a write into the store at `dbPath` is made as. Resolved per call, never cached: SessionStart
 * rewrites the harness link on `/clear`, and the next write must land in the new session. A linked
 * server writes as its harness session only in the conversation's own store (harnessKeyAppliesTo);
 * elsewhere as itself. Without `dbPath` the harness session counts wherever the link points.
 */
export function currentSessionOwner(dbPath?: string): SessionOwner {
  if (isDirectoryEdition()) return processSessionOwner();
  if (ownerOverride) return ownerOverride;
  if (externalOwnerId) {
    return { key: `ext:${externalOwnerId}`, kind: 'external', pid: process.pid };
  }
  const codex = currentCodexRequest();
  if (codex) {
    // Hook-less requests and requests into another store keep the process owner. Never borrow
    // an inherited Claude link from a shell that happened to start this Codex server.
    if (!dbPath || !codex.cwd || !codex.sessionId) return processSessionOwner();
    const hash = harnessSessionHash(codex.sessionId);
    if (!harnessKeyAppliesTo({ hash, projectDir: codex.cwd }, dbPath)) return processSessionOwner();
    const runtime = openDraftRuntime(dbPath, process.env, { readonly: true });
    try {
      if (runtime && hasHookSession(runtime, hash)) {
        return { key: `ext:${hash}`, kind: 'external', pid: process.pid };
      }
    } finally {
      runtime?.close();
    }
    return processSessionOwner();
  }
  const linked = linkedHarness();
  if (linked && (dbPath === undefined || harnessKeyAppliesTo(linked, dbPath))) {
    return { key: `ext:${linked.hash}`, kind: 'external', pid: process.pid };
  }
  return processSessionOwner();
}

/**
 * This process's own pid-keyed identity, whatever harness link it has. A server closes only these
 * sessions when it exits: a harness session's sessions close at SessionEnd (mechanism critic B2).
 */
export function processSessionOwner(): SessionOwner {
  // The test seam acts as another process; an external override has no pid key of its own.
  if (ownerOverride?.kind === 'process') return ownerOverride;
  return {
    key: processOwnerKey(process.pid, PROCESS_STARTED_MS),
    kind: 'process',
    pid: process.pid,
  };
}

/**
 * The owner key an explicit session started by `owner` records: a harness session's key, or none
 * (see WHICH EXPLICIT SESSIONS CARRY A KEY).
 */
export function explicitSessionOwnerKey(
  owner: SessionOwner = currentSessionOwner()
): string | null {
  return owner.kind === 'external' ? owner.key : null;
}

/**
 * `dead` only when the owner is a process on THIS host and that pid is gone. A reused pid reads
 * `alive`, which can only delay a close until the idle bound; it never closes a live session.
 * External owners and other hosts read `unknown`: nothing here can probe them.
 */
export type OwnerLiveness = 'self' | 'alive' | 'dead' | 'unknown';

/** The refusal of a write to, or a close of, a session another copy started (s96-m12). */
export function sessionOfAnotherCopy(sessionId: string): RbookToolError {
  return {
    code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
    message: `Session '${sessionId}' belongs to another copy of this shared record, and only that copy writes to it or closes it; this call did not change it.`,
    field: 'sessionId',
    providedValue: sessionId,
    suggestion: 'Leave sessionId out to use a session on this copy.',
  };
}

export function ownerLiveness(
  ownerKey: string | null,
  self: SessionOwner = currentSessionOwner()
): OwnerLiveness {
  if (!ownerKey) return 'unknown';
  if (ownerKey === self.key) return 'self';
  const match = /^pid:([0-9a-f]+):(\d+):(\d+)$/.exec(ownerKey);
  if (!match || match[1] !== THIS_HOST_ID) return 'unknown';
  try {
    process.kill(Number(match[2]), 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? 'alive' : 'dead';
  }
}

/** The day's id prefix: `PS-YYYY-MM-DD-` in block 0, `PS-YYYY-MM-DD-bK-` in block K (ADR s96 §3). */
export function sessionIdPrefix(block = 0, now = new Date()): string {
  const dateStr = now.toISOString().split('T')[0];
  return block ? `PS-${dateStr}-b${block}-` : `PS-${dateStr}-`;
}

/**
 * Format: PS-YYYY-MM-DD-NNN, one counter per project per day; a copy of a shared record in block K
 * writes PS-YYYY-MM-DD-bK-NNN. Block 0's counter skips the segmented ids (their tail is no number).
 */
export function generateSessionId(existingIds: string[], block = 0): string {
  const prefix = sessionIdPrefix(block);

  // Find the highest counter for today
  let maxCounter = 0;
  for (const id of existingIds) {
    if (id.startsWith(prefix)) {
      const counterStr = id.slice(prefix.length);
      const counter = parseInt(counterStr, 10);
      if (!isNaN(counter) && counter > maxCounter) {
        maxCounter = counter;
      }
    }
  }

  return `${prefix}${String(maxCounter + 1).padStart(3, '0')}`;
}

export interface NewSessionInput {
  type: string;
  title: string;
  sprintId: string | null;
  agent: string;
  /** ISO timestamp for started_at and the start event. */
  now: string;
  implicit: boolean;
  ownerKey: string | null;
}

export type NewSessionOutcome =
  | { ok: true; sessionId: string; warnings: string[] }
  | { ok: false; error: RbookToolError };

/**
 * The one place a local session row is written (explicit start and implicit open). Retries on a
 * session-id collision (a restore, or another process minting the same counter between the SELECT
 * and the INSERT), stamps genesis columns, and logs the start event.
 *
 * PRECONDITION: the caller ran ensureImplicitSessionColumns into its own answer's warnings (the
 * migration-warning census requires the migration at the answer boundary, not in a helper). A
 * caller that forgot fails loudly on the INSERT's column list, never silently.
 */
export function insertNewSession(
  client: RbookDatabaseClient,
  input: NewSessionInput
): NewSessionOutcome {
  const warnings: string[] = [];
  const block = readReplicaIdentity(client)?.block ?? 0;
  const todayPrefix = sessionIdPrefix(block);
  const MAX_ID_RETRIES = 3;
  let sessionId = '';
  let inserted: ReturnType<RbookDatabaseClient['execute']> = { success: false };

  for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt++) {
    const existing = client.getMany<{ id: string }>(
      'SELECT id FROM sessions WHERE id LIKE ? ORDER BY id DESC',
      [`${todayPrefix}%`]
    );
    sessionId = generateSessionId(
      existing.success && existing.data ? existing.data.map((r) => r.id) : [],
      block
    );

    // s96-m01: on a shared store each attempt takes its sequence under the write lock, so a
    // colliding attempt rolls its sequence back (ADR s96 §3).
    inserted = recordedWrite(client, () => {
      const g = genesisColumns(client, 'sessions', getProjectId(client));
      return client.execute(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures, next_steps, metadata, implicit, owner_key, ${g.columns.join(', ')})
         VALUES (?, ?, ?, ?, ?, ?, 'active', '[]', NULL, NULL, ?, ?, ${g.placeholders})`,
        [
          sessionId,
          input.type,
          input.title,
          input.sprintId,
          input.now,
          input.agent,
          input.implicit ? 1 : 0,
          input.ownerKey,
          ...g.values,
        ]
      );
    });
    if (inserted.success) break;

    // Only a UNIQUE collision on the session id is worth another counter.
    const isIdCollision =
      inserted.error?.code === RBOOK_ERROR_CODES.INVALID_PARAMETER &&
      inserted.error?.field === 'id';
    if (!isIdCollision) break;
  }

  if (!inserted.success) {
    return {
      ok: false,
      error: {
        code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to create session: ${inserted.error?.message ?? 'Unknown error'}`,
        suggestion: 'Check database permissions and schema integrity',
      },
    };
  }

  const rawEvent = JSON.stringify({
    ts: input.now,
    agent: input.agent,
    session: sessionId,
    action: 'start',
    status: 'active',
    summary: input.title,
  });
  // The session DID start, so a lost event row must not undo it, but it must not be silent either.
  checkWrite(
    client.execute(
      `INSERT INTO session_events (ts, agent, mission, action, status, summary, next_hint, raw_event)
       VALUES (?, ?, ?, 'start', 'active', ?, ?, ?)`,
      [input.now, input.agent, sessionId, input.title, input.sprintId, rawEvent]
    ),
    warnings,
    'Session start event logging'
  );

  return { ok: true, sessionId, warnings };
}

export interface CallerSession {
  sessionId: string;
  implicit: boolean;
  /** True when this call opened the implicit session. */
  opened: boolean;
}

export type CallerSessionOutcome =
  | { ok: true; session: CallerSession | null; warnings: string[] }
  | { ok: false; error: RbookToolError };

/** The title an implicit session carries: who opened it, never a hostname. */
export function implicitSessionTitle(owner: SessionOwner = currentSessionOwner()): string {
  return owner.kind === 'external'
    ? `Implicit session (${owner.key})`
    : `Implicit session (process ${owner.pid})`;
}

/** Stores in which this process has used an implicit session, for the close at stdin end. */
const storesWithImplicitUse = new Map<string, number>();

function noteImplicitUse(dbPath: string): void {
  storesWithImplicitUse.set(dbPath, Date.now());
}

/** Store paths this process opened or found its implicit session in. */
export function storesUsedImplicitly(): string[] {
  return [...storesWithImplicitUse.keys()];
}

/**
 * Reconcile runs once per process per store: after the first write call there, of any kind and
 * whether or not it succeeded, and only for that call's own store. A store counts as reconciled
 * only once a reconcile pass actually read it.
 */
const reconciledStores = new Set<string>();

export function storeNeedsReconcile(dbPath: string): boolean {
  return !reconciledStores.has(dbPath);
}

export function markStoreReconciled(dbPath: string): void {
  reconciledStores.add(dbPath);
}

/**
 * The session a write that names none belongs to (see the module docblock for the order). With
 * `open: false` it never writes a session row and answers null when the caller has none.
 *
 * PRECONDITION: as for {@link insertNewSession}, the caller ran ensureImplicitSessionColumns.
 */
export function resolveCallerSession(
  client: RbookDatabaseClient,
  options: { open: boolean; agent?: string; now?: string }
): CallerSessionOutcome {
  const warnings: string[] = [];
  const owner = currentSessionOwner(client.path);

  // An explicit session this caller started comes first; a keyless one (started before 3.3.0)
  // absorbs keyless writers as it always did. Another caller's keyed explicit session never does.
  const explicit = client.getOne<{ id: string }>(
    `SELECT id FROM sessions
      WHERE status = 'active' AND implicit = 0 AND (owner_key = ? OR owner_key IS NULL)
      ORDER BY (owner_key IS NULL), julianday(started_at) DESC LIMIT 1`,
    [owner.key]
  );
  if (!explicit.success) {
    return {
      ok: false,
      error: explicit.error ?? {
        code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
        message: 'Failed to find active session',
      },
    };
  }
  if (explicit.data) {
    return {
      ok: true,
      session: { sessionId: explicit.data.id, implicit: false, opened: false },
      warnings,
    };
  }

  const own = client.getOne<{ id: string }>(
    `SELECT id FROM sessions
      WHERE status = 'active' AND implicit = 1 AND owner_key = ?
      ORDER BY julianday(started_at) DESC LIMIT 1`,
    [owner.key]
  );
  if (!own.success) {
    return {
      ok: false,
      error: own.error ?? {
        code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
        message: "Failed to find this process's implicit session",
      },
    };
  }
  if (own.data) {
    noteImplicitUse(client.path);
    return {
      ok: true,
      session: { sessionId: own.data.id, implicit: true, opened: false },
      warnings,
    };
  }
  if (!options.open) return { ok: true, session: null, warnings };

  const opened = insertNewSession(client, {
    type: 'custom',
    title: implicitSessionTitle(owner),
    sprintId: null,
    agent: options.agent ?? 'assistant',
    now: options.now ?? new Date().toISOString(),
    implicit: true,
    ownerKey: owner.key,
  });
  if (!opened.ok) return { ok: false, error: opened.error };
  noteImplicitUse(client.path);
  return {
    ok: true,
    session: { sessionId: opened.sessionId, implicit: true, opened: true },
    warnings: [...warnings, ...opened.warnings],
  };
}

/**
 * The latest moment a session did anything: its start, its newest capture, and the newest decision
 * or learning it authored. Derived, so no row write is needed per activity.
 *
 * Stored times are UTC. SQLite's own spelling (`YYYY-MM-DD HH:MM:SS`, no zone) is normalized to
 * ISO first: Date.parse reads that spelling as LOCAL time, which east of UTC makes a session look
 * hours older than it is, close enough to the idle bound to close a live one.
 */
export function lastActivityMs(
  client: RbookDatabaseClient,
  session: { id: string; started_at: string; captures: string | null }
): number {
  const parse = (value: string): number => storedTimeMs(value);
  const times: number[] = [parse(session.started_at)];
  try {
    const captures: unknown = JSON.parse(session.captures ?? '[]');
    if (Array.isArray(captures)) {
      for (const capture of captures) {
        const stamp = (capture as { timestamp?: unknown })?.timestamp;
        if (typeof stamp === 'string') times.push(parse(stamp));
      }
    }
  } catch {
    // An unreadable capture blob adds nothing; the other anchors still count.
  }
  for (const table of ['strategic_decisions', 'learnings'] as const) {
    const newest = client.getOne<{ newest: string | null }>(
      `SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday(created_at))) AS newest FROM ${table} WHERE author_session_id = ?`,
      [session.id]
    );
    if (newest.success && newest.data?.newest) times.push(parse(newest.data.newest));
  }
  const known = times.filter((t) => Number.isFinite(t));
  return known.length > 0 ? Math.max(...known) : Date.now();
}

/**
 * Whether a named session belongs to another running process: implicit, not this process's, and
 * its owner alive (or not probeable from here). Such a session is never WRITTEN to by this caller,
 * however idle: a write would be attributed to that process and would restart its idle clock. It
 * may be COMPLETED once it has idled past the bound, which is exactly when reconcile would close
 * it; a session whose owner is gone is fair game for both.
 */
export function heldByAnotherProcess(
  client: RbookDatabaseClient,
  session: {
    id: string;
    started_at: string;
    captures: string | null;
    implicit?: number | null;
    owner_key?: string | null;
  },
  purpose: 'write' | 'complete',
  nowMs: number = Date.now(),
  self: SessionOwner = currentSessionOwner(client.path)
): boolean {
  if (session.implicit !== 1) return false;
  const liveness = ownerLiveness(session.owner_key ?? null, self);
  if (liveness === 'self' || liveness === 'dead') return false;
  if (purpose === 'write') return true;
  return nowMs - lastActivityMs(client, session) <= IMPLICIT_SESSION_IDLE_HOURS * HOUR_MS;
}

export type CloseReason = 'owner-exited' | 'idle' | 'process-exit' | 'harness-ended';

export interface SessionToClose {
  sessionId: string;
  title: string;
  implicit: boolean;
  reason: CloseReason;
  idleHours: number;
}

interface ActiveSessionRow {
  id: string;
  title: string;
  started_at: string;
  captures: string | null;
  owner_key: string | null;
}

const roundHours = (ms: number): number => Math.round((ms / HOUR_MS) * 10) / 10;

/**
 * Implicit sessions reconcile should close: another process's session whose owner is gone from
 * this host, or any implicit session idle past {@link IMPLICIT_SESSION_IDLE_HOURS}. This process's
 * own sessions are never candidates. Null when the read failed. The finders below never migrate: a
 * store without the `implicit` column has no implicit session, and every active session is explicit.
 */
export function implicitSessionsToClose(
  client: RbookDatabaseClient,
  nowMs: number = Date.now(),
  self: SessionOwner = currentSessionOwner(client.path)
): SessionToClose[] | null {
  if (!tableHasColumn(client, 'sessions', 'implicit')) return [];
  const rows = client.getMany<ActiveSessionRow>(
    `SELECT id, title, started_at, captures, owner_key FROM sessions
      WHERE status = 'active' AND implicit = 1 AND (owner_key IS NULL OR owner_key <> ?)
      ORDER BY julianday(started_at) ASC`,
    [self.key]
  );
  if (!rows.success || !rows.data) return null;

  const close: SessionToClose[] = [];
  for (const row of rows.data) {
    const idleMs = nowMs - lastActivityMs(client, row);
    const liveness = ownerLiveness(row.owner_key, self);
    if (liveness === 'dead') {
      close.push({
        sessionId: row.id,
        title: row.title,
        implicit: true,
        reason: 'owner-exited',
        idleHours: roundHours(idleMs),
      });
    } else if (idleMs > IMPLICIT_SESSION_IDLE_HOURS * HOUR_MS) {
      close.push({
        sessionId: row.id,
        title: row.title,
        implicit: true,
        reason: 'idle',
        idleHours: roundHours(idleMs),
      });
    }
  }
  return close;
}

/**
 * The explicit sessions an explicit start would meet: those idle past the bound, whoever started
 * them (closed first, with a receipt), and a count of live ones that block this caller's start: its
 * own and keyless ones, never another harness session's (which make the start refuse). Null when
 * the read failed.
 */
export function explicitSessionsAtStart(
  client: RbookDatabaseClient,
  nowMs: number = Date.now(),
  self: SessionOwner = currentSessionOwner(client.path)
): { idle: SessionToClose[]; live: number } | null {
  const migrated = tableHasColumn(client, 'sessions', 'implicit');
  const keyed = migrated && tableHasColumn(client, 'sessions', 'owner_key');
  const rows = client.getMany<ActiveSessionRow>(
    keyed
      ? `SELECT id, title, started_at, captures, owner_key FROM sessions
          WHERE status = 'active' AND implicit = 0
            AND (owner_key IS NULL OR substr(owner_key, 1, ${PEER_OWNER_PREFIX.length}) <> '${PEER_OWNER_PREFIX}')
          ORDER BY julianday(started_at) ASC`
      : migrated
        ? `SELECT id, title, started_at, captures, NULL AS owner_key FROM sessions
            WHERE status = 'active' AND implicit = 0
            ORDER BY julianday(started_at) ASC`
        : `SELECT id, title, started_at, captures, NULL AS owner_key FROM sessions
            WHERE status = 'active'
            ORDER BY julianday(started_at) ASC`,
    []
  );
  if (!rows.success || !rows.data) return null;
  const idle: SessionToClose[] = [];
  let live = 0;
  for (const row of rows.data) {
    const idleMs = nowMs - lastActivityMs(client, row);
    if (idleMs > IMPLICIT_SESSION_IDLE_HOURS * HOUR_MS) {
      idle.push({
        sessionId: row.id,
        title: row.title,
        implicit: false,
        reason: 'idle',
        idleHours: roundHours(idleMs),
      });
    } else if (row.owner_key === null || row.owner_key === self.key) {
      live += 1;
    }
  }
  return { idle, live };
}

/**
 * The active sessions a harness session owns (`ext:<hash>`): its implicit session and any explicit
 * session it started. SessionEnd closes them all.
 */
export function harnessSessions(
  client: RbookDatabaseClient,
  ownerKey: string
): Array<{ id: string; title: string; implicit: boolean }> {
  if (
    !tableHasColumn(client, 'sessions', 'implicit') ||
    !tableHasColumn(client, 'sessions', 'owner_key')
  ) {
    return [];
  }
  const rows = client.getMany<{ id: string; title: string; implicit: number }>(
    `SELECT id, title, implicit FROM sessions
      WHERE status = 'active' AND owner_key = ?
      ORDER BY julianday(started_at) ASC`,
    [ownerKey]
  );
  if (!rows.success) {
    throw new Error(rows.error?.message ?? "Failed to read the harness session's sessions");
  }
  return (rows.data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    implicit: row.implicit === 1,
  }));
}

/** This process's own active implicit session in a store, if any. */
export function ownImplicitSession(
  client: RbookDatabaseClient,
  self: SessionOwner = currentSessionOwner(client.path)
): { id: string; title: string } | null {
  if (!tableHasColumn(client, 'sessions', 'implicit')) return null;
  const own = client.getOne<{ id: string; title: string }>(
    `SELECT id, title FROM sessions
      WHERE status = 'active' AND implicit = 1 AND owner_key = ?
      ORDER BY julianday(started_at) DESC LIMIT 1`,
    [self.key]
  );
  return own.success && own.data ? own.data : null;
}

/**
 * A SQL LIKE pattern matching {@link automaticCloseSummary} for a session that held nothing: no
 * capture, no decision, no learning. Onboard's "last session" never lets one displace a session
 * that has something.
 */
export const EMPTY_AUTOMATIC_CLOSE_PATTERN =
  'Closed automatically:%. 0 captures; 0 decisions and 0 learnings authored%';

/**
 * The summary a session closed by the server carries: counts and mission ids, nothing generated.
 */
export function automaticCloseSummary(input: {
  reason: CloseReason;
  idleHours: number | null;
  captures: string | null;
  decisions: number;
  learnings: number;
}): string {
  const why =
    input.reason === 'process-exit'
      ? 'its process ended'
      : input.reason === 'harness-ended'
        ? 'its harness session ended'
        : input.reason === 'owner-exited'
          ? 'the process that opened it is gone'
          : `idle ${input.idleHours ?? '?'} h, past the ${IMPLICIT_SESSION_IDLE_HOURS} h bound`;
  const byCategory = new Map<string, number>();
  const missions = new Set<string>();
  try {
    const captures: unknown = JSON.parse(input.captures ?? '[]');
    if (Array.isArray(captures)) {
      for (const capture of captures) {
        const c = capture as { category?: unknown; missionId?: unknown };
        const category = typeof c.category === 'string' ? c.category : 'unknown';
        byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
        if (typeof c.missionId === 'string' && c.missionId) missions.add(c.missionId);
      }
    }
  } catch {
    byCategory.set('unreadable', 1);
  }
  const total = [...byCategory.values()].reduce((a, b) => a + b, 0);
  const parts = [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, count]) => `${count} ${category}`);
  return (
    `Closed automatically: ${why}. ` +
    `${total} capture${total === 1 ? '' : 's'}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}; ` +
    `${input.decisions} decision${input.decisions === 1 ? '' : 's'} and ` +
    `${input.learnings} learning${input.learnings === 1 ? '' : 's'} authored` +
    (missions.size > 0 ? `; missions: ${[...missions].sort().join(', ')}` : '') +
    '.'
  );
}
