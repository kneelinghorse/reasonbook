// ABOUTME: Agent-callable key lifecycle — rbook_auth(action=rotate|revoke|list|reissue|login|login_init|login_complete|logout).
// ABOUTME: Thin dispatcher over DashboardClient + CredentialStore so agents can self-heal credentials.

/**
 * `rbook_auth` consolidated tool — Sprint 57 m03 + Sprint 58 m01 + Sprint 59 m02/m03/m04.
 *
 * Gives agents self-service credential actions:
 *   - `rotate`         — mint a new project-scoped key, keep the old one in a
 *                         local `pendingRevoke` slot until the dashboard-scheduled
 *                         `revokeAt` timestamp so in-flight requests don't 401.
 *   - `revoke`         — hard-revoke a specific `keyId` (or the current project
 *                         key for `projectRoot`). Dashboard invalidates immediately;
 *                         local row is removed.
 *   - `list`           — return the dashboard's `GET /api/keys` tree, optionally
 *                         filtered to "mine only" (keys spawned by a user-scoped
 *                         credential currently in this MCP's local store).
 *   - `reissue`        — manual lost-key recovery. Wraps `recoverProjectKey`
 *                         (same endpoint, exposed as an explicit agent action).
 *   - `login`          — RFC 8628 device-code bootstrap as a single blocking call.
 *                         NOTE: The prompt is invisible in IDE MCP hosts (VSCode,
 *                         Cursor, Claude Desktop) because the tool blocks polling
 *                         for the full `expiresIn` window and captured-to-response
 *                         fields only render on tool return. Prefer `login_init`
 *                         + `login_complete` for agent-driven auth in chat. Kept
 *                         for terminal callers where stderr is visible, and for
 *                         scripts/bootstrap-device-code.ts parity.
 *   - `login_init`     — Sprint 59 m04: first leg of the IDE-safe two-call flow.
 *                         Calls `/api/auth/device/code`, returns
 *                         `{deviceCode, userCode, verificationUri, expiresIn,
 *                         interval}` immediately (no blocking) so the agent can
 *                         render the prompt to the user before the code expires.
 *   - `login_complete` — Sprint 59 m04: second leg. Polls `/api/auth/device/token`
 *                         within a bounded `maxWaitSeconds` window and returns
 *                         `{status: 'approved'|'pending'|'expired'|'denied', ...}`.
 *                         Agent calls this after the user approves in browser
 *                         (or repeatedly until terminal). On `approved`, persists
 *                         the minted user-scoped key via CredentialStore.
 *   - `logout`         — Sprint 59 m03: symmetric counterpart to login. Revokes
 *                         the current user-scoped key on the dashboard via the
 *                         unified `revokeKey(keyId)` (m02) and removes the local
 *                         row. Auto-picks the keyId when exactly one user-scoped
 *                         key is in the store; requires an explicit `keyId` when
 *                         there are multiple. Project-scoped children are left
 *                         alone — they remain valid standalone cmk_ bearers
 *                         server-side and their local rows stay intact.
 *
 * All return structured results so agents don't need to parse error strings.
 * `rotate` / `revoke` / `reissue` / `login` / `login_complete` are write
 * surfaces — they always persist (or explicitly report why they didn't) before
 * returning success.
 *
 * @module tools/rbook/rbook-auth
 */

import { z } from 'zod';
import type { ActionParamMap, RbookToolError, RbookToolResult } from './types';
import { createError, createSuccess, RbookErrors } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import {
  CredentialStore,
  type KeySource,
  type ProjectKeyRecord,
  type UserScopedKeyRecord,
} from '../../intelligence/credential-store';
import { DashboardClient, type ListedKey, resolveDashboardBaseUrl } from './dashboard-client';
import { forgetDashboardIdentity } from '../../intelligence/user-author';
import { withClientAsync } from './client';
import {
  classifyAttribution,
  describeAttributionArm,
  recoverProjectKey,
  type AttributionFailure,
} from '../../auth/project-key-capture';
import {
  DeviceCodeError,
  buildUserAgent,
  defaultPrompter,
  pollForTokenBounded,
  readPackageVersion,
  requestDeviceCode,
  runDeviceCodeFlow,
  type BoundedPollOptions,
  type BoundedPollStatus,
  type DeviceCodeResponse,
  type DeviceCodeFlowOptions,
  type DeviceTokenSuccess,
} from '../../auth/device-code';
import { appendWarnings } from './format-warnings';
import { dashboardOwnerError } from '../../auth/dashboard-owner';

export const RBOOK_AUTH_ACTIONS = [
  'rotate',
  'revoke',
  'list',
  'reissue',
  'login',
  'login_init',
  'login_complete',
  'logout',
] as const;
export type RbookAuthAction = (typeof RBOOK_AUTH_ACTIONS)[number];

/**
 * s86-m04 — which published parameter applies to which action (see action-params.ts).
 *
 * rbook_auth's router hands the WHOLE params object to each handler, so "forwarded" is true of
 * every key on every action and proves nothing. These lists come from what each handler READS:
 * `login` and `login_init` take no request parameter at all (rbook-auth.ts:487-490 pass only
 * process wiring), and `deviceCode`/`maxWaitSeconds`/`pollIntervalSeconds` belong to
 * `login_complete` alone.
 */
export const RBOOK_AUTH_ACTION_PARAMS: ActionParamMap<RbookAuthAction, RbookAuthParams> = {
  rotate: ['action', 'projectRoot', 'graceSeconds'],
  revoke: ['action', 'projectRoot', 'keyId'],
  list: ['action', 'projectRoot', 'mineOnly'],
  reissue: ['action', 'projectRoot'],
  login: ['action'],
  login_init: ['action'],
  login_complete: ['action', 'deviceCode', 'maxWaitSeconds', 'pollIntervalSeconds'],
  logout: ['action', 'projectRoot', 'keyId'],
};

const DEFAULT_LOGIN_COMPLETE_MAX_WAIT_SECONDS = 30;
const DEFAULT_LOGIN_COMPLETE_INTERVAL_SECONDS = 2;

export const rbookAuthSchema = z
  .object({
    action: z
      .enum(RBOOK_AUTH_ACTIONS)
      .describe(
        'Credential action: rotate | revoke | list | reissue | login | login_init | login_complete | logout'
      ),
    projectRoot: z
      .string()
      .optional()
      .describe(
        'Project root for rotate/revoke/reissue. Defaults to the caller context when absent.'
      ),
    keyId: z
      .string()
      .optional()
      .describe(
        'Specific dashboard-side keyId. revoke: omit to revoke the current project key for projectRoot. logout: omit when there is exactly one user-scoped key in the local store; required when there are multiple.'
      ),
    graceSeconds: z
      .number()
      .int()
      .positive()
      .max(86_400)
      .optional()
      .describe(
        'Grace window for rotate (default: dashboard-side 300s). Keeps old key live while in-flight requests complete.'
      ),
    mineOnly: z
      .boolean()
      .optional()
      .describe(
        'list only: when true (default), filter to keys spawned by a user-scoped key currently in this MCP store.'
      ),
    deviceCode: z
      .string()
      .optional()
      .describe(
        'login_complete only: deviceCode from a prior login_init call. The dashboard-side opaque handle for the pending approval.'
      ),
    maxWaitSeconds: z
      .number()
      .int()
      .positive()
      .max(600)
      .optional()
      .describe(
        'login_complete only: bound the poll window before returning status=pending (default 30s). Agent can re-call login_complete to keep polling.'
      ),
    pollIntervalSeconds: z
      .number()
      .int()
      .positive()
      .max(60)
      .optional()
      .describe(
        'login_complete only: base poll interval (default 2s). Pass the interval from login_init for best behavior; dashboard slow_down responses bump this internally.'
      ),
  })
  .strict();

export type RbookAuthParams = z.infer<typeof rbookAuthSchema>;

export interface RotateActionResult {
  action: 'rotate';
  projectId: string;
  newKeyId: string;
  oldKeyId: string;
  revokeAt: string;
  graceSeconds: number | null;
}

export interface RevokeActionResult {
  action: 'revoke';
  keyId: string;
  /**
   * Local-inferred scope (from the MCP's credential store). 'unknown' when
   * the keyId was not present locally — the dashboard still revoked it, but
   * no local cleanup applied. Dashboard does NOT echo scope back from
   * /api/keys/:keyId/revoke — we infer pre-revoke for cleanup routing.
   */
  scope: 'user' | 'project' | 'unknown';
  revokedAt: string;
}

export interface ListActionResult {
  action: 'list';
  mineOnly: boolean;
  userScoped: ListedKey[];
  projectScoped: ListedKey[];
  /** Count of rows filtered out when mineOnly=true. 0 when mineOnly=false. */
  filteredOut: number;
}

export interface ReissueActionResult {
  action: 'reissue';
  projectId: string;
  newKeyId: string;
  /**
   * s86-m06 — the keyIds the DASHBOARD reported revoking as part of this reissue
   * (previously hardcoded `[]`). Empty when the dashboard reported an empty list AND
   * when it reported no list at all — read `revokedKeyIdsReported` to tell those apart.
   */
  revokedKeyIds: string[];
  /**
   * s86-m06 — whether the dashboard's response actually carried a revoked-key list.
   * `false` means we do not know what was revoked, which is a different fact from
   * "nothing was revoked"; the rendered answer says so rather than asserting the
   * stronger claim. The response shape is not validated (nor verified from this repo).
   */
  revokedKeyIdsReported: boolean;
}

/**
 * Sprint 58 m01 — RFC 8628 device-code bootstrap result.
 *
 * `verificationUri`/`userCode`/`expiresIn`/`interval` come from the initial
 * `/api/auth/device/code` response (captured by the response-prompter) so IDE
 * MCP hosts render them in the tool payload rather than swallowing stderr.
 *
 * `keyId`/`label` come from the eventual `/api/auth/device/token` success body
 * after the user approves. The minted user-scoped key is persisted to the
 * credential store before this result is returned.
 */
export interface LoginActionResult {
  action: 'login';
  verificationUri: string;
  userCode: string;
  expiresIn: number;
  interval: number;
  keyId: string;
  label: string;
}

/**
 * Sprint 59 m04 — `login_init` result. First leg of the IDE-safe two-call
 * auth flow; returns device code response immediately (no blocking) so the
 * agent can surface userCode + verificationUri to the user before the code
 * expires. Pass `deviceCode` and `interval` back to `login_complete`.
 */
export interface LoginInitActionResult {
  action: 'login_init';
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

/**
 * Sprint 59 m04 — `login_complete` result. Second leg of the two-call flow.
 * `status` is one of four terminal states; transport / malformed failures
 * surface as `success: false` with code `DASHBOARD_ERROR`. On `approved`, the
 * minted user-scoped key is persisted before the result is returned.
 * `intervalSeconds` is set on `approved` / `pending` so the agent can carry
 * any `slow_down`-adjusted interval into the next `login_complete` call.
 */
export interface LoginCompleteActionResult {
  action: 'login_complete';
  status: 'approved' | 'pending' | 'expired' | 'denied';
  keyId?: string;
  label?: string;
  description?: string;
  intervalSeconds?: number;
}

/**
 * Sprint 59 m03 — `logout` result. Symmetric to login: revokes the current
 * user-scoped key on the dashboard and removes the local row. Project-scoped
 * children are not cascade-revoked — they remain standalone valid cmk_
 * bearers on the dashboard and in the local store.
 */
export interface LogoutActionResult {
  action: 'logout';
  keyId: string;
  revokedAt: string;
}

export type RbookAuthResult =
  | RotateActionResult
  | RevokeActionResult
  | ListActionResult
  | ReissueActionResult
  | LoginActionResult
  | LoginInitActionResult
  | LoginCompleteActionResult
  | LogoutActionResult;

export const rbookAuthToolDefinition = {
  name: 'rbook_auth',
  description:
    'Agent-callable credential lifecycle. Actions: login_init (non-blocking — starts RFC 8628 ' +
    'device-code flow, returns userCode + verificationUri immediately; agent renders them for ' +
    'user approval) + login_complete (polls within a bounded window; returns status ' +
    "'approved'|'pending'|'expired'|'denied'). Prefer login_init + login_complete for " +
    'agent-driven auth in chat — a single blocking login is invisible in IDE MCP hosts. ' +
    'login (legacy single-call blocking flow; kept for terminal callers where stderr is visible). ' +
    'logout (symmetric to login — revokes the current user-scoped key on the dashboard + clears the local row). ' +
    'rotate (mint new project key with grace window), revoke (hard-revoke a keyId), ' +
    'list (view credential tree, mine-only by default), reissue (recover a lost project key). ' +
    'All writes persist atomically to the local credential store; agents can call these ' +
    'directly without human intervention.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...RBOOK_AUTH_ACTIONS],
        description:
          'Credential action: rotate | revoke | list | reissue | login | login_init | login_complete | logout',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root for rotate/revoke/reissue. Defaults to caller context.',
      },
      keyId: {
        type: 'string',
        description:
          'Dashboard keyId. revoke: defaults to the current project key. logout: defaults to the sole local user-scoped key; required when there are several.',
      },
      graceSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: 86_400,
        description: 'Rotate grace window (default: 300s dashboard-side).',
      },
      mineOnly: {
        type: 'boolean',
        description:
          'list only: default true. When true, filter to keys spawned by a local user-scoped credential.',
      },
      deviceCode: {
        type: 'string',
        description:
          'login_complete only: deviceCode from a prior login_init call. Opaque dashboard-side handle.',
      },
      maxWaitSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: 600,
        description:
          'login_complete only: bound the poll window before returning status=pending (default 30s).',
      },
      pollIntervalSeconds: {
        type: 'integer',
        minimum: 1,
        maximum: 60,
        description:
          'login_complete only: base poll interval (default 2s). Use the interval from login_init for best behavior.',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

// ─── Injection points ────────────────────────────────────────────────────────

/**
 * Build a dashboard client for `projectRoot`. Swappable in tests.
 * Returns `null` when the dashboard cannot be configured (missing URL or
 * credentials) — caller surfaces a typed error.
 */
export type DashboardClientResolver = (
  projectRoot: string | undefined
) => Promise<DashboardClient | null>;

/**
 * Read `dashboard_project_id` + `dashboard_registered` from the SQLite
 * metadata table. Returns `null` when the project has no DB (eg. uninitialized).
 */
export type DashboardProjectIdReader = (projectRoot: string) => Promise<string | null>;

const defaultDashboardClientResolver: DashboardClientResolver = async (projectRoot) => {
  const result = await DashboardClient.fromEnvForProject(projectRoot);
  if (!result.success || !result.data) return null;
  return result.data.client;
};

/**
 * s86-m06 — resolve a USER-scoped client for an operation that must not
 * authenticate with a project-scoped credential. Returns the `{client, keySource}`
 * pair because `keySource` is what lets the caller name WHICH arm failed to
 * attribute (see `classifyAttribution`).
 *
 * Takes the CredentialStore so the resolution reads the SAME store the handler
 * writes to — without it, an injected `deps.store` and the process singleton can
 * diverge, and the handler would classify against one store while persisting to
 * another.
 */
export type UserScopedClientResolver = (
  store: CredentialStore
) => Promise<{ client: DashboardClient; keySource: KeySource } | null>;

const defaultUserScopedClientResolver: UserScopedClientResolver = async (store) => {
  const result = await DashboardClient.fromEnvForUser({ credentialStore: store });
  if (!result.success || !result.data) return null;
  return { client: result.data.client, keySource: result.data.keySource };
};

const defaultDashboardProjectIdReader: DashboardProjectIdReader = async (projectRoot) => {
  try {
    const result = await withClientAsync<string | null>(
      async (client) => {
        const row = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'dashboard_project_id'`
        );
        const registered = client.getOne<{ value: string }>(
          `SELECT value FROM metadata WHERE key = 'dashboard_registered'`
        );
        const isRegistered = registered.success && registered.data?.value === 'true';
        const id = (row.success && row.data?.value) || null;
        return { success: true, data: isRegistered ? id : null };
      },
      { projectRoot }
    );
    if (!result.success) return null;
    return result.data ?? null;
  } catch {
    return null;
  }
};

/**
 * Swappable device-code flow implementation. Default: `runDeviceCodeFlow` from
 * `src/auth/device-code`. Tests inject a wrapper that passes a mock
 * `fetchImpl` / `sleepFn` / `nowFn` through to the real flow so the handler's
 * prompter-capture + error-mapping stays exercised end-to-end.
 */
export type DeviceCodeFlowImpl = (options: DeviceCodeFlowOptions) => Promise<DeviceTokenSuccess>;

/**
 * Sprint 59 m04 — swappable request for the device/code leg. Tests inject a
 * wrapper around `requestDeviceCode` that threads a mock fetchImpl through.
 */
export type DeviceCodeRequesterImpl = (options: {
  baseUrl: string;
  userAgent: string;
}) => Promise<DeviceCodeResponse>;

/**
 * Sprint 59 m04 — swappable bounded poll for the device/token leg. Tests
 * inject a wrapper around `pollForTokenBounded` that threads mock
 * fetchImpl / sleepFn / nowFn through.
 */
export type TokenPollerImpl = (options: BoundedPollOptions) => Promise<BoundedPollStatus>;

export interface RbookAuthDependencies {
  store?: CredentialStore;
  clientResolver?: DashboardClientResolver;
  /**
   * s86-m06 — user-scoped resolution, used by `reissue` ONLY. rotate / revoke /
   * list / logout deliberately keep `clientResolver`: each either wants
   * project-root-aware resolution or does not depend on the authenticating
   * identity at all.
   */
  userClientResolver?: UserScopedClientResolver;
  projectIdReader?: DashboardProjectIdReader;
  /** Sprint 58 m01 — override for tests; default = `runDeviceCodeFlow`. */
  deviceCodeFlow?: DeviceCodeFlowImpl;
  /** Sprint 59 m04 — override for tests; default wraps `requestDeviceCode`. */
  deviceCodeRequester?: DeviceCodeRequesterImpl;
  /** Sprint 59 m04 — override for tests; default = `pollForTokenBounded`. */
  tokenPoller?: TokenPollerImpl;
  /**
   * s96-m02 — asks the dashboard who the new sign-in is, so author names default to its username
   * (ADR s96 §10). Override for tests; default = `fetchSignedInIdentity`.
   */
  identityFetcher?: IdentityFetcherImpl;
  /**
   * Sprint 58 m01 — explicit override for tests. When omitted, the canonical resolver applies
   * explicit/env/baked-default precedence. An explicit empty string disables login actions.
   */
  dashboardBaseUrl?: string;
}

/** s96-m02: asks the dashboard for the identity of the account a new key belongs to. */
export type IdentityFetcherImpl = (baseUrl: string, apiKey: string) => Promise<void>;

/** The dashboard returns the caller's id and username (H3); a sign-in keeps them for its key. */
async function fetchSignedInIdentity(baseUrl: string, apiKey: string): Promise<void> {
  const client = new DashboardClient({ baseUrl, apiKey });
  const mine = await client.getMyProjects();
  if (mine.success && mine.data?.user) client.rememberIdentity(mine.data.user);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

function isAction(value: string): value is RbookAuthAction {
  return (RBOOK_AUTH_ACTIONS as readonly string[]).includes(value);
}

export async function rbookAuth(
  params: RbookAuthParams,
  deps: RbookAuthDependencies = {}
): Promise<RbookToolResult<RbookAuthResult>> {
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';
  if (!isAction(actionValue)) {
    return createError<RbookAuthResult>(
      RbookErrors.invalidAction('rbook_auth', actionValue, RBOOK_AUTH_ACTIONS)
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookAuthToolDefinition.inputSchema,
    RBOOK_AUTH_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<RbookAuthResult>(wrongTypedParam);

  if ((actionValue === 'rotate' || actionValue === 'reissue') && params.projectRoot) {
    const ownerError = await dashboardOwnerError(params.projectRoot);
    if (ownerError) return createError<RbookAuthResult>(ownerError);
  }

  const store = deps.store ?? (await CredentialStore.create());
  const clientResolver = deps.clientResolver ?? defaultDashboardClientResolver;
  const userClientResolver = deps.userClientResolver ?? defaultUserScopedClientResolver;
  const projectIdReader = deps.projectIdReader ?? defaultDashboardProjectIdReader;
  const deviceCodeFlow = deps.deviceCodeFlow ?? runDeviceCodeFlow;
  const deviceCodeRequester =
    deps.deviceCodeRequester ?? (({ baseUrl, userAgent }) => requestDeviceCode(baseUrl, userAgent));
  const tokenPoller = deps.tokenPoller ?? pollForTokenBounded;
  const identityFetcher = deps.identityFetcher ?? fetchSignedInIdentity;
  const dashboardBaseUrl =
    deps.dashboardBaseUrl !== undefined ? deps.dashboardBaseUrl : resolveDashboardBaseUrl();

  switch (actionValue) {
    case 'rotate':
      return handleRotate(params, store, clientResolver, projectIdReader);
    case 'revoke':
      return handleRevoke(params, store, userClientResolver);
    case 'list':
      return handleList(params, store, clientResolver);
    case 'reissue':
      return handleReissue(params, store, userClientResolver, projectIdReader);
    case 'login':
      return handleLogin(store, deviceCodeFlow, dashboardBaseUrl, identityFetcher);
    case 'login_init':
      return handleLoginInit(deviceCodeRequester, dashboardBaseUrl);
    case 'login_complete':
      return handleLoginComplete(params, store, tokenPoller, dashboardBaseUrl, identityFetcher);
    case 'logout':
      return handleLogout(params, store, userClientResolver);
  }
}

async function handleRotate(
  params: RbookAuthParams,
  store: CredentialStore,
  clientResolver: DashboardClientResolver,
  projectIdReader: DashboardProjectIdReader
): Promise<RbookToolResult<RbookAuthResult>> {
  if (!params.projectRoot) {
    return createError<RbookAuthResult>(RbookErrors.missingParameter('projectRoot'));
  }

  const existing = await store.getProjectKey(params.projectRoot);
  if (!existing) {
    return createError<RbookAuthResult>({
      code: 'CREDENTIAL_NOT_FOUND',
      message: `No project-scoped key found locally for ${params.projectRoot}`,
      suggestion:
        'Run registration or rbook_auth(action="reissue") to populate the local project key first.',
    });
  }

  const projectId = await projectIdReader(params.projectRoot);
  if (!projectId) {
    return createError<RbookAuthResult>({
      code: 'PROJECT_NOT_REGISTERED',
      message: `No dashboard_project_id recorded for ${params.projectRoot}`,
      suggestion: 'The project must be registered with the dashboard before keys can be rotated.',
    });
  }

  const client = await clientResolver(params.projectRoot);
  if (!client) {
    return createError<RbookAuthResult>(RbookErrors.dashboardNotConfigured());
  }

  const rotate = await client.rotateProjectKey(
    projectId,
    params.graceSeconds !== undefined ? { graceSeconds: params.graceSeconds } : {}
  );
  if (!rotate.success || !rotate.data) {
    // s86-m06 (f07) — rotate's CREDENTIAL SELECTION is deliberately untouched: it
    // authenticates with the project-scoped credential resolved for this root,
    // which is the very key being rotated, and changing that changes which
    // principal the dashboard's ownership check evaluates (unverifiable from this
    // repo). Only its HONESTY changes: a blind passthrough of a 401 surfaced the
    // generic dashboard-auth suggestion, which points a device-code install at
    // credentials it does not have and never mentions the recovery that exists.
    //
    // The message asserts the resolution RULE and the local row — not which
    // credential actually went on the wire, which a caller-injected resolver can
    // change. The error CODE is unchanged so no consumer branch breaks.
    if (rotate.error?.code === 'DASHBOARD_AUTH_FAILED') {
      return createError<RbookAuthResult>({
        code: 'DASHBOARD_AUTH_FAILED',
        message: `${rotate.error.message} — rotate authenticates with the project-scoped credential resolved for ${params.projectRoot}; the local row for that root is keyId=${existing.keyId}. If that key was revoked dashboard-side, rotate cannot recover it.`,
        suggestion: `Run rbook_auth(action="reissue", projectRoot="${params.projectRoot}") to mint a fresh project key using your user-scoped credential.`,
      });
    }
    return createError<RbookAuthResult>(
      rotate.error ?? RbookErrors.dashboardError('rotate returned no data')
    );
  }

  const now = new Date().toISOString();
  const next: ProjectKeyRecord = {
    key: rotate.data.newKey,
    keyId: rotate.data.newKeyId,
    parentKeyId: existing.parentKeyId,
    label: rotate.data.label ?? existing.label,
    issuedAt: now,
    lastUsedAt: now,
  };
  await store.swapProjectKey(params.projectRoot, next, {
    key: existing.key,
    keyId: rotate.data.oldKeyId,
    revokeAt: rotate.data.revokeAt,
  });

  return createSuccess<RbookAuthResult>({
    action: 'rotate',
    projectId,
    newKeyId: rotate.data.newKeyId,
    oldKeyId: rotate.data.oldKeyId,
    revokeAt: rotate.data.revokeAt,
    graceSeconds: params.graceSeconds ?? null,
  });
}

async function handleRevoke(
  params: RbookAuthParams,
  store: CredentialStore,
  userClientResolver: UserScopedClientResolver
): Promise<RbookToolResult<RbookAuthResult>> {
  // Sprint 59 m02 — unified scope-aware revoke. Accepts either an explicit
  // keyId or a projectRoot (to derive the keyId from the local project key).
  // The dashboard infers scope from the key row and enforces ownership, so
  // the tool no longer needs `projectId` to build the URL.
  let targetKeyId = params.keyId;
  if (!targetKeyId) {
    if (!params.projectRoot) {
      return createError<RbookAuthResult>({
        code: 'MISSING_PARAMETER',
        message: 'revoke requires either keyId or projectRoot.',
        suggestion:
          'Pass keyId to revoke a specific key, or projectRoot to revoke that project’s local project-scoped key.',
      });
    }
    const existing = await store.getProjectKey(params.projectRoot);
    if (!existing) {
      return createError<RbookAuthResult>({
        code: 'CREDENTIAL_NOT_FOUND',
        message: `No project-scoped key found locally for ${params.projectRoot}, and no explicit keyId was supplied.`,
        suggestion: 'Pass keyId to revoke a specific dashboard key.',
      });
    }
    targetKeyId = existing.keyId;
  }

  // Determine scope locally from credential store BEFORE calling revoke.
  // Dashboard message 335c3a34 (2026-04-23) confirmed the shipped response
  // envelope is {keyId, revokedAt} — scope is inferred server-side but NOT
  // echoed back. Local inference drives cleanup routing.
  const userScopedKeys = await store.listUserScopedKeys();
  const allProjects = await store.listProjectKeys();
  let scope: 'user' | 'project' | 'unknown';
  if (userScopedKeys[targetKeyId]) {
    scope = 'user';
  } else {
    const hasProjectMatch = Object.values(allProjects).some(
      (record) => record.keyId === targetKeyId || record.pendingRevoke?.keyId === targetKeyId
    );
    scope = hasProjectMatch ? 'project' : 'unknown';
  }

  // s100-m02 (#717 item 3): sent with this machine's user-scoped key, never a project's own, so the
  // dashboard can refuse a project key that revokes account keys.
  const client = (await userClientResolver(store))?.client;
  if (!client) {
    return createError<RbookAuthResult>(RbookErrors.dashboardNotConfigured());
  }

  const result = await client.revokeKey(targetKeyId);
  if (!result.success || !result.data) {
    return createError<RbookAuthResult>(
      result.error ?? RbookErrors.dashboardError('revoke returned no data')
    );
  }

  // Local cleanup per inferred scope. 'unknown' → no local row to clean. s96-m02: a revoked key's
  // identity is forgotten with it, so author names stop defaulting to it.
  if (scope === 'user') {
    forgetDashboardIdentity(userScopedKeys[targetKeyId].key);
    await store.removeUserScopedKey(targetKeyId);
  } else if (scope === 'project') {
    for (const [projectRoot, record] of Object.entries(allProjects)) {
      if (record.keyId === targetKeyId) {
        forgetDashboardIdentity(record.key);
        await store.removeProjectKey(projectRoot);
      } else if (record.pendingRevoke?.keyId === targetKeyId) {
        await store.clearPendingRevoke(projectRoot);
      }
    }
  }

  return createSuccess<RbookAuthResult>({
    action: 'revoke',
    keyId: targetKeyId,
    scope,
    revokedAt: result.data.revokedAt,
  });
}

async function handleList(
  params: RbookAuthParams,
  store: CredentialStore,
  clientResolver: DashboardClientResolver
): Promise<RbookToolResult<RbookAuthResult>> {
  const client = await clientResolver(params.projectRoot);
  if (!client) {
    return createError<RbookAuthResult>(RbookErrors.dashboardNotConfigured());
  }

  const listResult = await client.listKeys();
  if (!listResult.success || !listResult.data) {
    return createError<RbookAuthResult>(
      listResult.error ?? RbookErrors.dashboardError('list returned no data')
    );
  }

  const mineOnly = params.mineOnly !== false; // default true
  const localUserScopedKeys: Record<string, UserScopedKeyRecord> = await store.listUserScopedKeys();
  const mineKeyIds = new Set(Object.keys(localUserScopedKeys));

  const userScoped: ListedKey[] = [];
  const projectScoped: ListedKey[] = [];
  let filteredOut = 0;

  for (const key of listResult.data.keys) {
    const isUserScoped = !key.projectId;
    if (mineOnly) {
      const belongsToMe = isUserScoped
        ? mineKeyIds.has(key.id)
        : key.parentKeyId !== null && mineKeyIds.has(key.parentKeyId);
      if (!belongsToMe) {
        filteredOut += 1;
        continue;
      }
    }
    if (isUserScoped) {
      userScoped.push(key);
    } else {
      projectScoped.push(key);
    }
  }

  return createSuccess<RbookAuthResult>({
    action: 'list',
    mineOnly,
    userScoped,
    projectScoped,
    filteredOut,
  });
}

/**
 * `rbook_auth(action="reissue")` — lost-key recovery.
 *
 * s86-m06 rewrote two things about this handler:
 *
 *  1. IT RESOLVES A USER-SCOPED CLIENT (`userClientResolver`), not a
 *     project-scoped one. Reissue exists to repair a broken local project row, so
 *     it is called exactly when that row is present — and project-scoped
 *     resolution keys off mere row EXISTENCE, with no revocation concept. The old
 *     path therefore authenticated the repair with the credential being repaired
 *     and could not attribute the mint, so the documented recovery path worked
 *     ONLY when the local row was absent, which is when it is least needed.
 *
 *  2. NOTHING DESTRUCTIVE HAPPENS BEFORE CLASSIFICATION. The row used to be
 *     deleted before the handler discovered it could not attribute the mint,
 *     leaving an operator who asked for a repair with no project key row at all —
 *     strictly worse off than before the call.
 */
async function handleReissue(
  params: RbookAuthParams,
  store: CredentialStore,
  userClientResolver: UserScopedClientResolver,
  projectIdReader: DashboardProjectIdReader
): Promise<RbookToolResult<RbookAuthResult>> {
  if (!params.projectRoot) {
    return createError<RbookAuthResult>(RbookErrors.missingParameter('projectRoot'));
  }

  const projectId = await projectIdReader(params.projectRoot);
  if (!projectId) {
    return createError<RbookAuthResult>({
      code: 'PROJECT_NOT_REGISTERED',
      message: `No dashboard_project_id recorded for ${params.projectRoot}`,
      suggestion: 'Project must be registered before a key can be reissued.',
    });
  }

  const resolved = await userClientResolver(store);

  // Classify FIRST — before any write. A failure here must leave the operator's
  // local row exactly as it was.
  const attribution = await classifyAttribution(
    resolved?.client ?? null,
    resolved?.keySource ?? null,
    store
  );
  if (!attribution.ok) {
    return createError<RbookAuthResult>(reissueAttributionError(attribution.failure));
  }
  if (!resolved) {
    // Unreachable: classifyAttribution returns a failure whenever there is no
    // client. Typed rather than assumed, so an inconsistency cannot fall through.
    return createError<RbookAuthResult>(RbookErrors.dashboardNotConfigured());
  }

  // recoverProjectKey no-ops when a local key already exists; reissue should
  // force a fresh key even when something is present, so drop any existing
  // row first. This is the first destructive step and it now runs only after
  // attribution succeeded.
  //
  // s87-m07 (#527) — SNAPSHOT BEFORE THE DELETE, AND RESTORE ON EVERY NON-SUCCESS EXIT.
  //
  // Measured live: force a 500 on the mint and `getProjectKey` afterwards returns `null` — the
  // operator's only project key is gone, and reissue offered nothing in its place. A reissue that
  // gets past attribution and then fails dashboard-side used to DESTROY the credential it was
  // asked to replace.
  //
  // THE DELETE IS LOAD-BEARING, so the fix is not "move it later": `recoverProjectKey` returns
  // `no-op-already-present` while a row exists, so without the delete a reissue would silently
  // decline to reissue. Snapshot-and-re-upsert keeps the forcing behaviour and makes it
  // reversible.
  // Captured into a local because the closure below loses the narrowing the `!params.projectRoot`
  // guard at the top of this function established.
  const reissueRoot: string = params.projectRoot;
  const snapshot = await store.getProjectKey(reissueRoot);

  /**
   * Put the original row back. IDEMPOTENT, and a no-op when there was nothing to save — the
   * absent-row reissue path is legitimate (covered at reissue-resolution.test.ts) and must not be
   * handed a fabricated key.
   */
  const restoreSnapshot = async (): Promise<void> => {
    if (!snapshot) return;
    await store.upsertProjectKey(reissueRoot, snapshot);
  };

  await store.removeProjectKey(params.projectRoot);

  // WRAPPED, because the three named arms are not the only way out. `store.upsertProjectKey`
  // inside `recoverProjectKey` can THROW after the delete, and `rbookAuth`'s dispatcher has no
  // try/catch anywhere — so an exception would escape with the row already gone. A per-arm fix
  // that leaves the exception path open is a fix that still loses the key.
  let recovery: Awaited<ReturnType<typeof recoverProjectKey>>;
  try {
    recovery = await recoverProjectKey({
      projectRoot: params.projectRoot,
      projectId,
      client: resolved.client,
      store,
    });
  } catch (err) {
    await restoreSnapshot();
    throw err;
  }

  if (recovery.kind === 'recovered') {
    return createSuccess<RbookAuthResult>({
      action: 'reissue',
      projectId,
      newKeyId: recovery.record.keyId,
      // s86-m06 — what the dashboard actually revoked. Previously hardcoded `[]`,
      // i.e. a success answer asserting "nothing was revoked" while N keys had been.
      // The companion flag keeps "reported an empty list" distinct from "reported
      // nothing", so neither is rendered as the other.
      revokedKeyIds: recovery.revokedKeyIds ?? [],
      revokedKeyIdsReported: recovery.revokedKeyIds !== undefined,
    });
  }
  if (recovery.kind === 'missing-parent-key-id') {
    // Unreachable — classifyAttribution already passed. Reported as an internal
    // inconsistency rather than reusing the DEVICE_CODE_REQUIRED wording, which
    // would name a cause we have just proven false.
    // s87-m07 (#527): restore first. THREE arms need this, not the two the next-step names.
    await restoreSnapshot();
    return createError<RbookAuthResult>(
      RbookErrors.dashboardError(
        'internal inconsistency: attribution classified as usable, but the recovery path found no parent keyId'
      )
    );
  }
  if (recovery.kind === 'reissue-failed') {
    // s87-m07 (#527) — THE LIVE ONE. This is the arm a forced 500 lands on, and the arm that
    // measured `persisted: null` before this restore existed.
    await restoreSnapshot();
    // s87-m07 — and the message no longer stutters. `recovery.error` is already the
    // dashboard-client's own message, which carries its own `Dashboard error:` prefix; wrapping it
    // again produced the measured "Dashboard error: Dashboard error: Server error 500: upstream
    // exploded". Stripping one leading prefix matches the plain form the startup runner uses for
    // the same condition, so the two surfaces read the same way.
    return createError<RbookAuthResult>(
      RbookErrors.dashboardError(recovery.error.replace(/^Dashboard error:\s*/, ''))
    );
  }
  // 'no-op-already-present' can't happen — we removed the existing row above.
  // s87-m07 (#527): restored anyway. It is unreachable through the type system, which is exactly
  // why it must not be the one exit that silently keeps the key deleted if it ever is reached.
  await restoreSnapshot();
  return createError<RbookAuthResult>(
    RbookErrors.dashboardError('reissue recovery returned an unexpected state')
  );
}

/**
 * Turn an attribution failure into the error the operator reads.
 *
 * s86-m06 — the single string this replaces blamed a missing device-code bootstrap
 * for every attribution failure, which was false whenever the store held a
 * user-scoped key: the credentials existed and worked, they were simply not the
 * ones selected. Each branch below states only what is known, and none promises
 * that a subsequent reissue will work.
 */
function reissueAttributionError(failure: AttributionFailure): RbookToolError {
  switch (failure.kind) {
    case 'no-user-scoped-key':
      return {
        code: 'DEVICE_CODE_REQUIRED',
        message: `The credential store at ${failure.storePath} holds no user-scoped keys, so a reissued project key cannot be attributed to a parent credential.`,
        suggestion:
          'Run rbook_auth(action="login_init") then rbook_auth(action="login_complete") to bootstrap a user-scoped key, then retry reissue.',
      };
    case 'unattributable-credential':
      return {
        code: 'CREDENTIAL_NOT_ATTRIBUTABLE',
        message: `Reissue resolved its credential from ${describeAttributionArm(failure.via)}, which is not a device-code user key, so the dashboard cannot bind the new project key to a parent credential.`,
        suggestion:
          'Run rbook_auth(action="login_init") + login_complete to hold a device-code user-scoped key in the local store; reissue selects the newest user-scoped key from it.',
      };
    case 'inconsistent-resolution':
      return RbookErrors.dashboardError(
        `credential resolution is inconsistent: ${failure.detail} (store: ${failure.storePath})`
      );
  }
}

async function handleLogin(
  store: CredentialStore,
  deviceCodeFlow: DeviceCodeFlowImpl,
  dashboardBaseUrl: string | null | undefined,
  identityFetcher: IdentityFetcherImpl
): Promise<RbookToolResult<RbookAuthResult>> {
  if (!dashboardBaseUrl) {
    return createError<RbookAuthResult>(RbookErrors.dashboardNotConfigured());
  }

  let captured: DeviceCodeResponse | undefined;
  try {
    const token = await deviceCodeFlow({
      baseUrl: dashboardBaseUrl,
      credentialStore: store,
      prompter: (response) => {
        // Dual-emit: (a) capture into the response payload so IDE MCP hosts
        // (which swallow stderr) can render verificationUri/userCode to the
        // user/agent, (b) print to stderr so terminal callers and live
        // integration tests see the prompt immediately instead of after the
        // poll loop completes.
        captured = response;
        defaultPrompter(response);
      },
    });

    if (!captured) {
      // The default flow always invokes the prompter before polling; this
      // only triggers if a test double omits it.
      return createError<RbookAuthResult>(
        RbookErrors.dashboardError('device code flow produced no prompt response')
      );
    }

    // s96-m02: as login_complete does, learn who signed in so author names default to them.
    await identityFetcher(dashboardBaseUrl, token.key).catch(() => undefined);
    return createSuccess<RbookAuthResult>({
      action: 'login',
      verificationUri: captured.verificationUri,
      userCode: captured.userCode,
      expiresIn: captured.expiresIn,
      interval: captured.interval,
      keyId: token.keyId,
      label: token.label,
    });
  } catch (err) {
    if (err instanceof DeviceCodeError) {
      return createError<RbookAuthResult>(mapDeviceCodeError(err));
    }
    throw err;
  }
}

async function handleLoginInit(
  deviceCodeRequester: DeviceCodeRequesterImpl,
  dashboardBaseUrl: string | null | undefined
): Promise<RbookToolResult<RbookAuthResult>> {
  if (!dashboardBaseUrl) {
    return createError<RbookAuthResult>(RbookErrors.dashboardNotConfigured());
  }

  const version = await readPackageVersion();
  const userAgent = buildUserAgent(version);

  try {
    const response = await deviceCodeRequester({ baseUrl: dashboardBaseUrl, userAgent });
    return createSuccess<RbookAuthResult>({
      action: 'login_init',
      deviceCode: response.deviceCode,
      userCode: response.userCode,
      verificationUri: response.verificationUri,
      expiresIn: response.expiresIn,
      interval: response.interval,
    });
  } catch (err) {
    if (err instanceof DeviceCodeError) {
      return createError<RbookAuthResult>(mapDeviceCodeError(err));
    }
    throw err;
  }
}

async function handleLoginComplete(
  params: RbookAuthParams,
  store: CredentialStore,
  tokenPoller: TokenPollerImpl,
  dashboardBaseUrl: string | null | undefined,
  identityFetcher: IdentityFetcherImpl
): Promise<RbookToolResult<RbookAuthResult>> {
  if (!dashboardBaseUrl) {
    return createError<RbookAuthResult>(RbookErrors.dashboardNotConfigured());
  }
  if (!params.deviceCode) {
    return createError<RbookAuthResult>(RbookErrors.missingParameter('deviceCode'));
  }

  const maxWaitSeconds = params.maxWaitSeconds ?? DEFAULT_LOGIN_COMPLETE_MAX_WAIT_SECONDS;
  const intervalSeconds = params.pollIntervalSeconds ?? DEFAULT_LOGIN_COMPLETE_INTERVAL_SECONDS;

  const version = await readPackageVersion();
  const userAgent = buildUserAgent(version);

  try {
    const poll = await tokenPoller({
      baseUrl: dashboardBaseUrl,
      deviceCode: params.deviceCode,
      userAgent,
      intervalSeconds,
      maxWaitSeconds,
    });

    switch (poll.status) {
      case 'approved': {
        const now = new Date().toISOString();
        const record: UserScopedKeyRecord = {
          key: poll.key,
          label: poll.label,
          issuedAt: now,
          lastUsedAt: now,
        };
        await store.upsertUserScopedKey(poll.keyId, record);
        // s96-m02: learn the account's username now, so author names default to it. The sign-in
        // stands without it; a later dashboard call that returns the identity keeps it then.
        await identityFetcher(dashboardBaseUrl, poll.key).catch(() => undefined);
        return createSuccess<RbookAuthResult>({
          action: 'login_complete',
          status: 'approved',
          keyId: poll.keyId,
          label: poll.label,
          intervalSeconds: poll.intervalSeconds,
        });
      }
      case 'pending':
        return createSuccess<RbookAuthResult>({
          action: 'login_complete',
          status: 'pending',
          intervalSeconds: poll.intervalSeconds,
        });
      case 'expired':
        return createSuccess<RbookAuthResult>({
          action: 'login_complete',
          status: 'expired',
        });
      case 'denied':
        return createSuccess<RbookAuthResult>({
          action: 'login_complete',
          status: 'denied',
          ...(poll.description !== undefined ? { description: poll.description } : {}),
        });
    }
  } catch (err) {
    if (err instanceof DeviceCodeError) {
      return createError<RbookAuthResult>(mapDeviceCodeError(err));
    }
    throw err;
  }
}

async function handleLogout(
  params: RbookAuthParams,
  store: CredentialStore,
  userClientResolver: UserScopedClientResolver
): Promise<RbookToolResult<RbookAuthResult>> {
  const userScopedKeys = await store.listUserScopedKeys();
  const localKeyIds = Object.keys(userScopedKeys);

  let targetKeyId: string;
  if (params.keyId) {
    if (!userScopedKeys[params.keyId]) {
      return createError<RbookAuthResult>({
        code: 'CREDENTIAL_NOT_FOUND',
        message: `keyId ${params.keyId} is not a user-scoped key in the local credential store.`,
        suggestion:
          'logout specifically targets user-scoped login sessions. For project-scoped revocation use rbook_auth(action="revoke", keyId=...).',
      });
    }
    targetKeyId = params.keyId;
  } else if (localKeyIds.length === 0) {
    return createError<RbookAuthResult>({
      code: 'CREDENTIAL_NOT_FOUND',
      message: 'No user-scoped key in the local credential store to logout.',
      suggestion:
        'Run rbook_auth(action="login_init") then login_complete to bootstrap a credential first.',
    });
  } else if (localKeyIds.length === 1) {
    targetKeyId = localKeyIds[0]!;
  } else {
    return createError<RbookAuthResult>({
      code: 'MISSING_PARAMETER',
      message: `Multiple user-scoped keys (${localKeyIds.length}) in the local store — pass an explicit keyId to logout a specific one.`,
      suggestion:
        'rbook_auth(action="list", mineOnly=true) lists your user-scoped keys; pass the target as keyId.',
    });
  }

  // s100-m02 (#717 item 3): as revoke, sent with this machine's user-scoped key.
  const client = (await userClientResolver(store))?.client;
  if (!client) {
    return createError<RbookAuthResult>(RbookErrors.dashboardNotConfigured());
  }

  const result = await client.revokeKey(targetKeyId);
  if (!result.success || !result.data) {
    return createError<RbookAuthResult>(
      result.error ?? RbookErrors.dashboardError('logout revokeKey returned no data')
    );
  }

  // Remove the local user-scoped row. Project-scoped children are left alone
  // — they keep working server-side as standalone cmk_ bearers; if the user
  // wants to clean them up they can revoke each individually, signed in, since
  // a revoke goes with this machine's user-scoped key (s100-m02).
  // s96-m02: the signed-out key's identity goes with it, so author names stop defaulting to it.
  forgetDashboardIdentity(userScopedKeys[targetKeyId].key);
  await store.removeUserScopedKey(targetKeyId);

  return createSuccess<RbookAuthResult>({
    action: 'logout',
    keyId: targetKeyId,
    revokedAt: result.data.revokedAt,
  });
}

function mapDeviceCodeError(err: DeviceCodeError): {
  code: string;
  message: string;
  suggestion: string;
} {
  switch (err.code) {
    case 'expired_token':
      return {
        code: 'DEVICE_CODE_EXPIRED',
        message: err.description
          ? `Device code expired before authorization completed: ${err.description}`
          : 'Device code expired before authorization completed',
        suggestion:
          'Request a fresh code with rbook_auth(action="login_init"), approve it at the verificationUri, then call rbook_auth(action="login_complete") before it expires.',
      };
    case 'access_denied':
      return {
        code: 'DEVICE_CODE_ACCESS_DENIED',
        message: err.description
          ? `Authorization was denied: ${err.description}`
          : 'Authorization was denied at the dashboard',
        suggestion:
          'Run rbook_auth(action="login_init") again, approve the code at the verificationUri, then call rbook_auth(action="login_complete").',
      };
    case 'request_failed':
    case 'malformed_response':
    default:
      return {
        code: 'DASHBOARD_ERROR',
        message: `Dashboard error: ${err.message}`,
        suggestion: 'Check the dashboard is reachable and the device-code endpoints are healthy.',
      };
  }
}

export function formatAuthForLLM(action: string, result: RbookToolResult<RbookAuthResult>): string {
  const lines = [renderAuthBody(action, result)];

  appendWarnings(lines, result);

  return lines.join('\n');
}

/**
 * The auth answer itself. Split out of formatAuthForLLM in s86-m02 so the envelope warnings
 * channel has one tail to render from: every branch below returns a short single-line string, and
 * threading `appendWarnings` through each of them would have meant fourteen call sites and
 * fourteen chances to miss one.
 */
function renderAuthBody(action: string, result: RbookToolResult<RbookAuthResult>): string {
  if (!result.success || !result.data) {
    // s86-m06 — render the SUGGESTION too. Every auth error carries one and none of
    // them reached the agent: only `formatted` becomes content[0].text, and this
    // branch dropped the field entirely. Rewriting an error string into a channel
    // nothing renders is fail-quiet about its own fixing.
    const suggestion = result.error?.suggestion;
    return (
      `rbook_auth ${action} failed: ${result.error?.message ?? 'unknown error'}` +
      (suggestion ? `\nSuggestion: ${suggestion}` : '')
    );
  }
  const d = result.data;
  switch (d.action) {
    case 'rotate':
      return `Rotated project key on ${d.projectId}: new=${d.newKeyId}, old=${d.oldKeyId} revokes at ${d.revokeAt}.`;
    case 'revoke':
      return `Revoked ${d.scope}-scoped key ${d.keyId}.`;
    case 'list':
      return `Listed ${d.userScoped.length} user-scoped + ${d.projectScoped.length} project-scoped keys (mineOnly=${d.mineOnly}, filteredOut=${d.filteredOut}).`;
    case 'reissue': {
      // s86-m06 — the revoked list is RENDERED, not only carried in structuredContent. Making
      // the field truthful (it was hardcoded `[]`) while leaving it invisible in the text an
      // agent reads would have fixed the payload and none of the answer.
      //
      // THREE states, not two. "The dashboard reported an empty list" and "the dashboard
      // reported no list" are different facts, and rendering the second as the first would be
      // this mission's own defect one layer down.
      const revoked = !d.revokedKeyIdsReported
        ? 'The dashboard response carried no revoked-key list, so which prior keys it revoked is unknown.'
        : d.revokedKeyIds.length > 0
          ? `Dashboard revoked ${d.revokedKeyIds.length} prior key(s): ${d.revokedKeyIds.join(', ')}.`
          : 'Dashboard reported an empty revoked-key list.';
      return `Reissued project key on ${d.projectId}: new keyId=${d.newKeyId}. ${revoked}`;
    }
    case 'login':
      return `Logged in via device code (keyId=${d.keyId}, label="${d.label}"). Open ${d.verificationUri} and enter ${d.userCode} if you haven't already — this key is now persisted locally.`;
    case 'login_init':
      return `Device code issued. Open ${d.verificationUri} and enter ${d.userCode} (expires in ${d.expiresIn}s). Then call rbook_auth(action="login_complete", deviceCode, pollIntervalSeconds=${d.interval}).`;
    case 'login_complete': {
      switch (d.status) {
        case 'approved':
          return `Login approved. keyId=${d.keyId ?? 'unknown'}, label="${d.label ?? ''}" persisted locally.`;
        case 'pending':
          return `Login still pending approval. Call rbook_auth(action="login_complete") again (pollIntervalSeconds=${d.intervalSeconds ?? '?'}).`;
        case 'expired':
          return `Device code expired before approval. Re-run rbook_auth(action="login_init") to request a fresh code.`;
        case 'denied':
          return `Login denied at the dashboard${d.description ? `: ${d.description}` : ''}.`;
      }
      return `login_complete ${String(d.status)}`;
    }
    case 'logout':
      return `Logged out user-scoped key ${d.keyId} (revoked at ${d.revokedAt}). Local row cleared.`;
  }
}
