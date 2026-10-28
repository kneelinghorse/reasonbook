/**
 * rbook_sprint Tool
 *
 * Proof-of-concept consolidated tool for the action-parameterized pattern.
 * This routes actions to the existing sprint handlers without rewriting the
 * underlying sprint business logic.
 *
 * @module tools/rbook/rbook-sprint
 */

import { directoryCallError } from '../../edition';
import { formatToolFailure } from './format-failure';
import { z } from 'zod';
import { createError, RbookErrors } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import { appendWarnings } from './format-warnings';
import type { ActionParamMap, RbookToolResult } from './types';
import {
  rbookSprintAdd,
  formatSprintAddForLLM,
  type RbookSprintAddParams,
  type SprintAddResult,
} from './rbook-sprint-add';
import {
  rbookSprintComplete,
  formatSprintCompleteForLLM,
  type RbookSprintCompleteParams,
  type RbookSprintCompleteResult,
} from './rbook-sprint-complete';
import { triggerCheckpointBackfill } from './checkpoint-backfill';
import { closeUploadReceipt } from './dashboard-upload-receipt';
import { maybePropagateSprintStatus } from './sync-locks';
import {
  rbookSprintList,
  formatSprintListForLLM,
  type RbookSprintListParams,
  type RbookSprintListResult,
} from './rbook-sprint-list';
import {
  rbookSprintShow,
  formatSprintShowForLLM,
  type RbookSprintShowParams,
  type SprintShowResult,
} from './rbook-sprint-show';
import {
  rbookSprintUpdate,
  formatSprintUpdateForLLM,
  type RbookSprintUpdateParams,
  type SprintUpdateFields,
  type SprintUpdateResult,
} from './rbook-sprint-update';
import {
  rbookSprintRetro,
  formatSprintRetroForLLM,
  type RbookSprintRetroParams,
  type SprintRetroResult,
} from './rbook-sprint-retro';
import {
  rbookSprintCarryForward,
  formatSprintCarryForwardForLLM,
  type RbookSprintCarryForwardParams,
  type SprintCarryForwardResult,
} from './rbook-sprint-carry-forward';
import {
  rbookSprintAnalytics,
  formatSprintAnalyticsForLLM,
  type RbookSprintAnalyticsParams,
  type SprintAnalyticsResult,
} from './rbook-sprint-analytics';

export const RBOOK_SPRINT_ACTIONS = [
  'list',
  'show',
  'add',
  'update',
  'complete',
  'retro',
  'carry_forward',
  'analytics',
] as const;

export type RbookSprintAction = (typeof RBOOK_SPRINT_ACTIONS)[number];

/** s86-m04 — which published parameter applies to which action (see action-params.ts). */
export const RBOOK_SPRINT_ACTION_PARAMS: ActionParamMap<RbookSprintAction, RbookSprintParams> = {
  list: ['action', 'status', 'limit', 'projectRoot'],
  show: ['action', 'sprintId', 'projectRoot'],
  add: ['action', 'sprintId', 'title', 'focus', 'status', 'startDate', 'endDate', 'projectRoot'],
  update: ['action', 'sprintId', 'fields', 'projectRoot'],
  // `forceComplete` is retained and forwarded but is a NO-OP since decision #841 demoted the
  // build-freshness gate to advisory. It applies to this action in the sense the contract means —
  // the router accepts and forwards it — and the fact that it now changes nothing belongs in its
  // description, not in a silent omission here.
  complete: [
    'action',
    'sprintId',
    'summary',
    'condensation',
    'targetSizePercent',
    'forceComplete',
    'archive',
    'projectRoot',
  ],
  retro: ['action', 'sprintId', 'projectRoot'],
  carry_forward: ['action', 'sprintId', 'targetAddress', 'send', 'projectRoot'],
  analytics: ['action', 'limit', 'projectRoot'],
};

export type RbookSprintResult =
  | RbookSprintListResult
  | SprintShowResult
  | SprintAddResult
  | SprintUpdateResult
  | RbookSprintCompleteResult
  | SprintRetroResult
  | SprintCarryForwardResult
  | SprintAnalyticsResult;

const rbookSprintFieldsSchema = z
  .object({
    title: z.string().optional().describe('Sprint title'),
    focus: z.string().optional().describe('Strategic focus or theme of the sprint'),
    status: z.string().optional().describe('Sprint status (e.g., "Active", "Completed")'),
    startDate: z.string().optional().describe('Start date in ISO format (e.g., "2025-01-01")'),
    endDate: z.string().optional().describe('End date in ISO format (e.g., "2025-01-15")'),
  })
  .strict();

/**
 * Consolidated schema for all sprint actions.
 * Individual handlers still validate action-specific requirements.
 */
export const rbookSprintSchema = z
  .object({
    action: z
      .enum(RBOOK_SPRINT_ACTIONS)
      // s86-m04: DERIVED, not hand-written. This string listed 5 of the 8 members and had
      // shipped that way, so an agent reading it could not learn that retro, carry_forward or
      // analytics exist.
      .describe(`Sprint action: ${RBOOK_SPRINT_ACTIONS.join(' | ')}`),
    sprintId: z
      .string()
      .optional()
      .describe('Sprint ID for show/add/update/complete/retro/carry_forward actions'),
    title: z.string().optional().describe('Sprint title for add action'),
    focus: z.string().optional().describe('Strategic focus or theme for add action'),
    status: z.string().optional().describe('Filter or sprint status depending on action'),
    startDate: z.string().optional().describe('Sprint start date for add action'),
    endDate: z.string().optional().describe('Sprint end date for add action'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum sprints to return for list/analytics actions'),
    fields: rbookSprintFieldsSchema.optional().describe('Fields payload for update action'),
    summary: z.string().optional().describe('Closeout summary for complete action'),
    condensation: z
      .enum(['none', 'conservative', 'auto', 'aggressive'])
      .optional()
      .describe('Optional condensation strategy for complete action'),
    targetSizePercent: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Target size percent for complete action condensation'),
    forceComplete: z
      .boolean()
      .optional()
      .describe(
        'No-op for complete action, kept for backward compatibility. Build-freshness is advisory as of the s74 review — staleness is surfaced as a warning and never blocks closeout, so no override is needed.'
      ),
    archive: z
      .boolean()
      .optional()
      .describe(
        "complete: also archive the sprint's active decisions and learnings (off by default since 3.2.0)"
      ),
    targetAddress: z
      .string()
      .optional()
      .describe('rbook:// address for carry_forward action (e.g., rbook://example/dashboard)'),
    send: z
      .boolean()
      .optional()
      .describe(
        'Whether to actually send messages for carry_forward (default true, false = dry run)'
      ),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
  })
  .strict();

export type RbookSprintParams = z.infer<typeof rbookSprintSchema>;

/**
 * MCP Tool Definition for rbook_sprint.
 */
export const rbookSprintToolDefinition = {
  name: 'rbook_sprint',
  description:
    'Consolidated sprint tool with action parameter support. ' +
    'Actions: list, show, add, update, complete, retro, carry_forward, analytics. ' +
    // s87-m02: `complete` ARCHIVES rows, and until now its published description never said so.
    // This is the only client-visible surface where an operator can learn that closing a sprint
    // demotes decisions and learnings — it regenerates into TOOL_REFERENCE.md and the definitions
    // snapshot, both of which ship. The counterpart edit on rbookSprintCompleteToolDefinition is a
    // consistency fix on an UNREGISTERED definition and reaches no MCP host.
    // s92-m05 (operator Q1, decision #1160): the close stopped archiving by default.
    'Use complete to close a sprint: it stamps the actual close time, applies the next-step lease, ' +
    "and leaves the sprint's decisions and learnings ACTIVE unless archive is true (then it archives " +
    'them and names every archived id); it takes a pre-close database snapshot you can restore from. ' +
    'Use retro to auto-generate a sprint retrospective report with KPIs, decisions, learnings, and git commit summary. ' +
    'Use carry_forward to detect sync gaps and blocked missions and send backlog_request messages to a target project. ' +
    'Use analytics to compute cross-sprint trend KPIs: velocity, completion rate, decision volume, cycle time.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...RBOOK_SPRINT_ACTIONS],
        description: `Sprint action: ${RBOOK_SPRINT_ACTIONS.join(' | ')}`,
      },
      sprintId: {
        type: 'string',
        description: 'Sprint ID for show/add/update/complete/retro/carry_forward actions',
      },
      title: {
        type: 'string',
        description: 'Sprint title for add action',
      },
      focus: {
        type: 'string',
        description: 'Strategic focus or theme for add action',
      },
      status: {
        type: 'string',
        description: 'Filter or sprint status depending on action',
      },
      startDate: {
        type: 'string',
        description: 'Sprint start date for add action',
      },
      endDate: {
        type: 'string',
        description: 'Sprint end date for add action',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum sprints to return for list/analytics actions',
      },
      fields: {
        type: 'object',
        description: 'Fields payload for update action',
        properties: {
          title: { type: 'string', description: 'Sprint title' },
          focus: { type: 'string', description: 'Strategic focus or theme of the sprint' },
          status: { type: 'string', description: 'Sprint status (e.g., "Active", "Completed")' },
          startDate: {
            type: 'string',
            description: 'Start date in ISO format (e.g., "2025-01-01")',
          },
          endDate: {
            type: 'string',
            description: 'End date in ISO format (e.g., "2025-01-15")',
          },
        },
        additionalProperties: false,
      },
      summary: {
        type: 'string',
        description: 'Closeout summary for complete action',
      },
      condensation: {
        type: 'string',
        enum: ['none', 'conservative', 'auto', 'aggressive'],
        description: 'Optional condensation strategy for complete action',
      },
      targetSizePercent: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Target size percent for complete action condensation',
      },
      forceComplete: {
        type: 'boolean',
        description:
          'No-op for complete action, kept for backward compatibility. Build-freshness is advisory — staleness is surfaced as a warning and never blocks closeout.',
      },
      archive: {
        type: 'boolean',
        description:
          "complete: also archive the sprint's active decisions and learnings (off by default since 3.2.0)",
      },
      targetAddress: {
        type: 'string',
        description: 'rbook:// address for carry_forward action (e.g., rbook://example/dashboard)',
      },
      send: {
        type: 'boolean',
        description:
          'Whether to actually send messages for carry_forward (default true, false = dry run)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

function isSprintAction(value: string): value is RbookSprintAction {
  return (RBOOK_SPRINT_ACTIONS as readonly string[]).includes(value);
}

/**
 * Route a consolidated sprint request to the existing action-specific handler.
 */
export async function rbookSprint(
  params: RbookSprintParams
): Promise<RbookToolResult<RbookSprintResult>> {
  const editionError = directoryCallError('rbook_sprint', params);
  if (editionError) return createError(editionError);
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isSprintAction(actionValue)) {
    return createError<RbookSprintResult>(
      RbookErrors.invalidAction('rbook_sprint', actionValue, RBOOK_SPRINT_ACTIONS)
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookSprintToolDefinition.inputSchema,
    RBOOK_SPRINT_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<RbookSprintResult>(wrongTypedParam);

  switch (actionValue) {
    case 'list':
      return rbookSprintList({
        status: params.status,
        limit: params.limit,
        projectRoot: params.projectRoot,
      } satisfies RbookSprintListParams);
    case 'show':
      return rbookSprintShow({
        sprintId: params.sprintId ?? '',
        projectRoot: params.projectRoot,
      } satisfies RbookSprintShowParams);
    case 'add':
      return rbookSprintAdd({
        sprintId: params.sprintId ?? '',
        title: params.title ?? '',
        focus: params.focus,
        status: params.status,
        startDate: params.startDate,
        endDate: params.endDate,
        projectRoot: params.projectRoot,
      } satisfies RbookSprintAddParams);
    case 'update': {
      const result = await rbookSprintUpdate({
        sprintId: params.sprintId ?? '',
        fields: (params.fields ?? {}) as SprintUpdateFields,
        projectRoot: params.projectRoot,
      } satisfies RbookSprintUpdateParams);
      // Sprint 72 m02: propagate sprint_status to the broker on a collab store — but only
      // when this update actually touched `status` (a focus/title-only update emits
      // nothing). Resilient + no-op on solo stores (see maybePropagateSprintStatus).
      const statusChanged =
        result.success && (result.data?.updatedFields?.includes('status') ?? false);
      return statusChanged
        ? maybePropagateSprintStatus(result, params.sprintId ?? '', params.projectRoot)
        : result;
    }
    case 'complete': {
      const result = await rbookSprintComplete({
        sprintId: params.sprintId ?? '',
        summary: params.summary ?? '',
        condensation: params.condensation,
        targetSizePercent: params.targetSizePercent,
        forceComplete: params.forceComplete,
        archive: params.archive,
        projectRoot: params.projectRoot,
      } satisfies RbookSprintCompleteParams);
      if (result.success && result.data) {
        result.data.dashboardUpload = await closeUploadReceipt(params.projectRoot);
        triggerCheckpointBackfill({ projectRoot: params.projectRoot, force: true });
      }
      // Sprint 72 m02: a completed sprint flips status → 'Completed'; propagate it.
      return maybePropagateSprintStatus(result, params.sprintId ?? '', params.projectRoot);
    }
    case 'retro':
      return rbookSprintRetro({
        sprintId: params.sprintId ?? '',
        projectRoot: params.projectRoot,
      } satisfies RbookSprintRetroParams);
    case 'carry_forward':
      return rbookSprintCarryForward({
        sprintId: params.sprintId ?? '',
        targetAddress: params.targetAddress ?? '',
        send: params.send,
        projectRoot: params.projectRoot,
      } satisfies RbookSprintCarryForwardParams);
    case 'analytics':
      return rbookSprintAnalytics({
        limit: params.limit,
        projectRoot: params.projectRoot,
      } satisfies RbookSprintAnalyticsParams);
  }
}

/**
 * Format consolidated sprint responses by delegating to the existing formatter
 * for the selected action. This keeps the POC close to the current output style.
 */
export function formatSprintForLLM(
  action: string | undefined,
  result: RbookToolResult<RbookSprintResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute rbook_sprint', '', `Error: ${result.error.message}`];

    if (availableActions.length > 0) {
      lines.push('');
      lines.push(`Available actions: ${availableActions.join(', ')}`);
    }

    if (result.error.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${result.error.suggestion}`);
    }

    return lines.join('\n');
  }

  switch (action) {
    case 'list':
      return formatSprintListForLLM(result as RbookToolResult<RbookSprintListResult>);
    case 'show':
      return formatSprintShowForLLM(result as RbookToolResult<SprintShowResult>);
    case 'add':
      return formatSprintAddForLLM(result as RbookToolResult<SprintAddResult>);
    case 'update':
      return formatSprintUpdateForLLM(result as RbookToolResult<SprintUpdateResult>);
    case 'complete':
      return formatSprintCompleteForLLM(result as RbookToolResult<RbookSprintCompleteResult>);
    case 'retro':
      return formatSprintRetroForLLM(result as RbookToolResult<SprintRetroResult>);
    case 'carry_forward':
      return formatSprintCarryForwardForLLM(result as RbookToolResult<SprintCarryForwardResult>);
    case 'analytics':
      return formatSprintAnalyticsForLLM(result as RbookToolResult<SprintAnalyticsResult>);
    default: {
      if (!result.success)
        return formatToolFailure('❌ Failed to execute rbook_sprint', result.error);
      const lines = ['✓ Sprint action completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
