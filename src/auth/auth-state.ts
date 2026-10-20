// ABOUTME: Sprint 57 m04 — computeAuthState() composes the local credential store + last deliveryAck snapshot.
// ABOUTME: Surfaced by rbook_message(action=whoami) and rbook_agent_onboard for agent-visible auth diagnostics.

/**
 * Build the `authState` block exposed by `rbook_message(action=whoami)` and
 * `rbook_agent_onboard`. Pure observability — never mutates anything.
 *
 * @module auth/auth-state
 */

import { getSetting } from '../intelligence/legacy-compat';
import {
  CredentialStore,
  type ProjectKeyRecord,
  type UserScopedKeyRecord,
} from '../intelligence/credential-store';
import { getLastDeliveryAck, type DeliveryIdentitySource } from './delivery-ack-cache';
import {
  RBOOK_DASHBOARD_API_KEY_ENV,
  RBOOK_DASHBOARD_USER_ENV,
  RBOOK_DASHBOARD_PASSWORD_ENV,
} from '../tools/rbook/dashboard-client';

/**
 * Sprint 58 m02 — surfaces which auth arm a send would take right now.
 *
 * Mirrors the fromEnvForProject priority chain:
 *   - `device-code`       — user-scoped keys present in local credential
 *                           store (minted by rbook_auth sign-in: login_init, then
 *                           login_complete).
 *   - `legacy-env`        — store empty, RBOOK_DASHBOARD_API_KEY env var set.
 *                           Emits a startup WARN on first fire.
 *   - `password-fallback` — store empty, no legacy env key, email+password
 *                           env vars set. Emits a startup WARN on first fire.
 *   - `none`              — no configured credentials.
 *
 * Project-scoped keys don't change the tier: they're auto-issued by
 * /api/projects/register which itself authenticates via the *user-scoped*
 * credential whose arm is what the tier reflects.
 */
export type AuthTier = 'device-code' | 'legacy-env' | 'password-fallback' | 'none';

/**
 * `issuedVia` matches the dashboard's GET /api/keys vocabulary:
 *   `device_code`       — minted by RFC 8628 device code flow (m01)
 *   `registration_auto` — minted by /api/projects/register auto-issue (m02)
 *   `manual_generate`   — minted via the dashboard's UI key-gen surface
 */
export type IssuedVia = 'device_code' | 'registration_auto' | 'manual_generate';

export interface AuthState {
  /**
   * How the most recent send was attributed by the dashboard, OR — when no
   * send has been observed in this process — a heuristic from local state:
   *   `api-key`      — local store has a key for this project
   *   `request-body` — last send used the legacy user-scoped + body fallback
   *   `none`         — no usable credentials configured
   */
  identitySource: DeliveryIdentitySource;

  /**
   * Whether `identitySource` came from a real `deliveryAck` (true) or was
   * inferred from local credential state alone (false). Lets agents
   * distinguish "this is what the dashboard saw last" from "this is what we
   * would send if you tried right now."
   */
  identitySourceObserved: boolean;

  /** Project-scoped key in use for the current project root, when one exists. */
  projectKey: AuthStateKeyView | null;

  /**
   * The user-scoped credential most recently issued — the one `fromEnvForProject`
   * would pick if no project-scoped key applied.
   */
  userScopedKey: AuthStateKeyView | null;

  /** ISO timestamp of the cached deliveryAck observation, when present. */
  lastDeliveryObservedAt: string | null;

  /**
   * Soft warning for agent + operator surfaces. Populated when the dashboard
   * just told us the send used the legacy `request-body` path (rotation
   * pending) or when no credentials at all are configured.
   */
  warning: string | null;

  /**
   * Sprint 58 m02 — which `fromEnvForProject` arm would fire for the next
   * send. Inferred statically from local store + env vars (not from an
   * observed send). When this is anything other than `device-code`, the
   * onboard surface emits a `rbook_auth(action="login_init")` suggestedAction, then `login_complete`.
   */
  authTier: AuthTier;
}

export interface AuthStateKeyView {
  keyId: string;
  label: string;
  parentKeyId: string | null;
  /** Best-effort; matches dashboard's GET /api/keys field vocabulary. */
  issuedVia: IssuedVia;
  lastUsedAt: string | null;
  /** From `pendingRevoke.revokeAt` when the project key is mid-rotation. */
  revokeAt: string | null;
}

export interface ComputeAuthStateOptions {
  projectRoot?: string;
  store?: CredentialStore;
}

function projectKeyView(record: ProjectKeyRecord): AuthStateKeyView {
  return {
    keyId: record.keyId,
    label: record.label,
    parentKeyId: record.parentKeyId || null,
    issuedVia: 'registration_auto',
    lastUsedAt: record.lastUsedAt || null,
    revokeAt: record.pendingRevoke?.revokeAt ?? null,
  };
}

function userKeyView(keyId: string, record: UserScopedKeyRecord): AuthStateKeyView {
  return {
    keyId,
    label: record.label,
    parentKeyId: null,
    issuedVia: 'device_code',
    lastUsedAt: record.lastUsedAt || null,
    revokeAt: null,
  };
}

function pickNewest(
  keys: Record<string, UserScopedKeyRecord>
): { keyId: string; record: UserScopedKeyRecord } | null {
  const entries = Object.entries(keys);
  if (entries.length === 0) return null;
  const best = entries.reduce((a, b) => ((b[1].issuedAt ?? '') > (a[1].issuedAt ?? '') ? b : a));
  return { keyId: best[0], record: best[1] };
}

/**
 * Build the authState block for the given project root.
 *
 * Ordering of `identitySource`:
 *   1. If a deliveryAck has been observed in this process → use it (and set
 *      `identitySourceObserved = true`).
 *   2. Else: infer from local state — projectKey or any userScopedKey present
 *      → 'api-key'; nothing → 'none'.
 */
export async function computeAuthState(options: ComputeAuthStateOptions = {}): Promise<AuthState> {
  const store = options.store ?? (await CredentialStore.create());

  const projectKeyRecord = options.projectRoot
    ? await store.getProjectKey(options.projectRoot)
    : undefined;
  const userScopedKeys = await store.listUserScopedKeys();
  const newestUser = pickNewest(userScopedKeys);

  const ack = getLastDeliveryAck();

  let identitySource: DeliveryIdentitySource;
  let identitySourceObserved: boolean;
  if (ack) {
    identitySource = ack.identitySource;
    identitySourceObserved = true;
  } else if (projectKeyRecord || newestUser) {
    identitySource = 'api-key';
    identitySourceObserved = false;
  } else {
    identitySource = 'none';
    identitySourceObserved = false;
  }

  const projectKey = projectKeyRecord ? projectKeyView(projectKeyRecord) : null;
  const userScopedKey = newestUser ? userKeyView(newestUser.keyId, newestUser.record) : null;

  let warning: string | null = null;
  if (identitySource === 'request-body') {
    warning =
      'Last send was attributed via legacy user-scoped + body-level senderProjectId path. ' +
      'Run rbook_auth(action=reissue) for this project to migrate to project-scoped key.';
  } else if (identitySource === 'none' && !projectKey && !userScopedKey) {
    warning =
      'No dashboard credentials configured. Run the device code bootstrap to mint a user-scoped key.';
  } else if (options.projectRoot && !projectKey && newestUser) {
    warning =
      'No project-scoped key for this project root yet. Sends will use the user-scoped key until /api/projects/register auto-issues one.';
  }

  const authTier = deriveAuthTier(newestUser !== null);

  return {
    identitySource,
    identitySourceObserved,
    projectKey,
    userScopedKey,
    lastDeliveryObservedAt: ack?.observedAt ?? null,
    warning,
    authTier,
  };
}

/**
 * Mirror the fromEnvForProject priority chain (arms 3 → 4 → 5 → none) to
 * infer which arm a send would take. A user-scoped key in the store always
 * wins; legacy env arms are only visible when the store is empty.
 */
function deriveAuthTier(hasUserScopedKey: boolean): AuthTier {
  if (hasUserScopedKey) return 'device-code';
  if (getSetting(RBOOK_DASHBOARD_API_KEY_ENV)) return 'legacy-env';
  if (getSetting(RBOOK_DASHBOARD_USER_ENV) && getSetting(RBOOK_DASHBOARD_PASSWORD_ENV)) {
    return 'password-fallback';
  }
  return 'none';
}
