// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Choose one protocol for all writes in a SQLite transaction from its first surviving log row.
// ABOUTME: Bootstrap, older admissions and recovery cuts stay compatible without a rollback-unsafe memory pin.
import type { RbookDatabaseClient } from './client';
import { BASELINE_QUERY } from './record-baseline';
import type { RecordedChange } from './record-changes';
import { currentWriteProtocol, nextWriteProtocol } from './record-protocol-state';
import { PROTOCOL_VERSION } from './record-protocol';
import type { MergeContext } from './record-standing';

export interface RecordProtocolOptions {
  readonly admittingReads?: number | null;
  /** Recovery supplies its adopted authority reach, never the unadopted tail held in the base. */
  readonly recoveryContext?: MergeContext;
}

export function protocolForWrite(
  client: RbookDatabaseClient,
  txnId: string,
  replicaId: string,
  changes: readonly RecordedChange[],
  options: RecordProtocolOptions
): number {
  const held = client.getOne<{ protocol_version: number }>(
    'SELECT protocol_version FROM record_changes WHERE txn_id = ? AND replica_id = ? ORDER BY replica_seq LIMIT 1',
    [txnId, replicaId]
  );
  if (!held.success)
    throw new Error(held.error?.message ?? "Could not read this transaction's protocol.");
  if (held.data) return held.data.protocol_version;
  if (changes.every((change) => change.kind === 'baseline')) {
    const baseline = client.getOne(BASELINE_QUERY);
    if (!baseline.success)
      throw new Error(baseline.error?.message ?? 'Could not inspect the bootstrap baseline.');
    if (!baseline.data) return 1;
  }
  if (PROTOCOL_VERSION !== 2) return PROTOCOL_VERSION;
  if (options.recoveryContext) return currentWriteProtocol(client, options.recoveryContext);
  if (
    Object.prototype.hasOwnProperty.call(options, 'admittingReads') &&
    (options.admittingReads == null || options.admittingReads < 2) &&
    currentWriteProtocol(client) === 1
  )
    return 1;
  return nextWriteProtocol(client);
}
