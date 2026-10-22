// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Carry capabilities over actual SSH-shaped streams and persist only validated copy identities.
// ABOUTME: Prove handshakes do not claim exchanges, and refused or foreign traffic cannot poison later version guards.
import path from 'path';
import { PassThrough } from 'stream';
import { getServerVersion } from '../../../src/server-version';
import { hello } from '../../../src/tools/rbook/record-exchange';
import { importBundle, readBundle, writeBundle } from '../../../src/tools/rbook/record-bundle';
import { reportedCopy, rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { reach, syncRoute } from '../../../src/tools/rbook/record-sync';
import { serveSync, wirePeer, type NearHello } from '../../../src/tools/rbook/record-wire';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, type Copy } from '../../helpers/shared-copies';
import { farEndsExited, routeTo, standinSsh } from '../../helpers/standin-ssh';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-report-wire-');
});
afterEach(async () => {
  await farEndsExited(fixture.tmp);
  fixture.restore();
});
const installed = () => ({ libraryVersion: getServerVersion(), reads: 2 });
const open =
  (copy: Copy) =>
  <T>(step: Parameters<typeof onCopy<T>>[2]) =>
    onCopy(fixture.tmp, copy, step);

it('the actual CLI sync transports both reports and records completed exchanges on both copies', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const member = await joinedCopy(fixture.tmp, owner, 'member');
  const { ssh } = standinSsh(path.join(fixture.tmp, 'ssh'));
  const route = routeTo(owner.root, path.join(fixture.tmp, `config-${owner.machine}`));
  const result = await syncRoute(open(member), route, { ssh });
  expect(result.success).toBe(true);
  for (const [near, far] of [
    [owner, member],
    [member, owner],
  ])
    await onCopy(fixture.tmp, near, (client) => {
      expect(reportedCopy(client, far.replicaId)).toEqual(installed());
      expect(
        client.getOne<{ last_ok_at: string }>(
          'SELECT last_ok_at FROM record_peers WHERE replica_id=?',
          [far.replicaId]
        ).data?.last_ok_at
      ).toBeTruthy();
    });
});

it('NearHello carries the current report before exchange without marking an exchange complete', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const member = await joinedCopy(fixture.tmp, owner, 'member');
  await onCopy(fixture.tmp, owner, (client) => rememberCopyReport(client, member.replicaId, {}));
  const { ssh } = standinSsh(path.join(fixture.tmp, 'ssh'));
  const reached = await reach(
    routeTo(owner.root, path.join(fixture.tmp, `config-${owner.machine}`)),
    undefined,
    { ssh },
    open(member)
  );
  expect(reached.success).toBe(true);
  try {
    expect(await reached.data!.hello()).toMatchObject(installed());
  } finally {
    reached.data!.close();
  }
  await farEndsExited(fixture.tmp);
  await onCopy(fixture.tmp, owner, (client) => {
    expect(reportedCopy(client, member.replicaId)).toEqual(installed());
    expect(
      client.getOne<{ last_ok_at: string | null }>(
        'SELECT last_ok_at FROM record_peers WHERE replica_id=?',
        [member.replicaId]
      ).data?.last_ok_at
    ).toBeNull();
  });
});

async function helloWire(owner: Copy, near: NearHello) {
  const requests = new PassThrough(),
    answers = new PassThrough();
  const serving = serveSync(requests, answers, open(owner));
  const peer = await wirePeer(
    'owner',
    answers,
    requests,
    () => requests.end(),
    5000,
    async () => near
  );
  try {
    await peer.hello();
  } finally {
    peer.close();
    await serving;
  }
}

it.each(['foreign', 'unadmitted', 'epoch', 'authority'])(
  'a %s near hello does not replace admitted capability evidence',
  async (kind) => {
    const owner = await ownerCopy(fixture.tmp),
      member = await joinedCopy(fixture.tmp, owner, 'member');
    const near = await onCopy(fixture.tmp, member, hello);
    const original = { libraryVersion: '4.2.0', reads: 1 };
    await onCopy(fixture.tmp, owner, (client) =>
      rememberCopyReport(client, member.replicaId, original)
    );
    const forged = {
      ...near,
      libraryVersion: '4.5.0',
      reads: 2,
      ...(kind === 'foreign' ? { projectId: 'foreign-project' } : {}),
      ...(kind === 'unadmitted' ? { replicaId: 'unknown-copy' } : {}),
      ...(kind === 'epoch' ? { epoch: near.epoch + 1 } : {}),
      ...(kind === 'authority' ? { authority: 'other-owner' } : {}),
    };
    await helloWire(owner, forged);
    await onCopy(fixture.tmp, owner, (client) => {
      expect(reportedCopy(client, member.replicaId)).toEqual(original);
      expect(reportedCopy(client, 'unknown-copy')).toEqual({ libraryVersion: null, reads: null });
    });
  }
);

it('a legacy valid near hello clears a prior newer report', async () => {
  const owner = await ownerCopy(fixture.tmp),
    member = await joinedCopy(fixture.tmp, owner, 'member');
  const { projectId, replicaId, authority, epoch } = await onCopy(fixture.tmp, member, hello);
  await onCopy(fixture.tmp, owner, (client) =>
    rememberCopyReport(client, replicaId, { libraryVersion: '4.5.0', reads: 2 })
  );
  await helloWire(owner, { projectId, replicaId, authority, epoch });
  await onCopy(fixture.tmp, owner, (client) =>
    expect(reportedCopy(client, replicaId)).toEqual({ libraryVersion: null, reads: null })
  );
});

it('validated bundles retain the admitted sender report while foreign or edited bundles cannot replace it', async () => {
  const owner = await ownerCopy(fixture.tmp),
    member = await joinedCopy(fixture.tmp, owner, 'member');
  const bundle = await onCopy(fixture.tmp, owner, (client) => writeBundle(client, {}));
  await onCopy(fixture.tmp, member, (client) => {
    rememberCopyReport(client, owner.replicaId, {});
    expect(importBundle(client, bundle).success).toBe(true);
    expect(reportedCopy(client, owner.replicaId)).toEqual(installed());
    expect(readBundle(JSON.stringify(bundle)).success).toBe(true);
    // Always alter the report, including when the installed release becomes the old fixture's value.
    const edited = readBundle(
      JSON.stringify({
        ...bundle,
        from: { ...bundle.from, libraryVersion: `${bundle.from.libraryVersion}-edited` },
      })
    );
    expect(edited.success).toBe(false);
    expect(edited.error?.message).toContain('does not match its content hash');
    expect(
      importBundle(client, {
        ...bundle,
        from: { ...bundle.from, projectId: 'foreign', libraryVersion: '4.5.0' },
      }).success
    ).toBe(false);
    expect(reportedCopy(client, owner.replicaId)).toEqual(installed());
  });
});
