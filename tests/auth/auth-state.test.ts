// ABOUTME: Unit tests for computeAuthState — Sprint 57 m04 + Sprint 58 m02.
// ABOUTME: Covers identitySource inference, deliveryAck override, projectKey-only / userKey-only / empty / mid-rotation / authTier.

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { computeAuthState } from '../../src/auth/auth-state';
import { recordDeliveryAck, resetDeliveryAckCache } from '../../src/auth/delivery-ack-cache';
import { RBOOK_CONFIG_DIR_ENV, CredentialStore } from '../../src/intelligence/credential-store';
import type {
  ProjectKeyRecord,
  UserScopedKeyRecord,
} from '../../src/intelligence/credential-store';
import {
  RBOOK_DASHBOARD_API_KEY_ENV,
  RBOOK_DASHBOARD_USER_ENV,
  RBOOK_DASHBOARD_PASSWORD_ENV,
} from '../../src/tools/rbook/dashboard-client';

function userRecord(overrides: Partial<UserScopedKeyRecord> = {}): UserScopedKeyRecord {
  const now = new Date().toISOString();
  return {
    key: 'cmk_user',
    label: 'device: cmos-mcp/1.0.0 (darwin; host)',
    issuedAt: now,
    lastUsedAt: now,
    ...overrides,
  };
}

function projectRecord(overrides: Partial<ProjectKeyRecord> = {}): ProjectKeyRecord {
  const now = new Date().toISOString();
  return {
    key: 'cmk_project',
    keyId: 'project-key-id',
    parentKeyId: 'user-parent-id',
    label: 'auto: registered',
    issuedAt: now,
    lastUsedAt: now,
    ...overrides,
  };
}

describe('computeAuthState', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let store: CredentialStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-state-'));
    delete process.env[RBOOK_CONFIG_DIR_ENV];
    CredentialStore.resetInstance();
    resetDeliveryAckCache();
    store = await CredentialStore.create({ configDir: tempDir });
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    CredentialStore.resetInstance();
    resetDeliveryAckCache();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns identitySource="none" with a warning when nothing is configured', async () => {
    const result = await computeAuthState({ store });
    expect(result.identitySource).toBe('none');
    expect(result.identitySourceObserved).toBe(false);
    expect(result.projectKey).toBeNull();
    expect(result.userScopedKey).toBeNull();
    expect(result.warning).toMatch(/No dashboard credentials/);
  });

  it('infers "api-key" from local state when only user-scoped keys exist (no project key, no ack)', async () => {
    await store.upsertUserScopedKey('user-1', userRecord({ key: 'cmk_u1' }));
    const result = await computeAuthState({ store });
    expect(result.identitySource).toBe('api-key');
    expect(result.identitySourceObserved).toBe(false);
    expect(result.userScopedKey?.keyId).toBe('user-1');
    expect(result.userScopedKey?.issuedVia).toBe('device_code');
    expect(result.projectKey).toBeNull();
  });

  it('exposes the project key when one exists for the requested projectRoot', async () => {
    const projectRoot = path.join(tempDir, 'p');
    await store.upsertUserScopedKey('user-1', userRecord());
    await store.upsertProjectKey(projectRoot, projectRecord({ keyId: 'pk-1' }));

    const result = await computeAuthState({ projectRoot, store });
    expect(result.projectKey?.keyId).toBe('pk-1');
    expect(result.projectKey?.issuedVia).toBe('registration_auto');
    expect(result.projectKey?.parentKeyId).toBe('user-parent-id');
    expect(result.projectKey?.revokeAt).toBeNull();
    expect(result.warning).toBeNull();
  });

  it('surfaces revokeAt from a pendingRevoke slot during rotation', async () => {
    const projectRoot = path.join(tempDir, 'rotating');
    await store.swapProjectKey(projectRoot, projectRecord({ keyId: 'new-key', key: 'cmk_new' }), {
      key: 'cmk_old',
      keyId: 'old-key',
      revokeAt: '2099-01-01T00:00:00Z',
    });

    const result = await computeAuthState({ projectRoot, store });
    expect(result.projectKey?.keyId).toBe('new-key');
    expect(result.projectKey?.revokeAt).toBe('2099-01-01T00:00:00Z');
  });

  it('overrides the inferred identitySource when a deliveryAck has been observed', async () => {
    await store.upsertUserScopedKey('u', userRecord());
    recordDeliveryAck('request-body');

    const result = await computeAuthState({ store });
    expect(result.identitySource).toBe('request-body');
    expect(result.identitySourceObserved).toBe(true);
    expect(result.lastDeliveryObservedAt).toBeTruthy();
    expect(result.warning).toMatch(/legacy user-scoped/i);
  });

  it('newest user-scoped key (by issuedAt) wins when multiple are present', async () => {
    await store.upsertUserScopedKey(
      'old',
      userRecord({ key: 'cmk_old', issuedAt: '2026-01-01T00:00:00Z' })
    );
    await store.upsertUserScopedKey(
      'new',
      userRecord({ key: 'cmk_new', issuedAt: '2026-04-17T00:00:00Z' })
    );

    const result = await computeAuthState({ store });
    expect(result.userScopedKey?.keyId).toBe('new');
  });

  it('newest user-scoped key wins by instant whatever the stored spelling (s107-m01, #788)', async () => {
    // The store takes issuedAt as given, so the upload fallback's own test writes an offset.
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
      await store.upsertUserScopedKey('newer', userRecord({ issuedAt: newer }));
      await store.upsertUserScopedKey('older', userRecord({ issuedAt: older }));
      expect(older > newer).toBe(true);
      expect((await computeAuthState({ store })).userScopedKey?.keyId).toBe('newer');
    }
  });

  it('warns when projectRoot is supplied but no project key has been issued yet', async () => {
    await store.upsertUserScopedKey('u', userRecord());
    const result = await computeAuthState({ projectRoot: path.join(tempDir, 'unbound'), store });
    expect(result.projectKey).toBeNull();
    expect(result.userScopedKey).not.toBeNull();
    expect(result.warning).toMatch(/No project-scoped key for this project root/);
  });

  // ─── authTier (Sprint 58 m02) ──────────────────────────────────────────

  it('authTier="device-code" whenever a user-scoped key is present in the store', async () => {
    await store.upsertUserScopedKey('u', userRecord());
    // Env vars should be ignored when the store has keys — the priority
    // chain takes the store first.
    process.env[RBOOK_DASHBOARD_API_KEY_ENV] = 'cmk_legacy';
    const result = await computeAuthState({ store });
    expect(result.authTier).toBe('device-code');
  });

  it('authTier="legacy-env" when the store is empty and RBOOK_DASHBOARD_API_KEY is set', async () => {
    delete process.env[RBOOK_DASHBOARD_USER_ENV];
    delete process.env[RBOOK_DASHBOARD_PASSWORD_ENV];
    process.env[RBOOK_DASHBOARD_API_KEY_ENV] = 'cmk_legacy';
    const result = await computeAuthState({ store });
    expect(result.authTier).toBe('legacy-env');
  });

  it('authTier="password-fallback" when only USER + PASSWORD env vars are set', async () => {
    delete process.env[RBOOK_DASHBOARD_API_KEY_ENV];
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'user@example.com';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'secret';
    const result = await computeAuthState({ store });
    expect(result.authTier).toBe('password-fallback');
  });

  it('authTier="none" when nothing is configured', async () => {
    delete process.env[RBOOK_DASHBOARD_API_KEY_ENV];
    delete process.env[RBOOK_DASHBOARD_USER_ENV];
    delete process.env[RBOOK_DASHBOARD_PASSWORD_ENV];
    const result = await computeAuthState({ store });
    expect(result.authTier).toBe('none');
  });
});
