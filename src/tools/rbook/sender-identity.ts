// ABOUTME: Resolve the local project's sender identity (dashboard UUID + rbook_address)
// ABOUTME: for outbound cross-project messaging. Single source of truth for attribution.

/**
 * Sender Identity Resolver
 *
 * Every path that calls DashboardClient.sendMessage must attribute the send to the
 * *local* project — the cwd this process is running in. The original Sprint 32
 * auto-detect blindly returned `/api/projects/me` projects[0], which caused every
 * message from every project to be tagged with whichever project the dashboard
 * happened to list first for the user, rather than the project that sent it.
 *
 * This module centralises the resolution so any new sender path gets the right
 * answer automatically. Fail-closed: when we cannot authoritatively resolve the
 * local project, return `undefined` — never a sibling project's id.
 *
 * @module tools/rbook/sender-identity
 */

import { normalizeAddressScheme } from '../../intelligence/legacy-compat';
import { withClientAsync, type RbookDatabaseClient } from './client';
import { createSuccess } from './errors';
import { getProjectIdentity, backfillUnknownRbookAddress } from './project-identity';
import { resolveAndPersistOwner } from './owner-resolution';
import type { DashboardClient } from './dashboard-client';

/** UUID regex used to validate the local dashboard_project_id before trusting it. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Local sender identity — everything we know about *this* cwd's project, used to
 * attribute outgoing messages. Both fields are resolved from the local DB in a
 * single open; the async entrypoint also best-effort seeds `metadata.owner` and
 * backfills the canonical rbook_address if they are missing.
 */
export interface LocalSenderIdentity {
  /** Dashboard UUID for this local project, or null when never registered. */
  projectId: string | null;
  /** Canonical rbook://<owner>/<slug> address, or null when still empty/unknown. */
  rbookAddress: string | null;
}

function normalizeSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase().replace(/\s+/g, '-') : null;
}

function extractSlugFromAddress(address: string | null): string | null {
  address = address ? normalizeAddressScheme(address) : address;
  if (!address || !address.startsWith('rbook://')) {
    return null;
  }

  const body = address.slice('rbook://'.length);
  const [, slug] = body.split('/');
  return normalizeSlug(slug ?? null);
}

function readMetadataValue(db: RbookDatabaseClient, key: string): string | null {
  const result = db.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  if (!result.success || !result.data?.value) {
    return null;
  }

  const trimmed = result.data.value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function shouldAttemptIdentityRepair(
  projectId: string | null,
  rbookAddress: string | null,
  db: RbookDatabaseClient
): boolean {
  if (!projectId || !UUID_REGEX.test(projectId)) {
    return true;
  }

  if (!rbookAddress) {
    return true;
  }

  const currentSlug = extractSlugFromAddress(rbookAddress);
  const trustedSlugs = new Set(
    [readMetadataValue(db, 'project_id'), readMetadataValue(db, 'project_name')]
      .map((value) => normalizeSlug(value))
      .filter((value): value is string => value !== null)
  );

  if (trustedSlugs.size === 0) {
    return false;
  }

  return currentSlug === null || !trustedSlugs.has(currentSlug);
}

/**
 * Read the local project's sender identity (dashboard UUID + rbook_address) from
 * the Reasonbook database. Returns nulls — never bogus defaults — so the caller can
 * fail closed rather than publishing a sibling project's identity.
 *
 * `rbookAddress` is null when the identity row holds an empty or `rbook://unknown/*`
 * address; sending a bogus value would attribute the message to the wrong project.
 *
 * Attempts a best-effort owner resolution + backfill first to recover a registered
 * project's canonical address. An address alone does not authorize a send.
 */
export async function readLocalSenderIdentity(projectRoot?: string): Promise<LocalSenderIdentity> {
  try {
    const result = await withClientAsync(
      async (db) => {
        const readIdentity = (): LocalSenderIdentity => {
          const rawProjectId = readMetadataValue(db, 'dashboard_project_id') ?? '';
          const projectId = rawProjectId.length > 0 ? rawProjectId : null;
          const identity = getProjectIdentity(db);
          const addr = identity?.rbook_address?.trim() ?? '';
          const rbookAddress = !addr || addr.startsWith('rbook://unknown/') ? null : addr;
          return { projectId, rbookAddress };
        };

        let localIdentity = readIdentity();
        if (shouldAttemptIdentityRepair(localIdentity.projectId, localIdentity.rbookAddress, db)) {
          try {
            // s86-m02b: `resolveAndPersistOwner` returns a `warnings` array naming any
            // metadata write that errored, and this call site DROPS it — deliberately, and
            // this is the one caller of the three that must. It is a PRODUCER WITH NO
            // CONSUMER BY CONSTRUCTION: `readLocalSenderIdentity` is a resolver, not a tool
            // handler. It returns a bare `LocalSenderIdentity` (the `createSuccess` envelope
            // below is discarded by the `result.data` unwrap at the end of this function),
            // it has no `format*ForLLM`, and its two callers — rbook-message.ts's handleSend
            // and rbook-sprint-carry-forward.ts — consume only `{projectId, rbookAddress}`.
            // Carrying the failure out would mean widening this resolver's return type and
            // both call sites; the disclosure the operator actually gets is the NULL identity
            // this function then fails closed with, plus the same warnings surfaced by the
            // other two callers (rbook-agent-onboard, checkpoint-backfill) on their own answers.
            await resolveAndPersistOwner(db);
            backfillUnknownRbookAddress(db);
            localIdentity = readIdentity();
          } catch {
            // best-effort — fall through to whatever the DB currently has
          }
        }

        return createSuccess<LocalSenderIdentity>(localIdentity);
      },
      // Sender resolution observes (and may repair owner/address linkage); it is not the
      // project-registration authority even when nested inside a write-classified send.
      { projectRoot, registerProject: false }
    );
    return result.success && result.data ? result.data : { projectId: null, rbookAddress: null };
  } catch {
    return { projectId: null, rbookAddress: null };
  }
}

/**
 * Resolve the dashboard UUID to attribute an outbound message to.
 *
 * Only `metadata.dashboard_project_id`, the UUID recorded at registration or join,
 * identifies this store. A copied store retains that UUID. Names and canonical
 * addresses can be reused by a different store, so an account listing cannot
 * supply a missing ID. Return `undefined` and let the caller refuse publication.
 */
export async function resolveLocalSenderProjectId(
  _client: DashboardClient,
  identity: LocalSenderIdentity
): Promise<string | undefined> {
  if (identity.projectId && UUID_REGEX.test(identity.projectId)) {
    return identity.projectId;
  }

  return undefined;
}

/**
 * Convenience wrapper: read the local identity and resolve the senderProjectId
 * in a single call. Used by tools that don't need the rbookAddress separately.
 */
export async function getLocalSenderProjectId(
  client: DashboardClient,
  projectRoot?: string
): Promise<{ senderProjectId: string | undefined; identity: LocalSenderIdentity }> {
  const identity = await readLocalSenderIdentity(projectRoot);
  const senderProjectId = await resolveLocalSenderProjectId(client, identity);
  return { senderProjectId, identity };
}

/**
 * Thrown when handleSend or any other authoritative-attribution call site cannot
 * produce an authoritative sender ID. Defense in depth on top of the dispatcher's
 * `resolveSenderContext` gate — the resolver
 * normally fail-closes before we ever reach this path, but keeping the assertion
 * here prevents any caller that bypasses the boundary from silently publishing
 * with only a reusable address.
 *
 * The thrown code `SENDER_ATTRIBUTION_INCOMPLETE` is distinct from the resolver's
 * `SENDER_UNRESOLVABLE` so operators can tell which layer rejected the send.
 */
export class SenderAttributionIncompleteError extends Error {
  readonly code = 'SENDER_ATTRIBUTION_INCOMPLETE';
  readonly identity: LocalSenderIdentity;
  readonly senderProjectId: string | undefined;

  constructor(identity: LocalSenderIdentity, senderProjectId: string | undefined) {
    super(
      `Sender attribution incomplete: projectId=${identity.projectId ?? 'null'} ` +
        `rbookAddress=${identity.rbookAddress ?? 'null'} senderProjectId=${senderProjectId ?? 'null'}. ` +
        'Refusing to send — attribution must be authoritatively resolved before dashboard publish.'
    );
    this.name = 'SenderAttributionIncompleteError';
    this.identity = identity;
    this.senderProjectId = senderProjectId;
  }
}

/**
 * Require a sender ID even when the local address is canonical: a new store can
 * reuse another record's address. The resolver validates stored UUIDs; explicit
 * caller-supplied sender IDs retain their existing pass-through contract. The
 * dispatcher's full UUID+address gate remains the MCP authorization boundary.
 */
export function assertSenderIdentityValid(
  identity: LocalSenderIdentity,
  senderProjectId: string | undefined
): void {
  if (!senderProjectId) {
    throw new SenderAttributionIncompleteError(identity, senderProjectId);
  }
}
