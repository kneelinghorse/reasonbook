// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What a copy holds after a peer's marks (ADR s96 §7), for an exchange, a bundle and the pending count a
// ABOUTME: review shows: one module with no merge in it, so the hooks' digest stays light (s96-m13).

import type { RbookDatabaseClient } from './client';
import type { CopyReport } from './record-copy-report';
import { mergeContext, type LoggedChange } from './record-standing';
import { REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';

export interface ChangeRecipient extends Pick<CopyReport, 'reads'> {
  /** Between-epoch delivery may use connection-local historical capacity, never admission evidence. */
  readonly catchUp?: boolean;
  /** Recovery may proceed only after inspecting every needed row, never a filtered prefix. */
  readonly requireComplete?: boolean;
}

export interface ChangeSelection {
  readonly changes: LoggedChange[];
  /** Undelivered rows after the recipient's marks, excluding refused non-member transactions. */
  readonly withheld: number;
  readonly withheldProtocol: number;
}

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
  marks: Readonly<Record<string, number>>,
  recipient?: ChangeRecipient
): LoggedChange[] {
  return changesSinceReport(client, marks, recipient).changes;
}

/** Select once and disclose unreadable rows without changing the array-only wire format. */
export function changesSinceReport(
  client: RbookDatabaseClient,
  marks: Readonly<Record<string, number>>,
  recipient?: ChangeRecipient
): ChangeSelection {
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
  const all = rows<LoggedChange>(
    client,
    'SELECT * FROM record_changes ORDER BY replica_id, replica_seq'
  );
  // The whole stored transaction is inspected before marks, including a mark inside that txn.
  const readable = recipient === undefined ? all : readableChanges(all, recipient);
  const included = new Set(readable);
  if (recipient?.requireComplete) {
    const missing = all.find(
      (change) => change.replica_seq > (marks[change.replica_id] ?? 0) && !included.has(change)
    );
    if (missing) {
      const version = all.reduce(
        (maximum, change) =>
          change.replica_id === missing.replica_id
            ? Math.max(maximum, change.protocol_version)
            : maximum,
        1
      );
      throw new ReplicaRefusal({
        code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
        message: `The complete record includes protocol ${version} changes this reader cannot read, so no partial recovery log was returned.`,
        suggestion:
          'Upgrade Reasonbook on the recovering machine, then run the recovery again; every copy keeps its changes.',
      });
    }
  }
  const changes: LoggedChange[] = [];
  let withheldCount = 0;
  let withheldProtocol = 0;
  for (const change of all) {
    if (!included.has(change))
      withheldProtocol = Math.max(withheldProtocol, change.protocol_version);
    if (change.replica_seq <= (marks[change.replica_id] ?? 0) || withheld.has(change.txn_id))
      continue;
    if (included.has(change)) changes.push(change);
    else withheldCount++;
  }
  return { changes, withheld: withheldCount, withheldProtocol };
}

/** Stop each stream before the whole first transaction its recipient cannot read. */
export function readableChanges(
  changes: readonly LoggedChange[],
  recipient: Pick<CopyReport, 'reads'>
): LoggedChange[] {
  const reads =
    Number.isInteger(recipient.reads) && (recipient.reads ?? 0) > 0 ? recipient.reads! : 1;
  const starts = new Map<string, number>();
  for (const change of changes) {
    const key = `${change.replica_id}:${change.txn_id}`;
    starts.set(key, Math.min(starts.get(key) ?? Infinity, change.replica_seq));
  }
  const held = new Map<string, number>();
  for (const change of changes) {
    if (change.protocol_version <= reads) continue;
    const start = starts.get(`${change.replica_id}:${change.txn_id}`)!;
    held.set(change.replica_id, Math.min(held.get(change.replica_id) ?? Infinity, start));
  }
  return changes.filter((change) => change.replica_seq < (held.get(change.replica_id) ?? Infinity));
}
