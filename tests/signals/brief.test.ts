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
import { renderBriefText } from '../../src/signals/brief-text';

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
  it.each(['three-reports', 'stale-reports'])(
    'renders %s to the golden bytes, as the dashboard will',
    (name) => {
      const input = JSON.parse(
        fs.readFileSync(path.join(FIXTURE, `${name}.json`), 'utf8')
      ) as typeof three;
      const golden = fs.readFileSync(path.join(FIXTURE, `${name}.expected.txt`), 'utf8');
      expect(renderBrief(input.reports, { now: input.now, windowDays: input.windowDays })).toBe(
        golden
      );
      expect(lines(golden).length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
    }
  );

  it.each(['three-reports', 'stale-reports'])(
    'gives %s the same bytes in another time zone and locale',
    (name) => {
      // A second process stands in for another machine: far time zone, a locale whose case
      // rules and number formats differ. The renderer reads neither.
      const script = `
      require(${JSON.stringify(path.join(REPO, 'tests', 'helpers', 'ts-register.js'))});
      const { renderBrief } = require(${JSON.stringify(path.join(REPO, 'src', 'signals', 'index.ts'))});
      const fixture = require(${JSON.stringify(path.join(FIXTURE, `${name}.json`))});
      process.stdout.write(renderBrief(fixture.reports, { now: fixture.now, windowDays: fixture.windowDays }));
    `;
      const elsewhere = spawnSync(process.execPath, ['-e', script], {
        cwd: REPO,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, TZ: 'Pacific/Chatham', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' },
      });
      expect(elsewhere.status).toBe(0);
      expect(elsewhere.stdout).toBe(
        fs.readFileSync(path.join(FIXTURE, `${name}.expected.txt`), 'utf8')
      );
    }
  );

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
    expect(text).toContain(
      '\\[click\\]\\(https:\u200b//example.test\\) \\*\\*now\\*\\* \\#… (evil)'
    );
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

  it('names an old report and its differing window instead of presenting it as current', () => {
    const now = Date.now();
    const stale = {
      ...report('stale', { drafts_pending: { count: 1, ids: ['P1'] } }),
      computedAt: new Date(now - 14 * 86_400_000).toISOString(),
      window: { ...report('stale', {}).window, days: 30 },
    };
    const text = renderBrief([stale], { now, windowDays: 7 });
    expect(text).toMatch(/stale.*report.*14 days old/);
    expect(text).toMatch(/30-day window.*brief.*7/);
    expect(text).not.toContain('1 draft (P1)');
    expect(text).toContain('1 draft dropped');
    // Raw report provenance remains available to the dashboard and JSON consumers.
    expect(buildBrief([stale], { now, windowDays: 7 })).toMatchObject({
      reportCaveats: [{ projectId: 'stale', computedAt: stale.computedAt, windowDays: 30 }],
    });
  });

  it('caveat time ordering: sorts same-project SQLite and ISO spellings by their instants', () => {
    const now = Date.now();
    const day = 86_400_000;
    const yesterday = Math.floor(now / day) * day - day;
    const earlier = new Date(yesterday + 2 * 3_600_000).toISOString();
    const later = new Date(yesterday + 3 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
    const reports = [later, earlier].map((computedAt) => ({
      ...report('same-project', {}),
      computedAt,
    }));
    const brief = buildBrief(reports, { now });
    expect(brief.reportCaveats.map((item) => item.computedAt)).toEqual([earlier, later]);
    expect(brief.reportCaveats).toEqual(buildBrief([...reports].reverse(), { now }).reportCaveats);
    expect(renderBrief(reports, { now })).toBe(renderBrief([...reports].reverse(), { now }));
  });

  it('caveat time ordering: equivalent offsets use deterministic window, label and spelling ties', () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const instant = now - 86_400_000;
    const iso = new Date(instant).toISOString();
    const sqlite = iso.slice(0, 19).replace('T', ' ');
    const offset = new Date(instant + 2 * 3_600_000).toISOString().replace('Z', '+02:00');
    const base = report('same-project', {});
    const reports = [
      { ...base, computedAt: offset, project: { id: base.project.id, name: 'Alpha' } },
      { ...base, computedAt: sqlite, project: { id: base.project.id, name: 'Zulu' } },
      {
        ...base,
        computedAt: iso,
        project: { id: base.project.id, name: 'Alpha' },
        window: { ...base.window, days: 30 },
      },
      { ...base, computedAt: iso, project: { id: base.project.id, name: 'Alpha' } },
    ];
    const caveats = buildBrief(reports, { now }).reportCaveats;
    expect(caveats.map((item) => item.ageMs)).toEqual([
      86_400_000, 86_400_000, 86_400_000, 86_400_000,
    ]);
    expect(caveats.map((item) => [item.windowDays, item.projectName, item.computedAt])).toEqual([
      [7, 'Alpha', iso],
      [7, 'Alpha', offset],
      [7, 'Zulu', sqlite],
      [30, 'Alpha', iso],
    ]);
    expect(caveats).toEqual(buildBrief([...reports].reverse(), { now }).reportCaveats);
    expect(renderBrief(reports, { now })).toBe(renderBrief([...reports].reverse(), { now }));
  });

  it('caveat time ordering: unreadable times and null or empty names are deterministic', () => {
    const now = Date.now();
    const base = report('same-project', {});
    const valid = new Date(now - 86_400_000).toISOString();
    const reports = [
      { ...base, computedAt: 'unreadable-b', project: { id: base.project.id, name: null } },
      { ...base, computedAt: 'unreadable-b', project: { id: base.project.id, name: '' } },
      { ...base, computedAt: 'unreadable-b', project: { id: base.project.id, name: 'Alpha' } },
      { ...base, computedAt: 'unreadable-a', project: { id: base.project.id, name: 'Alpha' } },
      { ...base, computedAt: valid },
    ];
    const caveats = buildBrief(reports, { now }).reportCaveats;
    expect(caveats.map((item) => item.ageMs)).toEqual([null, null, null, null, 86_400_000]);
    expect(caveats).toEqual(buildBrief([...reports].reverse(), { now }).reportCaveats);
    expect(renderBrief(reports, { now })).toBe(renderBrief([...reports].reverse(), { now }));
  });

  it('counts unclassified friction with classified rows instead of silently dropping it', () => {
    const item = {
      ...report('friction', {}),
      feedbackKinds: { ...three.reports[0].feedbackKinds, unclassified: 8 },
    };
    expect(renderBrief([item], options)).toContain('unclassified: 8 new rows (friction 8)');
  });

  it('does not silently treat a future or unreadable report time as current', () => {
    const now = Date.now();
    const future = {
      ...report('future', {}),
      computedAt: new Date(now + 3_600_000).toISOString(),
    };
    const unreadable = { ...report('unreadable-time', {}), computedAt: 'not a time' };
    const text = renderBrief([future, unreadable], { now });
    expect(text).toContain('future: report time 1 hour ahead of this brief');
    expect(text).toContain('unreadable-time: report time unreadable');
  });

  it('enforces the rendering limit even if a later section grows past its current item cap', () => {
    const brief = buildBrief([], { now: Date.now() });
    const section = brief.sections[0];
    const text = renderBriefText({
      ...brief,
      sections: [
        {
          ...section,
          items: Array.from({ length: BRIEF_MAX_LINES + 1 }, (_, i) => ({
            projectId: `p-${i}`,
            text: `p-${i}: 1 draft`,
            ids: [`P${i}`],
          })),
        },
      ],
    });
    expect(lines(text)).toHaveLength(BRIEF_MAX_LINES);
    expect(lines(text)[BRIEF_MAX_LINES - 1]).toBe(
      '- Brief cut at the line limit; see the structured brief.'
    );
  });

  it('makes controls, automatic links and oversized ids inert while retaining raw structured ids', () => {
    const id = `m\u001bc\u0007\u0085\n${'x'.repeat(10_000)}`;
    const item = {
      ...report('ctl', { missions_blocked: { count: 1, ids: [id] } }),
      project: { id: 'ctl', name: '\b\u001bM\u009bhttps://a.test www.b.test a@b.test' },
    };
    const text = renderBrief([item], options);
    // eslint-disable-next-line no-control-regex -- C0/C1 witness permits only generated LF.
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(text).not.toMatch(/https?:\/\/|www\.[a-z]|a@b\.test/);
    expect(Math.max(...lines(text).map((line) => line.length))).toBeLessThan(500);
    expect(text).toContain('…');
    expect(buildBrief([item], options).sections[1].items[0].ids).toEqual([id]);
  });

  it('bounds report caveats and all six populated sections without hiding the omitted count', () => {
    const now = Date.now();
    const many = Array.from({ length: 100 }, (_, i) => ({
      ...three.reports[0],
      project: { id: `old-${i}`, name: null },
      computedAt: new Date(now - (i + 1) * 86_400_000).toISOString(),
      window: { ...three.reports[0].window, days: 30 },
    }));
    const text = renderBrief(many, { now });
    expect(text).toContain('Report ages and windows');
    expect(text).toContain('95 more report caveats');
    expect(lines(text).length).toBeLessThanOrEqual(BRIEF_MAX_LINES);
    expect(renderBrief([...many].reverse(), { now })).toBe(text);
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
