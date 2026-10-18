/**
 * rbook_mission_show Tool
 *
 * MCP tool for retrieving full mission details by ID from the Reasonbook database.
 * Returns complete mission specification including objective, context,
 * success criteria, deliverables, and reference docs.
 *
 * @module tools/rbook/rbook-mission-show
 */

import {
  prepareSpinOutRead,
  spinOutDetails,
  spinOutPointerLines,
  type SpinOutDetails,
} from './spin-out-read';
import { normalizeMissionStatus } from './terminal-status';
import { z } from 'zod';
import { withClient } from './client';
import type { RbookToolResult, Mission, MissionStatus, Sprint } from './types';
import { createError, createSuccess, RbookErrors } from './errors';
import { getProjectId, tableHasColumn } from './genesis-columns';
import { authorNamesSince, authorReading } from './author-name';
import { frameInlineIfForeign, frameTextIfForeign } from '../../intelligence/provenance-frame';
import { appendWarnings } from './format-warnings';

/**
 * Full mission details with parsed JSON fields.
 */
export interface MissionShowResult extends SpinOutDetails {
  /** Mission ID (e.g., "s12-m06") */
  id: string;

  /** Mission name/title */
  name: string;

  /** Current status */
  status: MissionStatus;

  /** Mission objective - what this mission aims to achieve */
  objective: string | null;

  /** Context explaining why this mission matters */
  context: string | null;

  /** Success criteria (parsed from JSON) */
  successCriteria: string[] | null;

  /** Deliverables (parsed from JSON) */
  deliverables: string[] | null;

  /** Reference docs (parsed from JSON) */
  referenceDocs: string[] | null;

  /** Domain-specific fields (parsed from JSON) */
  domainFields: Record<string, unknown> | null;

  /** Notes about the mission */
  notes: string | null;

  /** Completion timestamp */
  completedAt: string | null;

  /** When mission was created */
  createdAt: string | null;

  /** When mission first moved to In Progress */
  startedAt: string | null;

  /** Last state change timestamp */
  updatedAt: string | null;

  /** s96-m02 (ADR s96 §10): who created it, or the reading for a NULL author. */
  author: string;

  /** Additional metadata (parsed from JSON) */
  metadata: Record<string, unknown> | null;

  /** Sprint information (if mission belongs to a sprint) */
  sprint: SprintInfo | null;

  /** s84-m03: the mission's own project_id (guarded read). Foreign when it differs from
   *  localProjectId — name/objective/context/success_criteria/deliverables framed untrusted. */
  projectId?: string | null;

  /** s84-m03: the querying store's own project_id. */
  localProjectId?: string | null;
}

/**
 * Minimal sprint info for context.
 */
export interface SprintInfo {
  id: string;
  title: string;
  focus: string | null;
  status: string | null;

  /** s84-m03: the sprint's own project_id (guarded read). A foreign sprint's title/focus
   *  is framed untrusted independently of the mission (a mission can link a foreign sprint). */
  projectId?: string | null;
}

/**
 * Input parameters schema for rbook_mission_show tool.
 */
export const rbookMissionShowSchema = z.object({
  /** The mission ID to retrieve */
  missionId: z.string().min(1).describe('The mission ID to retrieve (e.g., "s12-m06")'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookMissionShowParams = z.infer<typeof rbookMissionShowSchema>;

/**
 * MCP Tool Definition for rbook_mission_show.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const rbookMissionShowToolDefinition = {
  name: 'rbook_mission_show',
  description:
    'Get full details of a specific mission by ID. ' +
    'Returns complete mission specification including objective, context, ' +
    'success criteria, deliverables, reference docs, and sprint information. ' +
    'Use this when you need the complete mission spec to execute work.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to retrieve (e.g., "s12-m06")',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['missionId'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_mission_show tool.
 *
 * Retrieves full mission details from the Reasonbook database by mission ID.
 * Includes sprint context if the mission belongs to a sprint.
 *
 * @param params - Tool parameters (missionId, projectRoot)
 * @returns RbookToolResult with full mission details or actionable error
 */
export async function rbookMissionShow(
  params: RbookMissionShowParams
): Promise<RbookToolResult<MissionShowResult>> {
  // Validate required parameter
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(RbookErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();

  return withClient(
    (client) => {
      // Query mission by ID (with soft column detection for timestamps)
      const missionColumns = getMissionColumns(client);
      const createdAtExpr = missionColumns.has('created_at') ? 'created_at' : 'NULL AS created_at';
      const startedAtExpr = missionColumns.has('started_at') ? 'started_at' : 'NULL AS started_at';
      const updatedAtExpr = missionColumns.has('updated_at') ? 'updated_at' : 'NULL AS updated_at';
      // s84-m03: guarded project_id read (NULL AS on an ancient store lacking the column).
      const projectIdExpr = missionColumns.has('project_id') ? 'project_id' : 'NULL AS project_id';
      const authorExpr = missionColumns.has('author_name') ? 'author_name' : 'NULL AS author_name';
      const occurredExpr = missionColumns.has('occurred_at')
        ? 'occurred_at'
        : 'NULL AS occurred_at';

      const missionResult = client.getOne<Mission>(
        `
        SELECT
          id, sprint_id, name, status, completed_at, notes,
          objective, context, success_criteria, deliverables,
          reference_docs, domain_fields, metadata,
          ${createdAtExpr}, ${startedAtExpr}, ${updatedAtExpr}, ${projectIdExpr},
          ${authorExpr}, ${occurredExpr}
        FROM missions
        WHERE id = ?
      `,
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionShowResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionShowResult>(RbookErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;

      // Get sprint info if mission has a sprint_id
      let sprintInfo: SprintInfo | null = null;
      if (mission.sprint_id) {
        // s84-m03: guarded project_id read on sprints too (independent foreign check).
        const sprintProjectIdExpr = tableHasColumn(client, 'sprints', 'project_id')
          ? 'project_id'
          : 'NULL AS project_id';
        const sprintResult = client.getOne<Sprint>(
          `
          SELECT id, title, focus, status, ${sprintProjectIdExpr}
          FROM sprints
          WHERE id = ?
        `,
          [mission.sprint_id]
        );

        if (sprintResult.success && sprintResult.data) {
          sprintInfo = {
            id: sprintResult.data.id,
            title: sprintResult.data.title,
            focus: sprintResult.data.focus,
            status: sprintResult.data.status,
            projectId:
              (sprintResult.data as unknown as Record<string, string | null>).project_id ?? null,
          };
        }
      }

      // Parse and transform mission
      const result: MissionShowResult = {
        ...spinOutDetails(prepareSpinOutRead(client), 'mission', mission.id),
        id: mission.id,
        name: mission.name,
        status: normalizeMissionStatus(mission.status),
        objective: mission.objective,
        context: mission.context,
        successCriteria: parseJsonArray(mission.success_criteria),
        deliverables: parseJsonArray(mission.deliverables),
        referenceDocs: parseJsonArray(mission.reference_docs),
        domainFields: parseJsonObject(mission.domain_fields),
        notes: mission.notes,
        completedAt: mission.completed_at,
        createdAt: (mission as unknown as Record<string, string | null>).created_at ?? null,
        startedAt: (mission as unknown as Record<string, string | null>).started_at ?? null,
        updatedAt: (mission as unknown as Record<string, string | null>).updated_at ?? null,
        author: authorReading(
          (mission as unknown as { author_name?: string | null }).author_name,
          (mission as unknown as { occurred_at?: number | null }).occurred_at,
          authorNamesSince(client)
        ),
        metadata: parseJsonObject(mission.metadata),
        sprint: sprintInfo,
        projectId: (mission as unknown as Record<string, string | null>).project_id ?? null,
        localProjectId: getProjectId(client),
      };

      return createSuccess(result);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Get the set of column names for the missions table.
 */
function getMissionColumns(client: Parameters<Parameters<typeof withClient>[0]>[0]): Set<string> {
  const result = client.getMany<{ name: string }>("PRAGMA table_info('missions')", []);
  if (!result.success || !result.data) {
    return new Set();
  }
  return new Set(result.data.map((row) => row.name));
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
 * Safely parse a JSON object string.
 */
function parseJsonObject(jsonString: string | null): Record<string, unknown> | null {
  if (!jsonString) return null;
  try {
    const parsed = JSON.parse(jsonString);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Format mission show result for LLM readability.
 *
 * @param result - Mission show result
 * @returns Human-readable formatted mission details
 */
export function formatMissionShowForLLM(result: RbookToolResult<MissionShowResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to retrieve mission',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    return lines.join('\n');
  }

  const m = result.data;
  const lines: string[] = [];

  // s84-m03: a foreign (pull-merged) mission is untrusted DATA. Short fields (name, sprint
  // title/focus) frame inline; long prose (objective/context/success_criteria/deliverables)
  // frames as a block. A LOCAL/NULL-project mission renders byte-identical to 2.3.0. The
  // sprint is checked against its OWN project_id — a mission can link a foreign sprint.
  const local = m.localProjectId;

  // Header with ID and status
  const statusIcon = getStatusIcon(m.status);
  lines.push(`# ${m.id}: ${frameInlineIfForeign(m.name, m.projectId, local)}`);
  lines.push(`**Status**: ${statusIcon} ${m.status}`);
  lines.push(`**Author**: ${m.author}`);

  // Sprint context
  if (m.sprint) {
    const sprintProjectId = m.sprint.projectId;
    lines.push(
      `**Sprint**: ${m.sprint.id} - ${frameInlineIfForeign(m.sprint.title, sprintProjectId, local)}`
    );
    if (m.sprint.focus) {
      lines.push(`**Focus**: ${frameInlineIfForeign(m.sprint.focus, sprintProjectId, local)}`);
    }
  }

  lines.push('');

  // Objective
  if (m.objective) {
    lines.push('## Objective');
    lines.push(frameTextIfForeign(m.objective, m.projectId, local));
    lines.push('');
  }

  // Context
  if (m.context) {
    lines.push('## Context');
    lines.push(frameTextIfForeign(m.context, m.projectId, local));
    lines.push('');
  }

  // Success Criteria
  if (m.successCriteria && m.successCriteria.length > 0) {
    lines.push('## Success Criteria');
    for (const criterion of m.successCriteria) {
      lines.push(`- [ ] ${frameTextIfForeign(criterion, m.projectId, local)}`);
    }
    lines.push('');
  }

  // Deliverables
  if (m.deliverables && m.deliverables.length > 0) {
    lines.push('## Deliverables');
    for (const deliverable of m.deliverables) {
      lines.push(`- ${frameTextIfForeign(deliverable, m.projectId, local)}`);
    }
    lines.push('');
  }

  // Reference Docs
  if (m.referenceDocs && m.referenceDocs.length > 0) {
    lines.push('## Reference Docs');
    for (const doc of m.referenceDocs) {
      lines.push(`- ${doc}`);
    }
    lines.push('');
  }

  // Notes
  if (m.notes) {
    lines.push('## Notes');
    lines.push(m.notes);
    lines.push('');
  }

  // Completion info
  if (m.completedAt) {
    lines.push(`**Completed**: ${m.completedAt}`);
  }

  lines.push(...spinOutPointerLines(m));
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
