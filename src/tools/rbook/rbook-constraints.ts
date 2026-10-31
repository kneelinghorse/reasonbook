/**
 * Constraint Lifecycle Handler
 *
 * Manages structured constraints with staleness detection and archival:
 * - list: View active/all constraints
 * - review: Show stale + expired constraints with staleness scores
 * - archive: Batch archive stale/expired constraints
 *
 * Wired into rbook_context(action="constraints").
 *
 * @module tools/rbook/rbook-constraints
 */

import { formatToolFailure } from './format-failure';
import { withClient, type RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RbookErrors, RBOOK_ERROR_CODES } from './errors';
import {
  ensureConstraintsTable,
  ensureConstraintReviewTimestamp,
  ensureConstraintEvergreen,
  type ConstraintStatus,
} from './schema-migrations';
import { appendWarnings, appendWriteFailures, attachWarnings } from './format-warnings';
import { skipConflicted, skippedConflicts } from './record-conflict-skip';
import { countWrite, type WriteFailure } from './write-guard';
import { storedTimeMs } from './stored-time';
import { recordedExecute } from './record-changes';
import {
  nextPageCall,
  pageFacts,
  pageRequest,
  REREAD_AFTER_ACTING,
  shownLine,
  type PageRequest,
} from './answer-page';

/**
 * s106-m03: rows per page. A constraint has no show action, so each goes out whole: a registered
 * store's 14 active constraints answered 32,493 characters, 16 flagged ones 22,944, and another's
 * average about 3,700 characters a row across text and structured copy; 8 flagged reached 19,579.
 */
export const CONSTRAINTS_PAGE_SIZE = 4;
export const CONSTRAINT_REVIEW_PAGE_SIZE = 6;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ConstraintRecord {
  id: number;
  content: string;
  status: ConstraintStatus;
  sessionId: string | null;
  sprintId: string | null;
  createdAt: string;
  expiresAt: string | null;
  archivedAt: string | null;
  /** ISO timestamp of the last reaffirm/review, null if never reviewed (Sprint 82 m01). */
  lastReviewedAt: string | null;
  /** s84-m05: durable "never trip staleness" flag. An evergreen constraint is excluded from
   *  review/count so an institutional rule never ages past the surfacing floor. */
  evergreen: boolean;
}

export interface ConstraintReviewItem extends ConstraintRecord {
  /** 0-100 staleness score. Higher = more stale. */
  stalenessScore: number;
  /** Why this constraint is flagged */
  reason: 'expired' | 'stale_no_expiry' | 'old_sprint';
}

export interface ConstraintsResult {
  constraintAction: string;
  items?: ConstraintRecord[];
  reviewItems?: ConstraintReviewItem[];
  affected: number;
  message: string;
  /** s106-m03, list and review: every matching row, this page's number and size. */
  totalCount?: number;
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
  nextPage?: number | null;
  /** The call that reads the next page with the same filters, or null on the last page. */
  nextPageCall?: string | null;
  /** While a page follows: archiving or reaffirming moves the later rows up; re-read first. */
  pageNote?: string | null;
  /** Constraint acted on by reaffirm (Sprint 82 m01). */
  constraintId?: number;
  /** ISO timestamp the reaffirm bumped last_reviewed_at to (Sprint 82 m01). */
  reaffirmedAt?: string;
  /** s86-m02b — writes the action ATTEMPTED and the database REJECTED. Emitted by `archive`,
   *  `[]` on the happy path; absent on the read actions and on `reaffirm`, which returns
   *  createError with the DB message instead. `affected` above counts rows the UPDATE actually
   *  changed, so a non-empty array here is the difference between the intent and the outcome.
   *  A caller-supplied id that matched no ACTIVE row is NOT a failure — the statement ran, its
   *  WHERE matched nothing — and produces no entry. */
  writeFailures?: WriteFailure[];
}

export interface RbookConstraintsParams {
  /** Sub-action: list | review | archive | reaffirm */
  constraintAction: 'list' | 'review' | 'archive' | 'reaffirm';
  /** Filter by status (for list, default: active) */
  constraintStatus?: ConstraintStatus;
  /** Constraint IDs to archive */
  constraintIds?: number[];
  /** Constraint ID to reaffirm (Sprint 82 m01) */
  constraintId?: number;
  /** s84-m05: on reaffirm, optionally set/clear the durable evergreen flag (true = never
   *  trip staleness). Omitted → the reaffirm only bumps last_reviewed_at (unchanged behavior). */
  evergreen?: boolean;
  /** Staleness threshold in days (for review, default: 30) */
  stalenessThresholdDays?: number;
  /** s106-m03: page of list or review rows, 1-based, and rows per page */
  page?: number;
  pageSize?: number;
  /** Optional project root */
  projectRoot?: string;
}

// ─── Staleness Scoring ───────────────────────────────────────────────────────

const DEFAULT_STALENESS_THRESHOLD_DAYS = 30;

/**
 * Compute a staleness score (0-100) for a constraint.
 * - Expired constraints get 100
 * - Age-based scoring: linearly increases from 0 to 80 over threshold days
 * - No expiry adds 20 bonus points (incentivizes setting TTLs)
 *
 * Sprint 82 m01: age is measured from `COALESCE(last_reviewed_at, created_at)`, so a
 * reaffirmed constraint (its `last_reviewed_at` bumped to now) resets to a low score —
 * mirroring learnings staleness. A NULL last_reviewed_at falls back to created_at
 * (pre-migration behavior), so no backfill is needed. Expiry is untouched by reaffirm.
 */
function computeStalenessScore(
  constraint: {
    created_at: string;
    expires_at: string | null;
    sprint_id: string | null;
    last_reviewed_at?: string | null;
  },
  now: Date,
  thresholdDays: number
): { score: number; reason: 'expired' | 'stale_no_expiry' | 'old_sprint' } {
  // Expired constraints are maximally stale
  if (constraint.expires_at) {
    // s93-m11: read as a stored time (UTC), not by new Date(), which reads SQLite's zone-less
    // spelling as local time.
    if (storedTimeMs(constraint.expires_at) <= now.getTime()) {
      return { score: 100, reason: 'expired' };
    }
  }

  const anchorIso = constraint.last_reviewed_at ?? constraint.created_at;
  const ageDays = (now.getTime() - storedTimeMs(anchorIso)) / (1000 * 60 * 60 * 24);

  // Age-based score: 0 at 0 days, 80 at thresholdDays
  const ageScore = Math.min(80, Math.round((ageDays / thresholdDays) * 80));

  // Bonus for no expiry set
  const noExpiryBonus = constraint.expires_at ? 0 : 20;

  const score = Math.min(100, ageScore + noExpiryBonus);
  const reason = constraint.expires_at ? 'old_sprint' : 'stale_no_expiry';

  return { score, reason };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

export async function rbookConstraints(
  params: RbookConstraintsParams
): Promise<RbookToolResult<ConstraintsResult>> {
  const action = params.constraintAction;

  if (!action || !['list', 'review', 'archive', 'reaffirm'].includes(action)) {
    return createError<ConstraintsResult>({
      code: 'INVALID_ACTION',
      message: `Invalid constraint action: '${action}'`,
      suggestion: 'Use constraintAction: list | review | archive | reaffirm',
      validValues: ['list', 'review', 'archive', 'reaffirm'],
    });
  }

  const migrationWarnings: string[] = [];
  const result = await withClient(
    (client) => {
      migrationWarnings.push(...(ensureConstraintsTable(client).warnings ?? []));
      // Sprint 82 m01: ensure last_reviewed_at exists so review/reaffirm can read+bump it.
      migrationWarnings.push(...(ensureConstraintReviewTimestamp(client).warnings ?? []));
      // s84-m05: ensure the durable `evergreen` flag column exists (excluded from staleness).
      migrationWarnings.push(...(ensureConstraintEvergreen(client).warnings ?? []));

      switch (action) {
        case 'list':
          return listConstraints(client, params.constraintStatus ?? 'active', {
            page: params.page,
            pageSize: params.pageSize,
            constraintStatus: params.constraintStatus,
            stalenessThresholdDays: params.stalenessThresholdDays,
            projectRoot: params.projectRoot,
          });
        case 'review':
          return reviewConstraints(
            client,
            params.stalenessThresholdDays ?? DEFAULT_STALENESS_THRESHOLD_DAYS,
            {
              page: params.page,
              pageSize: params.pageSize,
              constraintStatus: params.constraintStatus,
              stalenessThresholdDays: params.stalenessThresholdDays,
              projectRoot: params.projectRoot,
            }
          );
        case 'archive':
          return archiveConstraints(client, params.constraintIds);
        case 'reaffirm':
          return reaffirmConstraint(client, params.constraintId, params.evergreen);
        default:
          return createError<ConstraintsResult>({
            code: 'INVALID_ACTION',
            message: `Unknown constraint action: '${action}'`,
          });
      }
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, migrationWarnings);
}

/** What a list or review page reads from the call: its page and the filters its next call repeats. */
type ConstraintsPaging = Pick<
  RbookConstraintsParams,
  'page' | 'pageSize' | 'constraintStatus' | 'stalenessThresholdDays' | 'projectRoot'
>;

/** The page fields of a list or review answer, its next call repeating the caller's filters. */
function constraintsPage(
  request: PageRequest,
  returned: number,
  totalCount: number,
  params: ConstraintsPaging,
  constraintAction: 'list' | 'review'
): Pick<
  ConstraintsResult,
  'totalCount' | 'page' | 'pageSize' | 'hasMore' | 'nextPage' | 'nextPageCall' | 'pageNote'
> {
  const facts = pageFacts(request, returned, totalCount);
  return {
    totalCount,
    page: facts.page,
    pageSize: facts.pageSize,
    hasMore: facts.hasMore,
    nextPage: facts.nextPage,
    nextPageCall: nextPageCall(facts.nextPage, 'rbook_context', {
      action: 'constraints',
      constraintAction: constraintAction === 'review' ? 'review' : undefined,
      constraintStatus: params.constraintStatus,
      stalenessThresholdDays: params.stalenessThresholdDays,
      pageSize: params.pageSize,
      projectRoot: params.projectRoot,
    }),
    pageNote: facts.nextPage === null ? null : REREAD_AFTER_ACTING,
  };
}

function listConstraints(
  client: RbookDatabaseClient,
  status: ConstraintStatus,
  params: ConstraintsPaging
): RbookToolResult<ConstraintsResult> {
  const request = pageRequest(params.page, params.pageSize, CONSTRAINTS_PAGE_SIZE);
  const result = client.getMany<{
    id: number;
    content: string;
    status: string;
    session_id: string | null;
    sprint_id: string | null;
    created_at: string;
    expires_at: string | null;
    archived_at: string | null;
    last_reviewed_at: string | null;
    evergreen: number | null;
  }>(
    `SELECT id, content, status, session_id, sprint_id, created_at, expires_at, archived_at, last_reviewed_at, evergreen
     FROM constraints WHERE status = ? ORDER BY julianday(created_at) ASC, id ASC LIMIT ? OFFSET ?`,
    [status, request.pageSize, request.offset]
  );
  const total = client.getOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM constraints WHERE status = ?',
    [status]
  );

  if (!result.success || !result.data || !total.success || !total.data) {
    return createError<ConstraintsResult>({
      code: 'DB_QUERY_FAILED',
      message: 'Failed to query constraints',
    });
  }

  const items: ConstraintRecord[] = result.data.map((row) => ({
    id: row.id,
    content: row.content,
    status: row.status as ConstraintStatus,
    sessionId: row.session_id,
    sprintId: row.sprint_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    archivedAt: row.archived_at,
    lastReviewedAt: row.last_reviewed_at,
    evergreen: !!row.evergreen,
  }));

  return createSuccess<ConstraintsResult>({
    constraintAction: 'list',
    items,
    affected: items.length,
    ...constraintsPage(request, items.length, total.data.count, params, 'list'),
    message: `Found ${total.data.count} constraint(s) with status '${status}'`,
  });
}

function reviewConstraints(
  client: RbookDatabaseClient,
  thresholdDays: number,
  params: ConstraintsPaging
): RbookToolResult<ConstraintsResult> {
  const request = pageRequest(params.page, params.pageSize, CONSTRAINT_REVIEW_PAGE_SIZE);
  // Get all active constraints. s84-m05: EXCLUDE evergreen constraints — an institutional rule
  // (e.g. the ≤4KB review digest, constraint #2) must never surface as stale. The write-path
  // migration (rbookConstraints) guarantees the column exists here, so a bare reference is safe.
  const result = client.getMany<{
    id: number;
    content: string;
    status: string;
    session_id: string | null;
    sprint_id: string | null;
    created_at: string;
    expires_at: string | null;
    archived_at: string | null;
    last_reviewed_at: string | null;
    evergreen: number | null;
  }>(
    `SELECT id, content, status, session_id, sprint_id, created_at, expires_at, archived_at, last_reviewed_at, evergreen
     FROM constraints WHERE status = 'active' AND evergreen = 0 ORDER BY julianday(created_at) ASC, id ASC`,
    []
  );

  if (!result.success || !result.data) {
    return createError<ConstraintsResult>({
      code: 'DB_QUERY_FAILED',
      message: 'Failed to query constraints for review',
    });
  }

  const now = new Date();
  const reviewItems: ConstraintReviewItem[] = [];

  for (const row of result.data) {
    const { score, reason } = computeStalenessScore(row, now, thresholdDays);

    // Only include constraints that are stale (score >= 50) or expired
    if (score >= 50) {
      reviewItems.push({
        id: row.id,
        content: row.content,
        status: row.status as ConstraintStatus,
        sessionId: row.session_id,
        sprintId: row.sprint_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        archivedAt: row.archived_at,
        lastReviewedAt: row.last_reviewed_at,
        evergreen: !!row.evergreen,
        stalenessScore: score,
        reason,
      });
    }
  }

  // Sort by staleness score descending; the sort is stable, so equal scores keep the oldest first.
  reviewItems.sort((a, b) => b.stalenessScore - a.stalenessScore);
  const pageItems = reviewItems.slice(request.offset, request.offset + request.pageSize);

  return createSuccess<ConstraintsResult>({
    constraintAction: 'review',
    reviewItems: pageItems,
    affected: pageItems.length,
    ...constraintsPage(request, pageItems.length, reviewItems.length, params, 'review'),
    message:
      reviewItems.length > 0
        ? `${reviewItems.length} constraint(s) flagged for review (threshold: ${thresholdDays} days)`
        : `No stale constraints found (threshold: ${thresholdDays} days)`,
  });
}

function archiveConstraints(
  client: RbookDatabaseClient,
  ids: number[] | undefined
): RbookToolResult<ConstraintsResult> {
  const now = new Date().toISOString();
  const writeSink = { failures: [] as WriteFailure[] };

  if (!ids || ids.length === 0) {
    // Archive all expired constraints; on a shared record, skip one whose status is in conflict (s96-m12).
    const where = `status = 'active' AND expires_at IS NOT NULL AND julianday(expires_at) <= julianday(?)`;
    const conflicted = ['status', 'archived_at'];
    const skipped = skippedConflicts(client, 'constraints', conflicted, where, [now]);
    const result = recordedExecute(
      client,
      `UPDATE constraints SET status = 'archived', archived_at = ?
       WHERE ${where}${skipConflicted(client, 'constraints', conflicted)}`,
      [now, now]
    );
    const affected = countWrite(result, writeSink, 'constraints.archive (all expired)');
    const archived = createSuccess<ConstraintsResult>({
      constraintAction: 'archive',
      affected,
      writeFailures: writeSink.failures,
      // s86-m02b — THE THIRD ARM. `affected === 0` used to render 'No expired constraints to
      // archive' whether the UPDATE ran and matched nothing or the database REJECTED it. In the
      // rejected case the statement never ran, so whether expired constraints exist is UNKNOWN —
      // and this string is what renderConstraintsBody returns as the answer's FIRST line, ahead of
      // the write-failures block. Structurally the same defect as "Extraction skipped"
      // (rbook-session-capture.ts), and the same cure: the failure gets its OWN words. Only one
      // statement runs in this arm, so a non-empty sink means exactly "the archive did not happen".
      // The words live on `message` rather than in a formatter branch because for `archive` the
      // formatter returns `d.message` verbatim — a branch there would be a second copy of this
      // sentence, and the structured `data.message` would keep asserting the false one.
      message:
        writeSink.failures.length > 0
          ? 'Archive FAILED — the database rejected the UPDATE, so nothing was archived and whether any expired constraints exist is unknown'
          : affected > 0
            ? `${affected} expired constraint(s) archived`
            : 'No expired constraints to archive',
    });
    return attachWarnings(archived, skipped ? [skipped] : []);
  }

  let affected = 0;
  for (const id of ids) {
    const result = recordedExecute(
      client,
      `UPDATE constraints SET status = 'archived', archived_at = ? WHERE id = ? AND status = 'active'`,
      [now, id]
    );
    // s86-m02b: the ids come from the TOOL CALL and were never re-selected, so `changes: 0` on a
    // statement that RAN means "no active constraint with that id" (already archived, say) —
    // legitimate, and countWrite records nothing for it. Only an errored statement is a failure.
    affected += countWrite(result, writeSink, `constraints.archive #${id}`);
  }

  return createSuccess<ConstraintsResult>({
    constraintAction: 'archive',
    affected,
    writeFailures: writeSink.failures,
    message: `${affected} constraint(s) archived`,
  });
}

/**
 * Reaffirm an active constraint by bumping last_reviewed_at to now, without changing
 * its status (Sprint 82 m01). Mirrors `rbook_learnings(action="reaffirm")`. Because
 * staleness scoring anchors on COALESCE(last_reviewed_at, created_at), a reaffirmed
 * constraint drops back below the surfacing floor until it ages out again — the review
 * clock is reset without archiving a still-valid rule.
 */
function reaffirmConstraint(
  client: RbookDatabaseClient,
  id: number | undefined,
  evergreen?: boolean
): RbookToolResult<ConstraintsResult> {
  if (id === undefined || typeof id !== 'number') {
    return createError<ConstraintsResult>(RbookErrors.missingParameter('constraintId'));
  }

  const existing = client.getOne<{ id: number; status: string }>(
    'SELECT id, status FROM constraints WHERE id = ?',
    [id]
  );
  if (!existing.success || !existing.data) {
    return createError<ConstraintsResult>({
      code: RBOOK_ERROR_CODES.MISSION_NOT_FOUND,
      message: `Constraint #${id} not found`,
      suggestion: 'Use rbook_context(action="constraints", constraintAction="list") to find IDs',
    });
  }

  const nowIso = new Date().toISOString();
  // s84-m05: when `evergreen` is supplied, set/clear the durable flag alongside the review-clock
  // bump; when omitted, this is the unchanged Sprint-82 reaffirm (last_reviewed_at only).
  const updateResult =
    evergreen === undefined
      ? recordedExecute(client, 'UPDATE constraints SET last_reviewed_at = ? WHERE id = ?', [
          nowIso,
          id,
        ])
      : recordedExecute(
          client,
          'UPDATE constraints SET last_reviewed_at = ?, evergreen = ? WHERE id = ?',
          [nowIso, evergreen ? 1 : 0, id]
        );
  if (!updateResult.success) {
    return createError<ConstraintsResult>({
      code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
      message: `Failed to reaffirm constraint: ${updateResult.error?.message ?? 'Unknown error'}`,
    });
  }

  const evergreenNote = evergreen === undefined ? '' : `, evergreen=${evergreen ? 1 : 0}`;
  return createSuccess<ConstraintsResult>({
    constraintAction: 'reaffirm',
    constraintId: id,
    reaffirmedAt: nowIso,
    affected: 1,
    message: `Constraint #${id} reaffirmed — last_reviewed_at bumped${evergreenNote} (status ${existing.data.status}, unchanged)`,
  });
}

// ─── Staleness Helpers (for onboard integration) ─────────────────────────────

/**
 * Read-only check for whether the constraints table carries a given column.
 * Used on the onboard read path so it can degrade to created_at anchoring on an
 * un-migrated store WITHOUT triggering a schema write (Sprint 82 m01).
 */
function constraintsHasColumn(client: RbookDatabaseClient, column: string): boolean {
  const cols = client.getMany<{ name: string }>(`PRAGMA table_info('constraints')`, []);
  if (!cols.success || !cols.data) return false;
  return cols.data.some((c) => c.name === column);
}

/**
 * Count stale + expired active constraints.
 * Returns 0 if the constraints table doesn't exist.
 */
export function getStaleConstraintCount(
  client: RbookDatabaseClient,
  thresholdDays: number = DEFAULT_STALENESS_THRESHOLD_DAYS
): number {
  const tableCheck = client.getOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='constraints'",
    []
  );
  if (!tableCheck.success || !tableCheck.data) return 0;

  const now = new Date();
  const thresholdDate = new Date(now.getTime() - thresholdDays * 24 * 60 * 60 * 1000).toISOString();

  // s84-m05: exclude evergreen constraints from the onboard/rbook_review staleness count so an
  // institutional rule (constraint #2) never inflates the banner. READ path — column-guarded
  // (never a schema write), mirroring the last_reviewed_at guard below.
  const hasEvergreen = constraintsHasColumn(client, 'evergreen');
  const evergreenFilter = hasEvergreen ? ' AND evergreen = 0' : '';

  // Count expired
  const expiredResult = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM constraints
     WHERE status = 'active' AND expires_at IS NOT NULL AND julianday(expires_at) <= julianday(?)${evergreenFilter}`,
    [now.toISOString()]
  );
  const expired = expiredResult.success && expiredResult.data ? expiredResult.data.count : 0;

  // Count old without expiry. Sprint 82 m01: age from COALESCE(last_reviewed_at, created_at)
  // so a reaffirmed constraint drops out of the banner until it ages out again. This is a
  // READ path (called by onboard, possibly under a read-only agent session), so it must
  // never write — the column is detected rather than lazily added (mirrors countStale's
  // `evergreen` guard in staleness-detection.ts). The write-capable rbookConstraints entry
  // owns the ensureConstraintReviewTimestamp migration.
  const hasReviewTs = constraintsHasColumn(client, 'last_reviewed_at');
  const ageAnchor = hasReviewTs ? 'COALESCE(last_reviewed_at, created_at)' : 'created_at';
  const staleResult = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM constraints
     WHERE status = 'active' AND expires_at IS NULL AND julianday(${ageAnchor}) <= julianday(?)${evergreenFilter}`,
    [thresholdDate]
  );
  const stale = staleResult.success && staleResult.data ? staleResult.data.count : 0;

  return expired + stale;
}

// ─── LLM Formatter ──────────────────────────────────────────────────────────

export function formatConstraintsForLLM(result: RbookToolResult<ConstraintsResult>): string {
  const lines = [renderConstraintsBody(result)];

  appendWriteFailures(lines, result.data?.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}

/**
 * The constraints answer itself. Split out of formatConstraintsForLLM in s86-m02: the body has one
 * return per constraintAction, so a single tail renders the envelope warnings channel once for all
 * of them rather than once per branch.
 */
function renderConstraintsBody(result: RbookToolResult<ConstraintsResult>): string {
  if (!result.success || !result.data) {
    return formatToolFailure('Failed to manage constraints', result.error);
  }

  const d = result.data;

  // s106-m03: list and review state their page and total, and name the next page.
  const paged =
    d.page !== undefined && d.pageSize !== undefined && d.totalCount !== undefined
      ? { page: d.page, pageSize: d.pageSize, totalCount: d.totalCount }
      : null;
  const next = d.nextPageCall
    ? ['', `Next page: ${d.nextPageCall}.`, ...(d.pageNote ? [d.pageNote] : [])]
    : [];

  if (d.constraintAction === 'list' && d.items) {
    if (d.items.length === 0) {
      return paged && paged.totalCount > 0
        ? `${shownLine(paged, 0, 'constraints')}.`
        : 'No active constraints found.';
    }
    const lines = [
      paged
        ? `**Constraints**: ${shownLine(paged, d.items.length, 'constraints')}`
        : `**Constraints (${d.items.length})**`,
      '',
    ];
    for (const item of d.items) {
      const expiry = item.expiresAt ? ` [expires: ${item.expiresAt.split('T')[0]}]` : '';
      const sprint = item.sprintId ? ` (${item.sprintId})` : '';
      lines.push(`  #${item.id} [${item.status}]${sprint}${expiry}: ${item.content}`);
    }
    lines.push(...next);
    return lines.join('\n');
  }

  if (d.constraintAction === 'review' && d.reviewItems) {
    if (d.reviewItems.length === 0) {
      return paged && paged.totalCount > 0
        ? `${shownLine(paged, 0, 'flagged constraints')}.`
        : 'No stale constraints found.';
    }
    const lines = [
      paged
        ? `**Constraint Review**: ${shownLine(paged, d.reviewItems.length, 'flagged constraints')}`
        : `**Constraint Review (${d.reviewItems.length} flagged)**`,
      '',
    ];
    for (const item of d.reviewItems) {
      const expiry = item.expiresAt
        ? ` [expires: ${item.expiresAt.split('T')[0]}]`
        : ' [no expiry]';
      lines.push(
        `  #${item.id} [score: ${item.stalenessScore}] (${item.reason})${expiry}: ${item.content}`
      );
    }
    lines.push('');
    lines.push(
      'Use constraintAction="archive" with constraintIds to archive stale constraints, ' +
        'or constraintAction="reaffirm" with constraintId to reset a still-valid one.'
    );
    lines.push(...next);
    return lines.join('\n');
  }

  if (d.constraintAction === 'reaffirm') {
    return [
      '✓ **Constraint Reaffirmed**',
      '',
      `**Constraint**: #${d.constraintId}`,
      `**Reaffirmed at**: ${d.reaffirmedAt}`,
      d.message,
    ].join('\n');
  }

  return d.message;
}
