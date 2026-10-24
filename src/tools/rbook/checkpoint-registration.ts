// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reconciles checkpoint ownership and registers a project only for an explicit close.
// ABOUTME: Registration uploads a consistent snapshot while preserving the original local store path.

import { withClientAsync } from './client';
import { DashboardClient } from './dashboard-client';
import { createSuccess, RbookErrors } from './errors';
import type { RbookToolError } from './types';
import { resolveAndPersistOwner } from './owner-resolution';
import { isMembersCopy } from './record-membership';
import { backfillUnknownRbookAddress } from './project-identity';
import { checkWrite } from './write-guard';
import { captureRegisterResponse } from '../../auth/project-key-capture';
import type { KeySource } from '../../intelligence/credential-store';
import { withUploadSnapshot, uploadLog as log } from './dashboard-upload';

interface CheckResult {
  error?: RbookToolError;
  ownerConfirmed?: boolean;
  sqlitePath: string;
  projectSlug: string | null;
  expectedSlug: string | null;
  /** s81-m03 — the store's stable metadata.project_id (registry key for last_synced_at). */
  projectId: string | null;
  /**
   * s86-m02b — DB errors from the registration-state writes below. This path has no Reasonbook
   * answer to attach to (it is the fire-and-forget checkpoint), so its reporting channel is
   * this module's `log` to fd 2 — the same channel that already carries "Registration
   * failed" and "File sync failed". Without it, a failed `dashboard_registered` write is
   * followed by an "Auto-registered project ..." line asserting a row that was never stored.
   */
  warnings: string[];
}

function deriveProjectSlug(projectName: string): string {
  return projectName.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Check if the project is registered with the dashboard.
 * If not, register it by uploading the SQLite database.
 * Returns the SQLite path and project slug (null if unavailable).
 * Non-fatal — errors are logged and swallowed.
 */
export async function checkAndRegister(
  projectRoot: string | undefined,
  dashClient: DashboardClient,
  // s86-m06 — which resolution arm supplied `dashClient`. Threaded in because the
  // honest capture-failure log depends on it: `captureRegisterResponse` receives a
  // bare parentKeyId and structurally cannot know WHY it is absent, but its caller
  // can. Deriving the reason here rather than guessing there is the whole point.
  keySource: KeySource,
  allowRegister = true
): Promise<CheckResult | null> {
  let captured: CheckResult | null = null;
  // s86-m02b — declared out here so pushes made after `captured` is built still reach the
  // caller: the same array instance is handed to the CheckResult below.
  const warnings: string[] = [];

  try {
    await withClientAsync(
      async (client) => {
        // s96-m13 (design §s96-m13 item 3): a member's copy of a shared record never registers or
        // names the dashboard project; the owner's copy does. Nothing is captured, so nothing uploads.
        if (isMembersCopy(client)) return createSuccess(undefined);
        captured = {
          sqlitePath: client.path,
          projectSlug: null,
          expectedSlug: null,
          projectId: null,
          warnings,
        };

        const nameResult = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'project_name'`
        );
        const projectName = (nameResult.success && nameResult.data?.value) || '';
        captured.expectedSlug = projectName ? deriveProjectSlug(projectName) : null;

        // s81-m03: capture the stable project_id — the project-graph registry key for
        // recording the converged-push time (last_synced_at) after a successful sync.
        const pidResult = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'project_id'`
        );
        captured.projectId = (pidResult.success && pidResult.data?.value) || null;

        if (!allowRegister) {
          const registration = client.getOne<{ value: string }>(
            "SELECT value FROM metadata WHERE key = 'dashboard_registered'"
          );
          if (!registration.success)
            throw new Error(
              registration.error?.message ?? 'Could not read dashboard registration.'
            );
          if (registration.data?.value !== 'true') return createSuccess(undefined);
        }

        // Sprint 52 m01: seed metadata.owner from dashboard identity and rewrite any
        // legacy `rbook://unknown/*` address. Runs on every checkpoint so downstream
        // dashboard relays see the canonical address for sender attribution.
        // s81-m02: capture whether the reconcile POSITIVELY confirmed the incumbent this
        // cycle — only then may the expectedSlug guard be relaxed (below).
        // s86-m02b: the reconcile's own `metadata.owner` / `dashboard_slug` /
        // `dashboard_project_id` writes report through the same sink as the registration
        // writes below. A failed owner write leaves the store minting `rbook://unknown/*`
        // addresses while the push proceeds under a slug this cycle believed it persisted.
        let incumbentConfirmed = false;
        try {
          const ownerResult = await resolveAndPersistOwner(client, dashClient);
          incumbentConfirmed = ownerResult.incumbentConfirmed;
          captured.ownerConfirmed = ownerResult.ownerConfirmed;
          warnings.push(...(ownerResult.warnings ?? []));
          if (ownerResult.error) {
            captured.error = ownerResult.error;
            return createSuccess(undefined);
          }
          backfillUnknownRbookAddress(client);
        } catch (error) {
          captured.error = RbookErrors.dashboardError(
            `Owner reconciliation failed: ${error instanceof Error ? error.message : String(error)}`
          );
          return createSuccess(undefined);
        }

        // Check if already registered
        const regResult = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'dashboard_registered'`
        );
        if (regResult.success && regResult.data?.value === 'true') {
          // Already registered — read slug from metadata
          const slugResult = client.getOne<{ value: string }>(
            `SELECT value FROM metadata WHERE key = 'dashboard_slug'`
          );
          captured.projectSlug = (slugResult.success && slugResult.data?.value) || null;
          // s81-m02 defect-2 (adversarial-review-hardened): on the SYNC path, relax the
          // expectedSlug guard to the RECONCILED incumbent dashboard_slug ONLY when the
          // reconcile CONFIRMED that incumbent against a live dashboard row this cycle
          // (trusted id/slug/address match — not a self-referential dashboard_slug-hint
          // reaffirmation, not a getMyProjects failure). A confirmed incumbent lets a
          // same-owner byte-copy under a divergent name sync (the T4 goal). When NOT
          // confirmed we KEEP the stricter derive(project_name) guard (set at line 90) so
          // a stale/wrong dashboard_slug is refused with EXPECTED_SLUG_MISMATCH rather than
          // mis-routing the push into a sibling project's row. cmos-mcp-pro confirms via
          // byId every cycle, so its behavior is unchanged.
          if (incumbentConfirmed) {
            captured.expectedSlug = captured.projectSlug;
          }
          return createSuccess(undefined);
        }

        if (!projectName || !allowRegister) {
          return createSuccess(undefined); // Can't register without a name
        }

        const sqlitePath = client.path;
        const expectedSlug = captured.expectedSlug ?? undefined;
        const result = await withUploadSnapshot(sqlitePath, (snapshot) =>
          dashClient.registerProject({
            projectName,
            sqlitePath: snapshot,
            localDbPath: sqlitePath,
            expectedSlug,
          })
        );

        if (result.success && result.data) {
          // Store registration state in metadata
          checkWrite(
            client.execute(
              `INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_registered', 'true')`
            ),
            warnings,
            'metadata.dashboard_registered'
          );
          checkWrite(
            client.execute(
              `INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_slug', ?)`,
              [result.data.slug]
            ),
            warnings,
            'metadata.dashboard_slug'
          );
          checkWrite(
            client.execute(
              `INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`,
              [result.data.projectId]
            ),
            warnings,
            'metadata.dashboard_project_id'
          );
          log(
            `Auto-registered project "${projectName}" as "${result.data.slug}"` +
              (result.data.reregistered ? ' (re-registration)' : '')
          );
          captured.projectSlug = result.data.slug;
          // A fresh create-only response may allocate a suffix when a different name has the
          // same normalized slug. Its returned id/slug, not the original name, owns this upload.
          captured.expectedSlug = result.data.slug;

          // Sprint 57 m02: capture the auto-issued project-scoped key into the
          // local credential store so subsequent sends bear it via
          // fromEnvForProject() without relying on the user-scoped fallback.
          if (projectRoot) {
            try {
              const captureStatus = await captureRegisterResponse({
                projectRoot,
                response: result.data,
                parentKeyId: dashClient.authenticatingKeyId,
              });
              if (captureStatus === 'captured') {
                log(
                  `Captured project-scoped key for "${result.data.slug}" (keyId=${result.data.keyId})`
                );
              } else if (captureStatus === 'missing-parent-key-id') {
                // s86-m06 — the old line asserted "/reissue on next startup will
                // recover", which is false in exactly the state that emits it:
                // startup recovery returns `skipped-already-present` whenever a
                // local row exists, and where no row exists the reason for the
                // missing attribution is unchanged by a restart. Derived from
                // keySource so each arm gets the recovery that applies to it.
                log(
                  `Skipping project-key capture: the dashboard minted a project key but this client (keySource=${keySource}) carries no user-scoped parent to attribute it to, so it is left orphaned locally. ${
                    keySource === 'project-scoped'
                      ? 'A local project-key row already exists for this root, so startup recovery will skip it — run rbook_auth(action="reissue", projectRoot=…) to replace the row.'
                      : 'Startup recovery will hit the same wall — run rbook_auth(action="login_init") + login_complete so a device-code user key is available, then rbook_auth(action="reissue", projectRoot=…).'
                  }`
                );
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              log(`Project-key capture failed: ${msg}`);
            }
          }
        } else if (!result.success) {
          captured.error = result.error;
          log(`Registration failed: ${result.error?.message ?? 'unknown'}`);
        }

        return createSuccess(undefined);
      },
      { projectRoot }
    );
  } catch (error) {
    const message = `Registration check failed: ${error instanceof Error ? error.message : String(error)}`;
    log(message);
    return {
      error: RbookErrors.dashboardError(message),
      sqlitePath: '',
      projectSlug: null,
      expectedSlug: null,
      projectId: null,
      warnings,
    };
  }

  return captured;
}
