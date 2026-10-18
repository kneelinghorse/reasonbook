// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m14 (ADR s96 §9) — a copy made before sharing, brought in: each constructed case classifies exactly against
// ABOUTME: the base and the marker, the copy's own rows land in the importer's block, and a raised field keeps both values.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { importText } from '../../../src/cli/import';
import { importCopy, type ImportReport } from '../../../src/tools/rbook/record-import';
import type { TablePlan } from '../../../src/tools/rbook/record-import-plan';
import { openConflicts, settleField } from '../../../src/tools/rbook/record-settle';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import {
  oldCopyOf as oldCopy,
  onFile,
  onPlace,
  preShare,
  zipOf as zipOfFolder,
  type Place as ImportPlace,
} from '../../helpers/import-copies';
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
  fixture = replicaFixture('rbook-import-');
});
afterEach(() => fixture.restore());

type Place = ImportPlace;
const on = (place: Place, tool: string, args: Record<string, unknown>) =>
  onPlace(fixture.tmp, place, tool, args);
const before = (options: { base?: boolean; marker?: boolean } = {}) =>
  preShare(fixture.tmp, options);
const zipOf = (from: Place, name = 'zip') => zipOfFolder(fixture.tmp, from, name);
const oldCopyOf = (from: Place, schema: string) => oldCopy(fixture.tmp, from, schema);

async function importInto(
  target: Copy,
  from: Place,
  options: Parameters<typeof importCopy>[2] = {}
) {
  return onCopy(fixture.tmp, target, (client) => importCopy(client, from.root, options));
}

const table = (report: ImportReport | undefined, name: string): TablePlan =>
  report!.tables.find((entry) => entry.table === name)!;

const missionName = (copy: Place, id: string) =>
  read<{ name: string }>(copy, 'SELECT name FROM missions WHERE id = ?', [id])[0]?.name;

describe('a field against the base both folders hold', () => {
  it('only the owner changed it: the record keeps its value, and nothing is written', async () => {
    const place = await before({ base: true });
    const zip = zipOf(place);
    const owner = await shareExisting(fixture.tmp, place.root);
    await on(owner, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the owner' },
    });
    const dry = await importInto(owner, zip);
    expect(dry.data?.base).toMatch(/snapshot-/);
    expect(table(dry.data, 'missions')).toMatchObject({
      ownerChanged: 1,
      copyChanged: [],
      conflicts: [],
    });
    const applied = await importInto(owner, zip, { apply: true });
    expect(applied.data?.applied).toMatchObject({ created: 0, set: 0, conflicts: 0 });
    expect(missionName(owner, 'i-m01')).toBe('Renamed on the owner');
  }, 120000);

  it("only the copy changed it: the copy's value is set, with no conflict", async () => {
    const place = await before({ base: true });
    const zip = zipOf(place);
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    expect(table(dry.data, 'missions').copyChanged).toEqual([
      expect.objectContaining({ id: 'i-m01', field: 'name', copy: 'Renamed on the copy' }),
    ]);
    expect(table(dry.data, 'missions').conflicts).toEqual([]);
    await importInto(owner, zip, { apply: true });
    expect(missionName(owner, 'i-m01')).toBe('Renamed on the copy');
    expect(read(owner, 'SELECT * FROM record_conflicts')).toEqual([]);
  }, 120000);

  it("both changed it before sharing: the baseline value and the copy's both stand, on every copy, until settled", async () => {
    const place = await before({ base: true });
    const zip = zipOf(place);
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    // The owner's change comes before sharing, so the baseline holds it and no change records it.
    await on(place, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the owner' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const dry = await importInto(owner, zip);
    expect(table(dry.data, 'missions').conflicts).toEqual([
      expect.objectContaining({
        field: 'name',
        copy: 'Renamed on the copy',
        owner: 'Renamed on the owner',
      }),
    ]);
    await importInto(owner, zip, { apply: true });
    // A local set naming no head replaces a root; the import's names its base as unseen instead.
    const conflicts = await onCopy(fixture.tmp, owner, (client) => openConflicts(client));
    // Reads keep the shared record's value until the field is settled.
    expect(missionName(owner, 'i-m01')).toBe('Renamed on the owner');
    expect(conflicts.map((open) => open.provisional)).toEqual(['Renamed on the owner']);
    expect(conflicts.map((open) => open.candidates.map((candidate) => candidate.value))).toEqual([
      ['Renamed on the owner', 'Renamed on the copy'],
    ]);
    await syncCopies(fixture.tmp, studio, owner);
    const there = await onCopy(fixture.tmp, studio, (client) => openConflicts(client));
    expect(missionName(studio, 'i-m01')).toBe('Renamed on the owner');
    expect(there.map((open) => open.candidates.map((candidate) => candidate.value))).toEqual([
      ['Renamed on the owner', 'Renamed on the copy'],
    ]);
    // The record's own value can be kept, and the settle ends both on every copy.
    await onCopy(fixture.tmp, owner, (client) =>
      settleField(client, {
        table: 'missions',
        recordId: 'i-m01',
        field: 'name',
        value: 'Renamed on the owner',
      })
    );
    await syncCopies(fixture.tmp, studio, owner);
    expect(missionName(studio, 'i-m01')).toBe('Renamed on the owner');
    expect(read(studio, 'SELECT * FROM record_conflicts')).toEqual([]);
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 240000);

  it('applying plans again: a write that lands after the dry run is raised, not overwritten', async () => {
    const place = await before({ base: true });
    const zip = zipOf(place);
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    expect(table(dry.data, 'missions').copyChanged).toHaveLength(1);
    // Between the dry run and --apply, the record's own copy renames the mission too.
    await on(owner, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the owner, later' },
    });
    const applied = await importInto(owner, zip, { apply: true });
    expect(applied.data?.applied).toMatchObject({ set: 0, conflicts: 1 });
    const conflicts = await onCopy(fixture.tmp, owner, (client) => openConflicts(client));
    expect(conflicts.map((open) => open.candidates.map((candidate) => candidate.value))).toEqual([
      ['Renamed on the owner, later', 'Renamed on the copy'],
    ]);
  }, 120000);

  it('neither changed it: every row is as the record holds it, and the copy is recommended for archiving', async () => {
    const place = await before({ base: true });
    const zip = zipOf(place);
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    for (const entry of dry.data!.tables)
      expect(entry).toMatchObject({
        identical: entry.copyRows,
        ownerChanged: 0,
        copyChanged: [],
        conflicts: [],
        own: [],
        deletedOnOwner: [],
      });
    expect(dry.data).toMatchObject({ ownRows: 0, differing: 0, applied: null });
    expect(importText(dry.data!)).toMatch(
      /This copy holds nothing the record does not hold, so nothing needs bringing in: archive it/
    );
  }, 120000);
});

describe("the copy's own rows", () => {
  it("a decision whose number the record holds for other text is the copy's own, and takes a number in the importer's block", async () => {
    const place = await before({ marker: true });
    const zip = zipOf(place);
    await on(place, 'rbook_decisions', { action: 'record', content: "The owner's second." });
    await on(zip, 'rbook_decisions', { action: 'record', content: "The copy's second." });
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const dry = await importInto(studio, zip);
    const decisions = table(dry.data, 'strategic_decisions');
    expect(decisions.own.map((row) => row.values.decision_text)).toEqual(["The copy's second."]);
    expect(decisions.ownerOnly).toBe(1);
    const applied = await importInto(studio, zip, { apply: true });
    expect(applied.error).toBeUndefined();
    const number = applied.data!.applied!.renamed[`strategic_decisions:${decisions.own[0].id}`];
    expect(Number(number)).toBeGreaterThan(1000000);
    expect(
      read(studio, 'SELECT decision_text, author_name FROM strategic_decisions WHERE id = ?', [
        Number(number),
      ])
    ).toEqual([{ decision_text: "The copy's second.", author_name: 'Darryl' }]);
    expect(
      read(studio, 'SELECT decision_text FROM strategic_decisions WHERE id = ?', [
        decisions.own[0].id,
      ])
    ).toEqual([{ decision_text: "The owner's second." }]);
  }, 240000);

  it("a mission id created on both copies after the copy was made takes <id>~i<block> for the copy's", async () => {
    const place = await before({ marker: true });
    const zip = zipOf(place);
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: "The owner's",
      sprintId: 'i-sprint',
    });
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: "The copy's",
      sprintId: 'i-sprint',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const dry = await importInto(studio, zip);
    expect(table(dry.data, 'missions')).toMatchObject({
      createdOnBoth: ['i-m02'],
      conflicts: [],
    });
    await importInto(studio, zip, { apply: true });
    expect(missionName(studio, 'i-m02')).toBe("The owner's");
    expect(missionName(studio, `i-m02~i${studio.block}`)).toBe("The copy's");
  }, 240000);

  it('a row the owner deleted after the copy was made is labelled, left out, and brought in only on --include', async () => {
    const place = await before({});
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    await on(place, 'rbook_context', { action: 'snapshot', source: 'before the copy' });
    const zip = zipOf(place);
    onFile(place, "DELETE FROM missions WHERE id = 'i-m03'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const dry = await importInto(studio, zip);
    expect(table(dry.data, 'missions')).toMatchObject({
      own: [],
      deletedOnOwner: [expect.objectContaining({ id: 'i-m03' })],
    });
    expect(
      (await importInto(studio, zip, { include: ['missions:i-m99'] })).error?.validValues
    ).toEqual(['missions:i-m03']);
    // A row the record holds already needs nothing, so naming it is no mistake.
    expect((await importInto(studio, zip, { include: ['missions:i-m01'] })).error).toBeUndefined();
    await importInto(studio, zip, { apply: true });
    expect(missionName(studio, 'i-m03')).toBeUndefined();
    await importInto(studio, zip, { apply: true, include: ['missions:i-m03'] });
    expect(missionName(studio, 'i-m03')).toBe('Deleted on the owner');
  }, 240000);
});

describe('copies from older schemas', () => {
  it('a copy made before its firehose migration matches every row by natural key', async () => {
    const place = await before({});
    // Schema 2.1 holds every shared table and no stable id: the schema step mints ids that never match.
    const zip = oldCopyOf(place, 'schema-2.1.sql');
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    for (const entry of dry.data!.tables)
      expect(entry).toMatchObject({ own: [], conflicts: [], copyChanged: [], ownerOnly: 0 });
    expect(dry.data?.ownRows).toBe(0);
  }, 120000);

  it('an unmigrated old copy, lacking whole tables and columns, compares only what it held', async () => {
    const place = await before({});
    const zip = oldCopyOf(place, 'schema-2025-12.sql');
    // The owner's later decision status reaches no conflict: the copy never had the column.
    onFile(place, "UPDATE strategic_decisions SET status = 'archived'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    for (const name of ['learnings', 'next_steps', 'constraints', 'session_missions'])
      expect(table(dry.data, name)).toMatchObject({ absent: true, own: [] });
    expect(table(dry.data, 'strategic_decisions')).toMatchObject({
      lacked: expect.arrayContaining(['status', 'superseded_by', 'category']),
      conflicts: [],
    });
  }, 120000);

  it("a column renamed since the copy was made is compared under its new name, with the copy's value", async () => {
    const place = await before({});
    const zip = zipOf(place);
    await on(zip, 'rbook_session', { action: 'start', title: 'On the copy' });
    const [{ id: session }] = read<{ id: string }>(
      zip,
      'SELECT id FROM sessions ORDER BY julianday(started_at) DESC, id DESC LIMIT 1'
    );
    // The copy keeps the old name with its migration marker set, so the share step adds the new
    // name empty beside it: the copy's value is still the one under the old name.
    onFile(
      zip,
      'PRAGMA foreign_keys = OFF',
      'ALTER TABLE strategic_decisions RENAME COLUMN author_session_id TO session_id',
      `UPDATE strategic_decisions SET session_id = '${session}'`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const decisions = table((await importInto(owner, zip)).data, 'strategic_decisions');
    expect(decisions.lacked).not.toContain('author_session_id');
    expect(decisions.conflicts).toEqual([
      expect.objectContaining({ field: 'author_session_id', copy: session }),
    ]);
  }, 120000);

  it('a renamed column whose value the record holds is no conflict, and a NULL there is raised against the value', async () => {
    const place = await before({});
    const session = read<{ s: string | null }>(
      place,
      'SELECT author_session_id AS s FROM strategic_decisions WHERE id = 1'
    )[0].s;
    // The decision was recorded in a session, so the record holds one to compare with.
    expect(session).toMatch(/^PS-/);
    const zip = zipOf(place);
    onFile(zip, 'ALTER TABLE strategic_decisions RENAME COLUMN author_session_id TO session_id');
    const owner = await shareExisting(fixture.tmp, place.root);
    const same = table((await importInto(owner, zip)).data, 'strategic_decisions');
    expect(same.conflicts).toEqual([]);
    onFile(zip, 'PRAGMA foreign_keys = OFF', 'UPDATE strategic_decisions SET session_id = NULL');
    const raised = table((await importInto(owner, zip)).data, 'strategic_decisions');
    expect(raised.conflicts).toEqual([
      expect.objectContaining({ field: 'author_session_id', copy: null, owner: session }),
    ]);
  }, 120000);
});
