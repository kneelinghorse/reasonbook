// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Bootstrap a late join's recovery catch-up through the real SSH wire before admission is known.
// ABOUTME: Only removed historical members may persist factual read reports; no report grants delivery or admission.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { exchange, hello } from '../../../src/tools/rbook/record-exchange';
import { removeMember } from '../../../src/tools/rbook/record-membership';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { reportedCopy } from '../../../src/tools/rbook/record-peer-report';
import { recoverAuthority } from '../../../src/tools/rbook/record-recovery';
import { setAsideReplica } from '../../../src/tools/rbook/record-set-aside';
import { changesSince } from '../../../src/tools/rbook/record-since';
import { mergeContext, type LoggedChange } from '../../../src/tools/rbook/record-standing';
import {
  serveSync,
  wirePeer,
  type NearHello,
  type WirePeer,
} from '../../../src/tools/rbook/record-wire';
import {
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
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
  fixture = replicaFixture('rbook-initial-ssh-');
});
afterEach(() => fixture.restore());
const on = <T>(copy: Copy, step: Parameters<typeof onCopy<T>>[2]) =>
  onCopy(fixture.tmp, copy, step, { replicaCheck: false });

async function recovered(prove = false) {
  const owner = await ownerCopy(fixture.tmp);
  const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
  await syncCopies(fixture.tmp, studio, owner);
  const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
  const root = path.join(fixture.tmp, 'recovered');
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const source = new Database(dbOf(studio.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  useMachine(fixture.tmp, 'recovered');
  writeUserAuthor('Owner');
  const copy = { ...studio, root, machine: 'recovered', name: 'recovered' };
  const result = await recoverAuthority((step) => on(copy, step), [copyPeer(fixture.tmp, studio)], {
    members: ['Darryl'],
  });
  expect(result.success).toBe(true);
  const authority = { ...copy, replicaId: result.data!.authority, block: result.data!.block };
  if (prove) {
    const rows = await on(erin, (client) => changesSince(client, {}));
    expect((await copyPeer(fixture.tmp, authority).apply(rows)).success).toBe(true);
  }
  expect(await on(authority, (client) => mergeContext(client).unseen.has(erin.replicaId))).toBe(
    prove
  );
  expect((await on(authority, hello)).recordProtocol).toBe(2);
  return { authority, erin };
}
async function wire<T>(
  authority: Copy,
  near: (() => Promise<NearHello>) | undefined,
  step: (peer: WirePeer) => Promise<T>
) {
  const requests = new PassThrough(),
    answers = new PassThrough();
  const serving = serveSync(requests, answers, (use) => on(authority, use));
  const peer = await wirePeer('authority', answers, requests, () => requests.end(), 5000, near);
  try {
    return await step(peer);
  } finally {
    peer.close();
    await serving;
  }
}
const snapshot = (authority: Copy, replicaId: string) =>
  on(authority, (client) => ({
    rows: client.getMany('SELECT * FROM record_changes ORDER BY change_id').data,
    members: [...mergeContext(client).members.entries()],
    report: reportedCopy(client, replicaId),
    peer: client.getOne<Record<string, unknown>>(
      'SELECT * FROM record_peers WHERE replica_id = ?',
      [replicaId]
    ),
  }));

it.each([false, true])(
  'initial SSH catch-up works when old admission is already proven=%s without activating it',
  async (prove) => {
    const { authority, erin } = await recovered(prove);
    const before = await snapshot(authority, erin.replicaId);
    expect(before.report).toEqual({ libraryVersion: null, reads: null });
    await wire(
      authority,
      () => on(erin, hello),
      async (peer) => {
        const result = await exchange(copyPeer(fixture.tmp, erin), peer);
        expect(result.data?.caughtUp).toMatchObject({ epoch: 2, authority: authority.replicaId });
        expect((await on(erin, hello)).pending?.authority).toBe(authority.replicaId);
        // The catch-up does not turn ordinary requests into read2 requests for an unadmitted copy.
        if (prove) expect(await peer.changesSince({})).toEqual([]);
        else await expect(peer.changesSince({})).rejects.toThrow(/Upgrade Reasonbook here/);
      }
    );
    expect(await snapshot(authority, erin.replicaId)).toEqual(before);
  }
);

it('old/missing/foreign/forged hello cannot borrow request-supplied read capacity', async () => {
  const { authority, erin } = await recovered();
  const near = await on(erin, hello);
  const before = await snapshot(authority, erin.replicaId);
  const offers: Array<NearHello | undefined> = [
    undefined,
    { ...near, reads: undefined },
    { ...near, reads: 1 },
    { ...near, projectId: 'foreign' },
    { ...near, authority: 'forged-term' },
    { ...near, epoch: near.epoch + 1 },
    { ...near, replicaId: '' },
    { ...near, replicaId: authority.replicaId },
  ];
  for (const offer of offers)
    await wire(authority, offer ? async () => offer : undefined, async (peer) => {
      await peer.hello();
      await expect(
        peer.call('changesSince', {
          marks: {},
          catchUp: true,
          reads: 99,
        })
      ).rejects.toThrow(/Upgrade Reasonbook here/);
    });
  expect(await snapshot(authority, erin.replicaId)).toEqual(before);
});

it.each([false, true])(
  'initial catch-up proof=%s cannot be reused for complete recovery',
  async (prove) => {
    const { authority, erin } = await recovered(prove);
    const before = await snapshot(authority, erin.replicaId);
    await wire(
      authority,
      () => on(erin, hello),
      async (peer) => {
        await peer.hello();
        await expect(
          peer.call('changesSince', { marks: {}, catchUp: true, requireComplete: true, reads: 99 })
        ).rejects.toThrow(/complete record/);
      }
    );
    expect(await snapshot(authority, erin.replicaId)).toEqual(before);
  }
);

async function moved() {
  const owner = await ownerCopy(fixture.tmp);
  const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Owner');
  const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
  const near = await on(erin, hello),
    former = await on(owner, hello);
  await syncCopies(fixture.tmp, studio, owner);
  expect((await on(owner, (client) => handOver(client, { to: studio.replicaId }))).success).toBe(
    true
  );
  await syncCopies(fixture.tmp, studio, owner);
  expect((await on(studio, confirmOwner)).success).toBe(true);
  return { owner, studio, erin, near, former };
}
it.each(['removed', 'cut'])(
  'a known %s historical caller stays blocked; the former owner still catches up',
  async (kind) => {
    const { studio, erin, near, former } = await moved();
    expect(
      (
        await on(studio, (client) =>
          kind === 'removed'
            ? removeMember(client, 'Erin')
            : setAsideReplica(client, { replicaId: erin.replicaId, dryRun: false })
        )
      ).success
    ).toBe(true);
    const before = await snapshot(studio, erin.replicaId);
    await wire(
      studio,
      async () => near,
      async (peer) => {
        await peer.hello();
        expect(await peer.call('changesSince', { marks: {}, catchUp: true })).toEqual([]);
      }
    );
    const after = await snapshot(studio, erin.replicaId);
    if (kind === 'removed') {
      expect(after.rows).toEqual(before.rows);
      expect(after.members).toEqual(before.members);
      expect(after.report).toEqual({ libraryVersion: near.libraryVersion, reads: near.reads });
      expect(after.peer).toEqual({
        success: true,
        data: {
          replica_id: erin.replicaId,
          name: null,
          route: null,
          marks: null,
          digest: null,
          last_ok_at: null,
          last_error: null,
          last_error_at: null,
          failures: 0,
          failing_since: null,
          removed_at: null,
          ...before.peer.data,
          library_version: near.libraryVersion,
          reads: near.reads,
          last_call_at: expect.any(String),
        },
      });
    } else expect(after).toEqual(before);
    await wire(
      studio,
      async () => former,
      async (peer) => {
        await peer.hello();
        const rows = (await peer.call('changesSince', {
          marks: {},
          catchUp: true,
        })) as LoggedChange[];
        expect(rows.some((row) => row.kind === 'authority' && row.protocol_version === 2)).toBe(
          true
        );
      }
    );
  }
);

it('a copy that is not current authority cannot grant unknown historical catch-up capacity', async () => {
  const { owner, studio, near } = await moved();
  const before = await on(owner, hello);
  expect(before.authority).toBe(studio.replicaId);
  await wire(
    owner,
    async () => ({ ...near, replicaId: 'unproved-copy' }),
    async (peer) => {
      await peer.hello();
      await expect(
        peer.call('changesSince', {
          marks: {},
          catchUp: true,
        })
      ).rejects.toThrow(/Upgrade Reasonbook here/);
    }
  );
});
