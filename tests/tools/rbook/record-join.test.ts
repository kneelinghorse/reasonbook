// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (ADR s96 §8, §9) — an invite, then a post-share zip joins by two bundle carries or one SSH command run
// ABOUTME: from the owner's copy, named by its invite; reused answers, pre-share zips and second copies are refused.
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { clientPeer, exchange } from '../../../src/tools/rbook/record-exchange';
import {
  answerJoin,
  applyJoin,
  requestJoin,
  type JoinAnswer,
  type JoinRequest,
} from '../../../src/tools/rbook/record-join';
import { inviteMember, listMembers } from '../../../src/tools/rbook/record-membership';
import { peerHealth, rememberPeer } from '../../../src/tools/rbook/record-peers';
import { isMembersStore, readUploadProject } from '../../../src/tools/rbook/dashboard-upload';
import { joinRoute, syncPeers } from '../../../src/tools/rbook/record-sync';
import { syncsOnItsOwn } from '../../../src/tools/rbook/record-sync-trigger';
import { readReplicaIdentity } from '../../../src/tools/rbook/replica-identity';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore } from '../../helpers/seedRbookDb';
import { onCopy, ownerCopy, read, recordedState, type Copy } from '../../helpers/shared-copies';
import { farEndsExited, routeTo, standinSsh } from '../../helpers/standin-ssh';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-join-');
});
afterEach(async () => {
  await farEndsExited(fixture.tmp);
  fixture.restore();
});

async function ok(
  copy: Pick<Copy, 'root' | 'machine' | 'name'>,
  tool: string,
  args: Record<string, unknown>
) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const configOf = (machine: string): string => path.join(fixture.tmp, `config-${machine}`);

/** A zip of a copy, unpacked in a folder on another machine: the file as it was, identity and all. */
async function zipOf(
  from: Pick<Copy, 'root' | 'machine'>,
  name: string,
  machine = 'machine-studio'
) {
  const root = path.join(fixture.tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const source = new Database(dbOf(from.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  return { name, root, machine };
}

async function invite(owner: Copy, name: string) {
  return onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name }));
}

/** The two bundle carries, run here: the zip asks, the owner answers, the zip applies the answer. */
async function joinByBundle(owner: Copy, zip: { root: string; machine: string }, member: string) {
  useMachine(fixture.tmp, zip.machine);
  writeUserAuthor('darryl-default');
  const request = await onCopy(fixture.tmp, zip, (client) => requestJoin(client), {
    replicaCheck: false,
  });
  if (!request.success) throw new Error(JSON.stringify(request.error));
  const answer = await onCopy(fixture.tmp, owner, (client) =>
    answerJoin(client, JSON.parse(JSON.stringify(request.data)) as JoinRequest, member)
  );
  if (!answer.success) throw new Error(JSON.stringify(answer.error));
  const text = JSON.stringify(answer.data);
  const applied = await onCopy(
    fixture.tmp,
    zip,
    (client) => applyJoin(client, JSON.parse(text) as JoinAnswer),
    { replicaCheck: false }
  );
  return { request: request.data!, answer: answer.data!, text, applied };
}

describe('an invite', () => {
  it("only the owner's copy invites; the read-only role is refused; a second invite answers with the member", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const first = await invite(owner, 'Darryl');
    expect(first.data).toMatchObject({ name: 'Darryl', role: 'editor', invited: true });
    expect((await invite(owner, 'Darryl')).data).toMatchObject({
      memberId: first.data!.memberId,
      invited: false,
    });
    const readOnly = await onCopy(fixture.tmp, owner, (client) =>
      inviteMember(client, { name: 'Erin', role: 'read-only' })
    );
    expect(readOnly.error).toMatchObject({
      code: 'RECORD_WRITE_REFUSED',
      suggestion: expect.stringMatching(/as an editor/),
    });
    expect(
      (await onCopy(fixture.tmp, owner, (client) => listMembers(client))).map((m) => [
        m.name,
        m.role,
      ])
    ).toEqual([
      ['Owner', 'owner'],
      ['Darryl', 'editor'],
    ]);
  }, 120000);
});

describe('a join by bundle', () => {
  it('a post-share zip joins in a fresh block, under the name the invite gave, and then syncs', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await ok(owner, 'rbook_decisions', { action: 'record', content: 'Before the join.' });
    await invite(owner, 'Darryl');
    const zip = await zipOf(owner, 'studio');
    const { applied } = await joinByBundle(owner, zip, 'Darryl');
    expect(applied.data).toMatchObject({ block: 1, member: 'Darryl' });
    const identity = await onCopy(fixture.tmp, zip, (client) =>
      readReplicaIdentity(client, { fresh: true })
    );
    expect(identity).toMatchObject({ block: 1 });
    expect(identity!.replicaId).not.toBe(owner.replicaId);
    // Joined, it writes through the copy check, as Darryl, numbered in its block.
    const made = await ok({ ...zip, name: 'studio' }, 'rbook_decisions', {
      action: 'record',
      content: 'Written on the Studio.',
    });
    expect(made.data!.decisionId).toBeGreaterThan(1_000_000);
    expect(
      read(zip, 'SELECT author_name FROM strategic_decisions WHERE id = ?', [made.data!.decisionId])
    ).toEqual([{ author_name: 'Darryl' }]);
    const member: Copy = { ...zip, replicaId: identity!.replicaId, block: 1 };
    const synced = await exchange(
      clientPeer('studio', (step) => onCopy(fixture.tmp, member, step)),
      clientPeer('owner', (step) => onCopy(fixture.tmp, owner, step))
    );
    expect(synced.success).toBe(true);
    expect(
      read(
        owner,
        "SELECT author_name FROM strategic_decisions WHERE decision_text = 'Written on the Studio.'"
      )
    ).toEqual([{ author_name: 'Darryl' }]);
    expect(
      (await onCopy(fixture.tmp, owner, (client) => listMembers(client))).find(
        (m) => m.name === 'Darryl'
      )?.replicas
    ).toEqual([{ replicaId: identity!.replicaId, block: 1 }]);
  }, 180000);

  it('an answer applies once, and only to the copy that asked: a join answer cannot be reused', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await invite(owner, 'Darryl');
    const zip = await zipOf(owner, 'studio');
    const { text, request } = await joinByBundle(owner, zip, 'Darryl');
    const again = await onCopy(
      fixture.tmp,
      zip,
      (client) => applyJoin(client, JSON.parse(text) as JoinAnswer),
      {
        replicaCheck: false,
      }
    );
    expect(again.error?.message).toMatch(/a join answer cannot be reused/);
    const other = await zipOf(owner, 'other', 'machine-other');
    useMachine(fixture.tmp, other.machine);
    await onCopy(fixture.tmp, other, (client) => requestJoin(client), { replicaCheck: false });
    const elsewhere = await onCopy(
      fixture.tmp,
      other,
      (client) => applyJoin(client, JSON.parse(text) as JoinAnswer),
      {
        replicaCheck: false,
      }
    );
    expect(elsewhere.error?.message).toMatch(/not for this copy's join request/);
    const twice = await onCopy(fixture.tmp, owner, (client) =>
      answerJoin(client, request, 'Darryl')
    );
    expect(twice.error?.message).toMatch(/has joined already/);
  }, 180000);

  it('a zip made before sharing is sent to the import, and an uninvited member is refused', async () => {
    useMachine(fixture.tmp, 'machine-owner');
    const before = {
      name: 'before',
      root: project(fixture.tmp, 'owner'),
      machine: 'machine-owner',
    };
    const preShare = await zipOf(before, 'pre-share');
    const owner = await ownerCopy(fixture.tmp, 'owner-2');
    const refused = await onCopy(fixture.tmp, preShare, (client) => requestJoin(client), {
      replicaCheck: false,
    });
    expect(refused.error?.message).toMatch(/made before the project was shared/);
    const zip = await zipOf(owner, 'studio');
    const request = await onCopy(fixture.tmp, zip, (client) => requestJoin(client), {
      replicaCheck: false,
    });
    const uninvited = await onCopy(fixture.tmp, owner, (client) =>
      answerJoin(client, request.data!, 'Nobody')
    );
    expect(uninvited.error).toMatchObject({
      suggestion: expect.stringMatching(/Invite them first/),
    });
  }, 180000);

  it('one machine keeps one live copy: a second zip on the same machine is refused its join', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await invite(owner, 'Darryl');
    await joinByBundle(owner, await zipOf(owner, 'studio'), 'Darryl');
    const second = await zipOf(owner, 'studio-again');
    const refused = await onCopy(fixture.tmp, second, (client) => requestJoin(client), {
      replicaCheck: false,
    });
    expect(refused.error).toMatchObject({ code: 'REPLICA_SECOND_COPY' });
  }, 180000);
});

describe('a join over SSH', () => {
  it("one command from the owner's copy joins a zip and syncs, and later syncs reach it by the recorded route", async () => {
    const owner = await ownerCopy(fixture.tmp);
    await invite(owner, 'Darryl');
    const zip = await zipOf(owner, 'studio');
    useMachine(fixture.tmp, 'machine-studio');
    writeUserAuthor('darryl-default');
    const { ssh } = standinSsh(path.join(fixture.tmp, 'bin'));
    const route = routeTo(zip.root, configOf('machine-studio'));
    const open = <T>(step: (client: Parameters<Parameters<typeof onCopy>[2]>[0]) => T) =>
      onCopy(fixture.tmp, owner, step);
    const joined = await joinRoute(open, route, 'Darryl', { ssh });
    expect(joined.error).toBeUndefined();
    expect(joined.data!.joined).toMatchObject({ block: 1, member: 'Darryl' });
    const studio = { ...zip, name: 'studio' };
    await ok(studio, 'rbook_decisions', { action: 'record', content: 'After the SSH join.' });
    const synced = await syncPeers(open, { ssh });
    expect(synced.data!.peers).toEqual([
      expect.objectContaining({
        name: 'Darryl',
        report: expect.objectContaining({ sent: expect.any(Number) }),
      }),
    ]);
    expect(
      read(
        owner,
        "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'After the SSH join.'"
      )
    ).toEqual([{ n: 1 }]);
    const health = await onCopy(fixture.tmp, owner, (client) => peerHealth(client));
    expect(health).toEqual([
      expect.objectContaining({
        name: 'Darryl',
        route,
        pending: 0,
        lastError: null,
        lastOkAt: expect.any(String),
      }),
    ]);
    // The member's side recorded the owner's copy too, and it has no route back.
    const member = await onCopy(fixture.tmp, studio, (client) => peerHealth(client));
    expect(member).toEqual([
      expect.objectContaining({
        replicaId: owner.replicaId,
        route: null,
        lastOkAt: expect.any(String),
      }),
    ]);
    const noRoute = await syncPeers((step) => onCopy(fixture.tmp, studio, step), { ssh });
    expect(noRoute.error).toMatchObject({
      message: "This copy has no route to the owner's copy, so it cannot start a sync.",
      suggestion: expect.stringMatching(/carry a bundle/),
    });
  }, 300000);
});

describe('a join answer carried by hand (s96-m13 build-time critics)', () => {
  it('an answer changed after it was written is refused whole, and the joined copy keeps none of the routes its file brought', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await invite(owner, 'Darryl');
    // The owner's file remembers a route to another copy; a zip of it carries that route along.
    await onCopy(fixture.tmp, owner, (client) =>
      rememberPeer(client, 'some-other-copy', {
        name: 'Erin',
        route: { host: 'erin-laptop', root: '/erin/project' },
      })
    );
    const zip = await zipOf(owner, 'studio');
    useMachine(fixture.tmp, zip.machine);
    writeUserAuthor('darryl-default');
    const request = await onCopy(fixture.tmp, zip, (client) => requestJoin(client), {
      replicaCheck: false,
    });
    const answer = await onCopy(fixture.tmp, owner, (client) =>
      answerJoin(client, request.data!, 'Darryl')
    );
    const apply = (carried: JoinAnswer) =>
      onCopy(fixture.tmp, zip, (client) => applyJoin(client, carried), { replicaCheck: false });
    const edited = { ...answer.data!, block: answer.data!.block + 1 };
    expect((await apply(edited)).error?.message).toMatch(/does not match its content hash/);
    // Nothing of the edited answer was used: the answer as written still applies, once.
    expect((await apply(answer.data!)).success).toBe(true);
    expect(
      await onCopy(fixture.tmp, zip, (client) => peerHealth(client).map((peer) => peer.replicaId))
    ).not.toContain('some-other-copy');
  }, 180000);
});

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The real-store sync shares a copy of this repository's own store, taken from its git history; the public mirror carries neither.",
  revisions: { release: 'v4.0.2' },
});

PRIVATE.describe(
  "sharing a copy of this repository's own store (practice 4's real-store fire)",
  () => {
    it('shares it through rbook_project, joins a member over SSH, and a sync both ways leaves the record equal', async () => {
      const root = path.join(fixture.tmp, 'real-owner');
      fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
      fs.writeFileSync(
        dbOf(root),
        execFileSync('git', ['show', `${PRIVATE.revisions.release}:rbook/db/rbook.sqlite`], {
          cwd: path.resolve(__dirname, '..', '..', '..'),
          maxBuffer: 256 * 1024 * 1024,
        })
      );
      reidentifyRbookTestStore(root);
      const owner = { name: 'real-owner', root, machine: 'machine-real-owner' };
      useMachine(fixture.tmp, owner.machine);
      const shared = await call('rbook_project', {
        action: 'share',
        authorName: 'Owner',
        projectRoot: root,
      });
      expect(shared.success).toBe(true);
      useMachine(fixture.tmp, owner.machine);
      expect(
        (await call('rbook_project', { action: 'invite', name: 'Darryl', projectRoot: root }))
          .success
      ).toBe(true);
      const studio = await zipOf(owner, 'real-studio', 'machine-real-studio');
      useMachine(fixture.tmp, studio.machine);
      writeUserAuthor('Darryl');
      const { ssh } = standinSsh(path.join(fixture.tmp, 'bin'));
      const open = (copy: { root: string; machine: string }, check = true) =>
        ((step: Parameters<typeof onCopy>[2]) =>
          onCopy(fixture.tmp, copy, step, check ? {} : { replicaCheck: false })) as never;
      useMachine(fixture.tmp, owner.machine);
      const joined = await joinRoute(
        open(owner),
        routeTo(studio.root, path.join(fixture.tmp, `config-${studio.machine}`), 'real-studio'),
        'Darryl',
        { ssh }
      );
      expect(joined.success).toBe(true);
      // The features gated on what the store holds fire on the real one: the owner's copy syncs on
      // its own and uploads; the member's does neither.
      expect([syncsOnItsOwn(dbOf(owner.root)), syncsOnItsOwn(dbOf(studio.root))]).toEqual([
        true,
        false,
      ]);
      expect([
        await isMembersStore(readUploadProject(owner.root)!),
        await isMembersStore(readUploadProject(studio.root)!),
      ]).toEqual([false, true]);
      // A real decision changed on the member's copy, and a new one written on each side.
      const [decision] = read<{ id: number; status: string }>(
        owner,
        "SELECT id, status FROM strategic_decisions WHERE status = 'active' ORDER BY id DESC LIMIT 1"
      );
      for (const [copy, content] of [
        [owner, 'Written on the real owner copy.'],
        [studio, 'Written on the real studio copy.'],
      ] as const) {
        useMachine(fixture.tmp, copy.machine);
        expect(
          (await call('rbook_decisions', { action: 'record', content, projectRoot: copy.root }))
            .success
        ).toBe(true);
      }
      useMachine(fixture.tmp, studio.machine);
      expect(
        (
          await call('rbook_decisions', {
            action: 'update',
            decisionId: decision.id,
            status: 'archived',
            projectRoot: studio.root,
          })
        ).success
      ).toBe(true);
      useMachine(fixture.tmp, owner.machine);
      for (let round = 0; round < 2; round += 1) {
        const synced = await syncPeers(open(owner), { ssh, unchecked: open(owner, false) });
        expect(synced.success).toBe(true);
      }
      expect(recordedState(studio)).toEqual(recordedState(owner));
      expect(
        read(owner, 'SELECT status FROM strategic_decisions WHERE id = ?', [decision.id])
      ).toEqual([{ status: 'archived' }]);
    }, 600000);
  }
);
