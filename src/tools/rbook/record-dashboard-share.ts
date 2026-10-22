// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Sharing a project through the dashboard (s97-m11, design §The client design): a dry run first, then the share,
// ABOUTME: the upload, the referee's join and the handover to it, resumable where a step stopped.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { getSetting, settingIsOff } from '../../intelligence/legacy-compat';
import { RBOOK_CHECKPOINT_SYNC_ENV, whyCloseUploadsNothing } from './checkpoint-backfill';
import type { RbookDatabaseClient } from './client';
import { resolveDashboardBaseUrl } from './dashboard-client';
import { createError, createSuccess } from './errors';
import { PROTOCOL_VERSION } from './record-changes';
import { RECORDED_TABLES } from './record-columns';
import { dashboardClientFor, relayAnswer } from './record-dashboard-peer';
import { dashboardName, type DashboardRoute } from './record-dashboard-route';
import type { ExchangeReport } from './record-exchange';
import { buildFreshCopy } from './record-fresh-copy';
import { answerJoin, type JoinAnswer, type JoinRequest } from './record-join';
import { listMembers, OWNER_MEMBER } from './record-membership';
import { namedCopies, ownersOtherCopies } from './record-owner-copies';
import { handOver } from './record-moves';
import { forgetPeers, rememberPeer } from './record-peers';
import { isRecordedStore } from './record-recording';
import { shareProject } from './record-share-action';
import { mergeContext } from './record-standing';
import { syncRoute, type Opener } from './record-sync';
import { withSyncLock } from './record-sync-trigger';
import { sweepStaleRecordCopies } from './record-temp-copies';
import { refereeingDashboard } from './record-wire';
import { COPY_KEYS, writeCopyKey } from './replica-copy-keys';
import { REPLICA_ERROR_CODES, storeFolder } from './replica-identity';
import type { RbookToolError, RbookToolResult } from './types';

/**
 * What the shared record leaves out, so a share's own upload never sends it. The whole-store uploads
 * before the handover do (s100-m02): the dashboard holds it already from the registration.
 */
const STAYS_LOCAL = [
  'agent_feedback',
  'session_events',
  'telemetry_events',
  'context_snapshots',
  'proposals',
  'sync_event_queue',
  'prompt_mappings',
] as const;

export interface DashboardSharePlan {
  readonly dashboard: string;
  /** The dashboard's id for the project, not the store's own project_id (s97-m14 live test). */
  readonly dashboardProjectId: string;
  /** Rows of the shared record the upload holds, by table. */
  readonly up: Readonly<Record<string, number>>;
  /** Rows the shared record leaves out, by table; the search index and context documents too. */
  readonly stays: Readonly<Record<string, number>>;
}

export interface DashboardShared {
  readonly dashboard: string;
  /** The dashboard's id for the project, not the store's own project_id. */
  readonly dashboardProjectId: string;
  readonly refereeReplica: string;
  /** The move of the record to the referee's copy, caught up and confirmed there. */
  readonly handover: { readonly epoch: number; readonly to: string };
  readonly sync: ExchangeReport;
  /** What went up and what stayed, as the dry run listed it. */
  readonly plan: DashboardSharePlan;
}

/** The join answer this copy gave the referee, kept until the referee applies it (#1494). */
interface PendingShare {
  readonly projectId: string;
  readonly refereeReplica: string;
  readonly answer: JoinAnswer;
}

const refusal = (said: {
  readonly message: string;
  readonly suggestion: string;
}): RbookToolResult<never> => createError({ code: REPLICA_ERROR_CODES.WRITE_REFUSED, ...said });

/** Dashboard sharing's switch (design §What plan time settled); the dashboard never turns it on. */
export const DASHBOARD_SHARING_ENV = 'RBOOK_DASHBOARD_SHARING';
/** The switch unset: on from 4.2.0, the release made after the live test through reasonbook.ai passed. */
const DASHBOARD_SHARING_DEFAULT: boolean = true;

/**
 * Why this machine starts no share or join through the dashboard, or null when the switch lets it.
 * It gates only those two: a project already shared through the dashboard syncs, and its owner's copy
 * moves it back, whatever the switch says.
 */
export function dashboardSharingOff(): RbookToolError | null {
  const set = getSetting(DASHBOARD_SHARING_ENV);
  // s100-m02: read as a person writes it, in any case (the s97 review's finding 16).
  const said = set?.trim().toLowerCase();
  const off = settingIsOff(DASHBOARD_SHARING_ENV);
  if (said === 'on' || said === '1' || (!off && DASHBOARD_SHARING_DEFAULT)) return null;
  return {
    code: REPLICA_ERROR_CODES.WRITE_REFUSED,
    message: off
      ? `Sharing through the dashboard is off on this machine (${DASHBOARD_SHARING_ENV}=${set}).`
      : 'Sharing through the dashboard is not on yet in this version of Reasonbook; it turns on once its live test passes.',
    suggestion: `Nothing was sent. ${DASHBOARD_SHARING_ENV}=on where Reasonbook runs allows it on this machine: the person's setting to decide on, not an agent's. The switch stops no sync: a project already shared through the dashboard keeps syncing, and its owner's copy can still move it back.`,
  };
}

function count(client: RbookDatabaseClient, table: string): number | null {
  const present = client.getOne<{ n: number }>(
    "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table]
  );
  if (!present.data?.n) return null;
  return client.getOne<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`).data?.n ?? 0;
}

function pendingOf(client: RbookDatabaseClient): PendingShare | null {
  const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    COPY_KEYS.dashboardShare,
  ]);
  try {
    return row.data?.value ? (JSON.parse(row.data.value) as PendingShare) : null;
  } catch {
    return null;
  }
}

/** An answer kept for a referee that has held the record already, as before a move back: spent. */
function spent(client: RbookDatabaseClient, pending: PendingShare): boolean {
  return (
    isRecordedStore(client) &&
    !refereeingDashboard(client) &&
    mergeContext(client).terms.some((term) => term.replicaId === pending.refereeReplica)
  );
}

/** Why this copy cannot be shared through the dashboard, or null; and the project id it is routed by. */
function shareProblem(
  client: RbookDatabaseClient,
  projectId: string | undefined,
  pending: PendingShare | null,
  uploadsNothing: 'off' | 'signed-out' | null
): RbookToolError | { readonly projectId: string } {
  if (isRecordedStore(client)) {
    if (refereeingDashboard(client)) {
      // A share that stopped after its handover, its answer still kept, is finished by sharing
      // again: this copy is the owner's member copy by then (critics, round 1).
      if (pending) return { projectId: pending.projectId };
      return {
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: 'This project is shared through the dashboard already.',
        suggestion: 'Sync it: reasonbook sync.',
      };
    }
    const ctx = mergeContext(client);
    const others = listMembers(client).filter(
      (member) => member.memberId !== OWNER_MEMBER && member.role !== 'removed'
    );
    if (others.length)
      return {
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `This project is shared directly with ${others.map((member) => member.name).join(', ')}, and a project shared with members does not move to the dashboard.`,
        suggestion:
          'Keep sharing it directly, or remove those members first (their copies keep what they hold), then share it through the dashboard.',
      };
    // s100-m01: the owner's other copies would be left unable to sync, with what they hold.
    const copies = ownersOtherCopies(client).filter(
      (copy) => copy.replicaId !== pending?.refereeReplica
    );
    if (copies.length)
      return {
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `This project is also kept in ${namedCopies(copies)}, and a share through the dashboard would leave ${copies.length === 1 ? 'it' : 'each'} unable to sync, so nothing was shared.`,
        suggestion:
          'Sharing through the dashboard does not take your other copies along yet. Keep sharing it directly, and sync each of those copies with this one meanwhile: reasonbook sync.',
      };
    if (ctx.ownReplica !== ctx.authority)
      return {
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: "Only the owner's copy shares the project, and this copy is a member's.",
        suggestion: "Share it from the owner's copy.",
      };
  }
  const known =
    projectId ??
    client.getOne<{ value: string }>(
      "SELECT value FROM metadata WHERE key = 'dashboard_project_id'"
    ).data?.value;
  if (!known) return notUploaded(uploadsNothing);
  return { projectId: known };
}

/** Why a project the dashboard does not hold yet is not there, and the step that puts it there. */
function notUploaded(uploadsNothing: 'off' | 'signed-out' | null): RbookToolError {
  const close =
    'rbook_session(action="start", type="custom", title="Share through the dashboard"), then rbook_session(action="complete", summary="Uploaded to share it")';
  // s100-m02 (the s97 review's finding 7): a close uploads nothing signed out or with uploads off,
  // so prescribing one alone left the next share refused the same way.
  if (uploadsNothing === 'signed-out')
    return {
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'This project is not on the dashboard yet, and this machine is not signed in to it, so nothing has uploaded it there.',
      suggestion: `Sign in on this machine first: rbook_auth(action="login_init"), then rbook_auth(action="login_complete"). An explicit session close then uploads it: ${close}; share again once that upload is done, a few seconds later.`,
    };
  if (uploadsNothing === 'off')
    return {
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `This project is not on the dashboard yet, and uploads are off on this machine (${RBOOK_CHECKPOINT_SYNC_ENV}=${getSetting(RBOOK_CHECKPOINT_SYNC_ENV)}), so nothing puts it there.`,
      suggestion: `A project is shared through the dashboard only once it has been uploaded there, and turning uploads on is the person's setting to decide on, not an agent's. With ${RBOOK_CHECKPOINT_SYNC_ENV} unset where Reasonbook runs, an explicit session close on this machine, signed in, uploads it: ${close}; then share again.`,
    };
  return {
    code: REPLICA_ERROR_CODES.WRITE_REFUSED,
    message: 'This project is not on the dashboard yet, so it has no address there.',
    suggestion: `An explicit session close uploads it there: ${close}, on this machine signed in; share again once that upload is done, a few seconds later.`,
  };
}

/**
 * Share this project through the dashboard (design §The client design): without `confirm`, only the
 * dry run, by table and row count. With it: share locally if need be, upload only the shared record,
 * answer the referee's join, sync until it holds everything, hand over to it, and catch it up. A step
 * that stops is picked up again by sharing again.
 */
export async function shareThroughDashboard(
  open: Opener,
  unchecked: Opener,
  dbPath: string,
  options: { readonly confirm?: boolean; readonly projectId?: string; readonly authorName?: string }
): Promise<RbookToolResult<{ readonly plan: DashboardSharePlan } | DashboardShared>> {
  sweepStaleRecordCopies();
  const off = dashboardSharingOff();
  if (off) return createError(off);
  // No other sync of this copy runs in the middle of a share (critics, round 1).
  const shared = await withSyncLock(dbPath, () => share(open, unchecked, dbPath, options));
  return (
    shared ??
    refusal({
      message: 'A sync of this copy is running, so nothing was shared.',
      suggestion: 'Ask again once it finishes.',
    })
  );
}

async function share(
  open: Opener,
  unchecked: Opener,
  dbPath: string,
  options: { readonly confirm?: boolean; readonly projectId?: string; readonly authorName?: string }
): Promise<RbookToolResult<{ readonly plan: DashboardSharePlan } | DashboardShared>> {
  const projectRoot = storeFolder(dbPath);
  let pending = await unchecked((store) => {
    const kept = pendingOf(store);
    if (!kept || !spent(store, kept)) return kept;
    writeCopyKey(store, COPY_KEYS.dashboardShare, null);
    return null;
  });
  const uploadsNothing = await whyCloseUploadsNothing();
  const checked = await unchecked((client) =>
    shareProblem(client, options.projectId, pending, uploadsNothing)
  );
  if ('code' in checked) return createError(checked);
  const route: DashboardRoute = {
    kind: 'dashboard',
    url: new URL(resolveDashboardBaseUrl()).origin,
    projectId: checked.projectId,
  };
  const name = dashboardName(route);
  const plan = await unchecked(
    (client): DashboardSharePlan => ({
      dashboard: name,
      dashboardProjectId: route.projectId,
      // The shared tables' rows, and the change log with its conflicts: every value ever recorded.
      up: Object.fromEntries(
        [...RECORDED_TABLES, 'record_changes', 'record_conflicts']
          .map((table) => [table, count(client, table) ?? 0] as const)
          .filter(([, rows]) => rows)
      ),
      stays: Object.fromEntries(
        STAYS_LOCAL.flatMap((table) => {
          const rows = count(client, table);
          return rows ? [[table, rows] as const] : [];
        })
      ),
    })
  );
  if (!options.confirm) return createSuccess({ plan });

  const client = await dashboardClientFor(projectRoot);
  // The referee must take in what this copy writes: an older one would refuse it (design §Versions).
  const record = await client.refereeProtocol(route.projectId);
  if (record.success && typeof record.data === 'number' && record.data < PROTOCOL_VERSION)
    return refusal({
      message: `${name} runs an older Reasonbook engine (record protocol ${record.data}) than this copy (${PROTOCOL_VERSION}), so it could not take in this project's changes.`,
      suggestion:
        'Nothing was sent. Share it through the dashboard once the dashboard has upgraded.',
    });

  // The share's start: share locally if need be, upload only the shared record, and answer the
  // referee's join here, the answer kept until the referee applies it (#1494).
  const begin = async (): Promise<RbookToolResult<PendingShare>> => {
    if (!(await unchecked((store) => isRecordedStore(store)))) {
      const shared = await open((store) =>
        shareProject(store, projectRoot, { authorName: options.authorName })
      );
      if (!shared.success) return createError(shared.error!);
    }
    // Built in a folder of its own, which no other account on this machine can open (critics, round 1).
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonbook-upload-'));
    const upload = path.join(folder, 'record.sqlite');
    try {
      await buildFreshCopy(dbPath, upload);
      const sent = await client.relayRefereeCall(route.projectId, { kind: 'upload', file: upload });
      // The upload is held to the dashboard's file limit, which no smaller page helps (critics, round 2).
      if (sent.success && sent.data?.status === 413)
        return refusal({
          message: `${name} takes no upload as large as this project's shared record (${fs.statSync(upload).size} bytes), so nothing was shared.`,
          suggestion:
            'Nothing was sent. Share it directly meanwhile (rbook_project(action="share")), or ask the dashboard about its file limit.',
        });
      const created = relayAnswer<{ joinRequest: JoinRequest }>(name, sent);
      if (!created.success || !created.data) return createError(created.error!);
      const request = created.data.joinRequest;
      const answered = await open((store) => {
        const owner = listMembers(store).find((member) => member.memberId === OWNER_MEMBER);
        const answer = answerJoin(store, request, owner?.name ?? '');
        if (!answer.success || !answer.data) return answer;
        rememberPeer(store, request.replicaId, { route });
        writeCopyKey(
          store,
          COPY_KEYS.dashboardShare,
          JSON.stringify({
            projectId: route.projectId,
            refereeReplica: request.replicaId,
            answer: answer.data,
          })
        );
        return answer;
      });
      if (!answered.success || !answered.data) return createError(answered.error!);
      return createSuccess({
        projectId: route.projectId,
        refereeReplica: request.replicaId,
        answer: answered.data,
      });
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  };
  // A kept answer's referee the dashboard threw away, as by a discard after the answer was lost: the
  // dashboard no longer shares the project, and that referee never held the record (critics, round 2).
  const discarded = async (stale: PendingShare): Promise<boolean> => {
    const sharing = await client.dashboardSharing(route.projectId);
    if (!sharing.success || !sharing.data?.listed || sharing.data.shared !== false) return false;
    return unchecked(
      (store) =>
        !refereeingDashboard(store) &&
        !(
          isRecordedStore(store) &&
          mergeContext(store).terms.some((term) => term.replicaId === stale.refereeReplica)
        )
    );
  };
  const kept = pending !== null;
  if (!pending) {
    const begun = await begin();
    if (!begun.success || !begun.data) return createError(begun.error!);
    pending = begun.data;
  }
  let sent = await client.relayRefereeCall(route.projectId, {
    kind: 'answer',
    answer: pending.answer,
  });
  if (kept && sent.success && sent.data?.status === 404 && (await discarded(pending))) {
    // That answer is spent, and its route leads nowhere: the share starts again, with a new referee.
    const stale = pending;
    await unchecked((store) => {
      writeCopyKey(store, COPY_KEYS.dashboardShare, null);
      forgetPeers(store, [stale.refereeReplica]);
    });
    const begun = await begin();
    if (!begun.success || !begun.data) return createError(begun.error!);
    pending = begun.data;
    sent = await client.relayRefereeCall(route.projectId, {
      kind: 'answer',
      answer: pending.answer,
    });
  }
  const applied = relayAnswer<unknown>(name, sent);
  // An answer the referee applied already, as when a share stopped after sending it, is no refusal:
  // the answer route refuses a second answer, and only that, as REFEREE_METHOD_REFUSED (#1494).
  if (!applied.success && applied.error?.code !== 'REFEREE_METHOD_REFUSED')
    return createError(applied.error!);
  const sync = { unchecked, projectRoot };
  const caughtUp = await syncRoute(open, route, sync);
  if (!caughtUp.success) return createError(caughtUp.error!);
  const moved = await open((store) => {
    const ctx = mergeContext(store);
    return ctx.authority === pending!.refereeReplica
      ? createSuccess({ epoch: ctx.epoch, to: ctx.authority })
      : handOver(store, { to: pending!.refereeReplica });
  });
  if (!moved.success || !moved.data) return createError(moved.error!);
  const confirmed = await syncRoute(open, route, sync);
  if (!confirmed.success || !confirmed.data) return createError(confirmed.error!);
  await open((store) => writeCopyKey(store, COPY_KEYS.dashboardShare, null));
  return createSuccess({
    dashboard: name,
    dashboardProjectId: route.projectId,
    refereeReplica: pending!.refereeReplica,
    handover: { epoch: moved.data.epoch, to: moved.data.to },
    sync: confirmed.data,
    plan,
  });
}
