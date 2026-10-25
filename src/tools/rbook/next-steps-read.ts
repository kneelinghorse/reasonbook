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
  action: 'list' | 'show' = 'list'
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
  const query = `SELECT ${origin}, n.id, n.content, n.status, n.session_id, n.sprint_id, n.mission_id,
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

  return createSuccess<NextStepsResult>({
    nextStepAction: action,
    localProjectId: getProjectId(client),
    ...(action === 'show'
      ? { missingIds: [...new Set(ids)].filter((id) => !items.some((item) => item.id === id)) }
      : {}),
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
    return lines.join('\n');
  }

  return d.message;
}
