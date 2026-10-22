// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Moving a project back from the dashboard to its owner's copy (s97-m11, design §The client design): a successor
// ABOUTME: the referee admits, taken here, handed the record, caught up and confirmed; resumable where it stopped.

import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { replicaMarks } from './record-apply';
import { dashboardClientFor, dashboardPeer } from './record-dashboard-peer';
import { contributeRecovery } from './record-dashboard-recovery';
import { libraryAtLeast } from './record-dashboard-history';
import { dashboardName, type DashboardRoute } from './record-dashboard-route';
import { clientPeer, exchange, type ExchangeReport } from './record-exchange';
import { OWNER_MEMBER } from './record-membership';
import { confirmOwner, type Handover } from './record-moves';
import { endDashboardRoute } from './record-peers';
import { mergeContext } from './record-standing';
import { currentWriteProtocol } from './record-protocol-state';
import { takeSuccessor, type Successor, type SuccessorTaken } from './record-successor';
import { syncRoute, type Opener } from './record-sync';
import { withSyncLock } from './record-sync-trigger';
import { refereeingDashboard } from './record-wire';
import { COPY_KEYS, writeCopyKey } from './replica-copy-keys';
import { readReplicaIdentity, REPLICA_ERROR_CODES, storeFolder } from './replica-identity';
import type { RbookToolResult } from './types';

export interface MovedBack {
  readonly dashboard: string;
  /** The identity this copy took to hold the record again, and what it said. */
  readonly successor: SuccessorTaken | null;
  readonly handover: Handover | null;
  readonly epoch: number;
  /** The last sync with the dashboard; none when it had archived its copy before this ask. */
  readonly sync: ExchangeReport | null;
}

const refused = (said: { readonly message: string; readonly suggestion: string }) =>
  createError<MovedBack>({ code: REPLICA_ERROR_CODES.WRITE_REFUSED, ...said });

/** Where a move back stands on this copy: how far the move got. */
function stage(client: RbookDatabaseClient) {
  const ctx = mergeContext(client);
  const own = ctx.members.get(ctx.ownReplica);
  return {
    ctx,
    ownerCopy: own?.member === OWNER_MEMBER || ctx.terms[0].replicaId === ctx.ownReplica,
    // A successor this copy took for the move: an owner copy that succeeds another, and holds no term.
    successorTaken:
      own?.member === OWNER_MEMBER &&
      own.previous !== undefined &&
      !ctx.terms.some((term) => term.replicaId === ctx.ownReplica),
    holds: ctx.authority === ctx.ownReplica && !ctx.pending,
  };
}

/** The dashboard route this copy keeps to `replicaId`, if any. */
function refereeingAt(client: RbookDatabaseClient, replicaId: string): DashboardRoute | null {
  const row = client.getOne<{ route: string | null }>(
    'SELECT route FROM record_peers WHERE replica_id = ?',
    [replicaId]
  );
  try {
    const route = row.data?.route ? (JSON.parse(row.data.route) as DashboardRoute) : null;
    return route?.kind === 'dashboard' ? route : null;
  } catch {
    return null;
  }
}

/** The referee this copy moves from: the authority's, or after the move, the term before it. */
function refereeOf(client: RbookDatabaseClient): DashboardRoute | null {
  const ctx = mergeContext(client);
  const previous = ctx.terms[ctx.terms.length - 2]?.replicaId;
  return refereeingDashboard(client) ?? (previous ? refereeingAt(client, previous) : null);
}

/**
 * Move the project back from the dashboard to this copy, the owner's (design §The client design):
 * sync, have the referee admit a successor of this copy, take it here, ask the referee to hand the
 * record to it, catch up that move, confirm it (asking for the move back is the owner's word), and sync
 * once more at the new epoch, after which the dashboard archives its referee. A move that stopped is
 * picked up again by asking again. It holds the sync lock throughout, so no other sync of this copy
 * runs in the middle of it.
 */
export async function moveBackFromDashboard(
  open: Opener,
  unchecked: Opener,
  dbPath: string
): Promise<RbookToolResult<MovedBack>> {
  const route = await unchecked((client) => refereeOf(client));
  if (!route)
    return refused({
      message: 'This project is not shared through a dashboard, so there is nothing to move back.',
      suggestion: 'Sync it as it is shared: reasonbook sync.',
    });
  const moved = await withSyncLock(dbPath, () =>
    moveBack(open, unchecked, storeFolder(dbPath), route)
  );
  return (
    moved ??
    refused({
      message: 'A sync of this copy is running, so the move back did not start.',
      suggestion: 'Ask again once it finishes: reasonbook move --to owner.',
    })
  );
}

async function moveBack(
  open: Opener,
  unchecked: Opener,
  projectRoot: string,
  route: DashboardRoute
): Promise<RbookToolResult<MovedBack>> {
  const name = dashboardName(route);
  const sync = { unchecked, projectRoot };
  const peer = () =>
    dashboardPeer(route, {
      projectRoot,
      replicaIdNow: () =>
        unchecked((client) => readReplicaIdentity(client, { fresh: true })?.replicaId ?? ''),
      contextNow: () => unchecked((client) => mergeContext(client)),
      recordProtocolNow: () => unchecked(currentWriteProtocol),
      recovering: (error, dashboard) => contributeRecovery(unchecked, route, error, dashboard),
    });
  let successor: SuccessorTaken | null = null;
  let handover: Handover | null = null;
  const finish = async (report: ExchangeReport | null): Promise<RbookToolResult<MovedBack>> => {
    const done = await unchecked((client) => {
      const ctx = mergeContext(client);
      endDashboardRoute(client, ctx.terms[ctx.terms.length - 2]?.replicaId ?? '');
      // A share's answer kept from before is spent: a later share starts fresh (critics, round 1).
      writeCopyKey(client, COPY_KEYS.dashboardShare, null);
      return ctx;
    });
    return createSuccess({ dashboard: name, successor, handover, epoch: done.epoch, sync: report });
  };
  const unfinished = (said: string) =>
    refused({
      message: `This copy holds the project's record again, but ${said}, so the move back has not finished.`,
      suggestion:
        'Ask again to finish it: reasonbook move --to owner. Nothing is lost meanwhile, and members keep their changes.',
    });
  // An already-applied move still finishes its archive; otherwise an old engine must refuse
  // before a sync can admit or take a successor and change this copy's identity.
  if (!(await unchecked((client) => stage(client))).holds) {
    const capability = await (
      await dashboardClientFor(projectRoot, route)
    ).refereeCapabilities(route.projectId);
    if (!capability.success) return createError(capability.error!);
    if (!libraryAtLeast(capability.data!.version, '4.2.0'))
      return refused({
        message: `${name} must report Reasonbook library 4.2.0 or later before this copy moves back; it reported ${capability.data!.version ?? 'no version'}. Nothing moved.`,
        suggestion:
          'Ask the dashboard to upgrade its referee library, then retry reasonbook move --to owner.',
      });
  }
  // A sync first: every change this copy made goes to the referee, and a move asked again learns
  // how far it got, such as the referee's admission of this copy's successor or its handover.
  const first = await syncRoute(open, route, sync);
  if (first.error?.code === REPLICA_ERROR_CODES.ROUTE_ENDED) {
    // The dashboard archived its copy after this copy's last sync: a move that stopped there is done.
    if ((await unchecked((client) => stage(client))).holds) return finish(null);
    return createError(first.error);
  }
  if (first.error?.code === REPLICA_ERROR_CODES.TRANSACTION_TOO_LARGE) {
    // Asked again once this copy holds the record, the move is done but for the dashboard's archive.
    if ((await unchecked((client) => stage(client))).holds)
      return unfinished(`${name} takes none of its syncs: ${first.error.message}`);
    return refused({
      message: `Some of this copy's changes have not reached ${name}, so the project does not move back yet: ${first.error.message}`,
      suggestion:
        'Nothing moved. The project moves back once the dashboard holds every change this copy made.',
    });
  }
  if (!first.success || !first.data) return createError(first.error!);
  const before = await unchecked((client) => stage(client));
  if (!before.ownerCopy)
    return refused({
      message: "Only the owner's copy moves the project back, and this copy is a member's.",
      suggestion: "Move it back from the owner's copy.",
    });
  // A move pending here that is not to this copy is another's: asking for the move back confirms none.
  if (before.ctx.pending && before.ctx.pending.value.authority !== before.ctx.ownReplica)
    return refused({
      message:
        'This copy holds a move of the owner copy it has not confirmed, so it moves nothing back.',
      suggestion: 'Confirm that move first: reasonbook sync --confirm-owner.',
    });
  if (!before.holds && !before.ctx.pending && !before.successorTaken) {
    // Every change this copy made must be on the referee: the old identity ends where it holds it.
    // The take refuses one written since the last sync, under the write lock; it is synced, and the
    // take asked again, with the successor the referee admitted (critics, round 2).
    const own = before.ctx.ownReplica;
    let synced: ExchangeReport = first.data;
    for (let attempt = 1; !successor; attempt += 1) {
      const held = synced.remote.marks[own] ?? 0;
      const made = (await unchecked((client) => replicaMarks(client)))[own] ?? 0;
      if (held < made)
        return refused({
          message: `${made - held} of this copy's changes have not reached ${name}, so the project does not move back yet.`,
          suggestion: 'Sync until they have (reasonbook sync), then move the project back again.',
        });
      const admitted = await (await peer()).admitSuccessor({ replicaId: own });
      if (!admitted.success || !admitted.data) return createError(admitted.error!);
      const next: Successor = admitted.data;
      const taken = await unchecked((client) =>
        takeSuccessor(client, {
          successor: next,
          reason: 'move-back',
          authorityReceived: held,
          cut: held,
        })
      );
      if (taken.success && taken.data) successor = taken.data;
      else {
        const wrote = ((await unchecked((client) => replicaMarks(client)))[own] ?? 0) > held;
        if (!wrote || attempt >= 3) return createError(taken.error!);
        const again = await syncRoute(open, route, sync);
        if (!again.success || !again.data) return createError(again.error!);
        synced = again.data;
      }
    }
  }
  const after = await unchecked((client) => stage(client));
  if (!after.holds && !after.ctx.pending) {
    // The referee hands the record to this copy's successor, which it names as this call's replica.
    // Its new identity must report its library before a record with permanent cuts can move to it.
    const target = await peer();
    try {
      await target.hello();
      handover = (await target.call('moveBack', {})) as Handover;
    } finally {
      target.close();
    }
  }
  if (!(await unchecked((client) => stage(client))).holds) {
    // The move, caught up here, and confirmed: asking for the move back was the owner's word. A
    // catch-up delivers nothing to the referee, so its note lets the dashboard archive nothing (D6).
    const caught = await exchange(clientPeer('this copy', open, unchecked), await peer());
    if (!caught.success) return createError(caught.error!);
    const now = await unchecked((client) => mergeContext(client));
    if (now.pending && now.pending.value.authority !== now.ownReplica)
      return refused({
        message: `${name} moved the record to another copy than this one, so this copy confirms nothing.`,
        suggestion: "Sync it (reasonbook sync) and see the move in the project's review.",
      });
    if (now.pending) {
      const confirmed = await unchecked((client) => confirmOwner(client));
      if (!confirmed.success) return createError(confirmed.error!);
    }
  }
  const archived = async (): Promise<boolean | string> => {
    const sharing = await (
      await dashboardClientFor(projectRoot, route)
    ).dashboardSharing(route.projectId);
    if (!sharing.success || !sharing.data)
      return `${name} did not say whether it archived its copy (${sharing.error?.message ?? 'no answer'})`;
    // Only its word counts: a list that names no sharing state at all archives nothing (critics, round 2).
    if (!sharing.data.listed || sharing.data.shared === false) return true;
    return sharing.data.shared === null
      ? `${name} does not say whether it still shares the project`
      : false;
  };
  // One sync at the new epoch: this copy judges, the referee takes its delivery, and its note lets
  // the dashboard archive its copy; then the dashboard must say it no longer shares the project.
  let report: ExchangeReport = first.data;
  let gone = await archived();
  if (gone !== true) {
    const last = await syncRoute(open, route, sync);
    if (!last.success || !last.data)
      return unfinished(`its last sync with ${name} stopped (${last.error?.message})`);
    report = last.data;
    gone = await archived();
  }
  if (gone !== true) return unfinished(gone || `${name} still shares the project`);
  return finish(report);
}
