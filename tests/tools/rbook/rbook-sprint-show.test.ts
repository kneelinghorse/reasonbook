/**
 * rbook_sprint_show Tool Tests
 *
 * Comprehensive tests for the sprint show tool.
 *
 * @module tests/tools/rbook/rbook-sprint-show
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookSprintShow,
  rbookSprintShowToolDefinition,
  formatSprintShowForLLM,
  type RbookSprintShowParams,
  type SprintShowResult,
} from '../../../src/tools/rbook/rbook-sprint-show';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import { SPRINT_SUMMARY_VIEW_SQL } from '../../../src/tools/rbook/schema';
import { PREVIEW_MAX_CHARS } from '../../../src/tools/rbook/text-preview';

describe('rbook_sprint_show', () => {
  let tempDir: string;
  let dbPath: string;
  let projectRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-sprint-show-test-'));
    projectRoot = tempDir;
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

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT REFERENCES sprints(id),
        snapshot_id INTEGER,
        project_domain TEXT,
        mission_id TEXT,
        session_id TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT,
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
        value TEXT
      );

      ${SPRINT_SUMMARY_VIEW_SQL}

      INSERT INTO sprints (id, title, focus, status, start_date, end_date)
      VALUES
        ('sprint-14', 'Sprint 14', 'Sprint CRUD Tools', 'Active', '2025-12-10', '2025-12-15'),
        ('sprint-13', 'Sprint 13', 'Session Tools', 'Completed', '2025-12-08', '2025-12-10');

      INSERT INTO missions (id, sprint_id, name, status, objective)
      VALUES
        ('s14-m01', 'sprint-14', 'Prune Tools', 'Completed', 'Remove deprecated tools'),
        ('s14-m02', 'sprint-14', 'Sprint CRUD', 'In Progress', 'Implement sprint tools'),
        ('s14-m03', 'sprint-14', 'Mission Creation', 'Queued', 'Add mission creation'),
        ('s13-m01', 'sprint-13', 'Lifecycle Tools', 'Completed', 'Implement lifecycle'),
        ('s13-m02', 'sprint-13', 'Context Tools', 'Completed', 'Implement context');

      INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, project_domain)
      VALUES ('Decision 1', '2025-12-12T09:00:00Z', 'sprint-14', 'cmos-mcp');

      INSERT INTO metadata (key, value) VALUES ('project_domain', 'cmos-mcp');
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
    it('should return sprint details with missions', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('sprint-14');
      expect(result.data?.title).toBe('Sprint 14');
      expect(result.data?.focus).toBe('Sprint CRUD Tools');
      expect(result.data?.status).toBe('Active');
      expect(result.data?.missions).toHaveLength(3);
    });

    it('should include correct mission statistics', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.totalMissions).toBe(3);
      expect(result.data?.completedMissions).toBe(1);
      expect(result.data?.activeMissions).toBe(1);
    });

    it('should include decisions count', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.decisionsCount).toBe(1);
      expect(result.data?.sessionDecisionsCount).toBe(0);
      expect(result.data?.totalDecisionsCount).toBe(1);
    });

    it('should include date range', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.startDate).toBe('2025-12-10');
      expect(result.data?.endDate).toBe('2025-12-15');
    });
  });

  describe('mission ordering', () => {
    it('should order missions by status priority', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      const statuses = result.data?.missions.map((m) => m.status);

      // In Progress first, then Queued, then Completed
      expect(statuses?.[0]).toBe('In Progress');
      expect(statuses?.[1]).toBe('Queued');
      expect(statuses?.[2]).toBe('Completed');
    });

    it('should expose session-derived decision counts when sprint sessions include uncopied decisions', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures)
         VALUES (?, 'review', 'Sprint review', 'sprint-14', '2025-12-12T10:00:00Z', '2025-12-12T11:00:00Z', 'completed', ?)`
      ).run(
        'review-14',
        JSON.stringify([
          {
            category: 'decision',
            content: 'Session-only sprint review decision',
            timestamp: '2025-12-12T11:00:00Z',
          },
        ])
      );
      db.close();

      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });

      expect(result.success).toBe(true);
      expect(result.data?.decisionsCount).toBe(1);
      expect(result.data?.sessionDecisionsCount).toBe(1);
      expect(result.data?.totalDecisionsCount).toBe(2);
    });
  });

  describe('error handling', () => {
    it('should return error for non-existent sprint', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.SPRINT_NOT_FOUND);
      expect(result.error?.suggestion).toContain('rbook_sprint');
    });

    it('should return error for missing sprintId', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
    });

    it('should return error when Reasonbook not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-rbook-'));

      try {
        const result = await rbookSprintShow({ sprintId: 'sprint-14', projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookSprintShowToolDefinition.name).toBe('rbook_sprint_show');
    });

    it('should require sprintId parameter', () => {
      expect(rbookSprintShowToolDefinition.inputSchema.required).toContain('sprintId');
    });

    it('should have description', () => {
      expect(rbookSprintShowToolDefinition.description).toBeTruthy();
      expect(rbookSprintShowToolDefinition.description).toContain('sprint');
    });
  });

  describe('formatSprintShowForLLM', () => {
    it('should format success result', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });
      const formatted = formatSprintShowForLLM(result);

      expect(formatted).toContain('Sprint: sprint-14');
      expect(formatted).toContain('Sprint 14');
      expect(formatted).toContain('Focus');
      expect(formatted).toContain('Progress');
      expect(formatted).toContain('Missions');
    });

    it('should format strategic and session-derived decision counts distinctly', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures)
         VALUES (?, 'review', 'Sprint review', 'sprint-14', '2025-12-12T10:00:00Z', '2025-12-12T11:00:00Z', 'completed', ?)`
      ).run(
        'review-14',
        JSON.stringify([
          {
            category: 'decision',
            content: 'Session-only sprint review decision',
            timestamp: '2025-12-12T11:00:00Z',
          },
        ])
      );
      db.close();

      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });
      const formatted = formatSprintShowForLLM(result);

      expect(formatted).toContain('1 strategic, 1 session-derived (2 total)');
    });

    it('should format error result', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'nonexistent' });
      const formatted = formatSprintShowForLLM(result);

      expect(formatted).toContain('❌');
      expect(formatted).toContain('Failed');
      expect(formatted).toContain('Suggestion');
    });

    it('should show mission details', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });
      const formatted = formatSprintShowForLLM(result);

      expect(formatted).toContain('s14-m01');
      expect(formatted).toContain('Prune Tools');
      expect(formatted).toContain('s14-m02');
    });

    it('should show status icons for missions', async () => {
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });
      const formatted = formatSprintShowForLLM(result);

      expect(formatted).toMatch(/[○◉◐✓⊘]/);
    });
  });

  describe('mission objectives are previews (s106-m03)', () => {
    it('cuts a long objective with its full length and names mission show, keeping the focus whole', async () => {
      // A registered store's 12-mission sprint showed 41,257 characters of objectives in full.
      const long = 'objective '.repeat(80).trim();
      const db = new Database(dbPath);
      db.prepare("UPDATE missions SET objective = ? WHERE id = 's14-m02'").run(long);
      db.prepare("UPDATE sprints SET focus = ? WHERE id = 'sprint-14'").run(long);
      db.close();
      const result = await rbookSprintShowWithDb(dbPath, { sprintId: 'sprint-14' });
      const mission = result.data!.missions.find((m) => m.id === 's14-m02')!;
      expect(mission).toMatchObject({ objectiveTruncated: true, objectiveFullLength: long.length });
      expect(mission.objective!.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      expect(result.data!.missions.find((m) => m.id === 's14-m01')).toMatchObject({
        objective: 'Remove deprecated tools',
        objectiveTruncated: false,
      });
      // Show is where a sprint is read whole: its own focus is not cut.
      expect(result.data!.focus).toBe(long);
      expect(formatSprintShowForLLM(result)).toContain(
        'rbook_mission(action="show", missionId="s14-m02")'
      );
    });
  });
});

/**
 * Helper to run rbookSprintShow with explicit database path.
 */
async function rbookSprintShowWithDb(
  dbPath: string,
  params: RbookSprintShowParams
): Promise<RbookToolResult<SprintShowResult>> {
  return rbookSprintShow({
    ...params,
    projectRoot: path.dirname(path.dirname(path.dirname(dbPath))),
  });
}
