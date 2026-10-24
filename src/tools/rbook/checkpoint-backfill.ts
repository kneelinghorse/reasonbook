// ABOUTME: Explicit closes and timed debt uploads share a fenced lease and consistent snapshots.
// ABOUTME: Failures remain outside project stores and never block a successful caller write.
/**
 * Checkpoint Backfill — Fire-and-Forget Dashboard Sync
 *
 * Triggers a non-blocking sync to the dashboard at workflow boundaries
 * (session complete, sprint complete). Errors are logged to stderr and
 * never propagate to the caller.
 *
 * Primary path: POST SQLite file to /api/sync/sqlite-backfill (file-based bulk sync).
 * An unregistered destination reports a failure; legacy event replay is retired.
 *
 * Auto-registers the project with the dashboard on first checkpoint if not
 * already registered (checks `dashboard_registered` metadata flag).
 *
 * @module tools/rbook/checkpoint-backfill
 */

import { getSetting, settingIsOff } from '../../intelligence/legacy-compat';
import { attemptDashboardUpload, probeDashboardUpload } from './dashboard-upload-attempt';
import {
  RBOOK_DASHBOARD_API_KEY_ENV,
  RBOOK_DASHBOARD_USER_ENV,
  RBOOK_DASHBOARD_PASSWORD_ENV,
} from './dashboard-client';
import { CredentialStore } from '../../intelligence/credential-store';
import { resolveSenderContext } from '../../intelligence/sender-context';
import { isReadOnlyAgentSession } from './read-only-agent-guard';
import {
  isMembersStore,
  readUploadProject,
  withUploadLease,
  trackDashboardUpload,
  uploadLog,
} from './dashboard-upload';

/**
 * s86-m01 — write diagnostics straight to fd 2 instead of through the console
 * object.
 *
 * This module's work happens inside a fire-and-forget async IIFE
 * (`triggerCheckpointBackfill`) that deliberately outlives its caller. Under Jest
 * that body can still be in flight when a suite finishes, and Jest replaces the
 * global console object at teardown, so a late error write through it throws
 * "Cannot log after tests are done" — which surfaces as a nonzero exit AFTER a
 * fully green run (the CI flake root-caused in decision #970 and re-diagnosed in
 * s86-m01). `process.stderr` is not patched, so the same line lands without
 * arming that trap.
 *
 * Production behaviour is byte-identical: a stdio MCP server's error logging
 * already writes to fd 2, and stdout is reserved for the JSON-RPC channel.
 * In-tree precedent: `warnLegacyAuth` (dashboard-client.ts) already writes this way.
 *
 * The structural gate tests/tools/rbook/detached-log-gate.test.ts (Arm A) keeps
 * this module — and the other two on this path — free of console calls.
 */
function log(line: string): void {
  uploadLog(line);
}

/**
 * s86-m01 — kill switch for the fire-and-forget checkpoint sync.
 *
 * Set to the exact string `'off'` to disable it; any other value (including
 * `'on'`) leaves normal behaviour untouched. Exported so tests reference the name
 * rather than re-spelling the literal.
 */
export const RBOOK_CHECKPOINT_SYNC_ENV = 'RBOOK_CHECKPOINT_SYNC';

// ─── Sprint 70 m04: device-code credential gate ──────────────────────────────

/**
 * Whether the local CredentialStore holds a RESOLVABLE user-scoped key — i.e. at
 * least one device-code-minted record carrying a non-empty `cmk_...` key.
 *
 * This is the device-code-auth signal the checkpoint gate accepts in addition to
 * the env vars (#303/#701). Device-code-only auth (default since Sprint 57)
 * populates this store but NOT `RBOOK_DASHBOARD_API_KEY` / `USER`+`PASSWORD`, so the
 * old env-only gate silently skipped sync for those users. Mere presence of the
 * store FILE is not enough — an empty/placeholder record does not count (RISK
 * guard: do not open the gate wider than real device-code auth). Async +
 * non-throwing: any read failure folds into `false` (fail closed).
 *
 * Exported for tests.
 */
export async function hasResolvableUserScopedKey(): Promise<boolean> {
  try {
    const store = CredentialStore.getInstance();
    const keys = await store.listUserScopedKeys();
    return Object.values(keys).some(
      (record) => typeof record.key === 'string' && record.key.length > 0
    );
  } catch {
    return false;
  }
}

/**
 * s100-m02: why an explicit session close would upload nothing on this machine, or null. The share
 * names it for a project the dashboard does not hold yet, rather than prescribe a close that cannot
 * put it there (the s97 review's finding 7).
 */
export async function whyCloseUploadsNothing(): Promise<'off' | 'signed-out' | null> {
  if (settingIsOff(RBOOK_CHECKPOINT_SYNC_ENV)) return 'off';
  const hasApiKey = !!getSetting(RBOOK_DASHBOARD_API_KEY_ENV);
  const hasCredentials =
    !!getSetting(RBOOK_DASHBOARD_USER_ENV) && !!getSetting(RBOOK_DASHBOARD_PASSWORD_ENV);
  return hasApiKey || hasCredentials || (await hasResolvableUserScopedKey()) ? null : 'signed-out';
}

/**
 * s86-m01 — the most recently started checkpoint sync, held so a test that does
 * NOT own the call site can still drain it deterministically.
 *
 * `triggerCheckpointBackfill` already returns its promise, but the two production
 * call sites (rbook-sprint.ts, rbook-session.ts) deliberately drop it — that
 * non-blocking shape is the point, and awaiting it would be a user-visible
 * latency regression on every sprint/session complete. A test that drives
 * `rbook_sprint(action='complete')` therefore has no handle on the async work it
 * just started, and the detached body outlives the test: it re-resolves dashboard
 * credentials from `process.env` mid-flight, so an `afterEach` that restores
 * those vars flips the in-flight run onto a different code path and its log lands
 * after teardown. `__drainCheckpointBackfill` gives those tests the handle.
 */
const inFlightCheckpoints = new Set<Promise<void>>();

/**
 * Await the most recently triggered checkpoint sync (resolves immediately when
 * none has run). TEST-ONLY — the leading underscores mark it as not part of the
 * tool surface.
 *
 * Call it in an `afterEach` BEFORE restoring/deleting dashboard credential env
 * vars. Draining afterwards reproduces the bug instead of fixing it: the detached
 * body reads those vars as it runs, so tearing them down first is what pushes it
 * onto the no-credential fallback whose failure line arrives post-teardown.
 */
export async function __drainCheckpointBackfill(): Promise<void> {
  while (inFlightCheckpoints.size) await Promise.all([...inFlightCheckpoints]);
}

/**
 * Trigger a checkpoint sync in a fire-and-forget manner.
 *
 * Primary path: file-based sync via POST /api/sync/sqlite-backfill (idempotent, bulk).
 * An unregistered destination reports a failure; legacy event replay is retired.
 *
 * On first checkpoint, auto-registers the project with the dashboard
 * before running the sync.
 *
 * Returns the in-flight sync promise. Production callers IGNORE it — the sync
 * runs asynchronously and never blocks the caller (the trailing `.catch` folds
 * errors into a stderr log, so the returned promise always resolves and never
 * rejects). Tests `await` it for a deterministic drain: the device-code gate
 * does a real CredentialStore fs read, which heuristic event-loop ticking can
 * miss under full-suite load, leaking the async into the next test. Tests that
 * cannot reach the returned promise (because a production call site dropped it)
 * use {@link __drainCheckpointBackfill} instead.
 *
 * @param options.projectRoot - Project root for sync
 * @param options.force - true for full sync (sprint complete), false for incremental (session complete)
 */
export function triggerCheckpointBackfill(options: {
  projectRoot?: string;
  force: boolean;
  automatic?: boolean;
}): Promise<void> {
  if (settingIsOff(RBOOK_CHECKPOINT_SYNC_ENV) || isReadOnlyAgentSession()) {
    return Promise.resolve();
  }
  const inFlight = trackDashboardUpload(async () => {
    if ((await whyCloseUploadsNothing()) === 'signed-out') return;
    // Freeze resolution before detached work. Production dispatch always passes its resolved root.
    const projectRoot = options.projectRoot ?? (await resolveSenderContext({})).projectRoot;
    // s96-m13 (design §s96-m13 item 3): a member's copy of a shared record never registers, names
    // the dashboard project or uploads, at a checkpoint or on the timer; only the owner's copy does.
    let membersCopy = false;
    try {
      const project = readUploadProject(projectRoot);
      membersCopy = project ? await isMembersStore(project) : false;
    } catch {
      // A store the read cannot open is reported by the upload below, as before.
    }
    if (membersCopy) return;
    if (options.automatic) await probeDashboardUpload(projectRoot);
    await withUploadLease(
      projectRoot,
      options.automatic !== true,
      async () => (await attemptDashboardUpload(projectRoot, options.automatic !== true)).outcome
    );
  })
    .then(() => undefined)
    .catch((error: unknown) => {
      log(`Sync error: ${error instanceof Error ? error.message : String(error)}`);
    });
  inFlightCheckpoints.add(inFlight);
  void inFlight.finally(() => inFlightCheckpoints.delete(inFlight));
  return inFlight;
}
