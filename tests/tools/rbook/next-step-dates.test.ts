// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02 — what a next step's date may be: only a real day after today (UTC), at most 180 days
// ABOUTME: ahead, kept in the bare spelling that marks it; every refusal names today's UTC date.

import { describe, expect, it } from '@jest/globals';
import {
  bareDateSql,
  CHECK_AFTER_MAX_DAYS,
  nextStepWait,
  readCheckAfter,
  utcDay,
} from '../../../src/tools/rbook/next-step-dates';
import Database from 'better-sqlite3';

const DAY = 86_400_000;
// A Chicago evening: 23:30 local on a day whose UTC date is already the next one.
const now = Date.UTC(2031, 2, 10, 4, 30); // 2031-03-10T04:30Z, 2031-03-09 23:30 in Chicago
const day = (offset: number) => utcDay(now + offset * DAY);
const read = (value: string, use: 'capture' | 'carry' = 'carry') => readCheckAfter(value, use, now);
const refusal = (value: string, use: 'capture' | 'carry' = 'carry') => {
  const result = read(value, use);
  if (!('error' in result)) throw new Error(`accepted ${value} as ${result.day}`);
  return result.error;
};

describe('checkAfter is a future UTC day, stored bare', () => {
  it('keeps a real future date as written, and reads a month as its first day', () => {
    expect(read(day(1))).toEqual({ day: day(1) });
    expect(read('2031-04')).toEqual({ day: '2031-04-01' });
    expect(read(`  ${day(30)}  `)).toEqual({ day: day(30) });
  });

  it('reduces a date-time to its UTC day, a zone-less one read as UTC', () => {
    expect(read('2031-03-20T23:30:00-05:00')).toEqual({ day: '2031-03-21' });
    expect(read('2031-03-20T01:00')).toEqual({ day: '2031-03-20' });
    expect(read('2031-03-20 12:00:00.5Z')).toEqual({ day: '2031-03-20' });
  });

  it('refuses today, the past and a month that has begun, because the row would be due or lapsing at once', () => {
    // The UTC day is 2031-03-10 although it is still the 9th in Chicago.
    for (const value of [day(0), day(-1), '2031-03-09', '2031-03', '2031-03-10T23:59:59Z']) {
      const error = refusal(value);
      expect(error.code).toBe('INVALID_PARAMETER');
      expect(error.field).toBe('checkAfter');
      expect(error.message).toContain('Today is 2031-03-10 (UTC).');
    }
    expect(refusal(day(0), 'carry').suggestion).toMatch(
      /Carry it without checkAfter, which renews its lease/
    );
    expect(refusal(day(0), 'capture').suggestion).toMatch(/Capture it without checkAfter/);
  });

  it('refuses an impossible date, a bare year and free text instead of letting SQLite roll them over', () => {
    for (const value of [
      '2031-02-30',
      '2031-02-29T10:00Z',
      '2031-13',
      '2031',
      'next week',
      '31/03/2031',
      '2031-3-20',
    ])
      expect(refusal(value).message).toContain('is not a calendar date');
    // SQLite itself would accept the impossible one and read it as March 2.
    const db = new Database(':memory:');
    expect(db.prepare("SELECT date('2031-02-30') AS d").get()).toEqual({ d: '2031-03-02' });
    db.close();
  });

  it(`refuses a day more than ${CHECK_AFTER_MAX_DAYS} days ahead, pointing the trigger at a document`, () => {
    expect(read(day(CHECK_AFTER_MAX_DAYS))).toEqual({ day: day(CHECK_AFTER_MAX_DAYS) });
    const error = refusal(day(CHECK_AFTER_MAX_DAYS + 1));
    expect(error.message).toContain(`more than ${CHECK_AFTER_MAX_DAYS} days ahead`);
    expect(error.suggestion).toContain('belongs in a document');
  });
});

describe('an open row with a bare date waits until it, then is due since it', () => {
  it('reads only the bare spelling on open rows, from 00:00 UTC of the day', () => {
    expect(nextStepWait('carried', '2031-03-11', now)).toEqual({ waitsUntil: '2031-03-11' });
    expect(nextStepWait('pending', '2031-03-10', now)).toEqual({ dueSince: '2031-03-10' });
    expect(nextStepWait('carried', '2031-03-10', Date.UTC(2031, 2, 9, 23, 59))).toEqual({
      waitsUntil: '2031-03-10',
    });
    // Every other writer stamps a full instant, which is never a date, however far ahead.
    expect(nextStepWait('carried', '2031-09-01T00:00:00.000Z', now)).toEqual({});
    expect(nextStepWait('carried', null, now)).toEqual({});
    // A resolved row is never waiting or due, whatever spin-out left in its resolved_at.
    for (const status of ['completed', 'dropped'])
      expect(nextStepWait(status, '2031-03-11', now)).toEqual({});
  });

  it('matches the SQL marker on exactly the same spellings', () => {
    const db = new Database(':memory:');
    const marked = (value: string) =>
      (db.prepare(`SELECT ${bareDateSql('?')} AS m`).get(value) as { m: number }).m === 1;
    for (const value of ['2031-03-11', '0999-01-01']) expect(marked(value)).toBe(true);
    for (const value of ['2031-03-11T00:00:00.000Z', '2031-03-11 ', '2031-3-11', '2031-03', ''])
      expect(marked(value)).toBe(false);
    db.close();
  });
});
