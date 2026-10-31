/**
 * rbook_sprint_complete Tool Tests
 *
 * Regression coverage for the sprint closeout automation flow.
 *
 * @module tests/tools/rbook/rbook-sprint-complete
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookSprintComplete,
  rbookSprintCompleteToolDefinition,
  formatSprintCompleteForLLM,
} from '../../../src/tools/rbook/rbook-sprint-complete';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import * as buildFreshnessModule from '../../../src/tools/rbook/build-freshness';
import * as serverHealth from '../../../src/server-health';
import type { BuildManifest } from '../../../src/server-health';
import {
  LEASE_COUNTING_RULE,
  LEASE_IDLE_WARN_DAYS,
  LEASE_LAPSE_AT,
  LEASE_MIN_AGE_DAYS,
  LEASE_WARN_AT,
} from '../../../src/tools/rbook/next-step-lease';

describe('rbook_sprint_complete', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-sprint-complete-test-'));
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

      CREATE TABLE context_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL,
        session_id TEXT,
        source TEXT,
        content_hash TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
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

      CREATE TABLE session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT,
        agent TEXT,
        mission TEXT,
        action TEXT,
        status TEXT,
        summary TEXT,
        next_hint TEXT,
        raw_event TEXT NOT NULL
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    db.prepare(
      `INSERT INTO sprints (id, title, focus, status, start_date)
       VALUES ('sprint-22', 'Sprint 22', 'Production hardening', 'Active', '2026-03-01')`
    ).run();

    db.prepare(
      `INSERT INTO metadata (key, value) VALUES ('project_name', 'Reasonbook MCP Test')`
    ).run();

    db.close();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function getProjectRoot(): string {
    return tempDir;
  }

  function seedMissions(
    missions: Array<{ id: string; status: string; notes?: string | null }>
  ): void {
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, notes)
       VALUES (?, 'sprint-22', ?, ?, ?)`
    );

    for (const mission of missions) {
      insert.run(mission.id, `Mission ${mission.id}`, mission.status, mission.notes ?? null);
    }

    db.close();
  }

  function seedContexts(
    masterContent: Record<string, unknown>,
    projectContent: Record<string, unknown>
  ): void {
    const db = new Database(dbPath);
    const insert = db.prepare(
      `INSERT INTO contexts (id, source_path, content, updated_at)
       VALUES (?, ?, ?, '2026-03-06T00:00:00Z')`
    );

    insert.run('master_context', 'context/MASTER_CONTEXT.json', JSON.stringify(masterContent));
    insert.run('project_context', 'context/PROJECT_CONTEXT.json', JSON.stringify(projectContent));
    db.close();
  }

  function readContext(contextId: 'master_context' | 'project_context'): Record<string, unknown> {
    const db = new Database(dbPath);
    const row = db.prepare('SELECT content FROM contexts WHERE id = ?').get(contextId) as {
      content: string;
    };
    db.close();
    return JSON.parse(row.content);
  }

  describe('happy path', () => {
    it('completes the sprint, snapshots contexts, and preserves next-step prose', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Completed' },
      ]);
      seedContexts(
        {
          next_session_context: {
            when_we_resume: ['session-1: Wrap s22-m01 follow-up', 'Prepare sprint retro notes'],
          },
        },
        {
          working_memory: {
            next_steps: ['session-1: Finish s22-m02 docs', 'Keep lint clean'],
          },
          next_session_context: {
            when_we_resume: ['Close sprint-22 checklist', 'Investigate future telemetry work'],
          },
          next_steps: ['Archive sprint-22 notes', 'Draft sprint-23 kickoff'],
        }
      );

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Production hardening shipped',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
      expect(result.data?.contexts.masterContext.snapshotId).not.toBeNull();
      expect(result.data?.contexts.projectContext.snapshotId).not.toBeNull();
      expect(result.data?.contexts.masterContext.nextStepsCleared).toBe(0);
      expect(result.data?.contexts.projectContext.nextStepsCleared).toBe(0);

      const db = new Database(dbPath);
      const sprint = db
        .prepare('SELECT status, end_date FROM sprints WHERE id = ?')
        .get('sprint-22') as { status: string; end_date: string | null };
      const snapshotCount = db.prepare('SELECT COUNT(*) AS count FROM context_snapshots').get() as {
        count: number;
      };
      const eventCount = db
        .prepare("SELECT COUNT(*) AS count FROM session_events WHERE action = 'sprint_complete'")
        .get() as { count: number };
      db.close();

      expect(sprint.status).toBe('Completed');
      expect(sprint.end_date).toBeTruthy();
      expect(snapshotCount.count).toBe(2);
      expect(eventCount.count).toBe(1);

      expect(readContext('master_context')).toEqual({
        next_session_context: {
          when_we_resume: ['session-1: Wrap s22-m01 follow-up', 'Prepare sprint retro notes'],
        },
        // s91-m07: the close keeps sprint_tracking in step; nothing is open after sprint-22.
        sprint_tracking: { current_sprint: null, last_completed_sprint: 'sprint-22' },
      });
      expect(readContext('project_context')).toEqual({
        working_memory: {
          next_steps: ['session-1: Finish s22-m02 docs', 'Keep lint clean'],
        },
        next_session_context: {
          when_we_resume: ['Close sprint-22 checklist', 'Investigate future telemetry work'],
        },
        next_steps: ['Archive sprint-22 notes', 'Draft sprint-23 kickoff'],
      });
    });

    it('trims only oldest overflow, keeping newest 15 master and newest 10 project entries', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      const masterSteps = Array.from(
        { length: 17 },
        (_, index) => `master-${index}: sprint-22 s22-m01 follow-up`
      );
      const projectSteps = Array.from(
        { length: 12 },
        (_, index) => `project-${index}: sprint-22 s22-m01 follow-up`
      );
      seedContexts(
        { next_session_context: { when_we_resume: masterSteps } },
        { working_memory: { next_steps: projectSteps } }
      );

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Count-only retention',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.contexts.masterContext.nextStepsCleared).toBe(2);
      expect(result.data?.contexts.projectContext.nextStepsCleared).toBe(2);
      expect(
        (readContext('master_context').next_session_context as Record<string, unknown>)
          .when_we_resume
      ).toEqual(masterSteps.slice(-15));
      expect(
        (readContext('project_context').working_memory as Record<string, unknown>).next_steps
      ).toEqual(projectSteps.slice(-10));
    });
  });

  describe('readiness validation', () => {
    it('returns warnings when blocked missions remain', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Blocked', notes: 'Waiting on upstream API' },
        { id: 's22-m03', status: 'Completed', notes: '[Skipped] No longer needed' },
      ]);
      seedContexts(
        { next_session_context: { when_we_resume: ['Revisit s22-m02 blocker'] } },
        { working_memory: { next_steps: ['Carry s22-m02 into sprint-23'] } }
      );

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Closed with blocker carryover',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.readiness.blockedMissionIds).toEqual(['s22-m02']);
      expect(result.data?.readiness.skippedMissionIds).toEqual(['s22-m03']);
      expect(result.warnings).toContain(
        "Sprint 'sprint-22' closed with blocked missions: s22-m02."
      );
      expect(result.warnings).toContain(
        "Sprint 'sprint-22' includes skipped missions recorded in notes: s22-m03."
      );

      const context = readContext('project_context');
      expect(context).toEqual({
        working_memory: { next_steps: ['Carry s22-m02 into sprint-23'] },
      });
    });

    it('does not treat generic skip wording in notes as a skipped mission marker', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        {
          id: 's22-m02',
          status: 'Completed',
          notes: 'Implemented closeout flow and tests cover blocked/skipped readiness warnings.',
        },
      ]);
      seedContexts({}, {});

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Closed without skipped work',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.readiness.skippedMissionIds).toEqual([]);
      expect(result.warnings ?? []).not.toContain(
        "Sprint 'sprint-22' includes skipped missions recorded in notes: s22-m02."
      );
    });

    it('succeeds when only Dropped missions remain (Dropped is terminal)', async () => {
      // Regression test: sprint close was blocking on Dropped missions, forcing agents to
      // corrupt the audit trail by marking them Completed just to satisfy the gate.
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Dropped' },
      ]);
      seedContexts({}, {});

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Closed with a dropped mission',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
    });

    it('succeeds when only Deferred missions remain (Deferred is terminal for close)', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Deferred' },
      ]);
      seedContexts({}, {});

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Closed with a deferred mission',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
    });

    it('fails when queued or active missions remain', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Queued' },
      ]);
      seedContexts({}, {});

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Should not close',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.SPRINT_NOT_READY);

      const db = new Database(dbPath);
      const sprint = db.prepare('SELECT status FROM sprints WHERE id = ?').get('sprint-22') as {
        status: string;
      };
      db.close();

      expect(sprint.status).toBe('Active');
    });

    it('fails when the sprint is already completed', async () => {
      const db = new Database(dbPath);
      db.prepare("UPDATE sprints SET status = 'Completed' WHERE id = 'sprint-22'").run();
      db.close();

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Already closed',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.SPRINT_ALREADY_COMPLETED);
    });
  });

  describe('condensation integration', () => {
    it('runs optional condensation and reports post-closeout sizes', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts(
        {
          recent_sessions: [
            {
              id: 'session-1',
              summary: 'A'.repeat(320),
            },
          ],
          next_session_context: {
            when_we_resume: ['Complete s22-m01 wrap-up'],
          },
        },
        {
          working_memory: {
            next_steps: ['Complete s22-m01 wrap-up'],
            recent_sessions: [
              {
                id: 'session-2',
                summary: 'B'.repeat(320),
              },
            ],
          },
        }
      );

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Closed with condensation',
        condensation: 'conservative',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.contexts.masterContext.condensation?.strategy).toBe('conservative');
      expect(result.data?.contexts.projectContext.condensation?.strategy).toBe('conservative');
      // s91-m07: the close adds the sprint_tracking pointer to master_context, so "condensation
      // never grows the context" allows exactly the pointer's own bytes and nothing more.
      const pointerKb =
        JSON.stringify({
          sprint_tracking: { current_sprint: null, last_completed_sprint: 'sprint-22' },
        }).length / 1024;
      expect(result.data?.contexts.masterContext.afterSize.sizeKb).toBeLessThanOrEqual(
        result.data!.contexts.masterContext.beforeSize.sizeKb + pointerKb + 0.01
      );
      expect(result.data?.contexts.projectContext.afterSize.sizeKb).toBeLessThanOrEqual(
        result.data!.contexts.projectContext.beforeSize.sizeKb
      );
      expect(
        (readContext('master_context').next_session_context as Record<string, unknown>)
          .when_we_resume
      ).toEqual(['Complete s22-m01 wrap-up']);
      expect(
        (readContext('project_context').working_memory as Record<string, unknown>).next_steps
      ).toEqual(['Complete s22-m01 wrap-up']);
    });
  });

  describe('error and warning handling', () => {
    it('returns a parse error when a closeout context is invalid JSON', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);

      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO contexts (id, source_path, content, updated_at)
         VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{}', '2026-03-06T00:00:00Z')`
      ).run();
      db.prepare(
        `INSERT INTO contexts (id, source_path, content, updated_at)
         VALUES ('project_context', 'context/PROJECT_CONTEXT.json', ?, '2026-03-06T00:00:00Z')`
      ).run('{not-json');
      db.close();

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Invalid project context',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.CONTEXT_PARSE_ERROR);
    });

    it('warns when sprint closeout event logging fails after commit', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const db = new Database(dbPath);
      db.exec('DROP TABLE session_events');
      db.close();

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Event logging warning',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      // s86-m02b: the message now carries the DB error code and text verbatim — it used to
      // say only that logging failed, which told an operator nothing about why. Matched on
      // the stable prefix so the assertion pins the DISCLOSURE, not one DB's wording.
      expect(
        result.warnings?.some((w) => w.startsWith('Sprint closeout event logging failed'))
      ).toBe(true);
    });
  });

  describe('lifecycle triggers', () => {
    function seedDecisionsAndLearningsTables(): void {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS strategic_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          context_id TEXT NOT NULL DEFAULT 'master_context',
          decision_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
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
        CREATE TABLE IF NOT EXISTS learnings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          sprint_id TEXT,
          session_id TEXT,
          mission_id TEXT,
          created_at TEXT NOT NULL
        );
      `);
      db.close();
    }

    function addMissionTimestamps(): void {
      const db = new Database(dbPath);
      // Add started_at and updated_at columns if not present
      try {
        db.exec('ALTER TABLE missions ADD COLUMN started_at TEXT');
      } catch {
        /* already exists */
      }
      try {
        db.exec('ALTER TABLE missions ADD COLUMN updated_at TEXT');
      } catch {
        /* already exists */
      }
      db.close();
    }

    /** Two sprint-22 decisions and learnings (direct and via mission), plus rows that never move. */
    function seedArchivalScenario(): void {
      seedDecisionsAndLearningsTables();
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Completed' },
      ]);
      seedContexts({}, {});

      const db = new Database(dbPath);
      // Decisions linked directly and via mission
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Use WAL mode for concurrency', '2026-03-01T00:00:00Z', 'sprint-22', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, mission_id, status)
         VALUES ('FTS5 for search', '2026-03-02T00:00:00Z', 's22-m01', 'active')`
      ).run();
      // Decision already superseded — should NOT be changed
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Old approach', '2026-03-01T00:00:00Z', 'sprint-22', 'superseded')`
      ).run();
      // Decision from a different sprint — should NOT be archived
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Sprint 23 decision', '2026-03-05T00:00:00Z', 'sprint-23', 'active')`
      ).run();
      // Learnings
      db.prepare(
        `INSERT INTO learnings (content, category, status, sprint_id, created_at)
         VALUES ('SQLite COALESCE pattern', 'technical', 'active', 'sprint-22', '2026-03-01T00:00:00Z')`
      ).run();
      db.prepare(
        `INSERT INTO learnings (content, category, status, mission_id, created_at)
         VALUES ('Session capture flow', 'process', 'active', 's22-m02', '2026-03-02T00:00:00Z')`
      ).run();
      db.close();
    }

    function countWhere(sql: string): number {
      const db = new Database(dbPath);
      try {
        return (db.prepare(sql).get() as { count: number }).count;
      } finally {
        db.close();
      }
    }

    it('leaves sprint-scoped decisions and learnings active by default (s92-m05, decision #1160)', async () => {
      seedArchivalScenario();

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Default close keeps the record',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      const lifecycle = result.data!.lifecycle;
      expect(lifecycle.archived).toBe(false);
      expect(lifecycle.decisionsArchived).toBe(0);
      expect(lifecycle.learningsArchived).toBe(0);
      // The arrays stay present, so the agents.md receipt audit (Array.isArray on both) holds.
      expect(lifecycle.archivedDecisionIds).toEqual([]);
      expect(lifecycle.learningIds).toEqual([]);
      // The close still writes (end date, lease), so it still takes its undo handle.
      expect(lifecycle.preCloseSnapshotId).toEqual(expect.any(String));

      expect(
        countWhere("SELECT COUNT(*) AS count FROM strategic_decisions WHERE status = 'active'")
      ).toBe(3);
      expect(
        countWhere("SELECT COUNT(*) AS count FROM strategic_decisions WHERE status = 'archived'")
      ).toBe(0);
      expect(countWhere("SELECT COUNT(*) AS count FROM learnings WHERE status = 'active'")).toBe(2);

      const formatted = formatSprintCompleteForLLM(result);
      expect(formatted).toContain(
        "Archived: nothing — this sprint's decisions and learnings stay active"
      );
      expect(formatted).not.toMatch(/Archived: \d+ decisions/);
    });

    it('archives sprint-scoped decisions and learnings when archive: true', async () => {
      seedArchivalScenario();

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Lifecycle triggers test',
        archive: true,
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.lifecycle.archived).toBe(true);
      expect(result.data?.lifecycle.decisionsArchived).toBe(2);
      expect(result.data?.lifecycle.learningsArchived).toBe(2);

      // Verify DB state
      const db2 = new Database(dbPath);
      const activeDecisions = db2
        .prepare("SELECT COUNT(*) AS count FROM strategic_decisions WHERE status = 'active'")
        .get() as { count: number };
      const archivedDecisions = db2
        .prepare("SELECT COUNT(*) AS count FROM strategic_decisions WHERE status = 'archived'")
        .get() as { count: number };
      const supersededDecisions = db2
        .prepare("SELECT COUNT(*) AS count FROM strategic_decisions WHERE status = 'superseded'")
        .get() as { count: number };
      const activeLearnings = db2
        .prepare("SELECT COUNT(*) AS count FROM learnings WHERE status = 'active'")
        .get() as { count: number };
      db2.close();

      expect(activeDecisions.count).toBe(1); // sprint-23 decision only
      expect(archivedDecisions.count).toBe(2); // the two sprint-22 active ones
      expect(supersededDecisions.count).toBe(1); // unchanged
      expect(activeLearnings.count).toBe(0); // both archived
    });

    it('computes sprint summary KPIs', async () => {
      addMissionTimestamps();
      seedDecisionsAndLearningsTables();

      const db = new Database(dbPath);
      // Insert missions with timestamps for cycle time calculation
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, started_at, completed_at)
         VALUES ('s22-m01', 'sprint-22', 'Mission 1', 'Completed',
                 '2026-03-01T00:00:00Z', '2026-03-03T00:00:00Z')`
      ).run();
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, started_at, completed_at)
         VALUES ('s22-m02', 'sprint-22', 'Mission 2', 'Completed',
                 '2026-03-02T00:00:00Z', '2026-03-04T00:00:00Z')`
      ).run();
      db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, notes)
         VALUES ('s22-m03', 'sprint-22', 'Mission 3', 'Blocked', 'Waiting on API')`
      ).run();
      // Add decisions
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Decision 1', '2026-03-01T00:00:00Z', 'sprint-22', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Decision 2', '2026-03-02T00:00:00Z', 'sprint-22', 'active')`
      ).run();
      db.close();
      seedContexts({}, {});

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'KPI test',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      const kpis = result.data?.lifecycle.kpis;
      expect(kpis).toBeDefined();
      // 2 completed out of 3 total
      expect(kpis?.completionRate).toBeCloseTo(2 / 3, 1);
      // Each mission took 2 days
      expect(kpis?.avgCycleTimeDays).toBeCloseTo(2, 1);
      // 2 decisions linked to sprint
      expect(kpis?.decisionCount).toBe(2);
      expect(kpis?.blockedCount).toBe(1);
    });

    it('clears project_context working_memory session arrays on completion', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts(
        {},
        {
          working_memory: {
            session_history: [{ id: 'session-1', summary: 'Old session' }],
            recent_sessions: [{ id: 'session-2', summary: 'Recent' }],
            next_steps: ['Keep lint clean'],
          },
          current_sprint: 'sprint-22',
          active_mission: 's22-m01',
        }
      );

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Working memory test',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);

      const context = readContext('project_context');
      const wm = context.working_memory as Record<string, unknown>;
      // Ephemeral arrays cleared
      expect(wm.session_history).toEqual([]);
      expect(wm.recent_sessions).toEqual([]);
      // next_steps preserved (closeout retention is length-only)
      expect(wm.next_steps).toEqual(['Keep lint clean']);
      // Sprint/mission references cleared
      expect(context.current_sprint).toBeNull();
      expect(context.active_mission).toBeNull();
    });

    it('creates a DB snapshot after sprint completion', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'DB snapshot test',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.lifecycle.dbSnapshotId).toBeTruthy();

      // Verify snapshot file exists
      const snapshotDir = path.join(tempDir, 'rbook', 'db', 'snapshots');
      if (fs.existsSync(snapshotDir)) {
        const files = fs.readdirSync(snapshotDir);
        expect(files.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('succeeds even when decisions/learnings tables do not exist', async () => {
      // No strategic_decisions or learnings tables created
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      // archive: true so the archival arm runs against the missing tables (s92-m05 made it opt-in).
      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'No decision tables',
        archive: true,
        projectRoot: getProjectRoot(),
      });

      // Should succeed with warnings about archival failure
      expect(result.success).toBe(true);
      expect(result.data?.lifecycle.decisionsArchived).toBe(0);
      expect(result.data?.lifecycle.learningsArchived).toBe(0);
    });

    it('archives successfully on a pre-migration DB lacking the session-of-origin column (Sprint 52 m04 / s69-m04)', async () => {
      // Regression for reporter: "Column does not exist" on older DBs. Create
      // strategic_decisions and learnings WITHOUT the session-of-origin column; the
      // sprint-complete path must migrate the column in (s69-m04 names it
      // author_session_id) and then archive the scoped rows.
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS strategic_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          decision_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sprint_id TEXT,
          mission_id TEXT,
          status TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE IF NOT EXISTS learnings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          sprint_id TEXT,
          mission_id TEXT,
          created_at TEXT NOT NULL
        );
      `);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Scoped decision', '2026-03-01T00:00:00Z', 'sprint-22', 'active')`
      ).run();
      db.prepare(
        `INSERT INTO learnings (content, category, status, sprint_id, created_at)
         VALUES ('Scoped learning', 'technical', 'active', 'sprint-22', '2026-03-01T00:00:00Z')`
      ).run();
      db.close();

      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Pre-migration DB archival',
        archive: true,
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/partially failed/i)])
      );
      expect(result.data?.lifecycle.decisionsArchived).toBe(1);
      expect(result.data?.lifecycle.learningsArchived).toBe(1);

      // The session-of-origin column should be present after the migration ran.
      // s69-m04 renamed it author_session_id (and ensureArchivalColumns adds it
      // under the new name when neither name exists), so it must NOT resurrect the
      // legacy session_id.
      const db2 = new Database(dbPath);
      const decisionCols = db2.pragma('table_info(strategic_decisions)') as Array<{ name: string }>;
      const learningCols = db2.pragma('table_info(learnings)') as Array<{ name: string }>;
      db2.close();
      expect(decisionCols.some((c) => c.name === 'author_session_id')).toBe(true);
      expect(learningCols.some((c) => c.name === 'author_session_id')).toBe(true);
      expect(decisionCols.some((c) => c.name === 'session_id')).toBe(false);
      expect(learningCols.some((c) => c.name === 'session_id')).toBe(false);
    });

    it('formats lifecycle data in LLM output', async () => {
      seedDecisionsAndLearningsTables();
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Test decision', '2026-03-01T00:00:00Z', 'sprint-22', 'active')`
      ).run();
      db.close();

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Format test',
        projectRoot: getProjectRoot(),
      });
      const formatted = formatSprintCompleteForLLM(result);

      expect(formatted).toContain('KPIs:');
      expect(formatted).toContain('Archived:');
      expect(formatted).toContain('DB snapshot:');
    });
  });

  describe('build-freshness advisory (post-s74; was the Sprint 70 m02 gate)', () => {
    function writeSrcFile(relativePath: string, mtime?: Date): void {
      const fullPath = path.join(tempDir, relativePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `// ${relativePath}\n`);
      if (mtime) fs.utimesSync(fullPath, mtime, mtime);
    }

    function writeDistManifest(buildTime: Date): void {
      const distDir = path.join(tempDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(distDir, '.build-manifest.json'),
        JSON.stringify({ buildHash: 'x', buildTime: buildTime.toISOString(), fileCount: 1 })
      );
    }

    function writeDistIndex(mtime: Date): void {
      // dist/index.js; with a manifest that will not parse beside it, checkBuildFreshness walks
      // dist/ (reason 'src-newer-than-build-dir'); with no manifest it checks nothing (s107-m04).
      const distDir = path.join(tempDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      const indexPath = path.join(distDir, 'index.js');
      fs.writeFileSync(indexPath, 'module.exports = {};\n');
      fs.utimesSync(indexPath, mtime, mtime);
    }

    function countRows(table: string): number {
      const db = new Database(dbPath);
      try {
        const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
        return row.count;
      } finally {
        db.close();
      }
    }

    function readSprintStatus(): string {
      const db = new Database(dbPath);
      const row = db.prepare('SELECT status FROM sprints WHERE id = ?').get('sprint-22') as {
        status: string;
      };
      db.close();
      return row.status;
    }

    function fakeManifest(hash: string): BuildManifest {
      return { buildHash: hash, buildTime: '2026-05-01T00:00:00Z', fileCount: 1 };
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    // --- Fresh trees pass unaffected (criterion e) ---

    it('omits buildFreshness and completes when no src/ exists in the project root', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'No build artifacts',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.buildFreshness).toBeUndefined();
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/forceComplete|stale build/i)])
      );
    });

    it('completes when src/ is older than the build manifest (fresh tree)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeSrcFile('src/foo.ts', new Date(Date.now() - 60_000));
      writeDistManifest(new Date());

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Fresh dist',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.buildFreshness).toBeUndefined();
    });

    // --- Staleness is ADVISORY: surfaced as a warning, never blocks (post-s74) ---

    it('completes with an advisory warning (does NOT block) when src/ is newer than the build', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeDistManifest(new Date(Date.now() - 60_000));
      writeSrcFile('src/foo.ts', new Date());

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Stale dist is advisory, not blocking',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
      // The staleness report is attached and an advisory warning is surfaced...
      expect(result.data?.buildFreshness?.stale).toBe(true);
      expect(result.data?.buildFreshness?.staleFiles).toEqual(
        expect.arrayContaining([path.join('src', 'foo.ts')])
      );
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/Advisory.*build looks stale/i)])
      );
      // ...but it does NOT block: the sprint actually completed and mutated
      // (the inverse of the old gate's "zero mutation on block" invariant).
      expect(readSprintStatus()).toBe('Completed');
      expect(countRows('context_snapshots')).toBeGreaterThan(0);
    });

    it('completes with no advisory when there is no manifest, as there is no build to check (s107-m04)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeDistIndex(new Date(Date.now() - 60_000));
      writeSrcFile('src/foo.ts', new Date());

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'No manifest, no build check',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.buildFreshness).toBeUndefined();
      expect(result.warnings?.join('\n') ?? '').not.toMatch(/build looks stale|freshness/i);
      expect(readSprintStatus()).toBe('Completed');
    });

    it('keeps a failed freshness check and warns, never reading it as fresh (s107-m04)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeSrcFile('src/foo.ts', new Date());
      fs.writeFileSync(path.join(tempDir, 'dist'), 'not a folder');

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'A failed check is said',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.buildFreshness?.reason).toMatch(/^freshness-check-failed: ENOTDIR/);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^Build freshness could not be checked: ENOTDIR/),
        ])
      );
      expect(readSprintStatus()).toBe('Completed');
    });

    it('completes with an advisory warning on src-newer-than-build-dir (does NOT block)', async () => {
      // An interrupted build leaves a manifest that will not parse, so the newest dist/ file is
      // the build time. Detection is covered in build-freshness.test.ts; here we assert the e2e
      // closeout treats it as advisory, not a block.
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeDistIndex(new Date(Date.now() - 60_000));
      fs.writeFileSync(path.join(tempDir, 'dist', '.build-manifest.json'), '{ "buildTime": ');
      writeSrcFile('src/foo.ts', new Date());

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Stale build-dir fallback is advisory',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.buildFreshness?.reason).toBe('src-newer-than-build-dir');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/src-newer-than-build-dir/)])
      );
      expect(readSprintStatus()).toBe('Completed');
    });

    it('still runs the closeout transaction on a stale tree (advisory does not skip work)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeDistManifest(new Date(Date.now() - 60_000));
      writeSrcFile('src/foo.ts', new Date());

      const executeSpy = jest.spyOn(RbookDatabaseClient.prototype, 'execute');

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Stale tree still commits the closeout',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      const sqlCalls = executeSpy.mock.calls.map((c) => String(c[0]).toUpperCase());
      expect(sqlCalls.some((sql) => sql.includes('BEGIN'))).toBe(true);
      expect(sqlCalls.some((sql) => sql.includes('COMMIT'))).toBe(true);
    });

    // --- forceComplete is now a no-op (kept for backward compatibility) ---

    it('accepts forceComplete:true as a no-op — a stale tree completes either way', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      writeDistManifest(new Date(Date.now() - 60_000));
      writeSrcFile('src/foo.ts', new Date());

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'forceComplete is now a no-op',
        forceComplete: true,
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
      expect(result.data?.buildFreshness?.stale).toBe(true);
      // No "forceComplete over a stale build" override warning is produced anymore...
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/forceComplete.*stale build/i)])
      );
      // ...just the plain advisory.
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/Advisory.*build looks stale/i)])
      );
      expect(readSprintStatus()).toBe('Completed');
    });

    // --- Server-health (codeIsCurrent) signal: advisory + SCOPED to the own project ---

    it('surfaces server-stale as an advisory (no block) for the server OWN project', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      // Scope-in: the closing project IS this server's own project.
      jest.spyOn(serverHealth, 'getServerProjectRoot').mockReturnValue(getProjectRoot());
      jest.spyOn(serverHealth, 'getServerHealth').mockReturnValue({
        uptimeSeconds: 1,
        startedAt: '2026-05-01T00:00:00Z',
        memoryUsageMb: 1,
        startupBuild: fakeManifest('aaaaaaaaaaaa'),
        currentBuild: fakeManifest('bbbbbbbbbbbb'),
        codeIsCurrent: false,
        stalenessMessage:
          'Server is running stale code. Restart the MCP server to pick up changes.',
        pid: 1,
        nodeVersion: 'v20',
      });

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Own-project server-stale is advisory',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/running stale code/i)])
      );
      expect(readSprintStatus()).toBe('Completed');
    });

    it('does NOT surface server-stale to a SIBLING project (the Forge cross-project leak)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      // Scope-out: the server's own project is some OTHER directory, not the caller.
      jest
        .spyOn(serverHealth, 'getServerProjectRoot')
        .mockReturnValue(path.join(path.sep, 'some', 'other', 'cmos-mcp-pro'));
      jest.spyOn(serverHealth, 'getServerHealth').mockReturnValue({
        uptimeSeconds: 1,
        startedAt: '2026-05-01T00:00:00Z',
        memoryUsageMb: 1,
        startupBuild: fakeManifest('aaaaaaaaaaaa'),
        currentBuild: fakeManifest('bbbbbbbbbbbb'),
        codeIsCurrent: false,
        stalenessMessage:
          'Server is running stale code. Restart the MCP server to pick up changes.',
        pid: 1,
        nodeVersion: 'v20',
      });

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Sibling project must not be blamed for our rebuild',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
      // The server-stale message must NOT leak into a sibling's closeout.
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/running stale code/i)])
      );
      expect(readSprintStatus()).toBe('Completed');
    });

    it('produces no server-stale advisory when startupBuild is null, even for the own project', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      // Scope-in to the own project, but startupBuild=null (a manifest exists on
      // disk yet the process captured none at startup) — must NOT surface staleness.
      jest.spyOn(serverHealth, 'getServerProjectRoot').mockReturnValue(getProjectRoot());
      jest.spyOn(serverHealth, 'getServerHealth').mockReturnValue({
        uptimeSeconds: 1,
        startedAt: '2026-05-01T00:00:00Z',
        memoryUsageMb: 1,
        startupBuild: null,
        currentBuild: fakeManifest('bbbbbbbbbbbb'),
        codeIsCurrent: false,
        stalenessMessage: 'Server started before build manifest existed.',
        pid: 1,
        nodeVersion: 'v20',
      });

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Null startup manifest yields no server-stale advisory',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([
          expect.stringMatching(/running stale|started before build manifest/i),
        ])
      );
    });

    // --- Degenerate non-blocking cases are preserved (criterion f) ---

    it('does NOT block when the freshness probe throws (never-wedge contract)', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      jest
        .spyOn(buildFreshnessModule, 'checkBuildFreshness')
        .mockRejectedValue(new Error('probe blew up'));

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Probe failure must not wedge',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Completed');
    });
  });

  describe('tool definition and formatting', () => {
    it('exposes the expected tool schema', () => {
      expect(rbookSprintCompleteToolDefinition.name).toBe('rbook_sprint_complete');
      expect(rbookSprintCompleteToolDefinition.inputSchema.required).toEqual(
        expect.arrayContaining(['sprintId', 'summary'])
      );
    });

    it('exposes forceComplete as a boolean on the tool schema (Sprint 70 m02)', () => {
      const props = rbookSprintCompleteToolDefinition.inputSchema.properties as Record<
        string,
        { type?: string }
      >;
      expect(props.forceComplete).toBeDefined();
      expect(props.forceComplete.type).toBe('boolean');
    });

    it('formats success results for LLMs', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'Formatting check',
        projectRoot: getProjectRoot(),
      });
      const formatted = formatSprintCompleteForLLM(result);

      expect(formatted).toContain("Sprint 'sprint-22' completed");
      expect(formatted).toContain('Total context size');
    });
  });

  describe('s90-m05 whole-ledger next_steps survey', () => {
    /** Create + seed the next_steps table (absent from the base fixture schema). */
    function seedNextStepsTable(
      rows: Array<{
        id: number;
        content: string;
        status: string;
        sprintId: string | null;
        missionId: string | null;
      }>
    ): void {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS next_steps (
          id INTEGER PRIMARY KEY,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          session_id TEXT,
          sprint_id TEXT,
          mission_id TEXT,
          created_at TEXT NOT NULL,
          resolved_at TEXT
        );
      `);
      const insert = db.prepare(
        `INSERT INTO next_steps (id, content, status, sprint_id, mission_id, created_at)
         VALUES (?, ?, ?, ?, ?, '2026-03-05T00:00:00Z')`
      );
      for (const r of rows) insert.run(r.id, r.content, r.status, r.sprintId, r.missionId);
      db.close();
    }

    function readNextStep(id: number): { status: string; resolved_at: string | null } {
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT status, resolved_at FROM next_steps WHERE id = ?').get(id) as {
        status: string;
        resolved_at: string | null;
      };
      db.close();
      return row;
    }

    it('leaves every pending row unchanged and groups the whole ledger by provenance', async () => {
      seedMissions([
        { id: 's22-m01', status: 'Completed' },
        { id: 's22-m02', status: 'Blocked', notes: '[Blocked] waiting' },
      ]);
      seedContexts({}, {});
      seedNextStepsTable([
        // A: pending, FK to a Completed mission → closing sprint with mission provenance.
        {
          id: 1,
          content: 'wrap up s22-m01',
          status: 'pending',
          sprintId: 'sprint-22',
          missionId: 's22-m01',
        },
        // B: pending, FK to a Blocked mission → same provenance group; still pending.
        {
          id: 2,
          content: 'blocked follow-up',
          status: 'pending',
          sprintId: 'sprint-22',
          missionId: 's22-m02',
        },
        // C: pending, sprint-linked but NO mission FK → closing sprint without mission.
        {
          id: 3,
          content: 'free-text idea, did it ship?',
          status: 'pending',
          sprintId: 'sprint-22',
          missionId: null,
        },
        // D: pending, a DIFFERENT sprint → other-sprint provenance.
        {
          id: 4,
          content: 'other sprint work',
          status: 'pending',
          sprintId: 'sprint-99',
          missionId: null,
        },
        // E: already completed, FK to a Completed mission → UNTOUCHED (not pending).
        {
          id: 5,
          content: 'already done',
          status: 'completed',
          sprintId: 'sprint-22',
          missionId: 's22-m01',
        },
        // F: pending with no sprint provenance at all.
        {
          id: 6,
          content: 'unscoped pending work',
          status: 'pending',
          sprintId: null,
          missionId: null,
        },
        // G: four more rows under the old auto-complete predicate make the positive control
        // non-vacuous and push one rendered group past the prose-excerpt cap.
        ...[7, 8, 9, 10].map((id) => ({
          id,
          content: `additional delivered-provenance row ${id}`,
          status: 'pending',
          sprintId: 'sprint-22',
          missionId: 's22-m01',
        })),
      ]);

      const preCloseDb = new Database(dbPath, { readonly: true });
      try {
        const oldEligible = preCloseDb
          .prepare(
            `SELECT COUNT(*) AS count
               FROM next_steps ns
               JOIN missions m ON m.id = ns.mission_id
              WHERE ns.sprint_id = ?
                AND ns.status = 'pending'
                AND m.status = 'Completed'`
          )
          .get('sprint-22') as { count: number };
        expect(oldEligible.count).toBeGreaterThanOrEqual(2);

        const fixtureGroups = preCloseDb
          .prepare(
            `SELECT
               COALESCE(SUM(CASE WHEN sprint_id = ? AND mission_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS closingWithMission,
               COALESCE(SUM(CASE WHEN sprint_id = ? AND mission_id IS NULL THEN 1 ELSE 0 END), 0) AS closingWithoutMission,
               COALESCE(SUM(CASE WHEN sprint_id IS NOT NULL AND sprint_id <> ? THEN 1 ELSE 0 END), 0) AS otherSprint,
               COALESCE(SUM(CASE WHEN sprint_id IS NULL THEN 1 ELSE 0 END), 0) AS noSprint
             FROM next_steps
             WHERE status = 'pending'`
          )
          .get('sprint-22', 'sprint-22', 'sprint-22') as {
          closingWithMission: number;
          closingWithoutMission: number;
          otherSprint: number;
          noSprint: number;
        };
        expect(Object.values(fixtureGroups).every((count) => count > 0)).toBe(true);
      } finally {
        preCloseDb.close();
      }

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'closeout reconcile',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.nextStepsSurvey).toEqual({
        available: true,
        totalPending: 9,
        // s91-m06: additive — open total, per-row status and age, and the lease block.
        totalOpen: 9,
        groups: {
          closingSprintWithMissionProvenance: [
            {
              id: 1,
              content: 'wrap up s22-m01',
              sprintId: 'sprint-22',
              missionId: 's22-m01',
              status: 'pending',
              closesSurvived: 0,
              // s92-m02: days since the lease anchor (created_at here)
              ageDays: expect.any(Number),
            },
            {
              id: 2,
              content: 'blocked follow-up',
              sprintId: 'sprint-22',
              missionId: 's22-m02',
              status: 'pending',
              closesSurvived: 0,
              // s92-m02: days since the lease anchor (created_at here)
              ageDays: expect.any(Number),
            },
            ...[7, 8, 9, 10].map((id) => ({
              id,
              content: `additional delivered-provenance row ${id}`,
              sprintId: 'sprint-22',
              missionId: 's22-m01',
              status: 'pending',
              closesSurvived: 0,
              // s92-m02: days since the lease anchor (created_at here)
              ageDays: expect.any(Number),
            })),
          ],
          closingSprintWithoutMissionProvenance: [
            {
              id: 3,
              content: 'free-text idea, did it ship?',
              sprintId: 'sprint-22',
              missionId: null,
              status: 'pending',
              closesSurvived: 0,
              // s92-m02: days since the lease anchor (created_at here)
              ageDays: expect.any(Number),
            },
          ],
          otherSprintProvenance: [
            {
              id: 4,
              content: 'other sprint work',
              sprintId: 'sprint-99',
              missionId: null,
              status: 'pending',
              closesSurvived: 0,
              // s92-m02: days since the lease anchor (created_at here)
              ageDays: expect.any(Number),
            },
          ],
          noSprintProvenance: [
            {
              id: 6,
              content: 'unscoped pending work',
              sprintId: null,
              missionId: null,
              status: 'pending',
              closesSurvived: 0,
              // s92-m02: days since the lease anchor (created_at here)
              ageDays: expect.any(Number),
            },
          ],
        },
        lease: {
          warnAt: LEASE_WARN_AT,
          lapseAt: LEASE_LAPSE_AT,
          countingRule: LEASE_COUNTING_RULE,
          warned: [],
          lapsed: [],
          // s92-m02: the fixture rows were created 2026-03-05 and no close followed, so every one
          // is past the 6-week idle line — warned, never dropped by the calendar.
          minAgeDays: LEASE_MIN_AGE_DAYS,
          heldByMinAge: [],
          idleWarnDays: LEASE_IDLE_WARN_DAYS,
          idle: [1, 2, 3, 4, 6, 7, 8, 9, 10],
        },
      });

      // Row-level effects.
      for (const id of [1, 2, 3, 4, 6, 7, 8, 9, 10]) {
        expect(readNextStep(id)).toEqual({ status: 'pending', resolved_at: null });
      }
      expect(readNextStep(5).status).toBe('completed'); // already completed, unchanged

      const rendered = formatSprintCompleteForLLM(result);
      expect(rendered).toContain('Next-steps survey: 9 pending across the whole ledger');
      expect(rendered).toContain('Closing sprint with mission provenance (not delivery): 6');
      expect(rendered).toContain('Other sprint provenance: 1');
      expect(rendered).toContain('No sprint provenance: 1');
      expect(rendered).toContain('IDs: #1, #2, #7, #8, #9, #10');
      expect(rendered).not.toContain('additional delivered-provenance row 10');
      expect(rendered).toContain(
        'rbook_context(action="next_steps", nextStepAction="complete", nextStepIds=[...])'
      );
      expect(rendered).toContain(
        'rbook_context(action="next_steps", nextStepAction="carry", nextStepIds=[...])'
      );
      expect(rendered).toContain(
        'rbook_context(action="next_steps", nextStepAction="drop", nextStepIds=[...])'
      );
    });

    it('surveys pending rows outside the closing sprint instead of reporting an empty receipt', async () => {
      seedMissions([{ id: 's22-m01', status: 'Completed' }]);
      seedContexts({}, {});
      seedNextStepsTable([
        {
          id: 1,
          content: 'other sprint',
          status: 'pending',
          sprintId: 'sprint-99',
          missionId: null,
        },
      ]);

      const result = await rbookSprintComplete({
        sprintId: 'sprint-22',
        summary: 'empty reconcile',
        projectRoot: getProjectRoot(),
      });

      expect(result.success).toBe(true);
      expect(result.data?.nextStepsSurvey).toEqual({
        available: true,
        totalPending: 1,
        // s91-m06: additive — open total, per-row status and age, and the lease block.
        totalOpen: 1,
        groups: {
          closingSprintWithMissionProvenance: [],
          closingSprintWithoutMissionProvenance: [],
          otherSprintProvenance: [
            {
              id: 1,
              content: 'other sprint',
              sprintId: 'sprint-99',
              missionId: null,
              status: 'pending',
              closesSurvived: 0,
              // s92-m02: days since the lease anchor (created_at here)
              ageDays: expect.any(Number),
            },
          ],
          noSprintProvenance: [],
        },
        lease: {
          warnAt: LEASE_WARN_AT,
          lapseAt: LEASE_LAPSE_AT,
          countingRule: LEASE_COUNTING_RULE,
          warned: [],
          lapsed: [],
          minAgeDays: LEASE_MIN_AGE_DAYS,
          heldByMinAge: [],
          idleWarnDays: LEASE_IDLE_WARN_DAYS,
          idle: [1],
        },
      });
      expect(readNextStep(1).status).toBe('pending'); // untouched
    });
  });
});
