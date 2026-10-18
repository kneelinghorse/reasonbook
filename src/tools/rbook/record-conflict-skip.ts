// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Keeps a set-based write off rows whose fields are in conflict (s96-m12, ADR s96 §5): the SQL that skips them
// ABOUTME: on a shared record, nothing on any other store, and the warning that names each row it skipped.

import type { RbookDatabaseClient } from './client';
import type { SharedTable } from './record-columns';
import { isRecordedStore } from './record-guards';

const quoted = (text: string): string => `'${text.replace(/'/g, "''")}'`;

/** A condition to AND into a set-based write's WHERE, so it skips a conflicted row; empty off a shared record. */
export function skipConflicted(
  client: RbookDatabaseClient,
  table: SharedTable,
  fields: readonly string[],
  alias: string = table
): string {
  if (!isRecordedStore(client)) return '';
  return ` AND NOT EXISTS (SELECT 1 FROM record_conflicts rc WHERE rc.entity = ${quoted(table)} AND rc.entity_id = ${alias}.stable_event_id AND rc.field IN (${fields.map(quoted).join(', ')}))`;
}

/**
 * The ids of the rows a set-based write with this WHERE would skip, and the warning that names them;
 * null when it skips none.
 */
export function skippedConflicts(
  client: RbookDatabaseClient,
  table: SharedTable,
  fields: readonly string[],
  where: string,
  params: unknown[]
): string | null {
  if (!isRecordedStore(client)) return null;
  const found = client.getMany<{ id: unknown }>(
    `SELECT id FROM ${table} WHERE (${where}) AND EXISTS (SELECT 1 FROM record_conflicts rc WHERE rc.entity = ${quoted(table)} AND rc.entity_id = ${table}.stable_event_id AND rc.field IN (${fields.map(quoted).join(', ')}))`,
    params
  );
  if (!found.success)
    throw new Error(found.error?.message ?? 'the conflicted rows could not be read');
  const ids = (found.data ?? []).map((row) => String(row.id));
  if (!ids.length) return null;
  return `Skipped ${table} ${ids.join(', ')}: ${fields.join(' or ')} holds values from copies that had not seen each other. List them with rbook_db(action="conflicts") and settle each with rbook_db(action="settle").`;
}
