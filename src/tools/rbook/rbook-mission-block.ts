// ABOUTME: Blocks queued or active work and binds its origin to the current blocking episode.
// ABOUTME: Reads and verifies the transition under one write lock, preserving warning-only event logging.
/**
 * rbook_mission_block Tool
 *
 * MCP tool for blocking a mission - transitions from Queued/Current/In Progress to Blocked.
 * Validates state transitions and returns actionable errors.
 *
 * @module tools/rbook/rbook-mission-block
 */

import { normalizeMissionStatus } from './terminal-status';
import { z } from 'zod';
import { withClientValidated } from './client';
import type { RbookToolResult, Mission, MissionStatus, SanitizedFieldReport } from './types';
import {
  createError,
  createSuccess,
  RbookErrors,
  RBOOK_ERROR_CODES,
  transitionsFrom,
} from './errors';
import { ensureMissionTimestamps } from './schema-migrations';
import { sanitizeContentField, sanitizeStringArray } from '../../intelligence/content-sanitizer';
import { appendWarnings, attachWarnings } from './format-warnings';
import { checkWrite } from './write-guard';
import { recordedExecute } from './record-changes';

/**
 * Result of blocking a mission.
 */
export interface MissionBlockResult {
  /** The mission ID that was blocked */
  missionId: string;

  /** Previous status before transition */
  previousStatus: MissionStatus;

  /** Current status after transition (always 'Blocked') */
  currentStatus: MissionStatus;

  /** The reason for blocking */
  reason: string;

  /** Human-readable message */
  message: string;

  /** Timestamp when mission was blocked */
  blockedAt: string;
}

/**
 * Input parameters schema for rbook_mission_block tool.
 */
export const rbookMissionBlockSchema = z.object({
  /** The mission ID to block */
  missionId: z.string().min(1).describe('The mission ID to block (e.g., "s12-m06")'),

  /** The reason for blocking */
  reason: z.string().min(1).describe('The reason why this mission is being blocked'),

  /** Optional list of things needed to unblock */
  blockers: z
    .array(z.string())
    .optional()
    .describe('Optional list of items or dependencies needed to unblock'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookMissionBlockParams = z.infer<typeof rbookMissionBlockSchema>;

/**
 * MCP Tool Definition for rbook_mission_block.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const rbookMissionBlockToolDefinition = {
  name: 'rbook_mission_block',
  description:
    'Block a mission by transitioning it to Blocked status. ' +
    'Requires a reason for why the mission is blocked. ' +
    'Valid from Queued, Current or In Progress status. ' +
    'Returns INVALID_STATE_TRANSITION error with current_state and valid_transitions if the mission cannot be blocked.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to block (e.g., "s12-m06")',
      },
      reason: {
        type: 'string',
        description: 'The reason why this mission is being blocked',
      },
      blockers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of items or dependencies needed to unblock',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['missionId', 'reason'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_mission_block tool.
 *
 * Transitions a mission from Queued, Current or In Progress to Blocked.
 * Requires a reason and optionally accepts blockers list.
 *
 * @param params - Tool parameters (missionId, reason, blockers, projectRoot)
 * @returns RbookToolResult with block result or actionable error
 */
export async function rbookMissionBlock(
  params: RbookMissionBlockParams
): Promise<RbookToolResult<MissionBlockResult>> {
  // Validate required parameters
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(RbookErrors.missingParameter('missionId'));
  }

  if (!params.reason || params.reason.trim() === '') {
    return createError(RbookErrors.missingParameter('reason'));
  }

  const missionId = params.missionId.trim();
  // Sprint 60 m02: sanitize text inputs before persistence so XML-marshalling
  // sibling absorption is stripped + surfaced rather than written verbatim.
  const inputSanitized: SanitizedFieldReport[] = [];
  let cleanedReason = params.reason;
  const reasonSanitize = sanitizeContentField(params.reason);
  if (reasonSanitize.wasModified) {
    cleanedReason = reasonSanitize.cleaned;
    inputSanitized.push({ field: 'reason', reason: reasonSanitize.reason ?? '' });
  }
  if (!cleanedReason || cleanedReason.trim() === '') {
    return createError(RbookErrors.missingParameter('reason'));
  }
  let cleanedBlockers = params.blockers;
  if (Array.isArray(cleanedBlockers)) {
    const r = sanitizeStringArray('blockers', cleanedBlockers);
    cleanedBlockers = r.cleaned;
    inputSanitized.push(...r.sanitizedFields);
  }
  const reason = cleanedReason.trim();
  const targetStatus: MissionStatus = 'Blocked';

  const warnings: string[] = [];
  const result = await withClientValidated<MissionBlockResult>(
    (client) => {
      const begin = client.execute('BEGIN IMMEDIATE', []);
      if (!begin.success) return createError(begin.error!);
      let transactionOpen = true;
      try {
        warnings.push(...(ensureMissionTimestamps(client).warnings ?? []));
        // Query mission by ID
        const missionResult = client.getOne<Mission>(
          `
        SELECT id, status, name, domain_fields, notes
        FROM missions
        WHERE id = ?
      `,
          [missionId]
        );

        if (!missionResult.success) {
          return createError<MissionBlockResult>(
            missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
          );
        }

        if (!missionResult.data) {
          return createError<MissionBlockResult>(RbookErrors.missionNotFound(missionId));
        }

        const mission = missionResult.data;
        const currentStatus = normalizeMissionStatus(mission.status);

        // Check if already blocked
        if (currentStatus === targetStatus) {
          return createError<MissionBlockResult>({
            code: RBOOK_ERROR_CODES.MISSION_ALREADY_BLOCKED,
            message: `Mission '${missionId}' is already Blocked`,
            currentState: currentStatus,
            suggestion:
              'Use rbook_mission_transition(action="unblock") to unblock it first, or update the block reason',
          });
        }

        // Validate state transition
        // s87-m01: guarded through the ONE shared helper. `currentStatus` is read from the store,
        // not validated by the type system, and an unrecognized value now yields a NAMED refusal
        // instead of an unhandled TypeError the MCP boundary reports as "an internal error".
        const validTransitions = transitionsFrom(currentStatus);
        if (validTransitions === undefined) {
          return createError<MissionBlockResult>(
            RbookErrors.missionUnrecognizedStatus(missionId, currentStatus)
          );
        }
        if (!validTransitions.includes(targetStatus)) {
          return createError<MissionBlockResult>(
            RbookErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
          );
        }

        // Perform the update
        const now = new Date().toISOString();

        // Update domain_fields with blocker information
        let existingDomainFields: Record<string, unknown> = {};
        if (mission.domain_fields) {
          try {
            const parsed: unknown = JSON.parse(mission.domain_fields);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              existingDomainFields = parsed as Record<string, unknown>;
            }
          } catch {
            // If parsing fails, start fresh
            existingDomainFields = {};
          }
        }

        const updatedDomainFields = {
          ...existingDomainFields,
          blocker: reason,
          blockedSince: now,
          blockedFrom: { status: currentStatus, blockedSince: now },
          blockers: cleanedBlockers ?? [],
        };

        // Build note text
        const blockNote = cleanedBlockers?.length
          ? `[Blocked] ${reason}. Needs: ${cleanedBlockers.join(', ')}`
          : `[Blocked] ${reason}`;

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
          [targetStatus, JSON.stringify(updatedDomainFields), blockNote, now, missionId]
        );

        if (!updateResult.success) {
          return createError<MissionBlockResult>(
            updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
          );
        }

        if (updateResult.data?.changes === 0) {
          return createError<MissionBlockResult>({
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to update mission '${missionId}'`,
            suggestion: 'The mission may have been modified by another process',
          });
        }

        // Log the state change to session_events
        const eventResult = client.execute(
          `
        INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
        VALUES (?, 'mcp-tool', ?, 'block', ?, ?, ?)
      `,
          [
            now,
            missionId,
            targetStatus,
            reason,
            JSON.stringify({
              tool: 'rbook_mission_block',
              missionId,
              previousStatus: currentStatus,
              newStatus: targetStatus,
              reason,
              blockers: cleanedBlockers,
            }),
          ]
        );

        // Don't fail the operation if event logging fails (non-critical) — but say so.
        if (!checkWrite(eventResult, warnings, 'mission block event logging')) {
          console.warn('Failed to log mission block event:', eventResult.error);
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
            (mission.notes == null ? '' : `${mission.notes} | `) + blockNote ||
          persisted.data.updated_at !== now
        ) {
          return createError<MissionBlockResult>({
            code: 'MISSION_TRANSITION_POSTCONDITION_FAILED',
            message: `Mission '${missionId}' did not retain its requested transition.`,
            suggestion: 'Inspect database triggers and write failures, then retry after repair.',
          });
        }

        const committed = client.execute('COMMIT', []);
        if (!committed.success) return createError(committed.error!);
        transactionOpen = false;
        return createSuccess<MissionBlockResult>(
          {
            missionId,
            previousStatus: currentStatus,
            currentStatus: targetStatus,
            reason,
            message: `Mission '${missionId}' has been blocked: ${reason}`,
            blockedAt: now,
          },
          warnings,
          inputSanitized
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
 * Format mission block result for LLM readability.
 *
 * @param result - Mission block result
 * @returns Human-readable formatted result
 */
export function formatMissionBlockForLLM(result: RbookToolResult<MissionBlockResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to block mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

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
    `⊘ Mission '${data.missionId}' blocked`,
    '',
    `Status: ${data.previousStatus} → ${data.currentStatus}`,
    `Reason: ${data.reason}`,
    `Blocked at: ${data.blockedAt}`,
  ];

  // Surface warnings (incl. the m05 collab-sync warnings the transition dispatcher
  // folds in: lock contention, a superseded conflict, or a non-fatal broker-sync error).
  appendWarnings(lines, result);

  return lines.join('\n');
}
