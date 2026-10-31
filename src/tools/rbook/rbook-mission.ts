// ABOUTME: Route consolidated mission actions through the published input contract.
// ABOUTME: Preserve supported field clears while validating declared types and bounds.

/**
 * rbook_mission Tool
 *
 * Consolidated mission CRUD tool with action parameter support.
 * Actions: list, show, status, add, update, move, depends, undepends.
 * Routes to existing mission handlers without rewriting business logic.
 *
 * @module tools/rbook/rbook-mission
 */

import { directoryCallError } from '../../edition';
import { formatToolFailure } from './format-failure';
import { z } from 'zod';
import { createError, RbookErrors } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import { appendWarnings } from './format-warnings';
import type { ActionParamMap, RbookToolResult } from './types';
import {
  rbookMissionList,
  formatMissionListForLLM,
  type RbookMissionListParams,
  type RbookMissionListResult,
} from './rbook-mission-list';
import {
  rbookMissionShow,
  formatMissionShowForLLM,
  type RbookMissionShowParams,
  type MissionShowResult,
} from './rbook-mission-show';
import {
  rbookMissionStatus,
  missionStatusAcrossProjects,
  formatMissionStatusForLLM,
  formatMissionPortfolioForLLM,
  type RbookMissionStatusParams,
  type RbookMissionStatusResult,
  type RbookMissionPortfolioResult,
} from './rbook-mission-status';
import {
  rbookMissionAdd,
  formatMissionAddForLLM,
  type RbookMissionAddParams,
  type MissionAddResult,
} from './rbook-mission-add';
import {
  rbookMissionUpdate,
  formatMissionUpdateForLLM,
  type RbookMissionUpdateParams,
  type MissionUpdateResult,
  type MissionUpdateFields,
} from './rbook-mission-update';
import {
  rbookMissionDepends,
  formatMissionDependsForLLM,
  MISSION_DEPENDENCY_DISCLOSURE,
  type RbookMissionDependsParams,
  type MissionDependsResult,
} from './rbook-mission-depends';
import {
  rbookMissionMove,
  formatMissionMoveForLLM,
  type RbookMissionMoveParams,
  type MissionMoveResult,
} from './rbook-mission-move';
import {
  rbookMissionUndepends,
  formatMissionUndependsForLLM,
  type RbookMissionUndependsParams,
  type MissionUndependsResult,
} from './rbook-mission-undepends';

export const RBOOK_MISSION_ACTIONS = [
  'list',
  'show',
  'status',
  'add',
  'update',
  'move',
  'depends',
  'undepends',
] as const;

export type RbookMissionAction = (typeof RBOOK_MISSION_ACTIONS)[number];

/** s86-m04 — which published parameter applies to which action (see action-params.ts). */
export const RBOOK_MISSION_ACTION_PARAMS: ActionParamMap<RbookMissionAction, RbookMissionParams> = {
  list: ['action', 'sprintId', 'status', 'limit', 'page', 'projectRoot'],
  show: ['action', 'missionId', 'projectRoot'],
  // `limit` reaches only the acrossProjects arm (rbook-mission.ts:321) and `queuedLimit` only the
  // local one, but both are genuinely settable on this action, so both are published for it.
  status: ['action', 'limit', 'includeBlocked', 'queuedLimit', 'acrossProjects', 'projectRoot'],
  add: [
    'action',
    'missionId',
    'sprintId',
    'status',
    'name',
    'objective',
    'context',
    'successCriteria',
    'deliverables',
    'referenceDocs',
    'domainFields',
    'notes',
    'projectRoot',
  ],
  update: ['action', 'missionId', 'fields', 'projectRoot'],
  move: ['action', 'missionId', 'toSprintId', 'reason', 'projectRoot'],
  depends: ['action', 'fromId', 'toId', 'type', 'projectRoot'],
  undepends: ['action', 'fromId', 'toId', 'projectRoot'],
};

export type RbookMissionResult =
  | RbookMissionListResult
  | MissionShowResult
  | RbookMissionStatusResult
  | RbookMissionPortfolioResult
  | MissionAddResult
  | MissionUpdateResult
  | MissionMoveResult
  | MissionDependsResult
  | MissionUndependsResult;

const rbookMissionFieldsSchema = z
  .object({
    name: z.string().optional().describe('Mission name/title'),
    status: z.string().optional().describe('Mission status'),
    objective: z.string().nullable().optional().describe('Mission objective'),
    context: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .nullable()
      .optional()
      .describe('Background context'),
    successCriteria: z.array(z.string()).nullable().optional().describe('Success criteria'),
    deliverables: z.array(z.string()).nullable().optional().describe('Deliverables'),
    referenceDocs: z.array(z.string()).nullable().optional().describe('Reference docs'),
    domainFields: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe('Domain-specific fields'),
    notes: z.string().nullable().optional().describe('Notes'),
    metadata: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe('Additional metadata'),
  })
  .strict();

export const rbookMissionSchema = z
  .object({
    action: z
      .enum(RBOOK_MISSION_ACTIONS)
      .describe('Mission action: list | show | status | add | update | move | depends | undepends'),
    missionId: z.string().optional().describe('Mission ID for show/add/update/move actions'),
    sprintId: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Sprint ID for list filter; add: omitted infers the unique open sprint, null requests unscheduled'
      ),
    toSprintId: z.string().optional().describe('Destination sprint ID for move action'),
    reason: z.string().optional().describe('Reason recorded on the breadcrumb for move action'),
    status: z
      .string()
      .optional()
      .describe('Status filter for list action, or initial status for add action'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe(
        'Missions per page for list action (default 6), or across-project cap for status action'
      ),
    page: z.number().int().min(1).optional().describe('Page of list results, 1-based (default 1)'),
    includeBlocked: z.boolean().optional().describe('Include blocked missions in status action'),
    acrossProjects: z
      .boolean()
      .optional()
      .describe(
        'status action: active missions (In Progress/Current) across all registered projects (cross-store portfolio view)'
      ),
    queuedLimit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum queued missions for status action'),
    name: z.string().optional().describe('Mission name for add action'),
    objective: z.string().optional().describe('Mission objective for add action'),
    context: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .optional()
      .describe('Mission context for add action'),
    successCriteria: z.array(z.string()).optional().describe('Success criteria for add action'),
    deliverables: z.array(z.string()).optional().describe('Deliverables for add action'),
    referenceDocs: z.array(z.string()).optional().describe('Reference docs for add action'),
    domainFields: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Domain fields for add action'),
    notes: z.string().optional().describe('Notes for add action'),
    fields: rbookMissionFieldsSchema.optional().describe('Fields payload for update action'),
    fromId: z.string().optional().describe('Dependent mission ID for depends/undepends actions'),
    toId: z.string().optional().describe('Dependency mission ID for depends/undepends actions'),
    type: z
      .enum(['Blocks', 'Requires', 'Enables'])
      .optional()
      .describe(`Dependency label for depends action. ${MISSION_DEPENDENCY_DISCLOSURE}`),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
  })
  .strict();

export type RbookMissionParams = z.infer<typeof rbookMissionSchema>;

export const rbookMissionToolDefinition = {
  name: 'rbook_mission',
  description:
    'Consolidated mission tool with action parameter support. ' +
    'Actions: list, show, status, add, update, move, depends, undepends. ' +
    'Routes to the existing mission handlers without changing mission business logic.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...RBOOK_MISSION_ACTIONS],
        description:
          'Mission action: list | show | status | add | update | move | depends | undepends',
      },
      missionId: {
        type: 'string',
        description: 'Mission ID for show/add/update/move actions',
      },
      sprintId: {
        type: ['string', 'null'],
        description:
          'Sprint ID for list filter; add: omitted infers the unique open sprint, null requests unscheduled',
      },
      toSprintId: {
        type: 'string',
        description: 'Destination sprint ID for move action',
      },
      reason: {
        type: 'string',
        description: 'Reason recorded on the breadcrumb for move action',
      },
      status: {
        type: 'string',
        description: 'Status filter for list action, or initial status for add action',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description:
          'Missions per page for list action (default 6), or across-project cap for status action',
      },
      page: {
        type: 'integer',
        minimum: 1,
        description: 'Page of list results, 1-based (default 1)',
      },
      includeBlocked: {
        type: 'boolean',
        description: 'Include blocked missions in status action',
      },
      queuedLimit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum queued missions for status action',
      },
      name: {
        type: 'string',
        description: 'Mission name for add action',
      },
      objective: {
        type: 'string',
        description: 'Mission objective for add action',
      },
      context: {
        type: ['string', 'object'],
        description: 'Mission context for add action (string or object)',
      },
      successCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Success criteria for add action',
      },
      deliverables: {
        type: 'array',
        items: { type: 'string' },
        description: 'Deliverables for add action',
      },
      referenceDocs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Reference docs for add action',
      },
      domainFields: {
        type: 'object',
        description: 'Domain-specific fields for add action',
      },
      notes: {
        type: 'string',
        description: 'Notes for add action',
      },
      fields: {
        type: 'object',
        description: 'Fields payload for update action',
        properties: {
          name: { type: 'string', description: 'Mission name/title' },
          status: { type: 'string', description: 'Mission status' },
          objective: { type: ['string', 'null'], description: 'Mission objective' },
          context: { type: ['string', 'object', 'null'], description: 'Background context' },
          successCriteria: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'Success criteria',
          },
          deliverables: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'Deliverables',
          },
          referenceDocs: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'Reference docs',
          },
          domainFields: { type: ['object', 'null'], description: 'Domain-specific fields' },
          notes: { type: ['string', 'null'], description: 'Notes' },
          metadata: { type: ['object', 'null'], description: 'Additional metadata' },
        },
        additionalProperties: false,
      },
      fromId: {
        type: 'string',
        description: 'Dependent mission ID for depends/undepends actions',
      },
      toId: {
        type: 'string',
        description: 'Dependency mission ID for depends/undepends actions',
      },
      type: {
        type: 'string',
        enum: ['Blocks', 'Requires', 'Enables'],
        description: `Dependency label for depends action. ${MISSION_DEPENDENCY_DISCLOSURE}`,
      },
      acrossProjects: {
        type: 'boolean',
        description:
          'status action: active missions (In Progress/Current) across all registered projects (cross-store portfolio view)',
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

function isMissionAction(value: string): value is RbookMissionAction {
  return (RBOOK_MISSION_ACTIONS as readonly string[]).includes(value);
}

export async function rbookMission(
  params: RbookMissionParams
): Promise<RbookToolResult<RbookMissionResult>> {
  const editionError = directoryCallError('rbook_mission', params);
  if (editionError) return createError(editionError);
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isMissionAction(actionValue)) {
    return createError<RbookMissionResult>(
      RbookErrors.invalidAction('rbook_mission', actionValue, RBOOK_MISSION_ACTIONS)
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookMissionToolDefinition.inputSchema,
    RBOOK_MISSION_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<RbookMissionResult>(wrongTypedParam);

  switch (actionValue) {
    case 'list':
      return rbookMissionList({
        sprintId: params.sprintId ?? undefined,
        status: params.status as RbookMissionListParams['status'],
        limit: params.limit,
        page: params.page,
        projectRoot: params.projectRoot,
      });
    case 'show':
      return rbookMissionShow({
        missionId: params.missionId ?? '',
        projectRoot: params.projectRoot,
      } satisfies RbookMissionShowParams);
    case 'status':
      // s79-m05: acrossProjects → the §5.4 active-missions portfolio query (graph-
      // backed queryAcrossStores), NOT the single-store work queue. index.ts skips
      // local-root resolution for this branch.
      if (params.acrossProjects) {
        return missionStatusAcrossProjects({
          limit: params.limit,
          projectRoot: params.projectRoot,
        });
      }
      return rbookMissionStatus({
        includeBlocked: params.includeBlocked,
        queuedLimit: params.queuedLimit,
        projectRoot: params.projectRoot,
      } satisfies RbookMissionStatusParams);
    case 'add':
      return rbookMissionAdd({
        missionId: params.missionId ?? '',
        name: params.name ?? '',
        sprintId: params.sprintId,
        status: params.status as RbookMissionAddParams['status'],
        objective: params.objective,
        context: params.context,
        successCriteria: params.successCriteria,
        deliverables: params.deliverables,
        referenceDocs: params.referenceDocs,
        domainFields: params.domainFields,
        notes: params.notes,
        projectRoot: params.projectRoot,
      });
    case 'update':
      return rbookMissionUpdate({
        missionId: params.missionId ?? '',
        fields: (params.fields ?? {}) as MissionUpdateFields,
        projectRoot: params.projectRoot,
      } satisfies RbookMissionUpdateParams);
    case 'move':
      return rbookMissionMove({
        missionId: params.missionId ?? '',
        toSprintId: params.toSprintId ?? '',
        reason: params.reason,
        projectRoot: params.projectRoot,
      } satisfies RbookMissionMoveParams);
    case 'depends':
      return rbookMissionDepends({
        fromId: params.fromId ?? '',
        toId: params.toId ?? '',
        type: (params.type ?? 'Requires') as RbookMissionDependsParams['type'],
        projectRoot: params.projectRoot,
      } satisfies RbookMissionDependsParams);
    case 'undepends':
      return rbookMissionUndepends({
        fromId: params.fromId ?? '',
        toId: params.toId ?? '',
        projectRoot: params.projectRoot,
      } satisfies RbookMissionUndependsParams);
  }
}

export function formatMissionForLLM(
  action: string | undefined,
  result: RbookToolResult<RbookMissionResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute rbook_mission', '', `Error: ${result.error.message}`];

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
      return formatMissionListForLLM(result as RbookToolResult<RbookMissionListResult>);
    case 'show':
      return formatMissionShowForLLM(result as RbookToolResult<MissionShowResult>);
    case 'status':
      // s79-m05: the acrossProjects branch returns the flat portfolio envelope.
      if (result.success && result.data && 'acrossProjects' in result.data) {
        return formatMissionPortfolioForLLM(result as RbookToolResult<RbookMissionPortfolioResult>);
      }
      return formatMissionStatusForLLM(result as RbookToolResult<RbookMissionStatusResult>);
    case 'add':
      return formatMissionAddForLLM(result as RbookToolResult<MissionAddResult>);
    case 'update':
      return formatMissionUpdateForLLM(result as RbookToolResult<MissionUpdateResult>);
    case 'move':
      return formatMissionMoveForLLM(result as RbookToolResult<MissionMoveResult>);
    case 'depends':
      return formatMissionDependsForLLM(result as RbookToolResult<MissionDependsResult>);
    case 'undepends':
      return formatMissionUndependsForLLM(result as RbookToolResult<MissionUndependsResult>);
    default: {
      if (!result.success)
        return formatToolFailure('❌ Failed to execute rbook_mission', result.error);
      const lines = ['✓ Mission action completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
