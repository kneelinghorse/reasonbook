/**
 * Context Operations Tools Tests
 *
 * Comprehensive tests for all context operation tools:
 * - rbook_context_view
 * - rbook_context_snapshot
 * - rbook_context_history
 *
 * Each tool has 8+ tests covering happy paths and error cases.
 *
 * @module tests/tools/rbook/context-ops
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { RbookToolResult } from '../../../src/tools/rbook/types';

// Import tool implementations and types
import {
  rbookContextView,
  rbookContextViewToolDefinition,
  formatContextViewForLLM,
  type RbookContextViewResult,
} from '../../../src/tools/rbook/rbook-context-view';

import {
  rbookContextSnapshot,
  rbookContextSnapshotToolDefinition,
  formatContextSnapshotForLLM,
  type RbookContextSnapshotResult,
} from '../../../src/tools/rbook/rbook-context-snapshot';

import {
  rbookContextHistory,
  rbookContextHistoryToolDefinition,
  formatContextHistoryForLLM,
  type RbookContextHistoryResult,
} from '../../../src/tools/rbook/rbook-context-history';

/**
 * Helper to create test database with contexts table and test data.
 */
interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-context-test-'));
  const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);

  // Create schema
  db.exec(`
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
      created_at TEXT NOT NULL,
      FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_context_snapshots_ctx ON context_snapshots (context_id, created_at);
    CREATE INDEX idx_context_snapshots_hash ON context_snapshots (context_id, content_hash);

    -- s95-m09: the shipped view reads decisions and learnings from these tables (since Sprint 51),
    -- not from master_context's JSON, which only the old test-local copy of the handler read.
    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    INSERT INTO strategic_decisions (decision_text, status, created_at)
    VALUES
      ('Use TypeScript', 'active', '2024-01-10T10:00:00Z'),
      ('Choose SQLite', 'active', '2024-01-11T10:00:00Z'),
      ('Use JavaScript', 'superseded', '2024-01-09T10:00:00Z');
    INSERT INTO learnings (content, status, created_at)
    VALUES
      ('Finding 1', 'active', '2024-01-10T10:00:00Z'),
      ('Finding 2', 'active', '2024-01-11T10:00:00Z');

    -- Insert test contexts
    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES (
      'master_context',
      'context/MASTER_CONTEXT.json',
      '{"project_name": "Test Project", "decisions_made": ["Use TypeScript", "Choose SQLite"], "constraints": ["No external services"], "research_findings": ["Finding 1", "Finding 2"]}',
      '2024-01-15T10:00:00Z'
    );

    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES (
      'project_context',
      'PROJECT_CONTEXT.json',
      '{"active_mission": "s12-m03", "session_count": 5, "working_memory": {"next_steps": ["Step 1", "Step 2"]}}',
      '2024-01-15T12:00:00Z'
    );

    -- Insert some test snapshots
    INSERT INTO context_snapshots (context_id, session_id, source, content_hash, content, created_at)
    VALUES
      ('master_context', 'session-1', 'Sprint 11 completed', 'hash001', '{"version": 1}', '2024-01-10T10:00:00Z'),
      ('master_context', 'session-2', 'Architecture decision', 'hash002', '{"version": 2}', '2024-01-12T10:00:00Z'),
      ('project_context', NULL, 'Session checkpoint', 'hash003', '{"state": 1}', '2024-01-14T10:00:00Z'),
      ('master_context', NULL, 'Sprint 12 started', 'hash004', '{"version": 3}', '2024-01-15T10:00:00Z');
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
 * Helpers that run the shipped context handlers against the fixture's store.
 * s95-m09: each used to hold its own copy of its handler (its SQL, duplicate check and paging), so
 * these cases tested the copies rather than shipped code. They now map the store path
 * (<root>/rbook/db/rbook.sqlite) to its project root and call the handlers.
 */
function projectRootOf(dbPath: string): string {
  return path.dirname(path.dirname(path.dirname(dbPath)));
}

/** These cases read the documents, so they ask for the full view (s106-m03: the digest is the default). */
async function callContextView(
  dbPath: string,
  params: { contextType?: 'master_context' | 'project_context' } = {}
): Promise<RbookToolResult<RbookContextViewResult>> {
  return rbookContextView({ ...params, compact: false, projectRoot: projectRootOf(dbPath) });
}

async function callContextSnapshot(
  dbPath: string,
  params: { contextType: 'master_context' | 'project_context'; source: string; sessionId?: string }
): Promise<RbookToolResult<RbookContextSnapshotResult>> {
  return rbookContextSnapshot({ ...params, projectRoot: projectRootOf(dbPath) });
}

async function callContextHistory(
  dbPath: string,
  params: {
    contextType?: 'master_context' | 'project_context';
    since?: string;
    until?: string;
    sessionId?: string;
    page?: number;
    pageSize?: number;
  } = {}
): Promise<RbookToolResult<RbookContextHistoryResult>> {
  return rbookContextHistory({ ...params, projectRoot: projectRootOf(dbPath) });
}

// ============================================================================
// rbook_context_view Tests
// ============================================================================

describe('rbook_context_view', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should return both contexts when no filter is applied', async () => {
      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.masterContext).not.toBeNull();
      expect(result.data?.projectContext).not.toBeNull();
      expect(result.data?.contextCount).toBe(2);
    });

    it('should return only master_context when filtered', async () => {
      const result = await callContextView(testDb.dbPath, { contextType: 'master_context' });

      expect(result.success).toBe(true);
      expect(result.data?.masterContext).not.toBeNull();
      expect(result.data?.projectContext).toBeNull();
      expect(result.data?.contextCount).toBe(1);
    });

    it('should return only project_context when filtered', async () => {
      const result = await callContextView(testDb.dbPath, { contextType: 'project_context' });

      expect(result.success).toBe(true);
      expect(result.data?.masterContext).toBeNull();
      expect(result.data?.projectContext).not.toBeNull();
      expect(result.data?.contextCount).toBe(1);
    });

    it('should parse and return context content', async () => {
      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.masterContext?.content).toHaveProperty('project_name', 'Test Project');
      expect(result.data?.projectContext?.content).toHaveProperty('active_mission', 's12-m03');
    });

    it('should return correct source paths', async () => {
      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.masterContext?.sourcePath).toBe('context/MASTER_CONTEXT.json');
      expect(result.data?.projectContext?.sourcePath).toBe('PROJECT_CONTEXT.json');
    });

    it('should extract aggregated view correctly', async () => {
      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      const agg = result.data?.aggregated;

      expect(agg?.activeMission).toBe('s12-m03');
      expect(agg?.sessionCount).toBe(5);
      expect(agg?.decisions).toContain('Use TypeScript');
      expect(agg?.constraints).toContain('No external services');
      expect(agg?.learnings).toContain('Finding 1');
      expect(agg?.nextSteps).toContain('Step 1');
    });

    it('should return updatedAt timestamps', async () => {
      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.masterContext?.updatedAt).toBe('2024-01-15T10:00:00Z');
      expect(result.data?.projectContext?.updatedAt).toBe('2024-01-15T12:00:00Z');
    });

    it('should handle missing aggregated fields gracefully', async () => {
      // Update master_context to have no arrays, and leave the decision record empty (the shipped
      // view reads decisions from strategic_decisions, not from master_context).
      testDb.db.exec(
        `UPDATE contexts SET content = '{"project_name": "Test"}' WHERE id = 'master_context';
         DELETE FROM strategic_decisions;`
      );

      const result = await callContextView(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.aggregated.decisions).toEqual([]);
      expect(result.data?.aggregated.constraints).toEqual([]);
    });
  });

  describe('error cases', () => {
    it('should return CONTEXT_NOT_FOUND when filtered context does not exist', async () => {
      // Delete master_context
      testDb.db.exec(`DELETE FROM contexts WHERE id = 'master_context'`);

      const result = await callContextView(testDb.dbPath, { contextType: 'master_context' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.CONTEXT_NOT_FOUND);
    });

    it('should handle malformed JSON gracefully', async () => {
      testDb.db.exec(`UPDATE contexts SET content = 'invalid json' WHERE id = 'master_context'`);

      const result = await callContextView(testDb.dbPath);

      // Should still succeed but with empty content or null for master
      expect(result.success).toBe(true);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookContextViewToolDefinition.name).toBe('rbook_context_view');
    });

    it('should have comprehensive description', () => {
      expect(rbookContextViewToolDefinition.description).toContain('master_context');
      expect(rbookContextViewToolDefinition.description).toContain('project_context');
    });

    it('should not require any parameters', () => {
      // No required array means all parameters are optional
      expect(
        (rbookContextViewToolDefinition.inputSchema as Record<string, unknown>).required
      ).toBeUndefined();
    });
  });

  describe('formatContextViewForLLM', () => {
    it('should format success result with aggregated data', async () => {
      const result = await callContextView(testDb.dbPath);
      const formatted = formatContextViewForLLM(result);

      expect(formatted).toContain('Reasonbook Context View');
      expect(formatted).toContain('Active Mission');
      expect(formatted).toContain('Decisions Made');
    });

    it('should format error result with suggestion', async () => {
      testDb.db.exec(`DELETE FROM contexts`);
      const result = await callContextView(testDb.dbPath, { contextType: 'master_context' });
      const formatted = formatContextViewForLLM(result);

      // s95-m09: the handler's own not-found error and its suggestion, not any failure.
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.CONTEXT_NOT_FOUND);
      expect(result.error?.suggestion).toBeTruthy();
      expect(formatted).toContain(result.error?.suggestion as string);
      expect(formatted).toContain('Failed to retrieve context');
    });
  });
});

// ============================================================================
// rbook_context_snapshot Tests
// ============================================================================

describe('rbook_context_snapshot', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should create a new snapshot', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Test snapshot',
      });

      expect(result.success).toBe(true);
      expect(result.data?.isNew).toBe(true);
      expect(result.data?.contextId).toBe('master_context');
      expect(result.data?.source).toBe('Test snapshot');
      expect(result.data?.snapshotId).toBeGreaterThan(0);
    });

    it('should detect duplicate content and return existing snapshot', async () => {
      // Create first snapshot
      await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'First snapshot',
      });

      // Try to create another without changing content
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Second snapshot',
      });

      expect(result.success).toBe(true);
      expect(result.data?.isNew).toBe(false);
      expect(result.data?.message).toContain('Duplicate');
    });

    it('should create new snapshot when content changes', async () => {
      // Create first snapshot
      await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'First snapshot',
      });

      // Change content
      testDb.db.exec(
        `UPDATE contexts SET content = '{"changed": true}' WHERE id = 'master_context'`
      );

      // Create second snapshot
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Second snapshot',
      });

      expect(result.success).toBe(true);
      expect(result.data?.isNew).toBe(true);
    });

    it('should associate snapshot with session ID', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'With session',
        sessionId: 'test-session-123',
      });

      expect(result.success).toBe(true);

      const row = testDb.db
        .prepare('SELECT session_id FROM context_snapshots WHERE id = ?')
        .get(result.data?.snapshotId) as { session_id: string };
      expect(row.session_id).toBe('test-session-123');
    });

    it('should calculate content hash correctly', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Hash test',
      });

      expect(result.success).toBe(true);
      expect(result.data?.contentHash).toHaveLength(16);
    });

    it('should store content in snapshot', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Content test',
      });

      const row = testDb.db
        .prepare('SELECT content FROM context_snapshots WHERE id = ?')
        .get(result.data?.snapshotId) as { content: string };
      expect(row.content).toContain('project_name');
    });

    it('should record creation timestamp', async () => {
      const before = new Date().toISOString();
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Time test',
      });
      const after = new Date().toISOString();

      expect(result.success).toBe(true);
      const createdAt = result.data?.createdAt;
      expect(createdAt).toBeDefined();
      expect(createdAt !== undefined && createdAt >= before).toBe(true);
      expect(createdAt !== undefined && createdAt <= after).toBe(true);
    });

    it('should work for project_context', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'project_context',
        source: 'Project snapshot',
      });

      expect(result.success).toBe(true);
      expect(result.data?.contextId).toBe('project_context');
    });
  });

  describe('error cases', () => {
    it('should return CONTEXT_NOT_FOUND for non-existent context', async () => {
      testDb.db.exec(`DELETE FROM contexts WHERE id = 'master_context'`);

      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.CONTEXT_NOT_FOUND);
    });

    it('should return MISSING_PARAMETER for empty source', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: '',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
      expect(result.error?.field).toBe('source');
    });

    it('should return MISSING_PARAMETER for whitespace-only source', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: '   ',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookContextSnapshotToolDefinition.name).toBe('rbook_context_snapshot');
    });

    it('should require contextType and source parameters', () => {
      expect(rbookContextSnapshotToolDefinition.inputSchema.required).toContain('contextType');
      expect(rbookContextSnapshotToolDefinition.inputSchema.required).toContain('source');
    });

    it('should have contextType enum', () => {
      const props = rbookContextSnapshotToolDefinition.inputSchema.properties;
      expect(props.contextType.enum).toContain('master_context');
      expect(props.contextType.enum).toContain('project_context');
    });
  });

  describe('formatContextSnapshotForLLM', () => {
    it('should format new snapshot with camera icon', async () => {
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Test',
      });
      const formatted = formatContextSnapshotForLLM(result);

      expect(formatted).toContain('📸');
      expect(formatted).toContain('created');
      expect(formatted).toContain('master_context');
    });

    it('should format duplicate snapshot with refresh icon', async () => {
      // Create initial
      await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'First',
      });

      // Create duplicate
      const result = await callContextSnapshot(testDb.dbPath, {
        contextType: 'master_context',
        source: 'Second',
      });
      const formatted = formatContextSnapshotForLLM(result);

      expect(formatted).toContain('🔄');
      expect(formatted).toContain('duplicate');
    });
  });
});

// ============================================================================
// rbook_context_history Tests
// ============================================================================

describe('rbook_context_history', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('happy path', () => {
    it('should return all snapshots when no filter is applied', async () => {
      const result = await callContextHistory(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(4);
      expect(result.data?.totalCount).toBe(4);
    });

    it('should filter by contextType', async () => {
      const result = await callContextHistory(testDb.dbPath, { contextType: 'master_context' });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(3);
      expect(result.data?.snapshots.every((s) => s.contextId === 'master_context')).toBe(true);
    });

    it('should filter by sessionId', async () => {
      const result = await callContextHistory(testDb.dbPath, { sessionId: 'session-1' });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(1);
      expect(result.data?.snapshots[0].sessionId).toBe('session-1');
    });

    it('should filter by since date', async () => {
      const result = await callContextHistory(testDb.dbPath, { since: '2024-01-13T00:00:00Z' });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(2); // Only snapshots on 14th and 15th
    });

    it('should filter by until date', async () => {
      const result = await callContextHistory(testDb.dbPath, { until: '2024-01-11T00:00:00Z' });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(1); // Only snapshot on 10th
    });

    it('should filter by date range', async () => {
      const result = await callContextHistory(testDb.dbPath, {
        since: '2024-01-11T00:00:00Z',
        until: '2024-01-13T00:00:00Z',
      });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(1); // Only snapshot on 12th
    });

    it('should return snapshots in descending order by date', async () => {
      const result = await callContextHistory(testDb.dbPath);

      expect(result.success).toBe(true);
      const dates = result.data?.snapshots.map((s) => new Date(s.createdAt).getTime()) ?? [];

      for (let i = 0; i < dates.length - 1; i++) {
        expect(dates[i]).toBeGreaterThanOrEqual(dates[i + 1]);
      }
    });

    it('should paginate correctly', async () => {
      const result = await callContextHistory(testDb.dbPath, { page: 1, pageSize: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(2);
      expect(result.data?.page).toBe(1);
      expect(result.data?.pageSize).toBe(2);
      expect(result.data?.hasMore).toBe(true);
    });

    it('should return correct hasMore flag on last page', async () => {
      const result = await callContextHistory(testDb.dbPath, { page: 2, pageSize: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(2);
      expect(result.data?.hasMore).toBe(false);
    });

    it('should include content size in results', async () => {
      const result = await callContextHistory(testDb.dbPath);

      expect(result.success).toBe(true);
      result.data?.snapshots.forEach((snap) => {
        expect(snap.contentSize).toBeGreaterThan(0);
      });
    });

    it('should return source field for each snapshot', async () => {
      const result = await callContextHistory(testDb.dbPath);

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.some((s) => s.source === 'Sprint 11 completed')).toBe(true);
    });
  });

  describe('empty results', () => {
    it('should return empty array when no snapshots match', async () => {
      const result = await callContextHistory(testDb.dbPath, { sessionId: 'nonexistent-session' });

      expect(result.success).toBe(true);
      expect(result.data?.snapshots.length).toBe(0);
      expect(result.data?.totalCount).toBe(0);
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookContextHistoryToolDefinition.name).toBe('rbook_context_history');
    });

    it('should have comprehensive description', () => {
      expect(rbookContextHistoryToolDefinition.description).toContain('timeline');
      expect(rbookContextHistoryToolDefinition.description).toContain('paginated');
    });

    it('should not require any parameters', () => {
      // No required array means all parameters are optional
      expect(
        (rbookContextHistoryToolDefinition.inputSchema as Record<string, unknown>).required
      ).toBeUndefined();
    });

    it('should have page and pageSize parameters with limits', () => {
      const props = rbookContextHistoryToolDefinition.inputSchema.properties;
      expect(props.page.minimum).toBe(1);
      expect(props.pageSize.minimum).toBe(1);
      expect(props.pageSize.maximum).toBe(100);
    });
  });

  describe('formatContextHistoryForLLM', () => {
    it('should format results as markdown table', async () => {
      const result = await callContextHistory(testDb.dbPath);
      const formatted = formatContextHistoryForLLM(result);

      expect(formatted).toContain('Context Snapshot History');
      expect(formatted).toContain('| ID |');
      expect(formatted).toContain('Sprint 11 completed');
    });

    it('should show pagination info when hasMore is true', async () => {
      const result = await callContextHistory(testDb.dbPath, { pageSize: 2 });
      const formatted = formatContextHistoryForLLM(result);

      expect(formatted).toContain('More results available');
      expect(formatted).toContain('page: 2');
    });

    it('should show empty message when no snapshots', async () => {
      const result = await callContextHistory(testDb.dbPath, { sessionId: 'nonexistent' });
      const formatted = formatContextHistoryForLLM(result);

      expect(formatted).toContain('No snapshots found');
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('context tools integration', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('should view context, create snapshot, then see it in history', async () => {
    // View current context
    const viewResult = await callContextView(testDb.dbPath);
    expect(viewResult.success).toBe(true);

    // Create snapshot
    const snapshotResult = await callContextSnapshot(testDb.dbPath, {
      contextType: 'master_context',
      source: 'Integration test snapshot',
    });
    expect(snapshotResult.success).toBe(true);
    expect(snapshotResult.data?.isNew).toBe(true);

    // Find in history
    const historyResult = await callContextHistory(testDb.dbPath, {
      contextType: 'master_context',
    });
    expect(historyResult.success).toBe(true);

    const found = historyResult.data?.snapshots.find(
      (s) => s.source === 'Integration test snapshot'
    );
    expect(found).toBeDefined();
    expect(found?.id).toBe(snapshotResult.data?.snapshotId);
  });

  it('should track multiple context snapshots over time', async () => {
    // Create first snapshot
    await callContextSnapshot(testDb.dbPath, {
      contextType: 'master_context',
      source: 'First',
    });

    // Modify context
    testDb.db.exec(`UPDATE contexts SET content = '{"version": 2}' WHERE id = 'master_context'`);

    // Create second snapshot
    await callContextSnapshot(testDb.dbPath, {
      contextType: 'master_context',
      source: 'Second',
    });

    // Modify context again
    testDb.db.exec(`UPDATE contexts SET content = '{"version": 3}' WHERE id = 'master_context'`);

    // Create third snapshot
    await callContextSnapshot(testDb.dbPath, {
      contextType: 'master_context',
      source: 'Third',
    });

    // Check history shows all 3 new + 3 existing = 6 total for master_context
    const historyResult = await callContextHistory(testDb.dbPath, {
      contextType: 'master_context',
    });
    expect(historyResult.success).toBe(true);
    expect(historyResult.data?.totalCount).toBe(6);
  });
});
