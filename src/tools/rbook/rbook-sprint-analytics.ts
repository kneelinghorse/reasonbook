/**
 * rbook_sprint analytics action
 *
 * Computes KPIs across sprint history: velocity, completion rate trends,
 * decision volume, session patterns, and cycle time trends.
 * Read-only — does not mutate the database.
 *
 * @module tools/rbook/rbook-sprint-analytics
 */

import { formatToolFailure } from './format-failure';
import { prepareSpinOutRead, spinOutHistoryLines } from './spin-out-read';
import { missionCompletedSql } from './terminal-status';
import { withClient, type RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import { createSuccess } from './errors';
import { appendWarnings, attachWarnings } from './format-warnings';
import { ensureSprintSummaryView } from './schema-migrations';
import { sprintIdOrderSql } from './sprint-ordering';
import { parkedColumn } from './sprint-summary-read';
import { nextPageCall, pageFacts, pageRequest, shownLine } from './answer-page';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SprintDataPoint {
  sprintId: string;
  title: string;
  status: string | null;
  totalMissions: number;
  completedMissions: number;
  blockedMissions: number;
  /** s86-m08: Deferred + Dropped — outside totalMissions, reported so three sibling read
   *  surfaces (list, show, analytics) cannot disagree about whether parked work is visible. */
  parkedMissions: number;
  completionRate: number;
  avgCycleTimeDays: number | null;
  decisionsCount: number;
  learningsCount: number;
  sessionsCount: number;
  /** Sessions linked to at least one mission via session_missions */
  linkedSessionsCount: number;
}

export interface TrendDirection {
  direction: 'increasing' | 'decreasing' | 'stable';
  /** Change from first half average to second half average */
  changePercent: number;
}

export interface SprintAnalyticsResult {
  /**
   * The scope used by the decision, learning, and session counts below. These counts follow
   * stored sprint_id membership at read time; they are not clipped to the sprint end date.
   */
  countingRule: string;

  /**
   * Per-sprint data points on this page, chronological. s106-m03: a page holds
   * ANALYTICS_PAGE_SIZE sprints counted from the newest; every aggregate, trend and highlight
   * still covers the whole window.
   */
  sprints: SprintDataPoint[];

  /** s106-m03: this page's number, 1-based, counted from the newest sprint. */
  page: number;
  hasMore: boolean;
  nextPage: number | null;
  /** The call that reads the next (older) page of rows, or null on the last page. */
  nextPageCall: string | null;

  /** Aggregated cross-sprint KPIs */
  aggregates: {
    totalSprints: number;
    completedSprints: number;
    totalMissions: number;
    /** s86-m08: Deferred + Dropped across the window — outside totalMissions, stated so the
     *  TEXT answer discloses what the denominator excluded. */
    totalParked: number;
    totalCompleted: number;
    overallCompletionRate: number;
    avgVelocity: number;
    avgCycleTimeDays: number | null;
    totalDecisions: number;
    totalLearnings: number;
    totalSessions: number;
    totalLinkedSessions: number;
  };

  /** Computed trends (first half vs second half of sprint history) */
  trends: {
    velocity: TrendDirection;
    completionRate: TrendDirection;
    decisionsPerSprint: TrendDirection;
    cycleTime: TrendDirection | null;
  };

  /** Human-readable trend highlights */
  highlights: string[];

  /**
   * s86-m05 — the window these numbers actually describe. Every aggregate, trend and highlight
   * above is computed over exactly these sprints; without this field an operator reading
   * "across recent sprints" has no way to tell WHICH sprints, which is how the inverted-window
   * defect stayed invisible for as long as it did.
   */
  window: {
    /** The `limit` the caller passed, or null for an unbounded read. */
    requestedLimit: number | null;
    /** Sprints actually analyzed (≤ requestedLimit; fewer when the store holds fewer). */
    sprintCount: number;
    /** Oldest and newest sprint in the analyzed window; null when it is empty. */
    oldestSprintId: string | null;
    newestSprintId: string | null;
  };
}

export interface RbookSprintAnalyticsParams {
  /** Optional project root */
  projectRoot?: string;
  /** Limit to last N sprints (default: all completed) */
  limit?: number;
  /** s106-m03: page of per-sprint rows, 1-based, counted from the newest */
  page?: number;
}

/** s106-m03: per-sprint rows on a page. 219 rows were 94,342 characters on OODS-Forge. */
export const ANALYTICS_PAGE_SIZE = 20;

const ANALYTICS_COUNTING_RULE =
  'Decision, learning, and session counts use raw sprint_id membership at read time and are not clipped to the sprint end_date; mission totals and cycle-time metrics retain their existing status and timestamp rules.';

// ─── Implementation ──────────────────────────────────────────────────────────

export async function rbookSprintAnalytics(
  params: RbookSprintAnalyticsParams
): Promise<RbookToolResult<SprintAnalyticsResult>> {
  const warnings: string[] = [];
  const result = await withClient(
    (client) => {
      // s86-m08: upgrade a pre-migration store's view before reading it (see
      // ensureSprintSummaryView — zero writes once current, never touches a base table).
      const viewMigration = ensureSprintSummaryView(client);
      warnings.push(...(viewMigration.warnings ?? []));

      const { sprints, error: readError } = getSprintDataPoints(
        client,
        params.limit,
        viewMigration.parkedAvailable
      );

      // An unreadable store and an empty one are different facts. Say which one this is.
      const advisories = [...warnings];
      if (readError) {
        advisories.push(
          `${readError} No sprint data is included below — this is NOT a report that the store has no sprints.`
        );
      }

      if (sprints.length === 0) {
        return createSuccess<SprintAnalyticsResult>(
          {
            countingRule: ANALYTICS_COUNTING_RULE,
            sprints: [],
            page: params.page ?? 1,
            hasMore: false,
            nextPage: null,
            nextPageCall: null,
            aggregates: {
              totalSprints: 0,
              completedSprints: 0,
              totalMissions: 0,
              totalParked: 0,
              totalCompleted: 0,
              overallCompletionRate: 0,
              avgVelocity: 0,
              avgCycleTimeDays: null,
              totalDecisions: 0,
              totalLearnings: 0,
              totalSessions: 0,
              totalLinkedSessions: 0,
            },
            trends: {
              velocity: { direction: 'stable', changePercent: 0 },
              completionRate: { direction: 'stable', changePercent: 0 },
              decisionsPerSprint: { direction: 'stable', changePercent: 0 },
              cycleTime: null,
            },
            highlights: [
              readError
                ? 'Sprint data could not be read on this store — see warnings. This is not a finding that there are no sprints.'
                : 'No completed sprints found for analysis.',
            ],
            window: {
              requestedLimit: params.limit && params.limit > 0 ? params.limit : null,
              sprintCount: 0,
              oldestSprintId: null,
              newestSprintId: null,
            },
          },
          advisories
        );
      }

      const visibility = prepareSpinOutRead(client);
      const historical = client.getMany<{ id: string }>(
        `SELECT id FROM missions WHERE sprint_id IN (${sprints.map(() => '?').join(',')})`,
        sprints.map((sprint) => sprint.sprintId)
      );
      if (!historical.success)
        throw new Error(
          `SPIN_OUT_READ_FAILED: ${historical.error?.message ?? 'sprint history query failed'}`
        );
      advisories.push(
        ...spinOutHistoryLines(
          visibility,
          (historical.data ?? []).map((mission) => mission.id)
        )
      );
      const aggregates = computeAggregates(sprints);
      const trends = computeTrends(sprints);
      const highlights = generateHighlights(sprints, aggregates, trends);
      // s106-m03: the page is cut after every figure above was computed over the whole window.
      const request = pageRequest(params.page, undefined, ANALYTICS_PAGE_SIZE);
      const end = sprints.length - request.offset;
      const rows = end > 0 ? sprints.slice(Math.max(0, end - request.pageSize), end) : [];
      const facts = pageFacts(request, rows.length, sprints.length);

      return createSuccess<SprintAnalyticsResult>(
        {
          countingRule: ANALYTICS_COUNTING_RULE,
          sprints: rows,
          page: facts.page,
          hasMore: facts.hasMore,
          nextPage: facts.nextPage,
          nextPageCall: nextPageCall(facts.nextPage, 'rbook_sprint', {
            action: 'analytics',
            limit: params.limit,
            projectRoot: params.projectRoot,
          }),
          aggregates,
          trends,
          highlights,
          // `sprints` is oldest-first by construction (see getSprintDataPoints), so the ends of
          // the array ARE the ends of the window.
          //
          // requestedLimit reports the bound that was APPLIED, not the number that was passed.
          // `limitClause` is built with a truthiness test, so limit=0 (and any negative) produces
          // NO LIMIT clause and the call is unbounded — echoing `0` back would make this field,
          // whose entire purpose is to stop the answer misdescribing its own window, do exactly
          // that. Non-positive limits report null, which is what actually happened.
          window: {
            requestedLimit: params.limit && params.limit > 0 ? params.limit : null,
            sprintCount: sprints.length,
            oldestSprintId: sprints[0].sprintId,
            newestSprintId: sprints[sprints.length - 1].sprintId,
          },
        },
        advisories
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

// ─── Data Retrieval ──────────────────────────────────────────────────────────

interface SprintSummaryRow {
  sprint_id: string;
  title: string;
  status: string | null;
  total_missions: number;
  completed_missions: number;
  blocked_missions: number;
  parked_missions: number;
}

function getSprintDataPoints(
  client: RbookDatabaseClient,
  limit: number | undefined,
  parkedAvailable: boolean
): { sprints: SprintDataPoint[]; error: string | null } {
  // Get sprints with mission counts from the sprint_summary view.
  //
  // s86-m05 (next-step #514): this read used to be `ORDER BY sprint_id ASC ${limitClause}`, so
  // `limit=N` returned the OLDEST N sprints while the highlights below called them "recent".
  // Measured on the live store (77 sprints match the filter): limit=8 returned sprint-09..sprint-16
  // and reported velocity trending DOWN 44%, where the unlimited call reports stable +8% — a
  // wrong answer, not a stale one.
  //
  // The bound is applied to a DESC ordering INSIDE a subquery and oldest-first is restored
  // OUTSIDE it, rather than flipping this ORDER BY to DESC. computeTrendDirection compares the
  // first half of the array to the second, so an oldest-first array is what "trend" MEANS here;
  // a bare DESC flip would silently invert every reported direction, which is worse than the
  // bug it fixed. The subquery makes the ordering correct by construction, so a later refactor
  // of the .map() below cannot undo it. With `limit` undefined, limitClause is '' and the outer
  // ASC returns the full history oldest-first under the same numeric sprint-ID contract.
  //
  // sprint_id is TEXT, but the shared ordering fragment recognizes canonical sprint-N IDs and
  // orders their suffix numerically. This keeps the bounded window and chronological restore on
  // the same contract as every other sprint-ordered read.
  const limitClause = limit ? `LIMIT ${Math.floor(limit)}` : '';
  const sprintsResult = client.getMany<SprintSummaryRow>(
    `SELECT * FROM (
       SELECT sprint_id, title, status, total_missions, completed_missions, blocked_missions, ${parkedColumn(parkedAvailable)}
       FROM sprint_summary
       WHERE status IN ('Completed', 'Active')
       ORDER BY ${sprintIdOrderSql('sprint_id', 'DESC')}
       ${limitClause}
     ) ORDER BY ${sprintIdOrderSql('sprint_id', 'ASC')}`
  );

  // s86-m08 critic: this used to `return []`, and the caller then reported "No completed
  // sprints found for analysis" — a confident assertion of ABSENCE built from a swallowed read
  // failure. An empty store and an unreadable one are different facts and now stay different.
  if (!sprintsResult.success || !sprintsResult.data) {
    return {
      sprints: [],
      error:
        `sprint_summary could not be read ` +
        `(${sprintsResult.error?.code ?? 'DB_ERROR'} — ${sprintsResult.error?.message ?? 'unknown'}); ` +
        `the sprint window is unknown, not empty.`,
    };
  }

  const sprints: SprintDataPoint[] = [];
  for (const row of sprintsResult.data) {
    const decisions = getDecisionsCount(client, row.sprint_id);
    if (decisions.error !== null) return { sprints: [], error: decisions.error };

    const learnings = getLearningsCount(client, row.sprint_id);
    if (learnings.error !== null) return { sprints: [], error: learnings.error };

    const sessions = getSessionsCount(client, row.sprint_id);
    if (sessions.error !== null) return { sprints: [], error: sessions.error };

    const linkedSessions = getLinkedSessionsCount(client, row.sprint_id);
    if (linkedSessions.error !== null) return { sprints: [], error: linkedSessions.error };

    const cycleTime = getAvgCycleTime(client, row.sprint_id);
    sprints.push({
      sprintId: row.sprint_id,
      title: row.title,
      status: row.status,
      totalMissions: row.total_missions,
      completedMissions: row.completed_missions,
      blockedMissions: row.blocked_missions,
      parkedMissions: row.parked_missions ?? 0,
      completionRate:
        row.total_missions > 0
          ? Math.round((row.completed_missions / row.total_missions) * 100)
          : 0,
      avgCycleTimeDays: cycleTime,
      decisionsCount: decisions.count,
      learningsCount: learnings.count,
      sessionsCount: sessions.count,
      linkedSessionsCount: linkedSessions.count,
    });
  }

  return { sprints, error: null };
}

type CountReadResult = { count: number; error: null } | { count: null; error: string };

function membershipCountResult(
  source: string,
  sprintId: string,
  result: RbookToolResult<{ count: number } | undefined>
): CountReadResult {
  if (result.success && typeof result.data?.count === 'number') {
    return { count: result.data.count, error: null };
  }

  return {
    count: null,
    error:
      `${source} could not be read for sprint '${sprintId}' ` +
      `(${result.error?.code ?? 'DB_ERROR'} — ${result.error?.message ?? 'count query returned no row'}); ` +
      `its raw sprint_id membership count is unknown, not zero.`,
  };
}

function getAvgCycleTime(client: RbookDatabaseClient, sprintId: string): number | null {
  const result = client.getOne<{ avg_days: number | null }>(
    `SELECT AVG(
       (julianday(completed_at) - julianday(started_at))
     ) AS avg_days
     FROM missions
     WHERE sprint_id = ?
       AND ${missionCompletedSql('status')}
       AND started_at IS NOT NULL
       AND completed_at IS NOT NULL`,
    [sprintId]
  );
  if (!result.success || !result.data || result.data.avg_days === null) return null;
  return Math.round(result.data.avg_days * 100) / 100;
}

function getDecisionsCount(client: RbookDatabaseClient, sprintId: string): CountReadResult {
  return membershipCountResult(
    'strategic_decisions',
    sprintId,
    client.getOne<{ count: number }>(
      `SELECT COUNT(*) AS count FROM strategic_decisions WHERE sprint_id = ?`,
      [sprintId]
    )
  );
}

function getLearningsCount(client: RbookDatabaseClient, sprintId: string): CountReadResult {
  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM learnings WHERE sprint_id = ?`,
    [sprintId]
  );
  return membershipCountResult('learnings', sprintId, result);
}

function getSessionsCount(client: RbookDatabaseClient, sprintId: string): CountReadResult {
  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM sessions WHERE sprint_id = ?`,
    [sprintId]
  );
  return membershipCountResult('sessions', sprintId, result);
}

function getLinkedSessionsCount(client: RbookDatabaseClient, sprintId: string): CountReadResult {
  // Check if session_missions table exists
  const tableCheck = client.getOne<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='session_missions'`
  );
  if (!tableCheck.success) {
    return {
      count: null,
      error:
        `session_missions existence could not be established for sprint '${sprintId}' ` +
        `(${tableCheck.error?.code ?? 'DB_ERROR'} — ${tableCheck.error?.message ?? 'unknown'}); ` +
        `the linked-session count is unknown, not zero.`,
    };
  }
  // This is the one legitimate zero without a COUNT query: sqlite_master answered successfully
  // and established that the optional relation does not exist on this store.
  if (!tableCheck.data) return { count: 0, error: null };

  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(DISTINCT sm.session_id) AS count
     FROM session_missions sm
     JOIN sessions s ON s.id = sm.session_id
     WHERE s.sprint_id = ?`,
    [sprintId]
  );
  return membershipCountResult('session_missions', sprintId, result);
}

// ─── Aggregate Computation ───────────────────────────────────────────────────

function computeAggregates(sprints: SprintDataPoint[]): SprintAnalyticsResult['aggregates'] {
  const completedSprints = sprints.filter((s) => s.status === 'Completed');
  const totalMissions = sprints.reduce((sum, s) => sum + s.totalMissions, 0);
  const totalParked = sprints.reduce((sum, s) => sum + (s.parkedMissions ?? 0), 0);
  const totalCompleted = sprints.reduce((sum, s) => sum + s.completedMissions, 0);
  const totalDecisions = sprints.reduce((sum, s) => sum + s.decisionsCount, 0);
  const totalLearnings = sprints.reduce((sum, s) => sum + s.learningsCount, 0);
  const totalSessions = sprints.reduce((sum, s) => sum + s.sessionsCount, 0);
  const totalLinkedSessions = sprints.reduce((sum, s) => sum + s.linkedSessionsCount, 0);

  const cycleTimes = sprints
    .map((s) => s.avgCycleTimeDays)
    .filter((ct): ct is number => ct !== null);
  const avgCycleTimeDays =
    cycleTimes.length > 0
      ? Math.round((cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) * 100) / 100
      : null;

  const avgVelocity =
    completedSprints.length > 0
      ? Math.round(
          (completedSprints.reduce((sum, s) => sum + s.completedMissions, 0) /
            completedSprints.length) *
            100
        ) / 100
      : 0;

  return {
    totalSprints: sprints.length,
    completedSprints: completedSprints.length,
    totalMissions,
    totalParked,
    totalCompleted,
    overallCompletionRate:
      totalMissions > 0 ? Math.round((totalCompleted / totalMissions) * 100) : 0,
    avgVelocity,
    avgCycleTimeDays,
    totalDecisions,
    totalLearnings,
    totalSessions,
    totalLinkedSessions,
  };
}

// ─── Trend Computation ───────────────────────────────────────────────────────

function computeTrends(sprints: SprintDataPoint[]): SprintAnalyticsResult['trends'] {
  if (sprints.length < 2) {
    return {
      velocity: { direction: 'stable', changePercent: 0 },
      completionRate: { direction: 'stable', changePercent: 0 },
      decisionsPerSprint: { direction: 'stable', changePercent: 0 },
      cycleTime: null,
    };
  }

  const velocityTrend = computeTrendDirection(sprints.map((s) => s.completedMissions));

  const completionRateTrend = computeTrendDirection(sprints.map((s) => s.completionRate));

  const decisionsTrend = computeTrendDirection(sprints.map((s) => s.decisionsCount));

  const cycleTimes = sprints
    .map((s) => s.avgCycleTimeDays)
    .filter((ct): ct is number => ct !== null);
  const cycleTimeTrend = cycleTimes.length >= 2 ? computeTrendDirection(cycleTimes) : null;

  return {
    velocity: velocityTrend,
    completionRate: completionRateTrend,
    decisionsPerSprint: decisionsTrend,
    cycleTime: cycleTimeTrend,
  };
}

/**
 * Compute trend direction by comparing the average of the first half
 * to the average of the second half of data points.
 */
function computeTrendDirection(values: number[]): TrendDirection {
  if (values.length < 2) {
    return { direction: 'stable', changePercent: 0 };
  }

  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid);
  const secondHalf = values.slice(mid);

  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

  if (firstAvg === 0 && secondAvg === 0) {
    return { direction: 'stable', changePercent: 0 };
  }

  const changePercent =
    firstAvg === 0 ? 100 : Math.round(((secondAvg - firstAvg) / firstAvg) * 100);

  // Use a 10% threshold for meaningful change
  const direction: TrendDirection['direction'] =
    changePercent > 10 ? 'increasing' : changePercent < -10 ? 'decreasing' : 'stable';

  return { direction, changePercent };
}

// ─── Highlights ──────────────────────────────────────────────────────────────

function generateHighlights(
  sprints: SprintDataPoint[],
  aggregates: SprintAnalyticsResult['aggregates'],
  trends: SprintAnalyticsResult['trends']
): string[] {
  const highlights: string[] = [];

  // Velocity trend
  if (trends.velocity.direction === 'increasing') {
    highlights.push(
      `Velocity trending up: ${trends.velocity.changePercent > 0 ? '+' : ''}${trends.velocity.changePercent}% across recent sprints`
    );
  } else if (trends.velocity.direction === 'decreasing') {
    highlights.push(
      `Velocity trending down: ${trends.velocity.changePercent}% across recent sprints`
    );
  }

  // Average velocity
  highlights.push(
    `Average velocity: ${aggregates.avgVelocity} missions/sprint across ${aggregates.completedSprints} completed sprints`
  );

  // Completion rate
  highlights.push(
    `Overall completion rate: ${aggregates.overallCompletionRate}% (${aggregates.totalCompleted}/${aggregates.totalMissions} missions)`
  );

  // Decision volume trend
  if (trends.decisionsPerSprint.direction !== 'stable') {
    const label = trends.decisionsPerSprint.direction === 'increasing' ? 'growing' : 'declining';
    highlights.push(
      `Decision capture ${label}: ${trends.decisionsPerSprint.changePercent > 0 ? '+' : ''}${trends.decisionsPerSprint.changePercent}%`
    );
  }

  // Cycle time
  if (aggregates.avgCycleTimeDays !== null) {
    highlights.push(`Average mission cycle time: ${aggregates.avgCycleTimeDays} days`);
    if (trends.cycleTime?.direction === 'decreasing') {
      highlights.push(`Cycle time improving: ${trends.cycleTime.changePercent}%`);
    } else if (trends.cycleTime?.direction === 'increasing') {
      highlights.push(
        `Cycle time increasing: +${trends.cycleTime.changePercent}% — missions taking longer`
      );
    }
  }

  // Peak sprint
  if (sprints.length >= 3) {
    const peak = sprints.reduce((best, s) =>
      s.completedMissions > best.completedMissions ? s : best
    );
    highlights.push(
      `Peak velocity: ${peak.completedMissions} missions in ${peak.sprintId} (${peak.title})`
    );
  }

  return highlights;
}

// ─── LLM Formatter ───────────────────────────────────────────────────────────

export function formatSprintAnalyticsForLLM(
  result: RbookToolResult<SprintAnalyticsResult>
): string {
  if (!result.success || !result.data) {
    return formatToolFailure('Analytics failed', result.error);
  }

  const d = result.data;
  const lines: string[] = [];

  lines.push('**Cross-Sprint Analytics**');
  lines.push('');

  // s86-m05 — name the window BEFORE the numbers it explains. Every figure below describes
  // exactly these sprints, and a bounded call now says which ones rather than "recent".
  if (d.window.sprintCount > 0) {
    const bound =
      d.window.requestedLimit !== null
        ? `newest ${d.window.sprintCount} of the requested ${d.window.requestedLimit}`
        : `all ${d.window.sprintCount}`;
    lines.push(
      `**Window**: ${bound} — ${d.window.oldestSprintId} → ${d.window.newestSprintId} (oldest → newest)`
    );
    lines.push('');
  }

  // Aggregates
  lines.push('**Aggregates**');
  lines.push(
    `  Sprints: ${d.aggregates.totalSprints} (${d.aggregates.completedSprints} completed)`
  );
  lines.push(
    `  Missions: ${d.aggregates.totalCompleted}/${d.aggregates.totalMissions} completed (${d.aggregates.overallCompletionRate}%)` +
      (d.aggregates.totalParked > 0
        ? `, ${d.aggregates.totalParked} parked (Deferred/Dropped, outside the rate)`
        : '')
  );
  lines.push(`  Avg velocity: ${d.aggregates.avgVelocity} missions/sprint`);
  if (d.aggregates.avgCycleTimeDays !== null) {
    lines.push(`  Avg cycle time: ${d.aggregates.avgCycleTimeDays} days`);
  }
  lines.push(
    `  Decisions: ${d.aggregates.totalDecisions} | Learnings: ${d.aggregates.totalLearnings} | Sessions: ${d.aggregates.totalSessions}${d.aggregates.totalLinkedSessions > 0 ? ` (${d.aggregates.totalLinkedSessions} mission-linked)` : ''}`
  );
  lines.push(`  Counting rule: ${d.countingRule}`);

  // Trends
  lines.push('');
  lines.push('**Trends**');
  lines.push(`  Velocity: ${formatTrend(d.trends.velocity)}`);
  lines.push(`  Completion rate: ${formatTrend(d.trends.completionRate)}`);
  lines.push(`  Decisions/sprint: ${formatTrend(d.trends.decisionsPerSprint)}`);
  if (d.trends.cycleTime) {
    lines.push(`  Cycle time: ${formatTrend(d.trends.cycleTime)}`);
  }

  // Per-sprint table
  if (d.sprints.length > 0) {
    lines.push('');
    lines.push('**Per-Sprint Data**');
    // s106-m03: a page of rows counted from the newest; the figures above cover the window.
    if (d.page > 1 || d.hasMore)
      lines.push(
        `${shownLine({ page: d.page, pageSize: ANALYTICS_PAGE_SIZE, totalCount: d.window.sprintCount }, d.sprints.length, 'sprints')}, counted from the newest (${d.sprints[0].sprintId} → ${d.sprints[d.sprints.length - 1].sprintId}).`
      );
    lines.push('Sprint          | Missions | Done | Rate | Decisions | Sessions | Cycle');
    lines.push('----------------|----------|------|------|-----------|----------|------');
    for (const s of d.sprints) {
      const cycle = s.avgCycleTimeDays !== null ? `${s.avgCycleTimeDays}d` : '—';
      lines.push(
        `${s.sprintId.padEnd(16)}| ${String(s.totalMissions).padEnd(9)}| ${String(s.completedMissions).padEnd(5)}| ${String(s.completionRate + '%').padEnd(5)}| ${String(s.decisionsCount).padEnd(10)}| ${String(s.sessionsCount).padEnd(9)}| ${cycle}`
      );
    }
  }

  if (d.nextPageCall) lines.push(`Next page: ${d.nextPageCall}.`);

  // Highlights
  if (d.highlights.length > 0) {
    lines.push('');
    lines.push('**Highlights**');
    for (const h of d.highlights) {
      lines.push(`  - ${h}`);
    }
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

function formatTrend(trend: TrendDirection): string {
  const arrow =
    trend.direction === 'increasing' ? '↑' : trend.direction === 'decreasing' ? '↓' : '→';
  const sign = trend.changePercent > 0 ? '+' : '';
  return `${arrow} ${trend.direction} (${sign}${trend.changePercent}%)`;
}
