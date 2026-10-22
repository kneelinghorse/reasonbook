// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m02 — the ONE canonical current-sprint resolver. Collapses the four
// divergent pickers (onboard, mission-status, session-start, capture) onto one cascade.

/**
 * Canonical current-sprint resolver (s77-m02).
 *
 * Before s77 there were FOUR divergent "current sprint" pickers, and two of them
 * disagreed on a multi-Active store: onboard's `getExplicitOpenSprintId` ordered
 * `start_date DESC` (newest wins) while mission-status' `findActiveSprint` ordered
 * `start_date ASC` (oldest wins) — the recorded s75 #853 split (A said sprint-76,
 * B said sprint-75). This module is the single source of truth every surface now
 * delegates to, so they can never disagree again.
 *
 * The write-time invariant (s77-m01) keeps any store THIS server writes to a
 * single open sprint; this read-side resolver is the safety net for legacy /
 * foreign stores we don't control that already hold two open sprints.
 *
 * `resolveCurrentSprintId` returns the sprint ID only; callers layer their own
 * context/shape on top (onboard's `getSprintContextById`, mission-status'
 * `isComplete`, etc.).
 *
 * @module tools/rbook/current-sprint
 */

import { missionCompletedSql } from './terminal-status';
import type { RbookDatabaseClient } from './client';
import {
  SPRINT_TERMINAL_STATUSES as DEAD_SPRINT_STATUSES,
  SPRINT_NO_OPEN_WORK_STATUSES as NO_OPEN_WORK_STATUSES,
  SPRINT_OPEN_STATUSES,
  statusInSql,
  statusNotInSql as statusNotIn,
} from './terminal-status';
import { sprintIdOrderSql } from './sprint-ordering';

/**
 * Resolve the single current sprint ID via a mission-aware 6-step cascade.
 *
 * DEAD_SPRINT_STATUSES (Archived/Failed/Dropped/Reverted) never surface as
 * current even with recent activity (extends the s55-m03 Archived-only exclusion,
 * decision #567); the Completed-aware fallbacks re-admit Completed by excluding
 * only the DEAD set. Matching is case-insensitive (decision #839 / s75-m02).
 *
 * Strategy:
 * 1. Sprint with In Progress or Current missions (active work)
 * 2. Explicit open (In Progress/Current/Active) sprint that still has open work or
 *    no missions yet — tie-broken by most-recent real activity (s77-m02 Fork 1b)
 * 3. Most recently active non-Completed sprint when status fields drift behind reality
 * 4. Earliest non-completed sprint with Queued missions (next work)
 * 5. Most recently active sprint by real activity (any non-Archived, includes Completed)
 * 6. Fall back to status-based ordering
 */
export function resolveCurrentSprintId(client: RbookDatabaseClient): string | null {
  // Step 1: Find sprint with active work (In Progress or Current missions) on a
  // non-Archived sprint.
  const activeWorkResult = client.getOne<{ sprint_id: string }>(
    `SELECT m.sprint_id FROM missions m
       JOIN sprints s ON s.id = m.sprint_id
      WHERE m.status IN ('In Progress', 'Current')
        AND m.sprint_id IS NOT NULL
        AND ${statusNotIn("COALESCE(s.status, 'Planned')", DEAD_SPRINT_STATUSES)}
      LIMIT 1`,
    []
  );
  if (activeWorkResult.success && activeWorkResult.data?.sprint_id) {
    return activeWorkResult.data.sprint_id;
  }

  // Step 2: Prefer an explicitly open sprint unless it already looks fully completed.
  const explicitOpenSprintId = getExplicitOpenSprintId(client);
  if (explicitOpenSprintId) {
    return explicitOpenSprintId;
  }

  // Step 3: Most recently active sprint with mission/session activity, even if the
  // sprint status was never advanced beyond Planned.
  const recentActivitySprintId = getMostRecentlyActiveSprintId(client);
  if (recentActivitySprintId) {
    return recentActivitySprintId;
  }

  // Step 4: Earliest non-completed, non-archived sprint with Queued missions.
  const queuedWorkResult = client.getOne<{ sprint_id: string }>(
    `SELECT m.sprint_id FROM missions m
     JOIN sprints s ON m.sprint_id = s.id
     WHERE m.status = 'Queued' AND m.sprint_id IS NOT NULL
       AND ${statusNotIn("COALESCE(s.status, 'Planned')", NO_OPEN_WORK_STATUSES)}
     ORDER BY CASE COALESCE(s.status, 'Planned')
        WHEN 'In Progress' THEN 0
        WHEN 'Current' THEN 1
        WHEN 'Active' THEN 2
        WHEN 'Planned' THEN 3
        ELSE 4
      END, julianday(COALESCE(s.start_date, '9999-12-31')) ASC, s.rowid ASC
     LIMIT 1`,
    []
  );
  if (queuedWorkResult.success && queuedWorkResult.data?.sprint_id) {
    return queuedWorkResult.data.sprint_id;
  }

  // Step 5: Most recently active non-Archived sprint by real mission/session
  // activity, allowing Completed status. sprints.end_date (Step 6) is
  // admin-editable and drifts later than real activity (Sprint 63 m01), so
  // mission/session timestamps yield the genuinely most-recent shipped sprint.
  const recentlyActiveSprintId = getMostRecentlyActiveSprintIdIncludingCompleted(client);
  if (recentlyActiveSprintId) {
    return recentlyActiveSprintId;
  }

  // Step 6: Fall back to status-based ordering, with dead sprints excluded. When
  // no Active/In Progress/Planned sprint exists, prefer the latest Completed
  // sprint over silently returning a dead record.
  const result = client.getOne<{ id: string }>(
    `SELECT id
       FROM sprints
      WHERE ${statusNotIn("COALESCE(status, 'Planned')", DEAD_SPRINT_STATUSES)}
      ORDER BY CASE status
        WHEN 'In Progress' THEN 0
        WHEN 'Current' THEN 1
        WHEN 'Active' THEN 2
        WHEN 'Planned' THEN 3
        WHEN 'Completed' THEN 4
        ELSE 5
      END, julianday(COALESCE(end_date, start_date)) DESC, rowid DESC
      LIMIT 1`,
    []
  );

  return result.success ? (result.data?.id ?? null) : null;
}

/**
 * Resolve the sprint ID for a DURABLE WRITE — or `null` when nothing is open (s85-m03).
 *
 * **Read and write semantics diverge ON PURPOSE. Do not converge them.**
 *
 * {@link resolveCurrentSprintId} must ALWAYS be able to name a sprint, because a display
 * surface asking "which sprint am I looking at?" has no useful answer otherwise. That is why
 * its Steps 5–6 re-admit Completed sprints. Those same fallbacks are wrong for a durable
 * stamp: on a store whose sprints are all Completed they hand a dead sprint to the write
 * path, and the row keeps that label forever. Live evidence: this store has 76 sprints and
 * ZERO open; six planning sessions were stamped to sprints completed weeks earlier. An
 * external report (2026-07-30) independently found three months of engagement
 * work absorbed by a sprint closed in April — and on a Managed-tier project, which has no
 * sprints by design, there is never an open sprint to catch a session, so the mislabel is
 * guaranteed rather than incidental.
 *
 * The s77-m02 comment at rbook-session-start.ts:293-296 is exactly how the two got merged in
 * the first place: routing the write path through the display resolver looked like removing a
 * divergence. It removed the wrong one.
 *
 * Two legs, then null:
 *  1. **Active work** — the Step 1 query verbatim. Excludes only DEAD_SPRINT_STATUSES, so it
 *     correctly catches a `'Planned'` sprint that carries an In Progress mission.
 *  2. **Open status** — {@link getOpenStatusSprintId}, which is NOT
 *     `getExplicitOpenSprintId`. See that function's note for why reusing it would be a bug.
 *
 * Everything Steps 3–6 would have added is deliberately dropped. Note the real behavior delta
 * that follows: a `'Planned'` sprint whose missions are all Queued no longer receives the
 * write tag, though display still names it.
 */
export function resolveOpenSprintIdForWrite(client: RbookDatabaseClient): string | null {
  // Leg 1: a sprint with active work is unambiguously the one being worked in, whatever its
  // own status field says.
  const activeWorkResult = client.getOne<{ sprint_id: string }>(
    `SELECT m.sprint_id FROM missions m
       JOIN sprints s ON s.id = m.sprint_id
      WHERE m.status IN ('In Progress', 'Current')
        AND m.sprint_id IS NOT NULL
        AND ${statusNotIn("COALESCE(s.status, 'Planned')", DEAD_SPRINT_STATUSES)}
      LIMIT 1`,
    []
  );
  if (activeWorkResult.success && activeWorkResult.data?.sprint_id) {
    return activeWorkResult.data.sprint_id;
  }

  // Leg 2: an open-status sprint, whether or not it currently holds open work.
  return getOpenStatusSprintId(client);
}

/**
 * Leg 2 of {@link resolveOpenSprintIdForWrite}: the highest-priority sprint in an OPEN status,
 * with no open-work requirement.
 *
 * > **Why this is not `getExplicitOpenSprintId`.** That function additionally requires
 * > `NOT EXISTS(missions for this sprint) OR EXISTS(mission with status != 'Completed')`
 * > (see its `:162-170` clause). That predicate excludes an open-status sprint whose missions
 * > are ALL Completed — the wrap-up window between the last mission closing and
 * > `rbook_sprint(action="complete")` running, which is precisely when an agent is most likely
 * > to open a session. Reusing it would return NULL for a genuinely open sprint: a NEW
 * > mis-tagging defect traded for the old one. A live case exists in the portfolio
 * > (forge-data-viz-demos sprint S6: Active, 6 missions, all Completed).
 *
 * The status tiering and most-recent-real-activity tie-break mirror `getExplicitOpenSprintId`
 * so that when both do answer, they agree.
 */
function getOpenStatusSprintId(client: RbookDatabaseClient): string | null {
  const result = client.getOne<{ id: string }>(
    `SELECT s.id
       FROM sprints s
       LEFT JOIN (
         SELECT sprint_id, MAX(julianday(activity_at)) AS last_activity
           FROM (
             SELECT m.sprint_id AS sprint_id, m.completed_at AS activity_at
               FROM missions m
              WHERE m.sprint_id IS NOT NULL AND m.completed_at IS NOT NULL
             UNION ALL
             SELECT sess.sprint_id AS sprint_id,
                    COALESCE(sess.completed_at, sess.started_at) AS activity_at
               FROM sessions sess
              WHERE sess.sprint_id IS NOT NULL
           )
          GROUP BY sprint_id
       ) act ON act.sprint_id = s.id
      WHERE ${statusInSql("COALESCE(s.status, 'Planned')", SPRINT_OPEN_STATUSES)}
      ORDER BY CASE COALESCE(s.status, 'Planned')
        WHEN 'In Progress' THEN 0
        WHEN 'Current' THEN 1
        WHEN 'Active' THEN 2
        ELSE 3
      END, COALESCE(act.last_activity, 0) DESC, s.rowid DESC
      LIMIT 1`,
    []
  );

  return result.success ? (result.data?.id ?? null) : null;
}

/**
 * Step 2: the highest-priority explicitly-open sprint that still has open work (or
 * no missions yet).
 *
 * s77-m02 Fork 1b: within a status tier the tie-break is **most-recent real
 * activity** (max mission.completed_at / session timestamp) then `rowid DESC` —
 * NOT `start_date DESC`. This reuses the same activity signal Steps 3/5 already
 * trust (decision #661) and makes a multi-Active store deterministic: the sprint
 * that shipped work most recently wins, so onboard and mission-status agree
 * (retires the #853 ASC-vs-DESC divergence).
 */
function getExplicitOpenSprintId(client: RbookDatabaseClient): string | null {
  const result = client.getOne<{ id: string }>(
    `SELECT s.id
       FROM sprints s
       LEFT JOIN (
         SELECT sprint_id, MAX(julianday(activity_at)) AS last_activity
           FROM (
             SELECT m.sprint_id AS sprint_id, m.completed_at AS activity_at
               FROM missions m
              WHERE m.sprint_id IS NOT NULL AND m.completed_at IS NOT NULL
             UNION ALL
             SELECT sess.sprint_id AS sprint_id,
                    COALESCE(sess.completed_at, sess.started_at) AS activity_at
               FROM sessions sess
              WHERE sess.sprint_id IS NOT NULL
           )
          GROUP BY sprint_id
       ) act ON act.sprint_id = s.id
      WHERE ${statusInSql("COALESCE(s.status, 'Planned')", SPRINT_OPEN_STATUSES)}
        AND (
          NOT EXISTS (
            SELECT 1 FROM missions m WHERE m.sprint_id = s.id
          )
          OR EXISTS (
            SELECT 1 FROM missions m
             WHERE m.sprint_id = s.id AND NOT (${missionCompletedSql("COALESCE(m.status, '')")})
          )
        )
      ORDER BY CASE COALESCE(s.status, 'Planned')
        WHEN 'In Progress' THEN 0
        WHEN 'Current' THEN 1
        WHEN 'Active' THEN 2
        ELSE 3
      END, COALESCE(act.last_activity, 0) DESC, s.rowid DESC
      LIMIT 1`,
    []
  );

  return result.success ? (result.data?.id ?? null) : null;
}

/**
 * Step 3: most recently active sprint by real mission/session activity, excluding
 * the full NO_OPEN_WORK set (Archived/Failed/Dropped/Completed) so only genuinely
 * live parent sprints bubble up before the Completed-aware Step 5 (Sprint 74 m02).
 */
function getMostRecentlyActiveSprintId(client: RbookDatabaseClient): string | null {
  const result = client.getOne<{ sprint_id: string }>(
    `SELECT activity.sprint_id
       FROM (
         SELECT m.sprint_id, m.completed_at AS activity_at
           FROM missions m
           JOIN sprints s ON s.id = m.sprint_id
          WHERE m.sprint_id IS NOT NULL
            AND m.completed_at IS NOT NULL
            AND ${statusNotIn("COALESCE(s.status, 'Planned')", NO_OPEN_WORK_STATUSES)}
         UNION ALL
         SELECT sess.sprint_id, COALESCE(sess.completed_at, sess.started_at) AS activity_at
           FROM sessions sess
           JOIN sprints s ON s.id = sess.sprint_id
          WHERE sess.sprint_id IS NOT NULL
            AND ${statusNotIn("COALESCE(s.status, 'Planned')", NO_OPEN_WORK_STATUSES)}
       ) AS activity
      WHERE activity.activity_at IS NOT NULL
      GROUP BY activity.sprint_id
      ORDER BY MAX(julianday(activity.activity_at)) DESC, ${sprintIdOrderSql('activity.sprint_id', 'DESC')}
      LIMIT 1`,
    []
  );

  return result.success ? (result.data?.sprint_id ?? null) : null;
}

/**
 * Step 5: variant of {@link getMostRecentlyActiveSprintId} that allows Completed
 * sprints (the steady-state fallback for fork-and-forget projects where every
 * sprint is Completed) but still excludes the DEAD set (Sprint 63 m01 / 74 m02).
 */
function getMostRecentlyActiveSprintIdIncludingCompleted(
  client: RbookDatabaseClient
): string | null {
  const result = client.getOne<{ sprint_id: string }>(
    `SELECT activity.sprint_id
       FROM (
         SELECT m.sprint_id, m.completed_at AS activity_at
           FROM missions m
           JOIN sprints s ON s.id = m.sprint_id
          WHERE m.sprint_id IS NOT NULL
            AND m.completed_at IS NOT NULL
            AND ${statusNotIn("COALESCE(s.status, 'Planned')", DEAD_SPRINT_STATUSES)}
         UNION ALL
         SELECT sess.sprint_id, COALESCE(sess.completed_at, sess.started_at) AS activity_at
           FROM sessions sess
           JOIN sprints s ON s.id = sess.sprint_id
          WHERE sess.sprint_id IS NOT NULL
            AND ${statusNotIn("COALESCE(s.status, 'Planned')", DEAD_SPRINT_STATUSES)}
       ) AS activity
      WHERE activity.activity_at IS NOT NULL
      GROUP BY activity.sprint_id
      ORDER BY MAX(julianday(activity.activity_at)) DESC, ${sprintIdOrderSql('activity.sprint_id', 'DESC')}
      LIMIT 1`,
    []
  );

  return result.success ? (result.data?.sprint_id ?? null) : null;
}
