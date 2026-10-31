// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Lists bounded next-step previews and expands named rows without losing historical pointers.
// ABOUTME: Shares one visibility query across list and show; explicit IDs retain moved and resolved rows.
import { prepareSpinOutRead, spinOutDetails, spinOutPointerLines } from './spin-out-read';
import type { RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import type { NextStepStatus } from './schema-migrations';
import { createError, createSuccess, RbookErrors } from './errors';
import {
  CLOSES_SURVIVED_SQL,
  LEASE_COUNTING_RULE,
  LEASE_LAPSE_AT,
  LEASE_WARN_AT,
  LEASED_STATUS_SQL,
  LEASE_AGE_DAYS_SQL,
  leaseState,
} from './next-step-lease';
import { previewText } from './text-preview';
import { getProjectId } from './project-id';
import type { NextStepRecord, NextStepsResult } from './rbook-next-steps';
import {
  nextPageCall,
  pageFacts,
  pageRequest,
  REREAD_AFTER_ACTING,
  shownLine,
} from './answer-page';

/**
 * s106-m03: open rows per page of the list. A registered store with 207 open next steps answered
 * 155,898 characters in one list, and 20 rows of this repo's ran to 20,687; a row with its lease
 * and pointers is about 1,000 characters.
 */
export const NEXT_STEPS_PAGE_SIZE = 15;

/** The page a list asks for, and the filters its next-page call repeats. */
export interface NextStepsPage {
  readonly page?: number;
  readonly pageSize?: number;
  /** The project the call read, repeated by the next-page call. */
  readonly projectRoot?: string;
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
  project_id: string | null;
}

/**
 * s85-m04: restructured from two hardcoded, ternary-selected SQL literals into the
 * conditions-builder shape used by rbook-decisions-list.ts. The old form had no `conditions[]`
 * array at all, so adding the `missionId` filter to only one of the two branches would have
 * been an easy and invisible mistake — the pending branch inlined its status while the other
 * bound it. One query, one param list, both predicates applied uniformly.
 */
export function readNextSteps(
  client: RbookDatabaseClient,
  status: NextStepStatus | undefined,
  missionId?: string,
  ids?: number[],
  action: 'list' | 'show' = 'list',
  paging: NextStepsPage = {}
): RbookToolResult<NextStepsResult> {
  // s91-m06: with no status filter the list is the lease view — every OPEN row, carried included.
  // Carried rows used to be invisible to every surface but an explicit `carried` filter.
  // Show is an explicit historical lookup; list filters cannot hide a requested row.
  if (action === 'show') {
    status = undefined;
    missionId = undefined;
  }
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

  const columns = client.getMany<{ name: string }>('PRAGMA table_info(next_steps)');
  if (!columns.success || !columns.data)
    return createError({
      code: 'DB_QUERY_FAILED',
      message: 'Failed to inspect next-step origin metadata',
      suggestion:
        'Check database access and retry; origin metadata must be readable before showing next steps.',
    });
  const origin = columns.data.some((column) => column.name === 'project_id')
    ? 'n.project_id'
    : 'NULL AS project_id';
  // s106-m03: a list without named ids pages; named ids (show, or a list of ids) return every one.
  const request =
    action === 'list' && ids === undefined
      ? pageRequest(paging.page, paging.pageSize, NEXT_STEPS_PAGE_SIZE)
      : null;
  const where = `FROM next_steps n WHERE ${conditions.join(' AND ')}`;
  const query = `SELECT ${origin}, n.id, n.content, n.status, n.session_id, n.sprint_id, n.mission_id,
            n.created_at, n.resolved_at, n.carried_to_sprint, ${CLOSES_SURVIVED_SQL} AS closes_survived,
            ${LEASE_AGE_DAYS_SQL} AS age_days
     ${where} ORDER BY julianday(n.created_at) ASC, n.id ASC${request ? ' LIMIT ? OFFSET ?' : ''}`;

  const result = client.getMany<NextStepRow & { closes_survived: number; age_days: number | null }>(
    query,
    request ? [...queryParams, request.pageSize, request.offset] : queryParams
  );
  const total = request
    ? client.getOne<{ count: number }>(`SELECT COUNT(*) AS count ${where}`, queryParams)
    : null;
  if (total && (!total.success || !total.data))
    return createError<NextStepsResult>({
      code: 'DB_QUERY_FAILED',
      message: 'Failed to count next-steps',
      suggestion: 'Check database access and retry the list.',
    });

  if (!result.success || !result.data) {
    return createError<NextStepsResult>({
      code: 'DB_QUERY_FAILED',
      message: 'Failed to query next-steps',
    });
  }

  const items: NextStepRecord[] = result.data.map((row) => {
    const { preview, truncated, fullLength } = previewText(row.content);
    return {
      ...spinOutDetails(visibility, 'next-step', row.id),
      id: row.id,
      content: action === 'show' ? row.content : preview,
      truncated: action === 'show' ? false : truncated,
      fullLength,
      projectId: row.project_id,
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
    };
  });

  const totalCount = total?.data?.count;
  const facts =
    request && totalCount !== undefined ? pageFacts(request, items.length, totalCount) : null;
  return createSuccess<NextStepsResult>({
    nextStepAction: action,
    localProjectId: getProjectId(client),
    ...(action === 'show'
      ? { missingIds: [...new Set(ids)].filter((id) => !items.some((item) => item.id === id)) }
      : {}),
    items,
    affected: items.length,
    ...(facts
      ? {
          totalCount: facts.totalCount,
          page: facts.page,
          pageSize: facts.pageSize,
          hasMore: facts.hasMore,
          nextPage: facts.nextPage,
          nextPageCall: nextPageCall(facts.nextPage, 'rbook_context', {
            action: 'next_steps',
            nextStepAction: 'list',
            nextStepStatus: status,
            missionId,
            pageSize: paging.pageSize,
            projectRoot: paging.projectRoot,
          }),
          pageNote: facts.nextPage === null ? null : REREAD_AFTER_ACTING,
        }
      : {}),
    message: `Found ${totalCount ?? items.length} next-step(s) ${
      status === undefined
        ? ids === undefined
          ? 'open (pending or carried)'
          : 'by explicit IDs'
        : `with status '${status}'`
    }${missionId ? ` for mission '${missionId}'` : ''}`,
  });
}

/**
 * The next-steps answer itself. Split out of formatNextStepsForLLM in s86-m02 so the envelope
 * warnings channel renders from one tail instead of once per action branch.
 */
export function renderNextStepsBody(result: RbookToolResult<NextStepsResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [`Failed to manage next-steps: ${error?.message ?? 'Unknown error'}`];
    if (error?.suggestion) lines.push(`Suggestion: ${error.suggestion}`);
    return lines.join('\n');
  }

  const d = result.data;

  if ((d.nextStepAction === 'list' || d.nextStepAction === 'show') && d.items) {
    const paged =
      d.page !== undefined && d.pageSize !== undefined && d.totalCount !== undefined
        ? { page: d.page, pageSize: d.pageSize, totalCount: d.totalCount }
        : null;
    if (d.items.length === 0) {
      // Echo the filter that matched nothing, e.g. "No next-step(s) open (pending or carried)".
      if (paged && paged.totalCount > 0) return `${shownLine(paged, 0, 'next steps')}.`;
      return `${d.message.replace(/^Found 0 /, 'No ')}.`;
    }
    // s106-m03: a list states its page and total; show and named ids list every row asked for.
    const lines = [
      paged
        ? `**Next Steps**: ${shownLine(paged, d.items.length, 'next steps')}`
        : `**Next Steps (${d.items.length})**`,
      '',
    ];
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
    if (d.nextStepAction === 'list' && d.items.some((item) => item.truncated))
      lines.push(
        '',
        'Read full text: rbook_context(action="next_steps", nextStepAction="show", nextStepIds=[...]).'
      );
    if (d.items.some((item) => item.closesSurvived !== undefined)) {
      lines.push('');
      lines.push(
        `Lease: warn at ${LEASE_WARN_AT}, drop at ${LEASE_LAPSE_AT} unless carried. ${LEASE_COUNTING_RULE}.`
      );
    }
    if (d.nextPageCall) lines.push('', `Next page: ${d.nextPageCall}.`);
    if (d.pageNote) lines.push(d.pageNote);
    return lines.join('\n');
  }

  return d.message;
}
