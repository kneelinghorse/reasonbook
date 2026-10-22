/**
 * rbook_learnings Tool
 *
 * Consolidated learnings tool with action parameter support.
 * Actions: list, search, update.
 * Routes to existing learnings handlers without rewriting business logic.
 *
 * @module tools/rbook/rbook-learnings
 */

import { formatToolFailure } from './format-failure';
import { z } from 'zod';
import { createError, RbookErrors } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import { appendWarnings } from './format-warnings';
import type { ActionParamMap, RbookToolResult } from './types';
import {
  rbookLearningsList,
  rbookLearningsListAcrossProjects,
  formatLearningsListForLLM,
  type RbookLearningsListParams,
  type RbookLearningsListResult,
} from './rbook-learnings-list';
import {
  rbookLearningsSearch,
  formatLearningsSearchForLLM,
  type RbookLearningsSearchParams,
  type RbookLearningsSearchResult,
} from './rbook-learnings-search';
import {
  rbookLearningsUpdate,
  formatLearningsUpdateForLLM,
  type RbookLearningsUpdateParams,
  type RbookLearningsUpdateResult,
} from './rbook-learnings-update';
import {
  rbookLearningsReaffirm,
  formatLearningsReaffirmForLLM,
  type RbookLearningsReaffirmParams,
  type RbookLearningsReaffirmResult,
} from './rbook-learnings-reaffirm';
import {
  rbookLearningsShow,
  formatLearningsShowForLLM,
  type RbookLearningsShowParams,
  type RbookLearningsShowResult,
} from './rbook-learnings-show';

export const RBOOK_LEARNINGS_ACTIONS = ['list', 'search', 'show', 'update', 'reaffirm'] as const;

export type RbookLearningsAction = (typeof RBOOK_LEARNINGS_ACTIONS)[number];

/**
 * s86-m04 — which published parameter applies to which action. See action-params.ts for why this
 * is product data rather than a generated artifact.
 *
 * THE ENTRY THAT OPENED THIS ARC: `evergreen` appears under BOTH `update` and `reaffirm`. The
 * router forwarded it only to `update` until s86-m03, so `rbook_learnings(action="reaffirm",
 * evergreen=true)` reported success and wrote nothing — and no gate could see it, because
 * `RbookLearningsReaffirmParams` under-declared the key in the same way. Two lists claiming it is
 * what makes that class of defect red instead of silent.
 *
 * `learningId` likewise appears under `update` AND `reaffirm`. Its description used to read
 * "Learning ID for update action" — wrong in exactly the way this map exists to expose, since
 * per-action tables put that sentence under a `reaffirm` heading that contradicts it. Both the
 * description and the map now say update/reaffirm, and
 * tests/tools/rbook/action-clause-agreement.test.ts keeps them agreeing.
 */
export const RBOOK_LEARNINGS_ACTION_PARAMS: ActionParamMap<
  RbookLearningsAction,
  RbookLearningsParams
> = {
  list: [
    'action',
    'category',
    'sprintId',
    'missionId',
    'status',
    'since',
    'until',
    'page',
    'pageSize',
    'acrossProjects',
    'limit',
    'projectRoot',
  ],
  search: ['action', 'category', 'sprintId', 'query', 'limit', 'projectRoot'],
  // s92-m08: expand one learning by id; search answers carry previews.
  show: ['action', 'learningId', 'projectRoot'],
  update: ['action', 'status', 'learningId', 'evergreen', 'projectRoot'],
  reaffirm: ['action', 'learningId', 'evergreen', 'projectRoot'],
};

export type RbookLearningsResult =
  | RbookLearningsListResult
  | RbookLearningsSearchResult
  | RbookLearningsUpdateResult
  | RbookLearningsReaffirmResult
  | RbookLearningsShowResult;

export const rbookLearningsSchema = z
  .object({
    action: z
      .enum(RBOOK_LEARNINGS_ACTIONS)
      .describe(`Learnings action: ${RBOOK_LEARNINGS_ACTIONS.join(' | ')}`),
    // list params
    category: z
      .string()
      .optional()
      .describe(
        'Filter by category for list/search actions (technical | process | agent-behavior | tooling)'
      ),
    sprintId: z.string().optional().describe('Filter by sprint ID for list/search actions'),
    missionId: z.string().optional().describe('Only rows recorded for this mission'),
    status: z
      // s86-m04 (fork f04, fleet-resolved): four members, not three. Reasonbook through 3.2.0 wrote
      // 'stale' on its own (the old staleness flagger), and 246 such rows existed across 7 of 18
      // registered stores — so the published 3-member enum forbade callers from naming a value
      // the server had been writing for sprints. rbook_decisions never had this bug; that asymmetry
      // is the evidence the enum was wrong, not the data. s93-m11: Reasonbook no longer sets 'stale'
      // unasked (decision #1182); it stays a status a caller may set and filter on.
      .enum(['active', 'archived', 'superseded', 'stale'])
      .optional()
      .describe(
        'Filter by status for list action, or new status for update action (active | archived | superseded | stale)'
      ),
    since: z.string().optional().describe('ISO date lower bound for list action'),
    until: z.string().optional().describe('ISO date upper bound for list action'),
    page: z.number().int().positive().optional().describe('Page number for list action'),
    pageSize: z.number().int().positive().max(100).optional().describe('Page size for list action'),
    acrossProjects: z
      .boolean()
      .optional()
      .describe(
        'list action: learnings tagged `category` across all registered projects (cross-store portfolio view; requires category)'
      ),
    // search params
    query: z.string().optional().describe('Search query for search action (required for search)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Maximum results for search action, or the across-project cap for list action'),
    // update params
    learningId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Learning ID for show/update/reaffirm actions'),
    evergreen: z
      .boolean()
      .optional()
      .describe(
        'Toggle institutional-rule flag. Applies to the update and reaffirm actions. true = exclude from staleness signal; false = clear flag; omitted = leave unchanged.'
      ),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
  })
  .strict();

export type RbookLearningsParams = z.infer<typeof rbookLearningsSchema>;

export const rbookLearningsToolDefinition = {
  name: 'rbook_learnings',
  description:
    'Consolidated learnings tool with action parameter support. ' +
    `Actions: ${RBOOK_LEARNINGS_ACTIONS.join(', ')}. ` +
    'Use list to browse learnings with category/sprint/status filters. ' +
    'Use search to find learnings by keyword; results carry 300-character previews. ' +
    'Use show to read one learning in full by id. ' +
    'Use update to change status (active, archived, superseded). ' +
    'Use reaffirm to mark an evergreen learning as still valid (bumps last_reviewed_at without changing status).',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...RBOOK_LEARNINGS_ACTIONS],
        description: `Learnings action: ${RBOOK_LEARNINGS_ACTIONS.join(' | ')}`,
      },
      category: {
        type: 'string',
        // s86-m04 (fork f04): NO enum. `learnings.category` is `TEXT` with no CHECK constraint
        // (schema.ts), so publishing a closed set claimed an enforcement the server does not
        // perform — and the fleet already carries an out-of-set value ('voice', Writing-and-
        // Strategy). The four canonical values are guidance, not a contract.
        description: 'Filter by category. Commonly: technical | process | agent-behavior | tooling',
      },
      sprintId: { type: 'string', description: 'Filter by sprint ID' },
      missionId: {
        type: 'string',
        description: 'Only rows recorded for this mission',
      },
      status: {
        type: 'string',
        enum: ['active', 'archived', 'superseded', 'stale'],
        description: 'Filter by status (list) or new status (update)',
      },
      since: { type: 'string', description: 'ISO date lower bound for list action' },
      until: { type: 'string', description: 'ISO date upper bound for list action' },
      page: { type: 'integer', minimum: 1, description: 'Page number for list action' },
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Page size for list action',
      },
      acrossProjects: {
        type: 'boolean',
        description:
          'list action: learnings tagged `category` across all registered projects (cross-store portfolio view; requires category)',
      },
      query: { type: 'string', description: 'Search query for search action' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Maximum results for search action, or the across-project cap for list action',
      },
      learningId: {
        type: 'integer',
        minimum: 1,
        description: 'Learning ID for show/update/reaffirm actions',
      },
      evergreen: {
        type: 'boolean',
        description:
          'Toggle institutional-rule flag for the learning. Applies to the update and reaffirm actions. true = exclude from staleness signal; false = clear flag; omitted = leave unchanged.',
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

function isLearningsAction(value: string): value is RbookLearningsAction {
  return (RBOOK_LEARNINGS_ACTIONS as readonly string[]).includes(value);
}

export async function rbookLearnings(
  params: RbookLearningsParams
): Promise<RbookToolResult<RbookLearningsResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isLearningsAction(actionValue)) {
    return createError<RbookLearningsResult>(
      RbookErrors.invalidAction('rbook_learnings', actionValue, RBOOK_LEARNINGS_ACTIONS)
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookLearningsToolDefinition.inputSchema,
    RBOOK_LEARNINGS_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<RbookLearningsResult>(wrongTypedParam);

  switch (actionValue) {
    case 'list':
      // s79-m05: acrossProjects → the §5.4 "learnings tagged X" portfolio query
      // (graph-backed queryAcrossStores). index.ts skips local-root resolution.
      if (params.acrossProjects) {
        return rbookLearningsListAcrossProjects({
          category: params.category,
          limit: params.pageSize ?? params.limit,
        });
      }
      return rbookLearningsList({
        category: params.category,
        sprintId: params.sprintId,
        missionId: params.missionId,
        status: params.status,
        since: params.since,
        until: params.until,
        page: params.page,
        pageSize: params.pageSize,
        projectRoot: params.projectRoot,
      } satisfies RbookLearningsListParams);
    case 'search':
      return rbookLearningsSearch({
        query: params.query ?? '',
        category: params.category,
        sprintId: params.sprintId,
        limit: params.limit,
        projectRoot: params.projectRoot,
      } satisfies RbookLearningsSearchParams);
    case 'show':
      return rbookLearningsShow({
        learningId: params.learningId ?? 0,
        projectRoot: params.projectRoot,
      } satisfies RbookLearningsShowParams);
    case 'update':
      return rbookLearningsUpdate({
        learningId: params.learningId ?? 0,
        status: params.status,
        evergreen: params.evergreen,
        projectRoot: params.projectRoot,
      } satisfies RbookLearningsUpdateParams);
    case 'reaffirm':
      return rbookLearningsReaffirm({
        learningId: params.learningId ?? 0,
        // s86-m03: `evergreen` is declared on this router (zod :94-99 + JSON inputSchema :167-171)
        // with no action scoping, and is forwarded to `update` one branch above — but was dropped
        // here, so `rbook_learnings(action="reaffirm", evergreen=true)` returned success and wrote
        // nothing. A handler-only test would have passed throughout: rbookLearningsReaffirm never
        // received the value to ignore. The real-store read-back fire drives THIS ROUTER, not the
        // handler, and fails if this line is removed.
        evergreen: params.evergreen,
        projectRoot: params.projectRoot,
      } satisfies RbookLearningsReaffirmParams);
  }
}

export function formatLearningsForLLM(
  action: string | undefined,
  result: RbookToolResult<RbookLearningsResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute rbook_learnings', '', `Error: ${result.error.message}`];

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
      return formatLearningsListForLLM(result as RbookToolResult<RbookLearningsListResult>);
    case 'search':
      return formatLearningsSearchForLLM(result as RbookToolResult<RbookLearningsSearchResult>);
    case 'show':
      return formatLearningsShowForLLM(result as RbookToolResult<RbookLearningsShowResult>);
    case 'update':
      return formatLearningsUpdateForLLM(result as RbookToolResult<RbookLearningsUpdateResult>);
    case 'reaffirm':
      return formatLearningsReaffirmForLLM(result as RbookToolResult<RbookLearningsReaffirmResult>);
    default: {
      if (!result.success)
        return formatToolFailure('❌ Failed to execute rbook_learnings', result.error);
      const lines = ['✓ Learnings action completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
