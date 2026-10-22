// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Joining a project shared through the dashboard (s97-m11, design §The client design): the address resolved, the
// ABOUTME: first copy streamed into the folder, the 4.1.0 join through the referee, and the dashboard route kept.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { RbookDetector } from '../../intelligence/rbook-detector';
import { isContextlessDirectory } from '../../intelligence/resolution-policy';
import { registerResolvedProjectStore } from '../../intelligence/project-resolution';
import { resolveDashboardBaseUrl } from './dashboard-client';
import { createError, createSuccess } from './errors';
import { buildFreshCopy, FreshCopyRefused } from './record-fresh-copy';
import { dashboardClientFor, dashboardPeer, relayAnswer } from './record-dashboard-peer';
import { dashboardName, isDashboardRoute, type DashboardRoute } from './record-dashboard-route';
import { dashboardSharingOff } from './record-dashboard-share';
import type { ExchangeReport } from './record-exchange';
import { applyJoin, requestJoin, type JoinAnswer, type JoinApplied } from './record-join';
import { peerHealth, rememberPeer } from './record-peers';
import { isRecordedStore } from './record-recording';
import { replicaWriteRefusal } from './replica-check';
import { mergeContext } from './record-standing';
import { currentWriteProtocol } from './record-protocol-state';
import { storeOpener, syncRoute } from './record-sync';
import { sweepStaleRecordCopies } from './record-temp-copies';
import { COPY_KEYS, writeCopyKey } from './replica-copy-keys';
import { readReplicaIdentity, recordedProjectId, REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolResult } from './types';

interface DashboardJoinBase {
  readonly dashboard: string;
  /** The dashboard's id for the project, not the store's own project_id (s97-m14 live test). */
  readonly dashboardProjectId: string;
  /** The first sync after the join; a failure here leaves the join made, to sync again. */
  readonly sync: ExchangeReport | null;
}
export type DashboardJoined = DashboardJoinBase &
  (
    | { readonly joined: JoinApplied; readonly reattached?: never }
    | {
        readonly joined?: never;
        readonly reattached: { readonly replicaId: string; readonly block: number };
      }
  );

/** The store a join wrote and could not finish, taken away so the join can be asked again. */
function removeStore(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
}

/** A completed join stays completed if this machine's project list cannot be updated. */
async function registerJoinedFolder(folder: string): Promise<string[]> {
  try {
    await registerResolvedProjectStore(folder, {
      requireStoredIdentity: true,
      confirmedCopy: true,
    });
    return [];
  } catch (error) {
    return [
      `This copy was kept, but its local project-list registration failed (${error instanceof Error ? error.message : String(error)}). Restore access to this machine's Reasonbook configuration directory, then run join --dashboard again in this folder.`,
    ];
  }
}

/**
 * Join the project at `address` into `folder` through the dashboard (design §The client design):
 * resolve the address, stream the first copy, ask to join with the 4.1.0 request, send it to the
 * referee, apply its answer, keep the dashboard's route, and sync once. It needs a share for this
 * machine's account, and a folder holding no store.
 */
export async function joinThroughDashboard(input: {
  readonly folder: string;
  readonly address: string;
}): Promise<RbookToolResult<DashboardJoined>> {
  sweepStaleRecordCopies();
  const off = dashboardSharingOff();
  if (off) return createError(off);
  const folder = path.resolve(input.folder);
  // As init: no project goes into a folder that is none, such as home, where every agent started
  // there would write into the shared record (critics, round 2).
  if (isContextlessDirectory(folder))
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${folder} is not a project folder, so no project is joined into it.`,
      suggestion: 'Join into a folder of its own for this project.',
    });
  const { dbPath } = resolveRecordPaths(folder);
  const existing = fs.existsSync(dbPath);
  const client = await dashboardClientFor(folder);
  const origin = new URL(resolveDashboardBaseUrl()).origin;
  const resolved = await client.resolveAddress({ address: input.address });
  const projectId = resolved.success ? resolved.data?.resolved?.projectId : undefined;
  if (!projectId)
    return createError({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `The dashboard knows no project at ${input.address} for this account${resolved.success ? '' : `: ${resolved.error?.message ?? ''}`}.`,
      suggestion:
        "Check the address with the project's owner, and that they shared the project with you on the dashboard.",
    });
  const route: DashboardRoute = { kind: 'dashboard', url: origin, projectId };
  const name = dashboardName(route);
  if (existing) return reattach(dbPath, folder, route, input.address.trim());
  // The first copy comes in to a folder of this join's own, and the member's store is built from it
  // with this version's schema, every change checked: nothing the file holds runs here (#1492).
  const download = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonbook-join-'));
  try {
    const got = await client.downloadFirstCopy(projectId, path.join(download, 'first-copy.sqlite'));
    if (!got.success || !got.data) return createError(got.error!);
    if (got.data.status !== 200) {
      const said = relayAnswer<never>(
        name,
        createSuccess({ status: got.data.status, body: got.data.body })
      );
      return createError(said.error!);
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    try {
      await buildFreshCopy(path.join(download, 'first-copy.sqlite'), dbPath, { untrusted: true });
    } catch (error) {
      return createError({
        code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
        message: `The first copy ${name} sent could not be taken in: ${error instanceof Error ? error.message : String(error)}`,
        // s100-m01: a refusal that names its own remedy, such as a newer record protocol's upgrade,
        // keeps it.
        suggestion:
          error instanceof FreshCopyRefused && error.remedy
            ? `Nothing was joined. ${error.remedy}`
            : 'Nothing was joined. Join again; if it says the same, tell the dashboard.',
      });
    }
  } finally {
    fs.rmSync(download, { recursive: true, force: true });
  }
  // As init does: a lookup of the folder made before the join, at the server's start or by a call
  // in the last minute, remembers it held no store (s97-m14 live test).
  RbookDetector.getInstance().clearCache(folder);
  // From here the store is this join's own: a step that throws takes it away again.
  try {
    return await joinWith(dbPath, folder, client, route, name, input.address.trim());
  } catch (error) {
    removeStore(dbPath);
    throw error;
  }
}

async function joinWith(
  dbPath: string,
  folder: string,
  client: Awaited<ReturnType<typeof dashboardClientFor>>,
  route: DashboardRoute,
  name: string,
  address: string
): Promise<RbookToolResult<DashboardJoined>> {
  const projectId = route.projectId;
  const copy = storeOpener(dbPath, { replicaCheck: false });
  const request = await copy((store) => requestJoin(store));
  if (!request.success || !request.data) {
    removeStore(dbPath);
    return createError(request.error!);
  }
  const answer = relayAnswer<JoinAnswer>(
    name,
    await client.relayPeerCall(projectId, {
      method: 'answerJoin',
      params: request.data,
      replicaId: request.data.replicaId,
    })
  );
  if (!answer.success || !answer.data) {
    removeStore(dbPath);
    return createError(answer.error!);
  }
  const answered = answer.data;
  const applied = await copy((store) => {
    const done = applyJoin(store, answered);
    // The join forgets every route a copy carried; the dashboard's is this copy's own (s97-m10 F).
    if (done.success) {
      rememberPeer(store, mergeContext(store).authority, { route });
      // s100-m01: the address the copy was joined by, for its review to name (never its identity's).
      writeCopyKey(store, COPY_KEYS.joinedAddress, address);
    }
    return done;
  });
  if (!applied.success || !applied.data) return createError(applied.error!);
  const registrationWarnings = await registerJoinedFolder(folder);
  const synced = await syncRoute(storeOpener(dbPath), route, {
    unchecked: copy,
    projectRoot: folder,
  });
  return createSuccess(
    {
      dashboard: name,
      dashboardProjectId: projectId,
      joined: applied.data,
      sync: synced.success ? synced.data! : null,
    },
    [
      ...registrationWarnings,
      ...(applied.warnings ?? []),
      ...(synced.success
        ? (synced.warnings ?? [])
        : [`The first sync after the join did not finish (${synced.error?.message}); sync again.`]),
    ]
  );
}

/** Re-attachment neither downloads a store nor applies a fresh join to an already identified copy. */
async function reattach(
  dbPath: string,
  folder: string,
  route: DashboardRoute,
  address: string
): Promise<RbookToolResult<DashboardJoined>> {
  const copy = storeOpener(dbPath, { replicaCheck: false });
  const here = await copy((store) => {
    if (!isRecordedStore(store)) return null;
    const refused = replicaWriteRefusal(store);
    if (
      refused?.code === REPLICA_ERROR_CODES.NOT_JOINED ||
      refused?.code === REPLICA_ERROR_CODES.SECOND_COPY
    )
      return { refused };
    const dashboardRoutes = peerHealth(store).filter((peer) => isDashboardRoute(peer.route));
    return {
      identity: readReplicaIdentity(store, { fresh: true })!,
      projectId: recordedProjectId(store),
      hasDashboardHistory: dashboardRoutes.length > 0,
      route: dashboardRoutes.find(
        (peer) =>
          isDashboardRoute(peer.route) &&
          peer.route.url === route.url &&
          peer.route.projectId === route.projectId
      )?.route,
    };
  });
  if (here && 'refused' in here) return createError(here.refused!);
  if (!here || (!here.route && here.hasDashboardHistory))
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'This folder has no retained route for that exact dashboard project ID, so its existing store was not re-attached.',
      suggestion:
        'Use the existing copy’s original dashboard project. Join a different project into an empty folder; an address alone cannot replace a retained project identity.',
    });
  const peer = await dashboardPeer(route, {
    projectRoot: folder,
    replicaIdNow: async () => here.identity.replicaId,
    recordProtocolNow: () => copy(currentWriteProtocol),
  });
  try {
    const remote = await peer.hello();
    if (remote.projectId !== here.projectId)
      return createError({
        code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
        message: `The dashboard serves a different record (${remote.projectId}) from this copy (${here.projectId}), so nothing was re-attached.`,
        suggestion:
          'Check the project with its owner; keep this existing copy and join a different project into an empty folder.',
      });
    if (
      typeof remote.replicaId !== 'string' ||
      !remote.replicaId ||
      remote.replicaId !== remote.authority
    )
      return createError({
        code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
        message:
          'The dashboard does not hold this project’s record yet, so this copy was not re-attached.',
        suggestion: 'Ask the owner to finish sharing the project, then join --dashboard again.',
      });
    if (!here.route) {
      // A direct copy set aside before the first hosted share has no route to retain. Only the
      // authenticated referee's admission and explicit cut can authorize its first attachment;
      // this exception never replaces existing dashboard provenance or confirms an owner move.
      const own = here.identity.replicaId;
      const cut = remote.cuts?.[own];
      if (
        !Array.isArray(remote.members) ||
        !remote.members.includes(own) ||
        !Array.isArray(remote.removed) ||
        remote.removed.includes(own) ||
        !Object.prototype.hasOwnProperty.call(remote.cuts ?? {}, own) ||
        !Number.isSafeInteger(cut) ||
        cut < 0
      )
        return createError({
          code: REPLICA_ERROR_CODES.WRITE_REFUSED,
          message:
            'This copy has no dashboard history, and the authenticated referee does not name it as an admitted, nonremoved copy with an explicit cut, so nothing was re-attached.',
          suggestion:
            'Check this copy and the project with the owner. Keep this existing store; join a different project into an empty folder. A returning set-aside copy can re-attach only to the referee that knows its admission and cut.',
        });
    }
  } finally {
    peer.close();
  }
  const synced = await syncRoute(storeOpener(dbPath), here.route ?? route, {
    unchecked: copy,
    projectRoot: folder,
  });
  if (!synced.success || !synced.data) return createError(synced.error!);
  const identity = await copy((store) => {
    if (!here.route) rememberPeer(store, synced.data!.remote.replicaId, { route });
    writeCopyKey(store, COPY_KEYS.joinedAddress, address);
    return readReplicaIdentity(store, { fresh: true })!;
  });
  const registrationWarnings = await registerJoinedFolder(folder);
  return createSuccess(
    {
      dashboard: dashboardName(route),
      dashboardProjectId: route.projectId,
      reattached: identity,
      sync: synced.data,
    },
    [...registrationWarnings, ...(synced.warnings ?? [])]
  );
}
