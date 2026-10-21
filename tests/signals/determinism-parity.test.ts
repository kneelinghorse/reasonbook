// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m01 — a report is a function of the file, now and the runtime: the same bytes twice, another report 30 days
// ABOUTME: off or after a write; and at the wall clock each re-applied rule counts what the server's own function counts.

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readSignals, type SignalEntry, type SignalsReport } from '../../src/signals';
import { withClient } from '../../src/tools/rbook/client';
import { leaseState, LEASE_WARN_AT, readLeaseAges } from '../../src/tools/rbook/next-step-lease';
import { rbookProjectInit } from '../../src/tools/rbook/rbook-project-init';
import {
  ensureLearningsTable,
  ensureReviewTimestamps,
} from '../../src/tools/rbook/schema-migrations';
import {
  DEFAULT_STALENESS_THRESHOLD,
  readStaleness,
} from '../../src/tools/rbook/staleness-detection';
import { QUIET_SILENT_DAYS, SIGNALS_REVIEW_THRESHOLD } from '../../src/signals';
import { STALE_THRESHOLD_DAYS } from '../../src/tools/rbook/rbook-review';

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}
const savedEnv = { config: process.env.RBOOK_CONFIG_DIR, sync: process.env.RBOOK_CHECKPOINT_SYNC };
beforeAll(() => {
  process.env.RBOOK_CONFIG_DIR = tmp('rbook-signals-det-home-');
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
});
afterAll(() => {
  if (savedEnv.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedEnv.config;
  if (savedEnv.sync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = savedEnv.sync;
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function signal(report: SignalsReport, kind: SignalEntry['kind']): SignalEntry {
  return report.signals.find((entry) => entry.kind === kind)!;
}

async function initStore(): Promise<{ dbPath: string; db: Database.Database }> {
  const root = tmp('rbook-signals-det-');
  expect((await rbookProjectInit({ projectRoot: root, projectName: 'Det' } as never)).success).toBe(
    true
  );
  const dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  await withClient(
    (client) => {
      ensureLearningsTable(client);
      ensureReviewTimestamps(client);
      return { success: true, data: null };
    },
    { dbPath }
  );
  return { dbPath, db: new Database(dbPath) };
}

/** Twenty-four closes, the oldest 120 days ago, so a lease and a review age both read real numbers. */
function closes(db: Database.Database, wall: number): void {
  const insert = db.prepare(
    "INSERT INTO sprints (id, title, status, end_date) VALUES (?, 'Closed', 'Completed', ?)"
  );
  for (let i = 0; i < 24; i++) insert.run(`det-c${i}`, iso(wall - (120 - i * 5) * DAY));
}

describe('a signals report is a function of the file and now (s97-m01)', () => {
  it('gives the same bytes for the same now, another report 30 days off, and another after a write', async () => {
    const wall = Date.now();
    const { dbPath, db } = await initStore();
    closes(db, wall);
    // Rows the two instants disagree about: written between them.
    db.prepare(
      "INSERT INTO strategic_decisions (decision_text, created_at, occurred_at) VALUES ('Recent.', ?, ?)"
    ).run(iso(wall - 5 * DAY), wall - 5 * DAY);
    db.prepare(
      "INSERT INTO next_steps (content, status, created_at) VALUES ('An old step.', 'pending', ?)"
    ).run(iso(wall - 100 * DAY));
    const past = wall - 35 * DAY;
    const first = JSON.stringify(readSignals(dbPath, { now: past }));
    expect(JSON.stringify(readSignals(dbPath, { now: past }))).toBe(first);
    const atWall = readSignals(dbPath, { now: wall });
    expect(JSON.stringify(atWall)).not.toBe(first);
    expect(signal(atWall, 'next_steps_lapsing').count).toBe(1);
    expect(signal(JSON.parse(first), 'next_steps_lapsing').count).toBe(1);
    expect(atWall.window.counts.decisions).toBe(1);
    expect((JSON.parse(first) as SignalsReport).window.counts.decisions).toBe(0);
    // Changed state at the same now is a changed report: nothing is cached.
    db.prepare(
      "INSERT INTO strategic_decisions (decision_text, created_at, occurred_at) VALUES ('Older.', ?, ?)"
    ).run(iso(past - DAY), past - DAY);
    expect(JSON.stringify(readSignals(dbPath, { now: past }))).not.toBe(first);
    db.close();
  });
});

describe('each re-applied rule counts what the server counts, at the wall clock (s97-m01)', () => {
  it('pins the review threshold at the server’s default', () => {
    expect(SIGNALS_REVIEW_THRESHOLD).toBe(DEFAULT_STALENESS_THRESHOLD);
  });

  it('calls a project quiet at the review’s own silence threshold', () => {
    expect(QUIET_SILENT_DAYS).toBe(STALE_THRESHOLD_DAYS);
  });

  it('reviews_due equals readStaleness’s due decisions and learnings', async () => {
    const wall = Date.now();
    const { dbPath, db } = await initStore();
    closes(db, wall);
    const decision = db.prepare(
      "INSERT INTO strategic_decisions (decision_text, created_at, status, evidence, last_reviewed_at) VALUES (?, ?, 'active', ?, ?)"
    );
    decision.run('Old.', iso(wall - 400 * DAY), null, null);
    decision.run('Old, reviewed lately.', iso(wall - 400 * DAY), null, iso(wall - 10 * DAY));
    decision.run('Old, reviewed long ago.', iso(wall - 400 * DAY), null, iso(wall - 390 * DAY));
    decision.run('Old, with evidence.', iso(wall - 400 * DAY), '[{"type":"x","id":"1"}]', null);
    decision.run('Young.', iso(wall - 20 * DAY), null, null);
    // A replacement in a supersession is not due, however old.
    const replacement = decision.run(
      'Old replacement.',
      iso(wall - 400 * DAY),
      null,
      null
    ).lastInsertRowid;
    db.prepare(
      "INSERT INTO strategic_decisions (decision_text, created_at, status, superseded_by) VALUES ('Old replaced.', ?, 'superseded', ?)"
    ).run(iso(wall - 410 * DAY), replacement);
    const learning = db.prepare(
      "INSERT INTO learnings (content, created_at, status, evergreen) VALUES (?, ?, 'active', ?)"
    );
    learning.run('Old learning.', iso(wall - 400 * DAY), 0);
    learning.run('Old evergreen learning.', iso(wall - 400 * DAY), 1);
    db.close();
    const server = await withClient((client) => ({ success: true, data: readStaleness(client) }), {
      dbPath,
    });
    const library = signal(readSignals(dbPath, { now: Date.now() }), 'reviews_due');
    expect(server.data!.warnings).toEqual([]);
    expect(library.count).toBe(server.data!.dueDecisions + server.data!.dueLearnings);
    expect(library.count).toBe(3);
  });

  it('next_steps_lapsing equals the rows readLeaseAges puts at the warning age or past it', async () => {
    const wall = Date.now();
    const { dbPath, db } = await initStore();
    closes(db, wall);
    const step = db.prepare(
      'INSERT INTO next_steps (content, status, created_at, resolved_at) VALUES (?, ?, ?, ?)'
    );
    step.run('Pending since long ago.', 'pending', iso(wall - 100 * DAY), null);
    step.run('Carried lately.', 'carried', iso(wall - 100 * DAY), iso(wall - 12 * DAY));
    step.run('Carried a while ago.', 'carried', iso(wall - 100 * DAY), iso(wall - 30 * DAY));
    step.run('Done.', 'completed', iso(wall - 100 * DAY), null);
    db.close();
    const ages = await withClient((client) => ({ success: true, data: readLeaseAges(client) }), {
      dbPath,
    });
    const atWarning = ages.data!.filter((row) => row.closesSurvived >= LEASE_WARN_AT);
    const lapsing = ages.data!.filter(
      (row) => leaseState(row.closesSurvived, row.ageDays) === 'lapsing'
    );
    const library = signal(readSignals(dbPath, { now: Date.now() }), 'next_steps_lapsing');
    expect(library.count).toBe(atWarning.length);
    expect(library.lapseDue).toBe(lapsing.length);
    expect([...library.ids].sort()).toEqual(atWarning.map((row) => `n:${row.id}`).sort());
    expect(library.count).toBeGreaterThan(0);
  });
});
