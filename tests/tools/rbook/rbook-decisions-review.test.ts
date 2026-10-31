/**
 * rbook_decisions review + batch_update action tests
 *
 * Tests for decision lifecycle review (staleness scoring, suggested actions)
 * and batch update operations.
 *
 * @module tests/tools/rbook/rbook-decisions-review
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { formatDecisionsForLLM } from '../../../src/tools/rbook/rbook-decisions';
import {
  reviewDecisionStaleness,
  DEFAULT_STALENESS_THRESHOLD,
  type StaleDecisionDetail,
} from '../../../src/tools/rbook/staleness-detection';
import { withClient } from '../../../src/tools/rbook/client';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { PREVIEW_MAX_CHARS } from '../../../src/tools/rbook/text-preview';
import { REREAD_AFTER_ACTING } from '../../../src/tools/rbook/answer-page';

describe('rbook_decisions review & batch_update', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-decisions-review-test-'));
    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    dbPath = path.join(rbookDbDir, 'rbook.sqlite');

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
        category TEXT,
        superseded_by INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        evidence TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    // Insert sprints: sprint-1 through sprint-36. s97-m13: 1-35 closed in label order, two weeks
    // apart, as review ages count the closes after a decision's sprint closed.
    for (let i = 1; i <= 36; i++) {
      db.prepare('INSERT INTO sprints (id, title, status, end_date) VALUES (?, ?, ?, ?)').run(
        `sprint-${i}`,
        `Sprint ${i}`,
        i <= 35 ? 'Completed' : 'Active',
        i <= 35 ? new Date(Date.now() - ((36 - i) * 14 + 1) * 86400_000).toISOString() : null
      );
    }

    // Insert decisions at various sprint ages
    const insertDecision = db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status, category, evidence, superseded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    // Old decision (sprint-5, 30 closes after it) — should be "archive"
    insertDecision.run(
      'Use REST API for all endpoints',
      '2025-01-01T00:00:00Z',
      'sprint-5',
      'active',
      'architectural',
      null,
      null
    );

    // Moderately old (sprint-20, age=16) — stale
    insertDecision.run(
      'Prefer SQLite for local storage',
      '2025-06-01T00:00:00Z',
      'sprint-20',
      'stale',
      null,
      null,
      null
    );

    // Approaching staleness (sprint-28, age=8) — "review"
    insertDecision.run(
      'Use Zod for schema validation',
      '2025-09-01T00:00:00Z',
      'sprint-28',
      'active',
      'tooling',
      null,
      null
    );

    // Recent (sprint-35, age=1) — should NOT appear
    insertDecision.run(
      'Sprint 36 theme: Intelligence',
      '2026-03-01T00:00:00Z',
      'sprint-35',
      'active',
      null,
      null,
      null
    );

    // Old with evidence (sprint-10, age=26) — "confirm"
    insertDecision.run(
      'Event sourcing for audit trail',
      '2025-02-01T00:00:00Z',
      'sprint-10',
      'active',
      'architectural',
      '[{"type":"collection","id":"abc123"}]',
      null
    );

    // Already archived — should NOT appear
    insertDecision.run(
      'Deprecated approach',
      '2024-01-01T00:00:00Z',
      'sprint-3',
      'archived',
      null,
      null,
      null
    );

    // Old decision that is supersession target (sprint-8) — "confirm"
    insertDecision.run(
      'Use MCP for all tools',
      '2025-01-15T00:00:00Z',
      'sprint-8',
      'active',
      null,
      null,
      null
    );
    // Another decision superseded by the above
    insertDecision.run(
      'Old tool pattern',
      '2025-01-10T00:00:00Z',
      'sprint-7',
      'superseded',
      null,
      null,
      7
    );

    db.close();

    // Clear detector cache
    RbookDetector.getInstance().clearCache();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    RbookDetector.getInstance().clearCache();
  });

  describe('review action', () => {
    it('returns decisions with staleness scores and suggested actions', async () => {
      const result = await rbookDecisions({
        action: 'review',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.currentSprintNumber).toBe(36);
      expect(data.threshold).toBe(DEFAULT_STALENESS_THRESHOLD);
      expect(data.decisions.length).toBeGreaterThan(0);

      // Verify scoring
      for (const d of data.decisions) {
        expect(d.stalenessScore).toBeGreaterThanOrEqual(0);
        expect(d.stalenessScore).toBeLessThanOrEqual(1);
        expect(d.sprintAge).toBeGreaterThan(0);
        expect(['archive', 'review', 'confirm']).toContain(d.suggestedAction);
        expect(d.suggestedReason).toBeTruthy();
      }
    });

    it('suggests archive for very old decisions', async () => {
      const result = await rbookDecisions({
        action: 'review',
        projectRoot: tempDir,
      });

      const data = result.data as any;
      const oldDecision = data.decisions.find((d: StaleDecisionDetail) =>
        d.text.includes('REST API')
      );
      expect(oldDecision).toBeDefined();
      expect(oldDecision.suggestedAction).toBe('archive');
      expect(oldDecision.stalenessScore).toBe(1); // Capped at 1.0
      expect(oldDecision.sprintAge).toBe(30);
    });

    it('suggests confirm for decisions with evidence', async () => {
      const result = await rbookDecisions({
        action: 'review',
        projectRoot: tempDir,
      });

      const data = result.data as any;
      const evidenced = data.decisions.find((d: StaleDecisionDetail) =>
        d.text.includes('Event sourcing')
      );
      expect(evidenced).toBeDefined();
      expect(evidenced.suggestedAction).toBe('confirm');
      expect(evidenced.hasEvidence).toBe(true);
    });

    it('suggests confirm for supersession targets', async () => {
      const result = await rbookDecisions({
        action: 'review',
        projectRoot: tempDir,
      });

      const data = result.data as any;
      const referenced = data.decisions.find((d: StaleDecisionDetail) =>
        d.text.includes('Use MCP')
      );
      expect(referenced).toBeDefined();
      expect(referenced.suggestedAction).toBe('confirm');
      expect(referenced.isReferenced).toBe(true);
    });

    it('excludes recent decisions (current sprint)', async () => {
      const result = await rbookDecisions({
        action: 'review',
        projectRoot: tempDir,
      });

      const data = result.data as any;
      const recent = data.decisions.find((d: StaleDecisionDetail) =>
        d.text.includes('Sprint 36 theme')
      );
      expect(recent).toBeUndefined();
    });

    it('excludes already archived decisions', async () => {
      const result = await rbookDecisions({
        action: 'review',
        projectRoot: tempDir,
      });

      const data = result.data as any;
      const archived = data.decisions.find((d: StaleDecisionDetail) =>
        d.text.includes('Deprecated approach')
      );
      expect(archived).toBeUndefined();
    });

    it('sorts by staleness score descending', async () => {
      const result = await rbookDecisions({
        action: 'review',
        projectRoot: tempDir,
      });

      const data = result.data as any;
      const scores = data.decisions.map((d: StaleDecisionDetail) => d.stalenessScore);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
      }
    });

    it('formats review output for LLM', async () => {
      const result = await rbookDecisions({
        action: 'review',
        projectRoot: tempDir,
      });

      const formatted = formatDecisionsForLLM('review', result);
      expect(formatted).toContain('Decision Lifecycle Review');
      expect(formatted).toContain('Archive');
      expect(formatted).toContain('batch_update');
    });
  });

  describe('review pages (s106-m03)', () => {
    const long = 'Archive candidate '.repeat(30).trim();

    beforeEach(() => {
      const db = new Database(dbPath);
      const insert = db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES (?, '2025-01-02T00:00:00Z', 'sprint-5', 'active')`
      );
      for (let i = 0; i < 25; i++) insert.run(i === 0 ? long : `Old decision ${i + 1}`);
      db.close();
    });

    async function review(params: Record<string, unknown> = {}) {
      return rbookDecisions({ action: 'review', projectRoot: tempDir, ...params } as never);
    }

    it('returns 8 decisions a page, with every count over all of them, and pages to the last', async () => {
      // OODS-Forge's review was 258,332 characters: every candidate, in full, on one answer; 10 a
      // page still reached 20,128.
      const whole = await withClient(
        (client) => ({ success: true as const, data: reviewDecisionStaleness(client) }),
        { projectRoot: tempDir }
      );
      const all = whole.data!.decisions;
      const count = (action: string) => all.filter((d) => d.suggestedAction === action).length;
      const first = await review();
      const data = first.data as any;
      expect(all.length).toBeGreaterThan(20);
      expect(data.decisions).toHaveLength(8);
      expect(data.decisionCount).toBe(all.length);
      expect(data.countsByAction).toEqual({
        archive: count('archive'),
        review: count('review'),
        confirm: count('confirm'),
      });
      expect(data).toMatchObject({ page: 1, pageSize: 8, hasMore: true, nextPage: 2 });
      const text = formatDecisionsForLLM('review', first);
      expect(text).toContain(`${all.length} decision(s) need attention`);
      expect(text).toContain(`Showing 1–8 of ${all.length} decisions`);
      expect(text).toContain(
        `Next page: rbook_decisions(action="review", projectRoot=${JSON.stringify(tempDir)}, page=2).`
      );
      // The archive call names only the ids on this page, and says so.
      const archiveIds = data.decisions
        .filter((d: StaleDecisionDetail) => d.suggestedAction === 'archive')
        .map((d: StaleDecisionDetail) => d.id);
      expect(text).toContain(`decisionIds=[${archiveIds.join(',')}]`);
      expect(text).toContain(`this page's ${archiveIds.length}`);

      const seen: number[] = data.decisions.map((d: StaleDecisionDetail) => d.id);
      let page: number | null = data.nextPage;
      while (page !== null) {
        const next = (await review({ page })).data as any;
        expect(next.countsByAction).toEqual(data.countsByAction);
        seen.push(...next.decisions.map((d: StaleDecisionDetail) => d.id));
        page = next.nextPage;
      }
      expect(seen).toEqual(all.map((d) => d.id));
    });

    it('skips candidates when a page is acted on and the Next page call follows (critic B2)', async () => {
      // Why the note exists: archiving page 1 moves the later candidates up, so page 2 starts past
      // rows no page showed. If paging ever stops shifting rows, this fails and the note can go.
      const first = (await review()).data as any;
      const archive = first.decisions
        .filter((d: StaleDecisionDetail) => d.suggestedAction === 'archive')
        .map((d: StaleDecisionDetail) => d.id);
      expect(archive.length).toBeGreaterThan(0);
      const before = await withClient(
        (client) => ({ success: true as const, data: reviewDecisionStaleness(client) }),
        { projectRoot: tempDir }
      );
      await rbookDecisions({
        action: 'batch_update',
        decisionIds: archive,
        status: 'archived',
        projectRoot: tempDir,
      });
      const seen = new Set<number>(first.decisions.map((d: StaleDecisionDetail) => d.id));
      let page: number | null = first.nextPage;
      while (page !== null) {
        const next = (await review({ page })).data as any;
        next.decisions.forEach((d: StaleDecisionDetail) => seen.add(d.id));
        page = next.nextPage;
      }
      expect(before.data!.decisions.some((d) => !seen.has(d.id))).toBe(true);
    });

    it('reaches every candidate when each acted-on page is read again, as its note says', async () => {
      const first = (await review()).data as any;
      expect(first.pageNote).toBe(REREAD_AFTER_ACTING);
      expect(formatDecisionsForLLM('review', { success: true, data: first } as never)).toContain(
        REREAD_AFTER_ACTING
      );
      const all = await withClient(
        (client) => ({ success: true as const, data: reviewDecisionStaleness(client) }),
        { projectRoot: tempDir }
      );
      // Archive the even-numbered archive candidates and leave the rest: acting on a property of
      // the row, not its place, leaves page 1 full of rows left alone, so Next page must be used.
      const seen = new Set<number>();
      const handled = new Set<number>();
      let page = 1;
      for (let calls = 0; calls < 60; calls++) {
        const data = (await review({ page })).data as any;
        data.decisions.forEach((d: StaleDecisionDetail) => seen.add(d.id));
        const fresh = data.decisions.filter((d: StaleDecisionDetail) => !handled.has(d.id));
        fresh.forEach((d: StaleDecisionDetail) => handled.add(d.id));
        const archive = fresh
          .filter((d: StaleDecisionDetail) => d.suggestedAction === 'archive' && d.id % 2 === 0)
          .map((d: StaleDecisionDetail) => d.id);
        if (archive.length > 0) {
          await rbookDecisions({
            action: 'batch_update',
            decisionIds: archive,
            status: 'archived',
            projectRoot: tempDir,
          });
          continue; // read the same page again
        }
        if (data.nextPage === null) break;
        page = data.nextPage;
      }
      expect(all.data!.decisions.filter((d) => !seen.has(d.id))).toEqual([]);
      expect(page).toBeGreaterThanOrEqual(2);
    });

    it('previews a long decision with its full length, and pageSize sets the page', async () => {
      const data = (await review({ pageSize: 50 })).data as any;
      expect(data.decisions).toHaveLength(data.decisionCount);
      expect(data.hasMore).toBe(false);
      const cut = data.decisions.find((d: { truncated: boolean }) => d.truncated);
      expect(cut).toMatchObject({ fullLength: long.length });
      expect(cut.text.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      expect(formatDecisionsForLLM('review', { success: true, data } as never)).toContain(
        `rbook_decisions(action="show", decisionId=${cut.id})`
      );
    });
  });

  describe('batch_update action', () => {
    it('archives multiple decisions at once', async () => {
      const result = await rbookDecisions({
        action: 'batch_update',
        decisionIds: [1, 2],
        status: 'archived',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.updated).toBe(2);
      expect(data.requested).toBe(2);
      expect(data.notFound).toEqual([]);
      expect(data.status).toBe('archived');

      // Verify in database
      const db = new Database(dbPath);
      const d1 = db.prepare('SELECT status FROM strategic_decisions WHERE id = 1').get() as any;
      const d2 = db.prepare('SELECT status FROM strategic_decisions WHERE id = 2').get() as any;
      expect(d1.status).toBe('archived');
      expect(d2.status).toBe('archived');
      db.close();
    });

    it('reports not found IDs', async () => {
      const result = await rbookDecisions({
        action: 'batch_update',
        decisionIds: [1, 999],
        status: 'archived',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.updated).toBe(1);
      expect(data.notFound).toEqual([999]);
    });

    it('reports already-in-status IDs', async () => {
      const result = await rbookDecisions({
        action: 'batch_update',
        decisionIds: [6], // Already archived
        status: 'archived',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.updated).toBe(0);
      expect(data.alreadyInStatus).toEqual([6]);
    });

    it('rejects empty decisionIds', async () => {
      const result = await rbookDecisions({
        action: 'batch_update',
        decisionIds: [],
        status: 'archived',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(false);
    });

    it('rejects invalid status AT RUNTIME, independently of the schema', async () => {
      // s86-m04 tightened `status` to a 4-member z.enum, so the cast is now needed to express a
      // value the TYPE forbids. Keeping this test is the point: the consolidated zod schemas are
      // never parsed at runtime (src/index.ts casts every case), so the zod enum rejects NOTHING
      // an agent can send. What actually rejects this is the handler's own guard — and this
      // assertion is the only thing that proves that guard exists rather than being assumed from
      // the presence of a schema.
      const result = await rbookDecisions({
        action: 'batch_update',
        decisionIds: [1],
        status: 'invalid_status' as unknown as 'archived',
        projectRoot: tempDir,
      });

      expect(result.success).toBe(false);
    });

    it('formats batch_update output for LLM', async () => {
      const result = await rbookDecisions({
        action: 'batch_update',
        decisionIds: [1, 2, 3],
        status: 'archived',
        projectRoot: tempDir,
      });

      const formatted = formatDecisionsForLLM('batch_update', result);
      expect(formatted).toContain('Batch Decision Update');
      expect(formatted).toContain('archived');
    });
  });

  describe('reviewDecisionStaleness (direct)', () => {
    it('returns empty when no sprints exist', async () => {
      // Create a DB with no sprints
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-review-'));
      const emptyDbDir = path.join(emptyDir, 'rbook', 'db');
      fs.mkdirSync(emptyDbDir, { recursive: true });
      const emptyDbPath = path.join(emptyDbDir, 'rbook.sqlite');

      const db = new Database(emptyDbPath);
      db.exec(`
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER, focus TEXT);
        CREATE TABLE strategic_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT DEFAULT 'master_context', decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT, status TEXT DEFAULT 'active', category TEXT, evidence TEXT, superseded_by INTEGER, snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT, source_chunk_ids TEXT);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
      `);
      db.close();

      RbookDetector.getInstance().clearCache();

      const result = await rbookDecisions({
        action: 'review',
        projectRoot: emptyDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.decisions).toEqual([]);
      expect(data.currentSprintNumber).toBeNull();

      fs.rmSync(emptyDir, { recursive: true, force: true });
    });

    it('includeApproaching=false only returns stale decisions', async () => {
      const result = await rbookDecisions({
        action: 'review',
        includeApproaching: false,
        projectRoot: tempDir,
      });

      expect(result.success).toBe(true);
      const data = result.data as any;
      // Only decisions with status='stale' should be included
      for (const d of data.decisions) {
        expect(d.status).toBe('stale');
      }
    });
  });
});
