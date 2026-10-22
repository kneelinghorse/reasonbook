// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Derive the first counted protocol-2 authority position and the record's next write protocol.
// ABOUTME: A switch is log history, bounded by adopted cuts; capability observations can delay it but never undo it.
import type { RbookDatabaseClient } from './client';
import { mergeContext, termReach } from './record-context';
import { countedVerdicts } from './record-positions';
import { PROTOCOL_VERSION } from './record-protocol';
import { activeProtocolCopies, type ProtocolBlockingCopy } from './record-protocol-active';
import type { LoggedChange, MergeContext } from './record-standing';
export type { ProtocolBlockingCopy } from './record-protocol-active';

export interface ProtocolSwitch {
  readonly epoch: number;
  readonly seq: number;
  readonly replicaId: string;
  readonly changeId: string;
}

/** Only applied authority positions count; an earlier verdict keeps a promoted member write out. */
export function protocolSwitch(
  client: RbookDatabaseClient,
  ctx = mergeContext(client)
): ProtocolSwitch | null {
  for (const term of ctx.terms) {
    let after = 0;
    for (;;) {
      const found = client.getOne<
        Pick<LoggedChange, 'txn_id' | 'change_id' | 'replica_id' | 'replica_seq'>
      >(
        'SELECT txn_id, change_id, replica_id, replica_seq FROM record_changes WHERE replica_id = ? AND replica_seq > ? AND replica_seq <= ? AND protocol_version = 2 ORDER BY replica_seq LIMIT 1',
        [term.replicaId, after, termReach(ctx, term)]
      );
      if (!found.success)
        throw new Error(found.error?.message ?? 'Could not read the protocol switch.');
      const change = found.data;
      if (!change) break;
      after = change.replica_seq;
      if (countedVerdicts(client, ctx, change.txn_id, term.epoch).length) continue;
      return {
        epoch: term.epoch,
        seq: change.replica_seq,
        replicaId: change.replica_id,
        changeId: change.change_id,
      };
    }
  }
  return null;
}

/** What this copy holds as the record's write protocol, without predicting a future write. */
export function currentWriteProtocol(client: RbookDatabaseClient, ctx?: MergeContext): number {
  return protocolSwitch(client, ctx) ? 2 : 1;
}

export function protocolBlockers(
  client: RbookDatabaseClient,
  ctx = mergeContext(client)
): readonly ProtocolBlockingCopy[] {
  return activeProtocolCopies(client, ctx).filter((copy) => copy.reads === null || copy.reads < 2);
}

/** Members follow the counted switch; only the authority can initiate it after its reader census. */
export function nextWriteProtocol(client: RbookDatabaseClient, ctx = mergeContext(client)): number {
  // The explicit test seam models an older or a future release, including its actual write capacity.
  if (PROTOCOL_VERSION !== 2) return PROTOCOL_VERSION;
  if (protocolSwitch(client, ctx)) return 2;
  return ctx.ownReplica === ctx.authority && !protocolBlockers(client, ctx).length ? 2 : 1;
}
