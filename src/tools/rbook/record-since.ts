// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What a copy holds after a peer's marks (ADR s96 §7), for an exchange, a bundle and the pending count a
// ABOUTME: review shows: one module with no merge in it, so the hooks' digest stays light (s96-m13).

import type { RbookDatabaseClient } from './client';
import { mergeContext, type LoggedChange } from './record-standing';

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

/**
 * Every change this copy holds after a peer's marks, per replica in sequence order. The authority's
 * copy withholds a refused non-member's data (ADR s96 §7); its verdict travels alone.
 */
export function changesSince(
  client: RbookDatabaseClient,
  marks: Readonly<Record<string, number>>
): LoggedChange[] {
  const ctx = mergeContext(client);
  const withheld = new Set(
    ctx.ownReplica === ctx.authority
      ? rows<{ txn_id: string; replica_id: string }>(
          client,
          "SELECT txn_id, replica_id FROM record_txn_state WHERE state = 'refused'"
        )
          .filter((txn) => !ctx.members.has(txn.replica_id))
          .map((txn) => txn.txn_id)
      : []
  );
  return rows<LoggedChange>(
    client,
    'SELECT * FROM record_changes ORDER BY replica_id, replica_seq'
  ).filter(
    (change) => change.replica_seq > (marks[change.replica_id] ?? 0) && !withheld.has(change.txn_id)
  );
}
