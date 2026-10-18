// ABOUTME: Unit tests for rbook_auth — Sprint 57 m03 (rotate | revoke | list | reissue) + Sprint 58 m01/m03 login.
// ABOUTME: Uses injected dashboard-client + metadata stubs so tests stay hermetic.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import {
  rbookAuth,
  type RbookAuthDependencies,
  type DeviceCodeRequesterImpl,
  type TokenPollerImpl,
} from '../../../src/tools/rbook/rbook-auth';
import { RBOOK_CONFIG_DIR_ENV, CredentialStore } from '../../../src/intelligence/credential-store';
import type {
  ProjectKeyRecord,
  UserScopedKeyRecord,
} from '../../../src/intelligence/credential-store';
import type {
  DashboardClient,
  ListKeysResult,
  ListedKey,
  RevokeKeyResult,
  RotateProjectKeyResult,
  ReissueProjectKeyResult,
} from '../../../src/tools/rbook/dashboard-client';
import {
  RBOOK_DASHBOARD_URL_ENV,
  DEFAULT_DASHBOARD_URL,
} from '../../../src/tools/rbook/dashboard-client';
import type { RbookToolResult } from '../../../src/tools/rbook/types';
import { DeviceCodeError, runDeviceCodeFlow } from '../../../src/auth/device-code';
import type {
  BoundedPollStatus,
  DeviceCodeFlowOptions,
  DeviceCodeResponse,
  DeviceTokenSuccess,
} from '../../../src/auth/device-code';
import {
  describeLive,
  setUpLiveConfig,
  tearDownLiveConfig,
  type LiveDashboardConfig,
} from '../../auth/live-dashboard-helper';

type FetchArgs = [string | URL | Request, RequestInit?];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeFetchMock(): jest.Mock<typeof fetch> {
  return jest.fn() as unknown as jest.Mock<typeof fetch>;
}

function callsOf(fetchImpl: jest.Mock<typeof fetch>): FetchArgs[] {
  return (fetchImpl as unknown as { mock: { calls: FetchArgs[] } }).mock.calls;
}

const BASE_URL = 'http://dashboard.test';

/**
 * Wrap `runDeviceCodeFlow` with injected fetch + sleep so login-action tests
 * exercise the real RFC 8628 code path (prompter capture, polling loop,
 * error mapping) without touching the network or real clock.
 */
function wrappedFlow(
  fetchImpl: jest.Mock<typeof fetch>,
  sleepFn: (ms: number) => Promise<void>
): (options: DeviceCodeFlowOptions) => Promise<DeviceTokenSuccess> {
  return (options) =>
    runDeviceCodeFlow({
      ...options,
      version: '1.0.0',
      platform: 'darwin',
      hostname: 'host',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepFn,
    });
}

function projectRecord(overrides: Partial<ProjectKeyRecord> = {}): ProjectKeyRecord {
  const now = new Date().toISOString();
  return {
    key: 'cmk_project_v1',
    keyId: 'project-key-id',
    parentKeyId: 'user-parent-id',
    label: 'project-label',
    issuedAt: now,
    lastUsedAt: now,
    ...overrides,
  };
}

function userRecord(overrides: Partial<UserScopedKeyRecord> = {}): UserScopedKeyRecord {
  const now = new Date().toISOString();
  return {
    key: 'cmk_user',
    label: 'user-label',
    issuedAt: now,
    lastUsedAt: now,
    ...overrides,
  };
}

function stubClient(
  overrides: Partial<{
    rotate: RbookToolResult<RotateProjectKeyResult>;
    revoke: RbookToolResult<RevokeKeyResult>;
    revokeLegacy: RbookToolResult<RevokeKeyResult>;
    list: RbookToolResult<ListKeysResult>;
    reissue: RbookToolResult<ReissueProjectKeyResult>;
    authenticatingKeyId: string | undefined;
  }> = {}
): DashboardClient {
  const keyId =
    'authenticatingKeyId' in overrides ? overrides.authenticatingKeyId : 'user-parent-id';
  return {
    authenticatingKeyId: keyId,
    rotateProjectKey: async () =>
      overrides.rotate ??
      ({
        success: true,
        data: {
          newKey: 'cmk_project_v2',
          newKeyId: 'new-key-id',
          oldKeyId: 'project-key-id',
          revokeAt: '2099-01-01T00:00:00Z',
          label: 'rotated-label',
        },
      } as RbookToolResult<RotateProjectKeyResult>),
    revokeKey: async (keyIdArg: string) =>
      overrides.revoke ??
      ({
        success: true,
        data: { keyId: keyIdArg, revokedAt: '2026-04-23T23:00:00Z' },
      } as RbookToolResult<RevokeKeyResult>),
    revokeProjectKey: async () =>
      overrides.revokeLegacy ??
      ({
        success: true,
        data: { keyId: 'project-key-id', revokedAt: '2026-04-17T12:00:00Z' },
      } as RbookToolResult<RevokeKeyResult>),
    listKeys: async () =>
      overrides.list ??
      ({
        success: true,
        data: { keys: [] },
      } as RbookToolResult<ListKeysResult>),
    reissueProjectKey: async () =>
      overrides.reissue ??
      ({
        success: true,
        data: {
          key: 'cmk_reissued',
          keyId: 'reissued-key-id',
          label: 'reissued',
          revokedKeyIds: ['orphan-id'],
        },
      } as RbookToolResult<ReissueProjectKeyResult>),
  } as unknown as DashboardClient;
}

describe('rbook_auth', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let store: CredentialStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rbook-auth-'));
    delete process.env[RBOOK_CONFIG_DIR_ENV];
    CredentialStore.resetInstance();
    store = await CredentialStore.create({ configDir: tempDir });
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function deps(overrides: Partial<RbookAuthDependencies> = {}): RbookAuthDependencies {
    return {
      store,
      clientResolver: async () => stubClient(),
      // s86-m06 — `reissue` resolves a USER-scoped client and no longer consults
      // `clientResolver`. Injecting both keeps every pre-existing test's intent: without
      // this line the reissue cases would fall through to production resolution against an
      // empty tmpdir store (the suite strips the dashboard credential env vars) and fail
      // for a fixture reason rather than a behavioural one.
      userClientResolver: async () => ({ client: stubClient(), keySource: 'user-scoped' }),
      projectIdReader: async () => 'dashboard-project-id',
      // s96-m02: a completed sign-in asks the dashboard who it is; no network in unit tests.
      identityFetcher: async () => undefined,
      ...overrides,
    };
  }

  it('rejects an unknown action', async () => {
    const result = await rbookAuth({ action: 'nope' as 'list' }, deps());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  // ─── rotate ──────────────────────────────────────────────────────────────

  it('rotate swaps the project key and stores the old one in pendingRevoke', async () => {
    const projectRoot = path.join(tempDir, 'rotate');
    await store.upsertProjectKey(projectRoot, projectRecord({ key: 'cmk_v1' }));

    const result = await rbookAuth({ action: 'rotate', projectRoot, graceSeconds: 600 }, deps());
    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'rotate') {
      expect(result.data.newKeyId).toBe('new-key-id');
      expect(result.data.oldKeyId).toBe('project-key-id');
      expect(result.data.graceSeconds).toBe(600);
    }

    const persisted = await store.getProjectKey(projectRoot);
    expect(persisted?.key).toBe('cmk_project_v2');
    expect(persisted?.pendingRevoke).toEqual({
      key: 'cmk_v1',
      keyId: 'project-key-id',
      revokeAt: '2099-01-01T00:00:00Z',
    });
  });

  it('rotate fails when no project key exists locally', async () => {
    const result = await rbookAuth(
      { action: 'rotate', projectRoot: path.join(tempDir, 'missing') },
      deps()
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CREDENTIAL_NOT_FOUND');
  });

  it('rotate fails when the project has no dashboard_project_id', async () => {
    const projectRoot = path.join(tempDir, 'unregistered');
    await store.upsertProjectKey(projectRoot, projectRecord());
    const result = await rbookAuth(
      { action: 'rotate', projectRoot },
      deps({ projectIdReader: async () => null })
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROJECT_NOT_REGISTERED');
  });

  it('rotate surfaces dashboard errors as a tool failure', async () => {
    const projectRoot = path.join(tempDir, 'dash-fail');
    await store.upsertProjectKey(projectRoot, projectRecord());
    const result = await rbookAuth(
      { action: 'rotate', projectRoot },
      deps({
        clientResolver: async () =>
          stubClient({
            rotate: {
              success: false,
              error: { code: 'DASHBOARD_ERROR', message: 'rotate 500' },
            } as RbookToolResult<RotateProjectKeyResult>,
          }),
      })
    );
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('rotate 500');
  });

  /**
   * s86-m06 (fork f07) — rotate's CREDENTIAL SELECTION is out of scope and untouched:
   * it authenticates with the project-scoped key resolved for the root, which is the very
   * key being rotated, and changing that changes which principal the dashboard's ownership
   * check evaluates. Only the HONESTY of the 401 changes. The message may assert the
   * resolution RULE and the local row — not which credential actually went on the wire,
   * since a caller-injected resolver can change that.
   */
  it('rotate names the local row and points at reissue on a dashboard auth failure', async () => {
    const projectRoot = path.join(tempDir, 'rotate-401');
    await store.upsertProjectKey(projectRoot, projectRecord({ keyId: 'p-live' }));

    const result = await rbookAuth(
      { action: 'rotate', projectRoot },
      deps({
        clientResolver: async () =>
          stubClient({
            rotate: {
              success: false,
              error: {
                code: 'DASHBOARD_AUTH_FAILED',
                message: "Authentication failed for dashboard at 'https://dash.test'",
              },
            } as RbookToolResult<RotateProjectKeyResult>,
          }),
      })
    );

    expect(result.success).toBe(false);
    // The code is unchanged so no consumer branch breaks.
    expect(result.error?.code).toBe('DASHBOARD_AUTH_FAILED');
    expect(result.error?.message).toContain('p-live');
    expect(result.error?.message).toContain('project-scoped credential resolved for');
    expect(result.error?.suggestion).toContain('rbook_auth(action="reissue"');
  });

  // ─── revoke ──────────────────────────────────────────────────────────────

  it('revoke removes the current project key locally on success', async () => {
    const projectRoot = path.join(tempDir, 'revoke');
    await store.upsertProjectKey(projectRoot, projectRecord());

    const result = await rbookAuth({ action: 'revoke', projectRoot }, deps());
    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'revoke') {
      expect(result.data.keyId).toBe('project-key-id');
      expect(result.data.scope).toBe('project');
      expect(result.data.revokedAt).toBeTruthy();
    }
    expect(await store.getProjectKey(projectRoot)).toBeUndefined();
  });

  it('revoke with explicit keyId clears a pendingRevoke slot when that keyId matches', async () => {
    const projectRoot = path.join(tempDir, 'revoke-pending');
    await store.swapProjectKey(projectRoot, projectRecord({ key: 'cmk_v2', keyId: 'v2' }), {
      key: 'cmk_v1',
      keyId: 'v1',
      revokeAt: '2099-01-01T00:00:00Z',
    });

    const result = await rbookAuth(
      { action: 'revoke', projectRoot, keyId: 'v1' },
      deps({
        clientResolver: async () =>
          stubClient({
            revoke: {
              success: true,
              data: { keyId: 'v1', revokedAt: '2026-04-17T12:00:00Z' },
            } as RbookToolResult<RevokeKeyResult>,
          }),
      })
    );
    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'revoke') {
      expect(result.data.scope).toBe('project');
      expect(result.data.keyId).toBe('v1');
      expect(result.data.revokedAt).toBe('2026-04-17T12:00:00Z');
    }
    const after = await store.getProjectKey(projectRoot);
    expect(after?.key).toBe('cmk_v2');
    expect(after?.pendingRevoke).toBeUndefined();
  });

  it('revoke of a user-scoped keyId removes the local user-scoped row', async () => {
    // Seed a user-scoped key we will revoke.
    await store.upsertUserScopedKey('user-key-xyz', userRecord({ key: 'cmk_user_xyz' }));
    expect(await store.getUserScopedKey('user-key-xyz')).toBeDefined();

    const result = await rbookAuth(
      { action: 'revoke', keyId: 'user-key-xyz' },
      deps({
        clientResolver: async () =>
          stubClient({
            revoke: {
              success: true,
              data: { keyId: 'user-key-xyz', revokedAt: '2026-04-23T23:00:00Z' },
            } as RbookToolResult<RevokeKeyResult>,
          }),
      })
    );
    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'revoke') {
      expect(result.data.scope).toBe('user');
      expect(result.data.keyId).toBe('user-key-xyz');
    }
    expect(await store.getUserScopedKey('user-key-xyz')).toBeUndefined();
  });

  it('revoke returns scope=unknown when the keyId is not in the local credential store', async () => {
    // No user-scoped or project-scoped local record for 'orphan-id'.
    const result = await rbookAuth(
      { action: 'revoke', keyId: 'orphan-id' },
      deps({
        clientResolver: async () =>
          stubClient({
            revoke: {
              success: true,
              data: { keyId: 'orphan-id', revokedAt: '2026-04-23T23:00:00Z' },
            } as RbookToolResult<RevokeKeyResult>,
          }),
      })
    );
    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'revoke') {
      expect(result.data.scope).toBe('unknown');
      expect(result.data.keyId).toBe('orphan-id');
    }
  });

  it('revoke fails with MISSING_PARAMETER when neither keyId nor projectRoot is supplied', async () => {
    const result = await rbookAuth({ action: 'revoke' }, deps());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
  });

  it('revoke fails when no project key exists and no explicit keyId is supplied', async () => {
    const result = await rbookAuth(
      { action: 'revoke', projectRoot: path.join(tempDir, 'empty') },
      deps()
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CREDENTIAL_NOT_FOUND');
  });

  // ─── list ────────────────────────────────────────────────────────────────

  it('list returns mine-only by default, filtering by parentKeyId against local user-scoped keys', async () => {
    await store.upsertUserScopedKey('mine-1', userRecord({ key: 'cmk_mine' }));
    const listPayload: ListKeysResult = {
      keys: [
        {
          id: 'mine-1',
          projectId: null,
          projectSlug: null,
          parentKeyId: null,
          label: 'mine-user',
          issuedVia: 'device_code',
          lastUsedAt: null,
          revokeAt: null,
          createdAt: '2026-04-17T00:00:00Z',
        } as ListedKey,
        {
          id: 'project-of-mine',
          projectId: 'p-1',
          projectSlug: 'proj-1',
          parentKeyId: 'mine-1',
          label: 'mine-project',
          issuedVia: 'registration_auto',
          lastUsedAt: null,
          revokeAt: null,
          createdAt: '2026-04-17T00:00:00Z',
        } as ListedKey,
        {
          id: 'sibling-user',
          projectId: null,
          projectSlug: null,
          parentKeyId: null,
          label: 'other',
          issuedVia: 'device_code',
          lastUsedAt: null,
          revokeAt: null,
          createdAt: '2026-04-17T00:00:00Z',
        } as ListedKey,
        {
          id: 'project-of-sibling',
          projectId: 'p-2',
          projectSlug: 'proj-2',
          parentKeyId: 'sibling-user',
          label: 'other-project',
          issuedVia: 'registration_auto',
          lastUsedAt: null,
          revokeAt: null,
          createdAt: '2026-04-17T00:00:00Z',
        } as ListedKey,
      ],
    };

    const result = await rbookAuth(
      { action: 'list' },
      deps({
        clientResolver: async () =>
          stubClient({
            list: {
              success: true,
              data: listPayload,
            } as RbookToolResult<ListKeysResult>,
          }),
      })
    );

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'list') {
      expect(result.data.mineOnly).toBe(true);
      expect(result.data.userScoped.map((k) => k.id)).toEqual(['mine-1']);
      expect(result.data.projectScoped.map((k) => k.id)).toEqual(['project-of-mine']);
      expect(result.data.filteredOut).toBe(2);
    }
  });

  it('list with mineOnly=false returns every row and reports filteredOut=0', async () => {
    const listPayload: ListKeysResult = {
      keys: [
        {
          id: 'user-a',
          projectId: null,
          projectSlug: null,
          parentKeyId: null,
          label: 'a',
          issuedVia: 'device_code',
          lastUsedAt: null,
          revokeAt: null,
          createdAt: 'x',
        } as ListedKey,
        {
          id: 'project-a',
          projectId: 'p-1',
          projectSlug: 's',
          parentKeyId: 'user-a',
          label: 'p',
          issuedVia: 'registration_auto',
          lastUsedAt: null,
          revokeAt: null,
          createdAt: 'x',
        } as ListedKey,
      ],
    };

    const result = await rbookAuth(
      { action: 'list', mineOnly: false },
      deps({
        clientResolver: async () =>
          stubClient({
            list: { success: true, data: listPayload } as RbookToolResult<ListKeysResult>,
          }),
      })
    );

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'list') {
      expect(result.data.mineOnly).toBe(false);
      expect(result.data.userScoped).toHaveLength(1);
      expect(result.data.projectScoped).toHaveLength(1);
      expect(result.data.filteredOut).toBe(0);
    }
  });

  it('list fails with DASHBOARD_NOT_CONFIGURED when no client is available', async () => {
    const result = await rbookAuth({ action: 'list' }, deps({ clientResolver: async () => null }));
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  // ─── reissue ─────────────────────────────────────────────────────────────

  it('reissue drops any existing key and writes the fresh one from the dashboard', async () => {
    const projectRoot = path.join(tempDir, 'reissue');
    // Seed a stale record the reissue should replace.
    await store.upsertProjectKey(projectRoot, projectRecord({ key: 'cmk_stale' }));

    const result = await rbookAuth({ action: 'reissue', projectRoot }, deps());
    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'reissue') {
      expect(result.data.newKeyId).toBe('reissued-key-id');
    }

    const persisted = await store.getProjectKey(projectRoot);
    expect(persisted?.key).toBe('cmk_reissued');
  });

  /**
   * s86-m06 — this test used to be named "…when the client has no authenticatingKeyId"
   * and injected `clientResolver: stubClient({authenticatingKeyId: undefined})`. After the
   * resolver change it would have stayed GREEN for the wrong reason (the tmpdir store is
   * empty, so ANY implementation returns DEVICE_CODE_REQUIRED) — the name would assert
   * something the test no longer checked. It is renamed and the zero-user-key state is now
   * seeded and asserted explicitly, and the code's TWO conditions have two tests.
   */
  it('reissue surfaces DEVICE_CODE_REQUIRED when the credential store holds no user-scoped key', async () => {
    const projectRoot = path.join(tempDir, 'reissue-no-parent');
    // The state under test, stated rather than inherited from an empty fixture.
    expect(Object.keys(await store.listUserScopedKeys())).toHaveLength(0);

    const result = await rbookAuth(
      { action: 'reissue', projectRoot },
      // No userClientResolver override: production resolution must find the empty store.
      { store, projectIdReader: async () => 'dashboard-project-id' }
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DEVICE_CODE_REQUIRED');
    expect(result.error?.message).toContain(store.path);
    expect(result.error?.message).not.toContain('device code flow must be run');
  });

  it('reissue surfaces CREDENTIAL_NOT_ATTRIBUTABLE for a caller-supplied credential', async () => {
    const projectRoot = path.join(tempDir, 'reissue-unattributable');
    await store.upsertUserScopedKey('user-1', userRecord());

    const result = await rbookAuth(
      { action: 'reissue', projectRoot },
      deps({
        // keySource 'user-scoped' with no authenticating keyId is arm 1, and only arm 1.
        userClientResolver: async () => ({
          client: stubClient({ authenticatingKeyId: undefined }),
          keySource: 'user-scoped',
        }),
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CREDENTIAL_NOT_ATTRIBUTABLE');
    // A user-scoped key IS present, so blaming device code would be false here.
    expect(result.error?.message).not.toContain('device code flow must be run');
    expect(result.error?.message).toContain('caller-supplied apiKey override');
  });

  it('reissue reports the keyIds the dashboard actually revoked', async () => {
    const projectRoot = path.join(tempDir, 'reissue-revoked-ids');

    const result = await rbookAuth({ action: 'reissue', projectRoot }, deps());

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'reissue') {
      // The stub dashboard reports ['orphan-id']; the handler used to hardcode [].
      expect(result.data.revokedKeyIds).toEqual(['orphan-id']);
    } else {
      throw new Error('expected a reissue success payload');
    }
  });

  // ─── login (Sprint 58 m01) ───────────────────────────────────────────────

  it('login surfaces verificationUri/userCode on success and persists the minted key', async () => {
    const codeResponse = {
      deviceCode: 'dc-xyz',
      userCode: 'HELLO-9999',
      verificationUri: 'http://dashboard.test/auth/device',
      expiresIn: 600,
      interval: 2,
    };
    const tokenSuccess = {
      key: 'cmk_live_key',
      keyId: 'user-key-abc',
      label: 'device: cmos-mcp/1.0.0 (darwin; host) @ 2026-04-17T12:00:00Z',
    };

    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse(codeResponse))
      .mockImplementationOnce(async () => jsonResponse(tokenSuccess));

    const sleeps: number[] = [];
    const result = await rbookAuth(
      { action: 'login' },
      deps({
        deviceCodeFlow: wrappedFlow(fetchImpl, async (ms) => {
          sleeps.push(ms);
        }),
        dashboardBaseUrl: BASE_URL,
      })
    );

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'login') {
      expect(result.data.verificationUri).toBe(codeResponse.verificationUri);
      expect(result.data.userCode).toBe(codeResponse.userCode);
      expect(result.data.expiresIn).toBe(codeResponse.expiresIn);
      expect(result.data.interval).toBe(codeResponse.interval);
      expect(result.data.keyId).toBe(tokenSuccess.keyId);
      expect(result.data.label).toBe(tokenSuccess.label);
    }

    // runDeviceCodeFlow sleeps `interval` seconds before the first poll.
    expect(sleeps).toEqual([2000]);

    // The minted user-scoped key should be persisted to the credential store.
    const persisted = await store.getUserScopedKey('user-key-abc');
    expect(persisted?.key).toBe('cmk_live_key');
    expect(persisted?.label).toBe(tokenSuccess.label);

    // Both HTTP calls go to the dashboard base URL.
    expect(callsOf(fetchImpl)).toHaveLength(2);
    expect(String(callsOf(fetchImpl)[0][0])).toBe(`${BASE_URL}/api/auth/device/code`);
    expect(String(callsOf(fetchImpl)[1][0])).toBe(`${BASE_URL}/api/auth/device/token`);
  });

  it('login retries through authorization_pending responses then succeeds', async () => {
    const codeResponse = {
      deviceCode: 'dc',
      userCode: 'CODE',
      verificationUri: 'http://dashboard.test/auth/device',
      expiresIn: 600,
      interval: 3,
    };
    const tokenSuccess = { key: 'cmk_k', keyId: 'id', label: 'lbl' };

    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse(codeResponse))
      .mockImplementationOnce(async () => jsonResponse({ error: 'authorization_pending' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ error: 'authorization_pending' }, 400))
      .mockImplementationOnce(async () => jsonResponse(tokenSuccess));

    const sleeps: number[] = [];
    const result = await rbookAuth(
      { action: 'login' },
      deps({
        deviceCodeFlow: wrappedFlow(fetchImpl, async (ms) => {
          sleeps.push(ms);
        }),
        dashboardBaseUrl: BASE_URL,
      })
    );

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'login') {
      expect(result.data.keyId).toBe('id');
    }
    // Three sleeps of 3s each (one before each poll); interval unchanged.
    expect(sleeps).toEqual([3000, 3000, 3000]);
  });

  it('login honors RFC 8628 slow_down by adding +5s to the poll interval', async () => {
    const codeResponse = {
      deviceCode: 'dc',
      userCode: 'CODE',
      verificationUri: 'http://dashboard.test/auth/device',
      expiresIn: 600,
      interval: 2,
    };
    const tokenSuccess = { key: 'k', keyId: 'id', label: 'l' };

    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse(codeResponse))
      .mockImplementationOnce(async () => jsonResponse({ error: 'slow_down' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ error: 'authorization_pending' }, 400))
      .mockImplementationOnce(async () => jsonResponse({ error: 'slow_down' }, 400))
      .mockImplementationOnce(async () => jsonResponse(tokenSuccess));

    const sleeps: number[] = [];
    const result = await rbookAuth(
      { action: 'login' },
      deps({
        deviceCodeFlow: wrappedFlow(fetchImpl, async (ms) => {
          sleeps.push(ms);
        }),
        dashboardBaseUrl: BASE_URL,
      })
    );

    expect(result.success).toBe(true);
    // 2s → slow_down → 7s → pending → 7s → slow_down → 12s → success.
    expect(sleeps).toEqual([2000, 7000, 7000, 12000]);
  });

  it('login maps expired_token to a typed DEVICE_CODE_EXPIRED error', async () => {
    const codeResponse = {
      deviceCode: 'dc',
      userCode: 'CODE',
      verificationUri: 'http://dashboard.test/auth/device',
      expiresIn: 600,
      interval: 1,
    };

    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse(codeResponse))
      .mockImplementationOnce(async () =>
        jsonResponse({ error: 'expired_token', error_description: 'user too slow' }, 400)
      );

    const result = await rbookAuth(
      { action: 'login' },
      deps({
        deviceCodeFlow: wrappedFlow(fetchImpl, async () => {}),
        dashboardBaseUrl: BASE_URL,
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DEVICE_CODE_EXPIRED');
    expect(result.error?.message).toContain('user too slow');
    expect(result.error?.suggestion).toContain('rbook_auth(action="login")');
    // The minted key should not be persisted when the flow fails.
    expect(await store.listUserScopedKeys()).toEqual({});
  });

  it('login maps access_denied to a typed DEVICE_CODE_ACCESS_DENIED error', async () => {
    const codeResponse = {
      deviceCode: 'dc',
      userCode: 'CODE',
      verificationUri: 'http://dashboard.test/auth/device',
      expiresIn: 600,
      interval: 1,
    };

    const fetchImpl = makeFetchMock();
    fetchImpl
      .mockImplementationOnce(async () => jsonResponse(codeResponse))
      .mockImplementationOnce(async () => jsonResponse({ error: 'access_denied' }, 400));

    const result = await rbookAuth(
      { action: 'login' },
      deps({
        deviceCodeFlow: wrappedFlow(fetchImpl, async () => {}),
        dashboardBaseUrl: BASE_URL,
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DEVICE_CODE_ACCESS_DENIED');
    expect(result.error?.suggestion).toContain('verificationUri');
    expect(await store.listUserScopedKeys()).toEqual({});
  });

  it('login maps request_failed / malformed_response to DASHBOARD_ERROR', async () => {
    const fetchImpl = makeFetchMock();
    fetchImpl.mockImplementationOnce(async () => new Response('nope', { status: 503 }));

    const result = await rbookAuth(
      { action: 'login' },
      deps({
        deviceCodeFlow: wrappedFlow(fetchImpl, async () => {}),
        dashboardBaseUrl: BASE_URL,
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
    expect(result.error?.message).toContain('device/code HTTP 503');
  });

  it('login fails with DASHBOARD_NOT_CONFIGURED when no base URL is available', async () => {
    const result = await rbookAuth(
      { action: 'login' },
      deps({
        dashboardBaseUrl: '',
      })
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  // ─── login_init (Sprint 59 m04) ──────────────────────────────────────────

  function stubRequester(response: DeviceCodeResponse): DeviceCodeRequesterImpl {
    return async () => response;
  }

  const DEVICE_CODE_RESPONSE: DeviceCodeResponse = {
    deviceCode: 'dc-xyz',
    userCode: 'WXYZ-1234',
    verificationUri: 'http://dashboard.test/auth/device',
    expiresIn: 600,
    interval: 5,
  };

  it('login_init returns device/code fields immediately and does not poll', async () => {
    const requester = jest.fn(stubRequester(DEVICE_CODE_RESPONSE));
    const poller = jest.fn(async () => {
      throw new Error('login_init must not call the token poller');
    }) as unknown as TokenPollerImpl;

    const result = await rbookAuth(
      { action: 'login_init' },
      deps({
        deviceCodeRequester: requester as unknown as DeviceCodeRequesterImpl,
        tokenPoller: poller,
        dashboardBaseUrl: BASE_URL,
      })
    );

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'login_init') {
      expect(result.data.deviceCode).toBe('dc-xyz');
      expect(result.data.userCode).toBe('WXYZ-1234');
      expect(result.data.verificationUri).toBe(DEVICE_CODE_RESPONSE.verificationUri);
      expect(result.data.expiresIn).toBe(600);
      expect(result.data.interval).toBe(5);
    }
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it('login_init passes the configured baseUrl to the requester', async () => {
    const captured: { baseUrl?: string } = {};
    const requester: DeviceCodeRequesterImpl = async ({ baseUrl }) => {
      captured.baseUrl = baseUrl;
      return DEVICE_CODE_RESPONSE;
    };

    await rbookAuth(
      { action: 'login_init' },
      deps({
        deviceCodeRequester: requester,
        dashboardBaseUrl: BASE_URL,
      })
    );

    expect(captured.baseUrl).toBe(BASE_URL);
  });

  it('login_init uses the baked dashboard default when the env and dependency override are absent', async () => {
    delete process.env[RBOOK_DASHBOARD_URL_ENV];
    const captured: { baseUrl?: string } = {};
    const requester: DeviceCodeRequesterImpl = async ({ baseUrl }) => {
      captured.baseUrl = baseUrl;
      return DEVICE_CODE_RESPONSE;
    };

    const result = await rbookAuth(
      { action: 'login_init' },
      deps({ deviceCodeRequester: requester })
    );

    expect(result.success).toBe(true);
    expect(captured.baseUrl).toBe(DEFAULT_DASHBOARD_URL);
  });

  it('login_init fails with DASHBOARD_NOT_CONFIGURED when no base URL is available', async () => {
    const result = await rbookAuth(
      { action: 'login_init' },
      deps({
        dashboardBaseUrl: '',
      })
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  it('login_init maps a transport failure to DASHBOARD_ERROR', async () => {
    const requester: DeviceCodeRequesterImpl = async () => {
      throw new DeviceCodeError('request_failed', 'device/code HTTP 503: down');
    };

    const result = await rbookAuth(
      { action: 'login_init' },
      deps({
        deviceCodeRequester: requester,
        dashboardBaseUrl: BASE_URL,
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
    expect(result.error?.message).toContain('device/code HTTP 503');
  });

  // ─── login_complete (Sprint 59 m04) ──────────────────────────────────────

  function stubPoller(status: BoundedPollStatus): TokenPollerImpl {
    return async () => status;
  }

  it('login_complete persists the minted key and returns status=approved', async () => {
    const poller = stubPoller({
      status: 'approved',
      key: 'cmk_new',
      keyId: 'new-key-id',
      label: 'new-label',
      intervalSeconds: 2,
    });

    const result = await rbookAuth(
      {
        action: 'login_complete',
        deviceCode: 'dc-xyz',
        maxWaitSeconds: 30,
        pollIntervalSeconds: 2,
      },
      deps({ tokenPoller: poller, dashboardBaseUrl: BASE_URL })
    );

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'login_complete') {
      expect(result.data.status).toBe('approved');
      expect(result.data.keyId).toBe('new-key-id');
      expect(result.data.label).toBe('new-label');
      expect(result.data.intervalSeconds).toBe(2);
    }

    const persisted = await store.getUserScopedKey('new-key-id');
    expect(persisted?.key).toBe('cmk_new');
    expect(persisted?.label).toBe('new-label');
  });

  it('login_complete returns status=pending and does NOT persist anything', async () => {
    const poller = stubPoller({ status: 'pending', intervalSeconds: 7 });

    const result = await rbookAuth(
      { action: 'login_complete', deviceCode: 'dc-xyz' },
      deps({ tokenPoller: poller, dashboardBaseUrl: BASE_URL })
    );

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'login_complete') {
      expect(result.data.status).toBe('pending');
      expect(result.data.intervalSeconds).toBe(7);
      expect(result.data.keyId).toBeUndefined();
    }
    expect(await store.listUserScopedKeys()).toEqual({});
  });

  it('login_complete returns status=expired on expired_token', async () => {
    const poller = stubPoller({ status: 'expired' });

    const result = await rbookAuth(
      { action: 'login_complete', deviceCode: 'dc-xyz' },
      deps({ tokenPoller: poller, dashboardBaseUrl: BASE_URL })
    );

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'login_complete') {
      expect(result.data.status).toBe('expired');
    }
  });

  it('login_complete returns status=denied and preserves description when present', async () => {
    const poller = stubPoller({ status: 'denied', description: 'user rejected' });

    const result = await rbookAuth(
      { action: 'login_complete', deviceCode: 'dc-xyz' },
      deps({ tokenPoller: poller, dashboardBaseUrl: BASE_URL })
    );

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'login_complete') {
      expect(result.data.status).toBe('denied');
      expect(result.data.description).toBe('user rejected');
    }
  });

  it('login_complete maps a transport DeviceCodeError to DASHBOARD_ERROR', async () => {
    const poller: TokenPollerImpl = async () => {
      throw new DeviceCodeError('request_failed', 'device/token HTTP 503: down');
    };

    const result = await rbookAuth(
      { action: 'login_complete', deviceCode: 'dc-xyz' },
      deps({ tokenPoller: poller, dashboardBaseUrl: BASE_URL })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
  });

  it('login_complete fails with DASHBOARD_NOT_CONFIGURED when no base URL is available', async () => {
    const result = await rbookAuth(
      { action: 'login_complete', deviceCode: 'dc-xyz' },
      deps({ dashboardBaseUrl: '' })
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  it('login_complete fails with MISSING_PARAMETER when deviceCode is absent', async () => {
    const poller = stubPoller({ status: 'pending', intervalSeconds: 2 });

    const result = await rbookAuth(
      { action: 'login_complete' },
      deps({ tokenPoller: poller, dashboardBaseUrl: BASE_URL })
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
  });

  it('login_complete passes through maxWaitSeconds + pollIntervalSeconds overrides', async () => {
    const captured: { maxWaitSeconds?: number; intervalSeconds?: number; deviceCode?: string } = {};
    const poller: TokenPollerImpl = async (opts) => {
      captured.maxWaitSeconds = opts.maxWaitSeconds;
      captured.intervalSeconds = opts.intervalSeconds;
      captured.deviceCode = opts.deviceCode;
      return { status: 'pending', intervalSeconds: opts.intervalSeconds };
    };

    await rbookAuth(
      {
        action: 'login_complete',
        deviceCode: 'dc-xyz',
        maxWaitSeconds: 45,
        pollIntervalSeconds: 4,
      },
      deps({ tokenPoller: poller, dashboardBaseUrl: BASE_URL })
    );

    expect(captured.maxWaitSeconds).toBe(45);
    expect(captured.intervalSeconds).toBe(4);
    expect(captured.deviceCode).toBe('dc-xyz');
  });

  it('login_complete defaults to maxWaitSeconds=30 + pollIntervalSeconds=2 when omitted', async () => {
    const captured: { maxWaitSeconds?: number; intervalSeconds?: number } = {};
    const poller: TokenPollerImpl = async (opts) => {
      captured.maxWaitSeconds = opts.maxWaitSeconds;
      captured.intervalSeconds = opts.intervalSeconds;
      return { status: 'pending', intervalSeconds: opts.intervalSeconds };
    };

    await rbookAuth(
      { action: 'login_complete', deviceCode: 'dc-xyz' },
      deps({ tokenPoller: poller, dashboardBaseUrl: BASE_URL })
    );

    expect(captured.maxWaitSeconds).toBe(30);
    expect(captured.intervalSeconds).toBe(2);
  });

  // ─── logout (Sprint 59 m03) ──────────────────────────────────────────────

  it('logout auto-picks the keyId when exactly one user-scoped key is in the store', async () => {
    await store.upsertUserScopedKey('solo-key-id', userRecord({ key: 'cmk_solo' }));

    const captured: { keyId?: string } = {};
    const result = await rbookAuth(
      { action: 'logout' },
      deps({
        clientResolver: async () =>
          stubClient({
            revoke: {
              success: true,
              data: { keyId: 'solo-key-id', revokedAt: '2026-04-23T23:30:00Z' },
            } as RbookToolResult<RevokeKeyResult>,
          }),
        // Capture the keyId the client was called with by intercepting the stub.
        // Not needed explicitly — the result's keyId is already the proof.
      })
    );
    // Reference captured to avoid unused-variable lint complaint.
    expect(captured.keyId).toBeUndefined();

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'logout') {
      expect(result.data.keyId).toBe('solo-key-id');
      expect(result.data.revokedAt).toBe('2026-04-23T23:30:00Z');
    }
    expect(await store.getUserScopedKey('solo-key-id')).toBeUndefined();
  });

  it('logout targets an explicit keyId even when it is one of several user-scoped keys', async () => {
    await store.upsertUserScopedKey('key-a', userRecord({ key: 'cmk_a' }));
    await store.upsertUserScopedKey('key-b', userRecord({ key: 'cmk_b' }));

    const result = await rbookAuth(
      { action: 'logout', keyId: 'key-b' },
      deps({
        clientResolver: async () =>
          stubClient({
            revoke: {
              success: true,
              data: { keyId: 'key-b', revokedAt: '2026-04-23T23:31:00Z' },
            } as RbookToolResult<RevokeKeyResult>,
          }),
      })
    );

    expect(result.success).toBe(true);
    if (result.success && result.data?.action === 'logout') {
      expect(result.data.keyId).toBe('key-b');
    }
    // Only the targeted key is removed; the other stays.
    expect(await store.getUserScopedKey('key-a')).toBeDefined();
    expect(await store.getUserScopedKey('key-b')).toBeUndefined();
  });

  it('logout fails with CREDENTIAL_NOT_FOUND when the local store has no user-scoped keys', async () => {
    const result = await rbookAuth({ action: 'logout' }, deps());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CREDENTIAL_NOT_FOUND');
    expect(result.error?.suggestion).toContain('login_init');
  });

  it('logout fails with MISSING_PARAMETER when multiple user-scoped keys exist and no keyId supplied', async () => {
    await store.upsertUserScopedKey('key-a', userRecord({ key: 'cmk_a' }));
    await store.upsertUserScopedKey('key-b', userRecord({ key: 'cmk_b' }));

    const result = await rbookAuth({ action: 'logout' }, deps());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
    expect(result.error?.message).toContain('Multiple user-scoped keys');
  });

  it('logout fails with CREDENTIAL_NOT_FOUND when an explicit keyId is not a user-scoped row locally', async () => {
    // Seed a different user-scoped row so "empty store" isn't the trigger.
    await store.upsertUserScopedKey('key-a', userRecord({ key: 'cmk_a' }));

    const result = await rbookAuth({ action: 'logout', keyId: 'project-key-id' }, deps());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CREDENTIAL_NOT_FOUND');
    expect(result.error?.suggestion).toContain('revoke');
  });

  it('logout surfaces dashboard revoke failures and keeps the local row intact', async () => {
    await store.upsertUserScopedKey('solo-key-id', userRecord({ key: 'cmk_solo' }));

    const result = await rbookAuth(
      { action: 'logout' },
      deps({
        clientResolver: async () =>
          stubClient({
            revoke: {
              success: false,
              error: { code: 'DASHBOARD_ERROR', message: 'revoke 500' },
            } as RbookToolResult<RevokeKeyResult>,
          }),
      })
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('revoke 500');
    // Local row must NOT be removed when the dashboard call failed.
    expect(await store.getUserScopedKey('solo-key-id')).toBeDefined();
  });

  it('logout leaves project-scoped child rows alone (no cascade cleanup)', async () => {
    await store.upsertUserScopedKey('parent-key', userRecord({ key: 'cmk_parent' }));
    const projectRoot = path.join(tempDir, 'logout-child');
    await store.upsertProjectKey(
      projectRoot,
      projectRecord({ keyId: 'child-key', parentKeyId: 'parent-key', key: 'cmk_child' })
    );

    const result = await rbookAuth(
      { action: 'logout' },
      deps({
        clientResolver: async () =>
          stubClient({
            revoke: {
              success: true,
              data: { keyId: 'parent-key', revokedAt: '2026-04-23T23:32:00Z' },
            } as RbookToolResult<RevokeKeyResult>,
          }),
      })
    );

    expect(result.success).toBe(true);
    expect(await store.getUserScopedKey('parent-key')).toBeUndefined();
    // Child project-scoped row should still exist — logout does not cascade.
    const child = await store.getProjectKey(projectRoot);
    expect(child?.keyId).toBe('child-key');
    expect(child?.key).toBe('cmk_child');
  });

  it('logout fails with DASHBOARD_NOT_CONFIGURED when no client is available', async () => {
    await store.upsertUserScopedKey('solo-key-id', userRecord({ key: 'cmk_solo' }));
    const result = await rbookAuth(
      { action: 'logout' },
      deps({ clientResolver: async () => null })
    );
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
    // And the local row should not be cleared since we never even attempted revoke.
    expect(await store.getUserScopedKey('solo-key-id')).toBeDefined();
  });
});

// ─── Live dashboard (Sprint 58 m03) ───────────────────────────────────────
//
// Set RBOOK_LIVE_DASHBOARD=1 AND RBOOK_DASHBOARD_URL=https://reasonbook.ai to
// exercise the full login → list → revoke lifecycle against the real API.
// The test block revokes the freshly minted user-scoped key at the end so
// it doesn't accumulate orphans on the dashboard. Do not run in CI.

describeLive('rbook_auth — live dashboard', () => {
  let config: LiveDashboardConfig;
  let liveStore: CredentialStore;

  beforeEach(async () => {
    config = await setUpLiveConfig('rbook-auth');
    CredentialStore.resetInstance();
    liveStore = await CredentialStore.create({ configDir: config.tempConfigDir });
  });

  afterEach(async () => {
    CredentialStore.resetInstance();
    await tearDownLiveConfig(config);
  });

  it(
    'mints a user-scoped key, lists it under mine-only, and revokes it for cleanup',
    async () => {
      // 1. login — runs real RFC 8628 against the dashboard; requires browser approval.
      const login = await rbookAuth(
        { action: 'login' },
        { store: liveStore, dashboardBaseUrl: config.baseUrl }
      );
      expect(login.success).toBe(true);
      if (!login.success || login.data?.action !== 'login') return;
      const { keyId, label } = login.data;
      expect(keyId).toBeTruthy();
      expect(label).toBeTruthy();

      // 2. list — the minted key should show up under mine-only=true.
      const list = await rbookAuth(
        { action: 'list', mineOnly: true },
        { store: liveStore, dashboardBaseUrl: config.baseUrl }
      );
      expect(list.success).toBe(true);
      if (!list.success || list.data?.action !== 'list') return;
      const matchingUserKey = list.data.userScoped.find((k) => k.id === keyId);
      expect(matchingUserKey).toBeDefined();

      // 3. revoke — clean up so we don't accumulate orphans. Sprint 59 m02
      // landed the unified POST /api/keys/:keyId/revoke endpoint, so revoke
      // works for user-scoped rows directly without the legacy
      // projectRoot/projectId workaround.
      const revoke = await rbookAuth(
        { action: 'revoke', keyId },
        { store: liveStore, dashboardBaseUrl: config.baseUrl }
      );
      expect(revoke.success).toBe(true);
      if (revoke.success && revoke.data?.action === 'revoke') {
        expect(revoke.data.scope).toBe('user');
        expect(revoke.data.keyId).toBe(keyId);
      } else {
        // eslint-disable-next-line no-console
        console.error(
          `[live] manual cleanup required: keyId=${keyId} label="${label}" — revoke returned ${revoke.error?.code ?? 'unknown'}: ${revoke.error?.message ?? 'no message'}`
        );
      }
    },
    10 * 60 * 1000
  );

  // Sprint 59 m04 — verifies the non-blocking two-call flow against a real
  // dashboard. login_init should return in under a second; login_complete
  // blocks only for the bounded maxWaitSeconds window (default 30s).
  // Requires human browser approval between the two tool calls.
  it(
    'login_init + login_complete two-call flow mints + persists a user-scoped key',
    async () => {
      // 1. login_init — returns the device code payload immediately.
      const initStart = Date.now();
      const init = await rbookAuth(
        { action: 'login_init' },
        { store: liveStore, dashboardBaseUrl: config.baseUrl }
      );
      const initElapsed = Date.now() - initStart;
      expect(init.success).toBe(true);
      if (!init.success || init.data?.action !== 'login_init') return;
      expect(init.data.deviceCode).toBeTruthy();
      expect(init.data.userCode).toBeTruthy();
      expect(init.data.verificationUri).toBeTruthy();
      // Should be fast — this is the whole point of the two-call split.
      // Generous 5s bound covers cold-start DNS + TLS handshake.
      expect(initElapsed).toBeLessThan(5000);

      // Surface the prompt so the human running the test knows what to do.
      // eslint-disable-next-line no-console
      console.error(
        `\n[live] Two-call login — approve in browser within ${init.data.expiresIn}s:\n` +
          `  Open: ${init.data.verificationUri}\n` +
          `  Code: ${init.data.userCode}\n`
      );

      // 2. login_complete — poll until approved. Loop to simulate the agent
      // behavior; in production the agent would typically call this after
      // the user confirms approval.
      let approvedKeyId: string | undefined;
      let approvedLabel: string | undefined;
      let remainingSeconds = init.data.expiresIn;
      let intervalSeconds = init.data.interval;
      const MAX_WAIT_PER_CALL = 30;

      while (remainingSeconds > 0) {
        const wait = Math.min(MAX_WAIT_PER_CALL, remainingSeconds);
        const complete = await rbookAuth(
          {
            action: 'login_complete',
            deviceCode: init.data.deviceCode,
            maxWaitSeconds: wait,
            pollIntervalSeconds: intervalSeconds,
          },
          { store: liveStore, dashboardBaseUrl: config.baseUrl }
        );
        expect(complete.success).toBe(true);
        if (!complete.success || complete.data?.action !== 'login_complete') return;

        if (complete.data.status === 'approved') {
          approvedKeyId = complete.data.keyId;
          approvedLabel = complete.data.label;
          break;
        }
        if (complete.data.status === 'expired' || complete.data.status === 'denied') {
          throw new Error(
            `Login ${complete.data.status}${complete.data.description ? `: ${complete.data.description}` : ''}`
          );
        }
        // pending — carry adjusted interval, deduct budget, loop.
        intervalSeconds = complete.data.intervalSeconds ?? intervalSeconds;
        remainingSeconds -= wait;
      }

      expect(approvedKeyId).toBeTruthy();
      expect(approvedLabel).toBeTruthy();

      // The minted user-scoped key must be persisted after login_complete.
      if (approvedKeyId) {
        const persisted = await liveStore.getUserScopedKey(approvedKeyId);
        expect(persisted?.key).toMatch(/^cmk_/);
        expect(persisted?.label).toBe(approvedLabel);
      }

      // Cleanup: revoke the freshly minted key so orphans don't accumulate.
      // Uses the Sprint 59 m02 unified POST /api/keys/:keyId/revoke endpoint.
      if (approvedKeyId) {
        const revoke = await rbookAuth(
          { action: 'revoke', keyId: approvedKeyId },
          { store: liveStore, dashboardBaseUrl: config.baseUrl }
        );
        if (!revoke.success) {
          // eslint-disable-next-line no-console
          console.error(
            `[live] manual cleanup required: keyId=${approvedKeyId} label="${approvedLabel}" — revoke returned ${revoke.error?.code ?? 'unknown'}: ${revoke.error?.message ?? 'no message'}`
          );
        }
      }
    },
    10 * 60 * 1000
  );
});
