/**
 * rbook_session_list Tool
 *
 * MCP tool for listing sessions with optional filters.
 * Returns paginated list of sessions.
 *
 * @module tools/rbook/rbook-session-list
 */

import { z } from 'zod';
import { withClient } from './client';
import type { RbookToolResult, Session } from './types';
import { createError, createSuccess } from './errors';
import { authorNamesSince, authorReading } from './author-name';
import { VALID_SESSION_TYPES, type SessionType } from './rbook-session-start';
import { getProjectId, tableHasColumn } from './genesis-columns';
import { frameInlineIfForeign } from '../../intelligence/provenance-frame';
import { appendWarnings } from './format-warnings';
import { previewText } from './text-preview';
import { callText, nextPageCall } from './answer-page';
import { pagedSessionRead } from './session-read-pages';
import { namedReadLines } from './session-read-render';

/**
 * Valid session statuses.
 */
export const VALID_SESSION_STATUSES = ['active', 'completed', 'canceled'] as const;

export type SessionStatus = (typeof VALID_SESSION_STATUSES)[number];

/**
 * Session list item.
 */
export interface SessionListItem {
  /** Session ID */
  id: string;

  /** Session type */
  type: SessionType;

  /** Session title */
  title: string;

  /** Session status */
  status: SessionStatus;

  /** When the session started */
  startedAt: string;

  /** When the session was completed (if completed) */
  completedAt: string | null;

  /** Agent who ran the session */
  agent: string;

  /** s96-m02 (ADR s96 §10): the person whose session it is, or the reading for a NULL author. */
  author: string;

  /**
   * Session summary (if completed). s93-m11 (#602): a preview of at most PREVIEW_MAX_CHARS
   * characters on a plain list (a default page was 30 KB of summaries here); in full when the list
   * names one session (`sessionId`).
   */
  summary: string | null;

  /** Whether `summary` was cut; absent when it is whole. */
  summaryTruncated?: boolean;

  /** Characters in the full summary, when it was cut. */
  summaryFullLength?: number;

  /** s107-m05: a summary too large for one page is read in parts; this is the part's place. */
  summaryPart?: number;

  /** s107-m05: how many parts the summary was read in. */
  summaryParts?: number;

  /** Number of captures in this session */
  captureCount: number;

  /** Associated sprint ID (if any) */
  sprintId: string | null;

  /** s84-m03: the session's own project_id (guarded read). Foreign → title/summary framed. */
  projectId?: string | null;

  /**
   * s93-m11 — every capture in full, only when the list names one session (`sessionId`): search
   * answers carry previews and point here to read a session whole.
   */
  captures?: SessionListCapture[];
}

/** s93-m11 — one stored capture, whole: every field a capture stores. */
export interface SessionListCapture {
  category: string;
  content: string;
  timestamp: string | null;
  /** The capture's context note, when it was given one. */
  context?: string;
  missionId?: string;
  /** A constraint capture's expiry. */
  expiresAt?: string;
  /** The sprint a deferred capture materializes into. */
  sprintId?: string;
  /**
   * s107-m05: a capture too large for one page is read in parts that join back exactly; these
   * give the part's place, how many there are, and the whole content's length. Its context rides
   * whole on the first part, or, when it is too large for that, follows the content's parts in
   * parts of its own with empty content; joining each field across the parts gives it back.
   */
  part?: number;
  parts?: number;
  fullLength?: number;
}

/**
 * Result of session list operation.
 */
export interface RbookSessionListResult {
  /** List of sessions */
  sessions: SessionListItem[];

  /** Total count matching filters */
  totalCount: number;

  /** Page number returned */
  page: number;

  /**
   * Page size: sessions a page. On a named read in pages (pageCount present) the caller's pageSize,
   * when given, caps the captures a page holds; otherwise this is that default, and pages are
   * bounded by the answer cap alone.
   */
  pageSize: number;

  /** Whether there are more results */
  hasMore: boolean;

  /** s106-m03: the next page's number, or null on the last page. */
  nextPage: number | null;

  /** The call that reads the next page with the same filters, or null on the last page. */
  nextPageCall: string | null;

  /** s107-m05: a named read that needs more than one page: how many pages the session takes. */
  pageCount?: number;

  /** s107-m05: where this page's captures sit in stored order (1-based), when it holds any. */
  capturesShown?: { first: number; last: number };

  /** Applied filters */
  filters: {
    status?: SessionStatus;
    type?: SessionType;
    sprintId?: string;
    sessionId?: string;
  };

  /** s84-m03: the querying store's own project_id. Sessions whose projectId differs are
   *  foreign (pull-merged) and framed as untrusted in the render. */
  localProjectId?: string | null;
}

/**
 * Input parameters schema for rbook_session_list tool.
 */
export const rbookSessionListSchema = z.object({
  /** Filter by status */
  status: z
    .enum(VALID_SESSION_STATUSES)
    .optional()
    .describe('Filter by session status: active, completed, or canceled'),

  /** Filter by type */
  type: z
    .enum(VALID_SESSION_TYPES)
    .optional()
    .describe(
      'Filter by session type: onboarding, planning, review, research, check-in, or custom'
    ),

  /** Filter by sprint */
  sprintId: z.string().optional().describe('Filter by sprint ID'),

  /** s93-m11: only this session, so a search preview can be read in full. */
  sessionId: z.string().optional().describe('Only this session'),

  /** Page number */
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .optional()
    .describe('Page number (1-indexed, default: 1)'),

  /** Page size */
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(15)
    .optional()
    .describe('Results per page (1-100, default: 15)'),

  /** Optional project root */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookSessionListParams = z.infer<typeof rbookSessionListSchema>;

/**
 * MCP Tool Definition for rbook_session_list.
 */
export const rbookSessionListToolDefinition = {
  name: 'rbook_session_list',
  description:
    'List sessions with optional filtering by status, type, or sprint. Returns paginated results sorted by most recent first.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: VALID_SESSION_STATUSES,
        description: 'Filter by session status: active, completed, or canceled',
      },
      type: {
        type: 'string',
        enum: VALID_SESSION_TYPES,
        description:
          'Filter by session type: onboarding, planning, review, research, check-in, or custom',
      },
      sprintId: {
        type: 'string',
        description: 'Filter by sprint ID',
      },
      sessionId: {
        type: 'string',
        description: 'Only this session',
      },
      page: {
        type: 'number',
        description: 'Page number (1-indexed, default: 1)',
        minimum: 1,
      },
      pageSize: {
        type: 'number',
        description: 'Results per page (1-100, default: 15)',
        minimum: 1,
        maximum: 100,
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_session_list tool.
 *
 * Lists sessions with optional filters and pagination.
 *
 * @param params - Tool parameters
 * @returns RbookToolResult with session list or actionable error
 */
export async function rbookSessionList(
  params: RbookSessionListParams
): Promise<RbookToolResult<RbookSessionListResult>> {
  const page = params.page ?? 1;
  // s106-m03: 20 rows were 20,787 characters on a registered store, past the 20,000 cap.
  const pageSize = params.pageSize ?? 15;
  const offset = (page - 1) * pageSize;

  return withClient(
    (client) => {
      // Build query with filters
      const conditions: string[] = [];
      const queryParams: unknown[] = [];

      if (params.status) {
        conditions.push('status = ?');
        queryParams.push(params.status);
      }

      if (params.type) {
        conditions.push('type = ?');
        queryParams.push(params.type);
      }

      if (params.sprintId) {
        conditions.push('sprint_id = ?');
        queryParams.push(params.sprintId);
      }

      if (params.sessionId) {
        conditions.push('id = ?');
        queryParams.push(params.sessionId);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get total count
      const countResult = client.getOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM sessions ${whereClause}`,
        queryParams
      );

      if (!countResult.success) {
        return createError<RbookSessionListResult>(
          countResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to count sessions' }
        );
      }

      const totalCount = countResult.data?.count ?? 0;

      // s84-m03: guarded project_id read (NULL AS on an ancient store lacking the column).
      const projectIdExpr = tableHasColumn(client, 'sessions', 'project_id')
        ? 'project_id'
        : 'NULL AS project_id';
      const authorExpr = tableHasColumn(client, 'sessions', 'author_name')
        ? 'author_name'
        : 'NULL AS author_name';
      const occurredExpr = tableHasColumn(client, 'sessions', 'occurred_at')
        ? 'occurred_at'
        : 'NULL AS occurred_at';
      const since = authorNamesSince(client);

      // Get sessions
      const sessionsResult = client.getMany<Session>(
        `SELECT id, type, title, status, started_at, completed_at, agent, summary, captures, sprint_id, ${projectIdExpr},
                ${authorExpr}, ${occurredExpr}
         FROM sessions
         ${whereClause}
         ORDER BY julianday(started_at) DESC
         LIMIT ? OFFSET ?`,
        // s107-m05: a named read's page picks a page of that session's entries, not of sessions.
        [...queryParams, params.sessionId ? 1 : pageSize, params.sessionId ? 0 : offset]
      );

      if (!sessionsResult.success) {
        return createError<RbookSessionListResult>(
          sessionsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to list sessions' }
        );
      }

      const sessions: SessionListItem[] = (sessionsResult.data ?? []).map((s) => {
        // Count captures
        let captureCount = 0;
        let stored: unknown[] = [];
        try {
          const captures: unknown = s.captures ? JSON.parse(s.captures) : [];
          stored = Array.isArray(captures) ? captures : [];
          captureCount = stored.length;
        } catch {
          captureCount = 0;
        }

        return {
          id: s.id,
          type: s.type as SessionType,
          title: s.title,
          status: s.status as SessionStatus,
          startedAt: s.started_at,
          completedAt: s.completed_at,
          agent: s.agent,
          author: authorReading(
            (s as unknown as { author_name?: string | null }).author_name,
            (s as unknown as { occurred_at?: number | null }).occurred_at,
            since
          ),
          ...summaryAsListed(s.summary, Boolean(params.sessionId)),
          captureCount,
          sprintId: s.sprint_id,
          projectId: (s as unknown as Record<string, string | null>).project_id ?? null,
          ...(params.sessionId ? { captures: fullCaptures(stored) } : {}),
        };
      });

      const localProjectId = getProjectId(client);
      const filters = {
        ...(params.status && { status: params.status }),
        ...(params.type && { type: params.type }),
        ...(params.sprintId && { sprintId: params.sprintId }),
        ...(params.sessionId && { sessionId: params.sessionId }),
      };
      const callArgs = {
        action: 'list',
        status: params.status,
        type: params.type,
        sprintId: params.sprintId,
        sessionId: params.sessionId,
        pageSize: params.pageSize,
        projectRoot: params.projectRoot,
      };
      // s107-m05 (#879): a named read that needs more than one page answers one page of its
      // entries; one that fits on one page answers exactly as before.
      const paged =
        params.sessionId && sessions.length === 1
          ? pagedSessionRead({
              item: sessions[0],
              page,
              pageSize,
              maxCaptures: params.pageSize,
              totalCount,
              filters,
              localProjectId,
              callArgs,
            })
          : null;
      if (paged?.result)
        return createSuccess<RbookSessionListResult>(
          paged.result,
          paged.warning ? [paged.warning] : undefined
        );

      const hasMore = offset + sessions.length < totalCount;
      const nextPage = hasMore ? page + 1 : null;

      return createSuccess<RbookSessionListResult>(
        {
          sessions,
          totalCount,
          page,
          pageSize,
          hasMore,
          nextPage,
          nextPageCall: nextPageCall(nextPage, 'rbook_session', callArgs),
          filters,
          localProjectId,
        },
        paged?.warning ? [paged.warning] : undefined
      );
    },
    { projectRoot: params.projectRoot }
  );
}

/** s93-m11 — a summary as the list carries it: whole for a named session, else a preview. */
function summaryAsListed(
  summary: string | null,
  whole: boolean
): Pick<SessionListItem, 'summary' | 'summaryTruncated' | 'summaryFullLength'> {
  if (whole || summary === null) return { summary };
  const { preview, truncated, fullLength } = previewText(summary);
  return truncated
    ? { summary: preview, summaryTruncated: true, summaryFullLength: fullLength }
    : { summary };
}

/** s93-m11 — stored captures as the full read returns them; a malformed entry is skipped. */
function fullCaptures(stored: unknown[]): SessionListCapture[] {
  return stored.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const capture = entry as Record<string, unknown>;
    if (typeof capture.content !== 'string') return [];
    const optional = (key: 'context' | 'missionId' | 'expiresAt' | 'sprintId') =>
      typeof capture[key] === 'string' ? { [key]: capture[key] as string } : {};
    return [
      {
        category: typeof capture.category === 'string' ? capture.category : 'unknown',
        content: capture.content,
        timestamp: typeof capture.timestamp === 'string' ? capture.timestamp : null,
        ...optional('context'),
        ...optional('missionId'),
        ...optional('expiresAt'),
        ...optional('sprintId'),
      },
    ];
  });
}

/**
 * Format session list result for LLM readability.
 */
export function formatSessionListForLLM(result: RbookToolResult<RbookSessionListResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to list sessions', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const data = result.data;

  if (data.sessions.length === 0) {
    const filterDesc = Object.entries(data.filters)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    const lines = [
      filterDesc ? `No sessions found matching filters: ${filterDesc}` : 'No sessions found',
    ];
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const lines = [`📋 **Sessions** (${data.sessions.length} of ${data.totalCount})`, ''];

  // Apply filters description
  const filterEntries = Object.entries(data.filters);
  if (filterEntries.length > 0) {
    const filterDesc = filterEntries.map(([k, v]) => `${k}=${v}`).join(', ');
    lines.push(`*Filters: ${filterDesc}*`);
    lines.push('');
  }

  const statusIcon: Record<SessionStatus, string> = {
    active: '🟢',
    completed: '✅',
    canceled: '❌',
  };

  for (const session of data.sessions) {
    const icon = statusIcon[session.status] ?? '📄';
    // s107-m05: a read in pages says "1 capture"; a one-page read prints as it always has.
    const noun =
      data.pageCount !== undefined && session.captureCount === 1 ? 'capture' : 'captures';
    const captureInfo = session.captureCount > 0 ? ` (${session.captureCount} ${noun})` : '';
    // s84-m03: a foreign (pull-merged) session's title/summary is untrusted DATA — frame
    // inline; a local/NULL-project session renders byte-identical to 2.3.0.
    const title = frameInlineIfForeign(session.title, session.projectId, data.localProjectId);
    lines.push(`${icon} **${session.id}** - ${title}${captureInfo}`);
    lines.push(
      `   Type: ${session.type} | Status: ${session.status} | Agent: ${session.agent} | Author: ${session.author}`
    );
    if (session.captures) {
      // s93-m11: one session named by id is read in full, summary and every capture; s107-m05: a
      // page at a time when it takes more than one, page 1 reading the summary.
      lines.push(
        ...namedReadLines(
          session,
          data.localProjectId,
          data.pageCount === undefined
            ? undefined
            : {
                page: data.page,
                pageCount: data.pageCount,
                shown: data.capturesShown,
              }
        )
      );
    } else if (session.summary) {
      const shortSummary =
        session.summary.length > 80 ? session.summary.slice(0, 80) + '...' : session.summary;
      lines.push(
        `   Summary: ${frameInlineIfForeign(shortSummary, session.projectId, data.localProjectId)}`
      );
    }
    lines.push('');
  }

  // s107-m05: a named read's pages are its own entries', not pages of sessions.
  if (data.pageCount !== undefined) {
    if (data.page <= data.pageCount) lines.push(`*Page ${data.page} of ${data.pageCount}.*`);
  } else if (data.hasMore) {
    lines.push(`*Page ${data.page} of ${Math.ceil(data.totalCount / data.pageSize)}.*`);
  }
  if (data.nextPageCall) lines.push(`Next page: ${data.nextPageCall}.`);

  // s93-m11 (#602): a plain list shows a summary's first 80 characters and carries a preview; say
  // once how to read a session whole.
  const cut = data.sessions.find(
    (session) => !session.captures && session.summary && session.summary.length > 80
  );
  if (cut) {
    lines.push(
      `Summaries are cut here. Read a session in full with ` +
        `${callText('rbook_session', { action: 'list', sessionId: cut.id })}.`
    );
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
