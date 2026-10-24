// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Runs one owner-checked whole-store upload and classifies its outcome without retry loops.
// ABOUTME: Checkpoint and manual sends share auth rechecks, terminal holds and WAL-safe snapshots.

import { isSameDirectory } from '../../intelligence/resolution-policy';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { UploadOutcome } from '../../intelligence/project-upload-state';
import {
  DashboardClient,
  type ResolvedDashboardClient,
  type SyncSqliteFileResult,
} from './dashboard-client';
import { inspectUploadOwner, recheckUploadAuth } from './dashboard-upload-auth';
import { checkAndRegister } from './checkpoint-registration';
import { withUploadSnapshot, readUploadProject, uploadLog } from './dashboard-upload';
import type { RbookToolError } from './types';

export interface UploadAttempt {
  readonly outcome: UploadOutcome;
  readonly data?: SyncSqliteFileResult;
  readonly error?: RbookToolError;
}

function retryAfter(error?: RbookToolError): number | undefined {
  const state = error?.currentState;
  return state && typeof state === 'object' && typeof state.retryAfterMs === 'number'
    ? state.retryAfterMs
    : undefined;
}

export async function uploadFailure(
  projectRoot: string,
  error?: RbookToolError,
  ownerConfirmed = false
): Promise<UploadOutcome> {
  const base = {
    success: false,
    error:
      error?.code === 'PROJECT_NAME_CONFLICT' && error.suggestion
        ? `${error.message} ${error.suggestion}`
        : (error?.message ?? 'Dashboard upload unavailable.'),
    retryAfterMs: retryAfter(error),
  };
  if (error?.code === 'DASHBOARD_AUTH_FAILED') {
    const project = readUploadProject(projectRoot);
    const graph = await ProjectGraphRegistry.create();
    const state = project ? graph.readUploadState(project.projectId) : null;
    const checked = await recheckUploadAuth(projectRoot, {
      authFirstFailedAt: state?.authFirstFailedAt,
    });
    return {
      ...base,
      pauseReason: checked.recovered ? null : checked.pauseReason,
      authFirstFailedAt: checked.authFirstFailedAt,
      retryAfterMs: Math.max(base.retryAfterMs ?? 0, checked.retryAfterMs ?? 0),
    };
  }
  if (error?.code === 'PROJECT_DELETED' && ownerConfirmed)
    return { ...base, pauseReason: 'deleted' };
  if (error?.code === 'PROJECT_REPLACED' && ownerConfirmed)
    return { ...base, pauseReason: 'replaced' };
  if (error?.code === 'DASHBOARD_UPGRADE_REQUIRED') return { ...base, pauseReason: 'tier' };
  if (error?.code === 'DASHBOARD_FORBIDDEN') return { ...base, pauseReason: 'forbidden' };
  return base;
}

/** The caller already owns the upload lease. No path here acquires it a second time. */
export async function attemptDashboardUpload(
  projectRoot: string,
  allowRegister: boolean,
  destination?: { sqlitePath: string; projectSlug: string; expectedSlug: string }
): Promise<UploadAttempt> {
  const resolved = await DashboardClient.fromEnvForProject(projectRoot);
  if (!resolved.success || !resolved.data)
    return { outcome: await uploadFailure(projectRoot, resolved.error), error: resolved.error };
  let sending: ResolvedDashboardClient = resolved.data;
  let owner = await inspectUploadOwner(projectRoot, sending);
  if (owner.replaced)
    return {
      outcome: {
        success: false,
        pauseReason: 'replaced',
        error: 'This project was replaced on reasonbook.ai. Nothing was uploaded.',
      },
    };
  if (owner.error) {
    // No body has been sent. A same-owner key can make the single confirming upload now.
    if (owner.error.code === 'DASHBOARD_AUTH_FAILED') {
      const project = readUploadProject(projectRoot);
      const graph = await ProjectGraphRegistry.create();
      const state = project ? graph.readUploadState(project.projectId) : null;
      const check = await recheckUploadAuth(projectRoot, {
        authFirstFailedAt: state?.authFirstFailedAt,
      });
      if (check.confirmingClient) {
        sending = { ...sending, client: check.confirmingClient, keySource: 'user-scoped' };
        owner = { ownerConfirmed: true, projectListed: false, replaced: false };
      } else {
        return {
          outcome: {
            success: false,
            error: owner.error.message,
            pauseReason: check.recovered ? null : check.pauseReason,
            authFirstFailedAt: check.authFirstFailedAt,
            retryAfterMs: Math.max(retryAfter(owner.error) ?? 0, check.retryAfterMs ?? 0),
          },
          error: owner.error,
        };
      }
    } else return { outcome: await uploadFailure(projectRoot, owner.error), error: owner.error };
  }
  const checked = await checkAndRegister(
    projectRoot,
    sending.client,
    sending.keySource,
    allowRegister
  );
  if (!checked || checked.error)
    return {
      outcome: await uploadFailure(projectRoot, checked?.error, checked?.ownerConfirmed === true),
      error: checked?.error,
    };
  if (checked.ownerConfirmed !== undefined) owner.ownerConfirmed = checked.ownerConfirmed;
  const info = checked?.projectSlug
    ? checked
    : destination
      ? { ...destination, warnings: checked?.warnings, error: checked?.error }
      : checked;
  for (const warning of info?.warnings ?? []) uploadLog(warning);
  if (!info?.projectSlug)
    return {
      outcome: await uploadFailure(projectRoot, info?.error, owner.ownerConfirmed),
      error: info?.error,
    };
  const result = await withUploadSnapshot(info.sqlitePath, (snapshot) =>
    sending.client.syncSqliteFile(snapshot, info.projectSlug!, info.expectedSlug ?? undefined)
  );
  if (!result.success || !result.data)
    return {
      outcome: await uploadFailure(projectRoot, result.error, owner.ownerConfirmed),
      error: result.error,
    };
  const data = result.data;
  if (data.errors.length)
    return { outcome: { success: false, error: data.errors.join('; ') }, data };
  uploadLog(`File sync: ${info.projectSlug} (${data.durationMs}ms)`);
  return { outcome: { success: true }, data };
}

/** Probe only after the caller has checked switch, sign-in, ownership and read-only gates. */
export async function probeDashboardUpload(projectRoot: string): Promise<void> {
  const project = readUploadProject(projectRoot);
  if (!project) return;
  const graph = await ProjectGraphRegistry.create();
  const entry = graph.get(project.projectId);
  if (!entry || !isSameDirectory(entry.store_path, projectRoot))
    throw new Error('Upload probe identity does not match its registered store path.');
  const state = graph.readUploadState(project.projectId);
  const claim = graph.claimUploadProbe(project.projectId);
  if (claim === null) return;
  const checked = await recheckUploadAuth(projectRoot, {
    authFirstFailedAt: state?.authFirstFailedAt,
  });
  graph.finishUploadProbe(project.projectId, claim, {
    ...checked,
    recovered: checked.recovered || !!checked.confirmingClient,
  });
}
