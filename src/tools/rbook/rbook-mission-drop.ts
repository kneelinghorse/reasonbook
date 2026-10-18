// ABOUTME: Implements the rbook_mission_drop action — transitions a mission to Dropped (terminal).
// ABOUTME: Drop state and its mandatory audit share the caller-owned transaction used by spin-out.

import { normalizeMissionStatus } from './terminal-status';
import { z } from 'zod';
import { withClientValidated, type RbookDatabaseClient } from './client';
import type { RbookToolResult, Mission, MissionStatus } from './types';
import {
  createError,
  createSuccess,
  RbookErrors,
  RBOOK_ERROR_CODES,
  transitionsFrom,
} from './errors';
import { ensureMissionTimestamps } from './schema-migrations';
import { appendWarnings, attachWarnings } from './format-warnings';
import { recordedExecute } from './record-changes';

/**
 * Result of dropping a mission.
 */
export interface MissionDropResult {
  /** The mission ID that was dropped */
  missionId: string;

  /** Previous status before transition */
  previousStatus: MissionStatus;

  /** Current status after transition (always 'Dropped') */
  currentStatus: MissionStatus;

  /** The reason for dropping */
  reason: string | null;

  /** Human-readable message */
  message: string;

  /** Timestamp when mission was dropped */
  droppedAt: string;
}

export const rbookMissionDropSchema = z.object({
  missionId: z.string().min(1).describe('The mission ID to drop (e.g., "s12-m06")'),
  reason: z.string().optional().describe('Optional reason why this mission is being dropped'),
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookMissionDropParams = z.infer<typeof rbookMissionDropSchema>;

export async function rbookMissionDrop(
  params: RbookMissionDropParams
): Promise<RbookToolResult<MissionDropResult>> {
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(RbookErrors.missingParameter('missionId'));
  }

  const warnings: string[] = [];
  const result = await withClientValidated(
    (client) => {
      const migration = ensureMissionTimestamps(client);
      warnings.push(...(migration.warnings ?? []));
      const columns = client.getMany<{ name: string }>('PRAGMA table_info(missions)');
      if (!columns.success || !columns.data?.some((column) => column.name === 'updated_at')) {
        return createError<MissionDropResult>({
          code: 'MISSION_DROP_SCHEMA_FAILED',
          message: 'Mission timestamp schema is unavailable.',
          suggestion: 'Resolve the database migration warning, then retry.',
        });
      }
      const begin = client.raw('BEGIN IMMEDIATE');
      if (!begin.success) return createError<MissionDropResult>(begin.error!);
      try {
        const dropped = rbookMissionDropOnClient(client, params);
        if (!dropped.success) {
          const rollback = client.raw('ROLLBACK');
          if (!rollback.success) return createError<MissionDropResult>(rollback.error!);
          return dropped;
        }
        const commit = client.raw('COMMIT');
        if (!commit.success) {
          const rollback = client.raw('ROLLBACK');
          return createError<MissionDropResult>(rollback.success ? commit.error! : rollback.error!);
        }
        return dropped;
      } catch (error) {
        const rollback = client.raw('ROLLBACK');
        return createError<MissionDropResult>({
          code: 'MISSION_DROP_FAILED',
          message: `Mission drop failed: ${String(error)}${rollback.success ? '' : `; rollback failed: ${rollback.error?.message}`}`,
          suggestion: 'Check the database and session_events write permissions, then retry.',
        });
      }
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

/** Caller must own an IMMEDIATE transaction and roll it back on any failed result. */
export function rbookMissionDropOnClient(
  client: RbookDatabaseClient,
  params: RbookMissionDropParams
): RbookToolResult<MissionDropResult> {
  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = 'Dropped';
  const missionResult = client.getOne<Mission>(
    `SELECT id, status, name, domain_fields, notes FROM missions WHERE id = ?`,
    [missionId]
  );

  if (!missionResult.success) {
    return createError<MissionDropResult>(
      missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
    );
  }

  if (!missionResult.data) {
    return createError<MissionDropResult>(RbookErrors.missionNotFound(missionId));
  }

  const mission = missionResult.data;
  const currentStatus = normalizeMissionStatus(mission.status);

  if (currentStatus === 'Dropped') {
    return createError<MissionDropResult>({
      code: RBOOK_ERROR_CODES.MISSION_INVALID_STATE,
      message: `Mission '${missionId}' is already Dropped`,
      currentState: currentStatus,
      suggestion: 'Mission is already in terminal Dropped state',
    });
  }

  // s87-m01: guarded through the ONE shared helper. `currentStatus` is read from the store,
  // not validated by the type system, and an unrecognized value now yields a NAMED refusal
  // instead of an unhandled TypeError the MCP boundary reports as "an internal error".
  const validTransitions = transitionsFrom(currentStatus);
  if (validTransitions === undefined) {
    return createError<MissionDropResult>(
      RbookErrors.missionUnrecognizedStatus(missionId, currentStatus)
    );
  }
  if (!validTransitions.includes(targetStatus)) {
    return createError<MissionDropResult>(
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

  const updatedDomainFields = {
    ...existingDomainFields,
    droppedReason: params.reason ?? null,
    droppedAt: now,
    droppedFromStatus: currentStatus,
  };

  const dropNote = params.reason
    ? `[Dropped] ${params.reason}`
    : `[Dropped] Removed from active queue`;

  const updateResult = recordedExecute(
    client,
    `UPDATE missions
     SET status = ?,
         domain_fields = ?,
         notes = COALESCE(notes || ' | ', '') || ?,
         updated_at = ?
     WHERE id = ?`,
    [targetStatus, JSON.stringify(updatedDomainFields), dropNote, now, missionId]
  );

  if (!updateResult.success) {
    return createError<MissionDropResult>(
      updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
    );
  }

  if (updateResult.data?.changes === 0) {
    return createError<MissionDropResult>({
      code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
      message: `Failed to update mission '${missionId}'`,
      suggestion: 'The mission may have been modified by another process',
    });
  }

  const eventResult = client.execute(
    `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
     VALUES (?, 'mcp-tool', ?, 'drop', ?, ?, ?)`,
    [
      now,
      missionId,
      targetStatus,
      params.reason ?? `Dropped mission ${missionId}`,
      JSON.stringify({
        tool: 'rbook_mission_drop',
        missionId,
        previousStatus: currentStatus,
        newStatus: targetStatus,
        reason: params.reason ?? null,
      }),
    ]
  );

  if (!eventResult.success || eventResult.data?.changes !== 1) {
    return createError<MissionDropResult>({
      code: 'MISSION_DROP_AUDIT_FAILED',
      message: `Mission '${missionId}' could not record its mandatory drop audit: ${eventResult.error?.message ?? 'unknown error'}`,
      suggestion:
        'Repair the session_events write failure, then retry the drop. The transaction must be rolled back.',
    });
  }

  const verifiedMission = client.getOne<{
    status: string;
    domain_fields: string;
    notes: string;
    updated_at: string;
  }>('SELECT status,domain_fields,notes,updated_at FROM missions WHERE id=?', [missionId]);
  const verifiedAudit = client.getOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM session_events WHERE ts=? AND mission=? AND action='drop' AND status=? AND raw_event=?",
    [
      now,
      missionId,
      targetStatus,
      JSON.stringify({
        tool: 'rbook_mission_drop',
        missionId,
        previousStatus: currentStatus,
        newStatus: targetStatus,
        reason: params.reason ?? null,
      }),
    ]
  );
  if (
    !verifiedMission.success ||
    !verifiedAudit.success ||
    verifiedAudit.data?.count !== 1 ||
    verifiedMission.data?.status !== targetStatus ||
    verifiedMission.data?.domain_fields !== JSON.stringify(updatedDomainFields) ||
    verifiedMission.data?.notes !==
      (mission.notes == null ? '' : `${mission.notes} | `) + dropNote ||
    verifiedMission.data?.updated_at !== now
  ) {
    return createError<MissionDropResult>({
      code: 'MISSION_DROP_POSTCONDITION_FAILED',
      message: `Mission '${missionId}' did not retain its exact drop state and audit.`,
      suggestion:
        'Inspect database triggers and write failures, roll back this transaction, then retry after repair.',
    });
  }

  return createSuccess<MissionDropResult>({
    missionId,
    previousStatus: currentStatus,
    currentStatus: targetStatus,
    reason: params.reason ?? null,
    message: `Mission '${missionId}' has been dropped`,
    droppedAt: now,
  });
}

export function formatMissionDropForLLM(result: RbookToolResult<MissionDropResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to drop mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

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
    `✗ Mission '${data.missionId}' dropped`,
    '',
    `Status: ${data.previousStatus} → ${data.currentStatus}`,
    `Dropped at: ${data.droppedAt}`,
  ];

  if (data.reason) {
    lines.push(`Reason: ${data.reason}`);
  }

  // Surface warnings (incl. the m05 collab-sync warnings the transition dispatcher
  // folds in: lock contention, a superseded conflict, or a non-fatal broker-sync error).
  appendWarnings(lines, result);

  return lines.join('\n');
}
