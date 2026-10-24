// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Gives each explicit close a local upload receipt before its detached work begins.
// ABOUTME: Reports gates, durable holds and last success without waiting for a network request.

import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import { resolveSenderContext } from '../../intelligence/sender-context';
import { whyCloseUploadsNothing } from './checkpoint-backfill';
import { isMembersStore, readUploadProject } from './dashboard-upload';
import { isReadOnlyAgentSession } from './read-only-agent-guard';

export interface DashboardUploadReceipt {
  readonly started: boolean;
  readonly why:
    | 'off'
    | 'signed-out'
    | 'members-copy'
    | 'read-only'
    | 'deleted'
    | 'replaced'
    | 'no-store'
    | 'unavailable'
    | null;
  readonly lastSuccessAt: string | null;
  readonly paused: { readonly since: string | null; readonly reason: string } | null;
  readonly nextAttemptAt: string | null;
  readonly error?: string;
}

const iso = (value: number | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

export async function closeUploadReceipt(projectRoot?: string): Promise<DashboardUploadReceipt> {
  const empty = { started: false, lastSuccessAt: null, paused: null, nextAttemptAt: null };
  try {
    const why = isReadOnlyAgentSession() ? 'read-only' : await whyCloseUploadsNothing();
    const root = projectRoot ?? (await resolveSenderContext({})).projectRoot;
    const project = readUploadProject(root);
    if (!project) return { ...empty, why: why ?? 'no-store' };
    const graph = await ProjectGraphRegistry.create();
    const id = graph.getByStorePath(root);
    const state = id === project.projectId ? graph.readUploadState(project.projectId) : null;
    const held =
      state?.blocked && (state.pauseReason === 'deleted' || state.pauseReason === 'replaced')
        ? state.pauseReason
        : null;
    const gate = held ?? why ?? ((await isMembersStore(project)) ? 'members-copy' : null);
    return {
      started: gate === null,
      why: gate,
      lastSuccessAt: iso(state?.lastSyncedAt),
      nextAttemptAt: iso(state?.nextAttemptAt),
      paused: state?.blocked
        ? {
            since: iso(state.pausedAt ?? state.lastAttemptAt),
            reason: state.pauseReason ?? 'unknown',
          }
        : null,
    };
  } catch (error) {
    return {
      ...empty,
      why: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatUploadReceipt(receipt: DashboardUploadReceipt): string {
  return (
    `Dashboard upload: ${receipt.started ? 'started for this close' : `not started (${receipt.why})`}` +
    (receipt.paused
      ? `; paused since ${receipt.paused.since ?? 'unknown'} (${receipt.paused.reason})`
      : '') +
    `; last success ${receipt.lastSuccessAt ?? 'never'}` +
    (receipt.nextAttemptAt ? `; next automatic try ${receipt.nextAttemptAt}` : '') +
    (receipt.error ? `; ${receipt.error.replace(/[\r\n\t]+/g, ' ')}` : '') +
    '.'
  );
}
