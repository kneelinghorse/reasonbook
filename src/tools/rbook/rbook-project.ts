// ABOUTME: Route consolidated project actions and publish their complete input shapes.
// ABOUTME: Keep action-specific requiredness in handlers and preserve unscheduled initial missions.

/**
 * rbook_project Tool
 *
 * Consolidated project tool with action parameter support.
 * Actions: init, register, list, unregister, validate, update, sweep; s96-m13's shared-record
 * actions share, invite, join, members, remove and sync live in rbook-project-shared.ts.
 * Routes to existing project handlers without rewriting business logic.
 * Note: list action supports optional validate flag that runs validation.
 *
 * @module tools/rbook/rbook-project
 */

import { directoryCallError } from '../../edition';
import { formatToolFailure } from './format-failure';
import { z } from 'zod';
import { createError, RbookErrors } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import { appendWarnings } from './format-warnings';
import type { ActionParamMap, RbookToolResult } from './types';
import {
  rbookProjectInit,
  formatProjectInitForLLM,
  type RbookProjectInitInput,
  type RbookProjectInitResult,
} from './rbook-project-init';
import {
  rbookProjectRegister,
  formatProjectRegisterForLLM,
  type RbookProjectRegisterParams,
  type ProjectRegisterResult,
} from './rbook-project-register';
import {
  rbookProjectList,
  formatProjectListForLLM,
  type RbookProjectListParams,
  type ProjectListResult,
} from './rbook-project-list';
import {
  rbookProjectUnregister,
  formatProjectUnregisterForLLM,
  type RbookProjectUnregisterParams,
  type ProjectUnregisterResult,
} from './rbook-project-unregister';
import {
  rbookProjectValidate,
  formatProjectValidateForLLM,
  type RbookProjectValidateParams,
  type ProjectValidateResult,
} from './rbook-project-validate';
import {
  rbookProjectUpdate,
  formatProjectUpdateForLLM,
  type RbookProjectUpdateParams,
  type ProjectUpdateResult,
} from './rbook-project-update';
import {
  rbookProjectSweep,
  formatProjectSweepForLLM,
  type SweepResult,
} from './rbook-project-sweep';
import {
  formatSharedProjectForLLM,
  rbookProjectInvite,
  rbookProjectJoin,
  rbookProjectMembers,
  rbookProjectRemove,
  rbookProjectShare,
  rbookProjectSync,
  rbookProjectMove,
  SHARED_PROJECT_ACTION_PARAMS,
  sharedProjectProperties,
  sharedProjectZodFields,
  type SharedProjectAction,
  type SharedProjectResult,
} from './rbook-project-shared';

export const RBOOK_PROJECT_ACTIONS = [
  'init',
  'register',
  'list',
  'unregister',
  'validate',
  'prune',
  'update',
  'sweep',
  'share',
  'invite',
  'join',
  'members',
  'remove',
  'sync',
  'move',
] as const;

export type RbookProjectAction = (typeof RBOOK_PROJECT_ACTIONS)[number];

/**
 * s86-m04 — which published parameter applies to which action (see action-params.ts).
 *
 * THREE ACTIONS DO NOT TAKE `projectRoot`, and that is the tree, not an omission: `list`,
 * `validate` and `sweep` operate on the per-user project-graph registry rather than on one store
 * (rbook-project.ts:309-335), and `prune` forwards a hardcoded `{prune: true}` and reads nothing.
 * The flat table published `projectRoot` against all eight.
 */
export const RBOOK_PROJECT_ACTION_PARAMS: ActionParamMap<RbookProjectAction, RbookProjectParams> = {
  init: [
    'action',
    'projectRoot',
    'projectName',
    'projectId',
    'tracelabProjectId',
    'initialSprint',
    'initialMissions',
    'projectType',
  ],
  register: ['action', 'projectRoot', 'name', 'setAsDefault'],
  list: ['action', 'validate'],
  unregister: ['action', 'projectRoot'],
  validate: ['action', 'prune'],
  prune: ['action'],
  update: ['action', 'projectRoot', 'projectType'],
  sweep: ['action', 'instances', 'statusFilter', 'itemType'],
  ...SHARED_PROJECT_ACTION_PARAMS,
};

export type RbookProjectResult =
  | RbookProjectInitResult
  | ProjectRegisterResult
  | ProjectListResult
  | ProjectUnregisterResult
  | ProjectValidateResult
  | ProjectUpdateResult
  | SweepResult
  | SharedProjectResult;

const initialSprintSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    focus: z.string().optional(),
    status: z.string().optional(),
  })
  .strict();

const initialMissionSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    sprintId: z.string().nullable().optional(),
    objective: z.string().optional(),
    successCriteria: z.array(z.string()).optional(),
    deliverables: z.array(z.string()).optional(),
    status: z.enum(['Queued', 'Current']).optional(),
  })
  .strict();

export const rbookProjectSchema = z
  .object({
    action: z
      .enum(RBOOK_PROJECT_ACTIONS)
      .describe(
        'Project action: init | register | list | unregister | validate | prune | update | sweep | share | invite | join | members | remove | sync | move'
      ),
    projectRoot: z.string().optional().describe('Project root directory'),
    // init params
    projectName: z.string().optional().describe('Project name for init action'),
    projectId: z.string().optional().describe('Project ID for init action'),
    tracelabProjectId: z.string().optional().describe('TraceLab project ID for init action'),
    initialSprint: initialSprintSchema
      .optional()
      .describe(
        'Initial sprint config for init action; refused at the Ledger level, which keeps no sprints'
      ),
    initialMissions: z
      .array(initialMissionSchema)
      .optional()
      .describe(
        'Initial missions for init action; refused at the Ledger level, which keeps no missions'
      ),
    // register params
    name: z
      .string()
      .optional()
      .describe("register: the display name; invite and remove: the member's name"),
    setAsDefault: z
      .boolean()
      .optional()
      .describe(
        'register: make this the default for calls with no project context (no projectRoot, no MCP roots, cwd of /, $HOME or the install root)'
      ),
    // validate params
    prune: z
      .boolean()
      .optional()
      .describe(
        'validate: archive the registry entries whose store is missing, stale or ephemeral'
      ),
    // list with validate flag
    validate: z
      .boolean()
      .optional()
      .describe('Run validation on list action (routes to validate handler)'),
    // update params
    projectType: z
      .enum(['general', 'managed', 'build'])
      .optional()
      .describe('The level of record for init and update: general | managed | build'),
    // sweep params
    instances: z
      .array(z.string())
      .optional()
      .describe('Restrict sweep to these registry names only'),
    statusFilter: z
      .array(z.string())
      .optional()
      .describe('Restrict sweep to these mission/session statuses'),
    itemType: z
      .enum(['mission', 'session'])
      .optional()
      .describe('Restrict sweep to missions or sessions only'),
    ...sharedProjectZodFields,
  })
  .strict();

export type RbookProjectParams = z.infer<typeof rbookProjectSchema>;

export const rbookProjectToolDefinition = {
  name: 'rbook_project',
  description:
    'Consolidated project tool with action parameter support. ' +
    'Actions: init, register, list, unregister, validate, prune, update, sweep, share, invite, join, members, remove, sync, move. ' +
    'The list action supports an optional validate flag. ' +
    'The prune action removes registry entries where the local Reasonbook database no longer exists on disk. ' +
    'The update action sets the level (project_type: general/managed/build) and writes the files ' +
    'the new level uses that the project lacks; it removes no file and overwrites no edited one. ' +
    'The sweep action returns all open missions and active sessions across registered instances. ' +
    "The shared-record actions: share makes this copy the owner's of a record others join, or with " +
    'via=dashboard shares it through the dashboard after a dry run; invite and remove manage its ' +
    "members; join admits a member's copy over SSH, or with via=dashboard joins a project shared " +
    'through the dashboard by its address; members lists them; sync exchanges with every copy this ' +
    "one has a route to, or with confirmOwner confirms a move of the owner's copy; and move with " +
    "to=owner moves a project shared through the dashboard back to the owner's copy.",
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...RBOOK_PROJECT_ACTIONS],
        description:
          'Project action: init | register | list | unregister | validate | prune | update | sweep | share | invite | join | members | remove | sync | move',
      },
      projectRoot: { type: 'string', description: 'Project root directory' },
      projectName: { type: 'string', description: 'Project name for init action' },
      projectId: { type: 'string', description: 'Project ID for init action' },
      tracelabProjectId: { type: 'string', description: 'TraceLab project ID for init action' },
      // s86-m04: both sub-shapes are TRANSCRIBED from their zod schemas (initialSprintSchema /
      // initialMissionSchema above), not invented. Both are `.strict()` in zod while publishing
      // neither their properties nor `additionalProperties`, so the published half said nothing
      // where the server enforces a closed four- and seven-key shape. Publishing
      // `additionalProperties: false` WITHOUT the properties would have been the same defect in
      // the opposite direction — "no keys are accepted" — so the keys land with it.
      initialSprint: {
        type: 'object',
        description:
          'Initial sprint config for init action; refused at the Ledger level, which keeps no sprints',
        properties: {
          id: { type: 'string', description: 'Sprint ID' },
          title: { type: 'string', description: 'Sprint title' },
          focus: { type: 'string', description: 'Sprint focus' },
          status: { type: 'string', description: 'Sprint status' },
        },
        additionalProperties: false,
      },
      initialMissions: {
        type: 'array',
        description:
          'Initial missions for init action; refused at the Ledger level, which keeps no missions',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Mission ID' },
            name: { type: 'string', description: 'Mission name' },
            sprintId: { type: ['string', 'null'], description: 'Owning sprint ID' },
            objective: { type: 'string', description: 'Mission objective' },
            successCriteria: {
              type: 'array',
              items: { type: 'string' },
              description: 'Success criteria',
            },
            deliverables: {
              type: 'array',
              items: { type: 'string' },
              description: 'Deliverables',
            },
            status: {
              type: 'string',
              enum: ['Queued', 'Current'],
              description: 'Initial mission status',
            },
          },
          additionalProperties: false,
        },
      },
      name: {
        type: 'string',
        description: "register: the display name; invite and remove: the member's name",
      },
      setAsDefault: {
        type: 'boolean',
        description:
          'register: make this the default for calls with no project context (no projectRoot, no MCP roots, cwd of /, $HOME or the install root)',
      },
      prune: {
        type: 'boolean',
        description:
          'validate: archive the registry entries whose store is missing, stale or ephemeral',
      },
      validate: {
        type: 'boolean',
        description: 'Run validation on list action (routes to validate handler)',
      },
      projectType: {
        type: 'string',
        enum: ['general', 'managed', 'build'],
        description:
          'The level of record for init and update: general (decisions and lessons), managed (also next steps, as tasks in cycles) or build (sprints and missions); a new project defaults to general, or to the level its folder AGENTS.md already names, and init keeps an existing project level unless one is passed',
      },
      instances: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict sweep to these registry names only',
      },
      statusFilter: {
        type: 'array',
        items: { type: 'string' },
        description: 'Restrict sweep to these mission/session statuses',
      },
      itemType: {
        type: 'string',
        enum: ['mission', 'session'],
        description: 'Restrict sweep to missions or sessions only',
      },
      ...sharedProjectProperties,
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

function isProjectAction(value: string): value is RbookProjectAction {
  return (RBOOK_PROJECT_ACTIONS as readonly string[]).includes(value);
}

export async function rbookProject(
  params: RbookProjectParams
): Promise<RbookToolResult<RbookProjectResult>> {
  const editionError = directoryCallError('rbook_project', params);
  if (editionError) return createError(editionError);
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isProjectAction(actionValue)) {
    return createError<RbookProjectResult>(
      RbookErrors.invalidAction('rbook_project', actionValue, RBOOK_PROJECT_ACTIONS)
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookProjectToolDefinition.inputSchema,
    RBOOK_PROJECT_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<RbookProjectResult>(wrongTypedParam);

  switch (actionValue) {
    case 'init':
      return rbookProjectInit({
        projectRoot: params.projectRoot ?? '',
        projectName: params.projectName,
        projectId: params.projectId,
        tracelabProjectId: params.tracelabProjectId,
        initialSprint: params.initialSprint,
        initialMissions: params.initialMissions,
        projectType: params.projectType,
      } as RbookProjectInitInput);
    case 'register':
      return rbookProjectRegister({
        projectRoot: params.projectRoot ?? '',
        name: params.name,
        setAsDefault: params.setAsDefault,
      } satisfies RbookProjectRegisterParams);
    case 'list':
      // s93-m11 (#606 g): list is read-classified, so it never prunes. validate=true reports the
      // registry's health; archiving entries is validate's or prune's job, both writes.
      if (params.prune === true) {
        return createError<RbookProjectResult>({
          code: 'INVALID_PARAMETER',
          message:
            'rbook_project(action="list") only reads the registry, so it does not take prune.',
          suggestion:
            'To archive the registry entries whose store is gone, call rbook_project(action="prune"), or rbook_project(action="validate", prune=true) to see the report first.',
        });
      }
      if (params.validate) {
        return rbookProjectValidate({} satisfies RbookProjectValidateParams);
      }
      return rbookProjectList({} satisfies RbookProjectListParams);
    case 'unregister':
      return rbookProjectUnregister({
        projectRoot: params.projectRoot ?? '',
      } satisfies RbookProjectUnregisterParams);
    case 'validate':
      return rbookProjectValidate({
        prune: params.prune,
      } satisfies RbookProjectValidateParams);
    case 'prune':
      return rbookProjectValidate({ prune: true } satisfies RbookProjectValidateParams);
    case 'update':
      return rbookProjectUpdate({
        projectRoot: params.projectRoot,
        projectType: params.projectType,
      } satisfies RbookProjectUpdateParams);
    case 'sweep':
      return rbookProjectSweep({
        instances: params.instances,
        statusFilter: params.statusFilter,
        itemType: params.itemType,
      });
    case 'share':
      return rbookProjectShare({
        projectRoot: params.projectRoot,
        authorName: params.authorName,
        via: params.via,
        confirm: params.confirm,
      });
    case 'invite':
      return rbookProjectInvite({
        projectRoot: params.projectRoot,
        name: params.name,
        role: params.role,
      });
    case 'join':
      return rbookProjectJoin({
        projectRoot: params.projectRoot,
        member: params.member,
        host: params.host,
        remoteRoot: params.remoteRoot,
        remoteNode: params.remoteNode,
        remoteBin: params.remoteBin,
        remoteConfigDir: params.remoteConfigDir,
        via: params.via,
        project: params.project,
      });
    case 'members':
      return rbookProjectMembers({ projectRoot: params.projectRoot });
    case 'remove':
      return rbookProjectRemove({ projectRoot: params.projectRoot, name: params.name });
    case 'sync':
      return rbookProjectSync({
        projectRoot: params.projectRoot,
        confirmOwner: params.confirmOwner,
      });
    case 'move':
      return rbookProjectMove({ projectRoot: params.projectRoot, to: params.to });
  }
}

export function formatProjectForLLM(
  action: string | undefined,
  result: RbookToolResult<RbookProjectResult>,
  params?: { validate?: boolean }
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute rbook_project', '', `Error: ${result.error.message}`];

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
    case 'init':
      return formatProjectInitForLLM(result as RbookToolResult<RbookProjectInitResult>);
    case 'register':
      return formatProjectRegisterForLLM(result as RbookToolResult<ProjectRegisterResult>);
    case 'list':
      if (params?.validate) {
        return formatProjectValidateForLLM(result as RbookToolResult<ProjectValidateResult>);
      }
      return formatProjectListForLLM(result as RbookToolResult<ProjectListResult>);
    case 'unregister':
      return formatProjectUnregisterForLLM(result as RbookToolResult<ProjectUnregisterResult>);
    case 'validate':
    case 'prune':
      return formatProjectValidateForLLM(result as RbookToolResult<ProjectValidateResult>);
    case 'update':
      return formatProjectUpdateForLLM(result as RbookToolResult<ProjectUpdateResult>);
    case 'sweep':
      return formatProjectSweepForLLM(result as RbookToolResult<SweepResult>);
    case 'share':
    case 'invite':
    case 'join':
    case 'members':
    case 'remove':
    case 'sync':
    case 'move':
      return formatSharedProjectForLLM(
        action as SharedProjectAction,
        result as RbookToolResult<SharedProjectResult>
      );
    default: {
      if (!result.success)
        return formatToolFailure('❌ Failed to execute rbook_project', result.error);
      const lines = ['✓ Project action completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
