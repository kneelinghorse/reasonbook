// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Joining a project shared through the dashboard (s97-m11, design §The client design): the address resolved, the
// ABOUTME: first copy streamed into the folder, the 4.1.0 join through the referee, and the dashboard route kept.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { RbookDetector } from '../../intelligence/rbook-detector';
import { isContextlessDirectory } from '../../intelligence/resolution-policy';
import { resolveDashboardBaseUrl } from './dashboard-client';
import { createError, createSuccess } from './errors';
import { buildFreshCopy, FreshCopyRefused } from './record-fresh-copy';
import { dashboardClientFor, relayAnswer } from './record-dashboard-peer';
import { dashboardName, type DashboardRoute } from './record-dashboard-route';
import { dashboardSharingOff } from './record-dashboard-share';
import type { ExchangeReport } from './record-exchange';
import { applyJoin, requestJoin, type JoinAnswer, type JoinApplied } from './record-join';
import { rememberPeer } from './record-peers';
import { mergeContext } from './record-standing';
import { storeOpener, syncRoute } from './record-sync';
import { sweepStaleRecordCopies } from './record-temp-copies';
import { COPY_KEYS, writeCopyKey } from './replica-copy-keys';
import { REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolResult } from './types';

export interface DashboardJoined {
  readonly dashboard: string;
  /** The dashboard's id for the project, not the store's own project_id (s97-m14 live test). */
  readonly dashboardProjectId: string;
  readonly joined: JoinApplied;
  /** The first sync after the join; a failure here leaves the join made, to sync again. */
  readonly sync: ExchangeReport | null;
}

/** The store a join wrote and could not finish, taken away so the join can be asked again. */
function removeStore(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal'])
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
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
  if (fs.existsSync(dbPath))
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${folder} holds a Reasonbook store already, so no project is joined into it.`,
      suggestion: 'Join into an empty folder.',
    });
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
      ...(applied.warnings ?? []),
      ...(synced.success
        ? (synced.warnings ?? [])
        : [`The first sync after the join did not finish (${synced.error?.message}); sync again.`]),
    ]
  );
}
