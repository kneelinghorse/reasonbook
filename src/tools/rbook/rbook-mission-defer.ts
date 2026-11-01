// ABOUTME: Implements the rbook_mission_defer action — transitions a mission to Deferred (temporarily parked).
// ABOUTME: Deferred missions can be re-queued later via rbook_mission_update or rbook_mission_transition requeue.

import { z } from 'zod';
import { withClientValidated } from './client';
import type { RbookToolResult, Mission, MissionStatus, SanitizedFieldReport } from './types';
import { readCheckAfter } from './next-step-dates';
import {
  createError,
  createSuccess,
  RbookErrors,
  RBOOK_ERROR_CODES,
  transitionsFrom,
} from './errors';
import { ensureMissionTimestamps } from './schema-migrations';
import { sanitizeContentField } from '../../intelligence/content-sanitizer';
import { appendWarnings, attachWarnings } from './format-warnings';
import { checkWrite } from './write-guard';
import { recordedExecute } from './record-changes';

/**
 * Result of deferring a mission.
 */
export interface MissionDeferResult {
  /** The mission ID that was deferred */
  missionId: string;

  /** Previous status before transition */
  previousStatus: MissionStatus;

  /** Current status after transition (always 'Deferred') */
  currentStatus: MissionStatus;

  /** The reason for deferring */
  reason: string | null;

  /** Hint about when to re-queue (not enforced, just recorded) */
  deferUntil: string | null;

  /**
   * s108-m03: the day the mission comes back as due, when deferUntil reads as a day after today and
   * at most 180 days ahead (next-step-dates.ts); null when deferUntil stays a hint.
   */
  checkAfter: string | null;

  /** Human-readable message */
  message: string;

  /** Timestamp when mission was deferred */
  deferredAt: string;
}

export const rbookMissionDeferSchema = z.object({
  missionId: z.string().min(1).describe('The mission ID to defer (e.g., "s12-m06")'),
  reason: z.string().optional().describe('Optional reason why this mission is being deferred'),
  deferUntil: z
    .string()
    .optional()
    .describe('Optional hint about when to re-queue (e.g., "after sprint 48", "when API ships")'),
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookMissionDeferParams = z.infer<typeof rbookMissionDeferSchema>;

export async function rbookMissionDefer(
  params: RbookMissionDeferParams
): Promise<RbookToolResult<MissionDeferResult>> {
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(RbookErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = 'Deferred';

  // Sprint 60 m02: sanitize text inputs (reason + deferUntil) so XML
  // sibling absorption strips out and surfaces instead of writing verbatim.
  const inputSanitized: SanitizedFieldReport[] = [];
  let cleanedReason = params.reason;
  if (typeof cleanedReason === 'string') {
    const r = sanitizeContentField(cleanedReason);
    if (r.wasModified) {
      cleanedReason = r.cleaned;
      inputSanitized.push({ field: 'reason', reason: r.reason ?? '' });
    }
  }
  let cleanedDeferUntil = params.deferUntil;
  if (typeof cleanedDeferUntil === 'string') {
    const r = sanitizeContentField(cleanedDeferUntil);
    if (r.wasModified) {
      cleanedDeferUntil = r.cleaned;
      inputSanitized.push({ field: 'deferUntil', reason: r.reason ?? '' });
    }
  }

  const warnings: string[] = [];
  const result = await withClientValidated(
    (client) => {
      const missionResult = client.getOne<Mission>(
        `SELECT id, status, name, domain_fields FROM missions WHERE id = ?`,
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionDeferResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionDeferResult>(RbookErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = mission.status;

      if (currentStatus === 'Deferred') {
        return createError<MissionDeferResult>({
          code: RBOOK_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Mission '${missionId}' is already Deferred`,
          currentState: currentStatus,
          // s85-m01: the pre-s85 text named rbook_mission_transition action="requeue" (no such
          // action) and rbook_mission_update (no such tool). Deferred transitions to Queued /
          // Current / Dropped (errors.ts VALID_STATE_TRANSITIONS), and unblock is valid only
          // from Blocked — so an update to status is the actual re-queue path.
          suggestion:
            'Use rbook_mission(action="update", fields={"status":"Queued"}) to re-queue it',
        });
      }

      // s87-m01: guarded through the ONE shared helper. `currentStatus` is read from the store,
      // not validated by the type system, and an unrecognized value now yields a NAMED refusal
      // instead of an unhandled TypeError the MCP boundary reports as "an internal error".
      const validTransitions = transitionsFrom(currentStatus);
      if (validTransitions === undefined) {
        return createError<MissionDeferResult>(
          RbookErrors.missionUnrecognizedStatus(missionId, currentStatus)
        );
      }
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionDeferResult>(
          RbookErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      const now = new Date().toISOString();

      let existingDomainFields: Record<string, unknown> = {};
      if (mission.domain_fields) {
        try {
          existingDomainFields = JSON.parse(mission.domain_fields);
        } catch {
          existingDomainFields = {};
        }
      }

      // s108-m03 (settled item 3): a deferUntil that reads as a future day is the mission's date,
      // paired with this deferral, so a later deferral, which writes a new deferredAt, leaves it
      // stale. Anything else stays the hint it always was; deferUntil is never refused for it.
      const read = cleanedDeferUntil ? readCheckAfter(cleanedDeferUntil, 'carry') : null;
      const checkAfter = read && 'day' in read ? read.day : null;
      const updatedDomainFields = {
        ...existingDomainFields,
        deferredReason: cleanedReason ?? null,
        deferredAt: now,
        deferUntil: cleanedDeferUntil ?? null,
        deferredFromStatus: currentStatus,
        ...(checkAfter ? { checkAfter, checkAfterDeferredAt: now } : {}),
      };

      const deferNote = cleanedReason
        ? `[Deferred] ${cleanedReason}${cleanedDeferUntil ? ` (until: ${cleanedDeferUntil})` : ''}`
        : `[Deferred] Temporarily parked${cleanedDeferUntil ? ` (until: ${cleanedDeferUntil})` : ''}`;

      warnings.push(...(ensureMissionTimestamps(client).warnings ?? []));

      const updateResult = recordedExecute(
        client,
        `UPDATE missions
         SET status = ?,
             domain_fields = ?,
             notes = COALESCE(notes || ' | ', '') || ?,
             updated_at = ?
         WHERE id = ?`,
        [targetStatus, JSON.stringify(updatedDomainFields), deferNote, now, missionId]
      );

      if (!updateResult.success) {
        return createError<MissionDeferResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
        );
      }

      if (updateResult.data?.changes === 0) {
        return createError<MissionDeferResult>({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      const eventResult = client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'defer', ?, ?, ?)`,
        [
          now,
          missionId,
          targetStatus,
          cleanedReason ?? `Deferred mission ${missionId}`,
          JSON.stringify({
            tool: 'rbook_mission_defer',
            missionId,
            previousStatus: currentStatus,
            newStatus: targetStatus,
            reason: cleanedReason ?? null,
            deferUntil: cleanedDeferUntil ?? null,
          }),
        ]
      );

      if (!checkWrite(eventResult, warnings, 'mission defer event logging')) {
        console.warn('Failed to log mission defer event:', eventResult.error);
      }

      return createSuccess<MissionDeferResult>(
        {
          missionId,
          previousStatus: currentStatus,
          currentStatus: targetStatus,
          reason: cleanedReason ?? null,
          deferUntil: cleanedDeferUntil ?? null,
          checkAfter,
          message: `Mission '${missionId}' has been deferred${checkAfter ? ` until ${checkAfter}` : ''}`,
          deferredAt: now,
        },
        warnings,
        inputSanitized
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

export function formatMissionDeferForLLM(result: RbookToolResult<MissionDeferResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to defer mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

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
    `⏸ Mission '${data.missionId}' deferred`,
    '',
    `Status: ${data.previousStatus} → ${data.currentStatus}`,
    `Deferred at: ${data.deferredAt}`,
  ];

  if (data.reason) {
    lines.push(`Reason: ${data.reason}`);
  }

  // s108-m03: a date brings the mission back as due; any other deferUntil is a hint nothing acts on.
  if (data.checkAfter) {
    lines.push(`Due again: ${data.checkAfter}, when review and the signals list it as due`);
  } else if (data.deferUntil) {
    // Today's UTC day, since in an American evening it is already tomorrow there (settled item 5).
    lines.push(
      `Re-queue when: ${data.deferUntil} (a hint: nothing brings the mission back on its own; a day after today, up to 180 days ahead, would; today is ${data.deferredAt.slice(0, 10)} in UTC)`
    );
  }

  // Surface warnings (incl. the m05 collab-sync warnings the transition dispatcher
  // folds in: lock contention, a superseded conflict, or a non-fatal broker-sync error).
  appendWarnings(lines, result);

  return lines.join('\n');
}
