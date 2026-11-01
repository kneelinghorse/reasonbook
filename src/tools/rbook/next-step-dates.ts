// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02 — a next step's date: checkAfter read as a future UTC day, stored as the row's lease
// ABOUTME: anchor in the bare YYYY-MM-DD spelling no other writer produces, and read back as waiting or due.

import { RBOOK_ERROR_CODES } from './errors';
import { storedTimeMs } from './stored-time';
import type { RbookToolError } from './types';

/**
 * WHY THE DATE IS THE LEASE ANCHOR (the sprint-108 design, settled items 2 and 4). A new column on
 * `next_steps` would break older copies of a shared record and older runtimes on the same machine.
 * Every 4.x lease already anchors on `COALESCE(resolved_at, created_at)`, so a date written into
 * `resolved_at` gives 0 closes survived and a negative age until it arrives: the row is "ok" on every
 * copy and every runtime, and no close drops it. The row is `carried` with `carried_to_sprint` NULL,
 * the documented parked carry, so it stays out of pending counts and an older reopen keeps the date.
 *
 * THE SPELLING IS THE MARKER. Every other writer stamps a full ISO instant, and none of the 7,907
 * stamps in the 26 registered stores was a bare date when the design was made. So an open row whose
 * `resolved_at` is a bare date waits until that day, 00:00 UTC, as julianday() reads it; once the day
 * has come it is due since then. Any later carry, complete, drop or lease drop, by any release on any
 * copy, writes a full instant and ends the wait. NEVER NORMALISE A STORED TIME: a step that rewrote
 * stored stamps into one spelling would erase every date (a test pins this).
 */

/** The furthest ahead a date may be. A later trigger belongs in a document (practice 10). */
export const CHECK_AFTER_MAX_DAYS = 180;

const DAY_MS = 86_400_000;
/** The marker's spelling, a bare YYYY-MM-DD; the signals' work_due reads a mission's date by it too. */
export const BARE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?$/;

/** SQL true for an open row's stored bare date, the marker above (GLOB matches the spelling exactly). */
export function bareDateSql(column: string): string {
  return `${column} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`;
}

/** SQL true for a row whose stored bare date is still ahead: it waits, and is not open work yet. */
export function waitingSql(column: string): string {
  return `COALESCE(${bareDateSql(column)} AND julianday(${column}) > julianday('now'), 0)`;
}

/** What a date does on a shared record, said by every answer that writes one (settled item 4). */
export const SHARED_DATE_NOTE =
  'This record is shared, so the date travels to every copy. A carry of the same row on another copy at the same time conflicts, the newer write shows, and rbook_db(action="settle") settles it; a copy on a release before 4.10.0 erases the date with any carry, including a broad one.';

/** The UTC calendar day of an instant, as YYYY-MM-DD. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The day itself when year, month and day name a real one; SQLite would roll 2026-02-30 to March 2. */
function realDay(year: number, month: number, day: number): string | null {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? utcDay(date.getTime())
    : null;
}

/** What an entry means, before the window is checked; null when it names no day. */
function dayOf(raw: string): string | null {
  const bare = BARE_DATE.exec(raw);
  if (bare) return realDay(Number(bare[1]), Number(bare[2]), Number(bare[3]));
  const month = MONTH.exec(raw);
  if (month) return realDay(Number(month[1]), Number(month[2]), 1);
  const dateTime = DATE_TIME.exec(raw);
  if (dateTime) {
    // The date part must be a real day too; a zone-less time is UTC, as storedTimeMs reads it.
    if (!realDay(Number(dateTime[1]), Number(dateTime[2]), Number(dateTime[3]))) return null;
    const ms = storedTimeMs(raw);
    return Number.isFinite(ms) ? utcDay(ms) : null;
  }
  return null;
}

export type CheckAfterUse = 'capture' | 'carry';

/**
 * checkAfter read as the bare day to store, or the refusal. Only a day after today (UTC) and at most
 * CHECK_AFTER_MAX_DAYS ahead is accepted: written as the anchor, today or a past day would put the
 * row at or past its drop age at once. Every refusal prints today's UTC date, which in an American
 * evening is already tomorrow.
 */
export function readCheckAfter(
  value: string,
  use: CheckAfterUse,
  nowMs: number = Date.now()
): { day: string } | { error: RbookToolError } {
  const raw = value.trim();
  const today = utcDay(nowMs);
  const latest = utcDay(nowMs + CHECK_AFTER_MAX_DAYS * DAY_MS);
  const refused = (message: string) => ({
    code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
    field: 'checkAfter',
    providedValue: value,
    message: `${message} Today is ${today} (UTC).`,
  });
  const day = dayOf(raw);
  if (day === null)
    return {
      error: {
        ...refused(`checkAfter '${value}' is not a calendar date.`),
        suggestion:
          'Give a day as YYYY-MM-DD, a month as YYYY-MM (its first day), or a date-time, which is reduced to its UTC day.',
      },
    };
  if (day <= today)
    return {
      error: {
        ...refused(
          `checkAfter ${day} is not after today, so the next step would wait for nothing.`
        ),
        suggestion:
          use === 'capture'
            ? `Capture it without checkAfter, or give a day after ${today}.`
            : `Carry it without checkAfter, which renews its lease, or give a day after ${today}.`,
      },
    };
  if (day > latest)
    return {
      error: {
        ...refused(`checkAfter ${day} is more than ${CHECK_AFTER_MAX_DAYS} days ahead.`),
        suggestion: `Give a day up to ${latest}. A trigger further out belongs in a document, beside the work it waits on.`,
      },
    };
  return { day };
}

/** An open row's date as list and show report it: waiting until the day, or due since it. */
export interface NextStepWait {
  readonly waitsUntil?: string;
  readonly dueSince?: string;
}

export function nextStepWait(
  status: string,
  resolvedAt: string | null | undefined,
  nowMs: number = Date.now()
): NextStepWait {
  if (status !== 'pending' && status !== 'carried') return {};
  if (typeof resolvedAt !== 'string' || !BARE_DATE.test(resolvedAt)) return {};
  const at = storedTimeMs(resolvedAt);
  if (!Number.isFinite(at)) return {};
  return at > nowMs ? { waitsUntil: resolvedAt } : { dueSince: resolvedAt };
}
