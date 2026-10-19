// ABOUTME: Tests for rbook_status — Sprint 62 m06 at-a-glance status payload.
// ABOUTME: Verifies the 5 frozen fields, cross-side parity with onboard.authState.authTier, and graceful local-only fallback.

import Database from 'better-sqlite3';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookStatus,
  rbookStatusToolDefinition,
  formatStatusForLLM,
} from '../../../src/tools/rbook/rbook-status';
import {
  DashboardClient,
  RBOOK_DASHBOARD_URL_ENV,
  RBOOK_DASHBOARD_API_KEY_ENV,
  RBOOK_DASHBOARD_USER_ENV,
  RBOOK_DASHBOARD_PASSWORD_ENV,
  DEFAULT_DASHBOARD_URL,
} from '../../../src/tools/rbook/dashboard-client';
import type { SyncStatusResult } from '../../../src/tools/rbook/dashboard-client';
import { CredentialStore } from '../../../src/intelligence/credential-store';

describe('rbookStatus', () => {
  let tempDir: string;
  let configDir: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-status-test-'));
    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    const dbPath = path.join(rbookDbDir, 'rbook.sqlite');

    // Minimal schema — rbook_status reads contexts (project_identity row) only.
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT,
        content TEXT NOT NULL,
        updated_at TEXT
      );
      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    db.close();

    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-status-creds-'));

    savedEnv = {
      [RBOOK_DASHBOARD_URL_ENV]: process.env[RBOOK_DASHBOARD_URL_ENV],
      [RBOOK_DASHBOARD_API_KEY_ENV]: process.env[RBOOK_DASHBOARD_API_KEY_ENV],
      [RBOOK_DASHBOARD_USER_ENV]: process.env[RBOOK_DASHBOARD_USER_ENV],
      [RBOOK_DASHBOARD_PASSWORD_ENV]: process.env[RBOOK_DASHBOARD_PASSWORD_ENV],
      RBOOK_CONFIG_DIR: process.env.RBOOK_CONFIG_DIR,
    };

    delete process.env[RBOOK_DASHBOARD_URL_ENV];
    delete process.env[RBOOK_DASHBOARD_API_KEY_ENV];
    delete process.env[RBOOK_DASHBOARD_USER_ENV];
    delete process.env[RBOOK_DASHBOARD_PASSWORD_ENV];
    process.env.RBOOK_CONFIG_DIR = configDir;

    // CredentialStore is a process-scoped singleton — reset it per test so
    // a key written in one test doesn't bleed into the next via cache.
    CredentialStore.resetInstance();

    // Stub the dashboard round-trip. The 3 auth_tier tests below are the only
    // ones that supply credentials, so they are the only ones whose
    // rbookStatus() → resolveLastSyncAt() reaches fromEnvForProject() success
    // and calls getSyncStatus() — an otherwise LIVE, unmocked fetch() to
    // production reasonbook.ai. The client's 10s AbortController timeout
    // exceeds jest's 5s default testTimeout, so under full-suite parallel
    // contention jest kills the test before it returns (CI runs --runInBand,
    // so it only flaked locally). Mocking at the prototype keeps every test in
    // this file off the network. The stub mirrors the honest null-path
    // (dashboard reachable, nothing synced for this throwaway tmpdir project →
    // lastSyncAt null), so last_sync_at stays null exactly as it was — the
    // assertions stay honest, only the timing variable is removed (learning #232).
    const emptySyncStatus: SyncStatusResult = {
      tables: [],
      totalMirrorRows: 0,
      totalSyncLogEntries: 0,
      unprocessedSyncLogEntries: 0,
      failedSyncLogEntries: 0,
      lastSyncAt: null,
      oldestUnprocessedAt: null,
      projectCount: 0,
    };
    jest
      .spyOn(DashboardClient.prototype, 'getSyncStatus')
      .mockResolvedValue({ success: true, data: emptySyncStatus });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    CredentialStore.resetInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // ─── Tool definition shape ──────────────────────────────────────────────

  it('tool definition exposes name=rbook_status with no required params', () => {
    expect(rbookStatusToolDefinition.name).toBe('rbook_status');
    const schema = rbookStatusToolDefinition.inputSchema as {
      type: string;
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    // The only optional input is projectRoot — no free-text fields, so the
    // Sprint 60 m02 sanitizer wiring is N/A for this tool.
    expect(Object.keys(schema.properties)).toEqual(['projectRoot']);
  });

  // ─── Local-only mode ────────────────────────────────────────────────────

  it('local-only mode: returns the 5 frozen fields with null timestamps and authTier=none', async () => {
    const result = await rbookStatus({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();

    // The 5 frozen fields per dashboard team msg 416315a7 — exact key set.
    expect(Object.keys(result.data!).sort()).toEqual([
      'auth_tier',
      'dashboard_url',
      'last_delivery_observed_at',
      'last_sync_at',
      'rbook_address',
    ]);

    expect(result.data!.rbook_address).toBe('local-only');
    expect(result.data!.dashboard_url).toBe(DEFAULT_DASHBOARD_URL);
    expect(result.data!.auth_tier).toBe('none');
    expect(result.data!.last_sync_at).toBeNull();
    expect(result.data!.last_delivery_observed_at).toBeNull();
  });

  // ─── rbook_address normalization ─────────────────────────────────────────

  it('returns the canonical rbook_address when project_identity has one set', async () => {
    // Seed project_identity with a canonical address.
    const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
    const db = new Database(dbPath);
    const identity = {
      project_id: 'p1',
      project_name: 'Test',
      [LEGACY.identityAddressKey]: `${LEGACY.addressScheme}derek/test-project`,
      platform: 'aquex.ai',
      domain: '',
      project_type: 'build',
      tier: 'build',
      status: 'active_development',
      description: '',
      objectives: [],
      related_projects: [],
      foundational_docs: [],
      tracelab_refs: [],
      type_fields: {},
      identity_contract_version: 'v1',
      created_at: '',
      updated_at: '',
    };
    db.prepare(
      "INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES ('project_identity', '', ?, ?)"
    ).run(JSON.stringify(identity), new Date().toISOString());
    db.close();

    const result = await rbookStatus({ projectRoot: tempDir });
    expect(result.success).toBe(true);
    expect(result.data?.rbook_address).toBe('rbook://derek/test-project');
  });

  it('normalizes a rbook://unknown/* address to local-only', async () => {
    const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
    const db = new Database(dbPath);
    const identity = {
      project_id: 'p1',
      project_name: 'Test',
      [LEGACY.identityAddressKey]: `${LEGACY.addressScheme}unknown/test-stale`,
      platform: 'aquex.ai',
      domain: '',
      project_type: 'build',
      tier: 'build',
      status: 'active_development',
      description: '',
      objectives: [],
      related_projects: [],
      foundational_docs: [],
      tracelab_refs: [],
      type_fields: {},
      identity_contract_version: 'v1',
      created_at: '',
      updated_at: '',
    };
    db.prepare(
      "INSERT OR REPLACE INTO contexts (id, source_path, content, updated_at) VALUES ('project_identity', '', ?, ?)"
    ).run(JSON.stringify(identity), new Date().toISOString());
    db.close();

    const result = await rbookStatus({ projectRoot: tempDir });
    expect(result.data?.rbook_address).toBe('local-only');
  });

  // ─── dashboard_url precedence ───────────────────────────────────────────

  it('dashboard_url respects an explicit RBOOK_DASHBOARD_URL env override', async () => {
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'https://staging.example.test';
    const result = await rbookStatus({ projectRoot: tempDir });
    expect(result.data?.dashboard_url).toBe('https://staging.example.test');
  });

  it('dashboard_url falls back to baked default when env is empty string (IDE-spawn trap)', async () => {
    process.env[RBOOK_DASHBOARD_URL_ENV] = '';
    const result = await rbookStatus({ projectRoot: tempDir });
    expect(result.data?.dashboard_url).toBe(DEFAULT_DASHBOARD_URL);
  });

  // ─── auth_tier parity (mirrors onboard.authState.authTier) ──────────────

  it('auth_tier=device-code when a user-scoped key is in the credential store', async () => {
    const store = await CredentialStore.create({ configDir });
    await store.upsertUserScopedKey('test-key-id', {
      key: 'cmk_test',
      label: 'test',
      issuedAt: new Date().toISOString(),
      lastUsedAt: '',
    });
    const result = await rbookStatus({ projectRoot: tempDir });
    expect(result.data?.auth_tier).toBe('device-code');
  });

  it('auth_tier=legacy-env when RBOOK_DASHBOARD_API_KEY is set and store is empty', async () => {
    process.env[RBOOK_DASHBOARD_API_KEY_ENV] = 'cmk_legacy';
    const result = await rbookStatus({ projectRoot: tempDir });
    expect(result.data?.auth_tier).toBe('legacy-env');
  });

  it('auth_tier=password-fallback when only USER+PASSWORD env are set', async () => {
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'user@test.com';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'pwd';
    const result = await rbookStatus({ projectRoot: tempDir });
    expect(result.data?.auth_tier).toBe('password-fallback');
  });

  // ─── formatStatusForLLM ─────────────────────────────────────────────────

  // s97-m14 (critics, round 2): the removal is this copy's, so the line says what this copy sends.
  it("formatStatusForLLM names a member's removal on its shared-sync line", () => {
    const formatted = formatStatusForLLM({
      success: true,
      data: {
        rbook_address: 'rbook://local/x',
        dashboard_url: 'https://reasonbook.ai',
        auth_tier: 'none',
        last_sync_at: null,
        last_delivery_observed_at: null,
        shared_sync: [
          {
            peer: "the owner's copy",
            last_synced_at: '2026-10-19T09:00:00.000Z',
            pending: 0,
            last_error: null,
            removed_at: '2026-10-19T08:00:00.000Z',
          },
        ],
      },
    } as never);
    expect(formatted).toContain(
      "  the owner's copy: said this copy's member was removed (first said 2026-10-19T08:00:00.000Z), so what this copy sends is set aside; last synced 2026-10-19T09:00:00.000Z, 0 pending"
    );
  });

  it('formatStatusForLLM renders all 5 fields and a sign-up nudge in local-only mode', async () => {
    const result = await rbookStatus({ projectRoot: tempDir });
    const formatted = formatStatusForLLM(result);
    expect(formatted).toContain('rbook_address:');
    expect(formatted).toContain('dashboard_url:');
    expect(formatted).toContain('auth_tier:');
    expect(formatted).toContain('last_sync_at:');
    expect(formatted).toContain('last_delivery_observed_at:');
    expect(formatted).toContain('https://reasonbook.ai');
  });
});
