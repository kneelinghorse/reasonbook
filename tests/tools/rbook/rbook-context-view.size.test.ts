import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookContextView,
  formatContextViewForLLM,
} from '../../../src/tools/rbook/rbook-context-view';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';

describe('rbook_context_view size telemetry', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-context-view-size-test-'));
    const dbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'rbook.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
        status TEXT NOT NULL DEFAULT 'active'
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
        content_hash TEXT
      );

      INSERT INTO sprints (id, title, status, focus)
      VALUES ('sprint-20', 'Context Lifecycle', 'Active', 'Context tools');

      INSERT INTO strategic_decisions (decision_text, created_at, status)
      VALUES
        ('Use TypeScript for all tools', '2026-01-01T00:00:00Z', 'active'),
        ('Follow RbookToolResult pattern', '2026-01-02T00:00:00Z', 'active'),
        ('Store decisions in structured table', '2026-01-03T00:00:00Z', 'active');

      INSERT INTO contexts (id, source_path, content, updated_at)
      VALUES
      (
        'master_context',
        'context/MASTER_CONTEXT.json',
        '{"project":{"name":"Size Test"},"context_health":{"size_limit_kb":32,"warning_threshold_percent":75},"decisions_made":["d1","d2","d3","d4","d5","d6","d7"],"constraints":["c1","c2"],"learnings":["l1","l2","l3","l4","l5","l6"]}',
        '2026-02-18T00:00:00Z'
      ),
      (
        'project_context',
        'context/PROJECT_CONTEXT.json',
        '{"active_mission":"s20-m04","working_memory":{"next_steps":["n1","n2"]},"session_count":5,"context_health":{"size_limit_kb":32,"warning_threshold_percent":75}}',
        '2026-02-18T00:00:00Z'
      );
    `);
    db.close();
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports per-context and combined size metrics', async () => {
    const result = await rbookContextView({ compact: false, projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data?.contextSizes).toBeDefined();
    expect(result.data?.contextSizes?.masterContext?.sizeKb).toBeGreaterThan(0);
    expect(result.data?.contextSizes?.projectContext?.sizeKb).toBeGreaterThan(0);
    expect(result.data?.contextSizes?.totalSizeKb).toBeGreaterThan(0);
    expect(result.data?.masterContext?.size?.usagePercent).toBeGreaterThan(0);
  });

  it('emits warning when usage exceeds threshold', async () => {
    const db = new Database(dbPath);
    const oversizedMaster = {
      project: { name: 'Size Test' },
      context_health: { size_limit_kb: 1, warning_threshold_percent: 75 },
      payload: 'z'.repeat(1200),
    };
    db.prepare("UPDATE contexts SET content = ? WHERE id = 'master_context'").run(
      JSON.stringify(oversizedMaster)
    );
    db.close();

    const result = await rbookContextView({ projectRoot: tempDir });
    expect(result.success).toBe(true);
    expect((result.warnings ?? []).some((warning) => warning.includes('master_context'))).toBe(
      true
    );
  });

  describe('sizeOnly mode', () => {
    it('returns size metrics without content', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, sizeOnly: true });

      expect(result.success).toBe(true);
      expect(result.data?.mode).toBe('sizeOnly');
      expect(result.data?.masterContext).toBeNull();
      expect(result.data?.projectContext).toBeNull();
      expect(result.data?.contextSizes).toBeDefined();
      expect(result.data?.contextSizes?.masterContext?.sizeKb).toBeGreaterThan(0);
      expect(result.data?.contextSizes?.projectContext?.sizeKb).toBeGreaterThan(0);
      expect(result.data?.contextSizes?.totalSizeKb).toBeGreaterThan(0);
    });

    it('returns empty aggregated in sizeOnly mode', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, sizeOnly: true });

      expect(result.success).toBe(true);
      expect(result.data?.aggregated.decisions).toEqual([]);
      expect(result.data?.aggregated.constraints).toEqual([]);
      expect(result.data?.aggregated.learnings).toEqual([]);
      expect(result.data?.aggregated.nextSteps).toEqual([]);
      expect(result.data?.aggregated.activeMission).toBeNull();
    });

    it('respects contextType filter in sizeOnly mode', async () => {
      const result = await rbookContextView({
        projectRoot: tempDir,
        sizeOnly: true,
        contextType: 'master_context',
      });

      expect(result.success).toBe(true);
      expect(result.data?.contextSizes?.masterContext?.sizeKb).toBeGreaterThan(0);
      expect(result.data?.contextSizes?.projectContext).toBeNull();
    });

    it('formats sizeOnly result for LLM', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, sizeOnly: true });
      const formatted = formatContextViewForLLM(result);

      expect(formatted).toContain('Size Report');
      expect(formatted).toContain('Master Context');
      expect(formatted).toContain('Project Context');
      expect(formatted).toContain('Combined');
      expect(formatted).not.toContain('Decisions Made');
    });
  });

  describe('compact mode', () => {
    it('returns summary digest with limited entries', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, compact: true });

      expect(result.success).toBe(true);
      expect(result.data?.mode).toBe('compact');
      expect(result.data?.masterContext).toBeNull();
      expect(result.data?.projectContext).toBeNull();
      expect(result.data?.compact).toBeDefined();
    });

    it('limits decisions to 5 in compact mode', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, compact: true });

      expect(result.success).toBe(true);
      // Master context has 7 decisions, compact should limit to 5
      expect(result.data?.compact?.recentDecisions.length).toBeLessThanOrEqual(5);
      expect(result.data?.aggregated.decisions.length).toBeLessThanOrEqual(5);
    });

    it('limits learnings to 5 in compact mode', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, compact: true });

      expect(result.success).toBe(true);
      // Master context has 6 learnings, compact should limit to 5
      expect(result.data?.compact?.recentLearnings.length).toBeLessThanOrEqual(5);
    });

    it('reaches all constraints in compact mode, a page at a time (s106-m03)', async () => {
      const first = await rbookContextView({ projectRoot: tempDir, compact: true });
      const second = await rbookContextView({ projectRoot: tempDir, compact: true, page: 2 });

      expect(first.success).toBe(true);
      expect(first.data?.compact).toMatchObject({ activeConstraints: ['c1'], nextPage: 2 });
      expect(second.data?.compact).toMatchObject({ activeConstraints: ['c2'], nextPage: null });
    });

    it('reaches all next steps in compact mode, and pageSize widens the page', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, compact: true, pageSize: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.compact?.pendingNextSteps).toEqual(['n1', 'n2']);
    });

    it('includes active mission from project_context', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, compact: true });

      expect(result.success).toBe(true);
      expect(result.data?.compact?.activeMission).toBe('s20-m04');
    });

    it('includes active sprint info', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, compact: true });

      expect(result.success).toBe(true);
      expect(result.data?.compact?.activeSprint).toContain('sprint-20');
      expect(result.data?.compact?.activeSprint).toContain('Context Lifecycle');
    });

    it('includes size metrics in compact mode', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, compact: true });

      expect(result.success).toBe(true);
      expect(result.data?.contextSizes).toBeDefined();
      expect(result.data?.contextSizes?.totalSizeKb).toBeGreaterThan(0);
    });

    it('respects contextType filter in compact mode', async () => {
      const result = await rbookContextView({
        projectRoot: tempDir,
        compact: true,
        contextType: 'master_context',
      });

      expect(result.success).toBe(true);
      expect(result.data?.compact?.activeMission).toBeNull();
      expect(result.data?.compact?.recentDecisions.length).toBeGreaterThan(0);
    });

    it('formats compact result for LLM', async () => {
      const result = await rbookContextView({ projectRoot: tempDir, compact: true });
      const formatted = formatContextViewForLLM(result);

      expect(formatted).toContain('Context Digest');
      expect(formatted).toContain('compact');
      expect(formatted).toContain('Recent Decisions');
      expect(formatted).toContain('Next Steps');
    });
  });

  describe('mutual exclusion', () => {
    it('returns error when both sizeOnly and compact are true', async () => {
      const result = await rbookContextView({
        projectRoot: tempDir,
        sizeOnly: true,
        compact: true,
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PARAMETER');
      expect(result.error?.message).toContain('mutually exclusive');
    });
  });

  describe('full mode (compact=false)', () => {
    it('returns full content with mode=full', async () => {
      const result = await rbookContextView({ compact: false, projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data?.mode).toBe('full');
      expect(result.data?.masterContext).not.toBeNull();
      expect(result.data?.projectContext).not.toBeNull();
      expect(result.data?.compact).toBeUndefined();
    });

    it('defaults to the digest, since the full view ran to 871,683 characters (s106-m03)', async () => {
      const result = await rbookContextView({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data?.mode).toBe('compact');
      expect(result.data?.masterContext).toBeNull();
      expect(result.data?.aggregated.decisions.length).toBeGreaterThan(0);
    });
  });
});
