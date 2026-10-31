// ABOUTME: Resolution tests for DashboardClient.fromEnvForProject against the Sprint 57 CredentialStore.
// ABOUTME: Verifies project-scoped → newest user-scoped → env fallback → email/password precedence.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  DashboardClient,
  RBOOK_DASHBOARD_URL_ENV,
  RBOOK_DASHBOARD_API_KEY_ENV,
  RBOOK_DASHBOARD_USER_ENV,
  RBOOK_DASHBOARD_PASSWORD_ENV,
} from '../../../src/tools/rbook/dashboard-client';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import type {
  ProjectKeyRecord,
  UserScopedKeyRecord,
} from '../../../src/intelligence/credential-store';

describe('DashboardClient.fromEnvForProject (credential-store wiring)', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-key-'));
    delete process.env[RBOOK_DASHBOARD_API_KEY_ENV];
    delete process.env[RBOOK_DASHBOARD_USER_ENV];
    delete process.env[RBOOK_DASHBOARD_PASSWORD_ENV];
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'http://localhost:9999';
    CredentialStore.resetInstance();
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function userKey(overrides: Partial<UserScopedKeyRecord> = {}): UserScopedKeyRecord {
    const now = new Date().toISOString();
    return {
      key: 'cmk_user',
      label: 'user-key',
      issuedAt: now,
      lastUsedAt: now,
      ...overrides,
    };
  }

  function projectKey(overrides: Partial<ProjectKeyRecord> = {}): ProjectKeyRecord {
    const now = new Date().toISOString();
    return {
      key: 'cmk_project',
      keyId: 'p-1',
      parentKeyId: 'u-1',
      label: 'project-key',
      issuedAt: now,
      lastUsedAt: now,
      ...overrides,
    };
  }

  it('returns project-scoped key when the store has one for the caller projectRoot', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'project-x');
    // Seed the file directly (upsertProjectKey lands in m02).
    await fs.writeFile(
      store.path,
      JSON.stringify({
        version: 1,
        userScopedKeys: { 'u-1': userKey({ key: 'cmk_user_fallback' }) },
        projectKeys: { [path.resolve(projectRoot)]: projectKey({ key: 'cmk_project_hit' }) },
        updatedAt: new Date().toISOString(),
      })
    );
    store.clearCache();

    const result = await DashboardClient.fromEnvForProject(projectRoot, {
      credentialStore: store,
    });
    expect(result.success).toBe(true);
    expect(result.data?.keySource).toBe('project-scoped');
    expect(result.data?.matchedProjectRoot).toBe(path.resolve(projectRoot));
  });

  it('falls back to the newest user-scoped key when no project-scoped key exists', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey(
      'old-key',
      userKey({ key: 'cmk_old', issuedAt: '2026-01-01T00:00:00Z' })
    );
    await store.upsertUserScopedKey(
      'new-key',
      userKey({ key: 'cmk_new', issuedAt: '2026-04-17T00:00:00Z' })
    );

    const result = await DashboardClient.fromEnvForProject('/not/registered', {
      credentialStore: store,
    });
    expect(result.success).toBe(true);
    expect(result.data?.keySource).toBe('user-scoped');
    expect(result.data?.matchedProjectRoot).toBeNull();
    // Can't read the apiKey off the client directly (private), but we can confirm
    // it's a DashboardClient instance that selected user-scoped precedence.
    expect(result.data?.client).toBeInstanceOf(DashboardClient);
  });

  it('falls back to the newest user-scoped key by instant whatever the stored spelling (s107-m01, #788)', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    // Today's UTC midday, so a minute either side stays on the same date at any hour of the run.
    const midday = new Date();
    midday.setUTCHours(12, 0, 0, 0);
    const now = midday.getTime();
    const spellings: Array<[newer: string, older: string]> = [
      // An offset spelling of the older instant sorts after the newer key's Z spelling.
      [
        new Date(now).toISOString(),
        new Date(now - 60_000 + 2 * 3_600_000).toISOString().replace('Z', '+02:00'),
      ],
      // SQLite's zone-less spelling of the newer instant sorts before the older key's T.
      [
        new Date(now).toISOString().replace('T', ' ').slice(0, 19),
        new Date(now - 60_000).toISOString(),
      ],
    ];
    for (const [newer, older] of spellings) {
      await store.upsertUserScopedKey('newer', userKey({ key: 'cmk_newer', issuedAt: newer }));
      await store.upsertUserScopedKey('older', userKey({ key: 'cmk_older', issuedAt: older }));
      expect(older > newer).toBe(true);
      const result = await DashboardClient.fromEnvForProject('/not/registered', {
        credentialStore: store,
      });
      expect(result.data?.keySource).toBe('user-scoped');
      expect(result.data?.client.authenticatingKeyId).toBe('newer');
    }
  });

  it('falls back to RBOOK_DASHBOARD_API_KEY env var when the store is empty', async () => {
    process.env[RBOOK_DASHBOARD_API_KEY_ENV] = 'cmk_legacy_env';
    const store = await CredentialStore.create({ configDir: tempDir });

    const result = await DashboardClient.fromEnvForProject('/any', {
      credentialStore: store,
    });
    expect(result.success).toBe(true);
    // Sprint 58 m02: arm 4 now reports 'legacy-env' (was 'user-scoped') so the
    // onboard authTier + migration WARN can distinguish this path.
    expect(result.data?.keySource).toBe('legacy-env');
  });

  it('falls back to email/password as the terminal path', async () => {
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'test@example.com';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'pw';
    const store = await CredentialStore.create({ configDir: tempDir });

    const result = await DashboardClient.fromEnvForProject('/any', {
      credentialStore: store,
    });
    expect(result.success).toBe(true);
    // Sprint 58 m02: arm 5 now reports 'password-fallback' (was 'none') for
    // the same migration-tier surfacing reason.
    expect(result.data?.keySource).toBe('password-fallback');
  });

  it('returns DASHBOARD_NOT_CONFIGURED when nothing is configured', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const result = await DashboardClient.fromEnvForProject('/any', { credentialStore: store });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  it('explicit apiKey override bypasses the credential store', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('u', userKey({ key: 'cmk_ignored' }));

    const result = await DashboardClient.fromEnvForProject('/any', {
      apiKey: 'cmk_explicit',
      credentialStore: store,
    });
    expect(result.success).toBe(true);
    expect(result.data?.keySource).toBe('user-scoped');
    expect(result.data?.matchedProjectRoot).toBeNull();
  });

  // Sprint 62 m02: baseUrl has a baked default (https://reasonbook.ai), so
  // missing RBOOK_DASHBOARD_URL no longer blocks credential resolution. With a
  // store hit available, fromEnvForProject succeeds against the default host.
  it('falls back to baked default URL when RBOOK_DASHBOARD_URL is missing and a store key is present', async () => {
    delete process.env[RBOOK_DASHBOARD_URL_ENV];
    const store = await CredentialStore.create({ configDir: tempDir });
    await store.upsertUserScopedKey('u', userKey({ key: 'cmk_u' }));

    const result = await DashboardClient.fromEnvForProject('/any', { credentialStore: store });
    expect(result.success).toBe(true);
    expect(result.data?.keySource).toBe('user-scoped');
  });

  it('normalizes projectRoot via path.resolve so the lookup hits regardless of trailing slash', async () => {
    const store = await CredentialStore.create({ configDir: tempDir });
    const projectRoot = path.join(tempDir, 'project-y');
    await fs.writeFile(
      store.path,
      JSON.stringify({
        version: 1,
        userScopedKeys: {},
        projectKeys: { [path.resolve(projectRoot)]: projectKey({ key: 'cmk_proj_y' }) },
        updatedAt: new Date().toISOString(),
      })
    );
    store.clearCache();

    const withSlash = `${projectRoot}/`;
    const result = await DashboardClient.fromEnvForProject(withSlash, { credentialStore: store });
    expect(result.success).toBe(true);
    expect(result.data?.keySource).toBe('project-scoped');
  });
});
