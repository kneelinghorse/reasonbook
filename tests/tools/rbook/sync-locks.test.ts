// ABOUTME: Retired dashboard lock hooks preserve successful local edits and expose a remedy.
// ABOUTME: Real solo and collab stores prove the activation query and no-network behavior.
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import {
  maybePropagateMissionStatus,
  maybePropagateMutableStatus,
  pushMutableStatusUnderLock,
} from '../../../src/tools/rbook/sync-locks';
import { formatMissionStartForLLM } from '../../../src/tools/rbook/rbook-mission-start';
import { createSuccess } from '../../../src/tools/rbook/errors';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import {
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
let fixture: ReplicaFixture;
let root: string;
let credentials: jest.SpiedFunction<typeof DashboardClient.fromEnvForProject>;
beforeEach(() => {
  fixture = replicaFixture('rbook-lock-retirement-');
  useMachine(fixture.tmp, 'local');
  root = project(fixture.tmp, 'local');
  credentials = jest.spyOn(DashboardClient, 'fromEnvForProject').mockImplementation(async () => {
    throw new Error('No retired sync credentials');
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

it('mission and generic hooks remain quiet on a solo store', async () => {
  const base = createSuccess({ ok: true });
  const reader = jest.fn(() => 'Completed');
  expect(await maybePropagateMissionStatus(base, 'm1', root)).toEqual(base);
  expect(await maybePropagateMutableStatus(base, 'sprint_status', 's1', reader, root)).toEqual(
    base
  );
  expect(base.warnings).toBeUndefined();
  expect(reader).not.toHaveBeenCalled();
  expect(credentials).not.toHaveBeenCalled();
});
it.each(['owner', 'editor'])(
  'the %s collab_role produces a coded warning and preserves the local result',
  async (role) => {
    const db = new Database(dbOf(root));
    db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('collab_role', role);
    db.close();
    const base = createSuccess({ ok: true });
    const result = await maybePropagateMissionStatus(base, 'm1', root);
    expect(result).toMatchObject({
      success: true,
      data: { ok: true },
      warnings: [expect.stringMatching(/LEGACY_SYNC_RETIRED.*reasonbook sync/)],
    });
    expect(credentials).not.toHaveBeenCalled();
  }
);
it('a failed activation query is visible without failing the completed local edit', async () => {
  const original = RbookDatabaseClient.prototype.getOne;
  jest.spyOn(RbookDatabaseClient.prototype, 'getOne').mockImplementation(function (
    this: RbookDatabaseClient,
    sql,
    ...args
  ) {
    if (sql.includes("key = 'collab_role'"))
      return { success: false, error: { code: 'DB_QUERY_FAILED', message: 'Metadata unreadable' } };
    return original.call(this, sql, ...args);
  });
  const result = await maybePropagateMissionStatus(createSuccess({ ok: true }), 'm1', root);
  expect(result.success).toBe(true);
  expect(result.warnings?.join(' ')).toContain('Metadata unreadable');
  expect(credentials).not.toHaveBeenCalled();
});
it('lock push refuses even with a supplied client', async () => {
  const acquireLock = jest.fn();
  const result = await pushMutableStatusUnderLock({
    projectRoot: root,
    missionId: 'm1',
    status: 'Queued',
    client: { acquireLock } as unknown as DashboardClient,
  });
  expect(result).toMatchObject({ success: false, error: { code: 'LEGACY_SYNC_RETIRED' } });
  expect(acquireLock).not.toHaveBeenCalled();
});
it('transition formatters render the retirement remedy', () => {
  const formatted = formatMissionStartForLLM({
    success: true,
    data: {
      missionId: 'm1',
      previousStatus: 'Queued',
      currentStatus: 'In Progress',
      startedAt: new Date().toISOString(),
      relevantDecisions: [],
    } as unknown as Parameters<typeof formatMissionStartForLLM>[0]['data'],
    warnings: ['LEGACY_SYNC_RETIRED: Use reasonbook sync.'],
  });
  expect(formatted).toContain('Warnings:');
  expect(formatted).toContain('reasonbook sync');
});

it('an unexpected activation read exception cannot reject an already completed local edit', async () => {
  jest.spyOn(RbookDatabaseClient, 'create').mockRejectedValueOnce(new Error('Store open failed'));
  const result = await maybePropagateMissionStatus(createSuccess({ ok: true }), 'm1', root);
  expect(result.success).toBe(true);
  expect(result.warnings?.join(' ')).toContain('Store open failed');
  expect(credentials).not.toHaveBeenCalled();
});
