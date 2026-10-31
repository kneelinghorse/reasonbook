/**
 * rbook_session_search Tool
 *
 * MCP tool for searching session history by keyword.
 * Searches across titles, summaries, and captures.
 *
 * @module tools/rbook/rbook-session-search
 */

import { z } from 'zod';
import { withClient } from './client';
import type { RbookToolResult } from './types';
import {
  createError,
  createSuccess,
  RbookErrors,
  VALID_SESSION_TYPES,
  type SessionType,
} from './errors';
import { VALID_CAPTURE_CATEGORIES, type CaptureCategory } from './rbook-session-capture';
import { getProjectId, tableHasColumn } from './genesis-columns';
import { frameInlineIfForeign } from '../../intelligence/provenance-frame';
import { appendWarnings } from './format-warnings';
import { PREVIEW_MAX_CHARS, previewText } from './text-preview';
import { readTimeBounds } from './stored-time';
import { callText, nextPageCall, pageFacts, pageRequest, shownLine } from './answer-page';

/**
 * s106-m03: sessions per page. 20 were 34,496 characters on this repo's store and 10 still 29,581:
 * a result with three matched captures, each a preview and a snippet, is about 2,900 characters.
 */
export const SESSION_SEARCH_PAGE_SIZE = 5;

/** s106-m03: matched captures shown per session; matchedCaptureCount counts them all. */
export const MATCHED_CAPTURES_SHOWN = 3;

// Re-export for convenience
export { VALID_SESSION_TYPES };
export type { SessionType };

/**
 * Matched capture with context.
 */
export interface MatchedCapture {
  /** Capture category */
  category: CaptureCategory;

  /** s93-m11 (#602): a preview of the capture, at most PREVIEW_MAX_CHARS characters. */
  content: string;

  /** Whether `content` was cut. */
  truncated: boolean;

  /** Characters in the full capture. */
  fullLength: number;

  /** Timestamp of capture */
  timestamp: string;

  /** Highlight snippet showing match context */
  highlight: string;
}

/**
 * Session search result.
 */
export interface SessionSearchResult {
  /** Session ID */
  id: string;

  /** Session type */
  type: string;

  /** Session title */
  title: string;

  /** Session status */
  status: string;

  /** Associated sprint ID */
  sprintId: string | null;

  /** When the session started */
  startedAt: string;

  /** When the session completed (if completed) */
  completedAt: string | null;

  /**
   * s93-m11 (#602): a preview of the session summary, at most PREVIEW_MAX_CHARS characters; read
   * it in full with rbook_session(action="list", sessionId).
   */
  summary: string | null;

  /** Whether `summary` was cut. */
  summaryTruncated: boolean;

  /** Characters in the full summary (0 when there is none). */
  summaryFullLength: number;

  /** Total captures in session */
  captureCount: number;

  /** Matched captures (only those matching the query): s106-m03, the first MATCHED_CAPTURES_SHOWN */
  matchedCaptures: MatchedCapture[];

  /** Every capture that matched; rbook_session(action="list", sessionId) reads them all. */
  matchedCaptureCount: number;

  /** Match location: where the query was found */
  matchedIn: ('title' | 'summary' | 'captures')[];

  /** Relevance score (higher = more matches) */
  relevance: number;

  /** s84-m03: the session's own project_id (guarded read). Foreign → title/captures framed. */
  projectId?: string | null;
}

/**
 * Result of session search operation.
 */
export interface RbookSessionSearchResult {
  /** Search query used */
  query: string;

  /** List of matching sessions */
  results: SessionSearchResult[];

  /** Total matches found */
  totalMatches: number;

  /** Whether results were limited */
  limited: boolean;

  /** s106-m03: this page's number, 1-based; each page holds pageSize sessions (the limit). */
  page: number;
  pageSize: number;
  hasMore: boolean;
  nextPage: number | null;
  /** The call that reads the next page with the same query and filters, or null on the last page. */
  nextPageCall: string | null;

  /** Filters applied */
  filters: {
    category?: CaptureCategory;
    type?: SessionType;
    since?: string;
    until?: string;
  };

  /** s84-m03: the querying store's own project_id. Sessions whose projectId differs are
   *  foreign (pull-merged) and framed as untrusted in the render. */
  localProjectId?: string | null;
}

/**
 * Input parameters schema for rbook_session_search tool.
 */
export const rbookSessionSearchSchema = z.object({
  /** Search query (required) */
  query: z
    .string()
    .min(1)
    .describe('Search query - keywords to find in session titles, summaries, and captures'),

  /** Filter by capture category */
  category: z
    .enum(VALID_CAPTURE_CATEGORIES)
    .optional()
    .describe('Filter by capture category: decision, learning, constraint, context, next-step'),

  /** Filter by session type */
  type: z
    .enum(VALID_SESSION_TYPES)
    .optional()
    .describe('Filter by session type: planning, review, research, onboarding, check-in, custom'),

  /** Filter sessions created after this date */
  since: z
    .string()
    .optional()
    .describe('Filter sessions started after this ISO date (e.g., "2024-01-01")'),

  /** Filter sessions created before this date */
  until: z.string().optional().describe('Filter sessions started before this ISO date'),

  /** Maximum results to return */
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(SESSION_SEARCH_PAGE_SIZE)
    .optional()
    .describe('Sessions per page (1-100, default: 5)'),

  /** s106-m03: page of results, 1-based */
  page: z.number().int().min(1).optional().describe('Page of results, 1-based (default 1)'),

  /** Optional project root */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookSessionSearchParams = z.infer<typeof rbookSessionSearchSchema>;

// s77-m05: the standalone `rbookSessionSearchToolDefinition` was deleted — session
// search is now reachable as rbook_session(action="search"), and the tool surface is
// generated from RBOOK_TOOL_DEFINITIONS (m06). `rbookSessionSearchSchema` above is
// retained purely as the `z.infer` source for RbookSessionSearchParams.

/**
 * Session row from database.
 */
interface SessionRow {
  id: string;
  type: string;
  title: string;
  status: string;
  sprint_id: string | null;
  started_at: string;
  completed_at: string | null;
  summary: string | null;
  captures: string | null;
  /** s84-m03: guarded project_id read (NULL on an ancient store). */
  project_id?: string | null;
}

/**
 * Parsed capture from JSON.
 */
interface ParsedCapture {
  category: string;
  content: string;
  timestamp: string;
  context?: string;
}

/**
 * Execute the rbook_session_search tool.
 *
 * Searches sessions using SQLite LIKE with multiple keywords.
 *
 * @param params - Tool parameters
 * @returns RbookToolResult with search results
 */
export async function rbookSessionSearch(
  requested: RbookSessionSearchParams
): Promise<RbookToolResult<RbookSessionSearchResult>> {
  // s93-m11: since/until compare as times; see readTimeBounds.
  const bounds = readTimeBounds(requested);
  if ('error' in bounds) return createError<RbookSessionSearchResult>(bounds.error);
  const params: RbookSessionSearchParams = { ...requested, ...bounds };
  if (!params.query || params.query.trim().length === 0) {
    return createError(RbookErrors.missingParameter('query'));
  }

  const request = pageRequest(params.page, params.limit, SESSION_SEARCH_PAGE_SIZE);
  const limit = request.pageSize;
  const query = params.query.trim().toLowerCase();

  // Split query into keywords for better matching
  const keywords = query.split(/\s+/).filter((k) => k.length >= 2);

  if (keywords.length === 0) {
    return createError(
      RbookErrors.invalidParameter('query', query, ['At least one keyword with 2+ characters'])
    );
  }

  return withClient(
    (client) => {
      // Build WHERE clauses for session-level filters
      const clauses: string[] = [];
      const queryParams: (string | number)[] = [];

      // Add session type filter
      if (params.type) {
        clauses.push('type = ?');
        queryParams.push(params.type);
      }

      // Add date range filters
      if (params.since) {
        clauses.push('julianday(started_at) >= julianday(?)');
        queryParams.push(params.since);
      }

      if (params.until) {
        clauses.push('julianday(started_at) <= julianday(?)');
        queryParams.push(params.until);
      }

      // Build search condition (search in title, summary, and captures)
      const searchConditions: string[] = [];
      for (const keyword of keywords) {
        searchConditions.push(
          `(LOWER(title) LIKE ? OR LOWER(COALESCE(summary, '')) LIKE ? OR LOWER(COALESCE(captures, '')) LIKE ?)`
        );
        queryParams.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
      }

      if (searchConditions.length > 0) {
        clauses.push(`(${searchConditions.join(' AND ')})`);
      }

      const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

      // s84-m03: guarded project_id read (NULL AS on an ancient store lacking the column).
      const projectIdExpr = tableHasColumn(client, 'sessions', 'project_id')
        ? 'project_id'
        : 'NULL AS project_id';

      // s106-m03: every matching session is ranked. This read used to stop at the newest
      // limit + 10, so an older, stronger match never reached the ranking, nor the total.
      const result = client.getMany<SessionRow>(
        `SELECT id, type, title, status, sprint_id, started_at, completed_at, summary, captures, ${projectIdExpr}
           FROM sessions
           ${whereClause}
          ORDER BY julianday(started_at) DESC, id DESC`,
        queryParams
      );

      const localProjectId = getProjectId(client);

      if (!result.success || !result.data) {
        return createSuccess<RbookSessionSearchResult>({
          query: params.query,
          results: [],
          totalMatches: 0,
          limited: false,
          page: request.page,
          pageSize: limit,
          hasMore: false,
          nextPage: null,
          nextPageCall: null,
          filters: {
            category: params.category,
            type: params.type,
            since: params.since,
            until: params.until,
          },
          localProjectId,
        });
      }

      // Process results and compute relevance
      const processedResults: SessionSearchResult[] = [];

      for (const row of result.data) {
        // Parse captures JSON
        let captures: ParsedCapture[] = [];
        try {
          captures = JSON.parse(row.captures || '[]');
        } catch {
          captures = [];
        }

        // Filter captures by category if specified
        if (params.category) {
          captures = captures.filter((c) => c.category === params.category);
        }

        // Find matches
        const matchedIn: ('title' | 'summary' | 'captures')[] = [];
        let relevance = 0;

        // Check title
        const titleLower = row.title.toLowerCase();
        for (const keyword of keywords) {
          if (titleLower.includes(keyword)) {
            if (!matchedIn.includes('title')) matchedIn.push('title');
            relevance += 3; // Title matches are weighted higher
          }
        }

        // Check summary
        const summaryLower = (row.summary || '').toLowerCase();
        for (const keyword of keywords) {
          if (summaryLower.includes(keyword)) {
            if (!matchedIn.includes('summary')) matchedIn.push('summary');
            relevance += 2; // Summary matches are weighted medium
          }
        }

        // Check captures and find matching ones
        const matchedCaptures: MatchedCapture[] = [];
        for (const capture of captures) {
          const contentLower = capture.content.toLowerCase();
          let captureMatches = false;

          for (const keyword of keywords) {
            if (contentLower.includes(keyword)) {
              captureMatches = true;
              relevance += 1;
            }
          }

          if (captureMatches) {
            if (!matchedIn.includes('captures')) matchedIn.push('captures');

            // Create highlight snippet
            const highlight = createHighlight(capture.content, keywords);

            const preview = previewText(capture.content);
            matchedCaptures.push({
              category: capture.category as CaptureCategory,
              content: preview.preview,
              truncated: preview.truncated,
              fullLength: preview.fullLength,
              timestamp: capture.timestamp,
              highlight,
            });
          }
        }

        // Skip if no matches found
        if (matchedIn.length === 0) continue;

        // Skip if category filter is set and no matching captures
        if (
          params.category &&
          matchedCaptures.length === 0 &&
          !matchedIn.includes('title') &&
          !matchedIn.includes('summary')
        ) {
          continue;
        }

        processedResults.push({
          id: row.id,
          type: row.type,
          title: row.title,
          status: row.status,
          sprintId: row.sprint_id,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          ...(row.summary
            ? (({ preview, truncated, fullLength }) => ({
                summary: preview,
                summaryTruncated: truncated,
                summaryFullLength: fullLength,
              }))(previewText(row.summary))
            : { summary: null, summaryTruncated: false, summaryFullLength: 0 }),
          captureCount: captures.length,
          matchedCaptures: matchedCaptures.slice(0, MATCHED_CAPTURES_SHOWN),
          matchedCaptureCount: matchedCaptures.length,
          matchedIn,
          relevance,
          projectId: row.project_id ?? null,
        });
      }

      // Sort by relevance; the sort is stable, so equal relevance keeps the newest first.
      processedResults.sort((a, b) => b.relevance - a.relevance);

      const limitedResults = processedResults.slice(request.offset, request.offset + limit);
      const totalMatches = processedResults.length;
      const facts = pageFacts(request, limitedResults.length, totalMatches);

      return createSuccess<RbookSessionSearchResult>({
        query: params.query,
        results: limitedResults,
        totalMatches,
        limited: facts.hasMore,
        page: facts.page,
        pageSize: limit,
        hasMore: facts.hasMore,
        nextPage: facts.nextPage,
        nextPageCall: nextPageCall(facts.nextPage, 'rbook_session', {
          action: 'search',
          query: requested.query,
          category: requested.category,
          type: requested.type,
          since: requested.since,
          until: requested.until,
          limit: requested.limit,
          projectRoot: requested.projectRoot,
        }),
        filters: {
          category: params.category,
          type: params.type,
          since: params.since,
          until: params.until,
        },
        localProjectId,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Create a highlight snippet showing keyword matches in context.
 */
function createHighlight(content: string, keywords: string[]): string {
  const maxLength = 100;
  const contentLower = content.toLowerCase();

  // Find first keyword position
  let firstMatchPos = content.length;
  for (const keyword of keywords) {
    const pos = contentLower.indexOf(keyword);
    if (pos !== -1 && pos < firstMatchPos) {
      firstMatchPos = pos;
    }
  }

  // Extract snippet around the match
  const start = Math.max(0, firstMatchPos - 20);
  const end = Math.min(content.length, firstMatchPos + maxLength - 20);

  let snippet = content.slice(start, end);

  // Add ellipsis if truncated
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';

  return snippet;
}

/**
 * Format session search result for LLM readability.
 *
 * @param result - Session search result
 * @returns Human-readable summary
 */
export function formatSessionSearchForLLM(
  result: RbookToolResult<RbookSessionSearchResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '? Failed to search sessions',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  // Header
  lines.push('? **Session Search Results**');
  lines.push('');
  lines.push(`Query: "${data.query}"`);
  lines.push(`Found: ${data.totalMatches} session${data.totalMatches === 1 ? '' : 's'}`);

  // Show filters if applied
  const activeFilters: string[] = [];
  if (data.filters.category) activeFilters.push(`category: ${data.filters.category}`);
  if (data.filters.type) activeFilters.push(`type: ${data.filters.type}`);
  if (data.filters.since) activeFilters.push(`since: ${data.filters.since}`);
  if (data.filters.until) activeFilters.push(`until: ${data.filters.until}`);
  if (activeFilters.length > 0) {
    lines.push(`Filters: ${activeFilters.join(', ')}`);
  }

  if (data.page > 1 || data.hasMore) {
    lines.push(
      `(${shownLine({ page: data.page, pageSize: data.pageSize, totalCount: data.totalMatches }, data.results.length, 'sessions')}, by relevance)`
    );
  }
  lines.push('');

  if (data.results.length === 0) {
    lines.push('No sessions found matching the query.');
    lines.push('');
    lines.push('**Suggestions**:');
    lines.push('  - Try different keywords');
    lines.push('  - Remove filters to broaden search');
    lines.push('  - Use rbook_session(action="list") to browse all sessions');
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  // List results
  for (const r of data.results) {
    const statusIcon = r.status === 'active' ? '?' : '?';
    // s84-m03: a foreign (pull-merged) session's title + matched-capture snippets are
    // untrusted DATA — frame inline; a local/NULL-project session renders byte-identical.
    const title = frameInlineIfForeign(r.title, r.projectId, data.localProjectId);
    lines.push(`${statusIcon} **${title}** (${r.type})`);
    lines.push(`   ID: ${r.id} | Status: ${r.status}`);
    lines.push(
      `   Started: ${r.startedAt}${r.completedAt ? ` | Completed: ${r.completedAt}` : ''}`
    );
    lines.push(`   Matched in: ${r.matchedIn.join(', ')} | Relevance: ${r.relevance}`);

    if (r.matchedCaptures.length > 0) {
      lines.push(`   Matching captures (${r.matchedCaptureCount}):`);
      for (const mc of r.matchedCaptures) {
        const highlight = frameInlineIfForeign(mc.highlight, r.projectId, data.localProjectId);
        lines.push(`     - [${mc.category}] ${highlight}`);
      }
      if (r.matchedCaptureCount > r.matchedCaptures.length) {
        lines.push(
          `     ... and ${r.matchedCaptureCount - r.matchedCaptures.length} more: ${callText('rbook_session', { action: 'list', sessionId: r.id })} reads the session whole`
        );
      }
    }
    lines.push('');
  }

  // s93-m11 (#602): summaries and captures are previews; say once how to read one in full.
  const cut = data.results.find(
    (r) => r.summaryTruncated || r.matchedCaptures.some((capture) => capture.truncated)
  );
  if (cut) {
    lines.push(
      `Summaries and captures are cut at ${PREVIEW_MAX_CHARS} characters. Read a session in full ` +
        `with rbook_session(action="list", sessionId="${cut.id}").`
    );
  }

  if (data.nextPageCall) lines.push(`Next page: ${data.nextPageCall}.`);

  appendWarnings(lines, result);

  return lines.join('\n');
}
