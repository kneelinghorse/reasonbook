// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m14 — rows that wait on an earlier import not live yet, and every row that names one: each waits, down any
// ABOUTME: chain and before any id is given, so an import never fails, never names the wrong row, and brings no row in twice.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { importText } from '../../../src/cli/import';
import { importCopy } from '../../../src/tools/rbook/record-import';
import { decideTransactions } from '../../../src/tools/rbook/record-decide';
import { inviteMember, removeMember } from '../../../src/tools/rbook/record-membership';
import type { ImportPlan } from '../../../src/tools/rbook/record-import-plan';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
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
  fixture = replicaFixture('rbook-import-waits-');
});
afterEach(() => fixture.restore());

const on = (place: Place, tool: string, args: Record<string, unknown>) =>
  onPlace(fixture.tmp, place, tool, args);
const importInto = (target: Copy, from: Place, apply = false) =>
  onCopy(fixture.tmp, target, (client) => importCopy(client, from.root, { apply }));
const tableOf = (plan: ImportPlan, table: string) => plan.tables.find((t) => t.table === table)!;
const decisionsHolding = (copy: Pick<Copy, 'root'>, text: string) =>
  read<{ id: number }>(copy, 'SELECT id FROM strategic_decisions WHERE decision_text = ?', [text]);

/**
 * Share `place` and have a member import `copy` after the owner removed them, so the owner holds
 * that import quarantined: there, each of the copy's own rows waits on it.
 */
async function quarantinedImportOf(place: Place, copy: Place) {
  const owner = await shareExisting(fixture.tmp, place.root);
  const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
  await syncCopies(fixture.tmp, studio, owner);
  expect(
    (await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Darryl'))).success
  ).toBe(true);
  expect((await importInto(studio, copy, true)).success).toBe(true);
  await syncCopies(fixture.tmp, studio, owner);
  expect(
    read(owner, "SELECT 1 FROM record_txn_state WHERE state = 'quarantined'").length
  ).toBeGreaterThan(0);
  return { owner, studio };
}
/** The member admitted again: the owner takes the import it held. */
const readmit = (owner: Copy) =>
  onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: 'Darryl' }));

describe('a row of the copy that names a row waiting on an earlier import', () => {
  it('takes no number while it waits, so the rows after it still come in, and it comes in naming that row once it is taken', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'c-m09',
      name: "The copy's own mission",
      sprintId: 'i-sprint',
    });
    const { owner } = await quarantinedImportOf(place, zip);
    await on(zip, 'rbook_decisions', {
      action: 'record',
      content: 'Decided for the waiting mission.',
      missionId: 'c-m09',
    });
    await on(zip, 'rbook_decisions', { action: 'record', content: 'A later decision of its own.' });
    const dry = (await importInto(owner, zip)).data!;
    const decisions = tableOf(dry, 'strategic_decisions');
    const [held] = read<{ id: number }>(
      zip,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'Decided for the waiting mission.'"
    );
    expect(decisions.heldBack).toContainEqual({ id: String(held.id), names: 'missions:c-m09' });
    expect(decisions.own.map((row) => row.values.decision_text)).toContain(
      'A later decision of its own.'
    );
    expect(decisions.own.map((row) => row.values.decision_text)).not.toContain(
      'Decided for the waiting mission.'
    );
    // It is the copy's own row, waiting with one an earlier import brought in: never said to be
    // one that import brought.
    const text = importText(dry);
    expect(text).toContain(`  strategic_decisions:${held.id} names missions:c-m09`);
    const brought = text
      .split('\n')
      .findIndex((line) => line.startsWith('Brought in by an earlier'));
    const listedThere = text
      .split('\n')
      .slice(brought + 1)
      .findIndex((line) => !line.startsWith('  '));
    expect(
      text
        .split('\n')
        .slice(brought + 1, brought + 1 + listedThere)
        .some((line) => line === `  strategic_decisions:${held.id}`)
    ).toBe(false);
    expect(text).toMatch(
      /, and 1 more waits with one of them; archiving it before what they wait on is taken or refused could lose them\. Import it again once it is\./
    );
    expect(text).toMatch(
      /^strategic_decisions: \d+ in the copy: .*\d+ waiting with a row they name/m
    );
    const applied = await importInto(owner, zip, true);
    expect(applied.error).toBeUndefined();
    // Applied, the copy still holds a row the record does not, so the answer says to keep it.
    expect(importText(applied.data!)).toMatch(/^Keep this copy: /m);
    expect(decisionsHolding(owner, 'A later decision of its own.')).toHaveLength(1);
    expect(decisionsHolding(owner, 'Decided for the waiting mission.')).toEqual([]);
    await readmit(owner);
    expect((await importInto(owner, zip, true)).error).toBeUndefined();
    expect(
      read(
        owner,
        "SELECT mission_id FROM strategic_decisions WHERE decision_text = 'Decided for the waiting mission.'"
      )
    ).toEqual([{ mission_id: 'c-m09' }]);
    expect(decisionsHolding(owner, 'A later decision of its own.')).toHaveLength(1);
  }, 300000);

  it('waits down a chain: a mission in a waiting sprint, a link and a decision naming that mission, and a shared row the copy pointed at it', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_sprint', {
      action: 'add',
      sprintId: 'c-sprint',
      title: "The copy's sprint",
      status: 'Planned',
    });
    const { owner } = await quarantinedImportOf(place, zip);
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'c-m10',
      name: 'In the waiting sprint',
      sprintId: 'c-sprint',
    });
    await on(zip, 'rbook_decisions', {
      action: 'record',
      content: 'Decided for c-m10.',
      missionId: 'c-m10',
    });
    const [{ mission_id: before }] = read<{ mission_id: string | null }>(
      owner,
      'SELECT mission_id FROM strategic_decisions WHERE id = 1'
    );
    onFile(
      zip,
      "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('c-m10', 'i-m01', 'blocks')",
      "UPDATE strategic_decisions SET mission_id = 'c-m10' WHERE id = 1"
    );
    const dry = (await importInto(owner, zip)).data!;
    expect(tableOf(dry, 'missions').heldBack).toEqual([{ id: 'c-m10', names: 'sprints:c-sprint' }]);
    // Its decision names the sprint and the mission; the first that waits is said.
    const [decided] = read<{ id: number }>(
      zip,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'Decided for c-m10.'"
    );
    expect(tableOf(dry, 'strategic_decisions').heldBack.map((row) => row.id)).toContain(
      String(decided.id)
    );
    expect(tableOf(dry, 'mission_dependencies').heldBack).toEqual([
      { id: 'c-m10|i-m01', names: 'missions:c-m10' },
    ]);
    // The shared decision 1 keeps the record's mission until c-m10 is taken: nothing raised or set
    // names a mission the record does not hold.
    const decisions = tableOf(dry, 'strategic_decisions');
    expect(
      [...decisions.conflicts, ...decisions.copyChanged].filter(
        (change) => change.field === 'mission_id'
      )
    ).toEqual([]);
    expect(decisions.leftOut).toContainEqual(
      expect.objectContaining({ row: 'strategic_decisions:1', column: 'mission_id', waits: true })
    );
    // Said apart from the rows the record will not hold, and counted where the record's value stays.
    const text = importText(dry);
    expect(text).toMatch(
      /^Naming a row that waits on a change the record has not taken, so the record keeps its own value until that change is taken or refused:\n(?: {2}.*\n)* {2}strategic_decisions:1 mission_id names missions:c-m10$/m
    );
    expect(text).not.toMatch(/strategic_decisions:1 mission_id names missions:c-m10: /);
    expect(text).toMatch(
      /^strategic_decisions: \d+ in the copy: .*1 field\(s\) naming a row left out or waiting, kept as the record holds them/m
    );
    const applied = await importInto(owner, zip, true);
    expect(applied.error).toBeUndefined();
    expect(read(owner, 'PRAGMA foreign_key_check')).toEqual([]);
    expect(read(owner, "SELECT id FROM missions WHERE id = 'c-m10'")).toEqual([]);
    expect(read(owner, 'SELECT mission_id FROM strategic_decisions WHERE id = 1')).toEqual([
      { mission_id: before },
    ]);
    await readmit(owner);
    expect((await importInto(owner, zip, true)).error).toBeUndefined();
    expect(read(owner, "SELECT sprint_id FROM missions WHERE id = 'c-m10'")).toEqual([
      { sprint_id: 'c-sprint' },
    ]);
    expect(
      read(
        owner,
        "SELECT mission_id FROM strategic_decisions WHERE decision_text = 'Decided for c-m10.'"
      )
    ).toEqual([{ mission_id: 'c-m10' }]);
    expect(
      read(owner, "SELECT 1 FROM mission_dependencies WHERE from_id = 'c-m10' AND to_id = 'i-m01'")
    ).toHaveLength(1);
    expect(read(owner, 'PRAGMA foreign_key_check')).toEqual([]);
  }, 300000);

  it("citing one of the copy's own decisions that waits, waits with it, and comes in citing that decision's number in the record", async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_decisions', { action: 'record', content: "The copy's own decision." });
    // The record numbers a decision after the copy, so the member's import renumbers the copy's.
    await on(place, 'rbook_decisions', {
      action: 'record',
      content: 'The owner decided after the copy.',
    });
    const { owner } = await quarantinedImportOf(place, zip);
    const [cited] = read<{ id: number }>(
      zip,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'The copy''s own decision.'"
    );
    await on(zip, 'rbook_decisions', { action: 'record', content: `Follows d:${cited.id}.` });
    // Only its citation names a row that waits: not the session it was recorded in.
    onFile(
      zip,
      "UPDATE strategic_decisions SET author_session_id = NULL, sprint_id = NULL, mission_id = NULL WHERE decision_text LIKE 'Follows d:%'"
    );
    const [citing] = read<{ id: number }>(
      zip,
      "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Follows d:%'"
    );
    const dry = (await importInto(owner, zip)).data!;
    expect(tableOf(dry, 'strategic_decisions').heldBack).toContainEqual({
      id: String(citing.id),
      names: `strategic_decisions:${cited.id}`,
    });
    expect((await importInto(owner, zip, true)).error).toBeUndefined();
    expect(
      read(owner, "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'Follows d:%'")
    ).toEqual([]);
    await readmit(owner);
    expect((await importInto(owner, zip, true)).error).toBeUndefined();
    const [inRecord] = decisionsHolding(owner, "The copy's own decision.");
    expect(inRecord.id).not.toBe(cited.id);
    expect(
      read(
        owner,
        "SELECT decision_text FROM strategic_decisions WHERE decision_text LIKE 'Follows d:%'"
      )
    ).toEqual([{ decision_text: `Follows d:${inRecord.id}.` }]);
  }, 300000);
});

describe("a copy's old schema, imported while its newer version's import waits", () => {
  it('waits on that import, row by row, and once it is taken the record holds each row once', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const later = new Date(Date.now() + 60_000).toISOString();
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('The copy''s own decision.', '${later}')`,
      `INSERT INTO missions (id, sprint_id, name, status, created_at) VALUES ('c-m09', 'i-sprint', 'The copy''s own mission', 'Queued', '${later}')`
    );
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    // A newer server opens one of the two, giving its rows stable ids of their own.
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'A later decision on it.' });
    const { owner, studio } = await quarantinedImportOf(place, migrated);
    const dry = (await importInto(owner, old)).data!;
    // The newer version's import derived its ids from rows the older one does not hold, so nothing
    // shows that change is an import of this copy: the row waits on it, said as such.
    expect(tableOf(dry, 'missions').waitingOnCreate).toEqual(['c-m09']);
    expect(importText(dry)).toMatch(
      /^missions: \d+ in the copy: .*1 waiting on a change the record has not taken/m
    );
    const [own] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'The copy''s own decision.'"
    );
    expect(tableOf(dry, 'strategic_decisions').waitingOnCreate).toContain(String(own.id));
    expect(dry.ownRows).toBe(0);
    expect((await importInto(owner, old, true)).error).toBeUndefined();
    await readmit(owner);
    await syncCopies(fixture.tmp, studio, owner);
    await syncCopies(fixture.tmp, studio, owner);
    expect(decisionsHolding(owner, "The copy's own decision.")).toHaveLength(1);
    expect(
      read(owner, "SELECT id FROM missions WHERE name = 'The copy''s own mission'")
    ).toHaveLength(1);
    expect(recordedState(studio)).toEqual(recordedState(owner));
  }, 300000);
});

describe('a row a change the record has not taken holds', () => {
  it('waits on it, said as such rather than as an earlier import, whoever wrote it, and comes in once that change is refused', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m01',
      name: "The copy's x",
      sprintId: 'i-sprint',
    });
    // A decision and a link of the copy's that name it wait with it.
    await on(zip, 'rbook_decisions', {
      action: 'record',
      content: 'Decided for x-m01.',
      missionId: 'x-m01',
    });
    onFile(
      zip,
      "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('x-m01', 'i-m01', 'Requires')"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await syncCopies(fixture.tmp, studio, owner);
    expect(
      (await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Darryl'))).success
    ).toBe(true);
    // Removed without knowing, the member makes a mission of the same id, its own and no import.
    await on(studio, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m01',
      name: "Darryl's x",
      sprintId: 'i-sprint',
    });
    await syncCopies(fixture.tmp, studio, owner);
    const dry = (await importInto(owner, zip)).data!;
    expect(tableOf(dry, 'missions')).toMatchObject({ waiting: [], waitingOnCreate: ['x-m01'] });
    expect(tableOf(dry, 'strategic_decisions').heldBack.map((row) => row.names)).toContain(
      'missions:x-m01'
    );
    expect(tableOf(dry, 'mission_dependencies').heldBack).toEqual([
      { id: 'x-m01|i-m01', names: 'missions:x-m01' },
    ]);
    const text = importText(dry);
    expect(text).not.toMatch(/came in with an earlier import|Brought in by an earlier import/);
    expect(text).toMatch(
      /^Keep this copy: 1 matches a change the record has not taken yet, and 2 more wait with one of them; /m
    );
    // Refused, the member's mission never stands, and the copy's comes in once.
    const quarantined = read<{ txn_id: string }>(
      owner,
      "SELECT txn_id FROM record_txn_state WHERE state = 'quarantined'"
    ).map((row) => row.txn_id);
    await onCopy(fixture.tmp, owner, (client) =>
      decideTransactions(client, quarantined, 'refused', 'removed before it wrote')
    );
    expect((await importInto(owner, zip, true)).error).toBeUndefined();
    expect(read(owner, "SELECT name FROM missions WHERE id = 'x-m01'")).toEqual([
      { name: "The copy's x" },
    ]);
    expect(
      read(
        owner,
        "SELECT mission_id FROM strategic_decisions WHERE decision_text = 'Decided for x-m01.'"
      )
    ).toEqual([{ mission_id: 'x-m01' }]);
    expect(
      read(owner, "SELECT 1 FROM mission_dependencies WHERE from_id = 'x-m01' AND to_id = 'i-m01'")
    ).toHaveLength(1);
  }, 300000);
});

describe('a row deleted on the owner that --include names', () => {
  it('waits with a waiting row it names, said once, as named by --include', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const [{ at: marker }] = read<{ at: string }>(
      place,
      'SELECT created_at AS at FROM context_snapshots ORDER BY id DESC LIMIT 1'
    );
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_sprint', {
      action: 'add',
      sprintId: 'c-sprint',
      title: "The copy's sprint",
      status: 'Planned',
    });
    const { owner } = await quarantinedImportOf(place, zip);
    // A mission dated before the marker, so deleted on the owner, that the copy put in its sprint.
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'd-m01',
      name: 'Dated before the marker',
      sprintId: 'c-sprint',
    });
    const before = new Date(Date.parse(marker) - 3_600_000).toISOString();
    onFile(zip, `UPDATE missions SET created_at = '${before}' WHERE id = 'd-m01'`);
    const dry = (
      await onCopy(fixture.tmp, owner, (client) =>
        importCopy(client, zip.root, { include: ['missions:d-m01'] })
      )
    ).data!;
    expect(tableOf(dry, 'missions').heldBack).toEqual([{ id: 'd-m01', names: 'sprints:c-sprint' }]);
    const text = importText(dry);
    expect(text).toContain(
      `  missions:d-m01 (${before}), named by --include, and waiting with a row it names (below)`
    );
    expect(text).toMatch(/^missions: .*1 waiting with a row they name/m);
    expect(text).not.toMatch(/^missions: .*deleted on the owner/m);
  }, 300000);
});

describe('a reference both stores hold alike that names a row which waits', () => {
  it('is named as waiting, never read as the record holds it, since the same id names another row there', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    // Each makes its own x-m01 and points decision 1 and a link at it.
    for (const [where, name] of [
      [zip, "The copy's x-m01"],
      [place, "The owner's x-m01"],
    ] as const) {
      await on(where, 'rbook_mission', {
        action: 'add',
        missionId: 'x-m01',
        name,
        sprintId: 'i-sprint',
      });
      onFile(
        where,
        "UPDATE strategic_decisions SET mission_id = 'x-m01' WHERE id = 1",
        "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('x-m01', 'i-m01', 'Requires')"
      );
    }
    const { owner } = await quarantinedImportOf(place, zip);
    const dry = (await importInto(owner, zip)).data!;
    expect(tableOf(dry, 'strategic_decisions').leftOut).toContainEqual(
      expect.objectContaining({ row: 'strategic_decisions:1', column: 'mission_id', waits: true })
    );
    expect(tableOf(dry, 'mission_dependencies').heldBack).toEqual([
      { id: 'x-m01|i-m01', names: 'missions:x-m01' },
    ]);
    expect(tableOf(dry, 'mission_dependencies').identical).toBe(0);
  }, 300000);
  it('is named as waiting in the dry run where the record holds no row of that id either', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m01',
      name: "The copy's x-m01",
      sprintId: 'i-sprint',
    });
    onFile(zip, "UPDATE strategic_decisions SET mission_id = 'x-m01' WHERE id = 1");
    // The owner's decision names an x-m01 it made and deleted before sharing: the record holds none.
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m01',
      name: "The owner's x-m01",
      sprintId: 'i-sprint',
    });
    onFile(
      place,
      "UPDATE strategic_decisions SET mission_id = 'x-m01' WHERE id = 1",
      'PRAGMA foreign_keys = OFF',
      "DELETE FROM missions WHERE id = 'x-m01'"
    );
    const { owner } = await quarantinedImportOf(place, zip);
    expect(read(owner, "SELECT id FROM missions WHERE id = 'x-m01'")).toEqual([]);
    const dry = (await importInto(owner, zip)).data!;
    expect(tableOf(dry, 'strategic_decisions').leftOut).toContainEqual(
      expect.objectContaining({ row: 'strategic_decisions:1', column: 'mission_id', waits: true })
    );
    expect(importText(dry)).toMatch(
      /^Naming a row that waits on a change the record has not taken, [^\n]*:\n {2}strategic_decisions:1 mission_id names missions:x-m01$/m
    );
  }, 300000);
});

describe("a citation cycle in an old copy whose newer version's import waits", () => {
  it('is left out as perhaps in the record already, and once that import is taken each row is in once', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const old = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    onFile(
      old,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('First.', '${at(60_000)}')`,
      `INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Second.', '${at(120_000)}')`
    );
    const [first, second] = read<{ id: number }>(
      old,
      "SELECT id FROM strategic_decisions WHERE decision_text IN ('First.', 'Second.') ORDER BY id"
    );
    onFile(
      old,
      `UPDATE strategic_decisions SET decision_text = 'First, see d:${second.id}.' WHERE id = ${first.id}`,
      `UPDATE strategic_decisions SET decision_text = 'Second, see d:${first.id}.' WHERE id = ${second.id}`
    );
    const migrated = { root: path.join(fixture.tmp, 'migrated'), machine: 'machine-migrated' };
    fs.cpSync(old.root, migrated.root, { recursive: true });
    await on(migrated, 'rbook_decisions', { action: 'record', content: 'Later on it.' });
    const { owner, studio } = await quarantinedImportOf(place, migrated);
    const dry = (await importInto(owner, old)).data!;
    // Only a change the record has not taken yet holds their twins, so no record row is named.
    expect(tableOf(dry, 'strategic_decisions').perhapsIn.map((row) => row.as)).toEqual([[], []]);
    expect(dry.ownRows).toBe(0);
    const text = importText(dry);
    expect(text).toMatch(
      /^ {2}strategic_decisions:\d+, perhaps a row a change the record has not taken yet holds$/m
    );
    // Should that change be refused, only this copy holds them: never called safe to archive.
    expect(text.split('\n').pop()).toBe(
      'Keep this copy: 2 are perhaps a row a change the record has not taken yet holds; archiving it before what they wait on is taken or refused could lose them. Import it again once it is.'
    );
    const applied = await importInto(owner, old, true);
    expect(applied.error).toBeUndefined();
    expect(importText(applied.data!)).toMatch(/^Keep this copy: 2 are perhaps a row a change/m);
    await readmit(owner);
    await syncCopies(fixture.tmp, studio, owner);
    await syncCopies(fixture.tmp, studio, owner);
    expect(
      read(
        owner,
        "SELECT id FROM strategic_decisions WHERE decision_text LIKE 'First, see d:%' OR decision_text LIKE 'Second, see d:%'"
      )
    ).toHaveLength(2);
  }, 300000);
});
