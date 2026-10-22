// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Open a copy store or its dashboard/SSH sync channel with the existing refusal boundaries.
// ABOUTME: Keep transport setup separate from exchange results and route iteration.
import { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { dashboardPeer } from './record-dashboard-peer';
import { contributeRecovery } from './record-dashboard-recovery';
import { dashboardName, isDashboardRoute } from './record-dashboard-route';
import { hello } from './record-exchange';
import { peerHealth, type PeerRoute } from './record-peers';
import { sshPeer } from './record-ssh';
import { mergeContext } from './record-standing';
import { currentWriteProtocol } from './record-protocol-state';
import {
  carriedRefusal,
  isReplicaRefusal,
  readReplicaIdentity,
  REPLICA_ERROR_CODES,
  ReplicaRefusal,
} from './replica-identity';
import type { RbookToolResult } from './types';
import { refereeingDashboard, type WirePeer } from './record-wire';
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Runs a step against a fresh client on this copy's store. */
export type Opener = <T>(step: (client: RbookDatabaseClient) => T) => Promise<Awaited<T>>;

/** A step against a fresh client on this copy's store, closed afterwards. */
export function storeOpener(
  dbPath: string,
  options: { readonly replicaCheck?: boolean } = {}
): Opener {
  return async <T>(step: (client: RbookDatabaseClient) => T): Promise<Awaited<T>> => {
    const opened = await RbookDatabaseClient.create({
      dbPath,
      registerProject: false,
      ...(options.replicaCheck === false ? { replicaCheck: false } : {}),
    });
    // A copy check's refusal keeps its code and remedy, so the answer can name them.
    if (!opened.success || !opened.data)
      throw isReplicaRefusal(opened.error)
        ? new ReplicaRefusal(opened.error!)
        : new Error(opened.error?.message ?? 'the store could not be opened');
    try {
      // A step may be async, such as an apply that embeds what it merged: the store stays open for it.
      return await step(opened.data);
    } finally {
      opened.data.close();
    }
  };
}

/** A step's answer, or the copy check's refusal, with its own remedy, when the store would not open. */
export async function answered<T>(
  pending: Promise<RbookToolResult<T>>
): Promise<RbookToolResult<T>> {
  try {
    return await pending;
  } catch (error) {
    const refused = carriedRefusal(error);
    if (refused) return createError<T>(refused);
    throw error;
  }
}

export interface SyncOptions {
  /** The ssh client to run; a test passes a stand-in. */
  readonly ssh?: string;
  /**
   * s96-m13: this copy opened without its check, for reads, per-copy health and the steps that put
   * a refused copy right (re-identifying it); writes to the record go through the checked opener.
   */
  readonly unchecked?: Opener;
  /** s97-m10: the project folder, whose credentials sign a dashboard route's calls (decision #832). */
  readonly projectRoot?: string;
  /** s97-m10: a sync no person started (a hook or the timer), which waits out a failing dashboard. */
  readonly auto?: boolean;
}

/**
 * Open the channel to a copy: the SSH channel to its far end, or (s97-m10) the dashboard that
 * referees the project, whose calls name this copy's replica as `local` reads it. Or say why not.
 */
export async function reach(
  route: PeerRoute,
  verb: readonly string[] | undefined,
  options: SyncOptions,
  local: Opener
): Promise<RbookToolResult<WirePeer>> {
  if (isDashboardRoute(route)) {
    if (!options.projectRoot)
      return createError({
        code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
        message: `This copy reaches ${dashboardName(route)}, but this sync named no project folder to sign its calls with.`,
        suggestion: 'Sync from the project: reasonbook sync --project-root <folder>.',
      });
    try {
      return createSuccess(
        await dashboardPeer(route, {
          projectRoot: options.projectRoot,
          replicaIdNow: () =>
            local((client) => readReplicaIdentity(client, { fresh: true })?.replicaId ?? ''),
          contextNow: () => local((client) => mergeContext(client)),
          recordProtocolNow: () => local(currentWriteProtocol),
          recovering: (error, dashboard) => contributeRecovery(local, route, error, dashboard),
          removedHere: () =>
            local((client) => {
              const ctx = mergeContext(client);
              return Boolean(
                peerHealth(client).find((peer) => peer.replicaId === ctx.authority)?.removedAt
              );
            }),
        })
      );
    } catch (error) {
      const refused = carriedRefusal(error);
      if (refused) return createError(refused);
      throw error;
    }
  }
  // A project the dashboard referees moves only through it: this copy opens no SSH channel at all,
  // so no far copy can stand in for the referee (critics, round 2).
  const refereed = await local((client) => refereeingDashboard(client));
  if (refereed)
    return createError({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `This project is shared through ${dashboardName(refereed)}, so this copy opens no SSH channel to another copy.`,
      suggestion: 'Sync through the dashboard instead: reasonbook sync.',
    });
  try {
    return createSuccess(
      await sshPeer(route, {
        verb,
        ssh: options.ssh,
        nearHello: () =>
          local((client) => {
            const { projectId, replicaId, authority, epoch, libraryVersion, reads } = hello(client);
            return { projectId, replicaId, authority, epoch, libraryVersion, reads };
          }),
      })
    );
  } catch (error) {
    return createError({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `${route.host} could not be reached: ${message(error)}`,
      suggestion:
        'Check that the machine is awake with Remote Login on, and that its remote command names Reasonbook there, then sync again; if the machine or its paths moved, set the route again: reasonbook sync --ssh <host> --remote-root <folder>.',
    });
  }
}
