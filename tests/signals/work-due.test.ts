// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m03 — work_due counts open next steps and Deferred missions whose date has come, never a stale
// ABOUTME: or malformed date, names the soonest date ahead, and reads old and foreign stores without an error.

import { afterAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computeSignals, renderBrief, type SignalEntry } from '../../src/signals';
import { missionDueDay } from '../../src/signals/rules-due';
import { personSignalsOf } from '../../src/tools/rbook/portfolio-signals';
import { portfolioWithSignals } from '../../src/tools/rbook/rbook-review';
import { utcDay } from '../../src/tools/rbook/next-step-dates';

const DAY = 86_400_000;
const NOW = Date.now();
const day = (offset: number) => utcDay(NOW + offset * DAY);

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** The two tables work_due reads, in their oldest shapes: no genesis columns are needed. */
function store(file = path.join(tmp('rbook-work-due-'), 'rbook.sqlite')): string {
  const db = new Database(file);
  db.exec(`CREATE TABLE next_steps (id INTEGER PRIMARY KEY, content TEXT, status TEXT, created_at TEXT,
      resolved_at TEXT, carried_to_sprint TEXT);
    CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT, status TEXT, domain_fields TEXT);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);`);
  db.close();
  return file;
}
function workDue(file: string, now = NOW): SignalEntry {
  const db = new Database(file, { readonly: true });
  try {
    return computeSignals(db, { now, storePath: file, only: ['work_due'] }).signals[0];
  } finally {
    db.close();
  }
}
const deferral = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe('work_due', () => {
  it('counts a due next step and a Deferred mission whose current date has come, and names the next', () => {
    const file = store();
    const db = new Database(file);
    const at = new Date(NOW - 30 * DAY).toISOString();
    db.prepare('INSERT INTO next_steps VALUES (?, ?, ?, ?, ?, NULL)').run(
      1,
      'Due step',
      'carried',
      at,
      day(-3)
    );
    db.prepare('INSERT INTO next_steps VALUES (?, ?, ?, ?, ?, NULL)').run(
      2,
      'Waiting step',
      'carried',
      at,
      day(9)
    );
    db.prepare('INSERT INTO next_steps VALUES (?, ?, ?, ?, ?, NULL)').run(
      3,
      'Undated',
      'pending',
      at,
      null
    );
    db.prepare('INSERT INTO next_steps VALUES (?, ?, ?, ?, ?, NULL)').run(
      4,
      'Carried at an instant',
      'carried',
      at,
      at
    );
    db.prepare('INSERT INTO next_steps VALUES (?, ?, ?, ?, ?, NULL)').run(
      5,
      'Done, bare',
      'completed',
      at,
      day(-1)
    );
    db.prepare('INSERT INTO missions VALUES (?, ?, ?, ?)').run(
      'm-due',
      'Due mission',
      'Deferred',
      deferral({ deferredAt: at, checkAfter: day(-5), checkAfterDeferredAt: at })
    );
    db.prepare('INSERT INTO missions VALUES (?, ?, ?, ?)').run(
      'm-later',
      'Later mission',
      'Deferred',
      deferral({ deferredAt: at, checkAfter: day(4), checkAfterDeferredAt: at })
    );
    db.close();
    const entry = workDue(file);
    expect(entry).toMatchObject({ available: true, count: 2, ids: ['m-due', 'n:1'] });
    expect(entry.oldestAt).toBe(`${day(-5)}T00:00:00.000Z`);
    expect(entry.nextDueAt).toBe(`${day(4)}T00:00:00.000Z`);
    // Before either day, nothing is due and nextDueAt names the first.
    const before = workDue(file, NOW - 10 * DAY);
    expect(before).toMatchObject({ count: 0, ids: [] });
    expect(before.nextDueAt).toBe(`${day(-5)}T00:00:00.000Z`);
  });

  it('never counts a stale, malformed or completed mission date', () => {
    const cases: Array<[string, string, unknown]> = [
      [
        'stale',
        'Deferred',
        deferral({ deferredAt: 'later', checkAfter: day(-2), checkAfterDeferredAt: 'earlier' }),
      ],
      ['unpaired', 'Deferred', deferral({ deferredAt: 'x', checkAfter: day(-2) })],
      [
        'free text',
        'Deferred',
        deferral({ deferredAt: 'x', checkAfter: 'after sprint 48', checkAfterDeferredAt: 'x' }),
      ],
      [
        'empty',
        'Deferred',
        deferral({ deferredAt: 'x', checkAfter: '', checkAfterDeferredAt: 'x' }),
      ],
      ['not json', 'Deferred', '{not json'],
      ['null', 'Deferred', null],
      ['array', 'Deferred', '[1]'],
      [
        'requeued',
        'Queued',
        deferral({ deferredAt: 'x', checkAfter: day(-2), checkAfterDeferredAt: 'x' }),
      ],
    ];
    const file = store();
    const db = new Database(file);
    for (const [id, status, fields] of cases)
      db.prepare('INSERT INTO missions VALUES (?, ?, ?, ?)').run(id, id, status, fields);
    db.close();
    expect(workDue(file)).toMatchObject({ available: true, count: 0, ids: [] });
    for (const [, , fields] of cases.slice(0, 7)) expect(missionDueDay(fields)).toBeNull();
  });

  it('reads a 4.9.0-shaped store with no dates, and a store with neither table, without an error', () => {
    const plain = store();
    const db = new Database(plain);
    db.prepare("INSERT INTO next_steps VALUES (1, 'x', 'pending', ?, NULL, NULL)").run(
      new Date(NOW).toISOString()
    );
    db.prepare("INSERT INTO missions VALUES ('m', 'm', 'Deferred', ?)").run(
      deferral({ deferredAt: 'x', deferUntil: 'later' })
    );
    db.close();
    expect(workDue(plain)).toMatchObject({ available: true, count: 0 });
    const empty = path.join(tmp('rbook-work-due-empty-'), 'rbook.sqlite');
    new Database(empty).close();
    expect(workDue(empty)).toMatchObject({ available: false, count: null });
  });

  it('lets a stored report show work that came due after it was computed', () => {
    const file = store();
    const db = new Database(file);
    db.prepare('INSERT INTO next_steps VALUES (?, ?, ?, ?, ?, NULL)').run(
      1,
      'Waits three days',
      'carried',
      new Date(NOW).toISOString(),
      day(3)
    );
    db.close();
    const read = new Database(file, { readonly: true });
    const report = (() => {
      try {
        return computeSignals(read, { now: NOW, storePath: file });
      } finally {
        read.close();
      }
    })();
    expect(report.signals.find((signal) => signal.kind === 'work_due')).toMatchObject({
      count: 0,
      nextDueAt: `${day(3)}T00:00:00.000Z`,
    });
    expect(renderBrief([report], { now: NOW })).toMatch(/## Due\n- Nothing\./);
    // The same report read four days later, as the dashboard reads a stored upload: the day has come.
    expect(renderBrief([report], { now: NOW + 4 * DAY })).toContain(
      `work due since ${day(3)}, after its report`
    );
  });

  it('ranks a project whose only work for a person is due among the review’s other projects', () => {
    // The fresh critic's case: eight projects with one draft each, and one with six items due.
    const people = [
      ...Array.from({ length: 8 }, (_, index) => ({
        projectId: `drafts-${index}`,
        name: `Drafts ${index}`,
        storePath: '',
        drafts: 1,
      })),
      { projectId: 'due-work', name: 'Due work', storePath: '', due: 6 },
    ];
    const read = { section: {}, people, unread: [] } as unknown as Parameters<
      typeof portfolioWithSignals
    >[0];
    const section = portfolioWithSignals(read, 'this-project');
    expect(section?.signals?.projects).toBe(9);
    expect(section?.signals?.top[0]).toMatchObject({ projectId: 'due-work', due: 6 });
  });

  it('reaches the review through PERSON_SIGNALS from a store on the cmos/ layout', () => {
    const root = tmp('rbook-work-due-legacy-');
    fs.mkdirSync(path.join(root, 'cmos', 'db'), { recursive: true });
    const file = store(path.join(root, 'cmos', 'db', 'cmos.sqlite'));
    const db = new Database(file);
    db.prepare("INSERT INTO next_steps VALUES (1, 'Due', 'carried', ?, ?, NULL)").run(
      new Date(NOW).toISOString(),
      day(-1)
    );
    db.close();
    const read = new Database(file, { readonly: true });
    try {
      const { counts, failed } = personSignalsOf(
        read,
        { store_path: root } as unknown as Parameters<typeof personSignalsOf>[1],
        NOW,
        {}
      );
      expect(failed).toBe(false);
      expect(counts.due).toBe(1);
    } finally {
      read.close();
    }
  });
});
