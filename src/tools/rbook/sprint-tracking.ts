// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps master_context.sprint_tracking in step with the sprints table at every sprint
// ABOUTME: boundary (add, status update, close), so no external runbook has to maintain it.

import type { RbookDatabaseClient } from './client';
import { isRecordedStore } from './record-recording';
import { SPRINT_OPEN_STATUSES } from './terminal-status';
import { checkWrite } from './write-guard';

/**
 * s91-m07 — TraceLab ran a manual runbook at every sprint boundary to keep four pointers in step.
 * Grounding showed only two of them exist anywhere: `master_context.sprint_tracking.current_sprint`
 * and `.last_completed_sprint` (null and sprint-76 on the origin store, fourteen sprints stale,
 * because nothing wrote them). They are written here. NOT written, deliberately:
 *  - `master_context.project_identity.status` — the PROJECT's status, owned by
 *    rbook_context(update, contextType=project_identity); a sprint id does not belong in it.
 *  - `metadata.current_sprint` / `metadata.sprint_status` — absent on the store, read by nothing;
 *    creating them would be a surface asserting a state nobody consumes.
 */

export interface SprintPointer {
  id: string;
  title: string;
  status: string;
  focus: string | null;
}

/**
 * The sprint with an open status (the single-current invariant keeps it to at most one). Two copies of
 * a shared record can each open one (s96-m12): every copy then names the one created last by the
 * record's clock, then by change id as the merge orders, as a solo store names the one it inserted last.
 */
export function openSprintPointer(client: RbookDatabaseClient): SprintPointer | null {
  const placeholders = SPRINT_OPEN_STATUSES.map(() => '?').join(', ');
  const create = (column: string) =>
    `(SELECT max(c.${column}) FROM record_changes c WHERE c.kind = 'create' AND c.entity = 'sprints'
          AND c.entity_id = sprints.stable_event_id) DESC, `;
  const created = isRecordedStore(client) ? create('hlc') + create('change_id') : '';
  const row = client.getOne<SprintPointer>(
    `SELECT id, title, status, focus FROM sprints
      WHERE status IN (${placeholders})
      ORDER BY ${created}rowid DESC LIMIT 1`,
    [...SPRINT_OPEN_STATUSES]
  );
  if (!row.success)
    throw new Error(`Open sprint lookup failed: ${row.error?.message ?? 'unknown'}`);
  return row.data ?? null;
}

/** Set the pointers on an already-parsed master_context object (the close persists it itself). */
export function applySprintTracking(
  masterContext: Record<string, unknown>,
  current: SprintPointer | null,
  lastCompletedSprintId?: string
): void {
  const existing =
    masterContext.sprint_tracking && typeof masterContext.sprint_tracking === 'object'
      ? (masterContext.sprint_tracking as Record<string, unknown>)
      : {};
  masterContext.sprint_tracking = {
    ...existing,
    current_sprint: current,
    ...(lastCompletedSprintId !== undefined
      ? { last_completed_sprint: lastCompletedSprintId }
      : {}),
  };
}

/**
 * Re-derive and persist the pointers after a sprint add/update. Non-fatal: the sprint write has
 * already succeeded, so a failed pointer write is DISCLOSED as a warning, never swallowed.
 */
export function syncSprintTracking(
  client: RbookDatabaseClient,
  warnings: string[],
  lastCompletedSprintId?: string
): void {
  // No contexts table or no master_context row: there is no pointer to keep in step.
  const table = client.getOne<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contexts'`,
    []
  );
  if (table.success && !table.data) return;
  const row = client.getOne<{ content: string }>(
    `SELECT content FROM contexts WHERE id = 'master_context'`,
    []
  );
  if (!row.success) {
    warnings.push(
      'master_context is unreadable, so sprint_tracking was not updated for this sprint change.'
    );
    return;
  }
  if (!row.data) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.data.content) as Record<string, unknown>;
  } catch {
    warnings.push(
      'master_context content is not valid JSON, so sprint_tracking was not updated for this sprint change.'
    );
    return;
  }
  let current: SprintPointer | null;
  try {
    current = openSprintPointer(client);
  } catch (error) {
    warnings.push(
      `sprint_tracking was not updated: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }
  applySprintTracking(parsed, current, lastCompletedSprintId);
  checkWrite(
    client.execute(`UPDATE contexts SET content = ?, updated_at = ? WHERE id = 'master_context'`, [
      JSON.stringify(parsed),
      new Date().toISOString(),
    ]),
    warnings,
    'master_context.sprint_tracking'
  );
}
