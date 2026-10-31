/**
 * rbook_mission_list Tool Tests
 *
 * Comprehensive tests for the mission listing tool.
 *
 * @module tests/tools/rbook/rbook-mission-list
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookMissionList,
  rbookMissionListToolDefinition,
  formatMissionListForLLM,
  type RbookMissionListParams,
  type RbookMissionListResult,
} from '../../../src/tools/rbook/rbook-mission-list';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { rbookMission } from '../../../src/tools/rbook/rbook-mission';
import { PREVIEW_MAX_CHARS } from '../../../src/tools/rbook/text-preview';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { RbookToolResult } from '../../../src/tools/rbook/types';

describe('rbook_mission_list', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a temporary directory and database for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-mission-list-test-'));
    dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    // Create a test database with comprehensive schema and data
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

      -- Insert test sprints
      INSERT INTO sprints (id, title, status)
      VALUES
        ('sprint-11', 'Sprint 11', 'Completed'),
        ('sprint-12', 'Sprint 12', 'planning');

      -- Insert test missions with various statuses and sprints
      INSERT INTO missions (id, sprint_id, name, status, objective, success_criteria, deliverables, completed_at, notes)
      VALUES
        ('s11-m01', 'sprint-11', 'Completed Mission 1', 'Completed', 'First objective', '["Criterion 1", "Criterion 2"]', '["File1.ts"]', '2024-01-01T10:00:00Z', 'Completed with notes'),
        ('s11-m02', 'sprint-11', 'Completed Mission 2', 'Completed', 'Second objective', '["Criterion A"]', '["File2.ts", "File3.ts"]', '2024-01-02T10:00:00Z', NULL),
        ('s12-m01', 'sprint-12', 'Current Mission', 'Current', 'Current sprint objective', NULL, NULL, NULL, NULL),
        ('s12-m02', 'sprint-12', 'In Progress Mission', 'In Progress', 'Work in progress', '["Success 1"]', '["output.ts"]', NULL, 'Being worked on'),
        ('s12-m03', 'sprint-12', 'Queued Mission 1', 'Queued', 'Waiting to start', NULL, NULL, NULL, NULL),
        ('s12-m04', 'sprint-12', 'Queued Mission 2', 'Queued', 'Also waiting', '["Done when X"]', NULL, NULL, NULL),
        ('s12-m05', 'sprint-12', 'Blocked Mission', 'Blocked', 'Cannot proceed', NULL, NULL, NULL, 'Blocked by dependency'),
        ('standalone', NULL, 'Standalone Mission', 'Queued', 'No sprint', NULL, NULL, NULL, NULL);
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
    it('should list the first page of missions when no filters applied', async () => {
      const resultWithDb = await rbookMissionListWithDb(dbPath, {});

      expect(resultWithDb.success).toBe(true);
      expect(resultWithDb.data?.missions).toHaveLength(6);
      expect(resultWithDb.data?.totalCount).toBe(8);
    });

    it('should return empty list for empty database', async () => {
      // Create empty database
      const emptyDbPath = path.join(tempDir, 'empty', 'rbook', 'db', 'rbook.sqlite');
      fs.mkdirSync(path.dirname(emptyDbPath), { recursive: true });
      const db = new Database(emptyDbPath);
      db.exec(`
        CREATE TABLE missions (
          id TEXT PRIMARY KEY,
          sprint_id TEXT,
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
      `);
      db.close();

      const result = await rbookMissionListWithDb(emptyDbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });

    it('should respect limit parameter', async () => {
      const result = await rbookMissionListWithDb(dbPath, { limit: 3 });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(3);
      expect(result.data?.totalCount).toBe(8); // Total is still 8
      expect(result.data?.filters.limit).toBe(3);
    });

    it('should use default limit of 6 (s106-m03: 20 rows were 56,988 characters, 8 still 21,750)', async () => {
      const result = await rbookMissionListWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.filters.limit).toBe(6);
    });
  });

  describe('status filtering', () => {
    it('should filter by Queued status', async () => {
      const result = await rbookMissionListWithDb(dbPath, { status: 'Queued' });

      expect(result.success).toBe(true);
      expect(result.data?.missions.every((m) => m.status === 'Queued')).toBe(true);
      expect(result.data?.missions).toHaveLength(3); // s12-m03, s12-m04, standalone
      expect(result.data?.totalCount).toBe(3);
      expect(result.data?.filters.status).toBe('Queued');
    });

    it('should filter by Current status', async () => {
      const result = await rbookMissionListWithDb(dbPath, { status: 'Current' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(1);
      expect(result.data?.missions[0].id).toBe('s12-m01');
      expect(result.data?.filters.status).toBe('Current');
    });

    it('should filter by In Progress status', async () => {
      const result = await rbookMissionListWithDb(dbPath, { status: 'In Progress' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(1);
      expect(result.data?.missions[0].id).toBe('s12-m02');
    });

    it('should filter by Completed status', async () => {
      const result = await rbookMissionListWithDb(dbPath, { status: 'Completed' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(2);
      expect(result.data?.missions.map((m) => m.id)).toContain('s11-m01');
      expect(result.data?.missions.map((m) => m.id)).toContain('s11-m02');
    });

    it('should filter by Blocked status', async () => {
      const result = await rbookMissionListWithDb(dbPath, { status: 'Blocked' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(1);
      expect(result.data?.missions[0].id).toBe('s12-m05');
    });

    it('should return empty for status with no matches', async () => {
      // Remove all blocked missions
      const db = new Database(dbPath);
      db.exec("DELETE FROM missions WHERE status = 'Blocked'");
      db.close();

      const result = await rbookMissionListWithDb(dbPath, { status: 'Blocked' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });
  });

  describe('sprint filtering', () => {
    it('should filter by sprint ID', async () => {
      const result = await rbookMissionListWithDb(dbPath, { sprintId: 'sprint-12' });

      expect(result.success).toBe(true);
      expect(result.data?.missions.every((m) => m.sprintId === 'sprint-12')).toBe(true);
      expect(result.data?.missions).toHaveLength(5);
      expect(result.data?.filters.sprintId).toBe('sprint-12');
    });

    it('should filter by different sprint ID', async () => {
      const result = await rbookMissionListWithDb(dbPath, { sprintId: 'sprint-11' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(2);
      expect(result.data?.missions.every((m) => m.sprintId === 'sprint-11')).toBe(true);
    });

    it('should return empty for non-existent sprint', async () => {
      const result = await rbookMissionListWithDb(dbPath, { sprintId: 'sprint-99' });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(0);
      expect(result.data?.totalCount).toBe(0);
    });

    it('should find missions with null sprint when filtering for null (via SQL)', async () => {
      // This tests that standalone missions can be found
      const result = await rbookMissionListWithDb(dbPath, { limit: 20 });

      expect(result.success).toBe(true);
      const standaloneMission = result.data?.missions.find((m) => m.id === 'standalone');
      expect(standaloneMission).toBeDefined();
      expect(standaloneMission?.sprintId).toBeNull();
    });
  });

  describe('combined filters', () => {
    it('should filter by both status and sprint', async () => {
      const result = await rbookMissionListWithDb(dbPath, {
        status: 'Queued',
        sprintId: 'sprint-12',
      });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(2); // s12-m03, s12-m04 (not standalone)
      expect(result.data?.missions.every((m) => m.status === 'Queued')).toBe(true);
      expect(result.data?.missions.every((m) => m.sprintId === 'sprint-12')).toBe(true);
    });

    it('should filter by status, sprint, and limit', async () => {
      const result = await rbookMissionListWithDb(dbPath, {
        status: 'Queued',
        sprintId: 'sprint-12',
        limit: 1,
      });

      expect(result.success).toBe(true);
      expect(result.data?.missions).toHaveLength(1);
      expect(result.data?.totalCount).toBe(2); // Total matching is 2
    });
  });

  describe('JSON field parsing', () => {
    it('should parse success_criteria JSON array', async () => {
      const result = await rbookMissionListWithDb(dbPath, { status: 'Completed' });

      expect(result.success).toBe(true);
      const m1 = result.data?.missions.find((m) => m.id === 's11-m01');
      expect(m1?.successCriteria).toEqual(['Criterion 1', 'Criterion 2']);
    });

    it('should parse deliverables JSON array', async () => {
      const result = await rbookMissionListWithDb(dbPath, { status: 'Completed' });

      expect(result.success).toBe(true);
      const m2 = result.data?.missions.find((m) => m.id === 's11-m02');
      expect(m2?.deliverables).toEqual(['File2.ts', 'File3.ts']);
    });

    it('should return null for null JSON fields', async () => {
      const result = await rbookMissionListWithDb(dbPath, { status: 'Current' });

      expect(result.success).toBe(true);
      expect(result.data?.missions[0].successCriteria).toBeNull();
      expect(result.data?.missions[0].deliverables).toBeNull();
    });

    it('should return null for invalid JSON', async () => {
      // Insert mission with invalid JSON
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, name, status, success_criteria)
        VALUES ('bad-json', 'Bad JSON Mission', 'Queued', 'not valid json');
      `);
      db.close();

      const result = await rbookMissionListWithDb(dbPath, { limit: 20 });

      expect(result.success).toBe(true);
      const badMission = result.data?.missions.find((m) => m.id === 'bad-json');
      expect(badMission?.successCriteria).toBeNull();
    });
  });

  describe('ordering', () => {
    it('should order by sprint (descending) then id (ascending)', async () => {
      const result = await rbookMissionListWithDb(dbPath, { limit: 20 });

      expect(result.success).toBe(true);
      const ids = result.data?.missions.map((m) => m.id);

      // sprint-12 missions should come first (sorted by id)
      // then sprint-11 missions
      // then null sprint missions last
      expect(ids?.indexOf('s12-m01')).toBeLessThan(ids?.indexOf('s11-m01') ?? Infinity);
      expect(ids?.indexOf('standalone')).toBe((ids?.length ?? 0) - 1);
    });
  });

  describe('error handling', () => {
    it('should return error when Reasonbook not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-rbook-'));

      try {
        const result = await rbookMissionList({ projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
        expect(result.error?.suggestion).toBeDefined();
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should return error for missing missions table', async () => {
      const badDbPath = path.join(tempDir, 'bad', 'rbook', 'db', 'rbook.sqlite');
      fs.mkdirSync(path.dirname(badDbPath), { recursive: true });
      const db = new Database(badDbPath);
      db.exec('CREATE TABLE other (id TEXT);');
      db.close();

      const result = await rbookMissionListWithDb(badDbPath, {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookMissionListToolDefinition.name).toBe('rbook_mission_list');
    });

    it('should have description', () => {
      expect(rbookMissionListToolDefinition.description).toBeTruthy();
      expect(rbookMissionListToolDefinition.description).toContain('mission');
    });

    it('should have valid input schema', () => {
      expect(rbookMissionListToolDefinition.inputSchema.type).toBe('object');
      expect(rbookMissionListToolDefinition.inputSchema.properties).toBeDefined();
      expect(rbookMissionListToolDefinition.inputSchema.properties.status).toBeDefined();
      expect(rbookMissionListToolDefinition.inputSchema.properties.sprintId).toBeDefined();
      expect(rbookMissionListToolDefinition.inputSchema.properties.limit).toBeDefined();
    });

    it('should have status enum with all valid values', () => {
      const statusProp = rbookMissionListToolDefinition.inputSchema.properties.status;
      expect(statusProp.enum).toContain('Queued');
      expect(statusProp.enum).toContain('Current');
      expect(statusProp.enum).toContain('In Progress');
      expect(statusProp.enum).toContain('Completed');
      expect(statusProp.enum).toContain('Blocked');
    });
  });

  describe('formatMissionListForLLM', () => {
    it('should format success result', async () => {
      const result = await rbookMissionListWithDb(dbPath, { status: 'Completed' });
      const formatted = formatMissionListForLLM(result);

      expect(formatted).toContain('Missions');
      expect(formatted).toContain('status=Completed');
      expect(formatted).toContain('sprint-11');
      expect(formatted).toContain('s11-m01');
    });

    it('should format error result', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-test-'));

      try {
        const result = await rbookMissionList({ projectRoot: emptyDir });
        const formatted = formatMissionListForLLM(result);

        expect(formatted).toContain('❌');
        expect(formatted).toContain('Failed');
        expect(formatted).toContain('Suggestion');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should show filter information', async () => {
      const result = await rbookMissionListWithDb(dbPath, {
        status: 'Queued',
        sprintId: 'sprint-12',
      });
      const formatted = formatMissionListForLLM(result);

      expect(formatted).toContain('status=Queued');
      expect(formatted).toContain('sprint=sprint-12');
    });

    it('should show message for empty results', async () => {
      const result = await rbookMissionListWithDb(dbPath, { sprintId: 'nonexistent' });
      const formatted = formatMissionListForLLM(result);

      expect(formatted).toContain('No missions found');
    });

    it('should group missions by sprint', async () => {
      const result = await rbookMissionListWithDb(dbPath, { limit: 20 });
      const formatted = formatMissionListForLLM(result);

      expect(formatted).toContain('**sprint-12**');
      expect(formatted).toContain('**sprint-11**');
      expect(formatted).toContain('**(no sprint)**');
    });

    it('should show status icons', async () => {
      const result = await rbookMissionListWithDb(dbPath, {});
      const formatted = formatMissionListForLLM(result);

      // Check for various status icons
      expect(formatted).toMatch(/[○◉◐✓⊘]/);
    });

    it('should truncate long objectives', async () => {
      // Add mission with long objective
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO missions (id, name, status, objective)
        VALUES ('long-obj', 'Long Objective', 'Queued', '${`x`.repeat(100)}');
      `);
      db.close();

      const result = await rbookMissionListWithDb(dbPath, { status: 'Queued' });
      const formatted = formatMissionListForLLM(result);

      expect(formatted).toContain('...');
    });
  });
});

/**
 * Helper to run the shipped rbookMissionList against the fixture's store.
 * s95-m09: it used to hold its own copy of the handler (validation, count and list SQL), so these
 * cases tested that copy rather than shipped code. It now maps the store path
 * (<root>/rbook/db/rbook.sqlite) to its project root and calls the handler.
 */
async function rbookMissionListWithDb(
  dbPath: string,
  params: Omit<RbookMissionListParams, 'projectRoot'>
): Promise<RbookToolResult<RbookMissionListResult>> {
  return rbookMissionList({
    ...params,
    projectRoot: path.dirname(path.dirname(path.dirname(dbPath))),
  });
}

describe('rbook_mission list pages (s106-m03)', () => {
  let root: string;
  const long = (label: string, n: number): string => `${label} `.repeat(n).trim();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-mission-pages-'));
    const dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE missions (
      id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL,
      completed_at TEXT, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT,
      deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT
    )`);
    const insert = db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, objective, notes, success_criteria)
       VALUES (?, 'sprint-7', ?, 'Queued', ?, ?, ?)`
    );
    for (let i = 1; i <= 11; i++)
      insert.run(
        `s7-m${String(i).padStart(2, '0')}`,
        `Mission ${i}`,
        i === 1 ? long('objective', 100) : `Objective ${i}`,
        i === 1 ? long('notes', 200) : null,
        JSON.stringify([`Criterion ${i}`])
      );
    db.close();
    RbookDetector.resetInstance();
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  async function list(params: Record<string, unknown>) {
    return rbookMission({ action: 'list', projectRoot: root, ...params } as never) as Promise<
      RbookToolResult<RbookMissionListResult>
    >;
  }

  it('returns 6 missions by default with previews, and mission show still returns the full text', async () => {
    // OODS-Forge's default 20 rows were 56,988 characters: notes average 1,640 characters there.
    const result = await list({});
    expect(result.data).toMatchObject({ totalCount: 11, page: 1, hasMore: true, nextPage: 2 });
    expect(result.data?.missions).toHaveLength(6);
    const first = result.data!.missions[0];
    expect(first).toMatchObject({
      objectiveTruncated: true,
      objectiveFullLength: long('objective', 100).length,
      notesTruncated: true,
      notesFullLength: long('notes', 200).length,
      successCriteria: ['Criterion 1'],
    });
    expect(first.objective!.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(first.notes!.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(result.data!.missions[1]).toMatchObject({
      objective: 'Objective 2',
      objectiveTruncated: false,
      notes: null,
      notesTruncated: false,
    });
    const text = formatMissionListForLLM(result);
    expect(text).toContain('showing 1–6 of 11');
    expect(text).toContain(
      `Next page: rbook_mission(action="list", projectRoot=${JSON.stringify(root)}, page=2).`
    );
    expect(text).toContain('rbook_mission(action="show", missionId="s7-m01")');
    const shown = (await rbookMission({
      action: 'show',
      missionId: 's7-m01',
      projectRoot: root,
    } as never)) as RbookToolResult<{ mission?: { notes?: string }; notes?: string }>;
    expect(JSON.stringify(shown.data)).toContain(long('notes', 200));
  });

  it('keeps the first three success criteria and deliverables of a mission, with their counts', async () => {
    // oods-foundry.com's newest eight missions held 7 to 16 criteria each: 29,033 characters.
    const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'));
    db.prepare(
      `UPDATE missions SET success_criteria = ?, deliverables = ? WHERE id = 's7-m02'`
    ).run(
      JSON.stringify(Array.from({ length: 6 }, (_, i) => `Criterion ${i + 1}`)),
      JSON.stringify(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    );
    db.close();
    const result = await list({});
    const mission = result.data!.missions.find((m) => m.id === 's7-m02')!;
    expect(mission).toMatchObject({
      successCriteria: ['Criterion 1', 'Criterion 2', 'Criterion 3'],
      successCriteriaCount: 6,
      deliverables: ['a.ts', 'b.ts', 'c.ts'],
      deliverablesCount: 4,
    });
    expect(result.data!.missions.find((m) => m.id === 's7-m03')).toMatchObject({
      successCriteria: ['Criterion 3'],
      successCriteriaCount: 1,
      deliverables: null,
      deliverablesCount: 0,
    });
    const shown = (await rbookMission({
      action: 'show',
      missionId: 's7-m02',
      projectRoot: root,
    } as never)) as RbookToolResult<unknown>;
    expect(JSON.stringify(shown.data)).toContain('Criterion 6');
  });

  it('reaches every mission exactly once, in list order, through the next pages', async () => {
    const seen: string[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const result = await list({ sprintId: 'sprint-7', limit: 4, page });
      seen.push(...result.data!.missions.map((m) => m.id));
      page = result.data!.nextPage;
      if (page !== null)
        expect(formatMissionListForLLM(result)).toContain(
          `Next page: rbook_mission(action="list", sprintId="sprint-7", limit=4, projectRoot=${JSON.stringify(root)}, page=${page}).`
        );
    }
    expect(seen).toEqual(
      Array.from({ length: 11 }, (_, i) => `s7-m${String(i + 1).padStart(2, '0')}`)
    );
  });
});
