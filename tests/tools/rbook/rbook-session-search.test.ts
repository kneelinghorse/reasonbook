/**
 * rbook_session_search Tool Tests
 *
 * s77-m05: these drive the REAL rbookSessionSearch handler (via projectRoot) against
 * a seeded temp store — the previous ~220-line reimplementation (a drift hazard whose
 * highlight logic had already diverged from the real createHighlight) was removed.
 *
 * @module tests/tools/rbook/rbook-session-search
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookSessionSearch,
  formatSessionSearchForLLM,
  VALID_SESSION_TYPES,
  type RbookSessionSearchParams,
  type RbookSessionSearchResult,
} from '../../../src/tools/rbook/rbook-session-search';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import type { RbookSessionSearchResult as SessionSearchResultType } from '../../../src/tools/rbook/rbook-session-search';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';

describe('rbook_session_search', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-session-search-test-'));
    const dbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'rbook.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT,
        focus TEXT,
        status TEXT
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

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT
      );

      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_name', 'Search Test'), ('project_id', 'search-test');

      -- Insert test data
      INSERT INTO sprints (id, title, status)
      VALUES ('sprint-14', 'Sprint 14', 'Current');

      INSERT INTO sessions (id, type, title, sprint_id, started_at, status, summary, captures)
      VALUES
        ('PS-001', 'planning', 'Sprint Planning Session', 'sprint-14', '2024-01-15T09:00:00Z', 'completed', 'Planned sprint 14 with TypeScript focus', '[{"category":"decision","content":"Use TypeScript for all tools","timestamp":"2024-01-15T09:30:00Z"},{"category":"learning","content":"SQLite is fast enough","timestamp":"2024-01-15T09:45:00Z"}]'),
        ('PS-002', 'review', 'Code Review Session', 'sprint-14', '2024-01-16T10:00:00Z', 'completed', 'Reviewed mission implementation code', '[{"category":"decision","content":"Add error handling","timestamp":"2024-01-16T10:30:00Z"},{"category":"constraint","content":"Must maintain backward compatibility","timestamp":"2024-01-16T10:45:00Z"}]'),
        ('PS-003', 'research', 'Database Research', 'sprint-14', '2024-01-17T14:00:00Z', 'active', NULL, '[{"category":"learning","content":"SQLite WAL mode improves performance","timestamp":"2024-01-17T14:30:00Z"},{"category":"next-step","content":"Implement caching layer","timestamp":"2024-01-17T14:45:00Z"}]'),
        ('PS-004', 'planning', 'Feature Planning', 'sprint-14', '2024-01-18T09:00:00Z', 'completed', 'Planned search functionality', '[{"category":"context","content":"Search needs to be fast","timestamp":"2024-01-18T09:30:00Z"}]');
    `);
    db.close();

    RbookDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** Drive the REAL rbookSessionSearch handler against the seeded temp store. */
  function search(
    params: Omit<RbookSessionSearchParams, 'projectRoot'>
  ): Promise<RbookToolResult<RbookSessionSearchResult>> {
    RbookDetector.resetInstance();
    return rbookSessionSearch({ ...params, projectRoot: tempDir });
  }

  describe('basic search functionality', () => {
    it('should search across session titles', async () => {
      const result = await search({ query: 'Planning' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results.some((r) => r.title.includes('Planning'))).toBe(true);
    });

    it('should search across session summaries', async () => {
      const result = await search({ query: 'TypeScript' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeGreaterThan(0);
      expect(result.data?.results[0].matchedIn).toContain('summary');
    });

    it('should search across captures', async () => {
      const result = await search({ query: 'SQLite' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBe(2); // PS-001 and PS-003
      expect(result.data?.results[0].matchedIn).toContain('captures');
    });

    it('should return matched captures with highlights (real createHighlight)', async () => {
      const result = await search({ query: 'TypeScript' });

      expect(result.success).toBe(true);
      expect(result.data?.results[0].matchedCaptures.length).toBeGreaterThan(0);
      const hl = result.data?.results[0].matchedCaptures[0].highlight;
      expect(hl).toBeDefined();
      // createHighlight extracts a window around the first keyword — the matched
      // snippet must actually contain the query.
      expect(hl?.toLowerCase()).toContain('typescript');
    });

    it('should rank results by relevance', async () => {
      const result = await search({ query: 'SQLite' });

      expect(result.success).toBe(true);
      const relevances = result.data?.results.map((r) => r.relevance) ?? [];
      for (let i = 1; i < relevances.length; i++) {
        expect(relevances[i]).toBeLessThanOrEqual(relevances[i - 1]);
      }
    });
  });

  describe('filtering', () => {
    it('should filter by capture category', async () => {
      const result = await search({ query: 'SQLite', category: 'learning' });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        for (const capture of session.matchedCaptures) {
          expect(capture.category).toBe('learning');
        }
      }
    });

    it('should filter by session type', async () => {
      const result = await search({ query: 'session', type: 'planning' });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(session.type).toBe('planning');
      }
    });

    it('should filter by date range (since)', async () => {
      const result = await search({ query: 'session', since: '2024-01-17' });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(new Date(session.startedAt) >= new Date('2024-01-17')).toBe(true);
      }
    });

    it('should filter by date range (until)', async () => {
      const result = await search({ query: 'session', until: '2024-01-16T12:00:00Z' });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(new Date(session.startedAt) <= new Date('2024-01-16T12:00:00Z')).toBe(true);
      }
    });

    it('should apply multiple filters', async () => {
      const result = await search({ query: 'Planning', type: 'planning', since: '2024-01-15' });

      expect(result.success).toBe(true);
      for (const session of result.data?.results ?? []) {
        expect(session.type).toBe('planning');
        expect(new Date(session.startedAt) >= new Date('2024-01-15')).toBe(true);
      }
    });
  });

  describe('pagination', () => {
    it('should respect limit parameter', async () => {
      const result = await search({ query: 'session', limit: 2 });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeLessThanOrEqual(2);
    });

    it('should indicate when results are limited', async () => {
      const result = await search({ query: 'session', limit: 1 });

      expect(result.success).toBe(true);
      if (result.data?.totalMatches && result.data.totalMatches > 1) {
        expect(result.data?.limited).toBe(true);
      }
    });

    it('should default limit to 5 (s106-m03: 20 were 34,496 characters, 10 still 29,581)', async () => {
      const result = await search({ query: 'session' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBeLessThanOrEqual(5);
    });
  });

  describe('pages (s106-m03)', () => {
    beforeEach(() => {
      const db = new Database(dbPath);
      const insert = db.prepare(
        `INSERT INTO sessions (id, type, title, started_at, status, captures)
         VALUES (?, 'review', ?, ?, 'completed', ?)`
      );
      // Twelve newer sessions that match the word once, in a capture.
      for (let i = 1; i <= 12; i++)
        insert.run(
          `NEW-${String(i).padStart(2, '0')}`,
          `Newer session ${i}`,
          `2024-03-${String(i).padStart(2, '0')}T09:00:00Z`,
          JSON.stringify([
            { category: 'learning', content: 'mentions zebra once', timestamp: '2024-03-01' },
          ])
        );
      // One old session whose title, summary and six captures match: the strongest match.
      insert.run(
        'OLD-01',
        'Zebra crossing review',
        '2023-01-01T09:00:00Z',
        JSON.stringify(
          Array.from({ length: 6 }, (_, i) => ({
            category: 'decision',
            content: `zebra decision ${i + 1}`,
            timestamp: '2023-01-01',
          }))
        )
      );
      db.close();
    });

    async function viaRouter(params: Record<string, unknown>) {
      RbookDetector.resetInstance();
      return (await rbookSession({
        action: 'search',
        projectRoot: tempDir,
        ...params,
      } as never)) as RbookToolResult<RbookSessionSearchResult>;
    }

    it('ranks every match, not only the newest few, and states the true total', async () => {
      // The read used to fetch limit+10 newest sessions, then rank only those.
      const result = await viaRouter({ query: 'zebra', limit: 2 });
      expect(result.data!.totalMatches).toBe(13);
      expect(result.data!.results[0].id).toBe('OLD-01');
      expect(result.data).toMatchObject({ page: 1, hasMore: true, nextPage: 2 });
    });

    it('returns 5 sessions by default and reaches every match once through the pages', async () => {
      const first = await viaRouter({ query: 'zebra' });
      expect(first.data!.results).toHaveLength(5);
      const seen: string[] = [];
      let page: number | null = 1;
      while (page !== null) {
        const result = await viaRouter({ query: 'zebra', limit: 5, page });
        seen.push(...result.data!.results.map((r) => r.id));
        page = result.data!.nextPage;
        if (page !== null)
          expect(formatSessionSearchForLLM(result)).toContain(
            `Next page: rbook_session(action="search", query="zebra", limit=5, projectRoot=${JSON.stringify(tempDir)}, page=${page}).`
          );
      }
      expect(seen).toHaveLength(13);
      expect(new Set(seen).size).toBe(13);
      expect(seen[0]).toBe('OLD-01');
      // Equal relevance keeps the newest first.
      expect(seen.slice(1)).toEqual(
        Array.from({ length: 12 }, (_, i) => `NEW-${String(12 - i).padStart(2, '0')}`)
      );
    });

    it('keeps three matched captures per session, counts them all, and names the full read', async () => {
      const result = await viaRouter({ query: 'zebra' });
      const old = result.data!.results.find((r) => r.id === 'OLD-01')!;
      expect(old.matchedCaptures).toHaveLength(3);
      expect(old.matchedCaptureCount).toBe(6);
      const text = formatSessionSearchForLLM(result);
      expect(text).toContain('Matching captures (6):');
      expect(text).toContain('... and 3 more: rbook_session(action="list", sessionId="OLD-01")');
    });
  });

  describe('error handling', () => {
    it('should return error for empty query', async () => {
      const result = await search({ query: '' });

      expect(result.success).toBe(false);
    });

    it('should return empty results for non-matching query', async () => {
      const result = await search({ query: 'xyznonexistent' });

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBe(0);
      expect(result.data?.totalMatches).toBe(0);
    });
  });

  describe('exports', () => {
    it('exposes the valid session types', () => {
      expect(VALID_SESSION_TYPES).toContain('planning');
      expect(VALID_SESSION_TYPES).toContain('review');
      expect(VALID_SESSION_TYPES).toContain('research');
    });
  });

  describe('via rbook_session(action="search") — end-to-end through the router', () => {
    it('drives the real handler and returns matchedCaptures with a highlight', async () => {
      RbookDetector.resetInstance();
      const result = (await rbookSession({
        action: 'search',
        query: 'SQLite',
        projectRoot: tempDir,
      })) as RbookToolResult<SessionSearchResultType>;

      expect(result.success).toBe(true);
      expect(result.data?.results.length).toBe(2); // PS-001 + PS-003
      const withCaptures = result.data?.results.find((r) => r.matchedCaptures.length > 0);
      expect(withCaptures).toBeDefined();
      expect(withCaptures?.matchedCaptures[0].highlight.toLowerCase()).toContain('sqlite');
    });

    it('surfaces MISSING_PARAMETER when query is omitted (?? "" reaches the handler)', async () => {
      RbookDetector.resetInstance();
      const result = await rbookSession({ action: 'search', projectRoot: tempDir });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAMETER');
    });
  });

  describe('formatSessionSearchForLLM', () => {
    it('should format search results', async () => {
      const result = await search({ query: 'Planning' });
      const formatted = formatSessionSearchForLLM(result);

      expect(formatted).toContain('Search Results');
      expect(formatted).toContain('Planning');
    });

    it('should show filter information', async () => {
      const result = await search({ query: 'test', type: 'planning' });
      const formatted = formatSessionSearchForLLM(result);

      expect(formatted).toContain('type: planning');
    });

    it('should show matched captures', async () => {
      const result = await search({ query: 'TypeScript' });
      const formatted = formatSessionSearchForLLM(result);

      expect(formatted).toContain('decision');
    });
  });
});
