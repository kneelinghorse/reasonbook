// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Ended dashboard routes retain exact identity for explicit revival and stay inactive automatically.
// ABOUTME: Real shared stores prove route-ending changes no record identity, history or direct fallback policy.
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { createSuccess } from '../../../src/tools/rbook/errors';
import * as dashboard from '../../../src/tools/rbook/record-dashboard-peer';
import type { DashboardRoute } from '../../../src/tools/rbook/record-dashboard-route';
import { peerHealth, rememberPeer } from '../../../src/tools/rbook/record-peers';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import { storeOpener, syncPeers } from '../../../src/tools/rbook/record-sync';
import {
  bundleRefusal,
  refereeingDashboard,
  type WirePeer,
} from '../../../src/tools/rbook/record-wire';
import { REPLICA_ERROR_CODES, ReplicaRefusal } from '../../../src/tools/rbook/replica-identity';
import { dbOf, replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { memberCopy, onCopy, ownerCopy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-ended-routes-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});
const route: DashboardRoute = {
  kind: 'dashboard',
  url: 'https://reasonbook.ai',
  projectId: 'original-dashboard-id',
};

it('retains the exact ended route and shows the explicit revival remedy after a dashboard ends sharing', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const member = await memberCopy(fixture.tmp, owner, 'member', 1);
  await onCopy(fixture.tmp, member, (client) => rememberPeer(client, owner.replicaId, { route }));
  jest.spyOn(dashboard, 'dashboardPeer').mockResolvedValue({
    name: 'dashboard',
    hello: async () => {
      throw new ReplicaRefusal({
        code: REPLICA_ERROR_CODES.ROUTE_ENDED,
        message: 'Sharing ended.',
        suggestion: 'Sync directly.',
      });
    },
    close: () => undefined,
  } as unknown as WirePeer);
  const result = await syncPeers(storeOpener(dbOf(member.root)), { projectRoot: member.root });
  expect(result.error?.code).toBe(REPLICA_ERROR_CODES.ROUTE_ENDED);
  const kept = await onCopy(fixture.tmp, member, (client) => ({
    peers: peerHealth(client),
    review: sharedRecordReview(client),
    referee: refereeingDashboard(client),
    bundle: bundleRefusal(client),
  }));
  expect(kept.peers.find((peer) => peer.replicaId === owner.replicaId)?.route).toEqual({
    ...route,
    ended: true,
  });
  expect(kept.review?.peers?.join(' ')).toMatch(/ended.*explicit|ended.*reasonbook sync/);
  expect(kept.referee).toBeNull();
  expect(kept.bundle).toBeNull();
});

it('automatic sync does not probe an ended route or erase the retained identity', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const member = await memberCopy(fixture.tmp, owner, 'member', 1);
  const ended = { ...route, ended: true } as DashboardRoute;
  await onCopy(fixture.tmp, member, (client) =>
    rememberPeer(client, owner.replicaId, { route: ended })
  );
  const reached = jest
    .spyOn(dashboard, 'dashboardPeer')
    .mockRejectedValue(new Error('must not reach ended route'));
  const result = await syncPeers(storeOpener(dbOf(member.root)), {
    projectRoot: member.root,
    auto: true,
  });
  expect(result).toEqual(createSuccess({ peers: [] }));
  expect(reached).not.toHaveBeenCalled();
  expect(await onCopy(fixture.tmp, member, (client) => peerHealth(client)[0].route)).toEqual(ended);
});
