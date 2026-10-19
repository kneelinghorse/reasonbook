// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What a recompute knows once (ADR s96 §7, §8): this copy, the authority's chain of terms, the members each term
// ABOUTME: admitted with their cuts, and the gap-free reach of each authority's stream on this copy.

import type { RbookDatabaseClient } from './client';
import { authorityChain, termOf, type AuthorityTerm } from './record-authority';
import { BASELINE_QUERY } from './record-baseline';
import type { LoggedChange, Member, MergeContext } from './record-standing';
import { readReplicaIdentity } from './replica-identity';

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

const json = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

/** The last sequence of a replica's stream that this copy holds with every earlier one. */
function gapFreePrefix(client: RbookDatabaseClient, replica: string): number {
  const [whole] = rows<{ n: number; last: number | null }>(
    client,
    'SELECT count(*) AS n, max(replica_seq) AS last FROM record_changes WHERE replica_id = ?',
    [replica]
  );
  if (whole.n === (whole.last ?? 0)) return whole.n;
  let prefix = 0;
  for (const { replica_seq } of rows<{ replica_seq: number }>(
    client,
    'SELECT replica_seq FROM record_changes WHERE replica_id = ? ORDER BY replica_seq',
    [replica]
  )) {
    if (replica_seq !== prefix + 1) break;
    prefix = replica_seq;
  }
  return prefix;
}

/**
 * The authority and the members, from the baseline and every term's membership changes inside that
 * term (ADR s96 §8). Former authorities stay members with the owner role; a removal, a recovery's
 * drop and a recovery's own cut each give a replica a cut past which its changes are quarantined.
 */
export function mergeContext(client: RbookDatabaseClient): MergeContext {
  const identity = readReplicaIdentity(client, { fresh: true });
  if (!identity) throw new Error('Only a copy of a shared record merges changes.');
  const [baseline] = rows<LoggedChange>(client, BASELINE_QUERY);
  if (!baseline) throw new Error('This copy has no baseline, so it cannot merge.');
  const first = String((json(baseline.value) as { authority: string }).authority);
  const prefixes = new Map<string, number>();
  const prefixOf = (replica: string): number => {
    if (!prefixes.has(replica)) prefixes.set(replica, gapFreePrefix(client, replica));
    return prefixes.get(replica)!;
  };
  const chain = authorityChain(client, { ownReplica: identity.replicaId, first, prefixOf });
  const current = chain.terms[chain.terms.length - 1];
  const members = new Map<string, Member>([
    [
      first,
      { replicaId: first, block: 0, role: 'owner', admittedAt: baseline.hlc, member: 'owner' },
    ],
  ]);
  // s96-m13: a member change names a person's role; a removal carries a cut for each replica.
  const people = new Map<string, { role: string; cuts: Record<string, number> }>();
  for (const term of chain.terms) {
    // A pending move ends the current term's count where its cut falls (ADR §8).
    const reach = Math.min(
      term.cut,
      term === current && chain.pending ? chain.pending.cut : Infinity,
      prefixOf(term.replicaId)
    );
    if (term.change)
      members.set(term.replicaId, {
        ...(members.get(term.replicaId) ?? { admittedAt: term.change.hlc, member: 'owner' }),
        replicaId: term.replicaId,
        block: term.block,
        role: 'owner',
      });
    for (const change of rows<LoggedChange>(
      client,
      "SELECT * FROM record_changes WHERE kind IN ('replica_joined', 'member') AND replica_id = ? AND replica_seq <= ? ORDER BY replica_seq",
      [term.replicaId, reach]
    )) {
      if (change.kind === 'member') {
        const value = json(change.value) as { role: string; cuts?: Record<string, number> };
        people.set(String(change.entity_id), { role: String(value.role), cuts: value.cuts ?? {} });
        continue;
      }
      const value = json(change.value) as {
        block: number;
        role: string;
        member?: string;
        previous?: string;
      };
      const replicaId = String(change.entity_id);
      members.set(replicaId, {
        replicaId,
        block: Number(value.block),
        role: String(value.role),
        // A re-admission at a new block keeps the time of the first.
        admittedAt: members.get(replicaId)?.admittedAt ?? change.hlc,
        ...(value.member ? { member: value.member } : {}),
        ...(value.previous ? { previous: value.previous } : {}),
      });
    }
  }
  // An authority that lost a block clash moved itself; its latest renumber names its block (ADR §7).
  for (const term of chain.terms) {
    const [moved] = rows<LoggedChange>(
      client,
      "SELECT * FROM record_changes WHERE kind = 'renumber' AND replica_id = ? AND replica_seq <= ? ORDER BY replica_seq DESC LIMIT 1",
      [term.replicaId, Math.min(term.cut, prefixOf(term.replicaId))]
    );
    const member = members.get(term.replicaId);
    if (moved && member)
      members.set(term.replicaId, {
        ...member,
        block: Number((json(moved.value) as { block: number }).block),
      });
  }
  const cut = (replicaId: string, at: number, reason: string, role?: string): void => {
    const member = members.get(replicaId);
    if (member)
      members.set(replicaId, { ...member, ...(role ? { role } : {}), cut: at, cutReason: reason });
  };
  for (const [replicaId, member] of members) {
    const latest = member.member ? people.get(member.member) : undefined;
    if (latest?.role === 'removed')
      cut(replicaId, latest.cuts[replicaId] ?? 0, 'its member was removed', 'removed');
    // s97-m11: a role set on the person later (setRole) is the role each of its copies writes with,
    // as the member list shows it (critics, round 1).
    else if ((latest?.role === 'owner' || latest?.role === 'editor') && latest.role !== member.role)
      members.set(replicaId, { ...member, role: latest.role });
  }
  for (const [replicaId, at] of Object.entries(chain.dropped))
    cut(replicaId, at, "the owner's recovery dropped this copy");
  for (const term of chain.terms)
    if (term.ended === 'recovery')
      cut(term.replicaId, term.cut, "it was the owner's copy, and a recovery replaced it");
  // An admission a former authority wrote past its recovery cut was never seen by the recovery.
  const unseen = new Map<string, Member>();
  for (const term of chain.terms.filter((ended) => ended.ended === 'recovery'))
    for (const change of rows<LoggedChange>(
      client,
      "SELECT * FROM record_changes WHERE kind = 'replica_joined' AND replica_id = ? AND replica_seq > ? ORDER BY replica_seq",
      [term.replicaId, term.cut]
    )) {
      const replicaId = String(change.entity_id);
      const value = json(change.value) as { block: number; role: string; member?: string };
      if (!members.has(replicaId))
        unseen.set(replicaId, {
          replicaId,
          block: Number(value.block),
          role: String(value.role),
          admittedAt: change.hlc,
          ...(value.member ? { member: value.member } : {}),
        });
    }
  for (const term of chain.terms) prefixOf(term.replicaId);
  const holders = new Map<number, Set<string>>();
  for (const member of [...members.values(), ...unseen.values()])
    holders.set(member.block, (holders.get(member.block) ?? new Set()).add(member.replicaId));
  holders.set(identity.block, (holders.get(identity.block) ?? new Set()).add(identity.replicaId));
  return {
    ownReplica: identity.replicaId,
    ownBlock: identity.block,
    authority: current.replicaId,
    authorityPrefix: prefixOf(current.replicaId),
    members,
    standings: new Map(),
    epoch: current.epoch,
    terms: chain.terms,
    pending: chain.pending,
    forks: chain.forks,
    prefixes,
    prefixOf,
    unseen,
    clashedBlocks: new Set(
      [...holders].filter(([, replicas]) => replicas.size > 1).map(([block]) => block)
    ),
  };
}

/**
 * The last sequence of a term's replica that counts as that authority's, on this copy: its cut, or
 * for the current term its gap-free prefix, ended early by a move this copy holds unconfirmed.
 */
export function termReach(ctx: MergeContext, term: AuthorityTerm): number {
  const current = ctx.terms[ctx.terms.length - 1];
  return Math.min(
    term.cut,
    term === current && ctx.pending ? ctx.pending.cut : Infinity,
    ctx.prefixes.get(term.replicaId) ?? 0
  );
}

/** Whether a transaction is a term authority's own write, inside its term: live by authorship. */
export function authoredInTerm(
  ctx: MergeContext,
  changes: readonly Pick<LoggedChange, 'replica_id' | 'replica_seq'>[]
): AuthorityTerm | null {
  const term = termOf(ctx.terms, changes[0].replica_id);
  if (!term) return null;
  const last = Math.max(...changes.map((change) => change.replica_seq));
  const current = ctx.terms[ctx.terms.length - 1];
  // The current authority's writes are its own at any sequence; a former one's, up to its cut.
  return term === current || last <= term.cut ? term : null;
}
