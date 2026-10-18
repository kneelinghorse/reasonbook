// ABOUTME: Creates missions with explicit, inferred or unscheduled sprint assignment.
// ABOUTME: Validates lifecycle choices and discloses failed writes through the standard tool result.
/**
 * rbook_mission_add Tool
 *
 * MCP tool for creating new missions in the Reasonbook database.
 * Supports explicitly unscheduled work and validates any named sprint before creation.
 *
 * @module tools/rbook/rbook-mission-add
 */

import { z } from 'zod';
import { SPRINT_OPEN_STATUSES, statusInSql } from './terminal-status';
import { withClientAsync } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import type { RbookToolResult, MissionStatus, Sprint } from './types';
import { createError, createSuccess, RbookErrors, VALID_MISSION_STATUSES } from './errors';
import {
  sanitizeContentField,
  sanitizeStringArray,
  type SanitizedField,
} from '../../intelligence/content-sanitizer';
import { ensureMissionTimestamps } from './schema-migrations';
import { recordEmbedding, missionEmbeddingInput } from '../../intelligence/embedding-pipeline';
import { appendWarnings, attachWarnings } from './format-warnings';
import { checkWrite } from './write-guard';
import { recordedWrite } from './record-changes';

/**
 * Result type for rbook_mission_add.
 */
export interface MissionAddResult {
  /** Created mission ID */
  id: string;

  /** Mission name */
  name: string;

  /** Sprint ID the mission belongs to */
  sprintId: string | null;

  /** Mission status */
  status: MissionStatus;

  /** Confirmation message */
  message: string;

  /**
   * The mission's identity. s93-m11 (#602, feedback #46): the optional members (objective,
   * context, successCriteria, deliverables, referenceDocs, domainFields, notes) stay declared but
   * are no longer echoed back (3-5 KB a call when seeding a sprint); `fields` names what was stored,
   * and rbook_mission(action="show") reads it.
   */
  mission: {
    id: string;
    name: string;
    sprintId: string | null;
    status: MissionStatus;
    objective?: string;
    context?: string;
    successCriteria?: string[];
    deliverables?: string[];
    referenceDocs?: string[];
    domainFields?: Record<string, unknown>;
    notes?: string;
  };

  /** s93-m11: the optional fields this add stored, by name, with list lengths. */
  fields: string[];
}

/**
 * Input parameters schema for rbook_mission_add tool.
 */
export const rbookMissionAddSchema = z.object({
  /** Unique mission identifier */
  missionId: z.string().min(1).describe("The mission ID (e.g., 's14-m05')"),

  /** Mission name/title */
  name: z.string().min(1).describe('Display name for the mission'),

  /** Sprint ID to associate with */
  sprintId: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe('Existing sprint; omitted infers the unique open sprint, null is unscheduled'),

  /** Mission status (default: Queued) */
  status: z
    .enum(['Queued', 'Current', 'In Progress', 'Completed', 'Blocked', 'Dropped', 'Deferred'])
    .optional()
    .describe("Mission status (default: 'Queued')"),

  /** Mission objective */
  objective: z.string().optional().describe('What this mission aims to accomplish'),

  /** Mission context - can be string or object */
  context: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional()
    .describe('Background context explaining why this mission matters'),

  /** Success criteria */
  successCriteria: z
    .array(z.string())
    .optional()
    .describe('Measurable criteria for mission completion'),

  /** Expected deliverables */
  deliverables: z.array(z.string()).optional().describe('Files or artifacts to be produced'),

  /** Reference documentation */
  referenceDocs: z
    .array(z.string())
    .optional()
    .describe('Documentation to reference during implementation'),

  /** Domain-specific fields */
  domainFields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Domain-specific custom fields'),

  /** Notes */
  notes: z.string().optional().describe('Additional notes about the mission'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookMissionAddParams = z.infer<typeof rbookMissionAddSchema>;

/**
 * MCP Tool Definition for rbook_mission_add.
 */
export const rbookMissionAddToolDefinition = {
  name: 'rbook_mission_add',
  description:
    'Create a new mission in the Reasonbook database. ' +
    'Omit sprintId to infer the unique open sprint, or pass null for unscheduled work; a named sprint must exist. ' +
    'Supports all mission spec fields including objective, context, success criteria, deliverables, and reference docs.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: "The mission ID (e.g., 's14-m05')",
      },
      name: {
        type: 'string',
        description: 'Display name for the mission',
      },
      sprintId: {
        type: ['string', 'null'],
        description:
          'Existing sprint ID; omitted infers the unique open sprint, null requests unscheduled work',
      },
      status: {
        type: 'string',
        enum: ['Queued', 'Current', 'In Progress', 'Completed', 'Blocked', 'Dropped', 'Deferred'],
        description: "Mission status (default: 'Queued')",
      },
      objective: {
        type: 'string',
        description: 'What this mission aims to accomplish',
      },
      context: {
        oneOf: [{ type: 'string' }, { type: 'object' }],
        description: 'Background context explaining why this mission matters',
      },
      successCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Measurable criteria for mission completion',
      },
      deliverables: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files or artifacts to be produced',
      },
      referenceDocs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Documentation to reference during implementation',
      },
      domainFields: {
        type: 'object',
        description: 'Domain-specific custom fields',
      },
      notes: {
        type: 'string',
        description: 'Additional notes about the mission',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['missionId', 'name'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_mission_add tool.
 *
 * @param params - Tool parameters
 * @returns RbookToolResult with created mission or actionable error
 */
export async function rbookMissionAdd(
  params: RbookMissionAddParams
): Promise<RbookToolResult<MissionAddResult>> {
  const sanitizedFields: SanitizedField[] = [];
  const sanitizeScalar = (
    field: 'name' | 'objective' | 'notes',
    value: string | undefined
  ): string | undefined => {
    if (typeof value !== 'string') return value;
    const r = sanitizeContentField(value);
    if (r.wasModified) sanitizedFields.push({ field, reason: r.reason ?? '' });
    return r.cleaned;
  };

  const name = sanitizeScalar('name', params.name) ?? params.name;
  const objective = sanitizeScalar('objective', params.objective);
  const notes = sanitizeScalar('notes', params.notes);
  const successCriteriaSan = sanitizeStringArray('successCriteria', params.successCriteria);
  sanitizedFields.push(...successCriteriaSan.sanitizedFields);
  const successCriteria = successCriteriaSan.cleaned;
  const deliverablesSan = sanitizeStringArray('deliverables', params.deliverables);
  sanitizedFields.push(...deliverablesSan.sanitizedFields);
  const deliverables = deliverablesSan.cleaned;
  const referenceDocsSan = sanitizeStringArray('referenceDocs', params.referenceDocs);
  sanitizedFields.push(...referenceDocsSan.sanitizedFields);
  const referenceDocs = referenceDocsSan.cleaned;
  let context = params.context;
  if (typeof context === 'string') {
    const r = sanitizeContentField(context);
    if (r.wasModified) sanitizedFields.push({ field: 'context', reason: r.reason ?? '' });
    context = r.cleaned;
  }
  const { missionId, sprintId, status = 'Queued', domainFields } = params;

  // Validate required parameters
  if (!missionId || missionId.trim() === '') {
    return createError(RbookErrors.missingParameter('missionId'));
  }

  if (!name || name.trim() === '') {
    return createError(RbookErrors.missingParameter('name'));
  }

  if (
    sprintId !== undefined &&
    sprintId !== null &&
    (typeof sprintId !== 'string' || sprintId.trim() === '')
  ) {
    return createError(
      RbookErrors.invalidParameter('sprintId', sprintId, ['a nonempty sprint ID, null, or omitted'])
    );
  }

  // Validate status if provided
  if (status && !VALID_MISSION_STATUSES.includes(status)) {
    return createError(RbookErrors.invalidParameter('status', status, VALID_MISSION_STATUSES));
  }

  const warnings: string[] = [];
  const result = await withClientAsync(
    async (client) => {
      let assignedSprintId = sprintId?.trim() ?? null;
      if (sprintId === undefined) {
        const open = client.getMany<{ id: string }>(
          `SELECT id FROM sprints WHERE ${statusInSql('status', SPRINT_OPEN_STATUSES)}`
        );
        if (!open.success)
          return createError<MissionAddResult>({
            code: open.error?.code ?? 'DB_QUERY_FAILED',
            message: open.error?.message ?? 'Failed to resolve an open sprint',
            suggestion:
              'Restore read access to sprints, or pass sprintId: null for explicitly unscheduled work.',
          });
        if (open.data?.length === 1) assignedSprintId = open.data[0].id;
        else if ((open.data?.length ?? 0) > 1)
          warnings.push(
            'Multiple sprints are open; the mission is unscheduled. Name sprintId to assign it.'
          );
      }
      if (assignedSprintId !== null) {
        const sprintResult = client.getOne<Sprint>('SELECT id, title FROM sprints WHERE id = ?', [
          assignedSprintId,
        ]);
        if (!sprintResult.success)
          return createError<MissionAddResult>({
            code: sprintResult.error?.code ?? 'DB_QUERY_FAILED',
            message: sprintResult.error?.message ?? 'Failed to verify sprint',
            suggestion: 'Check database access and the named sprint, then retry mission add.',
          });
        if (!sprintResult.data)
          return createError<MissionAddResult>(RbookErrors.sprintNotFound(assignedSprintId));
      }

      // Check if mission ID already exists
      const existingResult = client.getOne<{ id: string }>('SELECT id FROM missions WHERE id = ?', [
        missionId,
      ]);

      if (!existingResult.success) {
        return createError<MissionAddResult>(
          existingResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to check mission' }
        );
      }

      if (existingResult.data) {
        return createError<MissionAddResult>({
          code: 'MISSION_ID_EXISTS',
          message: `Mission '${missionId}' already exists`,
          suggestion:
            'Choose a different mission ID or use rbook_mission(action="update") to modify it',
        });
      }

      // Prepare context for storage
      const contextValue =
        context !== undefined
          ? typeof context === 'string'
            ? context
            : JSON.stringify(context)
          : null;

      // Ensure timestamp columns exist (migration)
      warnings.push(...(ensureMissionTimestamps(client).warnings ?? []));

      // Insert new mission with created_at timestamp
      const createdAt = new Date().toISOString();
      // s96-m01: on a shared store the create takes its sequence under the write lock (ADR s96 §3).
      const insertResult = recordedWrite(client, () => {
        const genesis = genesisColumns(client, 'missions', getProjectId(client));
        return client.execute(
          `INSERT INTO missions (
            id, sprint_id, name, status, objective, context,
            success_criteria, deliverables, reference_docs, domain_fields, notes,
            created_at, updated_at, ${genesis.columns.join(', ')}
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${genesis.placeholders})`,
          [
            missionId.trim(),
            assignedSprintId,
            name.trim(),
            status,
            objective?.trim() || null,
            contextValue,
            successCriteria ? JSON.stringify(successCriteria) : null,
            deliverables ? JSON.stringify(deliverables) : null,
            referenceDocs ? JSON.stringify(referenceDocs) : null,
            domainFields ? JSON.stringify(domainFields) : null,
            notes?.trim() || null,
            createdAt,
            createdAt,
            ...genesis.values,
          ]
        );
      });

      if (!insertResult.success) {
        return createError<MissionAddResult>(
          insertResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to create mission' }
        );
      }

      if (insertResult.data?.changes === 0) {
        return createError<MissionAddResult>({
          code: 'DB_QUERY_FAILED',
          message: 'Mission was not created (no rows affected)',
          suggestion: 'Check database permissions and try again',
        });
      }

      // Log creation event
      const now = new Date().toISOString();
      const eventResult = client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'create', ?, ?, ?)`,
        [
          now,
          missionId,
          status,
          `Created mission ${missionId}${assignedSprintId ? ` in sprint ${assignedSprintId}` : ' (unscheduled)'}`,
          JSON.stringify({
            tool: 'rbook_mission_add',
            missionId,
            sprintId: assignedSprintId,
            name: name.trim(),
            status,
          }),
        ]
      );

      checkWrite(eventResult, warnings, 'mission create event logging');

      // Sprint 66 m03 — write-path embedding hook
      const embedding = await recordEmbedding(client, {
        type: 'mission',
        id: missionId.trim(),
        inputText: missionEmbeddingInput({
          name: name.trim(),
          objective: objective?.trim() || null,
          notes: notes?.trim() || null,
          successCriteria: successCriteria ?? null,
        }),
      });

      if (embedding.warnings) warnings.push(...embedding.warnings);

      // A compact receipt: which optional fields were stored, with list lengths where they help.
      const fields: string[] = [];
      if (objective) fields.push('objective');
      if (context) fields.push('context');
      if (successCriteria) fields.push(`successCriteria (${successCriteria.length})`);
      if (deliverables) fields.push(`deliverables (${deliverables.length})`);
      if (referenceDocs) fields.push(`referenceDocs (${referenceDocs.length})`);
      if (domainFields) fields.push('domainFields');
      if (notes) fields.push('notes');

      return createSuccess(
        {
          id: missionId.trim(),
          name: name.trim(),
          sprintId: assignedSprintId,
          status,
          message: `Mission '${missionId}' created successfully${assignedSprintId ? ` in sprint '${assignedSprintId}'` : ' (unscheduled)'}`,
          mission: {
            id: missionId.trim(),
            name: name.trim(),
            sprintId: assignedSprintId,
            status,
          },
          fields,
        },
        warnings,
        sanitizedFields
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

/**
 * Format mission add result for LLM readability.
 *
 * @param result - Mission add result
 * @returns Human-readable summary
 */
export function formatMissionAddForLLM(result: RbookToolResult<MissionAddResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['Failed to create mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    `Mission '${data.id}' created`,
    '',
    `Sprint: ${data.sprintId ?? '(unscheduled)'}`,
    `Name: ${data.name}`,
    `Status: ${data.status}`,
  ];

  if (data.fields.length > 0) {
    lines.push(`Stored: ${data.fields.join(', ')}`);
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
