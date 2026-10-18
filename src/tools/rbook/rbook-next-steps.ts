// ABOUTME: Manages next-step state transitions without discarding a carried row's lease anchor.
// ABOUTME: Reports affected, unmatched and failed IDs explicitly for each lifecycle action.

/**
 * Next-Step Lifecycle Handler
 *
 * Manages structured next-steps with status tracking:
 * - list: View pending/all next-steps
 * - complete: Mark a next-step as completed
 * - carry: Carry open next-steps to a new sprint
 * - drop: Drop a next-step (no longer relevant)
 * - reopen: Return a completed, dropped or carried next-step to pending
 *
 * Wired into rbook_context(action="next_steps").
 *
 * @module tools/rbook/rbook-next-steps
 */

import {
  prepareSpinOutRead,
  spinOutDetails,
  spinOutPointerLines,
  type SpinOutDetails,
} from './spin-out-read';
import { withClient, type RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RbookErrors } from './errors';
import { ensureNextStepsTable, type NextStepStatus } from './schema-migrations';
import { appendWarnings, appendWriteFailures, attachWarnings } from './format-warnings';
import { skipConflicted, skippedConflicts } from './record-conflict-skip';
import { countWrite, type WriteFailure } from './write-guard';
import {
  CLOSES_SURVIVED_SQL,
  LEASED_STATUS_SQL,
  LEASE_AGE_DAYS_SQL,
  LEASE_COUNTING_RULE,
  LEASE_LAPSE_AT,
  LEASE_WARN_AT,
  leaseState,
  type LeaseState,
} from './next-step-lease';
import { recordedExecute } from './record-changes';

/**
 * A next-step record from the database.
 */
export interface NextStepRecord extends SpinOutDetails {
  id: number;
  content: string;
  status: NextStepStatus;
  sessionId: string | null;
  sprintId: string | null;
  missionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  carriedToSprint: string | null;
  /** s91-m06: sprint closes this open row has survived (see next-step-lease.ts); open rows only. */
  closesSurvived?: number;
  /** s91-m06: `lapsing` = the next close drops it unless carried; `warning` = the one after. */
  lease?: LeaseState;
}

/**
 * s87-m06 — WHICH statuses a next-step transition may move OUT of. Exactly two, and no others.
 *
 * It was `status = 'pending'` at all three write sites, so a row CARRIED to a later sprint could
 * never afterwards be completed, dropped, or re-carried by id. That is not hypothetical: rows
 * #486, #492 and #493 are stamped `carried_to_sprint='sprint-86'`, were still open at sprint-87,
 * and were frozen — they could only age.
 *
 * `'completed'` IS DELIBERATELY NOT ADMITTED. `write-disclosure-next-steps.test.ts` CRITERION 8
 * seeds a completed row and asserts that transitioning it reports `affected: 0` with no write
 * failure and no warning; admitting it breaks all five of that test's assertions. If that test
 * needs editing to accommodate a change here, the change is wrong — not the test.
 *
 * Sprint close deliberately does not reuse this predicate. Its whole-ledger survey performs no
 * next_steps write because mission/sprint links are provenance, not delivery evidence. Keep this
 * status gate local to explicit operator actions where caller-supplied ids can legitimately miss
 * without implying a database failure. Sprint-close disclosure tests cover its separate context
 * writes and survey-read failure.
 */
const TRANSITIONABLE_STATUS = "status IN ('pending','carried')";

/** Published next-step sub-actions, shared by the handler and rbook_context's two schemas. */
export const NEXT_STEP_ACTIONS = ['list', 'complete', 'carry', 'drop', 'reopen'] as const;
export type NextStepAction = (typeof NEXT_STEP_ACTIONS)[number];

/** Reopening is intentionally narrower than the ordinary pending/carried transition predicate. */
const REOPENABLE_STATUS = "status IN ('completed','dropped','carried')";

export interface NextStepsResult {
  /** The sub-action that was performed */
  nextStepAction: string;
  /** Next-steps returned (for list) */
  items?: NextStepRecord[];
  /** Count of items affected */
  affected: number;
  /** s86-m02b — writes an action ATTEMPTED and the database REJECTED. Emitted by every write
   *  action (complete/carry/drop/reopen), `[]` on the happy path; absent on `list`, which writes
   *  nothing. `affected` above counts rows the UPDATE actually changed, so a non-empty array
   *  here is the difference between the intent and the outcome. A caller-supplied id that
   *  matched no row eligible for that action is NOT a failure — its WHERE matched nothing —
   *  and produces no entry. */
  writeFailures?: WriteFailure[];
  /**
   * s87-m06 — WHICH requested ids the transition did not match.
   *
   * `affected` says HOW MANY rows moved. Asking for 12 and getting 10 told an operator that two
   * ids did nothing and gave them no way to find out which two. These ids are not failures and
   * are deliberately NOT reported as such: the statement ran and its WHERE matched nothing, which
   * is an ordinary outcome for an id whose status that action does not accept, or that does not
   * exist. `writeFailures` means the database REJECTED something, and conflating the two would
   * tell an operator a write failed when none did — the "say only what you know" violation this
   * fix exists to close, committed inside the fix.
   *
   * Absent on `list`, which writes nothing. Empty when every requested id matched.
   */
  unmatchedIds?: number[];
  /** Message */
  message: string;
}

export interface RbookNextStepsParams {
  /** Sub-action: list | complete | carry | drop | reopen */
  nextStepAction: NextStepAction;
  /** Filter by status (for list; default: the open rows, pending and carried — s91-m06) */
  nextStepStatus?: NextStepStatus;
  /** s85-m04: filter list to next-steps stamped with this mission (#487 read surface) */
  missionId?: string;
  /** Next-step IDs for historical list lookup or complete/carry/drop/reopen. Explicit list IDs bypass implicit open-status filtering. */
  nextStepIds?: number[];
  /** Target sprint for carry action */
  carryToSprint?: string;
  /** Optional project root */
  projectRoot?: string;
}

export async function rbookNextSteps(
  params: RbookNextStepsParams
): Promise<RbookToolResult<NextStepsResult>> {
  const action = params.nextStepAction;

  if (!action || !NEXT_STEP_ACTIONS.includes(action)) {
    return createError<NextStepsResult>({
      code: 'INVALID_ACTION',
      message: `Invalid next_step action: '${action}'`,
      suggestion: `Use nextStepAction: ${NEXT_STEP_ACTIONS.join(' | ')}`,
      validValues: [...NEXT_STEP_ACTIONS],
    });
  }

  const migrationWarnings: string[] = [];
  const result = await withClient(
    (client) => {
      migrationWarnings.push(...(ensureNextStepsTable(client).warnings ?? []));

      switch (action) {
        case 'list':
          return listNextSteps(client, params.nextStepStatus, params.missionId, params.nextStepIds);
        case 'complete':
          return transitionNextSteps(client, params.nextStepIds ?? [], 'completed');
        case 'carry':
          return carryNextSteps(client, params.nextStepIds, params.carryToSprint ?? null);
        case 'drop':
          return transitionNextSteps(client, params.nextStepIds ?? [], 'dropped');
        case 'reopen':
          return reopenNextSteps(client, params.nextStepIds ?? []);
        default:
          return createError<NextStepsResult>({
            code: 'INVALID_ACTION',
            message: `Unknown next_step action: '${action}'`,
          });
      }
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, migrationWarnings);
}

interface NextStepRow {
  id: number;
  content: string;
  status: string;
  session_id: string | null;
  sprint_id: string | null;
  mission_id: string | null;
  created_at: string;
  resolved_at: string | null;
  carried_to_sprint: string | null;
}

/**
 * s85-m04: restructured from two hardcoded, ternary-selected SQL literals into the
 * conditions-builder shape used by rbook-decisions-list.ts. The old form had no `conditions[]`
 * array at all, so adding the `missionId` filter to only one of the two branches would have
 * been an easy and invisible mistake — the pending branch inlined its status while the other
 * bound it. One query, one param list, both predicates applied uniformly.
 */
function listNextSteps(
  client: RbookDatabaseClient,
  status: NextStepStatus | undefined,
  missionId?: string,
  ids?: number[]
): RbookToolResult<NextStepsResult> {
  // s91-m06: with no status filter the list is the lease view — every OPEN row, carried included.
  // Carried rows used to be invisible to every surface but an explicit `carried` filter.
  ids = ids ?? undefined;
  if (
    ids !== undefined &&
    (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
  )
    return createError(RbookErrors.invalidParameter('nextStepIds', ids, ['positive integer IDs']));
  const visibility = prepareSpinOutRead(client);
  const conditions =
    status === undefined ? (ids === undefined ? [LEASED_STATUS_SQL] : ['1=1']) : ['n.status = ?'];
  const queryParams: unknown[] = status === undefined ? [] : [status];
  if (ids !== undefined) {
    conditions.push(ids.length ? `n.id IN (${ids.map(() => '?').join(',')})` : '0');
    queryParams.push(...ids);
  } else {
    const visible = visibility.predicate('next-step', 'n.id');
    conditions.push(visible.sql);
    queryParams.push(...visible.params);
  }

  if (missionId) {
    conditions.push('n.mission_id = ?');
    queryParams.push(missionId);
  }

  const query = `SELECT n.id, n.content, n.status, n.session_id, n.sprint_id, n.mission_id,
            n.created_at, n.resolved_at, n.carried_to_sprint, ${CLOSES_SURVIVED_SQL} AS closes_survived,
            ${LEASE_AGE_DAYS_SQL} AS age_days
     FROM next_steps n WHERE ${conditions.join(' AND ')} ORDER BY julianday(n.created_at) ASC`;

  const result = client.getMany<NextStepRow & { closes_survived: number; age_days: number | null }>(
    query,
    queryParams
  );

  if (!result.success || !result.data) {
    return createError<NextStepsResult>({
      code: 'DB_QUERY_FAILED',
      message: 'Failed to query next-steps',
    });
  }

  const items: NextStepRecord[] = result.data.map((row) => ({
    ...spinOutDetails(visibility, 'next-step', row.id),
    id: row.id,
    content: row.content,
    status: row.status as NextStepStatus,
    sessionId: row.session_id,
    sprintId: row.sprint_id,
    missionId: row.mission_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    carriedToSprint: row.carried_to_sprint,
    ...(row.status === 'pending' || row.status === 'carried'
      ? {
          closesSurvived: row.closes_survived,
          lease: leaseState(row.closes_survived, row.age_days),
        }
      : {}),
  }));

  return createSuccess<NextStepsResult>({
    nextStepAction: 'list',
    items,
    affected: items.length,
    message: `Found ${items.length} next-step(s) ${
      status === undefined
        ? ids === undefined
          ? 'open (pending or carried)'
          : 'by explicit IDs'
        : `with status '${status}'`
    }${missionId ? ` for mission '${missionId}'` : ''}`,
  });
}

function transitionNextSteps(
  client: RbookDatabaseClient,
  ids: number[],
  targetStatus: 'completed' | 'dropped'
): RbookToolResult<NextStepsResult> {
  if (ids.length === 0) {
    return createError<NextStepsResult>(RbookErrors.missingParameter('nextStepIds'));
  }

  const now = new Date().toISOString();
  const writeSink = { failures: [] as WriteFailure[] };
  const op = targetStatus === 'completed' ? 'next_steps.complete' : 'next_steps.drop';
  let affected = 0;
  const unmatchedIds: number[] = [];

  for (const id of ids) {
    const result = recordedExecute(
      client,
      `UPDATE next_steps SET status = ?, resolved_at = ? WHERE id = ? AND ${TRANSITIONABLE_STATUS}`,
      [targetStatus, now, id]
    );
    // s86-m02b: the ids come from the TOOL CALL and were never re-selected, so `changes: 0` on a
    // statement that RAN means "no transitionable row with that id" — legitimate, and countWrite
    // records nothing for it. Only an errored statement reaches writeSink.
    // s87-m06: that zero is now NAMED rather than merely not-counted. It is the value countWrite
    // already returns; nothing new is computed.
    const changed = countWrite(result, writeSink, `${op} #${id}`);
    if (result.success && (result.data?.changes ?? 0) === 0) unmatchedIds.push(id);
    affected += changed;
  }

  return createSuccess<NextStepsResult>({
    nextStepAction: targetStatus === 'completed' ? 'complete' : 'drop',
    affected,
    writeFailures: writeSink.failures,
    unmatchedIds,
    message: `${affected} next-step(s) marked as ${targetStatus}`,
  });
}

function reopenNextSteps(
  client: RbookDatabaseClient,
  ids: number[]
): RbookToolResult<NextStepsResult> {
  if (ids.length === 0) {
    return createError<NextStepsResult>(RbookErrors.missingParameter('nextStepIds'));
  }

  const writeSink = { failures: [] as WriteFailure[] };
  let affected = 0;
  const unmatchedIds: number[] = [];

  for (const id of ids) {
    const result = recordedExecute(
      client,
      `UPDATE next_steps SET status = 'pending', resolved_at = CASE WHEN status = 'carried' THEN resolved_at ELSE NULL END, carried_to_sprint = NULL WHERE id = ? AND ${REOPENABLE_STATUS}`,
      [id]
    );
    const changed = countWrite(result, writeSink, `next_steps.reopen #${id}`);
    if (result.success && (result.data?.changes ?? 0) === 0) unmatchedIds.push(id);
    affected += changed;
  }

  return createSuccess<NextStepsResult>({
    nextStepAction: 'reopen',
    affected,
    writeFailures: writeSink.failures,
    unmatchedIds,
    message: `${affected} next-step(s) reopened`,
  });
}

function carryNextSteps(
  client: RbookDatabaseClient,
  ids: number[] | undefined,
  targetSprint: string | null
): RbookToolResult<NextStepsResult> {
  if (targetSprint !== null) {
    const sprint = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
      targetSprint,
    ]);
    if (!sprint.success) {
      return createError<NextStepsResult>(
        sprint.error ?? {
          code: 'DB_QUERY_FAILED',
          message: `Failed to validate carryToSprint '${targetSprint}'`,
        }
      );
    }
    if (!sprint.data) {
      return createError<NextStepsResult>({
        code: 'INVALID_PARAMETER',
        field: 'carryToSprint',
        providedValue: targetSprint,
        message: `No sprint row exists for carryToSprint '${targetSprint}'; no next-steps were carried.`,
        suggestion:
          `Create it first with rbook_sprint(action="add", sprintId="${targetSprint}", title="<title>"), then retry; ` +
          'or omit carryToSprint to park the row as carried with no target. Parked rows leave ' +
          'rbook_agent_onboard\'s pending view; list them with rbook_context(action="next_steps", ' +
          'nextStepAction="list", nextStepStatus="carried").',
      });
    }
  }

  // If no IDs provided, carry ALL pending next-steps
  const now = new Date().toISOString();
  const writeSink = { failures: [] as WriteFailure[] };

  if (!ids || ids.length === 0) {
    // Carry all pending; on a shared record, skip a row whose status is in conflict (s96-m12).
    const conflicted = ['status', 'resolved_at', 'carried_to_sprint'];
    const skipped = skippedConflicts(client, 'next_steps', conflicted, TRANSITIONABLE_STATUS, []);
    const result = recordedExecute(
      client,
      `UPDATE next_steps SET status = 'carried', resolved_at = ?, carried_to_sprint = ? WHERE ${TRANSITIONABLE_STATUS}${skipConflicted(client, 'next_steps', conflicted)}`,
      [now, targetSprint]
    );
    const affected = countWrite(result, writeSink, 'next_steps.carry (all pending)');
    const carried = createSuccess<NextStepsResult>({
      nextStepAction: 'carry',
      affected,
      writeFailures: writeSink.failures,
      message: targetSprint
        ? `${affected} pending next-step(s) carried to ${targetSprint}`
        : `${affected} pending next-step(s) marked as carried`,
    });
    return attachWarnings(carried, skipped ? [skipped] : []);
  }

  let affected = 0;
  const unmatchedIds: number[] = [];
  for (const id of ids) {
    const result = recordedExecute(
      client,
      `UPDATE next_steps SET status = 'carried', resolved_at = ?, carried_to_sprint = ? WHERE id = ? AND ${TRANSITIONABLE_STATUS}`,
      [now, targetSprint, id]
    );
    // Caller-supplied id: a zero from a WHERE that matched no transitionable row is ordinary and
    // is not a write failure. s87-m06 names it instead of discarding it.
    const changed = countWrite(result, writeSink, `next_steps.carry #${id}`);
    if (result.success && (result.data?.changes ?? 0) === 0) unmatchedIds.push(id);
    affected += changed;
  }

  return createSuccess<NextStepsResult>({
    nextStepAction: 'carry',
    affected,
    writeFailures: writeSink.failures,
    unmatchedIds,
    message: targetSprint
      ? `${affected} next-step(s) carried to ${targetSprint}`
      : `${affected} next-step(s) marked as carried`,
  });
}

/**
 * Format next-steps result for LLM readability.
 */
export function formatNextStepsForLLM(result: RbookToolResult<NextStepsResult>): string {
  const lines = [renderNextStepsBody(result)];

  // s87-m06 — the unmatched ids, on a NEUTRAL line, and the neutrality is the whole design.
  //
  // It carries neither the WRITE-FAILURE heading nor the WARNINGS heading nor the
  // `next_steps.<op> #<id>` write-failure format, because an id that matched no transitionable
  // row is NOT a failure: the statement ran and its WHERE matched nothing. Announcing it as a
  // write failure would tell an operator the database rejected something it did not — which is
  // precisely the "say only what you know" violation this whole sprint is closing, committed
  // inside the fix for it. `write-disclosure-next-steps.test.ts` CRITERION 8 names that
  // temptation in as many words and must keep passing UNMODIFIED; a plain extra line trips none
  // of its five assertions.
  //
  // Placed BEFORE the two envelope channels so an operator reads what happened before reading
  // what went wrong — and so a reader can tell at a glance that it is neither of those things.
  const unmatched = result.data?.unmatchedIds ?? [];
  if (unmatched.length > 0) {
    const reason =
      result.data?.nextStepAction === 'reopen'
        ? 'not completed/dropped/carried, or no such id'
        : 'already resolved, or no such id';
    lines.push('');
    lines.push(`Not matched (${reason}): ${unmatched.map((id) => `#${id}`).join(', ')}`);
  }

  appendWriteFailures(lines, result.data?.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}

/**
 * The next-steps answer itself. Split out of formatNextStepsForLLM in s86-m02 so the envelope
 * warnings channel renders from one tail instead of once per action branch.
 */
function renderNextStepsBody(result: RbookToolResult<NextStepsResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [`Failed to manage next-steps: ${error?.message ?? 'Unknown error'}`];
    if (error?.suggestion) lines.push(`Suggestion: ${error.suggestion}`);
    return lines.join('\n');
  }

  const d = result.data;

  if (d.nextStepAction === 'list' && d.items) {
    if (d.items.length === 0) {
      // Echo the filter that matched nothing, e.g. "No next-step(s) open (pending or carried)".
      return `${d.message.replace(/^Found 0 /, 'No ')}.`;
    }
    const lines = [`**Next Steps (${d.items.length})**`, ''];
    for (const item of d.items) {
      const sprint = item.sprintId ? ` [${item.sprintId}]` : '';
      const mission = item.missionId ? ` (${item.missionId})` : '';
      const lease =
        item.closesSurvived === undefined
          ? ''
          : ` {closes survived ${item.closesSurvived}${item.lease === 'ok' ? '' : `, ${item.lease}`}}`;
      lines.push(`  #${item.id} [${item.status}]${lease}${sprint}${mission}: ${item.content}`);
      lines.push(...spinOutPointerLines(item));
    }
    if (d.items.some((item) => item.closesSurvived !== undefined)) {
      lines.push('');
      lines.push(
        `Lease: warn at ${LEASE_WARN_AT}, drop at ${LEASE_LAPSE_AT} unless carried. ${LEASE_COUNTING_RULE}.`
      );
    }
    return lines.join('\n');
  }

  return d.message;
}
