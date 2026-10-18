// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m14 — reasonbook import on the copy --project-root names, every refusal with its remedy, the raised field
// ABOUTME: listed and settled through the MCP dispatch, and a real-store fire on this repository's own store at two releases.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { importText } from '../../../src/cli/import';
import { importCopy } from '../../../src/tools/rbook/record-import';
import { COMPARED } from '../../../src/tools/rbook/record-import-fields';
import { RECORD_COLUMNS, RECORDED_TABLES } from '../../../src/tools/rbook/record-columns';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { onFile, onPlace, preShare, zipOf } from '../../helpers/import-copies';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';
import { joinedCopy, onCopy, read, shareExisting, syncCopies } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-import-cli-');
});
afterEach(() => fixture.restore());

async function cli(argv: string[], cwd: string) {
  let out = '';
  let err = '';
  const io: CliIo = {
    env: process.env,
    cwd,
    readStdin: async () => '',
    stdout: (text) => (out += text),
    stderr: (text) => (err += `${text}\n`),
  };
  const code = await runCli(argv, io);
  return { code, out, err };
}

describe('reasonbook import', () => {
  it('imports into a joined copy without a snapshot directory, raising differences without a base', async () => {
    const place = await preShare(fixture.tmp, { base: true });
    const zip = zipOf(fixture.tmp, place);
    await onPlace(fixture.tmp, zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the old copy' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    // Joining carries the record, not the owner's local snapshot files. The missing directory
    // means there is no common base; it must not prevent the member from importing its old copy.
    expect(fs.existsSync(path.join(path.dirname(dbOf(zip.root)), 'snapshots'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(dbOf(studio.root)), 'snapshots'))).toBe(false);
    useMachine(fixture.tmp, studio.machine);
    const args = ['import', '--from', zip.root, '--project-root', studio.root];
    const dry = await cli(args, studio.root);
    expect(dry).toMatchObject({ code: 0, err: '' });
    expect(dry.out).toContain('Base: none that both folders hold');
    expect(dry.out).toContain('Renamed on the old copy');
    expect(read(studio, 'SELECT count(*) AS n FROM record_conflicts')).toEqual([{ n: 0 }]);
    const applied = await cli([...args, '--apply'], studio.root);
    expect(applied).toMatchObject({ code: 0, err: '' });
    expect(applied.out).toContain('0 row(s) created, 0 field(s) set, and 1 raised as conflicts');
    expect(read(studio, "SELECT name FROM missions WHERE id = 'i-m01'")).toEqual([
      { name: 'Before the copy' },
    ]);
    expect(read(studio, 'SELECT count(*) AS n FROM record_conflicts')).toEqual([{ n: 1 }]);
  }, 120000);

  it('works on the copy --project-root names from another project folder: the dry run writes nothing, --apply raises the field', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    await onPlace(fixture.tmp, zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    useMachine(fixture.tmp, owner.machine);
    const elsewhere = project(fixture.tmp, 'elsewhere');
    const args = ['import', '--from', zip.root, '--project-root', owner.root];
    const dry = await cli(args, elsewhere);
    expect(dry).toMatchObject({ code: 0, err: '' });
    expect(dry.out).toMatch(/^Dry run of the import of /);
    expect(dry.out).toMatch(/Base: none that both folders hold/);
    expect(dry.out).toMatch(
      /missions i-m01 name: the copy holds "Renamed on the copy", the record "Before the copy"/
    );
    expect(dry.out).toContain(
      `This copy holds no row of its own: archive it and join a fresh copy (reasonbook copy on the owner's machine, then reasonbook join). Archiving drops the 1 field(s) listed above. Applying instead (reasonbook import --from ${zip.root} --project-root ${owner.root} --apply) sets 0 and raises 1 for you to settle.`
    );
    expect(read(owner, 'SELECT count(*) AS n FROM record_conflicts')).toEqual([{ n: 0 }]);
    // The working folder's project is never the one written: it keeps no change log.
    expect(
      read({ root: elsewhere }, 'SELECT count(*) AS n FROM sqlite_master WHERE name = ?', [
        'record_changes',
      ])
    ).toEqual([{ n: 0 }]);

    const applied = await cli([...args, '--apply'], elsewhere);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain(
      'Applied: 0 row(s) created, 0 field(s) set, and 1 raised as conflicts. Reads keep the record\'s value until each is settled with rbook_db(action="settle").'
    );
    expect(read(owner, "SELECT name FROM missions WHERE id = 'i-m01'")).toEqual([
      { name: 'Before the copy' },
    ]);
    // Listed and settled through the MCP dispatch: the shared record's value is one candidate.
    const listed = await call('rbook_db', { action: 'conflicts', projectRoot: owner.root });
    expect(JSON.stringify(listed.data)).toContain('Before the copy');
    expect(JSON.stringify(listed.data)).toContain('Renamed on the copy');
    const settled = await call('rbook_db', {
      action: 'settle',
      table: 'missions',
      recordId: 'i-m01',
      field: 'name',
      value: 'Before the copy',
      projectRoot: owner.root,
    });
    expect(settled.error).toBeUndefined();
    expect(read(owner, "SELECT name FROM missions WHERE id = 'i-m01'")).toEqual([
      { name: 'Before the copy' },
    ]);
    expect(read(owner, 'SELECT count(*) AS n FROM record_conflicts')).toEqual([{ n: 0 }]);
  }, 240000);

  it('refuses an unshared project, a folder with no store, a copy of a shared record, another project and an unreadable copy, each with its remedy', async () => {
    const place = await preShare(fixture.tmp);
    const zip = zipOf(fixture.tmp, place);
    const unshared = {
      name: 'owner',
      root: place.root,
      machine: 'machine-owner',
      replicaId: '',
      block: 0,
    };
    const refusal = async (on: typeof unshared, from: string) =>
      (await onCopy(fixture.tmp, on, (client) => importCopy(client, from))).error;
    expect(await refusal(unshared, zip.root)).toMatchObject({
      message: expect.stringMatching(/not shared, so it holds no shared record/),
      suggestion: expect.stringMatching(/rbook_project\(action="share"\)/),
    });
    // An unshared project is said first, even when the folder named holds no store either.
    expect(await refusal(unshared, path.join(fixture.tmp, 'nothing-here'))).toMatchObject({
      message: expect.stringMatching(/not shared, so it holds no shared record/),
    });
    // Run inside the copy itself, the import names the copy of the record to run in instead.
    expect(await refusal(unshared, place.root)).toMatchObject({
      message: expect.stringMatching(/holds the store this import would write to/),
      suggestion: expect.stringMatching(/--project-root <its folder>/),
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    expect(await refusal(owner, path.join(fixture.tmp, 'nothing-here'))).toMatchObject({
      message: expect.stringMatching(/holds no Reasonbook store/),
      suggestion: "Name the copy's project folder, or its store file.",
    });
    expect(await refusal(owner, owner.root)).toMatchObject({
      message: expect.stringMatching(/holds the store this import would write to/),
    });
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    expect(await refusal(owner, studio.root)).toMatchObject({
      message: expect.stringMatching(/is a copy of a shared record, not one made before sharing/),
      suggestion: expect.stringMatching(/reasonbook sync/),
    });
    // Another project's shared copy is refused as another project's, before it is a shared one.
    const other = path.join(fixture.tmp, 'other');
    seedRbookDb(other, { projectId: 'p-other', projectName: 'other' });
    await shareExisting(fixture.tmp, other, 'other');
    expect(await refusal(owner, other)).toMatchObject({
      message: expect.stringMatching(/holds project p-other, and this copy holds/),
      suggestion: expect.stringMatching(/belongs to that project's record/),
    });
    onFile(zip, "UPDATE metadata SET value = 'p-other' WHERE key = 'project_id'");
    expect(await refusal(owner, zip.root)).toMatchObject({
      message: expect.stringMatching(/holds project p-other, and this copy holds/),
    });
    onFile(zip, "UPDATE metadata SET value = 'p-shared' WHERE key = 'project_id'");
    // A zip archive named as the copy is said to be one, to unzip, not damage.
    const archive = path.join(fixture.tmp, 'carried.zip');
    fs.writeFileSync(archive, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]));
    expect(await refusal(owner, archive)).toMatchObject({
      message: expect.stringMatching(/is a zip archive, not a Reasonbook store/),
      suggestion: 'Unzip it first, then name the project folder it holds with --from.',
    });
    // Run in the shared copy, naming that copy itself, the remedy names the copy made before sharing.
    expect(await refusal(owner, owner.root)).toMatchObject({
      suggestion:
        'Name the copy made before sharing with --from, not this copy of the shared record.',
    });
    // A folder holding both layouts names neither silently.
    const both = path.join(fixture.tmp, 'both');
    for (const parts of [
      ['rbook', 'db', 'rbook.sqlite'],
      ['cmos', 'db', 'cmos.sqlite'],
    ]) {
      fs.mkdirSync(path.join(both, ...parts.slice(0, 2)), { recursive: true });
      fs.copyFileSync(dbOf(zip.root), path.join(both, ...parts));
    }
    expect(await refusal(owner, both)).toMatchObject({
      message: expect.stringMatching(
        /holds both rbook\/db\/rbook\.sqlite and cmos\/db\/cmos\.sqlite/
      ),
      suggestion: 'Name the store file to bring in with --from.',
    });
    // A store that opens but fails its integrity check is damage, and is never read on.
    const broken = path.join(fixture.tmp, 'broken', 'owner');
    fs.mkdirSync(path.dirname(dbOf(broken)), { recursive: true });
    fs.copyFileSync(dbOf(zip.root), dbOf(broken));
    const raw = new Database(dbOf(broken));
    try {
      raw.exec('CREATE TABLE damage (a TEXT); INSERT INTO damage VALUES (NULL)');
      raw.unsafeMode(true);
      raw.pragma('writable_schema = ON');
      raw
        .prepare(
          "UPDATE sqlite_master SET sql = 'CREATE TABLE damage (a TEXT NOT NULL)' WHERE name = 'damage'"
        )
        .run();
      raw.pragma('writable_schema = OFF');
    } finally {
      raw.close();
    }
    expect(await refusal(owner, broken)).toMatchObject({
      message: expect.stringMatching(/fails its integrity check: NULL value in damage\.a/),
      suggestion: expect.stringMatching(/Restore the copy from a backup/),
    });
    // A store this account cannot read is named so, not as damage.
    fs.chmodSync(dbOf(zip.root), 0o000);
    try {
      expect(await refusal(owner, zip.root)).toMatchObject({
        message: expect.stringMatching(/could not be read as a copy/),
        suggestion: `Give this account read access to ${zip.root}, then import it again.`,
      });
    } finally {
      fs.chmodSync(dbOf(zip.root), 0o644);
    }
    const damaged = path.join(fixture.tmp, 'damaged');
    fs.mkdirSync(path.dirname(dbOf(damaged)), { recursive: true });
    fs.writeFileSync(dbOf(damaged), 'not a database at all, only text');
    expect(await refusal(owner, damaged)).toMatchObject({
      message: expect.stringMatching(/could not be read as a copy/),
      suggestion: expect.stringMatching(/Restore the copy from a backup/),
    });
    // The CLI prints the refusal and its remedy as two sentences, and fails.
    useMachine(fixture.tmp, owner.machine);
    const said = await cli(['import', '--from', damaged, '--project-root', owner.root], owner.root);
    expect(said.code).toBe(1);
    expect(said.err).toMatch(/could not be read as a copy: .*[.!?] Restore the copy from a backup/);
    // --from given no folder is the usage, not a folder named "true".
    const bare = await cli(['import', '--from', '--project-root', owner.root], owner.root);
    expect(bare).toMatchObject({ code: 1 });
    expect(bare.err).toMatch(/^reasonbook import --from <folder>/);
  }, 240000);

  it('matches a copy that predates the project id by its folder name, refusing one under another', async () => {
    const place = await preShare(fixture.tmp);
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, "DELETE FROM metadata WHERE key = 'project_id'");
    const owner = await shareExisting(fixture.tmp, place.root);
    expect(
      (await onCopy(fixture.tmp, owner, (client) => importCopy(client, zip.root))).error
    ).toMatchObject({
      message: expect.stringMatching(
        /predates the project id, so it is matched by its folder's name/
      ),
      suggestion:
        'Put the copy in a folder named owner, its store under owner/rbook/db/ or owner/cmos/db/, then import that folder.',
    });
    // Named by a store file outside either layout, the remedy is the same, and following it works.
    const desk = path.join(fixture.tmp, 'desk', 'old.sqlite');
    fs.mkdirSync(path.dirname(desk), { recursive: true });
    fs.copyFileSync(dbOf(zip.root), desk);
    expect(
      (await onCopy(fixture.tmp, owner, (client) => importCopy(client, desk))).error?.suggestion
    ).toBe(
      'Put the copy in a folder named owner, its store under owner/rbook/db/ or owner/cmos/db/, then import that folder.'
    );
    const renamed = path.join(fixture.tmp, 'carried', 'owner');
    fs.mkdirSync(path.dirname(renamed), { recursive: true });
    fs.renameSync(zip.root, renamed);
    const dry = await onCopy(fixture.tmp, owner, (client) => importCopy(client, renamed));
    expect(dry.error).toBeUndefined();
    expect(dry.data?.ownRows).toBe(0);
  }, 240000);
});

describe("reasonbook import's text", () => {
  it('lists every field, says what the base shows the copy changed, and carries --include and --project-root into the command to apply', async () => {
    const place = await preShare(fixture.tmp, { base: true });
    await onPlace(fixture.tmp, place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    // Fifteen sprints made after the base, which the copy retitles: more than any short list shows.
    const sprints = Array.from({ length: 15 }, (_, index) => `s-${String(index).padStart(2, '0')}`);
    for (const id of sprints)
      await onPlace(fixture.tmp, place, 'rbook_sprint', {
        action: 'add',
        sprintId: id,
        title: 'Shared',
        status: 'Planned',
      });
    const copied = zipOf(fixture.tmp, place, 'copied');
    onFile(copied, "UPDATE sprints SET title = 'Retitled on the copy' WHERE id LIKE 's-%'");
    onFile(copied, "UPDATE missions SET name = 'Renamed on the copy' WHERE id = 'i-m01'");
    onFile(place, "DELETE FROM missions WHERE id = 'i-m03'");
    await onPlace(fixture.tmp, place, 'rbook_sprint', {
      action: 'add',
      sprintId: 'o-sprint',
      title: 'Only on the record',
      status: 'Planned',
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    useMachine(fixture.tmp, owner.machine);
    const elsewhere = project(fixture.tmp, 'elsewhere');
    const dry = await cli(
      ['import', '--from', copied.root, '--project-root', owner.root],
      elsewhere
    );
    expect(dry.code).toBe(0);
    for (const id of sprints) expect(dry.out).toContain(`sprints ${id} title:`);
    expect(dry.out).not.toMatch(/and \d+ more/);
    expect(dry.out).toMatch(/sprints: \d+ in the copy: .*1 only in the record, kept\./);
    expect(dry.out).toMatch(/Applying instead \(.*\) sets 1 and raises 15 for you to settle\./);
    const included = await cli(
      [
        'import',
        '--from',
        copied.root,
        '--include',
        'missions:i-m03',
        '--project-root',
        owner.root,
      ],
      elsewhere
    );
    expect(included.out).toContain('missions:i-m03');
    expect(included.out).toMatch(/missions:i-m03 \(.*\), brought in by --include/);
    expect(included.out).toContain(
      `This copy holds 0 row(s) of its own, and --include brings in 1 deleted on the owner: bring them in with reasonbook import --from ${copied.root} --include missions:i-m03 --project-root ${owner.root} --apply.`
    );
  }, 240000);
});

describe("reasonbook import's text after an import, and its commands", () => {
  it("a dry run after applying names the fields still in conflict as the earlier import's, and says to settle them", async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    await onPlace(fixture.tmp, zip, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed on the copy' },
    });
    const owner = await shareExisting(fixture.tmp, place.root);
    useMachine(fixture.tmp, owner.machine);
    const args = ['import', '--from', zip.root, '--project-root', owner.root];
    expect((await cli([...args, '--apply'], owner.root)).code).toBe(0);
    const again = await cli(args, owner.root);
    expect(again.out).toMatch(/1 field\(s\) an earlier import raised, still in conflict/);
    expect(again.out).toMatch(/An earlier import raised these, still in conflict/);
    expect(again.out).toMatch(
      /an earlier import raised every field it holds differently that the record has not changed since: archive it and join a fresh copy .*, once the 1 field\(s\) still in conflict are settled/
    );
    // The earlier import's raise is its own count, never one where the record's value stands.
    expect(again.out).not.toMatch(/where the record's value stands/);
  }, 240000);

  it('counts what applying would leave as the record holds it beside what it would raise', async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m02',
      name: 'Second',
      sprintId: 'i-sprint',
    });
    onFile(
      place,
      "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('i-m02', 'i-m01', 'Requires')"
    );
    const zip = zipOf(fixture.tmp, place);
    onFile(
      zip,
      "UPDATE missions SET name = 'Renamed on the copy' WHERE id = 'i-m01'",
      "UPDATE mission_dependencies SET type = 'Blocks'"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = (await onCopy(fixture.tmp, owner, (client) => importCopy(client, zip.root))).data!;
    expect(importText(dry)).toMatch(
      /Applying instead \(.*\) sets 0 and raises 1 for you to settle, and leaves 1 as the record holds them\./
    );
  }, 240000);

  it("names a field in a conflict no import raised as one to settle, never as an earlier import's", async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await onPlace(fixture.tmp, owner, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Owner renamed' },
    });
    await onPlace(fixture.tmp, studio, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Studio renamed' },
    });
    await syncCopies(fixture.tmp, studio, owner);
    const dry = (await onCopy(fixture.tmp, owner, (client) => importCopy(client, zip.root))).data!;
    const missions = dry.tables.find((table) => table.table === 'missions')!;
    expect(missions.alreadyRaised).toEqual([]);
    expect(missions.inConflict.map((change) => change.field)).toEqual(['name']);
    expect(importText(dry)).not.toMatch(/an earlier import raised/i);
  }, 240000);

  it("names a field whose copy value one copy of the record wrote into a conflict as one to settle: only an import's own set is an earlier import's raise", async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    const owner = await shareExisting(fixture.tmp, place.root);
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    await onPlace(fixture.tmp, owner, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Owner renamed' },
    });
    await onPlace(fixture.tmp, studio, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Studio renamed' },
    });
    await syncCopies(fixture.tmp, studio, owner);
    const [{ name: shown }] = read<{ name: string }>(
      owner,
      "SELECT name FROM missions WHERE id = 'i-m01'"
    );
    // The copy holds the candidate reads do not show, which no import wrote.
    const other = shown === 'Owner renamed' ? 'Studio renamed' : 'Owner renamed';
    onFile(zip, `UPDATE missions SET name = '${other}' WHERE id = 'i-m01'`);
    const dry = (await onCopy(fixture.tmp, owner, (client) => importCopy(client, zip.root))).data!;
    const missions = dry.tables.find((table) => table.table === 'missions')!;
    expect(missions.alreadyRaised).toEqual([]);
    expect(missions.inConflict).toEqual([expect.objectContaining({ field: 'name', copy: other })]);
    expect(importText(dry)).not.toMatch(/an earlier import raised/i);
  }, 240000);

  it("names the fields the record changed after holding the copy's value apart from the base's and the plain rules", async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    const owner = await shareExisting(fixture.tmp, place.root);
    await onPlace(fixture.tmp, owner, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed by the owner after sharing' },
    });
    useMachine(fixture.tmp, owner.machine);
    const dry = await cli(['import', '--from', zip.root, '--project-root', owner.root], owner.root);
    expect(dry.out).toMatch(
      /1 field\(s\) the record has held as the copy holds them since sharing, and changed since, keep the record's value\./
    );
    expect(dry.out).toMatch(/1 field\(s\) the record changed after holding the copy's value/);
    expect(dry.out).toMatch(
      /the record's value stands for every field the two hold differently, so nothing needs bringing in/
    );
  }, 240000);

  it('prints a command a shell runs as written, quoting a pair and a folder that holds a dollar sign; repeated --include flags add up', async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    const [{ id: session }] = read<{ id: string }>(place, 'SELECT id FROM sessions LIMIT 1');
    onFile(
      place,
      `INSERT INTO session_missions (session_id, mission_id, linked_at, source) VALUES ('${session}', 'i-m03', '${new Date(Date.now() - 60000).toISOString()}', 'capture')`
    );
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    const made = zipOf(fixture.tmp, place);
    const strange = path.join(fixture.tmp, 'a $HOME copy', 'owner');
    fs.mkdirSync(path.dirname(strange), { recursive: true });
    fs.renameSync(made.root, strange);
    onFile(
      place,
      'PRAGMA foreign_keys = OFF',
      "DELETE FROM session_missions WHERE mission_id = 'i-m03'",
      "DELETE FROM missions WHERE id = 'i-m03'"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    useMachine(fixture.tmp, owner.machine);
    const dry = await cli(
      [
        'import',
        '--from',
        strange,
        '--include',
        'missions:i-m03',
        '--include',
        `session_missions:${session}|i-m03`,
        '--project-root',
        owner.root,
      ],
      owner.root
    );
    expect(dry.code).toBe(0);
    expect(dry.out).toMatch(/--include brings in 2 deleted on the owner/);
    // The deleted rows' list quotes a pair, so it can be typed into a shell as shown.
    expect(dry.out).toContain(`  'session_missions:${session}|i-m03'`);
    const command = /bring them in with (.*)\.$/m.exec(dry.out)![1];
    // The shell reads every argument back as the CLI was given it.
    const words = execFileSync(
      'bash',
      ['-c', `printf '%s\\n' ${command.replace(/^reasonbook /, '')}`],
      {
        encoding: 'utf8',
      }
    )
      .trim()
      .split('\n');
    expect(words).toEqual([
      'import',
      '--from',
      strange,
      '--include',
      `missions:i-m03,session_missions:${session}|i-m03`,
      '--project-root',
      owner.root,
      '--apply',
    ]);
  }, 240000);

  it('says which listed fields sit on rows the copy changed after the marker, which columns the copy never had, and what it renumbered', async () => {
    const place = await preShare(fixture.tmp, { marker: true });
    const zip = zipOf(fixture.tmp, place);
    const second = zipOf(fixture.tmp, place, 'second');
    await onPlace(fixture.tmp, second, 'rbook_decisions', {
      action: 'record',
      content: "The copy's own.",
    });
    // A rename after the marker, on a copy whose decisions lack a column the record holds.
    onFile(
      zip,
      `UPDATE missions SET name = 'Renamed on the copy', updated_at = '${new Date(Date.now() + 60000).toISOString()}' WHERE id = 'i-m01'`,
      'ALTER TABLE strategic_decisions DROP COLUMN approval_words'
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const dry = (await onCopy(fixture.tmp, owner, (client) => importCopy(client, zip.root))).data!;
    const text = importText(dry);
    expect(text).toMatch(
      /missions i-m01 name: the copy holds "Renamed on the copy", the record "Before the copy"; the copy's row carries a time after the marker, so this may be its own change/
    );
    expect(text).toMatch(
      /; 1 are on rows carrying a time after the marker, so they may be the copy's own changes/
    );
    expect(text).toMatch(
      /strategic_decisions: .*Taken from the record, which the copy never had: [^\n]*approval_words/
    );
    expect(text).toMatch(
      /Base: none that both folders hold, so a field the two hold differently is raised, unless the record's own history shows it changed the field after holding the copy's value, or the field's kind decides: appended text keeps what each side added, the later review time and an added flag win, and an author the copy never recorded is no other author\./
    );
    // A decision of another copy's own, brought into a member's copy, takes a number in its block.
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Darryl');
    const applied = (
      await onCopy(fixture.tmp, studio, (client) =>
        importCopy(client, second.root, { apply: true })
      )
    ).data!;
    expect(importText(applied)).toMatch(/Renumbered: strategic_decisions:2 as \d{7}\./);
  }, 240000);

  it('refuses a store that cannot reach the sharing schema, with a remedy, rather than failing on a table it lacks', async () => {
    const place = await preShare(fixture.tmp, {});
    const owner = await shareExisting(fixture.tmp, place.root);
    const odd = path.join(fixture.tmp, 'odd', 'owner');
    fs.mkdirSync(path.dirname(dbOf(odd)), { recursive: true });
    const db = new Database(dbOf(odd));
    try {
      db.exec(
        "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT); INSERT INTO metadata VALUES ('project_id', 'p-shared'); CREATE TABLE missions (id TEXT PRIMARY KEY, name TEXT)"
      );
    } finally {
      db.close();
    }
    const refused = (await onCopy(fixture.tmp, owner, (client) => importCopy(client, odd))).error;
    expect(refused).toMatchObject({
      message: expect.stringMatching(/could not be brought to the sharing schema/),
      suggestion: expect.stringMatching(/Name a copy of this project's Reasonbook folder/),
    });
  }, 240000);
});

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The real-store fire imports this repository's own store at one release into a shared copy of it at the next, both taken from its git history; the public mirror carries neither.",
  revisions: { before: 'v4.0.1', after: 'v4.0.2' },
});

/** The text a numbered row is told by: two rows holding it are one row brought in twice. */
const TEXTS: Readonly<Record<string, string>> = {
  strategic_decisions: 'decision_text',
  learnings: 'content',
  next_steps: 'content',
  constraints: 'content',
};

PRIVATE.describe("this repository's own store (practice 4's real-store fire)", () => {
  it('its store at v4.0.1, brought into a shared copy of v4.0.2: the dry run classifies, and applying loses and duplicates no row', async () => {
    const write = (revision: string, root: string) => {
      fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
      fs.writeFileSync(
        dbOf(root),
        execFileSync('git', ['show', `${revision}:rbook/db/rbook.sqlite`], {
          cwd: path.resolve(__dirname, '..', '..', '..'),
          maxBuffer: 256 * 1024 * 1024,
        })
      );
      reidentifyRbookTestStore(root, 'test-real-import');
    };
    const target = path.join(fixture.tmp, 'cmos-mcp-pro');
    write(PRIVATE.revisions.after, target);
    const copy = path.join(fixture.tmp, 'carried', 'cmos-mcp-pro');
    write(PRIVATE.revisions.before, copy);
    const owner = await shareExisting(fixture.tmp, target, 'cmos-mcp-pro', 'Owner');
    const count = (table: string) => {
      const db = new Database(dbOf(target), { readonly: true });
      try {
        return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    const repeated = (table: string) => {
      const db = new Database(dbOf(target), { readonly: true });
      try {
        return (
          db
            .prepare(
              `SELECT count(*) - count(DISTINCT "${TEXTS[table]}") AS n FROM ${table} WHERE "${TEXTS[table]}" IS NOT NULL`
            )
            .get() as { n: number }
        ).n;
      } finally {
        db.close();
      }
    };
    const before = Object.fromEntries(RECORDED_TABLES.map((table) => [table, count(table)]));
    const repeatedBefore = Object.fromEntries(
      Object.keys(TEXTS).map((table) => [table, repeated(table)])
    );
    const dry = await onCopy(fixture.tmp, owner, (client) => importCopy(client, copy));
    expect(dry.error).toBeUndefined();
    // Fixed revisions give one classification: the two dependency links v4.0.2 removed, which no
    // time dates, come back as the copy's own (ADR §9), no row reads as deleted, and 71 fields rise.
    expect(
      dry.data!.tables.flatMap((table) =>
        table.own.map((row) => `${table.table}:${row.id}${row.at ? '' : ' (undated)'}`)
      )
    ).toEqual([
      'mission_dependencies:s96-m03|s94-m01 (undated)',
      'mission_dependencies:s96-m04|s96-m01 (undated)',
    ]);
    expect(dry.data!.tables.flatMap((table) => table.deletedOnOwner)).toEqual([]);
    expect(dry.data!.tables.reduce((sum, table) => sum + table.conflicts.length, 0)).toBe(71);
    for (const table of dry.data!.tables)
      for (const conflict of table.conflicts) {
        expect(COMPARED[table.table]).toContain(conflict.field);
        expect(table.lacked).not.toContain(conflict.field);
      }
    const applied = await onCopy(fixture.tmp, owner, (client) =>
      importCopy(client, copy, { apply: true })
    );
    expect(applied.error).toBeUndefined();
    const done = applied.data!.applied!;
    expect(done.created).toBe(dry.data!.ownRows);
    const after = new Database(dbOf(target), { readonly: true });
    try {
      const created = new Map(dry.data!.tables.map((table) => [table.table, table.own.length]));
      for (const table of RECORDED_TABLES) {
        const rows = after.prepare(`SELECT * FROM ${table}`).all() as Array<
          Record<string, unknown>
        >;
        expect({ table, rows: rows.length }).toEqual({
          table,
          rows: before[table] + (created.get(table) ?? 0),
        });
      }
      // No text the import brought in repeats one the record held: none of its rows came twice.
      for (const table of Object.keys(TEXTS))
        expect({ table, repeated: repeated(table) }).toEqual({
          table,
          repeated: repeatedBefore[table],
        });
      expect(
        (after.prepare('SELECT count(*) AS n FROM record_conflicts').get() as { n: number }).n
      ).toBe(done.conflicts);
    } finally {
      after.close();
    }
    // Applied again, the copy brings in nothing: every row it brought is found where it landed.
    const again = await onCopy(fixture.tmp, owner, (client) =>
      importCopy(client, copy, { apply: true })
    );
    expect(again.data?.applied).toMatchObject({ created: 0 });
    expect(Object.fromEntries(RECORDED_TABLES.map((table) => [table, count(table)]))).toEqual(
      Object.fromEntries(
        RECORDED_TABLES.map((table) => [
          table,
          before[table] +
            (dry.data!.tables.find((entry) => entry.table === table)?.own.length ?? 0),
        ])
      )
    );
  }, 900000);
});

describe("reasonbook import's text says only what is true (s96-m14, round 4)", () => {
  const dryRun = async (
    owner: Parameters<typeof onCopy>[1],
    from: { root: string },
    include: string[] = []
  ) =>
    (await onCopy(fixture.tmp, owner, (client) => importCopy(client, from.root, { include })))
      .data!;

  it('never says a copy holding rows deleted on the owner holds nothing the record does not, and its marker line names the removed-link rule', async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    const zip = zipOf(fixture.tmp, place);
    onFile(place, "DELETE FROM missions WHERE id = 'i-m03'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const text = importText(await dryRun(owner, zip));
    expect(text).toMatch(/missions:i-m03 \(/);
    expect(text).toContain(
      "a row only the copy holds, dated at or before it, was deleted on the owner, as was one the record's log shows it removed."
    );
    expect(text).not.toMatch(/holds nothing the record does not hold/);
    expect(text).toMatch(
      /This copy holds no row of its own and nothing the record holds differently; the 1 row\(s\) left out above stay out, but for any --include brings in: archive it/
    );
  }, 240000);

  it('lists a flag the record keeps without saying applying writes it, since applying writes nothing there', async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 'Kept as evergreen.',
      evergreen: true,
    });
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, "UPDATE learnings SET evergreen = 0 WHERE content = 'Kept as evergreen.'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const report = await dryRun(owner, zip);
    expect(report.tables.find((table) => table.table === 'learnings')!.flagKept).toHaveLength(1);
    const text = importText(report);
    expect(text).toMatch(/learnings \d+ evergreen: the copy holds 0, the record 1\n/);
    expect(text).not.toMatch(/evergreen: .*applying writes/);
  }, 240000);

  it("labels each count by what applying does, not by who changed the field: an author the copy never recorded is the record's value standing", async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    // The record names i-m01's author; the copy, as one made before authors were recorded, names none.
    onFile(place, "UPDATE missions SET author_name = 'Owner' WHERE id = 'i-m01'");
    onFile(zip, "UPDATE missions SET author_name = NULL WHERE id = 'i-m01'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const text = importText(await dryRun(owner, zip));
    expect(text).toMatch(
      /missions: \d+ in the copy: .*1 field\(s\) where the record's value stands/
    );
    expect(text).not.toMatch(/changed only (on the copy|in the record)/);
    expect(text).toMatch(
      /the record's value stands for every field the two hold differently, so nothing needs bringing in/
    );
  }, 240000);

  it('names in its base line the rules a field kind decides by, beside what the base decides', async () => {
    const place = await preShare(fixture.tmp, { base: true });
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, "UPDATE missions SET name = 'Renamed on the copy' WHERE id = 'i-m01'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const text = importText(await dryRun(owner, zip));
    expect(text).toMatch(
      /^Base: snapshot-.*, which both folders hold: a field only one side changed since takes that side's value and one both changed is raised, unless the record's own history shows it changed the field after holding the copy's value, or the field's kind decides: appended text keeps what each side added, the later review time wins, an added flag wins where the base cannot tell, and an author the copy never recorded is no other author\.$/m
    );
  }, 240000);

  it("counts only the raised fields on rows the base lacks, and the new raises apart from an earlier import's", async () => {
    const place = await preShare(fixture.tmp, { base: true });
    // A sprint made after the base: the base holds i-m01's row, not this one's.
    await onPlace(fixture.tmp, place, 'rbook_sprint', {
      action: 'add',
      sprintId: 's-new',
      title: 'After the base',
      status: 'Planned',
    });
    const first = zipOf(fixture.tmp, place, 'first');
    onFile(first, "UPDATE sprints SET title = 'Retitled on first' WHERE id = 's-new'");
    // The second holds the first's title, which the first import raised, and a rename of its own.
    const second = zipOf(fixture.tmp, place, 'second');
    onFile(
      second,
      "UPDATE sprints SET title = 'Retitled on first' WHERE id = 's-new'",
      "UPDATE missions SET name = 'Renamed on second' WHERE id = 'i-m01'"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    // The record renames i-m01 too, so with the base both sides changed it: raised, on a row the base holds.
    await onPlace(fixture.tmp, owner, 'rbook_mission', {
      action: 'update',
      missionId: 'i-m01',
      fields: { name: 'Renamed by the owner' },
    });
    await onCopy(fixture.tmp, owner, (client) => importCopy(client, first.root, { apply: true }));
    const report = await dryRun(owner, second);
    const text = importText(report);
    // s-new's title is the first import's raise; i-m01's name is a new raise, on a row the base holds.
    expect(
      report.tables.flatMap((table) => table.alreadyRaised).map((change) => change.field)
    ).toEqual(['title']);
    expect(report.tables.flatMap((table) => table.conflicts).map((change) => change.field)).toEqual(
      ['name']
    );
    expect(text).not.toMatch(/raised field\(s\) are on rows or columns the base does not hold/);
    expect(text).toMatch(/sets 0 and raises 1 for you to settle/);
  }, 240000);

  it('accepts an --include of a row the record already holds, and says it brings in nothing for it', async () => {
    const place = await preShare(fixture.tmp, {});
    const zip = zipOf(fixture.tmp, place);
    const owner = await shareExisting(fixture.tmp, place.root);
    const report = await dryRun(owner, zip, ['missions:i-m01']);
    expect(report.alreadyIn).toEqual(['missions:i-m01']);
    expect(importText(report)).toContain(
      '--include names missions:i-m01, which the record already holds, so it brings in nothing for them.'
    );
  }, 240000);

  it('says what it does with a table the copy lacks, and with no marker, where a row only the copy holds is its own', async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    const zip = zipOf(fixture.tmp, place);
    onFile(
      zip,
      'DROP TABLE constraints',
      "UPDATE strategic_decisions SET mission_id = 'i-m03' WHERE id = 1"
    );
    onFile(place, 'PRAGMA foreign_keys = OFF', "DELETE FROM missions WHERE id = 'i-m03'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const report = await dryRun(owner, zip);
    const text = importText(report);
    expect(text).toMatch(
      /^constraints: the copy has no such table; the record's 0 stay as they are\.$/m
    );
    expect(text).toContain(
      "Marker: none, so a row only the copy holds reads as its own, unless the record's log shows it removed it."
    );
    // With no marker, the copy's i-m03 is its own; decision 1's mission names it, as the record will hold it.
    expect(text).toMatch(/missions: \d+ in the copy: .*1 of its own/);
    expect(
      report.tables.find((table) => table.table === 'missions')!.own.map((row) => row.id)
    ).toEqual(['i-m03']);
  }, 240000);

  it("counts a matched row's field naming a row left out among what archiving drops and applying keeps as the record holds it", async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, "UPDATE strategic_decisions SET mission_id = 'i-m03' WHERE id = 1");
    onFile(place, 'PRAGMA foreign_keys = OFF', "DELETE FROM missions WHERE id = 'i-m03'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const text = importText(await dryRun(owner, zip));
    expect(text).toMatch(
      /^strategic_decisions: \d+ in the copy: .*1 field\(s\) naming a row left out or waiting, kept as the record holds them/m
    );
    expect(text).not.toMatch(
      /nothing the record holds differently|holds nothing the record does not hold/
    );
    expect(text).toMatch(
      /Archiving drops the 1 field\(s\) listed above, and the 1 row\(s\) left out above stay out, but for any --include brings in\. Applying would leave all 1 as the record holds them\./
    );
  }, 240000);

  it('counts a link with both ends left out once', async () => {
    const place = await preShare(fixture.tmp, {});
    for (const id of ['i-m03', 'i-m04'])
      await onPlace(fixture.tmp, place, 'rbook_mission', {
        action: 'add',
        missionId: id,
        name: 'Deleted on the owner',
        sprintId: 'i-sprint',
      });
    await onPlace(fixture.tmp, place, 'rbook_mission', {
      action: 'depends',
      fromId: 'i-m03',
      toId: 'i-m04',
      type: 'Requires',
    });
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    const zip = zipOf(fixture.tmp, place);
    onFile(
      place,
      'PRAGMA foreign_keys = OFF',
      "DELETE FROM mission_dependencies WHERE from_id = 'i-m03'",
      "DELETE FROM missions WHERE id IN ('i-m03', 'i-m04')"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const text = importText(await dryRun(owner, zip));
    expect(text).toMatch(
      /^mission_dependencies: 1 in the copy: .*; 1 left out, naming a row the record will not hold/m
    );
    expect(text).toMatch(/the 3 row\(s\) left out above stay out/);
  }, 240000);

  it('names a flag set in the record and clear in the copy by what each holds, since nothing shows which side changed it', async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 'Marked evergreen after the copy.',
    });
    const zip = zipOf(fixture.tmp, place);
    onFile(
      place,
      "UPDATE learnings SET evergreen = 1 WHERE content = 'Marked evergreen after the copy.'"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const text = importText(await dryRun(owner, zip));
    expect(text).toMatch(
      /1 flag\(s\) set in the record and clear in the copy, kept as the record holds them/
    );
    expect(text).toContain(
      'Flags set in the record and clear in the copy; nothing shows which side changed them, and an added flag wins, so the record keeps its own:'
    );
    expect(text).not.toMatch(/the copy cleared/);
  }, 240000);

  it('names a citation, in a row it brings in, of a row it leaves out, since the citation keeps the number the copy wrote', async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_decisions', {
      action: 'record',
      content: 'Gone on the owner.',
    });
    const [gone] = read<{ id: number }>(
      place,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'Gone on the owner.'"
    );
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    const zip = zipOf(fixture.tmp, place);
    await onPlace(fixture.tmp, zip, 'rbook_decisions', {
      action: 'record',
      content: `Follows d:${gone.id}.`,
    });
    onFile(
      place,
      'PRAGMA foreign_keys = OFF',
      `DELETE FROM strategic_decisions WHERE id = ${gone.id}`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const report = await dryRun(owner, zip);
    expect(
      report.tables.find((table) => table.table === 'strategic_decisions')!.leftOut
    ).toContainEqual(
      expect.objectContaining({
        column: 'decision_text',
        names: `strategic_decisions:${gone.id}`,
        cites: true,
      })
    );
    expect(importText(report)).toContain(
      `decision_text cites strategic_decisions:${gone.id}, which the import leaves out: the citation keeps the number the copy wrote, which in the record names another row or none`
    );
  }, 240000);

  it('counts no difference for a field both stores hold alike, though it names a row neither holds', async () => {
    const place = await preShare(fixture.tmp, {});
    onFile(
      place,
      'PRAGMA foreign_keys = OFF',
      "UPDATE missions SET sprint_id = 'gone-sprint' WHERE id = 'i-m01'"
    );
    const zip = zipOf(fixture.tmp, place);
    const owner = await shareExisting(fixture.tmp, place.root);
    const report = await dryRun(owner, zip);
    expect(report.tables.flatMap((table) => table.leftOut)).toEqual([]);
    expect(report.differing).toBe(0);
    expect(importText(report)).toMatch(
      /This copy holds nothing the record does not hold, so nothing needs bringing in/
    );
  }, 240000);

  it('matches a link both stores hold alike, though an end names a row neither holds', async () => {
    const place = await preShare(fixture.tmp, {});
    onFile(
      place,
      'PRAGMA foreign_keys = OFF',
      "INSERT INTO mission_dependencies (from_id, to_id, type) VALUES ('i-m01', 'gone-m99', 'Requires')"
    );
    const zip = zipOf(fixture.tmp, place);
    const owner = await shareExisting(fixture.tmp, place.root);
    const report = await dryRun(owner, zip);
    expect(report.tables.find((table) => table.table === 'mission_dependencies')).toMatchObject({
      identical: 1,
      leftOut: [],
      ownerOnly: 0,
    });
    expect(importText(report)).toMatch(/This copy holds nothing the record does not hold/);
  }, 240000);

  it("keeps an earlier import's raises still in conflict in the last line beside what archiving drops", async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    const zip = zipOf(fixture.tmp, place);
    onFile(
      zip,
      "UPDATE missions SET name = 'Renamed on the copy' WHERE id = 'i-m01'",
      "UPDATE strategic_decisions SET mission_id = 'i-m03' WHERE id = 1"
    );
    onFile(place, 'PRAGMA foreign_keys = OFF', "DELETE FROM missions WHERE id = 'i-m03'");
    const owner = await shareExisting(fixture.tmp, place.root);
    await onCopy(fixture.tmp, owner, (client) => importCopy(client, zip.root, { apply: true }));
    const text = importText(await dryRun(owner, zip));
    expect(text).toMatch(/An earlier import raised these, still in conflict/);
    expect(text).toMatch(
      /Archiving drops the 1 field\(s\) listed above.* The 1 field\(s\) an earlier import raised are still in conflict: settle each with rbook_db\(action="settle"\) first\./
    );
  }, 240000);

  it("names a citation of a row left out in a matched row's text the copy holds differently", async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_decisions', {
      action: 'record',
      content: 'Gone on the owner.',
    });
    const [gone] = read<{ id: number }>(
      place,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'Gone on the owner.'"
    );
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, `UPDATE strategic_decisions SET context_text = 'See d:${gone.id}.' WHERE id = 1`);
    onFile(
      place,
      'PRAGMA foreign_keys = OFF',
      `DELETE FROM strategic_decisions WHERE id = ${gone.id}`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const report = await dryRun(owner, zip);
    const decisions = report.tables.find((table) => table.table === 'strategic_decisions')!;
    expect(decisions.conflicts.map((change) => change.field)).toContain('context_text');
    expect(importText(report)).toContain(
      `  strategic_decisions:1 context_text cites strategic_decisions:${gone.id}, which the import leaves out: the citation keeps the number the copy wrote, which in the record names another row or none`
    );
    // A note on a field it raises, never one it keeps.
    expect(importText(report)).not.toMatch(/naming a row left out or waiting, kept/);
  }, 240000);

  it('names a reference both stores hold alike whose number the record has given another row, and the number an --include takes', async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_decisions', {
      action: 'record',
      content: 'Supersedes the first.',
    });
    const [second] = read<{ id: number }>(
      place,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'Supersedes the first.'"
    );
    onFile(place, `UPDATE strategic_decisions SET superseded_by = ${second.id} WHERE id = 1`);
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    const zip = zipOf(fixture.tmp, place);
    onFile(
      place,
      'PRAGMA foreign_keys = OFF',
      `DELETE FROM strategic_decisions WHERE id = ${second.id}`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    // After sharing, the record gives that number to a decision of its own.
    await onPlace(fixture.tmp, owner, 'rbook_decisions', {
      action: 'record',
      content: 'The owner, after sharing.',
    });
    expect(
      read(
        owner,
        "SELECT id FROM strategic_decisions WHERE decision_text = 'The owner, after sharing.'"
      )
    ).toEqual([{ id: second.id }]);
    const text = importText(await dryRun(owner, zip));
    expect(text).toContain(
      `  strategic_decisions:1 superseded_by names strategic_decisions:${second.id}: the record keeps its own value`
    );
    expect(text).not.toMatch(
      /nothing the record holds differently|holds nothing the record does not hold/
    );
    const included = importText(await dryRun(owner, zip, [`strategic_decisions:${second.id}`]));
    expect(included).toMatch(
      new RegExp(`strategic_decisions:${second.id} \\(.*\\), brought in by --include as \\d+`)
    );
  }, 240000);

  it('flags a kept reference on a row the copy changed after the marker, and counts it among those so flagged', async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_mission', {
      action: 'add',
      missionId: 'i-m03',
      name: 'Deleted on the owner',
      sprintId: 'i-sprint',
    });
    // A shared next step, as a session's close writes it, naming the mission.
    await onPlace(fixture.tmp, place, 'rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'Before the copy',
    });
    await onPlace(fixture.tmp, place, 'rbook_session', {
      action: 'complete',
      summary: 'Before the copy.',
      nextSteps: ['A shared step.'],
    });
    onFile(place, "UPDATE next_steps SET mission_id = 'i-m03' WHERE content = 'A shared step.'");
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    const zip = zipOf(fixture.tmp, place);
    const later = new Date(Date.now() + 60_000).toISOString();
    onFile(
      zip,
      `UPDATE next_steps SET status = 'completed', resolved_at = '${later}' WHERE content = 'A shared step.'`
    );
    // The owner deletes the mission, emptying the step's reference as the schema's own rule would.
    onFile(
      place,
      'PRAGMA foreign_keys = OFF',
      "UPDATE next_steps SET mission_id = NULL WHERE content = 'A shared step.'",
      "DELETE FROM missions WHERE id = 'i-m03'"
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const report = await dryRun(owner, zip);
    const text = importText(report);
    expect(text).toMatch(
      /^ {2}next_steps:\d+ mission_id names missions:i-m03: the record keeps its own value; the copy's row carries a time after the marker, so this may be its own change$/m
    );
    expect(report.flagged).toBe(report.differing);
    expect(text).toMatch(
      new RegExp(
        `Archiving drops the ${report.differing} field\\(s\\) listed above; ${report.differing} are on rows carrying a time after the marker`
      )
    );
  }, 240000);

  it("names no citation where the record's value stands, since nothing is written there", async () => {
    const place = await preShare(fixture.tmp, {});
    await onPlace(fixture.tmp, place, 'rbook_decisions', { action: 'record', content: 'Gone.' });
    const [gone] = read<{ id: number }>(
      place,
      "SELECT id FROM strategic_decisions WHERE decision_text = 'Gone.'"
    );
    onFile(place, `UPDATE strategic_decisions SET context_text = 'See d:${gone.id}.' WHERE id = 1`);
    await onPlace(fixture.tmp, place, 'rbook_db', { action: 'snapshot' });
    await onPlace(fixture.tmp, place, 'rbook_context', { action: 'snapshot', source: 'marker' });
    const zip = zipOf(fixture.tmp, place);
    // Only the record changed the text since the base; the copy still cites the decision it lost.
    onFile(
      place,
      'PRAGMA foreign_keys = OFF',
      "UPDATE strategic_decisions SET context_text = 'Changed by the owner.' WHERE id = 1",
      `DELETE FROM strategic_decisions WHERE id = ${gone.id}`
    );
    const owner = await shareExisting(fixture.tmp, place.root);
    const report = await dryRun(owner, zip);
    expect(report.base).toMatch(/snapshot-/);
    expect(importText(report)).not.toMatch(/context_text cites/);
  }, 240000);

  it('names in its base line that a flag follows the base where it tells, and an added flag wins only where it cannot', async () => {
    const place = await preShare(fixture.tmp, { base: true });
    const zip = zipOf(fixture.tmp, place);
    onFile(zip, "UPDATE missions SET name = 'Renamed on the copy' WHERE id = 'i-m01'");
    const owner = await shareExisting(fixture.tmp, place.root);
    const text = importText(await dryRun(owner, zip));
    expect(text).toMatch(
      /^Base: snapshot-.*appended text keeps what each side added, the later review time wins, an added flag wins where the base cannot tell, and an author the copy never recorded is no other author\./m
    );
  }, 240000);
});
