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
  /**
   * s100-m01: the address a member's copy joined through the dashboard by, which its review and
   * rbook_status show; never its identity's own address, so it registers and sends as nothing.
   */
  joinedAddress: 'replica_joined_address',
  /** s100-m01: the newer record protocol this copy kept changes of out, and when it first met it. */
  newerProtocol: 'replica_newer_protocol',
  /** Hosted recovery receipts and held-condition notes belong to this copy alone. */
  dashboardRecovery: 'replica_dashboard_recovery',
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

/** One of a copy's own keys, or null when it has none. */
export function readCopyKey(client: RbookDatabaseClient, key: CopyKey): string | null {
  const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  return row.success ? (row.data?.value ?? null) : null;
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
