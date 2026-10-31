import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';

import { rbookSprintAnalytics } from '../../../src/tools/rbook/rbook-sprint-analytics';
import { formatSprintAnalyticsForLLM } from '../../../src/tools/rbook/rbook-sprint-analytics';
import { RBOOK_SCHEMA } from '../../../src/tools/rbook/schema';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let tempDir: string;
let dbPath: string;

function setupTestDb(): void {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-analytics-test-'));
  const rbookDbDir = path.join(tempDir, 'rbook', 'db');
  fs.mkdirSync(rbookDbDir, { recursive: true });
  dbPath = path.join(rbookDbDir, 'rbook.sqlite');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(RBOOK_SCHEMA);
  // Set project metadata
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'test-project')"
  ).run();
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', 'Test Project')"
  ).run();
  // Ensure master_context exists for FK constraints on strategic_decisions
  db.prepare(
    "INSERT OR IGNORE INTO contexts (id, source_path, content) VALUES ('master_context', 'test', '{}')"
  ).run();
  db.close();
}

function seedSprints(
  sprints: Array<{
    id: string;
    title: string;
    status: string;
    missions?: Array<{
      id: string;
      name: string;
      status: string;
      startedAt?: string;
      completedAt?: string;
    }>;
    decisions?: number;
    learnings?: number;
    sessions?: number;
  }>
): void {
  const db = new Database(dbPath);

  for (const sprint of sprints) {
    db.prepare(`INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)`).run(
      sprint.id,
      sprint.title,
      sprint.status
    );

    // Add missions
    if (sprint.missions) {
      for (const mission of sprint.missions) {
        db.prepare(
          `INSERT INTO missions (id, sprint_id, name, status, started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(
          mission.id,
          sprint.id,
          mission.name,
          mission.status,
          mission.startedAt ?? null,
          mission.completedAt ?? null
        );
      }
    }

    // Add decisions
    const decisionCount = sprint.decisions ?? 0;
    for (let i = 0; i < decisionCount; i++) {
      db.prepare(
        `INSERT INTO strategic_decisions (context_id, decision_text, created_at, sprint_id, status)
         VALUES ('master_context', ?, datetime('now'), ?, 'active')`
      ).run(`Decision ${i + 1} for ${sprint.id}`, sprint.id);
    }

    // Add learnings
    const learningCount = sprint.learnings ?? 0;
    for (let i = 0; i < learningCount; i++) {
      db.prepare(
        `INSERT INTO learnings (content, sprint_id, created_at, status)
         VALUES (?, ?, datetime('now'), 'active')`
      ).run(`Learning ${i + 1} for ${sprint.id}`, sprint.id);
    }

    // Add sessions
    const sessionCount = sprint.sessions ?? 0;
    for (let i = 0; i < sessionCount; i++) {
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, status)
         VALUES (?, 'planning', ?, ?, datetime('now'), 'completed')`
      ).run(`session-${sprint.id}-${i}`, `Session ${i + 1}`, sprint.id);
    }
  }

  db.close();
}

function cleanupTestDb(): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup failures
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('rbookSprintAnalytics', () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    cleanupTestDb();
  });

  // ─── Empty Database ─────────────────────────────────────────────────

  describe('empty database', () => {
    it('returns empty result with no sprints', async () => {
      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      expect(result.data!.sprints).toHaveLength(0);
      expect(result.data!.aggregates.totalSprints).toBe(0);
      expect(result.data!.highlights).toContain('No completed sprints found for analysis.');
    });
  });

  // ─── Single Sprint ────────────────────────────────────────────────

  describe('single sprint', () => {
    it('computes basic KPIs for one sprint', async () => {
      seedSprints([
        {
          id: 'sprint-1',
          title: 'Alpha',
          status: 'Completed',
          missions: [
            {
              id: 's1-m01',
              name: 'M1',
              status: 'Completed',
              startedAt: '2026-01-01',
              completedAt: '2026-01-02',
            },
            {
              id: 's1-m02',
              name: 'M2',
              status: 'Completed',
              startedAt: '2026-01-02',
              completedAt: '2026-01-03',
            },
            { id: 's1-m03', name: 'M3', status: 'Blocked' },
          ],
          decisions: 5,
          learnings: 2,
          sessions: 3,
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.success).toBe(true);
      const data = result.data!;

      expect(data.sprints).toHaveLength(1);
      expect(data.sprints[0].totalMissions).toBe(3);
      expect(data.sprints[0].completedMissions).toBe(2);
      expect(data.sprints[0].blockedMissions).toBe(1);
      expect(data.sprints[0].completionRate).toBe(67);
      expect(data.sprints[0].decisionsCount).toBe(5);
      expect(data.sprints[0].learningsCount).toBe(2);
      expect(data.sprints[0].sessionsCount).toBe(3);

      expect(data.aggregates.totalSprints).toBe(1);
      expect(data.aggregates.completedSprints).toBe(1);
      expect(data.aggregates.totalMissions).toBe(3);
      expect(data.aggregates.totalCompleted).toBe(2);
      expect(data.aggregates.overallCompletionRate).toBe(67);
    });

    it('returns stable trends with single sprint', async () => {
      seedSprints([
        {
          id: 'sprint-1',
          title: 'Alpha',
          status: 'Completed',
          missions: [{ id: 's1-m01', name: 'M1', status: 'Completed' }],
          decisions: 3,
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });
      const trends = result.data!.trends;

      expect(trends.velocity.direction).toBe('stable');
      expect(trends.completionRate.direction).toBe('stable');
      expect(trends.decisionsPerSprint.direction).toBe('stable');
    });
  });

  // ─── Multi-Sprint Trends ──────────────────────────────────────────

  describe('multi-sprint trends', () => {
    it('detects increasing velocity', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'S1',
          status: 'Completed',
          missions: [
            { id: 's1-m01', name: 'M1', status: 'Completed' },
            { id: 's1-m02', name: 'M2', status: 'Completed' },
          ],
        },
        {
          id: 'sprint-02',
          title: 'S2',
          status: 'Completed',
          missions: [
            { id: 's2-m01', name: 'M1', status: 'Completed' },
            { id: 's2-m02', name: 'M2', status: 'Completed' },
          ],
        },
        {
          id: 'sprint-03',
          title: 'S3',
          status: 'Completed',
          missions: [
            { id: 's3-m01', name: 'M1', status: 'Completed' },
            { id: 's3-m02', name: 'M2', status: 'Completed' },
            { id: 's3-m03', name: 'M3', status: 'Completed' },
            { id: 's3-m04', name: 'M4', status: 'Completed' },
          ],
        },
        {
          id: 'sprint-04',
          title: 'S4',
          status: 'Completed',
          missions: [
            { id: 's4-m01', name: 'M1', status: 'Completed' },
            { id: 's4-m02', name: 'M2', status: 'Completed' },
            { id: 's4-m03', name: 'M3', status: 'Completed' },
            { id: 's4-m04', name: 'M4', status: 'Completed' },
          ],
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.data!.trends.velocity.direction).toBe('increasing');
      expect(result.data!.trends.velocity.changePercent).toBeGreaterThan(0);
    });

    it('detects decreasing velocity', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'S1',
          status: 'Completed',
          missions: [
            { id: 's1-m01', name: 'M1', status: 'Completed' },
            { id: 's1-m02', name: 'M2', status: 'Completed' },
            { id: 's1-m03', name: 'M3', status: 'Completed' },
            { id: 's1-m04', name: 'M4', status: 'Completed' },
          ],
        },
        {
          id: 'sprint-02',
          title: 'S2',
          status: 'Completed',
          missions: [
            { id: 's2-m01', name: 'M1', status: 'Completed' },
            { id: 's2-m02', name: 'M2', status: 'Completed' },
            { id: 's2-m03', name: 'M3', status: 'Completed' },
            { id: 's2-m04', name: 'M4', status: 'Completed' },
          ],
        },
        {
          id: 'sprint-03',
          title: 'S3',
          status: 'Completed',
          missions: [{ id: 's3-m01', name: 'M1', status: 'Completed' }],
        },
        {
          id: 'sprint-04',
          title: 'S4',
          status: 'Completed',
          missions: [{ id: 's4-m01', name: 'M1', status: 'Completed' }],
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.data!.trends.velocity.direction).toBe('decreasing');
    });

    it('detects stable velocity within threshold', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'S1',
          status: 'Completed',
          missions: [
            { id: 's1-m01', name: 'M1', status: 'Completed' },
            { id: 's1-m02', name: 'M2', status: 'Completed' },
            { id: 's1-m03', name: 'M3', status: 'Completed' },
          ],
        },
        {
          id: 'sprint-02',
          title: 'S2',
          status: 'Completed',
          missions: [
            { id: 's2-m01', name: 'M1', status: 'Completed' },
            { id: 's2-m02', name: 'M2', status: 'Completed' },
            { id: 's2-m03', name: 'M3', status: 'Completed' },
          ],
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.data!.trends.velocity.direction).toBe('stable');
    });

    it('computes decision volume trends', async () => {
      seedSprints([
        { id: 'sprint-01', title: 'S1', status: 'Completed', decisions: 2 },
        { id: 'sprint-02', title: 'S2', status: 'Completed', decisions: 3 },
        { id: 'sprint-03', title: 'S3', status: 'Completed', decisions: 8 },
        { id: 'sprint-04', title: 'S4', status: 'Completed', decisions: 10 },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.data!.trends.decisionsPerSprint.direction).toBe('increasing');
      expect(result.data!.aggregates.totalDecisions).toBe(23);
    });
  });

  // ─── Aggregates ───────────────────────────────────────────────────

  describe('aggregates', () => {
    it('computes overall completion rate', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'S1',
          status: 'Completed',
          missions: [
            { id: 's1-m01', name: 'M1', status: 'Completed' },
            { id: 's1-m02', name: 'M2', status: 'Blocked' },
          ],
        },
        {
          id: 'sprint-02',
          title: 'S2',
          status: 'Completed',
          missions: [
            { id: 's2-m01', name: 'M1', status: 'Completed' },
            { id: 's2-m02', name: 'M2', status: 'Completed' },
          ],
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.data!.aggregates.totalMissions).toBe(4);
      expect(result.data!.aggregates.totalCompleted).toBe(3);
      expect(result.data!.aggregates.overallCompletionRate).toBe(75);
    });

    it('computes average velocity across completed sprints', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'S1',
          status: 'Completed',
          missions: [
            { id: 's1-m01', name: 'M1', status: 'Completed' },
            { id: 's1-m02', name: 'M2', status: 'Completed' },
          ],
        },
        {
          id: 'sprint-02',
          title: 'S2',
          status: 'Completed',
          missions: [
            { id: 's2-m01', name: 'M1', status: 'Completed' },
            { id: 's2-m02', name: 'M2', status: 'Completed' },
            { id: 's2-m03', name: 'M3', status: 'Completed' },
            { id: 's2-m04', name: 'M4', status: 'Completed' },
          ],
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.data!.aggregates.avgVelocity).toBe(3); // (2+4)/2
    });

    it('sums sessions and learnings across sprints', async () => {
      seedSprints([
        { id: 'sprint-01', title: 'S1', status: 'Completed', sessions: 2, learnings: 3 },
        { id: 'sprint-02', title: 'S2', status: 'Completed', sessions: 4, learnings: 1 },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.data!.aggregates.totalSessions).toBe(6);
      expect(result.data!.aggregates.totalLearnings).toBe(4);
    });
  });

  // ─── Cycle Time ───────────────────────────────────────────────────

  describe('cycle time', () => {
    it('computes average cycle time from mission timestamps', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'S1',
          status: 'Completed',
          missions: [
            {
              id: 's1-m01',
              name: 'M1',
              status: 'Completed',
              startedAt: '2026-01-01',
              completedAt: '2026-01-03',
            },
            {
              id: 's1-m02',
              name: 'M2',
              status: 'Completed',
              startedAt: '2026-01-03',
              completedAt: '2026-01-04',
            },
          ],
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.data!.sprints[0].avgCycleTimeDays).not.toBeNull();
      // (2 days + 1 day) / 2 = 1.5
      expect(result.data!.sprints[0].avgCycleTimeDays).toBe(1.5);
    });

    it('returns null cycle time when no timestamps available', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'S1',
          status: 'Completed',
          missions: [{ id: 's1-m01', name: 'M1', status: 'Completed' }],
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      expect(result.data!.sprints[0].avgCycleTimeDays).toBeNull();
    });
  });

  // ─── Limit Parameter ──────────────────────────────────────────────

  describe('limit parameter', () => {
    it('limits number of sprints returned', async () => {
      seedSprints([
        { id: 'sprint-01', title: 'S1', status: 'Completed' },
        { id: 'sprint-02', title: 'S2', status: 'Completed' },
        { id: 'sprint-03', title: 'S3', status: 'Completed' },
        { id: 'sprint-04', title: 'S4', status: 'Completed' },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir, limit: 2 });

      expect(result.data!.sprints).toHaveLength(2);
    });
  });

  // ─── Highlights ───────────────────────────────────────────────────

  describe('highlights', () => {
    it('generates velocity highlight', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'S1',
          status: 'Completed',
          missions: [{ id: 's1-m01', name: 'M1', status: 'Completed' }],
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      const hasVelocity = result.data!.highlights.some((h) => h.includes('velocity'));
      expect(hasVelocity).toBe(true);
    });

    it('generates completion rate highlight', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'S1',
          status: 'Completed',
          missions: [
            { id: 's1-m01', name: 'M1', status: 'Completed' },
            { id: 's1-m02', name: 'M2', status: 'Blocked' },
          ],
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      const hasCompletionRate = result.data!.highlights.some((h) => h.includes('completion rate'));
      expect(hasCompletionRate).toBe(true);
    });

    it('generates peak sprint highlight for 3+ sprints', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'Alpha',
          status: 'Completed',
          missions: [{ id: 's1-m01', name: 'M1', status: 'Completed' }],
        },
        {
          id: 'sprint-02',
          title: 'Beta',
          status: 'Completed',
          missions: [
            { id: 's2-m01', name: 'M1', status: 'Completed' },
            { id: 's2-m02', name: 'M2', status: 'Completed' },
            { id: 's2-m03', name: 'M3', status: 'Completed' },
          ],
        },
        {
          id: 'sprint-03',
          title: 'Gamma',
          status: 'Completed',
          missions: [
            { id: 's3-m01', name: 'M1', status: 'Completed' },
            { id: 's3-m02', name: 'M2', status: 'Completed' },
          ],
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });

      const hasPeak = result.data!.highlights.some((h) => h.includes('Peak velocity'));
      expect(hasPeak).toBe(true);
      const peakHighlight = result.data!.highlights.find((h) => h.includes('Peak'));
      expect(peakHighlight).toContain('sprint-02');
    });
  });

  // ─── LLM Formatter ───────────────────────────────────────────────

  describe('formatSprintAnalyticsForLLM', () => {
    it('formats analytics result as readable text', async () => {
      seedSprints([
        {
          id: 'sprint-01',
          title: 'Alpha',
          status: 'Completed',
          missions: [
            { id: 's1-m01', name: 'M1', status: 'Completed' },
            { id: 's1-m02', name: 'M2', status: 'Completed' },
          ],
          decisions: 5,
          sessions: 2,
        },
        {
          id: 'sprint-02',
          title: 'Beta',
          status: 'Completed',
          missions: [
            { id: 's2-m01', name: 'M1', status: 'Completed' },
            { id: 's2-m02', name: 'M2', status: 'Completed' },
            { id: 's2-m03', name: 'M3', status: 'Completed' },
          ],
          decisions: 8,
          sessions: 3,
        },
      ]);

      const result = await rbookSprintAnalytics({ projectRoot: tempDir });
      const formatted = formatSprintAnalyticsForLLM(result);

      expect(formatted).toContain('Cross-Sprint Analytics');
      expect(formatted).toContain('Aggregates');
      expect(formatted).toContain('Trends');
      expect(formatted).toContain('Per-Sprint Data');
      expect(formatted).toContain('sprint-01');
      expect(formatted).toContain('sprint-02');
    });

    it('formats error result', () => {
      const formatted = formatSprintAnalyticsForLLM({
        success: false,
        error: { code: 'TEST', message: 'Test error' },
      });

      expect(formatted).toContain('Analytics failed');
      expect(formatted).toContain('Test error');
    });
  });

  // ─── Pages (s106-m03) ───────────────────────────────────────────────

  describe('pages of per-sprint rows (s106-m03)', () => {
    const id = (n: number): string => `sprint-${String(n).padStart(2, '0')}`;

    beforeEach(() => {
      seedSprints(
        Array.from({ length: 25 }, (_, i) => ({
          id: id(i + 1),
          title: `Sprint ${i + 1}`,
          status: 'Completed',
          missions: [{ id: `s${i + 1}-m01`, name: 'Work', status: 'Completed' }],
        }))
      );
    });

    async function analytics(params: Record<string, unknown>) {
      return (await rbookSprint({
        action: 'analytics',
        projectRoot: tempDir,
        ...params,
      } as never)) as Awaited<ReturnType<typeof rbookSprintAnalytics>>;
    }

    it('shows the newest 20 rows, computes every figure over the whole window, and pages back', async () => {
      // OODS-Forge's 219 sprints made the unbounded default 94,342 characters.
      const first = await analytics({});
      expect(first.data!.sprints.map((s) => s.sprintId)).toEqual(
        Array.from({ length: 20 }, (_, i) => id(i + 6))
      );
      expect(first.data!.aggregates.totalSprints).toBe(25);
      expect(first.data!.window).toMatchObject({
        sprintCount: 25,
        oldestSprintId: id(1),
        newestSprintId: id(25),
      });
      expect(first.data).toMatchObject({ page: 1, hasMore: true, nextPage: 2 });
      const text = formatSprintAnalyticsForLLM(first);
      expect(text).toContain('Showing 1–20 of 25 sprints, counted from the newest');
      expect(text).toContain(
        `Next page: rbook_sprint(action="analytics", projectRoot=${JSON.stringify(tempDir)}, page=2).`
      );

      const second = await analytics({ page: 2 });
      expect(second.data!.sprints.map((s) => s.sprintId)).toEqual([1, 2, 3, 4, 5].map(id));
      expect(second.data!.aggregates).toEqual(first.data!.aggregates);
      expect(second.data).toMatchObject({ page: 2, hasMore: false, nextPage: null });
      expect(formatSprintAnalyticsForLLM(second)).not.toContain('Next page');
    });

    it('keeps a window of 20 or fewer on one page, with the window in the next-page call', async () => {
      const small = await analytics({ limit: 10 });
      expect(small.data!.sprints).toHaveLength(10);
      expect(small.data).toMatchObject({ hasMore: false, nextPage: null });
      const windowed = await analytics({ limit: 22 });
      expect(formatSprintAnalyticsForLLM(windowed)).toContain(
        `Next page: rbook_sprint(action="analytics", limit=22, projectRoot=${JSON.stringify(tempDir)}, page=2).`
      );
    });
  });
});
