// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The next-steps lease (policy 2, s91-m06; s92-m02): age is real sprint closes survived since
// ABOUTME: creation or last carry; warn at 3, drop at 4 unless carried, never younger than 14 days.

import type { RbookDatabaseClient } from './client';

/**
 * WHY A LEASE. Next-steps and carry-forwards accumulated with no way to expire: rows #486-#506
 * were six closes old at sprint-91 planning and nothing had disposed of them. Policy 2 (operator,
 * 2026-09-17): a row holds a lease that lapses unless renewed. CARRY is the renewal — it stamps
 * `resolved_at` and resets the clock. REOPEN clears that timestamp for completed/dropped rows,
 * restoring the creation anchor; reopening carried rows preserves their last carry anchor.
 *
 * s92-m02 — WHAT A CLOSE IS. 3.1.0 counted a close by `sprints.end_date`, and `rbook_sprint(complete)`
 * kept a PLANNED end date when one was set (`COALESCE(end_date, ?)`). A sprint planned to end next
 * week but closed today therefore counted as a close survived by rows carried after it closed:
 * TraceLab lost 58 freshly carried rows that way (its feedback #83). Since 3.2.0 every close stamps
 * its actual close time, a one-time repair re-dates the sprints that kept a planned date, and the
 * count itself ignores any end_date still in the future.
 *
 * CALENDAR BOUNDS (operator Q4, decision #1161): a row is never dropped before it is
 * {@link LEASE_MIN_AGE_DAYS} days past its lease anchor, however many closes it survived (TraceLab
 * dropped never-carried rows aged 8–14 days after five closes in 45 hours); and a row that has
 * survived no close at all is flagged idle after {@link LEASE_IDLE_WARN_DAYS} days. Nothing is ever
 * dropped by the calendar alone.
 *
 * NO SCHEMA CHANGE. The anchors (`created_at`, the last carry's `resolved_at`) and every close's
 * `sprints.end_date` are already on disk.
 *
 * s108-m02 — A DATE IS AN ANCHOR TOO. A row that waits until a day holds it in `resolved_at`, in the
 * bare YYYY-MM-DD spelling no other writer produces (next-step-dates.ts). Ahead of now it survives
 * no close and its age is negative, so no close drops it; from the day on, its lease runs from the
 * day. This module computes nothing new for it. Never normalise stored times: that would erase the
 * marker that tells a date from a carry.
 */

export const LEASE_WARN_AT = 3;
export const LEASE_LAPSE_AT = 4;
/** s92-m02 — the minimum age, in days past the lease anchor, before a close may drop a row. */
export const LEASE_MIN_AGE_DAYS = 14;
/** s92-m02 — a row that has survived no close is flagged idle after this many days. */
export const LEASE_IDLE_WARN_DAYS = 42;

/**
 * Published verbatim on every surface that shows the number. The denominator names its own hole:
 * a Completed sprint with no recorded end_date (sprint-13..16 and 18..20 on the origin store) is
 * not counted.
 */
export const LEASE_COUNTING_RULE =
  "closes survived = Completed sprints whose recorded end_date — the actual close time — is in the past and later than the row's resolved_at " +
  '(the day a dated row waits until, else its last carry or the reopen that ended a wait) or, if neither, its created_at; a close counts only after it completes, so ' +
  'the closing sprint never counts toward its own close. A row at the drop age is dropped only once it is ' +
  `also ${LEASE_MIN_AGE_DAYS} days past that same anchor; a row that has survived no close for ` +
  `${LEASE_IDLE_WARN_DAYS} days is flagged idle; nothing is dropped by the calendar alone`;

/**
 * Correlated subquery over `next_steps` aliased as `n`. s92-m02: an end_date still in the future —
 * a planned date that outlived its close — never counts.
 */
export const CLOSES_SURVIVED_SQL = `(SELECT COUNT(*) FROM sprints s
    WHERE s.status = 'Completed'
      AND s.end_date IS NOT NULL AND s.end_date <> ''
      AND julianday(s.end_date) <= julianday('now')
      AND julianday(s.end_date) > julianday(COALESCE(n.resolved_at, n.created_at)))`;

/** s92-m02 — days since the row's lease anchor (its last carry, else its creation). */
export const LEASE_AGE_DAYS_SQL = `(julianday('now') - julianday(COALESCE(n.resolved_at, n.created_at)))`;

/** Statuses a lease applies to — the open ones. */
export const LEASED_STATUS_SQL = "n.status IN ('pending','carried')";

/**
 * `lapsing`: the next close drops it unless it is carried first. `warning`: at or past the warning
 * age — including a row past the drop age that the 14-day floor still protects. `idle`: no close
 * survived for 6+ weeks (a warning only, never a drop). The close computes ages BEFORE it writes
 * its own end_date, so a row at LEASE_LAPSE_AT going into a close is dropped by that close.
 */
export type LeaseState = 'ok' | 'warning' | 'lapsing' | 'idle';

/**
 * @param closesSurvived - real closes survived since the lease anchor
 * @param ageDays - days since the lease anchor; when unknown, the calendar bounds cannot be applied,
 *   so the row is treated as old enough (the s91-m06 behaviour)
 */
export function leaseState(closesSurvived: number, ageDays?: number | null): LeaseState {
  const known = typeof ageDays === 'number' && Number.isFinite(ageDays);
  if (closesSurvived >= LEASE_LAPSE_AT && (!known || ageDays >= LEASE_MIN_AGE_DAYS)) {
    return 'lapsing';
  }
  if (closesSurvived >= LEASE_WARN_AT) return 'warning';
  if (closesSurvived === 0 && known && ageDays >= LEASE_IDLE_WARN_DAYS) return 'idle';
  return 'ok';
}

export interface LeaseAge {
  id: number;
  status: 'pending' | 'carried';
  closesSurvived: number;
  /** s92-m02 — days since the lease anchor; null when the anchor did not parse. */
  ageDays: number | null;
}

/** Ages of every open next-step, or `null` when the read failed (never a silent zero). */
export function readLeaseAges(client: RbookDatabaseClient): LeaseAge[] | null {
  const rows = client.getMany<LeaseAge>(
    `SELECT n.id AS id, n.status AS status, ${CLOSES_SURVIVED_SQL} AS closesSurvived,
            ${LEASE_AGE_DAYS_SQL} AS ageDays
       FROM next_steps n
      WHERE ${LEASED_STATUS_SQL}
      ORDER BY n.id ASC`,
    []
  );
  return rows.success && rows.data ? rows.data : null;
}

/** The exact command that undoes a lease drop, printed beside the ids it drops. */
export function reopenCommand(ids: readonly number[]): string {
  return `rbook_context(action="next_steps", nextStepAction="reopen", nextStepIds=[${ids.join(', ')}])`;
}
