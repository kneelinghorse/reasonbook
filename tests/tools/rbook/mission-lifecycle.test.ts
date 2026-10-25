/**
 * Mission Lifecycle Tools Tests
 *
 * Comprehensive tests for all mission lifecycle mutation tools:
 * - rbook_mission_start
 * - rbook_mission_complete
 * - rbook_mission_block
 * - rbook_mission_unblock
 *
 * Each tool has 10+ tests covering happy paths and error cases.
 *
 * @module tests/tools/rbook/mission-lifecycle
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { RbookToolResult, MissionStatus } from '../../../src/tools/rbook/types';

// Import tool implementations and types
import {
  rbookMissionStart,
  rbookMissionStartToolDefinition,
  formatMissionStartForLLM,
  type MissionStartResult,
} from '../../../src/tools/rbook/rbook-mission-start';

import {
  rbookMissionComplete,
  rbookMissionCompleteToolDefinition,
  formatMissionCompleteForLLM,
  type MissionCompleteResult,
} from '../../../src/tools/rbook/rbook-mission-complete';

import {
  rbookMissionBlock,
  rbookMissionBlockToolDefinition,
  formatMissionBlockForLLM,
  type MissionBlockResult,
} from '../../../src/tools/rbook/rbook-mission-block';

import {
  rbookMissionUnblock,
  rbookMissionUnblockToolDefinition,
  formatMissionUnblockForLLM,
  type MissionUnblockResult,
} from '../../../src/tools/rbook/rbook-mission-unblock';

/**
 * Helper to create test database and run tool with explicit db path.
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-lifecycle-test-'));
  // s87-m01: the standard `<root>/rbook/db/rbook.sqlite` layout, so the REAL handlers' projectRoot
  // resolution finds this store. It used to sit at `<root>/rbook.sqlite`, which no handler could
  // resolve — which is part of why the helpers below were hand-copied bodies instead of calls.
  const dbDir = path.join(tempDir, 'rbook', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'rbook.sqlite');
  const db = new Database(dbPath);

  // Create comprehensive schema
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

    -- Mission transitions now resolve their caller session as well as writing the status.
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, type TEXT, title TEXT, sprint_id TEXT, started_at TEXT,
      completed_at TEXT, agent TEXT, status TEXT, summary TEXT, captures TEXT,
      next_steps TEXT, metadata TEXT
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

    -- Insert test sprint
    INSERT INTO sprints (id, title, focus, status)
    VALUES ('sprint-12', 'Sprint 12 - Testing', 'Test lifecycle tools', 'In Progress');

    -- Insert test missions with various statuses
    INSERT INTO missions (id, sprint_id, name, status, objective, notes, domain_fields)
    VALUES
      ('m-queued', 'sprint-12', 'Queued Mission', 'Queued', 'Test queued mission', NULL, NULL),
      ('m-current', 'sprint-12', 'Current Mission', 'Current', 'Test current mission', NULL, NULL),
      ('m-in-progress', 'sprint-12', 'In Progress Mission', 'In Progress', 'Test in progress mission', NULL, NULL),
      ('m-completed', 'sprint-12', 'Completed Mission', 'Completed', 'Test completed mission', 'Done', '2024-01-15T10:00:00Z'),
      ('m-blocked', 'sprint-12', 'Blocked Mission', 'Blocked', 'Test blocked mission', '[Blocked] Waiting on dependency', '{"blocker": "external-api", "blockedSince": "2024-01-14T12:00:00Z"}');
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
 * s87-m01 — THE FOUR HELPERS NOW DELEGATE TO THE REAL HANDLERS.
 *
 * WHAT WAS HERE BEFORE. `callMissionStart`, `callMissionComplete`, `callMissionBlock` and
 * `callMissionUnblock` were ~520 lines of HAND-COPIED handler bodies. This file imports the real
 * `rbookMissionStart` / `rbookMissionComplete` / `rbookMissionBlock` / `rbookMissionUnblock` at the
 * top and then never called them: all 65 tests asserted the behaviour of the copies.
 *
 * WHY THAT MATTERED, and it is the whole reason s87-m01 touched this file. Every one of those
 * copies contained the line `VALID_STATE_TRANSITIONS[currentStatus]`, unguarded, exactly as the
 * real handlers did. So the suite was green — over the copies — while the shipped handlers threw
 * an unhandled TypeError on a mission row that exists in this repo's own store. 65 green tests
 * sitting on the exact paths that ship a crash is not coverage; it is a coverage CLAIM, and it is
 * why the defect survived s86-m08's attempt to fix it. Repointing them is the difference between
 * testing the code and testing a photograph of the code.
 *
 * WHAT CHANGED MECHANICALLY. `createTestDb` now writes its store at the standard
 * `<root>/rbook/db/rbook.sqlite` layout so the real handlers' `projectRoot` resolution finds it; the
 * helpers keep their `(dbPath, params)` signatures so no call site moved. `runWithDb` is gone —
 * it was dead, having imported `withClient` and then never used it.
 */

/** `<root>/rbook/db/rbook.sqlite` -> `<root>`, so the real handlers resolve the temp store. */
function projectRootOf(dbPath: string): string {
  return path.resolve(path.dirname(dbPath), '..', '..');
}

async function callMissionStart(
  dbPath: string,
  params: { missionId: string; notes?: string }
): Promise<RbookToolResult<MissionStartResult>> {
  return rbookMissionStart({ ...params, projectRoot: projectRootOf(dbPath) });
}

async function callMissionComplete(
  dbPath: string,
  params: { missionId: string; notes?: string }
): Promise<RbookToolResult<MissionCompleteResult>> {
  return rbookMissionComplete({ ...params, projectRoot: projectRootOf(dbPath) });
}

async function callMissionBlock(
  dbPath: string,
  params: { missionId: string; reason: string; blockers?: string[] }
): Promise<RbookToolResult<MissionBlockResult>> {
  return rbookMissionBlock({ ...params, projectRoot: projectRootOf(dbPath) });
}

async function callMissionUnblock(
  dbPath: string,
  params: { missionId: string; resolution?: string; targetStatus?: 'In Progress' | 'Current' }
): Promise<RbookToolResult<MissionUnblockResult>> {
  return rbookMissionUnblock({ ...params, projectRoot: projectRootOf(dbPath) });
}

describe('rbook_mission_start', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should start a Queued mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('m-queued');
      expect(result.data?.previousStatus).toBe('Queued');
      expect(result.data?.currentStatus).toBe('In Progress');
      expect(result.data?.startedAt).toBeDefined();
    });

    it('should start a Current mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-current' });

      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('Current');
      expect(result.data?.currentStatus).toBe('In Progress');
    });

    it('should include notes in result message', async () => {
      const result = await callMissionStart(testDb.dbPath, {
        missionId: 'm-queued',
        notes: 'Starting implementation',
      });

      expect(result.success).toBe(true);
      expect(result.data?.message).toContain('In Progress');
    });

    it('should update mission status in database', async () => {
      await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });

      const row = testDb.db.prepare('SELECT status FROM missions WHERE id = ?').get('m-queued') as {
        status: string;
      };
      expect(row.status).toBe('In Progress');
    });

    it('should append notes to existing notes', async () => {
      // First add some notes
      testDb.db.exec(`UPDATE missions SET notes = 'Initial note' WHERE id = 'm-queued'`);

      await callMissionStart(testDb.dbPath, {
        missionId: 'm-queued',
        notes: 'Starting work',
      });

      const row = testDb.db.prepare('SELECT notes FROM missions WHERE id = ?').get('m-queued') as {
        notes: string;
      };
      expect(row.notes).toContain('Initial note');
      expect(row.notes).toContain('[Started] Starting work');
    });

    it('should log event to session_events', async () => {
      await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ? AND action = ?')
        .get('m-queued', 'start') as { action: string; status: string };
      expect(event).toBeDefined();
      expect(event.action).toBe('start');
      expect(event.status).toBe('In Progress');
    });

    it('should auto-activate a Planned parent sprint when mission work begins', async () => {
      testDb.db.exec(`
        UPDATE sprints SET status='Completed' WHERE id='sprint-12';
        INSERT INTO sprints (id, title, focus, status)
        VALUES ('sprint-planned', 'Planned Sprint', 'Future work', 'Planned');

        INSERT INTO missions (id, sprint_id, name, status, objective)
        VALUES ('m-planned', 'sprint-planned', 'Planned Mission', 'Queued', 'Start planned work');
      `);

      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-planned' });

      expect(result.success).toBe(true);

      const sprint = testDb.db
        .prepare('SELECT status FROM sprints WHERE id = ?')
        .get('sprint-planned') as { status: string };
      expect(sprint.status).toBe('Active');
    });
  });

  describe('error cases', () => {
    it('should return MISSION_NOT_FOUND for non-existent mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_NOT_FOUND);
      // s85-m01: suggestions now name the CONSOLIDATED tool — the pre-s85 name was removed in the 38→15 consolidation.
      expect(result.error?.suggestion).toContain('rbook_mission(action="list")');
    });

    it('should return MISSION_INVALID_STATE for already In Progress mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-in-progress' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_INVALID_STATE);
      expect(result.error?.currentState).toBe('In Progress');
    });

    it('should return INVALID_STATE_TRANSITION for Completed mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-completed' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_INVALID_TRANSITION);
      expect(result.error?.currentState).toBe('Completed');
      expect(result.error?.validTransitions).toEqual([]);
    });

    it('should return INVALID_STATE_TRANSITION for Blocked mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-blocked' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_INVALID_TRANSITION);
      expect(result.error?.currentState).toBe('Blocked');
      expect(result.error?.validTransitions).toContain('In Progress');
      // s85-m01: suggestions now name the CONSOLIDATED tool — the pre-s85 name was removed in the 38→15 consolidation.
      expect(result.error?.suggestion).toContain('rbook_mission_transition(action="unblock")');
    });

    it('should return MISSING_PARAMETER for empty mission ID', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('missionId');
    });

    it('should return MISSING_PARAMETER for whitespace-only mission ID', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: '   ' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookMissionStartToolDefinition.name).toBe('rbook_mission_start');
    });

    it('should have comprehensive description', () => {
      expect(rbookMissionStartToolDefinition.description).toContain('In Progress');
      expect(rbookMissionStartToolDefinition.description).toContain('INVALID_STATE_TRANSITION');
    });

    it('should require missionId parameter', () => {
      expect(rbookMissionStartToolDefinition.inputSchema.required).toContain('missionId');
    });
  });

  describe('formatMissionStartForLLM', () => {
    it('should format success result', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });
      const formatted = formatMissionStartForLLM(result);

      expect(formatted).toContain("Mission 'm-queued' started");
      expect(formatted).toContain('Queued → In Progress');
    });

    it('should format error result with suggestion', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'nonexistent' });
      const formatted = formatMissionStartForLLM(result);

      expect(formatted).toContain('Failed to start mission');
      expect(formatted).toContain('Suggestion');
    });
  });
});

describe('rbook_mission_complete', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should complete an In Progress mission', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-in-progress' });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('m-in-progress');
      expect(result.data?.previousStatus).toBe('In Progress');
      expect(result.data?.currentStatus).toBe('Completed');
      expect(result.data?.completedAt).toBeDefined();
    });

    it('should include notes in completion', async () => {
      const result = await callMissionComplete(testDb.dbPath, {
        missionId: 'm-in-progress',
        notes: 'All tests passing',
      });

      expect(result.success).toBe(true);

      const row = testDb.db
        .prepare('SELECT notes FROM missions WHERE id = ?')
        .get('m-in-progress') as {
        notes: string;
      };
      expect(row.notes).toContain('[Completed] All tests passing');
    });

    it('should set completed_at timestamp', async () => {
      await callMissionComplete(testDb.dbPath, { missionId: 'm-in-progress' });

      const row = testDb.db
        .prepare('SELECT completed_at FROM missions WHERE id = ?')
        .get('m-in-progress') as { completed_at: string };
      expect(row.completed_at).toBeDefined();
      expect(new Date(row.completed_at).getTime()).toBeGreaterThan(0);
    });

    it('should update mission status in database', async () => {
      await callMissionComplete(testDb.dbPath, { missionId: 'm-in-progress' });

      const row = testDb.db
        .prepare('SELECT status FROM missions WHERE id = ?')
        .get('m-in-progress') as { status: string };
      expect(row.status).toBe('Completed');
    });

    it('should log event to session_events', async () => {
      await callMissionComplete(testDb.dbPath, { missionId: 'm-in-progress' });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ? AND action = ?')
        .get('m-in-progress', 'complete') as { action: string };
      expect(event).toBeDefined();
      expect(event.action).toBe('complete');
    });
  });

  describe('error cases', () => {
    it('should return MISSION_NOT_FOUND for non-existent mission', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_NOT_FOUND);
    });

    it('should return MISSION_ALREADY_COMPLETED for Completed mission', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-completed' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_ALREADY_COMPLETED);
      expect(result.error?.suggestion).toContain('already been completed');
    });

    it('should return INVALID_STATE_TRANSITION for Queued mission', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-queued' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_INVALID_TRANSITION);
      expect(result.error?.currentState).toBe('Queued');
    });

    it('should return INVALID_STATE_TRANSITION for Blocked mission', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-blocked' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_INVALID_TRANSITION);
    });

    it('should return MISSING_PARAMETER for empty mission ID', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookMissionCompleteToolDefinition.name).toBe('rbook_mission_complete');
    });

    it('should have comprehensive description', () => {
      expect(rbookMissionCompleteToolDefinition.description).toContain('Completed');
      expect(rbookMissionCompleteToolDefinition.description).toContain('In Progress');
    });
  });

  describe('formatMissionCompleteForLLM', () => {
    it('should format success result', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-in-progress' });
      const formatted = formatMissionCompleteForLLM(result);

      expect(formatted).toContain("Mission 'm-in-progress' completed");
      expect(formatted).toContain('In Progress → Completed');
    });

    it('should format error result', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'm-queued' });
      const formatted = formatMissionCompleteForLLM(result);

      expect(formatted).toContain('Failed to complete mission');
    });
  });
});

describe('rbook_mission_block', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should block an In Progress mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: 'Waiting on API access',
      });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('m-in-progress');
      expect(result.data?.previousStatus).toBe('In Progress');
      expect(result.data?.currentStatus).toBe('Blocked');
      expect(result.data?.reason).toBe('Waiting on API access');
      expect(result.data?.blockedAt).toBeDefined();
    });

    it('should block a Current mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-current',
        reason: 'Dependencies not ready',
      });

      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('Current');
      expect(result.data?.currentStatus).toBe('Blocked');
    });

    it('should include blockers list in domain_fields', async () => {
      await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: 'External dependency',
        blockers: ['API access', 'Auth tokens'],
      });

      const row = testDb.db
        .prepare('SELECT domain_fields FROM missions WHERE id = ?')
        .get('m-in-progress') as { domain_fields: string };
      const domainFields = JSON.parse(row.domain_fields);

      expect(domainFields.blocker).toBe('External dependency');
      expect(domainFields.blockers).toEqual(['API access', 'Auth tokens']);
      expect(domainFields.blockedSince).toBeDefined();
    });

    it('should update notes with blocker info', async () => {
      await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: 'Blocked reason',
        blockers: ['Item 1', 'Item 2'],
      });

      const row = testDb.db
        .prepare('SELECT notes FROM missions WHERE id = ?')
        .get('m-in-progress') as {
        notes: string;
      };
      expect(row.notes).toContain('[Blocked]');
      expect(row.notes).toContain('Needs: Item 1, Item 2');
    });

    it('should log event to session_events', async () => {
      await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: 'Test block',
      });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ? AND action = ?')
        .get('m-in-progress', 'block') as { action: string; summary: string };
      expect(event).toBeDefined();
      expect(event.action).toBe('block');
      expect(event.summary).toBe('Test block');
    });
  });

  describe('error cases', () => {
    it('should return MISSION_NOT_FOUND for non-existent mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'nonexistent',
        reason: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_NOT_FOUND);
    });

    it('should return MISSION_ALREADY_BLOCKED for Blocked mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-blocked',
        reason: 'Another reason',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_ALREADY_BLOCKED);
      expect(result.error?.suggestion).toContain('unblock');
    });

    it('blocks Queued work without requiring a false start', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-queued',
        reason: 'Waiting before work can begin',
      });

      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('Queued');
      expect(result.data?.currentStatus).toBe('Blocked');
    });

    it('should return INVALID_STATE_TRANSITION for Completed mission', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-completed',
        reason: 'Cannot block completed',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_INVALID_TRANSITION);
    });

    it('should return MISSING_PARAMETER for empty mission ID', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: '',
        reason: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('missionId');
    });

    it('should return MISSING_PARAMETER for empty reason', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: '',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('reason');
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookMissionBlockToolDefinition.name).toBe('rbook_mission_block');
    });

    it('should require missionId and reason parameters', () => {
      expect(rbookMissionBlockToolDefinition.inputSchema.required).toContain('missionId');
      expect(rbookMissionBlockToolDefinition.inputSchema.required).toContain('reason');
    });
  });

  describe('formatMissionBlockForLLM', () => {
    it('should format success result with block icon', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'm-in-progress',
        reason: 'Test reason',
      });
      const formatted = formatMissionBlockForLLM(result);

      expect(formatted).toContain("Mission 'm-in-progress' blocked");
      expect(formatted).toContain('Reason: Test reason');
      expect(formatted).toContain('⊘');
    });
  });
});

describe('rbook_mission_unblock', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should unblock a Blocked mission to In Progress', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'm-blocked' });

      expect(result.success).toBe(true);
      expect(result.data?.missionId).toBe('m-blocked');
      expect(result.data?.previousStatus).toBe('Blocked');
      expect(result.data?.currentStatus).toBe('In Progress');
      expect(result.data?.unblockedAt).toBeDefined();
    });

    it('should unblock to Current status when specified', async () => {
      const result = await callMissionUnblock(testDb.dbPath, {
        missionId: 'm-blocked',
        targetStatus: 'Current',
      });

      expect(result.success).toBe(true);
      expect(result.data?.currentStatus).toBe('Current');
    });

    it('should include resolution notes', async () => {
      const result = await callMissionUnblock(testDb.dbPath, {
        missionId: 'm-blocked',
        resolution: 'API access granted',
      });

      expect(result.success).toBe(true);
      expect(result.data?.resolution).toBe('API access granted');
    });

    it('should clear blocker info from domain_fields', async () => {
      await callMissionUnblock(testDb.dbPath, {
        missionId: 'm-blocked',
        resolution: 'Resolved',
      });

      const row = testDb.db
        .prepare('SELECT domain_fields FROM missions WHERE id = ?')
        .get('m-blocked') as { domain_fields: string };
      const domainFields = JSON.parse(row.domain_fields);

      expect(domainFields.blocker).toBeNull();
      expect(domainFields.blockedSince).toBeNull();
      expect(domainFields.previousBlocker).toBe('external-api');
      expect(domainFields.unblockedAt).toBeDefined();
      expect(domainFields.resolution).toBe('Resolved');
    });

    it('should update notes with unblock info', async () => {
      await callMissionUnblock(testDb.dbPath, {
        missionId: 'm-blocked',
        resolution: 'Fixed the issue',
      });

      const row = testDb.db.prepare('SELECT notes FROM missions WHERE id = ?').get('m-blocked') as {
        notes: string;
      };
      expect(row.notes).toContain('[Unblocked] Fixed the issue');
    });

    it('should log event to session_events', async () => {
      await callMissionUnblock(testDb.dbPath, { missionId: 'm-blocked' });

      const event = testDb.db
        .prepare('SELECT * FROM session_events WHERE mission = ? AND action = ?')
        .get('m-blocked', 'unblock') as { action: string };
      expect(event).toBeDefined();
      expect(event.action).toBe('unblock');
    });
  });

  describe('error cases', () => {
    it('should return MISSION_NOT_FOUND for non-existent mission', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_NOT_FOUND);
    });

    /**
     * s87-m01 — THIS ASSERTION USED TO PIN A TOOL THAT DOES NOT EXIST, and it was green.
     *
     * The deleted hand-copy emitted `'Use rbook_mission_start to begin work on this mission'`
     * (old file, line 587). `rbook_mission_start` was retired in the 38→15 consolidation; the real
     * handler has said `rbook_mission_transition(action="start")` for four sprints. So the copy was
     * stale agent-facing prose AND the test held it in place — the exact class `s85-m01`'s gate
     * sweeps `src/` for, living in `tests/`, where that gate does not look.
     *
     * WHAT IS ASSERTED NOW is the behaviour, not a string: `start` REFUSES from 'In Progress'
     * (measured through the real router — 'In Progress' transitions to Completed/Blocked/Dropped/
     * Deferred, never to itself), so the refusal must NOT prescribe it. That is the Tier-2 rule in
     * `remedy-reachability.test.ts` stated as a unit assertion.
     */
    it('should return MISSION_INVALID_STATE for non-blocked mission, without prescribing start', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'm-in-progress' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_INVALID_STATE);
      expect(result.error?.currentState).toBe('In Progress');
      // It says why there is nothing to do…
      expect(result.error?.suggestion).toContain('already In Progress');
      // …and does not prescribe a remedy that refuses from this state.
      expect(result.error?.suggestion).not.toContain('action="start"');
      // The retired name must not come back on any path.
      expect(result.error?.suggestion).not.toContain('rbook_mission_start');
    });

    it('should return MISSION_INVALID_STATE for Queued mission', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'm-queued' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_INVALID_STATE);
      // Queued is the one state where `start` IS a valid transition, so it is still prescribed —
      // under its CURRENT name. This is the positive half of the pair above.
      expect(result.error?.suggestion).toContain('rbook_mission_transition(action="start"');
    });

    it('should return MISSION_INVALID_STATE for Completed mission', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'm-completed' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSION_INVALID_STATE);
      // s87-m01: the old text was 'Cannot unblock a completed mission'. Accurate but incomplete —
      // it left an operator believing the record was frozen. Only the STATUS is settled; the
      // mission's other fields remain editable, and the refusal now says which is which.
      expect(result.error?.suggestion).toContain('no blocker to clear');
      expect(result.error?.suggestion).toContain('rbook_mission(action="update")');
    });

    it('should return MISSING_PARAMETER for empty mission ID', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookMissionUnblockToolDefinition.name).toBe('rbook_mission_unblock');
    });

    it('should only require missionId parameter', () => {
      expect(rbookMissionUnblockToolDefinition.inputSchema.required).toContain('missionId');
      expect(rbookMissionUnblockToolDefinition.inputSchema.required).not.toContain('resolution');
      expect(rbookMissionUnblockToolDefinition.inputSchema.required).not.toContain('targetStatus');
    });

    it('should include targetStatus enum options', () => {
      const props = rbookMissionUnblockToolDefinition.inputSchema.properties;
      expect(props.targetStatus.enum).toContain('In Progress');
      expect(props.targetStatus.enum).toContain('Current');
    });
  });

  describe('formatMissionUnblockForLLM', () => {
    it('should format success result', async () => {
      const result = await callMissionUnblock(testDb.dbPath, {
        missionId: 'm-blocked',
        resolution: 'Problem solved',
      });
      const formatted = formatMissionUnblockForLLM(result);

      expect(formatted).toContain("Mission 'm-blocked' unblocked");
      expect(formatted).toContain('Blocked → In Progress');
      expect(formatted).toContain('Resolution: Problem solved');
    });

    it('should format error result', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'm-queued' });
      const formatted = formatMissionUnblockForLLM(result);

      expect(formatted).toContain('Failed to unblock mission');
      expect(formatted).toContain('not blocked');
    });
  });
});

describe('state transition integration', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('should allow full lifecycle: Queued -> In Progress -> Completed', async () => {
    // Start
    const startResult = await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });
    expect(startResult.success).toBe(true);
    expect(startResult.data?.currentStatus).toBe('In Progress');

    // Complete
    const completeResult = await callMissionComplete(testDb.dbPath, { missionId: 'm-queued' });
    expect(completeResult.success).toBe(true);
    expect(completeResult.data?.currentStatus).toBe('Completed');
  });

  it('should allow block and unblock cycle', async () => {
    // Block
    const blockResult = await callMissionBlock(testDb.dbPath, {
      missionId: 'm-in-progress',
      reason: 'Waiting on dependency',
    });
    expect(blockResult.success).toBe(true);
    expect(blockResult.data?.currentStatus).toBe('Blocked');

    // Unblock
    const unblockResult = await callMissionUnblock(testDb.dbPath, {
      missionId: 'm-in-progress',
      resolution: 'Dependency resolved',
    });
    expect(unblockResult.success).toBe(true);
    expect(unblockResult.data?.currentStatus).toBe('In Progress');

    // Complete after unblock
    const completeResult = await callMissionComplete(testDb.dbPath, {
      missionId: 'm-in-progress',
    });
    expect(completeResult.success).toBe(true);
    expect(completeResult.data?.currentStatus).toBe('Completed');
  });

  it('should track full history in session_events', async () => {
    // Full lifecycle
    await callMissionStart(testDb.dbPath, { missionId: 'm-queued' });
    await callMissionBlock(testDb.dbPath, { missionId: 'm-queued', reason: 'Blocked' });
    await callMissionUnblock(testDb.dbPath, { missionId: 'm-queued' });
    await callMissionComplete(testDb.dbPath, { missionId: 'm-queued' });

    const events = testDb.db
      .prepare('SELECT action FROM session_events WHERE mission = ? ORDER BY ts')
      .all('m-queued') as { action: string }[];

    expect(events.map((e) => e.action)).toEqual(['start', 'block', 'unblock', 'complete']);
  });
});
