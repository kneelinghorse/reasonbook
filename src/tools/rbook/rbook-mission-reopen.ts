// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reopens a completed mission only after checking its sprint under the write lock.
// ABOUTME: The appended shared note, local event and completion metadata commit or roll back together.
import { z } from 'zod';
import { sanitizeContentField } from '../../intelligence/content-sanitizer';
import { withClientValidated, type RbookDatabaseClient } from './client';
import { createError, createSuccess, RbookErrors } from './errors';
import { appendWarnings, attachWarnings } from './format-warnings';
import { recordedExecute } from './record-changes';
import { ensureMissionTimestamps } from './schema-migrations';
import {
  isOpenStatus,
  isTerminalStatus,
  normalizeMissionStatus,
  SPRINT_NO_OPEN_WORK_STATUSES,
} from './terminal-status';
import type { MissionStatus, RbookToolResult, SanitizedFieldReport } from './types';

export interface MissionReopenResult {
  readonly missionId: string;
  readonly previousStatus: MissionStatus;
  readonly currentStatus: MissionStatus;
  readonly reason: string;
  readonly completedAt: string | null;
  readonly reopenedAt: string;
  readonly message: string;
}

export const rbookMissionReopenSchema = z.object({
  missionId: z.string().min(1).describe('The completed mission ID to reopen'),
  reason: z.string().trim().min(1).describe('Why this completed mission needs more work'),
  projectRoot: z.string().optional().describe('Project root directory'),
});
export type RbookMissionReopenParams = z.infer<typeof rbookMissionReopenSchema>;

interface ReopenMission {
  id: string;
  status: string | null;
  sprint_id: string | null;
  completed_at: string | null;
  domain_fields: string | null;
  notes: string | null;
  updated_at: string | null;
}

function failure(code: string, message: string): RbookToolResult<MissionReopenResult> {
  return createError({
    code,
    message,
    suggestion: 'Repair the database schema, triggers or audit write failure, then retry reopen.',
  });
}

export async function rbookMissionReopen(
  params: RbookMissionReopenParams
): Promise<RbookToolResult<MissionReopenResult>> {
  if (!params.missionId?.trim()) return createError(RbookErrors.missingParameter('missionId'));
  if (typeof params.reason !== 'string') return createError(RbookErrors.missingParameter('reason'));
  const sanitized = sanitizeContentField(params.reason);
  const reason = sanitized.cleaned.trim();
  if (!reason) return createError(RbookErrors.missingParameter('reason'));
  const inputSanitized: SanitizedFieldReport[] = sanitized.wasModified
    ? [{ field: 'reason', reason: sanitized.reason ?? '' }]
    : [];
  const warnings: string[] = [];
  const result = await withClientValidated(
    (client) => {
      // Both eligibility reads and schema preparation belong to this transaction: a local
      // sprint close cannot slip between the positive-open check and the mission write.
      const begin = client.raw('BEGIN IMMEDIATE');
      if (!begin.success) return failure('MISSION_REOPEN_FAILED', begin.error!.message);
      try {
        const migration = ensureMissionTimestamps(client);
        warnings.push(...(migration.warnings ?? []));
        const result = reopenOnClient(client, params.missionId.trim(), reason, inputSanitized);
        if (!result.success) {
          const rollback = client.raw('ROLLBACK');
          return rollback.success
            ? result
            : failure('MISSION_REOPEN_FAILED', rollback.error!.message);
        }
        const commit = client.raw('COMMIT');
        if (!commit.success) {
          const rollback = client.raw('ROLLBACK');
          return failure(
            'MISSION_REOPEN_FAILED',
            `${commit.error?.message}${rollback.success ? '' : `; rollback failed: ${rollback.error?.message}`}`
          );
        }
        return result;
      } catch (error) {
        const rollback = client.raw('ROLLBACK');
        return failure(
          'MISSION_REOPEN_FAILED',
          `${String(error)}${rollback.success ? '' : `; rollback failed: ${rollback.error?.message}`}`
        );
      }
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

function reopenOnClient(
  client: RbookDatabaseClient,
  missionId: string,
  reason: string,
  inputSanitized: SanitizedFieldReport[]
): RbookToolResult<MissionReopenResult> {
  const missionResult = client.getOne<ReopenMission>(
    'SELECT id,status,sprint_id,completed_at,domain_fields,notes,updated_at FROM missions WHERE id=?',
    [missionId]
  );
  if (!missionResult.success)
    return failure('MISSION_REOPEN_SCHEMA_FAILED', missionResult.error!.message);
  const mission = missionResult.data;
  if (!mission) return createError(RbookErrors.missionNotFound(missionId));
  if (normalizeMissionStatus(mission.status) !== 'Completed') {
    return createError({
      code: 'MISSION_INVALID_STATE',
      message: `Mission '${missionId}' is not Completed and cannot be reopened.`,
      currentState: mission.status ?? 'NULL',
      suggestion:
        'Reopen only a Completed mission; use the ordinary transition actions for unfinished work.',
    });
  }
  const sprint = client.getOne<{ status: string | null }>('SELECT status FROM sprints WHERE id=?', [
    mission.sprint_id,
  ]);
  if (!sprint.success) return failure('MISSION_REOPEN_SCHEMA_FAILED', sprint.error!.message);
  if (!isOpenStatus(sprint.data?.status)) {
    const status = sprint.data?.status;
    const suggestion = isTerminalStatus(status, SPRINT_NO_OPEN_WORK_STATUSES)
      ? `Create a successor mission in an open sprint using rbook_mission(action="add", missionId="<new-id>", name="<name>", sprintId="<open-sprint-id>"), then link it with rbook_mission(action="depends", fromId="<new-id>", toId=${JSON.stringify(missionId)}, type="Requires").`
      : status?.toUpperCase() === 'PLANNED'
        ? `Activate this sprint with rbook_sprint(action="update", sprintId=${JSON.stringify(mission.sprint_id)}, fields={status:"Active"}); activation demotes any other open sprint to Planned.`
        : 'Repair the mission sprint association or the sprint status before reopening.';
    return createError({
      code: 'MISSION_REOPEN_SPRINT_NOT_OPEN',
      message: `Mission '${missionId}' requires an open sprint; '${mission.sprint_id ?? 'none'}' is ${status ?? 'missing or NULL'}.`,
      suggestion: suggestion,
    });
  }
  let fields: Record<string, unknown> = {};
  if (mission.domain_fields) {
    try {
      const parsed: unknown = JSON.parse(mission.domain_fields);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not an object');
      fields = parsed as Record<string, unknown>;
    } catch {
      return failure(
        'MISSION_REOPEN_METADATA_INVALID',
        'Mission domain_fields is not a JSON object; reopening cannot preserve its history.'
      );
    }
  }
  if (fields.reopened !== undefined && !Array.isArray(fields.reopened)) {
    return failure('MISSION_REOPEN_METADATA_INVALID', 'Mission reopened history is not an array.');
  }
  const now = new Date().toISOString();
  const history = Array.isArray(fields.reopened) ? fields.reopened : [];
  const domainFields = JSON.stringify({
    ...fields,
    reopened: [...history, { at: now, reason, completedAt: mission.completed_at }],
  });
  const notes = (mission.notes === null ? '' : `${mission.notes} | `) + `[Reopened] ${reason}`;
  const update = recordedExecute(
    client,
    'UPDATE missions SET status=?,completed_at=NULL,domain_fields=?,notes=?,updated_at=? WHERE id=?',
    ['In Progress', domainFields, notes, now, missionId]
  );
  if (!update.success || update.data?.changes !== 1)
    return failure(
      'MISSION_REOPEN_FAILED',
      update.error?.message ?? 'Mission reopen did not update exactly one row.'
    );
  const event = JSON.stringify({
    tool: 'rbook_mission_reopen',
    missionId,
    previousStatus: 'Completed',
    newStatus: 'In Progress',
    reason,
    completedAt: mission.completed_at,
  });
  const audit = client.execute(
    "INSERT INTO session_events(ts,agent,mission,action,status,summary,raw_event) VALUES(?,'mcp-tool',?,'reopen','In Progress',?,?)",
    [now, missionId, reason, event]
  );
  if (!audit.success || audit.data?.changes !== 1)
    return failure(
      'MISSION_REOPEN_AUDIT_FAILED',
      audit.error?.message ?? 'Mission reopen did not record its mandatory audit.'
    );
  const persisted = client.getOne<ReopenMission>(
    'SELECT status,completed_at,domain_fields,notes,updated_at,sprint_id FROM missions WHERE id=?',
    [missionId]
  );
  const persistedAudit = client.getOne<{ count: number }>(
    "SELECT COUNT(*) AS count FROM session_events WHERE ts=? AND agent='mcp-tool' AND mission=? AND action='reopen' AND status='In Progress' AND summary=? AND raw_event=?",
    [now, missionId, reason, event]
  );
  const row = persisted.data;
  if (
    !persisted.success ||
    !persistedAudit.success ||
    persistedAudit.data?.count !== 1 ||
    row?.status !== 'In Progress' ||
    row.completed_at !== null ||
    row.domain_fields !== domainFields ||
    row.notes !== notes ||
    row.updated_at !== now ||
    row.sprint_id !== mission.sprint_id
  ) {
    return failure(
      'MISSION_REOPEN_POSTCONDITION_FAILED',
      'Mission did not retain its exact reopened state and mandatory audit.'
    );
  }
  return createSuccess(
    {
      missionId,
      previousStatus: 'Completed',
      currentStatus: 'In Progress',
      reason,
      completedAt: mission.completed_at,
      reopenedAt: now,
      message: `Mission '${missionId}' reopened.`,
    },
    undefined,
    inputSanitized
  );
}

export function formatMissionReopenForLLM(result: RbookToolResult<MissionReopenResult>): string {
  const lines =
    result.success && result.data
      ? [
          `Mission '${result.data.missionId}' reopened`,
          `Status: ${result.data.previousStatus} → ${result.data.currentStatus}`,
          `Reason: ${result.data.reason}`,
          `Reopened at: ${result.data.reopenedAt}`,
        ]
      : [
          'Failed to reopen mission',
          `Error: ${result.error?.message ?? 'Unknown error'}`,
          `Suggestion: ${result.error?.suggestion ?? 'Inspect the mission and retry.'}`,
        ];
  if (result.sanitizedFields?.length) {
    lines.push(
      `Sanitized input: ${result.sanitizedFields.map((field) => `${field.field}: ${field.reason}`).join('; ')}`
    );
  }
  appendWarnings(lines, result);
  return lines.join('\n');
}
