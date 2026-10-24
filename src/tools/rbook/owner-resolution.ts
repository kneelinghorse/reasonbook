// ABOUTME: Resolves the authenticated owner and reconciles only the store's registered dashboard id.
// ABOUTME: Renames keep that identity; another account or a reused name never replaces it.

import path from 'path';
import { LEGACY, normalizeAddressScheme, storedAddress } from '../../intelligence/legacy-compat';
import type { RbookDatabaseClient } from './client';
import { DashboardClient } from './dashboard-client';
import { RbookErrors } from './errors';
import type { RbookToolError } from './types';
import { isMembersCopy } from './record-membership';
import { checkWrite, type WriteSink } from './write-guard';

export interface OwnerResolutionResult {
  owner: string | null;
  source: 'metadata' | 'dashboard' | 'unresolved';
  /**
   * s81-m02 — true only when the incumbent dashboard project was POSITIVELY confirmed
   * against a live dashboard row THIS cycle by the stored dashboard_project_id. The push path relaxes its
   * expectedSlug guard only when this is true; otherwise it keeps the stricter
   * derive(project_name) check so a stale/wrong dashboard_slug is refused, not mis-routed.
   * Every early return (reconcile skipped / dashboard unreachable) reports false.
   */
  incumbentConfirmed: boolean;
  /**
   * s86-m02b — metadata writes that ERRORED during this resolution. The result still
   * reports the owner/slug it resolved, so without this a failed `metadata.owner` write
   * reads as a persisted owner while the store keeps minting `rbook://unknown/*`
   * addresses. Callers with a warnings channel should splice this into it.
   */
  warnings?: string[];
  /** Safety evidence from this listing, for the upload caller; messaging may retain its local identity. */
  ownerConfirmed?: boolean;
  error?: RbookToolError;
}

interface DashboardProjectLike {
  id?: string | null;
  owner?: string | null;
  address?: string | null;
  [LEGACY.wireAddressKey]?: string | null;
  slug?: string | null;
  name?: string | null;
  isOwner?: boolean;
}

function parseOwnerFromAddress(address: string | null | undefined): string | null {
  address = address ? normalizeAddressScheme(address) : address;
  if (!address || !address.startsWith('rbook://')) {
    return null;
  }

  const body = address.slice('rbook://'.length);
  const [owner] = body.split('/');
  return owner && owner.trim().length > 0 ? owner.trim() : null;
}

function readMetadata(client: RbookDatabaseClient, key: string): string | null {
  const r = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  if (!r.success) throw new Error(r.error?.message ?? `Could not read metadata.${key}.`);
  if (!r.data) return null;
  const v = r.data.value;
  return v && v.trim().length > 0 ? v.trim() : null;
}

function readProjectIdentityAddress(client: RbookDatabaseClient): string | null {
  const result = client.getOne<{ content: string }>(
    "SELECT content FROM contexts WHERE id = 'project_identity'",
    []
  );
  if (!result.success || !result.data?.content) {
    return null;
  }

  try {
    const address = storedAddress(JSON.parse(result.data.content) as Record<string, unknown>);
    return typeof address === 'string' ? normalizeAddressScheme(address.trim()) : null;
  } catch {
    return null;
  }
}

function writeMetadata(
  client: RbookDatabaseClient,
  key: string,
  value: string,
  sink: WriteSink
): void {
  checkWrite(
    client.execute(
      `INSERT INTO metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE metadata.value IS NOT excluded.value`,
      [key, value]
    ),
    sink,
    `metadata.${key}`
  );
}

/**
 * Resolve the project owner and persist it to `metadata.owner` when absent.
 *
 * Order:
 *   1. metadata.owner → done.
 *   2. Dashboard identity (login via env or provided client) → write metadata.owner +
 *      metadata.dashboard_username → done.
 *   3. Otherwise return { owner: null, source: 'unresolved' }.
 *
 * Dashboard errors retain the local identity and carry safety evidence for uploads.
 * A failed metadata read throws instead of silently treating a registered store as new.
 */
export async function resolveAndPersistOwner(
  client: RbookDatabaseClient,
  dashClientOverride?: DashboardClient
): Promise<OwnerResolutionResult> {
  const existing = readMetadata(client, 'owner');
  // s96-m13 (design §s96-m13 item 3): a member's copy of a shared record keeps the owner and the
  // dashboard project its owner's copy named; it never overwrites them with whoever is signed in.
  if (isMembersCopy(client))
    return { owner: existing, source: 'metadata', incumbentConfirmed: false };
  const currentAddress = readProjectIdentityAddress(client);
  const needsProjectIdentityRepair =
    currentAddress !== null &&
    (currentAddress.length === 0 || currentAddress.startsWith('rbook://unknown/'));
  const localProjectId = readMetadata(client, 'dashboard_project_id');
  const unavailable = (error: RbookToolError): OwnerResolutionResult => ({
    owner: existing,
    source: existing ? 'metadata' : 'unresolved',
    incumbentConfirmed: false,
    ownerConfirmed: false,
    ...(localProjectId ? { error } : {}),
  });

  if (existing && !needsProjectIdentityRepair && !localProjectId) {
    return { owner: existing, source: 'metadata', incumbentConfirmed: false };
  }

  let dashClient: DashboardClient | null = dashClientOverride ?? null;
  if (!dashClient) {
    const envResult = await DashboardClient.fromEnvForProject(
      path.dirname(path.dirname(path.dirname(client.path)))
    );
    if (!envResult.success || !envResult.data) {
      return unavailable(envResult.error ?? RbookErrors.dashboardNotConfigured());
    }
    dashClient = envResult.data.client;
  }

  // This listing is the latest account and project evidence before an upload.
  const probe = await dashClient.getMyProjects();
  if (!probe.success || !probe.data)
    return unavailable(probe.error ?? RbookErrors.dashboardError('The owner listing had no data.'));
  const ownerConfirmed = Boolean(existing && probe.data.user?.username === existing);
  if (localProjectId && existing && !ownerConfirmed)
    return unavailable({
      code: 'DASHBOARD_OWNER_MISMATCH',
      message: `The latest dashboard listing could not confirm this store's owner (${existing}).`,
      suggestion: 'Sign in to the account that owns this store; no upload was sent.',
    });
  // s96-m02: this is a write path (a checkpoint, a message send), so the sign-in's identity is kept
  // here for author names; reads never keep it.
  if (probe.data?.user) dashClient.rememberIdentity(probe.data.user);

  const identity = dashClient.userIdentity;
  let username = probe.data?.user?.username ?? identity?.username ?? null;
  const projects = (probe.data?.projects ?? []) as DashboardProjectLike[];
  // A dashboard id survives rename. Names, addresses and slugs can be reused by another store.
  const matchedProject = localProjectId
    ? projects.find((project) => project.id === localProjectId)
    : undefined;
  const confirmed = matchedProject !== undefined;
  if (localProjectId && ownerConfirmed && !confirmed) {
    const slug = readMetadata(client, 'dashboard_slug');
    const name = readMetadata(client, 'project_name');
    if (
      projects.some(
        (project) =>
          project.isOwner === true &&
          ((slug !== null && project.slug === slug) || (name !== null && project.name === name))
      )
    )
      return {
        owner: existing,
        source: 'metadata',
        incumbentConfirmed: false,
        ownerConfirmed: true,
        error: {
          code: 'PROJECT_REPLACED',
          message: 'This project was replaced on reasonbook.ai. Nothing was uploaded.',
          suggestion:
            'Uploads for this project are stopped. Creating it again is not available in this version; a new registration needs your consent.',
        },
      };
  }

  // s86-m02b — every metadata write below is reported as done by the returned result;
  // a failed one is carried out on `warnings` rather than assumed to have landed.
  const warnings: string[] = [];

  // API-key auth skips the login that populates cachedIdentity. Fall back to the
  // matching project row returned by /api/projects/me.
  if (!username && matchedProject) {
    if (matchedProject.owner) {
      username = matchedProject.owner;
    } else {
      username = parseOwnerFromAddress(
        matchedProject[LEGACY.wireAddressKey] ?? matchedProject.address
      );
    }
  }

  if (existing && username && username.trim() !== existing)
    return unavailable({
      code: 'DASHBOARD_OWNER_MISMATCH',
      message: `The dashboard account differs from this store's owner (${existing}).`,
      suggestion: 'Sign in to the account that owns this store; no upload was sent.',
    });

  if (matchedProject?.slug && matchedProject.slug.trim().length > 0) {
    const destination = matchedProject.slug.trim();
    writeMetadata(client, 'dashboard_slug', destination, warnings);
    // A failed or ignored rename must not leave the upload using a sibling's old slug.
    if (readMetadata(client, 'dashboard_slug') !== destination)
      return {
        owner: existing,
        source: existing ? 'metadata' : 'unresolved',
        incumbentConfirmed: false,
        ownerConfirmed,
        warnings: warnings.length > 0 ? warnings : undefined,
        error: {
          code: 'DASHBOARD_DESTINATION_NOT_SAVED',
          message: `The dashboard destination '${destination}' could not be saved in this store. Nothing was uploaded.`,
          suggestion:
            "Check this store's write errors and retry after its dashboard destination can be saved.",
        },
      };
  }
  if (matchedProject?.id && matchedProject.id.trim().length > 0) {
    writeMetadata(client, 'dashboard_project_id', matchedProject.id.trim(), warnings);
  }

  const surfaced = (): string[] | undefined => (warnings.length > 0 ? warnings : undefined);

  if (!username || username.trim().length === 0) {
    return existing
      ? {
          owner: existing,
          source: 'metadata',
          incumbentConfirmed: confirmed,
          ownerConfirmed,
          warnings: surfaced(),
        }
      : {
          owner: null,
          source: 'unresolved',
          incumbentConfirmed: confirmed,
          ownerConfirmed,
          warnings: surfaced(),
        };
  }

  const trimmed = username.trim();
  writeMetadata(client, 'owner', trimmed, warnings);
  writeMetadata(client, 'dashboard_username', trimmed, warnings);
  return {
    owner: trimmed,
    source: 'dashboard',
    incumbentConfirmed: confirmed,
    ownerConfirmed,
    warnings: surfaced(),
  };
}
