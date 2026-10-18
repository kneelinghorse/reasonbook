/**
 * rbook_sprint_add Tool
 *
 * MCP tool for creating new sprints in the Reasonbook database.
 * Validates sprint ID uniqueness and required fields.
 *
 * @module tools/rbook/rbook-sprint-add
 */

import { z } from 'zod';
import { withClientValidated, type RbookDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RbookErrors } from './errors';
import { isOpenStatus } from './terminal-status';
import { buildDemotionWarning, writeSingleCurrentSprint } from './sprint-current-invariant';
import { appendWarnings, attachWarnings } from './format-warnings';
import { syncSprintTracking } from './sprint-tracking';
import { recordedWrite } from './record-changes';

/**
 * Result type for rbook_sprint_add.
 */
export interface SprintAddResult {
  /** Created sprint ID */
  id: string;

  /** Sprint title */
  title: string;

  /** Confirmation message */
  message: string;
}

/**
 * Input parameters schema for rbook_sprint_add tool.
 */
export const rbookSprintAddSchema = z.object({
  /** Unique sprint identifier */
  sprintId: z.string().min(1).describe('Unique sprint identifier (e.g., "sprint-15")'),

  /** Sprint title */
  title: z.string().min(1).describe('Sprint title (required)'),

  /** Strategic focus of the sprint */
  focus: z.string().optional().describe('Strategic focus or theme of the sprint'),

  /** Sprint status */
  status: z
    .string()
    .optional()
    .describe('Sprint status (default: "Active"). Common values: Active, Completed, Planned'),

  /** Start date in ISO format */
  startDate: z.string().optional().describe('Start date in ISO format (e.g., "2025-01-01")'),

  /** End date in ISO format */
  endDate: z.string().optional().describe('End date in ISO format (e.g., "2025-01-15")'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookSprintAddParams = z.infer<typeof rbookSprintAddSchema>;

/**
 * MCP Tool Definition for rbook_sprint_add.
 */
export const rbookSprintAddToolDefinition = {
  name: 'rbook_sprint_add',
  description:
    'Create a new sprint in the Reasonbook database. ' +
    'Requires a unique sprint ID and title. ' +
    'Optionally set focus, status, and date range.',
  inputSchema: {
    type: 'object',
    properties: {
      sprintId: {
        type: 'string',
        description: 'Unique sprint identifier (e.g., "sprint-15")',
      },
      title: {
        type: 'string',
        description: 'Sprint title (required)',
      },
      focus: {
        type: 'string',
        description: 'Strategic focus or theme of the sprint',
      },
      status: {
        type: 'string',
        description: 'Sprint status (default: "Active"). Common values: Active, Completed, Planned',
      },
      startDate: {
        type: 'string',
        description: 'Start date in ISO format (e.g., "2025-01-01")',
      },
      endDate: {
        type: 'string',
        description: 'End date in ISO format (e.g., "2025-01-15")',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['sprintId', 'title'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_sprint_add tool.
 *
 * @param params - Tool parameters
 * @returns RbookToolResult with created sprint or actionable error
 */
export async function rbookSprintAdd(
  params: RbookSprintAddParams
): Promise<RbookToolResult<SprintAddResult>> {
  const { sprintId, title, focus, status, startDate, endDate } = params;

  // Validate required parameters
  if (!sprintId || sprintId.trim() === '') {
    return createError(RbookErrors.missingParameter('sprintId'));
  }

  if (!title || title.trim() === '') {
    return createError(RbookErrors.missingParameter('title'));
  }

  return withClientValidated(
    (client) => {
      // Check if sprint ID already exists
      const existingResult = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
        sprintId,
      ]);

      if (!existingResult.success) {
        return createError<SprintAddResult>(
          existingResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to check sprint' }
        );
      }

      if (existingResult.data) {
        return createError<SprintAddResult>(RbookErrors.sprintIdExists(sprintId));
      }

      const effectiveStatus = status?.trim() || 'Active';
      const projectId = getProjectId(client);
      const insert = (): RbookToolResult<void> =>
        insertSprintRow(
          client,
          {
            sprintId,
            title: title.trim(),
            focus: focus?.trim() || null,
            status: effectiveStatus,
            startDate: startDate?.trim() || null,
            endDate: endDate?.trim() || null,
          },
          projectId
        );

      const success = (warnings?: string[]): RbookToolResult<SprintAddResult> =>
        createSuccess(
          {
            id: sprintId,
            title: title.trim(),
            message: `Sprint '${sprintId}' created successfully`,
          },
          warnings
        );

      // Single-current-sprint invariant (s77-m01): adding an OPEN sprint demotes
      // every other open sprint to 'Planned' atomically. A non-open add (Planned,
      // Completed, …) takes the plain insert path — it opens no work, so demotes
      // nothing.
      if (!isOpenStatus(effectiveStatus)) {
        const inserted = insert();
        if (!inserted.success) {
          return createError<SprintAddResult>(inserted.error!);
        }
        return success();
      }

      const invariant = writeSingleCurrentSprint(client, sprintId, insert);
      if (!invariant.success) {
        return attachWarnings(
          createError<SprintAddResult>(invariant.error!),
          invariant.warnings ?? []
        );
      }
      const warning = buildDemotionWarning(invariant.data!.demoted);
      const warnings = [...(invariant.warnings ?? [])];
      if (warning) warnings.push(warning);
      // s91-m07: an open sprint was added, so master_context.sprint_tracking now points at it.
      syncSprintTracking(client, warnings);
      return success(warnings.length > 0 ? warnings : undefined);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Fields the sprint-add INSERT stamps (pre-trimmed / defaulted by the caller).
 */
interface SprintInsertFields {
  sprintId: string;
  title: string;
  focus: string | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
}

/**
 * Stamp the genesis columns and INSERT one sprint row. Shared by the plain-add
 * and the single-current-sprint transactional paths so both stamp identically.
 */
function insertSprintRow(
  client: RbookDatabaseClient,
  fields: SprintInsertFields,
  projectId: string
): RbookToolResult<void> {
  // s96-m01: on a shared store the create takes its sequence under the write lock (ADR s96 §3).
  return recordedWrite(client, () => insertSprint(client, fields, projectId));
}

function insertSprint(
  client: RbookDatabaseClient,
  fields: SprintInsertFields,
  projectId: string
): RbookToolResult<void> {
  const g = genesisColumns(client, 'sprints', projectId);
  const insertResult = client.execute(
    `INSERT INTO sprints (id, title, focus, status, start_date, end_date, ${g.columns.join(', ')})
        VALUES (?, ?, ?, ?, ?, ?, ${g.placeholders})`,
    [
      fields.sprintId,
      fields.title,
      fields.focus,
      fields.status,
      fields.startDate,
      fields.endDate,
      ...g.values,
    ]
  );

  if (!insertResult.success) {
    return createError<void>(
      insertResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to create sprint' }
    );
  }

  if (insertResult.data?.changes === 0) {
    return createError<void>({
      code: 'DB_QUERY_FAILED',
      message: 'Sprint was not created (no rows affected)',
      suggestion: 'Check database permissions and try again',
    });
  }

  return createSuccess<void>(undefined);
}

/**
 * Format sprint add result for LLM readability.
 *
 * @param result - Sprint add result
 * @returns Human-readable summary
 */
export function formatSprintAddForLLM(result: RbookToolResult<SprintAddResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to create sprint', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    '✓ Sprint created successfully',
    '',
    `   ID: ${data.id}`,
    `   Title: ${data.title}`,
  ];

  // s77-m01: surface the single-current-sprint demotion warning so the running
  // server TELLS the operator which sprints were auto-demoted (mirrors
  // formatSprintUpdateForLLM). index.ts renders only this text — warnings not
  // folded in here would be invisible to the operator.
  appendWarnings(lines, result);

  return lines.join('\n');
}
