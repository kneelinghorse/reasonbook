/**
 * rbook_session Tool
 *
 * Consolidated session tool with action parameter support.
 * Actions: list, start, capture, complete.
 * Routes to existing session handlers without rewriting business logic.
 *
 * @module tools/rbook/rbook-session
 */

import { formatToolFailure } from './format-failure';
import { z } from 'zod';
import { createError, RbookErrors, VALID_SESSION_TYPES } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import { appendWarnings } from './format-warnings';
import type { ActionParamMap, RbookToolResult } from './types';
import {
  rbookSessionList,
  formatSessionListForLLM,
  VALID_SESSION_STATUSES,
  type RbookSessionListParams,
  type RbookSessionListResult,
} from './rbook-session-list';
import {
  rbookSessionStart,
  formatSessionStartForLLM,
  type RbookSessionStartParams,
  type RbookSessionStartResult,
} from './rbook-session-start';
import {
  rbookSessionCapture,
  formatSessionCaptureForLLM,
  VALID_CAPTURE_CATEGORIES,
  type RbookSessionCaptureParams,
  type RbookSessionCaptureResult,
} from './rbook-session-capture';
import {
  rbookSessionComplete,
  formatSessionCompleteForLLM,
  type RbookSessionCompleteParams,
  type RbookSessionCompleteResult,
} from './rbook-session-complete';
import {
  rbookSessionSearch,
  formatSessionSearchForLLM,
  type RbookSessionSearchResult,
} from './rbook-session-search';
import { triggerCheckpointBackfill } from './checkpoint-backfill';
import { closeUploadReceipt } from './dashboard-upload-receipt';

export const RBOOK_SESSION_ACTIONS = ['list', 'start', 'capture', 'complete', 'search'] as const;

export type RbookSessionAction = (typeof RBOOK_SESSION_ACTIONS)[number];

/** s86-m04 — which published parameter applies to which action (see action-params.ts). */
export const RBOOK_SESSION_ACTION_PARAMS: ActionParamMap<RbookSessionAction, RbookSessionParams> = {
  list: ['action', 'status', 'type', 'sprintId', 'sessionId', 'page', 'pageSize', 'projectRoot'],
  start: [
    'action',
    'type',
    'sprintId',
    'title',
    'agent',
    'autoRefreshMasterContext',
    'projectRoot',
  ],
  capture: [
    'action',
    'agent',
    'sessionId',
    'category',
    'content',
    'context',
    'expiresAt',
    'missionId',
    'evidence',
    'citesLearningIds',
    'evergreen',
    'sprintId',
    'projectRoot',
  ],
  complete: [
    'action',
    'agent',
    'sessionId',
    'missionId',
    'citesLearningIds',
    'summary',
    'nextSteps',
    'decisions',
    'agentFeedback',
    'projectRoot',
  ],
  search: ['action', 'query', 'since', 'until', 'limit', 'type', 'category', 'projectRoot'],
};

export type RbookSessionResult =
  | RbookSessionListResult
  | RbookSessionStartResult
  | RbookSessionCaptureResult
  | RbookSessionCompleteResult
  | RbookSessionSearchResult;

export const rbookSessionSchema = z
  .object({
    action: z
      .enum(RBOOK_SESSION_ACTIONS)
      .describe('Session action: list | start | capture | complete | search'),
    // search params (s77-m05) — query/since/until/limit; type/category reused below
    query: z
      .string()
      .optional()
      .describe('Search query for search action (keywords across titles, summaries, captures)'),
    since: z.string().optional().describe('Filter sessions started after this ISO date (search)'),
    until: z.string().optional().describe('Filter sessions started before this ISO date (search)'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum sessions to return for search action (1-100, default: 20)'),
    // list params
    status: z
      .enum(VALID_SESSION_STATUSES)
      .optional()
      .describe('Filter by session status for list action'),
    type: z
      .enum(VALID_SESSION_TYPES)
      .optional()
      .describe('Session type for list/start/search actions'),
    sprintId: z
      .string()
      .optional()
      .describe(
        'Sprint ID filter for list action; for start and capture actions, an existing sprint (any status) to tag. A sprint that does not exist is refused by name'
      ),
    page: z.number().int().positive().optional().describe('Page number for list action'),
    pageSize: z.number().int().positive().max(100).optional().describe('Page size for list action'),
    // start params
    title: z.string().optional().describe('Session title for start action (required for start)'),
    agent: z.string().optional().describe('Agent identifier for start/capture/complete actions'),
    autoRefreshMasterContext: z
      .boolean()
      .optional()
      .describe('Auto-refresh master context on start'),
    // capture params
    sessionId: z
      .string()
      .optional()
      .describe(
        'capture/complete: the session to write; omit it for the session your writes land in (an open explicit session, else your own implicit one). list: only this session, to read its summary in full'
      ),
    category: z
      .enum(VALID_CAPTURE_CATEGORIES)
      .optional()
      .describe(
        'Capture category for capture action, or category filter for search action (required for capture)'
      ),
    content: z
      .string()
      .optional()
      .describe('Capture content for capture action (required for capture)'),
    context: z.string().optional().describe('Additional context for capture action'),
    expiresAt: z
      .string()
      .optional()
      .describe(
        'Optional expiry date for constraint captures (ISO 8601, e.g. "2026-03-20T00:00:00Z"). Applies to capture(category="constraint") and to constraints materialized from that capture at session complete.'
      ),
    missionId: z
      .string()
      .optional()
      .describe(
        'Associated mission ID. On capture, stamps the decision, learning or next-step row it writes; on complete, stamps the decisions[] and nextSteps[] rows this call materializes.'
      ),
    evidence: z
      .array(z.object({ type: z.string(), id: z.string() }))
      .optional()
      .describe('Array of TraceLab evidence references [{type, id}] for decision captures'),
    citesLearningIds: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        'Learning IDs this capture/decision cites. Bumps last_reviewed_at on each — applies to capture(category=decision|learning) and complete(decisions[]).'
      ),
    evergreen: z
      .boolean()
      .optional()
      .describe(
        'Whether a learning is exempt from staleness archival. Applies only to category="learning" on the capture action.'
      ),
    // complete params
    summary: z
      .string()
      .optional()
      .describe('Session summary for complete action (required for complete)'),
    nextSteps: z.array(z.string()).optional().describe('Next steps for complete action'),
    decisions: z
      .array(z.string())
      .optional()
      .describe(
        'Decisions captured at session close; each entry is inserted into strategic_decisions'
      ),
    agentFeedback: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Optional free-text UX feedback logged to the agent_feedback channel at session close. Use it to flag rough edges you hit while working. Reviewed via rbook_feedback(action="list").'
      ),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
  })
  .strict();

export type RbookSessionParams = z.infer<typeof rbookSessionSchema>;

export const rbookSessionToolDefinition = {
  name: 'rbook_session',
  description:
    'Consolidated session tool with action parameter support. ' +
    'Actions: list, start, capture, complete, search. ' +
    "Sessions are optional: a capture with no session open lands in the caller's implicit " +
    'session, opened as needed and closed when the conversation (without hooks, the server process) ends. ' +
    'Routes to the existing session handlers without changing session business logic.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...RBOOK_SESSION_ACTIONS],
        description: 'Session action: list | start | capture | complete | search',
      },
      query: {
        type: 'string',
        description: 'Search query for search action (keywords across titles, summaries, captures)',
      },
      since: {
        type: 'string',
        description: 'Filter sessions started after this ISO date (search action)',
      },
      until: {
        type: 'string',
        description: 'Filter sessions started before this ISO date (search action)',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum sessions to return for search action (1-100, default: 20)',
      },
      status: {
        type: 'string',
        enum: [...VALID_SESSION_STATUSES],
        description: 'Filter by session status for list action',
      },
      type: {
        type: 'string',
        enum: [...VALID_SESSION_TYPES],
        description: 'Session type for list/start/search actions',
      },
      sprintId: {
        type: 'string',
        description:
          'Sprint ID filter for list action; for start and capture actions, an existing sprint (any status) to tag. A sprint that does not exist is refused by name',
      },
      page: { type: 'integer', minimum: 1, description: 'Page number for list action' },
      pageSize: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Page size for list action',
      },
      title: { type: 'string', description: 'Session title for start action' },
      agent: { type: 'string', description: 'Agent identifier for start/capture/complete actions' },
      autoRefreshMasterContext: {
        type: 'boolean',
        description: 'Auto-refresh master context on start',
      },
      sessionId: {
        type: 'string',
        description:
          'capture/complete: the session to write; omit it for the session your writes land in (an open explicit session, else your own implicit one). list: only this session, to read its summary in full',
      },
      category: {
        type: 'string',
        enum: [...VALID_CAPTURE_CATEGORIES],
        description: 'Capture category for capture action, or category filter for search action',
      },
      content: { type: 'string', description: 'Capture content for capture action' },
      context: { type: 'string', description: 'Additional context for capture action' },
      expiresAt: {
        type: 'string',
        description:
          'Optional expiry date for constraint captures (ISO 8601, e.g. "2026-03-20T00:00:00Z"). Applies to capture(category="constraint") and to constraints materialized from that capture at session complete.',
      },
      missionId: {
        type: 'string',
        description:
          'Associated mission ID. On capture, stamps the decision, learning or next-step row it writes; on complete, stamps the decisions[] and nextSteps[] rows this call materializes.',
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
        },
        description: 'Array of TraceLab evidence references [{type, id}] for decision captures',
      },
      citesLearningIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'Learning IDs this capture/decision cites. Bumps last_reviewed_at on each — applies to capture(category=decision|learning) and complete(decisions[]).',
      },
      evergreen: {
        type: 'boolean',
        description:
          'Whether a learning is exempt from staleness archival. Applies only to category="learning" on the capture action.',
      },
      summary: { type: 'string', description: 'Session summary for complete action' },
      nextSteps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Next steps for complete action',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Decisions captured at session close; each entry is inserted into strategic_decisions',
      },
      agentFeedback: {
        type: 'string',
        maxLength: 2000,
        description:
          'Optional free-text UX feedback logged to the agent_feedback channel at session close. Use it to flag rough edges you hit while working. Reviewed via rbook_feedback(action="list").',
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

function isSessionAction(value: string): value is RbookSessionAction {
  return (RBOOK_SESSION_ACTIONS as readonly string[]).includes(value);
}

export async function rbookSession(
  params: RbookSessionParams
): Promise<RbookToolResult<RbookSessionResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isSessionAction(actionValue)) {
    return createError<RbookSessionResult>(
      RbookErrors.invalidAction('rbook_session', actionValue, RBOOK_SESSION_ACTIONS)
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookSessionToolDefinition.inputSchema,
    RBOOK_SESSION_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<RbookSessionResult>(wrongTypedParam);

  switch (actionValue) {
    case 'list':
      return rbookSessionList({
        status: params.status,
        type: params.type,
        sprintId: params.sprintId,
        sessionId: params.sessionId,
        page: params.page,
        pageSize: params.pageSize,
        projectRoot: params.projectRoot,
      } as RbookSessionListParams);
    case 'start':
      return rbookSessionStart({
        type: params.type ?? ('planning' as RbookSessionStartParams['type']),
        title: params.title ?? '',
        agent: params.agent,
        sprintId: params.sprintId,
        autoRefreshMasterContext: params.autoRefreshMasterContext,
        projectRoot: params.projectRoot,
      } as RbookSessionStartParams);
    case 'capture':
      return rbookSessionCapture({
        sessionId: params.sessionId,
        category: params.category ?? ('context' as RbookSessionCaptureParams['category']),
        content: params.content ?? '',
        context: params.context,
        // s86-m03: declared on the DEPRECATED standalone rbook_session_capture definition
        // (rbook-session-capture.ts:186/:275) — which is not a published surface — but never on
        // this router, so no agent could set it and both constraint write paths saw undefined.
        expiresAt: params.expiresAt,
        missionId: params.missionId,
        evidence: params.evidence,
        agent: params.agent,
        citesLearningIds: params.citesLearningIds,
        evergreen: params.evergreen,
        sprintId: params.sprintId,
        projectRoot: params.projectRoot,
      } as RbookSessionCaptureParams);
    case 'complete': {
      const result = await rbookSessionComplete({
        sessionId: params.sessionId,
        summary: params.summary ?? '',
        nextSteps: params.nextSteps,
        decisions: params.decisions,
        // s85-m04: `missionId` is declared on this router (zod + JSON inputSchema) and was
        // forwarded to `capture` but NOT here — so wiring it into rbookSessionComplete alone
        // would pass every handler test and ship DEAD over the real MCP surface, silently
        // returning null. That is the s80-m07 shape. The real-store positive fire drives this
        // router, not the handler, and fails if this line is removed.
        missionId: params.missionId,
        // s86-m03: rbook-feedback.ts documents three writable surfaces for the agent_feedback
        // channel; only two were reachable. rbook-session-complete.ts declares and records
        // `agentFeedback`, but the string appeared ZERO times in this router — no schema key and
        // no forward — so `rbook_session(action="complete", agentFeedback=…)` was silently dropped.
        agentFeedback: params.agentFeedback,
        agent: params.agent,
        citesLearningIds: params.citesLearningIds,
        projectRoot: params.projectRoot,
      } as RbookSessionCompleteParams);
      if (result.success && result.data) {
        result.data.dashboardUpload = await closeUploadReceipt(params.projectRoot);
        triggerCheckpointBackfill({ projectRoot: params.projectRoot, force: false });
      }
      return result;
    }
    case 'search':
      // `?? ''` mirrors start/capture: a missing query reaches the handler as ''
      // and surfaces its own MISSING_PARAMETER('query').
      return rbookSessionSearch({
        query: params.query ?? '',
        category: params.category,
        type: params.type,
        since: params.since,
        until: params.until,
        limit: params.limit,
        projectRoot: params.projectRoot,
      });
  }
}

export function formatSessionForLLM(
  action: string | undefined,
  result: RbookToolResult<RbookSessionResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute rbook_session', '', `Error: ${result.error.message}`];

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
      return formatSessionListForLLM(result as RbookToolResult<RbookSessionListResult>);
    case 'start':
      return formatSessionStartForLLM(result as RbookToolResult<RbookSessionStartResult>);
    case 'capture':
      return formatSessionCaptureForLLM(result as RbookToolResult<RbookSessionCaptureResult>);
    case 'complete':
      return formatSessionCompleteForLLM(result as RbookToolResult<RbookSessionCompleteResult>);
    case 'search':
      return formatSessionSearchForLLM(result as RbookToolResult<RbookSessionSearchResult>);
    default: {
      if (!result.success)
        return formatToolFailure('❌ Failed to execute rbook_session', result.error);
      const lines = ['✓ Session action completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
