// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m14 — what the merge makes of an import: reads keep the record's value until a raised field is settled, an
// ABOUTME: appended field keeps every side's additions through any settle, and the import's marks end with its write.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as changes from '../../../src/tools/rbook/record-changes';
import { recordedExecute } from '../../../src/tools/rbook/record-changes';
import { importText } from '../../../src/cli/import';
import { importCopy } from '../../../src/tools/rbook/record-import';
import { openConflicts, settleField } from '../../../src/tools/rbook/record-settle';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { onFile, onPlace, preShare, zipOf, type Place } from '../../helpers/import-copies';
import {
  joinedCopy,
  onCopy,
  read,
  recordedState,
  shareExisting,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-import-merge-');
});
afterEach(() => fixture.restore());

const on = (place: Place, tool: string, args: Record<string, unknown>) =>
  onPlace(fixture.tmp, place, tool, args);
const importInto = (target: Copy, from: Place, apply = false) =>
  onCopy(fixture.tmp, target, (client) => importCopy(client, from.root, { apply }));
/** Each copy's open conflicts, by field: a copy orders them by when it found each. */
const listed = async (copy: Copy) =>
  (await onCopy(fixture.tmp, copy, (client) => openConflicts(client)))
    .map((open) => ({
      field: open.field,
      provisional: open.provisional,
      candidates: open.candidates.map((candidate) => candidate.value),
    }))
    .sort((a, b) => a.field.localeCompare(b.field));
const mission = (copy: Pick<Copy, 'root'>) =>
  read<{ name: string; notes: string | null }>(
    copy,
    "SELECT name, notes FROM missions WHERE id = 'i-m01'"
  )[0];
const setNotes = (place: Place, notes: string) =>
  on(place, 'rbook_mission', { action: 'update', missionId: 'i-m01', fields: { notes } });

describe('a raised field', () => {
  it("reads as the shared record's value on every copy until it is settled, and then as the value kept", async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const applied = await importInto(owner, zip, true);
    expect(applied.data?.applied).toMatchObject({ conflicts: 1 });
    await syncCopies(fixture.tmp, studio, owner);
    for (const copy of [owner, studio]) {
      expect(mission(copy).name).toBe('Before the copy');
      expect(await listed(copy)).toEqual([
        {
          field: 'name',
          provisional: 'Before the copy',
          candidates: ['Before the copy', 'Renamed on the copy'],
        },
      ]);
    }
    await onCopy(fixture.tmp, studio, (client) =>
      settleField(client, {
        table: 'missions',
        recordId: 'i-m01',
        field: 'name',
        value: 'Renamed on the copy',
      })
    );
    await syncCopies(fixture.tmp, studio, owner);
    expect([mission(owner).name, mission(studio).name]).toEqual([
      'Renamed on the copy',
      'Renamed on the copy',
    ]);
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 300000);
});

describe('a raised field the record changed after sharing', () => {
  for (const withBase of [false, true])
    it(`reads as the record's own newest value on every copy until it is settled (${withBase ? 'with' : 'no'} base)`, async () => {
      const place = await preShare(fixture.tmp, { base: withBase });
      const zip = zipOf(fixture.tmp, place);
      await on(zip, 'rbook_mission', {
        action: 'update',
        missionId: 'i-m01',
        fields: { name: 'Renamed on the copy' },
      });
      const owner = await shareExisting(fixture.tmp, place.root);
      const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
      await on(owner, 'rbook_mission', {
        action: 'update',
        missionId: 'i-m01',
        fields: { name: 'Renamed by the owner after sharing' },
      });
      expect((await importInto(owner, zip, true)).data?.applied).toMatchObject({ conflicts: 1 });
      await syncCopies(fixture.tmp, studio, owner);
      for (const copy of [owner, studio]) {
        expect(mission(copy).name).toBe('Renamed by the owner after sharing');
        expect((await listed(copy)).find((open) => open.field === 'name')).toMatchObject({
          provisional: 'Renamed by the owner after sharing',
          candidates: ['Renamed by the owner after sharing', 'Renamed on the copy'],
        });
      }
      expect(recordedState(studio)).toEqual(recordedState(owner));
    }, 300000);
});

describe("a raised field beside two of the record's own concurrent writes", () => {
  it("reads as the record's newest own value, the import's never provisional, on every copy", async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await on(owner, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the owner' },
    });
    await on(studio, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the studio' },
    });
    await importInto(owner, zip, true);
    await syncCopies(fixture.tmp, studio, owner);
    await syncCopies(fixture.tmp, studio, owner);
    const newest = read<{ value: string }>(
      owner,
      "SELECT value FROM record_changes WHERE field = 'name' AND kind = 'set' AND base NOT LIKE '%import%' ORDER BY hlc DESC, change_id DESC LIMIT 1"
    )[0].value;
    for (const copy of [owner, studio]) {
      expect(JSON.stringify(mission(copy).name)).toBe(newest);
      expect((await listed(copy)).find((open) => open.field === 'name')?.provisional).toBe(
        JSON.parse(newest)
      );
    }
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 300000);
});

describe('an appended field', () => {
  for (const keep of ['Original.', 'Copy rewrote.'])
    it(`rewritten on the copy and added to after sharing: settling it to ${JSON.stringify(keep)} keeps the record's addition on every copy`, async () => {
      const place = await preShare(fixture.tmp, {});
      await setNotes(place, 'Original.');
      const zip = zipOf(fixture.tmp, place);
      await setNotes(zip, 'Copy rewrote.');
      const owner = await shareExisting(fixture.tmp, place.root);
      const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
      await setNotes(owner, 'Original. Added after sharing.');
      expect((await importInto(owner, zip, true)).data?.applied).toMatchObject({ conflicts: 1 });
      // Reads keep the record's notes, its addition among them, until they are settled.
      expect(mission(owner).notes).toBe('Original. Added after sharing.');
      await syncCopies(fixture.tmp, studio, owner);
      expect(mission(studio).notes).toBe('Original. Added after sharing.');
      await onCopy(fixture.tmp, owner, (client) =>
        settleField(client, { table: 'missions', recordId: 'i-m01', field: 'notes', value: keep })
      );
      await syncCopies(fixture.tmp, studio, owner);
      expect(mission(owner).notes).toBe(`${keep} Added after sharing.`);
      expect(recordedState(studio)).toEqual(recordedState(owner));
    }, 300000);

  it("added to on the copy: the copy's addition follows the record's, once, with no conflict", async () => {
    const place = await preShare(fixture.tmp, {});
    await setNotes(place, 'Original.');
    const zip = zipOf(fixture.tmp, place);
    await setNotes(zip, 'Original. Added on the copy.');
    const owner = await shareExisting(fixture.tmp, place.root);
    await setNotes(owner, 'Original. Added after sharing.');
    const dry = await importInto(owner, zip);
    const missions = dry.data!.tables.find((table) => table.table === 'missions')!;
    expect(missions.conflicts).toEqual([]);
    expect(missions.copyChanged).toEqual([
      expect.objectContaining({
        field: 'notes',
        write: 'Original. Added after sharing. Added on the copy.',
      }),
    ]);
    // The dry run shows what applying writes, the record's addition first.
    expect(importText(dry.data!)).toMatch(
      /notes: the copy holds .*; applying writes "Original\. Added after sharing\./
    );
    expect((await importInto(owner, zip, true)).data?.applied).toMatchObject({
      set: 1,
      conflicts: 0,
    });
    expect(mission(owner).notes).toBe('Original. Added after sharing. Added on the copy.');
    // Brought in again, the addition is the record's already.
    expect((await importInto(owner, zip, true)).data?.applied).toMatchObject({ set: 0 });
    expect(mission(owner).notes).toBe('Original. Added after sharing. Added on the copy.');
  }, 300000);

  it("whose copy text only extends the record's: written as an addition, with no conflict", async () => {
    const place = await preShare(fixture.tmp, {});
    await setNotes(place, 'Original.');
    const zip = zipOf(fixture.tmp, place);
    await setNotes(zip, 'Original. Copy appended.');
    const owner = await shareExisting(fixture.tmp, place.root);
    expect((await importInto(owner, zip, true)).data?.applied).toMatchObject({
      set: 1,
      conflicts: 0,
    });
    expect(
      read(
        owner,
        "SELECT kind, base FROM record_changes WHERE field = 'notes' ORDER BY replica_seq"
      )
    ).toEqual([{ kind: 'append', base: '[]' }]);
    expect(mission(owner).notes).toBe('Original. Copy appended.');
    expect(read(owner, 'SELECT * FROM record_conflicts')).toEqual([]);
  }, 300000);
});

describe('a settle of appended text in any conflict', () => {
  it('keeping the rewrite that had not applied an addition keeps the addition after it, on both copies', async () => {
    const place = await preShare(fixture.tmp, {});
    await setNotes(place, 'Original.');
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await setNotes(owner, 'Original. Added on the owner.');
    await setNotes(owner, 'Rewritten by the owner.');
    await setNotes(studio, 'Rewritten by the member.');
    await syncCopies(fixture.tmp, studio, owner);
    await onCopy(fixture.tmp, owner, (client) =>
      settleField(client, {
        table: 'missions',
        recordId: 'i-m01',
        field: 'notes',
        value: 'Rewritten by the member.',
      })
    );
    await syncCopies(fixture.tmp, studio, owner);
    for (const copy of [owner, studio])
      expect(mission(copy).notes).toBe('Rewritten by the member. Added on the owner.');
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 300000);
});

describe('appended items and a record that removed an addition', () => {
  const capturesOf = (copy: Pick<Copy, 'root'>, id: string) =>
    (
      JSON.parse(
        read<{ captures: string }>(copy, 'SELECT captures FROM sessions WHERE id = ?', [id])[0]
          .captures
      ) as Array<{ content: string }>
    ).map((item) => item.content);
  const item = (content: string) =>
    JSON.stringify({
      type: 'context',
      content,
      timestamp: '2026-10-01T00:00:00.000Z',
      missionId: 'i-m01',
    });

  for (const withBase of [false, true])
    it(`captures: both sides' items kept, the record's first, and an item the record later removed not brought again (${withBase ? 'with' : 'no'} base)`, async () => {
      const place = await preShare(fixture.tmp, {});
      await on(place, 'rbook_session', {
        action: 'capture',
        category: 'context',
        content: 'Before the copy.',
        missionId: 'i-m01',
      });
      if (withBase) await on(place, 'rbook_db', { action: 'snapshot' });
      const [session] = read<{ id: string }>(place, 'SELECT id FROM sessions');
      const zip = zipOf(fixture.tmp, place);
      onFile(
        zip,
        `UPDATE sessions SET captures = json_insert(captures, '$[#]', json('${item('Copy note.')}')) WHERE id = '${session.id}'`
      );
      const owner = await shareExisting(fixture.tmp, place.root);
      await onCopy(fixture.tmp, owner, (client) =>
        recordedExecute(
          client,
          "UPDATE sessions SET captures = json_insert(captures, '$[#]', json(?)) WHERE id = ?",
          [item('Owner note.'), session.id]
        )
      );
      expect((await importInto(owner, zip, true)).data?.applied).toMatchObject({
        set: 1,
        conflicts: 0,
      });
      expect(capturesOf(owner, session.id)).toEqual([
        'Before the copy.',
        'Owner note.',
        'Copy note.',
      ]);
      // The record removes the copy's item, with a rewrite that saw it.
      const kept = (
        JSON.parse(
          read<{ captures: string }>(owner, 'SELECT captures FROM sessions WHERE id = ?', [
            session.id,
          ])[0].captures
        ) as Array<{ content: string }>
      ).filter((entry) => entry.content !== 'Copy note.');
      await onCopy(fixture.tmp, owner, (client) =>
        recordedExecute(client, 'UPDATE sessions SET captures = ? WHERE id = ?', [
          JSON.stringify(kept),
          session.id,
        ])
      );
      const sessions = (await importInto(owner, zip)).data!.tables.find(
        (table) => table.table === 'sessions'
      )!;
      expect(sessions.copyChanged).toEqual([]);
      expect(sessions.conflicts).toEqual([]);
    }, 300000);

  it('notes: an addition the record later rewrote away is not brought again', async () => {
    const place = await preShare(fixture.tmp, {});
    await setNotes(place, 'Original.');
    const zip = zipOf(fixture.tmp, place);
    await setNotes(zip, 'Original. Copy added.');
    const owner = await shareExisting(fixture.tmp, place.root);
    await setNotes(owner, 'Original. Owner added.');
    await importInto(owner, zip, true);
    await setNotes(owner, 'Original. Owner added.');
    const missions = (await importInto(owner, zip)).data!.tables.find(
      (table) => table.table === 'missions'
    )!;
    expect(missions.copyChanged).toEqual([]);
    expect(missions.conflicts).toEqual([]);
  }, 300000);
});

describe('a flag', () => {
  for (const [atSharing, onTheCopy] of [
    [true, false],
    [false, true],
  ] as const)
    it(`${atSharing ? 'set' : 'clear'} in the record and ${onTheCopy ? 'set' : 'cleared'} on the copy, with no base: never raised, an added flag winning and a cleared one listed`, async () => {
      const place = await preShare(fixture.tmp, {});
      const learned = await on(place, 'rbook_session', {
        action: 'capture',
        category: 'learning',
        content: 'A lesson from before the copy.',
        missionId: 'i-m01',
      });
      const learningId = learned.data?.learningId as number;
      await on(place, 'rbook_learnings', { action: 'update', learningId, evergreen: !onTheCopy });
      const zip = zipOf(fixture.tmp, place);
      await on(zip, 'rbook_learnings', { action: 'update', learningId, evergreen: onTheCopy });
      await on(place, 'rbook_learnings', { action: 'update', learningId, evergreen: atSharing });
      const owner = await shareExisting(fixture.tmp, place.root);
      const learnings = (await importInto(owner, zip)).data!.tables.find(
        (table) => table.table === 'learnings'
      )!;
      expect(learnings.conflicts.map((change) => change.field)).not.toContain('evergreen');
      if (onTheCopy)
        expect(learnings.copyChanged.map((change) => change.field)).toContain('evergreen');
      else expect(learnings.flagKept.map((change) => change.field)).toEqual(['evergreen']);
      await importInto(owner, zip, true);
      expect(
        Boolean(
          read<{ evergreen: number }>(owner, 'SELECT evergreen FROM learnings WHERE id = ?', [
            learningId,
          ])[0].evergreen
        )
      ).toBe(true);
    }, 300000);
});

describe("the import's marks", () => {
  it('end with its write, even one that fails, so a later write through the same client keeps its own base', async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    onFile(zip, "UPDATE sprints SET title = 'Retitled on the copy'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const real = changes.markImportSet;
    let marked = 0;
    const spy = jest.spyOn(changes, 'markImportSet').mockImplementation((...args) => {
      real(...args);
      // The second raised field fails its write once the first is marked.
      if ((marked += 1) === 2) throw new Error('the write failed after a mark');
    });
    await onCopy(fixture.tmp, owner, async (client) => {
      const failed = await importCopy(client, zip.root, { apply: true });
      expect(failed.error?.message).toMatch(/the write failed after a mark/);
      spy.mockRestore();
      for (const sql of [
        "UPDATE missions SET name = 'Renamed later' WHERE id = 'i-m01'",
        "UPDATE sprints SET title = 'Retitled later'",
      ])
        expect(recordedExecute(client, sql).success).toBe(true);
    });
    expect(
      read<{ base: string }>(owner, "SELECT base FROM record_changes WHERE kind = 'set'").map(
        (change) => change.base.includes('import')
      )
    ).toEqual([false, false]);
  }, 300000);
});

describe("the root's candidate", () => {
  it('reads as the merge reads it on every copy, whichever deliveries brought the create and the import', async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'y-m01',
      name: "The copy's y",
      sprintId: 'i-sprint',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const third = await joinedCopy(fixture.tmp, owner, 'third', 'Third');
    const fourth = await joinedCopy(fixture.tmp, owner, 'fourth', 'Fourth');
    await on(third, 'rbook_mission', {
      action: 'add',
      missionId: 'y-m01',
      name: "The third's y",
      sprintId: 'i-sprint',
    });
    await syncCopies(fixture.tmp, third, owner);
    await syncCopies(fixture.tmp, studio, owner);
    await importInto(studio, zip, true);
    await syncCopies(fixture.tmp, studio, owner);
    // The fourth copy takes the third's create and the studio's import in one delivery.
    await syncCopies(fixture.tmp, fourth, owner);
    await syncCopies(fixture.tmp, third, owner);
    const expected = await listed(owner);
    expect(expected.find((open) => open.field === 'name')).toEqual({
      field: 'name',
      provisional: "The third's y",
      candidates: ["The third's y", "The copy's y"],
    });
    for (const copy of [studio, third, fourth]) expect(await listed(copy)).toEqual(expected);
    expect(recordedState(fourth)).toEqual(recordedState(owner));
  }, 300000);
});

describe('a field already in conflict in the record', () => {
  it('is left alone and named, and the rest of the copy still comes in', async () => {
    const place = await preShare(fixture.tmp, {});
    const one = zipOf(fixture.tmp, place, 'one');
    const two = zipOf(fixture.tmp, place, 'two');
    // Two copies of one project on one machine: written as files, since only one registers.
    onFile(one, "UPDATE missions SET name = 'Renamed on one' WHERE id = 'i-m01'");
    onFile(
      two,
      "UPDATE missions SET name = 'Renamed on two' WHERE id = 'i-m01'",
      "UPDATE sprints SET title = 'Retitled on two'"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, one, true);
    const dry = await importInto(owner, two);
    expect(dry.error).toBeUndefined();
    const missions = dry.data!.tables.find((table) => table.table === 'missions')!;
    expect(missions.inConflict).toEqual([
      expect.objectContaining({ field: 'name', copy: 'Renamed on two' }),
    ]);
    expect(missions.conflicts).toEqual([]);
    const applied = await importInto(owner, two, true);
    expect(applied.error).toBeUndefined();
    expect(applied.data?.applied).toMatchObject({ conflicts: 1 });
    expect((await listed(owner)).map((open) => open.field).sort()).toEqual(['name', 'title']);
  }, 300000);
});
