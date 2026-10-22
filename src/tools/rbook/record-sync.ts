// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Running a sync (ADR s96 §7): with each copy this one has a route to, over SSH, each side recording the other's
// ABOUTME: health; the one-command join from the authority; and why a copy with no route cannot start one.

import { copyReport, localCopyReport } from './record-copy-report';
import { reach, type Opener, type SyncOptions } from './record-sync-channel';
export { reach, storeOpener, answered } from './record-sync-channel';
export type { Opener, SyncOptions } from './record-sync-channel';
import { createError, createSuccess } from './errors';
import { rememberDashboardAuthority } from './record-dashboard-history';
import {
  hostedRecoveryPeer,
  rebindRecoveryRoutes,
  recoveryReplaces,
} from './record-dashboard-recovery-moves';
import { dashboardName, isDashboardRoute } from './record-dashboard-route';
import { clientPeer, exchange, type ExchangeReport, type Hello } from './record-exchange';
import { answerJoin, type JoinApplied, type JoinRequest } from './record-join';
import { listMembers } from './record-membership';
import {
  forgetPeers,
  endDashboardRoute,
  nextTryAt,
  recordHeldBack,
  peerHealth,
  recordExchanged,
  recordExchangeFailed,
  noteRemoval,
  rememberPeer,
  syncsWith,
  visiblePeerRoutes,
  type PeerRoute,
} from './record-peers';
import type { SshRoute } from './record-ssh';
import { mergeContext, type MergeContext } from './record-standing';
import { replicaWriteRefusal } from './replica-check';
import { carriedRefusal, REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolError, RbookToolResult } from './types';

export interface PeerOutcome {
  readonly replicaId: string;
  readonly name: string | null;
  readonly report?: ExchangeReport;
  /** s96-m13: what either copy could not embed after its merge. */
  readonly warnings?: readonly string[];
  readonly error?: string;
  /** s97-m10: an automatic sync that waited out a failing dashboard: when it tries again. */
  readonly nextTryAt?: string;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Sync with one copy over its route; each side then records the other's marks and the time. */
export async function syncRoute(
  open: Opener,
  route: PeerRoute,
  options: SyncOptions = {}
): Promise<RbookToolResult<ExchangeReport>> {
  const local = options.unchecked ?? open;
  if (isDashboardRoute(route)) await local(rebindRecoveryRoutes);
  const reached = await reach(route, undefined, options, options.unchecked ?? open);
  if (!reached.success || !reached.data) return createError(reached.error!);
  const far = reached.data;
  try {
    let remoteIdentity: Hello | undefined;
    const observedFar = {
      ...far,
      hello: async () => {
        remoteIdentity = await far.hello();
        return remoteIdentity;
      },
    };
    const near = clientPeer('this copy', open, local);
    const result = await exchange(
      isDashboardRoute(route) ? await hostedRecoveryPeer(near, local, route) : near,
      observedFar
    );
    if (!result.success || !result.data) return result;
    const report = result.data;
    await local((client) => {
      if (isDashboardRoute(route)) rebindRecoveryRoutes(client);
      if (isDashboardRoute(route) && remoteIdentity)
        rememberDashboardAuthority(client, route, remoteIdentity);
      recordExchanged(client, report.remote.replicaId, {
        ...copyReport(remoteIdentity),
        marks: report.remote.marks,
        digest: report.digest,
        // Only this copy's own membership is recorded here; a far copy's removal is not this copy's.
        removed: report.removedCopy === 'local' ? true : report.removed ? undefined : false,
      });
      // s100-m01 (#707): a removed copy takes nothing in, so after a move it still takes the old owner
      // copy for the owner's; what the exchange said is kept on that copy's row too, which its
      // review shows. A copy that is no member at all is told nothing new here.
      const ctx = mergeContext(client);
      const owner = ctx.ownReplica === ctx.authority ? null : ctx.authority;
      if (
        owner &&
        owner !== report.remote.replicaId &&
        (report.removedCopy === 'local' || !report.removed)
      )
        noteRemoval(client, owner, report.removedCopy === 'local');
    });
    // The far copy's note of this exchange is its own: the exchange stands if the note fails (s97-m10).
    try {
      await far.call('exchanged', {
        ...localCopyReport(),
        replicaId: report.local.replicaId,
        marks: report.local.marks,
        digest: report.digest,
      });
    } catch (error) {
      return createSuccess(report, [
        ...(result.warnings ?? []),
        `${far.name} did not note this exchange (${message(error)}); its review shows the previous one until the next sync.`,
      ]);
    }
    return result;
  } catch (error) {
    const refused = carriedRefusal(error);
    if (refused) return createError(refused);
    return createError({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `The sync with ${far.name} stopped: ${message(error)}`,
      suggestion: 'Sync again; a whole exchange repeats safely, and a duplicate changes nothing.',
    });
  } finally {
    far.close();
  }
}

/** Whether `replicaId` took over from `from` through successors this copy admitted or holds. */
function successorOf(ctx: MergeContext, replicaId: string, from: string): boolean {
  let at: string | undefined = replicaId;
  for (let steps = 0; at && steps < 16; steps += 1) {
    at = ctx.members.get(at)?.previous;
    if (at === from) return true;
  }
  return false;
}

/**
 * Why this copy starts no sync at all: a copy carried here and not joined, or a second live copy of
 * the project on this machine, holds another copy's identity, so it syncs as no one. The copy
 * check's own refusal says which, and what to do.
 */
async function strangerHere(local: Opener): Promise<RbookToolError | null> {
  const refusal = await local((client) => replicaWriteRefusal(client));
  return refusal?.code === REPLICA_ERROR_CODES.NOT_JOINED ||
    refusal?.code === REPLICA_ERROR_CODES.SECOND_COPY
    ? refusal
    : null;
}

/**
 * Sync with every copy this copy has a route to. A copy with none says so: a member's copy reaches
 * the owner's only if the owner's machine accepts SSH, so the owner's sync or a bundle is the way.
 */
export async function syncPeers(
  open: Opener,
  options: SyncOptions = {}
): Promise<RbookToolResult<{ readonly peers: readonly PeerOutcome[] }>> {
  const local = options.unchecked ?? open;
  const stranger = await strangerHere(local);
  if (stranger) return createError(stranger);
  await local(rebindRecoveryRoutes);
  const { peers, ownerCopy } = await local((client) => {
    const ctx = mergeContext(client);
    return {
      // ADR s96 §7: a member's copy syncs only with the owner's copy, and no copy with a removed
      // member's; a route a file brought from another copy is not followed to any other.
      peers: visiblePeerRoutes(
        peerHealth(client).filter(
          (peer) => syncsWith(ctx, peer.replicaId) || isDashboardRoute(peer.route)
        )
      ),
      ownerCopy: ctx.ownReplica === ctx.authority,
    };
  });
  const routed = peers.filter(
    (peer) => peer.route && !(options.auto && isDashboardRoute(peer.route) && peer.route.ended)
  );
  if (
    options.auto &&
    !routed.length &&
    peers.some((peer) => isDashboardRoute(peer.route) && peer.route.ended)
  )
    return createSuccess({ peers: [] });
  // s100-m01: a copy told its member was removed, whose route is gone, is told that, not to set one.
  if (!routed.length && !ownerCopy && peers.some((peer) => peer.removedAt))
    return createError({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message:
        "This copy's member was removed from the project, so it syncs with no copy; what it holds stays with it.",
      suggestion:
        "Whether the project is shared with you again is the owner's to decide; this copy's review keeps the removal until then.",
    });
  if (!routed.length) {
    return createError(
      ownerCopy
        ? {
            code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
            message: 'No member of this shared record has a route from this copy yet.',
            suggestion:
              'Join a member over SSH first (reasonbook join --ssh <host> --remote-root <folder> --member <name>); for a member who has joined, set its route with reasonbook sync --ssh <host> --remote-root <folder>. Or carry a bundle (reasonbook sync --bundle-out <file>).',
          }
        : {
            code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
            message: "This copy has no route to the owner's copy, so it cannot start a sync.",
            suggestion:
              "The owner's sync reaches this copy once the owner's copy has its route (reasonbook sync --ssh there); or carry a bundle: reasonbook sync --bundle-out <file> here, and import it on the owner's machine.",
          }
    );
  }
  const outcomes: PeerOutcome[] = [];
  const refusals: RbookToolError[] = [];
  for (const peer of routed) {
    // A dashboard's route is named for the dashboard in what the sync says (s97-m11).
    const name = peer.name ?? (isDashboardRoute(peer.route) ? dashboardName(peer.route) : null);
    // A sync no person started waits out a dashboard that keeps failing (s97-m10).
    const wait = options.auto ? nextTryAt(peer) : null;
    if (wait) {
      outcomes.push({ replicaId: peer.replicaId, name, nextTryAt: wait });
      continue;
    }
    const result = await syncRoute(open, peer.route!, options);
    if (result.success && result.data) {
      // A route that reached the successor its copy took moves to it; one that reached another copy
      // is left as it was, and says so, since it no longer reaches its own.
      const reached = result.data.remote.replicaId;
      // s100-m01 (#707): a copy told its member was removed receives no move, so it cannot tell the
      // owner copy a move made from another copy; its route stays as it was, and asks for nothing.
      const removedHere = result.data.removedCopy === 'local';
      const dashboardRoute = isDashboardRoute(peer.route) ? peer.route : null;
      const moved =
        reached !== peer.replicaId &&
        !removedHere &&
        (await local((client) => {
          const ctx = mergeContext(client);
          if (
            !successorOf(ctx, reached, peer.replicaId) &&
            !(
              dashboardRoute &&
              (recoveryReplaces(ctx, reached, peer.replicaId) ||
                peerHealth(client).some(
                  (current) =>
                    current.replicaId === reached &&
                    isDashboardRoute(current.route) &&
                    current.route.url === dashboardRoute.url &&
                    current.route.projectId === dashboardRoute.projectId
                ))
            )
          )
            return false;
          if (isDashboardRoute(peer.route)) {
            endDashboardRoute(client, peer.replicaId);
          } else {
            rememberPeer(client, reached, { name: peer.name, route: peer.route });
            forgetPeers(client, [peer.replicaId]);
          }
          return true;
        }));
      const astray = reached !== peer.replicaId && !moved && !removedHere;
      if (astray)
        await local((client) =>
          recordExchangeFailed(
            client,
            peer.replicaId,
            `its route reached another copy (${reached}), not this one: set its route again with reasonbook sync --ssh`
          )
        );
      outcomes.push({
        replicaId: moved ? reached : peer.replicaId,
        name,
        report: result.data,
        warnings: [
          ...(result.warnings ?? []),
          ...(astray
            ? [
                `${peer.name ?? peer.replicaId}'s route reached another copy; set it again with reasonbook sync --ssh <host> --remote-root <folder>.`,
              ]
            : []),
        ],
      });
    } else {
      const error = result.error?.message ?? 'the sync failed';
      // A transaction held back for its size is no failure of the dashboard: the exchange went
      // through, so it is shown, never waited out (critics, round 2).
      await local((client) => {
        if (result.error?.code === REPLICA_ERROR_CODES.TRANSACTION_TOO_LARGE)
          return recordHeldBack(client, peer.replicaId, error);
        // A dashboard that no longer shares the project ended this route: this copy is no longer
        // refereed there, so it syncs with the owner's copy directly from now on (s97-m11). A copy
        // told its member was removed keeps the row its review reads the removal from (s100-m01).
        if (result.error?.code === REPLICA_ERROR_CODES.ROUTE_ENDED)
          return endDashboardRoute(client, peer.replicaId);
        return recordExchangeFailed(client, peer.replicaId, error, { count: true });
      });
      outcomes.push({ replicaId: peer.replicaId, name, error });
      if (result.error) refusals.push(result.error);
    }
  }
  const failed = outcomes.filter((outcome) => outcome.error);
  // One copy to sync with, as a member has: its own refusal, with its code and remedy (s97-m10).
  if (outcomes.length === 1 && failed.length === 1 && refusals.length === 1)
    return createError(refusals[0]);
  if (failed.length && failed.length === outcomes.length)
    return createError({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `No copy could be synced: ${failed.map((outcome) => `${outcome.name ?? outcome.replicaId}: ${outcome.error}`).join('; ')}`,
      suggestion:
        "Put right what each copy's error names, then sync again; a whole exchange repeats safely.",
    });
  return createSuccess({ peers: outcomes }, [
    ...failed.map(
      (outcome) => `${outcome.name ?? outcome.replicaId} was not synced: ${outcome.error}`
    ),
    ...outcomes.flatMap((outcome) => outcome.warnings ?? []),
  ]);
}

/**
 * Sync with the copy at `route`, and remember the route for the copy it reaches: how a route is set
 * again, as when the far machine's node or Reasonbook moved (s96-m13).
 */
export async function syncAndRoute(
  open: Opener,
  route: SshRoute,
  options: SyncOptions = {}
): Promise<RbookToolResult<ExchangeReport>> {
  const stranger = await strangerHere(options.unchecked ?? open);
  if (stranger) return createError(stranger);
  const synced = await syncRoute(open, route, options);
  if (synced.success && synced.data) {
    const reached = synced.data.remote.replicaId;
    // Named for its member, as a join names it, so the review says whose copy it reaches.
    await (options.unchecked ?? open)((client) =>
      rememberPeer(client, reached, {
        name:
          listMembers(client).find((member) =>
            member.replicas.some((replica) => replica.replicaId === reached)
          )?.name ?? null,
        route,
      })
    );
  }
  return synced;
}

/**
 * The one-command join, run on the authority's copy: the far copy asks, this copy answers for the
 * invited member, the far copy applies the answer, and the two sync. The route is remembered for
 * the member, with its remote command (ADR s96 §9; design §s96-m13 item 4).
 */
export async function joinRoute(
  open: Opener,
  route: SshRoute,
  memberName: string,
  options: SyncOptions = {}
): Promise<RbookToolResult<{ readonly joined: JoinApplied; readonly sync: ExchangeReport }>> {
  const reached = await reach(
    route,
    ['sync', '--serve', '--join'],
    options,
    options.unchecked ?? open
  );
  if (!reached.success || !reached.data) return createError(reached.error!);
  const far = reached.data;
  let joined: JoinApplied;
  try {
    const request = (await far.call('joinRequest')) as RbookToolResult<JoinRequest>;
    if (!request.success || !request.data) return createError(request.error!);
    const answer = await open((client) => answerJoin(client, request.data!, memberName));
    if (!answer.success || !answer.data) return createError(answer.error!);
    const applied = (await far.call('joinApply', answer.data)) as RbookToolResult<JoinApplied>;
    if (!applied.success || !applied.data) return createError(applied.error!);
    await open((client) =>
      rememberPeer(client, answer.data!.replicaId, { name: memberName, route })
    );
    joined = applied.data;
  } catch (error) {
    const refused = carriedRefusal(error);
    if (refused) return createError(refused);
    return createError({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `The join over ${far.name} stopped: ${message(error)}`,
      suggestion: 'Run the join again; an answer the far copy did not apply was never used.',
    });
  } finally {
    far.close();
  }
  const synced = await syncRoute(open, route, options);
  if (!synced.success || !synced.data) return createError(synced.error!);
  return createSuccess({ joined, sync: synced.data }, synced.warnings ?? []);
}
