/**
 * rbook_mission_status Tool Tests
 *
 * Comprehensive tests for the mission status tool that shows
 * the active work queue from the Reasonbook database.
 *
 * @module tests/tools/rbook/rbook-mission-status
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookMissionStatus,
  rbookMissionStatusToolDefinition,
  formatMissionStatusForLLM,
  type RbookMissionStatusParams,
  type RbookMissionStatusResult,
} from '../../../src/tools/rbook/rbook-mission-status';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import {
  createTestDatabase,
  seedTestData,
  getTestSchema,
  getSampleData,
} from './fixtures/test-helpers';

describe('rbook_mission_status', () => {
  let tempDir: string;
  let dbPath: string;
  let projectRoot: string;

  beforeEach(() => {
    // Create a temporary project structure: tempDir/rbook/db/rbook.sqlite
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-status-test-'));
    projectRoot = tempDir;
    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    dbPath = path.join(rbookDbDir, 'rbook.sqlite');

    // Create database with schema and seed data
    const db = new Database(dbPath);
    db.exec(getTestSchema());
    db.exec(getSampleData());
    db.close();

    // Reset RbookDetector cache
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    RbookDetector.resetInstance();
  });

  describe('basic status retrieval', () => {
    it('should return in_progress missions at highest priority', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data?.inProgress.length).toBe(1);
      expect(result.data?.inProgress[0].id).toBe('s12-m08');
      expect(result.data?.inProgress[0].status).toBe('In Progress');
    });

    it('should return current missions (ready to start)', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.current.length).toBe(1);
      expect(result.data?.current[0].id).toBe('s12-m09');
      expect(result.data?.current[0].status).toBe('Current');
    });

    it('should return queued missions scoped to active sprint', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      // Sprint-12 is active (has In Progress mission), so queued is scoped to it
      // The active sprint queue plus explicitly unscheduled work.
      expect(result.data?.queued.length).toBe(4);
      expect(result.data?.queued.every((m) => m.status === 'Queued')).toBe(true);
      expect(
        result.data?.queued.every((m) => m.sprint === null || m.sprint?.id === 'sprint-12')
      ).toBe(true);
    });

    it('should not include blocked missions by default', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.blocked).toBeNull();
    });

    it('should not include completed missions', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      // Verify no completed missions in any category
      const allMissions = [
        ...(result.data?.inProgress || []),
        ...(result.data?.current || []),
        ...(result.data?.queued || []),
      ];
      expect(allMissions.some((m) => m.status === 'Completed')).toBe(false);
    });
  });

  describe('includeBlocked parameter', () => {
    it('should include blocked missions when includeBlocked is true', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { includeBlocked: true });

      expect(result.success).toBe(true);
      expect(result.data?.blocked).not.toBeNull();
      expect(result.data?.blocked?.length).toBe(1);
      expect(result.data?.blocked?.[0].id).toBe('s12-blocked');
      expect(result.data?.blocked?.[0].status).toBe('Blocked');
    });

    it('should include blocked count in summary when includeBlocked is true', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { includeBlocked: true });

      expect(result.success).toBe(true);
      expect(result.data?.summary.blockedCount).toBe(1);
    });

    it('should not include blocked missions when includeBlocked is false', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { includeBlocked: false });

      expect(result.success).toBe(true);
      expect(result.data?.blocked).toBeNull();
      expect(result.data?.summary.blockedCount).toBeNull();
    });
  });

  describe('queuedLimit parameter', () => {
    it('should respect custom queuedLimit', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { queuedLimit: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.queued.length).toBeLessThanOrEqual(2);
    });

    it('should return all queued from active sprint when limit exceeds count', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { queuedLimit: 50 });

      expect(result.success).toBe(true);
      // 3 queued missions in active sprint (sprint-12)
      expect(result.data?.queued.length).toBe(4);
    });

    it('should return just 1 when queuedLimit is 1', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { queuedLimit: 1 });

      expect(result.success).toBe(true);
      expect(result.data?.queued.length).toBe(1);
    });
  });

  describe('sprint context', () => {
    it('should include sprint information for missions with sprint_id', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const inProgressMission = result.data?.inProgress[0];
      expect(inProgressMission?.sprint).toBeDefined();
      expect(inProgressMission?.sprint?.id).toBe('sprint-12');
      expect(inProgressMission?.sprint?.title).toBe('Sprint 12 - Reasonbook Tools');
      expect(inProgressMission?.sprint?.focus).toBeNull();
      expect(result.data?.activeSprint?.focus).toBe('Implement Reasonbook MCP tools');
    });

    it('should return null sprint for standalone missions', async () => {
      // Modify the standalone mission to be in_progress to test it
      const db = new Database(dbPath);
      db.exec(`UPDATE missions SET status = 'In Progress' WHERE id = 'standalone-01'`);
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const standalone = result.data?.inProgress.find((m) => m.id === 'standalone-01');
      expect(standalone?.sprint).toBeNull();
    });
  });

  describe('mission data parsing', () => {
    it('should parse success_criteria JSON array', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const mission = result.data?.inProgress[0];
      expect(mission?.successCriteria).toEqual(['Reasonbook tools registered', 'Tests pass']);
    });

    it('should parse deliverables JSON array', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      const mission = result.data?.inProgress[0];
      expect(mission?.deliverables).toEqual(['src/index.ts', 'tests/']);
    });

    it('should return null for null JSON fields', async () => {
      // Queued missions have some null fields
      const result = await rbookMissionStatusWithDb(dbPath, { queuedLimit: 10 });

      expect(result.success).toBe(true);
      const adminMission = result.data?.queued.find((m) => m.id === 's12-m11');
      expect(adminMission?.deliverables).toBeNull();
      expect(adminMission?.notes).toBeNull();
    });
  });

  describe('summary and nextAction', () => {
    it('should calculate activeCount correctly', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      // 1 in_progress + 1 current = 2 active
      expect(result.data?.summary.activeCount).toBe(2);
    });

    it('should calculate queuedCount correctly (scoped to active sprint)', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { queuedLimit: 10 });

      expect(result.success).toBe(true);
      // Three queued in sprint-12 plus standalone-01.
      expect(result.data?.summary.queuedCount).toBe(4);
    });

    it('should recommend continuing in-progress mission', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.summary.nextAction).toContain('s12-m08');
      expect(result.data?.summary.nextAction).toContain('Continue');
    });

    it('should recommend starting current mission when nothing in progress', async () => {
      // Remove all in-progress missions
      const db = new Database(dbPath);
      db.exec(`UPDATE missions SET status = 'Completed' WHERE status = 'In Progress'`);
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.summary.nextAction).toContain('Start');
      expect(result.data?.summary.nextAction).toContain('s12-m09');
    });

    it('should recommend promoting queued when no active missions', async () => {
      // Remove all in-progress and current missions
      const db = new Database(dbPath);
      db.exec(
        `UPDATE missions SET status = 'Completed' WHERE status IN ('In Progress', 'Current')`
      );
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.summary.nextAction).toContain('Promote');
    });

    it('should indicate all blocked when nothing else available', async () => {
      // Update all non-blocked missions to completed
      const db = new Database(dbPath);
      db.exec(`UPDATE missions SET status = 'Completed' WHERE status != 'Blocked'`);
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, { includeBlocked: true });

      expect(result.success).toBe(true);
      expect(result.data?.summary.nextAction).toContain('blocked');
    });

    it('should indicate empty queue when no missions available', async () => {
      // Delete all missions
      const db = new Database(dbPath);
      db.exec(`DELETE FROM missions`);
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.summary.nextAction).toContain('No missions');
    });

    it('should warn about multiple in-progress missions', async () => {
      // Add another in-progress mission
      const db = new Database(dbPath);
      db.exec(`UPDATE missions SET status = 'In Progress' WHERE id = 's12-m09'`);
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.inProgress.length).toBe(2);
      expect(result.data?.summary.nextAction).toContain('in progress');
    });
  });

  describe('error handling', () => {
    it('should return RBOOK_NOT_DETECTED when no Reasonbook directory found', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-rbook-'));

      try {
        const result = await rbookMissionStatus({ projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
        expect(result.error?.suggestion).toBeDefined();
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should return DB_SCHEMA_MISMATCH for database without required tables', async () => {
      // Create a separate project with a bad database (missing tables)
      const badTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-bad-schema-'));
      const badRbookDbDir = path.join(badTempDir, 'rbook', 'db');
      fs.mkdirSync(badRbookDbDir, { recursive: true });
      const badDbPath = path.join(badRbookDbDir, 'rbook.sqlite');

      const db = new Database(badDbPath);
      db.exec('CREATE TABLE other (id TEXT);');
      db.close();

      try {
        const result = await rbookMissionStatusWithDb(badDbPath, {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH);
      } finally {
        fs.rmSync(badTempDir, { recursive: true, force: true });
      }
    });
  });

  describe('edge cases', () => {
    it('should handle empty database gracefully', async () => {
      // Create a separate project with an empty database (schema only, no data)
      const emptyTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-empty-'));
      const emptyRbookDbDir = path.join(emptyTempDir, 'rbook', 'db');
      fs.mkdirSync(emptyRbookDbDir, { recursive: true });
      const emptyDbPath = path.join(emptyRbookDbDir, 'rbook.sqlite');

      const db = new Database(emptyDbPath);
      db.exec(getTestSchema());
      db.close();

      try {
        const result = await rbookMissionStatusWithDb(emptyDbPath, {});

        expect(result.success).toBe(true);
        expect(result.data?.inProgress.length).toBe(0);
        expect(result.data?.current.length).toBe(0);
        expect(result.data?.queued.length).toBe(0);
        expect(result.data?.summary.activeCount).toBe(0);
      } finally {
        fs.rmSync(emptyTempDir, { recursive: true, force: true });
      }
    });

    it('should order queued missions by id ASC within active sprint', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { queuedLimit: 10 });

      expect(result.success).toBe(true);
      const queuedIds = result.data?.queued.map((m) => m.id) || [];
      // All queued should be from sprint-12, ordered by id
      expect(queuedIds).toEqual(['s12-m10', 's12-m11', 's12-m12', 'standalone-01']);
    });

    it('should include unscheduled missions alongside the sprint-scoped queue', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { queuedLimit: 10 });

      expect(result.success).toBe(true);
      // Unscheduled work stays visible when another sprint is open.
      const standalone = result.data?.queued.find((m) => m.id === 'standalone-01');
      expect(standalone?.sprint).toBeNull();
    });
  });

  describe('sprint scoping', () => {
    it('should return activeSprint in the result', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.activeSprint).toBeDefined();
      expect(result.data?.activeSprint?.id).toBe('sprint-12');
      expect(result.data?.activeSprint?.title).toBe('Sprint 12 - Reasonbook Tools');
    });

    it('should scope queued to active sprint even when other sprints have queued work', async () => {
      // Add a sprint-13 with queued missions
      const db = new Database(dbPath);
      db.exec(`
        INSERT INTO sprints (id, title, focus, status) VALUES ('sprint-13', 'Sprint 13 - Future', 'Future work', 'Active');
        INSERT INTO missions (id, sprint_id, name, status, objective) VALUES ('s13-m01', 'sprint-13', 'Future Task 1', 'Queued', 'Future work item');
        INSERT INTO missions (id, sprint_id, name, status, objective) VALUES ('s13-m02', 'sprint-13', 'Future Task 2', 'Queued', 'Another future item');
      `);
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, { queuedLimit: 50 });

      expect(result.success).toBe(true);
      // Active sprint is sprint-12 (has In Progress mission), so queued should only be from sprint-12
      expect(result.data?.queued.length).toBe(4);
      expect(
        result.data?.queued.every((m) => m.sprint === null || m.sprint?.id === 'sprint-12')
      ).toBe(true);
      // sprint-13 missions should NOT appear
      expect(result.data?.queued.find((m) => m.id === 's13-m01')).toBeUndefined();
    });

    it('should detect sprint completion when all missions are done', async () => {
      // Complete ALL missions in sprint-12 (including blocked)
      const db = new Database(dbPath);
      db.exec(`
        UPDATE missions SET status = 'Completed' WHERE sprint_id = 'sprint-12';
      `);
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      expect(result.data?.activeSprint?.id).toBe('sprint-12');
      expect(result.data?.queued.map((m) => m.id)).toEqual(['standalone-01']);
      expect(result.data?.summary.nextAction).toContain('standalone-01');
    });

    it('should fall back to next active sprint when current sprint is done', async () => {
      // Complete sprint-12, add Active sprint-13 with queued work
      const db = new Database(dbPath);
      db.exec(`
        UPDATE missions SET status = 'Completed' WHERE sprint_id = 'sprint-12' AND status IN ('In Progress', 'Current', 'Queued');
        UPDATE sprints SET status = 'Completed' WHERE id = 'sprint-12';
        INSERT INTO sprints (id, title, focus, status) VALUES ('sprint-13', 'Sprint 13 - Next', 'Next work', 'Active');
        INSERT INTO missions (id, sprint_id, name, status, objective) VALUES ('s13-m01', 'sprint-13', 'Next Task', 'Queued', 'Next sprint work');
      `);
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, { queuedLimit: 10 });

      expect(result.success).toBe(true);
      expect(result.data?.activeSprint?.id).toBe('sprint-13');
      expect(result.data?.queued.length).toBe(2);
      expect(result.data?.queued[0].id).toBe('s13-m01');
    });

    it('surfaces the explicitly-open sprint when no sprints have missions (s77-m02 convergence)', async () => {
      const db = new Database(dbPath);
      db.exec('DELETE FROM missions');
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, {});

      expect(result.success).toBe(true);
      // Pre-s77-m02 this returned null — mission-status' picker required a sprint
      // WITH missions, while onboard's getCurrentSprint already surfaced an
      // explicitly-open (In Progress) sprint with no missions yet. m02 collapses
      // both onto resolveCurrentSprintId, so mission-status now agrees: the open
      // sprint IS the current sprint even before its missions are added.
      expect(result.data?.activeSprint?.id).toBe('sprint-12');
      // No open missions → nothing queued to scope in.
      expect(result.data?.queued).toHaveLength(0);
    });

    it('should show all queued as fallback when no active sprint found', async () => {
      // Remove all sprints and add standalone queued missions
      const db = new Database(dbPath);
      db.exec(`
        DELETE FROM missions;
        DELETE FROM sprints;
        INSERT INTO missions (id, name, status, objective) VALUES ('orphan-01', 'Orphan Task 1', 'Queued', 'No sprint');
        INSERT INTO missions (id, name, status, objective) VALUES ('orphan-02', 'Orphan Task 2', 'Queued', 'No sprint');
      `);
      db.close();

      const result = await rbookMissionStatusWithDb(dbPath, { queuedLimit: 10 });

      expect(result.success).toBe(true);
      expect(result.data?.activeSprint).toBeNull();
      expect(result.data?.queued.length).toBe(2);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookMissionStatusToolDefinition.name).toBe('rbook_mission_status');
    });

    it('should have comprehensive description', () => {
      expect(rbookMissionStatusToolDefinition.description).toBeTruthy();
      expect(rbookMissionStatusToolDefinition.description).toContain('work queue');
      expect(rbookMissionStatusToolDefinition.description).toContain('priority');
    });

    it('should have valid input schema', () => {
      expect(rbookMissionStatusToolDefinition.inputSchema.type).toBe('object');
      expect(rbookMissionStatusToolDefinition.inputSchema.properties).toBeDefined();
    });

    it('should have includeBlocked as optional boolean', () => {
      const props = rbookMissionStatusToolDefinition.inputSchema.properties as Record<
        string,
        unknown
      >;
      expect(props.includeBlocked).toBeDefined();
      expect((props.includeBlocked as { type: string }).type).toBe('boolean');
    });

    it('should have queuedLimit with min/max constraints', () => {
      const props = rbookMissionStatusToolDefinition.inputSchema.properties as Record<
        string,
        unknown
      >;
      expect(props.queuedLimit).toBeDefined();
      expect((props.queuedLimit as { type: string }).type).toBe('number');
      expect((props.queuedLimit as { minimum: number }).minimum).toBe(1);
      expect((props.queuedLimit as { maximum: number }).maximum).toBe(50);
    });
  });

  describe('formatMissionStatusForLLM', () => {
    it('should format success result with all sections', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { includeBlocked: true });
      const formatted = formatMissionStatusForLLM(result);

      expect(formatted).toContain('Work Queue Status');
      expect(formatted).toContain('Sprint');
      expect(formatted).toContain('sprint-12');
      expect(formatted).toContain('In Progress');
      expect(formatted).toContain('Current');
      expect(formatted).toContain('Queued');
      expect(formatted).toContain('Blocked');
      expect(formatted).toContain('Next:');
    });

    it('should show summary stats', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { includeBlocked: true });
      const formatted = formatMissionStatusForLLM(result);

      expect(formatted).toContain('Active:');
      expect(formatted).toContain('Queued:');
      expect(formatted).toContain('Blocked:');
    });

    it('should include mission IDs and names', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});
      const formatted = formatMissionStatusForLLM(result);

      expect(formatted).toContain('s12-m08');
      expect(formatted).toContain('Tool Registration & Tests');
    });

    it('should include sprint context', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});
      const formatted = formatMissionStatusForLLM(result);

      expect(formatted).toContain('sprint-12');
    });

    it('should include objective for active missions', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, {});
      const formatted = formatMissionStatusForLLM(result);

      expect(formatted).toContain('Register Reasonbook tools');
    });

    it('should omit blocked section when not included', async () => {
      const result = await rbookMissionStatusWithDb(dbPath, { includeBlocked: false });
      const formatted = formatMissionStatusForLLM(result);

      expect(formatted).not.toContain('**Blocked:**');
    });

    it('should format error result', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-rbook-format-'));

      try {
        const result = await rbookMissionStatus({ projectRoot: emptyDir });
        const formatted = formatMissionStatusForLLM(result);

        expect(formatted).toContain('Failed');
        expect(formatted).toContain('Suggestion');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });
});

/**
 * Helper to run rbookMissionStatus with explicit database path.
 *
 * Expects dbPath to be at tempDir/rbook/db/rbook.sqlite structure.
 */
async function rbookMissionStatusWithDb(
  dbPath: string,
  params: RbookMissionStatusParams
): Promise<RbookToolResult<RbookMissionStatusResult>> {
  // dbPath = tempDir/rbook/db/rbook.sqlite
  // projectRoot = tempDir
  const rbookDbDir = path.dirname(dbPath); // rbook/db
  const rbookDir = path.dirname(rbookDbDir); // rbook
  const projectRoot = path.dirname(rbookDir); // tempDir

  // Reset detector to pick up new db
  RbookDetector.resetInstance();

  // Call actual implementation with the projectRoot
  return rbookMissionStatus({
    ...params,
    projectRoot,
  });
}
