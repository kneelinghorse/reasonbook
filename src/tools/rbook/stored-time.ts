// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 — a stored timestamp read as an instant the way SQLite's julianday() reads it, so a
// ABOUTME: comparison or ordering done in JavaScript agrees with the same one done in SQL (#607, #597).

import { RbookErrors } from './errors';
import type { RbookToolError } from './types';

/**
 * WHY. Stored times are UTC, in three spellings that real stores hold side by side: ISO-8601 with
 * `Z`, the same with milliseconds, and SQLite's CURRENT_TIMESTAMP spelling `YYYY-MM-DD HH:MM:SS`
 * with no zone. Compared as text, a space sorts before `T`, so one instant spelled two ways orders
 * wrongly (a copy of the meridian store listed #480 after #475 that way); and Date.parse reads a
 * zone-less date-time as LOCAL time. SQL compares through julianday(), which reads every zone-less
 * spelling as UTC; these helpers do the same, so a sort or filter in JavaScript matches it.
 */

// SQLite's calendar grammar: no leading whitespace, uppercase T/ASCII whitespace between date
// and time, and optional Z/z or HH:MM offset. Numeric Julian dates, time-only and "now" are not
// stored calendar timestamps. Do not pass other spellings to V8's locale-dependent Date.parse.
const STORED_CALENDAR_TIME =
  /^(-?\d{4})-(\d{2})-(\d{2})[ T\t\n\v\f\r]*(?:(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,308}))?)?(?:[ \t\n\v\f\r]*(?:[Zz]|([+-])(\d{2}):(\d{2})))?[ \t\n\v\f\r]*)?$/;

/**
 * Milliseconds since the epoch for a stored time, or NaN where julianday() would give NULL. A
 * zone-less date-time is UTC, and a date alone is its midnight UTC.
 */
export function storedTimeMs(value: string | null | undefined): number {
  if (typeof value !== 'string') return NaN;
  const match = STORED_CALENDAR_TIME.exec(value);
  if (!match) return NaN;
  const [, y, mo, d, h = '0', mi = '0', s = '0', fraction = '0', sign, zh = '0', zm = '0'] = match;
  const [year, month, day, hour, minute, second, zoneHour, zoneMinute] = [
    y,
    mo,
    d,
    h,
    mi,
    s,
    zh,
    zm,
  ].map(Number);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 24 ||
    minute > 59 ||
    second > 59 ||
    zoneHour > 14 ||
    zoneMinute > 59
  )
    return NaN;

  // SQLite normalizes day 29–31 overflow and hour 24. setUTCFullYear avoids Date.UTC's special
  // 1900-based interpretation of years 0–99. SQLite rounds milliseconds, clamping fractions at
  // .999 before rounding so .9999 never rolls into the next second (parseHhMmSs/computeJD).
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  // The same decimal accumulation as SQLite, bounded to 308 digits so its scale stays finite.
  // Longer fractions hit engine-dependent floating-point overflow; refuse them explicitly.
  let numerator = 0;
  let scale = 1;
  for (const digit of fraction) {
    numerator = numerator * 10 + Number(digit);
    scale *= 10;
  }
  const milliseconds = Math.floor((second + Math.min(numerator / scale, 0.999)) * 1000 + 0.5);
  date.setUTCHours(hour, minute, 0, milliseconds);
  const offset = (zoneHour * 60 + zoneMinute) * 60_000 * (sign === '-' ? -1 : 1);
  const result = date.getTime() - offset;
  // SQLite's valid Julian-day interval, expressed as Unix milliseconds.
  return result >= -210866760000000 && result <= 253402300799999 ? result : NaN;
}

/**
 * Oldest first, as `ORDER BY julianday(x)` orders: a time it cannot read sorts first, as its NULL
 * does. For newest first, swap the arguments; an unreadable time then sorts last, as in DESC.
 */
export function compareStoredTimes(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const x = storedTimeMs(a);
  const y = storedTimeMs(b);
  const xUnread = Number.isNaN(x);
  const yUnread = Number.isNaN(y);
  if (xUnread || yUnread) return xUnread === yUnread ? 0 : xUnread ? -1 : 1;
  return x - y;
}

/** The spellings julianday() reads that a caller would write: a date, then optionally a time. */
const TIME_BOUND =
  /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/;

/**
 * A since/until bound as SQL will compare it, or null when it cannot be read as a time. A year or
 * a month alone, which julianday() cannot read (so `since="2026-10"` matched nothing), widens to
 * its period: a since starts it and an until ends it.
 */
export function timeBound(value: string, edge: 'since' | 'until'): string | null {
  const raw = value.trim();
  const period = /^(\d{4})(?:-(\d{2}))?$/.exec(raw);
  if (period) {
    const year = Number(period[1]);
    const month = period[2] === undefined ? null : Number(period[2]) - 1;
    if (month !== null && (month < 0 || month > 11)) return null;
    const start = new Date(0);
    start.setUTCFullYear(year, month ?? 0, 1);
    const next = new Date(start);
    if (month === null) next.setUTCFullYear(year + 1);
    else next.setUTCMonth(month + 1);
    return new Date(edge === 'since' ? start.getTime() : next.getTime() - 1).toISOString();
  }
  return TIME_BOUND.test(raw) && !Number.isNaN(storedTimeMs(raw)) ? raw : null;
}

/**
 * A call's since/until read as bounds (timeBound), or the refusal for the first that cannot be.
 * Bounds the call did not pass stay absent.
 */
export function readTimeBounds(params: {
  since?: string;
  until?: string;
}): { since?: string; until?: string } | { error: RbookToolError } {
  const out: { since?: string; until?: string } = {};
  for (const edge of ['since', 'until'] as const) {
    const value = params[edge];
    if (value === undefined) continue;
    const bound = timeBound(value, edge);
    if (bound === null) return { error: RbookErrors.invalidTimeBound(edge, value) };
    out[edge] = bound;
  }
  return out;
}
