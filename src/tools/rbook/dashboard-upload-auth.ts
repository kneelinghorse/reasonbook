// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Confirms upload identity against the store owner's account without adopting names.
// ABOUTME: Fresh auth probes distinguish transient outages, revoked keys and replacement records.

import Database from 'better-sqlite3';
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { CredentialStore } from '../../intelligence/credential-store';
import {
  DashboardClient,
  type GetMyProjectsResult,
  type ResolvedDashboardClient,
} from './dashboard-client';
import { RbookErrors } from './errors';
import { compareStoredTimes } from './stored-time';
import type { RbookToolError } from './types';

interface UploadIdentity {
  owner: string | null;
  id: string | null;
  slug: string | null;
  name: string | null;
}

export interface UploadOwnerInspection {
  ownerConfirmed: boolean;
  projectListed: boolean;
  replaced: boolean;
  ownerClient?: DashboardClient;
  error?: RbookToolError;
  skipped?: boolean;
}

export interface UploadAuthCheck {
  recovered: boolean;
  pauseReason?: 'auth' | 'project-key' | 'forbidden' | 'tier' | 'replaced';
  authFirstFailedAt?: number | null;
  retryAfterMs?: number;
  confirmingClient?: DashboardClient;
  ownerConfirmed?: boolean;
  error?: string;
}

function readIdentity(projectRoot: string): UploadIdentity {
  const db = new Database(resolveRecordPaths(projectRoot).dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: 250,
  });
  try {
    const values = new Map(
      (
        db
          .prepare(
            "SELECT key,value FROM metadata WHERE key IN ('owner','dashboard_project_id','dashboard_slug','project_name')"
          )
          .all() as Array<{ key: string; value: string | null }>
      ).map((row) => [row.key, row.value?.trim() || null])
    );
    return {
      owner: values.get('owner') ?? null,
      id: values.get('dashboard_project_id') ?? null,
      slug: values.get('dashboard_slug') ?? null,
      name: values.get('project_name') ?? null,
    };
  } finally {
    db.close();
  }
}

const unconfirmed = (): UploadOwnerInspection => ({
  ownerConfirmed: false,
  projectListed: false,
  replaced: false,
});

function inspectListing(
  identity: UploadIdentity,
  client: DashboardClient,
  listing: GetMyProjectsResult
): UploadOwnerInspection {
  if (!identity.owner || listing.user?.username !== identity.owner)
    return {
      ...unconfirmed(),
      error: {
        code: 'DASHBOARD_OWNER_MISMATCH',
        message: `The dashboard account could not be confirmed as this store's owner (${identity.owner ?? 'unknown'}).`,
        suggestion: 'Sign in to the account that owns this store; no upload was sent.',
      },
    };
  const projectListed = listing.projects.some((project) => project.id === identity.id);
  const replaced =
    !projectListed &&
    listing.projects.some(
      (project) =>
        project.isOwner === true &&
        ((identity.slug !== null && project.slug === identity.slug) ||
          (identity.name !== null && project.name === identity.name))
    );
  return { ownerConfirmed: true, projectListed, replaced, ownerClient: client };
}

/** No-id stores retain the legacy slug path; a failed read must not silently bypass the guard. */
export async function inspectUploadOwner(
  projectRoot: string,
  resolved: ResolvedDashboardClient
): Promise<UploadOwnerInspection> {
  try {
    const identity = readIdentity(projectRoot);
    if (!identity.id) return { ...unconfirmed(), skipped: true };
    const probe = await resolved.client.getMyProjects();
    if (!probe.success || !probe.data)
      return {
        ...unconfirmed(),
        error: probe.error ?? RbookErrors.dashboardError('The owner listing had no data.'),
      };
    return inspectListing(identity, resolved.client, probe.data);
  } catch (error) {
    return {
      ...unconfirmed(),
      error: RbookErrors.dashboardError(
        `Upload owner check failed: ${error instanceof Error ? error.message : String(error)}`
      ),
    };
  }
}

function status(error: RbookToolError | undefined): number | undefined {
  const state = error?.currentState;
  if (state && typeof state === 'object' && typeof state.httpStatus === 'number')
    return state.httpStatus;
  return error?.code === 'DASHBOARD_AUTH_FAILED' ? 401 : undefined;
}

function failed(error: RbookToolError | undefined): UploadAuthCheck {
  const state = error?.currentState;
  return {
    recovered: false,
    error: error?.message,
    ...(state && typeof state === 'object' && typeof state.retryAfterMs === 'number'
      ? { retryAfterMs: state.retryAfterMs }
      : {}),
  };
}

function suspect(
  reason: 'auth' | 'project-key',
  firstFailed: number | null | undefined,
  now: number,
  error?: string
): UploadAuthCheck {
  const since = firstFailed ?? now;
  return {
    recovered: false,
    authFirstFailedAt: since,
    error,
    ...(now - since >= 15 * 60_000 ? { pauseReason: reason } : {}),
  };
}

async function ownerUserClient(
  projectRoot: string,
  identity: UploadIdentity
): Promise<{
  inspection?: UploadOwnerInspection;
  authOnly: boolean;
  error?: RbookToolError;
}> {
  const store = await CredentialStore.create();
  const projectKey = await store.getProjectKey(projectRoot);
  const keys = await store.listUserScopedKeys();
  const ordered = Object.entries(keys).sort(([a, av], [b, bv]) => {
    if (a === projectKey?.parentKeyId) return -1;
    if (b === projectKey?.parentKeyId) return 1;
    return compareStoredTimes(bv.issuedAt, av.issuedAt);
  });
  let authOnly = true;
  let error: RbookToolError | undefined;
  // With no saved user key, the user-only resolver may still find an environment credential.
  for (const candidate of ordered.length ? ordered : [null]) {
    const resolved = candidate
      ? await DashboardClient.fromEnvForUser({
          userScopedKeyId: candidate[0],
          credentialStore: store,
        })
      : await DashboardClient.fromEnvForUser({ credentialStore: store });
    if (!resolved.success || !resolved.data) {
      authOnly = false;
      error = resolved.error;
      continue;
    }
    const probe = await resolved.data.client.getMyProjects();
    if (!probe.success || !probe.data) {
      if (status(probe.error) !== 401) authOnly = false;
      error = probe.error;
      continue;
    }
    const inspection = inspectListing(identity, resolved.data.client, probe.data);
    if (inspection.ownerConfirmed) return { inspection, authOnly: false };
    authOnly = false;
    error = inspection.error;
  }
  return { authOnly, error };
}

/** Caller fences and schedules this probe; no registry or store mutation happens here. */
export async function recheckUploadAuth(
  projectRoot: string,
  options: {
    authFirstFailedAt?: number | null;
    now?: number;
  }
): Promise<UploadAuthCheck> {
  try {
    const identity = readIdentity(projectRoot);
    const now = options.now ?? Date.now();
    const store = await CredentialStore.create();
    store.clearCache();
    const resolved = await DashboardClient.fromEnvForProject(projectRoot);
    if (!resolved.success || !resolved.data) return failed(resolved.error);
    const probe = await resolved.data.client.getMyProjects();
    if (probe.success && probe.data) {
      if (!identity.id && !identity.owner)
        return { recovered: true, authFirstFailedAt: null, ownerConfirmed: false };
      const inspection = inspectListing(identity, resolved.data.client, probe.data);
      if (inspection.error) return failed(inspection.error);
      if (identity.id && inspection.replaced)
        return { recovered: false, pauseReason: 'replaced', ownerConfirmed: true };
      return { recovered: true, authFirstFailedAt: null, ownerConfirmed: true };
    }
    const httpStatus = status(probe.error);
    const failure = failed(probe.error);
    if (httpStatus === 403 && probe.error?.code === 'DASHBOARD_FORBIDDEN')
      return { ...failure, pauseReason: 'forbidden' };
    if (httpStatus === 402) return { ...failure, pauseReason: 'tier' };
    if (httpStatus !== 401) return failure;
    if (resolved.data.keySource !== 'project-scoped')
      return {
        ...failure,
        ...suspect('auth', options.authFirstFailedAt, now, probe.error?.message),
      };
    const owner = await ownerUserClient(projectRoot, identity);
    if (owner.inspection) {
      if (!identity.id)
        return {
          ...failure,
          error: 'The store has no dashboard project id to confirm its project key.',
        };
      if (identity.id && owner.inspection.replaced)
        return { ...failure, pauseReason: 'replaced', ownerConfirmed: true };
      if (identity.id && !owner.inspection.projectListed)
        return { ...failure, confirmingClient: owner.inspection.ownerClient, ownerConfirmed: true };
      return {
        ...failure,
        ...suspect('project-key', options.authFirstFailedAt, now, probe.error?.message),
      };
    }
    if (owner.authOnly)
      return {
        ...failure,
        ...suspect('auth', options.authFirstFailedAt, now, probe.error?.message),
      };
    return failed(owner.error);
  } catch (error) {
    return {
      recovered: false,
      error: `Upload authentication check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
