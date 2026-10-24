// ABOUTME: rbook_review — sprint-64 m03 bundled session-opener digest tool.
// ABOUTME: Bundles a project-scoped core plus compact portfolio into ≤4KB, with flat top-3 next_actions.

/**
 * rbook_review Tool
 *
 * Bundles the three canonical session-opener calls (rbook_agent_onboard,
 * rbook_context_view, rbook_mission_status) into a single ≤4KB digest so a
 * fresh agent can boot from one tool call instead of four.
 *
 * SCOPE. #671 (sprint-64 m03) locked this tool to "no new SQL queries beyond what
 * rbook_agent_onboard and rbook_context_view already issue". That clause is SUPERSEDED IN PART by
 * decision #1016 (s87-m03) and this file no longer cites it as a live constraint.
 *
 * WHAT REPLACED IT, and it is tighter in the dimension #671 actually cared about. #671 protected
 * the session-opener budget: this tool runs on every session start, fans out across every
 * registered store, and must stay inside a 4KB digest and a fan-in p95 measured in tens of
 * milliseconds. "No new SQL" was the PROXY chosen in sprint-64, when rbook_review was a
 * single-store digest and every read it needed already existed. The proxy is now retired and the
 * fence is stated as a COST: rbook_review may issue a read of its own ONLY when it runs on a
 * connection this call already opens (no new store opens, no new connections, no network), is
 * read-only and index-covered with its per-store cost measured and recorded, degrades to a
 * LABELLED fallback rather than an error, and exists to make a PUBLISHED NUMBER TRUE rather than
 * to add a field. Anything failing that last clause is still forbidden.
 *
 * ONE RATIFIED EXCEPTION (s97-m01, the sprint-100 design ratified by #1546). The portfolio section
 * carries other projects' signals that need a person. That departs from the fence above in three
 * ways, and in nothing else. It ADDS A FIELD. A store holding a pending draft has its draft runtime
 * opened read-only, a SECOND OPEN. And not every read is index-covered: drafts and open next steps
 * are (idx_proposals_outcome, idx_next_steps_status), while sprints and missions are scanned, and
 * session_events once for each blocked mission with no recorded blockedSince; on a shared copy
 * record_conflicts and record_peers are read whole. The cost is stated as the fence asks, measured
 * on this Mac's 25 stores on 2026-10-20 (budget.json in rbook/research/2026-10-s100-build/
 * s97-m01-signals/, whose rule defines each number): 1.42 ms per store at p95 and 1.75 ms at most,
 * about 10.4 ms per review beside the drift stamp's 16 ms, and 6 runtime opens. Every failure is labelled, as the fence requires: a project whose signals cannot be
 * read is counted in `unread`, and a drift stamp that cannot be read reads as freshness unknown. A
 * further field needs the same measurement and its own ratified reason.
 *
 * WHY THE PROXY HAD TO GO. Under it, the only available drift signal was a file mtime — and the
 * cross-store fan-out CREATES the `-wal` sidecar whose mtime the signal read, so the instrument
 * fabricated its own evidence. A constraint written to keep a mission cheap had come to keep a
 * published number wrong. See {@link storeMtimeMs} and {@link newestRowStampMs}.
 *
 * rbook_agent_onboard and rbook_context_view stay unchanged for back-compat; this tool is purely
 * additive.
 *
 * Cross-store portfolio rollup (s79-m06 — SUPERSEDES the #672 project-only
 * exclusion). #672 excluded cross-project status because the old model was one
 * Reasonbook aggregating all projects; Arc D makes the sqlite ProjectGraphRegistry the
 * one discovery source + `queryAcrossStores` the one portfolio read path. So
 * rbook_review now carries an ALWAYS-ON, graceful-degrading ≤4KB portfolio section
 * (active missions across the registered projects) built on that graph-backed
 * fan-out. It degrades to `portfolio=null` for a single-project operator (registry
 * lists ≤1 active project) or when the fan-out fails. Latency-fenced to the
 * active-missions query only (no second decisions-pulse fan-out).
 *
 * @module tools/rbook/rbook-review
 */

import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { isOpenStatus } from './terminal-status';
import { countReflaggedSinceRepair } from './staleness-detection';
import type Database from 'better-sqlite3';
import { realpathSync, statSync } from 'fs';
import * as path from 'path';
import { projectDisplayName } from '../../utils/project-display-name';
import { z } from 'zod';
import type { RbookToolResult } from './types';
import { createError, createSuccess } from './errors';
import { withClientAsync } from './client';
import { sharedRecordText } from './digest-v2';
import { sharedRecordReview } from './record-review';
import type { RecordProtocolReview } from './record-protocol-review';
import { tableHasColumn } from './genesis-columns';
import { findWrongTypedStringParam } from './param-type-guard';
import { rbookAgentOnboard, type RbookAgentOnboardResult } from './rbook-agent-onboard';
import { AUTHOR_BEFORE_RECORDED, AUTHOR_NOT_RECORDED, writerName } from './author-name';
import type { SelfCaptureGap } from './self-capture-guard';
import { rbookMissionStatus, type StatusMissionItem } from './rbook-mission-status';
import {
  checkBuildFreshness,
  projectChecksBuildFreshness,
  type BuildFreshnessReport,
} from './build-freshness';
import { resolveProjectRootEnhanced } from '../../intelligence/project-resolution';
import {
  ProjectGraphRegistry,
  unappliedDefaultNotice,
} from '../../intelligence/project-graph-registry';
import type { ResolvedBy } from '../../intelligence/sender-context';
import { activeMissionsAcrossProjects } from '../../intelligence/cross-store-queries';
import { personSignalsOf, personSignalsPhrase, type PersonSignals } from './portfolio-signals';
import {
  frameForeignInline,
  frameInlineIfForeign,
  isForeignProject,
} from '../../intelligence/provenance-frame';
import { isReadOnlyAgentSession } from './read-only-agent-guard';
import { captureToolCall, currentToolCallActionMode } from './tool-call-context';
import { appendWarnings } from './format-warnings';

/**
 * Compact action descriptor for the flat top-level next_actions array.
 */
export interface NextAction {
  action: string;
  command: string;
  priority: number;
}

/**
 * Compact work-queue mission entry.
 */
export interface WorkItem {
  id: string;
  name: string;
  /** s84-m03: the mission's own project_id — foreign name is framed / dropped from nextAction. */
  projectId?: string | null;
}

/**
 * Per-bucket work queue summary.
 */
export interface WorkQueueBucket {
  count: number;
  top: WorkItem[];
}

/** s80-m06 — one drifting project in the portfolio drift list. */
export interface PortfolioDriftItem {
  projectId: string;
  /** Display name, capped to {@link DRIFT_NAME_CAP_CHARS}. */
  name: string;
  /**
   * Why it drifted, e.g. "no new Reasonbook rows in 37d", "un-migrated (…)", or "freshness
   * unknown (…)".
   *
   * s87-m03: the wording changed WITH the mechanism. It used to assert a WRITE in the last N days,
   * derived from a file mtime this very call created by opening the store. It is now derived from
   * the newest row stamp across six domain tables, which measures row CREATION, not writes — so
   * the sentence says rows. (The old phrase is deliberately not quoted here: a mechanical gate
   * greps this tree for it, and a gate that a comment can trip is a gate someone will weaken.)
   */
  reason: string;
  /** Store mtime age in whole days (0 when the store could not be stat'd). */
  ageDays: number;
  /** Optional operator action, e.g. "run rbook_db backfill/rebuild" for un-migrated stores. */
  hint?: string;
}

/** s80-m06 — per-project freshness drift within the portfolio. */
export interface PortfolioDrift {
  /** The "silent" threshold in days (a store past it is flagged). */
  staleThresholdDays: number;
  /** The drifting projects (silent + un-migrated), top-N by ageDays desc. */
  stale: PortfolioDriftItem[];
}

/** s97-m01 — another project's counts of what needs a person; a zero or unavailable one is left out. */
export interface PortfolioSignalsItem extends PersonSignals {
  projectId: string;
  /** Display name, capped to {@link DRIFT_NAME_CAP_CHARS}. */
  name: string;
}

/**
 * s97-m01 — other projects' signals that need a person, counted by the signals library on the
 * connection the fan-out opens, with this machine's draft runtime: drafts awaiting a decision,
 * next steps near their lease, blocked missions and a shared copy's unsettled conflicts. This
 * project's own are left out, since its digest carries them. `reasonbook signals` gives the full
 * reports, with every unavailable signal and its reason.
 */
export interface PortfolioSignals {
  /** Other projects with at least one count. */
  projects: number;
  /** The most counted first, then by project id; at most {@link SIGNALS_TOP_N}, trimmed under budget. */
  top: PortfolioSignalsItem[];
  /**
   * Other projects whose signals could not be read: the store could not be queried, or one of the
   * four failed on it (a missing table is not a failure). Present only when there are any.
   */
  unread?: number;
}

/**
 * s79-m06 / s80-m06 — cross-store portfolio rollup. Active missions (In Progress/
 * Current) across the registered projects, built on the graph-backed
 * `queryAcrossStores`. `null` for a single-project operator or when the fan-out fails
 * (graceful degrade). s80-m06 reclassified the old `reachable`/`unreachable` split into
 * a STRICT PARTITION — `reachable + silent + unmigrated + unreadable === projects` — so
 * "reachable" regains its literal meaning (a succeeded, non-stale store) and per-project
 * drift is visible without a fan-out.
 */
export interface PortfolioSection {
  /** Active projects the graph registry lists (= stores queried). */
  projects: number;
  /** Succeeded ∧ fresh (written within `drift.staleThresholdDays`). */
  reachable: number;
  /** Succeeded ∧ stale (no new Reasonbook rows in > `drift.staleThresholdDays`; s87-m03). */
  silent: number;
  /** Failed with "no such column" — the missions table predates the s79 per-row rebuild. */
  unmigrated: number;
  /** Failed for another reason (store DB moved/locked/unreadable). */
  unreadable: number;
  /** Active missions across the portfolio: total count + the top ≤5 (trimmed first under budget). */
  activeMissions: {
    count: number;
    top: Array<{ id: string; name: string; projectId: string }>;
  };
  /** p95 per-store fan-in latency in ms (App-View Trigger-A signal); overall wall-clock when no store succeeded. */
  fanInP95Ms: number;
  /** Per-project freshness drift (silent + un-migrated stores); null when nothing drifted. */
  drift: PortfolioDrift | null;
  /** s97-m01 — other projects' signals that need a person; null when none has one. */
  signals: PortfolioSignals | null;
}

/**
 * Result of rbook_review — ≤4KB digest of project state for cold-start onboarding.
 *
 * Field surface is intentionally narrow: only fields a fresh agent needs to
 * decide what to do first. Anything not on this surface lives on the unchanged
 * rbook_agent_onboard payload for callers that need the long form.
 */
export interface RbookReviewResult {
  /** Top-3 ranked actions, promoted from rbook_agent_onboard.suggestedActions. */
  next_actions: NextAction[];

  /** Compact project identity. */
  project: {
    name: string;
    rbook_address: string;
    status: string | null;
    tier: string;
  };

  /**
   * s97-m14: a copy of a shared record: the digest's shared-record lines, or their short form, so a
   * client whose model reads this structured answer rather than the text sees the copy is shared.
   */
  sharedRecord?: string;

  /** Complete blocking and stranded copies, retained even when their list exceeds the typical budget. */
  recordProtocol?: RecordProtocolReview;

  /** Current sprint summary, focus capped to 280 chars. Null if none. */
  sprint: {
    id: string;
    title: string;
    status: string | null;
    focus: string | null;
    /** s84-m03: the sprint's own project_id — a foreign sprint's title/focus is framed. */
    projectId?: string | null;
    /**
     * s91-m07: `open` when the sprint's own status is an open status; `fallback` when the
     * read-side resolver named a Planned or Completed sprint because none was open. Derived from
     * `status`, so it is true by construction and needs no resolver change.
     */
    resolvedBy: 'open' | 'fallback';
  } | null;

  /** Project-only work queue. Cross-project status is explicitly excluded. */
  workQueue: {
    inProgress: WorkQueueBucket;
    current: WorkQueueBucket;
    queued: WorkQueueBucket;
    blocked: { count: number };
    nextAction: string;
  };

  /** Up to 5 most recent decisions in compact {text, createdAt} form. `projectId`
   *  carries genesis provenance so the renderer can frame a pull-merged FOREIGN
   *  decision (project_id != localProjectId) as untrusted (s83-m06). s92-m04: `id` lets the
   *  capped text be read in full with rbook_decisions(action="show"). */
  recentDecisions: Array<{
    id: number;
    text: string;
    createdAt: string;
    projectId: string | null;
    /**
     * s96-m02: the author's name, from onboard's own decision query, so the review issues no SQL
     * for it. Present only when someone other than this writer wrote the decision; decision show
     * and list carry every author and both readings for an unnamed one.
     */
    author?: string;
  }>;

  /**
   * s92-m04: up to 3 most recent active learnings, capped like decisions. Learnings never reached
   * the digest before. Trimmed first when the digest is over budget.
   */
  recentLearnings: Array<{
    id: number;
    text: string;
    createdAt: string;
    projectId: string | null;
  }>;

  /** s83-m06: the local project_id, so the renderer frames foreign recent decisions
   *  and foreign portfolio mission names. */
  localProjectId: string | null;

  /** s79-m06 — always-on cross-store portfolio rollup; null when degraded (≤1 project / fan-out failed). */
  portfolio: PortfolioSection | null;

  /** s80-m07 — self-capture gap, present ONLY when it fires (commits ahead of the last Reasonbook write). */
  selfCapture?: SelfCaptureGap;

  /**
   * s93-m11 — present only when rows the first-write staleness repair restored are marked stale
   * again. Only an older Reasonbook server writes 'stale' on its own, so one is still running. Read-only.
   */
  staleReflagged?: { count: number; lastRepair: string };

  /** Master-context freshness signal. */
  freshness: {
    lagDays: number;
    isStale: boolean;
  };

  /*
   * s87-m06 — `warnings` IS GONE FROM THIS TYPE. It was assigned `[]` exactly once and never
   * written to, so the field, the renderer branch that printed it and the size-trim stage that
   * sliced it were all operating on a list that could not have content. A published field that
   * has never carried a value is a promise the payload cannot keep.
   *
   * THE ENVELOPE CHANNEL IS UNAFFECTED and is where warnings actually travel:
   * `createSuccess(digest, reviewWarnings)` puts the filtered onboard warnings on the RESULT, and
   * `appendWarnings(lines, result)` renders them. Two different objects; only the data-level one
   * was dead.
   *
   * DELETED RATHER THAN POPULATED. Populating it would have shipped identical strings on two
   * channels of one answer, against a test whose whole point is that the two stay distinct — and
   * the digest measured 3995 of its 4096-byte budget live, so there was no room for a second copy
   * even if it had been desirable.
   */

  /** Build-freshness signal — present ONLY when stale=true (Sprint 67 m03).
   *  Closes the s65 retro footgun where missions were marked Complete against
   *  stale runtime code because nobody had rebuilt dist/. */
  buildFreshness?: BuildFreshnessReport;

  /**
   * s92-m01 — a registry default that exists but is not applied (written before 3.2.0 and never
   * re-confirmed). Present only then; resolution never uses such a default.
   */
  registryDefault?: string;

  /**
   * s92-m01 — the store this digest describes and how it was chosen. Carried INSIDE the digest
   * (rather than stamped on afterwards by the dispatcher) so the 4KB budget and
   * `digestSizeBytes` both account for them. Present when the dispatcher supplies `resolvedBy`.
   */
  projectRoot?: string | null;
  resolvedBy?: ResolvedBy;

  /** Self-reported payload size in bytes (matches Buffer.byteLength of JSON). */
  digestSizeBytes: number;
}

/**
 * Input schema for rbook_review.
 */
export const rbookReviewSchema = z
  .object({
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
  })
  // s86-m04: `.strict()` so the zod schema states what the published inputSchema has always
  // stated (additionalProperties: false), matching the other 12 tools. INERT AT RUNTIME — the
  // consolidated schemas are never parsed (src/index.ts casts every case), so this rejects
  // nothing previously accepted; it aligns the two declarations.
  .strict();

export type RbookReviewParams = z.infer<typeof rbookReviewSchema>;

/**
 * MCP tool definition for rbook_review.
 */
export const rbookReviewToolDefinition = {
  name: 'rbook_review',
  description:
    'Bundled session-opener digest (≤4KB). Replaces the older three-step opener (rbook_agent_onboard + rbook_context(action="view") + rbook_mission(action="status")) with one payload. Top-3 next_actions are promoted to a flat top-level field. Includes an always-on cross-store `portfolio` rollup (active missions and signals needing a person across your registered projects) built on the graph-backed queryAcrossStores; it degrades to null for a single-project setup.',
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/** Top-N applied to each work-queue bucket. */
const WORK_QUEUE_TOP_N = 3;

/** Top-N applied to next_actions (mission spec: "top-3 ranked next_actions"). */
const NEXT_ACTIONS_TOP_N = 3;

/** Hard cap on sprint focus length to keep the digest within budget. */
const SPRINT_FOCUS_CAP_CHARS = 280;

/** Hard cap on individual decision text length. */
const DECISION_TEXT_CAP_CHARS = 220;

/** Hard cap on mission name length for work-queue entries. */
const WORK_ITEM_NAME_CAP_CHARS = 80;

/** Maximum recent-decisions retained in the digest. */
const RECENT_DECISIONS_MAX = 5;

/** s92-m04: maximum recent learnings retained in the digest. */
const RECENT_LEARNINGS_MAX = 3;

/** Payload budget in bytes (mission spec). */
const DIGEST_BUDGET_BYTES = 4096;

/** s79-m06 — max active missions shown in the portfolio section (count is unbounded up to the fetch limit). */
const PORTFOLIO_TOP_N = 5;

/** s79-m06 — per-store fan-out cap for the portfolio active-missions count (bounded, latency-fenced). */
const PORTFOLIO_FETCH_LIMIT = 50;

/** Optional portfolio work stops admitting stores after one second; locked stores never wait. */
const PORTFOLIO_READ_BUDGET_MS = 1000;

/** s79-m06 — cap on a portfolio mission name (tighter than the local work-queue cap to protect the budget). */
const PORTFOLIO_MISSION_NAME_CAP_CHARS = 60;

/** s79-m06 — under-budget re-truncation cap for sprint.focus (trim stage 2). */
const SPRINT_FOCUS_TRIM_CAP_CHARS = 160;

/**
 * s80-m06 — a store with no new Reasonbook rows in more than this many days is "silent" (drift).
 *
 * s87-m03: "rows", not "writes". The signal is the newest `occurred_at` across the six domain
 * tables, read on the connection the portfolio fan-out already holds — not a file mtime, which
 * that same fan-out perturbs by opening the store.
 */
export const STALE_THRESHOLD_DAYS = 21;

/**
 * s81-m03 — a FRESH store whose local mtime is more than this many days ahead of its
 * persisted `last_synced_at` (last dashboard-converged push from THIS machine) is flagged
 * "local ahead of dashboard (unsynced)". Deliberately SHORTER than the 21d silent
 * threshold — this catches unpushed LOCAL work, a different axis from a dead store.
 * NULL `last_synced_at` (pre-v2 / never-pushed) = no-signal, so it never false-positives.
 */
const UNSYNCED_THRESHOLD_DAYS = 3;

/** s80-m06 — cap on the per-project drift list (top-N by ageDays) to bound digest bytes. */
const DRIFT_TOP_N = 8;

/** s80-m06 — cap on a drifting project's display name in the drift list. */
const DRIFT_NAME_CAP_CHARS = 30;

/** s97-m01 — cap on the other projects listed with signals that need a person. */
const SIGNALS_TOP_N = 8;

/**
 * Execute rbook_review.
 *
 * Calls rbook_agent_onboard and rbook_mission_status in parallel (both already
 * exist with their own SQL), then shapes the bundled output into a digest.
 * No new database queries are added by this tool.
 */
export async function rbookReview(
  params: RbookReviewParams = {},
  // s79-m06 — internal, NON-schema seam: an injectable ProjectGraphRegistry for
  // deterministic tests of the portfolio section. NOT exposed on the tool
  // inputSchema (it must never reach the MCP boundary).
  // s92-m01: `resolvedBy` is how the dispatcher chose this project, so the digest can carry it
  // inside its own budget. Also internal and non-schema.
  // s92-m04: the client's advertised roots and whether the caller named the project, so the
  // nested onboard does not call an unambiguous project ambiguous (the whoami nudge).
  internalOpts: {
    registry?: ProjectGraphRegistry;
    resolvedBy?: ResolvedBy;
    advertisedRoots?: readonly string[];
    callerProvidedProjectRoot?: boolean;
    /** s93-m01: no dashboard calls (the hook CLI's session start). Internal and non-schema. */
    offline?: boolean;
  } = {}
): Promise<RbookToolResult<RbookReviewResult>> {
  // s89-m08 — ONE schema-driven boundary guard, placed at the router entry so no handler can be
  // reached with a wrong-typed published string parameter. It reads this tool's OWN shipped
  // inputSchema, so it cannot drift from what is published. This tool is ACTION-LESS, so every
  // published string parameter applies. See param-type-guard.ts for the 714-triple measurement,
  // the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookReviewToolDefinition.inputSchema,
    undefined,
    params
  );
  if (wrongTypedParam) return createError<RbookReviewResult>(wrongTypedParam);

  // Direct callers do not pass through the MCP dispatcher, but this action-less tool is still
  // intrinsically read-classified. Establish the same request-local registration policy here so
  // its nested onboard/status client opens cannot infer write permission from an absent context.
  // Registered dispatch already supplies the context and skips this wrapper.
  if (currentToolCallActionMode() === undefined) {
    return (await captureToolCall('read', () => rbookReview(params, internalOpts))).value;
  }

  const projectRoot = params.projectRoot;

  const onboardPromise = rbookAgentOnboard({
    ...(projectRoot ? { projectRoot } : {}),
    ...(internalOpts.advertisedRoots ? { advertisedRoots: internalOpts.advertisedRoots } : {}),
    ...(internalOpts.callerProvidedProjectRoot !== undefined
      ? { callerProvidedProjectRoot: internalOpts.callerProvidedProjectRoot }
      : {}),
    ...(internalOpts.offline ? { offline: true } : {}),
  });

  const [
    onboardResult,
    missionStatusResult,
    buildFreshness,
    portfolio,
    ,
    registryDefault,
    recentLearningsRead,
    reflagged,
    sharedRecord,
  ] = await Promise.all([
    onboardPromise,
    rbookMissionStatus(
      projectRoot ? { projectRoot, includeBlocked: true } : { includeBlocked: true }
    ),
    onboardPromise.then((result) =>
      projectChecksBuildFreshness(result.data?.projectIdentity)
        ? resolveReviewFreshness(projectRoot)
        : null
    ),
    // s79-m06 — the always-on cross-store portfolio rollup (active missions across
    // the registered projects). Runs in the same parallel batch as onboard/status
    // so it adds no serial latency; latency-fenced to the active-missions query.
    // Degrades to null (never throws) on ≤1 project or fan-out failure.
    buildPortfolioSection(internalOpts.registry),
    // s69-m05 / s88-m08 — refresh last_seen_at only for an EXISTING registration.
    // A read-classified opener must not register a store it merely names; the first write or an
    // explicit rbook_project(register) owns that transition. Never throws or blocks the opener.
    touchProjectGraphRegistry(projectRoot),
    // s92-m01 — say when a registry default exists but is not applied. Never throws.
    readUnappliedDefaultNotice(internalOpts.registry),
    // s92-m04 — the learnings line. Never throws; a failed read leaves it empty.
    readRecentLearnings(projectRoot),
    // s93-m11 — rows the staleness repair restored that are stale again. Never throws.
    readReflaggedSinceRepair(projectRoot),
    // s97-m14 — a copy of a shared record: the digest's shared-record lines. Never throws.
    readSharedRecordText(projectRoot),
  ]);

  if (!onboardResult.success || !onboardResult.data) {
    return {
      success: false,
      error: onboardResult.error ?? {
        code: 'DB_QUERY_FAILED',
        message: 'rbook_review failed to gather onboarding data',
      },
    };
  }

  const onboard = onboardResult.data;
  const missionStatus =
    missionStatusResult.success && missionStatusResult.data ? missionStatusResult.data : null;

  // s84-m05: build-freshness is a build-tier concern — a general/managed project has no `dist/`
  // to keep fresh, so the "rebuild before working" nudge is noise there. Gate on the
  // already-fetched projectType (no extra query); the probe already ran in the parallel batch
  // above — we simply suppress its result for non-build tiers. The local store defaults to
  // 'build', so it keeps the signal.
  const gatedBuildFreshness = onboard.project.projectType === 'build' ? buildFreshness : null;

  const portfolioSection = portfolioWithSignals(
    portfolio,
    onboard.localProjectId ?? null,
    projectRoot ?? null
  );
  const digest = buildDigest(onboard, missionStatus, gatedBuildFreshness, portfolioSection, {
    registryDefault,
    recentLearnings: recentLearningsRead,
    reflagged,
    resolution: internalOpts.resolvedBy
      ? { projectRoot: projectRoot ?? null, resolvedBy: internalOpts.resolvedBy }
      : null,
    // As a write would resolve it: a joined copy's invite name, else the user's (s96-m13, #671).
    writer: writerName(projectRoot ?? null),
    sharedRecord: sharedRecord?.text,
    recordProtocol: sharedRecord?.protocol,
  });

  // Filter to auth + sync warnings only. Drop staleness/orphan/context-size
  // warnings — those live on the long-form rbook_agent_onboard payload.
  const reviewWarnings = filterReviewWarnings(onboardResult.warnings ?? []);
  if (sharedRecord?.warning) reviewWarnings.push(sharedRecord.warning);

  return createSuccess(digest, reviewWarnings);
}

/**
 * Assemble the digest from the two bundled handler outputs, applying caps to
 * keep the JSON-serialized payload within the 4KB budget.
 */
function buildDigest(
  onboard: RbookAgentOnboardResult,
  missionStatus: import('./rbook-mission-status').RbookMissionStatusResult | null,
  buildFreshness: BuildFreshnessReport | null,
  portfolio: PortfolioSection | null,
  extras: {
    registryDefault: string | null;
    recentLearnings?: ReadonlyArray<{
      id: number;
      text: string;
      createdAt: string;
      projectId: string | null;
    }>;
    resolution: { projectRoot: string | null; resolvedBy: ResolvedBy } | null;
    reflagged?: { count: number; lastRestoredAt: string } | null;
    /** s96-m02: the name this project's writes stamp now, whose decisions need no author. */
    writer?: string | null;
    /** s97-m14: the digest's shared-record lines for a copy of a shared record. */
    sharedRecord?: string | null;
    recordProtocol?: RecordProtocolReview;
  } = { registryDefault: null, resolution: null }
): RbookReviewResult {
  const sprintFocus = onboard.currentSprint?.focus
    ? truncate(onboard.currentSprint.focus, SPRINT_FOCUS_CAP_CHARS)
    : null;

  const sprint = onboard.currentSprint
    ? {
        id: onboard.currentSprint.id,
        title: onboard.currentSprint.title,
        status: onboard.currentSprint.status,
        focus: sprintFocus,
        projectId: onboard.currentSprint.projectId ?? null,
        resolvedBy: isOpenStatus(onboard.currentSprint.status)
          ? ('open' as const)
          : ('fallback' as const),
      }
    : null;

  // Pull rbook_address from the project_identity row when present; fall back to
  // local-only sentinel so the field is never null/empty (rbook_status uses the
  // same convention — see src/tools/rbook/rbook-status.ts).
  const rbookAddress = normalizeAddress(onboard.projectIdentity?.rbook_address ?? null);

  const project = {
    name: onboard.project.name,
    rbook_address: rbookAddress,
    status: onboard.project.status,
    tier: onboard.project.projectType,
  };

  // Bucket work queue. Prefer rbook_mission_status when available — it gives
  // us proper full buckets per status. Fall back to rbook_agent_onboard's
  // pendingMissions (which mixes In Progress + Current + Queued under a
  // single LIMIT 5 cap) when mission-status fails.
  const workQueue = missionStatus
    ? bucketFromMissionStatus(missionStatus)
    : bucketFromOnboardFallback(onboard);
  // s92-m06: a general-tier project has no missions or sprints (rbook-seed/tiers/general.md), so
  // an empty queue prescribes nothing to it; the text answer also omits the queue lines.
  if (project.tier === 'general' && workQueueIsEmpty(workQueue)) {
    workQueue.nextAction = GENERAL_TIER_IDLE;
  }

  // Recent decisions trimmed to compact form. rbook_agent_onboard already
  // ordered by created_at DESC and LIMIT 10 — we slice to 5 and drop domain.
  // s96-m02: a decision names its author only when someone other than this writer wrote it. In
  // a solo project that is never; in a shared one it is the name worth the digest's bytes.
  const recentDecisions = onboard.recentDecisions.slice(0, RECENT_DECISIONS_MAX).map((d) => ({
    id: d.id,
    text: truncate(d.decision, DECISION_TEXT_CAP_CHARS),
    createdAt: d.createdAt,
    projectId: d.projectId,
    ...(d.author !== AUTHOR_BEFORE_RECORDED &&
    d.author !== AUTHOR_NOT_RECORDED &&
    d.author !== extras.writer
      ? { author: d.author }
      : {}),
  }));

  const freshness = {
    lagDays: onboard.contextFreshness.lagDays ?? 0,
    isStale: onboard.contextFreshness.isStale,
  };

  // Promote top-3 suggestedActions to a flat top-level next_actions array.
  // suggestedActions is already priority-sorted by the onboard handler.
  // s92-m04: never an onboard-only action (it points at a field this digest does not have); a
  // fresh project instead gets the action that does exist here: run the onboard flow.
  const reviewActions = [
    ...(onboard.freshProject
      ? [
          {
            action: 'Fresh project: rbook_agent_onboard walks the first-session setup',
            command: 'rbook_agent_onboard()',
            priority: 0,
          },
        ]
      : []),
    ...onboard.suggestedActions.filter((a) => a.scope !== 'onboard'),
  ];
  const promotedActions = reviewActions.slice(0, NEXT_ACTIONS_TOP_N).map((a) => ({
    action: a.action,
    command: a.command,
    priority: a.priority,
  }));

  // Insert a priority-1 build-freshness entry above the existing actions when stale.
  // Top-N cap is reapplied so the array still respects NEXT_ACTIONS_TOP_N.
  //
  // Build-freshness is ADVISORY ON BOTH SURFACES. The s70-m02 wording here promised that the
  // same condition was ENFORCED at rbook_sprint(action='complete') and that close "now blocks on
  // this"; the s74 review retired that gate, and rbook-sprint-complete.ts states plainly that
  // staleness "is now surfaced as a warning after the work completes ... never as a block".
  // The two surfaces still describe ONE condition — they just both describe it as advice.
  const next_actions = buildFreshness?.stale
    ? [
        {
          // s86-m05: ONE wording for both situations a reader can be in. `npm run build` only
          // exists in a source checkout — package.json files[] ships dist/, not scripts/ or the
          // build toolchain — so an unconditional "run npm run build" is an instruction a
          // consumer of the published package cannot follow. Name the packaged case too.
          action:
            buildFreshness.reason === 'dist-missing'
              ? 'build output missing — rebuild from source (npm run build) or reinstall the package before starting work'
              : 'build output is behind src/ — rebuild from source (npm run build) or reinstall the package before starting fresh sessions',
          command: 'npm run build',
          priority: 1,
        },
        ...promotedActions,
      ].slice(0, NEXT_ACTIONS_TOP_N)
    : promotedActions;

  // Assemble — digestSizeBytes is computed after the rest of the body is in
  // place so the byte-count reflects the serialized final shape.
  const draft: RbookReviewResult = {
    next_actions,
    project,
    ...(extras.sharedRecord ? { sharedRecord: extras.sharedRecord } : {}),
    ...(extras.recordProtocol ? { recordProtocol: extras.recordProtocol } : {}),
    sprint,
    workQueue,
    recentDecisions,
    recentLearnings: (extras.recentLearnings ?? []).slice(0, RECENT_LEARNINGS_MAX).map((l) => ({
      ...l,
      text: truncate(l.text, DECISION_TEXT_CAP_CHARS),
    })),
    localProjectId: onboard.localProjectId ?? null,
    portfolio,
    freshness,
    digestSizeBytes: 0,
  };

  if (buildFreshness?.stale) {
    draft.buildFreshness = buildFreshness;
  }

  // s80-m07 — surface the self-capture gap via the structured path (NOT the warning
  // string, which filterReviewWarnings drops). The `selfCapture` struct + the
  // formatReviewForLLM line are the GUARANTEED surfaces; the priority-2 action also
  // rides in via onboard.suggestedActions → next_actions when it ranks in the top-3.
  if (onboard.selfCapture?.fires) {
    draft.selfCapture = onboard.selfCapture;
  }

  if (extras.registryDefault) {
    draft.registryDefault = extras.registryDefault;
  }
  if (extras.reflagged && extras.reflagged.count > 0) {
    draft.staleReflagged = {
      count: extras.reflagged.count,
      lastRepair: extras.reflagged.lastRestoredAt.slice(0, 10),
    };
  }
  if (extras.resolution) {
    draft.projectRoot = extras.resolution.projectRoot;
    draft.resolvedBy = extras.resolution.resolvedBy;
  }

  return finishDigest(draft);
}

/**
 * The digest trimmed to its budget, with its size stamped. Exported for its tests (s97-m01), which
 * drive the trim order and the budget's edge on built digests.
 */
export function finishDigest(draft: RbookReviewResult): RbookReviewResult {
  const trimmed = trimToBudget(draft);

  // Iterative convergence on digestSizeBytes. The field self-reports the size
  // of the serialized JSON, but stamping the number changes the digit width
  // (e.g. "0" → "1945") which itself shifts the byte count. Loop until the
  // stamped value matches the post-stamp serialization length. Converges in
  // ≤3 iterations in practice.
  trimmed.digestSizeBytes = Buffer.byteLength(JSON.stringify(trimmed), 'utf8');
  for (let i = 0; i < 5; i++) {
    const measured = Buffer.byteLength(JSON.stringify(trimmed), 'utf8');
    if (measured === trimmed.digestSizeBytes) break;
    trimmed.digestSizeBytes = measured;
  }

  return trimmed;
}

/**
 * Resolve the project root for the build-freshness probe. Returns null on any
 * resolution failure so the parallel Promise.all keeps the happy path intact —
 * rbook_review never blocks on the freshness check.
 */
async function resolveReviewFreshness(
  explicitRoot: string | undefined
): Promise<BuildFreshnessReport | null> {
  let root = explicitRoot;
  if (!root) {
    try {
      const resolution = await resolveProjectRootEnhanced(undefined, {
        autoRegister: false,
        silent: true,
      });
      root = resolution.projectRoot;
    } catch {
      return null;
    }
  }
  try {
    return await checkBuildFreshness(root);
  } catch {
    return null;
  }
}

/** Shared-record lines and protocol status; unshared stores omit them, failed reads warn. */
async function readSharedRecordText(
  projectRoot: string | undefined
): Promise<{ text: string | null; protocol?: RecordProtocolReview; warning?: string } | null> {
  try {
    const read = await withClientAsync(
      async (client) => {
        const review = sharedRecordReview(client);
        return createSuccess({ text: sharedRecordText(review), protocol: review?.protocol });
      },
      projectRoot ? { projectRoot } : {}
    );
    if (!read.success) throw new Error(read.error?.message ?? 'Could not open the record.');
    return read.data ?? null;
  } catch (error) {
    return {
      text: null,
      warning: `Shared-record review, including protocol status, could not be read: ${error instanceof Error ? error.message : String(error)}. Retry rbook_review; resolve the reported error if it persists.`,
    };
  }
}

/**
 * s92-m04 — the newest active learnings for the digest's learnings line. Swallows every error and
 * answers [] (an empty line is honest; a failed opener is not).
 */
async function readRecentLearnings(
  projectRoot: string | undefined
): Promise<Array<{ id: number; text: string; createdAt: string; projectId: string | null }>> {
  try {
    const read = await withClientAsync(
      async (client) => {
        const projExpr = tableHasColumn(client, 'learnings', 'project_id') ? 'project_id' : 'NULL';
        const rows = client.getMany<{
          id: number;
          content: string;
          created_at: string;
          project_id: string | null;
        }>(
          `SELECT id, content, created_at, ${projExpr} AS project_id FROM learnings
            WHERE status = 'active' ORDER BY julianday(created_at) DESC, id DESC LIMIT ?`,
          [RECENT_LEARNINGS_MAX]
        );
        return createSuccess(
          rows.success && rows.data
            ? rows.data.map((r) => ({
                id: r.id,
                text: r.content,
                createdAt: r.created_at,
                projectId: r.project_id,
              }))
            : []
        );
      },
      projectRoot ? { projectRoot } : {}
    );
    return read.success && read.data ? read.data : [];
  } catch {
    return [];
  }
}

/**
 * s93-m11 — how many rows the first-write staleness repair restored are marked stale again, from
 * the repair's ledger. Read-only; null when no repair ever ran or the read failed.
 */
async function readReflaggedSinceRepair(
  projectRoot: string | undefined
): Promise<{ count: number; lastRestoredAt: string } | null> {
  try {
    const read = await withClientAsync(
      async (client) => createSuccess(countReflaggedSinceRepair(client)),
      projectRoot ? { projectRoot } : {}
    );
    return read.success && read.data ? read.data : null;
  } catch {
    return null;
  }
}

/**
 * s92-m01 — the "registry default: X — not applied" line, or null. Reads the injected registry in
 * tests, else the per-user graph. Swallows every error: a registry hiccup never breaks the opener.
 */
async function readUnappliedDefaultNotice(
  registry: ProjectGraphRegistry | undefined
): Promise<string | null> {
  try {
    const graph = registry ?? (await ProjectGraphRegistry.create());
    return unappliedDefaultNotice(graph.getDefaultStatus());
  } catch {
    return null;
  }
}

/**
 * Record the current project's `last_seen_at` in the per-user project-graph
 * registry (s69-m05) when it is already registered. Since s88-m08, this read-classified opener
 * never creates the selected project's registration. The bookkeeping result never enters the
 * digest. Resolves the project root the same way the freshness probe does (explicit param, else
 * `resolveProjectRootEnhanced` with auto-register off so this path neither registers nor touches
 * a project row; opening the graph may still ensure its own schema).
 * Swallows every error: registry bookkeeping must never break the session opener.
 */
async function touchProjectGraphRegistry(explicitRoot: string | undefined): Promise<void> {
  // s78-m04: suppress this intentional per-user graph bookkeeping under the review role. This is
  // deliberately call-scoped; it does not claim every nested compatibility read is physically
  // write-free (see the action-taxonomy contract).
  if (isReadOnlyAgentSession()) return;
  try {
    let root = explicitRoot;
    if (!root) {
      const resolution = await resolveProjectRootEnhanced(undefined, {
        autoRegister: false,
        silent: true,
      });
      root = resolution.projectRoot;
    }
    const graph = await ProjectGraphRegistry.create();
    const projectId = graph.getByStorePath(root);
    if (projectId) graph.touch(projectId);
  } catch {
    // Best-effort — the project-graph registry is an additive discovery index.
  }
}

/**
 * s79-m06 — build the always-on cross-store portfolio section. Discovers stores
 * via the graph registry (injectable for tests) and merges active missions across
 * the portfolio through `activeMissionsAcrossProjects` (§5.4 query b — that helper owns its
 * own SQL; the per-store content probe s87-m03 adds runs on the connection this fan-out already
 * opens, within the cost fence #1016 set in place of #671's retired no-new-SQL proxy). Graceful degrade: returns null when the registry lists ≤1 active
 * project (a portfolio rollup is meaningless for one project) OR when the whole
 * fan-out throws. Latency-fenced: the single active-missions query only.
 */
/** s80-m06 — return a store file's mtime in Unix ms, or null if it can't be stat'd. */
export type StoreStatFn = (filePath: string) => number | null;

const defaultStoreStatFn: StoreStatFn = (filePath) => {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * The newest mtime (Unix ms) across a store's `rbook.sqlite` + `-wal` sidecar, or null.
 *
 * s87-m03 — THIS IS NO LONGER THE FRESHNESS SIGNAL, and it must not become one again.
 *
 * It was, and it was wrong in both directions. The mechanism: this function takes
 * `max(base, base-wal)`, and SQLite CREATES the `-wal` sidecar on any open of a WAL database.
 * `rbook_review`'s own cross-store fan-out opens every store microseconds before this function
 * stats it — so the instrument manufactured the evidence it then read as proof of freshness.
 * Live consequence: `portfolio/cmos-mcp` classified FRESH on a store whose durable content had
 * not moved in months.
 *
 * AND DROPPING THE `-wal` LEG DOES NOT FIX IT. Base mtime lies too, measured: The Academy Web's
 * base read 47.97d against a newest row of 105.27d; Project History's read 16.18d against a true
 * 26.94d. A file's mtime is not a claim about the rows inside it.
 *
 * What survives here are the two uses it is still honest for: the `ageDays` shown beside an
 * UN-MIGRATED store, whose rows cannot be read at all, and the s81-m03 unsynced overlay, which
 * compares local mtime against a persisted push timestamp — a file-vs-file comparison, where a
 * file timestamp is the right unit. The SILENCE decision now comes from the content probe.
 */
function storeMtimeMs(storePath: string, statFn: StoreStatFn): number | null {
  const base = resolveRecordPaths(storePath).dbPath;
  let newest = 0;
  for (const p of [base, `${base}-wal`]) {
    const mtime = statFn(p);
    if (mtime !== null && mtime > newest) newest = mtime;
  }
  return newest === 0 ? null : newest;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

function storeAgeDays(storePath: string, statFn: StoreStatFn, nowMs: number): number | null {
  const mtime = storeMtimeMs(storePath, statFn);
  return mtime === null ? null : (nowMs - mtime) / MS_PER_DAY;
}

/**
 * s87-m03 (#529) — the six domain tables whose newest row stamp defines "this store has had
 * activity". Chosen because they are what a Reasonbook store's own tools write; a store none of these
 * has touched in N days is silent in the sense the reason string claims.
 */
const DRIFT_PROBE_TABLES = [
  'missions',
  'sprints',
  'sessions',
  'learnings',
  'strategic_decisions',
  'next_steps',
] as const;

/**
 * s87-m03 (#529) — the newest `occurred_at` across the six domain tables, in Unix ms, or null.
 *
 * THIS IS THE FRESHNESS SIGNAL. It reads the content the drift reason string has always claimed
 * to describe, on the connection the fan-out already holds — no new open, no new connection, no
 * network, which is exactly the cost fence decision #1016 put in place of #671's syntax fence.
 *
 * COLUMN-GUARDED BY `PRAGMA table_info`, AND THAT GUARD IS A FIXTURE, NOT A HOPE. Synthesis
 * Workbench's `next_steps` has no `occurred_at` column at all — one real gap in 19 readable
 * stores — and a store may be missing a table outright. Either case skips that table rather than
 * throwing, because a single missing column must not cost the whole probe.
 *
 * Returns null when NO table yielded a stamp. That is not "fresh" and not "silent": it is
 * "unknown", and the caller renders it as unknown rather than guessing.
 */
export function newestRowStampMs(db: Database.Database): number | null {
  let newest: number | null = null;
  for (const table of DRIFT_PROBE_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
    if (!columns.some((c) => c.name === 'occurred_at')) continue;
    const row = db.prepare(`SELECT MAX(occurred_at) AS newest FROM ${table}`).get() as
      | { newest?: unknown }
      | undefined;
    const value = typeof row?.newest === 'number' ? row.newest : null;
    if (value !== null && (newest === null || value > newest)) newest = value;
  }
  return newest;
}

/**
 * s93-m11 (#606 e) — the drift probe: the newest row stamp, or `'no-history'` when none of the six
 * domain tables holds a row yet. A brand-new project has nothing that could have gone quiet, so
 * it is neither silent nor of unknown freshness; it used to show as drifting the moment a second
 * project was registered.
 */
export function driftContentProbe(db: Database.Database): number | null | 'no-history' {
  const newest = newestRowStampMs(db);
  if (newest !== null) return newest;
  for (const table of DRIFT_PROBE_TABLES) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (exists && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return null;
  }
  return 'no-history';
}

/** s80-m06 — the strict reachability partition + the drift list. */
export interface DriftPartition {
  reachable: number;
  silent: number;
  unmigrated: number;
  unreadable: number;
  drift: PortfolioDrift | null;
}

/**
 * s80-m06 — classify every queried store into the strict partition and build the
 * per-project drift list, consuming ONLY existing outputs (`registry.list()` +
 * `fanout.errors`) plus `fs.stat` on each store file, and — since s87-m03 — the per-store content
 * probe the fan-out ran on the connection it already held. No new store opens, no new
 * connections, no network: the cost fence #1016 put in place of #671's retired no-new-SQL proxy. A store is:
 *   - `unmigrated` — failed with "no such column" (its missions table predates the s79
 *      per-row rebuild) → drift item with a backfill hint;
 *   - `unreadable` — failed otherwise (moved/locked/I/O; classified transient);
 *   - `silent`     — succeeded but its store mtime is > `STALE_THRESHOLD_DAYS` old → drift;
 *   - `reachable`  — succeeded ∧ fresh.
 * By construction `reachable + silent + unmigrated + unreadable === stores.length`.
 * The drift list is capped top-N by `ageDays` desc to bound digest bytes.
 *
 * s81-m03 — additionally OVERLAYS an "unsynced" drift signal: a FRESH (reachable) store
 * whose local mtime is > {@link UNSYNCED_THRESHOLD_DAYS} ahead of its persisted
 * `last_synced_at` (last dashboard-converged push from THIS machine) gets an extra drift
 * ITEM. This is orthogonal to the partition — an unsynced store is still counted
 * `reachable`, so the 4 buckets still sum to `stores.length`. NULL `last_synced_at`
 * (pre-v2 / never-pushed-from-here) = no-signal (never a false positive). Machine-local
 * scope by construction — it flags THIS machine's unpushed work, not another machine's.
 */
export function deriveDrift(
  stores: ReadonlyArray<{
    project_id: string;
    store_path: string;
    name: string;
    last_synced_at?: number | null;
  }>,
  errors: ReadonlyArray<{ projectId: string; error: string }>,
  statFn: StoreStatFn,
  nowMs: number,
  /**
   * s87-m03 — THE FRESHNESS SIGNAL, keyed by `project_id`: the newest row stamp the fan-out's
   * probe read on the connection it already held. A store absent from this map, or mapping to
   * `null`, has no readable row stamps and is reported as freshness-unknown.
   *
   * REQUIRED, NOT OPTIONAL, and that is FORK-1b's ruling made structural. An optional parameter
   * would leave a second code path that decides silence from file mtime while printing the
   * sentence "no new Reasonbook rows in Nd" — a reason string describing a mechanism that did not
   * produce it, which is precisely the defect this mission exists to close, reintroduced inside
   * the fix for it. There is one mechanism here, so there is one sentence.
   */
  contentStamps: ReadonlyMap<string, number | null | 'no-history'>
): DriftPartition {
  const errorById = new Map(errors.map((e) => [e.projectId, e.error]));
  let reachable = 0;
  let silent = 0;
  let unmigrated = 0;
  let unreadable = 0;
  const items: PortfolioDriftItem[] = [];

  for (const store of stores) {
    const name = truncate(store.name, DRIFT_NAME_CAP_CHARS);
    const err = errorById.get(store.project_id);
    if (err !== undefined) {
      if (/no such column/i.test(err)) {
        unmigrated++;
        items.push({
          projectId: store.project_id,
          name,
          reason: 'un-migrated (missions table predates the per-row rebuild)',
          ageDays: Math.round(storeAgeDays(store.store_path, statFn, nowMs) ?? 0),
          hint: 'run rbook_db backfill/rebuild',
        });
      } else {
        // moved / locked / I/O / unknown → transient, classified defensively.
        unreadable++;
      }
      continue;
    }
    // Succeeded. `mtimeMs` is still read, but ONLY for the s81-m03 unsynced overlay below —
    // never for the silence decision. See `storeMtimeMs`'s docblock for why.
    const mtimeMs = storeMtimeMs(store.store_path, statFn);

    // s87-m03 — FRESHNESS FROM CONTENT, and from nothing else. The fan-out that would perturb
    // the mtime is the same call that produced this stamp, and a row stamp is not perturbed by
    // being read.
    const probed = contentStamps.get(store.project_id) ?? null;
    if (probed === 'no-history') {
      // s93-m11 (#606 e): a project with no rows yet has not drifted; it is simply reachable.
      reachable++;
      continue;
    }
    const contentMs = probed;
    const age = contentMs === null ? null : (nowMs - contentMs) / MS_PER_DAY;

    if (contentMs === null) {
      // FORK-1b — NO MTIME FALLBACK. A fallback here could only ever say "fresh": `deriveDrift`
      // runs after the fan-out has already touched every `-wal`, so every mtime it could read is
      // ~now by construction. A labelled fallback describing a signal the caller has already
      // destroyed would be this sprint's defect class inside this sprint's own fix.
      //
      // The store stays counted `reachable` — it IS reachable, the fan-out read it — so #920's
      // strict partition still sums to `stores.length`. What it gets is a drift ITEM saying the
      // freshness is unknown and why, in the same overlay shape s81-m03 uses for "unsynced". It
      // is never reported as silent, and never asserted fresh.
      reachable++;
      items.push({
        projectId: store.project_id,
        name,
        reason:
          'freshness unknown — no readable row stamps; file mtime is not usable here because ' +
          'this call opened the store',
        ageDays: 0,
      });
      continue;
    }

    if (age !== null && age > STALE_THRESHOLD_DAYS) {
      silent++;
      items.push({
        projectId: store.project_id,
        name,
        // s87-m03 (FORK-2) — the sentence says ROWS because the probe measures rows: the newest
        // INSERT stamp across six domain tables. It does not observe writes, so it may not claim
        // to. Making the sentence true is cheaper than making the mechanism match a sentence
        // nobody validated.
        reason: `no new Reasonbook rows in ${Math.round(age)}d`,
        ageDays: Math.round(age),
      });
    } else {
      reachable++;
      // s81-m03: "unsynced" overlay — a FRESH store with local work newer than its last
      // dashboard-converged push (from THIS machine) by more than the threshold. Extra
      // drift ITEM only; the store stays counted `reachable` (partition sum unchanged).
      // NULL last_synced_at = no-signal (never-pushed-from-here); no false positive.
      const lastSynced = store.last_synced_at ?? null;
      if (lastSynced !== null && mtimeMs !== null) {
        const unsyncedDays = (mtimeMs - lastSynced) / MS_PER_DAY;
        if (unsyncedDays > UNSYNCED_THRESHOLD_DAYS) {
          items.push({
            projectId: store.project_id,
            name,
            reason: `local ahead of dashboard by ${Math.round(unsyncedDays)}d (unsynced; this machine)`,
            ageDays: Math.round(unsyncedDays),
          });
        }
      }
    }
  }

  items.sort((a, b) => b.ageDays - a.ageDays);
  const drift: PortfolioDrift | null = items.length
    ? { staleThresholdDays: STALE_THRESHOLD_DAYS, stale: items.slice(0, DRIFT_TOP_N) }
    : null;
  return { reachable, silent, unmigrated, unreadable, drift };
}

/** s97-m01 — what the fan-out reads on each store's connection; each half fails on its own. */
interface PortfolioProbe {
  /** null when no stamp could be read, which deriveDrift reports as freshness unknown. */
  readonly drift: ReturnType<typeof driftContentProbe>;
  /** null when the signals could not be computed; `failed` when one of them could not be read. */
  readonly signals: ReturnType<typeof personSignalsOf> | null;
}

/** A store the portfolio names, by registry id and folder, so this project is left out by either. */
interface PortfolioStore {
  readonly projectId: string;
  readonly storePath: string;
}

/** The section as the fan-out read it, and every store's person-needing counts, this one's included. */
interface PortfolioRead {
  readonly section: Omit<PortfolioSection, 'signals'>;
  readonly people: ReadonlyArray<PortfolioSignalsItem & { readonly storePath: string }>;
  /** The stores whose signals could not be read, whether the store or a signal failed. */
  readonly unread: readonly PortfolioStore[];
}

function driftOrUnknown(db: Database.Database): ReturnType<typeof driftContentProbe> {
  try {
    return driftContentProbe(db);
  } catch {
    return null; // freshness unknown, exactly as a store whose probe failed before s97-m01
  }
}

function personSignalsOrNull(
  db: Database.Database,
  store: Parameters<typeof personSignalsOf>[1],
  nowMs: number
): ReturnType<typeof personSignalsOf> | null {
  try {
    return personSignalsOf(db, store, nowMs, process.env);
  } catch {
    return null; // counted as unread in the section, never as none
  }
}

async function buildPortfolioSection(
  registryOverride?: ProjectGraphRegistry,
  statFn: StoreStatFn = defaultStoreStatFn,
  nowMs: number = Date.now()
): Promise<PortfolioRead | null> {
  try {
    const registry = registryOverride ?? (await ProjectGraphRegistry.create());
    const stores = registry.list();
    if (stores.length <= 1) return null; // single-project → degrade

    const fanout = await activeMissionsAcrossProjects<PortfolioProbe>({
      limit: PORTFOLIO_FETCH_LIMIT,
      registry,
      timeoutMs: 0,
      deadlineAtMs: Date.now() + PORTFOLIO_READ_BUDGET_MS,
      // s87-m03 (#529) — read the CONTENT on the connection the fan-out already opens. This is
      // the whole fix: the drift signal stops being a file mtime that this very call creates.
      // s97-m01 — the person-needing signals are read on the same connection.
      perStoreProbe: (db, store) => ({
        drift: driftOrUnknown(db),
        signals: personSignalsOrNull(db, store, nowMs),
      }),
    });
    const meta = fanout.metadata;
    // s80-m06: strict partition + drift over the SAME store set the fan-out queried.
    // s87-m03: probe values keyed by project_id. `probeErrors` are deliberately NOT merged into
    // `fanout.errors` — a failed optional probe must not reclassify a readable store as
    // unreadable — so a store whose probe threw simply has no entry here and lands on the
    // "freshness unknown" path.
    const contentStamps = new Map(fanout.probes.map((p) => [p.projectId, p.value.drift]));
    const partition = deriveDrift(stores, fanout.errors, statFn, nowMs, contentStamps);
    const byId = new Map(stores.map((store) => [store.project_id, store]));
    const storeOf = (projectId: string): PortfolioStore => ({
      projectId,
      storePath: byId.get(projectId)?.store_path ?? '',
    });
    const people: Array<PortfolioSignalsItem & { storePath: string }> = [];
    // A store the fan-out could not query, or whose probe failed, has no signals read either.
    const unread: PortfolioStore[] = [...fanout.errors, ...fanout.probeErrors].map((error) =>
      storeOf(error.projectId)
    );
    for (const probe of fanout.probes) {
      const signals = probe.value.signals;
      if (signals === null || signals.failed) unread.push(storeOf(probe.projectId));
      if (signals && Object.keys(signals.counts).length)
        people.push({
          ...storeOf(probe.projectId),
          name: truncate(
            projectDisplayName(storeOf(probe.projectId).storePath, byId.get(probe.projectId)?.name),
            DRIFT_NAME_CAP_CHARS
          ),
          ...signals.counts,
        });
    }
    const section = {
      projects: stores.length,
      reachable: partition.reachable,
      silent: partition.silent,
      unmigrated: partition.unmigrated,
      unreadable: partition.unreadable,
      activeMissions: {
        count: fanout.results.length,
        top: fanout.results.slice(0, PORTFOLIO_TOP_N).map((m) => ({
          id: m.id,
          name: truncate(m.name, PORTFOLIO_MISSION_NAME_CAP_CHARS),
          projectId: m.project_id,
        })),
      },
      fanInP95Ms: Math.round(meta.perStoreP95Ms ?? meta.overallMs),
      drift: partition.drift,
    };
    return { section, people, unread };
  } catch {
    return null; // fan-out failed → degrade, never break the opener
  }
}

const personTotal = (item: PersonSignals): number =>
  (item.drafts ?? 0) + (item.lapsing ?? 0) + (item.blocked ?? 0) + (item.conflicts ?? 0);

/** A folder as the file system names it, so one store under two spellings is one store. */
function realFolder(folder: string): string {
  try {
    return realpathSync.native(folder);
  } catch {
    return path.resolve(folder);
  }
}

/**
 * s97-m01 — the section the digest carries: the other projects' person-needing counts, most
 * first, without this project's own (its digest already carries them). This project is known by
 * its id and, when the caller named it, its folder: a registry row keeps its id when the store is
 * re-keyed, so the id alone could list this project as another.
 */
export function portfolioWithSignals(
  read: PortfolioRead | null,
  localProjectId: string | null,
  localRoot: string | null = null
): PortfolioSection | null {
  if (!read) return null;
  const local = localRoot ? realFolder(localRoot) : null;
  const isLocal = (store: PortfolioStore): boolean =>
    store.projectId === localProjectId ||
    (local !== null && store.storePath !== '' && realFolder(store.storePath) === local);
  const others = read.people
    .filter((item) => !isLocal(item))
    .sort(
      (a, b) =>
        personTotal(b) - personTotal(a) ||
        (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0)
    )
    .map(({ storePath: _storePath, ...item }) => item);
  const unread = new Set(read.unread.filter((store) => !isLocal(store)).map((s) => s.projectId))
    .size;
  const signals: PortfolioSignals | null =
    others.length || unread
      ? {
          projects: others.length,
          top: others.slice(0, SIGNALS_TOP_N),
          ...(unread ? { unread } : {}),
        }
      : null;
  return { ...read.section, signals };
}

/**
 * Trim the digest in stages until it fits the 4KB budget (s79-m06 F9 order). The
 * NEW cross-store portfolio signal is the point of this digest, so it is trimmed
 * LAST: recentLearnings → recentDecisions → sprint.focus → workQueue tops →
 * portfolio.activeMissions.top (5→3→0) → portfolio.drift.stale → portfolio.signals.top →
 * portfolio=null. Everything cheaper and more local is sacrificed before the portfolio
 * rollup degrades, and what needs a person elsewhere (s97-m01) is its last list to go.
 */
function trimToBudget(digest: RbookReviewResult): RbookReviewResult {
  // s97-m01: measured with the size field at its final width (four digits under the 4,096-byte
  // budget), not the 0 it holds here; stamping the size afterwards used to add up to 3 bytes.
  const measure = (d: RbookReviewResult): number =>
    Buffer.byteLength(JSON.stringify({ ...d, digestSizeBytes: 9999 }), 'utf8');

  let current = digest;
  let size = measure(current);

  // Stage 0 (s92-m04): drop recentLearnings one at a time, before any decision.
  while (size > DIGEST_BUDGET_BYTES && current.recentLearnings.length > 0) {
    current = { ...current, recentLearnings: current.recentLearnings.slice(0, -1) };
    size = measure(current);
  }

  // Stage 1: drop recentDecisions one at a time (largest existing field).
  while (size > DIGEST_BUDGET_BYTES && current.recentDecisions.length > 0) {
    current = { ...current, recentDecisions: current.recentDecisions.slice(0, -1) };
    size = measure(current);
  }

  // Stage 2: re-truncate sprint.focus to a tighter cap.
  if (
    size > DIGEST_BUDGET_BYTES &&
    current.sprint?.focus &&
    current.sprint.focus.length > SPRINT_FOCUS_TRIM_CAP_CHARS
  ) {
    current = {
      ...current,
      sprint: {
        ...current.sprint,
        focus: truncate(current.sprint.focus, SPRINT_FOCUS_TRIM_CAP_CHARS),
      },
    };
    size = measure(current);
  }

  // s87-m06 — Stage 3 ("drop warnings") is GONE. It sliced a list that was assigned `[]` once
  // and never written, so it could only ever remove nothing: a trim stage that could not trim.
  // The envelope warnings it appeared to protect the budget from are not part of the digest and
  // were never counted against it.

  // Stage 4: trim work-queue top arrays.
  while (
    size > DIGEST_BUDGET_BYTES &&
    (current.workQueue.inProgress.top.length > 0 ||
      current.workQueue.current.top.length > 0 ||
      current.workQueue.queued.top.length > 0)
  ) {
    current = {
      ...current,
      workQueue: {
        ...current.workQueue,
        inProgress: {
          ...current.workQueue.inProgress,
          top: current.workQueue.inProgress.top.slice(0, -1),
        },
        current: {
          ...current.workQueue.current,
          top: current.workQueue.current.top.slice(0, -1),
        },
        queued: {
          ...current.workQueue.queued,
          top: current.workQueue.queued.top.slice(0, -1),
        },
      },
    };
    size = measure(current);
  }

  // Stage 5: shrink portfolio.activeMissions.top (5→3→0), one at a time.
  while (
    size > DIGEST_BUDGET_BYTES &&
    current.portfolio &&
    current.portfolio.activeMissions.top.length > 0
  ) {
    current = {
      ...current,
      portfolio: {
        ...current.portfolio,
        activeMissions: {
          ...current.portfolio.activeMissions,
          top: current.portfolio.activeMissions.top.slice(0, -1),
        },
      },
    };
    size = measure(current);
  }

  // Stage 5b (s80-m06): shrink portfolio.drift.stale one at a time before dropping the
  // whole portfolio — the drift list is capped but still yields under extreme pressure.
  while (
    size > DIGEST_BUDGET_BYTES &&
    current.portfolio?.drift &&
    current.portfolio.drift.stale.length > 0
  ) {
    const stale = current.portfolio.drift.stale.slice(0, -1);
    current = {
      ...current,
      portfolio: {
        ...current.portfolio,
        drift: stale.length ? { ...current.portfolio.drift, stale } : null,
      },
    };
    size = measure(current);
  }

  // Stage 5c (s97-m01): shrink portfolio.signals.top one at a time. The count of other projects
  // needing a person stays; the list of them is the portfolio's last part to go.
  while (
    size > DIGEST_BUDGET_BYTES &&
    current.portfolio?.signals &&
    current.portfolio.signals.top.length > 0
  ) {
    current = {
      ...current,
      portfolio: {
        ...current.portfolio,
        signals: {
          ...current.portfolio.signals,
          top: current.portfolio.signals.top.slice(0, -1),
        },
      },
    };
    size = measure(current);
  }

  // Stage 6 (last resort): drop the whole portfolio section.
  if (size > DIGEST_BUDGET_BYTES && current.portfolio) {
    current = { ...current, portfolio: null };
    size = measure(current);
  }

  return current;
}

/** What review says of a general-tier project with no missions: nothing to prescribe. */
export const GENERAL_TIER_IDLE = 'Nothing in progress.';

function workQueueIsEmpty(queue: RbookReviewResult['workQueue']): boolean {
  return (
    queue.inProgress.count + queue.current.count + queue.queued.count + queue.blocked.count === 0
  );
}

function bucketFromMissionStatus(
  status: import('./rbook-mission-status').RbookMissionStatusResult
): RbookReviewResult['workQueue'] {
  return {
    inProgress: {
      count: status.inProgress.length,
      top: status.inProgress.slice(0, WORK_QUEUE_TOP_N).map(toWorkItem),
    },
    current: {
      count: status.current.length,
      top: status.current.slice(0, WORK_QUEUE_TOP_N).map(toWorkItem),
    },
    queued: {
      count: status.queued.length,
      top: status.queued.slice(0, WORK_QUEUE_TOP_N).map(toWorkItem),
    },
    blocked: { count: status.blocked?.length ?? 0 },
    nextAction: status.summary.nextAction,
  };
}

function bucketFromOnboardFallback(
  onboard: RbookAgentOnboardResult
): RbookReviewResult['workQueue'] {
  const byStatus = {
    'In Progress': [] as WorkItem[],
    Current: [] as WorkItem[],
    Queued: [] as WorkItem[],
  };
  for (const m of onboard.pendingMissions) {
    if (m.status === 'In Progress' || m.status === 'Current' || m.status === 'Queued') {
      byStatus[m.status].push(toWorkItemFromOnboard(m));
    }
  }
  // s97-m13 (#662): the opener lists queued missions in Requires order with what each waits on,
  // capped at five open missions, so "none ready" speaks only for the missions listed.
  const queuedListed = onboard.pendingMissions.filter((m) => m.status === 'Queued');
  const ready = queuedListed.find((m) => !m.waitsOn?.length);
  return {
    inProgress: {
      count: byStatus['In Progress'].length,
      top: byStatus['In Progress'].slice(0, WORK_QUEUE_TOP_N),
    },
    current: { count: byStatus.Current.length, top: byStatus.Current.slice(0, WORK_QUEUE_TOP_N) },
    queued: { count: byStatus.Queued.length, top: byStatus.Queued.slice(0, WORK_QUEUE_TOP_N) },
    blocked: { count: onboard.blockedMissions.length },
    nextAction:
      byStatus['In Progress'].length > 0
        ? `Continue working on ${byStatus['In Progress'][0].id}`
        : byStatus.Current.length > 0
          ? `Start the current mission: ${byStatus.Current[0].id}`
          : ready
            ? `Promote and start ${ready.id}`
            : queuedListed.length > 0
              ? `No queued mission listed is ready: ${queuedListed[0].id} waits on ${queuedListed[0].waitsOn?.join(', ')}`
              : 'No missions in queue. Add new missions to continue work.',
  };
}

function toWorkItem(m: StatusMissionItem): WorkItem {
  return {
    id: m.id,
    name: truncate(m.name, WORK_ITEM_NAME_CAP_CHARS),
    projectId: m.projectId ?? null,
  };
}

function toWorkItemFromOnboard(m: {
  id: string;
  name: string;
  projectId?: string | null;
}): WorkItem {
  return {
    id: m.id,
    name: truncate(m.name, WORK_ITEM_NAME_CAP_CHARS),
    projectId: m.projectId ?? null,
  };
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return value.slice(0, maxLen - 1) + '…';
}

/**
 * Normalize rbook:// address. Mirrors the local-only sentinel logic that
 * rbook_status uses so support-side and review-side agree on the field shape.
 */
function normalizeAddress(raw: string | null): string {
  if (!raw) return 'local-only';
  const trimmed = raw.trim();
  if (!trimmed) return 'local-only';
  if (trimmed.startsWith('rbook://unknown/')) return 'local-only';
  return trimmed;
}

/**
 * Keep only the high-signal warnings (auth, sync, attribution). Staleness,
 * orphan, and context-size warnings are valuable but heavy — they live on the
 * unchanged rbook_agent_onboard payload for callers that need them.
 */
function filterReviewWarnings(warnings: string[]): string[] {
  const interesting = warnings.filter((w) => {
    const lower = w.toLowerCase();
    return (
      lower.includes('auth') ||
      lower.includes('sync') ||
      lower.includes('rbook_auth') ||
      lower.includes('credential') ||
      lower.includes('attribution') ||
      lower.includes('whoami')
    );
  });
  // Cap to 3 warnings so a single noisy condition can't blow the budget.
  return interesting.slice(0, 3);
}

/**
 * Render the review digest as a short human-readable string for the MCP
 * `content` text field.
 */
export function formatReviewForLLM(result: RbookToolResult<RbookReviewResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['rbook_review failed', `Error: ${error?.message ?? 'unknown error'}`];
    if (error?.suggestion) {
      lines.push(`Suggestion: ${error.suggestion}`);
    }
    return lines.join('\n');
  }

  const d = result.data;
  const lines: string[] = [];
  // s84-m03: fence foreign (pull-merged) sprint/mission text INLINE — the digest is
  // budget-capped (≤4096 bytes), so only compact inline framing is used here. A
  // local/NULL-project row renders byte-identical to 2.3.0.
  const local = d.localProjectId;
  lines.push(`**${d.project.name}** (${d.project.tier}) — ${d.project.rbook_address}`);
  if (d.sprint) {
    const title = frameInlineIfForeign(d.sprint.title, d.sprint.projectId, local);
    lines.push(`Sprint ${d.sprint.id}: ${title} [${sprintStatusLabel(d.sprint)}]`);
    if (d.sprint.focus)
      lines.push(`  ${frameInlineIfForeign(d.sprint.focus, d.sprint.projectId, local)}`);
  }
  lines.push('');
  // s92-m06: a general-tier project with no missions sees no queue: that tier has none.
  const showQueue = !(d.project.tier === 'general' && workQueueIsEmpty(d.workQueue));
  if (showQueue) {
    lines.push(
      `Work queue — InProgress:${d.workQueue.inProgress.count} Current:${d.workQueue.current.count} Queued:${d.workQueue.queued.count} Blocked:${d.workQueue.blocked.count}`
    );
  }
  // s84-m03 (FORK-5): the mission-status nextAction embeds `<id>: <FULL name>` of the
  // referenced work-queue mission (determineNextAction; the name is the UNTRUNCATED source,
  // not the byte-capped WorkItem.name). When that mission is FOREIGN, render id-only — cut
  // the `: <name>` tail at the `<id>: ` marker so the foreign name never lands unfenced in
  // the ≤4KB digest. Matching the marker (not the name) is truncation-independent — a name
  // longer than the WorkItem cap would otherwise slip past a name-based match and leak.
  // Local rows leave nextAction byte-identical (no marker cut).
  const refItem =
    d.workQueue.inProgress.top[0] ?? d.workQueue.current.top[0] ?? d.workQueue.queued.top[0];
  let nextAction = d.workQueue.nextAction;
  if (refItem && isForeignProject(refItem.projectId, local)) {
    const marker = `${refItem.id}: `;
    const idx = nextAction.indexOf(marker);
    // The name always sits at the END of the recommendation (see determineNextAction), so
    // slicing from the marker and re-appending the bare id yields the id-only form. Formats
    // with no `<id>: <name>` segment (e.g. the multi-in-progress "Continue with <id> …",
    // which carries no name) simply don't match → left unchanged.
    if (idx !== -1) nextAction = nextAction.slice(0, idx) + refItem.id;
  }
  if (showQueue) lines.push(`Next: ${nextAction}`);

  if (d.next_actions.length > 0) {
    lines.push('');
    lines.push('Next actions:');
    for (const a of d.next_actions) {
      lines.push(`  [${a.priority}] ${a.action} → ${a.command}`);
    }
  }

  if (d.recentDecisions.length > 0) {
    lines.push('');
    lines.push('Recent decisions:');
    // s83-m06: frame a pull-merged FOREIGN decision (project_id != local) inside the
    // compact untrusted marker; render is text-only so the ≤4KB digestSizeBytes budget
    // is unaffected. Local rows stay bare.
    const localProjectId = d.localProjectId ?? null;
    for (const dec of d.recentDecisions) {
      const isForeign =
        dec.projectId != null && (localProjectId == null || dec.projectId !== localProjectId);
      lines.push(
        `  • #${dec.id} ${
          isForeign ? frameForeignInline(dec.text, `proj:${dec.projectId}`) : dec.text
        }${dec.author ? ` — ${dec.author}` : ''}`
      );
    }
  }

  if (d.recentLearnings.length > 0) {
    lines.push('');
    lines.push('Recent learnings:');
    // Same framing rule as decisions: a pull-merged FOREIGN learning is untrusted.
    const localLearningProject = d.localProjectId ?? null;
    for (const learning of d.recentLearnings) {
      const isForeign =
        learning.projectId != null &&
        (localLearningProject == null || learning.projectId !== localLearningProject);
      lines.push(
        `  • #${learning.id} ${
          isForeign
            ? frameForeignInline(learning.text, `proj:${learning.projectId}`)
            : learning.text
        }`
      );
    }
  }

  if (d.recentDecisions.length > 0 || d.recentLearnings.length > 0) {
    lines.push(
      'Read one in full: rbook_decisions(action="show", decisionId=N) or rbook_learnings(action="show", learningId=N).'
    );
  }

  if (d.portfolio) {
    const p = d.portfolio;
    lines.push('');
    // s80-m06: strict partition — reachable + silent + unmigrated + unreadable === projects.
    const parts = [`${p.reachable} reachable`];
    if (p.silent > 0) parts.push(`${p.silent} silent`);
    if (p.unmigrated > 0) parts.push(`${p.unmigrated} un-migrated`);
    if (p.unreadable > 0) parts.push(`${p.unreadable} unreadable`);
    lines.push(
      `🌐 Portfolio — ${p.activeMissions.count} active mission(s) across ${p.projects} store(s): ` +
        `${parts.join(', ')} · read in ${p.fanInP95Ms}ms (p95)`
    );
    // s84-m03 (#485): a portfolio mission from another project is FOREIGN — frame its
    // name inline (the [proj:X] tag is metadata, not a trust boundary). The local
    // project's own rows stay bare. Closes the s83-m06 deferral (SECURITY.md updated).
    for (const m of p.activeMissions.top) {
      const name = frameInlineIfForeign(m.name, m.projectId, local);
      lines.push(`  📋 ${m.id} — ${name} [proj:${m.projectId}]`);
    }
    if (p.drift && p.drift.stale.length > 0) {
      lines.push(`  ⚠ drift (>${p.drift.staleThresholdDays}d): ${p.drift.stale.length} project(s)`);
      for (const s of p.drift.stale) {
        lines.push(`    · ${s.name} — ${s.reason}${s.hint ? ` (${s.hint})` : ''}`);
      }
    }
    if (p.signals) {
      if (p.signals.projects > 0)
        lines.push(`  ⚑ needs a person in ${p.signals.projects} other project(s)`);
      for (const item of p.signals.top) {
        const name = frameInlineIfForeign(item.name, item.projectId, local);
        lines.push(`    · ${name} [proj:${item.projectId}] — ${personSignalsPhrase(item)}`);
      }
      if (p.signals.unread)
        lines.push(`  ⚑ some signals could not be read in ${p.signals.unread} other project(s)`);
    }
  }

  if (d.registryDefault) {
    lines.push('');
    lines.push(`⚙ ${d.registryDefault}`);
  }

  if (d.staleReflagged) {
    lines.push('');
    lines.push(
      `⚠ ${d.staleReflagged.count} record(s) restored on ${d.staleReflagged.lastRepair} are marked stale again: ` +
        'an older Reasonbook server still runs the opener that flagged them. Restarting those sessions ends it, ' +
        'and the next Reasonbook server process to write here restores them.'
    );
  }

  // s80-m07 — self-capture advisory (present only when it fires). Rendered here, not
  // via d.warnings, because filterReviewWarnings drops non-auth/sync warnings.
  if (d.selfCapture?.fires) {
    lines.push('');
    lines.push(
      `📝 Self-capture: local commits are ~${Math.round(d.selfCapture.gapDays)}d ahead of the last ` +
        `Reasonbook write — capture recent work (rbook_session action="capture")`
    );
  }

  // s87-m06 — the DATA-level warnings render is gone with the field. The ENVELOPE warnings are
  // rendered by `appendWarnings(lines, result)` below, exactly once, and that is the live channel.

  lines.push('');
  if (d.recordProtocol) lines.push(d.recordProtocol.summary);
  const copies = d.recordProtocol?.blockers.length
    ? 'blocking'
    : d.recordProtocol?.stranded.length
      ? 'stranded'
      : null;
  lines.push(
    `Digest size: ${d.digestSizeBytes} bytes (${d.digestSizeBytes > DIGEST_BUDGET_BYTES && copies ? `exceeds budget 4096 to list all ${copies} copies` : 'budget 4096'})`
  );
  appendWarnings(lines, result);

  return lines.join('\n');
}

/**
 * s91-m07 — a fallback sprint is labelled so "the digest shows a Completed or Planned sprint as
 * current" stops reading as drift: `[Completed, most recent; none open]`, `[Planned, next; none
 * open]`. KNOWN EDGE, named rather than built around: the resolver's step 1 can pick a Planned
 * sprint because it has work In Progress while another sprint is open; this label, derived from
 * status alone, would still say "none open" there.
 */
function sprintStatusLabel(sprint: {
  status: string | null;
  resolvedBy: 'open' | 'fallback';
}): string {
  const status = sprint.status ?? '—';
  if (sprint.resolvedBy === 'open') return status;
  if (status === 'Completed') return 'Completed, most recent; none open';
  if (status === 'Planned') return 'Planned, next; none open';
  return `${status}; none open`;
}
