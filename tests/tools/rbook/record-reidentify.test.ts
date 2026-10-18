// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (ADR s96 §7, §9) — a copy an exchange finds restored, replaced or clashing takes a successor in a fresh
// ABOUTME: block and reports what it lost; reused slots and a shared block are renumbered, and every copy ends equal.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { importBundle, writeBundle } from '../../../src/tools/rbook/record-bundle';
import { exchange, type Peer } from '../../../src/tools/rbook/record-exchange';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import { inviteMember } from '../../../src/tools/rbook/record-membership';
import { admitMember, replicaMarks } from '../../../src/tools/rbook/record-apply';
import {
  call,
  mark,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  backUp,
  copyPeer,
  joinedCopy,
  memberCopy,
  onCopy,
  ownerCopy,
  read,
  recordedState,
  replicaOf,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-reidentify-');
});
afterEach(() => fixture.restore());

async function decide(copy: Copy, content: string, extra: Record<string, unknown> = {}) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call('rbook_decisions', {
    action: 'record',
    content,
    ...extra,
    projectRoot: copy.root,
  });
  if (!answer.success) throw new Error(`${copy.name}: ${JSON.stringify(answer.error)}`);
  return answer.data!.decisionId as number;
}

const idOf = (copy: Copy, text: string): number | undefined =>
  read<{ id: number }>(copy, 'SELECT id FROM strategic_decisions WHERE decision_text = ?', [
    text,
  ])[0]?.id;

const seqOf = (copy: Copy, replicaId: string): number =>
  read<{ n: number }>(
    copy,
    'SELECT coalesce(max(replica_seq), 0) AS n FROM record_changes WHERE replica_id = ?',
    [replicaId]
  )[0].n;

describe('a copy restored or replaced, found by its exchange', () => {
  it('a whole-machine restore is found at the next exchange: the copy re-identifies, says later changes may be lost, and gets back what it had sent', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await decide(studio, 'Before the backup.');
    await syncCopies(fixture.tmp, owner, studio);
    const restore = await backUp(fixture.tmp, studio, { machine: true });
    await decide(studio, 'After the backup, synced.');
    await syncCopies(fixture.tmp, owner, studio);
    restore();
    // The registry came back with the store, so the copy's own check passes: only the exchange can tell.
    const report = await syncCopies(fixture.tmp, owner, studio);
    expect(report.reidentified).toMatchObject({
      reason: 'whole-machine',
      from: studio.replicaId,
      count: null,
      summary: expect.stringMatching(/may be lost/),
    });
    expect(report.reidentified!.block).toBeGreaterThan(studio.block);
    expect(idOf(studio, 'After the backup, synced.')).toBeDefined();
    const next = await decide(studio, 'In the new block.');
    expect(Math.floor(next / 1_000_000)).toBe(report.reidentified!.block);
    await syncCopies(fixture.tmp, owner, studio);
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 240000);

  it('a replaced folder under an intact, newer registry reports exactly what it lost, by count and range', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await decide(studio, 'Synced before the folder was replaced.');
    await syncCopies(fixture.tmp, owner, studio);
    const received = seqOf(owner, studio.replicaId);
    const restore = await backUp(fixture.tmp, studio);
    await decide(studio, 'Lost with the folder, one.');
    await decide(studio, 'Lost with the folder, two.');
    const wrote = seqOf(studio, studio.replicaId);
    restore();
    const report = await syncCopies(fixture.tmp, owner, studio);
    expect(report.reidentified).toMatchObject({
      reason: 'restored',
      count: wrote - received,
      first: received + 1,
      last: wrote,
      summary: expect.stringMatching(/never reached the authority and were lost/),
    });
    // The review keeps what the copy said.
    const review = await onCopy(fixture.tmp, studio, (client) => sharedRecordReview(client));
    expect(review?.moves).toEqual([
      expect.stringMatching(
        new RegExp(
          `took a new identity in block ${report.reidentified!.block} on .*: ${wrote - received} changes`
        )
      ),
    ]);
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 240000);

  it('an admitted member restored before its first synced write reports its exact loss from sequence one', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const authority = await copyPeer(fixture.tmp, owner).hello();
    expect(authority.members).toContain(studio.replicaId);
    expect(authority.marks).not.toHaveProperty(studio.replicaId);
    const restore = await backUp(fixture.tmp, studio);
    await decide(studio, 'Accepted, but lost before this member first synced.');
    const wrote = seqOf(studio, studio.replicaId);
    expect(wrote).toBeGreaterThan(0);
    restore();
    expect(mark()).toBe(wrote);
    expect(seqOf(studio, studio.replicaId)).toBe(0);

    // The authority knows this member and has received zero changes, not an unknown count.
    const report = await syncCopies(fixture.tmp, owner, studio);
    expect(report.reidentified).toMatchObject({
      reason: 'restored',
      count: wrote,
      first: 1,
      last: wrote,
      summary: expect.stringMatching(/never reached the authority and were lost/),
    });
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 240000);
});

describe('reused slots and a shared block', () => {
  it('slots a restored machine reused below both marks are found by the chain, and its creates renumber into a fresh block: three copies end equal', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const air = await joinedCopy(fixture.tmp, owner, 'air2', 'Erin');
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await decide(air, 'Before the backup.');
    await syncCopies(fixture.tmp, owner, air);
    const restore = await backUp(fixture.tmp, air, { machine: true });
    const original = await decide(air, 'The original, synced.');
    await syncCopies(fixture.tmp, owner, air);
    await syncCopies(fixture.tmp, owner, studio);
    restore();
    // The restored machine passes its own check and writes into slots and ids the original used.
    const reused = await decide(air, 'Written again after the restore.');
    expect(reused).toBe(original);
    const later = await decide(air, 'Supersedes the rewritten one.', { supersedes: [reused] });
    const report = await syncCopies(fixture.tmp, owner, air);
    expect(report.reidentified).toMatchObject({ reason: 'slot', from: air.replicaId });
    const block = report.reidentified!.block;
    expect(report.reidentified!.moved).toBeGreaterThan(0);
    await syncCopies(fixture.tmp, owner, studio);
    await syncCopies(fixture.tmp, owner, air);
    for (const copy of [owner, air, studio]) {
      expect(idOf(copy, 'The original, synced.')).toBe(original);
      expect(Math.floor(idOf(copy, 'Written again after the restore.')! / 1_000_000)).toBe(block);
      // A reference to the renumbered decision follows it.
      expect(
        read(copy, 'SELECT superseded_by FROM strategic_decisions WHERE id = ?', [
          idOf(copy, 'Written again after the restore.'),
        ])
      ).toEqual([{ superseded_by: idOf(copy, 'Supersedes the rewritten one.') }]);
    }
    expect(idOf(air, 'Supersedes the rewritten one.')).not.toBe(later);
    expect(recordedState(air)).toEqual(recordedState(owner));
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 360000);

  it('a block two replicas hold stops the exchange, names both, and the one admitted later renumbers', async () => {
    const owner = await ownerCopy(fixture.tmp);
    // Two admissions in one block, as a recovery that missed a join leaves them.
    const ids = await onCopy(fixture.tmp, owner, (client) =>
      ['Ann', 'Bea'].map((name) => inviteMember(client, { name }).data!.memberId)
    );
    const a = await memberCopy(fixture.tmp, owner, 'a', 1, { admit: false, author: 'Ann' });
    const b = await memberCopy(fixture.tmp, owner, 'b', 1, { admit: false, author: 'Bea' });
    for (const [copy, member] of [
      [a, ids[0]],
      [b, ids[1]],
    ] as const)
      await onCopy(fixture.tmp, owner, (client) => {
        const admitted = admitMember(client, {
          replicaId: copy.replicaId,
          block: 1,
          role: 'editor',
          member,
        });
        if (!admitted.success) throw new Error(admitted.error?.message);
      });
    const first = await decide(a, "Ann's decision.");
    const clash = await decide(b, "Bea's decision.");
    expect(clash).toBe(first);
    // An exchange that neither replica is a side of stops, and names both.
    const stopped = await exchange(copyPeer(fixture.tmp, owner), copyPeer(fixture.tmp, a));
    expect(stopped.error).toMatchObject({
      code: 'RECORD_BLOCK_CLASH',
      message: expect.stringContaining(
        `Block 1 is held by ${[a.replicaId, b.replicaId].sort().join(' and ')}`
      ),
    });
    const report = await syncCopies(fixture.tmp, owner, b);
    expect(report.reblocked).toEqual([{ replicaId: b.replicaId, block: expect.any(Number) }]);
    const block = report.reblocked![0].block;
    await syncCopies(fixture.tmp, owner, a);
    await syncCopies(fixture.tmp, owner, b);
    for (const copy of [owner, a, b]) {
      expect(idOf(copy, "Ann's decision.")).toBe(first);
      expect(Math.floor(idOf(copy, "Bea's decision.")! / 1_000_000)).toBe(block);
    }
    expect(await replicaOf(fixture.tmp, b)).toBe(b.replicaId);
    expect(recordedState(b)).toEqual(recordedState(owner));
    expect(recordedState(a)).toEqual(recordedState(owner));
  }, 360000);

  it("a digest mismatch in the owner's own stream stops the exchange and shows on both sides", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, owner, studio);
    const restore = await backUp(fixture.tmp, owner, { machine: true });
    await decide(owner, 'The owner wrote this, and the studio has it.');
    await syncCopies(fixture.tmp, owner, studio);
    restore();
    await decide(owner, 'The restored owner reused the slot.');
    const refused = await exchange(copyPeer(fixture.tmp, owner), copyPeer(fixture.tmp, studio));
    expect(refused.error).toMatchObject({
      code: 'RECORD_AUTHORITY_DIFFERS',
      suggestion: expect.stringMatching(/reasonbook recover/),
    });
    for (const copy of [owner, studio]) {
      const review = await onCopy(fixture.tmp, copy, (client) => sharedRecordReview(client), {
        replicaCheck: false,
      });
      expect(review?.syncErrors).toBe(1);
      expect(review?.peers?.join(' ')).toMatch(/owner's own stream differs/);
    }
  }, 240000);
});

describe('the order and the steps of a new identity (s96-m13 build-time critics)', () => {
  it('an owner copy whose own stream differs stops the exchange before any copy takes a new identity', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    const restoreOwner = await backUp(fixture.tmp, owner, { machine: true });
    await decide(owner, 'Owner, after the backup, one.');
    await decide(owner, 'Owner, after the backup, two.');
    await syncCopies(fixture.tmp, studio, owner);
    // The studio's folder is replaced by an older copy of itself: it has a reason to re-identify.
    const restoreStudio = await backUp(fixture.tmp, studio);
    await decide(studio, 'Studio, lost with its folder.');
    restoreStudio();
    // The owner's machine is restored, and it writes past what the studio holds of its stream.
    restoreOwner();
    for (const n of [1, 2, 3, 4]) await decide(owner, `Owner, restored, ${n}.`);
    const halted = await exchange(copyPeer(fixture.tmp, studio), copyPeer(fixture.tmp, owner));
    expect(halted.error).toMatchObject({
      code: 'RECORD_AUTHORITY_DIFFERS',
      suggestion: expect.stringMatching(/reasonbook recover/),
    });
    // Nothing moved first: the studio keeps the identity a recovery will look for.
    expect(read(studio, "SELECT value FROM metadata WHERE key = 'replica_id'")).toEqual([
      { value: studio.replicaId },
    ]);
  }, 360000);

  it('a copy whose channel closed as it took its new identity is given the same one again', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await decide(studio, 'Synced.');
    await syncCopies(fixture.tmp, studio, owner);
    const restore = await backUp(fixture.tmp, studio);
    await decide(studio, 'Lost with the folder.');
    restore();
    const real = copyPeer(fixture.tmp, studio);
    const dropping = {
      ...real,
      takeSuccessor: async () => {
        throw new Error('the channel closed');
      },
    };
    await expect(exchange(dropping, copyPeer(fixture.tmp, owner))).rejects.toThrow(
      /the channel closed/
    );
    const again = await syncCopies(fixture.tmp, studio, owner);
    const successors = read<{ id: string }>(
      owner,
      "SELECT entity_id AS id FROM record_changes WHERE kind = 'replica_joined' AND json_extract(value, '$.previous') = ?",
      [studio.replicaId]
    );
    // One successor, the one admitted first and taken now: none is left that no copy holds.
    expect(successors.map((row) => row.id)).toEqual([again.reidentified!.to]);
  }, 360000);

  it("a successor's stream carried to the owner by bundle takes its renumber first, so the owner's next bundle imports", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const air = await joinedCopy(fixture.tmp, owner, 'air', 'Erin');
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await decide(air, 'Before the backup.');
    await syncCopies(fixture.tmp, owner, air);
    await syncCopies(fixture.tmp, owner, studio);
    const restore = await backUp(fixture.tmp, air, { machine: true });
    await decide(air, 'The original, synced.');
    await syncCopies(fixture.tmp, owner, air);
    await syncCopies(fixture.tmp, owner, studio);
    restore();
    // The restored machine writes into the slot the synced original holds, and against it.
    const reused = await decide(air, 'Written again after the restore.');
    await decide(air, 'Supersedes the rewritten one.', { supersedes: [reused] });
    // The direct sync gives the air's copy a new identity; its channel closes before the transfer.
    const real = copyPeer(fixture.tmp, owner);
    let applies = 0;
    const dropping: Peer = {
      ...real,
      apply: async (changes, options) => {
        applies += 1;
        if (applies > 1) throw new Error('the channel closed');
        return real.apply(changes, options);
      },
    };
    await expect(exchange(copyPeer(fixture.tmp, air), dropping)).rejects.toThrow(
      /the channel closed/
    );
    // The rest goes by file. Its renumber has a newer clock than the changes it moved, which keep
    // theirs: applied by clock alone, a moved create went live in its old slot, and every later
    // bundle from the owner's copy stopped on the slot two rows claimed.
    const carry = async (from: Copy, to: Copy) => {
      const unchecked = { replicaCheck: false };
      const marks = await onCopy(fixture.tmp, to, (client) => replicaMarks(client), unchecked);
      const bundle = await onCopy(
        fixture.tmp,
        from,
        (client) => writeBundle(client, marks),
        unchecked
      );
      return onCopy(fixture.tmp, to, (client) => importBundle(client, bundle), unchecked);
    };
    expect((await carry(air, owner)).error).toBeUndefined();
    expect((await carry(owner, studio)).error).toBeUndefined();
    expect(recordedState(studio)).toEqual(recordedState(owner));
    expect(idOf(studio, 'Written again after the restore.')).not.toBe(
      idOf(studio, 'The original, synced.')
    );
  }, 360000);
});
