// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Check the actual private upload after a concurrent writer switches the source record.
// ABOUTME: An old or unreported referee never receives protocol2 bytes despite an earlier write1 preflight.
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { createError, createSuccess } from '../../../src/tools/rbook/errors';
import { inviteMember } from '../../../src/tools/rbook/record-membership';
import { currentWriteProtocol } from '../../../src/tools/rbook/record-protocol-state';
import { shareThroughDashboard } from '../../../src/tools/rbook/record-dashboard-share';
import { dashboardPeer } from '../../../src/tools/rbook/record-dashboard-peer';
import { changesSince } from '../../../src/tools/rbook/record-since';
import * as fresh from '../../../src/tools/rbook/record-fresh-copy';
import type { Opener } from '../../../src/tools/rbook/record-sync';
import { dbOf, replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { onCopy, ownerCopy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-upload-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

it.each([null, 1, 2])(
  'checks snapshot bytes against referee reads=%s after a real write switches the record',
  async (recordProtocol) => {
    const owner = await ownerCopy(fixture.tmp);
    const open: Opener = (step) => onCopy(fixture.tmp, owner, step);
    expect(await open(currentWriteProtocol)).toBe(1);
    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      email: 'owner@example.com',
      password: 'unused',
    });
    jest
      .spyOn(DashboardClient, 'fromEnvForProject')
      .mockResolvedValue(
        createSuccess({ client, keySource: 'user-scoped', matchedProjectRoot: null })
      );
    jest
      .spyOn(client, 'refereeCapabilities')
      .mockResolvedValue(createSuccess({ version: '4.5.0', recordProtocol }));
    const upload = jest.spyOn(client, 'relayRefereeCall').mockResolvedValue(
      createSuccess({
        status: 400,
        body: createError({
          code: 'OWNED_STOP',
          message: 'Reached upload',
          suggestion: 'Test boundary.',
        }),
      })
    );
    const original = fresh.buildFreshCopy;
    const copied = jest.spyOn(fresh, 'buildFreshCopy').mockImplementation(async (...args) => {
      // This separate real SQLite connection writes after capability/local preflight but before snapshot.
      expect(
        (await open((store) => inviteMember(store, { name: 'Concurrent person' }))).success
      ).toBe(true);
      expect(await open(currentWriteProtocol)).toBe(2);
      return original(...args);
    });
    const result = await shareThroughDashboard(open, open, dbOf(owner.root), {
      confirm: true,
      projectId: 'owned-project',
    });
    expect(copied).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    if (recordProtocol === 2) {
      expect(upload).toHaveBeenCalledTimes(1);
      expect(result.error?.code).toBe('OWNED_STOP');
    } else {
      expect(upload).not.toHaveBeenCalled();
      expect(result.error?.message).toMatch(/protocol 2/);
      expect(result.error?.suggestion).toMatch(/upgrad/i);
    }
  }
);

it('a complete dashboard recovery fetch refuses the stream cap instead of returning a partial log', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const rows = await onCopy(fixture.tmp, owner, (client) => changesSince(client, {}));
  const client = new DashboardClient({ baseUrl: 'http://localhost:3100', apiKey: 'owned-test' });
  jest
    .spyOn(DashboardClient, 'fromEnvForProject')
    .mockResolvedValue(
      createSuccess({ client, keySource: 'user-scoped', matchedProjectRoot: null })
    );
  jest.spyOn(client, 'refereeRequestLimit').mockResolvedValue(createSuccess(1024 * 1024));
  jest
    .spyOn(client, 'relayPeerCall')
    .mockResolvedValue(
      createSuccess({ status: 200, body: createSuccess({ changes: rows, more: true }) })
    );
  const remote = await dashboardPeer(
    { kind: 'dashboard', url: 'https://reasonbook.ai', projectId: 'owned' },
    { projectRoot: owner.root, replicaIdNow: async () => owner.replicaId, maxStreamBytes: 1 }
  );
  expect(await remote.changesSince({})).toEqual(rows);
  await expect(remote.changesSince({}, { reads: 2, requireComplete: true })).rejects.toThrow(
    /complete record/
  );
});
