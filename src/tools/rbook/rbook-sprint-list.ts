/**
 * rbook_sprint_list Tool
 *
 * MCP tool for listing sprints from the Reasonbook database.
 * Uses sprint_summary view for aggregated mission counts.
 * Returns structured sprint objects with mission statistics.
 *
 * @module tools/rbook/rbook-sprint-list
 */

import { z } from 'zod';
import { withClient } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess } from './errors';
import { appendWarnings, attachWarnings } from './format-warnings';
import { ensureSprintSummaryView } from './schema-migrations';
import { sprintIdOrderSql } from './sprint-ordering';
import { parkedColumn } from './sprint-summary-read';
import { callText, nextPageCall, pageFacts, pageRequest, shownLine } from './answer-page';
import { PREVIEW_MAX_CHARS, previewText } from './text-preview';

/** s106-m03: sprints per page of the list. */
export const SPRINT_LIST_PAGE_SIZE = 15;

/**
 * Sprint list item with mission statistics.
 */
export interface SprintListItem {
  /** Sprint ID (e.g., "sprint-14") */
  id: string;

  /** Sprint title */
  title: string;

  /** Strategic focus of the sprint: a preview of at most 300 characters (s106-m03); show has it whole */
  focus: string | null;

  /** Whether the focus preview was cut, and the full focus's length (0 when null) */
  focusTruncated: boolean;
  focusFullLength: number;

  /** Sprint status (e.g., "Active", "Completed") */
  status: string | null;

  /** Start date (ISO format) */
  startDate: string | null;

  /** End date (ISO format) */
  endDate: string | null;

  /** Total missions in sprint */
  totalMissions: number;

  /** Completed missions */
  completedMissions: number;

  /** Blocked missions */
  blockedMissions: number;

  /** Active missions (Current + In Progress) */
  activeMissions: number;

  /** s86-m08: Deferred + Dropped missions — parked work, excluded from totalMissions and
   *  reported here so it is neither counted against the sprint nor hidden from the reader. */
  parkedMissions: number;

  /** Strategic decisions count */
  decisionsCount: number;
}

/**
 * Result type for rbook_sprint_list.
 */
export interface RbookSprintListResult {
  /** List of sprints */
  sprints: SprintListItem[];

  /** Total count of sprints (before limit) */
  totalCount: number;

  /**
   * s93-m11 (feedback #47): Planned sprints this page left out. The page orders by start date and a
   * Planned sprint has none yet, so a short page used to drop every one of them without a word.
   * Present only for an unfiltered list that left one out.
   */
  omittedPlanned?: number;

  /** Filters applied */
  filters: {
    status: string | null;
    limit: number;
  };

  /** s106-m03: this page's number, 1-based; each page holds filters.limit sprints. */
  page: number;
  hasMore: boolean;
  nextPage: number | null;
  /** The call that reads the next page with the same filters, or null on the last page. */
  nextPageCall: string | null;
}

/**
 * Raw row from sprint_summary view.
 */
interface SprintSummaryRow {
  sprint_id: string;
  title: string;
  status: string | null;
  focus: string | null;
  start_date: string | null;
  end_date: string | null;
  total_missions: number;
  completed_missions: number;
  blocked_missions: number;
  active_missions: number;
  /** s86-m08: Deferred + Dropped — the work this sprint owned and parked. Excluded from
   *  total_missions so a sprint is not punished for parking honestly, surfaced here so it
   *  is not hidden either. On a store whose view could not be upgraded the reader projects
   *  `0 AS parked_missions` (see parkedColumn) and the answer carries a warning saying so —
   *  the column is always present in the ROW, the zero is the part to distrust. */
  parked_missions: number;
  decisions_count: number;
}

/**
 * Input parameters schema for rbook_sprint_list tool.
 */
export const rbookSprintListSchema = z.object({
  /** Filter by sprint status */
  status: z.string().optional().describe('Filter by sprint status (e.g., "Active", "Completed")'),

  /** Maximum number of sprints to return */
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Sprints per page (1-100, default: 15)'),

  /** s106-m03: page of results, 1-based */
  page: z.number().int().min(1).optional().describe('Page of results, 1-based (default 1)'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookSprintListParams = z.infer<typeof rbookSprintListSchema>;

/**
 * MCP Tool Definition for rbook_sprint_list.
 */
export const rbookSprintListToolDefinition = {
  name: 'rbook_sprint_list',
  description:
    'List sprints from the Reasonbook database with optional filtering. ' +
    'Returns sprint details including mission counts (total, completed, blocked, active). ' +
    'Sprints are ordered by start date (most recent first).',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Filter by sprint status (e.g., "Active", "Completed")',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 15,
        description: 'Sprints per page (1-100, default: 15)',
      },
      page: {
        type: 'integer',
        minimum: 1,
        description: 'Page of results, 1-based (default 1)',
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
 * Execute the rbook_sprint_list tool.
 *
 * @param params - Tool parameters (status, limit, projectRoot)
 * @returns RbookToolResult with sprint list or actionable error
 */
export async function rbookSprintList(
  params: RbookSprintListParams = {}
): Promise<RbookToolResult<RbookSprintListResult>> {
  // s106-m03: 20 previewed rows were 20,513 characters on OODS-Forge; 30,351 before the previews.
  const request = pageRequest(params.page, params.limit, SPRINT_LIST_PAGE_SIZE);
  const limit = request.pageSize;

  const warnings: string[] = [];
  const result = await withClient(
    (client) => {
      // s86-m08: bring a pre-migration store's sprint_summary up to the current counting
      // rule before reading it. No-op (zero writes) once current; never destroys a
      // same-named base table; a read-only store surfaces a warning instead of throwing.
      const viewMigration = ensureSprintSummaryView(client);
      warnings.push(...(viewMigration.warnings ?? []));

      // Build query dynamically based on filters
      const { sql, countSql, queryParams } = buildQuery(
        params.status,
        limit,
        request.offset,
        viewMigration.parkedAvailable
      );

      // Get total count first
      const countResult = client.getOne<{ count: number }>(countSql, queryParams.slice(0, -2));
      if (!countResult.success || !countResult.data) {
        return createError<RbookSprintListResult>(
          countResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get sprint count' }
        );
      }
      const totalCount = countResult.data.count;

      // Get filtered sprints
      const sprintsResult = client.getMany<SprintSummaryRow>(sql, queryParams);
      if (!sprintsResult.success || !sprintsResult.data) {
        return createError<RbookSprintListResult>(
          sprintsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get sprints' }
        );
      }

      // Transform to output format
      const sprints = sprintsResult.data.map(parseSprintRow);

      // s93-m11 (feedback #47): say how many Planned sprints an unfiltered page left out.
      let omittedPlanned: number | undefined;
      if (!params.status && sprints.length < totalCount) {
        const planned = client.getOne<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sprint_summary WHERE UPPER(status) = 'PLANNED'",
          []
        );
        const onPage = sprints.filter((sprint) => sprint.status?.toUpperCase() === 'PLANNED');
        const missing = (planned.success ? (planned.data?.count ?? 0) : 0) - onPage.length;
        if (missing > 0) omittedPlanned = missing;
      }

      const facts = pageFacts(request, sprints.length, totalCount);
      return createSuccess(
        {
          sprints,
          totalCount,
          ...(omittedPlanned !== undefined ? { omittedPlanned } : {}),
          filters: {
            status: params.status ?? null,
            limit,
          },
          page: facts.page,
          hasMore: facts.hasMore,
          nextPage: facts.nextPage,
          nextPageCall: nextPageCall(facts.nextPage, 'rbook_sprint', {
            action: 'list',
            status: params.status,
            limit: params.limit,
            projectRoot: params.projectRoot,
          }),
        },
        // s86-m08: a store whose view could not be upgraded still answers — and says that its
        // totals are the OLD rule. Swallowing this would leave the answer reporting parked work
        // inside total_missions under a column name that promises otherwise.
        viewMigration.warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

/**
 * Build SQL query based on filters.
 */
function buildQuery(
  status: string | undefined,
  limit: number,
  offset: number,
  parkedAvailable: boolean
): { sql: string; countSql: string; queryParams: unknown[] } {
  const conditions: string[] = [];
  const queryParams: unknown[] = [];

  if (status) {
    conditions.push('status = ?');
    queryParams.push(status);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count query (without limit)
  const countSql = `SELECT COUNT(*) as count FROM sprint_summary ${whereClause}`;

  // Main query with ordering and limit
  // Order by start_date descending (most recent first), nulls last
  const sql = `
    SELECT
      sprint_id, title, status, focus, start_date, end_date,
      total_missions, completed_missions, blocked_missions,
      active_missions, ${parkedColumn(parkedAvailable)}, decisions_count
    FROM sprint_summary
    ${whereClause}
    ORDER BY
      CASE WHEN start_date IS NULL THEN 1 ELSE 0 END,
      julianday(start_date) DESC,
      ${sprintIdOrderSql('sprint_id', 'DESC')}
    LIMIT ? OFFSET ?
  `;

  queryParams.push(limit, offset);

  return { sql, countSql, queryParams };
}

/**
 * Parse a sprint summary row into a SprintListItem.
 */
function parseSprintRow(row: SprintSummaryRow): SprintListItem {
  const focus = row.focus === null ? null : previewText(row.focus);
  return {
    id: row.sprint_id,
    title: row.title,
    focus: focus?.preview ?? null,
    focusTruncated: focus?.truncated ?? false,
    focusFullLength: focus?.fullLength ?? 0,
    status: row.status,
    startDate: row.start_date,
    endDate: row.end_date,
    totalMissions: row.total_missions ?? 0,
    parkedMissions: row.parked_missions ?? 0,
    completedMissions: row.completed_missions ?? 0,
    blockedMissions: row.blocked_missions ?? 0,
    activeMissions: row.active_missions ?? 0,
    decisionsCount: row.decisions_count ?? 0,
  };
}

/**
 * Format sprint list result for LLM readability.
 *
 * @param result - Sprint list result
 * @returns Human-readable summary
 */
export function formatSprintListForLLM(result: RbookToolResult<RbookSprintListResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to list sprints', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  // Header with filter info
  const filterParts: string[] = [];
  if (data.filters.status) filterParts.push(`status=${data.filters.status}`);

  const filterStr = filterParts.length > 0 ? ` (${filterParts.join(', ')})` : '';
  const shown = shownLine(
    { page: data.page, pageSize: data.filters.limit, totalCount: data.totalCount },
    data.sprints.length,
    'sprints'
  );
  lines.push(`**Sprints${filterStr}**: ${shown[0].toLowerCase()}${shown.slice(1)}`);
  lines.push('');

  if (data.sprints.length === 0) {
    if (data.page === 1) lines.push('No sprints found matching the filters.');
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  if (data.omittedPlanned) {
    lines.push(
      `${data.omittedPlanned} Planned sprint(s) are not on this page; ` +
        'rbook_sprint(action="list", status="Planned") lists them.'
    );
    lines.push('');
  }

  // List sprints with statistics
  for (const s of data.sprints) {
    const statusIcon = getStatusIcon(s.status);
    const progress = s.totalMissions > 0 ? `${s.completedMissions}/${s.totalMissions}` : '0';
    // s86-m08: parked work is stated, not folded into the denominator and not hidden.
    const parked = s.parkedMissions > 0 ? ` (+${s.parkedMissions} parked)` : '';

    lines.push(`${statusIcon} **${s.id}**: ${s.title}`);
    lines.push(`   Progress: ${progress} missions${parked}`);

    if (s.activeMissions > 0) {
      lines.push(`   Active: ${s.activeMissions} | Blocked: ${s.blockedMissions}`);
    }

    if (s.focus) {
      lines.push(`   Focus: ${truncate(s.focus, 60)}`);
    }

    if (s.startDate) {
      const dateRange = s.endDate ? `${s.startDate} → ${s.endDate}` : `Started: ${s.startDate}`;
      lines.push(`   Dates: ${dateRange}`);
    }

    lines.push('');
  }

  // s106-m03: a cut focus names the call that reads it whole.
  const cut = data.sprints.find((s) => s.focusTruncated);
  if (cut)
    lines.push(
      `Focus is a preview of at most ${PREVIEW_MAX_CHARS} characters; read a sprint in full with ${callText('rbook_sprint', { action: 'show', sprintId: cut.id })}.`
    );
  if (data.nextPageCall) lines.push(`Next page: ${data.nextPageCall}.`);

  appendWarnings(lines, result);

  return lines.join('\n').trim();
}

/**
 * Get a status icon for display.
 */
function getStatusIcon(status: string | null): string {
  switch (status?.toLowerCase()) {
    case 'active':
    case 'current':
      return '◉';
    case 'completed':
      return '✓';
    case 'planned':
    case 'queued':
      return '○';
    default:
      return '•';
  }
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
