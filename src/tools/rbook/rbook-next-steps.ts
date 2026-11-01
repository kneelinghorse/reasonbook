// ABOUTME: Routes next-step previews, full lookup and lifecycle changes without losing lease anchors.
// ABOUTME: Reports missing, unmatched and failed IDs explicitly while preserving historical pointers.

/**
 * Next-Step Lifecycle Handler
 *
 * Manages structured next-steps with status tracking:
 * - list: Preview pending/all next-steps
 * - show: Read named next-steps in full
 * - complete: Mark a next-step as completed
 * - carry: Carry open next-steps to a new sprint
 * - drop: Drop a next-step (no longer relevant)
 * - reopen: Return a completed, dropped or carried next-step to pending
 *
 * Wired into rbook_context(action="next_steps").
 *
 * @module tools/rbook/rbook-next-steps
 */

import type { SpinOutDetails } from './spin-out-read';
import { withClient, type RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RbookErrors } from './errors';
import { ensureNextStepsTable, type NextStepStatus } from './schema-migrations';
import { appendWarnings, appendWriteFailures, attachWarnings } from './format-warnings';
import { skipConflicted, skippedConflicts } from './record-conflict-skip';
import { countWrite, type WriteFailure } from './write-guard';
import type { LeaseState } from './next-step-lease';
import { recordedExecute, recordedTransaction } from './record-changes';
import { isRecordedStore } from './record-recording';
import { readNextSteps, renderNextStepsBody } from './next-steps-read';
import { bareDateSql, readCheckAfter, SHARED_DATE_NOTE } from './next-step-dates';
import {
  deleteNextStepReason,
  NEXT_STEP_REASON_MAX,
  NEXT_STEP_REASONS,
  prepareNextStepReasons,
  rowsWithoutStableIds,
  SHARED_REASON_NOTE,
  writeNextStepReason,
} from './next-step-reasons';
import { inapplicableParam, isGiven } from './inapplicable-param';
import { sanitizeContentField } from '../../intelligence/content-sanitizer';
import { emptiedParameter } from './emptied-parameter';

/**
 * A next-step record from the database.
 */
export interface NextStepRecord extends SpinOutDetails {
  id: number;
  content: string;
  /** List previews normalize whitespace and cap content at 300 characters; show returns original text. */
  truncated?: boolean;
  fullLength?: number;
  /** Origin namespace; NULL for historical rows without a recorded origin. */
  projectId?: string | null;
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
  /** s108-m02: an open row's date, while it is ahead (next-step-dates.ts). */
  waitsUntil?: string;
  /** s108-m02: an open row's date, once it has come. */
  dueSince?: string;
  /** s108-m02: why a completed or dropped row was resolved, while it still has that resolution. */
  reason?: string;
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
export const NEXT_STEP_ACTIONS = ['list', 'show', 'complete', 'carry', 'drop', 'reopen'] as const;
export type NextStepAction = (typeof NEXT_STEP_ACTIONS)[number];

/**
 * s108-m02 — which of next_steps' own parameters each sub-action takes. RBOOK_CONTEXT_ACTION_PARAMS is
 * keyed by action, so it cannot reach below next_steps; this table does, and every other pairing of
 * these keys with a sub-action is refused rather than ignored (inapplicable-param.ts).
 */
export const NEXT_STEP_ACTION_PARAMS: Readonly<
  Record<NextStepAction, readonly ('reason' | 'checkAfter')[]>
> = {
  list: [],
  show: [],
  complete: ['reason'],
  carry: ['checkAfter'],
  drop: ['reason'],
  reopen: [],
};

/** Reopening is intentionally narrower than the ordinary pending/carried transition predicate. */
const REOPENABLE_STATUS = "status IN ('completed','dropped','carried')";

export interface NextStepsResult {
  /** The sub-action that was performed */
  nextStepAction: string;
  /** Next-steps returned (for list and show) */
  items?: NextStepRecord[];
  /** Requested show IDs with no stored row; distinct from failed or unmatched writes. */
  missingIds?: number[];
  /** Store identity used to distinguish returned local IDs from foreign-origin IDs. */
  localProjectId?: string;
  /** Count of items affected */
  affected: number;
  /** s106-m03, a list without named ids: every matching row, this page's number and size. */
  totalCount?: number;
  page?: number;
  pageSize?: number;
  hasMore?: boolean;
  nextPage?: number | null;
  /** The call that reads the next page with the same filters, or null on the last page. */
  nextPageCall?: string | null;
  /** While a page follows: acting on a row moves the later rows up, so re-read before paging. */
  pageNote?: string | null;
  /** s86-m02b — writes an action ATTEMPTED and the database REJECTED. Emitted by every write
   *  action (complete/carry/drop/reopen), `[]` on the happy path; absent on `list` and `show`, which write
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
   * Absent on `list` and `show`, which write nothing. Empty when every requested id matched.
   */
  unmatchedIds?: number[];
  /** Message */
  message: string;
}

export interface RbookNextStepsParams {
  /** Sub-action: list | show | complete | carry | drop | reopen */
  nextStepAction: NextStepAction;
  /** Filter by status (for list; default: the open rows, pending and carried — s91-m06) */
  nextStepStatus?: NextStepStatus;
  /** Filter list and carry to next-steps stamped with this mission. */
  missionId?: string;
  /** Next-step IDs for full show, historical list lookup or complete/carry/drop/reopen. Explicit list IDs bypass implicit open-status filtering. */
  nextStepIds?: number[];
  /** Target sprint for carry action */
  carryToSprint?: string;
  /** s108-m02: complete and drop, why; kept in this copy's next_step_reasons table. */
  reason?: string;
  /** s108-m02: carry by explicit ids, the day the rows wait until (next-step-dates.ts). */
  checkAfter?: string;
  /** s106-m03: page of the list, 1-based, and rows per page (default NEXT_STEPS_PAGE_SIZE) */
  page?: number;
  pageSize?: number;
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

  const inapplicable = inapplicableParam(
    `rbook_context(action="next_steps", nextStepAction="${action}")`,
    NEXT_STEP_ACTION_PARAMS[action],
    params as unknown as Record<string, unknown>,
    ['reason', 'checkAfter']
  );
  if (inapplicable) return createError<NextStepsResult>(inapplicable);

  const warnings: string[] = [];
  let reason: string | undefined;
  if (isGiven(params.reason)) {
    const cleaned = sanitizeContentField(String(params.reason).trim());
    if (!cleaned.cleaned.trim()) return createError<NextStepsResult>(emptiedParameter('reason'));
    if (cleaned.wasModified)
      warnings.push(
        `reason held a stray tool-call tag, so it was kept only up to it: ${cleaned.reason ?? ''}`
      );
    reason = cleaned.cleaned.trim();
    // Enforced here, not in zod, whose max would publish maxLength on the wire (design, settled item 8).
    // Characters are code points, so an emoji counts once, not as its two UTF-16 units.
    const characters = [...reason].length;
    if (characters > NEXT_STEP_REASON_MAX)
      return createError<NextStepsResult>({
        code: 'INVALID_PARAMETER',
        field: 'reason',
        providedValue: `${characters} characters`,
        message: `reason is ${characters} characters; it can be at most ${NEXT_STEP_REASON_MAX}.`,
        suggestion: `Shorten it to ${NEXT_STEP_REASON_MAX} characters or fewer, and record anything longer as a decision or learning.`,
      });
  }
  let checkAfter: string | undefined;
  if (isGiven(params.checkAfter)) {
    if (!params.nextStepIds?.length)
      return createError<NextStepsResult>({
        code: 'INVALID_PARAMETER',
        field: 'checkAfter',
        providedValue: params.checkAfter,
        message:
          'A carry without nextStepIds carries every open next step, so it cannot give them one date; nothing was carried.',
        suggestion:
          'Name the rows: rbook_context(action="next_steps", nextStepAction="carry", nextStepIds=[…], checkAfter=…).',
      });
    const day = readCheckAfter(String(params.checkAfter), 'carry');
    if ('error' in day) return createError<NextStepsResult>(day.error);
    checkAfter = day.day;
  }

  if (action === 'show') {
    const ids = params.nextStepIds;
    if (ids === undefined || (Array.isArray(ids) && ids.length === 0))
      return createError(RbookErrors.missingParameter('nextStepIds'));
    if (!Array.isArray(ids) || ids.some((id) => !Number.isSafeInteger(id) || id < 1))
      return createError(
        RbookErrors.invalidParameter('nextStepIds', ids, ['positive integer IDs'])
      );
  }

  const result = await withClient(
    (client) => {
      warnings.push(...(ensureNextStepsTable(client).warnings ?? []));

      switch (action) {
        case 'list':
        case 'show':
          return readNextSteps(
            client,
            params.nextStepStatus,
            params.missionId,
            params.nextStepIds,
            action,
            { page: params.page, pageSize: params.pageSize, projectRoot: params.projectRoot }
          );
        case 'complete':
          return transitionNextSteps(client, params.nextStepIds ?? [], 'completed', reason);
        case 'carry':
          return carryNextSteps(
            client,
            params.nextStepIds,
            params.carryToSprint ?? null,
            params.missionId,
            checkAfter
          );
        case 'drop':
          return transitionNextSteps(client, params.nextStepIds ?? [], 'dropped', reason);
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
  return attachWarnings(result, warnings);
}

/** The status change and its reason in one write, so neither lands without the other. */
function changeWithReason(
  client: RbookDatabaseClient,
  id: number,
  targetStatus: 'completed' | 'dropped',
  now: string,
  reason: string
): RbookToolResult<{ changes: number; lastInsertRowid: number | bigint }> {
  const written = recordedTransaction(client, () => {
    const updated = client.execute(
      `UPDATE next_steps SET status = ?, resolved_at = ? WHERE id = ? AND ${TRANSITIONABLE_STATUS}`,
      [targetStatus, now, id]
    );
    if (!updated.success) throw new Error(updated.error?.message ?? 'next-step update failed');
    const changes = updated.data?.changes ?? 0;
    if (changes > 0) writeNextStepReason(client, id, reason, targetStatus, now);
    return changes;
  });
  if (!written.success)
    return createError(
      written.error ?? { code: 'DB_QUERY_FAILED', message: `next step #${id} was not changed` }
    );
  return createSuccess({ changes: written.data ?? 0, lastInsertRowid: 0 });
}

function transitionNextSteps(
  client: RbookDatabaseClient,
  ids: number[],
  targetStatus: 'completed' | 'dropped',
  reason?: string
): RbookToolResult<NextStepsResult> {
  if (ids.length === 0) {
    return createError<NextStepsResult>(RbookErrors.missingParameter('nextStepIds'));
  }
  if (reason !== undefined) {
    // Before any write: the stable ids a reason is keyed by, and its table (design, round 3's N3).
    const unprepared = prepareNextStepReasons(client);
    if (unprepared) return createError<NextStepsResult>(unprepared);
    const keyless = rowsWithoutStableIds(client, ids);
    if (keyless.length)
      return createError<NextStepsResult>({
        code: 'INVALID_PARAMETER',
        field: 'reason',
        providedValue: keyless,
        message: `A reason is kept by the next step's stable id, and ${keyless.map((id) => `#${id}`).join(', ')} ${keyless.length === 1 ? 'has' : 'have'} none; nothing was changed.`,
        suggestion: `Send the call without reason for ${keyless.length === 1 ? 'that row' : 'those rows'}, and with it for the others.`,
      });
  }

  const now = new Date().toISOString();
  const writeSink = { failures: [] as WriteFailure[] };
  const op = targetStatus === 'completed' ? 'next_steps.complete' : 'next_steps.drop';
  let affected = 0;
  const unmatchedIds: number[] = [];

  for (const id of ids) {
    const result =
      reason === undefined
        ? recordedExecute(
            client,
            `UPDATE next_steps SET status = ?, resolved_at = ? WHERE id = ? AND ${TRANSITIONABLE_STATUS}`,
            [targetStatus, now, id]
          )
        : changeWithReason(client, id, targetStatus, now, reason);
    // s86-m02b: the ids come from the TOOL CALL and were never re-selected, so `changes: 0` on a
    // statement that RAN means "no transitionable row with that id" — legitimate, and countWrite
    // records nothing for it. Only an errored statement reaches writeSink.
    // s87-m06: that zero is now NAMED rather than merely not-counted. It is the value countWrite
    // already returns; nothing new is computed.
    const changed = countWrite(result, writeSink, `${op} #${id}`);
    if (result.success && (result.data?.changes ?? 0) === 0) unmatchedIds.push(id);
    affected += changed;
  }

  const changed = createSuccess<NextStepsResult>({
    nextStepAction: targetStatus === 'completed' ? 'complete' : 'drop',
    affected,
    writeFailures: writeSink.failures,
    unmatchedIds,
    message: `${affected} next-step(s) marked as ${targetStatus}${reason !== undefined && affected ? ', with the reason' : ''}`,
  });
  return attachWarnings(
    changed,
    reason !== undefined && affected && isRecordedStore(client) ? [SHARED_REASON_NOTE] : []
  );
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
  const now = new Date().toISOString();
  // s108-m02: reopening a row that waits on a date ends the wait (the anchor becomes now), and a
  // reopen deletes the reason it would otherwise only hide. A store without the table has none.
  const reopen = `UPDATE next_steps SET status = 'pending', resolved_at = CASE WHEN status = 'carried' THEN CASE WHEN ${bareDateSql('resolved_at')} AND julianday(resolved_at) > julianday(?) THEN ? ELSE resolved_at END ELSE NULL END, carried_to_sprint = NULL WHERE id = ? AND ${REOPENABLE_STATUS}`;
  const reasons = client.getOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [NEXT_STEP_REASONS]
  );

  for (const id of ids) {
    const result =
      reasons.success && reasons.data
        ? reopenWithReason(client, reopen, now, id)
        : recordedExecute(client, reopen, [now, now, id]);
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

function reopenWithReason(
  client: RbookDatabaseClient,
  sql: string,
  now: string,
  id: number
): RbookToolResult<{ changes: number; lastInsertRowid: number | bigint }> {
  const written = recordedTransaction(client, () => {
    const updated = client.execute(sql, [now, now, id]);
    if (!updated.success) throw new Error(updated.error?.message ?? 'next-step reopen failed');
    const changes = updated.data?.changes ?? 0;
    if (changes > 0) deleteNextStepReason(client, id);
    return changes;
  });
  if (!written.success)
    return createError(
      written.error ?? { code: 'DB_QUERY_FAILED', message: `next step #${id} was not reopened` }
    );
  return createSuccess({ changes: written.data ?? 0, lastInsertRowid: 0 });
}

function carryNextSteps(
  client: RbookDatabaseClient,
  ids: number[] | undefined,
  targetSprint: string | null,
  missionId?: string,
  checkAfter?: string
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

  // The same mission predicate constrains broad carry, explicit IDs and conflict disclosure.
  const now = new Date().toISOString();
  const writeSink = { failures: [] as WriteFailure[] };
  const missionFilter = missionId === undefined ? '' : ' AND mission_id = ?';
  const missionParams = missionId === undefined ? [] : [missionId];
  const eligible = TRANSITIONABLE_STATUS + missionFilter;
  // s108-m02 (settled item 4): a carry renews the lease, but keeps a date still ahead, so it never
  // erases the day a row waits until. Only the bare date counts: a full stamp ahead of now (another
  // machine's clock) is renewed as before. 4.9.0 and older stamp now, the documented residual.
  const renewed = `CASE WHEN ${bareDateSql('resolved_at')} AND julianday(resolved_at) > julianday(?) THEN resolved_at ELSE ? END`;

  if (!ids || ids.length === 0) {
    // Carry all pending; on a shared record, skip a row whose status is in conflict (s96-m12).
    const conflicted = ['status', 'resolved_at', 'carried_to_sprint'];
    const skipped = skippedConflicts(client, 'next_steps', conflicted, eligible, missionParams);
    const result = recordedExecute(
      client,
      `UPDATE next_steps SET status = 'carried', resolved_at = ${renewed}, carried_to_sprint = ? WHERE ${eligible}${skipConflicted(client, 'next_steps', conflicted)}`,
      [now, now, targetSprint, ...missionParams]
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
      `UPDATE next_steps SET status = 'carried', resolved_at = ${checkAfter === undefined ? renewed : '?'}, carried_to_sprint = ? WHERE id = ? AND ${eligible}`,
      [
        ...(checkAfter === undefined ? [now, now] : [checkAfter]),
        targetSprint,
        id,
        ...missionParams,
      ]
    );
    // Caller-supplied id: a zero from a WHERE that matched no transitionable row is ordinary and
    // is not a write failure. s87-m06 names it instead of discarding it.
    const changed = countWrite(result, writeSink, `next_steps.carry #${id}`);
    if (result.success && (result.data?.changes ?? 0) === 0) unmatchedIds.push(id);
    affected += changed;
  }

  const dated = checkAfter === undefined ? '' : `, waiting until ${checkAfter}`;
  const carried = createSuccess<NextStepsResult>({
    nextStepAction: 'carry',
    affected,
    writeFailures: writeSink.failures,
    unmatchedIds,
    message: targetSprint
      ? `${affected} next-step(s) carried to ${targetSprint}${dated}`
      : `${affected} next-step(s) marked as carried${dated}`,
  });
  return attachWarnings(
    carried,
    checkAfter !== undefined && affected && isRecordedStore(client) ? [SHARED_DATE_NOTE] : []
  );
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
        : result.data?.nextStepAction === 'carry'
          ? 'already resolved, outside the requested mission, or no such id'
          : 'already resolved, or no such id';
    lines.push('');
    lines.push(`Not matched (${reason}): ${unmatched.map((id) => `#${id}`).join(', ')}`);
  }

  if (result.data?.missingIds?.length)
    lines.push('', `Not found: ${result.data.missingIds.map((id) => `#${id}`).join(', ')}`);

  appendWriteFailures(lines, result.data?.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}
