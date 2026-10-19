// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (ADR s96 §7, §8) — a copy's routes are its own: a joined copy keeps none the owner's file brought, a
// ABOUTME: member's copy follows only the owner's, a removal drops them, and one that reaches a successor moves to it.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import {
  inviteMember,
  isMembersCopy,
  removeMember,
} from '../../../src/tools/rbook/record-membership';
import { handOverRoute } from '../../../src/tools/rbook/record-move-routes';
import { confirmOwner } from '../../../src/tools/rbook/record-moves';
import {
  forgetPeers,
  peerHealth,
  recordExchanged,
  rememberPeer,
} from '../../../src/tools/rbook/record-peers';
import { exchangeText } from '../../../src/cli/sync-moves';
import { joinRoute, syncAndRoute, syncPeers } from '../../../src/tools/rbook/record-sync';
import {
  __resetSharedSyncScheduler,
  __sharedSyncTargets,
} from '../../../src/tools/rbook/record-sync-scheduler';
import { syncsOnItsOwn } from '../../../src/tools/rbook/record-sync-trigger';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { backUp, onCopy, ownerCopy, read, type Copy } from '../../helpers/shared-copies';
import { routeTo, standinSsh } from '../../helpers/standin-ssh';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-routes-');
});
afterEach(() => fixture.restore());

const configOf = (machine: string) => path.join(fixture.tmp, `config-${machine}`);

/** A consistent copy of `from`'s store in a new folder, to carry to another machine. */
function zipOf(from: Copy, name: string): string {
  const root = path.join(fixture.tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const source = new Database(dbOf(from.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  return root;
}

const opener =
  (copy: Pick<Copy, 'root' | 'machine'>, check = true) =>
  (step: Parameters<typeof onCopy>[2]) =>
    onCopy(fixture.tmp, copy, step, check ? {} : { replicaCheck: false });

/** The owner's copy and, joined over SSH from it, a member's copy on each named machine. */
async function owned(members: ReadonlyArray<readonly [string, string]>) {
  const owner = await ownerCopy(fixture.tmp);
  const { ssh } = standinSsh(path.join(fixture.tmp, 'bin'));
  const joined: Record<string, Copy> = {};
  for (const [folder, name] of members) {
    await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name }));
    const root = zipOf(owner, folder);
    useMachine(fixture.tmp, `machine-${folder}`);
    writeUserAuthor(name);
    const route = routeTo(root, configOf(`machine-${folder}`), folder);
    const done = await joinRoute(opener(owner) as never, route, name, { ssh });
    if (!done.success) throw new Error(JSON.stringify(done.error));
    joined[folder] = {
      name: folder,
      root,
      machine: `machine-${folder}`,
      replicaId: done.data!.joined.replicaId,
      block: done.data!.joined.block,
    };
  }
  return { owner, joined, ssh };
}

const routed = (copy: Copy) =>
  onCopy(fixture.tmp, copy, (client) => peerHealth(client).filter((peer) => peer.route), {
    replicaCheck: false,
  });

async function decide(copy: Copy, content: string) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call('rbook_decisions', {
    action: 'record',
    content,
    projectRoot: copy.root,
  });
  if (!answer.success) throw new Error(JSON.stringify(answer.error));
}

describe("a copy's routes are its own", () => {
  it("a copy joined from the owner's file keeps none of the owner's routes, so it never syncs with another member", async () => {
    // Erin's copy is a zip of the owner's store made after the studio joined: it brings that route.
    const { owner, joined } = await owned([
      ['studio', 'Darryl'],
      ['erin', 'Erin'],
    ]);
    expect((await routed(owner)).map((peer) => peer.replicaId).sort()).toEqual(
      [joined.studio.replicaId, joined.erin.replicaId].sort()
    );
    expect(await routed(joined.erin)).toEqual([]);
    expect(syncsOnItsOwn(dbOf(joined.erin.root))).toBe(false);
    useMachine(fixture.tmp, joined.erin.machine);
    const synced = await syncPeers(opener(joined.erin) as never, {
      unchecked: opener(joined.erin, false) as never,
    });
    expect(synced.error?.message).toMatch(/no route to the owner's copy/);
  }, 360000);

  it('removing a member drops the routes to its copies, and after a re-add the route the answer names syncs again', async () => {
    const { owner, joined, ssh } = await owned([['studio', 'Darryl']]);
    await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Darryl'));
    expect(await routed(owner)).toEqual([]);
    // Kept, the route would start a sync on every hook and timer tick that could reach no one.
    expect(syncsOnItsOwn(dbOf(owner.root))).toBe(false);
    const readded = await onCopy(fixture.tmp, owner, (client) =>
      inviteMember(client, { name: 'Darryl' })
    );
    expect(readded.data?.accepted).toBeDefined();
    useMachine(fixture.tmp, owner.machine);
    const unrouted = await syncPeers(opener(owner) as never, {
      ssh,
      unchecked: opener(owner, false) as never,
    });
    expect(unrouted.error).toMatchObject({
      message: expect.stringMatching(/No member of this shared record has a route/),
      // A join of the copy is refused, as a live copy: the remedy for a joined member is the route.
      suggestion: expect.stringMatching(
        /for a member who has joined, set its route with reasonbook sync --ssh/
      ),
    });
    // The re-add answer's remedy: one sync over the route sets it, and the timer takes it up again.
    const route = routeTo(joined.studio.root, configOf(joined.studio.machine), 'studio');
    const resumed = await syncAndRoute(opener(owner) as never, route, {
      ssh,
      unchecked: opener(owner, false) as never,
    });
    expect(resumed.success).toBe(true);
    expect(resumed.data?.remote.replicaId).toBe(joined.studio.replicaId);
    // Named for its member, as the join named it, so the review says whose copy it is.
    expect((await routed(owner)).map((peer) => [peer.replicaId, peer.name])).toEqual([
      [joined.studio.replicaId, 'Darryl'],
    ]);
    expect(syncsOnItsOwn(dbOf(owner.root))).toBe(true);
  }, 240000);

  // s97-m14 (critics, round 1): the removal belongs to the member's copy. The owner's own sync with
  // that copy said "This copy's member was removed" on the owner's copy, and the member's note of
  // the exchange erased the member's own record of its removal.
  it("an owner's sync with a removed member's copy names that copy, and leaves its own note of the removal", async () => {
    const { owner, joined } = await owned([['studio', 'Darryl']]);
    const { ssh } = standinSsh(path.join(fixture.tmp, 'bin'));
    // The member's copy was told of its removal at an earlier sync of its own.
    const noted = await onCopy(
      fixture.tmp,
      joined.studio,
      (client) => {
        recordExchanged(client, owner.replicaId, { marks: {}, removed: true });
        return peerHealth(client).find((peer) => peer.replicaId === owner.replicaId)!.removedAt;
      },
      { replicaCheck: false }
    );
    expect(noted).toEqual(expect.any(String));
    await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Darryl'));
    useMachine(fixture.tmp, owner.machine);
    const route = routeTo(joined.studio.root, configOf(joined.studio.machine), 'studio');
    const synced = await syncAndRoute(opener(owner) as never, route, {
      ssh,
      unchecked: opener(owner, false) as never,
    });
    expect(synced.success).toBe(true);
    expect(synced.data).toMatchObject({ removed: true, removedCopy: 'remote' });
    expect(exchangeText(synced.data!)).toMatch(/^That copy's member was removed from the project/);
    const removedAt = (copy: Copy, of: string) =>
      read<{ removed_at: string | null }>(
        copy,
        'SELECT removed_at FROM record_peers WHERE replica_id = ?',
        [of]
      )[0]?.removed_at ?? null;
    expect({
      memberKeeps: removedAt(joined.studio, owner.replicaId),
      ownerNotes: removedAt(owner, joined.studio.replicaId),
    }).toEqual({ memberKeeps: noted, ownerNotes: null });

    // The member's own sync at the terminal exits 0, as the removal is a state the owner can undo,
    // says what is set aside, and keeps when the copy was first told.
    const toOwner = routeTo(owner.root, configOf(owner.machine), 'air');
    let stdout = '';
    const stderr: string[] = [];
    const path0 = process.env.PATH;
    process.env.PATH = `${path.dirname(ssh)}:${path0 ?? ''}`;
    useMachine(fixture.tmp, joined.studio.machine);
    try {
      const code = await runCli(
        [
          'sync',
          '--ssh',
          'air',
          '--remote-root',
          toOwner.root,
          '--node',
          toOwner.node!,
          '--bin',
          toOwner.bin!,
          '--config-dir',
          toOwner.configDir!,
          '--project-root',
          joined.studio.root,
        ],
        {
          env: { ...process.env },
          cwd: fixture.tmp,
          readStdin: async () => '',
          stdout: (text) => {
            stdout += text;
          },
          stderr: (line) => {
            stderr.push(line);
          },
        }
      );
      expect({ code, stderr }).toEqual({ code: 0, stderr: [] });
    } finally {
      process.env.PATH = path0;
    }
    expect(stdout).toMatch(/This copy's member was removed from the project/);
    expect(removedAt(joined.studio, owner.replicaId)).toBe(noted);
  }, 240000);

  it('a route that reaches the successor its copy took moves to it, and the old identity is forgotten', async () => {
    const { owner, joined, ssh } = await owned([['studio', 'Darryl']]);
    const studio = joined.studio;
    const restore = await backUp(fixture.tmp, studio);
    await decide(studio, 'Lost with the folder.');
    restore();
    useMachine(fixture.tmp, owner.machine);
    const synced = await syncPeers(opener(owner) as never, {
      ssh,
      unchecked: opener(owner, false) as never,
    });
    expect(synced.success).toBe(true);
    const [outcome] = synced.data!.peers;
    expect(outcome.report?.reidentified?.from).toBe(studio.replicaId);
    const peers = await onCopy(fixture.tmp, owner, (client) => peerHealth(client));
    expect(peers.map((peer) => [peer.replicaId, Boolean(peer.route)])).toEqual([
      [outcome.report!.reidentified!.to, true],
    ]);
  }, 360000);

  it('reasonbook sync --ssh syncs with the copy there and remembers that route for it, as when its machine moved', async () => {
    const { owner, joined, ssh } = await owned([['studio', 'Darryl']]);
    const before = routeTo(joined.studio.root, configOf(joined.studio.machine), 'studio');
    let stdout = '';
    const stderr: string[] = [];
    const io: CliIo = {
      env: { ...process.env, PATH: `${path.dirname(ssh)}:${process.env.PATH ?? ''}` },
      cwd: fixture.tmp,
      readStdin: async () => '',
      stdout: (text) => {
        stdout += text;
      },
      stderr: (line) => {
        stderr.push(line);
      },
    };
    const path0 = process.env.PATH;
    process.env.PATH = `${path.dirname(ssh)}:${path0 ?? ''}`;
    useMachine(fixture.tmp, owner.machine);
    try {
      const code = await runCli(
        [
          'sync',
          '--ssh',
          'studio-moved',
          '--remote-root',
          before.root,
          '--node',
          before.node!,
          '--bin',
          before.bin!,
          '--config-dir',
          before.configDir!,
          '--project-root',
          owner.root,
        ],
        io
      );
      expect({ code, stderr }).toEqual({ code: 0, stderr: [] });
    } finally {
      process.env.PATH = path0;
    }
    expect(stdout).toMatch(/studio-moved:/);
    expect(
      (await routed(owner)).map((peer) => [
        peer.replicaId,
        peer.route && 'host' in peer.route ? peer.route.host : undefined,
      ])
    ).toEqual([[joined.studio.replicaId, 'studio-moved']]);
  }, 360000);
});

describe('a copy that cannot be reached', () => {
  it('shows when it last synced, what it lacks and the error, and a sync where no copy could be reached fails', async () => {
    const { owner, joined, ssh } = await owned([['studio', 'Darryl']]);
    await decide(owner, 'Written while the studio is away.');
    // The studio's machine is gone: its folder no longer holds a store.
    fs.rmSync(joined.studio.root, { recursive: true, force: true });
    useMachine(fixture.tmp, owner.machine);
    const synced = await syncPeers(opener(owner) as never, {
      ssh,
      unchecked: opener(owner, false) as never,
    });
    // s97-m10: the one copy this sync tried answers its own refusal, with its own remedy.
    expect(synced.error).toMatchObject({
      code: 'RECORD_EXCHANGE_REFUSED',
      message: expect.stringMatching(/^studio could not be reached: /),
      suggestion: expect.stringMatching(/Remote Login/),
    });
    const [peer] = await onCopy(fixture.tmp, owner, (client) => peerHealth(client));
    expect(peer).toMatchObject({
      replicaId: joined.studio.replicaId,
      lastOkAt: expect.any(String),
      lastError: expect.any(String),
    });
    expect(peer.pending).toBeGreaterThan(0);
    const status = await call('rbook_status', { projectRoot: owner.root });
    expect(status.data).toMatchObject({
      shared_sync: [
        {
          peer: 'Darryl',
          last_synced_at: peer.lastOkAt,
          pending: peer.pending,
          last_error: peer.lastError,
        },
      ],
    });
  }, 360000);
});

describe('a former owner copy', () => {
  it("syncs only with the owner's copy after a handover, though it keeps its routes to the members", async () => {
    const { owner, joined, ssh } = await owned([
      ['next', 'Owner'],
      ['studio', 'Darryl'],
    ]);
    const log = path.join(path.dirname(ssh), 'ssh.log');
    useMachine(fixture.tmp, owner.machine);
    const moved = await handOverRoute(
      opener(owner) as never,
      routeTo(joined.next.root, configOf(joined.next.machine), 'next'),
      { ssh, unchecked: opener(owner, false) as never }
    );
    expect(moved.success).toBe(true);
    // The old owner copy still remembers the studio's route, but is a member now.
    expect((await routed(owner)).map((peer) => peer.replicaId)).toContain(joined.studio.replicaId);
    const before = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const synced = await syncPeers(opener(owner) as never, {
      ssh,
      unchecked: opener(owner, false) as never,
    });
    expect(synced.data?.peers.map((peer) => peer.replicaId)).toEqual([joined.next.replicaId]);
    const reached = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(before.length);
    expect(reached).toEqual(['next']);
    // Its health shows the copy it syncs with, not the members' rows it keeps.
    useMachine(fixture.tmp, owner.machine);
    const status = await call('rbook_status', { projectRoot: owner.root });
    expect((status.data as { shared_sync: Array<{ peer: string }> }).shared_sync).toEqual([
      expect.objectContaining({ peer: "the owner's copy" }),
    ]);
  }, 360000);
});

describe('a restored copy behind a move (s96-m13 critics, round 3)', () => {
  it("the new owner copy's sync over SSH brings it up to the move, and once it confirms the next sync re-identifies it", async () => {
    const { owner, joined, ssh } = await owned([
      ['next', 'Owner'],
      ['studio', 'Darryl'],
    ]);
    const { next, studio } = joined;
    // The studio's folder is replaced by an older copy of itself: its copy check refuses its writes.
    const restore = await backUp(fixture.tmp, studio);
    await decide(studio, 'Lost with the folder.');
    restore();
    useMachine(fixture.tmp, owner.machine);
    const moved = await handOverRoute(
      opener(owner) as never,
      routeTo(next.root, configOf(next.machine), 'next'),
      { ssh, unchecked: opener(owner, false) as never }
    );
    expect(moved.success).toBe(true);
    // The far end takes the catch-up, which writes none of the copy's own changes.
    const sync = () => {
      useMachine(fixture.tmp, next.machine);
      return syncPeers(opener(next) as never, { ssh, unchecked: opener(next, false) as never });
    };
    const caught = await sync();
    expect(caught.data?.peers).toEqual([
      expect.objectContaining({
        replicaId: studio.replicaId,
        report: expect.objectContaining({
          caughtUp: { copy: 'remote', epoch: 2, authority: next.replicaId },
        }),
      }),
    ]);
    const confirmed = await onCopy(fixture.tmp, studio, (client) => confirmOwner(client), {
      replicaCheck: false,
    });
    expect(confirmed.data).toMatchObject({ authority: next.replicaId, isAuthority: false });
    const [back] = (await sync()).data!.peers;
    expect(back.report?.reidentified).toMatchObject({ from: studio.replicaId, reason: 'restored' });
    expect(back.replicaId).toBe(back.report!.reidentified!.to);
  }, 360000);

  it('an SSH handover to a copy its own check refuses is refused before the move is written, and goes through once it re-identifies', async () => {
    const { owner, joined, ssh } = await owned([['next', 'Owner']]);
    const { next } = joined;
    const restore = await backUp(fixture.tmp, next);
    await decide(next, 'Lost with the folder.');
    restore();
    const handover = () => {
      useMachine(fixture.tmp, owner.machine);
      return handOverRoute(
        opener(owner) as never,
        routeTo(next.root, configOf(next.machine), 'next'),
        { ssh, unchecked: opener(owner, false) as never }
      );
    };
    const refused = await handover();
    expect(refused.error).toMatchObject({
      message: expect.stringMatching(/REPLICA_RESTORED\), so it cannot take the owner's copy/),
      // The far copy's own remedy, quoted: whatever its check refuses, its own words say what to do.
      suggestion: expect.stringMatching(/Its own check says: Sync the copy so it re-identifies/),
    });
    // Written first, the move would have left this copy a member and the next one unable to confirm.
    expect(await onCopy(fixture.tmp, owner, (client) => isMembersCopy(client))).toBe(false);
    // The remedy: a sync re-identifies the copy, and the handover then reaches its new identity.
    const synced = await syncPeers(opener(owner) as never, {
      ssh,
      unchecked: opener(owner, false) as never,
    });
    const successor = synced.data!.peers[0].report!.reidentified!.to;
    const moved = await handover();
    expect(moved.data?.handover).toMatchObject({ to: successor });
    expect(await onCopy(fixture.tmp, owner, (client) => isMembersCopy(client))).toBe(true);
  }, 360000);
});

describe('copies that are not this one (s96-m13 critics, round 2)', () => {
  const withStandin = async <T>(ssh: string, run: () => Promise<T>): Promise<T> => {
    const before = process.env.PATH;
    process.env.PATH = `${path.dirname(ssh)}:${before ?? ''}`;
    try {
      return await run();
    } finally {
      process.env.PATH = before;
    }
  };

  it('reasonbook copy leaves out the routes and health it was made with, and a carried or second copy syncs with no one', async () => {
    const { owner, joined, ssh } = await owned([['studio', 'Darryl']]);
    const log = path.join(path.dirname(ssh), 'ssh.log');
    const io: CliIo = {
      env: process.env,
      cwd: fixture.tmp,
      readStdin: async () => '',
      stdout: () => undefined,
      stderr: () => undefined,
    };
    useMachine(fixture.tmp, owner.machine);
    const made = path.join(fixture.tmp, 'carried');
    expect(await runCli(['copy', '--to', made, '--project-root', owner.root], io)).toBe(0);
    const carried = {
      name: 'carried',
      root: made,
      machine: 'machine-carried',
      replicaId: owner.replicaId,
      block: 0,
    };
    expect(await routed(carried)).toEqual([]);
    // A copy carried by other means keeps them: it still syncs with no copy until it joins.
    const zipped = zipOf(owner, 'zipped');
    const zip = {
      name: 'zipped',
      root: zipped,
      machine: 'machine-zipped',
      replicaId: owner.replicaId,
      block: 0,
    };
    expect((await routed(zip)).length).toBe(1);
    useMachine(fixture.tmp, zip.machine);
    const before = fs.readFileSync(log, 'utf8');
    const synced = await syncPeers(opener(zip) as never, {
      ssh,
      unchecked: opener(zip, false) as never,
    });
    // The copy check's own refusal, at a sync over the routes and at one over a route given.
    expect(synced.error).toMatchObject({
      code: 'REPLICA_NOT_JOINED',
      message: expect.stringMatching(/has not joined on this machine/),
    });
    const toOwner = routeTo(owner.root, configOf(owner.machine), 'owner');
    expect(
      (
        await syncAndRoute(opener(zip) as never, toOwner, {
          ssh,
          unchecked: opener(zip, false) as never,
        })
      ).error?.code
    ).toBe('REPLICA_NOT_JOINED');
    // A second copy on the studio's machine, which holds a live one: it names the copy to work in.
    const second = {
      ...zip,
      name: 'second',
      root: zipOf(owner, 'second'),
      machine: joined.studio.machine,
    };
    useMachine(fixture.tmp, second.machine);
    for (const attempt of [
      syncPeers(opener(second) as never, { ssh, unchecked: opener(second, false) as never }),
      syncAndRoute(opener(second) as never, toOwner, {
        ssh,
        unchecked: opener(second, false) as never,
      }),
    ])
      expect((await attempt).error).toMatchObject({
        code: 'REPLICA_SECOND_COPY',
        suggestion: expect.stringMatching(
          /Work in the copy at .*, or archive one of the two copies/
        ),
      });
    expect(fs.readFileSync(log, 'utf8')).toBe(before);
    const studioPeers = await onCopy(fixture.tmp, joined.studio, (client) => peerHealth(client), {
      replicaCheck: false,
    });
    expect(studioPeers.every((peer) => peer.lastError === null)).toBe(true);
  }, 360000);

  it("a route that reaches another member's copy stays as it was, and says so", async () => {
    const { owner, joined, ssh } = await owned([
      ['studio', 'Darryl'],
      ['erin', 'Erin'],
    ]);
    // The studio's route now names the folder Erin's copy is in, as a moved machine might.
    await onCopy(fixture.tmp, owner, (client) => forgetPeers(client, [joined.studio.replicaId]));
    await onCopy(fixture.tmp, owner, (client) =>
      rememberPeer(client, joined.studio.replicaId, {
        name: 'Darryl',
        route: routeTo(joined.erin.root, configOf(joined.erin.machine), 'erin'),
      })
    );
    useMachine(fixture.tmp, owner.machine);
    const synced = await syncPeers(opener(owner) as never, {
      ssh,
      unchecked: opener(owner, false) as never,
    });
    expect(synced.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Darryl's route reached another copy/)])
    );
    const peers = await onCopy(fixture.tmp, owner, (client) => peerHealth(client));
    const studio = peers.find((peer) => peer.replicaId === joined.studio.replicaId);
    expect(studio).toMatchObject({
      route: { host: 'erin' },
      lastError: expect.stringMatching(/its route reached another copy/),
    });
    expect(peers.find((peer) => peer.replicaId === joined.erin.replicaId)?.name).toBe('Erin');
  }, 360000);

  it("join, sync and remove work through the tool dispatch, and the owner's timer takes the project up", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const { ssh } = standinSsh(path.join(fixture.tmp, 'bin'));
    useMachine(fixture.tmp, owner.machine);
    expect(
      (await call('rbook_project', { action: 'invite', name: 'Darryl', projectRoot: owner.root }))
        .success
    ).toBe(true);
    const root = zipOf(owner, 'studio');
    useMachine(fixture.tmp, 'machine-studio');
    writeUserAuthor('Darryl');
    const route = routeTo(root, configOf('machine-studio'), 'studio');
    __resetSharedSyncScheduler();
    try {
      useMachine(fixture.tmp, owner.machine);
      const joinedAnswer = await withStandin(ssh, () =>
        call('rbook_project', {
          action: 'join',
          member: 'Darryl',
          host: route.host,
          remoteRoot: route.root,
          remoteNode: route.node,
          remoteBin: route.bin,
          remoteConfigDir: route.configDir,
          projectRoot: owner.root,
        })
      );
      expect(joinedAnswer.success).toBe(true);
      expect(__sharedSyncTargets()).toEqual([owner.root]);
      await decide(owner, 'Written for the next sync.');
      useMachine(fixture.tmp, owner.machine);
      const synced = await withStandin(ssh, () =>
        call('rbook_project', { action: 'sync', projectRoot: owner.root })
      );
      expect(synced.success).toBe(true);
      expect(
        read(
          { root } as Copy,
          "SELECT id FROM strategic_decisions WHERE decision_text = 'Written for the next sync.'"
        )
      ).toHaveLength(1);
      useMachine(fixture.tmp, owner.machine);
      const removed = await call('rbook_project', {
        action: 'remove',
        name: 'Darryl',
        projectRoot: owner.root,
      });
      expect(removed.success).toBe(true);
      expect(await routed(owner)).toEqual([]);
    } finally {
      __resetSharedSyncScheduler();
    }
  }, 360000);
});
