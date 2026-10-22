// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m13 (ADR s96 §8) — recovering a lost owner copy: only with every member reached and the member list
// ABOUTME: confirmed, adopting every verdict, saying what was lost; dropped, unseen and superseded copies re-identify.
import { localCopyReport } from '../../../src/tools/rbook/record-copy-report';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { applyRemote, changesSince, replicaMarks } from '../../../src/tools/rbook/record-apply';
import { importBundle, writeBundle } from '../../../src/tools/rbook/record-bundle';
import { exchange, type Peer } from '../../../src/tools/rbook/record-exchange';
import {
  inviteMember,
  isMembersCopy,
  listMembers,
  removeMember,
} from '../../../src/tools/rbook/record-membership';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { recoverAuthority, type RecoveryInput } from '../../../src/tools/rbook/record-recovery';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
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
  fixture = replicaFixture('rbook-recovery-');
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

const on = <T>(copy: Copy, use: Parameters<typeof onCopy<T>>[2]) =>
  onCopy(fixture.tmp, copy, use, { replicaCheck: false });

/** A `reasonbook copy` of a copy, carried to `machine` as `name`, or written over `into`. */
function carry(from: Copy, name: string, machine: string, into?: string): Copy {
  const root = into ?? path.join(fixture.tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${dbOf(root)}${suffix}`, { force: true });
  const source = new Database(dbOf(from.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  useMachine(fixture.tmp, machine);
  writeUserAuthor('Owner');
  return { name, root, machine, replicaId: from.replicaId, block: from.block };
}

function recover(copy: Copy, peers: Copy[], input: RecoveryInput) {
  useMachine(fixture.tmp, copy.machine);
  return recoverAuthority(
    (step) => onCopy(fixture.tmp, copy, step, { replicaCheck: false }),
    peers.map((peer) => copyPeer(fixture.tmp, peer)),
    input
  );
}

/** A member confirms the new owner copy at its first sync after a move, then syncs. */
async function confirmAndSync(member: Copy, owner: Copy) {
  const caught = await syncCopies(fixture.tmp, member, owner);
  expect(caught.caughtUp).toBeDefined();
  const confirmed = await on(member, (client) => confirmOwner(client));
  if (!confirmed.success) throw new Error(JSON.stringify(confirmed.error));
  return syncCopies(fixture.tmp, member, owner);
}

const stateOf = (copy: Copy, text: string) =>
  read<{ state: string }>(
    copy,
    `SELECT s.state FROM record_txn_state s JOIN record_changes c ON c.txn_id = s.txn_id
      WHERE c.kind = 'create' AND json_extract(c.value, '$.decision_text') = ?`,
    [text]
  ).map((row) => row.state);

const seqOf = (copy: Copy, replicaId: string): number =>
  read<{ n: number }>(
    copy,
    'SELECT coalesce(max(replica_seq), 0) AS n FROM record_changes WHERE replica_id = ?',
    [replicaId]
  )[0].n;

describe('a recovery with every member reached', () => {
  it('adopts every earlier verdict, says what may be lost when the old machine is gone, and the new owner copy admits and removes', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
    await decide(studio, 'Darryl, accepted.');
    await syncCopies(fixture.tmp, studio, owner);
    await decide(erin, 'Erin, before her removal.');
    await syncCopies(fixture.tmp, erin, owner);
    await on(owner, (client) => removeMember(client, 'Erin'));
    await decide(erin, 'Erin, after her removal.');
    await syncCopies(fixture.tmp, erin, owner);
    await syncCopies(fixture.tmp, studio, owner);
    // The owner's machine is lost; a copy of the studio's copy on a new machine recovers it.
    const recovered = carry(studio, 'recovered', 'machine-new');
    const report = await recover(recovered, [studio], { members: ['Darryl'] });
    expect(report.data).toMatchObject({
      epoch: 2,
      previous: owner.replicaId,
      lost: { count: null, summary: expect.stringMatching(/may be lost/) },
    });
    expect(report.data!.block).toBeGreaterThan(erin.block);
    for (const text of ['Darryl, accepted.', 'Erin, before her removal.'])
      expect(stateOf(recovered, text)).toEqual([]);
    expect(stateOf(recovered, 'Erin, after her removal.')).toEqual(['quarantined']);
    await confirmAndSync(studio, { ...recovered, replicaId: report.data!.authority });
    expect(recordedState(studio)).toEqual(recordedState(recovered));
    const fay = await joinedCopy(fixture.tmp, recovered, 'fay', 'Fay');
    await on(recovered, (client) => removeMember(client, 'Darryl'));
    await syncCopies(fixture.tmp, fay, recovered);
    expect(recordedState(fay)).toEqual(recordedState(recovered));
  }, 360000);

  it('waits and names an unreachable member; dropped by the operator, its copy later re-identifies and reports what the recovery never saw', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
    await syncCopies(fixture.tmp, erin, owner);
    await syncCopies(fixture.tmp, studio, owner);
    await decide(erin, 'Erin, offline, one.');
    await decide(erin, 'Erin, offline, two.');
    const recovered = carry(studio, 'recovered', 'machine-new');
    const unconfirmed = await recover(recovered, [studio], { members: ['Darryl'] });
    expect(unconfirmed.error?.message).toMatch(/lists Darryl, Erin/);
    const waits = await recover(recovered, [studio], { members: ['Darryl', 'Erin'] });
    expect(waits.error?.message).toMatch(/waits for Erin's copy/);
    const report = await recover(recovered, [studio], {
      members: ['Darryl', 'Erin'],
      drop: ['Erin'],
    });
    const cut = report.data!.dropped[erin.replicaId];
    expect(cut).toBeDefined();
    const authority = { ...recovered, replicaId: report.data!.authority };
    await confirmAndSync(studio, authority);
    const back = await confirmAndSync(erin, authority);
    const wrote = seqOf(erin, erin.replicaId);
    expect(back.reidentified).toMatchObject({
      reason: 'cut',
      count: wrote - cut,
      first: cut + 1,
      last: wrote,
      summary: expect.stringMatching(/quarantined, and nothing in this release accepts them later/),
    });
    await syncCopies(fixture.tmp, erin, authority);
    expect(stateOf(recovered, 'Erin, offline, two.')).toEqual(['quarantined']);
    expect(recordedState(erin)).toEqual(recordedState(recovered));
    await syncCopies(fixture.tmp, studio, authority);
    expect(recordedState(studio)).toEqual(recordedState(recovered));
  }, 360000);

  it('is refused while the old owner copy is live, with the handover named', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    const recovered = carry(studio, 'recovered', owner.machine);
    const refused = await recover(recovered, [studio], { members: ['Darryl'] });
    expect(refused.error).toMatchObject({
      message: expect.stringMatching(/still live/),
      suggestion: expect.stringMatching(/reasonbook handover/),
    });
  }, 240000);
});

describe('copies a recovery did not see', () => {
  it('a superseded owner copy that comes back re-identifies as a member, and its owner-only changes past the cut are quarantined', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    // Offline, the owner copy keeps working as the owner's.
    await on(owner, (client) => inviteMember(client, { name: 'Gus' }));
    await decide(owner, 'The owner, offline.');
    const recovered = carry(studio, 'recovered', 'machine-new');
    const report = await recover(recovered, [studio], { members: ['Darryl'] });
    const authority = { ...recovered, replicaId: report.data!.authority };
    await confirmAndSync(studio, authority);
    await decide(studio, 'The studio, after the recovery.');
    await syncCopies(fixture.tmp, studio, authority);
    // The old copy, the owner's in its own view until it confirms, takes in the new owner copy's
    // stream without judging it: the studio's decision gets no verdict of the old copy's.
    const ownBefore = seqOf(owner, owner.replicaId);
    // Holding the recovery it has not confirmed, the old copy neither hands over nor recovers.
    const caught = await syncCopies(fixture.tmp, owner, authority);
    expect(caught.caughtUp).toBeDefined();
    expect(seqOf(owner, owner.replicaId)).toBe(ownBefore);
    expect(
      (await on(owner, (client) => handOver(client, { to: studio.replicaId }))).error?.message
    ).toMatch(/holds a move of the owner copy it has not confirmed/);
    expect((await recover(owner, [studio], { members: ['Darryl'] })).error?.message).toMatch(
      /holds a move of the owner copy it has not confirmed/
    );
    await on(owner, (client) => confirmOwner(client));
    const back = await syncCopies(fixture.tmp, owner, authority);
    expect(back.reidentified).toMatchObject({ reason: 'cut', from: owner.replicaId });
    expect(back.reidentified!.count).toBeGreaterThan(0);
    expect(await on(owner, (client) => isMembersCopy(client))).toBe(true);
    for (const copy of [authority, owner]) {
      expect(await on(copy, (client) => listMembers(client).map((m) => m.name))).toEqual([
        'Owner',
        'Darryl',
      ]);
      expect(stateOf(copy, 'The owner, offline.')).toEqual(['quarantined']);
    }
    expect(recordedState(owner)).toEqual(recordedState(authority));
  }, 360000);

  it('a copy presenting a join the recovery never saw takes the dropped path, and the new owner copy renumbers out of the block they share', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await on(owner, (client) => inviteMember(client, { name: 'Erin' }));
    await syncCopies(fixture.tmp, studio, owner);
    // Erin's copy joins after the studio last synced, so only the lost owner copy and Erin hold it.
    const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
    await decide(erin, 'Erin, unseen.');
    await syncCopies(fixture.tmp, erin, owner);
    const recovered = carry(studio, 'recovered', 'machine-new');
    const report = await recover(recovered, [studio], { members: ['Darryl', 'Erin'] });
    expect(report.data!.block).toBe(erin.block);
    const authority = { ...recovered, replicaId: report.data!.authority };
    await confirmAndSync(studio, authority);
    // Before the new owner copy's decision moves out of the shared block, rows point at it: the
    // studio's decision it supersedes, its own citation of that decision, and a later studio
    // decision whose text cites it by its number.
    const superseded = await decide(studio, "The studio's, which the new owner copy supersedes.");
    await syncCopies(fixture.tmp, studio, authority);
    const moving = await decide(authority, `The new owner copy, which builds on d:${superseded}.`, {
      supersedes: [superseded],
    });
    await syncCopies(fixture.tmp, studio, authority);
    const citing = await decide(studio, `The studio's, which builds on d:${moving}.`);
    await syncCopies(fixture.tmp, studio, authority);
    const back = await confirmAndSync(erin, authority);
    expect(back.reidentified).toMatchObject({
      reason: 'unseen',
      from: erin.replicaId,
      count: seqOf(erin, erin.replicaId),
    });
    expect(back.reblocked).toEqual([{ replicaId: authority.replicaId, block: expect.any(Number) }]);
    const block = back.reblocked![0].block;
    await syncCopies(fixture.tmp, studio, authority);
    await syncCopies(fixture.tmp, erin, authority);
    const links = (copy: Copy) =>
      read<{ from_id: number; to_id: number }>(
        copy,
        'SELECT from_id, to_id FROM record_links ORDER BY from_id, to_id'
      );
    for (const copy of [authority, studio, erin]) {
      const [row] = read<{ id: number }>(
        copy,
        'SELECT id FROM strategic_decisions WHERE decision_text = ?',
        [`The new owner copy, which builds on d:${superseded}.`]
      );
      expect(Math.floor(row.id / 1_000_000)).toBe(block);
      expect(stateOf(copy, 'Erin, unseen.')).toEqual(['quarantined']);
      // A reference another copy wrote follows the renumbered decision, and so does its own citation.
      expect(
        read(copy, 'SELECT superseded_by FROM strategic_decisions WHERE id = ?', [superseded])
      ).toEqual([{ superseded_by: row.id }]);
      // A citation in text names a number, so it follows the number: no row holds the old one now,
      // on any copy (the free-text hole). Every copy holds the same links.
      expect(links(copy)).toEqual([{ from_id: row.id, to_id: superseded }]);
      expect(links(copy).some((link) => link.from_id === citing)).toBe(false);
    }
    expect(recordedState(studio)).toEqual(recordedState(authority));
    expect(recordedState(erin)).toEqual(recordedState(authority));
  }, 360000);
});

describe('what a recovery says was lost', () => {
  it('an intact registry ahead of an overwritten folder gives the exact count and range', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    const received = seqOf(studio, owner.replicaId);
    await decide(owner, 'Lost with the folder, one.');
    await decide(owner, 'Lost with the folder, two.');
    const wrote = seqOf(owner, owner.replicaId);
    // A copy of the studio's copy, unzipped over the owner's folder on the owner's machine.
    const recovered = carry(studio, 'owner', owner.machine, owner.root);
    const report = await recover(recovered, [studio], { members: ['Darryl'] });
    expect(report.data!.lost).toMatchObject({
      count: wrote - received,
      first: received + 1,
      last: wrote,
    });
  }, 240000);

  it("a registry restored with the store can only say changes may be lost, and the owner copy's sync routes to recovery", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    const restore = await backUp(fixture.tmp, owner, { machine: true });
    await decide(owner, 'Synced after the backup.');
    await syncCopies(fixture.tmp, studio, owner);
    restore();
    const halted = await exchange(copyPeer(fixture.tmp, studio), copyPeer(fixture.tmp, owner));
    expect(halted.error).toMatchObject({
      code: 'RECORD_AUTHORITY_DIFFERS',
      suggestion: expect.stringMatching(/reasonbook recover/),
    });
    const report = await recover(owner, [studio], { members: ['Darryl'] });
    expect(report.data!.lost).toMatchObject({
      count: null,
      summary: expect.stringMatching(/may be lost/),
    });
    const authority = { ...owner, replicaId: report.data!.authority };
    await confirmAndSync(studio, authority);
    expect(recordedState(studio)).toEqual(recordedState(authority));
  }, 240000);
});

describe('what follows a recovery (s96-m13 build-time critics)', () => {
  it("a member's write under a row the new owner copy quarantines is quarantined with it, and every sync goes on", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    const recovered = carry(studio, 'recovered', 'machine-new');
    const report = await recover(recovered, [studio], { members: ['Darryl'] });
    const authority = { ...recovered, replicaId: report.data!.authority };
    // The old owner copy was only offline: it adds a mission, and the studio, not yet told, syncs.
    useMachine(fixture.tmp, owner.machine);
    const added = await call('rbook_mission', {
      action: 'add',
      missionId: 'o-m01',
      name: 'Old owner',
      projectRoot: owner.root,
    });
    expect(added.success).toBe(true);
    await syncCopies(fixture.tmp, studio, owner);
    await decide(studio, 'Darryl, under the old owner mission.', { missionId: 'o-m01' });
    // ADR s96 §5: a dependent of a quarantined change is quarantined, so it is never made live
    // without the row it names, and the next syncs do not fail on it.
    await confirmAndSync(studio, authority);
    await syncCopies(fixture.tmp, studio, authority);
    for (const copy of [authority, studio]) {
      expect(stateOf(copy, 'Darryl, under the old owner mission.')).toEqual(['quarantined']);
      expect(read(copy, "SELECT id FROM missions WHERE id = 'o-m01'")).toEqual([]);
    }
    expect(recordedState(studio)).toEqual(recordedState(authority));
  }, 360000);

  it('a join whose invite the recovery never saw either waits for the member to be invited again, then re-identifies', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    // Erin is invited and joins after the studio last synced: only the lost owner copy and Erin hold either.
    const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
    await decide(erin, 'Erin, unseen.');
    await syncCopies(fixture.tmp, erin, owner);
    const recovered = carry(studio, 'recovered', 'machine-new');
    const report = await recover(recovered, [studio], { members: ['Darryl'] });
    const authority = { ...recovered, replicaId: report.data!.authority };
    const caught = await syncCopies(fixture.tmp, erin, authority);
    expect(caught.caughtUp).toBeDefined();
    await on(erin, (client) => confirmOwner(client));
    const waits = await exchange(copyPeer(fixture.tmp, erin), copyPeer(fixture.tmp, authority));
    expect(waits.error).toMatchObject({
      message: expect.stringMatching(/^Erin was invited after the cut of the recovery/),
      suggestion: expect.stringMatching(/rbook_project\(action="invite", name="Erin"\)/),
    });
    await on(authority, (client) => inviteMember(client, { name: 'Erin' }));
    const back = await exchange(copyPeer(fixture.tmp, erin), copyPeer(fixture.tmp, authority));
    expect(back.data?.reidentified).toMatchObject({ reason: 'unseen', from: erin.replicaId });
    const successor = { ...erin, replicaId: back.data!.reidentified!.to };
    await syncCopies(fixture.tmp, successor, authority);
    expect(stateOf(authority, 'Erin, unseen.')).toEqual(['quarantined']);
    expect(recordedState(successor)).toEqual(recordedState(authority));
  }, 360000);

  it("the recovered owner copy writes as the owner, whichever member's copy it was made from", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    const [{ name: ownerName }] = read<{ name: string }>(
      owner,
      "SELECT author_name AS name FROM record_changes WHERE kind = 'baseline'"
    );
    const recovered = carry(studio, 'recovered', 'machine-new');
    // The person running the recovery goes by another name on this machine.
    writeUserAuthor('Ops');
    const report = await recover(recovered, [studio], { members: ['Darryl'] });
    const authority = { ...recovered, replicaId: report.data!.authority };
    await decide(authority, 'Written on the recovered owner copy.');
    expect(
      read(authority, "SELECT author_name FROM record_changes WHERE kind = 'authority'")
    ).toEqual([{ author_name: ownerName }]);
    expect(
      read(authority, 'SELECT author_name FROM strategic_decisions WHERE decision_text = ?', [
        'Written on the recovered owner copy.',
      ])
    ).toEqual([{ author_name: ownerName }]);
    expect(ownerName).not.toBe('Darryl');
  }, 360000);

  it('a dropped copy whose channel closed as it took a successor is given a fresh one, not the one the drop cut', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await decide(studio, 'Synced.');
    await syncCopies(fixture.tmp, studio, owner);
    const restore = await backUp(fixture.tmp, studio, { machine: true });
    await decide(studio, 'Synced after the backup.');
    await syncCopies(fixture.tmp, studio, owner);
    restore();
    // The channel closes as the restored copy takes its successor: the owner's copy holds it untaken.
    const real = copyPeer(fixture.tmp, studio);
    const dropping: Peer = {
      ...real,
      takeSuccessor: async () => {
        throw new Error('the channel closed');
      },
    };
    await expect(exchange(dropping, copyPeer(fixture.tmp, owner))).rejects.toThrow(
      /the channel closed/
    );
    // The owner's machine is lost. A copy of its folder recovers it with Darryl dropped, and the drop
    // cuts the untaken successor with the copy it was admitted for.
    const recovered = carry(owner, 'recovered', 'machine-new');
    const report = await recover(recovered, [], { members: ['Darryl'], drop: ['Darryl'] });
    expect(report.success).toBe(true);
    const authority = { ...recovered, replicaId: report.data!.authority };
    const back = await confirmAndSync(studio, authority);
    expect(back.reidentified).toMatchObject({ reason: 'cut' });
    // Given the cut one, its next write was quarantined and the sync after it re-identified again.
    await decide(studio, 'Darryl, after taking the new identity.');
    const next = await syncCopies(fixture.tmp, studio, authority);
    expect(next.reidentified).toBeUndefined();
    expect(stateOf(recovered, 'Darryl, after taking the new identity.')).toEqual([]);
    expect(recordedState(studio)).toEqual(recordedState(recovered));
  }, 360000);

  it('a member copy whose folder was replaced while the owner copy moved takes the catch-up, then re-identifies and says what it lost', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await decide(studio, 'Synced.');
    await syncCopies(fixture.tmp, studio, owner);
    const restore = await backUp(fixture.tmp, studio);
    await decide(studio, 'Sent before the folder was replaced.');
    await syncCopies(fixture.tmp, studio, owner);
    const received = seqOf(owner, studio.replicaId);
    await decide(studio, 'Never sent.');
    const wrote = seqOf(studio, studio.replicaId);
    restore();
    // The owner's machine is lost, and a copy of its folder recovers the record.
    const recovered = carry(owner, 'recovered', 'machine-new');
    const report = await recover(recovered, [studio], { members: ['Darryl'] });
    expect(report.error).toBeUndefined();
    const authority = { ...recovered, replicaId: report.data!.authority };
    // Held on the studio's copy until it confirms the move, then written there by the confirmation.
    await decide(recovered, 'Written by the recovered owner copy.');
    // The copy check refuses the replaced folder's own writes, and a catch-up writes none of them:
    // refused it too, the copy could neither catch up nor re-identify, which needs the move.
    const back = await confirmAndSync(studio, authority);
    expect(back.reidentified).toMatchObject({
      reason: 'restored',
      count: wrote - received,
      first: received + 1,
      last: wrote,
    });
    expect(recordedState(studio)).toEqual(recordedState(recovered));
    expect(
      read(studio, 'SELECT 1 FROM strategic_decisions WHERE decision_text = ?', [
        'Written by the recovered owner copy.',
      ])
    ).toHaveLength(1);
    expect(stateOf(recovered, 'Sent before the folder was replaced.')).toEqual([]);
    expect(
      read(studio, 'SELECT 1 FROM strategic_decisions WHERE decision_text = ?', [
        'Sent before the folder was replaced.',
      ])
    ).toHaveLength(1);
  }, 360000);

  it('a recovery that stopped after taking its new identity runs again', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    const recovered = carry(studio, 'recovered', 'machine-new');
    const cut = { ...copyPeer(fixture.tmp, studio) };
    const dropping = {
      ...cut,
      changesSince: async () => {
        throw new Error('the channel closed');
      },
    };
    useMachine(fixture.tmp, recovered.machine);
    await expect(
      recoverAuthority(
        (step) => onCopy(fixture.tmp, recovered, step, { replicaCheck: false }),
        [dropping],
        { members: ['Darryl'] }
      )
    ).rejects.toThrow(/the channel closed/);
    const report = await recover(recovered, [studio], { members: ['Darryl'] });
    expect(report.success).toBe(true);
    const authority = { ...recovered, replicaId: report.data!.authority };
    await confirmAndSync(studio, authority);
    expect(recordedState(studio)).toEqual(recordedState(authority));
  }, 360000);
});

describe('two moves for one epoch', () => {
  it('a handover and a recovery that each name a next owner copy are a fork: shown in the review, never applied', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const next = await joinedCopy(fixture.tmp, owner, 'next', 'Owner');
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, next, owner);
    await syncCopies(fixture.tmp, studio, owner);
    // The owner's machine is thought lost, and a copy of the studio's copy recovers it; the old
    // owner copy, only offline, hands over to the owner's other copy.
    const recovered = carry(studio, 'recovered', 'machine-new');
    const report = await recover(recovered, [studio, next], { members: ['Darryl'] });
    const authority = { ...recovered, replicaId: report.data!.authority };
    await on(owner, (client) => handOver(client, { to: next.replicaId }));
    // The studio takes in each move, one from each copy that names itself the next owner copy.
    expect((await syncCopies(fixture.tmp, studio, owner)).caughtUp).toBeDefined();
    expect((await syncCopies(fixture.tmp, studio, authority)).caughtUp).toBeDefined();
    const ctx = await on(studio, (client) => {
      const merged = mergeContext(client);
      return { epoch: merged.epoch, forks: merged.forks.length, pending: Boolean(merged.pending) };
    });
    expect(ctx).toEqual({ epoch: 1, forks: 2, pending: false });
    expect((await on(studio, (client) => confirmOwner(client))).error?.message).toMatch(
      /for an epoch it holds already, which it never applies/
    );
    const review = await on(studio, (client) => sharedRecordReview(client));
    expect(JSON.stringify(review)).toMatch(/2 move\(s\) of the owner's copy conflict/);
  }, 360000);
});

describe('dependents of a quarantined create, whatever their order (s96-m13 critics, round 2)', () => {
  it('a bundle that carries a dependent before its quarantined create does not wedge the owner copy', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    const recovered = carry(studio, 'recovered', 'machine-new');
    const report = await recover(recovered, [studio], { members: ['Darryl'] });
    const authority = { ...recovered, replicaId: report.data!.authority };
    // The old owner copy was only offline: it joins Erin, whose copy adds a mission, and the studio,
    // not yet told of the recovery, writes under it.
    const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
    useMachine(fixture.tmp, erin.machine);
    expect(
      (
        await call('rbook_mission', {
          action: 'add',
          missionId: 'e-m01',
          name: "Erin's mission",
          projectRoot: erin.root,
        })
      ).success
    ).toBe(true);
    await syncCopies(fixture.tmp, erin, owner);
    await syncCopies(fixture.tmp, studio, owner);
    await decide(studio, "Darryl, under Erin's mission.", { missionId: 'e-m01' });
    expect((await syncCopies(fixture.tmp, studio, authority)).caughtUp).toBeDefined();
    await on(studio, (client) => confirmOwner(client));
    // A bundle applies a transaction at a time; the studio's may sort before Erin's.
    const bundle = await on(studio, (client) => writeBundle(client, {}, localCopyReport()));
    for (const attempt of [1, 2]) {
      const imported = await on(authority, (client) => importBundle(client, bundle));
      expect({ attempt, ok: imported.success }).toEqual({ attempt, ok: true });
    }
    // In clock order the mission is judged first, so the decision takes its quarantine unjudged.
    expect(stateOf(authority, "Darryl, under Erin's mission.")).toEqual(['quarantined']);
    expect(read(authority, "SELECT id FROM missions WHERE id = 'e-m01'")).toEqual([]);
  }, 360000);

  it('a dependent that reaches the owner copy a delivery before its quarantined create waits for it, its verdict standing', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    const recovered = carry(studio, 'recovered', 'machine-new');
    const report = await recover(recovered, [studio], { members: ['Darryl'] });
    const authority = { ...recovered, replicaId: report.data!.authority };
    const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
    useMachine(fixture.tmp, erin.machine);
    expect(
      (
        await call('rbook_mission', {
          action: 'add',
          missionId: 'e-m03',
          name: "Erin's mission",
          projectRoot: erin.root,
        })
      ).success
    ).toBe(true);
    await syncCopies(fixture.tmp, erin, owner);
    await syncCopies(fixture.tmp, studio, owner);
    await decide(studio, "Darryl, ahead of Erin's mission.", { missionId: 'e-m03' });
    expect((await syncCopies(fixture.tmp, studio, authority)).caughtUp).toBeDefined();
    await on(studio, (client) => confirmOwner(client));
    // The studio's own decision is delivered first, alone; everything else after it.
    const marks = await on(authority, (client) => replicaMarks(client));
    const changes = await on(studio, (client) => changesSince(client, marks));
    const own = changes.filter((change) => change.replica_id === studio.replicaId);
    const rest = changes.filter((change) => change.replica_id !== studio.replicaId);
    for (const delivery of [own, rest]) {
      const applied = await on(authority, (client) => applyRemote(client, delivery));
      expect(applied.success).toBe(true);
    }
    expect(stateOf(authority, "Darryl, ahead of Erin's mission.")).toEqual(['held']);
    expect(
      read(authority, 'SELECT id FROM strategic_decisions WHERE decision_text = ?', [
        "Darryl, ahead of Erin's mission.",
      ])
    ).toEqual([]);
  }, 360000);

  it("a re-add that accepts a create another member's write waited on judges that write too", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const erin = await joinedCopy(fixture.tmp, owner, 'erin', 'Erin');
    await syncCopies(fixture.tmp, studio, owner);
    await syncCopies(fixture.tmp, erin, owner);
    const recovered = carry(studio, 'recovered', 'machine-new');
    const report = await recover(recovered, [studio, erin], { members: ['Darryl', 'Erin'] });
    const authority = { ...recovered, replicaId: report.data!.authority };
    // The new owner copy removes Erin; the old one, only offline and not told, accepts her mission,
    // and the studio, not told of the recovery either, writes under it.
    await on(authority, (client) => removeMember(client, 'Erin'));
    useMachine(fixture.tmp, erin.machine);
    expect(
      (
        await call('rbook_mission', {
          action: 'add',
          missionId: 'e-m02',
          name: "Erin's mission",
          projectRoot: erin.root,
        })
      ).success
    ).toBe(true);
    await syncCopies(fixture.tmp, erin, owner);
    await syncCopies(fixture.tmp, studio, owner);
    await decide(studio, "Darryl, under Erin's mission, again.", { missionId: 'e-m02' });
    await confirmAndSync(studio, authority);
    expect(stateOf(authority, "Darryl, under Erin's mission, again.")).toEqual(['quarantined']);
    // Re-adding Erin accepts her mission, and the studio's decision under it is judged with it.
    const readded = await on(authority, (client) => inviteMember(client, { name: 'Erin' }));
    expect(readded.success).toBe(true);
    expect(stateOf(authority, "Darryl, under Erin's mission, again.")).toEqual([]);
    expect(
      read(authority, 'SELECT mission_id FROM strategic_decisions WHERE decision_text = ?', [
        "Darryl, under Erin's mission, again.",
      ])
    ).toEqual([{ mission_id: 'e-m02' }]);
  }, 360000);
});
