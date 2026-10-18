// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Who the authority is on this copy (ADR s96 §8): the baseline's copy, then each authority change this copy
// ABOUTME: wrote or confirmed, each term up to its cut; one not confirmed waits, and another for a held epoch is a fork.

import type { RbookDatabaseClient } from './client';
import type { LoggedChange } from './record-standing';
import { COPY_KEYS } from './replica-copy-keys';

/** A handover is a live authority passing on; a recovery replaces one that is gone (ADR s96 §8). */
export type AuthorityMove = 'handover' | 'recovery';

/** An `authority` change's value. A handover's cut is its own sequence; a recovery names its cut. */
export interface AuthorityValue {
  readonly epoch: number;
  readonly authority: string;
  readonly previous: string;
  readonly move: AuthorityMove;
  readonly block: number;
  /** A recovery's cut: the highest gap-free sequence of the old authority it collected. */
  readonly cut?: number;
  /** A recovery's cut for each replica of a member the operator dropped. */
  readonly dropped?: Readonly<Record<string, number>>;
  /** The member names the operator confirmed for a recovery. */
  readonly members?: readonly string[];
}

/** One authority's term: its stream is the authority's up to its cut. */
export interface AuthorityTerm {
  readonly epoch: number;
  readonly replicaId: string;
  readonly block: number;
  /** Its last sequence as the authority; Infinity while it is the authority. */
  readonly cut: number;
  /** How the term ended: past a handover its writes are a member's; past a recovery, quarantined. */
  readonly ended: AuthorityMove | null;
  /** The change that opened the term; null for the baseline's. */
  readonly change: LoggedChange | null;
}

/** An authority change this copy holds, valid for its next epoch, that it has not confirmed. */
export interface PendingAuthority {
  readonly change: LoggedChange;
  readonly value: AuthorityValue;
  /** Where the current authority's term would end. */
  readonly cut: number;
}

export interface AuthorityChain {
  readonly terms: readonly AuthorityTerm[];
  readonly pending: PendingAuthority | null;
  /** Authority changes for an epoch this copy already holds another for: shown, never applied. */
  readonly forks: readonly LoggedChange[];
  /** Every recovery's cut for the replicas of members it dropped. */
  readonly dropped: Readonly<Record<string, number>>;
}

/** Per-copy metadata: the authority changes this copy's operator confirmed. Never recorded. */
export const CONFIRMED_KEY = COPY_KEYS.confirmedMoves;

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

export function authorityValue(change: LoggedChange): AuthorityValue {
  return JSON.parse(change.value ?? '{}') as AuthorityValue;
}

/** The authority changes confirmed on this copy. */
export function confirmedAuthorityChanges(client: RbookDatabaseClient): Set<string> {
  const [row] = rows<{ value: string }>(client, 'SELECT value FROM metadata WHERE key = ?', [
    CONFIRMED_KEY,
  ]);
  try {
    return new Set(row ? (JSON.parse(row.value) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** Where a change ends the term it follows: a handover at its own sequence, a recovery at its cut. */
export function cutOf(change: LoggedChange): number {
  const value = authorityValue(change);
  return value.move === 'handover' ? change.replica_seq : Number(value.cut ?? 0);
}

/**
 * The chain on this copy: the baseline's authority, then for each epoch the one valid change this
 * copy wrote or confirmed. A handover counts when the term's authority wrote it inside its gap-free
 * stream; a recovery, when the new authority wrote it inside its own. Each replica holds one term.
 */
export function authorityChain(
  client: RbookDatabaseClient,
  input: {
    readonly ownReplica: string;
    readonly first: string;
    readonly prefixOf: (replicaId: string) => number;
  }
): AuthorityChain {
  const terms: Array<AuthorityTerm & { cut: number; ended: AuthorityMove | null }> = [
    { epoch: 1, replicaId: input.first, block: 0, cut: Infinity, ended: null, change: null },
  ];
  const confirmed = confirmedAuthorityChanges(client);
  const changes = rows<LoggedChange>(
    client,
    "SELECT * FROM record_changes WHERE kind = 'authority' ORDER BY hlc, change_id"
  );
  const used = new Set<string>();
  const forks: LoggedChange[] = [];
  const dropped: Record<string, number> = {};
  let pending: PendingAuthority | null = null;
  const valid = (change: LoggedChange, current: AuthorityTerm): boolean => {
    const value = authorityValue(change);
    if (value.epoch !== current.epoch + 1 || value.previous !== current.replicaId) return false;
    if (terms.some((term) => term.replicaId === value.authority)) return false;
    if (value.move === 'handover')
      return (
        change.replica_id === current.replicaId &&
        change.replica_seq <= input.prefixOf(current.replicaId)
      );
    return (
      value.move === 'recovery' &&
      change.replica_id === value.authority &&
      change.replica_seq <= input.prefixOf(value.authority) &&
      Number.isInteger(value.cut)
    );
  };
  for (;;) {
    const current = terms[terms.length - 1];
    const next = changes.filter((change) => !used.has(change.change_id) && valid(change, current));
    if (!next.length) break;
    const applies = next.filter(
      (change) => confirmed.has(change.change_id) || change.replica_id === input.ownReplica
    );
    if (applies.length !== 1) {
      // None confirmed: the one valid change waits; two valid ones are a fork, and none applies.
      if (!applies.length && next.length === 1)
        pending = { change: next[0], value: authorityValue(next[0]), cut: cutOf(next[0]) };
      else forks.push(...next);
      for (const change of next) used.add(change.change_id);
      break;
    }
    const [chosen] = applies;
    for (const change of next) used.add(change.change_id);
    forks.push(...next.filter((change) => change !== chosen));
    const value = authorityValue(chosen);
    current.cut = cutOf(chosen);
    current.ended = value.move;
    Object.assign(dropped, value.dropped ?? {});
    terms.push({
      epoch: value.epoch,
      replicaId: value.authority,
      block: Number(value.block),
      cut: Infinity,
      ended: null,
      change: chosen,
    });
  }
  const held = terms[terms.length - 1].epoch;
  for (const change of changes)
    if (!used.has(change.change_id) && authorityValue(change).epoch <= held) forks.push(change);
  return { terms, pending, forks, dropped };
}

/** The term a replica held on this copy, if any; each replica holds at most one. */
export function termOf(
  terms: readonly AuthorityTerm[],
  replicaId: string
): AuthorityTerm | undefined {
  return terms.find((term) => term.replicaId === replicaId);
}
