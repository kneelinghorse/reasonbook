/**
 * rbook_db backfill action tests
 *
 * Tests for retained SQLite upload, reconciliation and explicit purge.
 * Retired event replay refusal is covered by legacy-sync-retired.test.ts.
 *
 * @module tests/tools/rbook/rbook-db-backfill
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookDbBackfill,
  formatBackfillForLLM,
  rbookDbReconcile,
  formatReconciliationForLLM,
  rbookDbPurge,
  formatPurgeForLLM,
  type RbookDbBackfillResult,
  type ReconciliationResult,
  type PurgeResult,
} from '../../../src/tools/rbook/rbook-db-backfill';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { DEFAULT_DASHBOARD_URL } from '../../../src/tools/rbook/dashboard-client';
import type { RbookToolResult } from '../../../src/tools/rbook/types';

// ─── Fetch Mock ───────────────────────────────────────────────────────────────

const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
(globalThis as Record<string, unknown>).fetch = fetchMock;

function loginResponse() {
  return {
    success: true,
    data: {
      token: 'test-jwt-token',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: { id: 'user-1', email: 'test@example.com', username: 'tester', projects: [] },
    },
  };
}

function dashboardEnvelope(data: unknown = { received: true }) {
  return { success: true, data };
}

function setupFetchMock() {
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/auth/login')) {
      return new Response(JSON.stringify(loginResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(dashboardEnvelope()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

// ─── Test Setup ───────────────────────────────────────────────────────────────

describe('rbookDbBackfill', () => {
  let tempDir: string;
  let dbPath: string;

  const ENV_BACKUP: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and set env vars
    for (const key of ['RBOOK_DASHBOARD_URL', 'RBOOK_DASHBOARD_USER', 'RBOOK_DASHBOARD_PASSWORD']) {
      ENV_BACKUP[key] = process.env[key];
    }
    process.env.RBOOK_DASHBOARD_URL = 'https://test-dashboard.example.com';
    process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
    process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';

    // Create temp dir with Reasonbook structure
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-backfill-test-'));
    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    dbPath = path.join(rbookDbDir, 'rbook.sqlite');

    RbookDetector.resetInstance();
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    setupFetchMock();
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of Object.entries(ENV_BACKUP)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createDb(extraSql = '') {
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
        completed_missions INTEGER,
        stable_event_id TEXT,
        occurred_at INTEGER,
        origin_seq INTEGER,
        schema_version INTEGER
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT,
        objective TEXT,
        context TEXT,
        success_criteria TEXT,
        deliverables TEXT,
        reference_docs TEXT,
        domain_fields TEXT,
        metadata TEXT,
        created_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        stable_event_id TEXT,
        occurred_at INTEGER,
        origin_seq INTEGER,
        schema_version INTEGER
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT NOT NULL DEFAULT 'test',
        summary TEXT,
        status TEXT NOT NULL,
        captures TEXT,
        next_steps TEXT,
        metadata TEXT,
        stable_event_id TEXT,
        occurred_at INTEGER,
        origin_seq INTEGER,
        schema_version INTEGER
      );

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT,
        session_id TEXT,
        mission_id TEXT,
        source_chunk_ids TEXT,
        stable_event_id TEXT,
        occurred_at INTEGER,
        origin_seq INTEGER,
        schema_version INTEGER
      );

      CREATE TABLE learnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        category TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        sprint_id TEXT,
        session_id TEXT,
        mission_id TEXT,
        created_at TEXT NOT NULL,
        stable_event_id TEXT,
        occurred_at INTEGER,
        origin_seq INTEGER,
        schema_version INTEGER
      );

      CREATE TABLE mission_dependencies (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        type TEXT NOT NULL,
        PRIMARY KEY (from_id, to_id)
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');

      ${extraSql}
    `);
    db.close();
  }

  // ─── File-based Sync (registered projects) ─────────────────────────────────

  it('should use file-based sync when dashboard_slug is present', async () => {
    createDb(`
      INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'test-project');
      INSERT INTO sprints (id, title, status, start_date)
      VALUES ('s30', 'Sprint 30', 'Active', '2026-03-05T00:00:00Z');
    `);

    const hitUrls: string[] = [];
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      hitUrls.push(url);
      if (url.includes('/api/auth/login')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              token: 'test-token',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              user: { id: 'u1', email: 'test@example.com', projects: [] },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/sync/sqlite-backfill')) {
        return new Response(
          JSON.stringify({
            success: true,
            counts: {
              sprints: 1,
              missions: 0,
              sessions: 0,
              decisions: 0,
              learnings: 0,
              dependencies: 0,
            },
            errors: [],
            durationMs: 42,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Should not hit event-replay endpoint
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await rbookDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.message).toMatch(/File-based sync complete/);
    expect(result.data?.pushed).toBe(1);
    // Must have hit sqlite-backfill, NOT /api/sync/events
    expect(hitUrls.some((u) => u.includes('/api/sync/sqlite-backfill'))).toBe(true);
    expect(hitUrls.some((u) => u.includes('/api/sync/events'))).toBe(false);
  });

  it('s81-m02: a store missing project_id/name but registered (dashboard_slug present) repairs from the incumbent slug — never pushes as Unknown — and file-sync is NOT rejected by expectedSlug', async () => {
    // Renamed-copy shape: no project_id/project_name (would fall to directory basename
    // 'rbook-backfill-test-*', which ≠ the incumbent slug), but dashboard_slug carries the
    // reconciled incumbent. Defect-3: identity repairs from dashboard_slug (not 'Unknown',
    // not the divergent directory basename). Defect-2: expectedSlug=slug, so the file-sync
    // guard does NOT reject with EXPECTED_SLUG_MISMATCH and we stay on the file path.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT NOT NULL DEFAULT 'test', summary TEXT, status TEXT NOT NULL, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'incumbent-proj');
    `);
    db.close();

    const backfillBodies: string[] = [];
    const graphIdsObservedAtPublish: Array<string | null> = [];
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              token: 'test-token',
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              user: { id: 'u1', email: 'test@example.com', projects: [] },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.includes('/api/sync/sqlite-backfill')) {
        const graph = await ProjectGraphRegistry.create();
        graphIdsObservedAtPublish.push(graph.getByStorePath(tempDir));
        // FormData body — capture the projectSlug field to confirm the incumbent slug.
        const form = init?.body as FormData | undefined;
        backfillBodies.push(String(form?.get?.('projectSlug') ?? ''));
        return new Response(
          JSON.stringify({ success: true, counts: { sprints: 0 }, errors: [], durationMs: 5 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await rbookDbBackfill({ projectRoot: tempDir });

    // Defect-2: stayed on the file path (guard did not reject) — NOT event-replay.
    expect(result.success).toBe(true);
    expect(result.data?.message).toMatch(/File-based sync complete/);
    expect(backfillBodies).toContain('incumbent-proj');
    expect(graphIdsObservedAtPublish).toEqual(['incumbent-proj']);

    // Defect-3: identity was repaired from the incumbent slug, never 'Unknown'.
    const verifyDb = new Database(dbPath);
    const pid = verifyDb.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as
      | { value: string }
      | undefined;
    const pname = verifyDb
      .prepare(`SELECT value FROM metadata WHERE key = 'project_name'`)
      .get() as { value: string } | undefined;
    verifyDb.close();
    expect(pid?.value).toBe('incumbent-proj');
    expect(pname?.value).not.toBe('Unknown');
    expect(pname?.value).toBe('Incumbent Proj');
    const graph = await ProjectGraphRegistry.create();
    expect(graph.getByStorePath(tempDir)).toBe(pid?.value);
  });

  // ─── Dashboard Not Configured ───────────────────────────────────────────────

  it('should return error when dashboard is not configured', async () => {
    delete process.env.RBOOK_DASHBOARD_URL;
    delete process.env.RBOOK_DASHBOARD_USER;
    delete process.env.RBOOK_DASHBOARD_PASSWORD;

    createDb("INSERT INTO metadata (key, value) VALUES ('dashboard_slug', 'test-project');");
    const result = await rbookDbBackfill({ projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  // ─── Provenance fields on the wire (s71-m01, decision #777) ─────────────────
  // The 3 genesis columns (stable_event_id, occurred_at, origin_seq) are stamped
  // on every firehose row locally by genesisColumns but must also ride in the
  // outbound event `data` so the dashboard's migration-024 mirror can populate
  // them and order LWW-by-(occurred_at, origin_seq) on the shared mutable surface
  // instead of falling back to synced_at. occurred_at (ms-epoch) goes in `data`,
  // NEVER the envelope `timestamp` (which must stay ISO 8601 — dashboard msg
  // 03064b74 Q1). author_user_id stays dashboard-authoritative — never sent.

  // ─── LLM Formatter ─────────────────────────────────────────────────────────

  describe('formatBackfillForLLM', () => {
    it('should format successful backfill result', () => {
      const result: RbookToolResult<RbookDbBackfillResult> = {
        success: true,
        data: {
          mode: 'backfill',
          dryRun: false,
          totalEvents: 10,
          pushed: 10,
          failed: 0,
          skipped: 0,
          deduped: 0,
          breakdown: {
            sprints: 2,
            missions: 3,
            sessions: 3,
            decisions: 2,
            learnings: 0,
            dependencies: 0,
          },
          cursor: '2026-03-05T00:00:00Z',
          previousCursor: null,
          message: 'Backfill complete: 10/10 events pushed.',
        },
      };

      const output = formatBackfillForLLM(result);
      expect(output).toContain('Backfill Complete');
      expect(output).toContain('10 pushed');
      expect(output).toContain('2 sprint');
      expect(output).toContain('Current cursor:');
    });

    it('should format dry run result', () => {
      const result: RbookToolResult<RbookDbBackfillResult> = {
        success: true,
        data: {
          mode: 'backfill',
          dryRun: true,
          totalEvents: 5,
          pushed: 0,
          failed: 0,
          skipped: 0,
          deduped: 0,
          breakdown: {
            sprints: 1,
            missions: 2,
            sessions: 1,
            decisions: 1,
            learnings: 0,
            dependencies: 0,
          },
          cursor: null,
          previousCursor: null,
          message: 'Dry run: 5 events would be pushed.',
        },
      };

      const output = formatBackfillForLLM(result);
      expect(output).toContain('Backfill Dry Run');
      expect(output).toContain('0 pushed');
    });

    it('should format error result', () => {
      const result: RbookToolResult<RbookDbBackfillResult> = {
        success: false,
        error: { code: 'DASHBOARD_NOT_CONFIGURED', message: 'Dashboard not configured' },
      };

      const output = formatBackfillForLLM(result);
      expect(output).toContain('Backfill failed');
      expect(output).toContain('Dashboard not configured');
    });
  });
});

// ─── Reconciliation Tests ───────────────────────────────────────────────────

describe('rbookDbReconcile', () => {
  let tempDir: string;
  let dbPath: string;

  const ENV_BACKUP: Record<string, string | undefined> = {};

  function syncStatusResponse(tableCounts: Record<string, number>) {
    const tables = Object.entries(tableCounts).map(([table, count]) => ({ table, count }));
    return {
      success: true,
      data: {
        tables,
        totalMirrorRows: tables.reduce((sum, t) => sum + t.count, 0),
        totalSyncLogEntries: 100,
        unprocessedSyncLogEntries: 0,
        failedSyncLogEntries: 0,
        lastSyncAt: '2026-03-10T05:00:00Z',
        oldestUnprocessedAt: null,
        projectCount: 1,
      },
    };
  }

  /** Build project-scoped state response with entity arrays of the right length */
  function projectStateResponse(counts: {
    sprints?: number;
    missions?: number;
    sessions?: number;
    decisions?: number;
    learnings?: number;
    dependencies?: number;
  }) {
    return {
      success: true,
      data: {
        project: {
          id: 'proj-test',
          slug: 'test-project',
          name: 'Test Project',
          schemaVersion: null,
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-03-10T05:00:00Z',
        },
        sprints: Array.from({ length: counts.sprints ?? 0 }, (_, i) => ({ id: `s${i}` })),
        missions: Array.from({ length: counts.missions ?? 0 }, (_, i) => ({ id: `m${i}` })),
        sessions: Array.from({ length: counts.sessions ?? 0 }, (_, i) => ({ id: `ps${i}` })),
        decisions: Array.from({ length: counts.decisions ?? 0 }, (_, i) => ({ id: i })),
        learnings: Array.from({ length: counts.learnings ?? 0 }, (_, i) => ({ id: i })),
        dependencies: Array.from({ length: counts.dependencies ?? 0 }, (_, i) => ({
          fromId: `m${i}`,
          toId: `m${i + 1}`,
        })),
      },
    };
  }

  beforeEach(() => {
    for (const key of ['RBOOK_DASHBOARD_URL', 'RBOOK_DASHBOARD_USER', 'RBOOK_DASHBOARD_PASSWORD']) {
      ENV_BACKUP[key] = process.env[key];
    }
    process.env.RBOOK_DASHBOARD_URL = 'https://test-dashboard.example.com';
    process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
    process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-reconcile-test-'));
    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    dbPath = path.join(rbookDbDir, 'rbook.sqlite');

    RbookDetector.resetInstance();
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(ENV_BACKUP)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createDb(extraSql = '') {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT NOT NULL DEFAULT 'test', summary TEXT, status TEXT NOT NULL, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
      ${extraSql}
    `);
    db.close();
  }

  /** Setup fetch mock for project-scoped reconciliation (default path) */
  function setupFetchForProjectScopedReconcile(counts: {
    sprints?: number;
    missions?: number;
    sessions?: number;
    decisions?: number;
    learnings?: number;
    dependencies?: number;
  }) {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Project-scoped status endpoint: /api/sync/status?projectSlug=...
      if (url.includes('/api/sync/status') && url.includes('projectSlug=')) {
        return new Response(
          JSON.stringify(
            syncStatusResponse({
              cmos_sprints: counts.sprints ?? 0,
              cmos_missions: counts.missions ?? 0,
              cmos_sessions: counts.sessions ?? 0,
              cmos_decisions: counts.decisions ?? 0,
              cmos_learnings: counts.learnings ?? 0,
              cmos_mission_dependencies: counts.dependencies ?? 0,
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // Global status endpoint (no projectSlug query param)
      if (url.includes('/api/sync/status')) {
        return new Response(
          JSON.stringify(
            syncStatusResponse({
              cmos_sprints: 0,
              cmos_missions: 0,
              cmos_sessions: 0,
              cmos_decisions: 0,
              cmos_learnings: 0,
              cmos_mission_dependencies: 0,
            })
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  /** Setup fetch mock for global fallback reconciliation */
  function setupFetchForGlobalReconcile(tableCounts: Record<string, number>) {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Project-scoped status endpoint returns 404 → triggers global fallback
      if (url.includes('/api/sync/status') && url.includes('projectSlug=')) {
        return new Response(JSON.stringify({ error: 'Project not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // Global status endpoint (no projectSlug) returns actual counts
      if (url.includes('/api/sync/status')) {
        return new Response(JSON.stringify(syncStatusResponse(tableCounts)), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
  }

  it('should report all tables matching when counts are equal (project-scoped)', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', 'Active'), ('s2', 'Sprint 2', 'Active');
      INSERT INTO missions (id, name, status) VALUES ('m1', 'M1', 'Queued');
      INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('D1', '2026-01-01T00:00:00Z');
    `);
    setupFetchForProjectScopedReconcile({
      sprints: 2,
      missions: 1,
      sessions: 0,
      decisions: 1,
      learnings: 0,
      dependencies: 0,
    });

    const result = await rbookDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.allMatch).toBe(true);
    expect(result.data?.projectScoped).toBe(true);
    expect(result.data?.projectSlug).toBe('test-project');
    expect(result.data?.tables).toHaveLength(6);
    for (const t of result.data!.tables) {
      expect(t.match).toBe(true);
      expect(t.delta).toBe(0);
    }
  });

  it('should detect mismatches with positive delta (SQLite > PG)', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', 'Active'), ('s2', 'Sprint 2', 'Active'), ('s3', 'Sprint 3', 'Active');
    `);
    setupFetchForProjectScopedReconcile({
      sprints: 1,
      missions: 0,
      sessions: 0,
      decisions: 0,
      learnings: 0,
      dependencies: 0,
    });

    const result = await rbookDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.allMatch).toBe(false);
    expect(result.data?.projectScoped).toBe(true);

    const sprintTable = result.data!.tables.find((t) => t.table === 'sprints');
    expect(sprintTable?.sqliteCount).toBe(3);
    expect(sprintTable?.pgCount).toBe(1);
    expect(sprintTable?.delta).toBe(2);
    expect(sprintTable?.match).toBe(false);
  });

  it('should detect mismatches with negative delta (PG > SQLite)', async () => {
    createDb(`
      INSERT INTO missions (id, name, status) VALUES ('m1', 'M1', 'Queued');
    `);
    setupFetchForProjectScopedReconcile({
      sprints: 0,
      missions: 3,
      sessions: 0,
      decisions: 0,
      learnings: 0,
      dependencies: 0,
    });

    const result = await rbookDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.allMatch).toBe(false);

    const missionTable = result.data!.tables.find((t) => t.table === 'missions');
    expect(missionTable?.sqliteCount).toBe(1);
    expect(missionTable?.pgCount).toBe(3);
    expect(missionTable?.delta).toBe(-2);
  });

  it('should include sync log stats from global endpoint', async () => {
    createDb();
    setupFetchForProjectScopedReconcile({
      sprints: 0,
      missions: 0,
      sessions: 0,
      decisions: 0,
      learnings: 0,
      dependencies: 0,
    });

    const result = await rbookDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.syncLogEntries).toBe(100);
    expect(result.data?.failedEntries).toBe(0);
    expect(result.data?.lastSyncAt).toBe('2026-03-10T05:00:00Z');
  });

  it('should call project-scoped endpoint with derived slug', async () => {
    createDb();
    setupFetchForProjectScopedReconcile({ sprints: 0 });

    await rbookDbReconcile({ projectRoot: tempDir });

    // project_name is 'Test Project' → slug is 'test-project'
    const urls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : c[0]?.toString()
    );
    expect(urls.some((u) => u?.includes('/api/sync/status?projectSlug=test-project'))).toBe(true);
  });

  it('should return error when dashboard is not configured', async () => {
    delete process.env.RBOOK_DASHBOARD_URL;
    delete process.env.RBOOK_DASHBOARD_USER;
    delete process.env.RBOOK_DASHBOARD_PASSWORD;
    createDb();

    const result = await rbookDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  it('should handle complete API failure on both endpoints', async () => {
    createDb();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await rbookDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(false);
  });

  it('should fall back to global endpoint when project-scoped returns 404', async () => {
    createDb(`
      INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', 'Active');
    `);
    setupFetchForGlobalReconcile({
      cmos_sprints: 1,
      cmos_missions: 0,
      cmos_sessions: 0,
      cmos_decisions: 0,
      cmos_learnings: 0,
      cmos_mission_dependencies: 0,
    });

    const result = await rbookDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.projectScoped).toBe(false);
    expect(result.data?.projectSlug).toBeNull();
    expect(result.data?.allMatch).toBe(true);
  });

  it('should only include 6 mapped entity types in project-scoped result', async () => {
    createDb();
    setupFetchForProjectScopedReconcile({
      sprints: 0,
      missions: 0,
      sessions: 0,
      decisions: 0,
      learnings: 0,
      dependencies: 0,
    });

    const result = await rbookDbReconcile({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.tables).toHaveLength(6);
    const tableNames = result.data!.tables.map((t) => t.table);
    expect(tableNames).toContain('sprints');
    expect(tableNames).toContain('missions');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('strategic_decisions');
    expect(tableNames).toContain('learnings');
    expect(tableNames).toContain('mission_dependencies');
  });

  it('reconciles via the credential-store key with NO env creds (s73 fix: fromEnvForProject, not fromEnv)', async () => {
    // s73 review: rbook_db was the last sync surface still on env-only auth. Under
    // the old DashboardClient.fromEnv() path, scrubbing the env (no API key, no
    // USER+PASSWORD) returned dashboardNotConfigured even when a device-code key
    // existed in the credential store. fromEnvForProject resolves that store key
    // (used directly as a Bearer — no /api/auth/login), so reconcile succeeds.
    const prevConfigDir = process.env.RBOOK_CONFIG_DIR;
    const prevApiKey = process.env.RBOOK_DASHBOARD_API_KEY;
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-credstore-'));
    try {
      // The credential-store key is the ONLY credential available.
      delete process.env.RBOOK_DASHBOARD_USER;
      delete process.env.RBOOK_DASHBOARD_PASSWORD;
      delete process.env.RBOOK_DASHBOARD_API_KEY;
      process.env.RBOOK_CONFIG_DIR = storeDir;
      CredentialStore.resetInstance();
      const store = await CredentialStore.create({ configDir: storeDir });
      await store.upsertUserScopedKey('store-key-id', {
        key: 'cmk_storekey',
        label: 'device-code test',
        issuedAt: new Date().toISOString(),
        lastUsedAt: '',
      });

      createDb();
      setupFetchForProjectScopedReconcile({
        sprints: 0,
        missions: 0,
        sessions: 0,
        decisions: 0,
        learnings: 0,
        dependencies: 0,
      });

      const result = await rbookDbReconcile({ projectRoot: tempDir });

      // Would be dashboardNotConfigured under the old fromEnv() path.
      expect(result.success).toBe(true);

      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      // API-key auth uses the key directly as a Bearer — it never logs in.
      expect(urls.some((u) => u.includes('/api/auth/login'))).toBe(false);
      // A sync request carried the store key as its Bearer token.
      const sawStoreKeyBearer = fetchMock.mock.calls.some((c) => {
        const init = c[1] as { headers?: Record<string, string> } | undefined;
        return (init?.headers ?? {}).Authorization === 'Bearer cmk_storekey';
      });
      expect(sawStoreKeyBearer).toBe(true);
    } finally {
      CredentialStore.resetInstance();
      if (prevConfigDir === undefined) delete process.env.RBOOK_CONFIG_DIR;
      else process.env.RBOOK_CONFIG_DIR = prevConfigDir;
      if (prevApiKey === undefined) delete process.env.RBOOK_DASHBOARD_API_KEY;
      else process.env.RBOOK_DASHBOARD_API_KEY = prevApiKey;
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  });

  // ─── Formatter ───────────────────────────────────────────────────────────

  describe('formatReconciliationForLLM', () => {
    it('should format matching project-scoped reconciliation', () => {
      const result: RbookToolResult<ReconciliationResult> = {
        success: true,
        data: {
          tables: [
            { table: 'sprints', sqliteCount: 5, pgCount: 5, match: true, delta: 0 },
            { table: 'missions', sqliteCount: 10, pgCount: 10, match: true, delta: 0 },
          ],
          allMatch: true,
          totalSqlite: 15,
          totalPg: 15,
          projectScoped: true,
          projectSlug: 'cmos-mcp',
          syncLogEntries: 50,
          failedEntries: 0,
          lastSyncAt: '2026-03-10T05:00:00Z',
        },
      };

      const output = formatReconciliationForLLM(result);
      expect(output).toContain('project-scoped: cmos-mcp');
      expect(output).toContain('ALL MATCH');
      expect(output).toContain('SQLite=15');
      expect(output).toContain('PG=15');
    });

    it('should format mismatched reconciliation', () => {
      const result: RbookToolResult<ReconciliationResult> = {
        success: true,
        data: {
          tables: [
            { table: 'sprints', sqliteCount: 25, pgCount: 18, match: false, delta: 7 },
            { table: 'missions', sqliteCount: 106, pgCount: 106, match: true, delta: 0 },
          ],
          allMatch: false,
          totalSqlite: 131,
          totalPg: 124,
          projectScoped: true,
          projectSlug: 'cmos-mcp',
          syncLogEntries: 100,
          failedEntries: 5,
          lastSyncAt: '2026-03-10T05:00:00Z',
        },
      };

      const output = formatReconciliationForLLM(result);
      expect(output).toContain('MISMATCHES DETECTED');
      expect(output).toContain('5 failed');
    });

    it('should format global fallback reconciliation', () => {
      const result: RbookToolResult<ReconciliationResult> = {
        success: true,
        data: {
          tables: [{ table: 'sprints', sqliteCount: 5, pgCount: 5, match: true, delta: 0 }],
          allMatch: true,
          totalSqlite: 5,
          totalPg: 5,
          projectScoped: false,
          projectSlug: null,
          syncLogEntries: 50,
          failedEntries: 0,
          lastSyncAt: '2026-03-10T05:00:00Z',
        },
      };

      const output = formatReconciliationForLLM(result);
      expect(output).toContain('global');
      expect(output).toContain('ALL MATCH');
    });

    it('should format error result', () => {
      const result: RbookToolResult<ReconciliationResult> = {
        success: false,
        error: { code: 'DASHBOARD_NOT_CONFIGURED', message: 'Dashboard not configured' },
      };

      const output = formatReconciliationForLLM(result);
      expect(output).toContain('Reconciliation failed');
    });
  });
});

// ─── Purge Tests ──────────────────────────────────────────────────────────────

describe('rbookDbPurge', () => {
  let tempDir: string;
  let dbPath: string;

  const ENV_BACKUP: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ['RBOOK_DASHBOARD_URL', 'RBOOK_DASHBOARD_USER', 'RBOOK_DASHBOARD_PASSWORD']) {
      ENV_BACKUP[key] = process.env[key];
    }
    process.env.RBOOK_DASHBOARD_URL = 'https://test-dashboard.example.com';
    process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
    process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-purge-test-'));
    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    dbPath = path.join(rbookDbDir, 'rbook.sqlite');

    RbookDetector.resetInstance();
    fetchMock.mockReset();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(ENV_BACKUP)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createDb() {
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL, notes TEXT, objective TEXT, context TEXT, success_criteria TEXT, deliverables TEXT, reference_docs TEXT, domain_fields TEXT, metadata TEXT, created_at TEXT, started_at TEXT, completed_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, agent TEXT NOT NULL DEFAULT 'test', summary TEXT, status TEXT NOT NULL, captures TEXT, next_steps TEXT, metadata TEXT);
      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT, mission_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE mission_dependencies (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (from_id, to_id));
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
    `);
    db.close();
  }

  it('should require explicit confirmation', async () => {
    createDb();

    const result = await rbookDbPurge({ projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
    expect(result.error?.message).toContain('confirm=true');
  });

  it('should reject when confirm is false', async () => {
    createDb();

    const result = await rbookDbPurge({ confirm: false, projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('should call POST /api/sync/purge with project slug', async () => {
    createDb();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/sync/purge')) {
        return new Response(
          JSON.stringify({
            success: true,
            // s95-m08: the dashboard's own answer shape (cmos-dashboard src/routes/sync.ts).
            data: {
              projectSlug: 'test-project',
              rbookProjectId: 'c3f1a2e0-0000-4000-8000-000000000003',
              purged: {
                rbook_sprints: 2,
                rbook_missions: 10,
                rbook_sessions: 5,
                rbook_decisions: 15,
                rbook_learnings: 9,
                rbook_mission_dependencies: 1,
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await rbookDbPurge({ confirm: true, projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.purgedProject).toBe('test-project');
    expect(result.data?.tablesCleared).toHaveLength(6);
    expect(result.data?.rowsDeleted).toBe(42);

    // Verify the POST body includes projectSlug
    const purgeCall = fetchMock.mock.calls.find((c) => {
      const url = typeof c[0] === 'string' ? c[0] : c[0]?.toString();
      return url?.includes('/api/sync/purge');
    });
    expect(purgeCall).toBeDefined();
    const body = JSON.parse(purgeCall![1]?.body as string);
    expect(body.projectSlug).toBe('test-project');
  });

  it("reads the dashboard's own purge answer, per-table row counts, and formats it", async () => {
    // s95-m08: the dashboard answers {projectSlug, rbookProjectId, purged: {table: rows}}
    // (cmos-dashboard src/routes/sync.ts:443-450); the answer used to throw formatting it, after
    // the dashboard had already purged.
    createDb();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/api/sync/purge')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              // The dashboard answers with its own slug for the project.
              projectSlug: 'test-project-on-dashboard',
              rbookProjectId: 'c3f1a2e0-0000-4000-8000-000000000001',
              purged: { rbook_decisions: 30, rbook_learnings: 10, rbook_missions: 2 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ success: true, data: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await rbookDbPurge({ confirm: true, projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      purgedProject: 'test-project-on-dashboard',
      tablesCleared: ['rbook_decisions', 'rbook_learnings', 'rbook_missions'],
      rowsDeleted: 42,
    });
    const output = formatPurgeForLLM(result);
    expect(output).toContain('Tables cleared: rbook_decisions, rbook_learnings, rbook_missions');
    expect(output).toContain('Rows deleted: 42');
  });

  it('says the counts are unknown when the dashboard accepts a purge but names no tables', async () => {
    createDb();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ success: true, data: { projectSlug: 'test-project' } }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    });

    const result = await rbookDbPurge({ confirm: true, projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(formatPurgeForLLM(result)).toContain('how many rows it deleted is unknown');
  });

  it('should return error when dashboard is not configured', async () => {
    delete process.env.RBOOK_DASHBOARD_URL;
    delete process.env.RBOOK_DASHBOARD_USER;
    delete process.env.RBOOK_DASHBOARD_PASSWORD;
    createDb();

    const result = await rbookDbPurge({ confirm: true, projectRoot: tempDir });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  it('should handle dashboard API errors', async () => {
    createDb();
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/auth/login')) {
        return new Response(JSON.stringify(loginResponse()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await rbookDbPurge({ confirm: true, projectRoot: tempDir });

    expect(result.success).toBe(false);
  });

  it('should refuse purge when expectedSlug does not match the local project slug', async () => {
    createDb();

    const result = await rbookDbPurge({
      confirm: true,
      projectRoot: tempDir,
      expectedSlug: 'different-project',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXPECTED_SLUG_MISMATCH');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('formatPurgeForLLM', () => {
    it('should format successful purge', () => {
      const result: RbookToolResult<PurgeResult> = {
        success: true,
        data: {
          purgedProject: 'test-project',
          tablesCleared: ['rbook_sprints', 'rbook_missions'],
          rowsDeleted: 15,
        },
      };

      const output = formatPurgeForLLM(result);
      expect(output).toContain('Purge Complete: test-project');
      expect(output).toContain('Rows deleted: 15');
      expect(output).toContain('backfill');
    });

    it('should format failed purge', () => {
      const result: RbookToolResult<PurgeResult> = {
        success: false,
        error: { code: 'DASHBOARD_ERROR', message: 'Something went wrong' },
      };

      const output = formatPurgeForLLM(result);
      expect(output).toContain('Purge failed');
    });
  });
});

// ─── computeContentHash Tests ─────────────────────────────────────────────────

describe('computeContentHash', () => {
  it('should produce consistent hashes for same input', () => {
    const { computeContentHash } = require('../../../src/tools/rbook/schema-migrations');
    const hash1 = computeContentHash('Use PostgreSQL', 'general');
    const hash2 = computeContentHash('Use PostgreSQL', 'general');
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it('should produce different hashes for different text', () => {
    const { computeContentHash } = require('../../../src/tools/rbook/schema-migrations');
    const hash1 = computeContentHash('Use PostgreSQL', 'general');
    const hash2 = computeContentHash('Use MongoDB', 'general');
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for different domains', () => {
    const { computeContentHash } = require('../../../src/tools/rbook/schema-migrations');
    const hash1 = computeContentHash('Use PostgreSQL', 'general');
    const hash2 = computeContentHash('Use PostgreSQL', 'tooling');
    expect(hash1).not.toBe(hash2);
  });
});
