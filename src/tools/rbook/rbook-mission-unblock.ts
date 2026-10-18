/**
 * rbook_mission_unblock Tool
 *
 * MCP tool for unblocking a mission - transitions from Blocked to In Progress or Current.
 * Validates state transitions and returns actionable errors.
 *
 * @module tools/rbook/rbook-mission-unblock
 */

import { normalizeMissionStatus } from './terminal-status';
import { z } from 'zod';
import { withClientValidated } from './client';
import type { RbookToolResult, Mission, MissionStatus } from './types';
import {
  createError,
  createSuccess,
  RbookErrors,
  RBOOK_ERROR_CODES,
  VALID_STATE_TRANSITIONS,
} from './errors';
import { ensureMissionTimestamps } from './schema-migrations';
import { appendWarnings, attachWarnings } from './format-warnings';
import { checkWrite } from './write-guard';
import { recordedExecute } from './record-changes';

/**
 * Result of unblocking a mission.
 */
export interface MissionUnblockResult {
  /** The mission ID that was unblocked */
  missionId: string;

  /** Previous status before transition (always 'Blocked') */
  previousStatus: MissionStatus;

  /** Current status after transition */
  currentStatus: MissionStatus;

  /** Resolution notes */
  resolution: string | null;

  /** Human-readable message */
  message: string;

  /** Timestamp when mission was unblocked */
  unblockedAt: string;
}

/**
 * Input parameters schema for rbook_mission_unblock tool.
 */
export const rbookMissionUnblockSchema = z.object({
  /** The mission ID to unblock */
  missionId: z.string().min(1).describe('The mission ID to unblock (e.g., "s12-m06")'),

  /** Optional resolution notes explaining how the blocker was resolved */
  resolution: z
    .string()
    .optional()
    .describe('Optional notes explaining how the blocker was resolved'),

  /** Target status after unblock (default: 'In Progress') */
  targetStatus: z
    .enum(['In Progress', 'Current'])
    .optional()
    .describe('Target status after unblocking (default: "In Progress")'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookMissionUnblockParams = z.infer<typeof rbookMissionUnblockSchema>;

/**
 * MCP Tool Definition for rbook_mission_unblock.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const rbookMissionUnblockToolDefinition = {
  name: 'rbook_mission_unblock',
  description:
    'Unblock a mission by transitioning it from Blocked to In Progress or Current status. ' +
    'Only valid from Blocked status. ' +
    'Optionally include resolution notes to document how the blocker was resolved. ' +
    'Returns INVALID_STATE_TRANSITION error if the mission is not blocked.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to unblock (e.g., "s12-m06")',
      },
      resolution: {
        type: 'string',
        description: 'Optional notes explaining how the blocker was resolved',
      },
      targetStatus: {
        type: 'string',
        enum: ['In Progress', 'Current'],
        description: 'Target status after unblocking (default: "In Progress")',
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
 * s87-m01 — the remedy `unblock` offers when the mission is not blocked, derived from the status
 * it is actually answering rather than prescribed uniformly.
 *
 * Each arm was checked by EXECUTING the remedy from the state it is offered in
 * (`tests/tools/rbook/remedy-reachability.test.ts`, TIER 2). Where the remedy only works after
 * another step, the string says so — a conditional remedy stated as unconditional is the same
 * defect as a remedy that crashes, one notch quieter.
 */
function unblockNotBlockedSuggestion(missionId: string, currentStatus: string): string {
  const startCall = `rbook_mission_transition(action="start", missionId="${missionId}")`;
  const requeueCall = `rbook_mission(action="update", missionId="${missionId}", fields={"status":"Queued"})`;
  switch (currentStatus) {
    case 'Queued':
    case 'Current':
      // `start` is a valid transition from both — the one case where the old text was right.
      return `The mission is not blocked, so there is no blocker to clear. Use ${startCall} to begin work on it.`;
    case 'In Progress':
      return `The mission is already In Progress — there is no blocker to clear and nothing to restart.`;
    case 'Completed':
      return `A completed mission has no blocker to clear; its status is settled. Other fields can still be edited with rbook_mission(action="update").`;
    case 'Dropped':
      return `Dropped is a terminal status: no status transition out of it is permitted, so there is nothing to unblock and it cannot be restarted.`;
    case 'Deferred':
      return `Deferred work is parked, not blocked. It cannot start directly — re-queue it first with ${requeueCall}, and only then ${startCall}.`;
    default:
      // Not a key of VALID_STATE_TRANSITIONS at all. Say that, rather than prescribing a
      // transition against a state machine that has never heard of this status.
      return `Mission '${missionId}' has unrecognized status '${currentStatus}', so whether it can still be worked is unknown — it is not blocked, and refusing to guess. Set a recognized status first with ${requeueCall}, then retry.`;
  }
}

/**
 * Execute the rbook_mission_unblock tool.
 *
 * Transitions a mission from Blocked to In Progress (default) or Current.
 * Clears blocker information and optionally records resolution notes.
 *
 * @param params - Tool parameters (missionId, resolution, targetStatus, projectRoot)
 * @returns RbookToolResult with unblock result or actionable error
 */
export async function rbookMissionUnblock(
  params: RbookMissionUnblockParams
): Promise<RbookToolResult<MissionUnblockResult>> {
  // Validate required parameter
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(RbookErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = params.targetStatus ?? 'In Progress';

  const warnings: string[] = [];
  const result = await withClientValidated(
    (client) => {
      // Query mission by ID
      const missionResult = client.getOne<Mission>(
        `
        SELECT id, status, name, domain_fields
        FROM missions
        WHERE id = ?
      `,
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionUnblockResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionUnblockResult>(RbookErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = normalizeMissionStatus(mission.status);

      // Check if mission is blocked
      if (currentStatus !== 'Blocked') {
        // s87-m01, TIER 2 (disclosed remedies). The old text prescribed
        // `rbook_mission_transition(action="start")` for EVERY non-Completed status. Measured
        // against the real router: `start` REFUSES from 'In Progress' (already there),
        // from 'Dropped' (terminal, empty transition list) and from 'Deferred' (which reaches
        // Queued/Current/Dropped, never 'In Progress' directly). Three of the six states it was
        // offered in. A remedy prescribed where it cannot run is the defect this sprint is named
        // for, so the string is now derived from the status it is answering — and where a remedy
        // is genuinely conditional, it says so rather than being quietly dropped.
        return createError<MissionUnblockResult>({
          code: RBOOK_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Mission '${missionId}' is not blocked (current status: ${currentStatus})`,
          currentState: currentStatus,
          suggestion: unblockNotBlockedSuggestion(missionId, currentStatus),
        });
      }

      // Validate target status is a valid transition from Blocked
      const validTransitions = VALID_STATE_TRANSITIONS['Blocked'];
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionUnblockResult>(
          RbookErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      // Perform the update
      const now = new Date().toISOString();

      // Update domain_fields to clear blocker information but preserve history
      let existingDomainFields: Record<string, unknown> = {};
      if (mission.domain_fields) {
        try {
          existingDomainFields = JSON.parse(mission.domain_fields);
        } catch {
          existingDomainFields = {};
        }
      }

      // Preserve previous blocker info for history, clear active blocker
      const previousBlocker = existingDomainFields.blocker;
      const previousBlockedSince = existingDomainFields.blockedSince;

      const updatedDomainFields = {
        ...existingDomainFields,
        blocker: null,
        blockedSince: null,
        blockers: null,
        unblockedAt: now,
        previousBlocker,
        previousBlockedSince,
        resolution: params.resolution ?? null,
      };

      // Build note text
      const unblockNote = params.resolution
        ? `[Unblocked] ${params.resolution}`
        : `[Unblocked] Blocker resolved`;

      // Ensure timestamp columns exist (migration)
      warnings.push(...(ensureMissionTimestamps(client).warnings ?? []));

      const updateResult = recordedExecute(
        client,
        `
        UPDATE missions
        SET status = ?,
            domain_fields = ?,
            notes = COALESCE(notes || ' | ', '') || ?,
            updated_at = ?
        WHERE id = ?
      `,
        [targetStatus, JSON.stringify(updatedDomainFields), unblockNote, now, missionId]
      );

      if (!updateResult.success) {
        return createError<MissionUnblockResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
        );
      }

      if (updateResult.data?.changes === 0) {
        return createError<MissionUnblockResult>({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      // Log the state change to session_events
      const eventResult = client.execute(
        `
        INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
        VALUES (?, 'mcp-tool', ?, 'unblock', ?, ?, ?)
      `,
        [
          now,
          missionId,
          targetStatus,
          params.resolution ?? `Unblocked mission ${missionId}`,
          JSON.stringify({
            tool: 'rbook_mission_unblock',
            missionId,
            previousStatus: currentStatus,
            newStatus: targetStatus,
            resolution: params.resolution,
            previousBlocker,
          }),
        ]
      );

      // Don't fail the operation if event logging fails (non-critical) — but say so.
      if (!checkWrite(eventResult, warnings, 'mission unblock event logging')) {
        console.warn('Failed to log mission unblock event:', eventResult.error);
      }

      return createSuccess<MissionUnblockResult>(
        {
          missionId,
          previousStatus: currentStatus,
          currentStatus: targetStatus,
          resolution: params.resolution ?? null,
          message: `Mission '${missionId}' has been unblocked`,
          unblockedAt: now,
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

/**
 * Format mission unblock result for LLM readability.
 *
 * @param result - Mission unblock result
 * @returns Human-readable formatted result
 */
export function formatMissionUnblockForLLM(result: RbookToolResult<MissionUnblockResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to unblock mission',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.currentState) {
      lines.push(`Current status: ${error.currentState}`);
    }

    if (error?.validTransitions && error.validTransitions.length > 0) {
      lines.push(`Valid transitions: ${error.validTransitions.join(', ')}`);
    }

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [
    `✓ Mission '${data.missionId}' unblocked`,
    '',
    `Status: ${data.previousStatus} → ${data.currentStatus}`,
    `Unblocked at: ${data.unblockedAt}`,
  ];

  if (data.resolution) {
    lines.push(`Resolution: ${data.resolution}`);
  }

  // Surface warnings (incl. the m05 collab-sync warnings the transition dispatcher
  // folds in: lock contention, a superseded conflict, or a non-fatal broker-sync error).
  appendWarnings(lines, result);

  return lines.join('\n');
}
