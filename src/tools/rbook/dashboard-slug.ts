// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m01 — the slug a dashboard request names: metadata.dashboard_slug, derived only when none is stored.
// ABOUTME: A failed read is never taken for an absent slug, and an answer that used a derived one says so.

import type { RbookDatabaseClient } from './client';
import { deriveProjectSlug } from './project-identity';

export interface DashboardSlugRead {
  /** The slug to send; null when none is stored and the name gives none, or the read failed. */
  readonly slug: string | null;
  /** True when no slug is stored and `slug` was derived from the project name. */
  readonly derived: boolean;
  /** Why metadata.dashboard_slug could not be read; `slug` is then null. */
  readonly error?: string;
}

/**
 * The dashboard knows a project by the slug it stored at registration, which registration writes to
 * metadata.dashboard_slug. Deriving it from the display name asked for a slug the dashboard does not
 * hold for five of this Mac's sixteen stores (aquex.ai, System.systems, Derekn.com, kneelinghorse.com
 * and Hive): checked live on 2026-11-04, the dashboard answered 404 to each derived slug and a sync
 * time to each stored one, so their last_sync_at read null.
 *
 * `projectName` is each caller's own fallback source. Only a string derives (#808: a stored numeric
 * name threw in rbook_status).
 */
export function readDashboardSlug(
  client: RbookDatabaseClient,
  projectName: unknown
): DashboardSlugRead {
  const row = client.getOne<{ value: unknown }>(
    "SELECT value FROM metadata WHERE key = 'dashboard_slug'"
  );
  if (!row.success)
    return { slug: null, derived: false, error: row.error?.message ?? 'the read failed' };
  const stored = row.data?.value;
  if (typeof stored === 'string' && stored.trim()) return { slug: stored, derived: false };
  return typeof projectName === 'string' && projectName
    ? { slug: deriveProjectSlug(projectName), derived: true }
    : { slug: null, derived: false };
}

/** What an answer says when the slug it asked for was derived. */
export function derivedSlugWarning(slug: string): string {
  return (
    `This store has no stored dashboard slug (metadata.dashboard_slug), so '${slug}' was derived ` +
    'from the project name. The dashboard knows a project by the slug it stored when the project ' +
    'was registered, which can differ.'
  );
}

/** What an answer says when the stored slug could not be read. */
export function slugReadFailure(error: string): string {
  return `This store's dashboard slug could not be read (metadata.dashboard_slug: ${error}).`;
}
