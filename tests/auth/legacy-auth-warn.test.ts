// ABOUTME: Sprint 58 m02 — WARN emission tests for fromEnvForProject arms 4 (legacy env) and 5 (password).
// ABOUTME: Each WARN fires at most once per process per arm; hermetic tempdir store; no network.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import {
  RBOOK_DASHBOARD_API_KEY_ENV,
  RBOOK_DASHBOARD_URL_ENV,
  RBOOK_DASHBOARD_USER_ENV,
  RBOOK_DASHBOARD_PASSWORD_ENV,
  DashboardClient,
  __resetLegacyAuthWarnSeen,
} from '../../src/tools/rbook/dashboard-client';
import { RBOOK_CONFIG_DIR_ENV, CredentialStore } from '../../src/intelligence/credential-store';

describe('fromEnvForProject legacy-auth WARN', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let store: CredentialStore;
  let writes: string[];
  let restoreWrite: (() => void) | null = null;

  function captureStderr(): void {
    writes = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
      writes.push(
        typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk as Uint8Array)
      );
      return true;
    };
    restoreWrite = () => {
      process.stderr.write = original;
    };
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-warn-'));
    // Clear every env var we care about so arms 1-3 cannot accidentally fire.
    delete process.env[RBOOK_CONFIG_DIR_ENV];
    delete process.env[RBOOK_DASHBOARD_API_KEY_ENV];
    delete process.env[RBOOK_DASHBOARD_USER_ENV];
    delete process.env[RBOOK_DASHBOARD_PASSWORD_ENV];
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'http://dashboard.test';
    CredentialStore.resetInstance();
    store = await CredentialStore.create({ configDir: tempDir });
    __resetLegacyAuthWarnSeen();
    captureStderr();
  });

  afterEach(async () => {
    if (restoreWrite) restoreWrite();
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    __resetLegacyAuthWarnSeen();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('WARNs exactly once when arm 4 (RBOOK_DASHBOARD_API_KEY) fires', async () => {
    process.env[RBOOK_DASHBOARD_API_KEY_ENV] = 'cmk_legacy';

    const first = await DashboardClient.fromEnvForProject(undefined, { credentialStore: store });
    const second = await DashboardClient.fromEnvForProject(undefined, { credentialStore: store });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success) expect(first.data?.keySource).toBe('legacy-env');

    const warnLines = writes.filter((w) => w.includes('[WARN]'));
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toMatch(/authenticating via legacy-env/);
    expect(warnLines[0]).toMatch(
      /rbook_auth\(action="login_init"\), then rbook_auth\(action="login_complete"\)/
    );
  });

  it('WARNs exactly once when arm 5 (password fallback) fires', async () => {
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'user@example.com';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'secret';

    const first = await DashboardClient.fromEnvForProject(undefined, { credentialStore: store });
    const second = await DashboardClient.fromEnvForProject(undefined, { credentialStore: store });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success) expect(first.data?.keySource).toBe('password-fallback');

    const warnLines = writes.filter((w) => w.includes('[WARN]'));
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toMatch(/authenticating via password-fallback/);
    expect(warnLines[0]).toMatch(
      /rbook_auth\(action="login_init"\), then rbook_auth\(action="login_complete"\)/
    );
  });

  it('each arm tracks its own seen-state (arm 4 and arm 5 warn independently)', async () => {
    process.env[RBOOK_DASHBOARD_API_KEY_ENV] = 'cmk_legacy';
    await DashboardClient.fromEnvForProject(undefined, { credentialStore: store });
    expect(writes.filter((w) => w.includes('legacy-env'))).toHaveLength(1);

    delete process.env[RBOOK_DASHBOARD_API_KEY_ENV];
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'u';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'p';
    await DashboardClient.fromEnvForProject(undefined, { credentialStore: store });

    expect(writes.filter((w) => w.includes('password-fallback'))).toHaveLength(1);
    expect(writes.filter((w) => w.includes('[WARN]'))).toHaveLength(2);
  });

  it('does not WARN when arms 1-3 fire (store has user-scoped key)', async () => {
    await store.upsertUserScopedKey('user-1', {
      key: 'cmk_user',
      label: 'device',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
    process.env[RBOOK_DASHBOARD_API_KEY_ENV] = 'cmk_legacy';

    const result = await DashboardClient.fromEnvForProject(undefined, { credentialStore: store });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data?.keySource).toBe('user-scoped');

    // The store key wins (arm 3); legacy env var never triggers.
    expect(writes.filter((w) => w.includes('[WARN]'))).toHaveLength(0);
  });
});
