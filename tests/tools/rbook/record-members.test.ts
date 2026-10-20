// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (ADR s96 §8, §11) — a removed member's changes past its cut are quarantined and it receives nothing
// ABOUTME: new; a re-add decides them from that decision; only the owner's copy removes, and never the owner.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { formatSharedProjectForLLM } from '../../../src/tools/rbook/rbook-project-shared';
import fs from 'fs';
import path from 'path';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { clientPeer, exchange } from '../../../src/tools/rbook/record-exchange';
import { answerJoin, applyJoin, requestJoin } from '../../../src/tools/rbook/record-join';
import {
  inviteMember,
  listMembers,
  removeMember,
} from '../../../src/tools/rbook/record-membership';
import { readReplicaIdentity } from '../../../src/tools/rbook/replica-identity';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { onCopy, ownerCopy, read, type Copy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-members-');
});
afterEach(() => fixture.restore());

async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

/** The owner invites `name`, and a post-share zip on another machine joins for them. */
async function joined(owner: Copy, name: string, folder: string): Promise<Copy> {
  await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name }));
  const root = path.join(fixture.tmp, folder);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const source = new Database(dbOf(owner.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  const zip = { root, machine: `machine-${folder}` };
  useMachine(fixture.tmp, zip.machine);
  writeUserAuthor(name);
  const request = await onCopy(fixture.tmp, zip, (client) => requestJoin(client), {
    replicaCheck: false,
  });
  const answer = await onCopy(fixture.tmp, owner, (client) =>
    answerJoin(client, request.data!, name)
  );
  await onCopy(fixture.tmp, zip, (client) => applyJoin(client, answer.data!), {
    replicaCheck: false,
  });
  const identity = await onCopy(fixture.tmp, zip, (client) =>
    readReplicaIdentity(client, { fresh: true })
  );
  return { name: folder, ...zip, replicaId: identity!.replicaId, block: identity!.block };
}

const peer = (copy: Copy) => clientPeer(copy.name, (step) => onCopy(fixture.tmp, copy, step));

async function sync(member: Copy, owner: Copy) {
  const result = await exchange(peer(member), peer(owner));
  if (!result.success) throw new Error(JSON.stringify(result.error));
  return result.data!;
}

const decided = (copy: Copy, text: string) =>
  read(copy, 'SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = ?', [text]);

describe('removal and re-add', () => {
  it("a removed member's changes past its cut are quarantined, it receives nothing new, and a re-add decides them", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joined(owner, 'Darryl', 'studio');
    await ok(member, 'rbook_decisions', { action: 'record', content: 'Before the removal.' });
    await sync(member, owner);
    const removed = await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Darryl'));
    expect(removed.data).toMatchObject({
      role: 'removed',
      cuts: { [member.replicaId]: expect.any(Number) },
    });
    // After the cut: the member keeps writing; the owner quarantines it and sends nothing back.
    await ok(member, 'rbook_decisions', { action: 'record', content: 'After the removal.' });
    await ok(owner, 'rbook_decisions', { action: 'record', content: 'The owner, meanwhile.' });
    const cutOff = await sync(member, owner);
    expect(cutOff).toMatchObject({ removed: true, received: 0 });
    expect(decided(owner, 'Before the removal.')).toEqual([{ n: 1 }]);
    expect(decided(owner, 'After the removal.')).toEqual([{ n: 0 }]);
    expect(
      read<{ state: string }>(
        owner,
        "SELECT state FROM record_txn_state WHERE state = 'quarantined'"
      ).length
    ).toBeGreaterThan(0);
    expect(decided(member, 'The owner, meanwhile.')).toEqual([{ n: 0 }]);
    // The re-add accepts what the cut held back, from now; the member then catches up.
    const readded = await onCopy(fixture.tmp, owner, (client) =>
      inviteMember(client, { name: 'Darryl' })
    );
    expect(readded.data).toMatchObject({
      role: 'editor',
      invited: true,
      accepted: expect.any(Number),
    });
    expect(readded.data!.accepted).toBeGreaterThan(0);
    expect(decided(owner, 'After the removal.')).toEqual([{ n: 1 }]);
    const back = await sync(member, owner);
    expect(back.removed).toBe(false);
    expect(decided(member, 'The owner, meanwhile.')).toEqual([{ n: 1 }]);
  }, 240000);

  it('a re-add judges what the member wrote while removed in clock order, so an edit of its own new decision is accepted after it (s100-m01)', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joined(owner, 'Darryl', 'studio');
    await sync(member, owner);
    await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Darryl'));
    // Removed, the member records a decision and then archives it: the second names the first's row.
    const recorded = await ok(member, 'rbook_decisions', {
      action: 'record',
      content: 'Written and archived while removed.',
    });
    const decisionId =
      (recorded.data as { id?: number; decisionId?: number }).decisionId ??
      (recorded.data as { id?: number }).id;
    await ok(member, 'rbook_decisions', { action: 'update', decisionId, status: 'archived' });
    expect((await sync(member, owner)).removed).toBe(true);
    const status = () =>
      read<{ status: string }>(
        owner,
        'SELECT status FROM strategic_decisions WHERE decision_text = ?',
        ['Written and archived while removed.']
      );
    expect(status()).toEqual([]);
    const readded = await onCopy(fixture.tmp, owner, (client) =>
      inviteMember(client, { name: 'Darryl' })
    );
    // The archive was judged after the decision it names; judged first, it would wait for good.
    expect(readded.data).toMatchObject({ refused: 0 });
    expect(readded.data!.accepted).toBeGreaterThanOrEqual(2);
    expect(status()).toEqual([{ status: 'archived' }]);
  }, 240000);

  it('the members list names the owner, the invited and the removed; only the owner removes, and never the owner', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joined(owner, 'Darryl', 'studio');
    await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: 'Erin' }));
    // A name that reads the same as a member's, case and compatibility forms aside, is refused.
    const fullwidth = String.fromCodePoint(0xff25, 0xff52, 0xff49, 0xff4e);
    for (const alike of ['erin', fullwidth])
      expect(
        (await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: alike }))).error
          ?.message
      ).toMatch(/reads the same as Erin/);
    await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Erin'));
    expect(
      (await onCopy(fixture.tmp, owner, (client) => listMembers(client))).map((m) => [
        m.name,
        m.role,
        m.replicas.length,
      ])
    ).toEqual([
      ['Owner', 'owner', 1],
      ['Darryl', 'editor', 1],
      ['Erin', 'removed', 0],
    ]);
    expect(
      (await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Owner'))).error?.message
    ).toMatch(/owner cannot be removed/);
    await sync(member, owner);
    expect(
      (await onCopy(fixture.tmp, member, (client) => removeMember(client, 'Erin'))).error?.message
    ).toMatch(/Only the owner's copy removes/);
    // A name that differs only by a joiner the name rule keeps between two letters of a script that
    // does not join, where it shows nothing, reads the same too: "Dasha" in Cyrillic, with one.
    const dasha = String.fromCodePoint(0x0414, 0x0430, 0x0448, 0x0430);
    const withJoiner = String.fromCodePoint(0x0414, 0x0430, 0x200d, 0x0448, 0x0430);
    await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: dasha }));
    expect(
      (await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: withJoiner })))
        .error?.message
    ).toMatch(new RegExp(`reads the same as ${dasha}`));
  }, 240000);
});

describe('how an invite reads (s96-m13 critics, round 2)', () => {
  it('a re-add says the route its removal dropped is set again, and never sends the owner to join it a second time', () => {
    const member = { memberId: 'm-1', name: 'Erin', role: 'editor', replicas: [] };
    const readded = formatSharedProjectForLLM('invite', {
      success: true,
      data: { ...member, invited: true, accepted: 2 },
    } as never);
    expect(readded).toMatch(/Re-added Erin as editor; 2 quarantined change\(s\)/);
    expect(readded).toMatch(
      /A removal drops the route to their copy: set it again with reasonbook sync --ssh/
    );
    expect(readded).not.toMatch(/action="join"/);
    // s100-m01: a re-add judges them again, and says how many it refused.
    const judged = formatSharedProjectForLLM('invite', {
      success: true,
      data: { ...member, invited: true, accepted: 2, refused: 1 },
    } as never);
    expect(judged).toMatch(
      /2 quarantined change\(s\) of theirs are accepted from now, and 1 refused, as an editor's would be/
    );
    const invited = formatSharedProjectForLLM('invite', {
      success: true,
      data: { ...member, invited: true },
    } as never);
    expect(invited).toMatch(/Join their copy with rbook_project\(action="join"/);
  });
});
