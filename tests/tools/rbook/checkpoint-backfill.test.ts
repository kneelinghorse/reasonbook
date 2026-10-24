import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/rbook/rbook-db-backfill', () => ({
  rbookDbBackfill: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/client', () => ({
  withClientAsync: jest.fn(),
}));

// Lease fencing and physical SQLite backups have their own real-store/child-process suites.
// These tests retain their registration, attribution and failure-path focus.
jest.mock('../../../src/tools/rbook/dashboard-upload', () => ({
  uploadLog: jest.fn(),
  trackDashboardUpload: jest.fn((work: () => Promise<unknown>) => work()),
  withUploadLease: jest.fn(
    async (_root: string, _explicit: boolean, send: () => Promise<unknown>) => send()
  ),
  withUploadSnapshot: jest.fn(async (file: string, send: (file: string) => Promise<unknown>) =>
    send(file)
  ),
}));
jest.mock('../../../src/tools/rbook/dashboard-upload-auth', () => ({
  inspectUploadOwner: jest.fn(async () => ({
    ownerConfirmed: false,
    projectListed: false,
    replaced: false,
    skipped: true,
  })),
}));

jest.mock('../../../src/intelligence/sender-context', () => ({
  ...jest.requireActual<typeof import('../../../src/intelligence/sender-context')>(
    '../../../src/intelligence/sender-context'
  ),
  resolveSenderContext: jest.fn(async () => ({ projectRoot: '/tmp/test' })),
}));

jest.mock('../../../src/tools/rbook/dashboard-client', () => {
  const actual = jest.requireActual<typeof import('../../../src/tools/rbook/dashboard-client')>(
    '../../../src/tools/rbook/dashboard-client'
  );
  return {
    ...actual,
    DashboardClient: {
      fromEnv: jest.fn(),
      fromEnvForProject: jest.fn(),
    },
  };
});

jest.mock('../../../src/auth/project-key-capture', () => ({
  captureRegisterResponse: jest.fn(async () => 'captured'),
}));

import {
  triggerCheckpointBackfill,
  RBOOK_CHECKPOINT_SYNC_ENV,
} from '../../../src/tools/rbook/checkpoint-backfill';
import { rbookDbBackfill } from '../../../src/tools/rbook/rbook-db-backfill';
import { withClientAsync } from '../../../src/tools/rbook/client';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { withUploadLease } from '../../../src/tools/rbook/dashboard-upload';

const mockBackfill = rbookDbBackfill as jest.MockedFunction<typeof rbookDbBackfill>;
const mockWithClientAsync = withClientAsync as jest.MockedFunction<typeof withClientAsync>;
const mockFromEnvForProject = DashboardClient.fromEnvForProject as jest.MockedFunction<
  typeof DashboardClient.fromEnvForProject
>;

/** A failed attempt is returned to the single lease holder, which records the debt. */
async function expectRecordedFailure(message?: string) {
  const lease = withUploadLease as jest.MockedFunction<typeof withUploadLease>;
  const result = await lease.mock.results[0].value;
  expect(result).toMatchObject({ success: false, ...(message ? { error: message } : {}) });
}

/** Helper: create a standard successful file sync result */
function makeSyncResult() {
  return {
    success: true as const,
    data: {
      success: true,
      counts: { sprints: 1, missions: 2 },
      errors: [] as string[],
      durationMs: 50,
    },
  };
}

/**
 * s86-m01 — MANDATORY OPT-OUT from the RBOOK_CHECKPOINT_SYNC kill switch.
 *
 * tests/jest-global-setup.ts defaults that var to 'off' for the whole run, which
 * would short-circuit `triggerCheckpointBackfill` before any of the real gates —
 * silently neutering all 24 call sites in this file, including the four s70-m04
 * device-code gate tests. This file is the one place that must exercise the real
 * behaviour, so it deletes the var for every test.
 *
 * Declared at TOP LEVEL, outside all three describes, so it runs before each of
 * their own beforeEach hooks (Jest runs beforeEach outermost-first). The switch's
 * own behaviour test lives in its own describe below, which re-sets the var in a
 * nested beforeEach — that runs after this one, so it wins.
 */
const ORIGINAL_CHECKPOINT_SYNC = process.env.RBOOK_CHECKPOINT_SYNC;

beforeEach(() => {
  delete process.env[RBOOK_CHECKPOINT_SYNC_ENV];
});

afterEach(() => {
  if (ORIGINAL_CHECKPOINT_SYNC === undefined) {
    delete process.env[RBOOK_CHECKPOINT_SYNC_ENV];
  } else {
    process.env[RBOOK_CHECKPOINT_SYNC_ENV] = ORIGINAL_CHECKPOINT_SYNC;
  }
});

describe('RBOOK_CHECKPOINT_SYNC kill switch (s86-m01)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RBOOK_DASHBOARD_API_KEY = 'test-key';
  });

  afterEach(() => {
    delete process.env.RBOOK_DASHBOARD_API_KEY;
  });

  it("resolves without touching any gate when set to 'off'", async () => {
    process.env[RBOOK_CHECKPOINT_SYNC_ENV] = 'off';

    await triggerCheckpointBackfill({ projectRoot: '/tmp/whatever', force: true });

    // The switch is read BEFORE every other gate, so none of these is reached.
    expect(mockFromEnvForProject).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
    expect(mockWithClientAsync).not.toHaveBeenCalled();
  });

  it("does NOT disable the sync when set to 'on'", async () => {
    process.env[RBOOK_CHECKPOINT_SYNC_ENV] = 'on';
    mockFromEnvForProject.mockResolvedValue({
      success: false as const,
      error: { code: 'NO_CREDENTIALS', message: 'none' },
    } as never);

    await triggerCheckpointBackfill({ projectRoot: '/tmp/whatever', force: true });

    // 'on' is not special-cased — it falls through to the real credential gate.
    expect(mockFromEnvForProject).toHaveBeenCalled();
  });

  it('does NOT disable the sync when unset', async () => {
    delete process.env[RBOOK_CHECKPOINT_SYNC_ENV];
    mockFromEnvForProject.mockResolvedValue({
      success: false as const,
      error: { code: 'NO_CREDENTIALS', message: 'none' },
    } as never);

    await triggerCheckpointBackfill({ projectRoot: '/tmp/whatever', force: true });

    expect(mockFromEnvForProject).toHaveBeenCalled();
  });
});

describe('checkpoint-backfill', () => {
  const originalUrl = process.env.RBOOK_DASHBOARD_URL;
  const originalApiKey = process.env.RBOOK_DASHBOARD_API_KEY;
  const originalUser = process.env.RBOOK_DASHBOARD_USER;
  const originalPassword = process.env.RBOOK_DASHBOARD_PASSWORD;

  let mockSyncSqliteFile: jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RBOOK_DASHBOARD_URL = 'http://localhost:3000';
    process.env.RBOOK_DASHBOARD_USER = 'test@example.com';
    process.env.RBOOK_DASHBOARD_PASSWORD = 'test-password';
    delete process.env.RBOOK_DASHBOARD_API_KEY;

    mockSyncSqliteFile = jest.fn<(...args: any[]) => any>().mockResolvedValue(makeSyncResult());

    // Default: fromEnvForProject returns {client, keySource, matchedProjectRoot}
    mockFromEnvForProject.mockResolvedValue({
      success: true,
      data: {
        client: {
          syncSqliteFile: mockSyncSqliteFile,
          getMyProjects: async () => ({ success: true, data: { projects: [], totalCount: 0 } }),
        } as any,
        keySource: 'user-scoped',
        matchedProjectRoot: null,
      },
    });

    // Default: withClientAsync resolves as already registered with a slug
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/rbook/db/rbook.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered'))
            return { success: true, data: { value: 'true' } };
          if (sql.includes('dashboard_slug'))
            return { success: true, data: { value: 'test-project' } };
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    };
    restore('RBOOK_DASHBOARD_URL', originalUrl);
    restore('RBOOK_DASHBOARD_API_KEY', originalApiKey);
    restore('RBOOK_DASHBOARD_USER', originalUser);
    restore('RBOOK_DASHBOARD_PASSWORD', originalPassword);
  });

  it('should trigger file sync for session complete (force: false)', async () => {
    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    // No registered id matches this empty listing, so the expectedSlug guard is not
    // relaxed; with no project_name it stays undefined.
    expect(mockSyncSqliteFile).toHaveBeenCalledWith(
      '/tmp/test/rbook/db/rbook.sqlite',
      'test-project',
      undefined
    );
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it('should trigger file sync for sprint complete (force: true)', async () => {
    await triggerCheckpointBackfill({ force: true });

    await new Promise((resolve) => setImmediate(resolve));

    // s81-m02: not confirmed in this mock → guard not relaxed → expectedSlug undefined.
    expect(mockSyncSqliteFile).toHaveBeenCalledWith(
      '/tmp/test/rbook/db/rbook.sqlite',
      'test-project',
      undefined
    );
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it('should not fail when file sync fails', async () => {
    mockSyncSqliteFile.mockResolvedValueOnce({
      success: false,
      error: { code: 'DASHBOARD_UNREACHABLE', message: 'Connection refused' },
    });

    // Should not throw
    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).toHaveBeenCalled();
  });

  it('should not fail when file sync throws', async () => {
    mockSyncSqliteFile.mockRejectedValueOnce(new Error('Network error'));

    // Should not throw
    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).toHaveBeenCalled();
  });

  // Sprint 62 m02: URL has a baked default — the gate is now credentials-only.
  // Without auth there's nothing to push, so backfill silently skips.
  it('should skip sync when no credentials are configured', async () => {
    delete process.env.RBOOK_DASHBOARD_API_KEY;
    delete process.env.RBOOK_DASHBOARD_USER;
    delete process.env.RBOOK_DASHBOARD_PASSWORD;

    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it('should pass projectRoot to withClientAsync', async () => {
    await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: true });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockWithClientAsync).toHaveBeenCalledWith(expect.any(Function), {
      projectRoot: '/tmp/test',
    });
  });

  it('should trigger file sync when API key is configured (no user/password)', async () => {
    process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_test-key-123';
    delete process.env.RBOOK_DASHBOARD_USER;
    delete process.env.RBOOK_DASHBOARD_PASSWORD;

    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).toHaveBeenCalled();
  });

  it('should skip sync when URL is set but no auth is configured', async () => {
    delete process.env.RBOOK_DASHBOARD_API_KEY;
    delete process.env.RBOOK_DASHBOARD_USER;
    delete process.env.RBOOK_DASHBOARD_PASSWORD;

    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
  });

  it('records pending upload failure when no project slug exists', async () => {
    // Override: registered but no slug available
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/rbook/db/rbook.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered'))
            return { success: true, data: { value: 'true' } };
          if (sql.includes('dashboard_slug')) return { success: true, data: null }; // No slug
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
    await expectRecordedFailure();
  });

  it('should skip when fromEnvForProject fails', async () => {
    mockFromEnvForProject.mockResolvedValue({
      success: false,
      error: { code: 'DASHBOARD_NOT_CONFIGURED', message: 'Missing credentials' },
    });

    await triggerCheckpointBackfill({ force: false });

    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
  });
});

// ─── Auto-Registration Tests ────────────────────────────────────────────────

describe('checkpoint-backfill auto-registration', () => {
  const originalUrl = process.env.RBOOK_DASHBOARD_URL;
  const originalApiKey = process.env.RBOOK_DASHBOARD_API_KEY;
  const originalUser = process.env.RBOOK_DASHBOARD_USER;
  const originalPassword = process.env.RBOOK_DASHBOARD_PASSWORD;

  let mockSyncSqliteFile: jest.MockedFunction<any>;
  let mockRegister: jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RBOOK_DASHBOARD_URL = 'http://localhost:3000';
    process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_test-key';
    delete process.env.RBOOK_DASHBOARD_USER;
    delete process.env.RBOOK_DASHBOARD_PASSWORD;

    mockSyncSqliteFile = jest.fn<(...args: any[]) => any>().mockResolvedValue({
      success: true,
      data: { success: true, counts: {}, errors: [], durationMs: 50 },
    });
    mockRegister = jest.fn<(...args: any[]) => any>();

    // Default fromEnvForProject — client includes both methods; individual tests override as needed
    mockFromEnvForProject.mockResolvedValue({
      success: true,
      data: {
        client: {
          getMyProjects: async () => ({ success: true, data: { projects: [], totalCount: 0 } }),
          registerProject: mockRegister,
          syncSqliteFile: mockSyncSqliteFile,
          authenticatingKeyId: 'user-key-id-1',
        } as any,
        keySource: 'user-scoped',
        matchedProjectRoot: null,
      },
    });
  });

  afterEach(() => {
    const restore = (key: string, val: string | undefined) => {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    };
    restore('RBOOK_DASHBOARD_URL', originalUrl);
    restore('RBOOK_DASHBOARD_API_KEY', originalApiKey);
    restore('RBOOK_DASHBOARD_USER', originalUser);
    restore('RBOOK_DASHBOARD_PASSWORD', originalPassword);
  });

  it('should skip registration when dashboard_registered is true', async () => {
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/rbook/db/rbook.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered'))
            return { success: true, data: { value: 'true' } };
          if (sql.includes('dashboard_slug'))
            return { success: true, data: { value: 'my-project' } };
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // Registration skipped — registerProject not called
    expect(mockRegister).not.toHaveBeenCalled();
    // File sync runs using the existing slug; the empty listing does not confirm an id →
    // guard not relaxed → expectedSlug undefined (no project_name) (s81-m02).
    expect(mockSyncSqliteFile).toHaveBeenCalledWith(
      '/tmp/test/rbook/db/rbook.sqlite',
      'my-project',
      undefined
    );
  });

  it('s81-m02: relaxes expectedSlug to the incumbent slug ONLY when the reconcile CONFIRMS it (byId trusted match)', async () => {
    // A fully-populated registered store whose local project_id slug matches the incumbent
    // dashboard row → resolveAndPersistOwner confirms via byId → the guard is relaxed so a
    // divergent-name copy could sync. Proven by expectedSlug == projectSlug on the call.
    const confirmingSync = jest.fn<(...args: any[]) => any>().mockResolvedValue(makeSyncResult());
    const confirmingClient = {
      // getMyProjects returns the incumbent row identified by its stored id.
      getMyProjects: jest.fn<(...args: any[]) => any>().mockResolvedValue({
        success: true,
        data: {
          projects: [
            { id: 'other', name: 'Other', slug: 'other', owner: 'derek' },
            { id: 'id1', name: 'Test Project', slug: 'test-project', owner: 'derek' },
          ],
          totalCount: 2,
        },
      }),
      syncSqliteFile: confirmingSync,
    };
    mockFromEnvForProject.mockResolvedValue({
      success: true,
      data: { client: confirmingClient as any, keySource: 'user-scoped', matchedProjectRoot: null },
    });
    const META: Record<string, string> = {
      dashboard_registered: 'true',
      dashboard_slug: 'test-project',
      dashboard_project_id: 'id1',
      project_id: 'test-project',
      project_name: 'Test Project',
    };
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/rbook/db/rbook.sqlite',
        getOne: jest.fn().mockImplementation((sql: any, params?: any) => {
          // resolveAndPersistOwner.readMetadata uses parameterized `key = ?` (key in params[0]).
          if (sql.includes('WHERE key = ?') && Array.isArray(params)) {
            const key = params[0] as string;
            return { success: true, data: key in META ? { value: META[key] } : null };
          }
          // checkAndRegister uses inline keys; contexts(project_identity)/owner → null.
          if (sql.includes('dashboard_registered'))
            return { success: true, data: { value: 'true' } };
          if (sql.includes('dashboard_slug'))
            return { success: true, data: { value: 'test-project' } };
          if (sql.includes("key = 'project_name'"))
            return { success: true, data: { value: 'Test Project' } };
          return { success: true, data: null };
        }),
        getMany: jest.fn().mockReturnValue({ success: true, data: [] }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // Confirmed incumbent → expectedSlug relaxed to the incumbent slug (== projectSlug).
    expect(confirmingSync).toHaveBeenCalledWith(
      '/tmp/test/rbook/db/rbook.sqlite',
      'test-project',
      'test-project'
    );
  });

  it('should auto-register when dashboard_registered is not set', async () => {
    mockRegister.mockResolvedValue({
      success: true,
      data: {
        slug: 'my-project',
        projectId: 'proj-uuid',
        reregistered: false,
        backfill: { counts: { sprints: 5 } },
      },
    });

    const mockExecute = jest.fn().mockReturnValue({ success: true });

    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/rbook/db/rbook.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered')) {
            return { success: true, data: null }; // Not registered
          }
          if (sql.includes('project_name')) {
            return { success: true, data: { value: 'My Project' } };
          }
          return { success: true, data: null };
        }),
        execute: mockExecute,
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // Should have called registerProject
    expect(mockRegister).toHaveBeenCalledWith({
      projectName: 'My Project',
      sqlitePath: '/tmp/test/rbook/db/rbook.sqlite',
      localDbPath: '/tmp/test/rbook/db/rbook.sqlite',
      expectedSlug: 'my-project',
    });

    // Should have stored registration metadata
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('dashboard_registered'));
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('dashboard_slug'), [
      'my-project',
    ]);
    expect(mockExecute).toHaveBeenCalledWith(expect.stringContaining('dashboard_project_id'), [
      'proj-uuid',
    ]);

    // Should run file sync after registration
    expect(mockSyncSqliteFile).toHaveBeenCalledWith(
      '/tmp/test/rbook/db/rbook.sqlite',
      'my-project',
      'my-project'
    );
  });

  it('should pass expectedSlug into file sync when project is already registered', async () => {
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/rbook/db/rbook.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered'))
            return { success: true, data: { value: 'true' } };
          if (sql.includes('dashboard_slug'))
            return { success: true, data: { value: 'my-project' } };
          if (sql.includes('project_name')) return { success: true, data: { value: 'My Project' } };
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSyncSqliteFile).toHaveBeenCalledWith(
      '/tmp/test/rbook/db/rbook.sqlite',
      'my-project',
      'my-project'
    );
  });

  it('should not fall back to file sync when the expected slug guard rejects registration', async () => {
    mockRegister.mockResolvedValue({
      success: false,
      error: { code: 'EXPECTED_SLUG_MISMATCH', message: 'slug mismatch' },
    });

    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/rbook/db/rbook.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered')) return { success: true, data: null };
          if (sql.includes('project_name')) return { success: true, data: { value: 'My Project' } };
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSlug: 'my-project' })
    );
    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
    expect(mockBackfill).not.toHaveBeenCalled();
    await expectRecordedFailure();
  });

  it('should skip registration when project name is empty', async () => {
    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/rbook/db/rbook.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered')) {
            return { success: true, data: null };
          }
          if (sql.includes('project_name')) {
            return { success: true, data: { value: '' } };
          }
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // Should not try to register
    expect(mockRegister).not.toHaveBeenCalled();
    // No slug: the lease records failure and keeps upload debt.
    expect(mockBackfill).not.toHaveBeenCalled();
    await expectRecordedFailure();
    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
  });

  it('records registration failure without starting a second backfill', async () => {
    mockRegister.mockResolvedValue({
      success: false,
      error: { code: 'DASHBOARD_UNREACHABLE', message: 'Connection refused' },
    });

    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/rbook/db/rbook.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered')) {
            return { success: true, data: null };
          }
          if (sql.includes('project_name')) {
            return { success: true, data: { value: 'My Project' } };
          }
          return { success: true, data: null };
        }),
        execute: jest.fn().mockReturnValue({ success: true }),
      };
      return fn(mockClient as any);
    });

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // Registration was attempted
    expect(mockRegister).toHaveBeenCalled();
    // A failed registration leaves debt on the current lease.
    expect(mockBackfill).not.toHaveBeenCalled();
    await expectRecordedFailure();
    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
  });

  it('records a failed registration check without starting a second backfill', async () => {
    mockWithClientAsync.mockRejectedValue(new Error('DB connection failed'));

    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));

    // The failed check leaves debt on the current lease.
    expect(mockBackfill).not.toHaveBeenCalled();
    await expectRecordedFailure();
    expect(mockSyncSqliteFile).not.toHaveBeenCalled();
  });

  it('should be idempotent — second checkpoint skips registration', async () => {
    mockRegister.mockResolvedValue({
      success: true,
      data: {
        slug: 'my-project',
        projectId: 'proj-uuid',
        reregistered: false,
        backfill: { counts: {} },
      },
    });

    let registered = false;
    const mockExecute = jest.fn().mockImplementation((sql: any) => {
      if (sql.includes("'dashboard_registered', 'true'")) {
        registered = true;
      }
      return { success: true };
    });

    mockWithClientAsync.mockImplementation(async (fn) => {
      const mockClient = {
        path: '/tmp/test/rbook/db/rbook.sqlite',
        getOne: jest.fn().mockImplementation((sql: any) => {
          if (sql.includes('dashboard_registered')) {
            return {
              success: true,
              data: registered ? { value: 'true' } : null,
            };
          }
          if (sql.includes('dashboard_slug')) {
            return {
              success: true,
              data: registered ? { value: 'my-project' } : null,
            };
          }
          if (sql.includes('project_name')) {
            return { success: true, data: { value: 'My Project' } };
          }
          return { success: true, data: null };
        }),
        execute: mockExecute,
      };
      return fn(mockClient as any);
    });

    // First checkpoint — should register
    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockSyncSqliteFile).toHaveBeenCalledTimes(1);

    // Second checkpoint — should skip registration
    await triggerCheckpointBackfill({ force: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRegister).toHaveBeenCalledTimes(1); // Still 1 — not called again
    expect(mockSyncSqliteFile).toHaveBeenCalledTimes(2); // Called again for sync
  });

  // Sprint 70 m04: device-code-only auth now PROCEEDS through the gate (the fix
  // for #303/#701). A resolvable user-scoped key in the CredentialStore counts as
  // sufficient even when the env vars are unset; the genuinely-unauthenticated
  // case still fails closed; and the obsolete s67-m04 silent-skip WARN is gone.
  describe('device-code checkpoint-sync gate (s70-m04)', () => {
    const { CredentialStore } = jest.requireActual<
      typeof import('../../../src/intelligence/credential-store')
    >('../../../src/intelligence/credential-store');

    const fs = jest.requireActual<typeof import('fs')>('fs');
    const os = jest.requireActual<typeof import('os')>('os');
    const path = jest.requireActual<typeof import('path')>('path');

    let configDir: string;
    let mockSync: jest.MockedFunction<any>;
    let stderrSpy: jest.SpiedFunction<typeof process.stderr.write>;

    async function seedUserScopedKey(key = 'cmk_devicecode'): Promise<void> {
      const store = CredentialStore.getInstance();
      await store.upsertUserScopedKey('keyId-1', {
        key,
        label: 'device: test',
        issuedAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
      });
    }

    beforeEach(() => {
      jest.clearAllMocks();
      // Device-code-only context: no env auth at all.
      process.env.RBOOK_DASHBOARD_URL = 'http://localhost:3000';
      delete process.env.RBOOK_DASHBOARD_API_KEY;
      delete process.env.RBOOK_DASHBOARD_USER;
      delete process.env.RBOOK_DASHBOARD_PASSWORD;

      configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-devicecode-test-'));
      CredentialStore.resetInstance();
      CredentialStore.getInstance({ configDir });

      mockSync = jest.fn<(...args: any[]) => any>().mockResolvedValue(makeSyncResult());
      mockFromEnvForProject.mockResolvedValue({
        success: true,
        data: {
          client: {
            syncSqliteFile: mockSync,
            getMyProjects: async () => ({ success: true, data: { projects: [], totalCount: 0 } }),
          } as any,
          keySource: 'user-scoped',
          matchedProjectRoot: null,
        },
      });
      // Registered with a slug so the primary file-sync path runs.
      mockWithClientAsync.mockImplementation(async (fn) => {
        const mockClient = {
          path: '/tmp/test/rbook/db/rbook.sqlite',
          getOne: jest.fn().mockImplementation((sql: any) => {
            if (sql.includes('dashboard_registered'))
              return { success: true, data: { value: 'true' } };
            if (sql.includes('dashboard_slug'))
              return { success: true, data: { value: 'test-project' } };
            return { success: true, data: null };
          }),
          execute: jest.fn().mockReturnValue({ success: true }),
        };
        return fn(mockClient as any);
      });

      stderrSpy = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true) as unknown as jest.SpiedFunction<
        typeof process.stderr.write
      >;
    });

    afterEach(() => {
      stderrSpy.mockRestore();
      CredentialStore.resetInstance();
      fs.rmSync(configDir, { recursive: true, force: true });
    });

    it('PROCEEDS for device-code-only auth (resolvable user-scoped key, env unset)', async () => {
      await seedUserScopedKey();

      await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: true });
      expect(mockFromEnvForProject).toHaveBeenCalled();
      // s81-m02: not confirmed in this mock → guard not relaxed → expectedSlug undefined.
      expect(mockSync).toHaveBeenCalledWith(
        '/tmp/test/rbook/db/rbook.sqlite',
        'test-project',
        undefined
      );
    });

    it('still fails closed when there is no credential by any path (no env, no user-scoped key)', async () => {
      // CredentialStore is empty; env is unset.
      await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: true });
      expect(mockFromEnvForProject).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
      expect(mockBackfill).not.toHaveBeenCalled();
    });

    it('does NOT open the gate on mere store-file presence with no resolvable key', async () => {
      // A user-scoped record whose key is empty is NOT resolvable (RISK guard:
      // do not open wider than device-code auth on file presence alone).
      await seedUserScopedKey('');

      await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: true });
      expect(mockFromEnvForProject).not.toHaveBeenCalled();
      expect(mockSync).not.toHaveBeenCalled();
    });

    it('emits no silent-skip WARN on the now-supported device-code path', async () => {
      await seedUserScopedKey();

      await triggerCheckpointBackfill({ projectRoot: '/tmp/test', force: true });
      const warns = stderrSpy.mock.calls
        .map((args: unknown[]) => String(args[0]))
        .filter((s) => /skipped|silently/i.test(s));
      expect(warns).toHaveLength(0);
    });
  });
});
