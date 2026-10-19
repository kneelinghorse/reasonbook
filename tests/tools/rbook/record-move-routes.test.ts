// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (ADR s96 §8) over SSH — reasonbook handover confirms on the owner's other copy and hands it the routes;
// ABOUTME: reasonbook recover reaches each member's copy by its route, names one it cannot reach, and remembers the rest.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { inviteMember } from '../../../src/tools/rbook/record-membership';
import { handOverRoute, recoverRoutes } from '../../../src/tools/rbook/record-move-routes';
import { peerHealth } from '../../../src/tools/rbook/record-peers';
import { joinRoute, syncPeers } from '../../../src/tools/rbook/record-sync';
import {
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { onCopy, ownerCopy, recordedState, type Copy } from '../../helpers/shared-copies';
import { routeTo, standinSsh } from '../../helpers/standin-ssh';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-move-routes-');
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

async function cli(argv: string[]) {
  let stdout = '';
  const stderr: string[] = [];
  const io: CliIo = {
    env: process.env,
    cwd: fixture.tmp,
    readStdin: async () => '',
    stdout: (text) => {
      stdout += text;
    },
    stderr: (line) => {
      stderr.push(line);
    },
  };
  return { code: await runCli(argv, io), stdout, stderr };
}

/** The owner's copy with the owner's other copy and a member's joined over SSH, each on its machine. */
async function joinedOverSsh() {
  const owner = await ownerCopy(fixture.tmp);
  await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: 'Darryl' }));
  const { ssh } = standinSsh(path.join(fixture.tmp, 'bin'));
  const opener =
    (copy: Copy, check = true) =>
    (step: Parameters<typeof onCopy>[2]) =>
      onCopy(fixture.tmp, copy, step, check ? {} : { replicaCheck: false });
  const join = async (name: string, member: string, author: string) => {
    const root = zipOf(owner, name);
    useMachine(fixture.tmp, `machine-${name}`);
    writeUserAuthor(author);
    const route = routeTo(root, configOf(`machine-${name}`), name);
    const joined = await joinRoute(opener(owner) as never, route, member, { ssh });
    if (!joined.success) throw new Error(JSON.stringify(joined.error));
    return {
      copy: {
        name,
        root,
        machine: `machine-${name}`,
        replicaId: joined.data!.joined.replicaId,
        block: joined.data!.joined.block,
      },
      route,
    };
  };
  const next = await join('next', 'Owner', 'Owner');
  const studio = await join('studio', 'Darryl', 'Darryl');
  return { owner, next, studio, ssh, opener };
}

describe('reasonbook handover', () => {
  it("confirms on the owner's other copy, hands it the routes, and leaves this copy a member that syncs with it", async () => {
    const { owner, next, studio, ssh, opener } = await joinedOverSsh();
    const moved = await handOverRoute(opener(owner) as never, next.route, {
      ssh,
      unchecked: opener(owner, false) as never,
    });
    expect(moved.error).toBeUndefined();
    expect(moved.data).toMatchObject({
      handover: { epoch: 2, to: next.copy.replicaId },
      confirmed: { isAuthority: true },
    });
    const routes = await onCopy(fixture.tmp, next.copy, (client) =>
      peerHealth(client).map((peer) => [
        peer.replicaId,
        peer.route && 'host' in peer.route ? peer.route.host : null,
      ])
    );
    expect(routes).toEqual(expect.arrayContaining([[studio.copy.replicaId, 'studio']]));
    // The new owner copy reaches the member, which holds the move until it confirms.
    const first = await syncPeers(opener(next.copy) as never, { ssh });
    const caught = first.data!.peers.find((peer) => peer.replicaId === studio.copy.replicaId);
    expect(caught?.report?.caughtUp).toMatchObject({ copy: 'remote', epoch: 2 });
    useMachine(fixture.tmp, studio.copy.machine);
    const confirmed = await cli(['sync', '--confirm-owner', '--project-root', studio.copy.root]);
    expect(confirmed).toMatchObject({ code: 0, stderr: [] });
    expect(confirmed.stdout).toMatch(/Confirmed: the owner's copy is/);
    await syncPeers(opener(next.copy) as never, { ssh });
    expect(recordedState(studio.copy)).toEqual(recordedState(next.copy));
    expect(recordedState(owner)).toEqual(recordedState(next.copy));
  }, 480000);
});

describe('reasonbook recover', () => {
  it("waits for a member copy it cannot reach, naming it, then recovers from the member's copy and remembers its route", async () => {
    const { owner, next, studio, ssh } = await joinedOverSsh();
    // The owner's machine is lost; a copy of the studio's copy on a new machine recovers it.
    const root = zipOf(studio.copy, 'recovered');
    useMachine(fixture.tmp, 'machine-new');
    writeUserAuthor('Owner');
    const self = (step: Parameters<typeof onCopy>[2]) =>
      onCopy(fixture.tmp, { root, machine: 'machine-new' }, step, { replicaCheck: false });
    const gone = await recoverRoutes(
      self as never,
      [{ ...studio.route, host: 'gone', root: path.join(fixture.tmp, 'nowhere') }],
      { members: ['Darryl'] },
      { ssh }
    );
    expect(gone.error?.message).toMatch(/The recovery waits for the copy at gone/);
    // Every member copy is reached, the owner's other copy included.
    const recovered = await recoverRoutes(
      self as never,
      [studio.route, next.route],
      { members: ['Darryl'] },
      { ssh }
    );
    expect(recovered.error).toBeUndefined();
    expect(recovered.data).toMatchObject({ epoch: 2, previous: owner.replicaId });
    const health = await self((client) => peerHealth(client));
    expect(health).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ replicaId: studio.copy.replicaId, route: studio.route }),
        expect.objectContaining({ replicaId: next.copy.replicaId, route: next.route }),
      ])
    );
    const first = await syncPeers(self as never, { ssh });
    for (const peer of first.data!.peers)
      expect(peer.report?.caughtUp).toMatchObject({ copy: 'remote', epoch: 2 });
  }, 480000);
});
