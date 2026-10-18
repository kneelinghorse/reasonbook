// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The running server's shared-record sync (design §s96-m13 item 4): each shared project it opened that has a
// ABOUTME: route syncs on an unref timer of its own, under RBOOK_SHARED_SYNC alone; two triggers at once run one sync.

import { withoutCodexRequest } from '../../codex-request-context';
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { storeOpener, syncPeers } from './record-sync';
import {
  readsAsSyncing,
  SHARED_SYNC_INTERVAL_MS,
  sharedSyncEnabled,
  withSyncLock,
} from './record-sync-trigger';
import { captureToolCall } from './tool-call-context';

const seen = new Set<string>();
/** When a store could not be read: it is asked again, at most once a sync interval. */
const unread = new Map<string, number>();
const targets = new Set<string>();
let timer: NodeJS.Timeout | undefined;

function syncNow(projectRoot: string): Promise<unknown> {
  const dbPath = resolveRecordPaths(projectRoot).dbPath;
  // setInterval inherits its creator's request context; each sync runs in a fresh one, as an upload does.
  return withoutCodexRequest(() =>
    captureToolCall('write', async () => {
      if (sharedSyncEnabled())
        await withSyncLock(dbPath, () =>
          syncPeers(storeOpener(dbPath), {
            unchecked: storeOpener(dbPath, { replicaCheck: false }),
          })
        );
    })
  ).catch((error: unknown) =>
    process.stderr.write(
      `[SYNC] The shared record's sync failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
  );
}

/**
 * Note a project this server opened. A copy of a shared record with a route then syncs on the timer.
 * Each project is checked once, so an unshared one costs one small read per server; `recheck` looks
 * again, after a share or a join makes the project a sync target.
 */
export function observeSharedSync(
  projectRoot: string,
  options: { readonly recheck?: boolean } = {}
): void {
  if (!sharedSyncEnabled() || (seen.has(projectRoot) && !options.recheck)) return;
  // A store that could not be read, such as one busy at that moment, is asked again later, at most
  // once a sync interval, so a store that stays unreadable is neither read nor logged at every call.
  const failedAtMs = unread.get(projectRoot);
  if (
    !options.recheck &&
    failedAtMs !== undefined &&
    Date.now() - failedAtMs < SHARED_SYNC_INTERVAL_MS
  )
    return;
  const syncing = readsAsSyncing(resolveRecordPaths(projectRoot).dbPath);
  if (syncing === null) {
    unread.set(projectRoot, Date.now());
    return;
  }
  unread.delete(projectRoot);
  seen.add(projectRoot);
  if (!syncing) return;
  targets.add(projectRoot);
  if (timer) return;
  timer = setInterval(() => {
    for (const root of targets) void syncNow(root);
  }, SHARED_SYNC_INTERVAL_MS);
  timer.unref();
}

/** Tests only: what the timer runs for `projectRoot` at each tick, awaited. */
export async function __runSharedSync(projectRoot: string): Promise<void> {
  await syncNow(projectRoot);
}

/** Tests only: the projects the timer syncs. */
export function __sharedSyncTargets(): readonly string[] {
  return [...targets];
}

/** Tests only: forget every project and stop the timer. */
export function __resetSharedSyncScheduler(): void {
  seen.clear();
  unread.clear();
  targets.clear();
  if (timer) clearInterval(timer);
  timer = undefined;
}
