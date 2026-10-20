// ABOUTME: rbook_status tool — at-a-glance status payload for support and ops surfaces.
// ABOUTME: Sprint 62 m06; 5 required fields per dashboard-team shape sketch (msg 416315a7), cross-side parity with onboard.authState.authTier.

/**
 * rbook_status Tool
 *
 * Returns a structured status payload that mirrors what an operator or support
 * agent would want to see at a glance: which rbook:// address this project
 * advertises, which dashboard URL it's pointed at, the auth tier (mirroring
 * onboard.authState.authTier exactly so support can read both sides the same
 * way), and last-sync / last-delivery timestamps.
 *
 * Field contract is FROZEN per dashboard team msg 416315a7. Any shape change
 * to the 5 required fields requires coordination with rbook://derek/cmos-dashboard
 * before shipping (see rbook_decisions #642).
 *
 * @module tools/rbook/rbook-status
 */

import { z } from 'zod';
import * as path from 'path';
import { withClientAsync, type RbookDatabaseClient } from './client';
import { isMembersCopy } from './record-membership';
import { peerHealth, syncsWith } from './record-peers';
import { isRecordedStore } from './record-recording';
import { mergeContext } from './record-standing';
import { COPY_KEYS, readCopyKey } from './replica-copy-keys';
import type { RbookToolResult } from './types';
import { createError, createSuccess } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import { getProjectIdentity, deriveProjectSlug } from './project-identity';
import { DashboardClient, resolveDashboardBaseUrl } from './dashboard-client';
import { computeAuthState } from '../../auth/auth-state';
import type { AuthTier } from '../../auth/auth-state';
import { appendWarnings } from './format-warnings';
import { readDashboardUploadStatus } from './dashboard-upload-scheduler';

/**
 * Public status payload. The five top-level fields are FROZEN — adding,
 * removing, or renaming any of them is a cross-side parity break and must
 * coordinate with the dashboard team before shipping.
 */
export interface RbookStatusResult {
  /** Project's rbook:// identity, or "local-only" when not dashboard-connected. */
  rbook_address: string;
  /** Runtime RBOOK_DASHBOARD_URL value (always defined post-Sprint 62 m02 bake). */
  dashboard_url: string;
  /** Mirrors onboard.authState.authTier exactly: device-code | legacy-env | password-fallback | none. */
  auth_tier: AuthTier;
  /** ISO timestamp of last successful /api/sync/* round-trip; null if never. */
  last_sync_at: string | null;
  /** ISO timestamp of last successful message delivery; null if never. */
  last_delivery_observed_at: string | null;
  /**
   * s96-m13 (design §s96-m13 item 5): on a copy of a shared record only, each copy it syncs with:
   * the last successful exchange, the changes it lacks, and the last error.
   */
  shared_sync?: Array<{
    peer: string;
    last_synced_at: string | null;
    pending: number;
    last_error: string | null;
    /** s97-m14: when that copy first said this copy's member was removed; absent while a member. */
    removed_at?: string;
  }>;
}

export const rbookStatusSchema = z
  .object({
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
  })
  // s86-m04: `.strict()` so the zod schema states what the published inputSchema has always
  // stated (additionalProperties: false), matching the other 12 tools. INERT AT RUNTIME — the
  // consolidated schemas are never parsed (src/index.ts casts every case), so this rejects
  // nothing previously accepted; it aligns the two declarations.
  .strict();

export type RbookStatusParams = z.infer<typeof rbookStatusSchema>;

export const rbookStatusToolDefinition = {
  name: 'rbook_status',
  description:
    'Return a structured status payload for the current project: rbook_address, dashboard_url, auth_tier, last_sync_at, last_delivery_observed_at. Mirrors onboard.authState.authTier on the auth_tier field for cross-side parity with the dashboard. Useful for support/ops triage and at-a-glance health.',
  inputSchema: {
    type: 'object',
    properties: {
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Local-only sentinel for the rbook_address field when the project has no
 * canonical address yet (fresh project) or its identity is stuck on
 * `rbook://unknown/*` (pre-canonicalization).
 */
const LOCAL_ONLY_ADDRESS = 'local-only';

function normalizeRbookAddress(raw: string | undefined | null): string {
  if (!raw) return LOCAL_ONLY_ADDRESS;
  const trimmed = raw.trim();
  if (!trimmed) return LOCAL_ONLY_ADDRESS;
  if (trimmed.startsWith('rbook://unknown/')) return LOCAL_ONLY_ADDRESS;
  return trimmed;
}

/**
 * s87-m03 — `last_sync_at` is documented as belonging to THIS project, so it must be asked for
 * as this project's.
 *
 * MEASURED DEFECT: calling `getSyncStatus` with no argument hits `/api/sync/status` unscoped and
 * returns a PLATFORM-WIDE timestamp. `rbook_status`'s five-field payload is described as "for the
 * current project", and the number it published was 32 days optimistic — `2026-07-11` against
 * this project's true `2026-06-09`. One argument, and the field starts describing its own row.
 */
async function resolveLastSyncAt(
  projectSlug: string | null,
  projectRoot?: string
): Promise<string | null> {
  // Build a dashboard client opportunistically. If we can't authenticate
  // (no credentials / unreachable / 4xx), the status payload returns null
  // for last_sync_at without surfacing an error.
  const clientResult = await DashboardClient.fromEnvForProject(projectRoot);
  if (!clientResult.success || !clientResult.data) {
    return null;
  }

  try {
    // `?? undefined` rather than `?? ''`: an empty slug would be sent as `?projectSlug=` and ask
    // the dashboard to scope to nothing. An identity-less store falls back to the unscoped call
    // deliberately — the honest degradation — rather than to a scoped call for a project that
    // has no name.
    const statusResult = await clientResult.data.client.getSyncStatus(projectSlug ?? undefined);
    if (statusResult.success && statusResult.data) {
      return statusResult.data.lastSyncAt ?? null;
    }
  } catch {
    // Non-fatal — rbook_status must always return useful data even when the
    // dashboard is unreachable.
  }
  return null;
}

/** Each copy this shared copy syncs with, named as a person knows it. */
function sharedSync(client: RbookDatabaseClient): NonNullable<RbookStatusResult['shared_sync']> {
  const ctx = mergeContext(client);
  return peerHealth(client)
    .filter((peer) => syncsWith(ctx, peer.replicaId))
    .map((peer) => ({
      peer: peer.replicaId === ctx.authority ? "the owner's copy" : (peer.name ?? peer.replicaId),
      last_synced_at: peer.lastOkAt,
      pending: peer.pending,
      last_error: peer.lastError,
      ...(peer.removedAt ? { removed_at: peer.removedAt } : {}),
    }));
}

/**
 * Execute rbook_status. Always returns success=true with all 5 frozen fields
 * populated; the only error path is the underlying Reasonbook DB being absent
 * (handled by `withClientAsync`).
 */
export async function rbookStatus(
  params: RbookStatusParams = {}
): Promise<RbookToolResult<RbookStatusResult>> {
  // s89-m08 — ONE schema-driven boundary guard, placed at the router entry so no handler can be
  // reached with a wrong-typed published string parameter. It reads this tool's OWN shipped
  // inputSchema, so it cannot drift from what is published. This tool is ACTION-LESS, so every
  // published string parameter applies. See param-type-guard.ts for the 714-triple measurement,
  // the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookStatusToolDefinition.inputSchema,
    undefined,
    params
  );
  if (wrongTypedParam) return createError<RbookStatusResult>(wrongTypedParam);

  return withClientAsync(
    async (client) => {
      const identity = getProjectIdentity(client);
      // s100-m01: a member's copy names the address it joined by, and asks the dashboard nothing
      // about the project, as its review does.
      const membersCopy = isMembersCopy(client);
      const rbook_address = normalizeRbookAddress(
        identity?.rbook_address ||
          (membersCopy ? readCopyKey(client, COPY_KEYS.joinedAddress) : null)
      );

      const dashboard_url = resolveDashboardBaseUrl();

      const authState = await computeAuthState({ projectRoot: params.projectRoot });

      // s87-m03: the slug is derived the same way every other caller derives it — from the
      // project name — so the four getSyncStatus sites agree about what "this project" means.
      const projectSlug = identity?.project_name ? deriveProjectSlug(identity.project_name) : null;
      const last_sync_at = membersCopy
        ? null
        : await resolveLastSyncAt(projectSlug, params.projectRoot);

      const result: RbookStatusResult = {
        rbook_address,
        dashboard_url,
        auth_tier: authState.authTier,
        last_sync_at,
        last_delivery_observed_at: authState.lastDeliveryObservedAt,
        ...(isRecordedStore(client) ? { shared_sync: sharedSync(client) } : {}),
      };

      const upload = await readDashboardUploadStatus(path.resolve(client.path, '..', '..', '..'));
      return createSuccess(result, upload ? [upload] : undefined);
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * Format the status payload for LLM-readable text output. The structuredContent
 * carries the canonical 5-field shape; this format is for the chat surface.
 */
export function formatStatusForLLM(result: RbookToolResult<RbookStatusResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = ['rbook_status failed', '', `Error: ${error?.message ?? 'Unknown error'}`];
    if (error?.suggestion) {
      lines.push('', `Suggestion: ${error.suggestion}`);
    }
    return lines.join('\n');
  }

  const s = result.data;
  const lines = [
    'Reasonbook Status',
    '',
    `rbook_address:              ${s.rbook_address}`,
    `dashboard_url:             ${s.dashboard_url}`,
    `auth_tier:                 ${s.auth_tier}`,
    `last_sync_at:              ${s.last_sync_at ?? 'never'}`,
    `last_delivery_observed_at: ${s.last_delivery_observed_at ?? 'never'}`,
    ...(s.shared_sync
      ? [
          `shared sync:               ${s.shared_sync.length ? '' : 'no copy has synced with this one yet'}`,
          ...s.shared_sync.map(
            (peer) =>
              `  ${peer.peer}: ${peer.removed_at ? `said this copy's member was removed (first said ${peer.removed_at}), so what this copy sends is set aside; ` : ''}last synced ${peer.last_synced_at ?? 'never'}, ${peer.pending} pending${peer.last_error ? `, last error: ${peer.last_error}` : ''}`
          ),
        ]
      : []),
    s.auth_tier === 'none'
      ? '\nNo dashboard credentials configured. Run rbook_auth(action="login_init"), then rbook_auth(action="login_complete"), to bootstrap, or sign up at https://reasonbook.ai/register.'
      : '',
  ].filter(Boolean);

  appendWarnings(lines, result);

  return lines.join('\n');
}
