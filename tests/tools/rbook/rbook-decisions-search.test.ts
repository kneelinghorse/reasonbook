/**
 * rbook_decisions_search Tool Tests
 *
 * Tests for the strategic decisions search tool.
 *
 * @module tests/tools/rbook/rbook-decisions-search
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookDecisionsSearch,
  rbookDecisionsSearchToolDefinition,
  formatDecisionsSearchForLLM,
  type RbookDecisionsSearchParams,
  type RbookDecisionsSearchResult,
} from '../../../src/tools/rbook/rbook-decisions-search';
import { RBOOK_ERROR_CODES } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import type { RbookToolResult } from '../../../src/tools/rbook/types';

describe('rbook_decisions_search', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-decisions-search-test-'));
    const rbookDir = path.join(tempDir, 'rbook');
    const dbDir = path.join(rbookDir, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'rbook.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT NOT NULL DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        snapshot_id INTEGER,
        project_domain TEXT,
        mission_id TEXT,
        session_id TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        sprint_id TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        agent TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        summary TEXT,
        captures TEXT DEFAULT '[]',
        next_steps TEXT,
        metadata TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      INSERT INTO strategic_decisions (decision_text, created_at, project_domain, sprint_id)
      VALUES
        ('Use TypeScript for all new tools', '2024-01-15T10:00:00Z', 'cmos-mcp', 'sprint-14'),
        ('Implement pagination for all list operations', '2024-01-14T09:00:00Z', 'cmos-mcp', 'sprint-14'),
        ('Follow RbookToolResult pattern for consistent responses', '2024-01-13T08:00:00Z', 'general', 'sprint-13'),
        ('Use SQLite for local storage', '2024-01-12T07:00:00Z', 'ai-studio', 'sprint-13'),
        ('Adopt better-sqlite3 for sync operations', '2024-01-11T06:00:00Z', 'cmos-mcp', 'sprint-12'),
        ('All tools should return structured errors', '2024-01-10T05:00:00Z', 'cmos-mcp', 'sprint-12');

      INSERT INTO metadata (key, value) VALUES ('project_domain', 'cmos-mcp');
    `);
    db.close();

    RbookDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('basic search', () => {
    it('should find decisions matching a single keyword', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'TypeScript' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results.some((d) => d.decision.includes('TypeScript'))).toBe(true);
    });

    it('should find decisions matching multiple keywords', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'all operations' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
    });

    it('should return empty for no matches', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'nonexistent xyz' });

      expect(result.success).toBe(true);
      expect(result.data?.results).toHaveLength(0);
      expect(result.data?.totalMatches).toBe(0);
    });

    it('should return the query in the result', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'TypeScript' });

      expect(result.success).toBe(true);
      expect(result.data?.query).toBe('TypeScript');
    });
  });

  describe('case insensitivity', () => {
    it('should be case insensitive', async () => {
      const upperResult = await rbookDecisionsSearchWithDb(dbPath, { query: 'TYPESCRIPT' });
      const lowerResult = await rbookDecisionsSearchWithDb(dbPath, { query: 'typescript' });
      const mixedResult = await rbookDecisionsSearchWithDb(dbPath, { query: 'TypeScript' });

      // s95-m09: a real match first, so three identical failures cannot pass as "case insensitive".
      expect(lowerResult.success).toBe(true);
      expect(lowerResult.data?.totalMatches).toBeGreaterThan(0);
      expect(upperResult.data?.totalMatches).toBe(lowerResult.data?.totalMatches);
      expect(lowerResult.data?.totalMatches).toBe(mixedResult.data?.totalMatches);
    });
  });

  describe('relevance scoring', () => {
    it('should return relevance scores', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'tools' });

      expect(result.success).toBe(true);
      expect(result.data?.results.every((r) => typeof r.relevance === 'number')).toBe(true);
    });

    it('should order by relevance (higher first)', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'tools' });

      expect(result.success).toBe(true);
      const relevances = result.data?.results.map((r) => r.relevance) || [];
      for (let i = 1; i < relevances.length; i++) {
        expect(relevances[i]).toBeLessThanOrEqual(relevances[i - 1]);
      }
    });
  });

  describe('filtering', () => {
    it('should filter by domain', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, {
        query: 'all',
        domain: 'cmos-mcp',
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.every((d) => d.domain === 'cmos-mcp')).toBe(true);
    });

    it('should filter by sprintId', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, {
        query: 'all',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.every((d) => d.sprintId === 'sprint-14')).toBe(true);
    });

    it('should combine search with filters', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, {
        query: 'tools',
        domain: 'cmos-mcp',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results.every((d) => d.domain === 'cmos-mcp')).toBe(true);
    });

    it('should surface session-only decisions in sprint-scoped search', async () => {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, captures)
         VALUES (?, 'review', 'Sprint review', 'sprint-14', '2024-01-15T08:00:00Z', '2024-01-15T09:00:00Z', 'completed', ?)`
      ).run(
        'review-14',
        JSON.stringify([
          {
            category: 'decision',
            content: 'Review retrospective decision',
            timestamp: '2024-01-15T09:00:00Z',
          },
        ])
      );
      db.close();

      const result = await rbookDecisionsSearchWithDb(dbPath, {
        query: 'retrospective decision',
        sprintId: 'sprint-14',
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.some((d) => d.decision === 'Review retrospective decision')).toBe(
        true
      );
      expect(
        result.data?.results.find((d) => d.decision === 'Review retrospective decision')?.source
      ).toBe('session_capture');
    });
  });

  describe('limit parameter', () => {
    it('should respect limit parameter', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, {
        query: 'all',
        limit: 2,
      });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeLessThanOrEqual(2);
    });

    it('should indicate when results are limited', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, {
        query: 'all',
        limit: 1,
      });

      expect(result.success).toBe(true);
      if (result.data?.totalMatches && result.data.totalMatches > 1) {
        expect(result.data?.limited).toBe(true);
      }
    });

    it('returns the top 15 by default and says how to see the rest (s106-m03)', async () => {
      // 20 results were 21,844 characters on a registered store, past the 20,000 cap.
      const db = new Database(dbPath);
      const insert = db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, project_domain, sprint_id)
         VALUES (?, ?, 'cmos-mcp', 'sprint-14')`
      );
      for (let i = 0; i < 20; i++)
        insert.run(`Zebra crossing rule ${i + 1}`, new Date(Date.now() - i * 60_000).toISOString());
      db.close();
      RbookDetector.resetInstance();
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'zebra' });

      expect(result.success).toBe(true);
      expect(result.data?.results).toHaveLength(15);
      expect(result.data?.limited).toBe(true);
      expect(formatDecisionsSearchForLLM(result)).toContain(
        'raise limit or narrow the query to see more'
      );
    });
  });

  describe('error handling', () => {
    it('should return error for empty query', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: '' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
    });

    it('should return error for whitespace-only query', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: '   ' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.MISSING_PARAMETER);
    });

    it('should return error for single character query', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'a' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe(RBOOK_ERROR_CODES.INVALID_PARAMETER);
    });

    it('should return error when Reasonbook not detected', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-rbook-'));

      try {
        const result = await rbookDecisionsSearch({ query: 'test', projectRoot: emptyDir });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe(RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });
  });

  describe('tool definition', () => {
    it('should have correct tool name', () => {
      expect(rbookDecisionsSearchToolDefinition.name).toBe('rbook_decisions_search');
    });

    it('should have description', () => {
      expect(rbookDecisionsSearchToolDefinition.description).toBeTruthy();
      expect(rbookDecisionsSearchToolDefinition.description).toContain('Search');
    });

    it('should have query as required parameter', () => {
      expect(rbookDecisionsSearchToolDefinition.inputSchema.required).toContain('query');
    });

    it('should have valid input schema', () => {
      expect(rbookDecisionsSearchToolDefinition.inputSchema.type).toBe('object');
      expect(rbookDecisionsSearchToolDefinition.inputSchema.properties).toBeDefined();
      expect(rbookDecisionsSearchToolDefinition.inputSchema.properties.query).toBeDefined();
      expect(rbookDecisionsSearchToolDefinition.inputSchema.properties.domain).toBeDefined();
      expect(rbookDecisionsSearchToolDefinition.inputSchema.properties.limit).toBeDefined();
    });
  });

  describe('formatDecisionsSearchForLLM', () => {
    it('should format success result', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'TypeScript' });
      const formatted = formatDecisionsSearchForLLM(result);

      expect(formatted).toContain('Search Results');
      expect(formatted).toContain('TypeScript');
    });

    it('should format error result', async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-test-'));

      try {
        const result = await rbookDecisionsSearch({ query: 'test', projectRoot: emptyDir });
        const formatted = formatDecisionsSearchForLLM(result);

        expect(formatted).toContain('Failed');
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it('should show query in output', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'pagination' });
      const formatted = formatDecisionsSearchForLLM(result);

      expect(formatted).toContain('pagination');
    });

    it('should show suggestions for no results', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'nonexistent' });
      const formatted = formatDecisionsSearchForLLM(result);

      expect(formatted).toContain('No decisions found');
      expect(formatted).toContain('Suggestion');
    });

    it('should include relevance in output', async () => {
      const result = await rbookDecisionsSearchWithDb(dbPath, { query: 'tools' });
      const formatted = formatDecisionsSearchForLLM(result);

      expect(formatted).toContain('Relevance');
    });
  });
});

/**
 * Helper to run rbookDecisionsSearch with explicit database path.
 * s95-m09: it only maps the fixture's path to its project root. It used to re-implement the
 * handler's query validation and return before the handler ran, so the validation cases tested a
 * copy rather than shipped code.
 */
async function rbookDecisionsSearchWithDb(
  dbPath: string,
  params: { query: string; domain?: string; sprintId?: string; limit?: number }
): Promise<RbookToolResult<RbookDecisionsSearchResult>> {
  return rbookDecisionsSearch({
    ...params,
    projectRoot: path.dirname(path.dirname(path.dirname(dbPath))),
  });
}
