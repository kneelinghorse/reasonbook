// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m14 — how the import tells rows and fields apart: which match rules hold, which base row a field is read
// ABOUTME: against, how a time without a zone is read, and that the plan under the lock sees a write made after the dry run.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { importText } from '../../../src/cli/import';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { recordedExecute } from '../../../src/tools/rbook/record-changes';
import { importCopy, type ImportReport } from '../../../src/tools/rbook/record-import';
import * as planModule from '../../../src/tools/rbook/record-import-plan';
import type { TablePlan } from '../../../src/tools/rbook/record-import-plan';
import { decideTransactions } from '../../../src/tools/rbook/record-decide';
import { openConflicts, settleField } from '../../../src/tools/rbook/record-settle';
import * as standing from '../../../src/tools/rbook/record-standing';
import * as sharing from '../../../src/tools/rbook/sharing-preconditions';
import {
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
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
  shareExisting,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-import-classify-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

const on = (place: Place, tool: string, args: Record<string, unknown>) =>
  onPlace(fixture.tmp, place, tool, args);
const importInto = (target: Copy, from: Place, options: Parameters<typeof importCopy>[2] = {}) =>
  onCopy(fixture.tmp, target, (client) => importCopy(client, from.root, options));
const table = (report: ImportReport | undefined, name: string): TablePlan =>
  report!.tables.find((entry) => entry.table === name)!;
const markerAt = (place: Place) =>
  read<{ at: string }>(
    place,
    'SELECT created_at AS at FROM context_snapshots ORDER BY id DESC LIMIT 1'
  )[0].at;
/** A time as SQLite's datetime() writes it: UTC, with no zone. */
const zoneless = (ms: number) =>
  new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '');

/** Each query asked of the change log whose plan scans the whole log rather than searching an index. */
function logScans(
  client: RbookDatabaseClient,
  asked: ReadonlyArray<readonly [string, readonly unknown[]]>
): string[] {
  const scans = new Set<string>();
  for (const [sql, params] of asked) {
    if (!/record_changes/.test(sql)) continue;
    const plan = client.getMany<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${sql}`,
      params.map(() => null)
    );
    if ((plan.data ?? []).some((step) => /^SCAN (TABLE )?record_changes\b/.test(step.detail)))
      scans.add(sql);
  }
  return [...scans];
}

describe('matching', () => {
  it('a stable id both held matches the row even when the copy reworded its text, so the text is raised, not brought in as a new row', async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    onFile(
      zip,
      "UPDATE strategic_decisions SET decision_text = 'Reworded on the copy.' WHERE id = 1"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const decisions = table((await importInto(owner, zip)).data, 'strategic_decisions');
    expect(decisions).toMatchObject({ own: [], copyRows: 1, identical: 0 });
    expect(decisions.conflicts).toEqual([
      expect.objectContaining({ field: 'decision_text', copy: 'Reworded on the copy.' }),
    ]);
  }, 120000);

  it('one text id is created on both only when both rows were made after the marker', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    // i-m01 was made before the marker; the copy makes it again, so the two hold different stable ids.
    onFile(zip, 'PRAGMA foreign_keys = OFF', "DELETE FROM missions WHERE id = 'i-m01'");
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m01',
      name: 'Made again on the copy',
      sprintId: 'i-sprint',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const missions = table((await importInto(owner, zip)).data, 'missions');
    expect(missions).toMatchObject({ createdOnBoth: [], own: [] });
    // One row, so its fields are compared: the name, and the time the copy made it again.
    expect(missions.conflicts.map((change) => `${change.id} ${change.field}`).sort()).toEqual([
      'i-m01 created_at',
      'i-m01 name',
    ]);
  }, 120000);

  it("one text id is created on both only when the copy's row too was made after the marker", async () => {
    const place = await preShare(fixture.tmp, {});
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: 'Before the marker',
      sprintId: 'i-sprint',
    });
    await on(place, 'rbook_context', { action: 'snapshot', source: 'before the copy' });
    const zip = zipOf(fixture.tmp, place);
    // The owner deletes i-m02 and makes it again after the marker, under a new stable id.
    onFile(place, 'PRAGMA foreign_keys = OFF', "DELETE FROM missions WHERE id = 'i-m02'");
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: 'Made again on the owner',
      sprintId: 'i-sprint',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const missions = table((await importInto(owner, zip)).data, 'missions');
    expect(missions).toMatchObject({ createdOnBoth: [], own: [] });
    expect(missions.conflicts.map((change) => `${change.id} ${change.field}`)).toEqual(
      expect.arrayContaining(['i-m02 name'])
    );
  }, 120000);

  it('one text id is created on both only when the copy held a stable id of its own for it', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: "The owner's",
      sprintId: 'i-sprint',
    });
    // A copy from before stable ids: its i-m02, made after the marker, gets one only from the schema step.
    const zip = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    onFile(
      zip,
      `UPDATE missions SET name = 'The copy''s', created_at = '${new Date(Date.now() + 60000).toISOString()}' WHERE id = 'i-m02'`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const missions = table((await importInto(owner, zip)).data, 'missions');
    expect(missions).toMatchObject({ createdOnBoth: [], own: [] });
    expect(missions.conflicts.map((change) => `${change.id} ${change.field}`).sort()).toEqual([
      'i-m02 created_at',
      'i-m02 name',
    ]);
  }, 120000);

  it("a copy-only row with no time of its own is the copy's own, and the dry run says it may be one the owner deleted", async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_sprint', {
      action: 'add',
      sprintId: 'c-sprint',
      title: 'Only on the copy',
      status: 'Planned',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    expect(table(dry.data, 'sprints').own).toEqual([
      expect.objectContaining({ id: 'c-sprint', at: null }),
    ]);
    expect(importText(dry.data!)).toMatch(
      /sprints:c-sprint; undated, so it may be a row the owner deleted/
    );
  }, 120000);

  it("the copy's own author stays on a row it brings in, and every count is exact: identical rows and links, and the after-marker flag", async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: 'Second',
      sprintId: 'i-sprint',
    });
    onFile(
      place,
      "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('i-m02', 'i-m01', 'blocks')"
    );
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_decisions', { action: 'record', content: "The copy's own." });
    onFile(
      zip,
      "UPDATE strategic_decisions SET author_name = 'Copy Author' WHERE decision_text = 'The copy''s own.'",
      `UPDATE missions SET name = 'Renamed on the copy', completed_at = '${new Date(Date.now() + 60000).toISOString()}' WHERE id = 'i-m02'`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    expect(table(dry.data, 'missions')).toMatchObject({ copyRows: 2, identical: 1 });
    expect(table(dry.data, 'mission_dependencies')).toMatchObject({ copyRows: 1, identical: 1 });
    expect(table(dry.data, 'missions').conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'name', afterMarker: true })])
    );
    expect(dry.data!.flagged).toBe(table(dry.data, 'missions').conflicts.length);
    expect((await importInto(owner, zip, { apply: true })).data?.applied).toMatchObject({
      created: 1,
    });
    expect(
      read(
        owner,
        "SELECT author_name FROM strategic_decisions WHERE decision_text = 'The copy''s own.'"
      )
    ).toEqual([{ author_name: 'Copy Author' }]);
  }, 120000);
});

describe('a numbered row matched by its text and time', () => {
  it('matches a record row no other copy row matched, so a second row with the same words and time comes in as its own', async () => {
    const place = await preShare(fixture.tmp, {});
    await on(place, 'rbook_decisions', { action: 'record', content: 'Same words.' });
    const [shared] = read<{ id: number; created_at: string }>(
      place,
      "SELECT id, created_at FROM strategic_decisions WHERE decision_text = 'Same words.'"
    );
    const zip = oldCopyOf(fixture.tmp, place, 'schema-2.1.sql');
    onFile(
      zip,
      `INSERT INTO strategic_decisions (decision_text, created_at, category, status) VALUES ('Same words.', '${shared.created_at}', 'copy-only', 'archived')`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    const decisions = table(dry.data, 'strategic_decisions');
    // The shared row matches its own number; the copy's second row is never read against it.
    expect(decisions.own.map((row) => row.values.category)).toEqual(['copy-only']);
    expect(
      [...decisions.conflicts, ...decisions.copyChanged].filter(
        (change) => change.id === String(shared.id)
      )
    ).toEqual([]);
    await importInto(owner, zip, { apply: true });
    expect(
      read(
        owner,
        "SELECT category FROM strategic_decisions WHERE decision_text = 'Same words.' ORDER BY id"
      )
    ).toEqual([{ category: null }, { category: 'copy-only' }]);
  }, 120000);
});

describe("the record's own history", () => {
  it('counts a value a settle kept as one the record held, though the write it kept was refused since', async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, "UPDATE missions SET name = 'Studio renamed' WHERE id = 'i-m01'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await on(owner, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Owner renamed' },
    });
    await on(studio, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Studio renamed' },
    });
    await syncCopies(fixture.tmp, studio, owner);
    const replica = read<{ replica: string }>(
      studio,
      "SELECT value AS replica FROM metadata WHERE key = 'replica_id'"
    )[0].replica;
    const [{ txn }] = read<{ txn: string }>(
      owner,
      "SELECT txn_id AS txn FROM record_changes WHERE replica_id = ? AND entity = 'missions' AND field = 'name'",
      [replica]
    );
    await onCopy(fixture.tmp, owner, (client) =>
      settleField(client, {
        table: 'missions',
        recordId: 'i-m01',
        field: 'name',
        value: 'Studio renamed',
      })
    );
    // The member's write is refused after the settle kept its value: the settle alone holds it now.
    await onCopy(fixture.tmp, owner, (client) =>
      decideTransactions(client, [txn], 'refused', 'refused after the settle')
    );
    await on(owner, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed again' },
    });
    const dry = await importInto(owner, zip);
    const missions = table(dry.data, 'missions');
    expect(missions.heldBefore).toBe(1);
    expect(missions.conflicts.filter((change) => change.field === 'name')).toEqual([]);
  }, 240000);
});

describe('a copy with no marker', () => {
  it('flags no field as changed after the marker, and reads a value a create of the record held as held', async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'add',
      missionId: 'y-m01',
      name: 'Same name',
      sprintId: 'i-sprint',
    });
    onFile(
      zip,
      `UPDATE missions SET name = 'Renamed on the copy', updated_at = '${new Date(Date.now() + 60000).toISOString()}' WHERE id = 'i-m01'`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    // After sharing, the record makes y-m01 under the same name and renames it.
    await on(owner, 'rbook_mission', {
      action: 'add',
      missionId: 'y-m01',
      name: 'Same name',
      sprintId: 'i-sprint',
    });
    await on(owner, 'rbook_mission', {
      action: 'update',
      missionId: 'y-m01',
      fields: { name: 'Renamed later' },
    });
    const dry = await importInto(owner, zip);
    expect(dry.data!.marker).toBeNull();
    expect(dry.data!.flagged).toBe(0);
    const missions = table(dry.data, 'missions');
    expect(missions.conflicts.map((change) => [change.id, change.afterMarker])).toEqual(
      expect.arrayContaining([['i-m01', false]])
    );
    // The copy's y-m01 name is the one the record's own create held before its rename.
    expect(missions.heldBefore).toBeGreaterThanOrEqual(1);
    expect(
      missions.conflicts.filter((change) => change.id === 'y-m01').map((change) => change.field)
    ).not.toContain('name');
  }, 120000);
});

describe('the base', () => {
  it('a row is read against the base by its id, never its text, so a text the copy reworded is changed only on the copy', async () => {
    const place = await preShare(fixture.tmp, { base: true });
    const zip = zipOf(fixture.tmp, place);
    onFile(
      zip,
      "UPDATE strategic_decisions SET decision_text = 'Reworded on the copy.' WHERE id = 1"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    await on(owner, 'rbook_decisions', { action: 'update', decisionId: 1, status: 'archived' });
    const decisions = table((await importInto(owner, zip)).data, 'strategic_decisions');
    expect(decisions.copyChanged.map((change) => change.field)).toEqual(['decision_text']);
    expect(decisions.conflicts).toEqual([]);
    expect(decisions.ownerChanged).toBe(1);
  }, 120000);

  it('a row the base does not hold has its differing fields raised, and the dry run counts them apart from the base', async () => {
    const place = await preShare(fixture.tmp, { base: true });
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: 'Added after the base',
      sprintId: 'i-sprint',
    });
    const zip = zipOf(fixture.tmp, place);
    const owner = await shareExisting(fixture.tmp, place.root);
    await on(owner, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m02',
      fields: { name: 'Renamed on the owner' },
    });
    const dry = await importInto(owner, zip);
    // The record held the copy's name before it renamed the mission: the record changed it.
    expect(table(dry.data, 'missions')).toMatchObject({ heldBefore: 1, conflicts: [] });
    onFile(zip, "UPDATE missions SET name = 'Renamed on the copy' WHERE id = 'i-m02'");
    const raised = await importInto(owner, zip);
    expect(table(raised.data, 'missions').conflicts).toEqual([
      expect.objectContaining({ id: 'i-m02', field: 'name', based: false }),
    ]);
    expect(importText(raised.data!)).toMatch(
      /1 raised field\(s\) are on rows or columns the base does not hold, so they are raised as with no base\./
    );
  }, 120000);

  /** Change the base snapshot both folders hold, keeping its bytes the same in both. */
  function alterBase(place: Place, zip: Place, ...statements: string[]): void {
    const dir = path.join(path.dirname(dbOf(place.root)), 'snapshots');
    const name = fs.readdirSync(dir).filter((file) => file.endsWith('.sqlite'))[0];
    const db = new Database(path.join(dir, name));
    try {
      for (const statement of statements) db.exec(statement);
      db.pragma('journal_mode = DELETE');
    } finally {
      db.close();
    }
    for (const suffix of ['-wal', '-shm'])
      fs.rmSync(path.join(dir, name) + suffix, { force: true });
    fs.copyFileSync(
      path.join(dir, name),
      path.join(path.dirname(dbOf(zip.root)), 'snapshots', name)
    );
  }

  it('reads a column the base keeps under its old name by that name, so the base settles it', async () => {
    const place = await preShare(fixture.tmp, { base: true });
    const zip = zipOf(fixture.tmp, place);
    alterBase(
      place,
      zip,
      'ALTER TABLE strategic_decisions RENAME COLUMN author_session_id TO session_id'
    );
    onFile(zip, 'ALTER TABLE strategic_decisions RENAME COLUMN author_session_id TO session_id');
    // Before sharing, only the owner gives the decision another session.
    await on(place, 'rbook_session', { action: 'start', title: 'Later on the owner' });
    const [{ id: later }] = read<{ id: string }>(
      place,
      'SELECT id FROM sessions ORDER BY julianday(started_at) DESC, id DESC LIMIT 1'
    );
    onFile(place, `UPDATE strategic_decisions SET author_session_id = '${later}'`);
    const owner = await shareExisting(fixture.tmp, place.root);
    const decisions = table((await importInto(owner, zip)).data, 'strategic_decisions');
    expect(decisions.conflicts).toEqual([]);
    expect(decisions.ownerChanged).toBe(1);
  }, 120000);

  it('a column the base lacks cannot tell either side: a field there is raised and counted as with no base', async () => {
    const place = await preShare(fixture.tmp, { base: true });
    const zip = zipOf(fixture.tmp, place);
    // A view names the column, so it is renamed away rather than dropped.
    alterBase(place, zip, 'ALTER TABLE missions RENAME COLUMN objective TO objective_before');
    await on(place, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { objective: 'Set on the owner after the copy' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = await importInto(owner, zip);
    expect(table(dry.data, 'missions').conflicts).toEqual([
      expect.objectContaining({ field: 'objective', based: false }),
    ]);
    expect(importText(dry.data!)).toMatch(
      /1 raised field\(s\) are on rows or columns the base does not hold/
    );
  }, 120000);

  it('reads a copy kept in WAL mode, and the change its live WAL holds, without writing beside its store', async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    const folder = path.dirname(dbOf(zip.root));
    // A connection left open keeps a WAL holding a rename the store file does not.
    const writer = new Database(dbOf(zip.root));
    try {
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      writer.exec("UPDATE missions SET name = 'Renamed in the WAL' WHERE id = 'i-m01'");
      const state = () =>
        fs
          .readdirSync(folder)
          .filter((name) => name.startsWith('rbook.sqlite'))
          .map((name) => {
            const stat = fs.statSync(path.join(folder, name));
            return `${name} ${stat.size} ${stat.mtimeMs}`;
          })
          .sort();
      const before = state();
      const owner = await shareExisting(fixture.tmp, place.root);
      const dry = await importInto(owner, zip);
      expect(table(dry.data, 'missions').conflicts).toEqual([
        expect.objectContaining({ field: 'name', copy: 'Renamed in the WAL' }),
      ]);
      expect(state()).toEqual(before);
    } finally {
      writer.close();
    }
  }, 120000);

  it('leaves a copy kept in WAL mode with no live WAL without an index or log beside its store', async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, 'PRAGMA journal_mode = WAL');
    const folder = path.dirname(dbOf(zip.root));
    const listing = () => fs.readdirSync(folder).sort();
    const before = listing();
    expect(before.filter((name) => /-(shm|wal)$/.test(name))).toEqual([]);
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, zip);
    await importInto(owner, zip, { apply: true });
    expect(listing()).toEqual(before);
  }, 120000);

  it("is copied before it is opened, so the copy's folder is left as it was", async () => {
    const place = await preShare(fixture.tmp, { base: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    const listing = () =>
      fs
        .readdirSync(path.join(path.dirname(dbOf(zip.root)), 'snapshots'))
        .map(
          (name) =>
            `${name} ${fs.statSync(path.join(path.dirname(dbOf(zip.root)), 'snapshots', name)).size}`
        );
    const before = listing();
    const owner = await shareExisting(fixture.tmp, place.root);
    expect((await importInto(owner, zip)).data?.base).toMatch(/snapshot-/);
    await importInto(owner, zip, { apply: true });
    expect(listing()).toEqual(before);
  }, 120000);
});

describe('the conflict list', () => {
  it('builds one merge context for every root candidate it lists, so a long list stays quick', async () => {
    const place = await preShare(fixture.tmp, {});
    for (let index = 0; index < 5; index += 1)
      await on(place, 'rbook_sprint', {
        action: 'add',
        sprintId: `s-${index}`,
        title: 'Shared',
        status: 'Planned',
      });
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, "UPDATE sprints SET title = 'Retitled on the copy' WHERE id LIKE 's-%'");
    const owner = await shareExisting(fixture.tmp, place.root);
    expect((await importInto(owner, zip, { apply: true })).data?.applied).toMatchObject({
      conflicts: 5,
    });
    const built = jest.spyOn(standing, 'mergeContext');
    const listed = await onCopy(fixture.tmp, owner, (client) => openConflicts(client));
    expect(listed).toHaveLength(5);
    expect(built.mock.calls.length).toBeLessThanOrEqual(1);
  }, 120000);

  it('reads the change log through an index for every candidate it lists, so its cost does not grow with the log', async () => {
    const place = await preShare(fixture.tmp, {});
    for (let index = 0; index < 3; index += 1)
      await on(place, 'rbook_sprint', {
        action: 'add',
        sprintId: `s-${index}`,
        title: 'Shared',
        status: 'Planned',
      });
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, "UPDATE sprints SET title = 'Retitled on the copy' WHERE id LIKE 's-%'");
    const owner = await shareExisting(fixture.tmp, place.root);
    await importInto(owner, zip, { apply: true });
    const scans = await onCopy(fixture.tmp, owner, (client) => {
      const read = jest.spyOn(client, 'getMany');
      expect(openConflicts(client)).toHaveLength(3);
      const asked = read.mock.calls.map(
        ([sql, params]) => [sql, Array.isArray(params) ? params : []] as const
      );
      read.mockRestore();
      return logScans(client, asked);
    });
    expect(scans).toEqual([]);
  }, 120000);

  it("reads each replica's stream as often however many of its transactions a plan judges", async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, "UPDATE missions SET name = 'Renamed on the copy' WHERE id = 'i-m01'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    /** Transactions from the member's copy, each one change, as a session of small writes makes. */
    const write = async (count: number, from: number) => {
      for (let index = from; index < from + count; index += 1)
        await on(studio, 'rbook_mission', {
          action: 'update',
          missionId: 'i-m01',
          fields: { notes: `Note ${index}.` },
        });
      await syncCopies(fixture.tmp, studio, owner);
    };
    /** How many times a dry run reads a replica's stream: its prefix, its sequences, or a gap. */
    const streamReads = () =>
      onCopy(fixture.tmp, owner, async (client) => {
        const read = jest.spyOn(client, 'getMany');
        expect((await importCopy(client, zip.root)).success).toBe(true);
        const calls = read.mock.calls.filter(([sql]) =>
          /FROM record_changes WHERE replica_id = \?/.test(String(sql))
        ).length;
        read.mockRestore();
        return calls;
      });
    await write(6, 0);
    const six = await streamReads();
    await write(6, 6);
    expect(await streamReads()).toBe(six);
  }, 240000);

  it("holds a member's transaction behind a gap in its stream, and says how many earlier changes it waits for", async () => {
    const place = await preShare(fixture.tmp, {});
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    for (const notes of ['One.', 'Two.'])
      await on(studio, 'rbook_mission', {
        action: 'update',
        missionId: 'i-m01',
        fields: { notes },
      });
    const [{ replica }] = read<{ replica: string }>(
      studio,
      "SELECT value AS replica FROM metadata WHERE key = 'replica_id'"
    );
    const stream = read<Record<string, unknown>>(
      studio,
      'SELECT * FROM record_changes WHERE replica_id = ? ORDER BY replica_seq',
      [replica]
    );
    const last = stream[stream.length - 1];
    // Only the member's last transaction reaches the owner, with none of its stream before it.
    const db = new Database(dbOf(owner.root));
    try {
      for (const change of stream.filter((row) => row.txn_id === last.txn_id)) {
        const columns = Object.keys(change);
        db.prepare(
          `INSERT INTO record_changes (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        ).run(...columns.map((column) => change[column]));
      }
    } finally {
      db.close();
    }
    const held = stream.filter((row) => row.txn_id === last.txn_id).length;
    const found = await onCopy(fixture.tmp, owner, (client) =>
      standing.txnStanding(client, standing.mergeContext(client), String(last.txn_id))
    );
    expect(found).toEqual({
      state: 'held',
      cause: `waits for ${Number(last.replica_seq) - held} earlier change(s) from replica ${replica}`,
    });
  }, 240000);

  it('plans an import with as many scans of the change log however many fields an earlier import raised', async () => {
    const place = await preShare(fixture.tmp, {});
    for (let index = 0; index < 8; index += 1)
      await on(place, 'rbook_sprint', {
        action: 'add',
        sprintId: `s-${index}`,
        title: 'Shared',
        status: 'Planned',
      });
    const few = zipOf(fixture.tmp, place, 'few');
    onFile(few, "UPDATE sprints SET title = 'Retitled on few' WHERE id IN ('s-0', 's-1')");
    const many = zipOf(fixture.tmp, place, 'many');
    onFile(many, "UPDATE sprints SET title = 'Retitled on many' WHERE id LIKE 's-%'");
    const owner = await shareExisting(fixture.tmp, place.root);
    /** How many times a dry run of `few` asks the log a question it answers by scanning the whole log. */
    const scanned = () =>
      onCopy(fixture.tmp, owner, async (client) => {
        const read = jest.spyOn(client, 'getMany');
        expect((await importCopy(client, few.root)).success).toBe(true);
        const asked = read.mock.calls.map(
          ([sql, params]) => [sql, Array.isArray(params) ? params : []] as const
        );
        read.mockRestore();
        const scans = new Set(logScans(client, asked));
        return asked.filter(([sql]) => scans.has(sql)).length;
      });
    await importInto(owner, few, { apply: true });
    const before = await scanned();
    // Six more raised fields, each an import's set whose standing the plan works out.
    await importInto(owner, many, { apply: true });
    expect(await scanned()).toBe(before);
  }, 120000);
});

describe('times', () => {
  it('a time with no zone is UTC, as SQLite writes it, whatever zone this machine keeps', async () => {
    const place = await preShare(fixture.tmp, {});
    await on(place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    await on(place, 'rbook_context', { action: 'snapshot', source: 'before the copy' });
    const zip = zipOf(fixture.tmp, place);
    // Two hours before the marker, as UTC: read as a local time west of UTC it would fall after it.
    onFile(
      zip,
      `UPDATE missions SET created_at = '${zoneless(Date.parse(markerAt(place)) - 2 * 3600 * 1000)}' WHERE id = 'i-m03'`
    );
    onFile(place, "DELETE FROM missions WHERE id = 'i-m03'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const missions = table((await importInto(owner, zip)).data, 'missions');
    expect(missions.deletedOnOwner.map((row) => row.id)).toEqual(['i-m03']);
    expect(missions.own).toEqual([]);
  }, 120000);
});

describe('applying', () => {
  it('a session the copy left open comes in with an owner key no process here matches, so none adopts it', async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_session', { action: 'start', title: 'Left open on the copy' });
    const owner = await shareExisting(fixture.tmp, place.root);
    expect((await importInto(owner, zip, { apply: true })).error).toBeUndefined();
    expect(
      read<{ status: string; owner_key: string | null }>(
        owner,
        "SELECT status, owner_key FROM sessions WHERE title = 'Left open on the copy'"
      )
    ).toEqual([{ status: 'active', owner_key: `import:${owner.replicaId}` }]);
  }, 120000);

  it('brings a numbered row deleted on the owner in with --include beside one of its own, each in the number planned', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_decisions', { action: 'record', content: "The copy's own decision." });
    onFile(
      place,
      "DELETE FROM strategic_decisions WHERE decision_text = 'Decided before the copy.'"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const decisions = table((await importInto(owner, zip)).data, 'strategic_decisions');
    const include = decisions.deletedOnOwner.map((row) => `strategic_decisions:${row.id}`);
    expect(include).toHaveLength(1);
    const applied = await importInto(owner, zip, { include, apply: true });
    expect(applied.error).toBeUndefined();
    expect(applied.data?.applied?.created).toBe(2);
    expect(
      read<{ decision_text: string }>(
        owner,
        'SELECT decision_text FROM strategic_decisions ORDER BY id'
      ).map((row) => row.decision_text)
    ).toEqual(['Decided before the copy.', "The copy's own decision."]);
  }, 120000);

  it("waits on another connection's write lock no longer than its timeout, then fails and writes nothing", async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const changes = () =>
      read<{ n: number }>(owner, 'SELECT count(*) AS n FROM record_changes')[0].n;
    const before = changes();
    useMachine(fixture.tmp, owner.machine);
    const client = (await RbookDatabaseClient.create({ dbPath: dbOf(owner.root), timeout: 300 }))
      .data!;
    const holder = new Database(dbOf(owner.root));
    try {
      holder.exec('BEGIN IMMEDIATE');
      const applied = await importCopy(client, zip.root, { apply: true });
      expect(applied.error?.message).toMatch(/locked|busy/i);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
      client.close();
    }
    expect(changes()).toBe(before);
    expect(read(owner, "SELECT name FROM missions WHERE id = 'i-m01'")).toEqual([
      { name: 'Before the copy' },
    ]);
  }, 120000);

  it("carries the schema step's warnings in its answer, since a migration that warns may have read the copy wrong", async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    const owner = await shareExisting(fixture.tmp, place.root);
    const real = sharing.prepareForSharing;
    jest
      .spyOn(sharing, 'prepareForSharing')
      .mockImplementation((client) => ({ ...real(client), warnings: ['the schema step warned'] }));
    const dry = await importInto(owner, zip);
    expect(dry.warnings).toEqual(expect.arrayContaining(['the schema step warned']));
  }, 120000);

  it('plans again under the write lock, so a write landing after the first plan is raised, not overwritten', async () => {
    const place = await preShare(fixture.tmp, { base: true });
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const other = await onCopy(
      fixture.tmp,
      owner,
      async () => (await RbookDatabaseClient.create({ dbPath: dbOf(owner.root) })).data!
    );
    const real = planModule.planImport;
    let calls = 0;
    jest.spyOn(planModule, 'planImport').mockImplementation((...args) => {
      const plan = real(...args);
      // Another writer on this copy, after the first plan and before the import takes its lock.
      if ((calls += 1) === 1) {
        const wrote = recordedExecute(other, 'UPDATE missions SET name = ? WHERE id = ?', [
          'Renamed on the owner, meanwhile',
          'i-m01',
        ]);
        if (!wrote.success) throw new Error(JSON.stringify(wrote.error));
      }
      return plan;
    });
    const applied = await importInto(owner, zip, { apply: true });
    other.close();
    expect(calls).toBe(2);
    expect(applied.data?.applied).toMatchObject({ set: 0, conflicts: 1 });
    const conflicts = await onCopy(fixture.tmp, owner, (client) => openConflicts(client));
    expect(conflicts.map((open) => open.candidates.map((candidate) => candidate.value))).toEqual([
      ['Renamed on the owner, meanwhile', 'Renamed on the copy'],
    ]);
  }, 240000);

  it('refuses, writing nothing, when the write would give a numbered row another id than the plan did', async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    await on(zip, 'rbook_decisions', { action: 'record', content: "The copy's own decision." });
    const owner = await shareExisting(fixture.tmp, place.root);
    const before = read(owner, 'SELECT count(*) AS n FROM strategic_decisions');
    const real = planModule.planImport;
    // A plan that disagrees with the write: its decision one number past the next of the block.
    jest.spyOn(planModule, 'planImport').mockImplementation((...args) => {
      const plan = real(...args);
      return {
        ...plan,
        tables: plan.tables.map((table) =>
          table.table === 'strategic_decisions'
            ? {
                ...table,
                own: table.own.map((row) => ({ ...row, to: String(Number(row.to) + 1) })),
              }
            : table
        ),
      };
    });
    const applied = await importInto(owner, zip, { apply: true });
    expect(applied.error).toMatchObject({
      code: 'RECORD_WRITE_REFUSED',
      suggestion: expect.stringMatching(/^Run the dry run again and apply what it prints/),
    });
    expect(read(owner, 'SELECT count(*) AS n FROM strategic_decisions')).toEqual(before);
  }, 240000);
});
