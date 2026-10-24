// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Retired dashboard event sync refuses at its own entry points without touching credentials, network or rows.
// ABOUTME: Local edits on old collab stores still succeed with a visible remedy, and SQLite uploads never fall back to replay.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { syncPull, formatSyncPullForLLM } from '../../../src/tools/rbook/sync-pull';
import { syncBootstrap, formatSyncBootstrapForLLM } from '../../../src/tools/rbook/sync-bootstrap';
import { pushMutableStatus } from '../../../src/tools/rbook/sync-mutable-push';
import {
  maybePropagateMutableStatus,
  pushMutableStatusUnderLock,
} from '../../../src/tools/rbook/sync-locks';
import { rbookDbBackfill } from '../../../src/tools/rbook/rbook-db-backfill';
import { __resetDashboardUploadScheduler } from '../../../src/tools/rbook/dashboard-upload-scheduler';
import { createSuccess } from '../../../src/tools/rbook/errors';
import { registerResolvedProjectStore } from '../../../src/intelligence/project-resolution';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { read } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
let root: string;
beforeEach(() => {
  fixture = replicaFixture('rbook-retired-sync-');
  useMachine(fixture.tmp, 'local');
  root = project(fixture.tmp, 'local');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

const retired = {
  success: false,
  error: { code: 'LEGACY_SYNC_RETIRED', suggestion: expect.stringContaining('reasonbook sync') },
};

function sql(statement: string): void {
  const db = new Database(dbOf(root));
  try {
    db.exec(statement);
  } finally {
    db.close();
  }
}

function noCredentials() {
  return jest.spyOn(DashboardClient, 'fromEnvForProject').mockImplementation(async () => {
    throw new Error('The retired path must not resolve credentials or contact a dashboard.');
  });
}

describe('retired dashboard sync entry points', () => {
  it.each([
    ['pull', () => syncPull({ projectRoot: root })],
    ['clone', () => syncBootstrap({ projectRoot: root })],
    [
      'mutable push',
      () => pushMutableStatus({ projectRoot: root, missionId: 'm1', status: 'Queued' }),
    ],
    [
      'lock push',
      () => pushMutableStatusUnderLock({ projectRoot: root, missionId: 'm1', status: 'Queued' }),
    ],
  ] as const)('%s refuses before resolving credentials or opening a store', async (_name, run) => {
    const credentials = noCredentials();
    expect(await run()).toMatchObject(retired);
    expect(credentials).not.toHaveBeenCalled();
    expect(
      read(
        { root },
        "SELECT * FROM metadata WHERE key LIKE 'pull_cursor:%' OR key LIKE 'mutable_status:%' OR key LIKE 'platform_project_id:%'"
      )
    ).toEqual([]);
  });

  it.each(['pull', 'clone'])(
    'the MCP dispatch keeps the %s action and returns the remedy',
    async (action) => {
      const credentials = noCredentials();
      expect(await call('rbook_db', { action, projectRoot: root })).toMatchObject(retired);
      expect(credentials).not.toHaveBeenCalled();
    }
  );

  it('the pull and clone formatters carry the replacement command', async () => {
    noCredentials();
    expect(formatSyncPullForLLM(await syncPull({ projectRoot: root }))).toContain(
      'reasonbook sync'
    );
    expect(formatSyncBootstrapForLLM(await syncBootstrap({ projectRoot: root }))).toContain(
      'reasonbook sync'
    );
  });

  it('the event-replay dry run refuses through dispatch before resolving credentials', async () => {
    const credentials = noCredentials();
    expect(
      await call('rbook_db', { action: 'backfill', dryRun: true, projectRoot: root })
    ).toMatchObject(retired);
    expect(credentials).not.toHaveBeenCalled();
  });
});

describe('local edits with an old collab_role', () => {
  beforeEach(() => {
    sql(
      "INSERT INTO sprints (id, title, status) VALUES ('s1', 'One', 'Planned'); INSERT INTO missions (id, name, sprint_id, status) VALUES ('m1', 'Work', 's1', 'Queued'); INSERT INTO metadata (key, value) VALUES ('collab_role', 'editor');"
    );
  });

  it.each([
    [
      'mission',
      'rbook_mission_transition',
      { action: 'start', missionId: 'm1' },
      "SELECT status AS value FROM missions WHERE id = 'm1'",
      'In Progress',
    ],
    [
      'sprint',
      'rbook_sprint',
      { action: 'update', sprintId: 's1', fields: { status: 'Active' } },
      "SELECT status AS value FROM sprints WHERE id = 's1'",
      'Active',
    ],
    [
      'identity',
      'rbook_context',
      {
        action: 'update',
        contextType: 'project_identity',
        fieldUpdates: [{ path: 'project_name', value: 'Renamed locally' }],
      },
      "SELECT json_extract(content, '$.project_name') AS value FROM contexts WHERE id = 'project_identity'",
      'Renamed locally',
    ],
  ] as const)(
    '%s edits succeed locally and expose the retired-sync remedy without old network calls',
    async (_name, tool, args, query, value) => {
      const credentials = noCredentials();
      const result = await call(tool, { ...args, projectRoot: root });
      expect(result.success).toBe(true);
      expect(result).toMatchObject({
        warnings: expect.arrayContaining([
          expect.stringMatching(/LEGACY_SYNC_RETIRED.*reasonbook sync/),
        ]),
      });
      expect(read({ root }, query)).toEqual([{ value }]);
      expect(credentials).not.toHaveBeenCalled();
    }
  );

  it('solo stores stay quiet, and failed local edits remain unchanged', async () => {
    sql("DELETE FROM metadata WHERE key = 'collab_role'");
    const credentials = noCredentials();
    const reader = jest.fn(() => 'Active');
    const ok = createSuccess({ kept: true });
    expect(await maybePropagateMutableStatus(ok, 'sprint_status', 's1', reader, root)).toEqual(ok);
    const failed = {
      success: false,
      error: { code: 'LOCAL_FAILURE', message: 'Local edit failed.' },
    };
    expect(await maybePropagateMutableStatus(failed, 'sprint_status', 's1', reader, root)).toEqual(
      failed
    );
    expect(reader).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });
});

describe('backfill keeps the SQLite upload and refuses event replay', () => {
  let previousSync: string | undefined;
  let previousApiKey: string | undefined;
  beforeEach(async () => {
    previousSync = process.env.RBOOK_CHECKPOINT_SYNC;
    previousApiKey = process.env.RBOOK_DASHBOARD_API_KEY;
    process.env.RBOOK_CHECKPOINT_SYNC = 'on';
    process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_retired-sync-test';
    // This suite reaches the upload only after the real sign-in and registered-owner guards.
    sql(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_registered', 'true'), ('dashboard_project_id', 'remote-shared'), ('owner', 'tester');"
    );
    await registerResolvedProjectStore(root);
  });
  afterEach(async () => {
    // Dispatch can start an automatic probe; finish it before removing its store or sign-in.
    await __resetDashboardUploadScheduler();
    if (previousSync === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
    else process.env.RBOOK_CHECKPOINT_SYNC = previousSync;
    if (previousApiKey === undefined) delete process.env.RBOOK_DASHBOARD_API_KEY;
    else process.env.RBOOK_DASHBOARD_API_KEY = previousApiKey;
  });

  function dashboard(ok: boolean) {
    const upload = jest.fn(async () =>
      ok
        ? createSuccess({ counts: { missions: 1 }, errors: [], durationMs: 1 })
        : { success: false, error: { code: 'UPLOAD_FAILED', message: 'Upload unavailable.' } }
    );
    const replay = jest.fn(async () => createSuccess({}));
    const listing = jest.fn(async () =>
      createSuccess({
        user: { id: 'tester-account', username: 'tester' },
        projects: [{ id: 'remote-shared', slug: 'shared', name: 'shared', isOwner: true }],
        totalCount: 1,
      })
    );
    const client = {
      syncSqliteFile: upload,
      pushSyncEvent: replay,
      getMyProjects: listing,
      rememberIdentity: jest.fn(),
    } as unknown as DashboardClient;
    jest
      .spyOn(DashboardClient, 'fromEnvForProject')
      .mockResolvedValue(
        createSuccess({ client, keySource: 'legacy-env', matchedProjectRoot: null }) as Awaited<
          ReturnType<typeof DashboardClient.fromEnvForProject>
        >
      );
    return { upload, replay, listing };
  }

  it('a registered project still uploads its SQLite file', async () => {
    const remote = dashboard(true);
    const result = await rbookDbBackfill({ projectRoot: root });
    expect(result).toMatchObject({ success: true, data: { pushed: 1, failed: 0 } });
    expect(remote.listing).toHaveBeenCalledTimes(2);
    expect(remote.upload).toHaveBeenCalledTimes(1);
    expect(remote.replay).not.toHaveBeenCalled();
  });

  it('a failed SQLite upload reports the failure and refuses a replay fallback', async () => {
    const remote = dashboard(false);
    const result = await rbookDbBackfill({ projectRoot: root });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'UPLOAD_FAILED', message: 'Upload unavailable.' },
    });
    expect(remote.upload).toHaveBeenCalledTimes(1);
    expect(remote.replay).not.toHaveBeenCalled();
  });

  it('a never-uploaded project names the explicit session close that first uploads it', async () => {
    sql("DELETE FROM metadata WHERE key = 'dashboard_slug'");
    delete process.env.RBOOK_CHECKPOINT_SYNC;
    const remote = dashboard(true);
    expect(await call('rbook_db', { action: 'backfill', projectRoot: root })).toMatchObject({
      success: false,
      error: {
        code: 'DASHBOARD_NOT_UPLOADED',
        message: expect.stringContaining('no recorded dashboard upload address'),
        suggestion: expect.stringMatching(
          /rbook_session\(action="start".*rbook_session\(action="complete"/
        ),
      },
    });
    expect(remote.upload).not.toHaveBeenCalled();
    expect(remote.listing).not.toHaveBeenCalled();
    expect(remote.replay).not.toHaveBeenCalled();
    expect(read({ root }, "SELECT * FROM metadata WHERE key = 'backfill_cursor'")).toEqual([]);
  });

  it.each(['off', 'signed-out'])(
    'a never-uploaded project respects the %s gate before suggesting a session close',
    async (gate) => {
      sql("DELETE FROM metadata WHERE key = 'dashboard_slug'");
      if (gate === 'off') process.env.RBOOK_CHECKPOINT_SYNC = 'off';
      else delete process.env.RBOOK_DASHBOARD_API_KEY;
      const remote = dashboard(true);
      const result = await rbookDbBackfill({ projectRoot: root });
      expect(result.error?.code).toBe(
        gate === 'off' ? 'CHECKPOINT_SYNC_DISABLED' : 'DASHBOARD_NOT_CONFIGURED'
      );
      expect(result.error?.suggestion).not.toContain('rbook_session(action="complete"');
      expect(remote.upload).not.toHaveBeenCalled();
      expect(remote.listing).not.toHaveBeenCalled();
      expect(remote.replay).not.toHaveBeenCalled();
    }
  );
});
