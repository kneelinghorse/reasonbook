// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02 — why a next step was completed or dropped, in a table outside the shared record,
// ABOUTME: keyed by the row's stable id and shown only while the row keeps the status and time it was written with.

import type { RbookDatabaseClient } from './client';
import { RBOOK_ERROR_CODES } from './errors';
import { ensureGenesisSchema } from './genesis-columns';
import type { RbookToolError } from './types';

/**
 * WHY A LOCAL TABLE (the sprint-108 design, settled item 2). A new column on `next_steps`, a shared
 * table, would fail older copies' deliveries or refuse older runtimes' writes. A table outside the
 * shared set is seen by no guard and sent by no exchange: record-columns.ts does not list it, a
 * share's dry run lists it as staying local, and spin-out does not copy it. It is still part of the
 * store file, so a whole-store copy (`reasonbook copy`, the direct join) or a checkpoint upload
 * carries it, as it carries every other table (docs/privacy.md, docs/trust.md). Sharing reasons
 * waits for a protocol-3 release.
 *
 * KEYED BY THE STABLE ID, NOT THE NUMBER. A renumber deletes a row and inserts it again under a new
 * id, copying `stable_event_id` (record-renumber.ts), so a reason survives a renumber by any release.
 *
 * SHOWN ONLY WHILE IT BELONGS. A reopen or a later resolve, by any release on any copy, rewrites the
 * row's status or `resolved_at`, and spin-out's drop changes the status alone (spin-out-mark.ts). A
 * reason is shown only while both still equal what it was written with, so an older runtime's reopen
 * hides it rather than leaving it to explain a different resolution.
 */
export const NEXT_STEP_REASONS = 'next_step_reasons';

/** Enforced here, not in zod: a zod max would publish maxLength on the wire (design, settled item 8). */
export const NEXT_STEP_REASON_MAX = 500;

/** What a reason does on a shared record, said by the answer that writes one. */
export const SHARED_REASON_NOTE =
  'This record is shared: exchanges do not send the reason to the other copies, which see the change without it. A whole-store copy or upload of this store still carries it.';

/** The reason a close's lease drop records. */
export function leaseDropReason(sprintId: string): string {
  return `lease lapsed at ${sprintId} close`;
}

/** The columns a reasons table must have to be read as one. */
const REASON_COLUMNS = ['stable_event_id', 'reason', 'status', 'resolved_at'];

/**
 * Whether this store holds the reasons table: absent, ours, or an object of that name with another
 * shape, which `CREATE TABLE IF NOT EXISTS` passes over without a word and Reasonbook never reads.
 */
function reasonsTable(client: RbookDatabaseClient): 'absent' | 'ours' | 'foreign' {
  const found = client.getOne<{ type: string }>('SELECT type FROM sqlite_master WHERE name = ?', [
    NEXT_STEP_REASONS,
  ]);
  if (!found.success) throw new Error(`Could not read the schema: ${found.error?.message}`);
  if (!found.data) return 'absent';
  if (found.data.type !== 'table') return 'foreign';
  const columns = client.getMany<{ name: string }>(`PRAGMA table_info('${NEXT_STEP_REASONS}')`, []);
  if (!columns.success)
    throw new Error(`Could not inspect ${NEXT_STEP_REASONS}: ${columns.error?.message}`);
  const names = new Set((columns.data ?? []).map((column) => column.name));
  return REASON_COLUMNS.every((name) => names.has(name)) ? 'ours' : 'foreign';
}

function hasStableIds(client: RbookDatabaseClient): boolean {
  const columns = client.getMany<{ name: string }>("PRAGMA table_info('next_steps')", []);
  if (!columns.success) throw new Error(`Could not inspect next_steps: ${columns.error?.message}`);
  return (columns.data ?? []).some((column) => column.name === 'stable_event_id');
}

/**
 * Before any transaction: the genesis columns a reason is keyed by, and the table. Returns the
 * refusal when either cannot be made, so a reason is never silently lost (design, round 3's N3).
 */
export function prepareNextStepReasons(client: RbookDatabaseClient): RbookToolError | null {
  try {
    ensureGenesisSchema(client, 'next_steps');
  } catch (error) {
    return {
      code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
      message: `A reason is kept by the next step's stable id, and next_steps could not be given one: ${error instanceof Error ? error.message : String(error)}`,
      suggestion:
        'Resolve the reported schema or lock problem and retry, or send the call without reason.',
    };
  }
  const created = client.execute(
    `CREATE TABLE IF NOT EXISTS ${NEXT_STEP_REASONS} (
      stable_event_id TEXT PRIMARY KEY NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL,
      resolved_at TEXT NOT NULL,
      recorded_at TEXT NOT NULL
    )`,
    []
  );
  if (!created.success)
    return {
      code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
      message: `The ${NEXT_STEP_REASONS} table could not be created: ${created.error?.message ?? 'unknown error'}`,
      suggestion:
        'Resolve the reported database problem and retry, or send the call without reason.',
    };
  if (reasonsTable(client) === 'foreign')
    return {
      code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
      message: `An object named ${NEXT_STEP_REASONS} that Reasonbook did not make holds the table's place, so a reason cannot be kept.`,
      suggestion: `Rename or remove that ${NEXT_STEP_REASONS} object and retry, or send the call without reason.`,
    };
  return null;
}

/** Requested rows that a reason cannot be kept for, because their stable id is NULL (round 4's N3). */
export function rowsWithoutStableIds(
  client: RbookDatabaseClient,
  ids: readonly number[]
): number[] {
  if (!ids.length) return [];
  const rows = client.getMany<{ id: number }>(
    `SELECT id FROM next_steps WHERE stable_event_id IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    [...ids]
  );
  if (!rows.success)
    throw new Error(`Could not read next steps' stable ids: ${rows.error?.message}`);
  return (rows.data ?? []).map((row) => row.id).sort((a, b) => a - b);
}

/**
 * Inside the write that sets the status: the reason, with the status and stamp it explains. A later
 * complete or drop with a reason replaces an older one, which an older runtime's reopen left behind.
 * Throws, rolling that write back, when the row has no stable id.
 */
export function writeNextStepReason(
  client: RbookDatabaseClient,
  id: number,
  reason: string,
  status: 'completed' | 'dropped',
  resolvedAt: string
): void {
  const row = client.getOne<{ stable_event_id: string | null }>(
    'SELECT stable_event_id FROM next_steps WHERE id = ?',
    [id]
  );
  if (!row.success) throw new Error(`Could not read next step #${id}: ${row.error?.message}`);
  const key = row.data?.stable_event_id;
  if (!key) throw new Error(`Next step #${id} has no stable id, so its reason cannot be kept.`);
  const written = client.execute(
    `INSERT INTO ${NEXT_STEP_REASONS} (stable_event_id, reason, status, resolved_at, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(stable_event_id) DO UPDATE SET reason = excluded.reason, status = excluded.status,
       resolved_at = excluded.resolved_at, recorded_at = excluded.recorded_at`,
    [key, reason, status, resolvedAt, new Date().toISOString()]
  );
  if (!written.success)
    throw new Error(`Could not keep next step #${id}'s reason: ${written.error?.message}`);
}

/** A 4.10.0 reopen deletes the reason it would otherwise only hide. Writes nothing on a store without our table. */
export function deleteNextStepReason(client: RbookDatabaseClient, id: number): void {
  if (reasonsTable(client) !== 'ours' || !hasStableIds(client)) return;
  const deleted = client.execute(
    `DELETE FROM ${NEXT_STEP_REASONS}
      WHERE stable_event_id = (SELECT stable_event_id FROM next_steps WHERE id = ?)`,
    [id]
  );
  if (!deleted.success)
    throw new Error(`Could not delete next step #${id}'s reason: ${deleted.error?.message}`);
}

/**
 * The reasons that still belong to these rows, by id. A store without our table or the stable ids
 * has none, and a read never creates either.
 */
export function readNextStepReasons(
  client: RbookDatabaseClient,
  ids: readonly number[]
): Map<number, string> {
  const reasons = new Map<number, string>();
  if (!ids.length || reasonsTable(client) !== 'ours' || !hasStableIds(client)) return reasons;
  const rows = client.getMany<{ id: number; reason: string }>(
    `SELECT n.id AS id, r.reason AS reason
       FROM next_steps n
       JOIN ${NEXT_STEP_REASONS} r
         ON r.stable_event_id = n.stable_event_id
        AND r.status = n.status
        AND r.resolved_at = n.resolved_at
      WHERE n.id IN (${ids.map(() => '?').join(',')})`,
    [...ids]
  );
  if (!rows.success) throw new Error(`Could not read next-step reasons: ${rows.error?.message}`);
  for (const row of rows.data ?? []) reasons.set(row.id, row.reason);
  return reasons;
}
