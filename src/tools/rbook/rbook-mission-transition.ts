/**
 * rbook_mission_transition Tool
 *
 * Consolidated mission state-machine tool with action parameter support.
 * Actions: start, complete, block, unblock.
 * Kept separate from rbook_mission per architectural decision to reduce
 * parameter hallucination risk around state transitions.
 *
 * @module tools/rbook/rbook-mission-transition
 */

import { z } from 'zod';
import { createError, RbookErrors } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import { appendWarnings } from './format-warnings';
import type { ActionParamMap, RbookToolResult } from './types';
import {
  rbookMissionStart,
  formatMissionStartForLLM,
  type MissionStartResult,
} from './rbook-mission-start';
import {
  rbookMissionComplete,
  formatMissionCompleteForLLM,
  type RbookMissionCompleteParams,
  type MissionCompleteResult,
} from './rbook-mission-complete';
import {
  rbookMissionBlock,
  formatMissionBlockForLLM,
  type RbookMissionBlockParams,
  type MissionBlockResult,
} from './rbook-mission-block';
import {
  rbookMissionUnblock,
  formatMissionUnblockForLLM,
  type RbookMissionUnblockParams,
  type MissionUnblockResult,
} from './rbook-mission-unblock';
import {
  rbookMissionDrop,
  formatMissionDropForLLM,
  type RbookMissionDropParams,
  type MissionDropResult,
} from './rbook-mission-drop';
import {
  rbookMissionDefer,
  formatMissionDeferForLLM,
  type RbookMissionDeferParams,
  type MissionDeferResult,
} from './rbook-mission-defer';
import { maybePropagateMissionStatus, maybePropagateSprintStatus } from './sync-locks';

export const RBOOK_MISSION_TRANSITION_ACTIONS = [
  'start',
  'complete',
  'block',
  'unblock',
  'drop',
  'defer',
] as const;

export type RbookMissionTransitionAction = (typeof RBOOK_MISSION_TRANSITION_ACTIONS)[number];

/** s86-m04 — which published parameter applies to which action (see action-params.ts). */
export const RBOOK_MISSION_TRANSITION_ACTION_PARAMS: ActionParamMap<
  RbookMissionTransitionAction,
  RbookMissionTransitionParams
> = {
  start: ['action', 'missionId', 'notes', 'targetStatus', 'projectRoot'],
  complete: ['action', 'missionId', 'notes', 'decisions', 'agentFeedback', 'projectRoot'],
  block: ['action', 'missionId', 'reason', 'blockers', 'projectRoot'],
  unblock: ['action', 'missionId', 'resolution', 'targetStatus', 'projectRoot'],
  drop: ['action', 'missionId', 'reason', 'projectRoot'],
  defer: ['action', 'missionId', 'reason', 'deferUntil', 'projectRoot'],
};

export type RbookMissionTransitionResult =
  | MissionStartResult
  | MissionCompleteResult
  | MissionBlockResult
  | MissionUnblockResult
  | MissionDropResult
  | MissionDeferResult;

export const rbookMissionTransitionSchema = z
  .object({
    action: z
      .enum(RBOOK_MISSION_TRANSITION_ACTIONS)
      .describe('Transition action: start | complete | block | unblock | drop | defer'),
    missionId: z.string().describe('The mission ID to transition'),
    notes: z.string().optional().describe('Notes for start/complete actions'),
    reason: z
      .string()
      .optional()
      .describe('Reason for block/drop/defer actions (required for block)'),
    blockers: z.array(z.string()).optional().describe('List of blockers for block action'),
    decisions: z
      .array(z.string())
      .optional()
      .describe('Decisions made during mission for complete action'),
    resolution: z.string().optional().describe('Resolution notes for unblock action'),
    targetStatus: z
      .enum(['In Progress', 'Current'])
      .optional()
      .describe(
        'unblock: the status after it (default In Progress); start: Current promotes without starting'
      ),
    deferUntil: z
      .string()
      .optional()
      .describe('Hint about when to re-queue for defer action (e.g., "after sprint 48")'),
    agentFeedback: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Optional free-text UX feedback. Use on complete actions to flag rough edges or improvement ideas you hit while working the mission. Reviewed via rbook_feedback(action="list").'
      ),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
  })
  .strict();

export type RbookMissionTransitionParams = z.infer<typeof rbookMissionTransitionSchema>;

export const rbookMissionTransitionToolDefinition = {
  name: 'rbook_mission_transition',
  description:
    'Consolidated mission state-machine tool with action parameter support. ' +
    'Actions: start, complete, block, unblock, drop, defer. ' +
    'Enforces state-machine rules and logs transition events.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...RBOOK_MISSION_TRANSITION_ACTIONS],
        description: 'Transition action: start | complete | block | unblock | drop | defer',
      },
      missionId: {
        type: 'string',
        description: 'The mission ID to transition',
      },
      notes: {
        type: 'string',
        description: 'Notes for start/complete actions',
      },
      reason: {
        type: 'string',
        description: 'Reason for block/drop/defer actions (required for block)',
      },
      blockers: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of blockers for block action',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Decisions made during mission for complete action. Prefer notes-only completion and ' +
          'rbook_decisions(action="record", missionId) per decision: a host that absorbs this array ' +
          'into notes makes the server refuse the completion.',
      },
      resolution: {
        type: 'string',
        description: 'Resolution notes for unblock action',
      },
      targetStatus: {
        type: 'string',
        enum: ['In Progress', 'Current'],
        description:
          'unblock: the status after it (default In Progress); start: Current promotes without starting',
      },
      deferUntil: {
        type: 'string',
        description: 'Hint about when to re-queue for defer action (e.g., "after sprint 48")',
      },
      agentFeedback: {
        type: 'string',
        maxLength: 2000,
        description:
          'Optional free-text UX feedback. Use on complete actions to flag rough edges or improvement ideas you hit while working the mission. Reviewed via rbook_feedback(action="list").',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['action', 'missionId'],
    additionalProperties: false,
  },
} as const;

function isTransitionAction(value: string): value is RbookMissionTransitionAction {
  return (RBOOK_MISSION_TRANSITION_ACTIONS as readonly string[]).includes(value);
}

export async function rbookMissionTransition(
  params: RbookMissionTransitionParams
): Promise<RbookToolResult<RbookMissionTransitionResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isTransitionAction(actionValue)) {
    return createError<RbookMissionTransitionResult>(
      RbookErrors.invalidAction(
        'rbook_mission_transition',
        actionValue,
        RBOOK_MISSION_TRANSITION_ACTIONS
      )
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookMissionTransitionToolDefinition.inputSchema,
    RBOOK_MISSION_TRANSITION_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<RbookMissionTransitionResult>(wrongTypedParam);

  // On a COLLAB store, every status transition is a mutable-surface edit that must
  // propagate to the broker per-field (m05). We wrap the handler result in a single
  // place — the dispatcher — rather than touch each handler: it reads the authoritative
  // POST-transition status and pushes it under a soft-lock. RESILIENT — a sync failure
  // never fails the local transition (folded into warnings); a SOLO store is untouched.
  switch (actionValue) {
    case 'start': {
      let started = await rbookMissionStart({
        missionId: params.missionId,
        notes: params.notes,
        targetStatus: params.targetStatus,
        projectRoot: params.projectRoot,
      });
      if (started.success && started.data?.activatedSprintId) {
        started = await maybePropagateSprintStatus(
          started,
          started.data.activatedSprintId,
          params.projectRoot
        );
      }
      return maybePropagateMissionStatus(started, params.missionId, params.projectRoot);
    }
    case 'complete':
      return maybePropagateMissionStatus(
        await rbookMissionComplete({
          missionId: params.missionId,
          notes: params.notes,
          decisions: params.decisions,
          agentFeedback: params.agentFeedback,
          projectRoot: params.projectRoot,
        } satisfies RbookMissionCompleteParams),
        params.missionId,
        params.projectRoot
      );
    case 'block':
      return maybePropagateMissionStatus(
        await rbookMissionBlock({
          missionId: params.missionId,
          reason: params.reason ?? '',
          blockers: params.blockers,
          projectRoot: params.projectRoot,
        } satisfies RbookMissionBlockParams),
        params.missionId,
        params.projectRoot
      );
    case 'unblock':
      return maybePropagateMissionStatus(
        await rbookMissionUnblock({
          missionId: params.missionId,
          resolution: params.resolution,
          targetStatus: params.targetStatus,
          projectRoot: params.projectRoot,
        } satisfies RbookMissionUnblockParams),
        params.missionId,
        params.projectRoot
      );
    case 'drop':
      return maybePropagateMissionStatus(
        await rbookMissionDrop({
          missionId: params.missionId,
          reason: params.reason,
          projectRoot: params.projectRoot,
        } satisfies RbookMissionDropParams),
        params.missionId,
        params.projectRoot
      );
    case 'defer':
      return maybePropagateMissionStatus(
        await rbookMissionDefer({
          missionId: params.missionId,
          reason: params.reason,
          deferUntil: params.deferUntil,
          projectRoot: params.projectRoot,
        } satisfies RbookMissionDeferParams),
        params.missionId,
        params.projectRoot
      );
  }
}

export function formatMissionTransitionForLLM(
  action: string | undefined,
  result: RbookToolResult<RbookMissionTransitionResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = [
      '❌ Failed to execute rbook_mission_transition',
      '',
      `Error: ${result.error.message}`,
    ];

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
    case 'start':
      return formatMissionStartForLLM(result as RbookToolResult<MissionStartResult>);
    case 'complete':
      return formatMissionCompleteForLLM(result as RbookToolResult<MissionCompleteResult>);
    case 'block':
      return formatMissionBlockForLLM(result as RbookToolResult<MissionBlockResult>);
    case 'unblock':
      return formatMissionUnblockForLLM(result as RbookToolResult<MissionUnblockResult>);
    case 'drop':
      return formatMissionDropForLLM(result as RbookToolResult<MissionDropResult>);
    case 'defer':
      return formatMissionDeferForLLM(result as RbookToolResult<MissionDeferResult>);
    default: {
      if (!result.success) return '❌ Failed to execute rbook_mission_transition';
      const lines = ['✓ Mission transition completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
