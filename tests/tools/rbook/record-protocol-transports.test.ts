// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Protect legacy readers at actual direct-peer and SSH-shaped outbound boundaries.
// ABOUTME: A missing or unauthenticated report never grants protocol2 delivery.
import { PassThrough } from 'stream';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { exchange, hello, type Peer } from '../../../src/tools/rbook/record-exchange';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { reportedCopy } from '../../../src/tools/rbook/record-peer-report';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { removeMember } from '../../../src/tools/rbook/record-membership';
import { setAsideReplica } from '../../../src/tools/rbook/record-set-aside';
import { changesSince } from '../../../src/tools/rbook/record-since';
import type { LoggedChange } from '../../../src/tools/rbook/record-standing';
import { serveSync, wirePeer, type NearHello } from '../../../src/tools/rbook/record-wire';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import {
  copyPeer,
  joinedCopy,
  onCopy,
  ownerCopy,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-transport-');
});
afterEach(() => fixture.restore());

it('hello advertises an unswitched record as write1 while the installed reader can read2', async () => {
  const owner = await ownerCopy(fixture.tmp);
  expect(await onCopy(fixture.tmp, owner, hello)).toMatchObject({ recordProtocol: 1, reads: 2 });
});

async function newer(owner: Copy, protocol = 2) {
  await onCopy(fixture.tmp, owner, (client) => {
    const undo = upgradeRecordProtocolForTesting(protocol);
    try {
      const done = client.writeTransaction(() =>
        recordOwnChanges(client, [
          {
            kind: 'member',
            entity: '__member__',
            entityId: 'another-person',
            field: null,
            value: JSON.stringify({ name: 'Another', role: 'editor' }),
          },
        ])
      );
      expect(done.success).toBe(true);
    } finally {
      undo();
    }
  });
}

it.each([undefined, 1])(
  'direct clientPeer exchange with reads=%s never calls the old receiver with protocol2',
  async (reads) => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joinedCopy(fixture.tmp, owner, 'Member');
    await newer(owner);
    const base = copyPeer(fixture.tmp, member);
    const deliveries: LoggedChange[][] = [];
    const old: Peer = {
      ...base,
      hello: async () => ({ ...(await base.hello()), libraryVersion: '4.2.0', reads }),
      apply: async (rows, options) => {
        deliveries.push([...rows]);
        return base.apply(rows, options);
      },
    };
    const result = await exchange(copyPeer(fixture.tmp, owner), old);
    expect(result.success).toBe(true);
    expect(deliveries.flat().some((row) => row.protocol_version > 1)).toBe(false);
    await onCopy(fixture.tmp, owner, (client) => {
      expect(reportedCopy(client, member.replicaId)).toEqual({
        libraryVersion: '4.2.0',
        reads: reads ?? null,
      });
    });
  }
);

it('complete SSH fetch refuses a future row that arrived after hello without mutating the source', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const member = await joinedCopy(fixture.tmp, owner, 'Member');
  const near = await onCopy(fixture.tmp, member, hello);
  const requests = new PassThrough(),
    answers = new PassThrough();
  const serving = serveSync(requests, answers, (step) => onCopy(fixture.tmp, owner, step));
  const peer = await wirePeer(
    'owner',
    answers,
    requests,
    () => requests.end(),
    5000,
    async () => ({ ...near, reads: 2 })
  );
  try {
    await peer.hello();
    await newer(owner, 3);
    const before = await onCopy(fixture.tmp, owner, (client) => changesSince(client, {}));
    const recipient = { reads: 2, requireComplete: true };
    await expect(peer.changesSince({}, recipient)).rejects.toThrow(/protocol 3/);
    expect(await onCopy(fixture.tmp, owner, (client) => changesSince(client, {}))).toEqual(before);
  } finally {
    peer.close();
    await serving;
  }
});

async function wireRows(
  owner: Copy,
  near?: NearHello,
  requireComplete = false
): Promise<LoggedChange[]> {
  const requests = new PassThrough(),
    answers = new PassThrough();
  const serving = serveSync(requests, answers, (step) => onCopy(fixture.tmp, owner, step));
  const peer = await wirePeer(
    'owner',
    answers,
    requests,
    () => requests.end(),
    5000,
    near ? async () => near : undefined
  );
  try {
    await peer.hello();
    return await peer.changesSince({}, { requireComplete });
  } finally {
    peer.close();
    await serving;
  }
}

it('SSH far end defaults to1, rejects foreign capability claims, and serves2 to a bound reader', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const member = await joinedCopy(fixture.tmp, owner, 'Member');
  const near = await onCopy(fixture.tmp, member, hello);
  await newer(owner);
  for (const report of [
    undefined,
    { ...near, reads: 1 },
    { ...near, reads: 2, projectId: 'foreign' },
  ]) {
    const rows = await wireRows(owner, report);
    expect(rows.some((row) => row.protocol_version > 1)).toBe(false);
  }
  const full = await wireRows(owner, { ...near, reads: 2 });
  expect(full).toEqual(await onCopy(fixture.tmp, owner, (client) => changesSince(client, {})));
  expect(full.some((row) => row.protocol_version === 2)).toBe(true);
});

it('a known historical-epoch reader can catch up over SSH without replacing its current report', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Owner');
  const pat = await joinedCopy(fixture.tmp, owner, 'Pat');
  const near = await onCopy(fixture.tmp, pat, hello);
  const formerOwner = await onCopy(fixture.tmp, owner, hello);
  await syncCopies(fixture.tmp, studio, owner);
  expect(
    (await onCopy(fixture.tmp, owner, (client) => handOver(client, { to: studio.replicaId })))
      .success
  ).toBe(true);
  await syncCopies(fixture.tmp, studio, owner);
  expect((await onCopy(fixture.tmp, studio, confirmOwner)).success).toBe(true);
  const before = await onCopy(fixture.tmp, studio, (client) => reportedCopy(client, pat.replicaId));
  const rows = await wireRows(studio, { ...near, reads: 2, libraryVersion: '99.0.0' });
  expect(rows.some((row) => row.kind === 'authority' && row.protocol_version === 2)).toBe(true);
  expect((await wireRows(studio, formerOwner)).some((row) => row.kind === 'authority')).toBe(true);
  expect(
    await onCopy(fixture.tmp, studio, (client) => reportedCopy(client, pat.replicaId))
  ).toEqual(before);
  for (const forged of [
    { ...near, authority: 'forged' },
    { ...near, replicaId: 'unadmitted' },
  ])
    expect(
      (await wireRows(studio, { ...forged, reads: 2 })).some((row) => row.protocol_version > 1)
    ).toBe(false);
  expect(
    (
      await onCopy(fixture.tmp, studio, (client) =>
        setAsideReplica(client, { replicaId: pat.replicaId, dryRun: false })
      )
    ).success
  ).toBe(true);
  expect(await wireRows(studio, { ...near, reads: 2 })).toEqual([]);
});

it('a known removed caller receives no new stream over the SSH far end', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const pat = await joinedCopy(fixture.tmp, owner, 'Pat');
  const near = await onCopy(fixture.tmp, pat, hello);
  expect((await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Pat'))).success).toBe(
    true
  );
  expect(await wireRows(owner, { ...near, reads: 2 })).toEqual([]);
  await expect(wireRows(owner, { ...near, reads: 2 }, true)).rejects.toThrow(/complete record/);
});
