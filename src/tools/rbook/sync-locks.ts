// ABOUTME: Retired dashboard soft-lock entry points refuse before contacting the old sync service.
// ABOUTME: Existing mission, sprint and identity hooks keep local edits and warn on legacy collab_role stores.

import { withClientAsync, type RbookDatabaseClient } from './client';
import type { DashboardClient } from './dashboard-client';
import { createError, createSuccess } from './errors';
import type { RbookToolResult } from './types';
import { PROJECT_IDENTITY_ENTITY_ID, type MutableFieldScope } from './sync-mutable';
import { getProjectIdentity } from './project-identity';
import type { PushMutableStatusResult } from './sync-mutable-push';
import { legacySyncRefusal } from './legacy-sync-refusal';
import { checkWrite, type WriteSink } from './write-guard';

function readMeta(db: RbookDatabaseClient, key: string): string | null {
  const row = db.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  return row.success && row.data?.value ? row.data.value : null;
}

function writeMeta(db: RbookDatabaseClient, key: string, value: string, sink: WriteSink): void {
  const res = db.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
    key,
    value,
  ]);
  checkWrite(res, sink, `metadata.${key}`);
}

/** Slug-scoped cache key (matches the `pull_cursor:<slug>` convention), so a store
 *  re-pointed at a different dashboard project never returns a stale platform id. */
function platformProjectIdKey(slug: string): string {
  return `platform_project_id:${slug}`;
}

/**
 * Resolve the platform `projects.id` for the project's slug (Sprint 71 m05). Cached
 * in `metadata.platform_project_id:<slug>` after the first lookup. Returns null when
 * the slug can't be matched in getMyProjects() (e.g. not a member, or the dashboard is
 * unreachable) — the caller then proceeds lockless. NOT the rbook_projects.id that the
 * clone stores as dashboard_project_id (different namespace — the whole point).
 *
 * `sink` carries a failed CACHE write into the caller's warnings (s86-m02b). The write is
 * a memo, not the lock itself — the resolved id is returned either way and the lock still
 * acquires — so its failure costs one extra getMyProjects() round-trip per edit, which the
 * answer should say rather than present the resolution as cached. It is REQUIRED and carries
 * no default: `pushMutableStatusUnderLock` passes the `warnings` array it returns on
 * `PushUnderLockResult`, which `maybePropagateMutableStatus` folds into `result.warnings`
 * (rendered by `appendWarnings`). A default would let a future caller drop that silently.
 */
export async function resolvePlatformProjectId(
  db: RbookDatabaseClient,
  client: DashboardClient,
  slug: string,
  sink: WriteSink
): Promise<string | null> {
  const cacheKey = platformProjectIdKey(slug);
  const cached = readMeta(db, cacheKey);
  if (cached) return cached;
  const mine = await client.getMyProjects();
  if (!mine.success || !mine.data) return null;
  const match = mine.data.projects.find((p) => p.slug === slug);
  if (!match || !match.id) return null;
  writeMeta(db, cacheKey, match.id, sink);
  return match.id;
}

// ─── Lock-wrapped push ───────────────────────────────────────────────────────

export type LockState =
  | 'acquired' // we acquired a free lock
  | 'tookover' // an expired lock — we took it over
  | 'held-by-other' // an active lock another editor holds (we pushed anyway, advisory)
  | 'unavailable' // couldn't resolve the platform id / reach the lock API
  | 'skipped'; // not a collab store (no lock attempted)

export interface PushUnderLockResult {
  lockState: LockState;
  lockHolder: { userId: string; email: string; expiresAt: string } | null;
  released: boolean;
  /** The m04 push outcome, or null when the push itself errored. */
  push: PushMutableStatusResult | null;
  warnings: string[];
}

export interface PushUnderLockParams {
  projectRoot?: string;
  slug?: string;
  /** The mutable scope (Sprint 72 m01). Defaults to 'mission_active' (frozen path). */
  fieldScope?: MutableFieldScope;
  /** The entity whose mutable field changed. Defaults to `missionId` for the mission scope. */
  entityId?: string;
  /** Mission-path alias for `entityId` (the Sprint 71 m05 call shape). */
  missionId?: string;
  status: string;
  now?: number;
  client?: DashboardClient;
}

/** Retired before any platform-id lookup, advisory lock or mutable push. */
export async function pushMutableStatusUnderLock(
  _params: PushUnderLockParams
): Promise<RbookToolResult<PushUnderLockResult>> {
  return legacySyncRefusal('Dashboard soft-lock sync');
}

/** Keep the completed local edit and expose retirement on old collab stores, with no remote work. */
export async function maybePropagateMutableStatus<T>(
  result: RbookToolResult<T>,
  _scope: MutableFieldScope,
  _entityId: string,
  _statusReader: (db: RbookDatabaseClient) => string | null,
  projectRoot: string | undefined,
  _options?: { emitOnlyIfChanged?: boolean }
): Promise<RbookToolResult<T>> {
  if (!result.success || !result.data) return result;
  const info = await withClientAsync(
    async (db) => {
      const role = db.getOne<{ value: string | null }>(
        "SELECT value FROM metadata WHERE key = 'collab_role'"
      );
      if (!role.success) return createError<boolean>(role.error!);
      return createSuccess(role.data?.value === 'owner' || role.data?.value === 'editor');
    },
    { projectRoot }
  ).catch((error: unknown) =>
    createError<boolean>({
      code: 'LEGACY_SYNC_STATUS_UNAVAILABLE',
      message: error instanceof Error ? error.message : String(error),
      suggestion: 'Use reasonbook sync to exchange the shared record between copies.',
    })
  );
  if (!info.success) {
    result.warnings = [
      ...(result.warnings ?? []),
      `The local edit is kept, but its old sync status could not be read: ${info.error?.message ?? 'unknown error'}.`,
    ];
  } else if (info.data) {
    const refusal = legacySyncRefusal('Dashboard event sync and soft-lock propagation').error!;
    const warning = `${refusal.code}: ${refusal.message} The local edit is kept. ${refusal.suggestion}`;
    if (!result.warnings?.includes(warning))
      result.warnings = [...(result.warnings ?? []), warning];
  }
  return result;
}

/** Preserve the mission transition hook signature; old collab stores receive a retirement warning. */
export async function maybePropagateMissionStatus<T>(
  result: RbookToolResult<T>,
  missionId: string,
  projectRoot: string | undefined
): Promise<RbookToolResult<T>> {
  return maybePropagateMutableStatus(
    result,
    'mission_active',
    missionId,
    (db) => {
      const row = db.getOne<{ status: string }>('SELECT status FROM missions WHERE id = ?', [
        missionId,
      ]);
      return row.success ? (row.data?.status ?? null) : null;
    },
    projectRoot
  );
}

/** Preserve the sprint hook signature; completed local edits never emit old sync events. */
export async function maybePropagateSprintStatus<T>(
  result: RbookToolResult<T>,
  sprintId: string,
  projectRoot: string | undefined
): Promise<RbookToolResult<T>> {
  return maybePropagateMutableStatus(
    result,
    'sprint_status',
    sprintId,
    (db) => {
      const row = db.getOne<{ status: string | null }>('SELECT status FROM sprints WHERE id = ?', [
        sprintId,
      ]);
      return row.success ? (row.data?.status ?? null) : null;
    },
    projectRoot,
    { emitOnlyIfChanged: true }
  );
}

/** Preserve the name-update hook signature; old collab stores receive the shared-record remedy. */
export async function maybePropagateProjectIdentity<T>(
  result: RbookToolResult<T>,
  projectRoot: string | undefined
): Promise<RbookToolResult<T>> {
  return maybePropagateMutableStatus(
    result,
    'project_identity',
    PROJECT_IDENTITY_ENTITY_ID,
    (db) => getProjectIdentity(db)?.project_name ?? null,
    projectRoot,
    { emitOnlyIfChanged: true }
  );
}
