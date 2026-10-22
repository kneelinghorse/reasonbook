// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 — the shared record's refusals no fuller flow reaches: files that are not bundles or join steps, copies
// ABOUTME: that cannot pair, steps off the owner's copy, a far end that dies mid-exchange; each names its remedy.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { decideTransactions } from '../../../src/tools/rbook/record-apply';
import { importBundle, readBundle, writeBundle } from '../../../src/tools/rbook/record-bundle';
import {
  clashRefusal,
  exchange,
  type Hello,
  type Peer,
} from '../../../src/tools/rbook/record-exchange';
import { settleBlocks } from '../../../src/tools/rbook/record-exchange-steps';
import {
  answerJoin,
  applyJoin,
  requestJoin,
  type JoinAnswer,
  type JoinRequest,
} from '../../../src/tools/rbook/record-join';
import { removeMember } from '../../../src/tools/rbook/record-membership';
import { admitSuccessor } from '../../../src/tools/rbook/record-admit-successor';
import { settleField } from '../../../src/tools/rbook/record-settle';
import { reblockSelf, takeSuccessor } from '../../../src/tools/rbook/record-successor';
import { joinRoute, syncRoute } from '../../../src/tools/rbook/record-sync';
import { REPLICA_ERROR_CODES } from '../../../src/tools/rbook/replica-identity';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  backUp,
  copyPeer,
  joinedCopy,
  onCopy,
  ownerCopy,
  read,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';
import { farEndsExited, standinSsh } from '../../helpers/standin-ssh';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-refusals-');
});
afterEach(async () => {
  await farEndsExited(fixture.tmp);
  fixture.restore();
});

const on = <T>(copy: Pick<Copy, 'root' | 'machine'>, use: Parameters<typeof onCopy<T>>[2]) =>
  onCopy(fixture.tmp, copy, use, { replicaCheck: false });

/** A peer that says what `say` makes of its real hello, and otherwise is the copy. */
function saying(copy: Copy, say: (hello: Hello) => Hello): Peer {
  const real = copyPeer(fixture.tmp, copy);
  return { ...real, hello: async () => say(await real.hello()) };
}

describe('files that are not what they say', () => {
  it('a file that is not JSON, or JSON that is not a bundle, is refused whole', () => {
    expect(readBundle('not json at all').error).toMatchObject({
      message: expect.stringMatching(/it is not JSON/),
      suggestion: expect.stringMatching(/as written, unchanged/),
    });
    expect(readBundle('{"format":"something-else"}').error).toMatchObject({
      message: 'The file is not a Reasonbook bundle.',
    });
  });

  it('a join request or answer of the wrong kind, protocol or project is refused, and so is an answer off the owner copy', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    // A live copy is not joined again; a zip carried to another machine asks.
    expect((await on(owner, (client) => requestJoin(client))).error?.message).toMatch(
      /is a live copy of the shared record on this machine already/
    );
    const zip = { name: 'zip', root: path.join(fixture.tmp, 'zip'), machine: 'machine-zip' };
    fs.mkdirSync(path.dirname(dbOf(zip.root)), { recursive: true });
    const source = new Database(dbOf(owner.root));
    try {
      source.exec(`VACUUM INTO '${dbOf(zip.root).replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }
    useMachine(fixture.tmp, zip.machine);
    const request = (await on(zip, (client) => requestJoin(client))).data as JoinRequest;
    expect(request?.format).toBe('reasonbook-join-request');
    useMachine(fixture.tmp, owner.machine);
    const answer = (input: unknown, copy: Copy = owner) =>
      on(copy, (client) => answerJoin(client, input as JoinRequest, 'Darryl'));
    expect((await answer({ format: 'nope' })).error?.message).toBe('That is not a join request.');
    expect((await answer({ ...request, protocol: 99 })).error).toMatchObject({
      code: 'RECORD_EXCHANGE_REFUSED',
      message: expect.stringMatching(/sync protocol 99/),
    });
    expect((await answer(request, studio)).error?.message).toMatch(
      /Only the owner's copy answers a join/
    );
    expect((await answer({ ...request, projectId: 'p-other' })).error?.message).toMatch(
      /is from a copy of project p-other/
    );
    expect(
      (await on(studio, (client) => applyJoin(client, { format: 'nope' } as unknown as JoinAnswer)))
        .error?.message
    ).toBe('That is not a join answer.');
  }, 240000);
});

describe('two copies that cannot pair', () => {
  it('one replica on both sides, two owner copies for one move, and a copy ahead that is no owner copy are refused', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const same = await exchange(
      copyPeer(fixture.tmp, owner),
      saying(studio, (hello) => ({ ...hello, replicaId: owner.replicaId }))
    );
    expect(same.error?.message).toMatch(/are the same copy of the record/);
    const fork = await exchange(
      copyPeer(fixture.tmp, owner),
      saying(studio, (hello) => ({ ...hello, authority: studio.replicaId }))
    );
    expect(fork.error).toMatchObject({
      code: 'RECORD_AUTHORITY_DIFFERS',
      message: expect.stringMatching(/each name a different owner's copy for the same move/),
    });
    // The owner's copy is its own authority, so the pair passes; the copy ahead is no owner copy.
    const ahead = await exchange(
      copyPeer(fixture.tmp, owner),
      saying(studio, (hello) => ({ ...hello, epoch: 2, authority: 'someone-else' }))
    );
    expect(ahead.error?.message).toMatch(/is not the owner's copy in either view/);
  }, 240000);

  it("a slot clash on another copy's stream is named, and blocks that keep clashing stop the exchange", async () => {
    const hello = { blocks: { a: 1 } } as unknown as Hello;
    expect(
      clashRefusal({ ...hello, authority: 'owner' } as Hello, hello, ['a'], 'that copy', 'nothing')
    ).toMatchObject({ code: 'RECORD_SLOT_CLASH', message: expect.stringMatching(/block 1/) });
    const stuck = {
      replicaId: 'owner',
      block: 0,
      blocks: { owner: 3, other: 3 },
      admitted: { owner: '2', other: '1' },
    } as unknown as Hello;
    const authority = {
      hello: async () => stuck,
      reblockSelf: async () => ({ success: true as const, data: { block: 3, renumbered: 0 } }),
    } as unknown as Peer;
    const member = {
      hello: async () => ({ ...stuck, replicaId: 'member', block: 1 }),
    } as unknown as Peer;
    expect((await settleBlocks(authority, member)).error?.message).toMatch(
      /kept clashing after four moves/
    );
  });
});

describe("steps that only the owner's copy takes", () => {
  it('a member copy cannot decide, admit a successor or move its own block; an unknown or removed copy takes no successor', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
    expect(
      (await on(studio, (client) => decideTransactions(client, [], 'accepted', 'x'))).error
    ).toMatchObject({ message: "Only the owner's copy decides a transaction." });
    expect(
      (await on(studio, (client) => admitSuccessor(client, { replicaId: studio.replicaId }))).error
        ?.message
    ).toMatch(/Only the owner's copy admits/);
    expect((await on(studio, (client) => reblockSelf(client))).error?.message).toMatch(
      /Only the owner's copy moves itself/
    );
    expect(
      (await on(owner, (client) => admitSuccessor(client, { replicaId: 'nobody' }))).error?.message
    ).toMatch(/not one of a member this record knows/);
    await on(owner, (client) => removeMember(client, 'Erin'));
    expect(
      (await on(owner, (client) => admitSuccessor(client, { replicaId: erin.replicaId }))).error
        ?.message
    ).toMatch(/member was removed/);
    useMachine(fixture.tmp, 'solo');
    const solo = { root: project(fixture.tmp, 'solo'), machine: 'solo' };
    expect(
      (
        await on(solo, (client) =>
          takeSuccessor(client, {
            successor: { replicaId: 'x', block: 9, role: 'editor', member: 'm' },
            reason: 'restored',
            authorityReceived: null,
          })
        )
      ).error?.message
    ).toMatch(/not a copy of a shared record/);
  }, 240000);

  it("a member's bundle that needs a new identity is refused by the owner, who names a direct sync", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const restore = await backUp(fixture.tmp, studio);
    // A write after the backup moves this machine's mark past what the restore brings back.
    useMachine(fixture.tmp, studio.machine);
    const wrote = await call('rbook_decisions', {
      action: 'record',
      content: 'Written after the backup.',
      projectRoot: studio.root,
    });
    if (!wrote.success) throw new Error(JSON.stringify(wrote.error));
    restore();
    const bundle = await on(studio, (client) => writeBundle(client, {}));
    const refused = await on(owner, (client) => importBundle(client, bundle));
    expect(refused.error).toMatchObject({
      message: expect.stringMatching(/must take a new identity first/),
      suggestion: expect.stringMatching(/over SSH from the owner's machine/),
    });
  }, 240000);
});

describe('a far end that stops mid-way', () => {
  it('a sync or a join whose far end dies after its handshake stops, named, and says a rerun is safe', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const { ssh } = standinSsh(path.join(fixture.tmp, 'bin'));
    const dies = path.join(fixture.tmp, 'dies.js');
    fs.writeFileSync(
      dies,
      `process.stdout.write(JSON.stringify({ banner: 'reasonbook-sync', protocol: 1 }) + '\\n');\n`
    );
    const route = { host: 'studio', root: owner.root, node: process.execPath, bin: dies };
    const open = (step: Parameters<typeof onCopy>[2]) => onCopy(fixture.tmp, owner, step);
    expect((await syncRoute(open as never, route, { ssh })).error).toMatchObject({
      message: expect.stringMatching(/The sync with studio:\S+ stopped/),
      suggestion: expect.stringMatching(/repeats safely/),
    });
    expect((await joinRoute(open as never, route, 'Darryl', { ssh })).error).toMatchObject({
      message: expect.stringMatching(/The join over studio:\S+ stopped/),
      suggestion: expect.stringMatching(/was never used/),
    });
  }, 240000);
});

describe('a refusal at the tool boundary (s96-m13 build-time critics)', () => {
  it("a copy its check refuses answers a shared-record action with the check's own remedy, and still lists its members", async () => {
    const owner = await ownerCopy(fixture.tmp);
    await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const restore = await backUp(fixture.tmp, owner);
    useMachine(fixture.tmp, owner.machine);
    const wrote = await call('rbook_decisions', {
      action: 'record',
      content: 'Written after the backup.',
      projectRoot: owner.root,
    });
    if (!wrote.success) throw new Error(JSON.stringify(wrote.error));
    restore();
    useMachine(fixture.tmp, owner.machine);
    const invited = await call('rbook_project', {
      action: 'invite',
      name: 'Erin',
      projectRoot: owner.root,
    });
    expect(invited.error).toMatchObject({
      code: REPLICA_ERROR_CODES.RESTORED,
      suggestion: expect.stringMatching(/\S/),
    });
    const members = await call('rbook_project', { action: 'members', projectRoot: owner.root });
    expect(members.success).toBe(true);
  }, 240000);
});

describe('a restored copy writes none of its own changes (s96-m13 critics, round 4)', () => {
  it('a settle on a restored copy is refused, however the copy was opened', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const ok = async (copy: Copy, tool: string, args: Record<string, unknown>) => {
      useMachine(fixture.tmp, copy.machine);
      const answer = await call(tool, { ...args, projectRoot: copy.root });
      if (!answer.success) throw new Error(`${copy.name}: ${JSON.stringify(answer.error)}`);
    };
    await ok(owner, 'rbook_sprint', {
      action: 'add',
      sprintId: 'r-sprint',
      title: 'R',
      status: 'Planned',
    });
    await ok(owner, 'rbook_mission', {
      action: 'add',
      missionId: 'r-m01',
      name: 'Contested',
      sprintId: 'r-sprint',
    });
    await syncCopies(fixture.tmp, studio, owner);
    // The same field written on both copies before either sees the other's: a conflict on each.
    for (const [copy, name] of [
      [owner, 'Owner name'],
      [studio, 'Studio name'],
    ] as const)
      await ok(copy, 'rbook_mission', { action: 'update', missionId: 'r-m01', fields: { name } });
    await syncCopies(fixture.tmp, studio, owner);
    await syncCopies(fixture.tmp, studio, owner);
    expect(read(studio, "SELECT field FROM record_conflicts WHERE entity = 'missions'")).toEqual([
      { field: 'name' },
    ]);
    const restore = await backUp(fixture.tmp, studio);
    await ok(studio, 'rbook_decisions', { action: 'record', content: 'Lost with the folder.' });
    restore();
    // Opened without the check, the settle makes it itself: written, it would take a sequence the
    // copy already used.
    await expect(
      on(studio, (client) =>
        settleField(client, {
          table: 'missions',
          recordId: 'r-m01',
          field: 'name',
          value: 'Owner name',
        })
      )
    ).rejects.toThrow(/restored backup or a replaced folder/);
    expect(read(studio, "SELECT count(*) AS n FROM record_changes WHERE kind = 'settle'")).toEqual([
      { n: 0 },
    ]);
  }, 240000);

  it('a row deleted on a restored copy by a client opened without the check is refused, whatever token rows its file holds', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const decide = async (content: string) => {
      useMachine(fixture.tmp, studio.machine);
      const answer = await call('rbook_decisions', {
        action: 'record',
        content,
        projectRoot: studio.root,
      });
      if (!answer.success) throw new Error(JSON.stringify(answer.error));
    };
    await decide('Kept.');
    const restore = await backUp(fixture.tmp, studio);
    await decide('Lost with the folder.');
    restore();
    // A merge token that damage left in the file is not a merge's: only the merge marks its client.
    const raw = new Database(dbOf(studio.root));
    try {
      raw.prepare("INSERT INTO record_apply_token (txn_id) VALUES ('left-over')").run();
    } finally {
      raw.close();
    }
    const deleted = await on(studio, (client) =>
      client.execute("DELETE FROM strategic_decisions WHERE decision_text = 'Kept.'")
    );
    expect(deleted.error?.code).toBe('REPLICA_RESTORED');
    expect(
      read(studio, "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'Kept.'")
    ).toEqual([{ n: 1 }]);
  }, 240000);
});
