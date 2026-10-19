/**
 * Staleness Detection Tests
 *
 * s93-m11 (operator Q10, decision #1182): staleness is computed when read and never written. These
 * tests pin the three halves: readStaleness counts what is due for review with the old flagger's
 * exemptions and changes no row; the clock counts only Completed sprints and the open one; and
 * repairFlaggerStaleness restores exactly the rows an automatic flagger could have written.
 *
 * @module tests/tools/rbook/staleness-detection
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  countReflaggedSinceRepair,
  readStaleness,
  readStalenessRepairLedger,
  repairFlaggerStaleness,
  reviewDecisionStaleness,
  DEFAULT_STALENESS_THRESHOLD,
  STALENESS_COUNTING_RULE,
} from '../../../src/tools/rbook/staleness-detection';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { withClient, type RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { createSuccess } from '../../../src/tools/rbook/errors';
import { seedRbookDb } from '../../helpers/seedRbookDb';

describe('staleness-detection', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-staleness-test-'));
    const rbookDir = path.join(tempDir, 'rbook');
    const dbDir = path.join(rbookDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'rbook.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT REFERENCES sprints(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        completed_at TEXT,
        notes TEXT,
        objective TEXT,
        context TEXT,
        success_criteria TEXT,
        deliverables TEXT,
        reference_docs TEXT,
        domain_fields TEXT,
        metadata TEXT
      );

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT REFERENCES sprints(id),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_reviewed_at TEXT,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT,
        session_id TEXT,
        mission_id TEXT,
        source_chunk_ids TEXT,
        category TEXT,
        superseded_by INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        evidence TEXT
      );

      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        category TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        sprint_id TEXT,
        session_id TEXT,
        mission_id TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO metadata (key, value) VALUES ('project_name', 'Reasonbook MCP Test');
    `);
    db.close();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function runWithClient<T>(fn: (client: RbookDatabaseClient) => T): Promise<T> {
    let captured: T;
    await withClient(
      (client) => {
        captured = fn(client);
        return createSuccess(null);
      },
      { projectRoot: tempDir }
    );
    return captured!;
  }

  /** Close time of a sprint `i` of `count`, in label order, two weeks apart, the last a day ago. */
  const closedAt = (i: number, count: number): string =>
    new Date(Date.now() - ((count - i) * 14 + 1) * 24 * 60 * 60 * 1000).toISOString();

  /** sprint-1..sprint-count, closed in label order (s97-m13: ages count closes), one left open. */
  function seedSprints(count: number, activeSprintNum?: number): void {
    const db = new Database(dbPath);
    for (let i = 1; i <= count; i++) {
      const open = i === (activeSprintNum ?? count);
      db.prepare(`INSERT INTO sprints (id, title, status, end_date) VALUES (?, ?, ?, ?)`).run(
        `sprint-${i}`,
        `Sprint ${i}`,
        open ? 'Active' : 'Completed',
        open ? null : closedAt(i, count)
      );
    }
    db.close();
  }

  function seedDecisions(
    items: Array<{ text: string; sprintId: string; status?: string; evidence?: string }>
  ): void {
    const db = new Database(dbPath);
    for (const item of items) {
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status, evidence)
         VALUES (?, '2026-01-01T00:00:00Z', ?, ?, ?)`
      ).run(item.text, item.sprintId, item.status ?? 'active', item.evidence ?? null);
    }
    db.close();
  }

  function seedLearnings(
    items: Array<{ content: string; sprintId: string; status?: string }>
  ): void {
    const db = new Database(dbPath);
    for (const item of items) {
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status)
         VALUES (?, '2026-01-01T00:00:00Z', ?, ?)`
      ).run(item.content, item.sprintId, item.status ?? 'active');
    }
    db.close();
  }

  // s91-m08 — untagged decisions used to be filtered out of review by `sprint_id IS NOT NULL`, so
  // a 300-day-old one could never be flagged. They now age on wall-clock time (14 days/sprint).
  it('scores untagged decisions by wall-clock age instead of excluding them', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
       VALUES (?, ?, NULL, 'active')`
    );
    const daysAgo = (d: number): string =>
      new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
    const old = Number(insert.run('Untagged, 300 days old', daysAgo(300)).lastInsertRowid);
    const fresh = Number(insert.run('Untagged, 10 days old', daysAgo(10)).lastInsertRowid);
    db.close();

    const review = await runWithClient((client) =>
      reviewDecisionStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    const oldRow = review.decisions.find((d) => d.id === old);
    expect(oldRow).toBeDefined();
    expect(oldRow!.sprintId).toBeNull();
    expect(oldRow!.sprintAge).toBe(Math.floor(300 / 14));
    const freshScore = review.decisions.find((d) => d.id === fresh)?.stalenessScore ?? 0;
    expect(oldRow!.stalenessScore).toBeGreaterThan(freshScore);
  });

  /** Every status in both tables, so a test can prove a read changed none of them. */
  function statuses(): string {
    const db = new Database(dbPath, { readonly: true });
    try {
      return JSON.stringify([
        db.prepare('SELECT id, status FROM strategic_decisions ORDER BY id').all(),
        db.prepare('SELECT id, status FROM learnings ORDER BY id').all(),
      ]);
    } finally {
      db.close();
    }
  }

  it('counts decisions past the review age and changes no status', async () => {
    const totalSprints = DEFAULT_STALENESS_THRESHOLD + 5;
    seedSprints(totalSprints); // active sprint = totalSprints
    const recentSprintNum = totalSprints - 3;
    seedDecisions([
      { text: 'Old decision', sprintId: 'sprint-3' },
      { text: 'Recent decision', sprintId: `sprint-${recentSprintNum}` },
    ]);
    const before = statuses();

    const result = await runWithClient((client) =>
      readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.dueDecisions).toBe(1);
    expect(result.storedStaleDecisions).toBe(0);
    // The point of Q10: a read computes the age; it never writes it back as status='stale'.
    expect(statuses()).toBe(before);
  });

  it.each([
    {
      branch: 'completed-sprint fallback',
      currentStatus: 'Completed',
      historicalStatus: 'Completed',
    },
    { branch: 'active-sprint query', currentStatus: 'Active', historicalStatus: 'Current' },
  ])('reads the $branch by close time after a historical insert', async (row) => {
    const currentSprint = DEFAULT_STALENESS_THRESHOLD + 5;
    const db = new Database(dbPath);
    const insertSprint = db.prepare(
      `INSERT INTO sprints (id, title, status, end_date) VALUES (?, ?, ?, ?)`
    );
    const ended = (sprint: number, status: string): string | null =>
      status === 'Completed' ? closedAt(sprint, currentSprint) : null;
    for (let sprint = 1; sprint <= currentSprint; sprint += 1) {
      if (sprint === 3) continue;
      const status = sprint === currentSprint ? row.currentStatus : 'Completed';
      insertSprint.run(`sprint-${sprint}`, `Sprint ${sprint}`, status, ended(sprint, status));
    }
    // A backfilled historical row has the newest rowid but is not the newest sprint.
    insertSprint.run('sprint-3', 'Sprint 3', row.historicalStatus, ended(3, row.historicalStatus));
    db.close();

    seedDecisions([{ text: 'Old decision', sprintId: 'sprint-2' }]);

    const read = await runWithClient((client) =>
      readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );
    const review = await runWithClient((client) =>
      reviewDecisionStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    // The closes after sprint-2's: sprint-3..25 when all closed, sprint-4..24 when 3 and 25 are open.
    expect({
      currentSprintNumber: review.currentSprintNumber,
      sprintAge: review.decisions[0]?.sprintAge,
      dueDecisions: read.dueDecisions,
    }).toEqual({
      currentSprintNumber: currentSprint,
      sprintAge: row.currentStatus === 'Completed' ? 23 : 21,
      dueDecisions: 1,
    });
  });

  // The defect review #1181 found: seeding sprints 93-98 as Planned moved the cutoff six sprints
  // ahead, and 20 decisions were flagged early. A Planned sprint has not happened.
  it('never counts a Planned sprint on the clock, in any letter case', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5, 0); // all Completed
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO sprints (id, title, status, end_date) VALUES (?, ?, ?, ?)`
    );
    // Planned dates that have already passed, as seeded sprints carry them.
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    for (let n = 1; n <= 6; n++) {
      insert.run(`sprint-${DEFAULT_STALENESS_THRESHOLD + 5 + n}`, `Planned ${n}`, 'Planned', past);
    }
    insert.run(`sprint-${DEFAULT_STALENESS_THRESHOLD + 40}`, 'lower-case planned', 'planned', past);
    db.close();
    // 17 closes after sprint-8's: three short. A clock counting the planned sprints flags it.
    seedDecisions([{ text: 'Not yet due', sprintId: 'sprint-8' }]);

    const result = await runWithClient((client) =>
      readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );
    const review = await runWithClient((client) => reviewDecisionStaleness(client));

    expect(review.currentSprintNumber).toBe(DEFAULT_STALENESS_THRESHOLD + 5);
    expect(result.dueDecisions).toBe(0);
  });

  it('reads a lower-case completed or active sprint on the clock', async () => {
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO sprints (id, title, status, end_date) VALUES (?, ?, ?, ?)`
    );
    insert.run('sprint-1', 'One', 'completed', closedAt(1, 2));
    insert.run('sprint-2', 'Two', 'active', null);
    db.close();

    const review = await runWithClient((client) => reviewDecisionStaleness(client));

    expect(review.currentSprintNumber).toBe(2);
  });

  it('does not count a decision reviewed inside the review window', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);

    const recentReviewIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO strategic_decisions (
         decision_text,
         created_at,
         last_reviewed_at,
         sprint_id,
         status
       ) VALUES (?, '2026-01-01T00:00:00Z', ?, ?, 'active')`
    ).run('Recently reviewed decision', recentReviewIso, 'sprint-2');
    db.close();

    const result = await runWithClient((client) =>
      readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.dueDecisions).toBe(0);
    expect(result.storedStaleDecisions).toBe(0);
  });

  it('counts learnings past the review age without writing them', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);
    seedLearnings([
      { content: 'Old learning', sprintId: 'sprint-2' },
      { content: 'New learning', sprintId: 'sprint-14' },
    ]);
    const before = statuses();

    const result = await runWithClient((client) =>
      readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.dueLearnings).toBe(1);
    expect(result.storedStaleLearnings).toBe(0);
    expect(statuses()).toBe(before);
  });

  it('exempts decisions referenced via supersession chain', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);

    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status)
       VALUES (1, 'Old decision A', '2026-01-01T00:00:00Z', 'sprint-2', 'active')`
    ).run();
    db.prepare(
      `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status, superseded_by)
       VALUES (2, 'Old decision B', '2026-01-01T00:00:00Z', 'sprint-2', 'active', 1)`
    ).run();
    db.prepare(
      `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status)
       VALUES (3, 'Unreferenced old', '2026-01-01T00:00:00Z', 'sprint-3', 'active')`
    ).run();
    db.close();

    const result = await runWithClient((client) =>
      readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    // A is a supersession target, so it is exempt; B and C are due.
    expect(result.dueDecisions).toBe(2);
  });

  it('exempts decisions with evidence links', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);
    seedDecisions([
      { text: 'Has evidence', sprintId: 'sprint-2', evidence: '[{"type":"doc","id":"123"}]' },
      { text: 'No evidence', sprintId: 'sprint-2' },
    ]);

    const result = await runWithClient((client) =>
      readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.dueDecisions).toBe(1);
  });

  it('counts nothing when there are fewer sprints than threshold', async () => {
    const seedCount = DEFAULT_STALENESS_THRESHOLD - 5;
    seedSprints(seedCount);
    seedDecisions([{ text: 'Sprint 1 decision', sprintId: 'sprint-1' }]);

    const result = await runWithClient((client) =>
      readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.dueDecisions).toBe(0);
  });

  it('reports rows stored as stale beside the computed ones, and counts non-active rows as neither', async () => {
    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);
    seedDecisions([
      { text: 'Stale one', sprintId: 'sprint-2', status: 'stale' },
      { text: 'Already archived', sprintId: 'sprint-2', status: 'archived' },
      { text: 'Already superseded', sprintId: 'sprint-2', status: 'superseded' },
      { text: 'Active one', sprintId: 'sprint-14' },
    ]);
    seedLearnings([{ content: 'Stale learning', sprintId: 'sprint-1', status: 'stale' }]);

    const result = await runWithClient((client) =>
      readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result.storedStaleDecisions).toBe(1);
    expect(result.storedStaleLearnings).toBe(1);
    expect(result.dueDecisions).toBe(0);
  });

  it('works when decisions/learnings tables do not exist', async () => {
    const db = new Database(dbPath);
    db.exec('DROP TABLE strategic_decisions');
    db.exec('DROP TABLE learnings');
    db.close();

    seedSprints(DEFAULT_STALENESS_THRESHOLD + 5);

    const result = await runWithClient((client) =>
      readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
    );

    expect(result).toMatchObject({
      dueDecisions: 0,
      dueLearnings: 0,
      storedStaleDecisions: 0,
      storedStaleLearnings: 0,
    });
  });

  it('uses configurable threshold', async () => {
    // Fixed seed (15 sprints) and explicit thresholds: the math is not keyed off the default.
    seedSprints(15);
    seedDecisions([{ text: 'Sprint 10 decision', sprintId: 'sprint-10' }]); // 5 sprints old

    // With threshold 3, sprint-10 is due (15 - 3 = 12, and 10 <= 12)
    const result3 = await runWithClient((client) => readStaleness(client, { threshold: 3 }));
    expect(result3.dueDecisions).toBe(1);

    // With threshold 10, sprint-10 is not due (15 - 10 = 5, and 10 > 5)
    const result10 = await runWithClient((client) => readStaleness(client, { threshold: 10 }));
    expect(result10.dueDecisions).toBe(0);
  });

  describe('repairFlaggerStaleness — restores only what a flagger could have written', () => {
    function seedStaleRows(): void {
      // 31 sprints, so a flagger-shaped row sits in sprint-N with N <= 31 - 10 = 21.
      seedSprints(31);
      const db = new Database(dbPath);
      db.exec(`ALTER TABLE learnings ADD COLUMN evergreen INTEGER NOT NULL DEFAULT 0`);
      db.exec(`ALTER TABLE learnings ADD COLUMN last_reviewed_at TEXT`);
      const decision = db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status, evidence, last_reviewed_at)
         VALUES (?, ?, '2026-01-01T00:00:00Z', ?, 'stale', ?, ?)`
      );
      decision.run(1, 'flagger-shaped', 'sprint-5', null, null);
      decision.run(2, 'has evidence', 'sprint-5', '[{"type":"doc","id":"x"}]', null);
      decision.run(3, 'reviewed on purpose', 'sprint-5', null, '2026-06-01T00:00:00.000Z');
      decision.run(4, 'too recent for any flagger', 'sprint-25', null, null);
      decision.run(5, 'non-canonical sprint', 'S8', null, null);
      decision.run(6, 'target of a supersession', 'sprint-5', null, null);
      db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status, superseded_by)
         VALUES (7, 'the newer one', '2026-01-01T00:00:00Z', 'sprint-30', 'active', 6)`
      ).run();
      db.prepare(
        `INSERT INTO sprints (id, title, status) VALUES ('S8', 'Legacy id', 'Completed')`
      ).run();
      const learning = db.prepare(
        `INSERT INTO learnings (id, content, created_at, sprint_id, status, evergreen)
         VALUES (?, ?, '2026-01-01T00:00:00Z', ?, 'stale', ?)`
      );
      learning.run(1, 'flagger-shaped learning', 'sprint-4', 0);
      learning.run(2, 'evergreen learning', 'sprint-4', 1);
      db.close();
    }

    function statusOf(table: string, id: number): string {
      const db = new Database(dbPath, { readonly: true });
      try {
        return (
          db.prepare(`SELECT status FROM ${table} WHERE id = ?`).get(id) as { status: string }
        ).status;
      } finally {
        db.close();
      }
    }

    it('restores the flagger-shaped rows, itemizes every row it leaves, and stamps no review', async () => {
      seedStaleRows();

      const receipt = await runWithClient((client) => repairFlaggerStaleness(client));

      expect(receipt.warnings).toEqual([]);
      expect(receipt.restoredDecisionIds).toEqual([1]);
      expect(receipt.restoredLearningIds).toEqual([1]);
      expect(receipt.left).toEqual([
        { table: 'decisions', id: 2, reason: 'has evidence' },
        { table: 'decisions', id: 3, reason: 'reviewed' },
        { table: 'decisions', id: 4, reason: 'sprint too recent for any flagger' },
        { table: 'decisions', id: 5, reason: 'not a canonical sprint' },
        { table: 'decisions', id: 6, reason: 'supersession target' },
        { table: 'learnings', id: 2, reason: 'evergreen' },
      ]);
      expect(statusOf('strategic_decisions', 1)).toBe('active');
      expect(statusOf('learnings', 1)).toBe('active');
      for (const id of [2, 3, 4, 5, 6]) expect(statusOf('strategic_decisions', id)).toBe('stale');
      expect(statusOf('learnings', 2)).toBe('stale');

      // A restored row keeps no review stamp, so its computed age stays honest.
      const db = new Database(dbPath, { readonly: true });
      const reviewed = db
        .prepare('SELECT last_reviewed_at FROM strategic_decisions WHERE id = 1')
        .get() as { last_reviewed_at: string | null };
      db.close();
      expect(reviewed.last_reviewed_at).toBeNull();

      const ledger = await runWithClient((client) => readStalenessRepairLedger(client));
      expect(ledger).toMatchObject({
        runs: 1,
        totalRestored: 2,
        reflaggedRestored: 0,
        restored: { decisions: [1], learnings: [1] },
        leftCount: 6,
      });
    });

    it('restores again after an older server re-flags, and says it was re-flagged', async () => {
      seedStaleRows();
      await runWithClient((client) => repairFlaggerStaleness(client));

      // An older server's opener writes 'stale' again on the restored rows.
      const db = new Database(dbPath);
      db.prepare("UPDATE strategic_decisions SET status = 'stale' WHERE id = 1").run();
      db.prepare("UPDATE learnings SET status = 'stale' WHERE id = 1").run();
      db.close();

      const seen = await runWithClient((client) => countReflaggedSinceRepair(client));
      expect(seen?.count).toBe(2);

      const second = await runWithClient((client) => repairFlaggerStaleness(client));
      expect(second.restoredDecisionIds).toEqual([1]);
      expect(second.reflagged).toBe(2);
      expect(statusOf('strategic_decisions', 1)).toBe('active');

      const ledger = await runWithClient((client) => readStalenessRepairLedger(client));
      expect(ledger).toMatchObject({ runs: 2, totalRestored: 4, reflaggedRestored: 2 });
      expect((await runWithClient((client) => countReflaggedSinceRepair(client)))?.count).toBe(0);
    });

    // Data-integrity critic N3: the ledger keeps every row any run restored, so a partial re-flag
    // followed by a full one is still counted in full.
    it('counts a re-flag of any row any run restored, across partial re-flags', async () => {
      seedStaleRows();
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (id, decision_text, created_at, sprint_id, status)
         VALUES (8, 'second flagger-shaped', '2026-01-01T00:00:00Z', 'sprint-6', 'stale')`
      ).run();
      db.close();
      await runWithClient((client) => repairFlaggerStaleness(client)); // restores 1, 8, learning 1

      const reflag = (ids: number[]): void => {
        const w = new Database(dbPath);
        w.prepare(
          `UPDATE strategic_decisions SET status = 'stale' WHERE id IN (${ids.join(',')})`
        ).run();
        w.close();
      };
      reflag([1]);
      expect((await runWithClient((client) => repairFlaggerStaleness(client))).reflagged).toBe(1);
      reflag([1, 8]); // both, including the one the second run did not touch
      expect((await runWithClient((client) => countReflaggedSinceRepair(client)))?.count).toBe(2);
      expect((await runWithClient((client) => repairFlaggerStaleness(client))).reflagged).toBe(2);
    });

    // Critic N2: a stale someone set on purpose (stamped) is not an older server's re-flag.
    it('does not report a deliberately stamped stale row as a re-flag', async () => {
      seedStaleRows();
      await runWithClient((client) => repairFlaggerStaleness(client));
      const db = new Database(dbPath);
      db.prepare(
        `UPDATE strategic_decisions SET status = 'stale', last_reviewed_at = ? WHERE id = 1`
      ).run(new Date().toISOString());
      db.close();
      expect((await runWithClient((client) => countReflaggedSinceRepair(client)))?.count).toBe(0);
    });

    // Critic N4: once nothing is stale, the ledger stops listing rows it left.
    it('brings the ledger current when the rows it left are no longer stale', async () => {
      seedStaleRows();
      await runWithClient((client) => repairFlaggerStaleness(client));
      const db = new Database(dbPath);
      db.prepare(`UPDATE strategic_decisions SET status = 'archived' WHERE status = 'stale'`).run();
      db.prepare(`UPDATE learnings SET status = 'archived' WHERE status = 'stale'`).run();
      db.close();

      await runWithClient((client) => repairFlaggerStaleness(client));
      const ledger = await runWithClient((client) => readStalenessRepairLedger(client));
      expect(ledger).toMatchObject({ left: [], leftCount: 0 });
      expect(ledger?.cannotSee).toMatch(/explicit 'stale'/);
    });

    // The contract critic: lastRunAt moves on a run that only updates the left-alone list, yet the
    // review printed it as the day rows were restored. lastRestoredAt moves only when rows were.
    it('keeps the day rows were restored apart from a run that only updated what it left', async () => {
      seedStaleRows();
      await runWithClient((client) => repairFlaggerStaleness(client, '2026-10-01T00:00:00.000Z'));
      const db = new Database(dbPath);
      db.prepare(`UPDATE strategic_decisions SET status = 'archived' WHERE id = 2`).run();
      db.close();
      await runWithClient((client) => repairFlaggerStaleness(client, '2026-10-05T00:00:00.000Z'));

      const ledger = await runWithClient((client) => readStalenessRepairLedger(client));
      expect(ledger).toMatchObject({
        lastRunAt: '2026-10-05T00:00:00.000Z',
        lastRestoredAt: '2026-10-01T00:00:00.000Z',
        leftCount: 5,
      });
      const db2 = new Database(dbPath);
      db2.prepare("UPDATE strategic_decisions SET status = 'stale' WHERE id = 1").run();
      db2.close();
      expect(await runWithClient((client) => countReflaggedSinceRepair(client))).toEqual({
        count: 1,
        lastRestoredAt: '2026-10-01T00:00:00.000Z',
      });
    });

    it('writes nothing on a store with no stale row', async () => {
      seedSprints(31);
      seedDecisions([{ text: 'Old but active', sprintId: 'sprint-2' }]);
      const before = statuses();

      const receipt = await runWithClient((client) => repairFlaggerStaleness(client));

      expect(receipt.ledgerWritten).toBe(false);
      expect(statuses()).toBe(before);
      expect(await runWithClient((client) => readStalenessRepairLedger(client))).toBeNull();
    });

    it('does not rewrite the ledger when nothing changed since the last run', async () => {
      seedStaleRows();
      await runWithClient((client) => repairFlaggerStaleness(client));

      const again = await runWithClient((client) => repairFlaggerStaleness(client));

      expect(again.restoredDecisionIds).toEqual([]);
      expect(again.ledgerWritten).toBe(false);
    });
  });

  // s97-m13 (#703): a review age is the number of sprints that closed after the row's sprint closed
  // (after the row was made, while its sprint is open or when it names none), by close time. Sprint
  // ids are labels: this store ran sprint-99 before sprint-96, and the label clock then read every
  // row three sprints older than the sprints that had actually closed.
  describe('the clock counts closes, not labels (s97-m13)', () => {
    const daysAgo = (days: number): string =>
      new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    function seedClosed(rows: Array<[id: string, status: string, endDate: string | null]>): void {
      const db = new Database(dbPath);
      const insert = db.prepare(
        'INSERT INTO sprints (id, title, status, end_date) VALUES (?, ?, ?, ?)'
      );
      for (const [id, status, endDate] of rows) insert.run(id, id, status, endDate);
      db.close();
    }

    function seedRows(
      table: 'strategic_decisions' | 'learnings',
      rows: Array<[text: string, sprintId: string | null, createdAt: string]>
    ): number[] {
      const db = new Database(dbPath);
      const insert =
        table === 'strategic_decisions'
          ? db.prepare(
              `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
               VALUES (?, ?, ?, 'active')`
            )
          : db.prepare(
              `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'active')`
            );
      const ids = rows.map(([text, sprintId, createdAt]) =>
        Number(insert.run(text, createdAt, sprintId).lastInsertRowid)
      );
      db.close();
      return ids;
    }

    /** sprint-1..sprint-22 closed ten days apart, then sprint-99, run out of label order; sprint-23 open. */
    function seedOutOfOrder(): void {
      seedClosed([
        ...Array.from({ length: 22 }, (_, i): [string, string, string] => [
          `sprint-${i + 1}`,
          'Completed',
          daysAgo(400 - (i + 1) * 10),
        ]),
        ['sprint-99', 'Completed', daysAgo(170)],
        ['sprint-23', 'Active', null],
      ]);
    }

    it('a sprint numbered out of order adds one close, not a jump of the clock', async () => {
      seedOutOfOrder();
      // sprint-3 closed 370 days ago: 19 closes of sprint-4..22 and sprint-99's after it, 20.
      // sprint-4 closed 360 days ago: 19 after it. The label clock read them 96 and 95 sprints old.
      const [third, fourth] = seedRows('strategic_decisions', [
        ['Made in sprint-3', 'sprint-3', daysAgo(375)],
        ['Made in sprint-4', 'sprint-4', daysAgo(365)],
      ]);
      seedRows('learnings', [
        ['Learned in sprint-3', 'sprint-3', daysAgo(375)],
        ['Learned in sprint-4', 'sprint-4', daysAgo(365)],
      ]);

      const read = await runWithClient((client) =>
        readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
      );
      const review = await runWithClient((client) =>
        reviewDecisionStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
      );

      expect({ decisions: read.dueDecisions, learnings: read.dueLearnings }).toEqual({
        decisions: 1,
        learnings: 1,
      });
      expect(
        [third, fourth].map((id) => review.decisions.find((d) => d.id === id)?.sprintAge)
      ).toEqual([20, 19]);
      expect(review.learnings.map((l) => [l.text, l.sprintAge])).toEqual([
        ['Learned in sprint-3', 20],
      ]);
    });

    it('a row whose sprint is open, or that names none, ages from when it was made', async () => {
      seedOutOfOrder();
      const [untaggedOld, untaggedNew, open] = seedRows('strategic_decisions', [
        ['Untagged, made before every close', null, daysAgo(500)],
        ['Untagged, made after every close', null, daysAgo(5)],
        ['Made in the open sprint', 'sprint-23', daysAgo(5)],
      ]);

      const read = await runWithClient((client) =>
        readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
      );
      const review = await runWithClient((client) =>
        reviewDecisionStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
      );

      // 23 closes after the old untagged row (a 14-day wall clock read it 35 sprints old).
      expect(read.dueDecisions).toBe(1);
      expect(review.decisions.find((d) => d.id === untaggedOld)?.sprintAge).toBe(23);
      expect(review.decisions.some((d) => d.id === untaggedNew || d.id === open)).toBe(false);
    });

    it('only recorded closes in the past count: never a planned sprint, an undated close or a future one', async () => {
      seedClosed([
        ['sprint-1', 'Completed', daysAgo(400)],
        // Planned dates already passed, closes with no recorded time, and one dated next week.
        ...Array.from({ length: 25 }, (_, i): [string, string, string] => [
          `sprint-${i + 2}`,
          'Planned',
          daysAgo(300 - i),
        ]),
        ...Array.from({ length: 25 }, (_, i): [string, string, null] => [
          `sprint-${i + 27}`,
          'Completed',
          null,
        ]),
        ['sprint-52', 'Completed', daysAgo(-7)],
        // A close in any letter case counts.
        ['sprint-53', 'completed', daysAgo(100)],
      ]);
      const [first] = seedRows('strategic_decisions', [
        ['Made in sprint-1', 'sprint-1', daysAgo(405)],
      ]);

      const read = await runWithClient((client) =>
        readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD })
      );
      const review = await runWithClient((client) =>
        reviewDecisionStaleness(client, { threshold: 2 })
      );

      expect(read.dueDecisions).toBe(0);
      expect(review.decisions.find((d) => d.id === first)?.sprintAge).toBe(1);
    });

    it('a store whose sprints carry no end_date column reads every age as 0, and no count fails', async () => {
      const db = new Database(dbPath);
      db.exec('ALTER TABLE sprints DROP COLUMN end_date');
      const insert = db.prepare('INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)');
      for (let n = 1; n <= 25; n += 1) insert.run(`sprint-${n}`, `Sprint ${n}`, 'Completed');
      db.close();
      seedRows('strategic_decisions', [['Made in sprint-2', 'sprint-2', daysAgo(400)]]);

      const read = await runWithClient((client) => readStaleness(client));
      const review = await runWithClient((client) => reviewDecisionStaleness(client));

      expect({ due: read.dueDecisions, warnings: read.warnings, listed: review.decisions }).toEqual(
        {
          due: 0,
          warnings: [],
          listed: [],
        }
      );
    });

    it('publishes the counting rule beside the counts', async () => {
      seedOutOfOrder();
      const read = await runWithClient((client) => readStaleness(client));
      expect(read.countingRule).toBe(STALENESS_COUNTING_RULE);
      // The rule names what it counts, from when, and what it never reads.
      for (const claim of [
        /recorded end_date/,
        /close of the row's own sprint/,
        /labels never count/,
      ])
        expect(STALENESS_COUNTING_RULE).toMatch(claim);
    });
  });
});

// s97-m13: the same clock on the schema a real store carries (seedRbookDb), not a hand-built one,
// so a wrong column or table in the clock's SQL fails here (the 6-path checklist's positive fire).
describe('the close-time clock on a real store (s97-m13)', () => {
  it('fires on a row twenty closes old and not on one nineteen closes old', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-staleness-real-'));
    try {
      const dbPath = seedRbookDb(root, { projectName: 'staleness-real' });
      const daysAgo = (days: number): string =>
        new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const db = new Database(dbPath);
      const sprint = db.prepare(
        'INSERT INTO sprints (id, title, status, end_date) VALUES (?, ?, ?, ?)'
      );
      for (let n = 1; n <= 21; n += 1)
        sprint.run(`sprint-${n}`, `Sprint ${n}`, 'Completed', daysAgo(300 - n * 10));
      // Run after sprint-21 under a higher label: the label clock read both rows below as due.
      sprint.run('sprint-99', 'Sprint 99', 'Completed', daysAgo(80));
      const decision = db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES (?, ?, ?, 'active')`
      );
      decision.run('Twenty closes after sprint-2', daysAgo(285), 'sprint-2');
      decision.run('Nineteen closes after sprint-3', daysAgo(275), 'sprint-3');
      db.close();
      RbookDetector.resetInstance();

      let read: ReturnType<typeof readStaleness> | undefined;
      await withClient(
        (client) => {
          read = readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD });
          return createSuccess(null);
        },
        { projectRoot: root }
      );

      expect({ due: read?.dueDecisions, warnings: read?.warnings }).toEqual({
        due: 1,
        warnings: [],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
