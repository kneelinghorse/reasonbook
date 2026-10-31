/**
 * rbook_mission_add Tool Tests
 *
 * Comprehensive tests for the mission creation tool.
 *
 * @module tests/tools/rbook/rbook-mission-add
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { RbookToolResult, MissionStatus } from '../../../src/tools/rbook/types';

import {
  rbookMissionAdd,
  rbookMissionAddToolDefinition,
  formatMissionAddForLLM,
  type MissionAddResult,
  type RbookMissionAddParams,
} from '../../../src/tools/rbook/rbook-mission-add';

/**
 * Helper to create test database.
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-add-test-'));
  fs.mkdirSync(path.join(tempDir, 'rbook', 'db'), { recursive: true });
  const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
  const db = new Database(dbPath);

  // Create schema
  db.exec(`
    PRAGMA foreign_keys = ON;

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

    CREATE TABLE mission_dependencies (
      from_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      PRIMARY KEY (from_id, to_id)
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

    -- Insert test sprints
    INSERT INTO sprints (id, title, focus, status)
    VALUES
      ('sprint-14', 'Sprint 14 - Testing', 'Test mission add', 'Active'),
      ('sprint-15', 'Sprint 15 - Future', 'Future work', 'Planned');

    -- Insert existing mission for collision test
    INSERT INTO missions (id, sprint_id, name, status, objective)
    VALUES ('existing-m01', 'sprint-14', 'Existing Mission', 'Queued', 'Already exists');
  `);

  return { tempDir, dbPath, db };
}

function cleanupTestDb(testDb: TestDb): void {
  testDb.db.close();
  if (testDb.tempDir) {
    fs.rmSync(testDb.tempDir, { recursive: true, force: true });
  }
}

/**
 * Helper to call rbookMissionAdd with explicit dbPath.
 */
async function callMissionAdd(
  dbPath: string,
  params: Omit<RbookMissionAddParams, 'projectRoot'>
): Promise<RbookToolResult<MissionAddResult>> {
  return rbookMissionAdd({ ...params, projectRoot: path.resolve(dbPath, '../../..') });
}

describe('rbook_mission_add', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path - basic creation', () => {
    it('should create a mission with required fields only', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: 'Test Mission',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('s14-m01');
      expect(result.data?.name).toBe('Test Mission');
      expect(result.data?.sprintId).toBe('sprint-14');
      expect(result.data?.status).toBe('Queued');

      const row = testDb.db.prepare('SELECT * FROM missions WHERE id = ?').get('s14-m01') as Record<
        string,
        unknown
      >;
      expect(row.name).toBe('Test Mission');
      expect(row.sprint_id).toBe('sprint-14');
      expect(row.status).toBe('Queued');
    });

    it('should create a mission with custom status', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m02',
        name: 'Current Mission',
        sprintId: 'sprint-14',
        status: 'Current',
      });

      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('Current');

      const row = testDb.db.prepare('SELECT status FROM missions WHERE id = ?').get('s14-m02') as {
        status: string;
      };
      expect(row.status).toBe('Current');
    });

    it('should create a mission with objective', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m03',
        name: 'Mission With Objective',
        sprintId: 'sprint-14',
        objective: 'Implement feature X',
      });

      expect(result.success).toBe(true);
      expect(result.data?.fields).toEqual(['objective']);

      const row = testDb.db
        .prepare('SELECT objective FROM missions WHERE id = ?')
        .get('s14-m03') as {
        objective: string;
      };
      expect(row.objective).toBe('Implement feature X');
    });

    it('should trim whitespace from string fields', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: '  s14-m04  ',
        name: '  Trimmed Mission  ',
        sprintId: 'sprint-14',
        objective: '  Trimmed objective  ',
      });

      expect(result.success).toBe(true);
      expect(result.data?.id).toBe('s14-m04');
      expect(result.data?.name).toBe('Trimmed Mission');

      const row = testDb.db.prepare('SELECT * FROM missions WHERE id = ?').get('s14-m04') as Record<
        string,
        unknown
      >;
      expect(row.name).toBe('Trimmed Mission');
      expect(row.objective).toBe('Trimmed objective');
    });
  });

  describe('happy path - all spec fields', () => {
    it('should create a mission with all optional fields', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m05',
        name: 'Full Mission',
        sprintId: 'sprint-14',
        status: 'Queued',
        objective: 'Complete objective',
        context: 'Important background info',
        successCriteria: ['Criterion 1', 'Criterion 2'],
        deliverables: ['file1.ts', 'file2.ts'],
        referenceDocs: ['doc1.md', 'doc2.md'],
        domainFields: { customField: 'value' },
        notes: 'Some notes',
      });

      expect(result.success).toBe(true);
      expect(result.data?.fields).toEqual([
        'objective',
        'context',
        'successCriteria (2)',
        'deliverables (2)',
        'referenceDocs (2)',
        'domainFields',
        'notes',
      ]);

      const row = testDb.db.prepare('SELECT * FROM missions WHERE id = ?').get('s14-m05') as Record<
        string,
        unknown
      >;
      expect(JSON.parse(row.success_criteria as string)).toEqual(['Criterion 1', 'Criterion 2']);
      expect(JSON.parse(row.deliverables as string)).toEqual(['file1.ts', 'file2.ts']);
      expect(JSON.parse(row.reference_docs as string)).toEqual(['doc1.md', 'doc2.md']);
      expect(JSON.parse(row.domain_fields as string)).toEqual({ customField: 'value' });
    });

    it('should handle context as object', async () => {
      const contextObj = { background: 'info', key: 'value' };
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m06',
        name: 'Object Context Mission',
        sprintId: 'sprint-14',
        context: contextObj,
      });

      expect(result.success).toBe(true);
      expect(result.data?.fields).toEqual(['context']);

      const row = testDb.db.prepare('SELECT context FROM missions WHERE id = ?').get('s14-m06') as {
        context: string;
      };
      expect(JSON.parse(row.context)).toEqual(contextObj);
    });

    it('should handle context as string', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m07',
        name: 'String Context Mission',
        sprintId: 'sprint-14',
        context: 'Simple string context',
      });

      expect(result.success).toBe(true);
      expect(result.data?.fields).toEqual(['context']);

      const row = testDb.db.prepare('SELECT context FROM missions WHERE id = ?').get('s14-m07') as {
        context: string;
      };
      expect(row.context).toBe('Simple string context');
    });
  });

  describe('happy path - event logging', () => {
    it('should log creation event', async () => {
      await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m08',
        name: 'Event Test Mission',
        sprintId: 'sprint-14',
      });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ?')
        .get('s14-m08') as {
        action: string;
        status: string;
        raw_event: string;
      };

      expect(event).toBeDefined();
      expect(event.action).toBe('create');
      expect(event.status).toBe('Queued');

      const rawEvent = JSON.parse(event.raw_event);
      expect(rawEvent.tool).toBe('rbook_mission_add');
      expect(rawEvent.missionId).toBe('s14-m08');
      expect(rawEvent.sprintId).toBe('sprint-14');
    });
  });

  describe('error cases - missing parameters', () => {
    it('should return error for missing missionId', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: '',
        name: 'Test',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('missionId');
    });

    // s106-m02 (#871): add takes the id the planner chooses, and nothing said so; the refusal now
    // names the requirement with an example. Reasonbook never derives an id.
    it('names the new-id requirement with an example, and derives no id', async () => {
      const missions = () => testDb.db.prepare('SELECT COUNT(*) AS n FROM missions').get();
      const before = missions();
      const result = await callMissionAdd(testDb.dbPath, {
        name: 'Test',
        sprintId: 'sprint-14',
      } as unknown as RbookMissionAddParams);
      expect(result.error).toMatchObject({
        code: RBOOK_ERROR_CODES.MISSING_PARAMETER,
        field: 'missionId',
      });
      expect(result.error?.message).toMatch(/needs the new mission's id/);
      expect(result.error?.suggestion).toMatch(/an id no mission in this project uses/);
      expect(result.error?.suggestion).toMatch(/missionId="s\d+-m\d+"/);
      expect(missions()).toEqual(before);
    });

    // s106-m02: a name made only of a stray tool-call tag is emptied by the content sanitizer.
    // "Missing" would send the same text back, emptied again; the refusal says what happened.
    it('says a supplied name was emptied by the sanitizer, and plain text then adds it', async () => {
      const emptied = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: '<parameter name="objective">',
        sprintId: 'sprint-14',
      });
      expect(emptied.error).toMatchObject({
        code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
        field: 'name',
      });
      expect(emptied.error?.message).toMatch(/content sanitizer/);
      expect(emptied.error?.suggestion).toMatch(/plain text/);
      const added = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: 'Test',
        sprintId: 'sprint-14',
      });
      expect(added.success).toBe(true);
    });

    it('should return error for missing name', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: '',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('name');
    });

    it('should return error for empty sprintId', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: 'Test',
        sprintId: '',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.field).toBe('sprintId');
    });
  });

  describe('error cases - validation', () => {
    it('should return error for non-existent sprint', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: 'Test',
        sprintId: 'nonexistent-sprint',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.SPRINT_NOT_FOUND);
      expect(result.error?.suggestion).toContain('rbook_sprint');
    });

    it('should return error for duplicate mission ID', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 'existing-m01',
        name: 'Duplicate',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_ID_EXISTS');
      expect(result.error?.suggestion).toContain('rbook_mission(action="update")');
    });

    it('should return error for invalid status', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-m01',
        name: 'Test',
        sprintId: 'sprint-14',
        status: 'InvalidStatus' as MissionStatus,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.INVALID_PARAMETER);
      expect(result.error?.validValues).toBeDefined();
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookMissionAddToolDefinition.name).toBe('rbook_mission_add');
    });

    it('should have comprehensive description', () => {
      expect(rbookMissionAddToolDefinition.description).toContain('Create a new mission');
      expect(rbookMissionAddToolDefinition.description).toContain('Omit sprintId');
      expect(rbookMissionAddToolDefinition.description).toContain('pass null for unscheduled');
      expect(rbookMissionAddToolDefinition.description).toContain('a named sprint must exist');
    });

    it('requires identity and name while allowing omitted or explicit-null sprint scope', () => {
      expect(rbookMissionAddToolDefinition.inputSchema.required).toContain('missionId');
      expect(rbookMissionAddToolDefinition.inputSchema.required).toContain('name');
      expect(rbookMissionAddToolDefinition.inputSchema.required).not.toContain('sprintId');
    });

    it('should have all spec fields defined', () => {
      const props = rbookMissionAddToolDefinition.inputSchema.properties;
      expect(props.missionId).toBeDefined();
      expect(props.name).toBeDefined();
      expect(props.sprintId).toBeDefined();
      expect(props.status).toBeDefined();
      expect(props.objective).toBeDefined();
      expect(props.context).toBeDefined();
      expect(props.successCriteria).toBeDefined();
      expect(props.deliverables).toBeDefined();
      expect(props.referenceDocs).toBeDefined();
      expect(props.domainFields).toBeDefined();
      expect(props.notes).toBeDefined();
    });
  });

  describe('formatMissionAddForLLM', () => {
    it('should format success result', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: 's14-fmt01',
        name: 'Format Test',
        sprintId: 'sprint-14',
        objective: 'Test formatting',
        successCriteria: ['A', 'B'],
        deliverables: ['X', 'Y', 'Z'],
      });

      const formatted = formatMissionAddForLLM(result);

      expect(formatted).toContain("Mission 's14-fmt01' created");
      expect(formatted).toContain('Sprint: sprint-14');
      expect(formatted).toContain('Name: Format Test');
      expect(formatted).toContain('Status: Queued');
      expect(formatted).toContain('Stored: objective, successCriteria (2), deliverables (3)');
      // The receipt never echoes the mission's text back.
      expect(formatted).not.toContain('Test formatting');
    });

    it('should format error result', async () => {
      const result = await callMissionAdd(testDb.dbPath, {
        missionId: '',
        name: 'Test',
        sprintId: 'sprint-14',
      });

      const formatted = formatMissionAddForLLM(result);

      expect(formatted).toContain('Failed to create mission');
      expect(formatted).toContain('Error:');
      expect(formatted).toContain('Suggestion');
    });
  });
});
