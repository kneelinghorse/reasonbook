// ABOUTME: Resolves authenticated dashboard access and preserves its deployed request contract.
// ABOUTME: Normalizes typed response addresses to current public names while leaving user content intact.
/**
 * Dashboard HTTP Client & Credential-Based Authentication
 *
 * Reusable HTTP client for calling the cmos-dashboard REST API.
 * Authenticates via POST /api/auth/login with user credentials,
 * caches the JWT, and re-authenticates when it expires.
 *
 * @module tools/rbook/dashboard-client
 */

import { isDirectoryEdition, directoryEditionError } from '../../edition';
import {
  LEGACY,
  normalizeAddressScheme,
  toDashboardAddress,
} from '../../intelligence/legacy-compat';
import { getSetting } from '../../intelligence/legacy-compat';
import { rememberDashboardIdentity } from '../../intelligence/user-author';
import { createReadStream, createWriteStream, readFileSync, rmSync, statSync } from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { gzipSync } from 'zlib';
import type { RbookToolError, RbookToolResult } from './types';
import { dashboardHttpError } from './dashboard-http-error';
import { registrationError } from './registration-error';
import { createError, createSuccess, RbookErrors } from './errors';
import { compareStoredTimes } from './stored-time';
import {
  CredentialStore,
  type KeySource,
  type UserScopedKeyRecord,
} from '../../intelligence/credential-store';

// ─── Environment Variable Names ──────────────────────────────────────────────

export const RBOOK_DASHBOARD_URL_ENV = 'RBOOK_DASHBOARD_URL';
export const RBOOK_DASHBOARD_USER_ENV = 'RBOOK_DASHBOARD_USER';
export const RBOOK_DASHBOARD_PASSWORD_ENV = 'RBOOK_DASHBOARD_PASSWORD';
export const RBOOK_DASHBOARD_API_KEY_ENV = 'RBOOK_DASHBOARD_API_KEY';

/**
 * Default dashboard URL used when RBOOK_DASHBOARD_URL is unset or empty.
 * Sprint 62 m02: bakes the canonical aquex.ai endpoint into the npm-shipped
 * package so fresh installs reach the right host without env config. The 402
 * graceful-degradation path (m05) is the actual fresh-user UX when the user
 * has no account yet — they hit the default URL, dashboard returns 402, and
 * rbook_message etc surface https://reasonbook.ai/register for sign-up.
 */
export const DEFAULT_DASHBOARD_URL = 'https://reasonbook.ai';

/**
 * Resolve the dashboard base URL from explicit override → env var → baked default.
 * Treats empty string as unset (per IDE-spawn empty-string env trap).
 *
 * Exported so downstream tools (rbook_status, future hosts) can read the same
 * effective URL without re-implementing the precedence chain.
 */
export function resolveDashboardBaseUrl(override?: string): string {
  if (override) return override;
  const envValue = getSetting(RBOOK_DASHBOARD_URL_ENV);
  if (envValue) return envValue;
  return DEFAULT_DASHBOARD_URL;
}

// ─── Sprint 58 m02: legacy-auth migration WARN ───────────────────────────────

/**
 * Tracks whether we've already emitted a [WARN] line for each legacy arm in
 * this process, so the warning fires exactly once per arm per run — loud
 * enough to be seen, quiet enough that repeated calls don't spam logs.
 *
 * Visible to tests via `__resetLegacyAuthWarnSeen` so assertions can force
 * a clean slate per case.
 */
const legacyAuthWarnSeen = new Set<'legacy-env' | 'password-fallback'>();

function warnLegacyAuth(arm: 'legacy-env' | 'password-fallback'): void {
  if (legacyAuthWarnSeen.has(arm)) return;
  legacyAuthWarnSeen.add(arm);
  const armLabel = arm === 'legacy-env' ? 'legacy-env' : 'password-fallback';
  process.stderr.write(
    `[WARN] reasonbook: authenticating via ${armLabel}; run rbook_auth(action="login_init"), then rbook_auth(action="login_complete"), to migrate to device-code credentials\n`
  );
}

/** Test helper — reset the per-process WARN seen-set. */
export function __resetLegacyAuthWarnSeen(): void {
  legacyAuthWarnSeen.clear();
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DashboardClientConfig {
  /** Dashboard base URL (e.g. https://reasonbook.ai) */
  baseUrl: string;
  /** API key for dashboard auth (cmk_ prefix). If set, email/password are not needed. */
  apiKey?: string;
  /** User email for dashboard login */
  email?: string;
  /** User password for dashboard login */
  password?: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

export interface LoginResponse {
  success: boolean;
  data: {
    token: string;
    expiresAt: string;
    user: {
      id: string;
      email: string;
      username?: string;
      projects: unknown[];
    };
  };
}

/**
 * Cached user identity from the last successful login.
 * Used for address discovery (username) and sender context (userId).
 */
export interface DashboardUserIdentity {
  userId: string;
  email: string;
  username: string | null;
}

/**
 * s87-m05 — THE SEND RESPONSE IS A DIFFERENT SHAPE FROM A LISTED MESSAGE, and conflating them is
 * what produced `ID: undefined` on every successful send.
 *
 * `sendMessage` was typed as returning {@link DashboardMessage}, whose `id` is required and IS
 * returned by the list/get routes. The SEND route returns `messageId`. Because the declared type
 * promised `id`, every send mock in the suite was written to satisfy the DECLARATION rather than
 * the WIRE — so the tests stayed green against a shape production has never produced, while the
 * shipped renderer printed `ID: undefined`.
 *
 * Verified rather than assumed: `git log -S messageId` puts the key in the FIRST commit of the
 * messaging API, and a live send (message `2f64af65`) returns it.
 *
 * `id` is kept as an optional tolerance for a deployed instance older than this checkout; it is
 * read only through `?? `, never depended on.
 */
export interface DashboardSendResponse {
  /** What the send route returns. */
  messageId?: string;
  /** Tolerance for a pre-cutover deployment. Never assumed present. */
  id?: string;
  status?: string;
  deliveredAt?: string;
  /** Dashboard-reported delivery/routing status, when the deploy exposes an ACK surface. */
  deliveryStatus?: string;
  /** Echoed back so the client can warn on an attribution mismatch. */
  senderAddress?: string;
  /** s57-m04 identity ACK, consumed by whoami/onboard's legacy-key warning. */
  deliveryAck?: { identitySource?: 'api-key' | 'request-body' | 'none' };
}

export interface DashboardMessage {
  id: string;
  type: string;
  summary: string;
  body?: string;
  from?: string;
  to?: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  evidence?: unknown[];
  /** Explicit sender project ID (intel message types) */
  from_project_id?: string;
  /** Explicit recipient project ID (intel message types) */
  to_project_id?: string;
  /** Canonical rbook:// address of the sender, echoed back by the dashboard when supported. */
  senderAddress?: string;
  /**
   * Routing/delivery status returned by the dashboard when recipient-relay ACKs are available
   * (e.g. "queued", "delivered", "failed"). Absent on dashboards that have not yet implemented
   * the ACK surface — callers should treat absence as "status=pending, unknown routing" and
   * NOT infer delivery success. Tracked as a cross-repo dependency on the dashboard side.
   */
  deliveryStatus?: string;
  /**
   * Sprint 31 dashboard ACK signal — how the dashboard attributed this send:
   *   `api-key`      — project-scoped key auth (post-rotation steady state)
   *   `request-body` — legacy user-scoped key + body-level senderProjectId
   *   `none`         — could not identify a sender project
   * Sprint 57 m04 reads this to surface authState in whoami + onboard.
   */
  deliveryAck?: {
    identitySource: 'api-key' | 'request-body' | 'none';
    recordedSender?: {
      projectId?: string | null;
      slug?: string | null;
      [LEGACY.wireAddressKey]?: string | null;
    };
  };
  // ── Live dashboard fields (s80-m05 probe, 2026-07-09) ──────────────────────
  // The dashboard returns a RICHER row than the s31-era typed set above. These are
  // the fields observed on a real inbox row; the summary shape (MessageSummary) picks
  // from them, and body-on-get returns the whole row. NOTE: the human-readable
  // attribution the dashboard actually populates is `senderProject`/`senderDisplayName`
  // (NOT `from`/`from_project_id`/`senderAddress`, which are empty on live rows).
  /** ActivityPub verb (e.g. "update"), mirrors MESSAGE_TYPE_MAP. */
  verb?: string;
  /** ActivityPub object type (e.g. "mission"). */
  objectType?: string;
  /** Nested payload; `payload.body` is the full message text (the bulk of list bytes). */
  payload?: { body?: string } & Record<string, unknown>;
  /** When the recipient responded (accept/decline/reply). */
  respondedAt?: string | null;
  /** Free-text response notes (heavy; body-on-get only). */
  responseNotes?: string | null;
  /** Inbox: the sender project's display name (e.g. "CMOS-MCP Pro"). */
  senderProject?: string | null;
  /** Inbox: the sender operator's display name (e.g. "kneelinghorse"). */
  senderDisplayName?: string | null;
  /** Inbox: the sender operator's email. */
  senderEmail?: string | null;
  /** Sent: the recipient project's display name. */
  targetProject?: string | null;
  /** Sent: the target mission id, when the message was addressed to one. */
  targetMissionId?: string | null;
  // ── s84-m01: sprint-47 dashboard messaging cutover (msg 3d59132e) ──────────
  // The cutover REPURPOSES `senderProject`/`targetProject` to carry the SLUG
  // (they previously carried the display NAME) and adds these `*Name` twins to
  // carry the display NAME, plus four additive identity UUIDs on every row.
  // Version-tolerant reads use `*Name ?? *Project` (name ?? slug) so they yield
  // the NAME pre-cutover (only slug-less `*Project`=NAME populated) AND
  // post-cutover (`*Name`=NAME populated). All optional so a pre-cutover row parses.
  /** Inbox: the sender project's display name post-cutover (twin of the now-slug `senderProject`). */
  senderProjectName?: string | null;
  /** Sent: the recipient project's display name post-cutover (twin of the now-slug `targetProject`). */
  targetProjectName?: string | null;
  /** Additive identity UUID: sender operator's user id. Distinct from the snake_case
   *  `from_project_id` (a PROJECT id) and from the outbound `SendMessageParams.senderProjectId`. */
  senderUserId?: string | null;
  /** Additive identity UUID: sender PROJECT id. Distinct from the snake_case `from_project_id`
   *  (legacy intel field) and the outbound `SendMessageParams.senderProjectId`. */
  senderProjectId?: string | null;
  /** Additive identity UUID: recipient operator's user id. */
  targetUserId?: string | null;
  /** Additive identity UUID: recipient PROJECT id. Distinct from the snake_case `to_project_id`. */
  targetProjectId?: string | null;
}

export interface SendMessageParams {
  targetAddress: string;
  type: string;
  summary: string;
  body?: string;
  evidence?: unknown[];
  /** Sender project ID for cross-project same-owner sends */
  senderProjectId?: string;
  /** Explicit sender project ID for project-to-project routing (intel types) */
  fromProjectId?: string;
  /** Explicit recipient project ID for project-to-project routing (intel types) */
  toProjectId?: string;
  /**
   * Canonical rbook://<owner>/<slug> address of the sender. Sent to the dashboard in addition to
   * senderProjectId so the relay can attribute messages even if its auto-resolve path falls back
   * to a sibling project (Sprint 52 m02). Omitted when the local project_identity rbook_address
   * is empty or still in the legacy rbook://unknown/* form.
   */
  senderAddress?: string;
}

function canonicalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function expectedSlugMismatchError(
  operation: string,
  expectedSlug: string,
  actualSlug: string
): RbookToolResult<never> {
  return createError({
    code: 'EXPECTED_SLUG_MISMATCH',
    message: `Refusing ${operation}: expected slug '${expectedSlug}' but resolved '${actualSlug}'.`,
    suggestion:
      'Verify the call is targeting the intended project and pass the canonical slug from the trusted local project context.',
  });
}

export interface ListMessagesParams {
  tab?: 'inbox' | 'sent';
  status?: string;
  limit?: number;
  /** s84-m02: SQL-side pagination offset (dashboard m05). Omitted → dashboard defaults to 0. */
  offset?: number;
}

export interface ListMessagesResult {
  messages: DashboardMessage[];
  /**
   * s87-m05 — USER-WIDE. This is what `/api/messages` returns unscoped: every unread message
   * across every project this user owns. It was rendered on a PROJECT-scoped digest as though it
   * were this project's, telling an agent to review messages it can never clear from here.
   */
  unreadCount: number;
  /** s87-m05 — this project's unread count, when the dashboard scopes the query. Optional so a
   *  pre-cutover dashboard still parses; absence means "not scoped", never zero. */
  unreadCountScoped?: number;
  /** s87-m05 — which of the two counts above the dashboard actually applied. */
  unreadScope?: 'project' | 'user';
  totalCount: number;
  /** s84-m02: page size the dashboard actually returned (dashboard m05). Absent on a
   *  pre-cutover dashboard that does not echo it — callers treat absence as unknown. */
  returnedCount?: number;
}

export interface RespondToMessageParams {
  messageId: string;
  status: 'accepted' | 'declined' | 'replied';
  notes?: string;
}

export interface AckMessageParams {
  messageId: string;
}

/** Dashboard /ack response shape (Sprint 72 m04, migration 031). Terminal pending→acknowledged. */
export interface AckMessageResult {
  messageId: string;
  previousStatus: string;
  status: string;
  ackedAt: string;
}

export interface ResolveAddressParams {
  address: string;
}

/**
 * GET /api/messages/resolve.
 *
 * s86-m07 — `resolved` is an OBJECT, not a boolean, and there are no top-level `projectName` /
 * `agentId` keys. The pre-s86 declaration described a response the endpoint has never sent;
 * `request()` returns the whole body as `data` (there is no `data` envelope key on this route),
 * so the live body is `{success, resolved: {...}}` verbatim. Recorded 2026-08-10 against
 * https://reasonbook.ai; the identity-redacted response shape was:
 *
 *     {"success":true,"resolved":{"projectId":"example-id","projectName":"Example Project",
 *      "projectSlug":"example-project"}}
 *
 * The members are optional because the route's own body varies by address kind; only
 * `resolved`'s PRESENCE is load-bearing (handleSend already treats a non-error response as
 * "the address exists"). The endpoint also returns a server-internal filesystem path to the
 * store — deliberately NOT modelled here: a path on the dashboard host is not this codebase's
 * business, and typing it would invite a caller to read it.
 */
export interface ResolveAddressResult {
  success?: boolean;
  resolved: {
    userId?: string;
    username?: string;
    displayName?: string;
    projectId?: string;
    projectName?: string;
    projectSlug?: string;
  };
}

/**
 * A project entry from the dashboard directory.
 *
 * s86-m07 — NO `description` member. Measured 2026-08-10 over 37 rows, GET
 * /api/projects/directory/public carried no description for any row, so the field and its
 * renderer were permanently inert. `createdAt` is the REGISTRATION date; it is not an activity or
 * freshness signal and must not be rendered as one.
 *
 * s87-m05 — TWO CLAIMS IN THIS BLOCK WERE REFUTED AGAINST THE LIVE API AND ARE CORRECTED.
 * It enumerated the payload as an exhaustive shape and stated that `isOwner` could never be
 * populated by that route. The route DOES return `isOwner`. (The original sentences are
 * paraphrased rather than quoted, so a grep for the refuted wording finds no live copy of it.) A live probe of the deployed dashboard settles it; the shape sentence was
 * written from a measurement of the payload as it stood in August and hardened into a claim about
 * what the route can never do.
 *
 * THE JOIN STAYS, AND THAT IS A DELIBERATE CALL, NOT AN OVERSIGHT. `rbook_message(directory)` still
 * calls GET /api/projects/me and merges. Dropping it now that the directory route carries
 * `isOwner` would be a LATENCY optimisation, not a truth fix — the join is correct today and its
 * degraded path already warns honestly. Rule 3: touch only what is wrong. What was wrong was the
 * sentence.
 */
export interface DirectoryProject {
  id: string;
  name: string;
  address: string;
  owner: string;
  slug?: string;
  isOwner?: boolean;
  createdAt?: string;
  ownerDisplayName?: string;
}

export interface ListDirectoryResult {
  projects: DirectoryProject[];
  totalCount: number;
}

export interface GetMyProjectsResult {
  projects: DirectoryProject[];
  totalCount: number;
  /** s96-m02: the caller's identity, which the dashboard returns since its sprint 61 (H3). */
  user?: { id: string; username: string | null };
}

type RawDirectoryProject = Partial<DirectoryProject> & {
  [LEGACY.wireAddressKey]?: string;
};

export function pickNewestUserScopedKey(
  keys: Record<string, UserScopedKeyRecord>
): { keyId: string; record: UserScopedKeyRecord } | undefined {
  const entries = Object.entries(keys);
  if (entries.length === 0) return undefined;
  // s107-m01 (#788): by instant, as the upload fallback orders keys; the store keeps any spelling.
  const best = entries.reduce((a, b) =>
    compareStoredTimes(b[1].issuedAt, a[1].issuedAt) > 0 ? b : a
  );
  return { keyId: best[0], record: best[1] };
}

/**
 * s86-m06 — the resolution envelope both `fromEnvForProject` and `fromEnvForUser`
 * return. Deliberately the SAME shape for both: `keySource` is what lets a caller
 * tell the arms apart by rule (see `classifyAttribution`), so no entry point needs
 * a divergent field to be interpretable.
 */
export interface ResolvedDashboardClient {
  client: DashboardClient;
  keySource: KeySource;
  matchedProjectRoot: string | null;
}

/**
 * s86-m06 — the api-key config literal, shared by `fromEnvForProject` and
 * `fromEnvForUser` so the two entry points cannot drift on how a key becomes a
 * client config.
 */
function apiKeyConfig(
  baseUrl: string,
  apiKey: string,
  timeoutMs: number | undefined
): DashboardClientConfig {
  return {
    baseUrl,
    apiKey,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function parseOwnerFromAddress(address: string | undefined): string | undefined {
  if (!address || !address.startsWith('rbook://')) {
    return undefined;
  }

  const body = address.slice('rbook://'.length);
  const [owner] = body.split('/');
  return owner && owner.trim().length > 0 ? owner.trim() : undefined;
}

/** Account emails are private metadata; protocol addresses normalize without rewriting user prose. */
function normalizeMessageAddresses<
  T extends Pick<DashboardMessage, 'from' | 'to' | 'senderAddress'>,
>(message: T): T {
  const publicMessage = { ...message } as T & Record<string, unknown>;
  delete publicMessage.senderEmail;
  delete publicMessage.targetEmail;
  return {
    ...publicMessage,
    ...(typeof message.from === 'string' ? { from: normalizeAddressScheme(message.from) } : {}),
    ...(typeof message.to === 'string' ? { to: normalizeAddressScheme(message.to) } : {}),
    ...(typeof message.senderAddress === 'string'
      ? { senderAddress: normalizeAddressScheme(message.senderAddress) }
      : {}),
  };
}

function normalizeDirectoryProject(project: RawDirectoryProject): DirectoryProject {
  const address = normalizeAddressScheme(project.address ?? project[LEGACY.wireAddressKey] ?? '');
  const owner = project.owner ?? parseOwnerFromAddress(address) ?? 'unknown';

  return {
    id: project.id ?? '',
    name: project.name ?? '',
    address,
    owner,
    ...(project.slug ? { slug: project.slug } : {}),
    ...(project.isOwner !== undefined ? { isOwner: project.isOwner } : {}),
    // s86-m07: the directory route sends both of these and this whitelist used to drop them.
    // Conditional-include (not `?? null`) so a lean row stays byte-identical — no null-wall.
    ...(project.createdAt ? { createdAt: project.createdAt } : {}),
    ...(project.ownerDisplayName ? { ownerDisplayName: project.ownerDisplayName } : {}),
  };
}

function normalizeProjectListResult<
  T extends { projects?: RawDirectoryProject[]; totalCount?: number },
>(data: T): { projects: DirectoryProject[]; totalCount: number } {
  const projects = (data.projects ?? []).map((project) => normalizeDirectoryProject(project));
  return {
    projects,
    totalCount: data.totalCount ?? projects.length,
  };
}

/** s97-m10: a peer call's request is gzip-compressed past this size; small ones go as they are. */
const RELAY_GZIP_FROM_BYTES = 64 * 1024;
/** s97-m10: how long one peer call may take: a page can hold the dashboard's whole request limit. */
const RELAY_TIMEOUT_MS = 120_000;
/** s97-m11: an upload or a first copy moves a whole store, so it may take longer than a page. */
const RELAY_UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;
/** s97-m11: the largest first copy this machine takes from a dashboard. */
const FIRST_COPY_MAX_BYTES = 4 * 1024 * 1024 * 1024;
/** s97-m10: the most one peer call's answer may hold, after decompression; a page is far smaller. */
const RELAY_MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
/** A project/capability directory is metadata, not a whole-store transfer. */
const PROJECTS_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** A response's text, or null once it holds more than `max` bytes; reading stops there. */
async function boundedText(response: Response, max: number): Promise<string | null> {
  if (!response.body) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Row count for a single PG mirror table. */
export interface SyncStatusTableCount {
  table: string;
  count: number;
}

/** Response from GET /api/sync/status — reconciliation data. */
export interface SyncStatusResult {
  tables: SyncStatusTableCount[];
  totalMirrorRows: number;
  totalSyncLogEntries: number;
  unprocessedSyncLogEntries: number;
  failedSyncLogEntries: number;
  lastSyncAt: string | null;
  oldestUnprocessedAt: string | null;
  projectCount: number;
}

/** Result from POST /api/projects/register-new — project registration. */
export interface RegisterProjectResult {
  slug: string;
  projectId: string;
  reregistered: boolean;
  backfill: { counts: Record<string, number> };
  /**
   * Auto-issued project-scoped key — present on first-time registration only.
   * Sprint 57 m02: dashboard returns the plaintext key exactly once here so
   * the MCP client can capture it into the local credential store. Absent on
   * idempotent re-registrations (see `keyRotated`).
   */
  key?: string;
  /** Dashboard-side UUID of the auto-issued key — pairs with `key`. */
  keyId?: string;
  /** Human-readable label (dashboard-generated from the register User-Agent). */
  label?: string;
  /**
   * Set to `false` by the dashboard on idempotent re-registration to signal
   * "project already exists for this user-scoped credential — no new key minted."
   * Undefined (absent) on first-time register.
   */
  keyRotated?: boolean;
}

/** Result from POST /api/projects/:id/keys/reissue — lost-key recovery. */
export interface ReissueProjectKeyResult {
  key: string;
  keyId: string;
  label: string;
  /** Dashboard-side keyIds that were revoked as part of this reissue. */
  revokedKeyIds: string[];
}

/** Result from POST /api/projects/:id/keys/rotate — atomic mint-new + schedule-revoke-old. */
export interface RotateProjectKeyResult {
  newKey: string;
  newKeyId: string;
  oldKeyId: string;
  /** ISO timestamp when the old key becomes invalid on the dashboard side. */
  revokeAt: string;
  /** Optional dashboard-assigned label for the new key. */
  label?: string;
}

/**
 * Result from POST /api/projects/:id/keys/revoke/:keyId (legacy project-scoped
 * endpoint) AND from POST /api/keys/:keyId/revoke (Sprint 59 m02 / dashboard
 * s34-m03 scope-aware unified endpoint). Both endpoints share the same
 * response envelope for parser-reuse — only the URL differs. Scope is inferred
 * server-side; the MCP caller determines local cleanup scope from its own
 * credential store lookup prior to calling revoke (since scope is not echoed
 * back).
 */
export interface RevokeKeyResult {
  keyId: string;
  revokedAt: string;
}

/** A single row from GET /api/keys. */
export interface ListedKey {
  id: string;
  projectId: string | null;
  projectSlug: string | null;
  parentKeyId: string | null;
  label: string | null;
  issuedVia: 'device_code' | 'registration_auto' | 'manual_generate' | string;
  lastUsedAt: string | null;
  revokeAt: string | null;
  createdAt: string;
}

/** Envelope returned by GET /api/keys. */
export interface ListKeysResult {
  keys: ListedKey[];
}

/** Result from POST /api/sync/sqlite-backfill — bulk file-based sync. */
export interface SyncSqliteFileResult {
  success: boolean;
  counts: Record<string, number>;
  errors: string[];
  durationMs: number;
}

/** Result from POST /api/sync/purge — purge confirmation. */
export interface PurgeMirrorResult {
  purgedProject: string;
  tablesCleared: string[];
  rowsDeleted: number;
}

/**
 * s95-m08: what the dashboard's purge route answers (cmos-dashboard src/routes/sync.ts): the rows
 * deleted per table, under the dashboard's own slug for the project.
 */
interface PurgeMirrorAnswer {
  readonly projectSlug?: string;
  readonly purged?: Record<string, number>;
}

/**
 * A single event from GET /api/sync/projects/:slug/events (Sprint 71 m02 PULL).
 * Mirrors the broker's MirrorSyncEvent shape.
 */
export interface PulledSyncEvent {
  /** rbook_sync_log.id — the broker-assigned monotonic pull cursor for this event. */
  cursor: number;
  eventType: string;
  /**
   * The stored event envelope, verbatim: { projectId, projectName, eventType,
   * timestamp, data, senderUserId }. Genesis provenance rides inside `data`
   * (camelCase, from the s71-m01/m02 emitter) — the dashboard stores and echoes
   * `data` unmodified, so whatever was pushed round-trips here.
   */
  payload: unknown;
  receivedAt: string;
  processed: boolean;
  error: string | null;
}

/** Response from GET /api/sync/projects/:slug/events?since=<cursor>. */
export interface PullEventsResult {
  events: PulledSyncEvent[];
  /** Cursor to pass as ?since= on the next pull — the last event's cursor, or the
   *  input `since` unchanged when the page is empty. */
  nextCursor: number;
  hasMore: boolean;
  returnedCount: number;
}

/**
 * A mutable-surface LWW conflict recorded by the broker (Sprint 71 m04). Mirrors
 * the dashboard's `ProjectConflict` plus the `youWereSuperseded` flag the push
 * response adds for the pushing client. `appliedValue` is the LWW winner;
 * `supersededValue` is the loser the superseded author can restore.
 */
export interface MutableConflict {
  id: string;
  fieldScope: string;
  entityId: string;
  field: string;
  appliedValue: string | null;
  appliedAuthorUserId: string | null;
  appliedOccurredAt: number | null;
  supersededValue: string | null;
  supersededAuthorUserId: string | null;
  supersededOccurredAt: number | null;
  detectedAt: string;
  resolved: boolean;
  /** True for the client whose pushed edit was the LWW loser. */
  youWereSuperseded: boolean;
}

/**
 * Response from POST /api/sync/events for a mutable-surface edit (Sprint 71 m04).
 * The broker returns `conflict` at the TOP level (NOT under `data`), so the
 * `request()` unwrapper passes the whole `{success, conflict?}` through.
 */
export interface MutablePushResult {
  success: boolean;
  conflict?: MutableConflict;
}

/** Advisory soft-lock field scopes (mirrors the dashboard's LockFieldScope). */
export type LockFieldScope = 'project_identity' | 'mission_active' | 'sprint_status';

/** A soft-lock row from the dashboard locks API (Sprint 71 m05). 30-min TTL. */
export interface ProjectLock {
  fieldScope: string;
  holderUserId: string;
  holderDisplayName: string | null;
  holderEmail: string;
  acquiredAt: string;
  expiresAt: string;
  /** DB-clock evaluation: expiresAt < NOW(). An expired lock is takeover-eligible. */
  expired: boolean;
}

/**
 * Outcome of acquire/takeover. `ok` true → we now hold the lock. On contention the
 * acquire route returns 409 with the holder + `reason` ('held' = active, another
 * member holds it; 'expired' = takeover-eligible); takeover returns 409 with no
 * reason when the lock is still active.
 */
export type LockResult =
  | { ok: true; lock: ProjectLock }
  | { ok: false; lock: ProjectLock | null; reason: 'held' | 'expired' | 'active' };

/**
 * Genesis provenance carried on each /state entity row (Sprint 71 m03; dashboard
 * ASK 2). occurredAt/originSeq are BIGINT carried VERBATIM as STRINGS (raw ms-epoch
 * / per-client counter, no Number/Date coercion on the wire); schemaVersion is a
 * number. All NULL in single-user mode today; populated once a shared push carries
 * them. The clone preserves them verbatim (never re-stamps).
 */
export interface SyncStateProvenance {
  stableEventId: string | null;
  occurredAt: string | null;
  originSeq: string | null;
  schemaVersion: number | null;
}

export interface SyncStateSprint extends SyncStateProvenance {
  id: string;
  title: string | null;
  status: string | null;
  focus: string | null;
  totalMissions: number | null;
  completedMissions: number | null;
  syncedAt: string;
}

export interface SyncStateMission extends SyncStateProvenance {
  id: string;
  sprintId: string | null;
  name: string | null;
  status: string | null;
  objective: string | null;
  startedAt: string | null;
  completedAt: string | null;
  syncedAt: string;
}

export interface SyncStateSession extends SyncStateProvenance {
  id: string;
  type: string | null;
  title: string | null;
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  syncedAt: string;
}

export interface SyncStateDecision extends SyncStateProvenance {
  id: number;
  decisionText: string | null;
  category: string | null;
  sprintId: string | null;
  sessionId: string | null;
  missionId: string | null;
  createdAt: string | null;
  syncedAt: string;
}

export interface SyncStateLearning extends SyncStateProvenance {
  id: number;
  content: string | null;
  category: string | null;
  sprintId: string | null;
  createdAt: string | null;
  syncedAt: string;
}

export interface SyncStateDependency {
  fromId: string;
  toId: string;
  type: string;
  syncedAt: string;
}

export interface SyncStateContext {
  id: string;
  updatedAt: string | null;
  syncedAt: string;
}

export interface SyncStateMetadataEntry {
  key: string;
  value: string;
  syncedAt: string;
}

/** Per-project sync-log counters + high-water cursor (Sprint 71 m03; dashboard ASK 1). */
export interface SyncStateSyncLog {
  totalEntries: number;
  processedEntries: number;
  failedEntries: number;
  /** COALESCE(MAX(rbook_sync_log.id), 0) — seed the PULL cursor here, then tail-pull. */
  maxCursor: number;
}

/**
 * Per-project sync state from GET /api/sync/projects/:slug/state. Returns the
 * CURRENT mutable state of every entity (the clone source — an event replay can't
 * reconstruct current status). `contexts`/`metadata`/`syncLog` are optional so a
 * pre-deploy dashboard (without the m03 additions) still parses; the clone degrades
 * gracefully (cursor falls back to 0 with a warning).
 */
export interface SyncProjectStateResult {
  project: {
    id: string;
    slug: string;
    name: string;
    schemaVersion: string | null;
    createdAt: string;
    updatedAt: string;
  };
  sprints: SyncStateSprint[];
  missions: SyncStateMission[];
  sessions: SyncStateSession[];
  decisions: SyncStateDecision[];
  learnings: SyncStateLearning[];
  dependencies: SyncStateDependency[];
  contexts?: SyncStateContext[];
  metadata?: SyncStateMetadataEntry[];
  syncLog?: SyncStateSyncLog;
}

// ─── DashboardClient ─────────────────────────────────────────────────────────

/**
 * HTTP client for the cmos-dashboard REST API.
 *
 * Authenticates with user credentials via /api/auth/login,
 * caches the JWT, and re-authenticates when expired.
 * All methods return RbookToolResult for consistent error handling.
 */
export class DashboardClient {
  /**
   * The dashboard origin this client talks to, after trailing-slash normalization.
   *
   * s86-m07 — exposed read-only so a caller can key a per-ORIGIN cache (the send-path
   * ambiguity lookup in rbook-message.ts) without reaching into credential state. It is the
   * one field of this client that is not a secret and not per-project.
   */
  get dashboardOrigin(): string {
    return this.baseUrl;
  }

  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly authMethod: 'apiKey' | 'jwt';

  /** Cached auth token */
  private cachedToken: string | null = null;
  /** Token expiry time (ms since epoch) */
  private tokenExpiresAt: number = 0;
  /** Cached user identity from last login */
  private cachedIdentity: DashboardUserIdentity | null = null;
  /**
   * Dashboard-side keyId of the user-scoped credential authenticating this client,
   * when known. Used by `registerProject()` to stamp `parentKeyId` on the auto-issued
   * project-scoped key captured into the local store.
   *
   * s87-m07 — SET BY BOTH ENTRY POINTS, not just `fromEnvForProject`. Since s86-m06 there is
   * exactly ONE `setAuthenticatingKeyId` call in this file, and it lives in the shared private
   * user-scoped resolution chain that `fromEnvForProject` AND `fromEnvForUser` both reach.
   * Crediting one of them was true when written and stopped being true when the chain was
   * extracted.
   */
  private _authenticatingKeyId: string | undefined;
  /** Buffer before expiry to trigger re-auth (30 seconds) */
  private static readonly EXPIRY_BUFFER_MS = 30_000;

  constructor(config: DashboardClientConfig) {
    if (isDirectoryEdition()) throw new Error(directoryEditionError().suggestion);
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 10_000;

    if (config.apiKey) {
      this.authMethod = 'apiKey';
      this.cachedToken = config.apiKey;
      this.tokenExpiresAt = Infinity;
      this.email = '';
      this.password = '';
    } else {
      this.authMethod = 'jwt';
      this.email = config.email ?? '';
      this.password = config.password ?? '';
    }
  }

  /**
   * Create a DashboardClient from environment variables.
   * Returns an error result if not configured.
   */
  static fromEnv(overrides?: Partial<DashboardClientConfig>): RbookToolResult<DashboardClient> {
    if (isDirectoryEdition()) return createError(directoryEditionError());
    const baseUrl = resolveDashboardBaseUrl(overrides?.baseUrl);
    const apiKey = overrides?.apiKey ?? getSetting(RBOOK_DASHBOARD_API_KEY_ENV);

    // API key auth takes precedence over email/password
    if (apiKey) {
      return createSuccess(
        new DashboardClient({
          baseUrl,
          apiKey,
          timeoutMs: overrides?.timeoutMs,
        })
      );
    }

    // Fallback to email/password auth
    const email = overrides?.email ?? getSetting(RBOOK_DASHBOARD_USER_ENV);
    const password = overrides?.password ?? getSetting(RBOOK_DASHBOARD_PASSWORD_ENV);

    if (!email || !password) {
      return createError(RbookErrors.dashboardNotConfigured());
    }

    return createSuccess(
      new DashboardClient({
        baseUrl,
        email,
        password,
        timeoutMs: overrides?.timeoutMs,
      })
    );
  }

  /**
   * Create a DashboardClient using the local CredentialStore minted by the
   * Sprint 57 device code flow.
   *
   * Resolution order:
   *   1. Explicit `apiKey` override (tests / callers bypassing the store).
   *   2. Project-scoped key in CredentialStore for `projectRoot` (set by m02
   *      auto-issue capture on `POST /api/projects/register-new`).
   *   3. Newest user-scoped key in CredentialStore (minted by device code
   *      flow; used before a project-scoped key has been issued for this root).
   *   4. Legacy `RBOOK_DASHBOARD_API_KEY` env var — carried forward so users
   *      who configured the env var directly before device code landed keep
   *      working.
   *   5. Email/password env vars — terminal fallback.
   *
   * `keySource` surfaces which arm fired so the eventual whoami + onboard
   * surface (m04) can show identitySource to the agent.
   */
  static async fromEnvForProject(
    projectRoot: string | undefined,
    overrides?: Partial<DashboardClientConfig> & { credentialStore?: CredentialStore }
  ): Promise<RbookToolResult<ResolvedDashboardClient>> {
    if (isDirectoryEdition()) return createError(directoryEditionError());
    const baseUrl = resolveDashboardBaseUrl(overrides?.baseUrl);

    const buildConfig = (apiKey: string): DashboardClientConfig =>
      apiKeyConfig(baseUrl, apiKey, overrides?.timeoutMs);

    // (1) Explicit override.
    if (overrides?.apiKey) {
      return createSuccess({
        client: new DashboardClient(buildConfig(overrides.apiKey)),
        keySource: 'user-scoped' as KeySource,
        matchedProjectRoot: null,
      });
    }

    const store = overrides?.credentialStore ?? (await CredentialStore.create());

    // (2) Project-scoped key in the credential store.
    if (projectRoot) {
      const projectKey = await store.getProjectKey(projectRoot);
      if (projectKey) {
        return createSuccess({
          client: new DashboardClient(buildConfig(projectKey.key)),
          keySource: 'project-scoped' as KeySource,
          matchedProjectRoot: path.resolve(projectRoot),
        });
      }
    }

    // (3) → (5) — the user-scoped chain, shared with `fromEnvForUser`.
    return DashboardClient.resolveUserScopedChain(store, baseUrl, overrides);
  }

  /**
   * s86-m06 — resolve a client for an operation whose credential MUST be
   * user-scoped, i.e. arms 3 → 4 → 5 only, deliberately skipping arm 2.
   *
   * WHY THIS EXISTS. `rbook_auth(action="reissue")` exists to repair a local
   * project-key row, so it is called exactly when that row is present-but-broken
   * — and arm 2 returns a project-scoped client on mere row EXISTENCE
   * (`CredentialStore.getProjectKey` is a map lookup with no revocation or
   * expiry concept). Routing reissue through `fromEnvForProject` therefore
   * authenticates the repair with the very credential being repaired, and leaves
   * `authenticatingKeyId` unset so the mint cannot be attributed. The fix is NOT
   * to stamp `authenticatingKeyId` in every arm: that field never reaches the
   * wire (the wire credential is `cachedToken`, set in the constructor and read
   * by `getAuthToken`), so a revoked project key would still 401 — and the
   * recorded `parentKeyId` would then name a user key that did not authorize the
   * mint, diverging from the dashboard's own binding to the CALLER's
   * parent_key_id and corrupting the mine-only filter in `rbook_auth(list)`.
   *
   * `userScopedKeyId` selects one exact saved user key through the shared attribution
   * chain, refusing a missing row instead of authenticating as another account.
   * Without that selection, arm 1 (explicit `apiKey` override) is honored here too.
   * It is the ONLY arm that can return `keySource: 'user-scoped'` with
   * `authenticatingKeyId === undefined`, which makes attribution failures separable.
   */
  static async fromEnvForUser(
    overrides?: Partial<DashboardClientConfig> & {
      credentialStore?: CredentialStore;
      /** Select exactly this saved user key; never fall back if it has disappeared. */
      userScopedKeyId?: string;
    }
  ): Promise<RbookToolResult<ResolvedDashboardClient>> {
    if (isDirectoryEdition()) return createError(directoryEditionError());
    const baseUrl = resolveDashboardBaseUrl(overrides?.baseUrl);

    // (1) Explicit override, unless the caller selected an attributable stored key.
    if (overrides?.apiKey && overrides.userScopedKeyId === undefined) {
      return createSuccess({
        client: new DashboardClient(apiKeyConfig(baseUrl, overrides.apiKey, overrides.timeoutMs)),
        keySource: 'user-scoped' as KeySource,
        matchedProjectRoot: null,
      });
    }

    const store = overrides?.credentialStore ?? (await CredentialStore.create());
    return DashboardClient.resolveUserScopedChain(store, baseUrl, overrides);
  }

  /**
   * Arms (3) newest user-scoped store key → (4) legacy `RBOOK_DASHBOARD_API_KEY`
   * → (5) email/password. Extracted in s86-m06 so `fromEnvForProject` and
   * `fromEnvForUser` share ONE copy of the chain: arm order and `keySource`
   * values are mirrored by nine call sites (rbook-status, the four sync modules,
   * rbook-db-backfill, checkpoint-backfill, rbook-message, and `deriveAuthTier`),
   * so a second copy that drifted would silently change which credential
   * authenticates ordinary sends.
   *
   * This is also the single home of the codebase's only authenticating-keyId
   * setter call — reachable from two entry points, still written once. Keep it
   * that way: stamping it in arm 1 or arm 2 records an attribution the wire
   * credential does not support.
   */
  private static async resolveUserScopedChain(
    store: CredentialStore,
    baseUrl: string,
    overrides?: Partial<DashboardClientConfig> & { userScopedKeyId?: string }
  ): Promise<RbookToolResult<ResolvedDashboardClient>> {
    // (3) The requested saved key, or the newest user-scoped key when none was requested.
    const userScopedKeys = await store.listUserScopedKeys();
    const selectedKeyId = overrides?.userScopedKeyId;
    if (
      selectedKeyId !== undefined &&
      !Object.prototype.hasOwnProperty.call(userScopedKeys, selectedKeyId)
    )
      return createError({
        ...RbookErrors.dashboardAuthFailed(baseUrl),
        message: 'The selected saved user key is no longer available.',
      });
    const pick =
      selectedKeyId === undefined
        ? pickNewestUserScopedKey(userScopedKeys)
        : { keyId: selectedKeyId, record: userScopedKeys[selectedKeyId] };
    if (pick) {
      const client = new DashboardClient(
        apiKeyConfig(baseUrl, pick.record.key, overrides?.timeoutMs)
      );
      client.setAuthenticatingKeyId(pick.keyId);
      return createSuccess({
        client,
        keySource: 'user-scoped' as KeySource,
        matchedProjectRoot: null,
      });
    }

    // (4) Legacy env-var user-scoped key.
    const envKey = getSetting(RBOOK_DASHBOARD_API_KEY_ENV);
    if (envKey) {
      warnLegacyAuth('legacy-env');
      return createSuccess({
        client: new DashboardClient(apiKeyConfig(baseUrl, envKey, overrides?.timeoutMs)),
        keySource: 'legacy-env' as KeySource,
        matchedProjectRoot: null,
      });
    }

    // (5) Email/password terminal fallback.
    const email = overrides?.email ?? getSetting(RBOOK_DASHBOARD_USER_ENV);
    const password = overrides?.password ?? getSetting(RBOOK_DASHBOARD_PASSWORD_ENV);
    if (!email || !password) {
      return createError(RbookErrors.dashboardNotConfigured());
    }

    warnLegacyAuth('password-fallback');
    return createSuccess({
      client: new DashboardClient({
        baseUrl,
        email,
        password,
        ...(overrides?.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
      }),
      keySource: 'password-fallback' as KeySource,
      matchedProjectRoot: null,
    });
  }

  /**
   * Authenticate with the dashboard and cache the token.
   */
  private async authenticate(): Promise<RbookToolResult<string>> {
    if (isDirectoryEdition()) return createError(directoryEditionError());
    const url = `${this.baseUrl}/api/auth/login`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ email: this.email, password: this.password }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 401 || response.status === 403) {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
        return createError(RbookErrors.dashboardAuthFailed(this.baseUrl));
      }

      if (!response.ok) {
        const text = await response.text().catch(() => 'Unknown error');
        return createError(
          RbookErrors.dashboardError(`Login failed: HTTP ${response.status}: ${text}`)
        );
      }

      const loginResponse = (await response.json()) as LoginResponse;
      this.cachedToken = loginResponse.data.token;
      this.tokenExpiresAt = new Date(loginResponse.data.expiresAt).getTime();
      this.cachedIdentity = {
        userId: loginResponse.data.user.id,
        email: loginResponse.data.user.email,
        username: loginResponse.data.user.username ?? null,
      };

      return createSuccess(this.cachedToken);
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return createError(
            RbookErrors.dashboardUnreachable(
              this.baseUrl,
              `Login timed out after ${this.timeoutMs}ms`
            )
          );
        }
        return createError(RbookErrors.dashboardUnreachable(this.baseUrl, error.message));
      }

      return createError(RbookErrors.dashboardUnreachable(this.baseUrl, 'Unknown network error'));
    }
  }

  /**
   * Get a valid auth token, re-authenticating if needed.
   */
  private async getAuthToken(): Promise<RbookToolResult<string>> {
    if (isDirectoryEdition()) return createError(directoryEditionError());
    // API keys are permanent — no expiry check, no login needed
    if (this.authMethod === 'apiKey') {
      return createSuccess(this.cachedToken!);
    }
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiresAt - DashboardClient.EXPIRY_BUFFER_MS) {
      return createSuccess(this.cachedToken);
    }
    return this.authenticate();
  }

  /**
   * s84-m02 — parse the dashboard's unified error envelope `{ error, hint }`
   * (dashboard m04) from a 4xx JSON body, best-effort. Returns `{}` when the body
   * is not JSON or carries neither field, so callers fall back to a generic message.
   * Reads the response body via `.json()`; pass a `.clone()` if the caller also
   * needs to read the body as text afterward.
   */
  private static async parseErrorEnvelope(
    response: Response
  ): Promise<{ detail?: string; hint?: string }> {
    const errorBody = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const detail = errorBody?.error ? String(errorBody.error) : undefined;
    const hint = errorBody?.hint ? String(errorBody.hint) : undefined;
    return { ...(detail ? { detail } : {}), ...(hint ? { hint } : {}) };
  }

  /**
   * Make an authenticated HTTP request to the dashboard.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    conflictError?: RbookToolError
  ): Promise<RbookToolResult<T>> {
    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) {
      return createError(tokenResult.error!);
    }

    const url = `${this.baseUrl}${path}`;
    const token = tokenResult.data!;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        ...(path === '/api/projects/me' ? { redirect: 'manual' as const } : {}),
      });

      if (path === '/api/projects/me') {
        // Keep the deadline alive through the body, including error bodies. Reusing a bounded
        // response preserves the existing status-specific error envelopes below.
        const raw = await boundedText(response, PROJECTS_MAX_RESPONSE_BYTES);
        if (raw === null)
          return createError(
            RbookErrors.dashboardError(
              `The projects response exceeds ${PROJECTS_MAX_RESPONSE_BYTES} bytes (4 MiB).`
            )
          );
        response = new Response(raw, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } else clearTimeout(timeout);

      if (response.status === 401 && this.authMethod === 'jwt') {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
      }

      // Only an endpoint that supplies its own conflict contract changes the generic 409 mapping.
      if (response.status === 409 && conflictError) {
        const { detail } = await DashboardClient.parseErrorEnvelope(response.clone());
        const reason = detail ?? (await response.text().catch(() => ''));
        return createError({
          ...conflictError,
          message: reason ? `${conflictError.message} ${reason}` : conflictError.message,
        });
      }

      if (!response.ok) {
        return createError(
          await dashboardHttpError(
            response,
            this.baseUrl,
            path,
            undefined,
            path === '/api/projects/me'
          )
        );
      }

      const json = (await response.json()) as Record<string, unknown>;
      // Dashboard API wraps responses in {success, data} envelope — unwrap it
      const data = (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
      return createSuccess(data);
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (controller.signal.aborted)
        return createError(
          RbookErrors.dashboardUnreachable(
            this.baseUrl,
            `Request timed out after ${this.timeoutMs}ms`
          )
        );

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return createError(
            RbookErrors.dashboardUnreachable(
              this.baseUrl,
              `Request timed out after ${this.timeoutMs}ms`
            )
          );
        }
        return createError(RbookErrors.dashboardUnreachable(this.baseUrl, error.message));
      }

      return createError(RbookErrors.dashboardUnreachable(this.baseUrl, 'Unknown network error'));
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── Public API Methods ──────────────────────────────────────────────────

  /**
   * Get the cached user identity from the last login.
   * Returns null if not yet authenticated.
   */
  get userIdentity(): DashboardUserIdentity | null {
    return this.cachedIdentity;
  }

  /**
   * `keyId` of the user-scoped credential that authenticated this client, if known.
   * Sprint 57 m02 — populated when a user-scoped key is picked from the credential store, by
   * EITHER `fromEnvForProject()` or `fromEnvForUser()`: s86-m06 extracted the pick into one
   * shared private chain with a single setter call, reachable from both. Callers capturing the
   * auto-issued register response stamp this into `parentKeyId` on the resulting project-scoped
   * record. (s87-m07 corrected the single-entry-point claim.)
   */
  get authenticatingKeyId(): string | undefined {
    return this._authenticatingKeyId;
  }

  /** Internal setter used by the factories when they know the keyId. */
  setAuthenticatingKeyId(keyId: string | undefined): void {
    this._authenticatingKeyId = keyId;
  }

  /**
   * Send a message to a target address.
   */
  async sendMessage(params: SendMessageParams): Promise<RbookToolResult<DashboardSendResponse>> {
    const body: Record<string, unknown> = {
      targetAddress: toDashboardAddress(params.targetAddress),
      type: params.type,
      summary: params.summary,
      body: params.body,
      evidence: params.evidence,
    };
    if (params.senderProjectId) {
      body.senderProjectId = params.senderProjectId;
    }
    if (params.fromProjectId) {
      body.fromProjectId = params.fromProjectId;
    }
    if (params.toProjectId) {
      body.toProjectId = params.toProjectId;
    }
    if (params.senderAddress) {
      body.senderAddress = toDashboardAddress(params.senderAddress);
    }
    const result = await this.request<DashboardSendResponse>('POST', '/api/messages', body);

    if (
      result.success &&
      result.data &&
      params.senderAddress &&
      result.data.senderAddress &&
      normalizeAddressScheme(result.data.senderAddress) !==
        normalizeAddressScheme(params.senderAddress)
    ) {
      console.warn(
        `[dashboard-client] senderAddress echo mismatch: sent ${params.senderAddress}, dashboard echoed ${result.data.senderAddress}`
      );
    }

    // Sprint 57 m04: capture the dashboard's identitySource ACK so whoami +
    // onboard can surface "still on legacy user-scoped key" as a warning.
    if (result.success && result.data?.deliveryAck?.identitySource) {
      // Lazy import to keep the dashboard-client free of upstream auth coupling
      // and to avoid a require cycle with src/auth.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { recordDeliveryAck } = require('../../auth/delivery-ack-cache') as {
        recordDeliveryAck: (s: 'api-key' | 'request-body' | 'none') => void;
      };
      recordDeliveryAck(result.data.deliveryAck.identitySource);
    }

    return result.success && result.data
      ? { ...result, data: normalizeMessageAddresses(result.data) }
      : result;
  }

  /**
   * List messages (inbox or sent).
   */
  async listMessages(params?: ListMessagesParams): Promise<RbookToolResult<ListMessagesResult>> {
    const query = new URLSearchParams();
    if (params?.tab) query.set('tab', params.tab);
    if (params?.status) query.set('status', params.status);
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    // s84-m02: only send offset when provided so omitting it reproduces the exact
    // pre-cutover call args (dashboard defaults offset to 0 server-side).
    if (params?.offset !== undefined) query.set('offset', String(params.offset));

    const queryString = query.toString();
    const path = `/api/messages${queryString ? `?${queryString}` : ''}`;

    const result = await this.request<ListMessagesResult>('GET', path);
    return result.success && result.data
      ? {
          ...result,
          data: { ...result.data, messages: result.data.messages.map(normalizeMessageAddresses) },
        }
      : result;
  }

  /**
   * s84-m02 — fetch a single message by id (dashboard m01: GET /api/messages/:id).
   * Authorized read-one returning the same slug/name fields as the list rows, with no
   * read/ack side-effect (safe to poll). The dashboard 404s a non-UUID id or a message
   * the caller cannot see; the shared request() maps that to DASHBOARD_NOT_FOUND, which
   * rbook_message.handleGet() catches to fall back to the pre-deploy paging scan.
   */
  async getMessageById(id: string): Promise<RbookToolResult<DashboardMessage>> {
    const result = await this.request<DashboardMessage | { message: DashboardMessage }>(
      'GET',
      `/api/messages/${encodeURIComponent(id)}`
    );
    const body = result.data;
    const message = body && typeof body === 'object' && 'message' in body ? body.message : body;
    return {
      ...result,
      data: message && typeof message === 'object' ? normalizeMessageAddresses(message) : undefined,
    };
  }

  /**
   * Respond to a message (accept, decline, or reply).
   */
  async respondToMessage(
    params: RespondToMessageParams
  ): Promise<RbookToolResult<DashboardMessage>> {
    const result = await this.request<DashboardMessage>(
      'POST',
      `/api/messages/${params.messageId}/respond`,
      { status: params.status, notes: params.notes },
      {
        code: 'MESSAGE_RESPONSE_CONFLICT',
        message: 'The message cannot accept this response in its current state.',
        suggestion:
          `Read its current state with rbook_message(action="get", messageId=${JSON.stringify(params.messageId)}) before choosing another response. ` +
          'If it already has a response, send a new message for any follow-up instead of retrying this response.',
      }
    );
    return result.success && result.data
      ? { ...result, data: normalizeMessageAddresses(result.data) }
      : result;
  }

  /**
   * Acknowledge (mark-read) a pending message (Sprint 72 m04). Status-only round-trip to
   * the dashboard's `POST /api/messages/:id/ack` (migration 031). Terminal pending →
   * 'acknowledged' — NOT a response (responded_at stays NULL; read_at is stamped). 409 if
   * the message is not pending; 403 if the caller is not the recipient.
   */
  async ackMessage(params: AckMessageParams): Promise<RbookToolResult<AckMessageResult>> {
    return this.request<AckMessageResult>('POST', `/api/messages/${params.messageId}/ack`);
  }

  /**
   * Resolve a rbook:// address to verify it exists.
   */
  async resolveAddress(
    params: ResolveAddressParams
  ): Promise<RbookToolResult<ResolveAddressResult>> {
    return this.request<ResolveAddressResult>(
      'GET',
      `/api/messages/resolve?address=${encodeURIComponent(toDashboardAddress(params.address))}`
    );
  }

  /**
   * List projects the authenticated account owns or that are shared with it.
   */
  async listDirectory(): Promise<RbookToolResult<ListDirectoryResult>> {
    const result = await this.request<ListDirectoryResult>('GET', '/api/projects/directory/public');
    if (!result.success || !result.data) {
      return result;
    }
    return createSuccess(normalizeProjectListResult(result.data));
  }

  /**
   * Get projects owned by the authenticated user.
   */
  async getMyProjects(): Promise<RbookToolResult<GetMyProjectsResult>> {
    const result = await this.request<GetMyProjectsResult>('GET', '/api/projects/me');
    if (!result.success || !result.data) {
      return result;
    }
    const user = result.data.user;
    const identity =
      user && typeof user.id === 'string' && user.id
        ? { id: user.id, username: typeof user.username === 'string' ? user.username : null }
        : undefined;
    return createSuccess({
      ...normalizeProjectListResult(result.data),
      ...(identity ? { user: identity } : {}),
    });
  }

  /**
   * s96-m02 (ADR s96 §10): keep the identity the dashboard returned for this client's credential,
   * so a write can name its author without calling the dashboard. Only a sign-in and a write path
   * call it, because reads never write (decision #1199); the identity is kept by the credential's
   * fingerprint and this dashboard's address, so another sign-in or dashboard never takes it. A
   * failure to keep it is reported, never fatal.
   */
  rememberIdentity(user: { readonly id: string; readonly username: string | null }): void {
    const credential =
      this.authMethod === 'apiKey' ? (this.cachedToken ?? '') : `password:${this.email}`;
    if (!credential || credential === 'password:') return;
    try {
      rememberDashboardIdentity(
        { userId: user.id, username: user.username, baseUrl: this.baseUrl },
        credential
      );
    } catch (error) {
      process.stderr.write(
        `[Reasonbook] the signed-in account's name could not be kept for author names: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
  }

  /**
   * Update only an existing project's local path. The dashboard's owner-only form endpoint
   * accepts bearer auth and confirms the write with this exact redirect; never follow a login
   * or cross-origin redirect and mistake the resulting HTML for a successful path update.
   */
  async updateLocalProjectPath(
    projectId: string,
    localDbPath: string
  ): Promise<RbookToolResult<void>> {
    if (!projectId.trim() || !localDbPath.trim())
      return createError(
        RbookErrors.dashboardError('A dashboard project id and local database path are required.')
      );
    const token = await this.getAuthToken();
    if (!token.success) return createError(token.error!);
    const id = encodeURIComponent(projectId);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/projects/${id}/local-path`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          Authorization: `Bearer ${token.data!}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ localDbPath }).toString(),
        signal: controller.signal,
      });
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (response.status === 401)
        return createError(RbookErrors.dashboardAuthFailed(this.baseUrl));
      if (response.status !== 302 || location !== `/projects/${id}/shares?status=path_updated`)
        return createError(
          RbookErrors.dashboardError(
            `Local-path update returned HTTP ${response.status} without its expected confirmation redirect.`
          )
        );
      return createSuccess(undefined);
    } catch (error) {
      return createError(
        RbookErrors.dashboardUnreachable(
          this.baseUrl,
          error instanceof Error ? error.message : String(error)
        )
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Push a sync event to the dashboard.
   * Used by checkpoint backfill.
   */
  async pushSyncEvent(envelope: Record<string, unknown>): Promise<RbookToolResult<void>> {
    return this.request<void>('POST', '/api/sync/events', envelope);
  }

  /**
   * Push a mutable-surface edit (e.g. `mission_updated`) to POST /api/sync/events
   * and return the broker's inline LWW outcome (Sprint 71 m04). Unlike
   * `pushSyncEvent` (fire-and-forget for the append-only bulk), the mutable path
   * needs the response's top-level `conflict` — `request()` returns the whole
   * `{success, conflict?}` body because there is no `data` envelope on this route.
   * The editor authenticates with their OWN credential (resolved upstream via
   * `fromEnvForProject`); `author_user_id` is stamped dashboard-authoritative.
   */
  async pushMutableEvent(
    envelope: Record<string, unknown>
  ): Promise<RbookToolResult<MutablePushResult>> {
    return this.request<MutablePushResult>('POST', '/api/sync/events', envelope);
  }

  /**
   * Like `request`, but returns the HTTP status alongside the parsed envelope and
   * does NOT special-case 401/403/404/409 (Sprint 71 m05). The lock + conflict
   * endpoints need the body of a 4xx (a 409 acquire carries the holder; a 403 is a
   * real authz denial, not token expiry), so this variant surfaces every HTTP
   * response and only errors on a transport/timeout failure. Parses JSON best-effort.
   */
  private async requestWithStatus<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<RbookToolResult<{ status: number; body: T | null }>> {
    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) {
      return createError(tokenResult.error!);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${tokenResult.data!}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const parsed = (await response.json().catch(() => null)) as T | null;
      return createSuccess({ status: response.status, body: parsed });
    } catch (error: unknown) {
      clearTimeout(timeout);
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? `Request timed out after ${this.timeoutMs}ms`
            : error.message
          : 'Unknown network error';
      return createError(RbookErrors.dashboardUnreachable(this.baseUrl, message));
    }
  }

  /**
   * s97-m10 (design §R2, contract v1 D2): one call on a dashboard-shared project's peer route. Any
   * JSON body in the engine's answer shape is the referee's answer whatever the status, so the body
   * comes back with the status for the caller to read. A large request goes gzip-compressed, since
   * the dashboard's request limit applies after decompression.
   */
  async relayPeerCall(
    projectId: string,
    request: { readonly method: string; readonly params?: unknown; readonly replicaId: string },
    options: { readonly timeoutMs?: number; readonly maxResponseBytes?: number } = {}
  ): Promise<RbookToolResult<{ status: number; body: unknown }>> {
    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) return createError(tokenResult.error!);
    const text = JSON.stringify(request);
    const zipped = Buffer.byteLength(text) > RELAY_GZIP_FROM_BYTES;
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? RELAY_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `${this.baseUrl}/api/relay/projects/${encodeURIComponent(projectId)}/peer`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenResult.data!}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(zipped ? { 'Content-Encoding': 'gzip' } : {}),
          },
          body: zipped ? gzipSync(text) : text,
          signal: controller.signal,
          // A redirect is answered as it stands: this machine's key goes to no other address.
          redirect: 'manual',
        }
      );
      const raw = await boundedText(response, options.maxResponseBytes ?? RELAY_MAX_RESPONSE_BYTES);
      if (raw === null) {
        controller.abort();
        return createError(
          RbookErrors.dashboardError(
            `the dashboard answered more than ${options.maxResponseBytes ?? RELAY_MAX_RESPONSE_BYTES} bytes to one call, so this copy stopped reading`
          )
        );
      }
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // Not JSON, such as a proxy's page: the caller reads the status.
      }
      return createSuccess({ status: response.status, body });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.name === 'AbortError'
            ? `Request timed out after ${timeoutMs}ms`
            : error.message
          : 'Unknown network error';
      return createError(RbookErrors.dashboardUnreachable(this.baseUrl, message));
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * s97-m11 (contract v1 D2, D6, #1494): a call on a dashboard-shared project's referee route —
   * the owner's upload at handover in, the join answer, or a discard — with the same reading as a
   * peer call: an engine-shaped body is the referee's answer whatever the status. No redirect is
   * followed, and the answer is read up to a bound.
   */
  async relayRefereeCall(
    projectId: string,
    call:
      | { readonly kind: 'upload'; readonly file: string }
      | { readonly kind: 'answer'; readonly answer: unknown }
      | { readonly kind: 'discard' }
  ): Promise<RbookToolResult<{ status: number; body: unknown }>> {
    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) return createError(tokenResult.error!);
    const base = `${this.baseUrl}/api/relay/projects/${encodeURIComponent(projectId)}/referee`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RELAY_UPLOAD_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${tokenResult.data!}`,
        Accept: 'application/json',
      };
      const init: RequestInit & { duplex?: 'half' } =
        call.kind === 'upload'
          ? {
              method: 'POST',
              headers: {
                ...headers,
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(statSync(call.file).size),
              },
              body: Readable.toWeb(createReadStream(call.file)) as unknown as RequestInit['body'],
              duplex: 'half',
            }
          : call.kind === 'answer'
            ? {
                method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' },
                body: JSON.stringify({ answer: call.answer }),
              }
            : { method: 'DELETE', headers };
      const response = await fetch(call.kind === 'answer' ? `${base}/answer` : base, {
        ...init,
        signal: controller.signal,
        redirect: 'manual',
      });
      const raw = await boundedText(response, RELAY_MAX_RESPONSE_BYTES);
      if (raw === null) {
        controller.abort();
        return createError(
          RbookErrors.dashboardError(
            `the dashboard answered more than ${RELAY_MAX_RESPONSE_BYTES} bytes to one call, so this copy stopped reading`
          )
        );
      }
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // Not JSON, such as a proxy's page: the caller reads the status.
      }
      return createSuccess({ status: response.status, body });
    } catch (error: unknown) {
      return createError(
        RbookErrors.dashboardUnreachable(
          this.baseUrl,
          error instanceof Error ? error.message : 'Unknown network error'
        )
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Upload one immutable recovery contribution; the host binds its receipt to this recovery and copy. */
  async relayRecoveryCopy(
    projectId: string,
    call: { readonly recoveryId: string; readonly replicaId: string; readonly file: string }
  ): Promise<RbookToolResult<{ status: number; body: unknown }>> {
    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) return createError(tokenResult.error!);
    const query = new URLSearchParams({ recoveryId: call.recoveryId, replicaId: call.replicaId });
    const url = `${this.baseUrl}/api/relay/projects/${encodeURIComponent(projectId)}/recovery/copy?${query}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RELAY_UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenResult.data!}`,
          Accept: 'application/json',
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(statSync(call.file).size),
        },
        body: Readable.toWeb(createReadStream(call.file)) as unknown as RequestInit['body'],
        duplex: 'half',
        signal: controller.signal,
        redirect: 'manual',
      } as RequestInit & { duplex: 'half' });
      const raw = await boundedText(response, RELAY_MAX_RESPONSE_BYTES);
      if (raw === null) {
        controller.abort();
        return createError(
          RbookErrors.dashboardError(
            `the dashboard answered more than ${RELAY_MAX_RESPONSE_BYTES} bytes to one recovery upload, so this copy stopped reading`
          )
        );
      }
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        /* The caller reports a non-JSON status. */
      }
      return createSuccess({ status: response.status, body });
    } catch (error: unknown) {
      return createError(
        RbookErrors.dashboardUnreachable(
          this.baseUrl,
          error instanceof Error ? error.message : 'Unknown network error'
        )
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * s97-m11 (contract v1 D5): stream a dashboard-shared project's first copy to `destPath`, never
   * past `maxBytes`; a body that is not the copy (an error) comes back as the status and the answer.
   */
  async downloadFirstCopy(
    projectId: string,
    destPath: string,
    maxBytes: number = FIRST_COPY_MAX_BYTES
  ): Promise<RbookToolResult<{ status: number; body: unknown; bytes: number }>> {
    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) return createError(tokenResult.error!);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RELAY_UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${this.baseUrl}/api/relay/projects/${encodeURIComponent(projectId)}/first-copy`,
        {
          headers: { Authorization: `Bearer ${tokenResult.data!}` },
          signal: controller.signal,
          redirect: 'manual',
        }
      );
      if (response.status !== 200 || !response.body) {
        const raw = await boundedText(response, RELAY_MAX_RESPONSE_BYTES);
        let body: unknown = raw;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          // The status says it.
        }
        return createSuccess({ status: response.status, body, bytes: 0 });
      }
      let bytes = 0;
      const bounded = async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) throw new Error(`the first copy is larger than ${maxBytes} bytes`);
          yield chunk;
        }
      };
      // Only a file this call created is taken away again: 'wx' refuses one already there.
      const out = createWriteStream(destPath, { flags: 'wx' });
      let created = false;
      out.once('open', () => {
        created = true;
      });
      try {
        await pipeline(response.body as unknown as AsyncIterable<Uint8Array>, bounded, out);
      } catch (error) {
        if (created) rmSync(destPath, { force: true });
        throw error;
      }
      return createSuccess({ status: 200, body: null, bytes });
    } catch (error: unknown) {
      return createError(
        RbookErrors.dashboardUnreachable(
          this.baseUrl,
          error instanceof Error ? error.message : 'Unknown network error'
        )
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * s97-m11 (contract v1 D9): whether the dashboard lists a project for this account, and whether it
   * still shares it through itself (`dashboardShared`).
   */
  async dashboardSharing(
    projectId: string
  ): Promise<RbookToolResult<{ readonly listed: boolean; readonly shared: boolean | null }>> {
    const me = await this.request<{
      projects?: Array<{ id?: unknown; dashboardShared?: unknown }>;
    }>('GET', '/api/projects/me');
    if (!me.success) return createError(me.error!);
    const project = (me.data?.projects ?? []).find((entry) => entry.id === projectId);
    return createSuccess({
      listed: project !== undefined,
      shared: typeof project?.dashboardShared === 'boolean' ? project.dashboardShared : null,
    });
  }

  /**
   * s97-m11 (contract v1 D9): the record protocol the dashboard's referee library speaks for a
   * project, or null when it names none.
   */
  async refereeProtocol(projectId: string): Promise<RbookToolResult<number | null>> {
    const result = await this.refereeCapabilities(projectId);
    return result.success ? createSuccess(result.data!.recordProtocol) : createError(result.error!);
  }

  /** Read both capability gates from the same authenticated project-list response. */
  async refereeCapabilities(projectId: string): Promise<
    RbookToolResult<{
      readonly version: string | null;
      readonly recordProtocol: number | null;
    }>
  > {
    const me = await this.request<{
      projects?: Array<{
        id?: unknown;
        referee?: { version?: unknown; protocol?: { record?: unknown } } | null;
      }>;
    }>('GET', '/api/projects/me');
    if (!me.success) return createError(me.error!);
    const referee = (me.data?.projects ?? []).find((project) => project.id === projectId)?.referee;
    const record = referee?.protocol?.record;
    return createSuccess({
      version: typeof referee?.version === 'string' ? referee.version : null,
      recordProtocol: typeof record === 'number' && Number.isInteger(record) ? record : null,
    });
  }

  /**
   * s97-m10 (contract v1 D9): the request limit the dashboard publishes for a shared project, or null
   * when it names none. Read from the raw project list, whose normalised rows keep no capability.
   */
  async refereeRequestLimit(projectId: string): Promise<RbookToolResult<number | null>> {
    const me = await this.request<{
      projects?: Array<{ id?: unknown; referee?: { requestLimit?: unknown } | null }>;
    }>('GET', '/api/projects/me');
    if (!me.success) return createError(me.error!);
    const limit = (me.data?.projects ?? []).find((project) => project.id === projectId)?.referee
      ?.requestLimit;
    return createSuccess(
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : null
    );
  }

  /**
   * Query a project's advisory soft-locks (Sprint 71 m05). Any member may read them.
   * `platformProjectId` is the platform `projects.id` (resolve via getMyProjects by
   * slug — NOT the rbook_projects.id that /state returns).
   */
  async queryLocks(platformProjectId: string): Promise<RbookToolResult<{ locks: ProjectLock[] }>> {
    const r = await this.requestWithStatus<{ data?: { locks?: ProjectLock[] } }>(
      'GET',
      `/api/projects/${encodeURIComponent(platformProjectId)}/locks`
    );
    if (!r.success || !r.data)
      return createError(r.error ?? RbookErrors.dashboardError('Lock query failed'));
    if (r.data.status !== 200) {
      return createError(RbookErrors.dashboardError(`Lock query HTTP ${r.data.status}`));
    }
    return createSuccess({ locks: r.data.body?.data?.locks ?? [] });
  }

  /**
   * Acquire a soft-lock on a field scope (Sprint 71 m05). 200 → we hold it; 409 →
   * another member holds it, with `reason` ('held' = active, 'expired' = takeover-
   * eligible) and the holder for surfacing. Writers only (a 403 surfaces as an error).
   */
  async acquireLock(
    platformProjectId: string,
    fieldScope: LockFieldScope
  ): Promise<RbookToolResult<LockResult>> {
    const r = await this.requestWithStatus<{
      data?: { lock?: ProjectLock; reason?: 'held' | 'expired' };
    }>('POST', `/api/projects/${encodeURIComponent(platformProjectId)}/locks`, { fieldScope });
    if (!r.success || !r.data)
      return createError(r.error ?? RbookErrors.dashboardError('Lock acquire failed'));
    if (r.data.status === 200 && r.data.body?.data?.lock) {
      return createSuccess<LockResult>({ ok: true, lock: r.data.body.data.lock });
    }
    if (r.data.status === 409) {
      return createSuccess<LockResult>({
        ok: false,
        lock: r.data.body?.data?.lock ?? null,
        reason: r.data.body?.data?.reason ?? 'held',
      });
    }
    return createError(RbookErrors.dashboardError(`Lock acquire HTTP ${r.data.status}`));
  }

  /**
   * Take over an EXPIRED lock and notify the prior holder (Sprint 71 m05). 200 → we
   * now hold it; 409 → the lock is still active and cannot be taken over.
   */
  async takeoverLock(
    platformProjectId: string,
    fieldScope: LockFieldScope
  ): Promise<RbookToolResult<LockResult>> {
    const r = await this.requestWithStatus<{ data?: { lock?: ProjectLock } }>(
      'POST',
      `/api/projects/${encodeURIComponent(platformProjectId)}/locks/${encodeURIComponent(
        fieldScope
      )}/takeover`
    );
    if (!r.success || !r.data)
      return createError(r.error ?? RbookErrors.dashboardError('Lock takeover failed'));
    if (r.data.status === 200 && r.data.body?.data?.lock) {
      return createSuccess<LockResult>({ ok: true, lock: r.data.body.data.lock });
    }
    if (r.data.status === 409) {
      return createSuccess<LockResult>({
        ok: false,
        lock: r.data.body?.data?.lock ?? null,
        reason: 'active',
      });
    }
    return createError(RbookErrors.dashboardError(`Lock takeover HTTP ${r.data.status}`));
  }

  /** Release a lock we hold (Sprint 71 m05). No-op server-side if we do not hold it. */
  async releaseLock(
    platformProjectId: string,
    fieldScope: LockFieldScope
  ): Promise<RbookToolResult<{ released: boolean }>> {
    const r = await this.requestWithStatus<{ data?: { released?: boolean } }>(
      'POST',
      `/api/projects/${encodeURIComponent(platformProjectId)}/locks/${encodeURIComponent(
        fieldScope
      )}/release`
    );
    if (!r.success || !r.data)
      return createError(r.error ?? RbookErrors.dashboardError('Lock release failed'));
    if (r.data.status !== 200) {
      return createError(RbookErrors.dashboardError(`Lock release HTTP ${r.data.status}`));
    }
    return createSuccess({ released: r.data.body?.data?.released ?? false });
  }

  /**
   * List a project's mutable-surface conflicts (Sprint 71 m05, deferred from m04).
   * `platformProjectId` is the platform `projects.id` (resolve via getMyProjects by
   * slug). Defaults to unresolved-only; pass `unresolvedOnly: false` for the full set.
   */
  async getProjectConflicts(
    platformProjectId: string,
    opts?: { unresolvedOnly?: boolean; entityId?: string }
  ): Promise<RbookToolResult<{ conflicts: MutableConflict[] }>> {
    const query = new URLSearchParams();
    if (opts?.unresolvedOnly === false) query.set('unresolvedOnly', 'false');
    if (opts?.entityId) query.set('entityId', opts.entityId);
    const qs = query.toString();
    return this.request<{ conflicts: MutableConflict[] }>(
      'GET',
      `/api/projects/${encodeURIComponent(platformProjectId)}/conflicts${qs ? `?${qs}` : ''}`
    );
  }

  /**
   * Restore a superseded mutable value — re-applies `superseded_value`, marks resolved
   * (Sprint 71 m05). Server-enforced: only the superseded author or the project owner
   * may restore. `platformProjectId` is the platform `projects.id`.
   */
  async restoreConflict(
    platformProjectId: string,
    conflictId: string
  ): Promise<RbookToolResult<{ conflict: MutableConflict }>> {
    return this.request<{ conflict: MutableConflict }>(
      'POST',
      `/api/projects/${encodeURIComponent(platformProjectId)}/conflicts/${encodeURIComponent(
        conflictId
      )}/restore`
    );
  }

  /**
   * Get sync reconciliation status from the dashboard.
   * Returns per-table row counts in the PG mirror.
   */
  async getSyncStatus(projectSlug?: string): Promise<RbookToolResult<SyncStatusResult>> {
    const query = projectSlug ? `?projectSlug=${encodeURIComponent(projectSlug)}` : '';
    return this.request<SyncStatusResult>('GET', `/api/sync/status${query}`);
  }

  /**
   * Get full project sync state from the dashboard.
   * Returns all synced entities for a specific project.
   */
  async getSyncProjectState(slug: string): Promise<RbookToolResult<SyncProjectStateResult>> {
    return this.request<SyncProjectStateResult>(
      'GET',
      `/api/sync/projects/${encodeURIComponent(slug)}/state`
    );
  }

  /**
   * Incremental PULL: fetch mirror events for a project with cursor > since,
   * ordered by rbook_sync_log.id ascending (Sprint 71 m02 — the missing half of
   * the sync loop). Membership-scoped server-side (owner or active share), so an
   * editor/collaborator can pull a shared project. Returns ONE bounded page; the
   * caller (sync-pull.ts) pages until hasMore=false. The cursor is independent of
   * the emitter's provenance columns, so it works even while those are NULL.
   */
  async getProjectEventsSince(
    slug: string,
    since: number,
    limit?: number
  ): Promise<RbookToolResult<PullEventsResult>> {
    const query = new URLSearchParams();
    query.set('since', String(since));
    if (limit !== undefined) {
      query.set('limit', String(limit));
    }
    return this.request<PullEventsResult>(
      'GET',
      `/api/sync/projects/${encodeURIComponent(slug)}/events?${query.toString()}`
    );
  }

  /**
   * Purge all mirrored data for a project from the PG mirror.
   * Used before re-backfill to ensure clean state.
   */
  async purgeMirror(
    projectSlug: string,
    expectedSlug?: string
  ): Promise<RbookToolResult<PurgeMirrorResult>> {
    if (expectedSlug && canonicalizeSlug(projectSlug) !== canonicalizeSlug(expectedSlug)) {
      return expectedSlugMismatchError(
        'mirror purge',
        canonicalizeSlug(expectedSlug),
        canonicalizeSlug(projectSlug)
      );
    }

    const result = await this.request<PurgeMirrorAnswer>('POST', '/api/sync/purge', {
      projectSlug,
      confirm: true,
    });

    // 404 means the project doesn't exist in PG yet — nothing to purge, treat as success
    if (!result.success && result.error?.code === 'DASHBOARD_NOT_FOUND') {
      return createSuccess<PurgeMirrorResult>({
        purgedProject: projectSlug,
        tablesCleared: [],
        rowsDeleted: 0,
      });
    }
    // s95-m08: the purge succeeded, so the answer must not then fail on the dashboard's field names,
    // nor report counts the dashboard did not send.
    if (result.success && result.data) {
      const counts = result.data.purged;
      if (!counts || typeof counts !== 'object') {
        return createSuccess<PurgeMirrorResult>(
          {
            purgedProject: result.data.projectSlug ?? projectSlug,
            tablesCleared: [],
            rowsDeleted: 0,
          },
          [
            'The dashboard accepted the purge but its answer named no tables, so how many rows it deleted is unknown.',
          ]
        );
      }
      const entries = Object.entries(counts);
      return {
        ...result,
        data: {
          purgedProject: result.data.projectSlug ?? projectSlug,
          tablesCleared: entries.map(([table]) => table),
          rowsDeleted: entries.reduce((sum, [, rows]) => sum + (Number(rows) || 0), 0),
        },
      };
    }

    return result as RbookToolResult<PurgeMirrorResult>;
  }

  /**
   * Register a project with the dashboard by uploading the SQLite database.
   * Used for auto-registration on first checkpoint.
   *
   * Endpoint: POST /api/projects/register-new (multipart/form-data)
   * - 201: New registration
   * - 409: Existing owner/name refused; no re-registration or purge
   */
  /**
   * POST the local SQLite file as multipart/form-data to /api/sync/sqlite-backfill.
   * This is the bulk reconciliation path — idempotent, returns per-entity counts.
   * Uses an extended timeout (60s minimum) to accommodate large file uploads.
   */
  async syncSqliteFile(
    filePath: string,
    projectSlug: string,
    expectedSlug?: string
  ): Promise<RbookToolResult<SyncSqliteFileResult>> {
    if (expectedSlug && canonicalizeSlug(projectSlug) !== canonicalizeSlug(expectedSlug)) {
      return expectedSlugMismatchError(
        'SQLite sync',
        canonicalizeSlug(expectedSlug),
        canonicalizeSlug(projectSlug)
      );
    }

    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) {
      return createError(tokenResult.error!);
    }

    // Read the SQLite file
    let fileBuffer: Buffer;
    try {
      fileBuffer = readFileSync(filePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return createError(RbookErrors.dashboardError(`Failed to read SQLite file: ${msg}`));
    }

    // Build multipart form
    const blob = new Blob([fileBuffer], { type: 'application/x-sqlite3' });
    const formData = new FormData();
    formData.append('database', blob, LEGACY.databaseFile);
    formData.append('projectSlug', projectSlug);

    const url = `${this.baseUrl}/api/sync/sqlite-backfill`;
    const token = tokenResult.data!;
    const controller = new AbortController();
    // Use longer timeout for file upload (60s minimum)
    const uploadTimeoutMs = Math.max(this.timeoutMs, 60_000);
    const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          // Content-Type is set automatically by fetch for FormData
        },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 401 && this.authMethod === 'jwt') {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
      }
      if (!response.ok) {
        return createError(
          await dashboardHttpError(response, this.baseUrl, url, 'SQLite backfill failed', true)
        );
      }

      const json = (await response.json()) as Record<string, unknown>;
      const data = (
        json && typeof json === 'object' && 'data' in json ? json.data : json
      ) as SyncSqliteFileResult;
      return createSuccess(data);
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return createError(
            RbookErrors.dashboardUnreachable(
              this.baseUrl,
              `SQLite backfill timed out after ${uploadTimeoutMs}ms`
            )
          );
        }
        return createError(RbookErrors.dashboardUnreachable(this.baseUrl, error.message));
      }

      return createError(RbookErrors.dashboardUnreachable(this.baseUrl, 'Unknown network error'));
    }
  }

  async registerProject(params: {
    projectName: string;
    sqlitePath: string;
    localDbPath?: string;
    expectedSlug?: string;
  }): Promise<RbookToolResult<RegisterProjectResult>> {
    const derivedSlug = canonicalizeSlug(params.projectName);
    if (params.expectedSlug && derivedSlug !== canonicalizeSlug(params.expectedSlug)) {
      return expectedSlugMismatchError(
        'project registration',
        canonicalizeSlug(params.expectedSlug),
        derivedSlug
      );
    }

    const tokenResult = await this.getAuthToken();
    if (!tokenResult.success) {
      return createError(tokenResult.error!);
    }

    // Read the SQLite file
    let fileBuffer: Buffer;
    try {
      fileBuffer = readFileSync(params.sqlitePath);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      return createError(RbookErrors.dashboardError(`Failed to read SQLite file: ${msg}`));
    }

    // Build multipart form
    const blob = new Blob([fileBuffer], { type: 'application/x-sqlite3' });
    const formData = new FormData();
    formData.append('database', blob, LEGACY.databaseFile);
    formData.append('projectName', params.projectName);
    if (params.localDbPath) {
      formData.append('localDbPath', params.localDbPath);
    }

    // A separate endpoint makes older dashboards fail safely instead of ignoring a new flag.
    const url = `${this.baseUrl}/api/projects/register-new`;
    const token = tokenResult.data!;
    const controller = new AbortController();
    // Use longer timeout for file upload (60s minimum)
    const uploadTimeoutMs = Math.max(this.timeoutMs, 60_000);
    const timeout = setTimeout(() => controller.abort(), uploadTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          // Content-Type is set automatically by fetch for FormData
        },
        body: formData,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 401 && this.authMethod === 'jwt') {
        this.cachedToken = null;
        this.tokenExpiresAt = 0;
      }
      if (!response.ok) {
        return createError(
          await registrationError(response, this.baseUrl, url, params.projectName)
        );
      }

      const json = (await response.json()) as Record<string, unknown>;
      const data = (
        json && typeof json === 'object' && 'data' in json ? json.data : json
      ) as RegisterProjectResult;
      if (data.reregistered === true) {
        return createError({
          code: 'UNSAFE_REGISTRATION_RESPONSE',
          message:
            'The create-only endpoint returned a re-registration. Its identity was not adopted.',
          suggestion:
            'Check the dashboard create-only endpoint before retrying; it must refuse an existing owner/name instead of replacing it.',
        });
      }
      return createSuccess(data);
    } catch (error: unknown) {
      clearTimeout(timeout);

      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          return createError(
            RbookErrors.dashboardUnreachable(
              this.baseUrl,
              `Registration timed out after ${uploadTimeoutMs}ms`
            )
          );
        }
        return createError(RbookErrors.dashboardUnreachable(this.baseUrl, error.message));
      }

      return createError(RbookErrors.dashboardUnreachable(this.baseUrl, 'Unknown network error'));
    }
  }

  /**
   * Reissue a project-scoped key after partial-failure recovery.
   *
   * POSTs `/api/projects/:id/keys/reissue` with user-scoped `cmk_...` Bearer
   * auth (same auth mode as `/rotate`, `/revoke`, `/register`, `/keys`).
   * Dashboard revokes all prior project-scoped keys bound to the caller's
   * `parent_key_id` for this project and mints a fresh one, returning the
   * plaintext exactly once in the response body. No grace window — reissue
   * implies the current key is lost or compromised.
   *
   * Originally landed in Sprint 57 m02. Sprint 58 m03 live verification
   * (2026-04-22) exposed that the dashboard endpoint was rejecting user-scoped
   * Bearer with HTTP 400 "Reissue requires a logged-in dashboard session".
   * Sprint 59 m01 + dashboard s34-m02 (2026-04-23) fixed the drift — removed
   * the api-key rejection at dashboard projects.ts:740 and added an ownership
   * check matching the existing revoke route. The MCP-side contract
   * (cmk_ Bearer + `{key, keyId, label, revokedKeyIds}` response) did not
   * change — only the dashboard-side acceptance did.
   */
  async reissueProjectKey(projectId: string): Promise<RbookToolResult<ReissueProjectKeyResult>> {
    if (!projectId) {
      return createError(RbookErrors.dashboardError('reissueProjectKey: projectId is required'));
    }
    return this.request<ReissueProjectKeyResult>(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/keys/reissue`,
      {}
    );
  }

  /**
   * Rotate a project-scoped key with an optional grace window.
   *
   * Sprint 57 m03 — `POST /api/projects/:id/keys/rotate` mints a new project
   * key and schedules the old one for revocation in `graceSeconds` (default
   * 300 dashboard-side). Response fields: `newKey`, `newKeyId`, `oldKeyId`,
   * `revokeAt`. Local callers store the new key and hold the old one in
   * `pendingRevoke` so in-flight requests survive the grace window.
   */
  async rotateProjectKey(
    projectId: string,
    options: { graceSeconds?: number } = {}
  ): Promise<RbookToolResult<RotateProjectKeyResult>> {
    if (!projectId) {
      return createError(RbookErrors.dashboardError('rotateProjectKey: projectId is required'));
    }
    const body: Record<string, unknown> = {};
    if (options.graceSeconds !== undefined) {
      body.graceSeconds = options.graceSeconds;
    }
    return this.request<RotateProjectKeyResult>(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/keys/rotate`,
      body
    );
  }

  /**
   * Scope-aware unified revoke.
   *
   * Sprint 59 m02 / dashboard s34-m03 — `POST /api/keys/:keyId/revoke`. Works
   * for both user-scoped (`projectId IS NULL`) and project-scoped rows; the
   * dashboard infers scope from the key row and enforces ownership:
   *   - user-scoped: requester's `userId` must equal the key row's `user_id`
   *   - project-scoped: requester must own the project (same check as
   *     `/api/projects/:id/keys/revoke/:keyId`)
   *
   * Response envelope `{keyId, revokedAt}` matches the legacy project-scoped
   * endpoint byte-for-byte — deliberate parser-reuse per dashboard team
   * message 335c3a34 (2026-04-23). The inferred scope is NOT echoed back;
   * callers determine it from their own credential store before invoking.
   *
   * No grace window — the key is invalid as soon as this returns. Use `rotate`
   * when a grace window is wanted instead.
   */
  async revokeKey(keyId: string): Promise<RbookToolResult<RevokeKeyResult>> {
    if (!keyId) {
      return createError(RbookErrors.dashboardError('revokeKey: keyId is required'));
    }
    return this.request<RevokeKeyResult>(
      'POST',
      `/api/keys/${encodeURIComponent(keyId)}/revoke`,
      {}
    );
  }

  /**
   * Hard-revoke a project-scoped key immediately via the legacy project-scoped endpoint.
   *
   * Sprint 57 m03 — `POST /api/projects/:id/keys/revoke/:keyId`. No grace
   * window; the key is invalid from the dashboard's perspective as soon as
   * this returns. Kept unchanged per dashboard team commitment — the
   * profile.ejs key-management UI calls this endpoint directly and existing
   * callers keep working. New callers should prefer `revokeKey(keyId)` (the
   * Sprint 59 m02 unified surface), which also handles user-scoped rows.
   */
  async revokeProjectKey(
    projectId: string,
    keyId: string
  ): Promise<RbookToolResult<RevokeKeyResult>> {
    if (!projectId || !keyId) {
      return createError(
        RbookErrors.dashboardError('revokeProjectKey: projectId and keyId are required')
      );
    }
    return this.request<RevokeKeyResult>(
      'POST',
      `/api/projects/${encodeURIComponent(projectId)}/keys/revoke/${encodeURIComponent(keyId)}`,
      {}
    );
  }

  /**
   * List every key the authenticated credential can see.
   *
   * Sprint 57 m03 — `GET /api/keys`. Response is the full credential tree
   * (user-scoped rows where `projectId === null` plus their spawned
   * project-scoped children via `parentKeyId`). Callers apply the "mine-only"
   * filter locally by matching `parentKeyId` against their own credential
   * store's `userScopedKeys`.
   */
  async listKeys(): Promise<RbookToolResult<ListKeysResult>> {
    return this.request<ListKeysResult>('GET', '/api/keys');
  }
}
