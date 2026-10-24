/**
 * rbook_agent_onboard Tool Tests
 *
 * Tests for the agent onboarding/context initialization tool.
 *
 * @module tests/tools/rbook/rbook-agent-onboard
 */

import { jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookAgentOnboard,
  rbookAgentOnboardToolDefinition,
  formatAgentOnboardForLLM,
  type RbookAgentOnboardResult,
} from '../../../src/tools/rbook/rbook-agent-onboard';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { DEFAULT_STALENESS_THRESHOLD } from '../../../src/tools/rbook/staleness-detection';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import type { ServerHealthStatus } from '../../../src/server-health';

/** Mock server health for test fixtures */
const mockServerHealth: ServerHealthStatus = {
  uptimeSeconds: 120,
  startedAt: '2026-03-11T10:00:00.000Z',
  memoryUsageMb: 64,
  startupBuild: null,
  currentBuild: null,
  codeIsCurrent: true,
  stalenessMessage: null,
  pid: 12345,
  nodeVersion: 'v22.0.0',
};

describe('rbook_agent_onboard', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-agent-onboard-test-'));
    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    dbPath = path.join(rbookDbDir, 'rbook.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT,
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

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT
      );

      -- Insert test data
      INSERT INTO sprints (id, title, status, focus)
      VALUES ('sprint-14', 'Sprint 14 - Agent Tools', 'Current', 'Implement agent utility tools');

      INSERT INTO missions (id, sprint_id, name, status, objective)
      VALUES
        ('s14-m01', 'sprint-14', 'Tool Pruning', 'Completed', 'Remove deprecated tools'),
        ('s14-m02', 'sprint-14', 'Sprint CRUD', 'Completed', 'Implement sprint tools'),
        ('s14-m03', 'sprint-14', 'Mission Creation', 'In Progress', 'Add mission creation'),
        ('s14-m04', 'sprint-14', 'Agent Utilities', 'Current', 'Add onboarding tools'),
        ('s14-m05', 'sprint-14', 'Documentation', 'Queued', 'Update docs'),
        ('blocked-1', 'sprint-14', 'Blocked Task', 'Blocked', 'Some blocked work');

      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES (
        'master_context',
        'context/MASTER_CONTEXT.json',
        '{"project":{"name":"Reasonbook","description":"MCP server for Reasonbook integration","status":"active"}}',
        '2024-01-15T10:00:00Z'
      ),
      (
        'project_context',
        'context/PROJECT_CONTEXT.json',
        '{"working_memory":{"next_steps":["Complete mission s14-m03","Start s14-m04"]},"next_session_context":{"when_we_resume":["Check test coverage"]}}',
        '2024-01-15T11:00:00Z'
      );

      INSERT INTO sessions (id, type, title, started_at, status, captures)
      VALUES
        ('PS-2024-01-15-001', 'planning', 'Sprint Planning', '2024-01-15T09:00:00Z', 'active', '["cap1", "cap2"]'),
        ('PS-2024-01-14-001', 'review', 'Code Review', '2024-01-14T10:00:00Z', 'completed', '[]');

      INSERT INTO strategic_decisions (decision_text, created_at, project_domain, sprint_id)
      VALUES
        ('Use TypeScript for all new tools', '2024-01-15T10:00:00Z', 'cmos-mcp', 'sprint-14'),
        ('Implement pagination for all list operations', '2024-01-14T09:00:00Z', 'cmos-mcp', 'sprint-14'),
        ('Follow RbookToolResult pattern', '2024-01-13T08:00:00Z', 'general', 'sprint-13');
    `);
    db.close();

    RbookDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic functionality', () => {
    it('should return aggregated onboarding data', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.project).toBeDefined();
      expect(result.data?.currentSprint).toBeDefined();
      expect(result.data?.pendingMissions).toBeDefined();
      expect(result.data?.recentDecisions).toBeDefined();
    });

    it('should include project identity', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.project.name).toBe('Reasonbook');
      expect(result.data?.project.description).toContain('MCP server');
    });

    it('should include current sprint context', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.id).toBe('sprint-14');
      expect(result.data?.currentSprint?.title).toContain('Sprint 14');
      expect(result.data?.currentSprint?.focus).toContain('agent');
    });

    it('should include active session if any', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.activeSession).toBeDefined();
      expect(result.data?.activeSession?.id).toBe('PS-2024-01-15-001');
      expect(result.data?.activeSession?.type).toBe('planning');
    });

    it('should include pending missions', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.pendingMissions.length).toBeGreaterThan(0);

      // Should have In Progress first, then Current, then Queued
      const statuses = result.data?.pendingMissions.map((m) => m.status);
      expect(statuses).toContain('In Progress');
    });

    it('should include blocked missions', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.blockedMissions.length).toBe(1);
      expect(result.data?.blockedMissions[0].id).toBe('blocked-1');
    });

    it('should include recent decisions', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.recentDecisions.length).toBe(3);
      expect(result.data?.recentDecisions[0].decision).toContain('TypeScript');
    });

    it('should include next steps from project_context', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.nextSteps.length).toBeGreaterThan(0);
    });

    it('should include session statistics', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.sessionStats.totalSessions).toBe(2);
      expect(result.data?.sessionStats.lastActivity).toBeDefined();
    });

    it('should include context size telemetry', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.contextSizes).toBeDefined();
      expect(result.data?.contextSizes.masterContext).not.toBeNull();
      expect(result.data?.contextSizes.projectContext).not.toBeNull();
      expect(result.data?.contextSizes.totalSizeKb).toBeGreaterThan(0);
    });

    it('should include suggested actions', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.suggestedActions.length).toBeGreaterThan(0);
      expect(result.data?.suggestedActions[0].action).toBeDefined();
      expect(result.data?.suggestedActions[0].command).toBeDefined();
      expect(result.data?.suggestedActions[0].priority).toBeDefined();
    });

    it('should infer current sprint from recent mission activity when status fields drift', async () => {
      const db = new Database(dbPath);
      db.exec(`
        UPDATE missions
        SET status = 'Completed',
            completed_at = '2024-01-10T10:00:00Z'
        WHERE sprint_id = 'sprint-14';

        UPDATE sprints
        SET status = 'Active'
        WHERE id = 'sprint-14';

        INSERT INTO sprints (id, title, status, focus)
        VALUES ('sprint-70', 'Sprint 70 - Field Feedback', 'Planned', 'Address production feedback');

        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at)
        VALUES
          ('s70-m01', 'sprint-70', 'Investigate field failures', 'Completed', 'Inspect field failures', '2024-01-20T11:00:00Z'),
          ('s70-m02', 'sprint-70', 'Ship follow-up fixes', 'Completed', 'Ship follow-up fixes', '2024-01-20T12:00:00Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.id).toBe('sprint-70');
      expect(result.data?.currentSprint?.status).toBe('Planned');
    });

    it('should prefer an explicitly active sprint that still has open runway over stale historical activity', async () => {
      const db = new Database(dbPath);
      db.exec(`
        UPDATE missions
        SET status = 'Completed',
            completed_at = '2024-01-10T10:00:00Z'
        WHERE sprint_id = 'sprint-14';

        UPDATE sprints
        SET status = 'Completed'
        WHERE id = 'sprint-14';

        INSERT INTO sprints (id, title, status, focus, start_date)
        VALUES
          ('sprint-70', 'Sprint 70 - Closed Drift', 'Planned', 'Historical drift', '2024-01-20'),
          ('sprint-71', 'Sprint 71 - Active Planning', 'Active', 'Ready for kickoff', '2024-01-21');

        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at)
        VALUES
          ('s70-m01', 'sprint-70', 'Investigate field failures', 'Completed', 'Inspect field failures', '2024-01-20T11:00:00Z');

        INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures)
        VALUES
          ('PS-2024-01-20-001', 'review', 'Historical sprint review', 'sprint-70', '2024-01-20T12:00:00Z', '2024-01-20T12:30:00Z', 'completed', '[]');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.id).toBe('sprint-71');
      expect(result.data?.currentSprint?.status).toBe('Active');
    });

    it('should filter stale next steps tied to completed work and old session residue', async () => {
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, status, focus)
        VALUES ('sprint-13', 'Sprint 13 - Closed', 'Completed', 'Closed work');

        INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures)
        VALUES ('PS-2024-01-01-001', 'review', 'Old review', 'sprint-13', '2024-01-01T09:00:00Z', '2024-01-01T10:00:00Z', 'completed', '[]');

        UPDATE contexts
        SET content = '{"working_memory":{"next_steps":["Complete mission s14-m01","Prepare release notes"]},"next_session_context":{"when_we_resume":["PS-2024-01-01-001: revisit sprint 13 planning","PS-2024-01-15-001: investigate current regression","Plan Sprint 13 closeout"]}}'
        WHERE id = 'project_context';
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.nextSteps).toContain('Prepare release notes');
      expect(result.data?.nextSteps).toContain('PS-2024-01-15-001: investigate current regression');
      expect(result.data?.nextSteps).not.toContain('Complete mission s14-m01');
      expect(result.data?.nextSteps).not.toContain('PS-2024-01-01-001: revisit sprint 13 planning');
      expect(result.data?.nextSteps).not.toContain('Plan Sprint 13 closeout');
    });
  });

  // ---------------------------------------------------------------------------
  // Sprint 55 m03: currentSprint excludes Archived + freshProject honors row counts
  // ---------------------------------------------------------------------------
  //
  // Bug context: OODS-Foundry-MCP reproduction (inbox c9024a19-9336-...).
  // Their project had 74 sprints, 458 missions, 127 sessions. sprint-91 closed
  // Completed, no Active. Onboard returned currentSprint={id:'sprint-69',
  // status:'Archived'} and freshProject:true. Root cause:
  //   (1) getMostRecentlyActiveSprintId only excluded Completed, not Archived.
  //   (2) detectFreshProject ignored row counts and only checked active
  //       missions + a "project brief" marker in master_context.
  // ---------------------------------------------------------------------------
  describe('Sprint 55 m03: currentSprint Archived exclusion', () => {
    it('returns null currentSprint when every sprint is Archived', async () => {
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus) VALUES
          ('sprint-1', 'Sprint 1', 'Archived', 'Historic work'),
          ('sprint-2', 'Sprint 2', 'Archived', 'Historic work'),
          ('sprint-3', 'Sprint 3', 'Archived', 'Historic work');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m1', 'sprint-3', 'Old task', 'Completed', 'Old work', '2024-01-01T10:00:00Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint).toBeNull();
    });

    it('prefers the latest Completed sprint over any Archived sprint when no Active exists', async () => {
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date, end_date) VALUES
          ('sprint-old', 'Old Archived', 'Archived', 'Historical', '2024-01-01', '2024-01-15'),
          ('sprint-mid', 'Middle Archived', 'Archived', 'Historical', '2024-02-01', '2024-02-15'),
          ('sprint-recent', 'Recent Completed', 'Completed', 'Most recent work', '2024-03-01', '2024-03-15');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m1', 'sprint-mid', 'Archived recent mission', 'Completed', 'Archived work', '2024-02-14T10:00:00Z'),
          ('m2', 'sprint-recent', 'Completed work', 'Completed', 'Recent work', '2024-03-14T10:00:00Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.id).toBe('sprint-recent');
      expect(result.data?.currentSprint?.status).toBe('Completed');
    });

    it('does not surface an Archived sprint even when it has the most recent mission activity', async () => {
      // Regression for the exact OODS repro: an Archived sprint has newer
      // mission completion timestamps than any Completed sprint, so the old
      // getMostRecentlyActiveSprintId step would return the Archived one.
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date, end_date) VALUES
          ('sprint-completed', 'Completed Sprint', 'Completed', 'Completed', '2024-01-01', '2024-01-15'),
          ('sprint-archived-recent', 'Archived Sprint', 'Archived', 'Archived', '2024-06-01', '2024-06-15');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m-completed', 'sprint-completed', 'Done work', 'Completed', 'Done', '2024-01-14T10:00:00Z'),
          ('m-archived', 'sprint-archived-recent', 'Newer but archived', 'Completed', 'Archived', '2024-06-14T10:00:00Z');
        INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures) VALUES
          ('PS-arch', 'review', 'Archived session', 'sprint-archived-recent', '2024-06-15T09:00:00Z', '2024-06-15T10:00:00Z', 'completed', '[]');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.status).not.toBe('Archived');
      expect(result.data?.currentSprint?.id).toBe('sprint-completed');
    });

    it('returns the Active sprint when Active and Archived coexist', async () => {
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date) VALUES
          ('sprint-arch', 'Archived', 'Archived', 'Historical', '2024-01-01'),
          ('sprint-active', 'Active Sprint', 'Active', 'Current work', '2024-05-01');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.id).toBe('sprint-active');
      expect(result.data?.currentSprint?.status).toBe('Active');
    });
  });

  // Sprint 74 m02: currentSprint treats Failed/Dropped as terminal + case-folds
  // ---------------------------------------------------------------------------
  // Bug context: Forge reproduction (msg 0b1050b9). Their dead sprint-101 (Failed)
  // surfaced as currentSprint while sprints 102-111 were Completed. Root cause:
  // every step excluded only 'Archived' (and Completed in the open-work steps),
  // so Step 3 (getMostRecentlyActiveSprintId) — which runs before the Completed-
  // aware Step 5 — was the only step a Failed sprint could reach, and it returned
  // the dead sprint. The '= Completed' compares were also case-sensitive, so a
  // lowercase 'completed' dodged the exclusion. Extends the s55-m03 Archived
  // pattern (decision #567) to {Archived, Failed, Dropped}, compared UPPER().
  // ---------------------------------------------------------------------------
  describe('Sprint 74 m02: Failed/Dropped terminal exclusion + case-fold', () => {
    it('does not surface a Failed sprint even when it has the most recent mission activity', async () => {
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date, end_date) VALUES
          ('sprint-completed', 'Completed Sprint', 'Completed', 'Shipped', '2024-01-01', '2024-01-15'),
          ('sprint-failed-recent', 'Failed Sprint', 'Failed', 'Abandoned', '2024-06-01', '2024-06-15');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m-completed', 'sprint-completed', 'Done work', 'Completed', 'Done', '2024-01-14T10:00:00Z'),
          ('m-failed', 'sprint-failed-recent', 'Newer but failed', 'Completed', 'Failed', '2024-06-14T10:00:00Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.status).not.toBe('Failed');
      expect(result.data?.currentSprint?.id).toBe('sprint-completed');
    });

    it('does not surface a Dropped sprint even when it has the most recent mission activity', async () => {
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date, end_date) VALUES
          ('sprint-completed', 'Completed Sprint', 'Completed', 'Shipped', '2024-01-01', '2024-01-15'),
          ('sprint-dropped-recent', 'Dropped Sprint', 'Dropped', 'Cut', '2024-06-01', '2024-06-15');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m-completed', 'sprint-completed', 'Done work', 'Completed', 'Done', '2024-01-14T10:00:00Z'),
          ('m-dropped', 'sprint-dropped-recent', 'Newer but dropped', 'Completed', 'Dropped', '2024-06-14T10:00:00Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.status).not.toBe('Dropped');
      expect(result.data?.currentSprint?.id).toBe('sprint-completed');
    });

    it('does not surface a Reverted sprint even when it has the most recent activity (Forge backlog msg 7aac15f6)', async () => {
      // Forge repro: sprint-133 'Reverted' leaked into currentSprint in the
      // review→plan gap while 134–148 were Completed, because 'Reverted' was not in
      // DEAD_SPRINT_STATUSES. Even with the newest mission activity, a reverted
      // sprint must be excluded and the latest Completed must win.
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date, end_date) VALUES
          ('sprint-147', 'Done 147', 'Completed', 'Shipped', '2024-10-01', '2024-10-15'),
          ('sprint-148', 'Done 148', 'Completed', 'Shipped', '2024-11-01', '2024-11-15'),
          ('sprint-133', 'Reverted Sprint', 'Reverted', 'Rolled back', '2024-03-01', '2024-03-15');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m-147', 'sprint-147', 'Done 147', 'Completed', 'Done', '2024-10-14T10:00:00Z'),
          ('m-148', 'sprint-148', 'Done 148', 'Completed', 'Done', '2024-11-14T10:00:00Z'),
          ('m-133', 'sprint-133', 'Reverted work', 'Completed', 'Reverted', '2024-12-14T10:00:00Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.status).not.toBe('Reverted');
      expect(result.data?.currentSprint?.id).toBe('sprint-148');
    });

    it('Forge repro: a Failed sprint with no later siblings still yields the latest Completed, not the Failed one', async () => {
      // sprint-101 Failed is the ONLY non-Completed sprint, so the old Step 3
      // (excludes Completed+Archived but not Failed) returned it regardless of
      // 102-111's later activity. New code excludes Failed → falls through to the
      // Completed-aware Step 5, which returns the most-recently-active Completed.
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date, end_date) VALUES
          ('sprint-101', 'Failed', 'Failed', 'Abandoned', '2024-01-01', '2024-01-15'),
          ('sprint-110', 'Done 110', 'Completed', 'Shipped', '2024-10-01', '2024-10-15'),
          ('sprint-111', 'Done 111', 'Completed', 'Shipped', '2024-11-01', '2024-11-15');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m-101', 'sprint-101', 'Failed work', 'Completed', 'Failed', '2024-01-14T10:00:00Z'),
          ('m-110', 'sprint-110', 'Done 110', 'Completed', 'Done', '2024-10-14T10:00:00Z'),
          ('m-111', 'sprint-111', 'Done 111', 'Completed', 'Done', '2024-11-14T10:00:00Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.status).not.toBe('Failed');
      expect(result.data?.currentSprint?.id).toBe('sprint-111');
    });

    it('treats a lowercase "failed" status as terminal (case-fold)', async () => {
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date, end_date) VALUES
          ('sprint-completed', 'Completed Sprint', 'Completed', 'Shipped', '2024-01-01', '2024-01-15'),
          ('sprint-fail-lower', 'lowercase failed', 'failed', 'Abandoned', '2024-06-01', '2024-06-15');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m-completed', 'sprint-completed', 'Done work', 'Completed', 'Done', '2024-01-14T10:00:00Z'),
          ('m-fail-lower', 'sprint-fail-lower', 'Newer but failed', 'Completed', 'failed', '2024-06-14T10:00:00Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.id).toBe('sprint-completed');
    });

    it('case-folds Completed: a lowercase "completed" sprint is excluded from the drift step in favor of a genuinely-active one', async () => {
      // Step 3 ("most recently active NON-completed sprint when status drifts")
      // must skip a lowercase 'completed' sprint. Old case-sensitive code let it
      // through and returned it over the genuinely-not-completed Planned sprint.
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date) VALUES
          ('sprint-planned', 'Drifted Planned', 'Planned', 'Real in-flight work', '2024-02-01'),
          ('sprint-comp-lower', 'lowercase completed', 'completed', 'Shipped', '2024-03-01');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m-planned', 'sprint-planned', 'In-flight', 'Completed', 'Work', '2024-02-14T10:00:00Z'),
          ('m-comp-lower', 'sprint-comp-lower', 'Most recent activity', 'Completed', 'Shipped', '2024-03-14T10:00:00Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.id).toBe('sprint-planned');
    });
  });

  // Sprint 63 m01: cascade must trust real mission/session activity over the
  // admin-editable end_date column.
  //
  // Repro: cmos-mcp's own DB had sprint-54 (Completed, real mission activity
  // ending 2026-04-16) with end_date later backfilled to '2026-05-14' as an
  // admin closeout date. sprint-62 (Completed) had end_date
  // '2026-05-08T16:28:13.236Z' and was the genuinely most-recent shipped
  // sprint. Step 5's ORDER BY COALESCE(end_date, start_date, '') DESC
  // compared '2026-05-14' > '2026-05-08...' as strings and surfaced sprint-54.
  // OODS-Foundry-MCP filed the same shape twice (intel_alert 7cf691bc,
  // 2026-05-15) with 28+ days of agent-side workarounds. Fix: prefer the
  // sprint with the most recent actual mission/session activity over the
  // status-and-end_date ordering when no Active sprint exists.
  describe('Sprint 63 m01: cascade prefers real activity over stale end_date', () => {
    it('returns the most-recently-active Completed sprint even when an older sprint has a later end_date', async () => {
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sessions;
        DELETE FROM sprints;
        -- sprint-stale-date: real activity in April, but admin backfilled
        -- end_date as a closeout marker to '2026-05-14' (later than reality).
        -- sprint-real-latest: real activity in May, ISO timestamp end_date
        -- earlier than '2026-05-14' lexicographically because the date-only
        -- string '2026-05-14' sorts after '2026-05-08T...'.
        INSERT INTO sprints (id, title, status, focus, start_date, end_date) VALUES
          ('sprint-stale-date', 'Stale end_date', 'Completed', 'Older work', '2026-04-16', '2026-05-14'),
          ('sprint-real-latest', 'Real latest', 'Completed', 'Latest work', '2026-05-07', '2026-05-08T16:28:13.236Z');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m-stale', 'sprint-stale-date', 'Old work', 'Completed', 'Old', '2026-04-16T20:03:38.216Z'),
          ('m-latest', 'sprint-real-latest', 'Latest work', 'Completed', 'Latest', '2026-05-08T03:26:53.769Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.id).toBe('sprint-real-latest');
      expect(result.data?.currentSprint?.status).toBe('Completed');
    });

    it('prefers the sprint with the most recent session activity when mission activity ties', async () => {
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sessions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date, end_date) VALUES
          ('sprint-late-end', 'Late end_date', 'Completed', 'Old work', '2024-01-01', '2026-12-31'),
          ('sprint-recent-session', 'Recent session', 'Completed', 'Latest', '2024-02-01', '2024-02-15');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m-old-a', 'sprint-late-end', 'Old A', 'Completed', 'Old', '2024-01-10T10:00:00Z'),
          ('m-old-b', 'sprint-recent-session', 'Old B', 'Completed', 'Old', '2024-01-10T10:00:00Z');
        INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures) VALUES
          ('PS-old', 'review', 'Old review', 'sprint-late-end', '2024-01-15T09:00:00Z', '2024-01-15T10:00:00Z', 'completed', '[]'),
          ('PS-recent', 'review', 'Recent review', 'sprint-recent-session', '2024-03-01T09:00:00Z', '2024-03-01T10:00:00Z', 'completed', '[]');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.id).toBe('sprint-recent-session');
    });

    it('still excludes Archived sprints even when their activity is most recent', async () => {
      // Belt-and-suspenders: ensure the Sprint 55 m03 Archived guardrail
      // continues to hold when the new activity-aware step runs.
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sessions;
        DELETE FROM sprints;
        INSERT INTO sprints (id, title, status, focus, start_date, end_date) VALUES
          ('sprint-archived-newer', 'Archived newer', 'Archived', 'Historical', '2024-06-01', '2024-06-15'),
          ('sprint-completed-older', 'Completed older', 'Completed', 'Older', '2024-01-01', '2024-01-15');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m-newer-archived', 'sprint-archived-newer', 'Newer but archived', 'Completed', 'Archived', '2024-06-14T10:00:00Z'),
          ('m-older-completed', 'sprint-completed-older', 'Older completed', 'Completed', 'Older', '2024-01-14T10:00:00Z');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.currentSprint?.status).not.toBe('Archived');
      expect(result.data?.currentSprint?.id).toBe('sprint-completed-older');
    });
  });

  describe('Sprint 55 m03: freshProject honors row counts', () => {
    it('returns freshProject:false for a mature project whose missions are all Completed', async () => {
      // Mirrors the OODS reproduction shape: many sprints/missions/sessions on
      // disk, but none currently In Progress/Current/Queued, and no "project
      // brief" marker in master_context. The pre-fix heuristic wrongly tagged
      // this as fresh and surfaced the tierSelectionPrompt.
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        DELETE FROM sessions;
        INSERT INTO sprints (id, title, status, focus) VALUES
          ('sprint-a', 'Sprint A', 'Completed', 'History'),
          ('sprint-b', 'Sprint B', 'Archived', 'History'),
          ('sprint-c', 'Sprint C', 'Completed', 'History');
        INSERT INTO missions (id, sprint_id, name, status, objective, completed_at) VALUES
          ('m1', 'sprint-a', 'Task 1', 'Completed', 'Done', '2024-01-10T10:00:00Z'),
          ('m2', 'sprint-a', 'Task 2', 'Completed', 'Done', '2024-01-11T10:00:00Z'),
          ('m3', 'sprint-b', 'Task 3', 'Completed', 'Done', '2024-02-10T10:00:00Z'),
          ('m4', 'sprint-c', 'Task 4', 'Completed', 'Done', '2024-03-10T10:00:00Z');
        INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures) VALUES
          ('PS-1', 'review', 'Retro 1', 'sprint-a', '2024-01-15T09:00:00Z', '2024-01-15T10:00:00Z', 'completed', '[]'),
          ('PS-2', 'review', 'Retro 2', 'sprint-c', '2024-03-15T09:00:00Z', '2024-03-15T10:00:00Z', 'completed', '[]');
        UPDATE contexts
           SET content = '{"project":{"name":"Mature","description":"Mature project","status":"active"}}'
         WHERE id = 'master_context';
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.freshProject).toBe(false);
      expect(result.data?.tierSelectionPrompt).toBeUndefined();
    });

    it('returns freshProject:false when sessions exist but no sprints or missions do', async () => {
      // A project that only ever opened conversation sessions is still past
      // the "tabula rasa" fresh state — row counts across any of the three
      // tables disqualify it.
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        DELETE FROM sessions;
        INSERT INTO sessions (id, type, title, started_at, completed_at, status, captures) VALUES
          ('PS-1', 'check-in', 'Note to self', '2024-04-01T09:00:00Z', '2024-04-01T10:00:00Z', 'completed', '[]');
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.freshProject).toBe(false);
    });

    it('still returns freshProject:true for a tabula-rasa database with zero rows everywhere', async () => {
      // Keep the primary baseline: a new project (no sprints, missions, or
      // sessions, no PROJECT BRIEF marker) must still be flagged fresh so
      // tierSelectionPrompt fires for onboarding.
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        DELETE FROM sessions;
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.freshProject).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle missing master_context gracefully', async () => {
      const db = new Database(dbPath);
      db.exec("DELETE FROM contexts WHERE id = 'master_context'");
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.project.name).toBe(path.basename(tempDir)); // Display-only folder fallback
    });

    it('should handle no active session', async () => {
      const db = new Database(dbPath);
      db.exec("UPDATE sessions SET status = 'completed'");
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.activeSession).toBeNull();
    });

    it('should handle no pending missions', async () => {
      const db = new Database(dbPath);
      db.exec("UPDATE missions SET status = 'Completed'");
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.pendingMissions).toHaveLength(0);
    });

    it('should handle no decisions', async () => {
      const db = new Database(dbPath);
      db.exec('DELETE FROM strategic_decisions');
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.recentDecisions).toHaveLength(0);
    });

    it('surfaces whoami as a priority-1 action when attribution is ambiguous and the dashboard is in use', async () => {
      const originalEnvProjectRoot = process.env.RBOOK_PROJECT_ROOT;
      const originalDashboardUrl = process.env.RBOOK_DASHBOARD_URL;
      process.env.RBOOK_PROJECT_ROOT = '/tmp/pinned-cmos-mcp';

      const whoamiOf = async () => {
        const result = await rbookAgentOnboard({
          projectRoot: tempDir,
          advertisedRoots: [],
        } as Parameters<typeof rbookAgentOnboard>[0]);
        expect(result.success).toBe(true);
        return (result.data?.suggestedActions ?? []).find(
          (action) => action.command === 'rbook_message(action="whoami")'
        );
      };

      try {
        // s93-m11 (#606 a): whoami checks the dashboard's sender identity, so a user who never set
        // the dashboard up is not told to run it; it used to fail and be prescribed again.
        delete process.env.RBOOK_DASHBOARD_URL;
        expect(await whoamiOf()).toBeUndefined();

        process.env.RBOOK_DASHBOARD_URL = 'http://127.0.0.1:9';
        const whoamiAction = await whoamiOf();
        expect(whoamiAction).toBeDefined();
        expect(whoamiAction?.action).toBe('Run whoami to confirm sender attribution');
        expect(whoamiAction?.priority).toBe(1);
      } finally {
        if (originalEnvProjectRoot === undefined) {
          delete process.env.RBOOK_PROJECT_ROOT;
        } else {
          process.env.RBOOK_PROJECT_ROOT = originalEnvProjectRoot;
        }
        if (originalDashboardUrl === undefined) delete process.env.RBOOK_DASHBOARD_URL;
        else process.env.RBOOK_DASHBOARD_URL = originalDashboardUrl;
      }
    });
  });

  describe('context freshness', () => {
    it('should not mark context stale when lag is within threshold', async () => {
      const db = new Database(dbPath);
      db.exec(`
        UPDATE contexts
        SET updated_at = '2024-01-15T10:00:00Z'
        WHERE id = 'master_context';
        UPDATE missions
        SET completed_at = '2024-01-20T10:00:00Z'
        WHERE id = 's14-m01';
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.contextFreshness.isStale).toBe(false);
      // No context-staleness warnings (orphan warnings may appear from test data)
      const contextWarnings = (result.warnings ?? []).filter(
        (w) => w.includes('stale') && w.includes('context')
      );
      expect(contextWarnings).toEqual([]);
    });

    it('should warn when master_context is stale by more than 7 days', async () => {
      const db = new Database(dbPath);
      db.exec(`
        UPDATE contexts
        SET updated_at = '2024-01-01T00:00:00Z'
        WHERE id = 'master_context';
        UPDATE missions
        SET completed_at = '2024-01-20T00:00:00Z'
        WHERE id = 's14-m01';
      `);
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.contextFreshness.isStale).toBe(true);
      expect(result.data?.contextFreshness.lagDays).toBeGreaterThan(7);
      const warnings = result.warnings ?? [];
      // s85-m01: these warnings ship to every stale-context session start, so they must name
      // the CONSOLIDATED tools. The pre-s85 strings (rbook_context_update / rbook_session_start)
      // named tools that were removed in the 38→15 consolidation and would return an
      // unknown-tool error if an agent followed them verbatim.
      expect(warnings.some((warning) => warning.includes('rbook_context(action="update")'))).toBe(
        true
      );
      const hasReviewSuggestion = warnings.some((warning) =>
        warning.includes('rbook_session(action="start", type="review"')
      );
      expect(hasReviewSuggestion).toBe(true);
    });
  });

  describe('context size warnings', () => {
    it('should warn when context usage exceeds warning threshold', async () => {
      const db = new Database(dbPath);
      const oversizedMaster = {
        project: {
          name: 'Reasonbook',
          description: 'MCP server for Reasonbook integration',
          status: 'active',
        },
        context_health: {
          size_limit_kb: 1,
          warning_threshold_percent: 75,
        },
        payload: 'x'.repeat(1024),
      };

      db.prepare("UPDATE contexts SET content = ? WHERE id = 'master_context'").run(
        JSON.stringify(oversizedMaster)
      );
      db.close();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.contextSizes.masterContext?.usagePercent).toBeGreaterThanOrEqual(75);
      expect((result.warnings ?? []).some((warning) => warning.includes('master_context'))).toBe(
        true
      );
    });
  });

  describe('error handling', () => {
    it('should return error when Reasonbook not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-rbook-'));

      try {
        const result = await rbookAgentOnboard({ projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookAgentOnboardToolDefinition.name).toBe('rbook_agent_onboard');
    });

    it('should have description', () => {
      expect(rbookAgentOnboardToolDefinition.description).toBeTruthy();
      expect(rbookAgentOnboardToolDefinition.description).toContain('onboard');
    });

    it('should have valid input schema', () => {
      expect(rbookAgentOnboardToolDefinition.inputSchema.type).toBe('object');
    });
  });

  describe('formatAgentOnboardForLLM', () => {
    /**
     * s87-m05 (#533) — THE DIGEST MUST NOT REPORT A USER-WIDE NUMBER AS THIS PROJECT'S.
     *
     * Asserted on the RENDERED ANSWER, not on `result.data`. The class this mission closes is
     * "the answer is the defect", and a fix whose only proof reads the data object has moved the
     * defect rather than closed it. The real onboard result is produced first and only its
     * `messaging` field is substituted, so the rest of the render stays realistic.
     */
    async function renderWithMessaging(messaging: unknown): Promise<string> {
      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      (result.data as unknown as { messaging: unknown }).messaging = messaging;
      return formatAgentOnboardForLLM(result);
    }

    it("s87-m05: renders the SCOPED count, and says it is this project's", async () => {
      const out = await renderWithMessaging({
        unreadCountScoped: 2,
        unreadCountUserWide: 7,
        unreadScope: 'project',
        recentMessages: [],
      });
      expect(out).toContain('2 unread for this project');
      // The number that is NOT this project's must not be the one on screen.
      expect(out).not.toContain('**Messaging**: 7 unread');
    });

    it('s87-m05: an UNSCOPED response renders UNKNOWN, never the user-wide number as ours', async () => {
      // THE MEASURED DEFECT: a live payload of `unreadCount: 7, unreadCountScoped: 0` rendered
      // `**Messaging**: 7 unread` on a project whose truthful count was 0. Unknown is a different
      // claim from zero, and it is the right one here.
      const out = await renderWithMessaging({
        unreadCountScoped: null,
        unreadCountUserWide: 7,
        unreadScope: 'user',
        recentMessages: [],
      });
      expect(out).toContain('unknown');
      expect(out).toContain('across all your projects');
      expect(out).not.toContain('7 unread for this project');
    });

    it('should format success result', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);
      const formatted = formatAgentOnboardForLLM(result);

      expect(formatted).toContain('Onboarding');
      expect(formatted).toContain('Reasonbook');
    });

    it('should format error result', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-test-'));

      try {
        const result = await rbookAgentOnboard({ projectRoot: emptyDir });
        const formatted = formatAgentOnboardForLLM(result);

        expect(formatted).toContain('Failed');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should include suggested actions', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);
      const formatted = formatAgentOnboardForLLM(result);

      expect(formatted).toContain('Suggested Actions');
    });
  });

  describe('messaging integration', () => {
    it('should return messaging: null when dashboard is not configured', async () => {
      // No RBOOK_DASHBOARD_URL or RBOOK_DASHBOARD_PASSWORD set
      const result = await rbookAgentOnboardWithDb(dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.messaging).toBeNull();
    });

    it('should include messaging context when dashboard is available', async () => {
      const originalUrl = process.env.RBOOK_DASHBOARD_URL;
      const originalUser = process.env.RBOOK_DASHBOARD_USER;
      const originalPassword = process.env.RBOOK_DASHBOARD_PASSWORD;

      process.env.RBOOK_DASHBOARD_URL = 'http://localhost:3100';
      process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
      process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';

      const loginResponse = {
        success: true,
        data: {
          token: 'test-jwt',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: 'u1', email: 'test@example.com', projects: [] },
        },
      };

      const messagesResponse = {
        messages: [
          {
            id: 'msg-001',
            type: 'backlog_request',
            summary: 'Add dark mode',
            from: 'rbook://birch/design-system',
            status: 'pending',
            createdAt: '2026-03-09T00:00:00Z',
          },
        ],
        unreadCount: 1,
        totalCount: 1,
      };

      // Mock fetch with URL-based routing (messaging + sync health run in parallel)
      const originalFetch = global.fetch;
      const mockFn = jest.fn() as jest.Mock<(...args: any[]) => any>;
      mockFn.mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/login')) {
          return new Response(JSON.stringify(loginResponse), { status: 200 });
        }
        if (url.includes('/api/messages')) {
          return new Response(JSON.stringify(messagesResponse), { status: 200 });
        }
        if (url.includes('/api/sync/status')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                tables: [],
                totalMirrorRows: 0,
                totalSyncLogEntries: 0,
                unprocessedSyncLogEntries: 0,
                failedSyncLogEntries: 0,
                lastSyncAt: null,
                oldestUnprocessedAt: null,
                projectCount: 0,
              },
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      });
      global.fetch = mockFn as typeof global.fetch;

      try {
        const result = await rbookAgentOnboardWithDb(dbPath);

        expect(result.success).toBe(true);
        expect(result.data?.messaging).not.toBeNull();
        // s87-m05 — the digest carries the PROJECT-scoped count now. This mock's dashboard does
        // not scope (it returns no `unreadCountScoped`), which is the pre-cutover shape, so the
        // honest answer is "unknown for this project" beside the user-wide total — not a number
        // presented as this project's.
        expect(result.data?.messaging?.unreadScope).toBe('user');
        expect(result.data?.messaging?.unreadCountScoped).toBeNull();
        expect(result.data?.messaging?.unreadCountUserWide).toBe(1);
        expect(result.data?.messaging?.recentMessages).toHaveLength(1);
        expect(result.data?.messaging?.recentMessages[0].summary).toBe('Add dark mode');
        expect(result.data?.messaging?.recentMessages[0].from).toBe('rbook://birch/design-system');
      } finally {
        global.fetch = originalFetch;
        process.env.RBOOK_DASHBOARD_URL = originalUrl;
        process.env.RBOOK_DASHBOARD_USER = originalUser;
        process.env.RBOOK_DASHBOARD_PASSWORD = originalPassword;
      }
    });

    it('should gracefully degrade when dashboard is unreachable', async () => {
      const originalUrl = process.env.RBOOK_DASHBOARD_URL;
      const originalUser = process.env.RBOOK_DASHBOARD_USER;
      const originalPassword = process.env.RBOOK_DASHBOARD_PASSWORD;

      process.env.RBOOK_DASHBOARD_URL = 'http://localhost:3100';
      process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
      process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';

      const originalFetch = global.fetch;
      global.fetch = (jest.fn() as jest.Mock<(...args: any[]) => any>).mockRejectedValue(
        new Error('ECONNREFUSED')
      ) as typeof global.fetch;

      try {
        const result = await rbookAgentOnboardWithDb(dbPath);

        expect(result.success).toBe(true);
        expect(result.data?.messaging).toBeNull();
        const warnings = result.warnings ?? [];
        expect(warnings.some((w) => w.includes('Dashboard messaging unavailable'))).toBe(true);
      } finally {
        global.fetch = originalFetch;
        process.env.RBOOK_DASHBOARD_URL = originalUrl;
        process.env.RBOOK_DASHBOARD_USER = originalUser;
        process.env.RBOOK_DASHBOARD_PASSWORD = originalPassword;
      }
    });

    it('should include messaging in formatted output', async () => {
      const mockResult: RbookToolResult<RbookAgentOnboardResult> = {
        success: true,
        data: {
          project: { name: 'Test', description: null, status: null, projectType: 'build' },
          currentSprint: null,
          activeSession: null,
          pendingMissions: [],
          blockedMissions: [],
          recentDecisions: [],
          localProjectId: null,
          nextSteps: [],
          suggestedActions: [],
          sessionStats: { totalSessions: 0, lastActivity: null },
          contextSizes: {
            masterContext: null,
            projectContext: null,
            totalSizeKb: 0,
            totalSizeBytes: 0,
          },
          contextFreshness: {
            contextId: 'master_context',
            contextUpdatedAt: null,
            latestMissionCompletionAt: null,
            latestSessionCompletionAt: null,
            latestActivityAt: null,
            lagDays: null,
            isStale: false,
            staleThresholdDays: 7,
          },
          selfCapture: {
            gapDays: 0,
            thresholdDays: 7,
            lastCaptureAt: null,
            devActivityAt: null,
            fires: false,
          },
          staleness: {
            staleDecisions: 0,
            staleLearnings: 0,
            dueForReviewDecisions: 0,
            dueForReviewLearnings: 0,
            threshold: DEFAULT_STALENESS_THRESHOLD,
          },
          messaging: {
            unreadCountScoped: 2,
            unreadCountUserWide: 2,
            unreadScope: 'project' as const,
            recentMessages: [
              {
                id: 'msg-001',
                type: 'question',
                summary: 'How does auth work?',
                from: 'rbook://user/project',
                status: 'pending',
                createdAt: '2026-03-09T00:00:00Z',
              },
            ],
          },
          syncHealth: null,
          orphans: {
            orphanedSprints: [],
            orphanedMissions: [],
            staleSessions: [],
            totalOrphans: 0,
          },
          serverHealth: mockServerHealth,
          tierConfig: null,
          freshProject: false,
        },
      };

      const formatted = formatAgentOnboardForLLM(mockResult);
      expect(formatted).toContain('2 unread');
      expect(formatted).toContain('How does auth work?');
      expect(formatted).toContain('rbook://user/project');
    });

    it('should suggest checking inbox when unread messages exist', async () => {
      const originalUrl = process.env.RBOOK_DASHBOARD_URL;
      const originalUser = process.env.RBOOK_DASHBOARD_USER;
      const originalPassword = process.env.RBOOK_DASHBOARD_PASSWORD;

      process.env.RBOOK_DASHBOARD_URL = 'http://localhost:3100';
      process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
      process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';

      const loginResponse = {
        success: true,
        data: {
          token: 'test-jwt',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: 'u1', email: 'test@example.com', projects: [] },
        },
      };

      const messagesResponse = {
        messages: [
          {
            id: 'msg-001',
            type: 'question',
            summary: 'Test',
            status: 'pending',
            createdAt: '2026-03-09T00:00:00Z',
          },
        ],
        // s87-m05 — a POST-CUTOVER dashboard response: it scopes, and says so. The suggested
        // action is now gated on THIS PROJECT's count, because it used to fire on the user-wide
        // number and told a project with an empty inbox to go clear other projects' messages.
        unreadCount: 3,
        unreadCountScoped: 3,
        unreadScope: 'project',
        totalCount: 3,
      };

      const originalFetch = global.fetch;
      const mockFn = jest.fn() as jest.Mock<(...args: any[]) => any>;
      mockFn.mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/login')) {
          return new Response(JSON.stringify(loginResponse), { status: 200 });
        }
        if (url.includes('/api/messages')) {
          return new Response(JSON.stringify(messagesResponse), { status: 200 });
        }
        if (url.includes('/api/sync/status')) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                tables: [],
                totalMirrorRows: 0,
                totalSyncLogEntries: 0,
                unprocessedSyncLogEntries: 0,
                failedSyncLogEntries: 0,
                lastSyncAt: null,
                oldestUnprocessedAt: null,
                projectCount: 0,
              },
            }),
            { status: 200 }
          );
        }
        return new Response('{}', { status: 200 });
      });
      global.fetch = mockFn as typeof global.fetch;

      try {
        const result = await rbookAgentOnboardWithDb(dbPath);

        expect(result.success).toBe(true);
        const actions = result.data?.suggestedActions ?? [];
        const inboxAction = actions.find((a) => a.action.includes('unread message'));
        expect(inboxAction).toBeDefined();
        expect(inboxAction?.command).toContain('rbook_message');
        // …and it says whose messages they are.
        expect(inboxAction?.action).toContain('for this project');
      } finally {
        global.fetch = originalFetch;
        process.env.RBOOK_DASHBOARD_URL = originalUrl;
        process.env.RBOOK_DASHBOARD_USER = originalUser;
        process.env.RBOOK_DASHBOARD_PASSWORD = originalPassword;
      }
    });
  });

  describe('sync health integration', () => {
    it('should return syncHealth: null when dashboard is not configured', async () => {
      // Dashboard env vars not set by default in test
      const originalUrl = process.env.RBOOK_DASHBOARD_URL;
      const originalUser = process.env.RBOOK_DASHBOARD_USER;
      const originalPassword = process.env.RBOOK_DASHBOARD_PASSWORD;
      delete process.env.RBOOK_DASHBOARD_URL;
      delete process.env.RBOOK_DASHBOARD_USER;
      delete process.env.RBOOK_DASHBOARD_PASSWORD;

      try {
        const result = await rbookAgentOnboardWithDb(dbPath);
        expect(result.success).toBe(true);
        expect(result.data?.syncHealth).toBeNull();
      } finally {
        if (originalUrl) process.env.RBOOK_DASHBOARD_URL = originalUrl;
        if (originalUser) process.env.RBOOK_DASHBOARD_USER = originalUser;
        if (originalPassword) process.env.RBOOK_DASHBOARD_PASSWORD = originalPassword;
      }
    });

    it('should include syncHealth with mismatches when dashboard returns different counts', async () => {
      const originalUrl = process.env.RBOOK_DASHBOARD_URL;
      const originalUser = process.env.RBOOK_DASHBOARD_USER;
      const originalPassword = process.env.RBOOK_DASHBOARD_PASSWORD;

      process.env.RBOOK_DASHBOARD_URL = 'http://localhost:3100';
      process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
      process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';

      const loginResponse = {
        success: true,
        data: {
          token: 'test-jwt',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: 'u1', email: 'test@example.com', projects: [] },
        },
      };

      const syncStatusResponse = {
        success: true,
        data: {
          tables: [
            { table: 'cmos_sprints', count: 0 },
            { table: 'cmos_missions', count: 0 },
            { table: 'cmos_sessions', count: 0 },
            { table: 'cmos_decisions', count: 0 },
            { table: 'cmos_learnings', count: 0 },
            { table: 'cmos_mission_dependencies', count: 0 },
          ],
          totalMirrorRows: 0,
          totalSyncLogEntries: 0,
          unprocessedSyncLogEntries: 0,
          failedSyncLogEntries: 0,
          lastSyncAt: null,
          oldestUnprocessedAt: null,
          projectCount: 0,
        },
      };

      const messagesResponse = {
        messages: [],
        unreadCount: 0,
        totalCount: 0,
      };

      const originalFetch = global.fetch;
      const mockFn = jest.fn() as jest.Mock<(...args: any[]) => any>;
      // Two parallel requests: messaging (login + list) and sync health (login + status)
      // Each gets its own login + API call
      mockFn.mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/login')) {
          return new Response(JSON.stringify(loginResponse), { status: 200 });
        }
        if (url.includes('/api/sync/status')) {
          return new Response(JSON.stringify(syncStatusResponse), { status: 200 });
        }
        if (url.includes('/api/messages')) {
          return new Response(JSON.stringify(messagesResponse), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      });
      global.fetch = mockFn as typeof global.fetch;

      try {
        const result = await rbookAgentOnboardWithDb(dbPath);
        expect(result.success).toBe(true);
        expect(result.data?.syncHealth).not.toBeNull();
        // The test DB has some data but PG mirror has 0, so mismatches expected
        expect(result.data?.syncHealth?.allMatch).toBe(false);
        expect(result.data?.syncHealth?.totalMismatches).toBeGreaterThan(0);
      } finally {
        global.fetch = originalFetch;
        process.env.RBOOK_DASHBOARD_URL = originalUrl;
        process.env.RBOOK_DASHBOARD_USER = originalUser;
        process.env.RBOOK_DASHBOARD_PASSWORD = originalPassword;
      }
    });

    it('answers without sync health when the sync status carries no tables (s93-m11)', async () => {
      // The m11 reads critic: buildSyncHealthFromGlobalStatus iterated `pgStatus.tables`, and its
      // promise was returned un-awaited from inside fetchSyncHealth's try, so the TypeError escaped
      // the catch and failed the whole onboard (and rbook_review, which composes it).
      const saved = {
        url: process.env.RBOOK_DASHBOARD_URL,
        user: process.env.RBOOK_DASHBOARD_USER,
        password: process.env.RBOOK_DASHBOARD_PASSWORD,
      };
      process.env.RBOOK_DASHBOARD_URL = 'http://localhost:3100';
      process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
      process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';
      const login = {
        success: true,
        data: {
          token: 'test-jwt',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: 'u1', email: 'test@example.com', projects: [] },
        },
      };
      const originalFetch = global.fetch;
      global.fetch = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/login')) {
          return new Response(JSON.stringify(login), { status: 200 });
        }
        if (url.includes('/api/sync/status')) {
          return new Response(JSON.stringify({ success: true, data: {} }), { status: 200 });
        }
        if (url.includes('/api/messages')) {
          return new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), {
            status: 200,
          });
        }
        return new Response('{}', { status: 404 });
      }) as typeof global.fetch;

      try {
        const result = await rbookAgentOnboardWithDb(dbPath);
        expect(result.success).toBe(true);
        expect(result.data?.syncHealth).toBeNull();
        expect(result.warnings ?? []).toContain(
          'Sync health unavailable: unexpected error during fetch'
        );
      } finally {
        global.fetch = originalFetch;
        if (saved.url === undefined) delete process.env.RBOOK_DASHBOARD_URL;
        else process.env.RBOOK_DASHBOARD_URL = saved.url;
        if (saved.user === undefined) delete process.env.RBOOK_DASHBOARD_USER;
        else process.env.RBOOK_DASHBOARD_USER = saved.user;
        if (saved.password === undefined) delete process.env.RBOOK_DASHBOARD_PASSWORD;
        else process.env.RBOOK_DASHBOARD_PASSWORD = saved.password;
      }
    });

    it('should suggest reconcile action when sync health has mismatches', async () => {
      const originalUrl = process.env.RBOOK_DASHBOARD_URL;
      const originalUser = process.env.RBOOK_DASHBOARD_USER;
      const originalPassword = process.env.RBOOK_DASHBOARD_PASSWORD;

      process.env.RBOOK_DASHBOARD_URL = 'http://localhost:3100';
      process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
      process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';

      const loginResponse = {
        success: true,
        data: {
          token: 'test-jwt',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: 'u1', email: 'test@example.com', projects: [] },
        },
      };

      const syncStatusResponse = {
        success: true,
        data: {
          tables: [
            { table: 'cmos_sprints', count: 0 },
            { table: 'cmos_missions', count: 0 },
            { table: 'cmos_sessions', count: 0 },
            { table: 'cmos_decisions', count: 0 },
            { table: 'cmos_learnings', count: 0 },
            { table: 'cmos_mission_dependencies', count: 0 },
          ],
          totalMirrorRows: 0,
          totalSyncLogEntries: 0,
          unprocessedSyncLogEntries: 0,
          failedSyncLogEntries: 0,
          lastSyncAt: null,
          oldestUnprocessedAt: null,
          projectCount: 0,
        },
      };

      const originalFetch = global.fetch;
      const mockFn = jest.fn() as jest.Mock<(...args: any[]) => any>;
      mockFn.mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/login')) {
          return new Response(JSON.stringify(loginResponse), { status: 200 });
        }
        if (url.includes('/api/sync/status')) {
          return new Response(JSON.stringify(syncStatusResponse), { status: 200 });
        }
        return new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), {
          status: 200,
        });
      });
      global.fetch = mockFn as typeof global.fetch;

      try {
        const result = await rbookAgentOnboardWithDb(dbPath);
        expect(result.success).toBe(true);
        const actions = result.data?.suggestedActions ?? [];
        const reconcileAction = actions.find((a) => a.action.includes('mismatch'));
        expect(reconcileAction).toBeDefined();
        // A count mismatch permits investigation, not an unsolicited record upload.
        expect(reconcileAction?.command).toBe('rbook_db(action="reconcile") for details');
      } finally {
        global.fetch = originalFetch;
        process.env.RBOOK_DASHBOARD_URL = originalUrl;
        process.env.RBOOK_DASHBOARD_USER = originalUser;
        process.env.RBOOK_DASHBOARD_PASSWORD = originalPassword;
      }
    });

    it('should use project-scoped endpoint when metadata has project_name', async () => {
      // Create a new DB with metadata table
      const scopedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-onboard-scoped-test-'));
      const scopedRbookDbDir = path.join(scopedTempDir, 'rbook', 'db');
      fs.mkdirSync(scopedRbookDbDir, { recursive: true });
      const scopedDbPath = path.join(scopedRbookDbDir, 'rbook.sqlite');

      const scopedDb = new Database(scopedDbPath);
      scopedDb.exec(`
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
        CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);
        CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
        CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO metadata (key, value) VALUES ('project_id', 'test-uuid');
        INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
        INSERT INTO contexts (id, source_path, content, updated_at)
        VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{"project":{"name":"Test Project"}}', '2024-01-15T10:00:00Z');
        INSERT INTO sprints (id, title, status) VALUES ('sprint-1', 'Sprint 1', 'Active');
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m1', 'sprint-1', 'Mission 1', 'Queued');
      `);
      scopedDb.close();

      const originalUrl = process.env.RBOOK_DASHBOARD_URL;
      const originalUser = process.env.RBOOK_DASHBOARD_USER;
      const originalPassword = process.env.RBOOK_DASHBOARD_PASSWORD;

      process.env.RBOOK_DASHBOARD_URL = 'http://localhost:3100';
      process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
      process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';

      const loginResponse = {
        success: true,
        data: {
          token: 'test-jwt',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          user: { id: 'u1', email: 'test@example.com', projects: [] },
        },
      };

      const projectStateResponse = {
        success: true,
        data: {
          project: {
            id: 'test-uuid',
            slug: 'test-project',
            name: 'Test Project',
            schemaVersion: null,
            createdAt: '2024-01-01',
            updatedAt: '2024-01-15',
          },
          sprints: [{ id: 's1' }],
          missions: [{ id: 'm1' }],
          sessions: [],
          decisions: [],
          learnings: [],
          dependencies: [],
        },
      };

      const syncStatusResponse = {
        success: true,
        data: {
          tables: [],
          totalMirrorRows: 0,
          totalSyncLogEntries: 5,
          unprocessedSyncLogEntries: 0,
          failedSyncLogEntries: 2,
          lastSyncAt: '2024-01-15T10:00:00Z',
          oldestUnprocessedAt: null,
          projectCount: 1,
        },
      };

      const originalFetch = global.fetch;
      const mockFn = jest.fn() as jest.Mock<(...args: any[]) => any>;
      mockFn.mockImplementation(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/api/auth/login')) {
          return new Response(JSON.stringify(loginResponse), { status: 200 });
        }
        if (url.includes('/api/sync/projects/test-project/state')) {
          return new Response(JSON.stringify(projectStateResponse), { status: 200 });
        }
        if (url.includes('/api/sync/status')) {
          return new Response(JSON.stringify(syncStatusResponse), { status: 200 });
        }
        if (url.includes('/api/messages')) {
          return new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), {
            status: 200,
          });
        }
        return new Response('{}', { status: 200 });
      });
      global.fetch = mockFn as typeof global.fetch;

      try {
        RbookDetector.resetInstance();
        const result = await rbookAgentOnboardWithDb(scopedDbPath);
        expect(result.success).toBe(true);
        expect(result.data?.syncHealth).not.toBeNull();
        // Project-scoped: 1 sprint in PG, 1 in SQLite = match
        // 1 mission in PG, 1 in SQLite = match
        expect(result.data?.syncHealth?.allMatch).toBe(true);
        expect(result.data?.syncHealth?.totalMismatches).toBe(0);
        expect(result.data?.syncHealth?.failedEntries).toBe(2);

        // Verify project-scoped endpoint was called
        const urls = mockFn.mock.calls.map((c: any[]) =>
          typeof c[0] === 'string' ? c[0] : c[0]?.toString()
        );
        expect(urls.some((u: string) => u?.includes('/api/sync/projects/test-project/state'))).toBe(
          true
        );
      } finally {
        global.fetch = originalFetch;
        process.env.RBOOK_DASHBOARD_URL = originalUrl;
        process.env.RBOOK_DASHBOARD_USER = originalUser;
        process.env.RBOOK_DASHBOARD_PASSWORD = originalPassword;
        fs.rmSync(scopedTempDir, { recursive: true, force: true });
      }
    });
  });

  describe('sprint closeout guardrail', () => {
    it('suggests sprint closeout when all missions are completed', async () => {
      // Create a DB with all-completed missions
      const closeoutTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-onboard-closeout-'));
      const closeoutRbookDbDir = path.join(closeoutTempDir, 'rbook', 'db');
      fs.mkdirSync(closeoutRbookDbDir, { recursive: true });
      const closeoutDbPath = path.join(closeoutRbookDbDir, 'rbook.sqlite');

      const closeoutDb = new Database(closeoutDbPath);
      closeoutDb.exec(`
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
        CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);
        CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
        CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO metadata (key, value) VALUES ('project_id', 'test-uuid'), ('project_name', 'Test');
        INSERT INTO contexts (id, source_path, content, updated_at)
        VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{}', '2024-01-15T10:00:00Z');
        INSERT INTO sprints (id, title, status) VALUES ('sprint-99', 'All Done Sprint', 'Active');
        INSERT INTO missions (id, sprint_id, name, status, completed_at)
        VALUES
          ('m-01', 'sprint-99', 'Mission 1', 'Completed', '2024-02-01T10:00:00Z'),
          ('m-02', 'sprint-99', 'Mission 2', 'Completed', '2024-02-01T11:00:00Z');
      `);
      closeoutDb.close();

      RbookDetector.resetInstance();

      try {
        const result = await rbookAgentOnboardWithDb(closeoutDbPath);
        expect(result.success).toBe(true);
        const actions = result.data?.suggestedActions ?? [];
        const closeoutAction = actions.find((a) => a.action.includes('All missions complete'));
        expect(closeoutAction).toBeDefined();
        expect(closeoutAction?.command).toContain('sprint-99');
        expect(closeoutAction?.priority).toBe(1);
      } finally {
        fs.rmSync(closeoutTempDir, { recursive: true, force: true });
      }
    });

    it('does not suggest closeout when missions remain', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      const actions = result.data?.suggestedActions ?? [];
      const closeoutAction = actions.find((a) => a.action.includes('All missions complete'));
      expect(closeoutAction).toBeUndefined();
    });
  });

  describe('abandoned session detection (ops-m16)', () => {
    it('should surface each stale session as an individual priority-1 suggested action', async () => {
      // The default test DB has PS-2024-01-15-001 as active from 2024 — definitely stale
      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);

      const actions = result.data?.suggestedActions ?? [];
      const sessionActions = actions.filter((a) => a.action.includes('PS-2024-01-15-001'));

      expect(sessionActions).toHaveLength(1);
      expect(sessionActions[0].priority).toBe(1);
      expect(sessionActions[0].command).toContain('rbook_session');
      expect(sessionActions[0].command).toContain('complete');
      expect(sessionActions[0].command).toContain('PS-2024-01-15-001');
    });

    it('should create separate actions for multiple stale sessions', async () => {
      // Add a second stale session
      const staleDb = new Database(dbPath);
      const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      staleDb.exec(`
        INSERT INTO sessions (id, type, title, started_at, status, captures)
        VALUES ('PS-stale-002', 'custom', 'Forgotten Session', '${twoDaysAgo}', 'active', '[]');
      `);
      staleDb.close();
      RbookDetector.resetInstance();

      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);

      const actions = result.data?.suggestedActions ?? [];
      // s93-m01: "Complete active session" names its session by id too; it is not a cleanup action.
      const sessionActions = actions.filter(
        (a) =>
          a.command.includes('rbook_session') &&
          a.command.includes('sessionId') &&
          !a.action.startsWith('Complete active session')
      );

      // Should have at least 2 individual session actions (PS-2024-01-15-001 + PS-stale-002)
      expect(sessionActions.length).toBeGreaterThanOrEqual(2);
      expect(sessionActions.every((a) => a.priority === 1)).toBe(true);

      const commands = sessionActions.map((a) => a.command);
      expect(commands.some((c) => c.includes('PS-2024-01-15-001'))).toBe(true);
      expect(commands.some((c) => c.includes('PS-stale-002'))).toBe(true);
    });

    it('should not suggest session cleanup when no stale sessions exist', async () => {
      // Create a fresh DB with only a recently-started active session
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-no-stale-'));
      const freshDbDir = path.join(freshDir, 'rbook', 'db');
      fs.mkdirSync(freshDbDir, { recursive: true });
      const freshDbPath = path.join(freshDbDir, 'rbook.sqlite');
      const freshDb = new Database(freshDbPath);

      const now = new Date().toISOString();
      freshDb.exec(`
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
        CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);

        INSERT INTO sprints (id, title, status, focus) VALUES ('sprint-1', 'Sprint 1', 'Current', 'Focus');
        INSERT INTO missions (id, sprint_id, name, status, objective) VALUES ('m01', 'sprint-1', 'Task', 'In Progress', 'Do work');
        INSERT INTO contexts (id, source_path, content, updated_at) VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{"project":{"name":"Test","description":"Test project","status":"active"}}', '${now}');
        INSERT INTO sessions (id, type, title, started_at, status, captures) VALUES ('PS-fresh', 'custom', 'Fresh Session', '${now}', 'active', '[]');
      `);
      freshDb.close();
      RbookDetector.resetInstance();

      try {
        const result = await rbookAgentOnboardWithDb(freshDbPath);
        expect(result.success).toBe(true);

        const actions = result.data?.suggestedActions ?? [];
        const sessionCleanupActions = actions.filter(
          (a) =>
            a.command.includes('rbook_session') &&
            a.command.includes('complete') &&
            a.action.includes('stale')
        );
        expect(sessionCleanupActions).toHaveLength(0);
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // m03: Fresh project detection + tier-aware payload shaping
  // ---------------------------------------------------------------------------

  describe('fresh project detection', () => {
    function createFreshDb(): { projectRoot: string; dbPath: string; cleanup: () => void } {
      const freshTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-fresh-'));
      const freshDbDir = path.join(freshTempDir, 'rbook', 'db');
      fs.mkdirSync(freshDbDir, { recursive: true });
      const freshDbPath = path.join(freshDbDir, 'rbook.sqlite');
      const freshDb = new Database(freshDbPath);
      const now = new Date().toISOString();
      freshDb.exec(`
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
        CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);

        INSERT INTO contexts (id, source_path, content, updated_at)
        VALUES ('master_context', 'context/MASTER_CONTEXT.json',
          '{"project":{"name":"Fresh Project","description":"A new project","status":"active"}}',
          '${now}');
      `);
      freshDb.close();
      RbookDetector.resetInstance();
      return {
        projectRoot: freshTempDir,
        dbPath: freshDbPath,
        cleanup: () => fs.rmSync(freshTempDir, { recursive: true, force: true }),
      };
    }

    it('returns freshProject: true when no active missions and no PROJECT BRIEF', async () => {
      const env = createFreshDb();
      try {
        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.success).toBe(true);
        expect(result.data?.freshProject).toBe(true);
      } finally {
        env.cleanup();
      }
    });

    it('returns tierSelectionPrompt when freshProject is true', async () => {
      const env = createFreshDb();
      try {
        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.success).toBe(true);
        expect(result.data?.tierSelectionPrompt).toBeDefined();
        expect(typeof result.data?.tierSelectionPrompt).toBe('string');
        expect(result.data!.tierSelectionPrompt!.length).toBeGreaterThan(0);
      } finally {
        env.cleanup();
      }
    });

    it('returns freshProject: false when active missions exist', async () => {
      const result = await rbookAgentOnboardWithDb(dbPath);
      expect(result.success).toBe(true);
      expect(result.data?.freshProject).toBe(false);
      expect(result.data?.tierSelectionPrompt).toBeUndefined();
    });

    it('returns freshProject: false when master_context contains PROJECT BRIEF', async () => {
      const env = createFreshDb();
      try {
        const db = new Database(env.dbPath);
        db.prepare(`UPDATE contexts SET content = ? WHERE id = 'master_context'`).run(
          JSON.stringify({
            project: { name: 'Fresh Project' },
            project_brief: { goal: 'Build something great' },
          })
        );
        db.close();
        RbookDetector.resetInstance();

        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.success).toBe(true);
        expect(result.data?.freshProject).toBe(false);
      } finally {
        env.cleanup();
      }
    });

    it('returns freshProject: false when master_context contains "project brief" text', async () => {
      const env = createFreshDb();
      try {
        const db = new Database(env.dbPath);
        db.prepare(`UPDATE contexts SET content = ? WHERE id = 'master_context'`).run(
          JSON.stringify({
            project: { name: 'Fresh Project' },
            notes: 'See the project brief for full context',
          })
        );
        db.close();
        RbookDetector.resetInstance();

        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.success).toBe(true);
        expect(result.data?.freshProject).toBe(false);
      } finally {
        env.cleanup();
      }
    });

    it('includes a first-session suggested action when freshProject is true', async () => {
      const env = createFreshDb();
      try {
        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.success).toBe(true);
        const actions = result.data?.suggestedActions ?? [];
        const freshAction = actions.find((a) => a.action.includes('Fresh project detected'));
        expect(freshAction).toBeDefined();
        expect(freshAction?.priority).toBe(0);
      } finally {
        env.cleanup();
      }
    });

    it('tierSelectionPrompt contains build-tier guidance for build tier', async () => {
      const env = createFreshDb();
      try {
        const db = new Database(env.dbPath);
        db.prepare(`INSERT INTO metadata (key, value) VALUES ('project_type', 'build')`).run();
        db.close();
        RbookDetector.resetInstance();

        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.data?.tierSelectionPrompt).toContain('sprint');
      } finally {
        env.cleanup();
      }
    });

    it('tierSelectionPrompt contains general-tier guidance for general tier', async () => {
      const env = createFreshDb();
      try {
        const db = new Database(env.dbPath);
        db.prepare(`INSERT INTO metadata (key, value) VALUES ('project_type', 'general')`).run();
        db.close();
        RbookDetector.resetInstance();

        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        // s95-m06: the prompt names the level as init offers it (Ledger is the general tier).
        expect(result.data?.tierSelectionPrompt).toContain('fresh Reasonbook Ledger project');
      } finally {
        env.cleanup();
      }
    });

    it('tierSelectionPrompt contains managed-tier guidance for managed tier', async () => {
      const env = createFreshDb();
      try {
        const db = new Database(env.dbPath);
        db.prepare(`INSERT INTO metadata (key, value) VALUES ('project_type', 'managed')`).run();
        db.close();
        RbookDetector.resetInstance();

        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        // s95-m06: Planner is the managed tier's level name.
        expect(result.data?.tierSelectionPrompt).toContain('fresh Reasonbook Planner project');
      } finally {
        env.cleanup();
      }
    });
  });

  describe('managed Sprint Zero trigger (m04)', () => {
    function createManagedFreshDb(): { projectRoot: string; dbPath: string; cleanup: () => void } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-managed-fresh-'));
      const dbDir = path.join(dir, 'rbook', 'db');
      fs.mkdirSync(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, 'rbook.sqlite');
      const db = new Database(dbPath);
      const now = new Date().toISOString();
      db.exec(`
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
        CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);

        INSERT INTO metadata (key, value) VALUES ('project_type', 'managed');
        INSERT INTO contexts (id, source_path, content, updated_at)
        VALUES ('master_context', 'context/MASTER_CONTEXT.json',
          '{"project":{"name":"Client Project","description":"A managed project","status":"active"}}',
          '${now}');
      `);
      db.close();
      RbookDetector.resetInstance();
      return {
        projectRoot: dir,
        dbPath,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
      };
    }

    it('sets sprintZeroReady: true for fresh managed project', async () => {
      const env = createManagedFreshDb();
      try {
        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.success).toBe(true);
        expect(result.data?.freshProject).toBe(true);
        expect(result.data?.sprintZeroReady).toBe(true);
      } finally {
        env.cleanup();
      }
    });

    it('includes sprintZeroContext with three entry modes', async () => {
      const env = createManagedFreshDb();
      try {
        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.success).toBe(true);
        const ctx = result.data?.sprintZeroContext;
        expect(ctx).toBeDefined();
        expect(ctx?.entryModes).toHaveLength(3);
        expect(ctx?.routingQuestion).toBeDefined();
        expect(ctx?.description).toBeDefined();
      } finally {
        env.cleanup();
      }
    });

    it('entry modes cover client+deadline, problem/no strategy, idea-only', async () => {
      const env = createManagedFreshDb();
      try {
        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        const modes = result.data?.sprintZeroContext?.entryModes ?? [];
        const situations = modes.map((m) => m.situation.toLowerCase());
        expect(situations.some((s) => s.includes('client') || s.includes('deadline'))).toBe(true);
        expect(situations.some((s) => s.includes('problem') || s.includes('strategy'))).toBe(true);
        expect(situations.some((s) => s.includes('idea'))).toBe(true);
      } finally {
        env.cleanup();
      }
    });

    it('does NOT set sprintZeroReady for build tier fresh project', async () => {
      const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-build-fresh-'));
      const dbDir = path.join(buildDir, 'rbook', 'db');
      fs.mkdirSync(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, 'rbook.sqlite');
      const db = new Database(dbPath);
      const now = new Date().toISOString();
      db.exec(`
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
        CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);

        INSERT INTO contexts (id, source_path, content, updated_at)
        VALUES ('master_context', 'context/MASTER_CONTEXT.json',
          '{"project":{"name":"Build Project","description":"A build project","status":"active"}}',
          '${now}');
      `);
      db.close();
      RbookDetector.resetInstance();

      try {
        const result = await rbookAgentOnboard({ projectRoot: buildDir });
        expect(result.success).toBe(true);
        expect(result.data?.freshProject).toBe(true);
        expect(result.data?.sprintZeroReady).toBeUndefined();
        expect(result.data?.sprintZeroContext).toBeUndefined();
      } finally {
        fs.rmSync(buildDir, { recursive: true, force: true });
      }
    });

    it('does NOT set sprintZeroReady for managed project with existing active missions', async () => {
      const env = createManagedFreshDb();
      try {
        const db = new Database(env.dbPath);
        db.prepare(
          `INSERT INTO missions (id, sprint_id, name, status) VALUES ('m01', NULL, 'Task 1', 'Queued')`
        ).run();
        db.close();
        RbookDetector.resetInstance();

        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.success).toBe(true);
        expect(result.data?.freshProject).toBe(false);
        expect(result.data?.sprintZeroReady).toBeUndefined();
      } finally {
        env.cleanup();
      }
    });
  });

  describe('general tier first-session flow (m05)', () => {
    function createGeneralFreshDb(): { projectRoot: string; dbPath: string; cleanup: () => void } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-general-fresh-'));
      const dbDir = path.join(dir, 'rbook', 'db');
      fs.mkdirSync(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, 'rbook.sqlite');
      const db = new Database(dbPath);
      const now = new Date().toISOString();
      db.exec(`
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
        CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);

        INSERT INTO metadata (key, value) VALUES ('project_type', 'general');
        INSERT INTO contexts (id, source_path, content, updated_at)
        VALUES ('master_context', 'context/MASTER_CONTEXT.json',
          '{"project":{"name":"Personal Notes","description":"A thinking partner project","status":"active"}}',
          '${now}');
      `);
      db.close();
      RbookDetector.resetInstance();
      return {
        projectRoot: dir,
        dbPath,
        cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
      };
    }

    it('sets firstSessionPrompt for fresh general project', async () => {
      const env = createGeneralFreshDb();
      try {
        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.success).toBe(true);
        expect(result.data?.freshProject).toBe(true);
        expect(result.data?.firstSessionPrompt).toBeDefined();
        expect(typeof result.data?.firstSessionPrompt).toBe('string');
      } finally {
        env.cleanup();
      }
    });

    it('firstSessionPrompt includes opening-question guidance', async () => {
      const env = createGeneralFreshDb();
      try {
        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        const prompt = result.data?.firstSessionPrompt ?? '';
        // Should guide the agent to ask what the user is working on
        expect(prompt.toLowerCase()).toMatch(/working on|what.*you.*working|what are you/);
      } finally {
        env.cleanup();
      }
    });

    it('firstSessionPrompt mentions silent session start and capture behavior', async () => {
      const env = createGeneralFreshDb();
      try {
        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        const prompt = result.data?.firstSessionPrompt ?? '';
        // Should mention session and capture
        expect(prompt.toLowerCase()).toMatch(/session/);
        expect(prompt.toLowerCase()).toMatch(/capture|context|decision/);
      } finally {
        env.cleanup();
      }
    });

    it('does NOT set firstSessionPrompt for managed tier fresh project', async () => {
      const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-managed-nofsp-'));
      const dbDir = path.join(managedDir, 'rbook', 'db');
      fs.mkdirSync(dbDir, { recursive: true });
      const dbPath = path.join(dbDir, 'rbook.sqlite');
      const db = new Database(dbPath);
      const now = new Date().toISOString();
      db.exec(`
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
        CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);

        INSERT INTO metadata (key, value) VALUES ('project_type', 'managed');
        INSERT INTO contexts (id, source_path, content, updated_at)
        VALUES ('master_context', 'context/MASTER_CONTEXT.json',
          '{"project":{"name":"Managed Project","description":"A managed project","status":"active"}}',
          '${now}');
      `);
      db.close();
      RbookDetector.resetInstance();

      try {
        const result = await rbookAgentOnboard({ projectRoot: managedDir });
        expect(result.success).toBe(true);
        expect(result.data?.freshProject).toBe(true);
        expect(result.data?.firstSessionPrompt).toBeUndefined();
      } finally {
        fs.rmSync(managedDir, { recursive: true, force: true });
      }
    });

    it('does NOT set firstSessionPrompt for returning general project (active missions)', async () => {
      const env = createGeneralFreshDb();
      try {
        const db = new Database(env.dbPath);
        db.prepare(
          `INSERT INTO missions (id, sprint_id, name, status) VALUES ('m01', NULL, 'Open thread', 'Queued')`
        ).run();
        db.close();
        RbookDetector.resetInstance();

        const result = await rbookAgentOnboard({ projectRoot: env.projectRoot });
        expect(result.success).toBe(true);
        expect(result.data?.freshProject).toBe(false);
        expect(result.data?.firstSessionPrompt).toBeUndefined();
      } finally {
        env.cleanup();
      }
    });
  });

  describe('onboard_fields_hide tier suppression', () => {
    it('suppresses syncHealth for general tier (syncHealth in onboard_fields_hide)', async () => {
      // Create a project with general tier
      const generalTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-general-'));
      const generalDbDir = path.join(generalTempDir, 'rbook', 'db');
      fs.mkdirSync(generalDbDir, { recursive: true });
      const generalDbPath = path.join(generalDbDir, 'rbook.sqlite');
      const generalDb = new Database(generalDbPath);
      const now = new Date().toISOString();
      generalDb.exec(`
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
        CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
        CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);

        INSERT INTO metadata (key, value) VALUES ('project_type', 'general');
        INSERT INTO contexts (id, source_path, content, updated_at)
        VALUES ('master_context', 'context/MASTER_CONTEXT.json',
          '{"project":{"name":"General Project","description":"A general project","status":"active"}}',
          '${now}');
      `);
      generalDb.close();
      RbookDetector.resetInstance();

      try {
        const result = await rbookAgentOnboard({ projectRoot: generalTempDir });
        expect(result.success).toBe(true);
        // syncHealth is in onboard_fields_hide for general tier — should be null
        expect(result.data?.syncHealth).toBeNull();
        // currentSprint, pendingMissions, blockedMissions also hidden for general tier
        expect(result.data?.currentSprint).toBeNull();
        expect(result.data?.pendingMissions).toHaveLength(0);
        expect(result.data?.blockedMissions).toHaveLength(0);
      } finally {
        fs.rmSync(generalTempDir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Helper to run rbookAgentOnboard with explicit database path.
 */
async function rbookAgentOnboardWithDb(
  dbPath: string
): Promise<RbookToolResult<RbookAgentOnboardResult>> {
  const projectRoot = path.resolve(dbPath, '..', '..', '..');
  return rbookAgentOnboard({ projectRoot });
}

// ─── Sprint 57 m04: authState surface ────────────────────────────────────────

import { RBOOK_CONFIG_DIR_ENV, CredentialStore } from '../../../src/intelligence/credential-store';
import { recordDeliveryAck, resetDeliveryAckCache } from '../../../src/auth/delivery-ack-cache';

describe('rbook_agent_onboard authState (Sprint 57 m04)', () => {
  let tempDir: string;
  let credDir: string;
  let dbPath: string;
  const envKeysToClear = [
    'RBOOK_DASHBOARD_API_KEY',
    'RBOOK_DASHBOARD_USER',
    'RBOOK_DASHBOARD_PASSWORD',
  ];
  const preservedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-auth-state-'));
    credDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-auth-cred-'));
    // s86-m01: SAVE before overwriting. This afterEach used to `delete` this var
    // unconditionally and never restore it, which stripped the per-run tmpdir
    // that jest-global-setup provisions — after which CredentialStore and
    // ProjectGraphRegistry both fall back to the developer's real
    // ~/.config/cmos-mcp. This file is rank 2 of 180 by size, so it runs near the
    // start of a --runInBand run and isolation was gone for essentially the whole
    // suite. Same preservedEnv mechanism the credential vars below already use.
    preservedEnv[RBOOK_CONFIG_DIR_ENV] = process.env[RBOOK_CONFIG_DIR_ENV];
    process.env[RBOOK_CONFIG_DIR_ENV] = credDir;
    // Sprint 58 m02: authTier reads these env vars; clear them so the
    // "none" case is deterministic on developer machines that have legacy
    // dashboard credentials exported.
    for (const key of envKeysToClear) {
      preservedEnv[key] = process.env[key];
      delete process.env[key];
    }
    CredentialStore.resetInstance();
    resetDeliveryAckCache();

    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    dbPath = path.join(rbookDbDir, 'rbook.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, status TEXT, focus TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT, status TEXT NOT NULL DEFAULT 'active', summary TEXT, captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT);
      INSERT INTO contexts (id, source_path, content, updated_at) VALUES ('master_context', 'context/MASTER_CONTEXT.json', '{"project":{"name":"AuthDemo"}}', '2024-01-15T10:00:00Z');
    `);
    db.close();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    // s86-m01: restore rather than delete — see the beforeEach note.
    if (preservedEnv[RBOOK_CONFIG_DIR_ENV] === undefined) {
      delete process.env[RBOOK_CONFIG_DIR_ENV];
    } else {
      process.env[RBOOK_CONFIG_DIR_ENV] = preservedEnv[RBOOK_CONFIG_DIR_ENV];
    }
    for (const key of envKeysToClear) {
      if (preservedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = preservedEnv[key];
      }
    }
    CredentialStore.resetInstance();
    resetDeliveryAckCache();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (credDir) fs.rmSync(credDir, { recursive: true, force: true });
  });

  it('offers dashboard sign-in without making it a prerequisite for local initialization', async () => {
    const projectRoot = path.resolve(dbPath, '..', '..', '..');
    const result = await rbookAgentOnboard({ projectRoot });

    expect(result.success).toBe(true);
    expect(result.data?.authState).toBeDefined();
    expect(result.data?.authState?.identitySource).toBe('none');
    expect(result.data?.suggestedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.stringMatching(
            /Sign in to use dashboard messaging or sync; local project initialization needs no sign-in/
          ),
          command: 'rbook_auth(action="login_init"), then rbook_auth(action="login_complete")',
        }),
      ])
    );
  });

  it('attaches authState=request-body with rotation suggestedAction after a legacy deliveryAck', async () => {
    const store = await CredentialStore.create({ configDir: credDir });
    await store.upsertUserScopedKey('u', {
      key: 'cmk_user',
      label: 'l',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
    recordDeliveryAck('request-body');

    const projectRoot = path.resolve(dbPath, '..', '..', '..');
    const result = await rbookAgentOnboard({ projectRoot });

    expect(result.data?.authState?.identitySource).toBe('request-body');
    expect(result.data?.suggestedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.stringMatching(/legacy user-scoped/i),
        }),
      ])
    );
  });

  it('emits a "no project-scoped key for this root" suggestedAction when only user-scoped key is configured', async () => {
    const store = await CredentialStore.create({ configDir: credDir });
    await store.upsertUserScopedKey('u', {
      key: 'cmk_user',
      label: 'l',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });

    const projectRoot = path.resolve(dbPath, '..', '..', '..');
    const result = await rbookAgentOnboard({ projectRoot });

    expect(result.data?.authState?.identitySource).toBe('api-key');
    expect(result.data?.authState?.projectKey).toBeNull();
    expect(result.data?.suggestedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.stringMatching(/No project-scoped key for this project root/i),
        }),
      ])
    );
  });

  // ─── Sprint 58 m02: authTier-driven login suggestedActions ─────────────

  it('emits authTier="legacy-env" and a migration suggestedAction when only RBOOK_DASHBOARD_API_KEY is set', async () => {
    process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_legacy';
    const projectRoot = path.resolve(dbPath, '..', '..', '..');
    const result = await rbookAgentOnboard({ projectRoot });

    expect(result.data?.authState?.authTier).toBe('legacy-env');
    expect(result.data?.suggestedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.stringMatching(/Authenticating via legacy-env/),
          command: expect.stringMatching(
            /rbook_auth\(action="login_init"\), then rbook_auth\(action="login_complete"\)/
          ),
        }),
      ])
    );
  });

  it('emits authTier="password-fallback" and a migration suggestedAction when only USER+PASSWORD env vars are set', async () => {
    process.env.RBOOK_DASHBOARD_USER = 'u@example.com';
    process.env.RBOOK_DASHBOARD_PASSWORD = 'secret';
    const projectRoot = path.resolve(dbPath, '..', '..', '..');
    const result = await rbookAgentOnboard({ projectRoot });

    expect(result.data?.authState?.authTier).toBe('password-fallback');
    expect(result.data?.suggestedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: expect.stringMatching(/Authenticating via password-fallback/),
          command: expect.stringMatching(
            /rbook_auth\(action="login_init"\), then rbook_auth\(action="login_complete"\)/
          ),
        }),
      ])
    );
  });

  it('emits authTier="device-code" and no login suggestedAction when a user-scoped key is present', async () => {
    const store = await CredentialStore.create({ configDir: credDir });
    await store.upsertUserScopedKey('u', {
      key: 'cmk_user',
      label: 'l',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });

    const projectRoot = path.resolve(dbPath, '..', '..', '..');
    const result = await rbookAgentOnboard({ projectRoot });

    expect(result.data?.authState?.authTier).toBe('device-code');
    const loginActions = (result.data?.suggestedActions ?? []).filter((a) =>
      a.command?.includes('rbook_auth(action="login')
    );
    // No login suggestedAction — the "no project-scoped key" branch still
    // fires (priority 2), but it points at rbook_auth(action="reissue"), not login.
    expect(loginActions).toHaveLength(0);
  });
});
