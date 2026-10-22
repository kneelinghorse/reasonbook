// ABOUTME: Route consolidated decision actions through their published input contract.
// ABOUTME: Validate evidence shape without inventing unpublished minimum string lengths.

/**
 * rbook_decisions Tool
 *
 * Consolidated decisions tool with action parameter support.
 * Actions: list, search, update, review, batch_update, record.
 * Routes to existing decisions handlers without rewriting business logic.
 *
 * @module tools/rbook/rbook-decisions
 */

import { formatToolFailure } from './format-failure';
import { z } from 'zod';
import { createError, RbookErrors } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import { appendWarnings } from './format-warnings';
import type { ActionParamMap, RbookToolResult } from './types';
import {
  rbookDecisionsList,
  formatDecisionsListForLLM,
  type RbookDecisionsListParams,
  type RbookDecisionsListResult,
} from './rbook-decisions-list';
import {
  rbookDecisionsSearch,
  formatDecisionsSearchForLLM,
  type RbookDecisionsSearchParams,
  type RbookDecisionsSearchResult,
} from './rbook-decisions-search';
import {
  rbookDecisionsUpdate,
  formatDecisionsUpdateForLLM,
  type RbookDecisionsUpdateParams,
  type RbookDecisionsUpdateResult,
} from './rbook-decisions-update';
import {
  rbookDecisionsReview,
  formatDecisionsReviewForLLM,
  type RbookDecisionsReviewParams,
  type RbookDecisionsReviewResult,
} from './rbook-decisions-review';
import {
  rbookDecisionsRecord,
  formatDecisionsRecordForLLM,
  type RbookDecisionsRecordParams,
  type RbookDecisionsRecordResult,
} from './rbook-decisions-record';
import type { RbookDraftRecordResult } from './draft-approval';
import {
  rbookDecisionsBatchUpdate,
  formatDecisionsBatchUpdateForLLM,
  type RbookDecisionsBatchUpdateParams,
  type RbookDecisionsBatchUpdateResult,
} from './rbook-decisions-batch-update';
import {
  rbookDecisionsShow,
  formatDecisionsShowForLLM,
  type RbookDecisionsShowParams,
  type RbookDecisionsShowResult,
} from './rbook-decisions-show';

export const RBOOK_DECISIONS_ACTIONS = [
  'list',
  'search',
  'show',
  'update',
  'review',
  'batch_update',
  'record',
] as const;

export type RbookDecisionsAction = (typeof RBOOK_DECISIONS_ACTIONS)[number];

/** s86-m04 — which published parameter applies to which action (see action-params.ts). */
export const RBOOK_DECISIONS_ACTION_PARAMS: ActionParamMap<
  RbookDecisionsAction,
  RbookDecisionsParams
> = {
  list: [
    'action',
    'domain',
    'sprintId',
    'missionId',
    'since',
    'until',
    'page',
    'pageSize',
    'acrossProjects',
    'projectRoot',
  ],
  search: ['action', 'domain', 'sprintId', 'query', 'limit', 'projectRoot'],
  // s92-m08: expand one decision by id; retrieval answers carry previews.
  show: ['action', 'decisionId', 'projectRoot'],
  update: ['action', 'decisionId', 'supersededBy', 'status', 'projectRoot'],
  review: ['action', 'includeApproaching', 'projectRoot'],
  batch_update: ['action', 'status', 'decisionIds', 'projectRoot'],
  record: [
    'action',
    'content',
    'fromDraft',
    'context',
    'alternatives',
    'consequences',
    'deciders',
    'mode',
    'missionId',
    'sprintId',
    'supersedes',
    'evidence',
    'citesLearningIds',
    'domain',
    'projectRoot',
  ],
};

export type RbookDecisionsResult =
  | RbookDecisionsListResult
  | RbookDecisionsSearchResult
  | RbookDecisionsUpdateResult
  | RbookDecisionsReviewResult
  | RbookDecisionsBatchUpdateResult
  | RbookDecisionsRecordResult
  | RbookDraftRecordResult
  | RbookDecisionsShowResult;

export const rbookDecisionsSchema = z
  .object({
    action: z
      .enum(RBOOK_DECISIONS_ACTIONS)
      // s86-m04: DERIVED. Listed 3 of 5 — review and batch_update were unreachable by reading.
      .describe(`Decisions action: ${RBOOK_DECISIONS_ACTIONS.join(' | ')}`),
    // shared params
    domain: z.string().optional().describe('Filter by domain for list/search actions'),
    sprintId: z.string().optional().describe('Filter by sprint ID for list/search actions'),
    missionId: z.string().optional().describe('Only rows recorded for this mission'),
    // list params
    since: z.string().optional().describe('ISO date lower bound for list action'),
    until: z.string().optional().describe('ISO date upper bound for list action'),
    page: z.number().int().positive().optional().describe('Page number for list action'),
    pageSize: z.number().int().positive().max(100).optional().describe('Page size for list action'),
    acrossProjects: z
      .boolean()
      .optional()
      .describe('list action: fan out across all registered projects (cross-store portfolio view)'),
    // search params
    query: z.string().optional().describe('Search query for search action (required for search)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum results for search action'),
    // update params
    decisionId: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Decision ID for show/update actions'),
    supersededBy: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('ID of the decision that supersedes this one (for update action)'),
    status: z
      // s86-m04: matches the published JSON enum exactly. Fleet-verified safe — no stored
      // strategic_decisions.status across the 18 registered stores falls outside these four.
      .enum(['active', 'superseded', 'archived', 'stale'])
      .optional()
      .describe(
        'New status for update/batch_update action (active | superseded | archived | stale)'
      ),
    // review params
    includeApproaching: z
      .boolean()
      .optional()
      .describe('Include decisions approaching staleness in review (default true)'),
    // batch_update params
    decisionIds: z
      .array(z.number().int().positive())
      .optional()
      .describe('Array of decision IDs for batch_update action (max 100)'),
    // record params (s91-m04)
    content: z.string().optional().describe('Decision text for record action (required)'),
    context: z.string().optional().describe('record: reasons and background for the decision'),
    alternatives: z.array(z.string()).optional().describe('record: options considered'),
    consequences: z.string().optional().describe('record: effects and tradeoffs'),
    deciders: z.array(z.string()).optional().describe('record: who made the decision'),
    mode: z
      .literal('autonomous')
      .optional()
      .describe('record: declare autonomous work with no operator'),
    // s93-m06
    fromDraft: z
      .string()
      .optional()
      .describe(
        'record action: the Reasonbook draft id (P<n>) the operator just answered; its kind decides what is written'
      ),
    supersedes: z
      .array(z.number().int().positive())
      .optional()
      .describe('record action: existing decision IDs this decision supersedes'),
    evidence: z
      .array(z.object({ type: z.string(), id: z.string() }).strict())
      .optional()
      .describe('record action: TraceLab evidence references [{type, id}]'),
    citesLearningIds: z
      .array(z.number().int().positive())
      .optional()
      .describe('record action: learning IDs this decision cites (bumps last_reviewed_at)'),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
  })
  .strict();

export type RbookDecisionsParams = z.infer<typeof rbookDecisionsSchema>;

export const rbookDecisionsToolDefinition = {
  name: 'rbook_decisions',
  description:
    'Consolidated decisions tool with action parameter support. ' +
    'Actions: list, search, show, update, review, batch_update, record. ' +
    'Use show to read one decision in full by id: search results and mission start carry ' +
    '300-character previews. ' +
    'Use review to triage stale decisions with scores and suggested actions. ' +
    'Use batch_update to archive/supersede multiple decisions at once. ' +
    'Use record to write a decision without a session: one or two sentences state the choice, ' +
    'context holds the reasons, and consequences holds the effects. alternatives and deciders ' +
    'are optional string arrays. mode=autonomous declares work with no operator. Direct headlines ' +
    'over 600 UTF-16 units succeed with a length warning. Decision text is never amended in ' +
    'place: correct a decision by recording a new one with supersedes=[<old id>]. ' +
    'When the operator answers a Reasonbook draft (a "Would record:" line Reasonbook gave an id, P<n>), ' +
    'record it with fromDraft="P<n>": the record then says how the approval was known ' +
    '(approved, agent-judged or agent-attested), and a constraint, rule or profile draft is ' +
    'written as that kind. A subagent shares its parent session and binds as the parent.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...RBOOK_DECISIONS_ACTIONS],
        description: `Decisions action: ${RBOOK_DECISIONS_ACTIONS.join(' | ')}`,
      },
      domain: {
        type: 'string',
        description: "Filter by domain; for record, the row's project_domain",
      },
      sprintId: {
        type: 'string',
        description:
          'Filter by sprint ID; for record, an existing sprint to tag when missionId is absent',
      },
      missionId: {
        type: 'string',
        description:
          'Only rows recorded for this mission; for record, the mission to record it for (its sprint is used)',
      },
      content: { type: 'string', description: 'Decision text for record action (required)' },
      context: { type: 'string', description: 'record: reasons and background' },
      alternatives: {
        type: 'array',
        items: { type: 'string' },
        description: 'record: options considered',
      },
      consequences: { type: 'string', description: 'record: effects and tradeoffs' },
      deciders: {
        type: 'array',
        items: { type: 'string' },
        description: 'record: who made the decision',
      },
      mode: {
        type: 'string',
        enum: ['autonomous'],
        description: 'record: autonomous work with no operator',
      },
      fromDraft: {
        type: 'string',
        description:
          'record action: the Reasonbook draft id (P<n>) the operator just answered; its kind decides what is written',
      },
      supersedes: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'record action: existing decision IDs this decision supersedes; each is set superseded with a pointer to the new row in the same transaction',
      },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Evidence type' },
            id: { type: 'string', description: 'Evidence identifier' },
          },
          required: ['type', 'id'],
          additionalProperties: false,
        },
        description: 'record action: TraceLab evidence references [{type, id}]',
      },
      citesLearningIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description: 'record action: learning IDs this decision cites (bumps last_reviewed_at)',
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
          'list action: fan out across all registered projects (cross-store portfolio view)',
      },
      query: { type: 'string', description: 'Search query for search action' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum results for search action',
      },
      decisionId: {
        type: 'integer',
        minimum: 1,
        description: 'Decision ID for show/update actions',
      },
      supersededBy: {
        type: 'integer',
        minimum: 1,
        description: 'ID of the decision that supersedes this one (for update action)',
      },
      status: {
        type: 'string',
        enum: ['active', 'superseded', 'archived', 'stale'],
        description: 'New status for update/batch_update action',
      },
      includeApproaching: {
        type: 'boolean',
        description: 'Include decisions approaching staleness in review (default true)',
      },
      decisionIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description: 'Array of decision IDs for batch_update action (max 100)',
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

function isDecisionsAction(value: string): value is RbookDecisionsAction {
  return (RBOOK_DECISIONS_ACTIONS as readonly string[]).includes(value);
}

export async function rbookDecisions(
  params: RbookDecisionsParams
): Promise<RbookToolResult<RbookDecisionsResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isDecisionsAction(actionValue)) {
    return createError<RbookDecisionsResult>(
      RbookErrors.invalidAction('rbook_decisions', actionValue, RBOOK_DECISIONS_ACTIONS)
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookDecisionsToolDefinition.inputSchema,
    RBOOK_DECISIONS_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<RbookDecisionsResult>(wrongTypedParam);

  switch (actionValue) {
    case 'list':
      return rbookDecisionsList({
        domain: params.domain,
        sprintId: params.sprintId,
        missionId: params.missionId,
        since: params.since,
        until: params.until,
        page: params.page,
        pageSize: params.pageSize,
        projectRoot: params.projectRoot,
        acrossProjects: params.acrossProjects,
      } satisfies RbookDecisionsListParams);
    case 'search':
      return rbookDecisionsSearch({
        query: params.query ?? '',
        domain: params.domain,
        sprintId: params.sprintId,
        limit: params.limit,
        projectRoot: params.projectRoot,
      } satisfies RbookDecisionsSearchParams);
    case 'show':
      return rbookDecisionsShow({
        decisionId: params.decisionId ?? 0,
        projectRoot: params.projectRoot,
      } satisfies RbookDecisionsShowParams);
    case 'update':
      return rbookDecisionsUpdate({
        decisionId: params.decisionId ?? 0,
        supersededBy: params.supersededBy,
        status: params.status,
        projectRoot: params.projectRoot,
      } satisfies RbookDecisionsUpdateParams);
    case 'review':
      return rbookDecisionsReview({
        includeApproaching: params.includeApproaching,
        projectRoot: params.projectRoot,
      } satisfies RbookDecisionsReviewParams);
    case 'batch_update':
      return rbookDecisionsBatchUpdate({
        decisionIds: params.decisionIds ?? [],
        status: params.status ?? '',
        projectRoot: params.projectRoot,
      } satisfies RbookDecisionsBatchUpdateParams);
    case 'record':
      return rbookDecisionsRecord({
        content: params.content ?? '',
        fromDraft: params.fromDraft,
        context: params.context,
        alternatives: params.alternatives,
        consequences: params.consequences,
        deciders: params.deciders,
        mode: params.mode,
        missionId: params.missionId,
        sprintId: params.sprintId,
        supersedes: params.supersedes,
        evidence: params.evidence,
        citesLearningIds: params.citesLearningIds,
        domain: params.domain,
        projectRoot: params.projectRoot,
      } satisfies RbookDecisionsRecordParams);
  }
}

export function formatDecisionsForLLM(
  action: string | undefined,
  result: RbookToolResult<RbookDecisionsResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute rbook_decisions', '', `Error: ${result.error.message}`];

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
      return formatDecisionsListForLLM(result as RbookToolResult<RbookDecisionsListResult>);
    case 'search':
      return formatDecisionsSearchForLLM(result as RbookToolResult<RbookDecisionsSearchResult>);
    case 'show':
      return formatDecisionsShowForLLM(result as RbookToolResult<RbookDecisionsShowResult>);
    case 'update':
      return formatDecisionsUpdateForLLM(result as RbookToolResult<RbookDecisionsUpdateResult>);
    case 'review':
      return formatDecisionsReviewForLLM(result as RbookToolResult<RbookDecisionsReviewResult>);
    case 'batch_update':
      return formatDecisionsBatchUpdateForLLM(
        result as RbookToolResult<RbookDecisionsBatchUpdateResult>
      );
    case 'record':
      return formatDecisionsRecordForLLM(result as RbookToolResult<RbookDecisionsRecordResult>);
    default: {
      if (!result.success)
        return formatToolFailure('❌ Failed to execute rbook_decisions', result.error);
      const lines = ['✓ Decisions action completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
