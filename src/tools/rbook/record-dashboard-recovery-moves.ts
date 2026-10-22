// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Hosted recovery is confirmed only after each local safety condition and the normal authority chain agree.
// ABOUTME: Rebinding follows a confirmed recovery, including one the person confirmed between syncs; SSH stays explicit.

import type { RbookDatabaseClient } from './client';
import { createError } from './errors';
import { authorityValue } from './record-authority';
import {
  isActiveDashboardRoute,
  isDashboardRoute,
  type DashboardRoute,
} from './record-dashboard-route';
import { dashboardRecoveryState, keepDashboardRecovery } from './record-dashboard-recovery';
import type { Peer } from './record-exchange';
import { listMembers, OWNER_MEMBER } from './record-membership';
import { confirmOwner } from './record-moves';
import { forgetPeers, peerHealth, rememberPeer } from './record-peers';
import { mergeContext, type LoggedChange, type MergeContext } from './record-standing';
import type { Opener } from './record-sync';
import { REPLICA_ERROR_CODES } from './replica-identity';

/** The recorded relation, not a remote hello, proves a recovered referee replaces this route's copy. */
export function recoveryReplaces(ctx: MergeContext, next: string, previous: string): boolean {
  const seen = new Set<string>();
  let at = next;
  while (!seen.has(at)) {
    seen.add(at);
    const term = ctx.terms.find((candidate) => candidate.replicaId === at);
    if (!term?.change) return false;
    const value = authorityValue(term.change);
    if (value.move !== 'recovery') return false;
    if (value.previous === previous) return true;
    at = value.previous;
  }
  return false;
}

/** Called before route selection too: manual confirmation must not strand the old keyed route. */
export function rebindRecoveryRoutes(client: RbookDatabaseClient): void {
  const ctx = mergeContext(client);
  for (const peer of peerHealth(client)) {
    if (!isDashboardRoute(peer.route) || !recoveryReplaces(ctx, ctx.authority, peer.replicaId))
      continue;
    rememberPeer(client, ctx.authority, { name: peer.name, route: peer.route });
    forgetPeers(client, [peer.replicaId]);
    const state = dashboardRecoveryState(client);
    keepDashboardRecovery(client, {
      accepted: state.accepted,
      ...(state.held && !ctx.terms.some((term) => term.change?.change_id === state.held?.changeId)
        ? { held: state.held }
        : {}),
      ...(state.status
        ? {
            status: {
              ...state.status,
              detail: 'recovery completed; this copy follows the recovered referee',
            },
          }
        : {}),
    });
  }
}

/** A received invalid candidate still gets a diagnosis even when authorityChain excludes it. */
export function considerHostedRecovery(
  client: RbookDatabaseClient,
  previous: string,
  changes: readonly LoggedChange[]
): string[] {
  const allFailures: string[] = [];
  const pending = mergeContext(client).pending?.change;
  const candidates = new Map(
    changes.filter((row) => row.kind === 'authority').map((row) => [row.change_id, row])
  );
  if (pending) candidates.set(pending.change_id, pending);
  for (const change of candidates.values()) {
    const ctx = mergeContext(client);
    if (ctx.terms.some((term) => term.change?.change_id === change.change_id)) continue;
    const value = authorityValue(change);
    const failures: string[] = [];
    const fail = (condition: string, why: string) =>
      failures.push(`${condition} condition failed: ${why}`);
    if (value.move !== 'recovery') fail('move', 'the move is not a recovery');
    if (value.epoch !== ctx.epoch + 1) fail('epoch', 'the epoch is not the applied epoch plus one');
    if (value.previous !== previous)
      fail('previous', 'the previous referee differs from the dashboard route');
    const admitted = client.getOne(
      'SELECT 1 FROM record_changes WHERE kind = ? AND entity_id = ? LIMIT 1',
      ['replica_joined', value.authority]
    );
    if (!admitted.success)
      throw new Error(admitted.error?.message ?? 'Admission history could not be read.');
    if (ctx.members.has(value.authority) || ctx.unseen.has(value.authority) || admitted.data)
      fail('authority', 'the new authority was already admitted for a member');
    const ownMember = ctx.members.get(ctx.ownReplica)?.member;
    const name = listMembers(client).find((member) => member.memberId === ownMember)?.name;
    if (
      Object.prototype.hasOwnProperty.call(value.dropped ?? {}, ctx.ownReplica) ||
      (ownMember !== OWNER_MEMBER &&
        (!name || !Array.isArray(value.members) || !value.members.includes(name)))
    )
      fail(
        'membership',
        'this copy was dropped or its member is absent from the confirmed members'
      );
    if (!Number.isSafeInteger(value.cut) || value.cut! < ctx.prefixOf(previous))
      fail('cut', 'the recovery cut is below this copy’s gap-free old-referee prefix');
    if (!failures.length && ctx.pending?.change.change_id !== change.change_id)
      fail('authority chain', 'this is not the unique valid next move');
    if (failures.length) {
      const remedied = failures.map(
        (failure) =>
          `${failure}; review with the owner, then reasonbook sync --confirm-owner (invalid chains first need correction)`
      );
      keepDashboardRecovery(client, {
        ...dashboardRecoveryState(client),
        held: { changeId: change.change_id, failures: remedied },
      });
      allFailures.push(...remedied);
      continue;
    }
    const confirmed = confirmOwner(client, { changeId: change.change_id });
    if (!confirmed.success)
      throw new Error(confirmed.error?.message ?? 'The recovery could not be confirmed.');
  }
  return allFailures;
}

/** Only a dashboard sync wraps the local apply; direct SSH and bundle moves keep their existing rule. */
export async function hostedRecoveryPeer(
  near: Peer,
  local: Opener,
  route: DashboardRoute
): Promise<Peer> {
  const previous = await local((client) => {
    const ctx = mergeContext(client);
    return peerHealth(client).find(
      (peer) =>
        peer.replicaId === ctx.authority &&
        isActiveDashboardRoute(peer.route) &&
        peer.route.url === route.url &&
        peer.route.projectId === route.projectId
    )?.replicaId;
  });
  if (!previous) return near;
  return {
    ...near,
    apply: async (changes, options) => {
      // A remote row claiming this copy wrote an authority move would otherwise satisfy the
      // chain's locally-authored shortcut before the post-apply conditions can inspect it.
      const ownClaim = await local((client) => {
        const own = mergeContext(client).ownReplica;
        for (const change of changes) {
          if (change.kind !== 'authority' || change.replica_id !== own) continue;
          const held = client.getOne('SELECT 1 FROM record_changes WHERE change_id = ?', [
            change.change_id,
          ]);
          if (!held.success)
            throw new Error(
              held.error?.message ?? 'The local authority history could not be read.'
            );
          if (held.data) continue;
          const message =
            'authority condition failed: a new remote authority change claims this copy’s own authorship';
          const suggestion =
            'Review the recovery with the owner before reasonbook sync --confirm-owner; the dashboard must correct a forged authority claim.';
          keepDashboardRecovery(client, {
            ...dashboardRecoveryState(client),
            held: { changeId: change.change_id, failures: [`${message}; ${suggestion}`] },
          });
          return createError<never>({
            code: REPLICA_ERROR_CODES.WRITE_REFUSED,
            message,
            suggestion: suggestion,
          });
        }
        return null;
      });
      if (ownClaim) return ownClaim;
      const applied = await near.apply(changes, options);
      if (applied.success)
        await local((client) => {
          const done = client.writeTransaction(() =>
            considerHostedRecovery(client, previous, changes)
          );
          if (!done.success)
            throw new Error(done.error?.message ?? 'The recovery conditions could not be checked.');
        });
      return applied;
    },
  };
}
