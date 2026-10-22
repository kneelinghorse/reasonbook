// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A record with persistent cuts reaches no upload until its referee reports support.
// ABOUTME: Capability failures and legacy reports refuse before bytes leave, while a supported report reaches upload.
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { canonicalJson } from '../../src/tools/rbook/record-capture';
import { recordOwnChanges } from '../../src/tools/rbook/record-changes';
import { localCopyReport } from '../../src/tools/rbook/record-copy-report';
import * as dashboardPeer from '../../src/tools/rbook/record-dashboard-peer';
import { shareThroughDashboard } from '../../src/tools/rbook/record-dashboard-share';
import { storeOpener } from '../../src/tools/rbook/record-sync';
import { dbOf, replicaFixture, useMachine, type ReplicaFixture } from '../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-set-aside-share-version-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

async function attempt(version: string | null, confirm = true) {
  const owner = await ownerCopy(fixture.tmp);
  const gone = await joinedCopy(fixture.tmp, owner, 'gone', 'Owner');
  await onCopy(fixture.tmp, owner, (client) => {
    expect(
      client.writeTransaction(() =>
        recordOwnChanges(client, [
          {
            kind: 'member',
            entity: 'member',
            entityId: 'owner',
            field: null,
            value: canonicalJson({
              name: 'Owner',
              role: 'owner',
              setAsideCuts: { [gone.replicaId]: 0 },
            }),
          },
        ])
      ).success
    ).toBe(true);
  });
  const client = new DashboardClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'owned-test-key' });
  jest.spyOn(dashboardPeer, 'dashboardClientFor').mockResolvedValue(client);
  const capability = jest.spyOn(client, 'refereeCapabilities').mockResolvedValue(
    version === null
      ? {
          success: false,
          error: { code: 'OWNED_CAPABILITY_FAILURE', message: 'No usable report.' },
        }
      : { success: true, data: { version, recordProtocol: localCopyReport().reads } }
  );
  const upload = jest.spyOn(client, 'relayRefereeCall').mockResolvedValue({
    success: true,
    data: {
      status: 409,
      body: { success: false, error: { code: 'OWNED_UPLOAD_STOP', message: 'Upload reached.' } },
    },
  });
  useMachine(fixture.tmp, owner.machine);
  const result = await shareThroughDashboard(
    storeOpener(dbOf(owner.root)),
    storeOpener(dbOf(owner.root), { replicaCheck: false }),
    dbOf(owner.root),
    { confirm, projectId: 'owned-version-project' }
  );
  return { result, upload, capability };
}

it.each(['4.4.0', '4.5.0-rc.1', 'invalid', null])(
  'refuses before any upload when a set-aside meets referee report %s',
  async (version) => {
    const { result, upload } = await attempt(version);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/set.aside.*4\.5\.0|4\.5\.0.*set.aside/i);
    expect(result.error?.suggestion).toMatch(/Nothing was uploaded/);
    expect(upload).not.toHaveBeenCalled();
  }
);

it('a released supporting referee reaches upload after the gate', async () => {
  const { result, upload } = await attempt('4.5.0');
  expect(result.error?.code).toBe('OWNED_UPLOAD_STOP');
  expect(upload.mock.calls.filter(([, call]) => call.kind === 'upload')).toHaveLength(1);
});

it('a dry run neither asks for a capability nor uploads', async () => {
  const { result, upload, capability } = await attempt('4.4.0', false);
  expect(result.success).toBe(true);
  expect(capability).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
});
