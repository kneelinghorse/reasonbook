// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — the proposals table: drafted records awaiting the operator, a carve-out outside FTS and sync.
// ABOUTME: Light (one SQL runner, no client), so the Stop and prompt hooks and the server share every statement.

import type Database from 'better-sqlite3';

import type { RbookDatabaseClient } from './client';
import type { DraftKind } from './draft-grammar';
import type { RbookToolResult } from './types';
import { storedTimeMs } from './stored-time';

/**
 * WHY A CARVE-OUT (design doc s93 m06 fork 2; build plan B1, B2, B15). A draft is not a record:
 * nobody has approved it. So it never enters the record's tables, FTS, embeddings or sync events,
 * and it carries no genesis columns. It is read only by the digest's drafts section, `drafts list`,
 * `stats` and the record path. Checkpoint sync uploads the whole store file, so drafts ride that
 * upload once signed in (disclosed in SECURITY.md and the README by m09).
 *
 * WHAT IS NEVER HERE. The operator's reply. The hook keeps it in the runtime directory for at most
 * two hours (#1188); only a `fromDraft` record copies it, into the decision it approves.
 *
 * EXPIRY IS COMPUTED WHEN READ (Q10's rule). A pending draft reads expired once it is older than
 * {@link DRAFT_EXPIRY_DAYS} days or {@link DRAFT_EXPIRY_STARTS} sessions have started since it was
 * drafted (counted in the runtime directory, so session start writes nothing here). No reader
 * writes `expired`; an expired draft can never be recorded.
 */

export const PROPOSALS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,      -- shown as P<id>
  text TEXT NOT NULL,                        -- the line after "Would record…:"
  kind TEXT NOT NULL DEFAULT 'decision',     -- decision | constraint | rule | profile
  source_session TEXT,                       -- the harness session hash (16 hex), never a raw id
  assistant_excerpt TEXT,                    -- up to 600 characters of the reply before the lines
  evidence TEXT,                             -- JSON array of links and documents the line names
  outside_content INTEGER,                   -- 1 seen in the session, 0 none, NULL unknown
  created_at TEXT NOT NULL,
  offered_at TEXT,
  answered_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | declined | replaced | answered
  replaced_by INTEGER,                       -- the draft that revised this one
  record_id TEXT,                            -- the record it became: d:N, c:N, l:N or profile
  approval_mode TEXT                         -- approved | agent-judged | agent-attested
);
CREATE INDEX IF NOT EXISTS idx_proposals_outcome ON proposals (outcome);`;

export const DRAFT_EXPIRY_DAYS = 7;
export const DRAFT_EXPIRY_STARTS = 3;

export type DraftOutcome = 'pending' | 'approved' | 'declined' | 'replaced' | 'answered';
export type ApprovalMode = 'approved' | 'agent-judged' | 'agent-attested';

export interface DraftRow {
  readonly id: number;
  readonly text: string;
  readonly kind: DraftKind;
  readonly sourceSession: string | null;
  readonly assistantExcerpt: string | null;
  readonly evidence: readonly string[];
  readonly outsideContent: number | null;
  readonly createdAt: string;
  readonly offeredAt: string | null;
  readonly answeredAt: string | null;
  readonly outcome: DraftOutcome;
  readonly replacedBy: number | null;
  readonly recordId: string | null;
  readonly approvalMode: ApprovalMode | null;
}

/** The few statements the proposals code needs, over better-sqlite3 or the Reasonbook client alike. */
export interface SqlRunner {
  all<T>(sql: string, params?: unknown[]): T[];
  get<T>(sql: string, params?: unknown[]): T | undefined;
  run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  exec(sql: string): void;
}

export function rawRunner(db: Database.Database): SqlRunner {
  return {
    all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: unknown[] = []) =>
      db.prepare(sql).get(...params) as T | undefined,
    run: (sql, params = []) => db.prepare(sql).run(...params),
    exec: (sql) => {
      db.exec(sql);
    },
  };
}

/** The Reasonbook client as a runner; a failed statement throws, so a caller never reads it as empty. */
export function clientRunner(client: RbookDatabaseClient): SqlRunner {
  const failed = (message: string | undefined): never => {
    throw new Error(message ?? 'The proposals query failed.');
  };
  const read = <T>(result: RbookToolResult<T>): T =>
    result.success ? (result.data as T) : failed(result.error?.message);
  return {
    all: <T>(sql: string, params: unknown[] = []) => read(client.getMany<T>(sql, params)) ?? [],
    get: <T>(sql: string, params: unknown[] = []) => read(client.getOne<T>(sql, params)),
    run: (sql, params = []) => {
      const written = client.execute(sql, params);
      if (!written.success || !written.data) return failed(written.error?.message);
      return { changes: written.data.changes, lastInsertRowid: written.data.lastInsertRowid };
    },
    exec: (sql) => {
      const applied = client.raw(sql);
      if (!applied.success) failed(applied.error?.message);
    },
  };
}

export function draftLabel(id: number): string {
  return `P${id}`;
}

/** `P12`, `p12` or `12`; null for anything else. */
export function parseDraftId(value: string | number | undefined | null): number | null {
  const text = String(value ?? '').trim();
  const match = /^[pP]?([1-9]\d{0,15})$/.exec(text);
  return match ? Number(match[1]) : null;
}

export function proposalsTableExists(run: SqlRunner): boolean {
  return Boolean(
    run.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'proposals'")
  );
}

export function ensureProposalsTable(run: SqlRunner): void {
  run.exec(PROPOSALS_TABLE_SQL);
}

interface StoredRow {
  id: number;
  text: string;
  kind: string;
  source_session: string | null;
  assistant_excerpt: string | null;
  evidence: string | null;
  outside_content: number | null;
  created_at: string;
  offered_at: string | null;
  answered_at: string | null;
  outcome: string;
  replaced_by: number | null;
  record_id: string | null;
  approval_mode: string | null;
}

function evidenceOf(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function toRow(row: StoredRow): DraftRow {
  return {
    id: row.id,
    text: row.text,
    kind: (['decision', 'constraint', 'rule', 'profile'].includes(row.kind)
      ? row.kind
      : 'decision') as DraftKind,
    sourceSession: row.source_session,
    assistantExcerpt: row.assistant_excerpt,
    evidence: evidenceOf(row.evidence),
    outsideContent: row.outside_content,
    createdAt: row.created_at,
    offeredAt: row.offered_at,
    answeredAt: row.answered_at,
    outcome: row.outcome as DraftOutcome,
    replacedBy: row.replaced_by,
    recordId: row.record_id,
    approvalMode: row.approval_mode as ApprovalMode | null,
  };
}

export interface NewDraft {
  readonly text: string;
  readonly kind: DraftKind;
  readonly sourceSession: string | null;
  readonly assistantExcerpt: string | null;
  readonly evidence: readonly string[];
  readonly outsideContent: number | null;
  readonly createdAt: string;
}

export function insertDraft(run: SqlRunner, draft: NewDraft): number {
  const result = run.run(
    `INSERT INTO proposals (text, kind, source_session, assistant_excerpt, evidence, outside_content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      draft.text,
      draft.kind,
      draft.sourceSession,
      draft.assistantExcerpt,
      draft.evidence.length ? JSON.stringify(draft.evidence) : null,
      draft.outsideContent,
      draft.createdAt,
    ]
  );
  return Number(result.lastInsertRowid);
}

/** Pending rows, oldest first, expiry not applied (callers apply {@link isExpired}). */
export function pendingDrafts(run: SqlRunner): DraftRow[] {
  if (!proposalsTableExists(run)) return [];
  return run
    .all<StoredRow>("SELECT * FROM proposals WHERE outcome = 'pending' ORDER BY id")
    .map(toRow);
}

export function getDraft(run: SqlRunner, id: number): DraftRow | undefined {
  if (!proposalsTableExists(run)) return undefined;
  const row = run.get<StoredRow>('SELECT * FROM proposals WHERE id = ?', [id]);
  return row ? toRow(row) : undefined;
}

/** Drafts created in a window, any outcome, oldest first: `drafts list --all` and `stats`. */
export function draftsCreatedBetween(run: SqlRunner, since: string, until: string): DraftRow[] {
  if (!proposalsTableExists(run)) return [];
  return run
    .all<StoredRow>(
      'SELECT * FROM proposals WHERE julianday(created_at) BETWEEN julianday(?) AND julianday(?) ORDER BY id',
      [since, until]
    )
    .map(toRow);
}

const placeholders = (ids: readonly number[]): string => ids.map(() => '?').join(', ');

/** The first offer's time; later offers leave it. */
export function markOffered(run: SqlRunner, ids: readonly number[], at: string): void {
  if (!ids.length) return;
  run.run(
    `UPDATE proposals SET offered_at = ? WHERE offered_at IS NULL AND id IN (${placeholders(ids)})`,
    [at, ...ids]
  );
}

export function markDeclined(run: SqlRunner, ids: readonly number[], at: string): number {
  if (!ids.length) return 0;
  return run.run(
    `UPDATE proposals SET outcome = 'declined', answered_at = ?
     WHERE outcome = 'pending' AND id IN (${placeholders(ids)})`,
    [at, ...ids]
  ).changes;
}

export function markReplaced(run: SqlRunner, id: number, by: number, at: string): number {
  return run.run(
    `UPDATE proposals SET outcome = 'replaced', replaced_by = ?, answered_at = ?
     WHERE outcome = 'pending' AND id = ?`,
    [by, at, id]
  ).changes;
}

/**
 * s97-m12: a line revising a draft the operator plainly approved links it, and the approved draft
 * stays pending: from then on it records only in its own words (evaluateDraft).
 */
export function markRevisedAfterApproval(run: SqlRunner, id: number, by: number): number {
  return run.run(
    `UPDATE proposals SET replaced_by = ? WHERE outcome = 'pending' AND id = ? AND replaced_by IS NULL`,
    [by, id]
  ).changes;
}

/** A direct record (no fromDraft) answered these drafts; they never reappear (B12). */
export function markAnswered(
  run: SqlRunner,
  ids: readonly number[],
  recordId: string,
  at: string
): number {
  if (!ids.length) return 0;
  const changed = run.run(
    `UPDATE proposals SET outcome = 'answered', record_id = ?, answered_at = ?
     WHERE outcome = 'pending' AND id IN (${placeholders(ids)})`,
    [recordId, at, ...ids]
  ).changes;
  if (changed) settleRevised(run, ids, at);
  return changed;
}

/** Guarded by `outcome = 'pending'`: two racing records approve one draft once. Returns changes. */
export function markApproved(
  run: SqlRunner,
  id: number,
  approval: { readonly recordId: string; readonly mode: ApprovalMode; readonly at: string }
): number {
  const changed = run.run(
    `UPDATE proposals SET outcome = 'approved', record_id = ?, approval_mode = ?, answered_at = ?
     WHERE outcome = 'pending' AND id = ?`,
    [approval.recordId, approval.mode, approval.at, id]
  ).changes;
  if (changed) settleRevised(run, [id], approval.at);
  return changed;
}

/**
 * s97-m12 (critic rounds 2 and 3): a recorded revision settles every approved draft its chain
 * revised, however many revisions back, which stayed pending only so it could still be recorded
 * in its own words.
 */
export function settleRevised(run: SqlRunner, ids: readonly number[], at: string): void {
  if (!ids.length) return;
  run.run(
    `WITH RECURSIVE earlier(id) AS (
       SELECT id FROM proposals WHERE replaced_by IN (${placeholders(ids)})
       UNION
       SELECT proposals.id FROM proposals JOIN earlier ON proposals.replaced_by = earlier.id
     )
     UPDATE proposals SET outcome = 'replaced', answered_at = ?
     WHERE outcome = 'pending' AND id IN (SELECT id FROM earlier)`,
    [...ids, at]
  );
}

/** The newest draft in a chain of revisions from `id`: the one no later line replaced. */
export function latestRevision(run: SqlRunner, id: number): number {
  let current = id;
  for (let step = 0; step < 32; step += 1) {
    const next = getDraft(run, current)?.replacedBy;
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

/**
 * Whether a pending draft has expired: older than 7 days, or 3 sessions have started since it was
 * drafted. An unreadable creation time reads expired, never fresh.
 */
export function isExpired(
  draft: { readonly createdAt: string },
  startsSinceCreated: number,
  now: number = Date.now()
): boolean {
  const created = storedTimeMs(draft.createdAt);
  if (!Number.isFinite(created)) return true;
  return (
    now - created > DRAFT_EXPIRY_DAYS * 86_400_000 || startsSinceCreated >= DRAFT_EXPIRY_STARTS
  );
}
