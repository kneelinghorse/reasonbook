// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Stored calendar times obey SQLite's normalization and NULL grammar without V8's locale fallback.
// ABOUTME: Cross-process time-zone fixtures keep malformed expiries out of signals and the brief.

import { afterEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSignals, renderBrief } from '../../../src/signals';
import { compareStoredTimes, storedTimeMs, timeBound } from '../../../src/tools/rbook/stored-time';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const year = new Date().getUTCFullYear();
const date = `${year}-02-28`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sqlMs(value: string | null): number | null {
  const db = new Database(':memory:');
  try {
    return (
      db
        .prepare('SELECT CAST(ROUND((julianday(?) - 2440587.5) * 86400000) AS INTEGER) AS ms')
        .get(value) as { ms: number | null }
    ).ms;
  } finally {
    db.close();
  }
}

it.each([
  `${date}T00:00:00.071588Z`,
  `${date}T00:00:59.9999Z`,
  `${date}T00:00:00.0005Z`,
  `${date}T00:00:00.0004Z`,
  `${year}-02-30`,
  `${year}-02-31T24:59:59.5-14:59`,
  `${year}-04-31 12:30`,
  `${date} T T 03:04:05 z\t`,
  `${date}03:04:05`,
  `${date}T`,
  `${date}T03:04+00:01`,
  // Calendar boundaries are grammar fixtures, independent of the current time.
  '0000-01-01',
  '0099-12-31T00:00:00Z',
  '-0001-01-01T00:00:00Z',
  '-4713-11-24T12:00:00Z',
  '9999-12-31T23:59:59.999Z',
])('normalizes %s to SQLite’s exact millisecond instant', (value) => {
  const expected = sqlMs(value);
  expect(expected).not.toBeNull();
  expect(storedTimeMs(value)).toBe(expected);
});

it.each([
  `${year}/02/28 12:00:00`,
  `Feb 28 ${year} 12:00:00`,
  `${date}t12:00:00`,
  ` ${date}`,
  `\u00a0${date}`,
  `${date}Z`,
  `${year}-00-01`,
  `${year}-13-01`,
  `${year}-01-00`,
  `${year}-01-32`,
  `${date}T25:00:00Z`,
  `${date}T12:60:00Z`,
  `${date}T12:00:60Z`,
  `${date}T12:00:00+15:00`,
  `${date}T12:00:00+00:60`,
  `${date}T12:00:00.`,
  '9999-12-31T24:00:00Z',
  '-4713-11-24T11:59:59Z',
  '',
  'yesterday',
  null,
])('returns NaN for %j where SQLite returns NULL', (value) => {
  expect(sqlMs(value)).toBeNull();
  expect(Number.isNaN(storedTimeMs(value))).toBe(true);
});

it('keeps missing, dynamic, numeric Julian and time-only values outside the stored-calendar grammar', () => {
  for (const value of [undefined, 'now', '2460000', '12:00:00'])
    expect(Number.isNaN(storedTimeMs(value))).toBe(true);
});

it('refuses fractions beyond SQLite’s finite decimal accumulation range', () => {
  for (const digits of [309, 4_000]) {
    const value = `${date}T12:00:59.${'9'.repeat(digits)}Z`;
    expect(Number.isNaN(storedTimeMs(value))).toBe(true);
  }
});

it('matches SQLite’s finite decimal accumulation rather than reparsing a long fraction', () => {
  for (const digits of [20, 100, 308]) {
    const value = `${date}T00:00:00.${'0005'.padEnd(digits, '0')}Z`;
    expect(storedTimeMs(value)).toBe(sqlMs(value));
  }
});

it('orders malformed locale times as NULL and refuses them as query bounds', () => {
  const malformed = `${year}/02/28 12:00:00`;
  expect(compareStoredTimes(malformed, date)).toBeLessThan(0);
  expect(timeBound(malformed, 'since')).toBeNull();
});

it('keeps year/month expansion correct below year 100 and at the upper calendar boundary', () => {
  expect(timeBound('0000', 'since')).toBe('0000-01-01T00:00:00.000Z');
  expect(timeBound('0099-02', 'until')).toBe('0099-02-28T23:59:59.999Z');
  expect(timeBound('9999', 'until')).toBe('9999-12-31T23:59:59.999Z');
});

it('the same stored NULL, malformed and valid expiries give the same report in every time zone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-time-contract-'));
  roots.push(root);
  const file = seedRbookDb(root, { projectId: 'time-contract' });
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  const expiry = new Date(storedTimeMs(now) + 7 * 86_400_000).toISOString();
  const zoneless = expiry.slice(0, 19).replace('T', ' ');
  const invalid = [zoneless.replace(/-/g, '/'), expiry.replace('T', 't')];
  const db = new Database(file);
  try {
    const insert = db.prepare(
      "INSERT INTO constraints(content,status,created_at,expires_at) VALUES (?, 'active', ?, ?)"
    );
    for (const [i, value] of [null, ...invalid, zoneless].entries())
      insert.run(`expiry ${i}`, now, value);
  } finally {
    db.close();
  }
  const script = `
    require(${JSON.stringify(path.resolve(__dirname, '../../helpers/ts-register.js'))});
    const {readSignals, renderBrief} = require(${JSON.stringify(path.resolve(__dirname, '../../../src/signals'))});
    const report = readSignals(${JSON.stringify(file)}, {now: ${JSON.stringify(now)}});
    process.stdout.write(JSON.stringify({report, brief: renderBrief([report], {now: ${JSON.stringify(now)}})}));
  `;
  const outputs = ['UTC', 'Pacific/Kiritimati', 'America/St_Johns'].map((TZ) => {
    const child = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, TZ, LANG: TZ === 'UTC' ? 'tr_TR.UTF-8' : 'C' },
    });
    expect(child.status).toBe(0);
    return child.stdout;
  });
  expect(new Set(outputs).size).toBe(1);
  const parsed = JSON.parse(outputs[0]);
  expect(
    parsed.report.signals.find((s: { kind: string }) => s.kind === 'constraints_expiring').count
  ).toBe(1);
  for (const bad of invalid) {
    expect(() => readSignals(file, { now: bad })).toThrow('now must be a valid time');
    expect(() => renderBrief([], { now: bad })).toThrow('now must be a valid time');
  }
});
