// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Pays durable dashboard upload debt for projects opened by this running server.
// ABOUTME: A single unref timer uses a fresh request context; reads never mark a project dirty.

import { settingIsOff } from '../../intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import { isSameDirectory } from '../../intelligence/resolution-policy';
import { triggerCheckpointBackfill } from './checkpoint-backfill';
import { isMembersStore, readUploadProject, uploadLog } from './dashboard-upload';
import { isReadOnlyAgentSession } from './read-only-agent-guard';
import { captureToolCall } from './tool-call-context';
import { withoutCodexRequest } from '../../codex-request-context';

const opened = new Set<string>();
const pending = new Set<Promise<unknown>>();
let timer: NodeJS.Timeout | undefined;
const enabled = (): boolean => !settingIsOff('RBOOK_CHECKPOINT_SYNC') && !isReadOnlyAgentSession();

function launch(projectRoot: string): void {
  // setInterval inherits its creator's AsyncLocalStorage. Replace that context so later uploads
  // never write into the read/write call that happened to open this project first.
  const job = withoutCodexRequest(() =>
    captureToolCall('write', async () => {
      if (enabled())
        await triggerCheckpointBackfill({ projectRoot, force: false, automatic: true });
    })
  ).catch((error: unknown) =>
    uploadLog(`Automatic upload failed: ${error instanceof Error ? error.message : String(error)}`)
  );
  pending.add(job);
  void job.finally(() => pending.delete(job));
}

function startTimer(): void {
  if (timer || !enabled()) return;
  timer = setInterval(() => {
    if (enabled()) for (const root of opened) launch(root);
  }, 60_000);
  timer.unref();
}

export async function observeDashboardUploadProject(projectRoot: string): Promise<void> {
  if (!enabled() || opened.has(projectRoot)) return;
  opened.add(projectRoot);
  startTimer();
  launch(projectRoot);
}

export async function markDashboardUploadOwed(projectRoot: string): Promise<void> {
  if (!enabled()) return;
  try {
    const project = readUploadProject(projectRoot);
    // s96-m13: a member's copy of a shared record never uploads; only the owner's copy does.
    if (!project?.registered || (await isMembersStore(project))) return;
    const graph = await ProjectGraphRegistry.create();
    const entry = graph.get(project.projectId);
    if (
      !entry ||
      !isSameDirectory(entry.store_path, project.projectRoot) ||
      !graph.markUploadOwed(project.projectId)
    )
      throw new Error('Written store does not match an active project registry row.');
    await observeDashboardUploadProject(projectRoot);
  } catch (error) {
    uploadLog(
      `Could not mark upload owed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function readDashboardUploadStatus(projectRoot: string): Promise<string | null> {
  try {
    const graph = await ProjectGraphRegistry.create();
    const projectId = graph.getByStorePath(projectRoot);
    if (!projectId) return null;
    const state = graph.readUploadState(projectId);
    if (!state) return null;
    // Registration alone is not an upload attempt. Keep actual debt and failure history visible.
    if (
      state.lastSyncedAt === null &&
      state.lastAttemptAt === null &&
      state.firstOwedAt === null &&
      state.lastOutcome === null &&
      state.lastError === null &&
      !state.blocked
    )
      return null;
    const last = state.lastSyncedAt === null ? 'never' : new Date(state.lastSyncedAt).toISOString();
    return (
      `Dashboard upload: last success ${last}` +
      (state.lastOutcome ? `; ${state.lastOutcome}` : '') +
      (state.firstOwedAt === null ? '' : '; pending') +
      (state.lastError ? `; ${state.lastError.replace(/[\r\n\t]+/g, ' ')}` : '') +
      (state.blocked ? '; automatic uploads paused until an explicit close succeeds' : '') +
      '.'
    );
  } catch (error) {
    return `Dashboard upload status unavailable: ${(error instanceof Error ? error.message : String(error)).replace(/[\r\n\t]+/g, ' ')}`;
  }
}

export async function __drainDashboardUploads(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}

export async function __resetDashboardUploadScheduler(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  opened.clear();
  await __drainDashboardUploads();
}
