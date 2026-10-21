// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m01 — each signal fires on a store in today's schema, written by the product's own paths where they exist,
// ABOUTME: and every rule is applied at the now it is given, 45 days off the wall clock, so a rule reading the clock fails.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  computeSignals,
  readSignals,
  SIGNAL_KINDS,
  SIGNAL_RULES,
  SIGNAL_RULES_AGE_ONLY,
  type SignalEntry,
  type SignalsReport,
} from '../../src/signals';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { withClient } from '../../src/tools/rbook/client';
import { rbookProjectInit } from '../../src/tools/rbook/rbook-project-init';
import {
  ensureAgentFeedbackTable,
  ensureLearningsTable,
  ensureReviewTimestamps,
} from '../../src/tools/rbook/schema-migrations';
import {
  draftRuntimeDir,
  openDraftRuntime,
  recordSessionStart,
} from '../../src/tools/rbook/draft-runtime';
import {
  DRAFT_EXPIRY_DAYS,
  DRAFT_EXPIRY_STARTS,
  ensureProposalsTable,
  insertDraft,
  markRevisedAfterApproval,
  rawRunner,
} from '../../src/tools/rbook/proposals';
import { draftRuntimeFile, draftStoreKey } from '../../src/tools/rbook/store-key';
import { installRecordGuards } from '../../src/tools/rbook/record-guards';
import { rbookAgentOnboard } from '../../src/tools/rbook/rbook-agent-onboard';
import { rbookDecisions } from '../../src/tools/rbook/rbook-decisions';
import { rbookMissionTransition } from '../../src/tools/rbook/rbook-mission-transition';
import { LEASE_WARN_AT } from '../../src/tools/rbook/next-step-lease';
import { rbookSession } from '../../src/tools/rbook/rbook-session';

const DAY = 86_400_000;
/** Every rule runs at this instant, far from the wall clock: one that reads Date.now() fails here. */
const NOW = Date.now() - 45 * DAY;
const iso = (ms: number): string => new Date(ms).toISOString();

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface Store {
  readonly root: string;
  readonly dbPath: string;
  readonly db: Database.Database;
  readonly projectId: string;
}

const savedEnv = { config: process.env.RBOOK_CONFIG_DIR, sync: process.env.RBOOK_CHECKPOINT_SYNC };
beforeAll(() => {
  process.env.RBOOK_CONFIG_DIR = tmp('rbook-signals-home-');
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
});
afterAll(() => {
  if (savedEnv.config === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedEnv.config;
  if (savedEnv.sync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = savedEnv.sync;
});

/**
 * A store as the product makes and migrates it: made by init, then given the columns the first
 * reads and writes add (learnings' evergreen and review times, and the feedback table), as every
 * store in use has them. A seeded schema is not a real store (tests/helpers/seedRbookDb.ts).
 */
async function store(): Promise<Store> {
  const root = tmp('rbook-signals-');
  const init = await rbookProjectInit({
    projectRoot: root,
    projectName: 'Signals fixture',
  } as never);
  expect(init.success).toBe(true);
  const dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  const migrated = await withClient(
    (client) => {
      for (const migrate of [
        ensureLearningsTable,
        ensureReviewTimestamps,
        ensureAgentFeedbackTable,
      ])
        migrate(client);
      return { success: true, data: null };
    },
    { dbPath }
  );
  expect(migrated.success).toBe(true);
  const db = new Database(dbPath);
  const projectId = (
    db.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get() as { value: string }
  ).value;
  return { root, dbPath, db, projectId };
}

function signal(report: SignalsReport, kind: SignalEntry['kind']): SignalEntry {
  return report.signals.find((entry) => entry.kind === kind)!;
}

/** Completed sprints closed at these instants, oldest first: the closes a lease and a review age count. */
function closes(s: Store, ...ends: number[]): void {
  const insert = s.db.prepare(
    "INSERT INTO sprints (id, title, status, end_date) VALUES (?, ?, 'Completed', ?)"
  );
  ends.forEach((end, i) => insert.run(`sprint-c${i + 1}`, `Closed ${i + 1}`, iso(end)));
}

let current: Store;
beforeEach(async () => {
  RbookDetector.resetInstance();
  current = await store();
});
afterEach(() => {
  current.db.close();
});

describe('the signals library (s97-m01)', () => {
  it('marks a rule that failed on the store, apart from an input the layout lacks', () => {
    current.db.exec(
      'DROP TABLE IF EXISTS proposals; CREATE VIEW proposals AS SELECT * FROM no_such_table'
    );
    const report = readSignals(current.dbPath, { now: NOW });
    expect(signal(report, 'drafts_pending')).toMatchObject({
      available: false,
      count: null,
      failed: true,
    });
    expect(signal(report, 'drafts_pending').reason).toMatch(/could not be read/);
    // An absent input is unavailable and not failed.
    expect(signal(report, 'shared_conflicts')).toMatchObject({ available: false });
    expect(signal(report, 'shared_conflicts').failed).toBeUndefined();
  });

  it('reads every rule in one transaction, and inside a caller’s own', () => {
    const outside = computeSignals(current.db, { storePath: current.dbPath, now: NOW });
    expect(current.db.inTransaction).toBe(false);
    const inside = current.db.transaction(() =>
      computeSignals(current.db, { storePath: current.dbPath, now: NOW })
    )();
    expect(JSON.stringify(inside)).toBe(JSON.stringify(outside));
  });

  it('publishes rules that cannot be changed, built from the constants they state', () => {
    expect(Object.isFrozen(SIGNAL_RULES)).toBe(true);
    expect(Object.isFrozen(SIGNAL_RULES_AGE_ONLY)).toBe(true);
    expect(SIGNAL_RULES.drafts_pending).toContain(`${DRAFT_EXPIRY_DAYS} days`);
    expect(SIGNAL_RULES.next_steps_lapsing).toContain(`${LEASE_WARN_AT} or more closes`);
  });

  it('reports every signal, in order, with its rule, and computedAt equal to now', () => {
    const report = readSignals(current.dbPath, { now: NOW });
    expect(report.schema).toBe('rbook.signals/1');
    expect(report.signals.map((entry) => entry.kind)).toEqual([...SIGNAL_KINDS]);
    expect(report.computedAt).toBe(iso(NOW));
    expect(report.project).toEqual({ id: current.projectId, name: 'Signals fixture' });
    for (const kind of SIGNAL_KINDS) expect(report.rules[kind]).toMatch(/\w/);
  });

  describe('drafts_pending', () => {
    function draft(createdAt: number, text: string): number {
      const run = rawRunner(current.db);
      ensureProposalsTable(run);
      return insertDraft(run, {
        text,
        kind: 'decision',
        sourceSession: 'a1b2c3d4e5f60718',
        assistantExcerpt: null,
        evidence: [],
        outsideContent: null,
        createdAt: iso(createdAt),
      });
    }

    it('counts drafts under 7 days old at now, oldest first, and never one drafted after now', () => {
      const old = draft(NOW - 3 * DAY, 'Use the older plan.');
      const fresh = draft(NOW - 1 * DAY, 'Use the newer plan.');
      draft(NOW - 8 * DAY, 'Expired by age.');
      draft(NOW + DAY, 'Drafted after now.');
      const entry = signal(readSignals(current.dbPath, { now: NOW }), 'drafts_pending');
      expect(entry).toMatchObject({ available: true, count: 2, ids: [`P${old}`, `P${fresh}`] });
      // s97-m03: the brief lists the oldest first, so the report says when the oldest began.
      expect(entry.oldestAt).toBe(iso(NOW - 3 * DAY));
    });

    it('with the machine’s real runtime folder, expires a draft after three session starts', () => {
      const env = { RBOOK_CONFIG_DIR: tmp('rbook-signals-config-') };
      const counted = draft(NOW - 2 * DAY, 'Two starts since.');
      const expired = draft(NOW - 3 * DAY, 'Three starts since.');
      const runtime = openDraftRuntime(current.dbPath, env)!;
      expect(runtime).not.toBeNull();
      // Three starts after the older draft, two of them after the newer one, and one after now.
      for (const at of [NOW - 2.5 * DAY, NOW - 1.5 * DAY, NOW - 0.5 * DAY, NOW + DAY])
        recordSessionStart(runtime, 'f0e1d2c3b4a59687', at);
      runtime.close();
      const withRuntime = signal(
        readSignals(current.dbPath, { now: NOW, draftRuntimeDir: draftRuntimeDir(env) }),
        'drafts_pending'
      );
      expect(withRuntime).toMatchObject({ count: 1, ids: [`P${counted}`] });
      expect(withRuntime.reason).toBeUndefined();
      // Without the runtime, age alone: both drafts count, and the report's rule says so; with
      // it, the rule names the starts and not age alone.
      const plain = readSignals(current.dbPath, { now: NOW });
      expect(signal(plain, 'drafts_pending')).toMatchObject({
        count: 2,
        ids: [`P${expired}`, `P${counted}`],
      });
      expect(plain.rules).toBe(SIGNAL_RULES_AGE_ONLY);
      expect(plain.rules.drafts_pending).toMatch(/by age only: no draft runtime was given/);
      const withStarts = readSignals(current.dbPath, {
        now: NOW,
        draftRuntimeDir: draftRuntimeDir(env),
      });
      expect(withStarts.rules).toBe(SIGNAL_RULES);
      expect(withStarts.rules.drafts_pending).not.toMatch(/age only: no draft runtime/);
      expect(withStarts.rules.drafts_pending).toContain(`${DRAFT_EXPIRY_STARTS} session starts`);
    });

    it('leaves out a draft approved and then revised, which waits only to be recorded', () => {
      const approved = draft(NOW - DAY, 'Use the weekly review.');
      const revision = draft(NOW - DAY / 2, 'Use the weekly review, on Mondays.');
      // As the Stop hook links a revision of an approved draft (proposals.ts).
      expect(markRevisedAfterApproval(rawRunner(current.db), approved, revision)).toBe(1);
      expect(signal(readSignals(current.dbPath, { now: NOW }), 'drafts_pending')).toMatchObject({
        count: 1,
        ids: [`P${revision}`],
      });
    });

    it('counts by age, and says why, when the runtime file is damaged or not a plain file', () => {
      draft(NOW - DAY, 'A pending draft.');
      const env = { RBOOK_CONFIG_DIR: tmp('rbook-signals-damaged-') };
      const dir = draftRuntimeDir(env);
      fs.mkdirSync(dir, { recursive: true });
      const file = draftRuntimeFile(
        dir,
        draftStoreKey({ projectId: current.projectId, dbPath: current.dbPath })
      );
      fs.writeFileSync(file, Buffer.alloc(8192, 0x5a));
      const damaged = signal(
        readSignals(current.dbPath, { now: NOW, draftRuntimeDir: dir }),
        'drafts_pending'
      );
      expect(damaged).toMatchObject({ available: true, count: 1 });
      expect(damaged.reason).toMatch(/draft runtime unreadable .*age only/);
      // A second name for the file is refused as the server's own open refuses it.
      fs.linkSync(file, `${file}.other`);
      const linked = signal(
        readSignals(current.dbPath, { now: NOW, draftRuntimeDir: dir }),
        'drafts_pending'
      );
      expect(linked.reason).toMatch(/draft runtime is not a plain file/);
      // So is a linked sidecar beside a plain file, as the server's open refuses one.
      fs.rmSync(`${file}.other`);
      fs.symlinkSync(path.join(dir, 'elsewhere'), `${file}-wal`);
      const sidecar = signal(
        readSignals(current.dbPath, { now: NOW, draftRuntimeDir: dir }),
        'drafts_pending'
      );
      expect(sidecar).toMatchObject({ count: 1 });
      expect(sidecar.reason).toMatch(/draft runtime is not a plain file/);
      // A link that leads nowhere is there, and not a plain file: not "not found".
      for (const name of [file, `${file}-wal`]) fs.rmSync(name, { force: true });
      fs.symlinkSync(path.join(dir, 'nowhere'), file);
      const dangling = signal(
        readSignals(current.dbPath, { now: NOW, draftRuntimeDir: dir }),
        'drafts_pending'
      );
      expect(dangling.reason).toMatch(/draft runtime is not a plain file/);
    });

    it('says the runtime was not found rather than counting by age silently', () => {
      draft(NOW - DAY, 'A pending draft.');
      const missing = tmp('rbook-signals-nodrafts-');
      const entry = signal(
        readSignals(current.dbPath, { now: NOW, draftRuntimeDir: missing }),
        'drafts_pending'
      );
      expect(entry.count).toBe(1);
      expect(entry.reason).toMatch(/draft runtime not found .*age only/);
    });

    it('counts a draft whose time cannot be read apart, as undated', () => {
      draft(NOW - DAY, 'Readable.');
      const run = rawRunner(current.db);
      run.run("UPDATE proposals SET created_at = 'not a time' WHERE text = 'Readable.'");
      draft(NOW - DAY, 'Also readable.');
      const entry = signal(readSignals(current.dbPath, { now: NOW }), 'drafts_pending');
      expect(entry).toMatchObject({ count: 1, undated: 1 });
    });
  });

  describe('next_steps_lapsing', () => {
    it('counts open next steps that survived three closes, and names the ones the next close drops', () => {
      closes(current, NOW - 30 * DAY, NOW - 20 * DAY, NOW - 10 * DAY, NOW - 5 * DAY);
      const insert = current.db.prepare(
        'INSERT INTO next_steps (content, status, created_at, resolved_at) VALUES (?, ?, ?, ?)'
      );
      const four = insert.run(
        'Four closes old.',
        'pending',
        iso(NOW - 40 * DAY),
        null
      ).lastInsertRowid;
      const three = insert.run(
        'Carried before three closes.',
        'carried',
        iso(NOW - 40 * DAY),
        iso(NOW - 25 * DAY)
      ).lastInsertRowid;
      insert.run('Two closes old.', 'pending', iso(NOW - 15 * DAY), null);
      insert.run('Completed rows do not lapse.', 'completed', iso(NOW - 40 * DAY), null);
      insert.run('Written after now.', 'pending', iso(NOW + DAY), null);
      const entry = signal(readSignals(current.dbPath, { now: NOW }), 'next_steps_lapsing');
      expect(entry).toMatchObject({
        available: true,
        count: 2,
        lapseDue: 1,
        ids: [`n:${four}`, `n:${three}`],
        oldestAt: iso(NOW - 40 * DAY),
      });
    });

    it('counts only a close whose status is exactly Completed, as the lease reads it', () => {
      closes(current, NOW - 30 * DAY, NOW - 20 * DAY);
      current.db
        .prepare(
          "INSERT INTO sprints (id, title, status, end_date) VALUES ('lower', 'Closed', 'completed', ?)"
        )
        .run(iso(NOW - 10 * DAY));
      current.db
        .prepare(
          "INSERT INTO next_steps (content, status, created_at) VALUES ('Old.', 'pending', ?)"
        )
        .run(iso(NOW - 40 * DAY));
      expect(signal(readSignals(current.dbPath, { now: NOW }), 'next_steps_lapsing').count).toBe(0);
    });

    it('does not count a close dated after now', () => {
      closes(current, NOW - 30 * DAY, NOW - 20 * DAY, NOW + 5 * DAY);
      current.db
        .prepare(
          "INSERT INTO next_steps (content, status, created_at) VALUES ('Old.', 'pending', ?)"
        )
        .run(iso(NOW - 40 * DAY));
      expect(signal(readSignals(current.dbPath, { now: NOW }), 'next_steps_lapsing').count).toBe(0);
    });
  });

  describe('reviews_due', () => {
    function twentyCloses(): void {
      closes(current, ...Array.from({ length: 20 }, (_, i) => NOW - (200 - i * 5) * DAY));
    }

    it('counts active rows 20 closes old, not reviewed in the window, and leaves out what the rule leaves out', () => {
      twentyCloses();
      const decision = current.db.prepare(
        "INSERT INTO strategic_decisions (decision_text, created_at, status, evidence) VALUES (?, ?, 'active', ?)"
      );
      const due = decision.run('Old and unreviewed.', iso(NOW - 300 * DAY), null).lastInsertRowid;
      decision.run('Old but with evidence.', iso(NOW - 300 * DAY), '[{"type":"file","id":"x"}]');
      decision.run('Too young.', iso(NOW - 50 * DAY), null);
      const learning = current.db.prepare(
        "INSERT INTO learnings (content, created_at, status, evergreen) VALUES (?, ?, 'active', ?)"
      );
      const dueLearning = learning.run('An old learning.', iso(NOW - 300 * DAY), 0).lastInsertRowid;
      learning.run('An evergreen learning.', iso(NOW - 300 * DAY), 1);
      const entry = signal(readSignals(current.dbPath, { now: NOW }), 'reviews_due');
      expect(entry).toMatchObject({ available: true, count: 2 });
      expect([...entry.ids].sort()).toEqual([`d:${due}`, `l:${dueLearning}`].sort());
    });

    it('counts the rows that became due in the window, from the closes in it (s97-m03)', () => {
      // Nineteen closes before the window and one inside it: the old row reaches twenty in the
      // window; the older row already had twenty before it.
      closes(
        current,
        ...Array.from({ length: 19 }, (_, i) => NOW - (100 - i * 2) * DAY),
        NOW - 2 * DAY
      );
      current.db
        .prepare(
          "INSERT INTO sprints (id, title, status, end_date) VALUES ('older-close', 'Closed', 'Completed', ?)"
        )
        .run(iso(NOW - 150 * DAY));
      const decision = current.db.prepare(
        "INSERT INTO strategic_decisions (decision_text, created_at, status) VALUES (?, ?, 'active')"
      );
      decision.run('Due before the window: twenty closes since.', iso(NOW - 200 * DAY));
      decision.run(
        'Due in the window: its twentieth close came two days ago.',
        iso(NOW - 120 * DAY)
      );
      const report = readSignals(current.dbPath, { now: NOW, windowDays: 7 });
      expect(signal(report, 'reviews_due')).toMatchObject({ count: 2, becameDue: 1 });
      // A window that holds every close sees both as new: neither was due at its start.
      expect(
        signal(readSignals(current.dbPath, { now: NOW, windowDays: 160 }), 'reviews_due')
      ).toMatchObject({ count: 2, becameDue: 2 });
    });

    it('counts an unreadable anchor apart only for rows the rule applies to', () => {
      twentyCloses();
      const decision = current.db.prepare(
        "INSERT INTO strategic_decisions (decision_text, created_at, status, evidence) VALUES (?, 'whenever', 'active', ?)"
      );
      decision.run('Undated, no evidence.', null);
      decision.run('Undated, with evidence.', '[{"type":"file","id":"x"}]');
      current.db
        .prepare(
          "INSERT INTO learnings (content, created_at, status, evergreen) VALUES ('Undated evergreen.', 'whenever', 'active', 1)"
        )
        .run();
      expect(signal(readSignals(current.dbPath, { now: NOW }), 'reviews_due')).toMatchObject({
        count: 0,
        undated: 1,
      });
    });

    it('ignores RBOOK_STALENESS_THRESHOLD_SPRINTS: the library pins its threshold at 20', () => {
      twentyCloses();
      current.db
        .prepare(
          "INSERT INTO strategic_decisions (decision_text, created_at, status) VALUES ('Nineteen closes old.', ?, 'active')"
        )
        .run(iso(NOW - 196 * DAY));
      const saved = process.env.RBOOK_STALENESS_THRESHOLD_SPRINTS;
      process.env.RBOOK_STALENESS_THRESHOLD_SPRINTS = '1';
      try {
        expect(signal(readSignals(current.dbPath, { now: NOW }), 'reviews_due').count).toBe(0);
      } finally {
        if (saved === undefined) delete process.env.RBOOK_STALENESS_THRESHOLD_SPRINTS;
        else process.env.RBOOK_STALENESS_THRESHOLD_SPRINTS = saved;
      }
    });
  });

  describe('superseded_cited', () => {
    it('counts active rows citing a superseded decision, but not a decision citing the one it replaced', async () => {
      const record = async (content: string, supersedes?: number[]) => {
        const result = await rbookDecisions({
          action: 'record',
          content,
          projectRoot: current.root,
          ...(supersedes ? { supersedes } : {}),
        });
        expect(result.success).toBe(true);
        return (result.data as { decisionId: number }).decisionId;
      };
      const old = await record('Store drafts in the session table.');
      const replacement = await record(
        `Store drafts in their own table; this supersedes d:${old}.`,
        [old]
      );
      const citing = await record(`The history still follows d:${old}.`);
      const later = await record(`A choice made after now that also follows d:${old}.`);
      await record('Unrelated choice.');
      // The writes happened at the wall clock; move them before now, a day apart in the order they
      // were made, since a citation counts only of an earlier record.
      current.db
        .prepare('UPDATE strategic_decisions SET created_at = ? WHERE id = ?')
        .run(iso(NOW - 10 * DAY), old);
      for (const [id, days] of [
        [replacement, 9],
        [citing, 8],
        [later, -2],
      ] as const)
        current.db
          .prepare('UPDATE strategic_decisions SET created_at = ? WHERE id = ?')
          .run(iso(NOW - days * DAY), id);
      const entry = signal(readSignals(current.dbPath, { now: NOW }), 'superseded_cited');
      expect(entry).toMatchObject({ available: true, count: 1, ids: [`d:${citing}`] });
      expect(entry.ids).not.toContain(`d:${replacement}`);
      expect(entry.ids).not.toContain(`d:${later}`);
    });

    it('follows the chain of replacements past one step, and counts a learning that cites', async () => {
      const record = async (content: string, supersedes?: number[]) => {
        const result = await rbookDecisions({
          action: 'record',
          content,
          projectRoot: current.root,
          ...(supersedes ? { supersedes } : {}),
        });
        expect(result.success).toBe(true);
        return (result.data as { decisionId: number }).decisionId;
      };
      const a = await record('Keep the brief in the digest.');
      const b = await record(`Keep the brief on the dashboard; this supersedes d:${a}.`, [a]);
      const c = await record(`Render the brief in the library, as d:${a} once said.`, [b]);
      // The learning comes through the capture the tools use, then moves before now with the rest.
      const captured = await rbookSession({
        action: 'capture',
        category: 'learning',
        content: `The digest was the wrong home for the brief (d:${a}).`,
        projectRoot: current.root,
      });
      expect(captured.success).toBe(true);
      const learning = (captured.data as { learningId: number }).learningId;
      current.db
        .prepare('UPDATE learnings SET created_at = ? WHERE id = ?')
        .run(iso(NOW - 5 * DAY), learning);
      for (const [id, days] of [
        [a, 10],
        [b, 9],
        [c, 8],
      ] as const)
        current.db
          .prepare('UPDATE strategic_decisions SET created_at = ? WHERE id = ?')
          .run(iso(NOW - days * DAY), id);
      const entry = signal(readSignals(current.dbPath, { now: NOW }), 'superseded_cited');
      // c replaced b, which replaced a: c citing a is its own history, two steps back.
      expect(entry).toMatchObject({ count: 1, ids: [`l:${learning}`] });
    });
  });

  describe('missions_blocked', () => {
    it('counts blocked missions, longest blocked first, from the block the tool records', async () => {
      const insert = current.db.prepare(
        "INSERT INTO missions (id, name, status) VALUES (?, ?, 'In Progress')"
      );
      insert.run('m-old', 'Blocked first');
      insert.run('m-new', 'Blocked second');
      insert.run('m-free', 'Not blocked');
      for (const missionId of ['m-new', 'm-old']) {
        const result = await rbookMissionTransition({
          action: 'block',
          missionId,
          reason: 'Waiting on a review.',
          projectRoot: current.root,
        });
        expect(result.success).toBe(true);
      }
      // The tool stamped blockedSince at the wall clock; place m-old's block earlier than m-new's.
      const since = (id: string, at: number) =>
        current.db
          .prepare('UPDATE missions SET domain_fields = json_set(domain_fields, ?, ?) WHERE id = ?')
          .run('$.blockedSince', iso(at), id);
      since('m-old', NOW - 20 * DAY);
      since('m-new', NOW - 2 * DAY);
      const entry = signal(readSignals(current.dbPath, { now: NOW }), 'missions_blocked');
      expect(entry).toMatchObject({
        available: true,
        count: 2,
        ids: ['m-old', 'm-new'],
        oldestAt: iso(NOW - 20 * DAY),
      });
      expect(entry.sinceUnknown).toBeUndefined();
      // With no blockedSince, the block event the tool wrote dates it: m-new now ranks first.
      current.db
        .prepare(
          "UPDATE missions SET domain_fields = json_remove(domain_fields, '$.blockedSince') WHERE id = 'm-new'"
        )
        .run();
      current.db
        .prepare("UPDATE session_events SET ts = ? WHERE mission = 'm-new' AND action = 'block'")
        .run(iso(NOW - 30 * DAY));
      const fallback = signal(readSignals(current.dbPath, { now: NOW }), 'missions_blocked');
      expect(fallback).toMatchObject({ count: 2, ids: ['m-new', 'm-old'] });
      expect(fallback.sinceUnknown).toBeUndefined();
      // Another spelling is not a block to the server (status = 'Blocked'), so not to the signal.
      current.db
        .prepare("INSERT INTO missions (id, name, status) VALUES ('m-case', 'Odd case', 'blocked')")
        .run();
      expect(signal(readSignals(current.dbPath, { now: NOW }), 'missions_blocked').count).toBe(2);
    });
  });

  describe('feedback_open', () => {
    it('counts open friction by kind, with the unclassified rows beside it', async () => {
      for (const agentFeedback of [
        'cmos_mission(action="status") returned 93KB, past the tool-result token cap.',
        'cmos_review build-freshness warning never clears for this repo.',
        'The project tests were flaky; nothing about the tooling.',
      ])
        await rbookAgentOnboard({ agentFeedback, projectRoot: current.root });
      current.db.prepare('UPDATE agent_feedback SET created_at = ?').run(iso(NOW - DAY));
      const entry = signal(readSignals(current.dbPath, { now: NOW }), 'feedback_open');
      expect(entry).toMatchObject({
        available: true,
        count: 2,
        unclassified: 1,
        byKind: { payload: 1, ceremony: 1, identity: 0, sync: 0, surfacing: 0 },
      });
      expect(entry.ids).toHaveLength(2);
      current.db
        .prepare("UPDATE agent_feedback SET created_at = 'whenever' WHERE body LIKE '%flaky%'")
        .run();
      expect(signal(readSignals(current.dbPath, { now: NOW }), 'feedback_open')).toMatchObject({
        count: 2,
        unclassified: 0,
        undated: 1,
      });
    });
  });

  describe('quiet_days', () => {
    it('counts whole days from the newest row stamped at or before now', () => {
      current.db
        .prepare(
          "INSERT INTO strategic_decisions (decision_text, created_at, occurred_at) VALUES ('a', ?, ?)"
        )
        .run(iso(NOW - 12 * DAY), NOW - 12 * DAY);
      current.db
        .prepare("INSERT INTO learnings (content, created_at, occurred_at) VALUES ('b', ?, ?)")
        .run(iso(NOW + 3 * DAY), NOW + 3 * DAY);
      expect(signal(readSignals(current.dbPath, { now: NOW }), 'quiet_days')).toMatchObject({
        available: true,
        count: 12,
      });
    });
  });

  describe('constraints_expiring', () => {
    it('counts active constraints expiring within 7 days of now, soonest first', () => {
      const insert = current.db.prepare(
        'INSERT INTO constraints (content, created_at, status, expires_at) VALUES (?, ?, ?, ?)'
      );
      const soon = insert.run(
        'Soon.',
        iso(NOW - DAY),
        'active',
        iso(NOW + 2 * DAY)
      ).lastInsertRowid;
      const later = insert.run(
        'Later.',
        iso(NOW - DAY),
        'active',
        iso(NOW + 6 * DAY)
      ).lastInsertRowid;
      insert.run('Past it.', iso(NOW - DAY), 'active', iso(NOW - DAY));
      insert.run('Too far.', iso(NOW - DAY), 'active', iso(NOW + 10 * DAY));
      insert.run('Archived.', iso(NOW - DAY), 'archived', iso(NOW + 2 * DAY));
      insert.run('Unreadable.', iso(NOW - DAY), 'active', 'whenever');
      expect(
        signal(readSignals(current.dbPath, { now: NOW }), 'constraints_expiring')
      ).toMatchObject({
        available: true,
        count: 2,
        ids: [`c:${soon}`, `c:${later}`],
        undated: 1,
      });
    });
  });

  describe('shared_conflicts', () => {
    // A shared copy's conflicts and removal fire in tests/signals/shared-conflicts.test.ts, on
    // copies the merge itself left them in.
    it('is unavailable on a copy that was never shared, never a zero', () => {
      expect(signal(readSignals(current.dbPath, { now: NOW }), 'shared_conflicts')).toMatchObject({
        available: false,
        count: null,
      });
    });

    it('reads a copy that keeps no record of its peers as told nothing, and its rule says so', () => {
      // The shared record's log tables before any exchange was noted: conflicts, and no peers.
      installRecordGuards((sql) => current.db.exec(sql));
      const report = readSignals(current.dbPath, { now: NOW });
      expect(signal(report, 'shared_conflicts')).toMatchObject({
        available: true,
        count: 0,
        removed: false,
      });
      expect(report.rules.shared_conflicts).toMatch(/keeps no peer record.*says nothing/);
    });
  });

  describe('the window, when a table it counts cannot be read', () => {
    it('says why its counts are null, and the signals that do not need that table still read', () => {
      current.db.exec('DROP TABLE learnings; CREATE VIEW learnings AS SELECT * FROM no_such_table');
      const report = readSignals(current.dbPath, { now: NOW });
      expect(report.window.counts).toEqual({
        decisions: null,
        learnings: null,
        missionsCompleted: null,
        sprintsClosed: null,
      });
      expect(report.window.reason).toMatch(/could not be read/);
      expect(signal(report, 'next_steps_lapsing')).toMatchObject({ available: true });
      expect(report.unreadable).toBeUndefined();
    });

    it('says why the feedback kinds are unknown, never a row of zeros', () => {
      current.db.exec(
        'DROP TABLE agent_feedback; CREATE VIEW agent_feedback AS SELECT * FROM no_such_table'
      );
      const report = readSignals(current.dbPath, { now: NOW });
      expect(report.feedbackKinds).toMatchObject({
        available: false,
        counts: null,
        unclassified: null,
      });
      expect(report.feedbackKinds.reason).toMatch(/could not be read/);
      expect(signal(report, 'feedback_open')).toMatchObject({ available: false, failed: true });
    });
  });

  describe('the window', () => {
    it('counts new rows and new feedback by kind in the days before now', async () => {
      current.db
        .prepare(
          "INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('In.', ?), ('Out.', ?)"
        )
        .run(iso(NOW - 2 * DAY), iso(NOW - 9 * DAY));
      closes(current, NOW - 3 * DAY, NOW - 30 * DAY);
      await rbookAgentOnboard({
        agentFeedback: 'cmos_review build-freshness warning again.',
        projectRoot: current.root,
      });
      current.db.prepare('UPDATE agent_feedback SET created_at = ?').run(iso(NOW - DAY));
      const report = readSignals(current.dbPath, { now: NOW });
      expect(report.window).toMatchObject({
        days: 7,
        counts: { decisions: 1, sprintsClosed: 1, learnings: 0 },
      });
      expect(report.feedbackKinds).toMatchObject({ available: true, counts: { ceremony: 1 } });
    });
  });
});
