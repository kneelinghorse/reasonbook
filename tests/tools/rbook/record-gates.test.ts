// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (design §s96-m13 item 3) — a member's copy of a shared record never registers, never names the
// ABOUTME: dashboard project or its owner, and never uploads, at a checkpoint or on the timer; the owner's copy does.
import Database from 'better-sqlite3';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import http from 'http';
import type { AddressInfo } from 'net';
import { triggerCheckpointBackfill } from '../../../src/tools/rbook/checkpoint-backfill';
import { checkAndRegister } from '../../../src/tools/rbook/checkpoint-registration';
import type { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { isMembersStore, readUploadProject } from '../../../src/tools/rbook/dashboard-upload';
import {
  __resetDashboardUploadScheduler,
  markDashboardUploadOwed,
} from '../../../src/tools/rbook/dashboard-upload-scheduler';
import { resolveAndPersistOwner } from '../../../src/tools/rbook/owner-resolution';
import { rbookDbBackfill, rbookDbPurge } from '../../../src/tools/rbook/rbook-db-backfill';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { isMembersCopy } from '../../../src/tools/rbook/record-membership';
import {
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  joinedCopy,
  memberCopy,
  onCopy,
  ownerCopy,
  read,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
let server: http.Server;
let requests: string[];
const keys = ['RBOOK_DASHBOARD_API_KEY', 'RBOOK_DASHBOARD_URL', 'RBOOK_CHECKPOINT_SYNC'] as const;
let previous: Record<string, string | undefined>;

beforeEach(async () => {
  fixture = replicaFixture('rbook-gates-');
  previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  requests = [];
  server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.RBOOK_DASHBOARD_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.RBOOK_DASHBOARD_API_KEY = 'test-key';
  delete process.env.RBOOK_CHECKPOINT_SYNC;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of keys)
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  fixture.restore();
});

const DASHBOARD = {
  dashboard_registered: 'true',
  dashboard_slug: 'p-shared',
  dashboard_project_id: 'remote-1',
  owner: 'owner-account',
  dashboard_username: 'owner-account',
};

/** The owner's copy, registered with the dashboard, and a member's copy made from it afterwards. */
async function registeredPair(): Promise<{ owner: Copy; member: Copy }> {
  const owner = await ownerCopy(fixture.tmp);
  const db = new Database(dbOf(owner.root));
  try {
    const put = db.prepare(
      'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    for (const [key, value] of Object.entries(DASHBOARD)) put.run(key, value);
  } finally {
    db.close();
  }
  return { owner, member: await memberCopy(fixture.tmp, owner, 'member', 1) };
}

const dashboardKeys = (copy: Copy) =>
  read(
    copy,
    `SELECT key, value FROM metadata WHERE key IN (${Object.keys(DASHBOARD)
      .map(() => '?')
      .join(', ')}) ORDER BY key`,
    Object.keys(DASHBOARD)
  );

/** A dashboard client that fails the test if anything calls it. */
const untouchable = new Proxy(
  {},
  {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      return () => {
        throw new Error(`the dashboard client was used: ${String(property)}`);
      };
    },
  }
) as DashboardClient;

describe("a member's copy never reaches the dashboard", () => {
  it('a checkpoint on the member uploads nothing and changes no dashboard metadata; the owner uploads', async () => {
    const { owner, member } = await registeredPair();
    const before = dashboardKeys(member);
    useMachine(fixture.tmp, member.machine);
    await triggerCheckpointBackfill({ projectRoot: member.root, force: true });
    expect(requests).toEqual([]);
    expect(dashboardKeys(member)).toEqual(before);
    // The control: the same checkpoint on the owner's copy reaches the dashboard.
    useMachine(fixture.tmp, owner.machine);
    await triggerCheckpointBackfill({ projectRoot: owner.root, force: true });
    expect(requests.length).toBeGreaterThan(0);
  }, 120000);

  it('the upload record, registration, owner resolution and the old backfill each stop on a member', async () => {
    const { owner, member } = await registeredPair();
    useMachine(fixture.tmp, 'solo');
    const solo = project(fixture.tmp, 'solo');
    const membersStore = (root: string) => isMembersStore(readUploadProject(root)!);
    expect(await Promise.all([member, owner].map((copy) => membersStore(copy.root)))).toEqual([
      true,
      false,
    ]);
    expect(await membersStore(solo)).toBe(false);
    expect(await onCopy(fixture.tmp, member, (client) => isMembersCopy(client))).toBe(true);
    const before = dashboardKeys(member);
    useMachine(fixture.tmp, member.machine);
    expect(await checkAndRegister(member.root, untouchable, 'legacy-env')).toBeNull();
    const resolved = await onCopy(fixture.tmp, member, (client) =>
      resolveAndPersistOwner(client, untouchable)
    );
    expect(resolved).toMatchObject({ owner: 'owner-account', source: 'metadata' });
    const backfill = await rbookDbBackfill({ projectRoot: member.root });
    expect(backfill.error).toMatchObject({
      code: 'RECORD_WRITE_REFUSED',
      message: expect.stringMatching(/member's copy of a shared record, which never uploads/),
    });
    expect(dashboardKeys(member)).toEqual(before);
    expect(requests).toEqual([]);
  }, 120000);

  it("neither a member's write nor its checkpoint marks its machine's registry as owing an upload", async () => {
    const { owner, member } = await registeredPair();
    const [{ value: projectId }] = read<{ value: string }>(
      owner,
      "SELECT value FROM metadata WHERE key = 'project_id'"
    );
    // Each machine knows the project at its own copy's folder, as its first tool call leaves it.
    const uploadState = async (copy: Copy) => {
      useMachine(fixture.tmp, copy.machine);
      const registry = await ProjectGraphRegistry.create();
      try {
        if (!registry.get(projectId))
          registry.register({ project_id: projectId, store_path: copy.root, name: copy.name });
        return registry.readUploadState(projectId);
      } finally {
        registry.close();
      }
    };
    try {
      await uploadState(member);
      await markDashboardUploadOwed(member.root);
      await triggerCheckpointBackfill({ projectRoot: member.root, force: true });
      expect(await uploadState(member)).toMatchObject({ firstOwedAt: null, lastAttemptAt: null });
      // The control: a write on the owner's copy marks its machine's registry as owing one.
      await uploadState(owner);
      await markDashboardUploadOwed(owner.root);
      expect((await uploadState(owner))?.firstOwedAt).toEqual(expect.any(Number));
    } finally {
      await __resetDashboardUploadScheduler();
    }
  }, 120000);
});

describe('the dashboard follows the owner copy (s96-m13 build-time critics)', () => {
  it("after a handover the new owner copy is the one that uploads, and a member's copy never purges the mirror", async () => {
    const old = await ownerCopy(fixture.tmp);
    const next = await joinedCopy(fixture.tmp, old, 'next', 'Owner');
    await syncCopies(fixture.tmp, old, next);
    const membersStore = (copy: Copy) => isMembersStore(readUploadProject(copy.root)!);
    expect([await membersStore(old), await membersStore(next)]).toEqual([false, true]);
    await onCopy(fixture.tmp, old, (client) => handOver(client, { to: next.replicaId }), {
      replicaCheck: false,
    });
    await syncCopies(fixture.tmp, old, next);
    await onCopy(fixture.tmp, next, (client) => confirmOwner(client), { replicaCheck: false });
    // ADR s96 §8: the authority chain, not the baseline, says whose copy uploads.
    expect([await membersStore(old), await membersStore(next)]).toEqual([true, false]);
    useMachine(fixture.tmp, old.machine);
    const purged = await rbookDbPurge({ confirm: true, projectRoot: old.root });
    expect(purged.error).toMatchObject({
      code: 'RECORD_WRITE_REFUSED',
      message: expect.stringMatching(/the dashboard mirror is the owner's, so it was not purged/),
    });
    expect(requests).toEqual([]);
  }, 240000);
});
