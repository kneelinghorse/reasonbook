// ABOUTME: Sprint 58 m02 — runStartupCredentialCheck emits a [WARN] when the credential store has no user-scoped keys.
// ABOUTME: Hermetic: tempdir store + captured writer; no MCP server.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { runStartupCredentialCheck } from '../../src/auth/project-key-capture';
import { RBOOK_CONFIG_DIR_ENV, CredentialStore } from '../../src/intelligence/credential-store';

describe('runStartupCredentialCheck', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let store: CredentialStore;
  let writes: string[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-cred-check-'));
    delete process.env[RBOOK_CONFIG_DIR_ENV];
    CredentialStore.resetInstance();
    store = await CredentialStore.create({ configDir: tempDir });
    writes = [];
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('emits a one-line [WARN] on an empty store WHEN a dashboard is configured', async () => {
    const result = await runStartupCredentialCheck({
      store,
      writer: (line) => writes.push(line),
      dashboardUrl: 'https://reasonbook.ai',
    });

    expect(result.status).toBe('empty-credential-store');
    expect(result.warned).toBe(true);
    expect(result.dashboardConfigured).toBe(true);
    expect(result.userScopedKeyCount).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/\[WARN\]/);
    expect(writes[0]).toMatch(/no user-scoped credentials found/);
    expect(writes[0]).toMatch(
      /rbook_auth\(action="login_init"\), then rbook_auth\(action="login_complete"\)/
    );
  });

  it('s78-m06: is SILENT on an empty store when NO dashboard is configured (local-forever)', async () => {
    const result = await runStartupCredentialCheck({
      store,
      writer: (line) => writes.push(line),
      dashboardUrl: '',
    });

    expect(result.status).toBe('empty-credential-store');
    expect(result.warned).toBe(false);
    expect(result.dashboardConfigured).toBe(false);
    expect(result.userScopedKeyCount).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('s78-m06: treats a whitespace-only dashboard URL as unconfigured (silent)', async () => {
    const result = await runStartupCredentialCheck({
      store,
      writer: (line) => writes.push(line),
      dashboardUrl: '   ',
    });
    expect(result.warned).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('is silent when at least one user-scoped key is present', async () => {
    await store.upsertUserScopedKey('user-1', {
      key: 'cmk_user',
      label: 'device',
      issuedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });

    const result = await runStartupCredentialCheck({
      store,
      writer: (line) => writes.push(line),
    });

    expect(result.status).toBe('has-user-scoped-keys');
    expect(result.warned).toBe(false);
    expect(result.userScopedKeyCount).toBe(1);
    expect(writes).toHaveLength(0);
  });
});
