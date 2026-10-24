// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Sharing a project through the dashboard (s97-m11, design §The client design): a dry run first, then the share,
// ABOUTME: the upload, the referee's join and the handover to it, resumable where a step stopped.

import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { getSetting, settingIsOff } from '../../intelligence/legacy-compat';
import { whyCloseUploadsNothing } from './checkpoint-backfill';
import type { RbookDatabaseClient } from './client';
import { resolveDashboardBaseUrl } from './dashboard-client';
import { createError, createSuccess } from './errors';
import { currentWriteProtocol } from './record-protocol-state';
import { RECORDED_TABLES } from './record-columns';
import { dashboardClientFor, relayAnswer } from './record-dashboard-peer';
import { dashboardName, type DashboardRoute } from './record-dashboard-route';
import { formerDashboardReferees, libraryAtLeast } from './record-dashboard-history';
import {
  confirmedShareProblem,
  pendingOf,
  shareProblem,
  spent,
  type PendingShare,
} from './record-dashboard-share-state';
import type { ExchangeReport } from './record-exchange';
import { buildFreshCopy } from './record-fresh-copy';
import { answerJoin, type JoinAnswer, type JoinRequest } from './record-join';
import { listMembers, OWNER_MEMBER } from './record-membership';
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
  if ('code' in checked)
    return createError(
      options.confirm ? await confirmedShareProblem(checked, projectRoot) : checked
    );
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
  const capability = await client.refereeCapabilities(route.projectId);
  const former = await unchecked((store) =>
    isRecordedStore(store) ? formerDashboardReferees(store, route) : []
  );
  const hasSetAside = await unchecked(
    (store) =>
      isRecordedStore(store) &&
      [...mergeContext(store).setAsideCuts.values()].some((cuts) => Object.keys(cuts).length > 0)
  );
  if (
    hasSetAside &&
    (!capability.success || !libraryAtLeast(capability.data?.version ?? null, '4.5.0'))
  )
    return refusal({
      message: `This record holds a set-aside, so ${name} must report Reasonbook library 4.5.0 or later before sharing it; it reported ${capability.data?.version ?? 'no usable version'}.`,
      suggestion:
        'Nothing was uploaded. Ask the dashboard to upgrade its referee library, then share again.',
    });
  if (
    former.length &&
    (!capability.success || !libraryAtLeast(capability.data?.version ?? null, '4.5.0'))
  )
    return refusal({
      message: `${name} must report Reasonbook library 4.5.0 or later to share this former referee's project again; it reported ${capability.data?.version ?? 'no usable version'}.`,
      suggestion:
        'Nothing was uploaded. Ask the dashboard to upgrade its referee library, then share again.',
    });
  const record = capability.data?.recordProtocol;
  const reads = Number.isInteger(record) && record! > 0 ? record! : 1;
  const writing = await unchecked((store) =>
    isRecordedStore(store) ? currentWriteProtocol(store) : 1
  );
  if (reads < writing)
    return refusal({
      message: `${name} runs an older Reasonbook engine (record protocol ${record ?? 'unreported'}) than this record (${writing}), so it could not take in this project's changes.`,
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
      // The source may have switched after preflight; inspect these immutable upload bytes.
      const snapshot = new Database(upload, { readonly: true });
      let required: number;
      try {
        required = (
          snapshot
            .prepare('SELECT COALESCE(max(protocol_version), 1) AS protocol FROM record_changes')
            .get() as { protocol: number }
        ).protocol;
      } finally {
        snapshot.close();
      }
      if (required > reads)
        return refusal({
          message: `${name} reads record protocol ${record ?? 'unreported'}, but this upload contains protocol ${required} changes, so nothing was uploaded.`,
          suggestion:
            'Ask the dashboard to upgrade its referee library, then share again; this copy keeps every change.',
        });
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
        const committed = store.writeTransaction(() => {
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
        if (!committed.success) return createError<JoinAnswer>(committed.error!);
        return committed.data!;
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
