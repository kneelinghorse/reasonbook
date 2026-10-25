// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s85-m03 — the "N rows have no sprint tag" advisories. Sprint-scoped surfaces count
// ABOUTME: disclose their membership rule so untagged records are never silently miscounted.

/**
 * Untagged-row advisories (s85-m03).
 *
 * s85-m03 made a session started with no open sprint record `sprint_id = NULL` instead of
 * inheriting a Completed sprint. That is the honest record, but it has a cost: every surface
 * that counts strictly by `sessions.sprint_id = ?` or `strategic_decisions.sprint_id` now
 * under-reports, and an under-report is indistinguishable from "there was no work".
 *
 * The advisory follows the consumer's membership rule without changing stored sprint tags.
 * Sprint completion still counts strictly by sprint_id. Since s102-m03, retro also counts
 * sessions linked to a mission in the requested sprint; its advisory states that inclusion.
 *
 * Three consumers: `rbook_sprint(action="retro")`, `rbook_sprint(action="complete")` and
 * `rbook_decisions(action="review")`. One implementation each so the wording cannot drift.
 *
 * @module tools/rbook/untagged-advisory
 */

import type { RbookDatabaseClient } from './client';
import { storedTimeMs } from './stored-time';

interface SprintWindow {
  readonly start: string | null;
  readonly end: string;
}

/**
 * Count sessions carrying no sprint tag, or `null` when the query cannot run.
 *
 * Without a window this is store-wide; close scopes by start time, never inferred sprint tags.
 * A consumer may separately include one through an explicit mission link, as retro does.
 */
export function countUntaggedSessions(
  client: RbookDatabaseClient,
  window?: SprintWindow
): number | null {
  // s93-m01 (#610 related): implicit sessions carry no sprint by design (a process outlives sprints)
  // and every row they write resolves its own, so only explicit sessions count as untagged.
  const implicitColumn = client.getOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pragma_table_info('sessions') WHERE name = 'implicit'",
    []
  );
  if (!implicitColumn.success) return null;
  const explicitOnly =
    implicitColumn.success && (implicitColumn.data?.n ?? 0) > 0 ? ' AND implicit = 0' : '';
  const result = client.getOne<{ count: number }>(
    `SELECT COUNT(*) AS count FROM sessions WHERE sprint_id IS NULL${explicitOnly}${window ? ' AND julianday(started_at) >= julianday(?) AND julianday(started_at) <= julianday(?)' : ''}`,
    window ? [window.start, window.end] : []
  );
  return result.success && result.data ? result.data.count : null;
}

/**
 * Build the sprint-surface advisory, or `null` when there is nothing to report.
 *
 * Sprint close retains its tag-only rule. Retro opts into the mission-link wording because
 * linked untagged sessions appear in its totals; decisions and learnings retain their own tags.
 */
export function buildUntaggedSessionAdvisory(
  client: RbookDatabaseClient,
  membership: 'sprint-tag' | 'mission-link' = 'sprint-tag',
  window?: SprintWindow
): string | null {
  if (
    window &&
    (!Number.isFinite(storedTimeMs(window.start)) || !Number.isFinite(storedTimeMs(window.end)))
  )
    return 'Untagged-session advisory unavailable: the sprint window has no readable start or close time. Other record totals retain their own membership rules; no store-wide count was substituted.';
  const count = countUntaggedSessions(client, window);
  if (count === null)
    return window
      ? 'Untagged-session advisory unavailable: the sprint-window count could not be read. Restore read access to sessions and retry the retrospective.'
      : null;
  if (count === 0) return null;
  if (window)
    return `${count} explicit session(s) started in this sprint's window (${window.start} through ${window.end}, inclusive) carry no sprint tag and are not counted as sprint-tagged sessions. Decision and learning totals use their own sprint tags or links through missions or author sessions in this sprint; an untagged session does not by itself exclude its records.`;
  if (membership === 'mission-link') {
    return (
      `${count} explicit session(s) in this store carry no sprint tag. This retrospective counts ` +
      `sessions tagged to this sprint or linked to one of its missions; untagged sessions without ` +
      `such a link are not counted. Decisions and learnings are counted by their own sprint tags, ` +
      `independently of session links.`
    );
  }
  return (
    `${count} session(s) in this store carry no sprint tag and are therefore NOT counted here ` +
    `(nor are the decisions, learnings, constraints and next-steps captured in them). This is ` +
    `expected for sessions started while no sprint was in an open status — the record is ` +
    `untagged by design, not missing. Work can stay unscheduled; use rbook_sprint(action="add") if ` +
    `you want it sprint-scoped.`
  );
}

/**
 * Build the decision-triage advisory, or `null` when there is nothing to report.
 *
 * s91-m08: `rbook_decisions(action="review")` now scores untagged decisions by wall-clock age
 * (they used to be permanently invisible to triage). The advisory still names how many there
 * are, because their age is approximate: it counts 14-day periods, not real sprint closes.
 */
export function buildUntaggedDecisionAdvisory(client: RbookDatabaseClient): string | null {
  const result = client.getOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM strategic_decisions WHERE sprint_id IS NULL AND COALESCE(status, 'active') = 'active'",
    []
  );
  if (!result.success || !result.data || result.data.count === 0) return null;
  return (
    `${result.data.count} active decision(s) have no sprint tag and are aged on wall-clock time ` +
    `because they carry no sprint tag (one sprint per 14 days since creation). Decisions ` +
    `captured while no sprint was open are untagged by design. Review them directly ` +
    `with rbook_decisions(action="list").`
  );
}
