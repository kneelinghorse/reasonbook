/**
 * Staleness, computed when read (s93-m11; operator Q10, decision #1182).
 *
 * Reasonbook never changes a decision's or a learning's status on its own. A record's age is computed
 * when it is read and shown beside its stored status with a suggestion to review it; it is never
 * written back as status='stale'. A status changes only through an explicit act: supersede,
 * archive, or an explicit status update, which stamps `last_reviewed_at`.
 *
 * s97-m13 (#703): the age counts sprints that closed, by close time ({@link STALENESS_COUNTING_RULE}).
 * Until then it subtracted sprint labels, and labels are names: this store ran sprint-99 before
 * sprint-96, so every row read three sprints older than the sprints that had closed.
 *
 * Until 3.3.0 the session opener ran a flagger here that wrote status='stale' on every call, on a
 * clock that counted Planned sprints (so it ran ahead while the next sprints were seeded) and under
 * the read-only review role too. {@link repairFlaggerStaleness} restores the rows that flagger
 * could have written, at a process's first write (first-write-maintenance.ts).
 *
 * @module tools/rbook/staleness-detection
 */

import { getSetting } from '../../intelligence/legacy-compat';
import type { RbookDatabaseClient } from './client';
import { sprintIdOrderSql } from './sprint-ordering';
import { SPRINT_OPEN_STATUSES, statusInSql } from './terminal-status';
import { previewText } from './text-preview';
import { checkWrite } from './write-guard';
import { isSharedStore } from './replica-identity';

/** A sprint's length on the wall clock (~14 days), used where a row carries no sprint tag. */
const MS_PER_SPRINT = 14 * 24 * 60 * 60 * 1000;

/**
 * Default review age in sprints.
 *
 * Sprint 61 m02 raised it from 10 to 20. Override at runtime with
 * `RBOOK_STALENESS_THRESHOLD_SPRINTS`. Tests import this constant rather than hard-coding 20.
 */
export const DEFAULT_STALENESS_THRESHOLD = 20;
const STALENESS_THRESHOLD_ENV = 'RBOOK_STALENESS_THRESHOLD_SPRINTS';

/**
 * The lowest threshold any shipped flagger used (10, before Sprint 61). A row in a sprint more
 * recent than the highest sprint minus this could not have been flagged by any shipped version.
 */
export const FLAGGER_MIN_THRESHOLD = 10;

/**
 * The sprints that have happened: Completed sprints and the open one, matched case-insensitively.
 * A Planned sprint has not happened yet. The review age counts only the closes among them
 * ({@link STALENESS_COUNTING_RULE}).
 */
export const SPRINT_CLOCK_STATUSES = [...SPRINT_OPEN_STATUSES, 'Completed'] as const;

/** SQL predicate over a sprints row's status: true for a sprint that has happened. */
export function sprintCountsOnClockSql(statusExpr = 'status'): string {
  return statusInSql(statusExpr, SPRINT_CLOCK_STATUSES);
}

/**
 * s97-m13 (#703, decision #1038's rule: the counting rule beside the number). Published wherever a
 * review age or a due count is shown.
 */
export const STALENESS_COUNTING_RULE =
  "review age = Completed sprints whose recorded end_date, the actual close time, is in the past and later than the close of the row's own sprint or, while that sprint is open or the row names none, than the row's created_at. Sprint labels never count, so a sprint run out of label order adds one close; a Planned sprint, a Completed sprint with no recorded end_date and a close dated in the future count as none. Due = active, at or past the review age, not reviewed within the review window, and without evidence and not a supersession target (decisions) or not evergreen (learnings)";

/** A Completed sprint whose recorded end_date, its actual close time, is in the past. */
function closedSql(alias: string): string {
  return (
    `${statusInSql(`${alias}.status`, ['Completed'])} AND ${alias}.end_date IS NOT NULL ` +
    `AND ${alias}.end_date <> '' AND julianday(${alias}.end_date) <= julianday('now')`
  );
}

/**
 * The review age of the current row of `table`, a correlated subquery: the closes after its own
 * sprint's close, or after the row was made while that sprint is open or when it names none. A
 * store whose sprints carry no end_date column records no close, so every age there reads 0
 * (every shipped schema has had the column since its first).
 */
function closesSinceSql(client: RbookDatabaseClient, table: string, hasSprintId: boolean): string {
  if (!getTableColumns(client, 'sprints').has('end_date')) return '0';
  const ownClose = hasSprintId
    ? `(SELECT o.end_date FROM sprints o WHERE o.id = ${table}.sprint_id AND ${closedSql('o')}), `
    : '';
  return (
    `(SELECT COUNT(*) FROM sprints c WHERE ${closedSql('c')} AND julianday(c.end_date) > ` +
    `julianday(COALESCE(${ownClose}${table}.created_at)))`
  );
}

/**
 * Staleness as read: stored status counts beside computed review ages. Nothing here writes.
 */
export interface StalenessRead {
  /** Decisions whose stored status is 'stale' (set explicitly, or left by an older server). */
  storedStaleDecisions: number;
  /** Learnings (not evergreen) whose stored status is 'stale'. */
  storedStaleLearnings: number;
  /** Active decisions at or past the review age, computed now. */
  dueDecisions: number;
  /** Active learnings (not evergreen) at or past the review age, computed now. */
  dueLearnings: number;
  /** The review age in sprints closed. */
  threshold: number;
  /** How the age is counted ({@link STALENESS_COUNTING_RULE}). */
  countingRule: string;
  /** Reads that failed, so a zero is never mistaken for a clean count. */
  warnings: string[];
}

/**
 * Compute staleness for the opener and the context view. Read-only: it runs no migration and
 * writes no row, under any role. Rows the review age applies to: active, at or past the review age
 * ({@link STALENESS_COUNTING_RULE}), never reviewed since the review window opened, without evidence
 * and not the target of a supersession (decisions), and not evergreen (learnings).
 */
export function readStaleness(
  client: RbookDatabaseClient,
  options?: { threshold?: number }
): StalenessRead {
  const threshold = resolveThreshold(options?.threshold);
  const warnings: string[] = [];

  const storedStaleDecisions = countRows(
    client,
    'strategic_decisions',
    "status = 'stale'",
    warnings
  );
  const learningColumns = getTableColumns(client, 'learnings');
  const notEvergreen = learningColumns.has('evergreen') ? ' AND evergreen = 0' : '';
  const storedStaleLearnings = countRows(
    client,
    'learnings',
    `status = 'stale'${notEvergreen}`,
    warnings
  );

  const due = dueForReviewPredicates(client, threshold);
  const dueDecisions = due.decisions
    ? countRows(client, 'strategic_decisions', due.decisions.sql, warnings, due.decisions.params)
    : 0;
  const dueLearnings = due.learnings
    ? countRows(client, 'learnings', due.learnings.sql, warnings, due.learnings.params)
    : 0;

  return {
    storedStaleDecisions,
    storedStaleLearnings,
    dueDecisions,
    dueLearnings,
    threshold,
    countingRule: STALENESS_COUNTING_RULE,
    warnings,
  };
}

/**
 * One line for the opener: the review suggestion, with the stored stale count when there is one.
 * Null when there is nothing to review.
 */
export function stalenessAdvisory(read: StalenessRead): string | null {
  const due = read.dueDecisions + read.dueLearnings;
  const stored = read.storedStaleDecisions + read.storedStaleLearnings;
  if (due === 0 && stored === 0) return null;
  const parts: string[] = [];
  if (due > 0) {
    parts.push(
      `${read.dueDecisions} active decision(s) and ${read.dueLearnings} learning(s) are ${read.threshold}+ sprints old with no review`
    );
  }
  if (stored > 0) {
    parts.push(
      `${read.storedStaleDecisions} decision(s) and ${read.storedStaleLearnings} learning(s) are marked stale`
    );
  }
  return (
    `${parts.join('; ')}. Nothing changes their status on its own: ` +
    'run rbook_decisions(action="review") to see each decision and learning with its age and a ' +
    'suggested action.'
  );
}

interface Predicate {
  readonly sql: string;
  readonly params: unknown[];
}

function dueForReviewPredicates(
  client: RbookDatabaseClient,
  threshold: number
): { decisions: Predicate | null; learnings: Predicate | null } {
  const reviewCutoffIso = computeReviewCutoffIso();

  const decisionColumns = getTableColumns(client, 'strategic_decisions');
  let decisions: Predicate | null = null;
  if (decisionColumns.has('status') && decisionColumns.has('created_at')) {
    const clauses = [
      "status = 'active'",
      `${closesSinceSql(client, 'strategic_decisions', decisionColumns.has('sprint_id'))} >= ?`,
    ];
    const params: unknown[] = [threshold];
    if (decisionColumns.has('last_reviewed_at')) {
      clauses.push('(last_reviewed_at IS NULL OR julianday(last_reviewed_at) < julianday(?))');
      params.push(reviewCutoffIso);
    }
    if (decisionColumns.has('superseded_by')) {
      clauses.push(
        'id NOT IN (SELECT superseded_by FROM strategic_decisions WHERE superseded_by IS NOT NULL)'
      );
    }
    if (decisionColumns.has('evidence')) {
      clauses.push("(evidence IS NULL OR evidence = '[]' OR evidence = '')");
    }
    decisions = { sql: clauses.join(' AND '), params };
  }

  const learningColumns = getTableColumns(client, 'learnings');
  let learnings: Predicate | null = null;
  if (learningColumns.has('status') && learningColumns.has('created_at')) {
    const clauses = [
      "status = 'active'",
      `${closesSinceSql(client, 'learnings', learningColumns.has('sprint_id'))} >= ?`,
    ];
    const params: unknown[] = [threshold];
    if (learningColumns.has('last_reviewed_at')) {
      clauses.push('(last_reviewed_at IS NULL OR julianday(last_reviewed_at) < julianday(?))');
      params.push(reviewCutoffIso);
    }
    if (learningColumns.has('evergreen')) clauses.push('evergreen = 0');
    learnings = { sql: clauses.join(' AND '), params };
  }

  return { decisions, learnings };
}

/**
 * Per-decision staleness detail with scoring and suggested action.
 */
export interface StaleDecisionDetail {
  /** Decision ID */
  id: number;
  /** s106-m03: a preview of at most 300 characters; rbook_decisions show reads it in full */
  text: string;
  /** Whether the preview was cut, and the full text's length */
  truncated: boolean;
  fullLength: number;
  /** Current status */
  status: string;
  /** Sprint ID the decision belongs to */
  sprintId: string | null;
  /** Sprints closed since ({@link STALENESS_COUNTING_RULE}) */
  sprintAge: number;
  /** Staleness score: 0 (fresh) to 1.0 (very stale) */
  stalenessScore: number;
  /** Category of the decision */
  category: string | null;
  /** Whether this decision has evidence references */
  hasEvidence: boolean;
  /** Whether this decision is referenced by a supersession chain */
  isReferenced: boolean;
  /** Suggested lifecycle action */
  suggestedAction: 'archive' | 'review' | 'confirm';
  /** Reason for the suggestion */
  suggestedReason: string;
}

/**
 * s93-m11 — a learning the opener's advisory counts, as the review shows it: at or past the review
 * age (computed now, as readStaleness counts it), or stored 'stale'. Evergreen learnings never are.
 */
export interface ReviewLearningDetail {
  id: number;
  /** A preview of at most 300 characters; rbook_learnings(action="show") reads it in full. */
  text: string;
  status: string;
  sprintId: string | null;
  /** Sprints closed since ({@link STALENESS_COUNTING_RULE}); null where none can be read. */
  sprintAge: number | null;
  suggestedAction: 'reaffirm' | 'review';
  suggestedReason: string;
}

/**
 * Result of a decision lifecycle review.
 */
export interface DecisionReviewResult {
  /** Decisions needing attention (stale or approaching staleness) */
  decisions: StaleDecisionDetail[];
  /**
   * s93-m11 — learnings at or past the review age or stored 'stale', so every record the opener's
   * advisory counts has a surface that shows its age.
   */
  learnings: ReviewLearningDetail[];
  /** Total active decisions */
  totalActive: number;
  /** Total stale decisions */
  totalStale: number;
  /** The open sprint's number, else the number of the sprint that closed last (display only). */
  currentSprintNumber: number | null;
  /** Staleness threshold in sprints */
  threshold: number;
}

/**
 * Get detailed staleness review for all decisions needing attention.
 * Returns per-decision scoring and suggested actions. Read-only.
 */
export function reviewDecisionStaleness(
  client: RbookDatabaseClient,
  options?: { threshold?: number; includeApproaching?: boolean }
): DecisionReviewResult {
  const threshold = resolveThreshold(options?.threshold);
  const includeApproaching = options?.includeApproaching ?? true;
  const currentSprintNumber = getCurrentSprintNumber(client);

  const totalActive = countByStatus(client, 'strategic_decisions', 'active');
  const totalStale = countByStatus(client, 'strategic_decisions', 'stale');
  const learnings = reviewLearnings(client, threshold);

  // Get referenced decision IDs (supersession targets)
  const referencedIds = getReferencedDecisionIds(client);

  // Load candidates: stale + active decisions. s91-m08: untagged rows are candidates too — they
  // used to be filtered out by `sprint_id IS NOT NULL` and could never be flagged, however old.
  // s97-m13: every row ages on one clock, the closes since its sprint's close or its making; an
  // untagged row no longer ages on a 14-day wall clock, nor a row of a non-canonical sprint not at all.
  const statusFilter = includeApproaching ? `status IN ('stale', 'active')` : `status = 'stale'`;

  const result = client.getMany<{
    id: number;
    decision_text: string;
    status: string;
    sprint_id: string | null;
    category: string | null;
    evidence: string | null;
    closes: number;
  }>(
    `SELECT id, decision_text, status, sprint_id, category, evidence,
            ${closesSinceSql(client, 'strategic_decisions', true)} AS closes
     FROM strategic_decisions
     WHERE ${statusFilter}
     ORDER BY sprint_id IS NULL, ${sprintIdOrderSql('sprint_id', 'ASC')}, id ASC`,
    []
  );

  if (!result.success || !result.data) {
    return { decisions: [], learnings, totalActive, totalStale, currentSprintNumber, threshold };
  }

  const decisions: StaleDecisionDetail[] = [];

  for (const row of result.data) {
    const sprintAge = row.closes;
    if (sprintAge < 1) continue; // No sprint has closed since: nothing to review yet

    // Only include decisions beyond half the threshold (approaching) or already stale
    if (includeApproaching && sprintAge < Math.floor(threshold / 2) && row.status !== 'stale') {
      continue;
    }

    const stalenessScore = Math.min(sprintAge / threshold, 1.0);
    const hasEvidence = !!(row.evidence && row.evidence !== '[]' && row.evidence !== '');
    const isReferenced = referencedIds.has(row.id);

    // Determine suggested action
    let suggestedAction: StaleDecisionDetail['suggestedAction'];
    let suggestedReason: string;

    if (hasEvidence || isReferenced) {
      suggestedAction = 'confirm';
      suggestedReason = hasEvidence
        ? 'Has evidence references — confirm still relevant or archive'
        : 'Referenced by supersession chain — confirm still relevant';
    } else if (stalenessScore >= 0.8) {
      suggestedAction = 'archive';
      suggestedReason = `${sprintAge} sprints old — likely no longer actionable`;
    } else {
      suggestedAction = 'review';
      suggestedReason = `${sprintAge} sprints old — approaching staleness threshold (${threshold})`;
    }

    const { preview, truncated, fullLength } = previewText(row.decision_text);
    decisions.push({
      id: row.id,
      text: preview,
      truncated,
      fullLength,
      status: row.status,
      sprintId: row.sprint_id,
      sprintAge,
      stalenessScore: Math.round(stalenessScore * 100) / 100,
      category: row.category,
      hasEvidence,
      isReferenced,
      suggestedAction,
      suggestedReason,
    });
  }

  // Sort by staleness score descending (most stale first)
  decisions.sort((a, b) => b.stalenessScore - a.stalenessScore);

  return { decisions, learnings, totalActive, totalStale, currentSprintNumber, threshold };
}

/**
 * s93-m11 — the learnings readStaleness counts: stored 'stale', or at or past the review age by the
 * same predicate, never evergreen. Oldest sprint first. Read-only.
 */
function reviewLearnings(client: RbookDatabaseClient, threshold: number): ReviewLearningDetail[] {
  const columns = getTableColumns(client, 'learnings');
  if (!columns.has('status') || !columns.has('sprint_id') || !columns.has('created_at')) return [];
  const notEvergreen = columns.has('evergreen') ? ' AND evergreen = 0' : '';
  const clauses = [`(status = 'stale'${notEvergreen})`];
  const params: unknown[] = [];
  const due = dueForReviewPredicates(client, threshold).learnings;
  if (due) {
    clauses.push(`(${due.sql})`);
    params.push(...due.params);
  }
  const rows = client.getMany<{
    id: number;
    content: string;
    status: string;
    sprint_id: string | null;
    closes: number | null;
  }>(
    `SELECT id, content, status, sprint_id, ${closesSinceSql(client, 'learnings', true)} AS closes
       FROM learnings
      WHERE ${clauses.join(' OR ')}
      ORDER BY ${sprintIdOrderSql('sprint_id', 'ASC')}, id ASC`,
    params
  );
  if (!rows.success || !rows.data) return [];

  return rows.data.map((row) => {
    const sprintAge = row.closes;
    const stale = row.status === 'stale';
    return {
      id: row.id,
      text: previewText(row.content).preview,
      status: row.status,
      sprintId: row.sprint_id,
      sprintAge,
      suggestedAction: stale ? 'review' : 'reaffirm',
      suggestedReason: stale
        ? 'Marked stale: set it active again or archive it'
        : `${sprintAge ?? threshold}+ sprints old with no review: reaffirm it if it still holds`,
    } satisfies ReviewLearningDetail;
  });
}

// ─── The repair ────────────────────────────────────────────────────────────────────────────────

/** The metadata key holding the repair's ledger. */
export const STALENESS_REPAIR_LEDGER_KEY = 'staleness_repair';
/** At most this many ids per table are kept in the ledger; the counts stay whole. */
export const STALENESS_REPAIR_ID_CAP = 500;

export type StaleRowTable = 'decisions' | 'learnings';

/** Why a stale row was left alone: it does not have the shape the flagger wrote. */
export type LeftReason =
  | 'reviewed'
  | 'has evidence'
  | 'supersession target'
  | 'evergreen'
  | 'not a canonical sprint'
  | 'sprint too recent for any flagger';

export interface LeftRow {
  readonly table: StaleRowTable;
  readonly id: number;
  readonly reason: LeftReason;
}

/**
 * What the repair cannot tell apart, written into every ledger (design fork 3: "the receipt says
 * so"). Each case is a 'stale' an older Reasonbook server wrote, either on purpose or on its own, that
 * the repair reads the other way.
 */
export const STALENESS_REPAIR_CANNOT_SEE =
  "An explicit 'stale' that a server before 3.3.0 wrote on a row that is otherwise flagger-shaped " +
  'and unreviewed is restored (those servers did not stamp the review). A row an older server ' +
  'flagged after its review aged out of the 280-day window, or under a RBOOK_STALENESS_THRESHOLD_SPRINTS ' +
  'below 10, is left and listed with the reason that kept it.';

/** The ledger kept in metadata (JSON). Counts are whole; id lists are capped. */
export interface StalenessRepairLedger {
  readonly version: 1;
  /** When the last run that changed something ran (ISO 8601). */
  readonly lastRunAt: string;
  /** When the last run that restored at least one row ran (ISO 8601); what the review reports. */
  readonly lastRestoredAt?: string;
  /** Runs that restored at least one row. */
  readonly runs: number;
  /** Every row any run restored, by table (distinct ids, capped). */
  readonly restored: { readonly decisions: number[]; readonly learnings: number[] };
  /** Rows the last restoring run restored, by table. */
  readonly lastRestoredCount: { readonly decisions: number; readonly learnings: number };
  /** Rows restored over every run, counting a row once per restore. */
  readonly totalRestored: number;
  /** Rows restored again after an earlier run had restored them: an older server re-flagged them. */
  readonly reflaggedRestored: number;
  /** Stale rows the repair leaves, itemized (capped), and how many there are in all. */
  readonly left: LeftRow[];
  readonly leftCount: number;
  /** What the repair cannot tell apart ({@link STALENESS_REPAIR_CANNOT_SEE}). */
  readonly cannotSee: string;
}

export interface StalenessRepairReceipt {
  readonly restoredDecisionIds: number[];
  readonly restoredLearningIds: number[];
  /** Restored rows that a previous run had already restored. */
  readonly reflagged: number;
  readonly left: LeftRow[];
  /** Whether the ledger was written by this run. */
  readonly ledgerWritten: boolean;
  readonly warnings: string[];
}

interface StaleCandidate {
  readonly id: number;
  readonly sprint_id: string | null;
  readonly evidence?: string | null;
  readonly last_reviewed_at?: string | null;
  readonly evergreen?: number | null;
  readonly is_target?: number;
}

/**
 * Restore the rows an automatic flagger could have set to 'stale', and nothing else (s93-m11
 * fork 3; decision #1191). A row is restored to 'active' only when it is ALL of:
 *  - stored as 'stale';
 *  - flagger-shaped: in a canonical `sprint-N` with N at most the highest sprint of any status minus
 *    {@link FLAGGER_MIN_THRESHOLD} (the lowest threshold ever shipped, on the old clock that counted
 *    Planned sprints); with no evidence and not the target of a supersession (decisions); not
 *    evergreen (learnings);
 *  - unreviewed: `last_reviewed_at` is NULL. An explicit status update stamps it, so a row someone
 *    set to 'stale' on purpose with this version is never restored.
 * Restored rows get no review stamp, so their computed age stays honest.
 *
 * WHAT IT CANNOT SEE is written into every ledger ({@link STALENESS_REPAIR_CANNOT_SEE}).
 *
 * Runs in one IMMEDIATE transaction. Writes the ledger only when it restored a row or the set of
 * rows it leaves changed, so a store with nothing to repair, and no ledger to bring current, is
 * not written at all.
 */
export function repairFlaggerStaleness(
  client: RbookDatabaseClient,
  nowIso: string = new Date().toISOString()
): StalenessRepairReceipt {
  const warnings: string[] = [];
  const empty: StalenessRepairReceipt = {
    restoredDecisionIds: [],
    restoredLearningIds: [],
    reflagged: 0,
    left: [],
    ledgerWritten: false,
    warnings,
  };

  // s96-m03 (ADR s96 §6): a shared record skips the restore; its status changes are recorded.
  if (isSharedStore(client)) return empty;
  const decisionColumns = getTableColumns(client, 'strategic_decisions');
  const learningColumns = getTableColumns(client, 'learnings');
  if (!decisionColumns.has('status') && !learningColumns.has('status')) return empty;

  // Fast path, outside any transaction: most stores hold no stale row at all.
  const anyStale = client.getOne<{ n: number }>(
    `SELECT ${decisionColumns.has('status') ? "(SELECT COUNT(*) FROM strategic_decisions WHERE status = 'stale')" : '0'}
          + ${learningColumns.has('status') ? "(SELECT COUNT(*) FROM learnings WHERE status = 'stale')" : '0'} AS n`,
    []
  );
  if (!anyStale.success) {
    warnings.push(`Staleness repair skipped: ${anyStale.error?.message ?? 'the count failed'}`);
    return empty;
  }
  if ((anyStale.data?.n ?? 0) === 0) {
    // Nothing stale. A ledger that still lists rows it left (since restored or archived by hand)
    // is brought current, so it never names a row that is no longer stale.
    const previous = readStalenessRepairLedger(client);
    if (previous && previous.leftCount > 0) {
      const current: StalenessRepairLedger = {
        ...previous,
        lastRunAt: nowIso,
        left: [],
        leftCount: 0,
        cannotSee: STALENESS_REPAIR_CANNOT_SEE,
      };
      const ledgerWritten = writeStalenessRepairLedger(client, current, warnings);
      return { ...empty, ledgerWritten, warnings };
    }
    return empty;
  }

  const highest = getHighestSprintNumberAnyStatus(client);
  const bound = highest === null ? null : highest - FLAGGER_MIN_THRESHOLD;

  // IMMEDIATE: the candidates are re-read under the write lock, so a concurrent writer cannot
  // change a row between its selection and its restore.
  const begin = client.execute('BEGIN IMMEDIATE', []);
  if (!begin.success) {
    warnings.push(`Staleness repair skipped: ${begin.error?.message ?? 'BEGIN failed'}`);
    return empty;
  }
  const rollback = (why: string): StalenessRepairReceipt => {
    client.execute('ROLLBACK', []);
    warnings.push(`Staleness repair rolled back: ${why}`);
    return { ...empty, warnings };
  };

  try {
    const previous = readStalenessRepairLedger(client);
    const decisionCandidates = decisionColumns.has('status')
      ? staleCandidates(client, 'strategic_decisions', decisionColumns)
      : [];
    const learningCandidates = learningColumns.has('status')
      ? staleCandidates(client, 'learnings', learningColumns)
      : [];

    const left: LeftRow[] = [];
    const restoreDecisions: number[] = [];
    const restoreLearnings: number[] = [];
    for (const row of decisionCandidates) {
      const reason = leftReason(row, bound, 'decisions');
      if (reason) left.push({ table: 'decisions', id: row.id, reason });
      else restoreDecisions.push(row.id);
    }
    for (const row of learningCandidates) {
      const reason = leftReason(row, bound, 'learnings');
      if (reason) left.push({ table: 'learnings', id: row.id, reason });
      else restoreLearnings.push(row.id);
    }

    const writeFailures: string[] = [];
    const restoredDecisionIds = restoreRows(
      client,
      'strategic_decisions',
      restoreDecisions,
      writeFailures
    );
    const restoredLearningIds = restoreRows(client, 'learnings', restoreLearnings, writeFailures);
    if (writeFailures.length > 0) return rollback(writeFailures.join('; '));

    const before = new Set([
      ...(previous?.restored.decisions ?? []).map((id) => `d${id}`),
      ...(previous?.restored.learnings ?? []).map((id) => `l${id}`),
    ]);
    const reflagged =
      restoredDecisionIds.filter((id) => before.has(`d${id}`)).length +
      restoredLearningIds.filter((id) => before.has(`l${id}`)).length;
    const union = (prior: readonly number[] = [], now: readonly number[]): number[] =>
      [...new Set([...prior, ...now])].sort((a, b) => a - b).slice(0, STALENESS_REPAIR_ID_CAP);

    const restoredAny = restoredDecisionIds.length + restoredLearningIds.length > 0;
    const leftChanged =
      JSON.stringify(previous?.left ?? []) !==
        JSON.stringify(left.slice(0, STALENESS_REPAIR_ID_CAP)) ||
      (previous?.leftCount ?? 0) !== left.length;
    let ledgerWritten = false;
    const lastRestoredAt = restoredAny ? nowIso : previous?.lastRestoredAt;
    if (restoredAny || leftChanged) {
      const ledger: StalenessRepairLedger = {
        version: 1,
        lastRunAt: nowIso,
        ...(lastRestoredAt ? { lastRestoredAt } : {}),
        runs: (previous?.runs ?? 0) + (restoredAny ? 1 : 0),
        restored: {
          decisions: union(previous?.restored.decisions, restoredDecisionIds),
          learnings: union(previous?.restored.learnings, restoredLearningIds),
        },
        lastRestoredCount: restoredAny
          ? { decisions: restoredDecisionIds.length, learnings: restoredLearningIds.length }
          : (previous?.lastRestoredCount ?? { decisions: 0, learnings: 0 }),
        totalRestored:
          (previous?.totalRestored ?? 0) + restoredDecisionIds.length + restoredLearningIds.length,
        reflaggedRestored: (previous?.reflaggedRestored ?? 0) + reflagged,
        left: left.slice(0, STALENESS_REPAIR_ID_CAP),
        leftCount: left.length,
        cannotSee: STALENESS_REPAIR_CANNOT_SEE,
      };
      const ledgerFailures: string[] = [];
      ledgerWritten = writeStalenessRepairLedger(client, ledger, ledgerFailures);
      // A restore without its ledger could not be reported as re-flagged later: all or nothing.
      if (!ledgerWritten) return rollback(ledgerFailures.join('; '));
    }

    const commit = client.execute('COMMIT', []);
    if (!commit.success) return rollback(commit.error?.message ?? 'COMMIT failed');

    return {
      restoredDecisionIds,
      restoredLearningIds,
      reflagged,
      left,
      ledgerWritten,
      warnings,
    };
  } catch (error) {
    return rollback(error instanceof Error ? error.message : String(error));
  }
}

function staleCandidates(
  client: RbookDatabaseClient,
  table: 'strategic_decisions' | 'learnings',
  columns: Set<string>
): StaleCandidate[] {
  const select = ['id', columns.has('sprint_id') ? 'sprint_id' : 'NULL AS sprint_id'];
  if (columns.has('last_reviewed_at')) select.push('last_reviewed_at');
  if (table === 'strategic_decisions') {
    if (columns.has('evidence')) select.push('evidence');
    select.push(
      columns.has('superseded_by')
        ? '(id IN (SELECT superseded_by FROM strategic_decisions WHERE superseded_by IS NOT NULL)) AS is_target'
        : '0 AS is_target'
    );
  } else if (columns.has('evergreen')) {
    select.push('evergreen');
  }
  const rows = client.getMany<StaleCandidate>(
    `SELECT ${select.join(', ')} FROM ${table} WHERE status = 'stale' ORDER BY id`,
    []
  );
  if (!rows.success) {
    throw new Error(`reading stale ${table} failed: ${rows.error?.message ?? 'unknown'}`);
  }
  return rows.data ?? [];
}

function leftReason(
  row: StaleCandidate,
  bound: number | null,
  table: StaleRowTable
): LeftReason | null {
  if (row.last_reviewed_at != null && row.last_reviewed_at !== '') return 'reviewed';
  const sprintNumber = row.sprint_id ? extractSprintNumber(row.sprint_id) : null;
  if (sprintNumber === null) return 'not a canonical sprint';
  if (bound === null || sprintNumber > bound) return 'sprint too recent for any flagger';
  if (table === 'decisions') {
    if (row.evidence && row.evidence !== '[]' && row.evidence !== '') return 'has evidence';
    if (row.is_target) return 'supersession target';
  } else if (row.evergreen) {
    return 'evergreen';
  }
  return null;
}

function restoreRows(
  client: RbookDatabaseClient,
  table: 'strategic_decisions' | 'learnings',
  ids: number[],
  failures: string[]
): number[] {
  const restored: number[] = [];
  // Literal statements, one per table, so the status-write and enum sweeps can read them.
  const sql =
    table === 'strategic_decisions'
      ? "UPDATE strategic_decisions SET status = 'active' WHERE id = ? AND status = 'stale'"
      : "UPDATE learnings SET status = 'active' WHERE id = ? AND status = 'stale'";
  for (const id of ids) {
    const result = client.execute(sql, [id]);
    if (checkWrite(result, failures, `${table}.status restore (id ${id})`) && result.data) {
      if (result.data.changes === 1) restored.push(id);
    }
  }
  return restored;
}

/** Write the repair's ledger; a failure is recorded in `sink`. */
function writeStalenessRepairLedger(
  client: RbookDatabaseClient,
  ledger: StalenessRepairLedger,
  sink: string[]
): boolean {
  return checkWrite(
    client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
      STALENESS_REPAIR_LEDGER_KEY,
      JSON.stringify(ledger),
    ]),
    sink,
    `metadata.${STALENESS_REPAIR_LEDGER_KEY}`
  );
}

/** The repair's ledger, or null when none was written (or it does not parse). */
export function readStalenessRepairLedger(
  client: RbookDatabaseClient
): StalenessRepairLedger | null {
  const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    STALENESS_REPAIR_LEDGER_KEY,
  ]);
  if (!row.success || !row.data?.value) return null;
  try {
    const parsed = JSON.parse(row.data.value) as StalenessRepairLedger;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * For the opener, read-only: how many rows a repair restored are marked stale again with no review
 * stamp. Only an older Reasonbook server writes an unstamped 'stale' (3.3.0 stamps every explicit status
 * update), so a non-zero count means one is still running.
 */
export function countReflaggedSinceRepair(
  client: RbookDatabaseClient
): { count: number; lastRestoredAt: string } | null {
  const ledger = readStalenessRepairLedger(client);
  if (!ledger?.restored) return null;
  const count =
    countIdsStaleUnreviewed(client, 'strategic_decisions', ledger.restored.decisions) +
    countIdsStaleUnreviewed(client, 'learnings', ledger.restored.learnings);
  // A run that only updated the left-alone list moves lastRunAt, not when anything was restored.
  return { count, lastRestoredAt: ledger.lastRestoredAt ?? ledger.lastRunAt };
}

function countIdsStaleUnreviewed(
  client: RbookDatabaseClient,
  table: 'strategic_decisions' | 'learnings',
  ids: readonly number[]
): number {
  if (ids.length === 0) return 0;
  const unreviewed = getTableColumns(client, table).has('last_reviewed_at')
    ? ' AND last_reviewed_at IS NULL'
    : '';
  const result = client.getOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table} WHERE status = 'stale'${unreviewed} AND id IN (${ids.map(() => '?').join(', ')})`,
    [...ids]
  );
  return result.success ? (result.data?.n ?? 0) : 0;
}

// ─── The current sprint, for display ───────────────────────────────────────────────────────────

/**
 * The sprint the review stands in, for display only (s97-m13): the open sprint with the highest
 * number, else the sprint that closed last by close time. Ages never read it: they count closes
 * ({@link STALENESS_COUNTING_RULE}). A Planned sprint never counts; ids that are not `sprint-N` are
 * skipped.
 */
export function getCurrentSprintNumber(client: RbookDatabaseClient): number | null {
  const open = client.getMany<{ id: string }>(
    `SELECT id FROM sprints WHERE ${statusInSql('status', SPRINT_OPEN_STATUSES)}
     ORDER BY ${sprintIdOrderSql('id', 'DESC')}`,
    []
  );
  const closed = getTableColumns(client, 'sprints').has('end_date')
    ? client.getMany<{ id: string }>(
        `SELECT id FROM sprints s WHERE ${closedSql('s')} ORDER BY julianday(s.end_date) DESC, s.rowid DESC`,
        []
      )
    : null;
  for (const result of [open, closed]) {
    if (!result) continue;
    if (!result.success || !result.data) continue;
    for (const row of result.data) {
      const num = extractSprintNumber(row.id);
      if (num !== null) return num;
    }
  }
  return null;
}

/** The highest canonical sprint number of any status: the bound older flaggers worked under. */
function getHighestSprintNumberAnyStatus(client: RbookDatabaseClient): number | null {
  const result = client.getMany<{ id: string }>(
    `SELECT id FROM sprints ORDER BY ${sprintIdOrderSql('id', 'DESC')}`,
    []
  );
  if (!result.success || !result.data) return null;
  for (const row of result.data) {
    const num = extractSprintNumber(row.id);
    if (num !== null) return num;
  }
  return null;
}

/**
 * Extract the numeric suffix from a sprint ID like "sprint-26" → 26.
 */
function extractSprintNumber(sprintId: string): number | null {
  const match = sprintId.match(/^sprint-(\d+)$/);
  if (!match) return null;
  const num = Number.parseInt(match[1], 10);
  return Number.isFinite(num) ? num : null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────────────────────

/**
 * Get IDs of decisions that are referenced by supersession chains.
 */
function getReferencedDecisionIds(client: RbookDatabaseClient): Set<number> {
  const result = client.getMany<{ superseded_by: number }>(
    `SELECT DISTINCT superseded_by FROM strategic_decisions WHERE superseded_by IS NOT NULL`,
    []
  );
  if (!result.success || !result.data) return new Set();
  return new Set(result.data.map((r) => r.superseded_by));
}

function countByStatus(client: RbookDatabaseClient, tableName: string, status: string): number {
  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${tableName} WHERE status = ?`,
    [status]
  );
  return result.success ? (result.data?.count ?? 0) : 0;
}

function countRows(
  client: RbookDatabaseClient,
  tableName: string,
  where: string,
  warnings: string[],
  params: unknown[] = []
): number {
  const columns = getTableColumns(client, tableName);
  if (!columns.has('status')) return 0;
  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM ${tableName} WHERE ${where}`,
    params
  );
  if (!result.success) {
    warnings.push(
      `Staleness count on ${tableName} failed: ${result.error?.message ?? 'unknown'}; the count shown is not complete.`
    );
    return 0;
  }
  return result.data?.count ?? 0;
}

function resolveThreshold(explicit?: number): number {
  if (explicit !== undefined && explicit > 0) {
    return explicit;
  }

  const envValue = getSetting(STALENESS_THRESHOLD_ENV);
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return DEFAULT_STALENESS_THRESHOLD;
}

/**
 * The review window: a row reviewed more recently than threshold × 14 days ago is not due, however
 * old its sprint.
 */
function computeReviewCutoffIso(): string {
  return new Date(Date.now() - DEFAULT_STALENESS_THRESHOLD * MS_PER_SPRINT).toISOString();
}

function getTableColumns(client: RbookDatabaseClient, tableName: string): Set<string> {
  const result = client.getMany<{ name: string }>(`PRAGMA table_info('${tableName}')`, []);
  if (!result.success || !result.data) return new Set();
  return new Set(result.data.map((row) => row.name));
}
