// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m14 — what an imported row names: references, link ends and citations read in the record's ids, so a link
// ABOUTME: or reference to one of the copy's renamed rows survives, and one to a row left out is named, never failed on.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { importText } from '../../../src/cli/import';
import { importCopy, type ImportReport } from '../../../src/tools/rbook/record-import';
import type { TablePlan } from '../../../src/tools/rbook/record-import-plan';
import { crossRecordFindings } from '../../../src/tools/rbook/record-checks';
import { removeMember } from '../../../src/tools/rbook/record-membership';
import { openConflicts } from '../../../src/tools/rbook/record-settle';
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
  fixture = replicaFixture('rbook-import-refs-');
});
afterEach(() => fixture.restore());

const on = (place: Place, tool: string, args: Record<string, unknown>) =>
  onPlace(fixture.tmp, place, tool, args);
const importInto = (target: Copy, from: Place, options: Parameters<typeof importCopy>[2] = {}) =>
  onCopy(fixture.tmp, target, (client) => importCopy(client, from.root, options));
const tableOf = (report: ImportReport | undefined, name: string): TablePlan =>
  report!.tables.find((entry) => entry.table === name)!;

/** The owner and the copy each make mission i-m02 after the copy, so the copy's is created on both. */
async function bothMakeIm02() {
  const place = await preShare(fixture.tmp, { marker: true });
  const zip = zipOf(fixture.tmp, place);
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
  return { place, zip };
}

describe("references among the copy's own rows", () => {
  it('a reference, a lineage and a citation, each to a row the import renames, take the new id', async () => {
    const { place, zip } = await bothMakeIm02();
    await on(place, 'rbook_decisions', { action: 'record', content: "The owner's second." });
    const a = await on(zip, 'rbook_decisions', {
      action: 'record',
      content: "The copy's A.",
      missionId: 'i-m02',
    });
    const aId = a.data!.decisionId as number;
    const b = await on(zip, 'rbook_decisions', {
      action: 'record',
      content: `The copy's B, which builds on decision #${aId} and d:${aId}.`,
      supersedes: [aId],
    });
    const bId = b.data!.decisionId as number;
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const applied = await importInto(studio, zip, { apply: true });
    expect(applied.error).toBeUndefined();
    const renamed = applied.data!.applied!.renamed;
    const [newA, newB] = [aId, bId].map((id) => renamed[`strategic_decisions:${id}`]);
    expect(renamed['missions:i-m02']).toBe(`i-m02~i${studio.block}`);
    const decisions = read<Record<string, unknown>>(
      studio,
      'SELECT id, decision_text, mission_id, superseded_by FROM strategic_decisions WHERE id IN (?, ?)',
      [Number(newA), Number(newB)]
    );
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: Number(newA),
          mission_id: `i-m02~i${studio.block}`,
          superseded_by: Number(newB),
        }),
        expect.objectContaining({
          id: Number(newB),
          decision_text: `The copy's B, which builds on decision #${newA} and d:${newA}.`,
        }),
      ])
    );
    // The citation's link is this copy's at once, as it is every copy's that merges the import.
    const links = (copy: Copy) =>
      read(
        copy,
        "SELECT from_kind, from_id, to_kind, to_id FROM record_links WHERE from_kind = 'decision' AND from_id = ? ORDER BY 1, 2, 3, 4",
        [Number(newB)]
      );
    expect(links(studio)).toEqual(
      expect.arrayContaining([
        { from_kind: 'decision', from_id: Number(newB), to_kind: 'decision', to_id: Number(newA) },
      ])
    );
    await syncCopies(fixture.tmp, studio, owner);
    expect(recordedState(owner)).toEqual(recordedState(studio));
    expect(links(owner)).toEqual(links(studio));
  }, 300000);

  for (const ownerHasPair of [false, true])
    it(`a link on a mission created on both comes in on the renamed mission (the owner holds the same pair: ${ownerHasPair})`, async () => {
      const { place, zip } = await bothMakeIm02();
      onFile(
        zip,
        "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('i-m02', 'i-m01', 'blocks')"
      );
      if (ownerHasPair)
        onFile(
          place,
          "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('i-m02', 'i-m01', 'blocks')"
        );
      const owner = await shareExisting(fixture.tmp, place.root);
      const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
      const dry = await importInto(studio, zip);
      expect(tableOf(dry.data, 'mission_dependencies')).toMatchObject({
        identical: 0,
        own: [expect.objectContaining({ to: `i-m02~i${studio.block}|i-m01` })],
      });
      await importInto(studio, zip, { apply: true });
      expect(
        read(studio, 'SELECT from_id, to_id, type FROM mission_dependencies ORDER BY from_id')
      ).toEqual([
        ...(ownerHasPair ? [{ from_id: 'i-m02', to_id: 'i-m01', type: 'blocks' }] : []),
        { from_id: `i-m02~i${studio.block}`, to_id: 'i-m01', type: 'blocks' },
      ]);
    }, 300000);
});

describe('a matched row naming one of the copy’s renamed rows', () => {
  it("compares the reference in the record's ids, so pointing a shared decision at the copy's mission is raised", async () => {
    const { place, zip } = await bothMakeIm02();
    onFile(zip, "UPDATE strategic_decisions SET mission_id = 'i-m02' WHERE id = 1");
    onFile(place, "UPDATE strategic_decisions SET mission_id = 'i-m02' WHERE id = 1");
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const dry = await importInto(studio, zip);
    expect(tableOf(dry.data, 'strategic_decisions').conflicts).toEqual([
      expect.objectContaining({
        id: '1',
        field: 'mission_id',
        copy: `i-m02~i${studio.block}`,
        owner: 'i-m02',
      }),
    ]);
  }, 300000);

  it('raises the lineage fork when both sides superseded a shared decision with their own', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(place, 'rbook_decisions', {
      action: 'record',
      content: "The owner's correction of 1.",
      supersedes: [1],
    });
    await on(zip, 'rbook_decisions', {
      action: 'record',
      content: "The copy's correction of 1.",
      supersedes: [1],
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const applied = await importInto(owner, zip, { apply: true });
    const correction = Number(applied.data!.applied!.renamed['strategic_decisions:2']);
    const forks = (await onCopy(fixture.tmp, owner, (client) => openConflicts(client))).filter(
      (open) => open.field === 'superseded_by'
    );
    expect(forks).toEqual([
      expect.objectContaining({ recordId: '1', ownerOnly: true, candidates: expect.any(Array) }),
    ]);
    expect(forks[0].candidates.map((candidate) => candidate.value)).toEqual([2, correction]);
  }, 300000);
});

describe('a lineage', () => {
  for (const when of ['after', 'never'] as const)
    it(`the copy superseded decision 1 with its own and the record ${when === 'after' ? 'did so after sharing' : 'never did'}: reads keep the record's lineage until the owner settles it`, async () => {
      const place = await preShare(fixture.tmp, { marker: true });
      const zip = zipOf(fixture.tmp, place);
      await on(zip, 'rbook_decisions', {
        action: 'record',
        content: "The copy's successor.",
        supersedes: [1],
      });
      const owner = await shareExisting(fixture.tmp, place.root);
      const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
      if (when === 'after')
        await on(owner, 'rbook_decisions', {
          action: 'record',
          content: "The owner's successor.",
          supersedes: [1],
        });
      const lineage = () =>
        read(owner, 'SELECT status, superseded_by FROM strategic_decisions WHERE id = 1');
      const before = lineage();
      await syncCopies(fixture.tmp, studio, owner);
      await importInto(studio, zip, { apply: true });
      await syncCopies(fixture.tmp, studio, owner);
      await syncCopies(fixture.tmp, studio, owner);
      expect(lineage()).toEqual(before);
      expect(recordedState(studio)).toEqual(recordedState(owner));
      const findings = await onCopy(fixture.tmp, owner, (client) => crossRecordFindings(client));
      const fork = findings.find((finding) => finding.check === 'lineage_fork');
      expect(fork?.detail).toMatch(
        when === 'never' ? /superseded by nothing and \d+/ : /superseded by \d+ and \d+/
      );
    }, 300000);
});

describe('a link the record removed since sharing', () => {
  it("reads as deleted on the owner, not as the copy's own, so it stays removed", async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: 'Second',
      sprintId: 'i-sprint',
    });
    await on(place, 'rbook_mission', {
      action: 'depends',
      fromId: 'i-m02',
      toId: 'i-m01',
      type: 'Requires',
    });
    const zip = zipOf(fixture.tmp, place);
    const owner = await shareExisting(fixture.tmp, place.root);
    await on(owner, 'rbook_mission', { action: 'undepends', fromId: 'i-m02', toId: 'i-m01' });
    const dry = await importInto(owner, zip);
    expect(tableOf(dry.data, 'mission_dependencies')).toMatchObject({
      own: [],
      deletedOnOwner: [expect.objectContaining({ id: 'i-m02|i-m01' })],
    });
    expect(dry.data?.ownRows).toBe(0);
    expect(importText(dry.data!)).toMatch(/mission_dependencies:i-m02\|i-m01'?(?: \(|$)/m);
    await importInto(owner, zip, { apply: true });
    expect(read(owner, 'SELECT * FROM mission_dependencies')).toEqual([]);
  }, 300000);

  it("counts only a removal the record has taken: one a removed member made, held in quarantine, leaves the copy's link its own", async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: 'Second',
      sprintId: 'i-sprint',
    });
    const zip = zipOf(fixture.tmp, place);
    onFile(
      zip,
      "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('i-m02', 'i-m01', 'Requires')"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    expect(
      (await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Darryl'))).success
    ).toBe(true);
    // Removed without knowing, the member links the pair and removes it again.
    await on(studio, 'rbook_mission', {
      action: 'depends',
      fromId: 'i-m02',
      toId: 'i-m01',
      type: 'Requires',
    });
    await on(studio, 'rbook_mission', { action: 'undepends', fromId: 'i-m02', toId: 'i-m01' });
    await syncCopies(fixture.tmp, studio, owner);
    expect(
      read(owner, "SELECT 1 FROM record_changes WHERE kind = 'unlink'").length
    ).toBeGreaterThan(0);
    const dry = await importInto(owner, zip);
    expect(tableOf(dry.data, 'mission_dependencies')).toMatchObject({
      own: [expect.objectContaining({ id: 'i-m02|i-m01' })],
      deletedOnOwner: [],
    });
  }, 300000);
});

describe('a text id created on both', () => {
  it("takes a name the alias rule never gives, so a member's own clash on the same id still syncs", async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m01',
      name: "The copy's x",
      sprintId: 'i-sprint',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    // The owner and the member each make x-m01 before they sync; the member's then imports the copy.
    await on(owner, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m01',
      name: "The owner's x",
      sprintId: 'i-sprint',
    });
    await on(studio, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m01',
      name: "The member's x",
      sprintId: 'i-sprint',
    });
    expect((await importInto(studio, zip, { apply: true })).error).toBeUndefined();
    await syncCopies(fixture.tmp, studio, owner);
    await syncCopies(fixture.tmp, studio, owner);
    const names = (copy: Copy) =>
      read<{ name: string }>(
        copy,
        "SELECT name FROM missions WHERE id LIKE 'x-m01%' ORDER BY name"
      ).map((row) => row.name);
    expect(names(owner)).toEqual(["The copy's x", "The member's x", "The owner's x"]);
    expect(recordedState(owner)).toEqual(recordedState(studio));
  }, 300000);
});

describe('two old copies with one id created on both', () => {
  it('each take a name of their own when imported in turn into one copy', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const one = zipOf(fixture.tmp, place, 'one');
    const two = zipOf(fixture.tmp, place, 'two');
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: "The owner's",
      sprintId: 'i-sprint',
    });
    await on(one, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: "Copy one's",
      sprintId: 'i-sprint',
    });
    // The second copy lives on a machine of its own, so each registers.
    await on({ root: two.root, machine: 'machine-other' }, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: "Copy two's",
      sprintId: 'i-sprint',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    expect((await importInto(studio, one, { apply: true })).error).toBeUndefined();
    expect((await importInto(studio, two, { apply: true })).error).toBeUndefined();
    expect(
      read(studio, "SELECT id, name FROM missions WHERE id LIKE 'i-m02%' ORDER BY id")
    ).toEqual([
      { id: 'i-m02', name: "The owner's" },
      { id: `i-m02~i${studio.block}`, name: "Copy one's" },
      { id: `i-m02~i${studio.block}-2`, name: "Copy two's" },
    ]);
  }, 300000);
});

describe('a row naming one the import leaves out', () => {
  it('is brought in without the reference, a link to it is left out, and both are named; --include brings them in whole', async () => {
    const place = await preShare(fixture.tmp, {});
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    await on(place, 'rbook_context', { action: 'snapshot', source: 'before the copy' });
    const zip = zipOf(fixture.tmp, place);
    onFile(place, "DELETE FROM missions WHERE id = 'i-m03'");
    await on(zip, 'rbook_decisions', {
      action: 'record',
      content: 'Own decision about i-m03.',
      missionId: 'i-m03',
    });
    onFile(
      zip,
      "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('i-m01', 'i-m03', 'blocks')"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    expect(dry.error).toBeUndefined();
    const left = dry.data!.tables.flatMap((table) => table.leftOut);
    expect(left).toEqual([
      expect.objectContaining({ column: 'mission_id', names: 'missions:i-m03', brought: true }),
      expect.objectContaining({
        row: 'mission_dependencies:i-m01|i-m03',
        names: 'missions:i-m03',
        brought: true,
      }),
    ]);
    expect(importText(dry.data!)).toMatch(/mission_id names missions:i-m03: brought in without it/);
    expect(importText(dry.data!)).toMatch(
      /i-m01\|i-m03 to_id names missions:i-m03: the link is left out/
    );
    // The table's own line counts the link left out.
    expect(importText(dry.data!)).toMatch(
      /^mission_dependencies: 1 in the copy: .*1 left out, naming a row the record will not hold/m
    );
    const applied = await importInto(owner, zip, { apply: true });
    expect(applied.error).toBeUndefined();
    expect(
      read(
        owner,
        "SELECT mission_id FROM strategic_decisions WHERE decision_text = 'Own decision about i-m03.'"
      )
    ).toEqual([{ mission_id: null }]);
    expect(read(owner, 'SELECT * FROM mission_dependencies')).toEqual([]);
  }, 300000);

  it("a matched row's reference to a left-out row keeps the record's value, and is named", async () => {
    const place = await preShare(fixture.tmp, {});
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    await on(place, 'rbook_context', { action: 'snapshot', source: 'before the copy' });
    const zip = zipOf(fixture.tmp, place);
    onFile(place, 'PRAGMA foreign_keys = OFF', "DELETE FROM missions WHERE id = 'i-m03'");
    // The shared decision 1 names i-m01 in the record and i-m03 on the copy alone.
    onFile(place, "UPDATE strategic_decisions SET mission_id = 'i-m01' WHERE id = 1");
    onFile(zip, "UPDATE strategic_decisions SET mission_id = 'i-m03' WHERE id = 1");
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    const decisions = tableOf(dry.data, 'strategic_decisions');
    expect(decisions.conflicts).toEqual([]);
    expect(decisions.leftOut).toEqual([
      expect.objectContaining({
        row: 'strategic_decisions:1',
        column: 'mission_id',
        names: 'missions:i-m03',
        brought: false,
      }),
    ]);
    expect(importText(dry.data!)).toMatch(
      /strategic_decisions:1 mission_id names missions:i-m03: the record keeps its own value/
    );
    await importInto(owner, zip, { apply: true });
    expect(read(owner, 'SELECT mission_id FROM strategic_decisions WHERE id = 1')).toEqual([
      { mission_id: 'i-m01' },
    ]);
    expect(read(owner, 'SELECT * FROM record_conflicts')).toEqual([]);
  }, 300000);

  it('with --include, the left-out row comes in and so do the rows that name it, whole', async () => {
    const place = await preShare(fixture.tmp, {});
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    await on(place, 'rbook_context', { action: 'snapshot', source: 'before the copy' });
    const zip = zipOf(fixture.tmp, place);
    onFile(place, "DELETE FROM missions WHERE id = 'i-m03'");
    onFile(
      zip,
      "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('i-m01', 'i-m03', 'blocks')"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const applied = await importInto(owner, zip, { apply: true, include: ['missions:i-m03'] });
    expect(applied.error).toBeUndefined();
    expect(applied.data!.tables.flatMap((table) => table.leftOut)).toEqual([]);
    expect(read(owner, 'SELECT from_id, to_id FROM mission_dependencies')).toEqual([
      { from_id: 'i-m01', to_id: 'i-m03' },
    ]);
  }, 300000);
});

describe("a link the copy holds alike to one of the record's, an end naming a row neither holds", () => {
  it("is the record's link only when its other end is the record's row too: a mission created on both is not", async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
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
    const dangling =
      "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('i-m02', 'gone-m99', 'Requires')";
    onFile(zip, 'PRAGMA foreign_keys = OFF', dangling);
    onFile(place, 'PRAGMA foreign_keys = OFF', dangling);
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const dry = await importInto(studio, zip);
    // The copy's i-m02 comes in under another name, so its link is not the record's.
    expect(tableOf(dry.data, 'missions').own.map((row) => [row.id, row.to])).toEqual([
      ['i-m02', expect.stringMatching(/^i-m02~i/)],
    ]);
    expect(tableOf(dry.data, 'mission_dependencies')).toMatchObject({ identical: 0, ownerOnly: 1 });
    expect(tableOf(dry.data, 'mission_dependencies').leftOut).toContainEqual(
      expect.objectContaining({
        row: 'mission_dependencies:i-m02|gone-m99',
        names: 'missions:gone-m99',
      })
    );
  }, 300000);
});
