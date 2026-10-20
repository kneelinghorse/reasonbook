// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The owner's other copies of a shared record (s100-m01, the sprint-97 review's finding 9): the replicas a share
// ABOUTME: through the dashboard would strand, which the client and the referee both refuse it over, each named.

import type { RbookDatabaseClient } from './client';
import { listMembers, OWNER_MEMBER } from './record-membership';
import { mergeContext } from './record-standing';

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

/** s100-m01: one of the owner's other copies, as a share through the dashboard names it. */
export interface OwnersCopy {
  readonly replicaId: string;
  readonly block: number;
  /** Where this copy reaches it, `host:folder`, when it keeps a route to it. */
  readonly route: string | null;
}

/**
 * s100-m01 (the sprint-97 review's finding 9): the owner's other copies a share through the
 * dashboard would strand, since only the copy that shares is handed to the referee. They are the
 * replicas admitted for the owner that are not this copy and are not cut, and that are still in use,
 * read from the record so the referee can read it too:
 * - a copy that once held the record counts when it wrote past its last term, as one handed over
 *   from goes on writing as a member (critics, round 1); a dashboard's referee after a move back
 *   writes nothing past its term;
 * - a copy a successor replaced counts until that successor writes, since an admitted successor no
 *   copy took up leaves its predecessor in use (critics, round 1); this copy's own former identities
 *   never count;
 * - any other copy counts when it wrote a change this copy holds, or when this copy keeps a route
 *   to it. An admission no copy took up, such as a referee the dashboard threw away before it
 *   joined, wrote nothing and keeps no route, so it is none.
 */
export function ownersOtherCopies(client: RbookDatabaseClient): OwnersCopy[] {
  const ctx = mergeContext(client);
  const owner = listMembers(client).find((member) => member.memberId === OWNER_MEMBER);
  const lastCut = new Map<string, number>();
  for (const term of ctx.terms) lastCut.set(term.replicaId, term.cut);
  const wroteAfter = (replicaId: string, seq: number): boolean =>
    rows(client, 'SELECT 1 FROM record_changes WHERE replica_id = ? AND replica_seq > ? LIMIT 1', [
      replicaId,
      seq,
    ]).length > 0;
  const replaced = new Set(
    [...ctx.members.values()]
      .filter((member) => member.previous && wroteAfter(member.replicaId, 0))
      .map((member) => member.previous!)
  );
  // This copy's own former identities are this copy, written or not, as a move back leaves one in
  // the same folder before the new identity writes (critics, round 2).
  for (
    let at = ctx.members.get(ctx.ownReplica)?.previous, steps = 0;
    at && steps < 16;
    steps += 1
  ) {
    replaced.add(at);
    at = ctx.members.get(at)?.previous;
  }
  const peers = client.getOne<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'record_peers'"
  ).data;
  return (owner?.replicas ?? []).flatMap(({ replicaId, block }) => {
    if (replicaId === ctx.ownReplica || replaced.has(replicaId)) return [];
    if (ctx.members.get(replicaId)?.cut !== undefined) return [];
    const cut = lastCut.get(replicaId);
    if (cut !== undefined)
      return Number.isFinite(cut) && wroteAfter(replicaId, cut)
        ? [{ replicaId, block, route: routeOf(client, peers, replicaId) }]
        : [];
    const route = routeOf(client, peers, replicaId);
    return route || wroteAfter(replicaId, 0) ? [{ replicaId, block, route }] : [];
  });
}

/** The SSH route this copy keeps to a replica, as `host:folder`, or null. */
function routeOf(client: RbookDatabaseClient, peers: unknown, replicaId: string): string | null {
  if (!peers) return null;
  const [row] = rows<{ route: string | null }>(
    client,
    'SELECT route FROM record_peers WHERE replica_id = ?',
    [replicaId]
  );
  const parsed = row?.route ? (JSON.parse(row.route) as { host?: unknown; root?: unknown }) : null;
  return parsed && typeof parsed.host === 'string' && typeof parsed.root === 'string'
    ? `${parsed.host}:${parsed.root}`
    : null;
}

/** How a share names the owner's other copies, as one clause. */
export function namedCopies(copies: readonly OwnersCopy[]): string {
  return copies
    .map((copy) =>
      copy.route
        ? `your copy at ${copy.route} (block ${copy.block})`
        : `your copy in block ${copy.block} (replica ${copy.replicaId})`
    )
    .join(', ');
}
