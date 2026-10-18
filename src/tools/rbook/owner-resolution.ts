// ABOUTME: Resolves and persists the project owner (username) to metadata.owner by
// consulting the authenticated dashboard identity. Lets sync project-identity seeding
// produce canonical rbook://<owner>/<slug> addresses instead of rbook://unknown/*.

import { LEGACY, normalizeAddressScheme, storedAddress } from '../../intelligence/legacy-compat';
import type { RbookDatabaseClient } from './client';
import { DashboardClient } from './dashboard-client';
import { isMembersCopy } from './record-membership';
import { checkWrite, type WriteSink } from './write-guard';

export interface OwnerResolutionResult {
  owner: string | null;
  source: 'metadata' | 'dashboard' | 'unresolved';
  /**
   * s81-m02 — true only when the incumbent dashboard project was POSITIVELY confirmed
   * against a live dashboard row THIS cycle (a trusted id/slug/address match, not a
   * self-referential dashboard_slug-hint reaffirmation). The push path relaxes its
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
}

interface DashboardProjectLike {
  id?: string | null;
  owner?: string | null;
  address?: string | null;
  [LEGACY.wireAddressKey]?: string | null;
  slug?: string | null;
  name?: string | null;
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

function normalizeSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase().replace(/\s+/g, '-') : null;
}

/**
 * The result of matching the local store against the owner's dashboard projects.
 * `confirmed` distinguishes a POSITIVE identity match (by dashboard_project_id with a
 * passing slug cross-check, by a LOCAL stable-identity slug — project_id/project_name —
 * or by rbook_address) from a WEAK adoption (matched only by reaffirming the local
 * dashboard_slug hint, or the single-project fallback). Only a confirmed match may relax
 * the push's expectedSlug guard (s81-m02 adversarial-review fix): a wrong dashboard_slug
 * can reaffirm itself via the weak tier, so trusting it there would mis-route a push.
 */
interface ProjectMatch {
  project: DashboardProjectLike | undefined;
  confirmed: boolean;
}

function selectMatchingProject(
  projects: DashboardProjectLike[],
  hints: {
    dashboardProjectId: string | null;
    rbookAddress: string | null;
    projectId: string | null;
    projectName: string | null;
    dashboardSlug: string | null;
  }
): ProjectMatch {
  const trustedSlugs = new Set(
    [hints.projectId, hints.projectName]
      .map((value) => normalizeSlug(value))
      .filter((value): value is string => value !== null)
  );
  const expectedSlugs = new Set(
    [hints.dashboardSlug, hints.projectId, hints.projectName]
      .map((value) => normalizeSlug(value))
      .filter((value): value is string => value !== null)
  );

  if (hints.dashboardProjectId) {
    const byId = projects.find((project) => project.id === hints.dashboardProjectId);
    if (byId) {
      const matchedSlug = normalizeSlug(byId.slug ?? byId.name ?? null);
      const slugSetToTrust = trustedSlugs.size > 0 ? trustedSlugs : expectedSlugs;
      if (slugSetToTrust.size === 0 || (matchedSlug !== null && slugSetToTrust.has(matchedSlug))) {
        return { project: byId, confirmed: true };
      }
    }
  }

  if (expectedSlugs.size > 0) {
    // Trusted tier: match by a LOCAL stable-identity slug (project_id / project_name).
    // These are the store's own identity, not dashboard-echoed state — a positive match.
    if (trustedSlugs.size > 0) {
      const byTrusted = projects.find((project) => {
        const projectSlug = normalizeSlug(project.slug ?? project.name ?? null);
        return projectSlug !== null && trustedSlugs.has(projectSlug);
      });
      if (byTrusted) return { project: byTrusted, confirmed: true };
    }
    // Weak tier: the only slug in expectedSlugs NOT already tried above is the local
    // dashboard_slug hint, so a match here is self-referential — a wrong dashboard_slug
    // reaffirms itself. Adopt the row (so a legit divergent-name copy still resolves an
    // owner) but mark it UNCONFIRMED so the push guard is NOT relaxed on its say-so.
    const byExpected = projects.find((project) => {
      const projectSlug = normalizeSlug(project.slug ?? project.name ?? null);
      return projectSlug !== null && expectedSlugs.has(projectSlug);
    });
    if (byExpected) return { project: byExpected, confirmed: false };
  }

  if (hints.rbookAddress) {
    const byAddress = projects.find(
      (project) =>
        normalizeAddressScheme(project[LEGACY.wireAddressKey] ?? project.address ?? '') ===
        normalizeAddressScheme(hints.rbookAddress!)
    );
    if (byAddress) return { project: byAddress, confirmed: true };
  }

  // s81-m02: only fall back to projects[0] when the account holds exactly ONE project
  // (unambiguous — a fresh store adopting the account's sole project). In a MULTI-project
  // account with no confident id/slug/address match, return undefined rather than
  // mis-adopting an arbitrary first project's slug/id — resolveAndPersistOwner persists
  // the matched slug/id back to local metadata (below), so a wrong pick corrupts the
  // push key and mints a dup container on the next checkpoint. Undefined = "no confident
  // incumbent" → the caller leaves the local key untouched. The single-project fallback is
  // unambiguous but is NOT a positive identity confirmation, so it stays `confirmed: false`.
  return { project: projects.length === 1 ? projects[0] : undefined, confirmed: false };
}

function readMetadata(client: RbookDatabaseClient, key: string): string | null {
  const r = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  if (!r.success || !r.data) return null;
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
 * Never throws — dashboard reachability is best-effort. Callers should still tolerate
 * a null owner (the identity row will be seeded with an empty rbook_address until a
 * later checkpoint can fill it in).
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
  const localDashboardSlug = readMetadata(client, 'dashboard_slug');
  const localProjectKey = readMetadata(client, 'project_id');
  const localProjectName = readMetadata(client, 'project_name');

  if (existing && !needsProjectIdentityRepair && !localProjectId) {
    return { owner: existing, source: 'metadata', incumbentConfirmed: false };
  }

  let dashClient: DashboardClient | null = dashClientOverride ?? null;
  if (!dashClient) {
    const envResult = DashboardClient.fromEnv();
    if (!envResult.success || !envResult.data) {
      return existing
        ? { owner: existing, source: 'metadata', incumbentConfirmed: false }
        : { owner: null, source: 'unresolved', incumbentConfirmed: false };
    }
    dashClient = envResult.data;
  }

  // Trigger authentication. getMyProjects() is a cheap authenticated GET; its side
  // effect is populating dashClient.userIdentity with the username we need.
  const probe = await dashClient.getMyProjects();
  if (!probe.success) {
    return existing
      ? { owner: existing, source: 'metadata', incumbentConfirmed: false }
      : { owner: null, source: 'unresolved', incumbentConfirmed: false };
  }
  // s96-m02: this is a write path (a checkpoint, a message send), so the sign-in's identity is kept
  // here for author names; reads never keep it.
  if (probe.data?.user) dashClient.rememberIdentity(probe.data.user);

  const identity = dashClient.userIdentity;
  let username = identity?.username ?? null;
  const projects = (probe.data?.projects ?? []) as DashboardProjectLike[];
  const match = selectMatchingProject(projects, {
    dashboardProjectId: localProjectId,
    rbookAddress: currentAddress,
    projectId: localProjectKey,
    projectName: localProjectName,
    dashboardSlug: localDashboardSlug,
  });
  const matchedProject = match.project;

  // s86-m02b — every metadata write below is reported as done by the returned result;
  // a failed one is carried out on `warnings` rather than assumed to have landed.
  const warnings: string[] = [];

  if (matchedProject?.slug && matchedProject.slug.trim().length > 0) {
    writeMetadata(client, 'dashboard_slug', matchedProject.slug.trim(), warnings);
  }
  if (matchedProject?.id && matchedProject.id.trim().length > 0) {
    writeMetadata(client, 'dashboard_project_id', matchedProject.id.trim(), warnings);
  }

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

  const surfaced = (): string[] | undefined => (warnings.length > 0 ? warnings : undefined);

  if (!username || username.trim().length === 0) {
    return existing
      ? {
          owner: existing,
          source: 'metadata',
          incumbentConfirmed: match.confirmed,
          warnings: surfaced(),
        }
      : {
          owner: null,
          source: 'unresolved',
          incumbentConfirmed: match.confirmed,
          warnings: surfaced(),
        };
  }

  const trimmed = username.trim();
  writeMetadata(client, 'owner', trimmed, warnings);
  writeMetadata(client, 'dashboard_username', trimmed, warnings);
  return {
    owner: trimmed,
    source: 'dashboard',
    incumbentConfirmed: match.confirmed,
    warnings: surfaced(),
  };
}
