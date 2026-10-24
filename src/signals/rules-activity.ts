// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Four signals over a store's activity at a given instant: open friction by kind, days quiet, constraints about
// ABOUTME: to expire and a shared copy's unsettled conflicts; and the window's new rows, with new feedback by kind.

import {
  classifyFeedback,
  countFeedbackKinds,
  FEEDBACK_KINDS,
  type FeedbackKind,
} from './feedback-kinds';
import type { FeedbackKindsReport, SignalEntry, WindowCounts } from './report';
import { oldestOf, unavailable, type RecordsContext } from './rules-records';
import { closesAtOrBefore, columnsOf, DAY_MS, timeOf } from './store-read';

/**
 * The six domain tables whose newest row stamp says a store has had activity (s87-m03): what a
 * Reasonbook store's own tools write. The review's silence rule reads the same six.
 */
export const ACTIVITY_TABLES = [
  'missions',
  'sprints',
  'sessions',
  'learnings',
  'strategic_decisions',
  'next_steps',
] as const;

/** The review calls a project silent after more than this many days (rbook-review.ts STALE_THRESHOLD_DAYS). */
export const QUIET_SILENT_DAYS = 21;

/** Constraints expiring within this many days are reported. */
export const CONSTRAINTS_EXPIRING_DAYS = 7;

export function feedbackOpen(ctx: RecordsContext): SignalEntry {
  const columns = columnsOf(ctx.db, 'agent_feedback');
  if (!columns.size) return unavailable('feedback_open', 'no feedback yet');
  if (!columns.has('status') || !columns.has('body'))
    return unavailable('feedback_open', 'agent_feedback has no status or body column');
  const created = columns.has('created_at') ? 'created_at' : 'NULL AS created_at';
  const rows = ctx.db
    .prepare(`SELECT id, body, ${created} FROM agent_feedback WHERE status = 'open'`)
    .all() as Array<{ id: number; body: string | null; created_at: unknown }>;
  const byKind = Object.fromEntries(FEEDBACK_KINDS.map(({ kind }) => [kind, 0])) as Record<
    FeedbackKind,
    number
  >;
  let unclassified = 0;
  let undated = 0;
  const friction: Array<{ at: number; id: number }> = [];
  for (const row of rows) {
    const at = timeOf(row.created_at);
    if (!Number.isFinite(at)) {
      undated += 1;
      continue;
    }
    if (at > ctx.nowMs) continue;
    const { kind } = classifyFeedback(row.body);
    if (kind === 'unclassified') {
      unclassified += 1;
      continue;
    }
    byKind[kind] += 1;
    friction.push({ at, id: row.id });
  }
  // Oldest friction first.
  friction.sort((a, b) => a.at - b.at || a.id - b.id);
  return {
    kind: 'feedback_open',
    available: true,
    count: friction.length,
    ids: friction.slice(0, ctx.maxIds).map((row) => `f:${row.id}`),
    byKind,
    unclassified,
    ...(undated ? { undated } : {}),
  };
}

export function quietDays(ctx: RecordsContext): SignalEntry {
  let newest: number | null = null;
  let stamped = 0;
  for (const table of ACTIVITY_TABLES) {
    if (!columnsOf(ctx.db, table).has('occurred_at')) continue;
    stamped += 1;
    const row = ctx.db
      .prepare(`SELECT MAX(occurred_at) AS newest FROM ${table} WHERE occurred_at <= ?`)
      .get(ctx.nowMs) as { newest: unknown } | undefined;
    const value = typeof row?.newest === 'number' ? row.newest : null;
    if (value !== null && (newest === null || value > newest)) newest = value;
  }
  if (!stamped) return unavailable('quiet_days', 'no domain table has an occurred_at stamp');
  if (newest === null) return unavailable('quiet_days', 'no row stamped at or before now');
  return {
    kind: 'quiet_days',
    available: true,
    count: Math.floor((ctx.nowMs - newest) / DAY_MS),
    ids: [],
  };
}

export function constraintsExpiring(ctx: RecordsContext): SignalEntry {
  const columns = columnsOf(ctx.db, 'constraints');
  if (!columns.size) return unavailable('constraints_expiring', 'no constraints table');
  if (!columns.has('status') || !columns.has('expires_at'))
    return unavailable('constraints_expiring', 'constraints has no status or expires_at column');
  const rows = ctx.db
    .prepare(
      "SELECT id, expires_at FROM constraints WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <> ''"
    )
    .all() as Array<{ id: number; expires_at: unknown }>;
  const horizonMs = ctx.nowMs + CONSTRAINTS_EXPIRING_DAYS * DAY_MS;
  let undated = 0;
  const expiring: Array<{ at: number; id: number }> = [];
  for (const row of rows) {
    const at = timeOf(row.expires_at);
    if (!Number.isFinite(at)) {
      undated += 1;
      continue;
    }
    if (at > ctx.nowMs && at <= horizonMs) expiring.push({ at, id: row.id });
  }
  expiring.sort((a, b) => a.at - b.at || a.id - b.id);
  return {
    kind: 'constraints_expiring',
    available: true,
    count: expiring.length,
    ids: expiring.slice(0, ctx.maxIds).map((row) => `c:${row.id}`),
    ...(undated ? { undated } : {}),
  };
}

export function sharedConflicts(ctx: RecordsContext): SignalEntry {
  const columns = columnsOf(ctx.db, 'record_conflicts');
  if (!columns.size)
    return unavailable('shared_conflicts', 'not a shared copy (no record_conflicts table)');
  const rows = ctx.db
    .prepare('SELECT entity, entity_id, field, detected_at FROM record_conflicts')
    .all() as Array<{ entity: string; entity_id: string; field: string; detected_at: unknown }>;
  const ranked = rows
    .map((row) => {
      const at = timeOf(row.detected_at);
      return {
        at: Number.isFinite(at) ? at : Number.MAX_SAFE_INTEGER,
        ref: `${row.entity}:${row.entity_id}/${row.field}`,
      };
    })
    .sort((a, b) => a.at - b.at || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  // A copy makes record_peers on the first exchange it notes, so a copy with none was told
  // nothing: not removed. A referee's snapshot never keeps peers, so there it says nothing.
  const peers = columnsOf(ctx.db, 'record_peers');
  const removed = peers.has('removed_at')
    ? Boolean(
        ctx.db.prepare('SELECT 1 FROM record_peers WHERE removed_at IS NOT NULL LIMIT 1').get()
      )
    : false;
  return {
    kind: 'shared_conflicts',
    available: true,
    count: ranked.length,
    ids: ranked.slice(0, ctx.maxIds).map((row) => row.ref),
    ...oldestOf(ranked.map((row) => row.at)),
    removed,
  };
}

/** Rows whose time column falls in (start, end]; null when the table or column is absent. */
function countIn(
  ctx: RecordsContext,
  table: string,
  column: string,
  startMs: number,
  where = ''
): number | null {
  const columns = columnsOf(ctx.db, table);
  if (!columns.has(column)) return null;
  const rows = ctx.db
    .prepare(`SELECT ${column} AS at FROM ${table} WHERE ${column} IS NOT NULL${where}`)
    .all() as Array<{ at: unknown }>;
  let count = 0;
  for (const row of rows) {
    const at = timeOf(row.at);
    if (at > startMs && at <= ctx.nowMs) count += 1;
  }
  return count;
}

export function windowCounts(ctx: RecordsContext, days: number): WindowCounts {
  const start = ctx.nowMs - days * DAY_MS;
  const sprints = columnsOf(ctx.db, 'sprints');
  return {
    decisions: countIn(ctx, 'strategic_decisions', 'created_at', start),
    learnings: countIn(ctx, 'learnings', 'created_at', start),
    missionsCompleted: countIn(ctx, 'missions', 'completed_at', start),
    sprintsClosed:
      sprints.has('status') && sprints.has('end_date')
        ? closesAtOrBefore(ctx.db, ctx.nowMs, false).filter((close) => close.endMs > start).length
        : null,
  };
}

export function windowFeedbackKinds(ctx: RecordsContext, days: number): FeedbackKindsReport {
  const columns = columnsOf(ctx.db, 'agent_feedback');
  if (!columns.has('body') || !columns.has('created_at')) {
    return {
      available: false,
      counts: null,
      unclassified: null,
      reason: columns.size ? 'agent_feedback has no body or created_at column' : 'no feedback yet',
    };
  }
  const start = ctx.nowMs - days * DAY_MS;
  const rows = ctx.db.prepare('SELECT body, created_at FROM agent_feedback').all() as Array<{
    body: string | null;
    created_at: unknown;
  }>;
  const inWindow = rows.filter((row) => {
    const at = timeOf(row.created_at);
    return at > start && at <= ctx.nowMs;
  });
  const { counts, unclassified } = countFeedbackKinds(inWindow.map((row) => row.body));
  return { available: true, counts, unclassified };
}
