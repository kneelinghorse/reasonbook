// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (ADR s96 §8) — the owner copy moves by a planned handover; each copy confirms the move before it applies
// ABOUTME: it, holding the new stream until then; afterwards the new owner copy admits and removes, and every copy ends equal.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { replicaMarks } from '../../../src/tools/rbook/record-apply';
import { importBundle, writeBundle } from '../../../src/tools/rbook/record-bundle';
import { exchange } from '../../../src/tools/rbook/record-exchange';
import {
  isMembersCopy,
  listMembers,
  removeMember,
} from '../../../src/tools/rbook/record-membership';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import {
  call,
  dbOf,
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
  recordedState,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-moves-');
});
afterEach(() => fixture.restore());

async function decide(copy: Copy, content: string) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call('rbook_decisions', {
    action: 'record',
    content,
    projectRoot: copy.root,
  });
  if (!answer.success) throw new Error(`${copy.name}: ${JSON.stringify(answer.error)}`);
}

const on = <T>(copy: Copy, use: Parameters<typeof onCopy<T>>[2]) =>
  onCopy(fixture.tmp, copy, use, { replicaCheck: false });

const standingOf = (copy: Copy, text: string) =>
  read<{ state: string; cause: string }>(
    copy,
    `SELECT s.state, s.cause FROM record_txn_state s JOIN record_changes c ON c.txn_id = s.txn_id
      WHERE c.kind = 'create' AND json_extract(c.value, '$.decision_text') = ?`,
    [text]
  );

/** The owner's copy, the owner's second copy and a member's, all synced. */
async function star(): Promise<{ old: Copy; next: Copy; studio: Copy }> {
  const old = await ownerCopy(fixture.tmp);
  const next = await joinedCopy(fixture.tmp, old, 'next', 'Owner');
  const studio = await joinedCopy(fixture.tmp, old, 'studio', 'Darryl');
  await decide(old, 'Before the handover.');
  await syncCopies(fixture.tmp, old, next);
  await syncCopies(fixture.tmp, old, studio);
  return { old, next, studio };
}

describe('a planned handover', () => {
  it('moves the judging to the new copy once it confirms; the old copy writes as a member; each member confirms before applying', async () => {
    const { old, next, studio } = await star();
    const moved = await on(old, (client) => handOver(client, { to: next.replicaId }));
    expect(moved.data).toMatchObject({ epoch: 2, to: next.replicaId });
    expect(await on(old, (client) => isMembersCopy(client))).toBe(true);
    await decide(old, 'After the handover, on the old copy.');
    // The new copy is behind an epoch: it takes in the move, and the old copy's later write waits.
    const caught = await syncCopies(fixture.tmp, old, next);
    expect(caught.caughtUp).toEqual({ copy: 'remote', epoch: 2, authority: next.replicaId });
    expect(standingOf(next, 'After the handover, on the old copy.')).toEqual([
      { state: 'held', cause: expect.stringMatching(/confirm the owner's copy/) },
    ]);
    // Its review says so first, and the digest's short form keeps it.
    const review = await on(next, (client) => sharedRecordReview(client));
    expect(review).toMatchObject({
      movePending: true,
      moves: [expect.stringMatching(/until you confirm it: reasonbook sync --confirm-owner/)],
    });
    useMachine(fixture.tmp, next.machine);
    expect(renderDigestV2(await readDigestV2(next.root)).text).toMatch(
      /Owner's copy: the owner's copy moved/
    );
    // A confirmation names the move it confirms; another is refused, and nothing changes.
    expect(
      (await on(next, (client) => confirmOwner(client, { changeId: 'another' }))).error?.message
    ).toMatch(/is not the one named/);
    const confirmed = await on(next, (client) => confirmOwner(client));
    expect(confirmed.data).toMatchObject({ epoch: 2, isAuthority: true, next: null });
    expect(confirmed.data!.judged).toBeGreaterThan(0);
    expect(standingOf(next, 'After the handover, on the old copy.')).toEqual([]);
    expect(await on(next, (client) => isMembersCopy(client))).toBe(false);
    // A copy that was the owner's once already takes no second term.
    expect(
      (await on(next, (client) => handOver(client, { to: old.replicaId }))).error?.message
    ).toMatch(/was the owner's copy once already/);
    await syncCopies(fixture.tmp, old, next);
    // The member holds the new owner copy's stream, and the old copy's writes past the cut, until it confirms.
    const held = await syncCopies(fixture.tmp, studio, next);
    expect(held.caughtUp).toMatchObject({ copy: 'local', epoch: 2 });
    expect(standingOf(studio, 'After the handover, on the old copy.')).toEqual([
      { state: 'held', cause: expect.stringMatching(/confirm the owner's copy/) },
    ]);
    expect(await on(studio, (client) => confirmOwner(client))).toMatchObject({
      data: { isAuthority: false },
    });
    expect(standingOf(studio, 'After the handover, on the old copy.')).toEqual([]);
    await decide(studio, 'A member writes after the move.');
    await syncCopies(fixture.tmp, studio, next);
    await syncCopies(fixture.tmp, old, next);
    for (const copy of [old, studio]) expect(recordedState(copy)).toEqual(recordedState(next));
    // After the move, the new owner copy admits one copy and removes another; the rest stay equal.
    const erin = await joinedCopy(fixture.tmp, next, 'erin', 'Erin');
    expect(erin.block).toBeGreaterThan(studio.block);
    await on(next, (client) => removeMember(client, 'Darryl'));
    for (const copy of [old, erin]) await syncCopies(fixture.tmp, copy, next);
    for (const copy of [old, erin]) expect(recordedState(copy)).toEqual(recordedState(next));
    const roles = (copy: Copy) =>
      on(copy, (client) => listMembers(client).map((member) => `${member.name}:${member.role}`));
    expect(await roles(old)).toEqual(await roles(next));
    expect(await roles(next)).toEqual(['Owner:owner', 'Darryl:removed', 'Erin:editor']);
  }, 360000);

  it('refuses a handover from a member, and to a copy that is not the owner’s', async () => {
    const { old, next, studio } = await star();
    expect(
      (await on(next, (client) => handOver(client, { to: studio.replicaId }))).error?.message
    ).toMatch(/Only the owner's copy hands over/);
    expect(
      (await on(old, (client) => handOver(client, { to: studio.replicaId }))).error?.message
    ).toMatch(/names another copy of the owner's/);
    const refused = await exchange(copyPeer(fixture.tmp, studio), copyPeer(fixture.tmp, next));
    expect(refused.error?.message).toMatch(/a member syncs only with the owner's/);
  }, 240000);
});

describe('three copies', () => {
  it('a forwarded join and a forwarded cut behind an earlier move end equal on all three', async () => {
    const { old, next, studio } = await star();
    await on(old, (client) => handOver(client, { to: next.replicaId }));
    await syncCopies(fixture.tmp, old, next);
    await on(next, (client) => confirmOwner(client));
    // The new owner copy admits a copy and cuts it; both sit behind the move in its stream.
    await joinedCopy(fixture.tmp, next, 'erin', 'Erin');
    await on(next, (client) => removeMember(client, 'Erin'));
    await syncCopies(fixture.tmp, old, next);
    const held = await syncCopies(fixture.tmp, studio, next);
    expect(held.caughtUp).toBeDefined();
    expect(await on(studio, (client) => listMembers(client).map((m) => m.name))).toEqual([
      'Owner',
      'Darryl',
    ]);
    await on(studio, (client) => confirmOwner(client));
    await syncCopies(fixture.tmp, studio, next);
    for (const copy of [old, studio]) {
      expect(recordedState(copy)).toEqual(recordedState(next));
      expect(
        await on(copy, (client) => listMembers(client).map((m) => `${m.name}:${m.role}`))
      ).toEqual(['Owner:owner', 'Darryl:editor', 'Erin:removed']);
    }
  }, 360000);
});

describe('a move carried by bundle', () => {
  it('a bundle from the new owner copy brings a member up to the move to confirm; a bundle from a copy behind it is refused', async () => {
    const { old, next, studio } = await star();
    await on(old, (client) => handOver(client, { to: next.replicaId }));
    await syncCopies(fixture.tmp, old, next);
    await on(next, (client) => confirmOwner(client));
    await decide(studio, 'Written before the member took the move.');
    const stale = await on(studio, (client) => writeBundle(client, {}));
    expect((await on(next, (client) => importBundle(client, stale))).error?.message).toMatch(
      /has not taken the owner copy's latest move/
    );
    const ahead = await on(next, (client) => writeBundle(client, {}));
    const caught = await on(studio, (client) => importBundle(client, ahead));
    expect(caught.data).toMatchObject({ caughtUp: { epoch: 2, authority: next.replicaId } });
    await on(studio, (client) => confirmOwner(client));
    const sent = await on(studio, (client) => writeBundle(client, {}));
    expect((await on(next, (client) => importBundle(client, sent))).data!.judged).toBeGreaterThan(
      0
    );
    const back = await on(next, (client) => writeBundle(client, {}));
    await on(studio, (client) => importBundle(client, back));
    expect(recordedState(studio)).toEqual(recordedState(next));
  }, 360000);
});

describe('around a move (s96-m13 build-time critics)', () => {
  it('a removed member behind a move takes in nothing new from the new owner copy', async () => {
    const { old, next } = await star();
    const erin = await joinedCopy(fixture.tmp, old, 'erin', 'Erin');
    await syncCopies(fixture.tmp, old, erin);
    await on(old, (client) => removeMember(client, 'Erin'));
    await decide(old, 'After the removal, on the owner copy.');
    await on(old, (client) => handOver(client, { to: next.replicaId }));
    await syncCopies(fixture.tmp, old, next);
    await on(next, (client) => confirmOwner(client));
    await decide(next, 'After the move, on the new owner copy.');
    // ADR s96 §8, §11: a removed member receives nothing new, across a move as within one.
    const caught = await exchange(copyPeer(fixture.tmp, erin), copyPeer(fixture.tmp, next));
    expect(caught.data).toMatchObject({ removed: true, received: 0 });
    for (const text of [
      'After the removal, on the owner copy.',
      'After the move, on the new owner copy.',
    ])
      expect(
        read(erin, 'SELECT id FROM strategic_decisions WHERE decision_text = ?', [text])
      ).toEqual([]);
  }, 360000);

  it("while a move waits for this copy's word, what the owner's copy already accepted from the new one stays", async () => {
    const { old, next, studio } = await star();
    const text = "The owner's other copy's decision, accepted before the handover.";
    useMachine(fixture.tmp, next.machine);
    const made = await call('rbook_decisions', {
      action: 'record',
      content: text,
      projectRoot: next.root,
    });
    const id = made.data!.decisionId as number;
    await syncCopies(fixture.tmp, next, old);
    await syncCopies(fixture.tmp, studio, old);
    const update = async (copy: Copy, status: string) => {
      useMachine(fixture.tmp, copy.machine);
      const answer = await call('rbook_decisions', {
        action: 'update',
        decisionId: id,
        status,
        projectRoot: copy.root,
      });
      if (!answer.success) throw new Error(JSON.stringify(answer.error));
    };
    // The studio marks it stale and the owner's other copy then archives it; the owner accepts both.
    await update(studio, 'stale');
    await syncCopies(fixture.tmp, studio, old);
    await syncCopies(fixture.tmp, next, old);
    await update(next, 'archived');
    await syncCopies(fixture.tmp, next, old);
    const row = (copy: Copy) =>
      read(copy, 'SELECT id, status FROM strategic_decisions WHERE decision_text = ?', [text]);
    const before = row(old);
    expect(before).toEqual([{ id, status: 'archived' }]);
    await on(old, (client) => handOver(client, { to: next.replicaId }));
    await syncCopies(fixture.tmp, old, next);
    await on(next, (client) => confirmOwner(client));
    // The studio takes in the move, and the archive the old owner copy accepted, before it confirms:
    // the new owner copy's stream waits, but what an owner's copy this copy follows judged does not.
    expect((await syncCopies(fixture.tmp, studio, next)).caughtUp).toBeDefined();
    expect(row(studio)).toEqual(before);
    await on(studio, (client) => confirmOwner(client));
    await syncCopies(fixture.tmp, studio, next);
    expect(recordedState(studio)).toEqual(recordedState(next));
  }, 360000);

  it('a restored copy takes a catch-up, by sync or by bundle, and confirms a move to another copy, never one to itself', async () => {
    const { old, next, studio } = await star();
    // Both folders are replaced by older copies of themselves: each copy check refuses its writes.
    for (const copy of [next, studio]) {
      const restore = await backUp(fixture.tmp, copy);
      await decide(copy, `${copy.name}, lost with its folder.`);
      restore();
    }
    await on(old, (client) => handOver(client, { to: next.replicaId }));
    // A catch-up writes none of a copy's own changes, so a restored copy takes it.
    const caught = await syncCopies(fixture.tmp, old, next);
    expect(caught.caughtUp).toEqual({ copy: 'remote', epoch: 2, authority: next.replicaId });
    // Confirming would make it the owner's copy, which writes its own verdicts at once: refused.
    expect((await on(next, (client) => confirmOwner(client))).error?.code).toBe('REPLICA_RESTORED');
    const marks = await on(studio, (client) => replicaMarks(client));
    const bundle = await on(old, (client) => writeBundle(client, marks));
    const imported = await on(studio, (client) => importBundle(client, bundle));
    expect(imported.data?.caughtUp).toEqual({ epoch: 2, authority: next.replicaId });
    // A member's copy confirming a move to another copy writes none of its own changes either.
    expect((await on(studio, (client) => confirmOwner(client))).data).toMatchObject({
      epoch: 2,
      authority: next.replicaId,
      isAuthority: false,
    });
  }, 360000);

  it('a restored copy whose guard is broken too takes no catch-up: its writes fail closed', async () => {
    const { old, next, studio } = await star();
    const restore = await backUp(fixture.tmp, studio);
    await decide(studio, 'Lost with the folder.');
    restore();
    // The older folder also holds a write token a crash left, which keeps every write out.
    const db = new Database(dbOf(studio.root));
    try {
      db.prepare("INSERT INTO record_write_token (txn_id) VALUES ('left-by-a-crash')").run();
    } finally {
      db.close();
    }
    await on(old, (client) => handOver(client, { to: next.replicaId }));
    await syncCopies(fixture.tmp, old, next);
    await on(next, (client) => confirmOwner(client));
    await decide(next, 'Written by the new owner copy.');
    // Taken in, the merge's rows would be staged under the token, and the repair would then record
    // them as the studio's own changes.
    const caught = await exchange(copyPeer(fixture.tmp, studio), copyPeer(fixture.tmp, next));
    expect(caught.error).toMatchObject({
      code: 'RECORD_GUARD_BROKEN',
      suggestion: expect.stringMatching(/reasonbook repair --guard/),
    });
    expect(read(studio, 'SELECT count(*) AS n FROM record_staged')).toEqual([{ n: 0 }]);
  }, 360000);
});
