// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A dashboard recovery collects one scrubbed contribution from each copy, with durable local receipts.
// ABOUTME: Both sharing switches gate uploads; held moves and collecting state remain visible without stopping writes.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { settingIsOff } from '../../intelligence/legacy-compat';
import type { StreamHead } from '../../referee/open';
import type { RbookDatabaseClient } from './client';
import type { DashboardClient } from './dashboard-client';
import { isDashboardRoute, type DashboardRoute } from './record-dashboard-route';
import { peerHealth } from './record-peers';
import { mergeContext } from './record-standing';
import type { Opener } from './record-sync';
import { sharedSyncEnabled } from './record-sync-trigger';
import { COPY_KEYS, writeCopyKey } from './replica-copy-keys';
import type { RbookToolError } from './types';

export interface RecoveryOffer {
  readonly recoveryId: string;
  readonly projectId: string;
  readonly state: 'collecting' | 'cancelled';
  readonly lostHead: StreamHead;
}

export interface DashboardRecoveryState {
  readonly accepted: readonly string[];
  readonly status?: {
    readonly recoveryId: string;
    readonly projectId: string;
    readonly previous: string;
    readonly detail: string;
  };
  readonly held?: { readonly changeId: string; readonly failures: readonly string[] };
}

/** Unlike a best-effort display note, this receipt must not disappear after a failed metadata read. */
export function dashboardRecoveryState(client: RbookDatabaseClient): DashboardRecoveryState {
  const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    COPY_KEYS.dashboardRecovery,
  ]);
  if (!row.success)
    throw new Error(row.error?.message ?? 'The recovery receipt could not be read.');
  if (!row.data) return { accepted: [] };
  const state = JSON.parse(row.data.value) as DashboardRecoveryState;
  if (!Array.isArray(state.accepted) || state.accepted.some((key) => typeof key !== 'string'))
    throw new Error('The recovery receipt is unreadable; no contribution was sent.');
  return state;
}

export function keepDashboardRecovery(
  client: RbookDatabaseClient,
  state: DashboardRecoveryState
): void {
  writeCopyKey(client, COPY_KEYS.dashboardRecovery, JSON.stringify(state));
}

/** The host's offer is data: it must name the exact dashboard project and remembered referee. */
function offered(
  value: unknown,
  route: DashboardRoute,
  previous: readonly string[]
): RecoveryOffer | null {
  if (!value || typeof value !== 'object') return null;
  const offer = value as RecoveryOffer;
  const head = offer.lostHead;
  return typeof offer.recoveryId === 'string' &&
    offer.recoveryId.length > 0 &&
    offer.recoveryId.length <= 200 &&
    offer.projectId === route.projectId &&
    (offer.state === 'collecting' || offer.state === 'cancelled') &&
    head &&
    typeof head.replicaId === 'string' &&
    previous.includes(head.replicaId) &&
    Number.isSafeInteger(head.seq) &&
    head.seq >= 0 &&
    (head.hash === null ||
      (head.seq === 0 && head.hash === '') ||
      (typeof head.hash === 'string' && /^[a-f0-9]{64}$/i.test(head.hash)))
    ? offer
    : null;
}

/** Contribute once per accepted recovery/copy; an unacknowledged HTTP request retries idempotently. */
export async function contributeRecovery(
  local: Opener,
  route: DashboardRoute,
  error: RbookToolError,
  dashboard: DashboardClient
): Promise<RbookToolError> {
  const here = await local((client) => ({
    own: mergeContext(client).ownReplica,
    file: client.path,
    previous: peerHealth(client)
      .filter(
        (peer) =>
          isDashboardRoute(peer.route) &&
          peer.route.projectId === route.projectId &&
          peer.route.url === route.url
      )
      .map((peer) => peer.replicaId),
  }));
  const offer = offered(error.currentState, route, here.previous);
  if (!offer)
    return {
      ...error,
      message: `${error.message} The recovery offer does not match this copy's dashboard project and referee, so no copy was uploaded.`,
    };
  const key = JSON.stringify([offer.recoveryId, here.own]);
  const note = async (detail: string, accepted = false) =>
    local((client) => {
      const state = dashboardRecoveryState(client);
      keepDashboardRecovery(client, {
        ...state,
        accepted: accepted ? [...new Set([...state.accepted, key])] : state.accepted,
        status: {
          recoveryId: offer.recoveryId,
          projectId: offer.projectId,
          previous: offer.lostHead.replicaId,
          detail,
        },
      });
    });
  let detail = 'recovery collecting copies';
  if (offer.state === 'cancelled')
    detail = 'recovery cancelled; no upload starts until the owner begins another recovery';
  else if ((await local(dashboardRecoveryState)).accepted.includes(key))
    detail += '; this copy uploaded already';
  else if (!sharedSyncEnabled())
    detail += '; upload stopped by RBOOK_SHARED_SYNC or this read-only session';
  else if (settingIsOff('RBOOK_DASHBOARD_SHARING'))
    detail += '; upload stopped by RBOOK_DASHBOARD_SHARING';
  else {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonbook-upload-'));
    try {
      const file = path.join(folder, 'recovery.sqlite');
      const { buildFreshCopy } = await import('./record-fresh-copy');
      const built = await buildFreshCopy(here.file, file);
      if (built.replicaId !== here.own)
        throw new Error('This copy changed identity before its recovery upload; sync again.');
      const sent = await dashboard.relayRecoveryCopy(route.projectId, {
        recoveryId: offer.recoveryId,
        replicaId: here.own,
        file,
      });
      const body = sent.data?.body as
        | {
            success?: boolean;
            data?: { recoveryId?: string; replicaId?: string; projectId?: string };
            error?: string | { message?: string; suggestion?: string };
            limit?: number;
          }
        | undefined;
      const hostMessage = typeof body?.error === 'string' ? body.error : body?.error?.message;
      const remedy = typeof body?.error === 'object' ? body.error?.suggestion : undefined;
      if (sent.success && sent.data && (sent.data.status < 200 || sent.data.status >= 300)) {
        const limit =
          Number.isFinite(body?.limit) && body!.limit! > 0 ? `; limit ${body!.limit} bytes` : '';
        const next =
          sent.data.status === 413
            ? "Ask the owner to check the dashboard's recovery upload limit, then sync again."
            : remedy;
        throw new Error(
          `The dashboard refused the recovery copy (HTTP ${sent.data.status}${limit}).${hostMessage ? ` ${hostMessage}` : ''}${next ? ` ${next}` : ''}`
        );
      }
      if (
        !sent.success ||
        body?.success !== true ||
        body.data?.recoveryId !== offer.recoveryId ||
        body.data.replicaId !== here.own ||
        body.data.projectId !== route.projectId
      )
        throw new Error(
          sent.error?.message ??
            (hostMessage ? `${hostMessage}${remedy ? ` ${remedy}` : ''}` : undefined) ??
            'The dashboard did not return a receipt for this recovery, project and copy.'
        );
      detail += '; this copy uploaded';
      await note(detail, true);
      return { ...error, message: `${error.message} ${detail}.` };
    } catch (problem) {
      detail += `; upload not accepted: ${problem instanceof Error ? problem.message : String(problem)}`;
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
  await note(detail);
  return { ...error, message: `${error.message} ${detail}.` };
}
