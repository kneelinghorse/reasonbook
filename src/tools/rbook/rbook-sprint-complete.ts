// ABOUTME: Closes a sprint atomically and returns its readiness, lifecycle and audit receipt.
// ABOUTME: Keeps concurrent session visibility and producing-build evidence at the close boundary.
/**
 * rbook_sprint_complete Tool
 *
 * MCP tool for closing out a sprint in one operation. It validates readiness,
 * snapshots both contexts, bounds next-step prose by count, optionally
 * runs condensation, and returns a closeout receipt with size telemetry.
 *
 * @module tools/rbook/rbook-sprint-complete
 */

import { prepareSpinOutRead, spinOutHistoryLines } from './spin-out-read';
import { normalizeMissionStatus } from './terminal-status';
import * as crypto from 'crypto';
import { z } from 'zod';
import { withClientAsync, type RbookDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import type { RbookToolResult, Context, Sprint } from './types';
import { createError, createSuccess, RbookErrors, RBOOK_ERROR_CODES } from './errors';
import {
  calculateContextSizeMetrics,
  resolveContextSizeSettings,
  type ContextSizeMetrics,
} from './context-retention';
import { rbookContextCondense } from './rbook-context-condense';
import { rbookDbSnapshot } from './rbook-db-snapshot';
import { buildUntaggedSessionAdvisory } from './untagged-advisory';
import { getProjectType } from './rbook-agent-onboard';
import {
  ensureArchivalColumns,
  ensureLearningsTable,
  ensureAuthorNamespaceColumns,
  ensureFirehoseEventColumns,
} from './schema-migrations';
import {
  checkBuildFreshness,
  isBlockingStaleness,
  projectChecksBuildFreshness,
  type BuildFreshnessReport,
} from './build-freshness';
import { readProjectIdentity } from './project-identity';
import { getServerHealth, getServerProjectRoot } from '../../server-health';
import { resolveProjectRootEnhanced } from '../../intelligence/project-resolution';
import * as path from 'path';
import { appendWarnings, appendWriteFailures, attachWarnings } from './format-warnings';
import { skipConflicted, skippedConflicts } from './record-conflict-skip';
import { isParkedMissionStatus } from './terminal-status';
import { countWrite, type WriteFailure } from './write-guard';
import { applySprintTracking, openSprintPointer, type SprintPointer } from './sprint-tracking';
import {
  CLOSES_SURVIVED_SQL,
  LEASED_STATUS_SQL,
  LEASE_AGE_DAYS_SQL,
  LEASE_COUNTING_RULE,
  LEASE_IDLE_WARN_DAYS,
  LEASE_LAPSE_AT,
  LEASE_MIN_AGE_DAYS,
  LEASE_WARN_AT,
  leaseState,
  reopenCommand,
} from './next-step-lease';
import { repairCompletedSprintEndDates, type SprintEndDateRepair } from './sprint-end-date-repair';
import { nextStepRowLookup, summarizeSessionCaptures } from './session-capture-state';
import { findReusableSnapshot, snapshotStorage } from './snapshot-content-policy';
import { storedTimeMs } from './stored-time';
import { recordedExecute } from './record-changes';
import { ARCHIVE_WHERE } from './sprint-archive-scope';

type CloseoutContextType = 'master_context' | 'project_context';
type CloseoutCondensationStrategy = 'none' | 'conservative' | 'auto' | 'aggressive';

interface SprintMissionRow {
  id: string;
  status: string;
  notes: string | null;
}

interface SprintMissionKpiRow {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

interface ActiveSessionAtCloseRow {
  id: string;
  title: string;
  captures: string | null;
}

/** An active session observed at the instant close began. */
export interface ActiveSessionAtClose {
  id: string;
  title: string;
  captureCount: number | null;
  deferredCaptureCount: number | null;
}

/**
 * Sprint summary KPIs computed during closeout.
 */
export interface SprintKPIs {
  completionRate: number;
  avgCycleTimeDays: number | null;
  decisionCount: number;
  learningCount: number;
  blockedCount: number;
}

/**
 * Lifecycle trigger results from sprint completion.
 */
export interface SprintLifecycleTriggers {
  /**
   * s92-m05 (operator Q1, decision #1160) — whether this close archived anything. Since 3.2.0 a
   * close leaves the sprint's decisions and learnings ACTIVE unless it was called with
   * `archive: true`; the counts and id arrays below are then 0 and [] (kept, so a receipt audit
   * that checks `Array.isArray` on both arrays still holds).
   */
  archived: boolean;
  decisionsArchived: number;
  learningsArchived: number;

  /**
   * s87-m02 — the ids of the decisions this close archived, enumerated.
   *
   * The counts above come from the driver's `changes`. They say HOW MANY rows moved and never
   * WHICH, so a close that demoted something it should not have left nothing to look up. This is
   * not hypothetical: sprint-86's close reported `Archived: 37 decisions` and one of the 37 was
   * the ratification of the arc the next sprint executes.
   *
   * `archivedDecisionIds.length === decisionsArchived` is asserted per table at write time; a
   * mismatch pushes a named warning rather than being reconciled silently. The ids come from a
   * pre-SELECT under the IDENTICAL predicate inside the same transaction — never from
   * `RETURNING id`, which this codebase's client silently discards (`.run()` reports
   * `{changes, lastInsertRowid}` and drops the rows, with no throw).
   */
  archivedDecisionIds: number[];

  /**
   * The ids of the learnings this close archived.
   *
   * NAMED ASYMMETRICALLY on purpose: the sprint-87 contract, the CHANGELOG bullet and s87-m08's
   * criteria all say `learningIds`, and renaming it here for symmetry with
   * `archivedDecisionIds` would leave three documents naming a field that does not exist. The
   * asymmetry is recorded rather than silently corrected.
   */
  learningIds: number[];

  kpis: SprintKPIs;

  /**
   * s87-m02 — THE UNDO HANDLE. A full database snapshot taken immediately BEFORE the closeout's
   * `BEGIN IMMEDIATE`, so every row this close archives reads `active` inside it.
   *
   * Distinct from {@link dbSnapshotId}, which is taken after the COMMIT and therefore captures
   * the post-archival state — it is a backup, not a pre-image. Both are kept: the pre-close one
   * makes the close reversible, the post-close one is the ordinary safety copy.
   *
   * `null` when the snapshot failed; the close still proceeds (it is non-critical, matching the
   * post-close snapshot's own error handling) and the failure is surfaced as a warning, because
   * refusing to close a sprint over a backup hiccup would be a worse trade than closing without
   * one and saying so.
   */
  preCloseSnapshotId: string | null;

  dbSnapshotId: string | null;
}

interface LoadedCloseoutContext {
  contextType: CloseoutContextType;
  rawContent: string;
  parsedContent: Record<string, unknown>;
  beforeSize: ContextSizeMetrics;
}

/**
 * Sprint readiness summary used in the closeout receipt.
 */
export interface SprintCloseoutReadiness {
  /** s86-m08: EXCLUDES parked (Deferred/Dropped) work — the denominator completionRate uses. */
  totalMissions: number;
  completedMissions: number;
  blockedMissions: number;
  skippedMissions: number;
  openMissions: number;
  /** s86-m08: Deferred + Dropped. Outside totalMissions, reported so it is not hidden. */
  parkedMissions: number;
  completedMissionIds: string[];
  blockedMissionIds: string[];
  skippedMissionIds: string[];
  openMissionIds: string[];
}

/**
 * Per-context closeout details.
 */
export interface SprintCloseoutContextResult {
  snapshotId: number | null;
  beforeSize: ContextSizeMetrics;
  afterSize: ContextSizeMetrics;
  /** Oldest entries trimmed to enforce the close-time 15/10 count limits. */
  nextStepsCleared: number;
  condensation?: {
    strategy: Exclude<CloseoutCondensationStrategy, 'none'>;
    snapshotId: number | null;
    reductionPercent: number;
    targetMet: boolean;
    message: string;
  };
}

/** A pending next-step as observed by the closeout survey. Provenance is not delivery. */
export interface SprintPendingNextStep {
  id: number;
  content: string;
  sprintId: string | null;
  missionId: string | null;
  /** s91-m06: `pending` or `carried` — the survey covers every open row. */
  status: 'pending' | 'carried';
  /** s91-m06: closes survived going INTO this close (next-step-lease.ts counting rule). */
  closesSurvived: number;
  /** s92-m02: days since the row's lease anchor (last carry, else creation); null if unparseable. */
  ageDays: number | null;
}

/** s91-m06 — the lease as this close applied it, published with its thresholds and rule. */
export interface SprintNextStepLease {
  warnAt: number;
  lapseAt: number;
  countingRule: string;
  /** Open rows at the warning age: the next close warns again, the one after drops. */
  warned: number[];
  /** Open rows at or past the lapse age: this close drops them (see lapsedDroppedIds). */
  lapsed: number[];
  /** s92-m02 (operator Q4): no row is dropped before it is this many days past its lease anchor. */
  minAgeDays: number;
  /** s92-m02: rows at or past the lapse age that the minimum-age floor kept — not dropped. */
  heldByMinAge: number[];
  /** s92-m02: rows that survived no close are flagged idle after this many days (never dropped). */
  idleWarnDays: number;
  /** s92-m02: rows that have survived no close for idleWarnDays days or more. */
  idle: number[];
}

export interface SprintPendingNextStepGroups {
  closingSprintWithMissionProvenance: SprintPendingNextStep[];
  closingSprintWithoutMissionProvenance: SprintPendingNextStep[];
  otherSprintProvenance: SprintPendingNextStep[];
  noSprintProvenance: SprintPendingNextStep[];
}

/** Whole-ledger pending-work survey. Null totals/groups distinguish a failed read from zero rows. */
export interface SprintPendingNextStepsSurvey {
  available: boolean;
  /** Pending rows only — unchanged in name and meaning. */
  totalPending: number | null;
  /** s91-m06: pending plus carried. */
  totalOpen: number | null;
  groups: SprintPendingNextStepGroups | null;
  /** s91-m06: null when the survey is unavailable. */
  lease: SprintNextStepLease | null;
}

/**
 * Result returned by rbook_sprint_complete.
 */
export interface RbookSprintCompleteResult {
  sprintId: string;
  previousStatus: string | null;
  currentStatus: 'Completed';
  summary: string;
  completedAt: string;
  /** Active sessions whose own sessions.sprint_id named this sprint when close began. */
  activeSessionsAtClose: ActiveSessionAtClose[];
  /** All active implicit sessions in this project at the same locked close boundary. */
  implicitSessionsAtClose: ActiveSessionAtClose[];
  /** Build timestamp captured by this producing server process, or null without a manifest. */
  startupBuildTime: string | null;
  /** Producer build drift in whole minutes; zero when current, null without both manifests. */
  driftMinutes: number | null;
  readiness: SprintCloseoutReadiness;
  contexts: {
    masterContext: SprintCloseoutContextResult;
    projectContext: SprintCloseoutContextResult;
    totalBeforeSizeKb: number;
    totalAfterSizeKb: number;
  };
  lifecycle: SprintLifecycleTriggers;
  /** Every open next-step in the ledger, grouped by provenance for explicit disposition. */
  nextStepsSurvey: SprintPendingNextStepsSurvey;
  /**
   * s91-m06 — ids this close set `dropped` because their lease lapsed, inside the close
   * transaction. Undo with the reopen command the rendered receipt prints beside them.
   */
  lapsedDroppedIds: number[];
  /**
   * s92-m02 — the sprint's end_date BEFORE this close, when one was planned. The close now writes
   * the actual close time into end_date (it used to keep a planned date, which the next-step
   * lease then counted as a close every later carry had survived). Null when none was set.
   */
  plannedEndDate: string | null;
  /**
   * s92-m02 — present ONLY on the close that ran the one-time end_date repair: the Completed
   * sprints re-dated from a planned date to their recorded close, and every Completed sprint left
   * as found because nothing on disk records when it closed.
   */
  endDateRepair?: SprintEndDateRepair;
  /** Build-freshness report, included ONLY when stale=true (omitted on the happy path
   *  to keep the response shape unchanged for fresh-build sprints). */
  buildFreshness?: BuildFreshnessReport;
  /** s86-m02b — writes the closeout ATTEMPTED and the database REJECTED. Always present. */
  writeFailures: WriteFailure[];
  message: string;
}

/**
 * s84-m04 — context_snapshots growth thresholds for the non-blocking sprint-close advisory.
 * Either the count of snapshots still holding content OR their content bytes crossing its
 * threshold fires the advisory. s92-m09: it counts only rows that hold content, so a prune clears
 * it, and it names the shipped `rbook_db(action="prune_snapshots")` dry run. Advisory-only — never
 * gates the close.
 */
const SNAPSHOT_GROWTH_ROW_THRESHOLD = 500;
const SNAPSHOT_GROWTH_BYTE_THRESHOLD = 20 * 1024 * 1024; // 20 MB

/**
 * Input parameters schema for rbook_sprint_complete.
 */
export const rbookSprintCompleteSchema = z.object({
  sprintId: z.string().min(1).describe('The sprint ID to close out (e.g., "sprint-22")'),
  summary: z
    .string()
    .min(1)
    .max(2000)
    .describe('Short closeout summary describing what the sprint delivered'),
  condensation: z
    .enum(['none', 'conservative', 'auto', 'aggressive'])
    .default('none')
    .optional()
    .describe(
      'Optional context condensation strategy to run after snapshots and next-step cleanup'
    ),
  targetSizePercent: z
    .number()
    .min(1)
    .max(100)
    .default(60)
    .optional()
    .describe('Target percentage of the context size limit when condensation is requested'),
  forceComplete: z
    .boolean()
    .optional()
    .describe(
      'No-op, kept for backward compatibility. Build-freshness is advisory as of the s74 review — staleness is surfaced as a warning and never blocks closeout, so no override is needed.'
    ),
  archive: z
    .boolean()
    .optional()
    .describe(
      "Also archive this sprint's active decisions and learnings (evergreen learnings kept), naming every archived id. Off by default since 3.2.0."
    ),
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookSprintCompleteParams = z.infer<typeof rbookSprintCompleteSchema>;

/**
 * MCP Tool Definition for rbook_sprint_complete.
 */
export const rbookSprintCompleteToolDefinition = {
  name: 'rbook_sprint_complete',
  // s87-m02 — THIS DEFINITION IS NOT REGISTERED, and the edit below is a consistency fix, not the
  // client-visible one. `rbook_sprint_complete` is not among the 15 definitions the server
  // publishes, and the definitions snapshot contains zero occurrences of that name — so no MCP
  // host receives this string and it pins nothing. The surface an operator actually reads is
  // `rbookSprintToolDefinition.description` in rbook-sprint.ts, which is where the archival
  // disclosure had to land. Kept in sync anyway so the two do not drift, and labelled so the next
  // reader does not mistake editing it for having fixed the published contract.
  description:
    'Close out a sprint in one operation. Validates sprint readiness, marks the sprint Completed with the actual ' +
    "close time as endDate, applies the next-step lease, leaves the sprint's decisions and learnings ACTIVE unless " +
    'archive is true (then archives them and names every archived id), takes a pre-close database snapshot as an ' +
    'undo handle, snapshots both contexts, retains bounded next-step prose by count, and optionally runs context ' +
    'condensation.',
  inputSchema: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        description: 'The sprint ID to close out (e.g., "sprint-22")',
      },
      summary: {
        type: 'string',
        description: 'Short closeout summary describing what the sprint delivered',
        minLength: 1,
        maxLength: 2000,
      },
      condensation: {
        type: 'string',
        enum: ['none', 'conservative', 'auto', 'aggressive'],
        default: 'none',
        description:
          'Optional context condensation strategy to run after snapshots and next-step cleanup',
      },
      targetSizePercent: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 60,
        description: 'Target percentage of the context size limit when condensation is requested',
      },
      forceComplete: {
        type: 'boolean',
        description:
          'No-op, kept for backward compatibility. Build-freshness is advisory — staleness is surfaced as a warning and never blocks closeout.',
      },
      archive: {
        type: 'boolean',
        description:
          "Also archive this sprint's active decisions and learnings, naming every archived id. Off by default since 3.2.0.",
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['sprintId', 'summary'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_sprint_complete tool.
 */
export async function rbookSprintComplete(
  params: RbookSprintCompleteParams
): Promise<RbookToolResult<RbookSprintCompleteResult>> {
  if (!params.sprintId || params.sprintId.trim() === '') {
    return createError(RbookErrors.missingParameter('sprintId'));
  }

  if (!params.summary || params.summary.trim() === '') {
    return createError(RbookErrors.missingParameter('summary'));
  }

  const sprintId = params.sprintId.trim();
  const summary = params.summary.trim();
  const condensation = params.condensation ?? 'none';
  const targetSizePercent = params.targetSizePercent ?? 60;

  const warnings: string[] = [];
  const result = await withClientAsync(
    async (client) => {
      // Build-freshness is ADVISORY, not blocking (post-s74 review). It used to be
      // an ENFORCED gate here (s70-m02) that blocked closeout with BUILD_STALE
      // unless forceComplete. Two problems retired it: (1) the signals (src-mtime
      // vs build, server-hash drift) are noisy heuristics that over-fire on git
      // ops and non-runtime edits; (2) the server-stale signal is cross-project
      // LEAKY — getServerHealth() tracks THIS server's own build (cmos-mcp-pro),
      // so a rebuild here flipped every sibling project's close to "stale" and
      // forced forceComplete. Staleness is now surfaced as a warning after the
      // work completes (see the advisory block near the end), never as a block.

      // s69-m03 — sprint closeout wraps its work in a manual BEGIN IMMEDIATE
      // transaction below, and later snapshots genesis rows (genesisColumns). The
      // firehose 12-step migration toggles foreign_keys (a no-op inside a
      // transaction), so it MUST run here, before BEGIN, not lazily mid-closeout.
      // Idempotent + marker-gated: a fast no-op on already-migrated stores.
      // s86-m02b (fork f23) — a migration that half-applies is the purest form of this
      // sprint's defect class. This was one of the original six warning splices; s88-m09's
      // semantic census now guards every reachable migration caller.
      warnings.push(...(ensureFirehoseEventColumns(client).warnings ?? []));
      // s69-m04 — settle the author_* namespace before BEGIN too. Its ALTERs are
      // transaction-safe (no 12-step rebuild), but ensuring it pre-BEGIN keeps the
      // rename out of the closeout transaction and mirrors the firehose pattern.
      warnings.push(...(ensureAuthorNamespaceColumns(client).warnings ?? []));

      // --- s87-m02: THE PRE-CLOSE SNAPSHOT. The undo handle for the store's most destructive
      // write, and the reason this close is reversible at all.
      //
      // POSITION IS FORCED, NOT TASTE. It must be here — after the two pre-BEGIN `ensure*` calls
      // and BEFORE `BEGIN IMMEDIATE` — for two independent reasons:
      //   (1) BEFORE the archival, or it is not a pre-image. The existing snapshot below is taken
      //       134 lines and one COMMIT later; it captures the post-archival state. When decision
      //       #1009 had to be recovered from sprint-86's close, what saved it was an UNRELATED
      //       snapshot that happened to land 108 seconds early.
      //   (2) OUTSIDE the transaction. `rbookDbSnapshot` opens a SECOND connection to the same
      //       file. Firing that against a held RESERVED lock is the one genuine hazard on this
      //       path, so it must not sit anywhere between BEGIN IMMEDIATE and COMMIT.
      //
      // NON-CRITICAL, in the same shape as the post-close snapshot below: a backup failure warns
      // and the close proceeds. Refusing to close a sprint because a copy failed would be a worse
      // trade than closing without one and saying so — and the warning says so.
      //
      // GATED ON THE SPRINT EXISTING, and that gate is not an optimisation. The sprint's existence
      // is validated INSIDE the transaction, after this point, so without the gate a typo'd
      // sprintId would copy the whole store (514–928 ms on this 64 MB one) and consume a retention
      // slot — pruning the operator's OLDEST real snapshot — before returning SPRINT_NOT_FOUND. A
      // call that fails should not destroy a backup. The check only skips wasted work: the
      // authoritative refusal still comes from the in-transaction validation below, unchanged.
      let preCloseSnapshotId: string | null = null;
      const sprintExists = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
        sprintId,
      ]);
      const worthSnapshotting = sprintExists.success && sprintExists.data !== undefined;
      try {
        const preSnapshot = worthSnapshotting
          ? await rbookDbSnapshot({ projectRoot: params.projectRoot })
          : null;
        if (!worthSnapshotting) {
          // No warning: the close is about to refuse anyway, and warning about a backup we
          // deliberately skipped for a call that cannot succeed would be noise.
        } else if (preSnapshot?.success && preSnapshot.data?.createdSnapshot) {
          preCloseSnapshotId = preSnapshot.data.createdSnapshot.id;
        } else {
          warnings.push(
            'Pre-close database snapshot failed — this close is NOT reversible from a snapshot. ' +
              'The close still runs; what it changes (lease drops, and archival when archive: true) is enumerated in the result.'
          );
        }
      } catch {
        warnings.push(
          'Pre-close database snapshot failed — this close is NOT reversible from a snapshot. ' +
            'The close still runs; what it changes (lease drops, and archival when archive: true) is enumerated in the result.'
        );
      }

      const spinOutRead = prepareSpinOutRead(client);
      const beginResult = client.execute('BEGIN IMMEDIATE', []);

      if (!beginResult.success) {
        return createError<RbookSprintCompleteResult>(
          beginResult.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to begin sprint closeout for '${sprintId}'`,
            suggestion: 'Retry once the database becomes available.',
          }
        );
      }

      let transactionOpen = true;
      const rollback = (): void => {
        if (!transactionOpen) {
          return;
        }
        client.execute('ROLLBACK', []);
        transactionOpen = false;
      };
      const fail = (error: Parameters<typeof createError<RbookSprintCompleteResult>>[0]) => {
        rollback();
        return createError<RbookSprintCompleteResult>(error);
      };

      const sprintResult = client.getOne<Sprint>(
        'SELECT id, title, focus, status, start_date, end_date, total_missions, completed_missions FROM sprints WHERE id = ?',
        [sprintId]
      );
      if (!sprintResult.success) {
        return fail(
          sprintResult.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to query sprint '${sprintId}'`,
            suggestion: 'Check database connectivity and schema.',
          }
        );
      }
      if (!sprintResult.data) {
        return fail(RbookErrors.sprintNotFound(sprintId));
      }

      const sprint = sprintResult.data;
      if (sprint.status === 'Completed') {
        return fail({
          code: RBOOK_ERROR_CODES.SPRINT_ALREADY_COMPLETED,
          message: `Sprint '${sprintId}' is already Completed`,
          currentState: sprint.status,
          suggestion:
            'Use rbook_sprint with action="show" to review the closed sprint. No further closeout is needed.',
        });
      }

      // Capture the exact direct-membership set before any closeout writes begin. Do not infer
      // membership through session_missions: an unscoped session that happened to touch one
      // sprint mission is not a session the sprint owns. This read stays inside the same
      // BEGIN IMMEDIATE transaction as the close so the receipt describes one stable boundary.
      // s92-m03: implicit sessions never appear here. They carry no sprint_id by construction
      // (a process outlives sprints), so `sprint_id = ?` already excludes them.
      const activeSessionsResult = client.getMany<ActiveSessionAtCloseRow>(
        `SELECT id, title, captures
         FROM sessions
         WHERE sprint_id = ? AND status = 'active'
         ORDER BY julianday(started_at) ASC, id ASC`,
        [sprintId]
      );
      if (!activeSessionsResult.success) {
        return fail({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message:
            `Failed to query active sessions for sprint '${sprintId}': ` +
            `${activeSessionsResult.error?.message ?? 'unknown database error'}`,
          suggestion: 'Check database connectivity and the sessions schema before retrying.',
        });
      }

      // Implicit sessions span sprints. Report them separately without assigning membership or
      // ending another process's work. A legacy schema lacks this column; a failed read is not
      // evidence of its absence and must refuse the close.
      const sessionColumns = client.getMany<{ name: string }>('PRAGMA table_info(sessions)');
      if (!sessionColumns.success) {
        return fail({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to inspect the sessions schema: ${sessionColumns.error?.message ?? 'unknown database error'}`,
          suggestion: 'Check database connectivity and the sessions schema before retrying.',
        });
      }
      const implicitSessionsResult = sessionColumns.data?.some(
        (column) => column.name === 'implicit'
      )
        ? client.getMany<ActiveSessionAtCloseRow>(
            `SELECT id, title, captures FROM sessions
             WHERE implicit = 1 AND status = 'active'
             ORDER BY julianday(started_at) ASC, id ASC`
          )
        : createSuccess<ActiveSessionAtCloseRow[]>([]);
      if (!implicitSessionsResult.success) {
        return fail({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to query active implicit sessions: ${implicitSessionsResult.error?.message ?? 'unknown database error'}`,
          suggestion: 'Check database connectivity and the sessions schema before retrying.',
        });
      }

      const summarizeActiveSession = (session: ActiveSessionAtCloseRow): ActiveSessionAtClose => {
        // s100-m03: a next step captured since 4.2.1 already has its row, so it is not deferred.
        const summary = summarizeSessionCaptures(
          session.captures,
          nextStepRowLookup(client, session.id)
        );
        if (summary.malformed) {
          warnings.push(
            `Active session '${session.id}' has malformed or non-array captures JSON; ` +
              'captureCount and deferredCaptureCount are unknown.'
          );
        }
        return {
          id: session.id,
          title: session.title,
          captureCount: summary.captureCount,
          deferredCaptureCount: summary.deferredCaptureCount,
        };
      };
      const activeSessionsAtClose = (activeSessionsResult.data ?? []).map(summarizeActiveSession);
      const implicitSessionsAtClose = (implicitSessionsResult.data ?? []).map(
        summarizeActiveSession
      );

      const missionsResult = client.getMany<SprintMissionRow>(
        'SELECT id, status, notes FROM missions WHERE sprint_id = ? ORDER BY id ASC',
        [sprintId]
      );
      if (!missionsResult.success) {
        return fail(
          missionsResult.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to query missions for sprint '${sprintId}'`,
            suggestion: 'Check database connectivity and schema.',
          }
        );
      }

      warnings.push(
        ...spinOutHistoryLines(
          spinOutRead,
          (missionsResult.data ?? []).map((mission) => mission.id)
        )
      );
      const readiness = summarizeSprintReadiness(missionsResult.data ?? []);
      if (readiness.openMissionIds.length > 0) {
        return fail({
          code: RBOOK_ERROR_CODES.SPRINT_NOT_READY,
          message: `Sprint '${sprintId}' still has non-terminal missions: ${readiness.openMissionIds.join(', ')}`,
          currentState: sprint.status ?? undefined,
          suggestion:
            'Complete, block, drop, or defer the remaining Queued/Current/In Progress missions before closing the sprint.',
        });
      }
      if (readiness.blockedMissionIds.length > 0) {
        warnings.push(
          `Sprint '${sprintId}' closed with blocked missions: ${readiness.blockedMissionIds.join(', ')}.`
        );
      }
      if (readiness.skippedMissionIds.length > 0) {
        warnings.push(
          `Sprint '${sprintId}' includes skipped missions recorded in notes: ${readiness.skippedMissionIds.join(', ')}.`
        );
      }

      const masterContext = loadCloseoutContext(client, 'master_context');
      if (!masterContext.success || !masterContext.data) {
        return fail(
          masterContext.error ?? {
            code: RBOOK_ERROR_CODES.CONTEXT_NOT_FOUND,
            message: 'master_context is required for sprint closeout',
            suggestion: 'Repair or recreate master_context before retrying sprint closeout.',
          }
        );
      }

      const projectContext = loadCloseoutContext(client, 'project_context');
      if (!projectContext.success || !projectContext.data) {
        return fail(
          projectContext.error ?? {
            code: RBOOK_ERROR_CODES.CONTEXT_NOT_FOUND,
            message: 'project_context is required for sprint closeout',
            suggestion: 'Repair or recreate project_context before retrying sprint closeout.',
          }
        );
      }

      const completedAt = new Date().toISOString();
      const snapshotSource = `sprint_complete:${sprintId}`;
      const masterSnapshotId = createSnapshot(
        client,
        'master_context',
        masterContext.data.rawContent,
        snapshotSource
      );
      if (!masterSnapshotId.success) {
        return fail({
          code: RBOOK_ERROR_CODES.SNAPSHOT_CREATION_FAILED,
          message: `Failed to snapshot master_context for sprint '${sprintId}'`,
          suggestion: 'Check context_snapshots table integrity and retry closeout.',
        });
      }

      const projectSnapshotId = createSnapshot(
        client,
        'project_context',
        projectContext.data.rawContent,
        snapshotSource
      );
      if (!projectSnapshotId.success) {
        return fail({
          code: RBOOK_ERROR_CODES.SNAPSHOT_CREATION_FAILED,
          message: `Failed to snapshot project_context for sprint '${sprintId}'`,
          suggestion: 'Check context_snapshots table integrity and retry closeout.',
        });
      }

      // Keep only the newest bounded prose entries. Text is never inspected: a mission/sprint id
      // occurring in a next step records provenance, not evidence that the work was delivered.
      const masterCleared = trimCloseoutNextStepProse(
        masterContext.data.parsedContent,
        'master_context'
      );
      const projectCleared = trimCloseoutNextStepProse(
        projectContext.data.parsedContent,
        'project_context'
      );

      // s92-m02 — the one-time end_date repair runs INSIDE this transaction and BEFORE the
      // survey: the lease ages below then count real closes, and a close that refuses or rolls
      // back also rolls back the repair and its marker, so the next close retries it.
      const endDateRepair = repairCompletedSprintEndDates(client, completedAt);
      if (endDateRepair && endDateRepair.failures.length > 0) {
        warnings.push(
          `end_date repair incomplete (it will be retried at the next close): ${endDateRepair.failures.join('; ')}`
        );
      }

      // Survey the WHOLE open ledger. Sprint close cannot prove delivery, so it never writes
      // `completed`; s91-m06 narrows the s90-m05 rule to one write — `dropped` for rows whose
      // lease lapsed — and names every id it drops.
      const nextStepsSurvey = surveyPendingNextSteps(client, sprintId, warnings);
      const leaseSink = { failures: [] as WriteFailure[] };
      const lapsedDroppedIds = dropLapsedNextSteps(
        client,
        nextStepsSurvey.lease?.lapsed ?? [],
        completedAt,
        leaseSink
      );

      // --- Lifecycle Trigger: Archive sprint-scoped decisions/learnings ---
      // s87-m02: the function now carries its own warnings (the per-table `ids.length === changes`
      // invariant and each arm's failure), spliced here in the same shape as the two pre-BEGIN
      // `ensure*` calls above. It has no `warnings` array in scope of its own — it is a
      // module-level function taking `(client, sprintId)`.
      // s92-m05 (operator Q1, decision #1160): "data is being lost and teams are working around
      // it" — 78% of fleet decisions were archived, mostly here. The close no longer archives by
      // default; `archive: true` runs exactly the s87-m02 archival and its itemized receipt.
      const archiveRequested = params.archive === true;
      const archiveResult: ArchiveOutcome = archiveRequested
        ? archiveSprintDecisionsAndLearnings(client, sprintId)
        : {
            decisions: { ok: true, count: 0, ids: [] },
            learnings: { ok: true, count: 0, ids: [] },
            warnings: [],
          };
      warnings.push(...archiveResult.warnings);

      // --- Lifecycle Trigger: Compute sprint KPIs ---
      const kpis = computeSprintKPIs(client, sprintId, readiness);

      // --- Lifecycle Trigger: Update project_context working_memory & current_sprint ---
      clearProjectContextWorkingMemory(projectContext.data.parsedContent, sprintId);

      // s91-m07: sprint_tracking rides in the master_context persist below, inside this
      // transaction, so a rolled-back close leaves the pointers exactly as they were.
      applySprintTracking(
        masterContext.data.parsedContent as Record<string, unknown>,
        nextOpenSprint(client, sprintId),
        sprintId
      );

      const masterPersist = persistCloseoutContext(client, masterContext.data, completedAt);
      if (!masterPersist.success || !masterPersist.data) {
        return fail(
          masterPersist.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: 'Failed to persist master_context sprint cleanup',
            suggestion: 'Check database permissions and retry closeout.',
          }
        );
      }

      const projectPersist = persistCloseoutContext(client, projectContext.data, completedAt);
      if (!projectPersist.success || !projectPersist.data) {
        return fail(
          projectPersist.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: 'Failed to persist project_context sprint cleanup',
            suggestion: 'Check database permissions and retry closeout.',
          }
        );
      }

      const sprintUpdateResult = completeSprintRecord(client, sprintId, completedAt);
      if (!sprintUpdateResult.success) {
        return fail(
          sprintUpdateResult.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to update sprint '${sprintId}'`,
            suggestion: 'Check database permissions and retry closeout.',
          }
        );
      }

      const commitResult = client.execute('COMMIT', []);
      if (!commitResult.success) {
        rollback();
        return createError<RbookSprintCompleteResult>(
          commitResult.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to commit sprint closeout for '${sprintId}'`,
            suggestion: 'Retry once the database can commit the closeout transaction.',
          }
        );
      }
      transactionOpen = false;

      const eventResult = client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'sprint_complete', 'Completed', ?, ?)`,
        [
          completedAt,
          sprintId,
          summary,
          JSON.stringify({
            tool: 'rbook_sprint_complete',
            sprintId,
            previousStatus: sprint.status,
            summary,
            condensation,
            targetSizePercent,
          }),
        ]
      );
      if (!eventResult.success) {
        // s86-m02b: this warned but dropped the error text entirely, so an operator learned that
        // logging failed and nothing about why. Name the DB error, as context-freshness.ts does.
        warnings.push(
          `Sprint closeout event logging failed: ${eventResult.error?.code ?? 'DB_ERROR'} — ` +
            `${eventResult.error?.message ?? 'unknown'}`
        );
      }

      // s84-m04 (FORK-3=b): NON-BLOCKING context_snapshots growth advisory. Computed here,
      // AFTER the closeout COMMIT (transactionOpen=false) — NEVER inside the BEGIN IMMEDIATE
      // and NEVER an auto-prune (the firehose migration is txn-order-sensitive; a prune is a
      // deliberate operator action). A hiccup here never affects the committed close.
      //
      // s86-m05 (fork f05, resolved (b)): this advisory NAMES NO COMMAND. It used to say "Run
      // 'npm run prune:snapshots' (dry-run) to preview…", which is unreachable for every
      // consumer of the published package: package.json `files` ships dist, rbook-seed, the
      // licences and four docs — `scripts/` is in none of them, and `bin` is only reasonbook.
      // So the advisory described a retention DECISION instead, which is true for everyone.
      //
      // s92-m09: f05's reason was that the command could not be run. rbook_db(action=
      // "prune_snapshots") ships in the package and is a dry run unless confirm=true, so the
      // advisory now names it. The advisory counts only snapshots that still hold content: the
      // prune keeps every row, so a row count never fell and the advisory never cleared.
      //
      // THE ALTERNATIVES WERE CONSIDERED AND REJECTED; do not re-open them:
      //  (a) add a bin/ entry so the command becomes real — rejected. It would drag scripts/
      //      (or a compiled equivalent) plus a ts-node runtime into installable surface, for a
      //      chore almost no consumer will ever run.
      //  (c) drop the advisory entirely — rejected. The growth signal is genuinely useful; it
      //      is the prescription that was wrong, not the observation.
      //
      // TWO STAGE1 CLAIMS ABOUT THIS SITE WERE REFUTED at plan time and are recorded so a later
      // sprint does not act on them: the advisory is NOT emitted inside the closeout transaction
      // (it runs after the COMMIT, as the comment above says), and it does NOT auto-prune or
      // otherwise mutate context_snapshots — it only counts rows and bytes.
      try {
        const growth = client.getOne<{ rows: number; bytes: number }>(
          `SELECT COUNT(*) AS rows, COALESCE(SUM(LENGTH(content)), 0) AS bytes
             FROM context_snapshots WHERE LENGTH(content) > 0`,
          []
        );
        if (
          growth.success &&
          growth.data &&
          (growth.data.rows > SNAPSHOT_GROWTH_ROW_THRESHOLD ||
            growth.data.bytes > SNAPSHOT_GROWTH_BYTE_THRESHOLD)
        ) {
          warnings.push(
            `context_snapshots has grown to ${growth.data.rows} snapshots holding ` +
              `${(growth.data.bytes / (1024 * 1024)).toFixed(1)} MB of content. Most are copies ` +
              `Reasonbook wrote on its own, and no read path returns them. rbook_db(action=` +
              `"prune_snapshots") shows what emptying those copies would reclaim without ` +
              `changing anything; confirm=true applies it after a database snapshot, and every ` +
              `row, id and reference is kept. A sprint close never prunes on its own.`
          );
        }
      } catch {
        // Advisory only — never let a growth-check hiccup affect the already-committed close.
      }

      // --- Lifecycle Trigger: Auto-snapshot the full database (non-critical) ---
      let dbSnapshotId: string | null = null;
      try {
        const snapshotResult = await rbookDbSnapshot({ projectRoot: params.projectRoot });
        if (snapshotResult.success && snapshotResult.data?.createdSnapshot) {
          dbSnapshotId = snapshotResult.data.createdSnapshot.id;

          // s87-m02 — THE CLOSE MUST NOT SILENTLY DELETE ITS OWN UNDO HANDLE.
          // Snapshot retention is count-capped (RBOOK_MAX_SNAPSHOTS, default 50) and prunes oldest
          // first. This close now takes TWO snapshots, so at a low cap this second one can prune
          // the pre-close one created minutes earlier — the same close destroying the pre-image
          // that makes it reversible. Found by m02's own build-time adversarial critic; it is
          // reachable by configuration, not hypothetical.
          // DISCLOSED, NOT OVERRIDDEN: raising the cap behind the operator's back would be this
          // tool deciding it knows better than a setting they chose. Saying what happened is the
          // honest half, and it names the setting so the remedy is obvious.
          if (
            preCloseSnapshotId &&
            (snapshotResult.data.prunedSnapshotIds ?? []).includes(preCloseSnapshotId)
          ) {
            warnings.push(
              `The pre-close snapshot '${preCloseSnapshotId}' was pruned by snapshot retention ` +
                `during this close (RBOOK_MAX_SNAPSHOTS=${snapshotResult.data.maxSnapshots}), so ` +
                `THIS CLOSE IS NO LONGER REVERSIBLE FROM A SNAPSHOT. The archived ids are still ` +
                `enumerated in the result. Raise RBOOK_MAX_SNAPSHOTS to keep the undo handle.`
            );
          }
        } else {
          warnings.push('Auto database snapshot after sprint completion failed.');
        }
      } catch {
        warnings.push('Auto database snapshot after sprint completion failed.');
      }

      // One health read supplies the whole producer receipt. Keep this independent of the
      // managed project's type/root: these fields describe the process producing the answer,
      // while the stale-code WARNING below remains scoped to that process's own project.
      const serverHealth = getServerHealth();
      const startupBuildTime = serverHealth.startupBuild?.buildTime ?? null;
      let driftMinutes: number | null = null;
      if (serverHealth.startupBuild && serverHealth.currentBuild) {
        if (serverHealth.codeIsCurrent) {
          driftMinutes = 0;
        } else {
          const startupTimeMs = Date.parse(serverHealth.startupBuild.buildTime);
          const currentTimeMs = Date.parse(serverHealth.currentBuild.buildTime);
          if (!Number.isNaN(startupTimeMs) && !Number.isNaN(currentTimeMs)) {
            driftMinutes = Math.round((currentTimeMs - startupTimeMs) / 60000);
          }
        }
      }

      // s87-m02 (FORK-4b) — EACH TABLE REPORTS ITS OWN OUTCOME. This line used to read
      // `archiveResult.success ? archiveResult.decisionsArchived : 0` for BOTH counts, so a
      // failure on the learnings arm reported `Archived: 0 decisions` about decisions that had
      // been archived and COMMITTED. A count that a different table's failure can zero is not a
      // report of what happened.
      const lifecycle: SprintLifecycleTriggers = {
        archived: archiveRequested,
        decisionsArchived: archiveResult.decisions.count,
        learningsArchived: archiveResult.learnings.count,
        archivedDecisionIds: archiveResult.decisions.ids,
        learningIds: archiveResult.learnings.ids,
        kpis,
        preCloseSnapshotId,
        dbSnapshotId,
      };

      const result: RbookSprintCompleteResult = {
        sprintId,
        previousStatus: sprint.status,
        currentStatus: 'Completed',
        summary,
        completedAt,
        activeSessionsAtClose,
        implicitSessionsAtClose,
        startupBuildTime,
        driftMinutes,
        readiness,
        contexts: {
          masterContext: {
            snapshotId: masterSnapshotId.snapshotId ?? null,
            beforeSize: masterContext.data.beforeSize,
            afterSize: masterPersist.data.afterSize,
            nextStepsCleared: masterCleared,
          },
          projectContext: {
            snapshotId: projectSnapshotId.snapshotId ?? null,
            beforeSize: projectContext.data.beforeSize,
            afterSize: projectPersist.data.afterSize,
            nextStepsCleared: projectCleared,
          },
          totalBeforeSizeKb: roundNumber(
            masterContext.data.beforeSize.sizeKb + projectContext.data.beforeSize.sizeKb
          ),
          totalAfterSizeKb: roundNumber(
            masterPersist.data.afterSize.sizeKb + projectPersist.data.afterSize.sizeKb
          ),
        },
        lifecycle,
        nextStepsSurvey,
        lapsedDroppedIds,
        plannedEndDate: sprint.end_date ?? null,
        ...(endDateRepair ? { endDateRepair } : {}),
        writeFailures: leaseSink.failures,
        message: buildCloseoutMessage(sprintId, condensation, readiness),
      };

      if (condensation !== 'none') {
        await applyOptionalCondensation({
          projectRoot: params.projectRoot,
          strategy: condensation,
          targetSizePercent,
          warnings,
          contexts: result.contexts,
        });
      }

      result.contexts.totalAfterSizeKb = roundNumber(
        result.contexts.masterContext.afterSize.sizeKb +
          result.contexts.projectContext.afterSize.sizeKb
      );

      // Build-freshness advisory (Sprint 67 m03; demoted to non-blocking post-s74).
      // Never blocks — surfaces staleness as a warning + an attached report so the
      // happy-path shape is unchanged when fresh. Two signals:
      //   (A) source newer than the MANAGED project's own build — attach the
      //       report and warn.
      //   (B) the running server is on stale code — SCOPED to this server's OWN
      //       project, because getServerHealth() tracks cmos-mcp-pro's build, not
      //       the caller's; surfacing it to a sibling blames them for our rebuild.
      // s84-m05: build-freshness is a build-tier concern — skip it entirely for a general/
      // managed project (no `dist/` to keep fresh). Gate on getProjectType (local store defaults
      // 'build', so it keeps the signal). Both signals (A source-newer, B server-stale) are gated.
      if (
        getProjectType(client) === 'build' &&
        projectChecksBuildFreshness(readProjectIdentity(client))
      ) {
        try {
          const freshnessRoot = await resolveFreshnessProjectRoot(params.projectRoot);
          if (freshnessRoot) {
            const freshness = await checkBuildFreshness(freshnessRoot);
            if (freshness.stale) {
              result.buildFreshness = freshness;
              if (isBlockingStaleness(freshness)) {
                warnings.push(buildStaleAdvisory(freshness));
              }
            }
            const serverRoot = getServerProjectRoot();
            if (serverRoot && path.resolve(serverRoot) === path.resolve(freshnessRoot)) {
              if (
                serverHealth.startupBuild != null &&
                serverHealth.currentBuild != null &&
                serverHealth.codeIsCurrent === false
              ) {
                warnings.push(
                  `Server is running stale code. ` +
                    `Build at startup: ${serverHealth.startupBuild.buildHash.slice(0, 12)}… ` +
                    `(${serverHealth.startupBuild.buildTime}). ` +
                    `Current build: ${serverHealth.currentBuild.buildHash.slice(0, 12)}… ` +
                    `(${serverHealth.currentBuild.buildTime}). ` +
                    `Drift: ${driftMinutes === null ? 'unknown' : `${driftMinutes} minute(s)`}. ` +
                    'Start a new host session or reconnect to use the current build.'
                );
              }
            }
          }
        } catch {
          // Advisory only — never block sprint close on a probe failure.
        }
      }

      // s85-m03: the close summary's decisionCount / learningCount count strictly by sprint
      // scope (sprint_id, or a mission/session belonging to the sprint), so work done in a
      // session that carries no sprint tag is omitted entirely. Unconditional and NOT
      // build-tier gated — a general/managed project is exactly where untagged sessions are
      // the norm, so suppressing it there would hide the signal from the projects that need
      // it most.
      const untaggedSessionAdvisory = buildUntaggedSessionAdvisory(client);
      if (untaggedSessionAdvisory) {
        warnings.push(untaggedSessionAdvisory);
      }

      return createSuccess(result, warnings);
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

/**
 * Resolve the project root for the build-freshness check. Honors an explicit
 * projectRoot when provided; otherwise falls back to the registry/auto-discovery
 * chain. Returns null when nothing resolves — the caller skips the check.
 */
async function resolveFreshnessProjectRoot(explicitRoot?: string): Promise<string | null> {
  if (explicitRoot) return explicitRoot;
  try {
    const resolution = await resolveProjectRootEnhanced(undefined, {
      autoRegister: false,
      silent: true,
    });
    return resolution.projectRoot;
  } catch {
    return null;
  }
}

/**
 * Build the advisory warning for a stale managed-project build (Signal A). This
 * NEVER blocks closeout (post-s74); it tells the operator the running code may
 * not reflect these source changes, with the same remediation the old gate gave.
 */
function buildStaleAdvisory(report: BuildFreshnessReport): string {
  const examples = report.staleFiles?.length
    ? ` (e.g. ${report.staleFiles.slice(0, 3).join(', ')})`
    : '';
  return (
    `Advisory: this project's build looks stale — ${report.reason ?? 'src newer than build'}` +
    // s86-m05: one wording for both situations — `npm run build` only exists in a source
    // checkout, so a packaged install needs the reinstall arm named.
    `${examples}. Rebuild from source (npm run build) or reinstall the package, then start a new ` +
    `host session or reconnect if subsequent tool calls should use these changes. ` +
    `This does not block sprint close.`
  );
}

function summarizeSprintReadiness(missions: SprintMissionRow[]): SprintCloseoutReadiness {
  const completedMissionIds = missions
    .filter((mission) => normalizeMissionStatus(mission.status) === 'Completed')
    .map((mission) => mission.id);
  const blockedMissionIds = missions
    .filter((mission) => mission.status === 'Blocked')
    .map((mission) => mission.id);
  const skippedMissionIds = missions
    .filter(
      (mission) =>
        normalizeMissionStatus(mission.status) === 'Completed' && isSkippedMission(mission.notes)
    )
    .map((mission) => mission.id);
  // Terminal states for sprint close: Completed, Blocked, Dropped, Deferred.
  // Dropped = soft-parked and intentionally removed — sprint can close.
  // Deferred = temporarily parked — sprint can close; mission carries to next sprint.
  // Only Queued / Current / In Progress missions are truly blocking.
  const TERMINAL_FOR_SPRINT_CLOSE = new Set(['Completed', 'Blocked', 'Dropped', 'Deferred']);
  const openMissionIds = missions
    .filter((mission) => !TERMINAL_FOR_SPRINT_CLOSE.has(mission.status))
    .map((mission) => mission.id);

  // s86-m08: sprint close computes from SprintMissionRow[], NOT from sprint_summary, so the
  // view fix does not reach it. Same rule, same source constant: the closeout receipt must not
  // score a sprint against work it parked, and must still say how much it parked.
  const parkedMissionCount = missions.filter((mission) =>
    isParkedMissionStatus(mission.status)
  ).length;

  return {
    totalMissions: missions.length - parkedMissionCount,
    completedMissions: completedMissionIds.length,
    blockedMissions: blockedMissionIds.length,
    skippedMissions: skippedMissionIds.length,
    openMissions: openMissionIds.length,
    parkedMissions: parkedMissionCount,
    completedMissionIds,
    blockedMissionIds,
    skippedMissionIds,
    openMissionIds,
  };
}

function isSkippedMission(notes: string | null): boolean {
  if (typeof notes !== 'string') {
    return false;
  }

  return notes
    .split(/\r?\n|\|/)
    .map((segment) => segment.trim())
    .some(
      (segment) =>
        /^\[(?:skip|skipped)\](?:\s|$)/i.test(segment) ||
        /^skip(?:ped)?\s*[:-]/i.test(segment) ||
        /^status\s*:\s*skipped\b/i.test(segment)
    );
}

function loadCloseoutContext(
  client: RbookDatabaseClient,
  contextType: CloseoutContextType
): RbookToolResult<LoadedCloseoutContext> {
  const result = client.getOne<Context>(
    'SELECT id, source_path, content, updated_at FROM contexts WHERE id = ?',
    [contextType]
  );
  if (!result.success) {
    return createError(
      result.error ?? {
        code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to load ${contextType}`,
        suggestion: 'Check database connectivity and schema.',
      }
    );
  }
  if (!result.data) {
    return createError(RbookErrors.contextNotFound(contextType));
  }

  try {
    const parsed = JSON.parse(result.data.content);
    if (!isPlainObject(parsed)) {
      return createError({
        code: RBOOK_ERROR_CODES.CONTEXT_PARSE_ERROR,
        message: `${contextType} content must be a JSON object`,
        suggestion: 'Repair the stored context JSON before retrying sprint closeout.',
      });
    }

    const sizeSettings = resolveContextSizeSettings(parsed);
    return createSuccess({
      contextType,
      rawContent: result.data.content,
      parsedContent: parsed,
      beforeSize: calculateContextSizeMetrics(result.data.content, sizeSettings),
    });
  } catch {
    return createError({
      code: RBOOK_ERROR_CODES.CONTEXT_PARSE_ERROR,
      message: `${contextType} content is not valid JSON`,
      suggestion: 'Repair the stored context JSON before retrying sprint closeout.',
    });
  }
}

function createSnapshot(
  client: RbookDatabaseClient,
  contextType: CloseoutContextType,
  content: string,
  source: string
): { success: boolean; snapshotId?: number } {
  const contentHash = crypto.createHash('sha256').update(content).digest('hex').substring(0, 16);
  // s92-m09: reuse an identical snapshot only when it is itself never prunable (a milestone, a
  // named snapshot); landing on an update or close copy would lose the milestone to a prune.
  const reusable = findReusableSnapshot(client, {
    contextId: contextType,
    contentHash,
    kind: 'milestone',
  });
  if (reusable.ok && reusable.row) {
    return { success: true, snapshotId: reusable.row.id };
  }

  const now = new Date().toISOString();
  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  // s92-m09: a sprint-close milestone; it keeps its content.
  const storage = snapshotStorage('milestone', content, { contentHash });
  const insertResult = client.execute(
    `INSERT INTO context_snapshots (context_id, source, content_hash, content, created_at, ${[...storage.columns, ...g.columns].join(', ')})
     VALUES (?, ?, ?, ?, ?, ${[...storage.columns.map(() => '?'), g.placeholders].join(', ')})`,
    [contextType, source, storage.contentHash, storage.content, now, ...storage.values, ...g.values]
  );
  if (!insertResult.success) {
    return { success: false };
  }

  return { success: true, snapshotId: Number(insertResult.data?.lastInsertRowid) };
}

/**
 * Survey every pending next-step without inferring delivery from provenance. The read remains
 * inside the closeout transaction so the receipt describes the same stable boundary as the close.
 */
function surveyPendingNextSteps(
  client: RbookDatabaseClient,
  sprintId: string,
  warnings: string[]
): SprintPendingNextStepsSurvey {
  const unavailable: SprintPendingNextStepsSurvey = {
    available: false,
    totalPending: null,
    totalOpen: null,
    groups: null,
    lease: null,
  };
  // s91-m06: every OPEN row (pending and carried). Ages are computed HERE, before
  // completeSprintRecord writes this sprint's end_date, so the closing sprint never counts
  // toward its own survey.
  const rows = client.getMany<{
    id: number;
    content: string;
    sprint_id: string | null;
    mission_id: string | null;
    status: 'pending' | 'carried';
    closes_survived: number;
    age_days: number | null;
  }>(
    `SELECT n.id, n.content, n.sprint_id, n.mission_id, n.status,
            ${CLOSES_SURVIVED_SQL} AS closes_survived,
            ${LEASE_AGE_DAYS_SQL} AS age_days
       FROM next_steps n
      WHERE ${LEASED_STATUS_SQL}
      ORDER BY n.id ASC`,
    []
  );

  if (!rows.success || !rows.data) {
    warnings.push(
      `next_steps survey unavailable for sprint '${sprintId}' — ` +
        `${rows.error?.code ?? 'DB_ERROR'}: ${rows.error?.message ?? 'no row data returned'}. ` +
        'Pending total is unknown; no next_steps status was changed.'
    );
    return unavailable;
  }

  const groups: SprintPendingNextStepGroups = {
    closingSprintWithMissionProvenance: [],
    closingSprintWithoutMissionProvenance: [],
    otherSprintProvenance: [],
    noSprintProvenance: [],
  };

  for (const row of rows.data) {
    const item: SprintPendingNextStep = {
      id: row.id,
      content: row.content,
      sprintId: row.sprint_id,
      missionId: row.mission_id,
      status: row.status,
      closesSurvived: row.closes_survived,
      ageDays: row.age_days,
    };
    if (row.sprint_id === null) {
      groups.noSprintProvenance.push(item);
    } else if (row.sprint_id !== sprintId) {
      groups.otherSprintProvenance.push(item);
    } else if (row.mission_id !== null) {
      groups.closingSprintWithMissionProvenance.push(item);
    } else {
      groups.closingSprintWithoutMissionProvenance.push(item);
    }
  }

  return {
    available: true,
    totalPending: rows.data.filter((row) => row.status === 'pending').length,
    totalOpen: rows.data.length,
    groups,
    lease: {
      warnAt: LEASE_WARN_AT,
      lapseAt: LEASE_LAPSE_AT,
      countingRule: LEASE_COUNTING_RULE,
      warned: rows.data
        .filter(
          (row) => row.closes_survived >= LEASE_WARN_AT && row.closes_survived < LEASE_LAPSE_AT
        )
        .map((row) => row.id),
      // s92-m02: the drop also needs the 14-day floor (leaseState applies both bounds).
      lapsed: rows.data
        .filter((row) => leaseState(row.closes_survived, row.age_days) === 'lapsing')
        .map((row) => row.id),
      minAgeDays: LEASE_MIN_AGE_DAYS,
      heldByMinAge: rows.data
        .filter(
          (row) =>
            row.closes_survived >= LEASE_LAPSE_AT &&
            leaseState(row.closes_survived, row.age_days) !== 'lapsing'
        )
        .map((row) => row.id),
      idleWarnDays: LEASE_IDLE_WARN_DAYS,
      idle: rows.data
        .filter((row) => leaseState(row.closes_survived, row.age_days) === 'idle')
        .map((row) => row.id),
    },
  };
}

/** The open sprint that remains once `closingSprintId` completes, or null. */
function nextOpenSprint(
  client: RbookDatabaseClient,
  closingSprintId: string
): SprintPointer | null {
  const open = openSprintPointer(client);
  return open && open.id !== closingSprintId ? open : null;
}

/**
 * s91-m06 — drop every lapsed row INSIDE the close transaction, so the receipt describes one
 * stable boundary: a drop that landed after COMMIT could succeed while the receipt reported the
 * row pending. The close still never writes `completed` and never infers delivery (s90-m05); it
 * writes `dropped` only for rows at or past LEASE_LAPSE_AT, and names each.
 */
function dropLapsedNextSteps(
  client: RbookDatabaseClient,
  lapsedIds: readonly number[],
  droppedAt: string,
  writeSink: { failures: WriteFailure[] }
): number[] {
  const dropped: number[] = [];
  for (const id of lapsedIds) {
    const result = recordedExecute(
      client,
      `UPDATE next_steps SET status = 'dropped', resolved_at = ?
        WHERE id = ? AND status IN ('pending','carried')`,
      [droppedAt, id]
    );
    if (countWrite(result, writeSink, `next_steps.lease_drop #${id}`) > 0) dropped.push(id);
  }
  return dropped;
}

/**
 * Bound the two canonical production arrays measured at close (master resume and project working
 * memory). Legacy/noncanonical next-step arrays are preserved without inventing an unmeasured cap.
 * Text is never inspected for sprint or mission tokens.
 */
function trimCloseoutNextStepProse(
  content: Record<string, unknown>,
  contextType: CloseoutContextType
): number {
  const parentKey = contextType === 'master_context' ? 'next_session_context' : 'working_memory';
  const arrayKey = contextType === 'master_context' ? 'when_we_resume' : 'next_steps';
  const limit = contextType === 'master_context' ? 15 : 10;
  const parent = content[parentKey];
  if (!isPlainObject(parent) || !Array.isArray(parent[arrayKey])) return 0;

  const entries = parent[arrayKey] as unknown[];
  const removed = Math.max(0, entries.length - limit);
  if (removed > 0) entries.splice(0, removed);
  return removed;
}

function persistCloseoutContext(
  client: RbookDatabaseClient,
  context: LoadedCloseoutContext,
  updatedAt: string
): RbookToolResult<{ afterSize: ContextSizeMetrics }> {
  const serialized = JSON.stringify(context.parsedContent);
  const afterSize = calculateContextSizeMetrics(
    serialized,
    resolveContextSizeSettings(context.parsedContent)
  );

  if (serialized === context.rawContent) {
    return createSuccess({ afterSize });
  }

  const updateResult = client.execute(
    'UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?',
    [serialized, updatedAt, context.contextType]
  );
  if (!updateResult.success) {
    return createError(
      updateResult.error ?? {
        code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to update ${context.contextType}`,
        suggestion: 'Check database permissions and retry sprint closeout.',
      }
    );
  }

  return createSuccess({ afterSize });
}

function completeSprintRecord(
  client: RbookDatabaseClient,
  sprintId: string,
  completedAt: string
): ReturnType<RbookDatabaseClient['execute']> {
  // s92-m02: the ACTUAL close time, always. `COALESCE(end_date, ?)` kept a planned end date,
  // and the next-step lease counted that future date as a close later carries had survived.
  // The planned date is reported on the receipt as plannedEndDate instead.
  const updateWithEndDate = recordedExecute(
    client,
    `UPDATE sprints
        SET status = 'Completed',
            end_date = ?
      WHERE id = ?`,
    [completedAt, sprintId]
  );

  // s86-m02b: inverted from `if (success || not-the-schema-mismatch) return it` by De Morgan.
  // Behaviour is identical; the failure is now READ negatively, which is what the no-silent-write
  // gate requires and what makes the fallback's precondition ("the column is missing") legible.
  if (
    !updateWithEndDate.success &&
    updateWithEndDate.error?.code === RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH &&
    updateWithEndDate.error?.message.includes('end_date')
  ) {
    // Pre-end_date store — fall through to the column-free UPDATE below.
  } else {
    return updateWithEndDate;
  }

  return recordedExecute(client, `UPDATE sprints SET status = 'Completed' WHERE id = ?`, [
    sprintId,
  ]);
}

async function applyOptionalCondensation(params: {
  projectRoot?: string;
  strategy: Exclude<CloseoutCondensationStrategy, 'none'>;
  targetSizePercent: number;
  warnings: string[];
  contexts: RbookSprintCompleteResult['contexts'];
}): Promise<void> {
  const mappings = [
    ['masterContext', 'master_context'],
    ['projectContext', 'project_context'],
  ] as const;

  for (const [resultKey, contextType] of mappings) {
    const condenseResult = await rbookContextCondense(
      {
        contextType,
        strategy: params.strategy,
        targetSizePercent: params.targetSizePercent,
        dryRun: false,
        projectRoot: params.projectRoot,
      },
      { preserveNextStepProse: true }
    );

    if (!condenseResult.success || !condenseResult.data) {
      params.warnings.push(
        `Optional ${contextType} condensation failed: ${condenseResult.error?.message ?? 'Unknown error'}.`
      );
      continue;
    }

    params.contexts[resultKey].afterSize = condenseResult.data.afterSize;
    params.contexts[resultKey].condensation = {
      strategy: params.strategy,
      snapshotId: condenseResult.data.snapshotId,
      reductionPercent: condenseResult.data.reductionPercent,
      targetMet: condenseResult.data.targetMet,
      message: condenseResult.data.message,
    };

    for (const warning of condenseResult.warnings ?? []) {
      params.warnings.push(`${contextType}: ${warning}`);
    }
  }
}

// s87-m02's shared archive predicate lives in sprint-archive-scope.ts, which s96-m12's checks read too.
const DECISIONS_WHERE = ARCHIVE_WHERE;

/**
 * The learnings arm adds ONE predicate: `evergreen = 0`.
 *
 * s87-m02 — this AMENDS #38's compound-WHERE coverage on the learnings arm only, and it is the
 * single behaviour change in this function. An `evergreen = 1` learning is an institutional rule
 * an operator flagged precisely so it would stop aging out of view; archiving it at every sprint
 * close is the close overruling that flag. Measured before the change: all 29 active evergreen
 * learnings in this store carry a `last_reviewed_at` LATER than their sprint's end_date — not one
 * had ever been protected by its flag, because a human restored each of them by hand afterwards.
 * The manual restore WAS the compensating control.
 *
 * The decisions arm gets no equivalent: `strategic_decisions` has no `evergreen` column at all,
 * so that half is a schema migration rather than a predicate, and it is deliberately not shipped
 * here (its next-step is minted with the cost stated).
 */
const LEARNINGS_WHERE = `${ARCHIVE_WHERE}\n       AND evergreen = 0`;

/** The outcome of archiving ONE table. Reported independently of the other's fate. */
interface ArchiveTableOutcome {
  ok: boolean;
  count: number;
  ids: number[];
  error?: string;
}

interface ArchiveOutcome {
  decisions: ArchiveTableOutcome;
  learnings: ArchiveTableOutcome;
  warnings: string[];
}

/**
 * Archive one table's sprint-scoped rows, and NAME them.
 *
 * WHY A PRE-SELECT AND NOT `RETURNING id`. Measured on better-sqlite3 12.6.0 through this
 * codebase's own client: `RbookDatabaseClient.execute` calls `.run()`, which DISCARDS the rows a
 * `RETURNING` clause produces and reports `{changes, lastInsertRowid}` — no throw, and the UPDATE
 * still applies. A fix whose entire purpose is removing a silent write would have introduced one.
 * The SELECT runs immediately before the UPDATE, under the identical predicate, inside the same
 * `BEGIN IMMEDIATE`, so no row can enter or leave the set between them.
 *
 * THE INVARIANT, per table: `ids.length === changes`. If the enumeration and the count disagree,
 * one of them is not describing the write — so the disagreement is surfaced as a named warning
 * rather than reconciled by preferring whichever number is handier.
 */
function archiveOneTable(
  client: RbookDatabaseClient,
  table: 'strategic_decisions' | 'learnings',
  where: string,
  sprintId: string,
  warnings: string[]
): ArchiveTableOutcome {
  const params = [sprintId, sprintId, sprintId];
  // s96-m12: on a shared record, a row whose status is in conflict is skipped and named.
  const skipped = skippedConflicts(client, table, ['status'], where, params);
  if (skipped) warnings.push(skipped);
  const skip = skipConflicted(client, table, ['status']);

  const selectSql = `SELECT id FROM ${table} WHERE ${where}${skip}`;
  const selected = client.getMany<{ id: number }>(selectSql, params);
  if (!selected.success) {
    const msg = selected.error?.message ?? `Failed to enumerate ${table}`;
    return {
      ok: false,
      count: 0,
      ids: [],
      error: `${table}: ${msg} — SQL: ${selectSql.replace(/\s+/g, ' ')}`,
    };
  }
  const ids = (selected.data ?? []).map((r) => r.id);

  const updateSql = `UPDATE ${table} SET status = 'archived' WHERE ${where}${skip}`;
  const updated = recordedExecute(client, updateSql, params);
  if (!updated.success) {
    const msg = updated.error?.message ?? `Failed to archive ${table}`;
    return {
      ok: false,
      count: 0,
      ids: [],
      error: `${table}: ${msg} — SQL: ${updateSql.replace(/\s+/g, ' ')}`,
    };
  }
  const count = updated.data?.changes ?? 0;

  if (ids.length !== count) {
    warnings.push(
      `Sprint close archived ${count} row(s) in ${table} but enumerated ${ids.length}. ` +
        `The reported ids may be incomplete; the pre-close snapshot holds the full pre-image.`
    );
  }

  return { ok: true, count, ids };
}

/**
 * Archive sprint-scoped decisions and learnings, naming every row moved.
 *
 * Sets status='archived' for active decisions/learnings linked to the sprint (directly via
 * sprint_id, or indirectly via mission/session sprint linkage). Rows with status other than
 * 'active' are left untouched, and `evergreen = 1` learnings are left active.
 *
 * s87-m02 — THE TWO TABLES REPORT INDEPENDENTLY (FORK-4b). The previous shape returned a single
 * `success` boolean, and the caller read `success ? decisionsArchived : 0`. So a failure on the
 * LEARNINGS arm zeroed the DECISIONS count — for decisions that had been archived AND, because
 * the failure only warned, COMMITTED. The close reported `Archived: 0 decisions` about N rows it
 * had just permanently demoted. That is a larger instance of this sprint's own defect class than
 * the one the mission was opened for, and it lived inside the function the mission rewrites.
 */
function archiveSprintDecisionsAndLearnings(
  client: RbookDatabaseClient,
  sprintId: string
): ArchiveOutcome {
  const warnings: string[] = [];

  // Sprint 52 m04: older DBs seeded before the session-of-origin column was added
  // will fail the archival UPDATE with `no such column` and silently archive zero
  // rows. Ensure it exists first. s69-m04 renamed it session_id → author_session_id;
  // ensureAuthorNamespaceColumns (run pre-BEGIN at the top of this handler) has
  // already settled the rename, and ensureArchivalColumns is now rename-aware.
  warnings.push(...(ensureArchivalColumns(client).warnings ?? []));

  // s87-m02 — REQUIRED BY `LEARNINGS_WHERE`, and it is not defensive padding. `evergreen` is
  // absent from `rbook-seed/db/schema.sql` entirely (`grep -n evergreen` returns nothing), so
  // every store created from the published tarball lacks the column until some read path
  // migrates it. Without this call the added predicate throws `no such column: evergreen`, the
  // learnings arm early-returns, and the close archives ZERO learnings on a fleet store — worse
  // than the defect being fixed. #519 is the precedent for an `ensure*` inside this transaction.
  // s87-m03: its warnings are SPLICED, not discarded. This call site was added by s87-m02 three
  // missions ago, and leaving its MigrationResult on the floor would have made sprint-87 add a
  // forty-sixth unspliced migration call — in the sprint about surfaces that hide what they did.
  warnings.push(...(ensureLearningsTable(client).warnings ?? []));

  const decisions = archiveOneTable(
    client,
    'strategic_decisions',
    DECISIONS_WHERE,
    sprintId,
    warnings
  );
  if (!decisions.ok && decisions.error) {
    warnings.push(`Decision archival failed: ${decisions.error}`);
  }

  const learnings = archiveOneTable(client, 'learnings', LEARNINGS_WHERE, sprintId, warnings);
  if (!learnings.ok && learnings.error) {
    warnings.push(`Learning archival failed: ${learnings.error}`);
  }

  return { decisions, learnings, warnings };
}

/**
 * Compute sprint summary KPIs from mission and decision data.
 */
function computeSprintKPIs(
  client: RbookDatabaseClient,
  sprintId: string,
  readiness: SprintCloseoutReadiness
): SprintKPIs {
  const completionRate =
    readiness.totalMissions > 0
      ? roundNumber(readiness.completedMissions / readiness.totalMissions)
      : 0;

  // Compute average cycle time from missions with both started_at and completed_at
  let avgCycleTimeDays: number | null = null;
  const missionRows = client.getMany<SprintMissionKpiRow>(
    'SELECT id, status, started_at, completed_at FROM missions WHERE sprint_id = ? AND status = ? AND started_at IS NOT NULL AND completed_at IS NOT NULL',
    [sprintId, 'Completed']
  );
  if (missionRows.success && missionRows.data && missionRows.data.length > 0) {
    let totalMs = 0;
    let count = 0;
    for (const row of missionRows.data) {
      if (row.started_at && row.completed_at) {
        const started = storedTimeMs(row.started_at);
        const completed = storedTimeMs(row.completed_at);
        if (!Number.isNaN(started) && !Number.isNaN(completed) && completed >= started) {
          totalMs += completed - started;
          count += 1;
        }
      }
    }
    if (count > 0) {
      avgCycleTimeDays = roundNumber(totalMs / count / (1000 * 60 * 60 * 24));
    }
  }

  // Count decisions for this sprint
  let decisionCount = 0;
  const decisionCountResult = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM strategic_decisions
     WHERE sprint_id = ?
       OR mission_id IN (SELECT id FROM missions WHERE sprint_id = ?)
       OR author_session_id IN (SELECT id FROM sessions WHERE sprint_id = ?)`,
    [sprintId, sprintId, sprintId]
  );
  if (decisionCountResult.success && decisionCountResult.data) {
    decisionCount = decisionCountResult.data.count;
  }

  // Count learnings for this sprint
  let learningCount = 0;
  const learningCountResult = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM learnings
     WHERE sprint_id = ?
       OR mission_id IN (SELECT id FROM missions WHERE sprint_id = ?)
       OR author_session_id IN (SELECT id FROM sessions WHERE sprint_id = ?)`,
    [sprintId, sprintId, sprintId]
  );
  if (learningCountResult.success && learningCountResult.data) {
    learningCount = learningCountResult.data.count;
  }

  return {
    completionRate,
    avgCycleTimeDays,
    decisionCount,
    learningCount,
    blockedCount: readiness.blockedMissions,
  };
}

/**
 * Clear project_context sprint-specific working_memory fields and update current_sprint.
 * Clears session_history and recent_sessions arrays (sprint-scoped ephemeral data).
 * Does NOT clear next_steps — closeout retention trims only oldest overflow by count.
 * Mutates the parsed content in-place for subsequent persistence.
 */
function clearProjectContextWorkingMemory(
  content: Record<string, unknown>,
  _sprintId: string
): void {
  if (isPlainObject(content.working_memory)) {
    const wm = content.working_memory as Record<string, unknown>;
    // Clear sprint-scoped ephemeral arrays but NOT next_steps (bounded separately by count).
    const ephemeralKeys = ['session_history', 'recent_sessions'];
    for (const key of ephemeralKeys) {
      if (Array.isArray(wm[key])) {
        wm[key] = [];
      }
    }
  }

  // Set current_sprint to null to signal the sprint is closed
  if ('current_sprint' in content) {
    content.current_sprint = null;
  }

  // Also clear active_mission if present
  if ('active_mission' in content) {
    content.active_mission = null;
  }
}

function buildCloseoutMessage(
  sprintId: string,
  condensation: CloseoutCondensationStrategy,
  readiness: SprintCloseoutReadiness
): string {
  const parts = [`Sprint '${sprintId}' closed successfully`];
  if (readiness.blockedMissions > 0) {
    parts.push(
      `with ${readiness.blockedMissions} blocked mission${readiness.blockedMissions === 1 ? '' : 's'} left as carryover`
    );
  }
  if (condensation !== 'none') {
    parts.push(`using ${condensation} context condensation`);
  }
  return parts.join(' ');
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * s87-m02 — render an archived-id list, and say so when it is cut short.
 *
 * The close's rendered answer shares a session-opener budget, so an unbounded id list is not an
 * option: sprint-86's close would have printed 47 ids. But a list truncated in SILENCE is this
 * sprint's own defect class — a surface reporting a write while hiding which rows it touched —
 * so the truncation is stated, with the remaining count, and the full list stays on the data
 * object for any caller that wants it.
 *
 * An empty list renders nothing at all rather than `[]`: "0 decisions" already said it.
 */
const ARCHIVED_ID_RENDER_CAP = 30;
const NEXT_STEP_SURVEY_CONTENT_EXCERPT_CAP = 5;
const NEXT_STEP_SURVEY_CONTENT_RENDER_CAP = 160;

function formatArchivedIds(ids: number[] | undefined): string {
  if (!ids || ids.length === 0) return '';
  const shown = ids.slice(0, ARCHIVED_ID_RENDER_CAP);
  const remainder = ids.length - shown.length;
  const body = shown.map((id) => `#${id}`).join(', ');
  return remainder > 0 ? ` (${body}, +${remainder} more)` : ` (${body})`;
}

function formatPendingNextStepGroup(
  lines: string[],
  label: string,
  rows: SprintPendingNextStep[]
): void {
  lines.push(`${label}: ${rows.length}`);
  if (rows.length === 0) return;

  // Every id stays visible in the text channel agents actually read. Only the prose excerpts are
  // capped; structured data retains every complete row.
  lines.push(`  IDs: ${rows.map((row) => `#${row.id}`).join(', ')}`);
  for (const row of rows.slice(0, NEXT_STEP_SURVEY_CONTENT_EXCERPT_CAP)) {
    const provenance = [
      row.sprintId ?? 'no sprint',
      row.missionId ? `mission provenance ${row.missionId}` : null,
    ]
      .filter((value): value is string => value !== null)
      .join('; ');
    const content =
      row.content.length > NEXT_STEP_SURVEY_CONTENT_RENDER_CAP
        ? `${row.content.slice(0, NEXT_STEP_SURVEY_CONTENT_RENDER_CAP - 1)}…`
        : row.content;
    lines.push(`  - #${row.id} [${provenance}]: ${content}`);
  }
  if (rows.length > NEXT_STEP_SURVEY_CONTENT_EXCERPT_CAP) {
    lines.push(
      `  - ${rows.length - NEXT_STEP_SURVEY_CONTENT_EXCERPT_CAP} additional prose excerpt(s) omitted; all ids are listed above`
    );
  }
}

/**
 * Format sprint closeout results for LLM readability.
 */
export function formatSprintCompleteForLLM(
  result: RbookToolResult<RbookSprintCompleteResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to complete sprint',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const data = result.data;
  const runtimeBuildAtClose =
    data.startupBuildTime === null
      ? 'unavailable (no startup manifest; drift unavailable)'
      : `${data.startupBuildTime}; drift ${
          data.driftMinutes === null ? 'unavailable' : `${data.driftMinutes} minute(s)`
        }`;
  const sessionLines = (label: string, sessions: ActiveSessionAtClose[]): string[] =>
    sessions.length === 0
      ? [`${label}: none`]
      : [
          `${label}: ${sessions.length}`,
          ...sessions.map(
            (session) =>
              `  - ${session.id} (${session.title}): ` +
              `${session.captureCount === null ? 'unknown' : session.captureCount} capture(s), ` +
              `${
                session.deferredCaptureCount === null ? 'unknown' : session.deferredCaptureCount
              } deferred`
          ),
        ];
  const lines = [
    `✓ Sprint '${data.sprintId}' completed`,
    '',
    `Status: ${data.previousStatus ?? 'Unknown'} → ${data.currentStatus}`,
    `Completed at: ${data.completedAt} (stamped as end_date${
      data.plannedEndDate ? `; the planned end date was ${data.plannedEndDate}` : ''
    })`,
    `Summary: ${data.summary}`,
    '',
    `Readiness: ${data.readiness.completedMissions}/${data.readiness.totalMissions} completed, ${data.readiness.blockedMissions} blocked, ${data.readiness.openMissions} open, ${data.readiness.parkedMissions} parked (outside the total)`,
    '',
    `KPIs: completion rate ${(data.lifecycle.kpis.completionRate * 100).toFixed(0)}%, avg cycle time ${data.lifecycle.kpis.avgCycleTimeDays !== null ? `${data.lifecycle.kpis.avgCycleTimeDays}d` : 'N/A'}, ${data.lifecycle.kpis.decisionCount} decisions, ${data.lifecycle.kpis.learningCount} learnings`,
    data.lifecycle.archived
      ? `Archived: ${data.lifecycle.decisionsArchived} decisions${formatArchivedIds(data.lifecycle.archivedDecisionIds)}, ${data.lifecycle.learningsArchived} learnings${formatArchivedIds(data.lifecycle.learningIds)}`
      : "Archived: nothing — this sprint's decisions and learnings stay active (pass archive: true to archive them)",
    `Pre-close snapshot (undo handle): ${data.lifecycle.preCloseSnapshotId ?? 'FAILED — this close is not reversible from a snapshot'}`,
    `DB snapshot: ${data.lifecycle.dbSnapshotId ?? 'failed'}`,
    `Runtime build at close: ${runtimeBuildAtClose}`,
    ...sessionLines('Active sessions at close', data.activeSessionsAtClose),
    ...sessionLines('Implicit sessions at close', data.implicitSessionsAtClose),
    '',
    `master_context: ${data.contexts.masterContext.beforeSize.sizeKb.toFixed(2)}KB → ${data.contexts.masterContext.afterSize.sizeKb.toFixed(2)}KB, trimmed ${data.contexts.masterContext.nextStepsCleared} oldest next-step item(s) by count`,
    `project_context: ${data.contexts.projectContext.beforeSize.sizeKb.toFixed(2)}KB → ${data.contexts.projectContext.afterSize.sizeKb.toFixed(2)}KB, trimmed ${data.contexts.projectContext.nextStepsCleared} oldest next-step item(s) by count`,
    `Total context size: ${data.contexts.totalBeforeSizeKb.toFixed(2)}KB → ${data.contexts.totalAfterSizeKb.toFixed(2)}KB`,
  ];

  if (data.contexts.masterContext.condensation || data.contexts.projectContext.condensation) {
    lines.push('');
    if (data.contexts.masterContext.condensation) {
      lines.push(
        `master_context condensation: ${data.contexts.masterContext.condensation.message}`
      );
    }
    if (data.contexts.projectContext.condensation) {
      lines.push(
        `project_context condensation: ${data.contexts.projectContext.condensation.message}`
      );
    }
  }

  lines.push('');
  if (
    !data.nextStepsSurvey.available ||
    data.nextStepsSurvey.totalPending === null ||
    data.nextStepsSurvey.groups === null
  ) {
    lines.push('Next-steps survey: unavailable (pending total unknown)');
  } else {
    lines.push(
      `Next-steps survey: ${data.nextStepsSurvey.totalPending} pending across the whole ledger ` +
        `(${data.nextStepsSurvey.totalOpen ?? data.nextStepsSurvey.totalPending} open including carried)`
    );
    const lease = data.nextStepsSurvey.lease;
    if (lease) {
      lines.push(
        `Lease: warn at ${lease.warnAt}, drop at ${lease.lapseAt} unless carried. ${lease.countingRule}.`
      );
      lines.push(
        `  Warned (next close warns again, the one after drops): ${
          lease.warned.length > 0 ? lease.warned.map((id) => `#${id}`).join(', ') : 'none'
        }`
      );
      lines.push(
        `  Dropped by this close (lease lapsed): ${
          data.lapsedDroppedIds.length > 0
            ? data.lapsedDroppedIds.map((id) => `#${id}`).join(', ')
            : 'none'
        }`
      );
      if (data.lapsedDroppedIds.length > 0) {
        lines.push(`  Undo: ${reopenCommand(data.lapsedDroppedIds)}`);
      }
      if (lease.heldByMinAge.length > 0) {
        lines.push(
          `  Kept by the ${lease.minAgeDays}-day floor (past the drop age, too young to drop): ` +
            lease.heldByMinAge.map((id) => `#${id}`).join(', ')
        );
      }
      if (lease.idle.length > 0) {
        lines.push(
          `  Idle (no close survived in ${lease.idleWarnDays}+ days; never dropped by the calendar): ` +
            lease.idle.map((id) => `#${id}`).join(', ')
        );
      }
    }
    formatPendingNextStepGroup(
      lines,
      'Closing sprint with mission provenance (not delivery)',
      data.nextStepsSurvey.groups.closingSprintWithMissionProvenance
    );
    formatPendingNextStepGroup(
      lines,
      'Closing sprint without mission provenance',
      data.nextStepsSurvey.groups.closingSprintWithoutMissionProvenance
    );
    formatPendingNextStepGroup(
      lines,
      'Other sprint provenance',
      data.nextStepsSurvey.groups.otherSprintProvenance
    );
    formatPendingNextStepGroup(
      lines,
      'No sprint provenance',
      data.nextStepsSurvey.groups.noSprintProvenance
    );
    lines.push('Resolve explicitly with one valid action:');
    lines.push(
      '  - rbook_context(action="next_steps", nextStepAction="complete", nextStepIds=[...])'
    );
    lines.push('  - rbook_context(action="next_steps", nextStepAction="carry", nextStepIds=[...])');
    lines.push('  - rbook_context(action="next_steps", nextStepAction="drop", nextStepIds=[...])');
  }

  appendWriteFailures(lines, data.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}
