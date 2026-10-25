// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Snapshot age comparisons accept explicit instants rather than host-local date parsing.
// ABOUTME: Preserves SQLite UTC timestamps while refusing ambiguous or unrelated date formats.
import { snapshotTimeMs } from '../../../src/tools/rbook/snapshot-content-policy';

const iso = new Date(Date.now() - 3600000).toISOString();
const parse = (createdAt: string) => snapshotTimeMs({ createdAt });

it('accepts explicit ISO offsets and SQLite UTC forms as the same instant', () => {
  const expected = Date.parse(iso);
  expect(parse(iso)).toBe(expected);
  expect(parse(iso.replace('Z', '+00:00'))).toBe(expected);
  expect(parse(iso.replace('Z', '+0000'))).toBe(expected);
  expect(parse(iso.replace('Z', '+01:00'))).toBe(expected - 3600000);
  expect(parse(iso.replace('T', ' ').replace('Z', ''))).toBe(expected);
  expect(parse(iso.slice(0, 19).replace('T', ' '))).toBe(Math.floor(expected / 1000) * 1000);
});

it.each([
  ['date only', iso.slice(0, 10)],
  ['local ISO', iso.slice(0, -1)],
  ['RFC', new Date(iso).toUTCString()],
  ['slash date', iso.slice(0, 10).replace(/-/g, '/')],
  ['empty', ''],
  ['invalid', 'not a date'],
])('treats %s as unknown, never a host-dependent age', (_name, value) => {
  expect(parse(value)).toBe(-Infinity);
});
