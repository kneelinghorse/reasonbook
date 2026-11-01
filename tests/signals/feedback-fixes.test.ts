// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m04 — the feedback fix rules: the closing test's every condition, partly fixed rows that never close, the
// ABOUTME: three groups with the post-4.0 words, and the kinds' regex cost discipline. Synthetic rows only.

import { describe, expect, it } from '@jest/globals';
import { performance } from 'perf_hooks';
import {
  FEEDBACK_FIX_RULES,
  FEEDBACK_FIXES_RULE,
  FEEDBACK_GROUPS_RULE,
  FEEDBACK_SECOND_ITEM,
  feedbackFixByRule,
  feedbackFixOf,
  feedbackGroupOf,
  reopenedMarker,
} from '../../src/signals/feedback-fixes';
import { classifyFeedback, REASONBOOK_NAMED } from '../../src/signals/feedback-kinds';
import { multipleUnboundedAlternatives } from '../helpers/feedback-regex';

const before = (rule: string) =>
  new Date(
    Date.parse(FEEDBACK_FIX_RULES.find((r) => r.id === rule)!.publishedAt) - 86_400_000
  ).toISOString();
const row = (body: string, createdAt: string, status = 'open') => ({ body, status, createdAt });

const DECISIONS = 'completion.decisions-advisory';
const SUPERSESSION = 'decisions.supersession-offers';
const FAN_OUT = 'reads.fan-out-every-project';

describe('the closing test', () => {
  const advisory =
    'Mission completion said "No decisions captured" although I had recorded two with cmos_decisions for the mission.';

  it('fixes an open or triaged row filed before the release that names the defect in its first sentence', () => {
    for (const status of ['open', 'triaged'])
      expect(feedbackFixOf(row(advisory, before(DECISIONS), status))).toEqual({
        rule: DECISIONS,
        revision: 1,
        fixedIn: '3.2.0',
        state: 'fixed',
      });
  });

  it('matches nothing filed at or after the release, resolved, archived, or without a readable time or body', () => {
    const published = FEEDBACK_FIX_RULES.find((r) => r.id === DECISIONS)!.publishedAt;
    expect(feedbackFixOf(row(advisory, published))).toBeNull();
    expect(
      feedbackFixOf(row(advisory, new Date(Date.parse(published) + 1).toISOString()))
    ).toBeNull();
    for (const status of ['resolved', 'archived'])
      expect(feedbackFixOf(row(advisory, before(DECISIONS), status))).toBeNull();
    expect(feedbackFixOf({ body: advisory, status: 'open', createdAt: null })).toBeNull();
    expect(feedbackFixOf({ body: advisory, status: 'open', createdAt: 'last Tuesday' })).toBeNull();
    expect(feedbackFixOf({ body: null, status: 'open', createdAt: before(DECISIONS) })).toBeNull();
  });

  it('only partly fixes a row whose first sentence misses, or which names a second item, and never closes it', () => {
    const late = `A long day of planning work went well. Then ${advisory}`;
    const listed = `${advisory} Also the digest repeats the sprint focus.`;
    const numbered = `Two issues: (1) ${advisory} (2) The digest was slow.`;
    for (const body of [late, listed, numbered]) {
      const verdict = feedbackFixOf(row(body, before(DECISIONS)));
      expect(verdict).toMatchObject({ rule: DECISIONS, state: 'partly' });
      expect(feedbackGroupOf(row(body, before(DECISIONS)))).toBe('reasonbook');
    }
    expect(FEEDBACK_SECOND_ITEM.test(listed)).toBe(true);
  });

  it.each([
    'Separately, the digest repeats the sprint focus.',
    'In addition, the digest was slow.',
    'Additionally the digest was slow.',
    'Another problem: the digest was slow.',
  ])('only partly fixes a row that goes on: %s', (tail) => {
    // The fresh critic's phrasings, which the first second-item test let through as wholly fixed.
    expect(feedbackFixOf(row(`${advisory} ${tail}`, before(DECISIONS)))).toMatchObject({
      state: 'partly',
    });
  });

  it('fixes nothing as of a moment before the release was published', () => {
    const published = Date.parse(FEEDBACK_FIX_RULES.find((r) => r.id === DECISIONS)!.publishedAt);
    expect(feedbackFixOf(row(advisory, before(DECISIONS)), published - 1)).toBeNull();
    expect(feedbackFixOf(row(advisory, before(DECISIONS)), published)).toMatchObject({
      state: 'fixed',
    });
    expect(feedbackGroupOf(row(advisory, before(DECISIONS)), published - 1)).toBe('reasonbook');
  });

  it('lets no rule claim a reopened row but a newer revision of the rule the reopen names', () => {
    const marked = { ...row(advisory, before(DECISIONS)), fixRule: reopenedMarker(DECISIONS, 1) };
    expect(feedbackFixOf(marked)).toBeNull();
    expect(feedbackFixOf({ ...marked, fixRule: reopenedMarker(DECISIONS, 0) })).toMatchObject({
      state: 'fixed',
    });
    // Another rule's reopen blocks this one too, so a row two rules fix cannot cycle between them.
    expect(feedbackFixOf({ ...marked, fixRule: reopenedMarker(SUPERSESSION, 1) })).toBeNull();
    expect(feedbackFixOf({ ...marked, fixRule: 'reopened:garbled' })).toBeNull();
    // A revision that is not a plain number names none, so it bars every rule, its own included:
    // Number('') is 0, which once let a blank one through (round 3).
    // '0.5' and '0 ' read as revision 0, which revision 1 would pass, if digits were matched at
    // the start alone.
    for (const tail of ['', ' ', '1x', '-1', '1.5', 'NaN', '0.5', '0 '])
      expect(feedbackFixOf({ ...marked, fixRule: `reopened:${DECISIONS}@${tail}` })).toBeNull();
  });

  it('reads only the first 4,000 code units for the patterns', () => {
    const far = `${'Planning notes that run on. '.repeat(160)}${advisory}`;
    expect(far.length).toBeGreaterThan(4000);
    expect(feedbackFixOf(row(far, before(DECISIONS)))).toBeNull();
  });

  it('does not take "No learnings captured", which still warns by design, for the decisions fix', () => {
    const learnings =
      'Mission completion warned "No learnings captured" although I recorded decisions with cmos_decisions.';
    expect(
      feedbackFixByRule(
        FEEDBACK_FIX_RULES.find((r) => r.id === DECISIONS)!,
        row(learnings, before(DECISIONS))
      )
    ).toBeNull();
  });

  it.each([
    [
      SUPERSESSION,
      'Supersession candidates on every decision were unrelated: they only shared keywords.',
    ],
    [
      FAN_OUT,
      'cmos_mission show walked the whole registry and returned one entry per registered project.',
    ],
  ])('fixes %s rows', (rule, body) => {
    expect(feedbackFixOf(row(body, before(rule)))).toMatchObject({ rule, state: 'fixed' });
  });

  it('publishes its rule beside the counts', () => {
    expect(FEEDBACK_FIXES_RULE).toMatch(/npm publish time/);
    expect(FEEDBACK_FIXES_RULE).toMatch(/first 4,000/);
    expect(FEEDBACK_GROUPS_RULE).toMatch(/fromDraft/);
    for (const rule of FEEDBACK_FIX_RULES) {
      expect(Number.isFinite(Date.parse(rule.publishedAt))).toBe(true);
      expect(rule.revision).toBeGreaterThanOrEqual(1);
      expect(rule.description.length).toBeGreaterThan(20);
    }
  });
});

describe('the three groups', () => {
  it('sorts a row fixed by a shipped release, one about Reasonbook, and one about the project’s own work', () => {
    expect(
      feedbackGroupOf(
        row('cmos_mission show walked the whole registry for one mission.', before(FAN_OUT))
      )
    ).toBe('fixed');
    expect(feedbackGroupOf(row('rbook_review was slow today.', new Date().toISOString()))).toBe(
      'reasonbook'
    );
    expect(feedbackGroupOf(row('The checkout page renders twice.', new Date().toISOString()))).toBe(
      'own'
    );
  });

  it('counts the words agents use for Reasonbook since 4.0 as naming it, in the kinds’ gate too', () => {
    for (const body of [
      'The drafts list was empty after approval.',
      'fromDraft refused my approved wording.',
      'mission status named the wrong next action.',
    ]) {
      expect(REASONBOOK_NAMED.test(body)).toBe(true);
      expect(feedbackGroupOf(row(body, new Date().toISOString()))).toBe('reasonbook');
    }
    // The gate is shared: a supersession complaint in post-4.0 words now reaches the kinds.
    expect(
      classifyFeedback(
        'The drafts flow proposed superseding an unrelated decision on keyword overlap.'
      ).kind
    ).toBe('surfacing');
  });
});

describe('the regex cost contract', () => {
  const patterns = [
    ...FEEDBACK_FIX_RULES.flatMap((rule) => [...rule.match, ...(rule.unless ?? [])]),
    FEEDBACK_SECOND_ITEM,
  ];

  it('has no alternative with two unbounded quantifiers, and every pattern is neither global nor sticky', () => {
    expect(patterns.flatMap((pattern) => multipleUnboundedAlternatives(pattern))).toEqual([]);
    for (const pattern of patterns) expect(pattern.flags).not.toMatch(/[gy]/);
  });

  it('sends a bounded row through every rule within 50 ms', () => {
    // The rules run at every session start, over every open row of every registered store.
    const text = 'Reasonbook supersession archived every project fan out '
      .repeat(400)
      .slice(0, 4000);
    let elapsed = Infinity;
    for (let sample = 0; sample < 5; sample += 1) {
      const started = performance.now();
      feedbackFixOf(row(text, '2026-01-01T00:00:00.000Z'));
      elapsed = Math.min(elapsed, performance.now() - started);
    }
    expect(elapsed).toBeLessThan(50);
  });
});

describe('feedback_open’s groups', () => {
  it('splits the open rows as of the report’s now, in an additive field', () => {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const { computeSignals } = require('../../src/signals') as typeof import('../../src/signals');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-feedback-groups-'));
    try {
      const file = path.join(dir, 'rbook.sqlite');
      const db = new Database(file);
      db.exec(`CREATE TABLE agent_feedback (id INTEGER PRIMARY KEY, tool_name TEXT, body TEXT,
        status TEXT, created_at TEXT, resolved_at TEXT, resolution_note TEXT, fix_rule TEXT);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);`);
      // A row a reopen marked: never fixed, whatever rule matches it.
      db.prepare(
        "INSERT INTO agent_feedback (tool_name, body, status, created_at, fix_rule) VALUES ('t', ?, 'open', ?, ?)"
      ).run(
        'cmos_mission status walked the whole registry and returned one entry per registered project.',
        '2026-06-01T00:00:00.000Z',
        'reopened:reads.fan-out-every-project@1'
      );
      const insert = db.prepare(
        "INSERT INTO agent_feedback (tool_name, body, status, created_at) VALUES ('t', ?, 'open', ?)"
      );
      insert.run(
        'cmos_mission show walked the whole registry and returned one entry per registered project.',
        '2026-06-01T00:00:00.000Z'
      );
      insert.run('rbook_review was slow today.', '2026-06-01T00:00:00.000Z');
      insert.run('The checkout page renders twice.', '2026-06-01T00:00:00.000Z');
      db.close();
      const read = new Database(file, { readonly: true });
      try {
        const at = (now: number) =>
          computeSignals(read, { now, storePath: file, only: ['feedback_open'] }).signals[0];
        expect(at(Date.now()).groups).toEqual({ fixed: 1, reasonbook: 2, own: 1 });
        // A moment before 2.1.0 was published, nothing it fixed counts as fixed.
        const published = Date.parse(FEEDBACK_FIX_RULES.find((r) => r.id === FAN_OUT)!.publishedAt);
        expect(at(published - 1).groups).toEqual({ fixed: 0, reasonbook: 3, own: 1 });
      } finally {
        read.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('splits a store 4.10.0 has not written, which has no fix_rule column', () => {
    const fs = require('fs') as typeof import('fs');
    const os = require('os') as typeof import('os');
    const path = require('path') as typeof import('path');
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const { computeSignals } = require('../../src/signals') as typeof import('../../src/signals');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-feedback-groups-older-'));
    try {
      const file = path.join(dir, 'rbook.sqlite');
      const db = new Database(file);
      db.exec(`CREATE TABLE agent_feedback (id INTEGER PRIMARY KEY, tool_name TEXT, body TEXT,
        status TEXT, created_at TEXT, resolved_at TEXT, resolution_note TEXT);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);`);
      const insert = db.prepare(
        "INSERT INTO agent_feedback (tool_name, body, status, created_at) VALUES ('t', ?, 'open', ?)"
      );
      insert.run(
        'cmos_mission show walked the whole registry and returned one entry per registered project.',
        '2026-06-01T00:00:00.000Z'
      );
      insert.run('rbook_review was slow today.', '2026-06-01T00:00:00.000Z');
      insert.run('The checkout page renders twice.', '2026-06-01T00:00:00.000Z');
      db.close();
      const read = new Database(file, { readonly: true });
      try {
        const signal = computeSignals(read, {
          now: Date.now(),
          storePath: file,
          only: ['feedback_open'],
        }).signals[0];
        expect(signal.groups).toEqual({ fixed: 1, reasonbook: 1, own: 1 });
      } finally {
        read.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
