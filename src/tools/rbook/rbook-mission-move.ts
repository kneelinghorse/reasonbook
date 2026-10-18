// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Implements rbook_mission(action="move") — re-binds a mission to a different sprint.
// ABOUTME: Refuses closed destinations and terminal missions; never renumbers the mission id.

/**
 * Sprint 86 m08 — a supported sprint re-binding.
 *
 * WHY THIS EXISTS. `missions.sprint_id` carries two different facts in one column: "which sprint
 * CREATED this mission" and "which sprint OWNS its execution". For every mission written before
 * sprint-85 those were the same fact, so nothing forced them apart. They diverged the first time
 * a sprint took in defect work mid-flight, and the column answered with the creating sprint —
 * the only thing `rbook_mission(add)` can know. Until now the sole repair was raw SQL against
 * durable state (`rbook-mission-update.ts`'s fieldMapping has no `sprint_id` entry), so the
 * operator's real choice was between a wrong number and an out-of-band write.
 *
 * THE HARM IS NOT KPI COSMETICS. `resolveCurrentSprintId` step 1 returns the sprint of any
 * In Progress/Current mission, excluding only the DEAD sprint statuses — 'Completed' is NOT in
 * that set. So starting a mission bound to a closed sprint makes that CLOSED sprint the system's
 * current sprint, and `inferSprintIdForDecisionCapture` then stamps it onto every decision,
 * learning and constraint captured in the session. Onboarding also scopes Queued missions to the
 * active sprint, so a re-queued mission on the wrong sprint never surfaces at all.
 *
 * WHY IT IS AN ACTION ON `rbook_mission` AND NOT A TRANSITION.
 * `RBOOK_MISSION_TRANSITION_ACTIONS` is exactly the six STATUS transitions. A sprint re-binding
 * changes a CRUD field, not a status — it belongs beside list/show/add/update/depends.
 *
 * THE ID IS NOT RENUMBERED, DELIBERATELY. Four tables carry `REFERENCES missions`
 * (mission_dependencies, session_missions, agent_feedback, next_steps) plus the session_events
 * trail. The `s85-` prefix on a moved mission is a CREATION-TIME LABEL, not an ownership claim;
 * the formatter says so rather than pretending otherwise.
 *
 * @module tools/rbook/rbook-mission-move
 */

import { z } from 'zod';
import { withClientValidated } from './client';
import type { RbookToolResult, Mission, MissionStatus, SanitizedFieldReport } from './types';
import {
  createError,
  createSuccess,
  RbookErrors,
  RBOOK_ERROR_CODES,
  VALID_STATE_TRANSITIONS,
  transitionsFrom,
} from './errors';
import { ensureMissionTimestamps } from './schema-migrations';
import { sanitizeContentField } from '../../intelligence/content-sanitizer';
import { appendWarnings, attachWarnings } from './format-warnings';
import { checkWrite } from './write-guard';
import { isTerminalStatus, SPRINT_NO_OPEN_WORK_STATUSES } from './terminal-status';
import { recordedExecute } from './record-changes';

/** Result of moving a mission to a different sprint. */
export interface MissionMoveResult {
  /** The mission ID that was moved (NEVER renumbered — see the module note). */
  missionId: string;

  /** The sprint the mission was bound to before the move. `null` when it had no binding. */
  fromSprintId: string | null;

  /** The sprint the mission is bound to now. */
  toSprintId: string;

  /** The mission's status, which a move never changes. */
  status: MissionStatus;

  /** The reason recorded on the breadcrumb, when one was given. */
  reason: string | null;

  /** Human-readable message. */
  message: string;

  /** Timestamp of the move. */
  movedAt: string;

  /** True when the mission was already bound to `toSprintId` and NOTHING was written. */
  noOp: boolean;
}

export const rbookMissionMoveSchema = z.object({
  missionId: z.string().min(1).describe('The mission ID to move (e.g., "s85-m06")'),
  toSprintId: z.string().min(1).describe('Destination sprint ID (must be an open sprint)'),
  reason: z.string().optional().describe('Optional reason recorded on the mission breadcrumb'),
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookMissionMoveParams = z.infer<typeof rbookMissionMoveSchema>;

/** A mission row plus the one field the move reads that {@link Mission} does not declare. */
type MissionWithSprint = Mission & { sprint_id: string | null };

export async function rbookMissionMove(
  params: RbookMissionMoveParams
): Promise<RbookToolResult<MissionMoveResult>> {
  if (!params.missionId || params.missionId.trim() === '') {
    return createError(RbookErrors.missingParameter('missionId'));
  }
  if (!params.toSprintId || params.toSprintId.trim() === '') {
    return createError(RbookErrors.missingParameter('toSprintId'));
  }

  const missionId = params.missionId.trim();
  const toSprintId = params.toSprintId.trim();

  // Sprint 60 m02: sanitize free text so XML sibling absorption strips out and surfaces
  // rather than being written verbatim into the mission's notes.
  const inputSanitized: SanitizedFieldReport[] = [];
  let cleanedReason = params.reason;
  if (typeof cleanedReason === 'string') {
    const r = sanitizeContentField(cleanedReason);
    if (r.wasModified) {
      cleanedReason = r.cleaned;
      inputSanitized.push({ field: 'reason', reason: r.reason ?? '' });
    }
  }

  const warnings: string[] = [];
  const result = await withClientValidated(
    (client) => {
      // ─── 1. The mission exists ───────────────────────────────────────────
      const missionResult = client.getOne<MissionWithSprint>(
        `SELECT id, status, name, sprint_id FROM missions WHERE id = ?`,
        [missionId]
      );

      if (!missionResult.success) {
        return createError<MissionMoveResult>(
          missionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query mission' }
        );
      }
      if (!missionResult.data) {
        return createError<MissionMoveResult>(RbookErrors.missionNotFound(missionId));
      }

      const mission = missionResult.data;
      const fromSprintId = mission.sprint_id ?? null;
      const currentStatus = mission.status;

      // ─── 2. The destination sprint exists ────────────────────────────────
      // Checked BEFORE the status rule so a typo'd sprint id returns SPRINT_NOT_FOUND rather
      // than a confusing "closed sprint" refusal — and never a silent success-with-0-changes.
      const sprintResult = client.getOne<{ id: string; status: string | null }>(
        `SELECT id, status FROM sprints WHERE id = ?`,
        [toSprintId]
      );

      if (!sprintResult.success) {
        return createError<MissionMoveResult>(
          sprintResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query sprint' }
        );
      }
      if (!sprintResult.data) {
        return createError<MissionMoveResult>(RbookErrors.sprintNotFound(toSprintId));
      }

      // ─── 3. The destination sprint can still hold open work ──────────────
      // `isTerminalStatus` is the JS-side twin of `statusNotInSql` and folds case the same way,
      // so a drifted-case 'completed' cannot dodge the refusal. The check is JS-side rather
      // than an `AND UPPER(status) NOT IN (…)` clause on the SELECT above ON PURPOSE: folding
      // it into the query would make a NONEXISTENT sprint and a CLOSED sprint return the same
      // empty row, and the operator would be told the wrong thing about which one they hit.
      //
      // HARD REFUSE, no override flag (fork f18(a)). Allow-and-warn was rejected outright: it is
      // the "bury the truth in warnings[]" compromise this sprint exists to stop making, and it
      // would let a Completed sprint become the resolved current sprint through the very surface
      // built to prevent that.
      const destinationStatus = sprintResult.data.status;
      if (isTerminalStatus(destinationStatus, SPRINT_NO_OPEN_WORK_STATUSES)) {
        return createError<MissionMoveResult>({
          code: RBOOK_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Sprint '${toSprintId}' has status '${destinationStatus}' and carries no open work — a mission moved there could never be executed under it.`,
          // NOT `currentState`: that field is the MISSION's state everywhere else in this file
          // and in types.ts, and filling it with the SPRINT's status made the answer read
          // "Current status: Completed" about a mission that is Queued. The message above
          // already names the sprint and its status, which is the fact the operator needs.
          suggestion: `Move '${missionId}' into a sprint whose status is open (e.g. Active, In Progress, Current, or Planned), or keep its current assignment. New missions can be unscheduled with rbook_mission(action="add", sprintId=null).`,
        });
      }

      // ─── 4. The mission has a future to move ─────────────────────────────
      // DERIVED BY RULE, not hand-listed: refuse exactly when the mission's status has an EMPTY
      // transition set — today {Completed, Dropped}. A Completed mission's sprint credit is
      // historical fact; a Dropped mission can never re-enter work, so moving a tombstone only
      // corrupts both sprints' parked counts. If the stored status is not a key of the map at
      // all, REFUSE and name it — fail loud, never fail-open (the live store holds one such row,
      // status 'Archived', which is not in VALID_MISSION_STATUSES).
      // OWN properties only. A bare index falls through to Object.prototype, so a mission
      // stored with status 'constructor' resolved to a truthy function and MOVED — the
      // fail-loud rule below silently bypassed — while 'toString' was refused as "a terminal
      // status", which is not true of anything. Statuses come from the store, and the store
      // already proves unvalidated ones land there.
      // s87-m01: this file found the rule first; the hasOwnProperty read it inlined is now the
      // SHARED `transitionsFrom` in errors.ts, used by all six mission-transition sites. Same
      // behaviour, one implementation — so the next handler cannot reintroduce the bare index.
      const validTransitions = transitionsFrom(currentStatus);

      if (validTransitions === undefined) {
        return createError<MissionMoveResult>({
          code: RBOOK_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Mission '${missionId}' has unrecognized status '${currentStatus}', so whether it can still be worked is unknown — refusing to move it rather than guessing.`,
          currentState: currentStatus,
          validValues: Object.keys(VALID_STATE_TRANSITIONS),
          suggestion: `Set a recognized status first — rbook_mission(action="update", missionId="${missionId}", fields={"status":"Queued"}) — then retry the move. If that update also refuses, the row's status is outside VALID_MISSION_STATUSES entirely and needs a store-level repair; do not drop the mission to work around it, since Dropped is terminal.`,
        });
      }

      if (validTransitions.length === 0) {
        return createError<MissionMoveResult>({
          code: RBOOK_ERROR_CODES.MISSION_INVALID_STATE,
          message: `Mission '${missionId}' is '${currentStatus}', a terminal status — its sprint credit is settled and moving it would change history in both sprints.`,
          currentState: currentStatus,
          // Deliberately NOT suggesting drop-and-recreate: Dropped is terminal and irreversible.
          suggestion: `Leave it where it is. A terminal mission stays bound to the sprint that ended it and is surfaced there as parked work, not hidden.`,
        });
      }

      const now = new Date().toISOString();

      // ─── 5. No-op guard: same binding writes NOTHING ─────────────────────
      if (fromSprintId === toSprintId) {
        warnings.push(
          `Mission '${missionId}' is already bound to '${toSprintId}' — no change was written (no breadcrumb, no event row, updated_at untouched).`
        );
        return createSuccess<MissionMoveResult>(
          {
            missionId,
            fromSprintId,
            toSprintId,
            status: currentStatus,
            reason: cleanedReason ?? null,
            message: `Mission '${missionId}' was already bound to sprint '${toSprintId}'`,
            movedAt: now,
            noOp: true,
          },
          warnings,
          inputSanitized
        );
      }

      // ─── 6. The write ────────────────────────────────────────────────────
      const moveNote = cleanedReason
        ? `[Moved] ${fromSprintId ?? '(unbound)'} -> ${toSprintId} (${cleanedReason})`
        : `[Moved] ${fromSprintId ?? '(unbound)'} -> ${toSprintId}`;

      warnings.push(...(ensureMissionTimestamps(client).warnings ?? []));

      const updateResult = recordedExecute(
        client,
        `UPDATE missions
         SET sprint_id = ?,
             notes = COALESCE(notes || ' | ', '') || ?,
             updated_at = ?
         WHERE id = ?`,
        [toSprintId, moveNote, now, missionId]
      );

      if (!updateResult.success) {
        return createError<MissionMoveResult>(
          updateResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to move mission' }
        );
      }

      if (updateResult.data?.changes === 0) {
        return createError<MissionMoveResult>({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to move mission '${missionId}' — the UPDATE matched no rows`,
          suggestion: 'The mission may have been modified or removed by another process',
        });
      }

      // ─── 7. Provenance ───────────────────────────────────────────────────
      // Since s86-m02 the seven sibling transition handlers DO disclose this into the envelope
      // (checkWrite at rbook-mission-defer.ts, -drop, -unblock, -block, -start, -update; an
      // explicit warnings.push in -complete). What they also do is duplicate it to the console,
      // a channel no agent reads. This handler uses the envelope ALONE: `success` stays true —
      // the binding DID change — and the lost provenance row is disclosed exactly once.
      const eventResult = client.execute(
        `INSERT INTO session_events (ts, agent, mission, action, status, summary, raw_event)
         VALUES (?, 'mcp-tool', ?, 'move', ?, ?, ?)`,
        [
          now,
          missionId,
          currentStatus,
          cleanedReason ?? `Moved mission ${missionId} to ${toSprintId}`,
          JSON.stringify({
            tool: 'rbook_mission_move',
            missionId,
            fromSprintId,
            toSprintId,
            reason: cleanedReason ?? null,
          }),
        ]
      );

      checkWrite(eventResult, warnings, 'mission move event logging');

      return createSuccess<MissionMoveResult>(
        {
          missionId,
          fromSprintId,
          toSprintId,
          status: currentStatus,
          reason: cleanedReason ?? null,
          message: `Mission '${missionId}' moved to sprint '${toSprintId}'`,
          movedAt: now,
          noOp: false,
        },
        warnings,
        inputSanitized
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

export function formatMissionMoveForLLM(result: RbookToolResult<MissionMoveResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['❌ Failed to move mission', '', `Error: ${error?.message ?? 'Unknown error'}`];

    if (error?.currentState) {
      lines.push(`Current status: ${error.currentState}`);
    }

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = data.noOp
    ? [`↔ Mission '${data.missionId}' already belongs to sprint '${data.toSprintId}'`]
    : [
        `↔ Mission '${data.missionId}' moved`,
        '',
        `Sprint: ${data.fromSprintId ?? '(unbound)'} → ${data.toSprintId}`,
        `Status: ${data.status} (unchanged — a move re-binds, it does not transition)`,
        `Moved at: ${data.movedAt}`,
      ];

  if (!data.noOp && data.reason) {
    lines.push(`Reason: ${data.reason}`);
  }

  if (!data.noOp && !data.missionId.startsWith(idPrefixOf(data.toSprintId))) {
    // Say it plainly rather than letting a reader infer ownership from the id.
    lines.push(
      '',
      `Note: the mission id keeps its original prefix. An id is a creation-time label, not an ownership claim — '${data.missionId}' is now executed under '${data.toSprintId}'.`
    );
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

/** `sprint-86` -> `s86-`, the id prefix missions created under that sprint carry. */
function idPrefixOf(sprintId: string): string {
  const match = /^sprint-(\d+)$/.exec(sprintId);
  return match ? `s${match[1]}-` : `${sprintId}-`;
}
