// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real recovery copies distinguish capability evidence from admission and ordinary delivery.
// ABOUTME: Direct and bundled move receipts name only an actually held advertised move, including forks.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { importBundle, writeBundle } from '../../../src/tools/rbook/record-bundle';
import { localCopyReport } from '../../../src/tools/rbook/record-copy-report';
import { exchange, hello } from '../../../src/tools/rbook/record-exchange';
import { inviteMember } from '../../../src/tools/rbook/record-membership';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { reportedCopy } from '../../../src/tools/rbook/record-peer-report';
import { recoverAuthority } from '../../../src/tools/rbook/record-recovery';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import { serveSync, wirePeer, type NearHello } from '../../../src/tools/rbook/record-wire';
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
  fixture = replicaFixture('rbook-protocol-repair-');
});
afterEach(() => fixture.restore());
const on = <T>(copy: Copy, step: Parameters<typeof onCopy<T>>[2]) =>
  onCopy(fixture.tmp, copy, step, { replicaCheck: false });
function carry(from: Copy): Copy {
  const root = path.join(fixture.tmp, 'recovered');
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const source = new Database(dbOf(from.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  const machine = 'recovered';
  useMachine(fixture.tmp, machine);
  writeUserAuthor('Owner');
  return { ...from, root, machine, name: 'recovered' };
}
async function recover(from: Copy, copies: Copy[], members = ['Darryl']) {
  const recovered = carry(from);
  const result = await recoverAuthority(
    (step) => on(recovered, step),
    copies.map((copy) => copyPeer(fixture.tmp, copy)),
    { members }
  );
  expect(result.success).toBe(true);
  return { ...recovered, replicaId: result.data!.authority, block: result.data!.block };
}
async function wireHello(authority: Copy, near: NearHello) {
  const requests = new PassThrough(),
    answers = new PassThrough();
  const serving = serveSync(requests, answers, (step) => on(authority, step));
  const remote = await wirePeer(
    'authority',
    answers,
    requests,
    () => requests.end(),
    5000,
    async () => near
  );
  try {
    await remote.hello();
    return await remote.changesSince({});
  } finally {
    remote.close();
    await serving;
  }
}
async function unseen() {
  const owner = await ownerCopy(fixture.tmp);
  const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
  await syncCopies(fixture.tmp, studio, owner);
  const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
  const authority = await recover(studio, [studio]);
  expect((await syncCopies(fixture.tmp, erin, authority)).caughtUp).toBeDefined();
  expect((await on(erin, confirmOwner)).success).toBe(true);
  const waits = await exchange(copyPeer(fixture.tmp, erin), copyPeer(fixture.tmp, authority));
  expect(waits.error?.message).toMatch(/Erin was invited after the cut/);
  expect(await on(authority, (client) => mergeContext(client).unseen.has(erin.replicaId))).toBe(
    true
  );
  return { erin, authority };
}

it.each(['direct', 'SSH'])(
  'a proven unseen %s report permits re-invitation repair without ordinary stream access',
  async (transport) => {
    const { erin, authority } = await unseen();
    const near = await on(erin, hello);
    if (transport === 'direct') await copyPeer(fixture.tmp, authority).observeHello!(near);
    else expect(await wireHello(authority, near)).toEqual([]);
    expect(await on(authority, (client) => reportedCopy(client, erin.replicaId))).toEqual(
      localCopyReport()
    );
    expect(await on(authority, (client) => mergeContext(client).members.has(erin.replicaId))).toBe(
      false
    );
    expect((await on(authority, (client) => inviteMember(client, { name: 'Erin' }))).success).toBe(
      true
    );
    const repaired = await exchange(copyPeer(fixture.tmp, erin), copyPeer(fixture.tmp, authority));
    expect(repaired.data?.reidentified).toMatchObject({ reason: 'unseen', from: erin.replicaId });
  }
);

it('unknown identities and forged project/term claims cannot supply an unseen capability', async () => {
  const { erin, authority } = await unseen();
  const near = await on(erin, hello);
  const before = await on(authority, (client) => reportedCopy(client, erin.replicaId));
  for (const forged of [
    { ...near, replicaId: 'unrelated-copy' },
    { ...near, projectId: 'different-project' },
    { ...near, epoch: near.epoch + 1 },
    { ...near, authority: 'different-authority' },
  ]) {
    const report = { ...forged, reads: 99, libraryVersion: '99.0.0' };
    await copyPeer(fixture.tmp, authority).observeHello!(report);
    // An unbound forged report gets only legacy-reader treatment, never its claimed reads99.
    await expect(wireHello(authority, report)).rejects.toThrow(/Upgrade Reasonbook here/);
    expect(await on(authority, (client) => reportedCopy(client, erin.replicaId))).toEqual(before);
    expect(await on(authority, (client) => reportedCopy(client, 'unrelated-copy'))).toEqual({
      libraryVersion: null,
      reads: null,
    });
  }
});

it('a direct exchange binds the report after learning an unseen admission in that same call', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
  expect((await on(owner, (client) => inviteMember(client, { name: 'Erin' }))).success).toBe(true);
  await syncCopies(fixture.tmp, studio, owner);
  const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
  const authority = await recover(studio, [studio], ['Darryl', 'Erin']);
  expect((await syncCopies(fixture.tmp, erin, authority)).caughtUp).toBeDefined();
  expect((await on(erin, confirmOwner)).success).toBe(true);
  expect(await on(authority, (client) => mergeContext(client).unseen.has(erin.replicaId))).toBe(
    false
  );
  expect(await on(authority, (client) => reportedCopy(client, erin.replicaId))).toEqual({
    libraryVersion: null,
    reads: null,
  });
  const repaired = await exchange(copyPeer(fixture.tmp, erin), copyPeer(fixture.tmp, authority));
  expect(repaired.success).toBe(true);
  expect(repaired.data?.reidentified).toMatchObject({ reason: 'unseen', from: erin.replicaId });
  expect(await on(authority, (client) => reportedCopy(client, erin.replicaId))).toEqual(
    localCopyReport()
  );
});

async function fork() {
  const owner = await ownerCopy(fixture.tmp);
  const next = await joinedCopy(fixture.tmp, owner, 'next', 'Owner');
  const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
  await syncCopies(fixture.tmp, next, owner);
  await syncCopies(fixture.tmp, studio, owner);
  const authority = await recover(studio, [studio, next]);
  expect((await on(owner, (client) => handOver(client, { to: next.replicaId }))).success).toBe(
    true
  );
  expect((await syncCopies(fixture.tmp, studio, owner)).caughtUp).toBeDefined();
  return { studio, authority };
}
it.each(['direct', 'bundle'])(
  'a %s receipt recognizes the advertised recovery held as a competing fork',
  async (transport) => {
    const { studio, authority } = await fork();
    const held = await on(authority, (client) => writeBundle(client, {}, localCopyReport()));
    const result =
      transport === 'direct'
        ? await exchange(copyPeer(fixture.tmp, studio), copyPeer(fixture.tmp, authority))
        : await on(studio, (client) => importBundle(client, held));
    expect(result.data?.caughtUp).toMatchObject({ epoch: 2, authority: authority.replicaId });
    expect(result.warnings?.join(' ') ?? '').not.toMatch(/not received|Upgrade that copy/);
    expect(
      await on(studio, (client) => {
        const ctx = mergeContext(client);
        return { epoch: ctx.epoch, forks: ctx.forks.length, pending: ctx.pending };
      })
    ).toEqual({ epoch: 1, forks: 2, pending: null });
  }
);

it('an empty legacy-safe bundle cannot claim its advertised move arrived', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const next = await joinedCopy(fixture.tmp, owner, 'next', 'Owner');
  const behind = await joinedCopy(fixture.tmp, owner, 'behind', 'Erin');
  const before = await on(behind, hello);
  expect((await on(owner, (client) => handOver(client, { to: next.replicaId }))).success).toBe(
    true
  );
  const bundle = await on(owner, (client) => writeBundle(client, before.marks));
  expect(bundle.changes).toEqual([]);
  const result = await on(behind, (client) => importBundle(client, bundle));
  expect(result.success).toBe(true);
  expect(result.data?.caughtUp).toBeUndefined();
  expect((await on(behind, hello)).epoch).toBe(before.epoch);
  expect((await on(behind, hello)).pending).toBeNull();
});

it('an older hello without fork evidence cannot claim a held fork arrived', async () => {
  const { studio, authority } = await fork();
  const real = copyPeer(fixture.tmp, studio);
  const old = {
    ...real,
    hello: async () => {
      const { forks: _forks, ...legacy } = await real.hello();
      return legacy;
    },
  };
  const result = await exchange(old, copyPeer(fixture.tmp, authority));
  expect(result.success).toBe(true);
  expect(result.data?.caughtUp).toBeUndefined();
  expect(await on(studio, (client) => mergeContext(client).forks.length)).toBe(2);
  expect(result.warnings?.join(' ')).toMatch(/does not report holding the advertised owner's move/);
  expect(result.warnings?.join(' ')).toMatch(/Inspect.*sync again/);
  expect(result.warnings?.join(' ')).not.toMatch(/Upgrade that copy/);
});

it.each(['direct', 'bundle'])(
  'an unrelated pending move cannot prove a withheld %s move arrived',
  async (transport) => {
    const { studio, authority } = await fork();
    const before = await on(studio, hello);
    expect(before.pending?.authority).not.toBe(authority.replicaId);
    const real = copyPeer(fixture.tmp, studio);
    const old = { ...real, hello: async () => ({ ...(await real.hello()), reads: 1 }) };
    const held = await on(authority, (client) => writeBundle(client, before.marks));
    expect(held.changes.some((change) => change.kind === 'authority')).toBe(false);
    const result =
      transport === 'direct'
        ? await exchange(old, copyPeer(fixture.tmp, authority))
        : await on(studio, (client) => importBundle(client, held));
    expect(result.success).toBe(transport !== 'direct');
    expect(result.data?.caughtUp).toBeUndefined();
    expect((await on(studio, hello)).pending).toEqual(before.pending);
    if (transport === 'direct')
      expect(result.error?.message).toMatch(/Upgrade Reasonbook.*withheld/);
  }
);
