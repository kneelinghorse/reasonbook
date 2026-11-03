// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — what a settle refuses and what it writes: a decision the operator's answer is recorded in settles
// ABOUTME: its pending draft as answered, settled; an autonomous, superseded or unrelated decision never does.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ensureProposalsTable,
  getDraft,
  insertDraft,
  markReplaced,
  rawRunner,
  type SqlRunner,
} from '../../../src/tools/rbook/proposals';
import { settleDrafts, type SettleOutcome } from '../../../src/tools/rbook/draft-settle';
import type { SettleLine } from '../../../src/tools/rbook/draft-settle-grammar';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const HOUR = 3_600_000;
const DRAFT = 'Store decisions as JSON files because they diff cleanly in review.';
/** 57% of DRAFT's own subject (draftCoverage). */
const PART = 'Store decisions as JSON files.';

let tmp: string;
let db: Database.Database;
let run: SqlRunner;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s109m02-settle-'));
  const projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  db = new Database(seedRbookDb(projectRoot, { projectName: 'settle' }));
  run = rawRunner(db);
  ensureProposalsTable(run);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function draft(text = DRAFT, at = NOW - 2 * HOUR, kind: 'decision' | 'rule' = 'decision'): number {
  return insertDraft(run, {
    text,
    kind,
    sourceSession: 'aaaaaaaaaaaaaaaa',
    assistantExcerpt: null,
    evidence: [],
    outsideContent: 0,
    createdAt: new Date(at).toISOString(),
  });
}

function decision(
  text: string,
  at = NOW - HOUR,
  fields: { approval_mode?: string | null; status?: string; superseded_by?: number } = {}
): number {
  const result = db
    .prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, approval_mode, status, superseded_by)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      text,
      Number.isFinite(at) ? new Date(at).toISOString() : 'not a time',
      fields.approval_mode ?? null,
      fields.status ?? 'active',
      fields.superseded_by ?? null
    );
  return Number(result.lastInsertRowid);
}

const line = (draftId: number, decisionId: number): SettleLine => ({
  draftId,
  decisionId,
  text: `Settled: P${draftId} by decision ${decisionId}`,
  misplaced: false,
});

function settle(
  lines: SettleLine[],
  options: Partial<Parameters<typeof settleDrafts>[0]> = {}
): SettleOutcome[] {
  return db.transaction(() =>
    settleDrafts({
      run,
      lines,
      sameReply: new Set(),
      declines: [],
      isExpired: () => false,
      settledBy: 'bbbbbbbbbbbbbbbb',
      now: NOW,
      ...options,
    })
  )();
}

const reasons = (outcomes: SettleOutcome[]) =>
  outcomes.map((outcome) => [outcome.applied, outcome.reason]);

describe('a settle writes the draft answered, settled, by the named decision (settled item 2)', () => {
  it('marks the draft answered as d:N with approval mode settled and the settling session', () => {
    const id = draft();
    const d = decision(DRAFT);
    expect(reasons(settle([line(id, d)]))).toEqual([[true, null]]);
    expect(getDraft(run, id)).toMatchObject({
      outcome: 'answered',
      recordId: `d:${d}`,
      approvalMode: 'settled',
    });
    expect(
      (
        db.prepare('SELECT settled_by FROM proposals WHERE id = ?').get(id) as {
          settled_by: string;
        }
      ).settled_by
    ).toBe('bbbbbbbbbbbbbbbb');
  });

  it('adds settled_by to a proposals table that predates it, once', () => {
    db.exec('DROP TABLE proposals');
    db.exec(`CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'decision', source_session TEXT, assistant_excerpt TEXT, evidence TEXT,
      outside_content INTEGER, created_at TEXT NOT NULL, offered_at TEXT, answered_at TEXT,
      outcome TEXT NOT NULL DEFAULT 'pending', replaced_by INTEGER, record_id TEXT, approval_mode TEXT)`);
    const first = draft();
    const second = draft(`${DRAFT} Also for the archive.`);
    const d = decision(`${DRAFT} Also for the archive.`);
    expect(reasons(settle([line(first, d), line(second, d)]))).toEqual([
      [true, null],
      [true, null],
    ]);
    const columns = (db.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>)
      .map((column) => column.name)
      .filter((name) => name === 'settled_by');
    expect(columns).toEqual(['settled_by']);
  });

  it('settles a revision chain back through settleRevised, as recording a revision does (#1514)', () => {
    const older = draft(DRAFT, NOW - 3 * HOUR);
    const newer = draft(`${DRAFT} Keep one file per decision.`, NOW - 2 * HOUR);
    db.prepare('UPDATE proposals SET replaced_by = ? WHERE id = ?').run(newer, older);
    const d = decision(`${DRAFT} Keep one file per decision.`);
    expect(reasons(settle([line(newer, d)]))).toEqual([[true, null]]);
    expect(getDraft(run, older)?.outcome).toBe('replaced');
  });

  it('applies a decision recorded after the draft at 0.3 of its subject, with a note below 0.85 (settled item 3)', () => {
    const id = draft();
    const [outcome] = settle([line(id, decision(PART))]);
    expect([outcome.applied, outcome.reason, outcome.detail]).toEqual([
      true,
      'low-coverage',
      '57%',
    ]);
    expect(getDraft(run, id)?.outcome).toBe('answered');
  });
});

describe('what a settle refuses (settled item 4); a refused draft stays pending and unchanged', () => {
  it('a draft that does not exist, or a store with no proposals table, which is never created', () => {
    const d = decision(DRAFT);
    expect(reasons(settle([line(999, d)]))).toEqual([[false, 'no-draft']]);
    db.exec('DROP TABLE proposals');
    expect(reasons(settle([line(1, d)]))).toEqual([[false, 'no-draft']]);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'proposals'").get()
    ).toBeUndefined();
  });

  it('a decision recorded autonomously, which claims no operator approval', () => {
    const id = draft();
    const d = decision(DRAFT, NOW - HOUR, { approval_mode: 'autonomous' });
    expect(reasons(settle([line(id, d)]))).toEqual([[false, 'autonomous']]);
    expect(getDraft(run, id)?.outcome).toBe('pending');
  });

  it('a superseded decision, naming the end of its chain', () => {
    const id = draft();
    const end = decision(DRAFT);
    const middle = decision(DRAFT, NOW - HOUR, { status: 'superseded', superseded_by: end });
    const first = decision(DRAFT, NOW - HOUR, { status: 'superseded', superseded_by: middle });
    const [outcome] = settle([line(id, first)]);
    expect([outcome.applied, outcome.reason, outcome.detail]).toEqual([
      false,
      'superseded',
      `d:${end}`,
    ]);
  });

  it('a constraint, rule or profile draft, which keeps needing the operator’s plain approval (#1188)', () => {
    const id = draft(DRAFT, NOW - 2 * HOUR, 'rule');
    expect(reasons(settle([line(id, decision(DRAFT))]))).toEqual([[false, 'not-decision']]);
  });

  it('a draft whose revision chain holds one the same reply drafts, which settleRevised would answer (critic A, B1)', () => {
    const first = draft();
    const revision = draft(`${DRAFT} Keep one file per decision.`);
    db.prepare('UPDATE proposals SET replaced_by = ? WHERE id = ?').run(revision, first);
    const [outcome] = settle([line(first, decision(DRAFT))], { sameReply: new Set([revision]) });
    expect(outcome.reason).toBe('same-reply');
    expect([getDraft(run, first)?.outcome, getDraft(run, revision)?.outcome]).toEqual([
      'pending',
      'pending',
    ]);
  });

  it('a settle of a revision whose earlier draft the same reply repeats, which settleRevised would replace (verifier A2, note 3)', () => {
    const first = draft();
    const revision = draft(`${DRAFT} Keep one file per decision.`);
    db.prepare('UPDATE proposals SET replaced_by = ? WHERE id = ?').run(revision, first);
    const [outcome] = settle([line(revision, decision(`${DRAFT} Keep one file per decision.`))], {
      sameReply: new Set([first]),
    });
    expect(outcome.reason).toBe('same-reply');
    expect([getDraft(run, first)?.outcome, getDraft(run, revision)?.outcome]).toEqual([
      'pending',
      'pending',
    ]);
  });

  it('autonomous in any letter case, and a superseded status with no successor names no chain’s end (critic A, note 3)', () => {
    const id = draft();
    expect(
      reasons(settle([line(id, decision(DRAFT, NOW - HOUR, { approval_mode: 'Autonomous' }))]))
    ).toEqual([[false, 'autonomous']]);
    const [outcome] = settle([line(id, decision(DRAFT, NOW - HOUR, { status: 'superseded' }))]);
    expect([outcome.reason, outcome.detail]).toEqual(['superseded', '']);
  });

  it('an unreadable draft time is named as such, though expiry would read it expired (critic A, note 4)', () => {
    const id = draft();
    db.prepare('UPDATE proposals SET created_at = ? WHERE id = ?').run('yesterday', id);
    expect(reasons(settle([line(id, decision(DRAFT))], { isExpired: () => true }))).toEqual([
      [false, 'unreadable-time'],
    ]);
  });

  it('a draft the same reply’s Would record lines create, repeat or revise', () => {
    const id = draft();
    expect(reasons(settle([line(id, decision(DRAFT))], { sameReply: new Set([id]) }))).toEqual([
      [false, 'same-reply'],
    ]);
  });

  it('an expired draft, and one that is no longer pending, named by its state', () => {
    const expired = draft();
    expect(reasons(settle([line(expired, decision(DRAFT))], { isExpired: () => true }))).toEqual([
      [false, 'expired'],
    ]);
    const revised = draft();
    markReplaced(run, revised, expired, new Date(NOW).toISOString());
    const [outcome] = settle([line(revised, decision(DRAFT))]);
    expect([outcome.reason, outcome.detail]).toEqual(['not-pending', `replaced by P${expired}`]);
  });

  it('applies every retained decline first, so a declined draft is refused (#1650)', () => {
    const id = draft();
    const [outcome] = settle([line(id, decision(DRAFT))], {
      declines: [{ id, at: NOW - HOUR }],
    });
    expect([outcome.reason, outcome.detail]).toEqual(['not-pending', 'declined by the operator']);
    expect(getDraft(run, id)?.outcome).toBe('declined');
  });

  it('a decision that is not in the store, saying to sync first on a shared copy', () => {
    const id = draft();
    expect(settle([line(id, 4242)])[0]).toMatchObject({ reason: 'no-decision', detail: '' });
    db.exec('CREATE TABLE record_peers (replica_id TEXT)');
    expect(settle([line(id, 4242)])[0]).toMatchObject({
      reason: 'no-decision',
      detail: 'sync first',
    });
  });

  it('an unreadable time on the draft or the decision, failing closed', () => {
    const id = draft();
    expect(reasons(settle([line(id, decision(DRAFT, Number.NaN))]))).toEqual([
      [false, 'unreadable-time'],
    ]);
    db.prepare('UPDATE proposals SET created_at = ? WHERE id = ?').run('yesterday', id);
    expect(reasons(settle([line(id, decision(DRAFT))]))).toEqual([[false, 'unreadable-time']]);
  });

  it('a decision recorded after the draft below 0.3 of its subject, and an older one below 0.85', () => {
    const id = draft();
    expect(
      reasons(settle([line(id, decision('Rotate the dashboard keys every ninety days.'))]))
    ).toEqual([[false, 'coverage']]);
    const [outcome] = settle([line(id, decision(PART, NOW - 3 * HOUR))]);
    expect([outcome.reason, outcome.detail]).toEqual([
      'coverage',
      '57%, recorded before the draft',
    ]);
    expect(getDraft(run, id)?.outcome).toBe('pending');
  });

  it('a decision recorded at the same instant as the draft is held to the older floor', () => {
    const id = draft(DRAFT, NOW - HOUR);
    expect(settle([line(id, decision(PART, NOW - HOUR))])[0].reason).toBe('coverage');
  });

  it('a second settle of a draft one line already settled, named by its state', () => {
    const id = draft();
    const d = decision(DRAFT);
    expect(reasons(settle([line(id, d), line(id, d)]))).toEqual([
      [true, null],
      [false, 'not-pending'],
    ]);
  });
});
