/**
 * rbook_sprint_list Tool Tests
 *
 * Comprehensive tests for the sprint listing tool.
 *
 * @module tests/tools/rbook/rbook-sprint-list
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookSprintList,
  rbookSprintListToolDefinition,
  formatSprintListForLLM,
  type RbookSprintListParams,
  type RbookSprintListResult,
} from '../../../src/tools/rbook/rbook-sprint-list';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import { SPRINT_SUMMARY_VIEW_SQL } from '../../../src/tools/rbook/schema';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import { PREVIEW_MAX_CHARS } from '../../../src/tools/rbook/text-preview';

describe('rbook_sprint_list', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary directory and database for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-sprint-list-test-'));
    dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Create a test database with comprehensive schema and data
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
        id TEXT PRIMARY KEY,
        sprint_id TEXT REFERENCES sprints(id),
        decision TEXT,
        context TEXT
      );

      -- Create sprint_summary view
      ${SPRINT_SUMMARY_VIEW_SQL}

      -- Insert test sprints
      INSERT INTO sprints (id, title, focus, status, start_date, end_date)
      VALUES
        ('sprint-14', 'Sprint 14', 'Sprint CRUD Tools', 'Active', '2025-12-10', '2025-12-15'),
        ('sprint-13', 'Sprint 13', 'Session Tools', 'Completed', '2025-12-08', '2025-12-10'),
        ('sprint-12', 'Sprint 12', 'Foundation', 'Completed', '2025-12-05', '2025-12-08'),
        ('sprint-11', 'Sprint 11', 'Legacy', 'Completed', NULL, NULL);

      -- Insert test missions
      INSERT INTO missions (id, sprint_id, name, status)
      VALUES
        ('s14-m01', 'sprint-14', 'Prune Tools', 'Completed'),
        ('s14-m02', 'sprint-14', 'Sprint CRUD', 'In Progress'),
        ('s13-m01', 'sprint-13', 'Lifecycle Tools', 'Completed'),
        ('s13-m02', 'sprint-13', 'Context Tools', 'Completed'),
        ('s12-m01', 'sprint-12', 'Identity', 'Completed'),
        ('s12-m02', 'sprint-12', 'Blocked Test', 'Blocked');

      -- Insert test strategic decisions
      INSERT INTO strategic_decisions (id, sprint_id, decision)
      VALUES
        ('d1', 'sprint-14', 'Decision 1'),
        ('d2', 'sprint-14', 'Decision 2');
    `);
    db.close();

    // Reset RbookDetector cache before each test
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic listing', () => {
    it('should list all sprints when no filters applied', async () => {
      const result = await rbookSprintListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(4);
      expect(result.data?.totalCount).toBe(4);
    });

    it('should return empty list for empty database', async () => {
      const emptyDbPath = path.join(tempDir, 'empty', 'rbook', 'db', 'rbook.sqlite');
      fs.mkdirSync(path.dirname(emptyDbPath), { recursive: true });
      const db = new Database(emptyDbPath);
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
          sprint_id TEXT,
          name TEXT NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE strategic_decisions (id TEXT PRIMARY KEY, sprint_id TEXT);
        CREATE VIEW sprint_summary AS
        SELECT s.id AS sprint_id, s.title, s.status, s.focus, s.start_date, s.end_date,
               0 AS total_missions, 0 AS completed_missions, 0 AS blocked_missions,
               0 AS active_missions, 0 AS parked_missions, 0 AS decisions_count
        FROM sprints s;
      `);
      db.close();

      const result = await rbookSprintListWithDb(emptyDbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });

    it('should respect limit parameter', async () => {
      const result = await rbookSprintListWithDb(dbPath, { limit: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(2);
      expect(result.data?.totalCount).toBe(4);
      expect(result.data?.filters.limit).toBe(2);
    });

    it('should use default limit of 15 (s106-m03: 20 previewed rows were 20,513 characters)', async () => {
      const result = await rbookSprintListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.filters.limit).toBe(15);
    });
  });

  describe('status filtering', () => {
    it('should filter by Active status', async () => {
      const result = await rbookSprintListWithDb(dbPath, { status: 'Active' });

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(1);
      expect(result.data?.sprints[0].id).toBe('sprint-14');
      expect(result.data?.filters.status).toBe('Active');
    });

    it('should filter by Completed status', async () => {
      const result = await rbookSprintListWithDb(dbPath, { status: 'Completed' });

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(3);
      expect(result.data?.sprints.every((s) => s.status === 'Completed')).toBe(true);
    });

    it('should return empty for status with no matches', async () => {
      const result = await rbookSprintListWithDb(dbPath, { status: 'Planned' });

      expect(result.success).toBe(true);
      expect(result.data?.sprints).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });
  });

  describe('mission statistics', () => {
    it('should include correct total missions count', async () => {
      const result = await rbookSprintListWithDb(dbPath, { status: 'Active' });

      expect(result.success).toBe(true);
      const sprint14 = result.data?.sprints[0];
      expect(sprint14?.totalMissions).toBe(2);
    });

    it('should include correct completed missions count', async () => {
      const result = await rbookSprintListWithDb(dbPath, { status: 'Active' });

      expect(result.success).toBe(true);
      const sprint14 = result.data?.sprints[0];
      expect(sprint14?.completedMissions).toBe(1);
    });

    it('should include correct active missions count', async () => {
      const result = await rbookSprintListWithDb(dbPath, { status: 'Active' });

      expect(result.success).toBe(true);
      const sprint14 = result.data?.sprints[0];
      expect(sprint14?.activeMissions).toBe(1); // 1 In Progress
    });

    it('should include blocked missions count', async () => {
      const result = await rbookSprintListWithDb(dbPath, {});
      const sprint12 = result.data?.sprints.find((s) => s.id === 'sprint-12');

      expect(sprint12?.blockedMissions).toBe(1);
    });

    it('should include decisions count', async () => {
      const result = await rbookSprintListWithDb(dbPath, { status: 'Active' });

      expect(result.success).toBe(true);
      const sprint14 = result.data?.sprints[0];
      expect(sprint14?.decisionsCount).toBe(2);
    });
  });

  describe('ordering', () => {
    it('should order by start_date descending (most recent first)', async () => {
      const result = await rbookSprintListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const ids = result.data?.sprints.map((s) => s.id);

      // sprint-14 has most recent start_date, sprint-11 has null
      expect(ids?.[0]).toBe('sprint-14');
      expect(ids?.[ids.length - 1]).toBe('sprint-11'); // null dates last
    });
  });

  describe('pages (s106-m03)', () => {
    const longFocus = 'focus '.repeat(120).trim();

    beforeEach(() => {
      const db = new Database(dbPath);
      db.prepare("UPDATE sprints SET focus = ? WHERE id = 'sprint-14'").run(longFocus);
      db.close();
    });

    it('previews a long focus, says how to read it whole, and keeps every other field', async () => {
      // OODS-Forge's sprint focus averages 1.7K characters; 20 of them made 30,351.
      const result = await rbookSprintListWithDb(dbPath, {});
      const sprint = result.data!.sprints.find((s) => s.id === 'sprint-14')!;
      expect(sprint).toMatchObject({
        focusTruncated: true,
        focusFullLength: longFocus.length,
        totalMissions: 2,
        decisionsCount: 2,
      });
      expect(sprint.focus!.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      expect(result.data!.sprints.find((s) => s.id === 'sprint-13')).toMatchObject({
        focus: 'Session Tools',
        focusTruncated: false,
      });
      expect(formatSprintListForLLM(result)).toContain(
        'rbook_sprint(action="show", sprintId="sprint-14")'
      );
    });

    it('reaches every sprint once through the next pages, with the filters repeated', async () => {
      const seen: string[] = [];
      let page: number | null = 1;
      while (page !== null) {
        const result = (await rbookSprint({
          action: 'list',
          limit: 3,
          page,
          projectRoot: tempDir,
        } as never)) as RbookToolResult<RbookSprintListResult>;
        seen.push(...result.data!.sprints.map((s) => s.id));
        expect(result.data!.totalCount).toBe(4);
        page = result.data!.nextPage;
        if (page !== null)
          expect(formatSprintListForLLM(result)).toContain(
            `Next page: rbook_sprint(action="list", limit=3, projectRoot=${JSON.stringify(tempDir)}, page=${page}).`
          );
      }
      expect(seen).toEqual(['sprint-14', 'sprint-13', 'sprint-12', 'sprint-11']);
    });
  });

  describe('error handling', () => {
    it('should return error when Reasonbook not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-rbook-'));

      try {
        const result = await rbookSprintList({ projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
        expect(result.error?.suggestion).toBeDefined();
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookSprintListToolDefinition.name).toBe('rbook_sprint_list');
    });

    it('should have description', () => {
      expect(rbookSprintListToolDefinition.description).toBeTruthy();
      expect(rbookSprintListToolDefinition.description).toContain('sprint');
    });

    it('should have valid input schema', () => {
      expect(rbookSprintListToolDefinition.inputSchema.type).toBe('object');
      expect(rbookSprintListToolDefinition.inputSchema.properties).toBeDefined();
      expect(rbookSprintListToolDefinition.inputSchema.properties.status).toBeDefined();
      expect(rbookSprintListToolDefinition.inputSchema.properties.limit).toBeDefined();
    });
  });

  describe('formatSprintListForLLM', () => {
    it('should format success result', async () => {
      const result = await rbookSprintListWithDb(dbPath, {});
      const formatted = formatSprintListForLLM(result);

      expect(formatted).toContain('Sprints');
      expect(formatted).toContain('sprint-14');
      expect(formatted).toContain('Progress');
    });

    it('should format error result', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-test-'));

      try {
        const result = await rbookSprintList({ projectRoot: emptyDir });
        const formatted = formatSprintListForLLM(result);

        expect(formatted).toContain('❌');
        expect(formatted).toContain('Failed');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should show status icons', async () => {
      const result = await rbookSprintListWithDb(dbPath, {});
      const formatted = formatSprintListForLLM(result);

      // Check for various status icons
      expect(formatted).toMatch(/[○◉✓•]/);
    });

    it('should show message for empty results', async () => {
      const result = await rbookSprintListWithDb(dbPath, { status: 'nonexistent' });
      const formatted = formatSprintListForLLM(result);

      expect(formatted).toContain('No sprints found');
    });
  });
});

/**
 * Helper to run the shipped rbookSprintList against the fixture's store.
 * s95-m09: it used to hold its own copy of the handler (its sprint_summary SQL), so these cases
 * tested that copy rather than shipped code. It now maps the store path
 * (<root>/rbook/db/rbook.sqlite) to its project root and calls the handler.
 */
async function rbookSprintListWithDb(
  dbPath: string,
  params: Omit<RbookSprintListParams, 'projectRoot'>
): Promise<RbookToolResult<RbookSprintListResult>> {
  return rbookSprintList({
    ...params,
    projectRoot: path.dirname(path.dirname(path.dirname(dbPath))),
  });
}
