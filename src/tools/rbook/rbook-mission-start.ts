// ABOUTME: Starts missions while preserving the single-open-sprint invariant and persisted tracking.
// ABOUTME: Validates lifecycle choices and discloses failed writes through the standard tool result.
/**
 * rbook_mission_start Tool
 *
 * MCP tool for starting a mission - transitions from Queued/Current to In Progress.
 * Validates state transitions and returns actionable errors.
 *
 * @module tools/rbook/rbook-mission-start
 */

import { syncSprintTracking } from './sprint-tracking';
import { SPRINT_OPEN_STATUSES, statusInSql, normalizeMissionStatus } from './terminal-status';
import { z } from 'zod';
import { withClientAsync, type RbookDatabaseClient } from './client';
import type { RbookToolResult, Mission, MissionStatus } from './types';
import {
  createError,
  createSuccess,
  RbookErrors,
  RBOOK_ERROR_CODES,
  transitionsFrom,
} from './errors';
import { ensureMissionTimestamps } from './schema-migrations';
import { getProjectId } from './genesis-columns';
import { frameForeignText } from '../../intelligence/provenance-frame';
import {
  findRelevantDecisions,
  buildMissionSearchText,
  type RelevantDecision,
} from './relevance-surfacing';
import { appendWarnings, attachWarnings } from './format-warnings';
import { checkWrite } from './write-guard';
import { recordedExecute } from './record-changes';

/**
 * Result of starting a mission.
 */
export interface MissionStartResult {
  /** The mission ID that was started */
  missionId: string;

  /** Previous status before transition */
  previousStatus: MissionStatus;

  /** Current status after transition: In Progress, or Current when promoted (s97-m13) */
  currentStatus: MissionStatus;

  /** Human-readable message */
  message: string;

  /** Timestamp when mission was started; absent when it was promoted to Current, not started */
  startedAt?: string;

  /** Active decisions relevant to this mission's objective (0-5 items) */
  relevantDecisions?: RelevantDecision[];

  /**
   * s83-m06: the local project_id, so the renderer can frame any relevant decision
   * whose project_id differs (a pull-merged FOREIGN row) as untrusted data.
   */
  localProjectId?: string | null;
  activatedSprintId?: string;
}

/**
 * Input parameters schema for rbook_mission_start tool.
 */
export const rbookMissionStartSchema = z.object({
  /** The mission ID to start */
  missionId: z.string().min(1).describe('The mission ID to start (e.g., "s12-m06")'),

  /** Optional notes about starting this mission */
  notes: z.string().optional().describe('Optional notes about why this mission is being started'),

  /** s97-m13 (#662): Current promotes a Queued or Deferred mission without starting its clock */
  targetStatus: z
    .enum(['In Progress', 'Current'])
    .optional()
    .describe('In Progress (the default) starts it; Current promotes it without starting it'),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookMissionStartParams = z.infer<typeof rbookMissionStartSchema>;

/**
 * MCP Tool Definition for rbook_mission_start.
 *
 * Conforms to MCP tool definition spec for registration with the server.
 */
export const rbookMissionStartToolDefinition = {
  name: 'rbook_mission_start',
  description:
    'Start a mission by transitioning it to In Progress status. ' +
    'Valid from Queued or Current status. ' +
    'Returns INVALID_STATE_TRANSITION error with valid_transitions if the mission cannot be started.',
  inputSchema: {
    type: 'object',
    properties: {
      missionId: {
        type: 'string',
        description: 'The mission ID to start (e.g., "s12-m06")',
      },
      notes: {
        type: 'string',
        description: 'Optional notes about why this mission is being started',
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
 * Execute the rbook_mission_start tool.
 *
 * Transitions a mission from Queued or Current to In Progress.
 * Validates the state transition and returns actionable errors if invalid.
 *
 * @param params - Tool parameters (missionId, notes, projectRoot)
 * @returns RbookToolResult with start result or actionable error
 */
export async function rbookMissionStart(
  params: RbookMissionStartParams
): Promise<RbookToolResult<MissionStartResult>> {
  // Validate required parameter
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(RbookErrors.missingParameter('missionId'));
  }

  const missionId = params.missionId.trim();
  const targetStatus: MissionStatus = params.targetStatus ?? 'In Progress';
  // s97-m13 (#662): a promotion makes a mission the next to start; its clock (started_at), its
  // sprint's activation and its start event wait for the start itself.
  const promotion = targetStatus === 'Current';

  const warnings: string[] = [];
  const result = await withClientAsync(
    async (client) => {
      // Query mission by ID
      const missionResult = loadMissionForStart(client, missionId);

      if (!missionResult.success) {
        return createError<MissionStartResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }

      if (!missionResult.data) {
        return createError<MissionStartResult>(RbookErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const currentStatus = normalizeMissionStatus(mission.status);

      // Check if already in target status
      if (currentStatus === targetStatus) {
        return createError<MissionStartResult>({
          code: RBOOK_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Mission '${missionId}' is already ${targetStatus}`,
          currentState: currentStatus,
          suggestion: promotion
            ? `Start it with rbook_mission_transition(action="start", missionId="${missionId}")`
            : 'Use rbook_mission_transition(action="complete") to mark it done or rbook_mission_transition(action="block") if blocked',
        });
      }

      // Special handling for blocked missions - redirect to unblock tool
      if (currentStatus === 'Blocked') {
        return createError<MissionStartResult>({
          code: RBOOK_ERROR_CODES.MISSION_INVALID_TRANSITION,
          message: `Cannot start blocked mission '${missionId}'`,
          currentState: currentStatus,
          validTransitions: ['In Progress', 'Current'],
          suggestion:
            'Use rbook_mission_transition(action="unblock") to unblock this mission first. ' +
            'Provide a resolution explaining how the blocker was resolved.',
        });
      }

      // Validate state transition
      // s87-m01: guarded through the ONE shared helper. `currentStatus` is read from the store,
      // not validated by the type system, and an unrecognized value now yields a NAMED refusal
      // instead of an unhandled TypeError the MCP boundary reports as "an internal error".
      const validTransitions = transitionsFrom(currentStatus);
      if (validTransitions === undefined) {
        return createError<MissionStartResult>(
          RbookErrors.missionUnrecognizedStatus(missionId, currentStatus)
        );
      }
      if (!validTransitions.includes(targetStatus)) {
        return createError<MissionStartResult>(
          RbookErrors.missionInvalidTransition(missionId, currentStatus, targetStatus)
        );
      }

      // Perform the update
      const now = new Date().toISOString();
      // Ensure timestamp columns exist (migration)
      warnings.push(...(ensureMissionTimestamps(client).warnings ?? []));

      // Build update query - include notes if provided
      // Set started_at only if not already set (first start), always update updated_at
      let updateQuery: string;
      let updateParams: (string | null)[];

      if (promotion) {
        updateQuery = params.notes
          ? `UPDATE missions SET status = ?, notes = COALESCE(notes || ' | ', '') || ?, updated_at = ? WHERE id = ?`
          : `UPDATE missions SET status = ?, updated_at = ? WHERE id = ?`;
        updateParams = params.notes
          ? [targetStatus, `[Promoted] ${params.notes}`, now, missionId]
          : [targetStatus, now, missionId];
      } else if (params.notes) {
        updateQuery = `
          UPDATE missions
          SET status = ?,
              notes = COALESCE(notes || ' | ', '') || ?,
              started_at = COALESCE(started_at, ?),
              updated_at = ?
          WHERE id = ?
        `;
        updateParams = [targetStatus, `[Started] ${params.notes}`, now, now, missionId];
      } else {
        updateQuery = `
          UPDATE missions
          SET status = ?,
              started_at = COALESCE(started_at, ?),
              updated_at = ?
          WHERE id = ?
        `;
        updateParams = [targetStatus, now, now, missionId];
      }

      const beginResult = client.execute('BEGIN IMMEDIATE', []);
      if (!beginResult.success) {
        return createError<MissionStartResult>(
          beginResult.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to begin mission start transaction for '${missionId}'`,
            suggestion: 'Retry the mission start once the database is available',
          }
        );
      }

      let transactionOpen = true;

      const rollbackTransaction = (): void => {
        if (!transactionOpen) {
          return;
        }
        client.execute('ROLLBACK', []);
        transactionOpen = false;
      };

      let activatedSprintId: string | undefined;
      const sprintActivationResult = promotion
        ? { success: true as const, data: false }
        : shouldActivateParentSprint(client, mission.sprint_id);
      if (!sprintActivationResult.success) {
        rollbackTransaction();
        return createError<MissionStartResult>({
          code: sprintActivationResult.error?.code ?? 'DB_QUERY_FAILED',
          message: sprintActivationResult.error?.message ?? 'Could not inspect the parent sprint',
          suggestion: 'Check the sprints table and retry the mission start.',
        });
      }
      let otherOpen: string | undefined;
      if (sprintActivationResult.data && mission.sprint_id) {
        const open = client.getMany<{ id: string }>(
          `SELECT id FROM sprints WHERE id <> ? AND ${statusInSql('status', SPRINT_OPEN_STATUSES)}`,
          [mission.sprint_id]
        );
        if (!open.success) {
          rollbackTransaction();
          return createError<MissionStartResult>({
            code: open.error?.code ?? 'DB_QUERY_FAILED',
            message: open.error?.message ?? 'Could not check for another open sprint',
            suggestion: 'Restore read access to the sprints table, then retry the mission start.',
          });
        }
        otherOpen = open.data?.[0]?.id;
        if (otherOpen)
          warnings.push(
            `Sprint '${otherOpen}' is already open; '${mission.sprint_id}' stays Planned. To switch, use rbook_sprint(action="update", sprintId="${mission.sprint_id}", fields={status:"Active"}).`
          );
      }
      if (sprintActivationResult.data && mission.sprint_id && !otherOpen) {
        const activateSprintResult = activateParentSprint(client, mission.sprint_id, now);

        if (!activateSprintResult.success) {
          rollbackTransaction();
          return createError<MissionStartResult>(
            activateSprintResult.error ?? {
              code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
              message: `Failed to activate parent sprint '${mission.sprint_id}'`,
              suggestion: 'Check database connectivity and retry the mission start.',
            }
          );
        }
      }

      if (sprintActivationResult.data && mission.sprint_id && !otherOpen)
        activatedSprintId = mission.sprint_id;
      const updateResult = recordedExecute(client, updateQuery, updateParams);

      if (!updateResult.success) {
        rollbackTransaction();
        return createError<MissionStartResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to update mission' }
        );
      }

      if (updateResult.data?.changes === 0) {
        rollbackTransaction();
        return createError<MissionStartResult>({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update mission '${missionId}'`,
          suggestion: 'The mission may have been modified by another process',
        });
      }

      const commitResult = client.execute('COMMIT', []);
      if (!commitResult.success) {
        rollbackTransaction();
        return createError<MissionStartResult>(
          commitResult.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Failed to commit mission start for '${missionId}'`,
            suggestion: 'Retry the mission start once the database transaction can be committed.',
          }
        );
      }
      transactionOpen = false;
      if (activatedSprintId) syncSprintTracking(client, warnings);

      // Log the state change to session_events
      const eventResult = client.execute(
        `
        INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
        VALUES (?, 'mcp-tool', ?, ?, ?, ?, ?)
      `,
        [
          now,
          missionId,
          promotion ? 'promote' : 'start',
          targetStatus,
          params.notes ?? `${promotion ? 'Promoted' : 'Started'} mission ${missionId}`,
          JSON.stringify({
            tool: 'rbook_mission_start',
            missionId,
            previousStatus: currentStatus,
            newStatus: targetStatus,
            notes: params.notes,
          }),
        ]
      );

      // Don't fail the operation if event logging fails (non-critical) — but say so.
      if (!checkWrite(eventResult, warnings, 'mission start event logging')) {
        console.warn('Failed to log mission start event:', eventResult.error);
      }

      // Surface relevant decisions for this mission (non-critical)
      let relevantDecisions: RelevantDecision[] | undefined;
      const missionDetail = client.getOne<{
        objective: string | null;
        success_criteria: string | null;
      }>('SELECT objective, success_criteria FROM missions WHERE id = ?', [missionId]);
      if (missionDetail.success && missionDetail.data) {
        const searchText = buildMissionSearchText(
          missionDetail.data.objective,
          missionDetail.data.success_criteria
        );
        if (searchText.length > 0) {
          const found = await findRelevantDecisions(client, searchText);
          if (found.length > 0) {
            relevantDecisions = found;
          }
        }
      }

      return createSuccess<MissionStartResult>(
        {
          missionId,
          previousStatus: currentStatus,
          currentStatus: targetStatus,
          message: promotion
            ? `Mission '${missionId}' is now Current: next to start, not started`
            : `Mission '${missionId}' is now In Progress`,
          ...(promotion ? {} : { startedAt: now }),
          ...(activatedSprintId ? { activatedSprintId } : {}),
          relevantDecisions,
          localProjectId: getProjectId(client),
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

function loadMissionForStart(
  client: RbookDatabaseClient,
  missionId: string
): RbookToolResult<Pick<Mission, 'id' | 'status' | 'name' | 'sprint_id'>> {
  const missionResult = client.getOne<Pick<Mission, 'id' | 'status' | 'name' | 'sprint_id'>>(
    `
      SELECT id, status, name, sprint_id
      FROM missions
      WHERE id = ?
    `,
    [missionId]
  );

  if (
    missionResult.success ||
    missionResult.error?.code !== RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH ||
    !missionResult.error?.message.includes('sprint_id')
  ) {
    return missionResult as RbookToolResult<Pick<Mission, 'id' | 'status' | 'name' | 'sprint_id'>>;
  }

  const legacyResult = client.getOne<Mission>(
    `
      SELECT id, status, name
      FROM missions
      WHERE id = ?
    `,
    [missionId]
  );

  if (!legacyResult.success || !legacyResult.data) {
    return legacyResult as RbookToolResult<Pick<Mission, 'id' | 'status' | 'name' | 'sprint_id'>>;
  }

  return createSuccess({
    ...legacyResult.data,
    sprint_id: null,
  });
}

function shouldActivateParentSprint(
  client: { getOne: RbookDatabaseClient['getOne'] },
  sprintId: string | null
): RbookToolResult<boolean> {
  if (!sprintId) {
    return createSuccess(false);
  }

  const sprintResult = client.getOne<{ status: string | null }>(
    'SELECT status FROM sprints WHERE id = ?',
    [sprintId]
  );

  if (!sprintResult.success) {
    return createError<boolean>(
      sprintResult.error ?? {
        code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
        message: `Failed to query sprint '${sprintId}'`,
        suggestion: 'Check database connectivity and schema',
      }
    );
  }

  return createSuccess(sprintResult.data?.status === 'Planned');
}

function activateParentSprint(
  client: RbookDatabaseClient,
  sprintId: string,
  startedAt: string
): ReturnType<RbookDatabaseClient['execute']> {
  const updateWithStartDate = recordedExecute(
    client,
    `
      UPDATE sprints
      SET status = 'Active',
          start_date = COALESCE(start_date, ?)
      WHERE id = ?
        AND status = 'Planned'
    `,
    [startedAt, sprintId]
  );

  // s86-m02b: stated as the NEGATIVE test (De Morgan of the original
  // `success || code !== … || !message.includes(…)` early return) so the failure
  // path is the one named in the condition. Behaviour is identical.
  if (
    !updateWithStartDate.success &&
    updateWithStartDate.error?.code === RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH &&
    updateWithStartDate.error?.message.includes('start_date')
  ) {
    return recordedExecute(
      client,
      `
      UPDATE sprints
      SET status = 'Active'
      WHERE id = ?
        AND status = 'Planned'
    `,
      [sprintId]
    );
  }

  return updateWithStartDate;
}

/**
 * Format mission start result for LLM readability.
 *
 * @param result - Mission start result
 * @returns Human-readable formatted result
 */
export function formatMissionStartForLLM(result: RbookToolResult<MissionStartResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to start mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

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
  const lines: string[] = data.startedAt
    ? [
        `✓ Mission '${data.missionId}' started`,
        '',
        `Status: ${data.previousStatus} → ${data.currentStatus}`,
        `Started at: ${data.startedAt}`,
      ]
    : [
        `✓ Mission '${data.missionId}' promoted, not started`,
        '',
        `Status: ${data.previousStatus} → ${data.currentStatus}`,
      ];

  if (data.relevantDecisions && data.relevantDecisions.length > 0) {
    lines.push('');
    lines.push(`**Relevant Past Decisions** (${data.relevantDecisions.length}):`);
    const localProjectId = data.localProjectId ?? null;
    for (const d of data.relevantDecisions) {
      const cat = d.category ? ` [${d.category}]` : '';
      const sprint = d.sprintId ? ` (${d.sprintId})` : '';
      // s92-m07: archived and stale decisions surface too, so every row names its status.
      const status = d.status ? `, ${d.status}` : '';
      // s83-m06: a relevant decision pull-merged from ANOTHER project is foreign,
      // untrusted content — render its text inside the provenance fence instead of
      // as a bare bullet that could read as an instruction. Mirrors the ratified
      // LIST precedent (rbook-decisions-list.ts). Local rows stay bare.
      const isForeign =
        d.projectId != null && (localProjectId == null || d.projectId !== localProjectId);
      if (isForeign) {
        lines.push(`  • #${d.id}${status}${cat}${sprint} [proj:${d.projectId}]`);
        lines.push(frameForeignText(d.decisionText, `proj:${d.projectId}`));
        // s83-m06 (review): evidence is also foreign-author-controlled free text —
        // it MUST stay inside the fence, not render bare after [END UNTRUSTED DATA].
        if (d.evidence) {
          lines.push('    Evidence:');
          lines.push(frameForeignText(d.evidence, `proj:${d.projectId}`));
        }
      } else {
        // s92-m08: decisionText is already a preview of at most 300 characters.
        lines.push(`  • #${d.id}${status}${cat}${sprint}: ${d.decisionText}`);
        if (d.evidence) {
          lines.push(`    Evidence: ${d.evidence}`);
        }
      }
    }
  }

  if (data.relevantDecisions?.some((d) => d.truncated)) {
    lines.push(
      '  (Previews; read one in full with rbook_decisions(action="show", decisionId=<id>).)'
    );
  }

  // Surface warnings (incl. the m05 collab-sync warnings the transition dispatcher
  // folds in: lock contention, a superseded conflict, or a non-fatal broker-sync error).
  appendWarnings(lines, result);

  return lines.join('\n');
}
