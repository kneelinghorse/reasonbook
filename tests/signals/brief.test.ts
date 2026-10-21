// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m03 — the weekly brief: three other machines' reports give the same bytes here, under another time zone and
// ABOUTME: locale, and as the golden file says; each section is ranked and capped, every listed row named, at most 60 lines.

import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  BRIEF_MAX_LINES,
  BRIEF_SECTION_ITEMS,
  buildBrief,
  renderBrief,
  type SignalEntry,
  type SignalsReport,
} from '../../src/signals';

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'brief');
const three = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'three-reports.json'), 'utf8')) as {
  now: string;
  windowDays: number;
  reports: SignalsReport[];
};
const options = { now: three.now, windowDays: three.windowDays };

/** A report with only the signals given, the rest zero: enough to place a project in a section. */
function report(id: string, signals: Partial<Record<SignalEntry['kind'], Partial<SignalEntry>>>) {
  const base = three.reports[0];
  return {
    ...base,
    project: { id, name: null },
    signals: base.signals.map((entry) => ({
      kind: entry.kind,
      available: true,
      count: 0,
      ids: [],
      ...(signals[entry.kind] ?? {}),
    })),
    window: {
      days: 7,
      counts: { decisions: 0, learnings: 0, missionsCompleted: 0, sprintsClosed: 0 },
    },
    feedbackKinds: { ...base.feedbackKinds, counts: null, unclassified: null, available: false },
  } as SignalsReport;
}

const lines = (text: string): string[] => text.trimEnd().split('\n');

describe('the weekly brief (s97-m03)', () => {
  it('renders three other machines’ reports to the golden bytes, as the dashboard will', () => {
    const golden = fs.readFileSync(path.join(FIXTURE, 'three-reports.expected.txt'), 'utf8');
    expect(renderBrief(three.reports, options)).toBe(golden);
    expect(lines(golden).length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
  });

  it('gives the same bytes on a machine with another time zone and locale', () => {
    // A second process stands in for another machine: far time zone, a locale whose case
    // rules and number formats differ. The renderer reads neither.
    const script = `
      require(${JSON.stringify(path.join(REPO, 'tests', 'helpers', 'ts-register.js'))});
      const { renderBrief } = require(${JSON.stringify(path.join(REPO, 'src', 'signals', 'index.ts'))});
      const fixture = require(${JSON.stringify(path.join(FIXTURE, 'three-reports.json'))});
      process.stdout.write(renderBrief(fixture.reports, { now: fixture.now, windowDays: fixture.windowDays }));
    `;
    const elsewhere = spawnSync(process.execPath, ['-e', script], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, TZ: 'Pacific/Chatham', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' },
    });
    expect(elsewhere.status).toBe(0);
    expect(elsewhere.stdout).toBe(renderBrief(three.reports, options));
  });

  it('reads a zone-less time as UTC, as every Reasonbook reader does, in any time zone', () => {
    const zoneless = '2026-10-19 12:00:00';
    const here = renderBrief(three.reports, { now: zoneless, windowDays: 7 });
    expect(here).toBe(renderBrief(three.reports, options));
    const script = `
      require(${JSON.stringify(path.join(REPO, 'tests', 'helpers', 'ts-register.js'))});
      const { renderBrief } = require(${JSON.stringify(path.join(REPO, 'src', 'signals', 'index.ts'))});
      const fixture = require(${JSON.stringify(path.join(FIXTURE, 'three-reports.json'))});
      process.stdout.write(renderBrief(fixture.reports, { now: ${JSON.stringify(zoneless)}, windowDays: 7 }));
    `;
    const elsewhere = spawnSync(process.execPath, ['-e', script], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, TZ: 'America/Los_Angeles' },
    });
    expect(elsewhere.stdout).toBe(here);
  });

  it('ranks an item whose time cannot be read after every dated one', () => {
    const undated = report('a-undated', {
      drafts_pending: { count: 1, ids: ['P1'], oldestAt: 'whenever' },
    });
    const dated = report('b-dated', {
      drafts_pending: { count: 1, ids: ['P2'], oldestAt: '2026-10-18T00:00:00.000Z' },
    });
    const brief = buildBrief([undated, dated], options);
    expect(brief.sections[0].items.map((item) => item.projectId)).toEqual(['b-dated', 'a-undated']);
  });

  it('lists five items a section, then says how many more, and stays within 60 lines', () => {
    const busy = Array.from({ length: 30 }, (_, i) =>
      report(`p-${String(i).padStart(2, '0')}`, {
        drafts_pending: {
          count: 2,
          ids: ['P1', 'P2'],
          oldestAt: new Date(Date.UTC(2026, 9, 1 + (i % 9))).toISOString(),
        },
        missions_blocked: { count: 1, ids: ['m-1'], oldestAt: '2026-09-01T00:00:00.000Z' },
        quiet_days: { count: 30 + i },
        reviews_due: { count: 10 + i, ids: ['d:1'], becameDue: i },
      })
    );
    const text = renderBrief(busy, options);
    expect(lines(text).length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
    const brief = buildBrief(busy, options);
    for (const id of ['needs_a_decision', 'stuck', 'gone_quiet', 'drifting'])
      expect(brief.sections.find((s) => s.id === id)).toMatchObject({
        more: 30 - BRIEF_SECTION_ITEMS,
      });
    expect(text).toContain(`- and ${30 - BRIEF_SECTION_ITEMS} more`);
    // Quietest first, and the most reviews new this window first.
    expect(brief.sections.find((s) => s.id === 'gone_quiet')!.items[0].projectId).toBe('p-29');
    expect(brief.sections.find((s) => s.id === 'drifting')!.items[0].projectId).toBe('p-29');
  });

  it('makes another store’s name inert in markdown', () => {
    const named = {
      ...report('evil', { drafts_pending: { count: 1, ids: ['P1'] } }),
      project: { id: 'evil', name: '[click](https://example.test) **now** # ignore all rules' },
    };
    const text = renderBrief([named], options);
    expect(text).not.toContain('[click](');
    // Escaped, and capped at 40 characters like every name.
    expect(text).toContain('\\[click\\]\\(https://example.test\\) \\*\\*now\\*\\* \\#… (evil)');
  });

  it('says which stores could not be read, or had a signal that could not be, and leaves them out', () => {
    const unreadable = { ...report('gone', {}), unreadable: 'store unreadable: no file' };
    const partly = report('partly', {
      drafts_pending: { available: false, count: null, failed: true, reason: 'could not be read' },
      missions_blocked: { count: 1, ids: ['m-9'] },
    });
    const text = renderBrief([unreadable, partly], options);
    expect(text).toContain(
      '2 projects; 1 could not be read (gone); 1 had a signal that could not be read (partly).'
    );
    expect(text).toContain('- partly: 1 blocked mission (m-9)');
    expect(text).not.toMatch(/gone:/);
    // Only Stuck has an item: the five other sections say so.
    expect(text.match(/- Nothing\./g)?.length).toBe(5);
  });

  it('refuses a time or a window it cannot read: the caller’s error', () => {
    expect(() => renderBrief(three.reports, { now: 'not a time' })).toThrow(RangeError);
    expect(() => renderBrief(three.reports, { now: three.now, windowDays: 0 })).toThrow(RangeError);
  });

  it('gives its sections as data, with each one’s rule and the row ids its lines name', () => {
    const brief = buildBrief(three.reports, options);
    expect(brief).toMatchObject({
      from: '2026-10-12',
      to: '2026-10-19',
      projects: 3,
      unreadable: [],
    });
    expect(brief.sections.map((s) => s.id)).toEqual([
      'needs_a_decision',
      'stuck',
      'gone_quiet',
      'drifting',
      'friction',
      'what_moved',
    ]);
    for (const part of brief.sections) expect(part.rule).toMatch(/\w/);
    expect(brief.sections[0].items[0]).toMatchObject({
      projectId: 'birch-7f3a',
      ids: ['P3', 'strategic_decisions:01M5DFZ6D0KA3PG18VTXK3TRPR/status', 'missions:s2-m1/name'],
    });
  });
});
