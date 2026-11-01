// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Name deferred work, and Deferred work whose date has come, without treating an exhausted queue as a
// ABOUTME: completed sprint. Parked and due mission names retain the same foreign-data framing as other queue entries.
import type { RbookDatabaseClient } from './client';
import type { RbookToolResult, Sprint } from './types';
import { createError, createSuccess } from './errors';
import { frameInlineIfForeign } from '../../intelligence/provenance-frame';
import { missionDueDay } from '../../signals/rules-due';
import { storedTimeMs } from './stored-time';

/** s108-m03: the most due missions the notice names; it counts the rest. */
const DUE_NAMED = 3;

/**
 * s108-m03: Deferred missions, in any sprint, whose current date has come (rules-due.ts), the
 * earliest first; the queue leaves Deferred missions out, so this is where a due one is named. It
 * names three and counts the rest; the three named are left out of the parked notice, so a due
 * mission past the third is still named there.
 */
export function dueMissionNotice(
  client: RbookDatabaseClient,
  local: string | null,
  nowMs: number = Date.now()
): RbookToolResult<{ text: string; ids: readonly string[] }> {
  const deferred = client.getMany<{
    id: string;
    name: string;
    domain_fields?: unknown;
    project_id?: string | null;
  }>("SELECT * FROM missions WHERE status = 'Deferred' ORDER BY id ASC");
  if (!deferred.success)
    return createError({
      code: deferred.error?.code ?? 'DB_QUERY_FAILED',
      message: deferred.error?.message ?? 'Could not read deferred missions.',
      suggestion: 'Restore read access to missions and retry mission status.',
    });
  const due = (deferred.data ?? [])
    .map((mission) => ({ mission, day: missionDueDay(mission.domain_fields) }))
    .filter(
      (entry): entry is { mission: typeof entry.mission; day: string } =>
        entry.day !== null && storedTimeMs(entry.day) <= nowMs
    )
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const named = due
    .slice(0, DUE_NAMED)
    .map(
      ({ mission, day }) =>
        `${mission.id}: ${frameInlineIfForeign(mission.name, mission.project_id, local)} (since ${day})`
    );
  const more = due.length > DUE_NAMED ? `; and ${due.length - DUE_NAMED} more` : '';
  return createSuccess({
    text: due.length ? `Deferred and due: ${named.join('; ')}${more}.` : '',
    ids: due.slice(0, DUE_NAMED).map(({ mission }) => mission.id),
  });
}

export function parkedMissionNotice(
  client: RbookDatabaseClient,
  sprint: Sprint | null,
  local: string | null,
  /** s108-m03: missions the due notice already names. */
  except: ReadonlySet<string> = new Set()
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
  const listed = (parked.data ?? []).filter((m) => !except.has(m.id));
  return createSuccess(
    listed.length
      ? `Parked missions: ${listed.map((m) => `${m.id}: ${frameInlineIfForeign(m.name, m.project_id, local)}`).join('; ')}.`
      : ''
  );
}
