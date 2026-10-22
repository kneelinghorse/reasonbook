// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The checks an exchange makes before anything moves (ADR s96 §7): each replica's hash chain at the lower of
// ABOUTME: two marks, which finds a slot two copies filled differently, and the blocks each replica holds.

import { createHash } from 'crypto';
import type { RbookDatabaseClient } from './client';
import { canonicalJson } from './record-capture';
import { mergeContext } from './record-standing';

/**
 * The fields a change's hash covers: everything its author wrote. The user id is left out: ADR s96
 * §10 never writes it back into a change and keeps it out of the chain.
 */
const CHAINED = [
  'change_id',
  'txn_id',
  'project_id',
  'replica_id',
  'replica_seq',
  'author_name',
  'hlc',
  'protocol_version',
  'kind',
  'entity',
  'entity_id',
  'field',
  'value',
  'base',
] as const;

type ChainedChange = Record<(typeof CHAINED)[number], unknown>;

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

/** One link of a replica's chain: the previous link's hash and this change's chained fields. */
function link(previous: string, change: ChainedChange): string {
  const fields = Object.fromEntries(CHAINED.map((field) => [field, change[field] ?? null]));
  return createHash('sha256')
    .update(previous)
    .update('\n')
    .update(canonicalJson(fields))
    .digest('hex');
}

/**
 * A replica's chain hash through sequence `upTo`, or null when this copy lacks one of the changes
 * before it. Two copies that hold the same changes in those slots hold the same hash.
 */
export function chainHash(
  client: RbookDatabaseClient,
  replicaId: string,
  upTo: number
): string | null {
  return chainHashOf(
    rows<ChainedChange>(
      client,
      `SELECT ${CHAINED.join(', ')} FROM record_changes WHERE replica_id = ? AND replica_seq <= ?
      ORDER BY replica_seq`,
      [replicaId, upTo]
    ),
    upTo
  );
}

/** The same chain over an ordered stream, such as the union of recovery inputs. */
export function chainHashOf(changes: readonly ChainedChange[], upTo: number): string | null {
  let hash = '';
  let expected = 1;
  for (const change of changes) {
    if (Number(change.replica_seq) > upTo) break;
    if (change.replica_seq !== expected) return null;
    hash = link(hash, change);
    expected += 1;
  }
  return expected === upTo + 1 ? hash : null;
}

/** This copy's chain hash for each replica at the sequence asked. */
export function chainsAt(
  client: RbookDatabaseClient,
  at: Readonly<Record<string, number>>
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(at).map(([replicaId, seq]) => [replicaId, chainHash(client, replicaId, seq)])
  );
}

/** Per replica, the lower of two copies' marks, where both hold some of its stream. */
export function commonMarks(
  ours: Readonly<Record<string, number>>,
  theirs: Readonly<Record<string, number>>
): Record<string, number> {
  const common: Record<string, number> = {};
  for (const [replicaId, mark] of Object.entries(ours)) {
    const other = theirs[replicaId] ?? 0;
    if (mark > 0 && other > 0) common[replicaId] = Math.min(mark, other);
  }
  return common;
}

/** The replicas whose chains differ at a common mark: a slot two copies filled differently. */
export function chainClashes(
  ours: Readonly<Record<string, string | null>>,
  theirs: Readonly<Record<string, string | null>>
): string[] {
  return Object.keys(ours)
    .filter((replicaId) => replicaId in theirs)
    .filter((replicaId) => ours[replicaId] !== null && theirs[replicaId] !== null)
    .filter((replicaId) => ours[replicaId] !== theirs[replicaId])
    .sort();
}

/**
 * The block each replica holds, as this copy knows it: its own, each a term admitted, and each an
 * unseen join holds, whose creates may be decided later (ADR s96 §3, §8).
 */
export function knownBlocks(client: RbookDatabaseClient): Record<string, number> {
  const ctx = mergeContext(client);
  const blocks: Record<string, number> = {};
  for (const member of [...ctx.unseen.values(), ...ctx.members.values()])
    blocks[member.replicaId] = member.block;
  blocks[ctx.ownReplica] = ctx.ownBlock;
  return blocks;
}

/** Each block two replicas hold, with both, as two copies know them together (ADR s96 §7). */
export function blockClashes(
  ours: Readonly<Record<string, number>>,
  theirs: Readonly<Record<string, number>>
): Array<{ readonly block: number; readonly replicas: readonly string[] }> {
  const holders = new Map<number, Set<string>>();
  for (const blocks of [ours, theirs])
    for (const [replicaId, block] of Object.entries(blocks))
      holders.set(block, (holders.get(block) ?? new Set()).add(replicaId));
  return [...holders.entries()]
    .filter(([, replicas]) => replicas.size > 1)
    .map(([block, replicas]) => ({ block, replicas: [...replicas].sort() }))
    .sort((a, b) => a.block - b.block);
}
