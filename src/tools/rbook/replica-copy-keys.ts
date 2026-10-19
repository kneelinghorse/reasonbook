// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A shared record's per-copy keys besides the identity (ADR s96 §4; s96-m13), each written or cleared
// ABOUTME: through one helper, and a copy's move to another block when a block clash made it renumber.

import type { RbookDatabaseClient } from './client';
import { forgetReplicaIdentity, REPLICA_KEYS, writeReplicaKey } from './replica-identity';

/**
 * s96-m13: the per-copy keys a shared record's steps keep besides the identity (ADR s96 §4): the
 * join this copy asked for, the owner-copy moves its operator confirmed, and what it said when it last
 * took a new identity. Never recorded, never sent, and never the schema label.
 */
export const COPY_KEYS = {
  joinPending: 'replica_join_pending',
  confirmedMoves: 'replica_owner_confirmed',
  successor: 'replica_reidentified',
  author: REPLICA_KEYS.author,
  /** s97-m11: the join answer this copy gave a dashboard's referee, kept until the referee applies it. */
  dashboardShare: 'replica_dashboard_share',
} as const;
export type CopyKey = (typeof COPY_KEYS)[keyof typeof COPY_KEYS];

/** s96-m13: write one of a copy's own keys, or with null clear it; only the keys COPY_KEYS names. */
export function writeCopyKey(
  client: RbookDatabaseClient,
  key: CopyKey,
  value: string | null
): void {
  if (value !== null) return writeReplicaKey(client, key, value);
  const cleared = client.execute('DELETE FROM metadata WHERE key = ?', [key]);
  if (!cleared.success) throw new Error(cleared.error?.message ?? `${key} was not cleared`);
}

/**
 * s96-m13 (ADR s96 §7): move this copy to another block under the same replica id, when a block clash
 * made it the replica that renumbers. Its new rows number in the new block from then on.
 */
export function moveReplicaBlock(client: RbookDatabaseClient, block: number): void {
  if (!Number.isInteger(block) || block < 1)
    throw new Error(`A copy moves only to a block above 0: ${block}`);
  writeReplicaKey(client, REPLICA_KEYS.block, String(block));
  forgetReplicaIdentity(client);
}
