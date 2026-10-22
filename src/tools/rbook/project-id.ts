// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Canonical read-only project identity resolution with bounded per-call disclosure.
// ABOUTME: Kept dependency-light so hooks share the same fallback policy without write machinery.

import type { RbookDatabaseClient } from './client';
import { recordProjectIdentityDisclosure } from './tool-call-context';

/**
 * s87-m04 — PER STORE, not per process.
 *
 * This was a single module-level boolean, so N identity-less stores opened in one process
 * produced ONE stderr line — and that line named no path, only the fallback VALUE. An operator
 * reading it could not tell which store had no identity, or how many did. The #1038 immutable
 * remeasurement found that 13 of the 45 Reasonbook stores on this machine resolve to the literal.
 *
 * Keyed by the store's own path so each one discloses exactly once. Still de-duplicated, because
 * the alternative is a line per genesis row.
 */
const warnedStorePaths = new Set<string>();

/** Bound and encode untrusted store metadata before it crosses into an MCP answer or stderr. */
function encodeDisclosureValue(value: string): string {
  const maxLength = 320;
  const bounded =
    value.length > maxLength
      ? `${value.slice(0, maxLength)}… [truncated; original length=${value.length}]`
      : value;
  return JSON.stringify(bounded)
    .replace(/`/g, '\\u0060')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Read the store's `project_id` from `metadata`. Explicit pass-through with no
 * process-level caching (matches the no-silent-state discipline that gives
 * `event_type` no DEFAULT).
 *
 * When `project_id` is missing or empty it falls back to the next-best store identifier
 * (`dashboard_slug` → `project_name` → `'unknown-project'`) rather than throwing. It emits stderr
 * once per store and attaches one request-de-duplicated disclosure to every affected MCP answer.
 *
 * WHY IT FALLS BACK RATHER THAN THROWING — ruling #736, REAFFIRMED by decision #1017 (D-8). A
 * hard throw breaks any read path that lazily writes a genesis row (blob-migration snapshots) on
 * a store with no identity, and `getProjectId` serves 36 call sites across 26 files, 16 of them
 * read/display. It would also do nothing for rows already stamped with the fallback.
 *
 * WHY THE OLD RATIONALE IS GONE. It asserted that every real store records an identity at
 * init/register, so the fallback could not fire outside test fixtures — and that premise was the
 * entire basis on which the fallback was approved over throwing. It is MEASURABLY FALSE. (The
 * original sentence is quoted verbatim in decision #1017, where a quotation belongs; it is
 * paraphrased here because a shipped-prose gate sweeps this tree for it.) Measured
 * 2026-08-28, using immutable SQLite inspection, with its command —
 *   find ~ -maxdepth 7 -path '*\/rbook/db/rbook.sqlite' -not -path '*\/node_modules/*'
 * → 45 stores; 32 resolve via a non-empty `project_id`; 13 collapse to the literal; 0 are
 * unclassifiable. The fallback has already fired in
 * production: one measured store carries 217 rows stamped `unknown-project` across six tables.
 *
 * The RULING stands and is reaffirmed; only its PREMISE is amended (#1017). Sprint 87 changed the
 * fallback LABEL, added stderr once per store, and corrected the SEED that manufactures new
 * instances. Sprint 88 m08 adds the encoded, bounded warning on every affected MCP answer and
 * splits read resolution from write registration. Neither disclosure itself identifies a store;
 * only the explicit/write registration path may persist the identity.
 */
export function getProjectId(client: Pick<RbookDatabaseClient, 'getOne' | 'path'>): string {
  const read = (key: string): string => {
    const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
    return row.success && row.data ? (row.data.value ?? '') : '';
  };
  const projectId = read('project_id');
  if (projectId) return projectId;

  const fallback = read('dashboard_slug') || read('project_name') || 'unknown-project';
  const storePath = client.path;
  const disclosure =
    `[WARN] reasonbook: store=${encodeDisclosureValue(storePath)} has NO RECORDED project identity ` +
    `(metadata.project_id is missing/empty). This operation resolved identity as ` +
    `project_id=${encodeDisclosureValue(fallback)}, which is a fallback label and not a project identity. ` +
    `Any provenance row written before registration will use the fallback. Register or initialize ` +
    `the project before provenance writes.`;

  // Agent-visible and PER CALL. The surrounding request context de-duplicates repeated rows in
  // one answer, but a prior stderr warning must never make a later agent answer silent.
  recordProjectIdentityDisclosure(disclosure);

  if (!warnedStorePaths.has(storePath)) {
    warnedStorePaths.add(storePath);
    // Names the STORE and says the id is UNRECORDED. The old wording said only that a fallback
    // value was being stamped, which reads as though `unknown-project` were a project.
    process.stderr.write(`${disclosure}\n`);
  }
  return fallback;
}
