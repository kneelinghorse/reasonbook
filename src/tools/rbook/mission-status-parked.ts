// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Name deferred work without treating an exhausted queue as a completed sprint.
// ABOUTME: Parked mission names retain the same foreign-data framing as other queue entries.
import type { RbookDatabaseClient } from './client';
import type { RbookToolResult, Sprint } from './types';
import { createError, createSuccess } from './errors';
import { frameInlineIfForeign } from '../../intelligence/provenance-frame';

export function parkedMissionNotice(
  client: RbookDatabaseClient,
  sprint: Sprint | null,
  local: string | null
): RbookToolResult<string> {
  if (!sprint) return createSuccess('');
  const parked = client.getMany<{ id: string; name: string; project_id?: string | null }>(
    "SELECT * FROM missions WHERE sprint_id = ? AND status = 'Deferred' ORDER BY id ASC",
    [sprint.id]
  );
  if (!parked.success)
    return createError({
      code: parked.error?.code ?? 'DB_QUERY_FAILED',
      message: parked.error?.message ?? 'Could not read parked missions.',
      suggestion: 'Restore read access to missions and retry mission status.',
    });
  return createSuccess(
    parked.data?.length
      ? `Parked missions: ${parked.data.map((m) => `${m.id}: ${frameInlineIfForeign(m.name, m.project_id, local)}`).join('; ')}.`
      : ''
  );
}
