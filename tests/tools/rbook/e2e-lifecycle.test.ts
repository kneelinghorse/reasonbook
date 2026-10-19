/**
 * End-to-End Lifecycle Integration Tests
 *
 * Full Reasonbook lifecycle validation covering:
 * - Onboard → Session → Sprint → Missions → Decisions with evidence → Sprint complete
 * - Staleness detection
 * - FTS5 relevance surfacing
 * - Evidence round-trip (capture → store → query)
 * - Performance benchmarks with large datasets
 *
 * @module tests/tools/rbook/e2e-lifecycle
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';

// Tool imports
import { rbookAgentOnboard } from '../../../src/tools/rbook/rbook-agent-onboard';
import { rbookSprintComplete } from '../../../src/tools/rbook/rbook-sprint-complete';
import {
  readStaleness,
  DEFAULT_STALENESS_THRESHOLD,
} from '../../../src/tools/rbook/staleness-detection';
import { findRelevantDecisions } from '../../../src/tools/rbook/relevance-surfacing';
import { ensureDecisionsFts5 } from '../../../src/tools/rbook/schema-migrations';

// Wall-clock latency asserts (`elapsed < 200ms`) flake under full-suite parallel
// CPU contention (220+ suites), so they run only in the opt-in performance lane
// (`npm run test:performance`, which sets RUN_PERF_ASSERTS=1). The functional
// assertions in these tests — operations succeed and return correct results at
// scale — always run. See s75-m03.
const PERF_ASSERTS = process.env.RUN_PERF_ASSERTS === '1';

interface TestDb {
  tempDir: string;
  projectRoot: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

/**
 * Create a comprehensive test database with full schema.
 */
function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-e2e-test-'));
  const projectRoot = tempDir;
  const rbookDir = path.join(tempDir, 'rbook');
  const dbDir = path.join(rbookDir, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'rbook.sqlite');

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

    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_id TEXT NOT NULL DEFAULT 'master_context',
      decision_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sprint_id TEXT,
      snapshot_id INTEGER,
      project_domain TEXT,
      session_id TEXT REFERENCES sessions(id),
      mission_id TEXT,
      source_chunk_ids TEXT,
      category TEXT,
      superseded_by INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      evidence TEXT
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      sprint_id TEXT,
      session_id TEXT,
      mission_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE telemetry_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT,
      session_id TEXT
    );

    CREATE TABLE mission_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'Blocks',
      created_at TEXT NOT NULL
    );

    CREATE TABLE prompt_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      params TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Insert base metadata
  db.prepare(`INSERT INTO metadata (key, value) VALUES ('project_name', 'E2E Test Project')`).run();
  db.prepare(`INSERT INTO metadata (key, value) VALUES ('project_domain', 'e2e-testing')`).run();

  // Insert contexts
  db.prepare(
    `INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, datetime('now'))`
  ).run(
    'master_context',
    'context/MASTER_CONTEXT.json',
    JSON.stringify({ project: 'E2E Test', decisions: [], learnings: [] })
  );
  db.prepare(
    `INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, datetime('now'))`
  ).run(
    'project_context',
    'context/PROJECT_CONTEXT.json',
    JSON.stringify({ active_mission: null })
  );

  return { tempDir, projectRoot, dbPath, db };
}

function cleanupTestDb(testDb: TestDb): void {
  testDb.db.close();
  fs.rmSync(testDb.tempDir, { recursive: true, force: true });
}

// =============================================================================
// Helper to call tools via withClient with explicit dbPath
// =============================================================================

async function callWithDb(dbPath: string, fn: (client: any) => any): Promise<any> {
  const { withClient } = await import('../../../src/tools/rbook/client');
  return withClient(fn as any, { dbPath });
}

// =============================================================================
// FULL LIFECYCLE TESTS
// =============================================================================

describe('E2E Lifecycle Integration', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  describe('full lifecycle: onboard → session → sprint → missions → complete', () => {
    it('should complete a full sprint lifecycle without errors', async () => {
      const { db, projectRoot, dbPath } = testDb;

      // Step 1: Agent onboard
      const onboard = await rbookAgentOnboard({ projectRoot });
      expect(onboard.success).toBe(true);
      expect(onboard.data?.project).toBeDefined();

      // Step 2: Create sprint
      db.prepare(
        `INSERT INTO sprints (id, title, focus, status, start_date)
         VALUES ('sprint-e2e', 'E2E Test Sprint', 'Full lifecycle validation', 'Active', '2026-03-01')`
      ).run();

      // Step 3: Add missions
      const missions = [
        {
          id: 'e2e-m01',
          name: 'Research Phase',
          objective: 'Research event sourcing patterns for audit trail',
        },
        {
          id: 'e2e-m02',
          name: 'Implementation',
          objective: 'Implement event sourcing with CQRS pattern',
        },
        { id: 'e2e-m03', name: 'Testing', objective: 'Write integration tests for event sourcing' },
      ];
      for (const m of missions) {
        db.prepare(
          `INSERT INTO missions (id, sprint_id, name, status, objective, success_criteria)
           VALUES (?, 'sprint-e2e', ?, 'Queued', ?, '["Tests pass"]')`
        ).run(m.id, m.name, m.objective);
      }

      // Step 4: Start session
      const sessionId = 'PS-E2E-001';
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures)
         VALUES (?, 'planning', 'E2E Planning', 'sprint-e2e', datetime('now'), 'test', 'active', '[]')`
      ).run(sessionId);

      // Step 5: Start and complete missions with decisions and evidence
      for (const m of missions) {
        // Start mission
        db.prepare(`UPDATE missions SET status = 'In Progress' WHERE id = ?`).run(m.id);

        // Add decision with evidence
        db.prepare(
          `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, session_id, mission_id, status, evidence)
           VALUES (?, datetime('now'), 'sprint-e2e', ?, ?, 'active', ?)`
        ).run(
          `Decision for ${m.name}: Use event sourcing`,
          sessionId,
          m.id,
          JSON.stringify([
            { type: 'collection', id: `col-${m.id}` },
            { type: 'report', id: `rpt-${m.id}` },
          ])
        );

        // Complete mission
        db.prepare(
          `UPDATE missions SET status = 'Completed', completed_at = datetime('now'), notes = ? WHERE id = ?`
        ).run(`${m.name} completed successfully`, m.id);
      }

      // Step 6: Complete session
      db.prepare(
        `UPDATE sessions SET status = 'completed', completed_at = datetime('now'), summary = 'E2E test session' WHERE id = ?`
      ).run(sessionId);

      // Step 7: Complete sprint — verifies lifecycle triggers fire
      const sprintResult = await rbookSprintComplete({
        sprintId: 'sprint-e2e',
        summary: 'E2E lifecycle test sprint completed',
        projectRoot,
      });

      expect(sprintResult.success).toBe(true);
      expect(sprintResult.data?.currentStatus).toBe('Completed');
      expect(sprintResult.data?.lifecycle).toBeDefined();

      // Verify lifecycle triggers. s92-m05 (decision #1160): a default close archives nothing.
      const lifecycle = sprintResult.data!.lifecycle;
      expect(lifecycle.archived).toBe(false);
      expect(lifecycle.decisionsArchived).toBe(0);
      expect(lifecycle.dbSnapshotId).toBeDefined();

      // Step 8: Verify context snapshot was created
      const snapshots = db.prepare('SELECT COUNT(*) as count FROM context_snapshots').get() as {
        count: number;
      };
      expect(snapshots.count).toBeGreaterThanOrEqual(1);

      // Step 9: Verify the sprint's decisions are still active after the close
      const activeDecisions = db
        .prepare(
          `SELECT COUNT(*) as count FROM strategic_decisions WHERE sprint_id = 'sprint-e2e' AND status = 'active'`
        )
        .get() as { count: number };
      expect(activeDecisions.count).toBe(3);

      const archivedDecisions = db
        .prepare(
          `SELECT COUNT(*) as count FROM strategic_decisions WHERE sprint_id = 'sprint-e2e' AND status = 'archived'`
        )
        .get() as { count: number };
      expect(archivedDecisions.count).toBe(0);
    });
  });

  describe('evidence round-trip: capture → store → query', () => {
    it('evidence survives full round-trip through strategic_decisions', async () => {
      const { db } = testDb;
      const evidence = [
        { type: 'collection', id: 'col-abc-123' },
        { type: 'report', id: 'rpt-def-456' },
        { type: 'chunk', id: 'chunk-ghi-789' },
      ];

      // Store decision with evidence
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status, evidence)
         VALUES (?, datetime('now'), 'sprint-test', 'active', ?)`
      ).run('Test decision with evidence', JSON.stringify(evidence));

      // Query back
      const stored = db
        .prepare('SELECT evidence FROM strategic_decisions WHERE decision_text = ?')
        .get('Test decision with evidence') as { evidence: string };

      expect(stored.evidence).toBeDefined();
      const parsed = JSON.parse(stored.evidence);
      expect(parsed).toEqual(evidence);
      expect(parsed).toHaveLength(3);
      expect(parsed[0].type).toBe('collection');
      expect(parsed[1].type).toBe('report');
      expect(parsed[2].type).toBe('chunk');
    });

    it('null evidence survives round-trip', () => {
      const { db } = testDb;

      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, status)
         VALUES ('No evidence decision', datetime('now'), 'active')`
      ).run();

      const stored = db
        .prepare('SELECT evidence FROM strategic_decisions WHERE decision_text = ?')
        .get('No evidence decision') as { evidence: string | null };

      expect(stored.evidence).toBeNull();
    });
  });

  describe('staleness detection', () => {
    it('counts old decisions from past sprints as due for review without changing them', async () => {
      const { db, dbPath } = testDb;

      // Create old and new sprints — total = threshold + 5 so the active sprint
      // is far enough past sprint-1 to make it stale, but sprint-(total-N) is not.
      const totalSprints = DEFAULT_STALENESS_THRESHOLD + 5;
      const recentSprintNum = totalSprints; // Active sprint, won't be stale.
      // s97-m13: closed in label order, two weeks apart; review ages count the closes.
      for (let i = 1; i <= totalSprints; i++) {
        db.prepare(
          `INSERT INTO sprints (id, title, status, start_date, end_date)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          `sprint-${i}`,
          `Sprint ${i}`,
          i < totalSprints ? 'Completed' : 'Active',
          `2025-01-${String(Math.min(i, 28)).padStart(2, '0')}`,
          i < totalSprints
            ? new Date(Date.now() - ((totalSprints - i) * 14 + 1) * 86400_000).toISOString()
            : null
        );
      }

      // Add old decisions (sprint-1, should be stale)
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Old decision from sprint 1', '2025-01-01T00:00:00Z', 'sprint-1', 'active')`
      ).run();

      // Add recent decision (current sprint, should NOT be stale): made after the last close.
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES (?, ?, ?, 'active')`
      ).run(
        `Recent decision from sprint ${recentSprintNum}`,
        new Date(Date.now() - 3600_000).toISOString(),
        `sprint-${recentSprintNum}`
      );

      const result = await callWithDb(dbPath, (client: any) => {
        return readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD });
      });

      // s93-m11: the old decision is counted as due for review; its status is not changed.
      expect(result.dueDecisions).toBe(1);

      const oldDecision = db
        .prepare(`SELECT status FROM strategic_decisions WHERE decision_text LIKE '%sprint 1%'`)
        .get() as { status: string };
      expect(oldDecision.status).toBe('active');

      // Verify recent decision is still active
      const recentDecision = db
        .prepare(
          `SELECT status FROM strategic_decisions WHERE decision_text LIKE '%sprint ${recentSprintNum}%'`
        )
        .get() as { status: string };
      expect(recentDecision.status).toBe('active');
    });
  });

  describe('FTS5 relevance surfacing', () => {
    it('returns meaningful results on mission start', async () => {
      const { db, dbPath } = testDb;

      // Insert decisions with varied content
      const decisions = [
        'Use event sourcing pattern for audit trail implementation',
        'Adopt PostgreSQL for primary database storage',
        'Implement CQRS pattern alongside event sourcing for read scalability',
        'Use Redis for session caching and rate limiting',
        'Apply domain-driven design boundaries for microservice decomposition',
      ];

      for (const d of decisions) {
        db.prepare(
          `INSERT INTO strategic_decisions (decision_text, created_at, status)
           VALUES (?, datetime('now'), 'active')`
        ).run(d);
      }

      // Set up FTS5
      await callWithDb(dbPath, (client: any) => {
        ensureDecisionsFts5(client);
      });

      // Search for event sourcing related decisions
      const results = await callWithDb(dbPath, (client: any) => {
        return findRelevantDecisions(client, 'Implement event sourcing pattern for audit system');
      });

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(5);

      // The event sourcing decisions should be most relevant
      const topDecision = results[0];
      expect(topDecision.decisionText).toMatch(/event sourcing/i);
    });

    it('returns empty results for unrelated queries', async () => {
      const { db, dbPath } = testDb;

      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, status)
         VALUES ('Use TypeScript for all new development', datetime('now'), 'active')`
      ).run();

      await callWithDb(dbPath, (client: any) => {
        ensureDecisionsFts5(client);
      });

      const results = await callWithDb(dbPath, (client: any) => {
        return findRelevantDecisions(client, 'quantum computing neural network');
      });

      // Should return 0 results since there's no overlap
      expect(results.length).toBe(0);
    });
  });
});

// =============================================================================
// PERFORMANCE BENCHMARKS
// =============================================================================

describe('Performance benchmarks', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    cleanupTestDb(testDb);
  });

  it('handles 500+ missions: all operations <200ms', () => {
    const { db } = testDb;

    // Create sprint
    db.prepare(
      `INSERT INTO sprints (id, title, status, start_date)
       VALUES ('sprint-perf', 'Performance Test Sprint', 'Active', '2026-01-01')`
    ).run();

    // Insert 500 missions
    const insertMission = db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, objective, success_criteria, completed_at, notes)
       VALUES (?, 'sprint-perf', ?, ?, ?, '["Test passes"]', ?, ?)`
    );

    const insertTxn = db.transaction(() => {
      for (let i = 1; i <= 500; i++) {
        const status = i <= 400 ? 'Completed' : i <= 450 ? 'In Progress' : 'Queued';
        const completedAt = status === 'Completed' ? '2026-02-01T00:00:00Z' : null;
        insertMission.run(
          `perf-m${String(i).padStart(3, '0')}`,
          `Mission ${i}`,
          status,
          `Objective for mission ${i} about ${i % 2 === 0 ? 'event sourcing' : 'microservices'}`,
          completedAt,
          status === 'Completed' ? `Mission ${i} done` : null
        );
      }
    });
    insertTxn();

    // Benchmark: Mission list query
    const listStart = Date.now();
    const missions = db
      .prepare(`SELECT id, name, status FROM missions WHERE sprint_id = 'sprint-perf' LIMIT 50`)
      .all();
    const listElapsed = Date.now() - listStart;
    expect(missions).toHaveLength(50);
    if (PERF_ASSERTS) expect(listElapsed).toBeLessThan(200);

    // Benchmark: Status query (grouped counts)
    const statusStart = Date.now();
    const statusCounts = db
      .prepare(
        `SELECT status, COUNT(*) as count FROM missions WHERE sprint_id = 'sprint-perf' GROUP BY status`
      )
      .all();
    const statusElapsed = Date.now() - statusStart;
    expect(statusCounts.length).toBeGreaterThan(0);
    if (PERF_ASSERTS) expect(statusElapsed).toBeLessThan(200);

    // Benchmark: Mission update
    const updateStart = Date.now();
    db.prepare(`UPDATE missions SET notes = 'Updated' WHERE id = 'perf-m001'`).run();
    const updateElapsed = Date.now() - updateStart;
    if (PERF_ASSERTS) expect(updateElapsed).toBeLessThan(200);
  });

  it('FTS5 search performs well with 500+ decisions', async () => {
    const { db, dbPath } = testDb;

    // Insert 500 decisions with varied content
    const topics = [
      'event sourcing',
      'microservices',
      'database sharding',
      'API gateway',
      'message queue',
      'container orchestration',
      'CI/CD pipeline',
      'monitoring',
      'security hardening',
      'performance optimization',
      'code review',
      'testing strategy',
    ];

    const insertDecision = db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, status, sprint_id)
       VALUES (?, datetime('now'), 'active', 'sprint-test')`
    );

    db.prepare(
      `INSERT INTO sprints (id, title, status) VALUES ('sprint-test', 'Test Sprint', 'Active')`
    ).run();

    const insertTxn = db.transaction(() => {
      for (let i = 0; i < 500; i++) {
        const topic = topics[i % topics.length];
        insertDecision.run(`Decision ${i}: Adopt ${topic} for production system component ${i}`);
      }
    });
    insertTxn();

    // Set up FTS5 and benchmark
    await callWithDb(dbPath, (client: any) => {
      ensureDecisionsFts5(client);
    });

    const searchStart = Date.now();
    const results = await callWithDb(dbPath, (client: any) => {
      return findRelevantDecisions(client, 'event sourcing pattern for production audit trail');
    });
    const searchElapsed = Date.now() - searchStart;

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(5);
    if (PERF_ASSERTS) expect(searchElapsed).toBeLessThan(200);
  });

  it('agent onboard completes quickly with large dataset', async () => {
    const { db, projectRoot } = testDb;

    // Populate with realistic data
    for (let s = 1; s <= 10; s++) {
      db.prepare(
        `INSERT INTO sprints (id, title, status, start_date)
         VALUES (?, ?, ?, ?)`
      ).run(
        `sprint-${s}`,
        `Sprint ${s}`,
        s < 10 ? 'Completed' : 'Active',
        `2025-${String(s).padStart(2, '0')}-01`
      );

      for (let m = 1; m <= 5; m++) {
        db.prepare(
          `INSERT INTO missions (id, sprint_id, name, status, objective)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          `s${s}-m${String(m).padStart(2, '0')}`,
          `sprint-${s}`,
          `Mission ${s}.${m}`,
          s < 10 ? 'Completed' : m <= 2 ? 'Completed' : 'Queued',
          `Objective for mission ${s}.${m}`
        );
      }
    }

    // Add sessions
    for (let i = 1; i <= 20; i++) {
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, completed_at, summary)
         VALUES (?, 'planning', ?, ?, datetime('now', '-${i} hours'), 'test', 'completed', datetime('now', '-${i - 1} hours'), ?)`
      ).run(`PS-${i}`, `Session ${i}`, `sprint-${Math.ceil(i / 2)}`, `Summary ${i}`);
    }

    // Add decisions
    for (let i = 1; i <= 50; i++) {
      db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, status, sprint_id)
         VALUES (?, datetime('now', '-${i} hours'), 'active', ?)`
      ).run(`Strategic decision ${i}`, `sprint-${Math.ceil(i / 5)}`);
    }

    const start = Date.now();
    const result = await rbookAgentOnboard({ projectRoot });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(true);
    expect(result.data?.project).toBeDefined();
    expect(result.data?.pendingMissions).toBeDefined();
    if (PERF_ASSERTS) expect(elapsed).toBeLessThan(200);
  });

  it('context size stays stable with snapshot overhead', () => {
    const { db } = testDb;

    // Simulate multiple sprint completions building up snapshots
    for (let i = 0; i < 20; i++) {
      db.prepare(
        `INSERT INTO context_snapshots (context_id, source, content_hash, content, created_at)
         VALUES ('master_context', ?, ?, ?, datetime('now', '-${i} days'))`
      ).run(
        `sprint-${i}-complete`,
        `hash-${i}`,
        JSON.stringify({ sprint: i, data: 'x'.repeat(500) })
      );
    }

    // Measure context table size
    const contextRow = db
      .prepare(`SELECT length(content) as size FROM contexts WHERE id = 'master_context'`)
      .get() as { size: number };

    // Context content should be reasonable (<100KB = 102400 bytes)
    expect(contextRow.size).toBeLessThan(102400);

    // Snapshots accumulate but are separate from context
    const snapshotCount = db.prepare('SELECT COUNT(*) as count FROM context_snapshots').get() as {
      count: number;
    };
    expect(snapshotCount.count).toBe(20);
  });
});
