/**
 * Integration Lifecycle Tests
 *
 * End-to-end tests that verify all Sprint 13 Reasonbook tools work together
 * in realistic workflows. Tests cover:
 * - Full mission lifecycle: list -> start -> update -> complete
 * - Blocking flow: list -> start -> block -> unblock -> complete
 * - Cross-tool consistency and state management
 *
 * @module tests/tools/rbook/integration-lifecycle
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { RbookToolResult, MissionStatus } from '../../../src/tools/rbook/types';
import {
  rbookMissionStart,
  type MissionStartResult,
} from '../../../src/tools/rbook/rbook-mission-start';
import {
  rbookMissionComplete,
  type MissionCompleteResult,
} from '../../../src/tools/rbook/rbook-mission-complete';
import {
  rbookMissionBlock,
  type MissionBlockResult,
} from '../../../src/tools/rbook/rbook-mission-block';
import {
  rbookMissionUnblock,
  type MissionUnblockResult,
} from '../../../src/tools/rbook/rbook-mission-unblock';
import {
  rbookMissionUpdate,
  type MissionUpdateResult,
  type MissionUpdateFields,
} from '../../../src/tools/rbook/rbook-mission-update';
import {
  rbookMissionList,
  type RbookMissionListResult,
} from '../../../src/tools/rbook/rbook-mission-list';
import {
  rbookMissionStatus,
  type RbookMissionStatusResult,
} from '../../../src/tools/rbook/rbook-mission-status';
import { seedRbookDb } from '../../helpers/seedRbookDb';

/**
 * Test database setup interface
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

/**
 * Create a test database with realistic mission data
 */
function createTestDb(): TestDb {
  // s95-m09: a seeded project (the full Reasonbook schema at <root>/rbook/db/rbook.sqlite), so the shipped
  // handlers run against the store layout they run against in use.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-integration-test-'));
  const dbPath = seedRbookDb(tempDir, { projectName: 'integration-test' });
  const db = new Database(dbPath);

  db.exec(`
    -- Insert sprint
    INSERT INTO sprints (id, title, focus, status, total_missions, completed_missions)
    VALUES ('sprint-integration', 'Integration Test Sprint', 'End-to-end workflow testing', 'In Progress', 5, 0);

    -- Insert missions representing a realistic workflow
    INSERT INTO missions (id, sprint_id, name, status, objective, context, success_criteria, deliverables, reference_docs, notes)
    VALUES
      ('int-m01', 'sprint-integration', 'Feature Implementation', 'Queued',
       'Implement new user authentication feature',
       'Users need secure login with OAuth support',
       '["OAuth provider integration works", "Unit tests pass", "Security review complete"]',
       '["src/auth/oauth.ts", "tests/auth/oauth.test.ts"]',
       '["docs/security.md", "docs/oauth-spec.md"]',
       NULL),
      ('int-m02', 'sprint-integration', 'Database Migration', 'Queued',
       'Add new tables for user preferences',
       'Need to store user settings in a normalized way',
       '["Migration runs without errors", "Data integrity verified"]',
       '["migrations/001_preferences.sql"]',
       '["docs/db-schema.md"]',
       NULL),
      ('int-m03', 'sprint-integration', 'API Endpoint', 'Current',
       'Create REST endpoint for preferences',
       'Frontend needs to read/write preferences',
       '["Endpoint returns correct data", "Error handling works"]',
       '["src/api/preferences.ts"]',
       NULL,
       NULL),
      ('int-m04', 'sprint-integration', 'UI Components', 'In Progress',
       'Build settings panel UI',
       'Users need visual interface for preferences',
       '["Component renders correctly", "Accessibility checks pass"]',
       '["src/components/SettingsPanel.tsx"]',
       NULL,
       'Working on form validation'),
      ('int-m05', 'sprint-integration', 'Testing', 'Blocked',
       'Write E2E tests for the entire flow',
       'Need comprehensive test coverage',
       '["All E2E tests pass", "Coverage > 80%"]',
       '["tests/e2e/preferences.test.ts"]',
       NULL,
       '[Blocked] Waiting on UI components');

  `);

  return { tempDir, dbPath, db };
}

function cleanupTestDb(testDb: TestDb): void {
  testDb.db.close();
  if (testDb.tempDir) {
    fs.rmSync(testDb.tempDir, { recursive: true, force: true });
  }
}

// =============================================================================
// Tool Helper Functions
// =============================================================================
// s95-m09: each helper used to hold its own copy of a mission handler (its own SQL, validation and
// transition rules), so this "integration" file tested seven copies and none of the shipped
// transitions. Each now maps the store path (<root>/rbook/db/rbook.sqlite) to its project root and
// calls the shipped handler.

function projectRootOf(dbPath: string): string {
  return path.dirname(path.dirname(path.dirname(dbPath)));
}

async function callMissionList(
  dbPath: string,
  params: { status?: MissionStatus; sprintId?: string; limit?: number } = {}
): Promise<RbookToolResult<RbookMissionListResult>> {
  return rbookMissionList({ ...params, projectRoot: projectRootOf(dbPath) });
}

async function callMissionStatus(
  dbPath: string,
  params: { includeBlocked?: boolean; queuedLimit?: number } = {}
): Promise<RbookToolResult<RbookMissionStatusResult>> {
  return rbookMissionStatus({ ...params, projectRoot: projectRootOf(dbPath) });
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

async function callMissionUpdate(
  dbPath: string,
  params: { missionId: string; fields: MissionUpdateFields }
): Promise<RbookToolResult<MissionUpdateResult>> {
  return rbookMissionUpdate({ ...params, projectRoot: projectRootOf(dbPath) });
}

// =============================================================================
// Integration Tests
// =============================================================================

describe('Integration: Full Mission Lifecycle', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('Workflow: list -> start -> update -> complete', () => {
    it('should complete full lifecycle for a Queued mission', async () => {
      // 1. List missions to find Queued ones
      const listResult = await callMissionList(testDb.dbPath, { status: 'Queued' });
      expect(listResult.success).toBe(true);
      expect(listResult.data?.missions.length).toBeGreaterThan(0);

      const queuedMission = listResult.data?.missions.find((m) => m.id === 'int-m01');
      expect(queuedMission).toBeDefined();
      expect(queuedMission?.status).toBe('Queued');

      // 2. Start the mission
      const startResult = await callMissionStart(testDb.dbPath, {
        missionId: 'int-m01',
        notes: 'Beginning OAuth implementation',
      });
      expect(startResult.success).toBe(true);
      expect(startResult.data?.previousStatus).toBe('Queued');
      expect(startResult.data?.currentStatus).toBe('In Progress');

      // 3. Verify status changed via list
      const listAfterStart = await callMissionList(testDb.dbPath, { status: 'In Progress' });
      expect(listAfterStart.success).toBe(true);
      expect(listAfterStart.data?.missions.some((m) => m.id === 'int-m01')).toBe(true);

      // 4. Update the mission with progress notes
      const updateResult = await callMissionUpdate(testDb.dbPath, {
        missionId: 'int-m01',
        fields: {
          notes: 'OAuth provider integrated, working on tests',
          successCriteria: [
            'OAuth provider integration works',
            'Unit tests pass',
            'Security review complete',
            'Documentation updated',
          ],
        },
      });
      expect(updateResult.success).toBe(true);
      expect(updateResult.data?.updatedFields).toContain('notes');
      expect(updateResult.data?.updatedFields).toContain('successCriteria');

      // 5. Complete the mission
      const completeResult = await callMissionComplete(testDb.dbPath, {
        missionId: 'int-m01',
        notes: 'All criteria met, OAuth fully implemented',
      });
      expect(completeResult.success).toBe(true);
      expect(completeResult.data?.previousStatus).toBe('In Progress');
      expect(completeResult.data?.currentStatus).toBe('Completed');

      // 6. Verify final state
      const finalList = await callMissionList(testDb.dbPath, { status: 'Completed' });
      expect(finalList.success).toBe(true);
      expect(finalList.data?.missions.some((m) => m.id === 'int-m01')).toBe(true);
    });

    it('should show mission in correct queue position via status tool', async () => {
      // Check initial status
      const statusBefore = await callMissionStatus(testDb.dbPath, { includeBlocked: true });
      expect(statusBefore.success).toBe(true);
      expect(statusBefore.data?.inProgress.some((m) => m.id === 'int-m04')).toBe(true);
      expect(statusBefore.data?.current.some((m) => m.id === 'int-m03')).toBe(true);
      expect(statusBefore.data?.queued.some((m) => m.id === 'int-m01')).toBe(true);
      expect(statusBefore.data?.blocked?.some((m) => m.id === 'int-m05')).toBe(true);

      // Start a queued mission
      await callMissionStart(testDb.dbPath, { missionId: 'int-m01' });

      // Verify it moved to In Progress
      const statusAfter = await callMissionStatus(testDb.dbPath);
      expect(statusAfter.success).toBe(true);
      expect(statusAfter.data?.inProgress.some((m) => m.id === 'int-m01')).toBe(true);
      expect(statusAfter.data?.queued.every((m) => m.id !== 'int-m01')).toBe(true);
    });
  });

  describe('Workflow: blocking and unblocking', () => {
    it('should validate unblock only works on blocked missions', async () => {
      // Try to unblock a non-blocked mission
      const result = await callMissionUnblock(testDb.dbPath, {
        missionId: 'int-m01', // Queued, not blocked
        resolution: 'Test resolution',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_STATE');
    });

    it('should allow full Queued -> In Progress -> Completed flow', async () => {
      // Use a queued mission
      const missionId = 'int-m02';

      // Start
      const startResult = await callMissionStart(testDb.dbPath, { missionId });
      expect(startResult.success).toBe(true);
      expect(startResult.data?.currentStatus).toBe('In Progress');

      // Complete
      const completeResult = await callMissionComplete(testDb.dbPath, { missionId });
      expect(completeResult.success).toBe(true);
      expect(completeResult.data?.currentStatus).toBe('Completed');

      // Verify final state via direct db query
      const dbCheck = testDb.db
        .prepare('SELECT status, completed_at FROM missions WHERE id = ?')
        .get(missionId) as { status: string; completed_at: string };
      expect(dbCheck.status).toBe('Completed');
      expect(dbCheck.completed_at).toBeDefined();
    });
  });

  describe('Cross-tool state consistency', () => {
    it('should maintain consistent state across all query tools', async () => {
      // Start a mission
      await callMissionStart(testDb.dbPath, { missionId: 'int-m01' });

      // Query via list with status filter
      const listInProgress = await callMissionList(testDb.dbPath, { status: 'In Progress' });
      const listQueued = await callMissionList(testDb.dbPath, { status: 'Queued' });

      // Query via status
      const status = await callMissionStatus(testDb.dbPath);

      // All should agree
      expect(listInProgress.data?.missions.some((m) => m.id === 'int-m01')).toBe(true);
      expect(listQueued.data?.missions.every((m) => m.id !== 'int-m01')).toBe(true);
      expect(status.data?.inProgress.some((m) => m.id === 'int-m01')).toBe(true);
    });

    it('should update list counts after status changes', async () => {
      const beforeStart = await callMissionList(testDb.dbPath, { status: 'Queued' });
      const queuedCountBefore = beforeStart.data?.totalCount ?? 0;

      await callMissionStart(testDb.dbPath, { missionId: 'int-m01' });
      await callMissionStart(testDb.dbPath, { missionId: 'int-m02' });

      const afterStart = await callMissionList(testDb.dbPath, { status: 'Queued' });
      const queuedCountAfter = afterStart.data?.totalCount ?? 0;

      expect(queuedCountAfter).toBe(queuedCountBefore - 2);
    });
  });

  describe('Error handling across tools', () => {
    it('should prevent completing a Queued mission (must start first)', async () => {
      const result = await callMissionComplete(testDb.dbPath, { missionId: 'int-m01' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_TRANSITION');
      expect(result.error?.currentState).toBe('Queued');
    });

    it('should prevent starting an already In Progress mission', async () => {
      const result = await callMissionStart(testDb.dbPath, { missionId: 'int-m04' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_STATE');
    });

    it('should return a blocked Queued mission to the queue without starting it', async () => {
      const result = await callMissionBlock(testDb.dbPath, {
        missionId: 'int-m01',
        reason: 'Waiting for a prerequisite before starting',
      });

      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('Queued');
      expect(result.data?.currentStatus).toBe('Blocked');
      const unblocked = await callMissionUnblock(testDb.dbPath, { missionId: 'int-m01' });
      expect(unblocked.success).toBe(true);
      expect(unblocked.data?.currentStatus).toBe('Queued');
      expect(
        testDb.db.prepare('SELECT started_at FROM missions WHERE id = ?').get('int-m01')
      ).toEqual({ started_at: null });
    });

    it('should prevent unblocking a non-blocked mission', async () => {
      const result = await callMissionUnblock(testDb.dbPath, { missionId: 'int-m04' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_STATE');
    });

    it('should prevent invalid status update via update tool', async () => {
      const result = await callMissionUpdate(testDb.dbPath, {
        missionId: 'int-m01',
        fields: { status: 'Completed' }, // Invalid: Queued -> Completed
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_INVALID_TRANSITION');
    });
  });

  describe('Mission update integration', () => {
    it('should allow updating mission details while In Progress', async () => {
      // Already In Progress mission
      const missionId = 'int-m04';

      // Update multiple fields
      const updateResult = await callMissionUpdate(testDb.dbPath, {
        missionId,
        fields: {
          objective: 'Updated: Build settings panel UI with accessibility focus',
          successCriteria: [
            'Component renders correctly',
            'Accessibility checks pass',
            'Responsive design works',
          ],
          deliverables: [
            'src/components/SettingsPanel.tsx',
            'src/components/SettingsPanel.test.tsx',
          ],
        },
      });

      expect(updateResult.success).toBe(true);
      expect(updateResult.data?.updatedFields.length).toBe(3);

      // Verify via database
      const row = testDb.db
        .prepare('SELECT objective, success_criteria, deliverables FROM missions WHERE id = ?')
        .get(missionId) as {
        objective: string;
        success_criteria: string;
        deliverables: string;
      };

      expect(row.objective).toContain('accessibility focus');
      expect(JSON.parse(row.success_criteria)).toHaveLength(3);
      expect(JSON.parse(row.deliverables)).toContain('src/components/SettingsPanel.test.tsx');
    });

    it('should allow status transition via update tool', async () => {
      // Start queued mission via update tool
      const updateResult = await callMissionUpdate(testDb.dbPath, {
        missionId: 'int-m01',
        fields: {
          status: 'In Progress',
          notes: 'Starting via update tool',
        },
      });

      expect(updateResult.success).toBe(true);
      expect(updateResult.data?.previousStatus).toBe('Queued');
      expect(updateResult.data?.currentStatus).toBe('In Progress');

      // Verify via status tool
      const status = await callMissionStatus(testDb.dbPath);
      expect(status.data?.inProgress.some((m) => m.id === 'int-m01')).toBe(true);
    });
  });
});

describe('Integration: Sprint-scoped operations', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('should filter missions by sprint', async () => {
    const result = await callMissionList(testDb.dbPath, { sprintId: 'sprint-integration' });

    expect(result.success).toBe(true);
    expect(result.data?.missions.length).toBe(5);
    expect(result.data?.missions.every((m) => m.sprintId === 'sprint-integration')).toBe(true);
  });

  it('should filter by both sprint and status', async () => {
    const result = await callMissionList(testDb.dbPath, {
      sprintId: 'sprint-integration',
      status: 'Queued',
    });

    expect(result.success).toBe(true);
    expect(result.data?.missions.length).toBe(2);
    expect(result.data?.missions.every((m) => m.status === 'Queued')).toBe(true);
  });
});
