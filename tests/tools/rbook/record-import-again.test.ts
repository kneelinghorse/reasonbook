// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m14 — a copy imported again, or on two copies of the record: a shared record never deletes a row, so a row
// ABOUTME: an import brought in must be found by every later plan, wherever it ran, or the record holds it twice for good.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { recordedExecute } from '../../../src/tools/rbook/record-changes';
import { importText } from '../../../src/cli/import';
import { importCopy } from '../../../src/tools/rbook/record-import';
import { decideTransactions } from '../../../src/tools/rbook/record-decide';
import { inviteMember, removeMember } from '../../../src/tools/rbook/record-membership';
import { openConflicts } from '../../../src/tools/rbook/record-settle';
import { RECORDED_TABLES } from '../../../src/tools/rbook/record-columns';
import { dbOf, replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import {
  oldCopyOf,
  onFile,
  onPlace,
  preShare,
  zipOf,
  type Place,
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
  fixture = replicaFixture('rbook-import-again-');
});
afterEach(() => fixture.restore());

const on = (place: Place, tool: string, args: Record<string, unknown>) =>
  onPlace(fixture.tmp, place, tool, args);
const importInto = (target: Copy, from: Place, apply = false) =>
  onCopy(fixture.tmp, target, (client) => importCopy(client, from.root, { apply }));

const counts = (copy: Copy) =>
  Object.fromEntries(
    RECORDED_TABLES.map((table) => [
      table,
      read<{ n: number }>(copy, `SELECT count(*) AS n FROM ${table}`)[0].n,
    ])
  );
const decisionsHolding = (copy: Copy, text: string) =>
  read<{ id: number }>(copy, 'SELECT id FROM strategic_decisions WHERE decision_text = ?', [text]);
const missionsNamed = (copy: Copy, name: string) =>
  read<{ id: string }>(copy, 'SELECT id FROM missions WHERE name = ? ORDER BY id', [name]);

/** A copy with a decision and a mission of its own, and a mission id the owner made too. */
async function copyWithItsOwn() {
  const place = await preShare(fixture.tmp, { marker: true });
  const zip = zipOf(fixture.tmp, place);
  await on(place, 'rbook_mission', {
    action: 'add',
    missionId: 'i-m02',
    name: "The owner's i-m02",
    sprintId: 'i-sprint',
  });
  await on(zip, 'rbook_mission', {
    action: 'add',
    missionId: 'i-m02',
    name: "The copy's i-m02",
    sprintId: 'i-sprint',
  });
  await on(zip, 'rbook_decisions', { action: 'record', content: "The copy's own decision." });
  await on(zip, 'rbook_mission', {
    action: 'add',
    missionId: 'c-m09',
    name: "The copy's own mission",
    sprintId: 'i-sprint',
  });
  const owner = await shareExisting(fixture.tmp, place.root);
  const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
  return { zip, owner, studio };
}

describe('a copy brought in again', () => {
  it('applied twice on one copy, the second plan finds every row the first brought in, a text id created on both among them', async () => {
    const { zip, studio } = await copyWithItsOwn();
    const first = await importInto(studio, zip, true);
    expect(first.error).toBeUndefined();
    expect(first.data?.applied).toMatchObject({ created: 3 });
    const after = counts(studio);

    const again = await importInto(studio, zip);
    expect(again.error).toBeUndefined();
    expect(again.data).toMatchObject({ ownRows: 0, differing: 0 });
    for (const table of again.data!.tables)
      expect({ table: table.table, createdOnBoth: table.createdOnBoth }).toEqual({
        table: table.table,
        createdOnBoth: [],
      });
    const second = await importInto(studio, zip, true);
    expect(second.data?.applied).toMatchObject({ created: 0, set: 0, conflicts: 0 });
    expect(counts(studio)).toEqual(after);
    expect(decisionsHolding(studio, "The copy's own decision.")).toHaveLength(1);
    expect(missionsNamed(studio, "The copy's i-m02")).toEqual([{ id: `i-m02~i${studio.block}` }]);
  }, 300000);

  it('imported on one copy, then on another once they synced: the second finds what the first brought in', async () => {
    const { zip, owner, studio } = await copyWithItsOwn();
    expect((await importInto(owner, zip, true)).data?.applied).toMatchObject({ created: 3 });
    await syncCopies(fixture.tmp, studio, owner);
    const there = await importInto(studio, zip);
    expect(there.data).toMatchObject({ ownRows: 0, differing: 0 });
    expect((await importInto(studio, zip, true)).data?.applied).toMatchObject({ created: 0 });
    await syncCopies(fixture.tmp, studio, owner);
    expect(decisionsHolding(owner, "The copy's own decision.")).toHaveLength(1);
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 300000);

  it('imported on two copies before they synced: both copies hold each row twice, the same way, and a later dry run names the pairs', async () => {
    const { zip, owner, studio } = await copyWithItsOwn();
    await importInto(owner, zip, true);
    await importInto(studio, zip, true);
    await syncCopies(fixture.tmp, studio, owner);
    await syncCopies(fixture.tmp, studio, owner);
    expect(recordedState(studio)).toEqual(recordedState(owner));
    expect(decisionsHolding(owner, "The copy's own decision.")).toHaveLength(2);
    // The alias rule names the later of the two creates of c-m09 by its creator's block.
    expect(missionsNamed(owner, "The copy's own mission")).toHaveLength(2);
    const later = await importInto(owner, zip);
    expect(later.data?.ownRows).toBe(0);
    const twice = later.data!.tables.flatMap((table) =>
      table.broughtTwice.map((entry) => `${table.table} ${entry}`)
    );
    expect(twice).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^strategic_decisions \d+ as \d+ and \d+$/),
        expect.stringMatching(/^missions c-m09 as /),
      ])
    );
    expect(importText(later.data!)).toMatch(
      /Brought in twice, by two copies before they synced; a shared record keeps every row[^\n]*\n {2}strategic_decisions \d+ as \d+ and \d+/
    );
  }, 300000);

  it('an old copy brought in, then opened by a newer server that gives its rows stable ids, brings in nothing the second time', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const later = new Date(Date.now() + 60_000).toISOString();
    onFile(
      zip,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('The copy''s own decision.', '${later}')`,
      `INSERT INTO missions (id, sprint_id, name, status, created_at) VALUES ('c-m09', 'i-sprint', 'The copy''s own mission', 'Queued', '${later}')`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    expect((await importInto(studio, zip, true)).data?.applied).toMatchObject({ created: 2 });
    // A newer server opens the copy, as an install on the machine that holds it does.
    await on(zip, 'rbook_decisions', {
      action: 'record',
      content: 'A later decision on the copy.',
    });
    expect(
      read<{ n: number }>(zip, 'SELECT count(*) AS n FROM missions WHERE stable_event_id IS NULL')
    ).toEqual([{ n: 0 }]);
    const again = await importInto(studio, zip, true);
    expect(again.data?.applied).toMatchObject({ created: 1 });
    expect(decisionsHolding(studio, "The copy's own decision.")).toHaveLength(1);
    expect(missionsNamed(studio, "The copy's own mission")).toHaveLength(1);
  }, 300000);

  it('a row it brought in and the copy changed since is raised: the values it brought are no base, since an older or sibling copy would then overwrite the record', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'c-m09',
      name: "The copy's own mission",
      sprintId: 'i-sprint',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, zip, true);
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'c-m09',
      fields: { name: 'Renamed on the copy later' },
    });
    const missions = (await importInto(owner, zip)).data!.tables.find(
      (table) => table.table === 'missions'
    )!;
    expect(missions.conflicts.map((change) => `${change.id} ${change.field}`)).toEqual([
      'c-m09 name',
    ]);
    expect(missions.copyChanged).toEqual([]);
  }, 300000);
});

describe('a row an earlier import brought in', () => {
  it("reads a reference the record repointed since as the record's change, since the record held the copy's value", async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: 'Second',
      sprintId: 'i-sprint',
    });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_decisions', {
      action: 'record',
      content: "The copy's own decision.",
      missionId: 'i-m01',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, zip, true);
    const [{ id }] = decisionsHolding(owner, "The copy's own decision.");
    await onCopy(fixture.tmp, owner, (client) =>
      recordedExecute(client, 'UPDATE strategic_decisions SET mission_id = ? WHERE id = ?', [
        'i-m02',
        id,
      ])
    );
    const decisions = (await importInto(owner, zip)).data!.tables.find(
      (table) => table.table === 'strategic_decisions'
    )!;
    // The mission the record held as the copy holds it, and the author the copy never recorded.
    expect(decisions).toMatchObject({ ownerChanged: 1, heldBefore: 1, conflicts: [] });
  }, 300000);
});

describe('a copy reworded between two imports', () => {
  it('is found again by the stable id the copy kept for each row, its new wording raised, never brought in twice', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_decisions', { action: 'record', content: "The copy's own decision." });
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, zip, true);
    // Reworded, the decision's natural key moves; its own stable id does not.
    onFile(
      zip,
      "UPDATE strategic_decisions SET decision_text = 'The copy''s own decision, reworded.' WHERE decision_text = 'The copy''s own decision.'"
    );
    const again = await importInto(owner, zip, true);
    expect(again.data).toMatchObject({ ownRows: 0 });
    expect(again.data?.applied).toMatchObject({ created: 0, set: 0, conflicts: 1 });
    expect(
      read(
        owner,
        "SELECT decision_text FROM strategic_decisions WHERE decision_text LIKE 'The copy''s own decision%'"
      )
    ).toEqual([{ decision_text: "The copy's own decision." }]);
  }, 300000);
});

describe('another version of a copy brought in', () => {
  it('the older of two zips, imported after the newer, raises its older values and overwrites nothing', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const older = zipOf(fixture.tmp, place, 'older');
    await on(older, 'rbook_mission', {
      action: 'add',
      missionId: 'c-m09',
      name: 'Old name',
      sprintId: 'i-sprint',
    });
    const newer = zipOf(fixture.tmp, older, 'newer');
    onFile(
      newer,
      "UPDATE missions SET name = 'New name', notes = 'Added on the newer zip.' WHERE id = 'c-m09'"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, newer, true);
    const dry = await importInto(owner, older);
    const missions = dry.data!.tables.find((table) => table.table === 'missions')!;
    expect(missions.copyChanged).toEqual([]);
    expect(missions.conflicts.map((change) => change.field).sort()).toEqual(['name', 'notes']);
    await importInto(owner, older, true);
    expect(missionsNamed(owner, 'New name')).toHaveLength(1);
    expect(read(owner, "SELECT notes FROM missions WHERE id = 'c-m09'")).toEqual([
      { notes: 'Added on the newer zip.' },
    ]);
  }, 300000);

  it('its newer schema first, then its old one: a numbered row the first renumbered is found by its text and time, and comes in once', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const later = new Date(Date.now() + 60_000).toISOString();
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('The copy''s own decision.', '${later}')`
    );
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    // A newer server opens one of the two, giving its rows stable ids.
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    // The record numbers a decision of its own after the copy, so the copy's number is taken.
    await on(place, 'rbook_decisions', { action: 'record', content: 'The owner decided after.' });
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, migrated, true);
    const dry = await importInto(owner, old);
    expect(dry.data?.ownRows).toBe(0);
    await importInto(owner, old, true);
    expect(decisionsHolding(owner, "The copy's own decision.")).toHaveLength(1);
  }, 300000);
  it("its newer schema first, then its old one: a row whose citation the first import rewrote is found in the record's ids", async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('The copy''s own decision.', '${at(60_000)}')`
    );
    const [cited] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'The copy''s own decision.'"
    );
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Follows d:${cited.id}.', '${at(120_000)}')`
    );
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    // The record numbers a decision of its own after the copy, so both of the copy's move.
    await on(place, 'rbook_decisions', { action: 'record', content: 'The owner decided after.' });
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, migrated, true);
    const [moved] = decisionsHolding(owner, "The copy's own decision.");
    expect(moved.id).not.toBe(cited.id);
    expect(
      read(
        owner,
        "SELECT decision_text FROM strategic_decisions WHERE decision_text LIKE 'Follows d:%'"
      )
    ).toEqual([{ decision_text: `Follows d:${moved.id}.` }]);
    const dry = await importInto(owner, old);
    expect(dry.data?.ownRows).toBe(0);
    await importInto(owner, old, true);
    expect(
      read(owner, "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Follows d:%'")
    ).toHaveLength(1);
    expect(decisionsHolding(owner, "The copy's own decision.")).toHaveLength(1);
  }, 300000);
  it('its newer schema first, then its old one: a decision citing a learning the first import renumbered is found once that learning is, in a later table', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    onFile(
      old,
      `INSERT INTO learnings (content, created_at) VALUES ('A lesson of its own.', '${at(60_000)}')`
    );
    const [lesson] = read<{ id: number }>(
      old,
      "SELECT id FROM learnings WHERE content = 'A lesson of its own.'"
    );
    // Decisions are matched before learnings, so this citation reads in the record's ids only once
    // the learning is matched by its own text and time.
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Per l:${lesson.id}.', '${at(120_000)}')`
    );
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    // The record captures a learning of its own after the copy, so the copy's learning moves.
    await on(place, 'rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 'The owner learned after.',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, migrated, true);
    const [moved] = read<{ id: number }>(
      owner,
      "SELECT id FROM learnings WHERE content = 'A lesson of its own.'"
    );
    expect(moved.id).not.toBe(lesson.id);
    expect(
      read(
        owner,
        "SELECT decision_text FROM strategic_decisions WHERE decision_text LIKE 'Per l:%'"
      )
    ).toEqual([{ decision_text: `Per l:${moved.id}.` }]);
    // Found once the learning is, never left out as perhaps the record's decision.
    const [decision] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Per l:%'"
    );
    const again = await importInto(owner, old);
    const decisions = again.data!.tables.find((table) => table.table === 'strategic_decisions')!;
    expect(decisions.perhapsIn).toEqual([]);
    expect(decisions.inRecord).toContain(String(decision.id));
    await importInto(owner, old, true);
    expect(
      read(owner, "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Per l:%'")
    ).toHaveLength(1);
    expect(
      read(owner, "SELECT id FROM learnings WHERE content = 'A lesson of its own.'")
    ).toHaveLength(1);
  }, 300000);
  it('its newer schema first, then its old one: two decisions citing each other, whose cycle no pass can start, are left out as perhaps in the record already', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Cycle A.', '${at(60_000)}')`,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Cycle B.', '${at(120_000)}')`
    );
    const [a, b] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Cycle %' ORDER BY id"
    );
    // Each cites the other, the first by a number written in by hand after the second was made.
    onFile(
      old,
      `UPDATE strategic_decisions SET decision_text = 'Cycle A, see d:${b.id}.' WHERE id = ${a.id}`,
      `UPDATE strategic_decisions SET decision_text = 'Cycle B, see d:${a.id}.' WHERE id = ${b.id}`
    );
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    // The record numbers a decision of its own after the copy, so both of the copy's move.
    await on(place, 'rbook_decisions', { action: 'record', content: 'The owner decided after.' });
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, migrated, true);
    const cycle = read<{ id: number }>(
      owner,
      "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Cycle %' ORDER BY id"
    );
    expect(cycle).toHaveLength(2);
    expect(cycle.map((row) => row.id)).not.toEqual([a.id, b.id]);
    const dry = await importInto(owner, old);
    expect(dry.data?.ownRows).toBe(0);
    const decisions = dry.data!.tables.find((table) => table.table === 'strategic_decisions')!;
    expect(decisions.perhapsIn.map((row) => row.id).sort()).toEqual(
      [String(a.id), String(b.id)].sort()
    );
    expect(importText(dry.data!)).toMatch(
      /^Perhaps in the record already, alike but for their citation numbers/m
    );
    expect(importText(dry.data!)).toMatch(
      /^strategic_decisions: \d+ in the copy: .*2 perhaps in the record already/m
    );
    expect(importText(dry.data!).split('\n').pop()).toMatch(
      /^This copy holds no row of its own and nothing the record holds differently; the 2 row\(s\) left out above stay out, but for any --include brings in: archive it/
    );
    // Only a row the dry run labels may be named, and the refusal names both kinds it accepts.
    const refused = await onCopy(fixture.tmp, owner, (client) =>
      importCopy(client, old.root, { include: ['strategic_decisions:999'] })
    );
    expect(refused.error?.suggestion).toBe(
      'Name only rows the dry run lists as deleted on the owner or perhaps in the record already, as <table>:<id>.'
    );
    await importInto(owner, old, true);
    expect(
      read(owner, "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Cycle %'")
    ).toHaveLength(2);
  }, 300000);
  it('empties and names every reference and citation of a row left out as perhaps in the record, never reading it as the record row of that number', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Cycle A.', '${at(60_000)}')`,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Cycle B.', '${at(120_000)}')`
    );
    const [a, b] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Cycle %' ORDER BY id"
    );
    onFile(
      old,
      `UPDATE strategic_decisions SET decision_text = 'Cycle A, see d:${b.id}.' WHERE id = ${a.id}`,
      `UPDATE strategic_decisions SET decision_text = 'Cycle B, see d:${a.id}.' WHERE id = ${b.id}`
    );
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    // The old copy, after the newer one was made, gains a decision superseded by the first of the
    // cycle and one citing it, and points the shared decision at it.
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at, superseded_by) VALUES ('Superseded by the cycle.', '${at(180_000)}', ${a.id})`,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Cites the cycle, see d:${a.id}.', '${at(240_000)}')`,
      `UPDATE strategic_decisions SET superseded_by = ${a.id} WHERE id = 1`
    );
    const [later] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'Superseded by the cycle.'"
    );
    const [citing] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Cites the cycle%'"
    );
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    // The record gives the first of the cycle's number to a decision of its own, and points the
    // shared decision at that one: the same number in both stores, naming different rows.
    await on(place, 'rbook_decisions', { action: 'record', content: 'The owner decided after.' });
    onFile(place, `UPDATE strategic_decisions SET superseded_by = ${a.id} WHERE id = 1`);
    const owner = await shareExisting(fixture.tmp, place.root);
    expect(
      read(owner, 'SELECT decision_text FROM strategic_decisions WHERE id = ?', [a.id])
    ).toEqual([{ decision_text: 'The owner decided after.' }]);
    await importInto(owner, migrated, true);
    const dry = await importInto(owner, old);
    const decisions = dry.data!.tables.find((table) => table.table === 'strategic_decisions')!;
    expect(decisions.perhapsIn.map((row) => row.id)).toContain(String(a.id));
    expect(decisions.leftOut).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          row: `strategic_decisions:${later.id}`,
          column: 'superseded_by',
          names: `strategic_decisions:${a.id}`,
          brought: true,
        }),
        expect.objectContaining({
          row: `strategic_decisions:${citing.id}`,
          column: 'decision_text',
          names: `strategic_decisions:${a.id}`,
          brought: true,
          cites: true,
        }),
        expect.objectContaining({
          row: 'strategic_decisions:1',
          column: 'superseded_by',
          names: `strategic_decisions:${a.id}`,
          brought: false,
        }),
      ])
    );
    // The shared decision reads the same number in both, but it names another row in each.
    expect(dry.data!.differing).toBeGreaterThan(0);
    await importInto(owner, old, true);
    expect(
      read(
        owner,
        "SELECT superseded_by FROM strategic_decisions WHERE decision_text = 'Superseded by the cycle.'"
      )
    ).toEqual([{ superseded_by: null }]);
    expect(read(owner, 'SELECT superseded_by FROM strategic_decisions WHERE id = 1')).toEqual([
      { superseded_by: a.id },
    ]);
    // Imported again, the shared decision still reads as one the copy holds differently.
    const again = await importInto(owner, old);
    expect(
      again.data!.tables.find((table) => table.table === 'strategic_decisions')!.leftOut
    ).toContainEqual(
      expect.objectContaining({ row: 'strategic_decisions:1', column: 'superseded_by' })
    );
  }, 300000);
  it('brings a row left out as perhaps in the record in by --include, under a number every row naming it reads, and names its citation of the one still left out', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Cycle A.', '${at(60_000)}')`,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Cycle B.', '${at(120_000)}')`
    );
    const [a, b] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Cycle %' ORDER BY id"
    );
    onFile(
      old,
      `UPDATE strategic_decisions SET decision_text = 'Cycle A, see d:${b.id}.' WHERE id = ${a.id}`,
      `UPDATE strategic_decisions SET decision_text = 'Cycle B, see d:${a.id}.' WHERE id = ${b.id}`
    );
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at, superseded_by) VALUES ('Superseded by the cycle.', '${at(180_000)}', ${a.id})`
    );
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    await on(place, 'rbook_decisions', { action: 'record', content: 'The owner decided after.' });
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, migrated, true);
    const including = (apply: boolean) =>
      onCopy(fixture.tmp, owner, (client) =>
        importCopy(client, old.root, { apply, include: [`strategic_decisions:${a.id}`] })
      );
    const dry = await including(false);
    const decisions = dry.data!.tables.find((table) => table.table === 'strategic_decisions')!;
    const brought = decisions.own.find((row) => row.id === String(a.id))!;
    expect(brought.to).not.toBe(String(a.id));
    expect(decisions.leftOut).toContainEqual(
      expect.objectContaining({
        row: `strategic_decisions:${a.id}`,
        column: 'decision_text',
        names: `strategic_decisions:${b.id}`,
        cites: true,
      })
    );
    expect(importText(dry.data!)).toMatch(
      new RegExp(
        `^  strategic_decisions:${a.id}, perhaps the record's \\d+, brought in by --include as ${brought.to}$`,
        'm'
      )
    );
    await including(true);
    expect(
      read(
        owner,
        "SELECT superseded_by FROM strategic_decisions WHERE decision_text = 'Superseded by the cycle.'"
      )
    ).toEqual([{ superseded_by: Number(brought.to) }]);
    expect(
      read(owner, 'SELECT decision_text FROM strategic_decisions WHERE id = ?', [
        Number(brought.to),
      ])
    ).toEqual([{ decision_text: `Cycle A, see d:${b.id}.` }]);
  }, 300000);
  it('reads a cycle the owner deleted before sharing, brought back by --include on the newer version, as perhaps in the record on the old one, never as deleted on the owner', async () => {
    const place = await preShare(fixture.tmp);
    await on(place, 'rbook_decisions', { action: 'record', content: 'Cycle A.' });
    await on(place, 'rbook_decisions', { action: 'record', content: 'Cycle B.' });
    const [a, b] = read<{ id: number }>(
      place,
      "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Cycle %' ORDER BY id"
    );
    onFile(
      place,
      `UPDATE strategic_decisions SET decision_text = 'Cycle A, see d:${b.id}.' WHERE id = ${a.id}`,
      `UPDATE strategic_decisions SET decision_text = 'Cycle B, see d:${a.id}.' WHERE id = ${b.id}`
    );
    await on(place, 'rbook_context', { action: 'snapshot', source: 'before the copy' });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    // The owner deletes both before sharing and decides once more, so rows brought back move.
    onFile(
      place,
      'PRAGMA foreign_keys = OFF',
      `DELETE FROM strategic_decisions WHERE id IN (${a.id}, ${b.id})`
    );
    await on(place, 'rbook_decisions', { action: 'record', content: 'The owner decided after.' });
    const owner = await shareExisting(fixture.tmp, place.root);
    const include = [`strategic_decisions:${a.id}`, `strategic_decisions:${b.id}`];
    await onCopy(fixture.tmp, owner, (client) =>
      importCopy(client, migrated.root, { apply: true, include })
    );
    const cycle = () =>
      read(owner, "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Cycle %'");
    expect(cycle()).toHaveLength(2);
    const dry = await importInto(owner, old);
    const decisions = dry.data!.tables.find((table) => table.table === 'strategic_decisions')!;
    expect(decisions.perhapsIn.map((row) => row.id).sort()).toEqual(
      [String(a.id), String(b.id)].sort()
    );
    // Called deleted on the owner, the person would bring them back a second time.
    expect(decisions.deletedOnOwner).toEqual([]);
    expect(importText(dry.data!)).not.toMatch(/^Deleted on the owner/m);
    await importInto(owner, old, true);
    expect(cycle()).toHaveLength(2);
  }, 300000);
  it('its newer schema first, then its old one: a row alike to one the first import brought in, of the same moment but only on the old copy, is its own, never matched to that row or left out as perhaps it', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const moment = new Date(Date.now() + 60_000).toISOString();
    const twice = `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Twice in one moment.', '${moment}')`;
    onFile(old, twice);
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    onFile(old, twice);
    // Two decisions of the record's own after the copy, so neither of the old copy's rows has the
    // number and text of the record's: only the text pass can find them.
    await on(place, 'rbook_decisions', { action: 'record', content: 'The owner decided after.' });
    await on(place, 'rbook_decisions', { action: 'record', content: 'And again after.' });
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, migrated, true);
    expect(decisionsHolding(owner, 'Twice in one moment.')).toHaveLength(1);
    const dry = await importInto(owner, old);
    const decisions = dry.data!.tables.find((table) => table.table === 'strategic_decisions')!;
    // Each record row is matched once, and one another copy row matched is no row this one may be.
    expect(decisions.perhapsIn).toEqual([]);
    expect(decisions.own).toHaveLength(1);
    await importInto(owner, old, true);
    expect(decisionsHolding(owner, 'Twice in one moment.')).toHaveLength(2);
  }, 300000);

  it('its newer schema first, then its old one: two decisions of one moment, citing each other and alike but for their numbers, are left out as perhaps in the record already, never in twice', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const moment = new Date(Date.now() + 60_000).toISOString();
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Pair.', '${moment}')`,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Pair.', '${moment}')`
    );
    const [a, b] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'Pair.' ORDER BY id"
    );
    onFile(
      old,
      `UPDATE strategic_decisions SET decision_text = 'Pair, see d:${b.id}.' WHERE id = ${a.id}`,
      `UPDATE strategic_decisions SET decision_text = 'Pair, see d:${a.id}.' WHERE id = ${b.id}`
    );
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    // Two decisions of the record's own after the copy, so no number the copy cites lands, by chance,
    // on a row the first import renumbered: only their texts with the numbers masked show them.
    await on(place, 'rbook_decisions', { action: 'record', content: 'The owner decided after.' });
    await on(place, 'rbook_decisions', { action: 'record', content: 'And again after.' });
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, migrated, true);
    expect(
      read(owner, "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Pair, see d:%'")
    ).toHaveLength(2);
    const dry = await importInto(owner, old);
    const twins = read<{ id: number }>(
      owner,
      "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Pair, see d:%' ORDER BY id"
    ).map((row) => String(row.id));
    expect(
      dry.data!.tables.find((table) => table.table === 'strategic_decisions')!.perhapsIn
    ).toEqual([
      { id: String(a.id), as: twins },
      { id: String(b.id), as: twins },
    ]);
    expect(importText(dry.data!)).toMatch(
      new RegExp(
        `^  strategic_decisions:${a.id}, perhaps the record's ${twins.join(' or ')}, as may strategic_decisions:${b.id}$`,
        'm'
      )
    );
    await importInto(owner, old, true);
    expect(
      read(owner, "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Pair, see d:%'")
    ).toHaveLength(2);
  }, 300000);
  it('never writes onto a row the base holds for a copy row alike to it but for its citation numbers', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    await on(place, 'rbook_decisions', {
      action: 'record',
      content: 'Alike, see d:1.',
      missionId: 'i-m01',
    });
    await on(place, 'rbook_decisions', { action: 'record', content: 'Alike, see d:2.' });
    const moment = new Date(Date.now() - 90 * 60_000).toISOString();
    onFile(
      place,
      `UPDATE strategic_decisions SET created_at = '${moment}' WHERE decision_text LIKE 'Alike, see d:%'`
    );
    await on(place, 'rbook_db', { action: 'snapshot' });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    fs.cpSync(
      path.join(path.dirname(dbOf(place.root)), 'snapshots'),
      path.join(path.dirname(dbOf(old.root)), 'snapshots'),
      { recursive: true }
    );
    // On the copy: the first deleted, and the second's citation changed to a row the copy lacks.
    onFile(
      old,
      "DELETE FROM strategic_decisions WHERE decision_text = 'Alike, see d:1.'",
      "UPDATE strategic_decisions SET decision_text = 'Alike, see d:4.' WHERE decision_text = 'Alike, see d:2.'"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const before = read(
      owner,
      'SELECT id, decision_text, mission_id FROM strategic_decisions ORDER BY id'
    );
    const dry = await importInto(owner, old);
    expect(dry.data?.base).toMatch(/snapshot-/);
    const decisions = dry.data!.tables.find((table) => table.table === 'strategic_decisions')!;
    expect([...decisions.copyChanged, ...decisions.conflicts]).toEqual([]);
    await importInto(owner, old, true);
    expect(
      read(owner, 'SELECT id, decision_text, mission_id FROM strategic_decisions ORDER BY id')
    ).toEqual(before);
  }, 300000);

  it('never takes a row of a cycle, alike only to a row shared before sharing, for one already in the record', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    await on(place, 'rbook_decisions', {
      action: 'record',
      content: 'Alike, see d:1.',
      missionId: 'i-m01',
    });
    await on(place, 'rbook_decisions', { action: 'record', content: 'Alike, see d:2.' });
    const moment = new Date(Date.now() - 90 * 60_000).toISOString();
    onFile(
      place,
      `UPDATE strategic_decisions SET created_at = '${moment}' WHERE decision_text LIKE 'Alike, see d:%'`
    );
    await on(place, 'rbook_db', { action: 'snapshot' });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    fs.cpSync(
      path.join(path.dirname(dbOf(place.root)), 'snapshots'),
      path.join(path.dirname(dbOf(old.root)), 'snapshots'),
      { recursive: true }
    );
    // On the copy: the first deleted, and the second now in a cycle with a row of the copy's own.
    const [second] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'Alike, see d:2.'"
    );
    onFile(
      old,
      "DELETE FROM strategic_decisions WHERE decision_text = 'Alike, see d:1.'",
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Then, see d:${second.id}.', '${new Date().toISOString()}')`
    );
    const [then] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Then, see d:%'"
    );
    onFile(
      old,
      `UPDATE strategic_decisions SET decision_text = 'Alike, see d:${then.id}.' WHERE id = ${second.id}`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const before = read(
      owner,
      "SELECT id, decision_text, mission_id FROM strategic_decisions WHERE decision_text LIKE 'Alike, see d:%' ORDER BY id"
    );
    const dry = await importInto(owner, old);
    const decisions = dry.data!.tables.find((table) => table.table === 'strategic_decisions')!;
    expect([...decisions.copyChanged, ...decisions.conflicts]).toEqual([]);
    expect(decisions.perhapsIn).toEqual([]);
    await importInto(owner, old, true);
    expect(
      read(
        owner,
        "SELECT id, decision_text, mission_id FROM strategic_decisions WHERE decision_text LIKE 'Alike, see d:%' ORDER BY id"
      )
    ).toEqual(before);
  }, 300000);

  it("never takes a row of the copy's own for one already in the record because a shared row it resembles changed since sharing", async () => {
    const place = await preShare(fixture.tmp, {});
    await on(place, 'rbook_decisions', { action: 'record', content: 'Alike, see d:1.' });
    const [shared] = read<{ id: number; created_at: string }>(
      place,
      "SELECT id, created_at FROM strategic_decisions WHERE decision_text = 'Alike, see d:1.'"
    );
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    // The copy lost the shared decision, and holds one of its own made in the same moment, alike but
    // for its number: the shared row is free, and only a create could make it a twin.
    onFile(
      old,
      `DELETE FROM strategic_decisions WHERE id = ${shared.id}`,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Alike, see d:9.', '${shared.created_at}')`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    // A change since sharing gives the shared row a log entry, but no create.
    await on(owner, 'rbook_decisions', {
      action: 'update',
      decisionId: shared.id,
      status: 'archived',
    });
    const dry = await importInto(owner, old);
    const decisions = dry.data!.tables.find((table) => table.table === 'strategic_decisions')!;
    expect(decisions.perhapsIn).toEqual([]);
    expect(decisions.own.map((row) => row.values.decision_text)).toEqual(['Alike, see d:9.']);
  }, 300000);

  it('brings no row of a cycle in twice, and names a row alike to them as perhaps in, which --include brings in', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const moment = new Date(Date.now() + 60_000).toISOString();
    const after = new Date(Date.now() + 120_000).toISOString();
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Same, see d:1.', '${moment}')`,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Same, see d:4.', '${moment}')`,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Cites d:3.', '${after}')`
    );
    // The newer version lost the first; the second and third cite each other.
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    onFile(migrated, "DELETE FROM strategic_decisions WHERE decision_text = 'Same, see d:1.'");
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await importInto(studio, migrated, true);
    const [first] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'Same, see d:1.'"
    );
    const dry = await onCopy(fixture.tmp, studio, (client) => importCopy(client, old.root));
    expect(
      dry
        .data!.tables.find((table) => table.table === 'strategic_decisions')!
        .perhapsIn.map((row) => row.id)
    ).toContain(String(first.id));
    await importInto(studio, old, true);
    const same = () =>
      read<{ decision_text: string }>(
        studio,
        "SELECT decision_text FROM strategic_decisions WHERE decision_text LIKE 'Same, see d:%' ORDER BY id"
      );
    // None of the cycle comes in again, and the first, perhaps one of them, waits for --include.
    expect(same()).toHaveLength(1);
    expect(
      read(studio, "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Cites d:%'")
    ).toHaveLength(1);
    await onCopy(fixture.tmp, studio, (client) =>
      importCopy(client, old.root, { apply: true, include: [`strategic_decisions:${first.id}`] })
    );
    expect(same().filter((row) => row.decision_text === 'Same, see d:1.')).toHaveLength(1);
    expect(same()).toHaveLength(2);
  }, 300000);
});

describe('a copy whose earlier import waits for a verdict', () => {
  /** A member, removed without knowing, imports the copy; its import is quarantined on the owner. */
  async function quarantinedImport() {
    const { zip, owner, studio } = await copyWithItsOwn();
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    await syncCopies(fixture.tmp, studio, owner);
    expect(
      (await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Darryl'))).success
    ).toBe(true);
    await importInto(studio, zip, true);
    await syncCopies(fixture.tmp, studio, owner);
    const quarantined = read<{ txn_id: string }>(
      owner,
      "SELECT txn_id FROM record_txn_state WHERE state = 'quarantined'"
    ).map((row) => row.txn_id);
    expect(quarantined.length).toBeGreaterThan(0);
    return { zip, owner, studio, quarantined };
  }

  it("is not brought in again while it waits, and a field it raised is raised again, since a value no copy took is not the record's", async () => {
    const { zip, owner, quarantined } = await quarantinedImport();
    const dry = await importInto(owner, zip);
    const missions = dry.data!.tables.find((table) => table.table === 'missions')!;
    expect(missions.waiting).toEqual(expect.arrayContaining(['c-m09']));
    expect(missions.own).toEqual([]);
    expect(importText(dry.data!)).toMatch(
      /^missions: \d+ in the copy: .*\d+ waiting on an earlier import/m
    );
    // Archiving now could lose rows that are in no table yet, so the dry run says to keep the copy.
    expect(importText(dry.data!)).toMatch(
      /Keep this copy: \d+ of its rows came in with an earlier import that is not live yet/
    );
    expect(importText(dry.data!)).not.toMatch(/archive it/);
    expect(missions.conflicts.map((change) => change.field)).toEqual(
      expect.arrayContaining(['name'])
    );
    await importInto(owner, zip, true);
    // Refused for good, the waiting rows come in on the next import, once.
    await onCopy(fixture.tmp, owner, (client) =>
      decideTransactions(client, quarantined, 'refused', 'removed before it imported')
    );
    expect((await importInto(owner, zip, true)).data?.applied).toMatchObject({ created: 3 });
    expect(decisionsHolding(owner, "The copy's own decision.")).toHaveLength(1);
    const names = (await onCopy(fixture.tmp, owner, (client) => openConflicts(client)))
      .filter((open) => open.field === 'name')
      .flatMap((open) => open.candidates.map((candidate) => candidate.value));
    expect(names).toContain('Renamed on the copy');
  }, 300000);

  it('refused, then imported again by the member once admitted again: its rows take attempts the refused import never named, and land once on both copies', async () => {
    const { zip, owner, studio, quarantined } = await quarantinedImport();
    await onCopy(fixture.tmp, owner, (client) =>
      decideTransactions(client, quarantined, 'refused', 'removed before it imported')
    );
    await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: 'Darryl' }));
    await syncCopies(fixture.tmp, studio, owner);
    await syncCopies(fixture.tmp, studio, owner);
    // The same copy imports again: its own first attempts were refused, so it takes the next.
    expect((await importInto(studio, zip, true)).data?.applied).toMatchObject({ created: 3 });
    await syncCopies(fixture.tmp, studio, owner);
    await syncCopies(fixture.tmp, studio, owner);
    for (const copy of [owner, studio])
      expect(decisionsHolding(copy, "The copy's own decision.")).toHaveLength(1);
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 300000);

  it("a row the copy gained since, naming a row that waits, waits with it, and comes in naming the copy's row once that row is taken", async () => {
    const { zip, owner } = await quarantinedImport();
    await on(zip, 'rbook_decisions', {
      action: 'record',
      content: 'Decided for the waiting mission.',
      missionId: 'i-m02',
    });
    onFile(
      zip,
      "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('i-m01', 'c-m09', 'blocks')"
    );
    const dry = await importInto(owner, zip);
    const decisions = dry.data!.tables.find((table) => table.table === 'strategic_decisions')!;
    expect(decisions.heldBack).toContainEqual({ id: expect.any(String), names: 'missions:i-m02' });
    // A link to a waiting row waits too, rather than being left out for good.
    const links = dry.data!.tables.find((table) => table.table === 'mission_dependencies')!;
    expect(links.heldBack).toEqual([{ id: 'i-m01|c-m09', names: 'missions:c-m09' }]);
    expect(links.leftOut).toEqual([]);
    expect(decisions.own.map((row) => row.values.decision_text)).not.toContain(
      'Decided for the waiting mission.'
    );
    await importInto(owner, zip, true);
    expect(decisionsHolding(owner, 'Decided for the waiting mission.')).toEqual([]);
    // Admitted again, the member's import is taken; the next import brings the decision in.
    await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: 'Darryl' }));
    await importInto(owner, zip, true);
    const [copys] = missionsNamed(owner, "The copy's i-m02");
    expect(
      read(
        owner,
        "SELECT mission_id FROM strategic_decisions WHERE decision_text = 'Decided for the waiting mission.'"
      )
    ).toEqual([{ mission_id: copys.id }]);
  }, 300000);

  it('taken once the member is admitted again: each row is in the record once', async () => {
    const { zip, owner } = await quarantinedImport();
    await importInto(owner, zip, true);
    await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: 'Darryl' }));
    expect(decisionsHolding(owner, "The copy's own decision.")).toHaveLength(1);
    expect(missionsNamed(owner, "The copy's own mission")).toHaveLength(1);
  }, 300000);
});
