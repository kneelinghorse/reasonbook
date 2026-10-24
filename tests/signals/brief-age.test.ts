// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A hosted report must keep aging when uploads stop, without inventing observed activity.
// ABOUTME: The brief retains its 21-day threshold and unreadable reports retain a caller's known identity.

import { buildBrief, renderBrief, unreadableReport, type SignalsReport } from '../../src/signals';
import fixture from '../fixtures/brief/three-reports.json';

const DAY = 86_400_000;
const NOW = Date.now() - 30 * DAY;
const iso = (time: number) => new Date(time).toISOString();

function report(id: string, quiet: number | null, ageDays: number): SignalsReport {
  const base = fixture.reports[0] as SignalsReport;
  return {
    ...base,
    project: { id, name: null },
    computedAt: iso(NOW - ageDays * DAY),
    signals: [{ kind: 'quiet_days', available: quiet !== null, count: quiet, ids: [] }],
  };
}

const quietItems = (reports: SignalsReport[]) =>
  buildBrief(reports, { now: NOW }).sections.find((section) => section.id === 'gone_quiet')!.items;

describe('reports age to the brief time (s101-m09)', () => {
  it('crosses the existing 21-day threshold after uploads stop and discloses the inferred days', () => {
    const old = report('stopped-uploading', 12, 9);
    const before = JSON.stringify(old);
    expect(quietItems([old])).toEqual([
      {
        projectId: 'stopped-uploading',
        text: 'stopped-uploading: 21 days without a new row, 9 of them since its last upload',
        ids: [],
      },
    ]);
    expect(renderBrief([old], { now: NOW })).toContain('21 days without a new row');
    expect(JSON.stringify(old)).toBe(before);
    // The planning example's 3 + 9 = 12 must not silently lower the published threshold.
    expect(quietItems([report('only-twelve', 3, 9)])).toEqual([]);
  });

  it('ages an observed zero, but never turns an unavailable signal into a known quiet period', () => {
    expect(quietItems([report('zero-at-upload', 0, 21), report('unknown', null, 90)])).toEqual([
      {
        projectId: 'zero-at-upload',
        text: 'zero-at-upload: 21 days without a new row, 21 of them since its last upload',
        ids: [],
      },
    ]);
  });

  it('ranks by the aged whole-day count, not the old count, without inventing a partial day', () => {
    const reports = [report('current', 30, 0), report('old', 20, 12.75)];
    const items = quietItems(reports);
    expect(items.map((item) => item.projectId)).toEqual(['old', 'current']);
    expect(items[0].text).toBe('old: 32 days without a new row, 12 of them since its last upload');
    expect(items[1].text).toBe('current: 30 days without a new row');
    expect(quietItems([...reports].reverse())).toEqual(items);
  });

  it.each(['not a time', iso(NOW + DAY)])(
    'keeps report-time caveats and adds no invented elapsed days for %s',
    (computedAt) => {
      const held = { ...report('untrusted-time', 25, 0), computedAt };
      expect(quietItems([held])[0].text).toBe('untrusted-time: 25 days without a new row');
      expect(buildBrief([held], { now: NOW }).reportCaveats).toHaveLength(1);
    }
  );

  it('reads an old zone-less SQLite stamp as UTC when counting elapsed whole days', () => {
    const old = report('sqlite-time', 20, 2);
    // Strip milliseconds consistently so both spellings denote the same instant.
    const utc = old.computedAt.slice(0, 19) + 'Z';
    expect(quietItems([{ ...old, computedAt: utc.replace('T', ' ').replace('Z', '') }])).toEqual(
      quietItems([{ ...old, computedAt: utc }])
    );
    expect(quietItems([old])[0].text).toContain('22 days without a new row, 2 of them');
  });
});

describe('known identities on unreadable reports (s101-m09)', () => {
  it.each([
    { projectId: 'known-id', projectName: 'Known project' },
    { projectId: 'known-id' },
    { projectName: 'Known project' },
    {},
  ])('preserves supplied identity %j while every failed count stays unknown', (identity) => {
    const options = { storePath: '/unused/rbook/db/rbook.sqlite', now: NOW, ...identity };
    const result = unreadableReport(options, 'store unreadable: no file');
    expect(result.project).toEqual({
      id: 'projectId' in identity ? identity.projectId : 'unknown-project',
      name: 'projectName' in identity ? identity.projectName : null,
    });
    expect(result.unreadable).toBe('store unreadable: no file');
    expect(result.signals.every((signal) => signal.failed && signal.count === null)).toBe(true);
    expect(Object.values(result.window.counts).every((count) => count === null)).toBe(true);
    expect(result.feedbackKinds.counts).toBeNull();
  });
});
