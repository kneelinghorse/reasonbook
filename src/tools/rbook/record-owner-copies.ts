// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The owner's other copies of a shared record (s100-m01, the sprint-97 review's finding 9): the replicas a share
// ABOUTME: through the dashboard would strand, which the client and the referee both refuse it over, each named.

import type { RbookDatabaseClient } from './client';
import { isDashboardRoute } from './record-dashboard-route';
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
 * - a former authority counts when it wrote past its term, retains an SSH route or completed an
 *   exchange; dashboard-route observations (including ended routes) never count as owner use;
 * - a predecessor counts until its successor wrote or completed a non-dashboard exchange; this
 *   copy's own former identities never count;
 * - any other copy counts when it wrote, has an SSH route or completed a non-dashboard exchange.
 *   An unused admission with no such evidence does not count. This owner-stranding rule is not
 *   the future all-member protocol-activation rule (s98-m17, decision 1606).
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
  const peers = client.getOne<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'record_peers'"
  );
  if (!peers.success) throw new Error(peers.error?.message ?? 'could not check for record_peers');
  const evidence = new Map<string, { route: string | null; called: boolean }>();
  const peerOf = (replicaId: string) => {
    let held = evidence.get(replicaId);
    if (!held) {
      held = peerEvidence(client, Boolean(peers.data), replicaId);
      evidence.set(replicaId, held);
    }
    return held;
  };
  const replaced = new Set(
    [...ctx.members.values()]
      .filter(
        (member) =>
          member.previous && (wroteAfter(member.replicaId, 0) || peerOf(member.replicaId).called)
      )
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
  return (owner?.replicas ?? []).flatMap(({ replicaId, block }) => {
    if (replicaId === ctx.ownReplica || replaced.has(replicaId)) return [];
    if (ctx.members.get(replicaId)?.cut !== undefined) return [];
    const cut = lastCut.get(replicaId);
    if (cut !== undefined && !Number.isFinite(cut)) return [];
    const { route, called } = peerOf(replicaId);
    return route || called || wroteAfter(replicaId, cut ?? 0) ? [{ replicaId, block, route }] : [];
  });
}

/** A successful exchange or SSH route is evidence of owner use; dashboard observations are not. */
function peerEvidence(
  client: RbookDatabaseClient,
  peers: boolean,
  replicaId: string
): { route: string | null; called: boolean } {
  if (!peers) return { route: null, called: false };
  const [row] = rows<{ route: string | null; last_ok_at: string | null }>(
    client,
    'SELECT route, last_ok_at FROM record_peers WHERE replica_id = ?',
    [replicaId]
  );
  const parsed = row?.route ? (JSON.parse(row.route) as { host?: unknown; root?: unknown }) : null;
  if (isDashboardRoute(parsed)) return { route: null, called: false };
  return {
    route:
      parsed && typeof parsed.host === 'string' && typeof parsed.root === 'string'
        ? `${parsed.host}:${parsed.root}`
        : null,
    called: row?.last_ok_at != null,
  };
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
