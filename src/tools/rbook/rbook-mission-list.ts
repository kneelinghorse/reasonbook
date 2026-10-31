/**
 * rbook_mission_list Tool
 *
 * MCP tool for listing missions from the Reasonbook database.
 * Supports filtering by status, sprint, and pagination.
 * Returns structured mission objects with actionable error messages.
 *
 * @module tools/rbook/rbook-mission-list
 */

import { prepareSpinOutRead } from './spin-out-read';
import { normalizeMissionStatus, missionCompletedSql } from './terminal-status';
import { z } from 'zod';
import { withClient } from './client';
import type { RbookToolResult, Mission, MissionStatus } from './types';
import { createError, createSuccess, RbookErrors, VALID_MISSION_STATUSES } from './errors';
import { getProjectId, tableHasColumn } from './genesis-columns';
import { frameInlineIfForeign } from '../../intelligence/provenance-frame';
import { appendWarnings } from './format-warnings';
import { sprintIdOrderSql } from './sprint-ordering';
import { callText, nextPageCall, pageFacts, pageRequest, shownLine } from './answer-page';
import { PREVIEW_MAX_CHARS, previewText } from './text-preview';

/**
 * s106-m03: 20 rows were 56,988 characters on a registered store, past the 20,000 cap; with
 * previews, 8 rows of its older missions still reached 21,750 on later pages.
 */
export const MISSION_LIST_PAGE_SIZE = 6;

/** s106-m03: success criteria and deliverables a listed mission shows; show returns every one. */
export const MISSION_LIST_ITEMS = 3;

/**
 * Mission with parsed JSON fields for return to caller.
 */
export interface MissionListItem {
  /** Mission ID (e.g., "s12-m05") */
  id: string;

  /** Sprint ID (e.g., "sprint-12") */
  sprintId: string | null;

  /** Mission name/title */
  name: string;

  /** Current status */
  status: MissionStatus;

  /** Completion timestamp */
  completedAt: string | null;

  /** Notes about the mission: a preview of at most 300 characters (s106-m03); show has them in full */
  notes: string | null;

  /** Mission objective: a preview of at most 300 characters (s106-m03); show has it in full */
  objective: string | null;

  /** Whether the objective preview was cut, and the full objective's length (0 when null) */
  objectiveTruncated: boolean;
  objectiveFullLength: number;

  /** Whether the notes preview was cut, and the full notes' length (0 when null) */
  notesTruncated: boolean;
  notesFullLength: number;

  /** Success criteria (parsed from JSON): s106-m03, the first three, each a preview */
  successCriteria: string[] | null;

  /** Every success criterion; rbook_mission show returns them all */
  successCriteriaCount: number;

  /** Deliverables (parsed from JSON): the first three, each a preview */
  deliverables: string[] | null;

  /** Every deliverable; rbook_mission show returns them all */
  deliverablesCount: number;

  /** s84-m03: source project_id (guarded read). A row whose projectId differs from the
   *  querying store's own is foreign (pull-merged) — its name/objective is framed untrusted. */
  projectId?: string | null;
}

/**
 * Result type for rbook_mission_list.
 */
export interface RbookMissionListResult {
  /** List of missions matching the filters */
  missions: MissionListItem[];

  /** Total count matching filters (before limit applied) */
  totalCount: number;

  /** Filters applied to the query */
  filters: {
    status: MissionStatus | null;
    sprintId: string | null;
    limit: number;
  };

  /** s106-m03: this page's number, 1-based; each page holds filters.limit missions. */
  page: number;
  hasMore: boolean;
  nextPage: number | null;
  /** The call that reads the next page with the same filters, or null on the last page. */
  nextPageCall: string | null;

  /** s84-m03: the querying store's own project_id. Rows whose projectId differs are
   *  foreign (pull-merged) and framed as untrusted in the render. */
  localProjectId?: string | null;
}

/**
 * Input parameters schema for rbook_mission_list tool.
 */
export const rbookMissionListSchema = z.object({
  /** Filter by mission status */
  status: z
    .enum(['Queued', 'Current', 'In Progress', 'Completed', 'Blocked', 'Dropped', 'Deferred'])
    .optional()
    .describe('Filter by mission status'),

  /** Filter by sprint ID */
  sprintId: z.string().optional().describe('Filter by sprint ID (e.g., "sprint-12")'),

  /** Maximum number of missions to return */
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Missions per page (1-100, default: 6)'),

  /** s106-m03: page of results, 1-based */
  page: z.number().int().min(1).optional().describe('Page of results, 1-based (default 1)'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookMissionListParams = z.infer<typeof rbookMissionListSchema>;

/**
 * MCP Tool Definition for rbook_mission_list.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const rbookMissionListToolDefinition = {
  name: 'rbook_mission_list',
  description:
    'List missions from the Reasonbook database with optional filtering. ' +
    'Supports filtering by status (Queued, Current, In Progress, Completed, Blocked, Dropped, Deferred), ' +
    'sprint ID, and pagination. Returns structured mission objects including ID, name, ' +
    'status, objective, success criteria, and deliverables.',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['Queued', 'Current', 'In Progress', 'Completed', 'Blocked', 'Dropped', 'Deferred'],
        description: 'Filter by mission status',
      },
      sprintId: {
        type: 'string',
        description: 'Filter by sprint ID (e.g., "sprint-12")',
      },
      limit: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 6,
        description: 'Missions per page (1-100, default: 6)',
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
 * Execute the rbook_mission_list tool.
 *
 * Retrieves missions from the Reasonbook database with optional filtering
 * by status and sprint ID. Returns structured mission objects with
 * parsed JSON fields.
 *
 * @param params - Tool parameters (status, sprintId, limit, projectRoot)
 * @returns RbookToolResult with mission list or actionable error
 */
export async function rbookMissionList(
  params: RbookMissionListParams = {}
): Promise<RbookToolResult<RbookMissionListResult>> {
  // Validate status if provided
  if (params.status && !VALID_MISSION_STATUSES.includes(params.status)) {
    return createError(
      RbookErrors.invalidParameter('status', params.status, VALID_MISSION_STATUSES as string[])
    );
  }

  const request = pageRequest(params.page, params.limit, MISSION_LIST_PAGE_SIZE);
  const limit = request.pageSize;

  return withClient(
    (client) => {
      // s84-m03: guard the project_id read so an ancient store (no column) degrades to
      // a NULL row projectId (→ rendered bare), never a "no such column" throw.
      const hasProjectId = tableHasColumn(client, 'missions', 'project_id');
      // Build query dynamically based on filters
      const { sql, countSql, queryParams } = buildQuery(
        params.status,
        params.sprintId,
        limit,
        request.offset,
        hasProjectId,
        prepareSpinOutRead(client).predicate('mission', 'missions.id')
      );

      // Get total count first
      const countResult = client.getOne<{ count: number }>(countSql, queryParams.slice(0, -2));
      if (!countResult.success || !countResult.data) {
        return createError<RbookMissionListResult>(
          countResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get mission count' }
        );
      }
      const totalCount = countResult.data.count;

      // Get filtered missions
      const missionsResult = client.getMany<Mission>(sql, queryParams);
      if (!missionsResult.success || !missionsResult.data) {
        return createError<RbookMissionListResult>(
          missionsResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to get missions' }
        );
      }

      // Parse and transform missions
      const missions = missionsResult.data.map(parseMission);

      const facts = pageFacts(request, missions.length, totalCount);
      return createSuccess({
        missions,
        totalCount,
        filters: {
          status: params.status ?? null,
          sprintId: params.sprintId ?? null,
          limit,
        },
        page: facts.page,
        hasMore: facts.hasMore,
        nextPage: facts.nextPage,
        nextPageCall: nextPageCall(facts.nextPage, 'rbook_mission', {
          action: 'list',
          sprintId: params.sprintId,
          status: params.status,
          limit: params.limit,
          projectRoot: params.projectRoot,
        }),
        localProjectId: getProjectId(client),
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Build SQL query based on filters.
 */
function buildQuery(
  status: MissionStatus | undefined,
  sprintId: string | undefined,
  limit: number,
  offset: number,
  hasProjectId: boolean,
  visibility: { sql: string; params: string[] }
): { sql: string; countSql: string; queryParams: unknown[] } {
  const conditions: string[] = [visibility.sql];
  const queryParams: unknown[] = [...visibility.params];

  if (status) {
    if (status === 'Completed') conditions.push(missionCompletedSql('status'));
    else {
      conditions.push('status = ?');
      queryParams.push(status);
    }
  }

  if (sprintId) {
    conditions.push('sprint_id = ?');
    queryParams.push(sprintId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count query (without limit)
  const countSql = `SELECT COUNT(*) as count FROM missions ${whereClause}`;

  // s84-m03: guarded project_id read (NULL AS on ancient stores lacking the column).
  const projectIdExpr = hasProjectId ? 'project_id' : 'NULL AS project_id';

  // Main query with ordering and limit
  // Order by canonical sprint number (legacy IDs and nulls last), then by mission ID.
  const sql = `
    SELECT
      id, sprint_id, name, status, completed_at, notes,
      objective, context, success_criteria, deliverables,
      reference_docs, domain_fields, metadata, ${projectIdExpr}
    FROM missions
    ${whereClause}
    ORDER BY
      ${sprintIdOrderSql('sprint_id', 'DESC')},
      id ASC
    LIMIT ? OFFSET ?
  `;

  queryParams.push(limit, offset);

  return { sql, countSql, queryParams };
}

/**
 * Parse a mission record into a MissionListItem.
 * Handles JSON field parsing with graceful fallbacks.
 */
function parseMission(mission: Mission): MissionListItem {
  const objective = mission.objective === null ? null : previewText(mission.objective);
  const notes = mission.notes === null ? null : previewText(mission.notes);
  return {
    id: mission.id,
    sprintId: mission.sprint_id,
    name: mission.name,
    status: normalizeMissionStatus(mission.status),
    completedAt: mission.completed_at,
    notes: notes?.preview ?? null,
    objective: objective?.preview ?? null,
    objectiveTruncated: objective?.truncated ?? false,
    objectiveFullLength: objective?.fullLength ?? 0,
    notesTruncated: notes?.truncated ?? false,
    notesFullLength: notes?.fullLength ?? 0,
    ...listedItems('successCriteria', parseJsonArray(mission.success_criteria)),
    ...listedItems('deliverables', parseJsonArray(mission.deliverables)),
    projectId: (mission as unknown as Record<string, string | null>).project_id ?? null,
  };
}

/**
 * s106-m03: the first MISSION_LIST_ITEMS of a mission's list, each a preview, beside its count.
 * A registered store's eight newest missions held 7 to 16 criteria each: 29,033 characters.
 */
function listedItems<K extends 'successCriteria' | 'deliverables'>(
  key: K,
  items: string[] | null
): Record<K, string[] | null> & Record<`${K}Count`, number> {
  return {
    [key]: items
      ? items
          .slice(0, MISSION_LIST_ITEMS)
          .map((item) => (typeof item === 'string' ? previewText(item).preview : item))
      : null,
    [`${key}Count`]: items?.length ?? 0,
  } as Record<K, string[] | null> & Record<`${K}Count`, number>;
}

/**
 * Safely parse a JSON array string.
 */
function parseJsonArray(jsonString: string | null): string[] | null {
  if (!jsonString) return null;
  try {
    const parsed = JSON.parse(jsonString);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format mission list result for LLM readability.
 *
 * @param result - Mission list result
 * @returns Human-readable summary
 */
export function formatMissionListForLLM(result: RbookToolResult<RbookMissionListResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to list missions', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    if (error?.validValues) {
      lines.push('');
      lines.push(`Valid values: ${error.validValues.join(', ')}`);
    }

    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  // Header with filter info
  const filterParts: string[] = [];
  if (data.filters.status) filterParts.push(`status=${data.filters.status}`);
  if (data.filters.sprintId) filterParts.push(`sprint=${data.filters.sprintId}`);

  const filterStr = filterParts.length > 0 ? ` (${filterParts.join(', ')})` : '';
  const shown = shownLine(
    { page: data.page, pageSize: data.filters.limit, totalCount: data.totalCount },
    data.missions.length,
    'missions'
  );
  lines.push(`**Missions${filterStr}**: ${shown[0].toLowerCase()}${shown.slice(1)}`);
  lines.push('');

  if (data.missions.length === 0) {
    if (data.page === 1) lines.push('No missions found matching the filters.');
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  // Group by sprint for readability
  const bySprintMap = new Map<string, MissionListItem[]>();
  for (const mission of data.missions) {
    const sprintKey = mission.sprintId ?? '(no sprint)';
    if (!bySprintMap.has(sprintKey)) {
      bySprintMap.set(sprintKey, []);
    }
    bySprintMap.get(sprintKey)!.push(mission);
  }

  for (const [sprintKey, missions] of bySprintMap) {
    lines.push(`**${sprintKey}**`);
    for (const m of missions) {
      const statusIcon = getStatusIcon(m.status);
      // s84-m03: a foreign (pull-merged) mission's name/objective is untrusted DATA —
      // frame it inline; a local/NULL-project row renders byte-identical to 2.3.0.
      const name = frameInlineIfForeign(m.name, m.projectId, data.localProjectId);
      lines.push(`  ${statusIcon} ${m.id}: ${name} [${m.status}]`);
      if (m.objective) {
        const objective = frameInlineIfForeign(
          truncate(m.objective, 60),
          m.projectId,
          data.localProjectId
        );
        lines.push(`     └─ ${objective}`);
      }
    }
    lines.push('');
  }

  // s106-m03: objectives, notes and the first criteria are previews; a cut one names the full read.
  const cut = data.missions.find(
    (m) =>
      m.objectiveTruncated ||
      m.notesTruncated ||
      m.successCriteriaCount > (m.successCriteria?.length ?? 0) ||
      m.deliverablesCount > (m.deliverables?.length ?? 0)
  );
  if (cut)
    lines.push(
      `Objectives and notes are previews of at most ${PREVIEW_MAX_CHARS} characters, with the first ${MISSION_LIST_ITEMS} success criteria and deliverables; read a mission in full with ${callText('rbook_mission', { action: 'show', missionId: cut.id })}.`
    );
  if (data.nextPageCall) lines.push(`Next page: ${data.nextPageCall}.`);

  appendWarnings(lines, result);

  return lines.join('\n').trim();
}

/**
 * Get a status icon for display.
 */
function getStatusIcon(status: MissionStatus): string {
  switch (status) {
    case 'Queued':
      return '○';
    case 'Current':
      return '◉';
    case 'In Progress':
      return '◐';
    case 'Completed':
      return '✓';
    case 'Blocked':
      return '⊘';
    default:
      return '?';
  }
}

/**
 * Truncate a string to a maximum length.
 */
function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
