// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s87-m02 — the sprint close must NAME the rows it archived, prove its own count per
// ABOUTME: table, and be undoable. The store's most destructive write, made disclosable.

/**
 * Sprint 87 m02 — THE SPRINT-DEFINING MISSION'S GATE.
 *
 * THE DEFECT. `rbook_sprint(action="complete")` archives every active decision and learning
 * matching a three-branch disjunction — 900 of this store's 1015 decisions are in the state it
 * produces — and reports the write as `Archived: 37 decisions, 10 learnings`. Three separate
 * problems live in that sentence:
 *
 *   1. IT IS UNNAMED ON THE PUBLISHED DESCRIPTION. The router's `rbook_sprint` description lists
 *      what `complete` does and never mentions archival at all. An operator reads the tool's own
 *      contract and cannot learn that closing a sprint demotes rows.
 *   2. IT IS UNITEMISED. The counts come from the driver's `changes`. WHICH rows moved is not
 *      recorded anywhere, so a close that archived something it should not have leaves no way to
 *      find out what.
 *   3. IT IS IRREVERSIBLE. The closeout does take a DB snapshot — 134 lines and one `COMMIT`
 *      AFTER the archival. It captures the post-archival state and provides no pre-image.
 *
 * THE EMBLEM, and it is not a metaphor. sprint-86's close returned `Archived: 37 decisions`, and
 * one of the 37 was decision #1009 — the ratification of Arc F, the arc sprint-87 executes. The
 * close of the sprint that ratified this work archived the row that says what the work is. The
 * recovery worked only because an unrelated snapshot happened to land 108 seconds early.
 *
 * PRECONDITIONS ARE ESTABLISHED, NEVER INHERITED (next-step #547, BINDING ON THIS MISSION). Every
 * fact this file asserts about decision and learning rows — their status, their evergreen flag,
 * which sprint they bind to — is SET here on a store this file created. #547 exists because two
 * real-store fire tests went red in a single working day for inheriting exactly this kind of
 * property (82584cb, the `sprint_summary` view; 82429ec, the `agent_feedback` baseline, which
 * went red because the feature it asserted was unreachable started working). m02's subject is
 * the archived/active distribution, and sprint-87's OWN CLOSE will change it — so inheriting any
 * of it would make this gate a countdown to its own failure.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * MEASURED RED BASELINE — the six reds, observed on an unmodified tree before any `src/` edit.
 * Recorded in the mission close; see that record for the verbatim failures.
 *   (a) `lifecycle.archivedDecisionIds` does not exist. THIS RED IS AT TYPE LEVEL, not value
 *       level: `SprintLifecycleTriggers` carries counts only, so the property access does not
 *       compile. A red that is merely `undefined` would be satisfiable by assigning `[]`.
 *   (b) `archivedDecisionIds.length === decisionsArchived` is unstatable for the same reason,
 *       per table.
 *   (c) no pre-close snapshot exists — the only snapshot is taken after the COMMIT.
 *   (d) the ROUTER description contains no form of the word "archiv".
 *   (e) an `evergreen=1` learning bound to the sprint is archived by the close.
 *   (f) with the learnings UPDATE forced to error, the close reports `Archived: 0 decisions` for
 *       N decisions it archived AND COMMITTED.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHY THE SNAPSHOT IS OPENED BY WRITABLE OPEN AND NEVER `readonly: true` (contradiction C13). A
 * WAL-mode SQLite file with no `-shm` sidecar cannot be opened read-only by the CLI's
 * `-readonly`/`mode=ro`, which needs to CREATE that sidecar: it returns `SQLITE_CANTOPEN(14)`.
 * `better-sqlite3` opens it fine. Asserting the pre-image through a readonly open would fail for
 * a reason that has nothing to do with archival, so these tests open the snapshot writably and
 * read it. That is also why m02 takes NO dependency on m03's `#535` read-only-client fix.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  rbookSprintComplete,
  rbookSprintCompleteToolDefinition,
} from '../../../src/tools/rbook/rbook-sprint-complete';
import { rbookSprintToolDefinition } from '../../../src/tools/rbook/rbook-sprint';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';

const SPRINT = 'sprint-87t';
const PRIOR_SPRINT = 'sprint-86t';

let tempDir: string;
let dbPath: string;

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * A store with every table the archival path touches. Built here rather than copied, so that no
 * assertion below depends on a property of the live store that ordinary use of a shipped Reasonbook
 * tool could change (#547).
 */
function seedStore(): void {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s87m02-'));
  const dbDir = path.join(tempDir, 'rbook', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  dbPath = path.join(dbDir, 'rbook.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT,
      start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER
    );
    CREATE TABLE missions (
      id TEXT PRIMARY KEY, sprint_id TEXT REFERENCES sprints(id), name TEXT NOT NULL,
      status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT,
      success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT,
      metadata TEXT
    );
    CREATE TABLE contexts (
      id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT
    );
    CREATE TABLE context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL, session_id TEXT,
      source TEXT, content_hash TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL,
      sprint_id TEXT REFERENCES sprints(id), started_at TEXT NOT NULL, completed_at TEXT,
      agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT,
      captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT
    );
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, agent TEXT, mission TEXT, action TEXT,
      status TEXT, summary TEXT, next_hint TEXT, raw_event TEXT NOT NULL
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE next_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, sprint_id TEXT,
      session_id TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL,
      resolved_at TEXT, carried_to_sprint TEXT
    );
    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, decision_text TEXT NOT NULL, domain TEXT,
      sprint_id TEXT, mission_id TEXT, author_session_id TEXT, created_at TEXT NOT NULL,
      source TEXT, category TEXT, status TEXT NOT NULL DEFAULT 'active', superseded_by INTEGER
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT,
      status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, author_session_id TEXT,
      mission_id TEXT, created_at TEXT NOT NULL, evergreen INTEGER NOT NULL DEFAULT 0
    );

    INSERT INTO sprints (id, title, focus, status, start_date)
      VALUES ('${SPRINT}', 'Sprint 87 test', 'archival disclosure', 'Active', '2026-08-01');
    INSERT INTO sprints (id, title, focus, status, start_date, end_date)
      VALUES ('${PRIOR_SPRINT}', 'Sprint 86 test', 'prior', 'Completed', '2026-07-01', '2026-07-31');
    INSERT INTO metadata (key, value) VALUES ('project_name', 'Reasonbook s87-m02 fixture');
    INSERT INTO missions (id, sprint_id, name, status)
      VALUES ('m-1', '${SPRINT}', 'Mission 1', 'Completed');
    INSERT INTO sessions (id, type, title, sprint_id, started_at, status)
      VALUES ('S-1', 'build', 'closing session', '${SPRINT}', '2026-08-27T00:00:00Z', 'active');
    INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{}', '2026-08-01T00:00:00Z');
    INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES ('project_context', 'context/PROJECT_CONTEXT.json', '{}', '2026-08-01T00:00:00Z');
  `);
  db.close();
  RbookDetector.resetInstance();
}

interface Seeded {
  /** Bound to the sprint directly — the ordinary case. */
  plainDecision: number;
  /** Bound only through the closing SESSION — #518's branch, fenced by criterion 8. */
  sessionOnlyDecision: number;
  /** Carries the PRIOR sprint's id but was authored by this sprint's session — #518's other half. */
  priorSprintDecision: number;
  /** Already archived before the close: must not be touched or counted. */
  alreadyArchived: number;
  plainLearning: number;
  /** evergreen = 1, bound to the sprint: must SURVIVE the close as active. */
  evergreenLearning: number;
}

function seedRows(): Seeded {
  return withDb((db) => {
    const d = db.prepare(
      `INSERT INTO strategic_decisions (decision_text, sprint_id, mission_id, author_session_id, created_at, status)
       VALUES (?, ?, ?, ?, '2026-08-27T00:00:00Z', ?)`
    );
    const l = db.prepare(
      `INSERT INTO learnings (content, sprint_id, mission_id, author_session_id, created_at, status, evergreen)
       VALUES (?, ?, ?, ?, '2026-08-27T00:00:00Z', ?, ?)`
    );
    const plainDecision = Number(d.run('plain', SPRINT, null, null, 'active').lastInsertRowid);
    const sessionOnlyDecision = Number(
      d.run('session-only', null, null, 'S-1', 'active').lastInsertRowid
    );
    const priorSprintDecision = Number(
      d.run('prior-sprint id, this sprint session', PRIOR_SPRINT, null, 'S-1', 'active')
        .lastInsertRowid
    );
    const alreadyArchived = Number(
      d.run('already archived', SPRINT, null, null, 'archived').lastInsertRowid
    );
    const plainLearning = Number(
      l.run('plain learning', SPRINT, null, null, 'active', 0).lastInsertRowid
    );
    const evergreenLearning = Number(
      l.run('institutional rule', SPRINT, null, null, 'active', 1).lastInsertRowid
    );
    return {
      plainDecision,
      sessionOnlyDecision,
      priorSprintDecision,
      alreadyArchived,
      plainLearning,
      evergreenLearning,
    };
  });
}

function statusOfDecision(id: number, atPath = dbPath): string | undefined {
  const db = new Database(atPath);
  try {
    return (
      db.prepare('SELECT status FROM strategic_decisions WHERE id = ?').get(id) as
        | { status: string }
        | undefined
    )?.status;
  } finally {
    db.close();
  }
}

function statusOfLearning(id: number, atPath = dbPath): string | undefined {
  const db = new Database(atPath);
  try {
    return (
      db.prepare('SELECT status FROM learnings WHERE id = ?').get(id) as
        | { status: string }
        | undefined
    )?.status;
  } finally {
    db.close();
  }
}

/** `<root>/rbook/db/snapshots/<id>.sqlite`. Opened WRITABLY — never readonly (C13). */
function snapshotPath(snapshotId: string): string {
  return path.join(tempDir, 'rbook', 'db', 'snapshots', `${snapshotId}.sqlite`);
}

/**
 * s92-m05 (operator Q1, decision #1160): since 3.2.0 a close archives only when called with
 * `archive: true`. This file is the archival path's gate, so every close here opts in; the
 * default close is fenced in `sprint-close-keeps-record.test.ts`.
 */
async function closeSprint(): ReturnType<typeof rbookSprintComplete> {
  return rbookSprintComplete({
    sprintId: SPRINT,
    summary: 's87-m02 archival disclosure fixture',
    archive: true,
    projectRoot: tempDir,
  });
}

describe('s87-m02 — the close names the rows it archived', () => {
  beforeEach(() => {
    seedStore();
  });
  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('RED (a)+(b): archivedDecisionIds enumerates the archived rows, and its length IS the count', async () => {
    const seeded = seedRows();
    const result = await closeSprint();
    expect(result.success).toBe(true);
    const lifecycle = result.data!.lifecycle;

    // (a) The ids exist and name the rows that actually moved.
    expect(lifecycle.archivedDecisionIds).toContain(seeded.plainDecision);
    expect(lifecycle.archivedDecisionIds).toContain(seeded.sessionOnlyDecision);
    // A row already archived before the close was not re-archived and is not claimed.
    expect(lifecycle.archivedDecisionIds).not.toContain(seeded.alreadyArchived);

    // (b) THE THESIS AS AN EXECUTABLE INVARIANT, PER TABLE. The count the close reports and the
    // ids it names are the same fact; if they can disagree, one of them is not evidence.
    expect(lifecycle.archivedDecisionIds).toHaveLength(lifecycle.decisionsArchived);
    expect(lifecycle.learningIds).toHaveLength(lifecycle.learningsArchived);

    // Non-vacuity: a close that archived nothing would satisfy both lengths trivially.
    expect(lifecycle.decisionsArchived).toBeGreaterThan(0);
    expect(lifecycle.learningsArchived).toBeGreaterThan(0);

    // And the enumeration describes the store: every named id really is archived now.
    for (const id of lifecycle.archivedDecisionIds) {
      expect(statusOfDecision(id)).toBe('archived');
    }
  }, 60_000);

  it('RED (c): a PRE-close snapshot exists, and the archived rows read active inside it', async () => {
    const seeded = seedRows();
    const result = await closeSprint();
    expect(result.success).toBe(true);
    const lifecycle = result.data!.lifecycle;

    expect(lifecycle.preCloseSnapshotId).toEqual(expect.any(String));
    const snapPath = snapshotPath(lifecycle.preCloseSnapshotId!);
    expect(fs.existsSync(snapPath)).toBe(true);

    // The undo handle has to hold the PRE-image. Opened writably, per C13.
    expect(lifecycle.archivedDecisionIds.length).toBeGreaterThan(0);
    for (const id of lifecycle.archivedDecisionIds) {
      expect(statusOfDecision(id, snapPath)).toBe('active');
      expect(statusOfDecision(id)).toBe('archived');
    }

    // The post-close snapshot still exists and is a DIFFERENT file — the pre-close one is an
    // addition, not a relocation. Losing the post-close image would be a silent subtraction.
    expect(lifecycle.dbSnapshotId).toEqual(expect.any(String));
    expect(lifecycle.dbSnapshotId).not.toBe(lifecycle.preCloseSnapshotId);
  }, 60_000);

  it('RED (d): the ROUTER description says the close archives decisions and learnings', () => {
    // THE CLIENT-VISIBLE SURFACE. `rbook_sprint` is one of the 15 registered definitions and its
    // description is what regenerates into TOOL_REFERENCE.md and the definitions snapshot.
    expect(rbookSprintToolDefinition.description.toLowerCase()).toContain('archiv');

    // The unregistered per-operation definition is corrected for consistency, and it is NOT the
    // reason this criterion passes — no MCP host ever receives it.
    expect(rbookSprintCompleteToolDefinition.description.toLowerCase()).toContain('archiv');
  });

  it('RED (e): an evergreen learning bound to the sprint SURVIVES the close as active', async () => {
    const seeded = seedRows();
    // Precondition ESTABLISHED, not inherited, and re-read so the test cannot pass on a row that
    // was never written the way it claims.
    expect(
      withDb(
        (db) =>
          (
            db
              .prepare('SELECT evergreen FROM learnings WHERE id = ?')
              .get(seeded.evergreenLearning) as { evergreen: number }
          ).evergreen
      )
    ).toBe(1);

    const result = await closeSprint();
    expect(result.success).toBe(true);

    expect(statusOfLearning(seeded.evergreenLearning)).toBe('active');
    // …while its non-evergreen sibling in the same sprint did archive. Without this the test
    // would pass on a close that archived no learnings at all.
    expect(statusOfLearning(seeded.plainLearning)).toBe('archived');
    expect(result.data!.lifecycle.learningIds).not.toContain(seeded.evergreenLearning);
    expect(result.data!.lifecycle.learningIds).toContain(seeded.plainLearning);
  }, 60_000);

  it('RED (f): a failed learnings UPDATE does not erase the REAL decisions count', async () => {
    const seeded = seedRows();
    // Force the learnings UPDATE to error. NOT by dropping the table — `ensureLearningsTable`
    // correctly re-creates it, so a drop is healed before the arm runs and forces nothing. That
    // is the right behaviour and it is what criterion 6 exists for; it just makes a drop useless
    // as a fault injector. A BEFORE UPDATE trigger that ABORTs is a fault the ensure* path cannot
    // heal, and it aborts the STATEMENT rather than the transaction — which is precisely the
    // partial-failure shape this red is about: the decisions arm has already run, its work is
    // real, and the close goes on to COMMIT it.
    // Guarded on `NEW.status = 'archived'` so it fires on the ARCHIVAL update and nothing else:
    // an unguarded BEFORE UPDATE trigger also catches `ensureFirehoseEventColumns`'s pre-BEGIN
    // backfill, which throws a SchemaMigrationError and tears down the whole close before the
    // archival is ever reached — testing a different failure than the one this red is about.
    withDb((db) =>
      db.exec(
        `CREATE TRIGGER learnings_archive_fails BEFORE UPDATE ON learnings
         WHEN NEW.status = 'archived'
         BEGIN SELECT RAISE(ABORT, 'forced learnings failure'); END`
      )
    );

    const result = await closeSprint();
    expect(result.success).toBe(true);
    const lifecycle = result.data!.lifecycle;

    // THE POINT: the decisions the close archived are reported, not zeroed by the other table's
    // failure. Today this reports 0 while having archived and COMMITTED N.
    expect(lifecycle.decisionsArchived).toBeGreaterThan(0);
    expect(lifecycle.archivedDecisionIds).toContain(seeded.plainDecision);
    expect(statusOfDecision(seeded.plainDecision)).toBe('archived');

    // …and the learnings failure is NAMED rather than folded into the decisions number.
    const warnings = result.warnings ?? [];
    expect(warnings.join('\n')).toMatch(/learnings/i);
  }, 60_000);

  it('criterion 8 — REGRESSION FENCE: #518s three-branch disjunction is not simplified away', async () => {
    const seeded = seedRows();
    const result = await closeSprint();
    expect(result.success).toBe(true);
    const ids = result.data!.lifecycle.archivedDecisionIds;

    // A decision reachable ONLY through the session branch. Store-wide these number zero today,
    // which is exactly why a well-meaning simplification of the disjunction would look safe.
    expect(ids).toContain(seeded.sessionOnlyDecision);
    // A decision carrying the PRIOR sprint's id, authored by THIS sprint's session. #518 blessed
    // this branch deliberately; 4 decisions and 2 learnings in the live store exist only on it.
    expect(ids).toContain(seeded.priorSprintDecision);
  }, 60_000);

  it('criterion 6 — an UN-MIGRATED store (learnings without evergreen) still archives learnings', async () => {
    // THE TRAP, and it has fleet reach: `grep -n evergreen rbook-seed/db/schema.sql` returns
    // NOTHING, so every store created from the published tarball lacks the column until some
    // read path migrates it. A bare `AND evergreen = 0` on such a store throws
    // `no such column: evergreen`, the early return fires, and the close archives ZERO — which is
    // strictly worse than the defect being fixed.
    const seeded = seedRows();
    withDb((db) => {
      db.exec('DROP INDEX IF EXISTS idx_learnings_evergreen');
      db.exec('ALTER TABLE learnings DROP COLUMN evergreen');
    });
    expect(
      withDb((db) =>
        (db.prepare('PRAGMA table_info(learnings)').all() as Array<{ name: string }>).map(
          (r) => r.name
        )
      )
    ).not.toContain('evergreen');

    const result = await closeSprint();
    expect(result.success).toBe(true);
    expect(result.data!.lifecycle.learningsArchived).toBeGreaterThan(0);
    expect(statusOfLearning(seeded.plainLearning)).toBe('archived');
    expect((result.warnings ?? []).join('\n')).not.toMatch(/no such column/i);
  }, 60_000);

  /**
   * BUILD-TIME ADVERSARIAL CRITIC FINDING 1 (standing gate #3), fixed and fenced here.
   *
   * Snapshot retention is count-capped and prunes oldest-first, and this close now takes TWO
   * snapshots. At a low cap the POST-close snapshot prunes the PRE-close one — the close silently
   * destroying the undo handle that is the entire point of the mission. Reachable by
   * configuration (`RBOOK_MAX_SNAPSHOTS`), not hypothetical.
   *
   * The chosen answer is DISCLOSURE, not an override: raising the operator's own cap behind their
   * back would be the tool deciding it knows better than a setting they chose.
   */
  it('critic finding — when retention prunes the pre-close snapshot, the close SAYS the undo handle is gone', async () => {
    seedRows();
    const previous = process.env.RBOOK_MAX_SNAPSHOTS;
    process.env.RBOOK_MAX_SNAPSHOTS = '1';
    try {
      const result = await closeSprint();
      expect(result.success).toBe(true);
      const lifecycle = result.data!.lifecycle;

      // The pre-close snapshot WAS created…
      expect(lifecycle.preCloseSnapshotId).toEqual(expect.any(String));
      // …and at a cap of 1 the post-close snapshot removed it. Non-vacuity: if the file survived,
      // this scenario did not happen and the assertion below would be testing nothing.
      expect(fs.existsSync(snapshotPath(lifecycle.preCloseSnapshotId!))).toBe(false);

      const warningText = (result.warnings ?? []).join('\n');
      expect(warningText).toContain(lifecycle.preCloseSnapshotId!);
      expect(warningText).toMatch(/no longer reversible/i);
      expect(warningText).toContain('RBOOK_MAX_SNAPSHOTS');

      // The archived ids remain, so the operator still knows WHICH rows moved even with no
      // pre-image to restore from. That is the whole reason both halves shipped.
      expect(lifecycle.archivedDecisionIds.length).toBeGreaterThan(0);
    } finally {
      if (previous === undefined) delete process.env.RBOOK_MAX_SNAPSHOTS;
      else process.env.RBOOK_MAX_SNAPSHOTS = previous;
    }
  }, 60_000);

  /**
   * BUILD-TIME ADVERSARIAL CRITIC FINDING 2 (standing gate #3), fixed and fenced here.
   *
   * The sprint's existence is validated INSIDE the closeout transaction, which is AFTER the
   * pre-close snapshot. Without a gate, closing a typo'd sprint id copied the entire store and
   * consumed a retention slot — pruning the operator's oldest real snapshot — before returning
   * SPRINT_NOT_FOUND. A call that fails should not destroy a backup.
   */
  it('critic finding — a close of a NONEXISTENT sprint takes no snapshot and prunes nothing', async () => {
    seedRows();
    const snapDir = path.join(tempDir, 'rbook', 'db', 'snapshots');
    const before = fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : [];

    const result = await rbookSprintComplete({
      sprintId: 'sprint-does-not-exist',
      summary: 'typo',
      projectRoot: tempDir,
    });

    // The refusal is unchanged — the gate skips wasted work, it does not change the answer.
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SPRINT_NOT_FOUND');

    const after = fs.existsSync(snapDir) ? fs.readdirSync(snapDir) : [];
    expect(after).toEqual(before);
  }, 60_000);

  /**
   * s109-m04 (#916). The nonexistent-sprint gate above did not reach the refusals the store's state
   * predicts: an open mission, a sprint already Completed, a missing or unreadable context. Each one
   * copied the whole store before refusing, and at the retention cap pruned the operator's oldest
   * backup. The close now runs its own checks before BEGIN and snapshots only when all of them pass.
   */
  describe('#916: a refusal the state predicts takes no snapshot and prunes nothing', () => {
    const snapDir = (): string => path.join(tempDir, 'rbook', 'db', 'snapshots');
    const listing = (): string[] =>
      fs.existsSync(snapDir()) ? fs.readdirSync(snapDir()).sort() : [];
    const addQueuedMission = (): void => {
      withDb((db) =>
        db
          .prepare(
            `INSERT INTO missions (id, sprint_id, name, status) VALUES ('m-2', ?, 'Mission 2', 'Queued')`
          )
          .run(SPRINT)
      );
    };

    it('an open mission: SPRINT_NOT_READY, and the snapshot folder is unchanged', async () => {
      seedRows();
      addQueuedMission();
      const before = listing();
      const result = await closeSprint();
      expect(result.error?.code).toBe('SPRINT_NOT_READY');
      expect(listing()).toEqual(before);
    }, 60_000);

    it('a second close of a Completed sprint: SPRINT_ALREADY_COMPLETED, and the folder is unchanged', async () => {
      seedRows();
      expect((await closeSprint()).success).toBe(true);
      const before = listing();
      // Non-vacuity: the first close took its two snapshots, so the folder exists and holds them.
      expect(before.length).toBeGreaterThanOrEqual(2);
      const again = await closeSprint();
      expect(again.error?.code).toBe('SPRINT_ALREADY_COMPLETED');
      expect(listing()).toEqual(before);
    }, 60_000);

    it('a missing project_context, then an unreadable master_context: refused, and the folder is unchanged', async () => {
      seedRows();
      withDb((db) => db.prepare(`DELETE FROM contexts WHERE id = 'project_context'`).run());
      const before = listing();
      const missing = await closeSprint();
      expect(missing.error?.code).toBe('CONTEXT_NOT_FOUND');
      expect(listing()).toEqual(before);

      withDb((db) => {
        db.prepare(
          `INSERT INTO contexts (id, source_path, content, updated_at)
           VALUES ('project_context', 'context/PROJECT_CONTEXT.json', '{}', '2026-08-01T00:00:00Z')`
        ).run();
        db.prepare(`UPDATE contexts SET content = 'not json' WHERE id = 'master_context'`).run();
      });
      const unreadable = await closeSprint();
      expect(unreadable.error?.code).toBe('CONTEXT_PARSE_ERROR');
      expect(listing()).toEqual(before);
    }, 60_000);

    it('at the retention cap, a refused close deletes nothing', async () => {
      seedRows();
      const { rbookDbSnapshot } = await import('../../../src/tools/rbook/rbook-db-snapshot');
      for (let i = 0; i < 3; i += 1) {
        expect((await rbookDbSnapshot({ projectRoot: tempDir })).success).toBe(true);
      }
      const before = listing();
      expect(before.filter((name) => name.endsWith('.sqlite'))).toHaveLength(3);
      addQueuedMission();
      const previous = process.env.RBOOK_MAX_SNAPSHOTS;
      process.env.RBOOK_MAX_SNAPSHOTS = '3';
      try {
        const result = await closeSprint();
        expect(result.error?.code).toBe('SPRINT_NOT_READY');
        // Before #916 this close added a snapshot and pruned the oldest of the three.
        expect(listing()).toEqual(before);
      } finally {
        if (previous === undefined) delete process.env.RBOOK_MAX_SNAPSHOTS;
        else process.env.RBOOK_MAX_SNAPSHOTS = previous;
      }
    }, 60_000);

    // Critic A, F4: only the store's state predicts a refusal. A read the pre-check cannot make
    // predicts nothing, so the close snapshots as before and the transaction gives any refusal.
    it.each([
      ['the sprint', 'getOne', 'SELECT status FROM sprints WHERE id = ?'],
      [
        'the missions',
        'getMany',
        'SELECT id, status, notes FROM missions WHERE sprint_id = ? ORDER BY id ASC',
      ],
      [
        'a context',
        'getOne',
        'SELECT id, source_path, content, updated_at FROM contexts WHERE id = ?',
      ],
    ] as const)(
      'a read of %s the pre-check cannot make predicts nothing: the snapshot is taken and the close goes ahead',
      async (_what, method, sql) => {
        seedRows();
        const { RbookDatabaseClient } = await import('../../../src/tools/rbook/client');
        const original = RbookDatabaseClient.prototype[method] as (...args: unknown[]) => unknown;
        let failed = 0;
        // The pre-check's read is that statement's first: the transaction's own read follows it.
        const spy = jest.spyOn(RbookDatabaseClient.prototype, method).mockImplementation(function (
          this: unknown,
          ...args: unknown[]
        ) {
          if (failed === 0 && args[0] === sql) {
            failed += 1;
            return { success: false, error: { code: 'DB_QUERY_FAILED', message: 'injected' } };
          }
          return original.apply(this, args);
        } as never);
        try {
          const result = await closeSprint();
          expect(failed).toBe(1);
          expect(result.success).toBe(true);
          expect(result.data!.lifecycle.preCloseSnapshotId).toEqual(expect.any(String));
          expect((result.warnings ?? []).join('\n')).not.toContain('snapshot skipped');
        } finally {
          spy.mockRestore();
        }
      },
      60_000
    );

    it('a close predicted to refuse that a race lets go ahead says its snapshot was skipped, not failed', async () => {
      seedRows();
      addQueuedMission();
      const spinOut = await import('../../../src/tools/rbook/spin-out-read');
      const original = spinOut.prepareSpinOutRead;
      // Another process completes m-2 after the pre-check and before BEGIN: the window this opens.
      const spy = jest.spyOn(spinOut, 'prepareSpinOutRead').mockImplementation((reader) => {
        withDb((db) =>
          db.prepare(`UPDATE missions SET status = 'Completed' WHERE id = 'm-2'`).run()
        );
        return original(reader);
      });
      try {
        const result = await closeSprint();
        // The in-transaction checks stay authoritative: the close goes ahead.
        expect(result.success).toBe(true);
        expect(result.data!.lifecycle.preCloseSnapshotId).toBeNull();
        const text = (result.warnings ?? []).join('\n');
        expect(text).toContain('Pre-close database snapshot skipped');
        // One open mission reads in the singular (round 2, verifier A, N4).
        expect(text).toContain('its mission m-2 was still open');
        expect(text).toContain('NOT reversible from a snapshot');
        expect(text).not.toContain('snapshot failed');
      } finally {
        spy.mockRestore();
      }
    }, 60_000);
  });

  it('criterion 10 — the rendered close line names ids, and any truncation is EXPLICIT', async () => {
    // Seed past the truncation threshold so the branch is exercised rather than assumed.
    withDb((db) => {
      const d = db.prepare(
        `INSERT INTO strategic_decisions (decision_text, sprint_id, created_at, status)
         VALUES (?, ?, '2026-08-27T00:00:00Z', 'active')`
      );
      for (let i = 0; i < 40; i += 1) d.run(`bulk ${i}`, SPRINT);
    });

    const result = await closeSprint();
    expect(result.success).toBe(true);
    const { formatSprintCompleteForLLM } =
      await import('../../../src/tools/rbook/rbook-sprint-complete');
    const rendered = formatSprintCompleteForLLM(result);

    expect(result.data!.lifecycle.decisionsArchived).toBeGreaterThan(30);
    // Ids are named, not merely counted.
    expect(rendered).toMatch(/Archived: \d+ decisions/);
    expect(rendered).toMatch(/#\d+/);
    // …and the truncation says so. A silently truncated id list is this sprint's own defect class.
    expect(rendered).toMatch(/\+\d+ more/);
  }, 60_000);
});
