// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Moving the owner copy over SSH (ADR s96 §8): a handover run on the owner's copy that confirms on the new copy as
// ABOUTME: the operator's word and hands it the routes, and a recovery that reaches every member's copy by its route.

import { createError, createSuccess } from './errors';
import { clientPeer, exchange, type ExchangeReport } from './record-exchange';
import { handOver, type Confirmed, type Handover } from './record-moves';
import { peerHealth, rememberPeer } from './record-peers';
import { recoverAuthority, type RecoveryInput, type RecoveryReport } from './record-recovery';
import { mergeContext } from './record-standing';
import type { SshRoute } from './record-ssh';
import { reach, syncRoute, type Opener, type SyncOptions } from './record-sync';
import type { WirePeer } from './record-wire';
import { REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolResult } from './types';

/** The far end's verb for a handover: it may confirm a move and take routes as the operator's word. */
export const HANDOVER_SERVE = ['sync', '--serve', '--confirm-owner'] as const;

/**
 * A planned handover to the owner's copy at `route`, run on the owner's copy (ADR s96 §8): this copy
 * records the move, the far copy catches up and confirms it, takes this copy's routes to the
 * members, and the two then sync with this copy as a member.
 */
export async function handOverRoute(
  open: Opener,
  route: SshRoute,
  options: SyncOptions = {}
): Promise<
  RbookToolResult<{
    readonly handover: Handover;
    readonly confirmed: Confirmed;
    readonly sync: ExchangeReport;
  }>
> {
  const local = options.unchecked ?? open;
  const reached = await reach(route, [...HANDOVER_SERVE], options);
  if (!reached.success || !reached.data) return createError(reached.error!);
  const far = reached.data;
  let handover: Handover;
  let confirmed: Confirmed;
  try {
    const theirs = await far.hello();
    // A copy its own check refuses could take the move and never confirm it, since a new owner copy
    // writes its verdicts at once: asked first, this copy stays the owner's.
    if (theirs.refusal)
      return createError({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `The copy at ${far.name} is refused its own writes (${theirs.refusal}), so it cannot take the owner's copy, and nothing was handed over.`,
        suggestion: `Put that copy right first, then hand over again. Its own check says: ${theirs.remedy ?? 'sync it to see what puts it right.'}`,
      });
    const moved = await open((client) => handOver(client, { to: theirs.replicaId }));
    if (!moved.success || !moved.data) return createError(moved.error!);
    handover = moved.data;
    const caught = await exchange(clientPeer('this copy', open, local), far);
    if (!caught.success) return createError(caught.error!);
    const answer = (await far.call('confirmOwner', {
      changeId: handover.changeId,
    })) as RbookToolResult<Confirmed>;
    if (!answer.success || !answer.data) return createError(answer.error!);
    confirmed = answer.data;
    // The routes to the members' copies go with the move; a removed member's are synced no more.
    const routes = await local((client) => {
      const members = mergeContext(client).members;
      return peerHealth(client)
        .filter(
          (peer) =>
            peer.route &&
            peer.replicaId !== theirs.replicaId &&
            members.get(peer.replicaId)?.role !== 'removed'
        )
        .map((peer) => ({ replicaId: peer.replicaId, name: peer.name, route: peer.route }));
    });
    await far.call('rememberPeers', routes);
    await local((client) =>
      rememberPeer(client, theirs.replicaId, { name: "the owner's copy", route })
    );
  } finally {
    far.close();
  }
  const synced = await syncRoute(open, route, options);
  if (!synced.success || !synced.data) return createError(synced.error!);
  return createSuccess({ handover, confirmed, sync: synced.data });
}

/**
 * Recover the owner's copy on this copy from the members' copies at `routes` (ADR s96 §8). A route
 * that cannot be reached stops it, named; the routes reached are remembered for the next sync.
 */
export async function recoverRoutes(
  self: Opener,
  routes: readonly SshRoute[],
  input: RecoveryInput,
  options: SyncOptions = {}
): Promise<RbookToolResult<RecoveryReport>> {
  const peers: Array<{ readonly peer: WirePeer; readonly route: SshRoute }> = [];
  try {
    for (const route of routes) {
      const reached = await reach(route, undefined, options);
      if (!reached.success || !reached.data)
        return createError({
          ...reached.error!,
          message: `The recovery waits for the copy at ${route.host}: ${reached.error!.message}`,
        });
      peers.push({ peer: reached.data, route });
    }
    const recovered = await recoverAuthority(
      self,
      peers.map((reached) => reached.peer),
      input
    );
    if (!recovered.success) return recovered;
    for (const { peer, route } of peers) {
      const { replicaId } = await peer.hello();
      await self((client) => rememberPeer(client, replicaId, { route }));
    }
    return recovered;
  } finally {
    for (const { peer } of peers) peer.close();
  }
}
