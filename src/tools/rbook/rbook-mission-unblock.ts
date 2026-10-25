// ABOUTME: Unblocks work to its explicit target or a fresh, unstarted queue origin.
// ABOUTME: Reads and verifies the transition under one write lock, preserving warning-only event logging.
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

/** Explicit targets; an omitted target may restore a fresh, unstarted Queued origin. */
const UNBLOCK_TARGETS = ['In Progress', 'Current'] as const;

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

  /** Explicit target; omission infers Queued only for a fresh, unstarted queue origin. */
  targetStatus: z
    .enum(UNBLOCK_TARGETS)
    .optional()
    .describe('Explicit target; otherwise restore an unstarted queue origin or use In Progress'),

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
    'Unblock a mission by transitioning it from Blocked to its queued origin, In Progress or Current status. ' +
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
        description:
          'Explicit target; otherwise restore an unstarted queue origin or use In Progress',
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
      return `A completed mission has no blocker to clear. A mistaken completion in an open sprint can be corrected with the separate reopen action; other fields remain editable with rbook_mission(action="update").`;
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

export async function rbookMissionUnblock(
  params: RbookMissionUnblockParams
): Promise<RbookToolResult<MissionUnblockResult>> {
  // Validate required parameter
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(RbookErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  // s100-m02: as for start (finding 14), the schema's enum binds nothing here, and Blocked may also
  // move to Dropped or Deferred, so an unblock to either would have moved the mission there.
  if (params.targetStatus != null && !UNBLOCK_TARGETS.includes(params.targetStatus)) {
    return createError(
      RbookErrors.invalidParameter('targetStatus', params.targetStatus, [...UNBLOCK_TARGETS])
    );
  }

  const warnings: string[] = [];
  const result = await withClientValidated<MissionUnblockResult>(
    (client) => {
      const begin = client.execute('BEGIN IMMEDIATE', []);
      if (!begin.success) return createError(begin.error!);
      let transactionOpen = true;
      try {
        warnings.push(...(ensureMissionTimestamps(client).warnings ?? []));
        // Query mission by ID
        const missionResult = client.getOne<Mission & { started_at: string | null }>(
          `
        SELECT id, status, name, domain_fields, notes, started_at
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
          // A non-blocked mission needs a remedy matched to its actual status.
          return createError<MissionUnblockResult>({
            code: RBOOK_ERROR_CODES.MISSION_INVALID_STATE,
            message: `Mission '${missionId}' is not blocked (current status: ${currentStatus})`,
            currentState: currentStatus,
            suggestion: unblockNotBlockedSuggestion(missionId, currentStatus),
          });
        }

        // Perform the update
        const now = new Date().toISOString();

        // Update domain_fields to clear blocker information but preserve history
        let existingDomainFields: Record<string, unknown> = {};
        if (mission.domain_fields) {
          try {
            const parsed: unknown = JSON.parse(mission.domain_fields);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              existingDomainFields = parsed as Record<string, unknown>;
            }
          } catch {
            existingDomainFields = {};
          }
        }

        const origin = existingDomainFields.blockedFrom;
        const queuedOrigin =
          origin !== null &&
          typeof origin === 'object' &&
          !Array.isArray(origin) &&
          (origin as Record<string, unknown>).status === 'Queued' &&
          typeof existingDomainFields.blockedSince === 'string' &&
          existingDomainFields.blockedSince.length > 0 &&
          (origin as Record<string, unknown>).blockedSince === existingDomainFields.blockedSince &&
          mission.started_at === null;
        const targetStatus: MissionStatus =
          params.targetStatus ?? (queuedOrigin ? 'Queued' : 'In Progress');

        // Validate target status is a valid transition from Blocked
        const validTransitions = VALID_STATE_TRANSITIONS['Blocked'];
        if (!validTransitions.includes(targetStatus)) {
          return createError<MissionUnblockResult>(
            RbookErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
          );
        }

        // Preserve previous blocker info for history, clear active blocker
        const previousBlocker = existingDomainFields.blocker;
        const previousBlockedSince = existingDomainFields.blockedSince;

        const updatedDomainFields = {
          ...existingDomainFields,
          blocker: null,
          blockedSince: null,
          blockedFrom: null,
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

        const persisted = client.getOne<{
          status: string;
          domain_fields: string;
          notes: string;
          updated_at: string;
        }>('SELECT status,domain_fields,notes,updated_at FROM missions WHERE id = ?', [missionId]);
        if (
          !persisted.success ||
          persisted.data?.status !== targetStatus ||
          persisted.data.domain_fields !== JSON.stringify(updatedDomainFields) ||
          persisted.data.notes !==
            (mission.notes == null ? '' : `${mission.notes} | `) + unblockNote ||
          persisted.data.updated_at !== now
        ) {
          return createError<MissionUnblockResult>({
            code: 'MISSION_TRANSITION_POSTCONDITION_FAILED',
            message: `Mission '${missionId}' did not retain its requested transition.`,
            suggestion: 'Inspect database triggers and write failures, then retry after repair.',
          });
        }

        const committed = client.execute('COMMIT', []);
        if (!committed.success) return createError(committed.error!);
        transactionOpen = false;
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
      } finally {
        if (transactionOpen) client.execute('ROLLBACK', []);
      }
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
