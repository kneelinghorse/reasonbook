// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m01 (ADR s96 §9) — this machine refuses writes to a copy of a shared record it cannot confirm
// ABOUTME: (unjoined, restored, replaced, a second live copy), rebinds a moved copy, and checks before it registers.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { genesisColumns } from '../../../src/tools/rbook/genesis-columns';
import { recordedTransaction } from '../../../src/tools/rbook/record-changes';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { reidentifyReplica, replicaWriteRefusal } from '../../../src/tools/rbook/replica-check';
import { establishReplica, fileIdentity } from '../../../src/tools/rbook/replica-identity';
import { spinOut } from '../../../src/tools/rbook/spin-out';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import {
  backup,
  call,
  dbOf,
  dropSidecars,
  mark,
  project,
  PROJECT_ID,
  record,
  replicaFixture,
  seq,
  share,
  useMachine,
  withClient,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';

const DATA_VOLUME = '/System/Volumes/Data';
const itOnMac = process.platform === 'darwin' && fs.existsSync(DATA_VOLUME) ? it : it.skip;

let fixture: ReplicaFixture;
let tmp: string;
beforeEach(() => {
  fixture = replicaFixture('rbook-replica-check-');
  tmp = fixture.tmp;
  useMachine(tmp, 'air');
});
afterEach(() => fixture.restore());

const registry = () => ProjectGraphRegistry.getInstance();
const binding = () => registry().liveReplicas(PROJECT_ID)[0];

/** Insert one decision through a client, as the record tool does, and return its id. */
function insertDecision(client: RbookDatabaseClient, text: string): number {
  const written = recordedTransaction(client, () => {
    const g = genesisColumns(client, 'strategic_decisions', PROJECT_ID);
    const inserted = client.execute(
      `INSERT INTO strategic_decisions (decision_text, created_at, ${g.columns.join(', ')}) VALUES (?, datetime('now'), ${g.placeholders})`,
      [text, ...g.values]
    );
    if (!inserted.success) throw new Error(inserted.error?.message);
    return Number(inserted.data?.lastInsertRowid);
  });
  if (!written.success) throw new Error(written.error?.message);
  return written.data!;
}

describe('this machine refuses writes to a copy it cannot confirm', () => {
  it('a second live copy of the project on this machine', async () => {
    const air = project(tmp, 'air-copy');
    await share(air, 0);
    expect((await record(air, 'The bound copy writes.')).success).toBe(true);
    const second = path.join(tmp, 'second-copy');
    fs.cpSync(air, second, { recursive: true });
    const refused = await record(second, 'A second copy must not write.');
    expect(refused.error?.code).toBe('REPLICA_SECOND_COPY');
    expect(refused.error?.message).toContain(air);
    // Tools that only read still work.
    expect((await call('rbook_decisions', { action: 'list', projectRoot: second })).success).toBe(
      true
    );
  });

  it('a copy that has not joined on this machine', async () => {
    const root = project(tmp, 'zipped');
    await share(root, 0);
    useMachine(tmp, 'studio');
    const refused = await record(root, 'Written before joining.');
    expect(refused.error?.code).toBe('REPLICA_NOT_JOINED');
  });

  it.each([
    [
      'replaced by a new file',
      (root: string, saved: string) => {
        fs.rmSync(dbOf(root));
        fs.copyFileSync(saved, dbOf(root));
      },
    ],
    [
      'restored in place, keeping the inode',
      (root: string, saved: string) => {
        fs.writeFileSync(dbOf(root), fs.readFileSync(saved));
      },
    ],
  ])('a restored backup, %s', async (_how, restore) => {
    const root = project(tmp, 'restored');
    await share(root, 1);
    expect((await record(root, 'Before the backup.')).success).toBe(true);
    const saved = path.join(tmp, 'backup.sqlite');
    backup(root, saved);
    const atBackup = seq(root);
    expect((await record(root, 'After the backup.')).success).toBe(true);
    const reached = seq(root);
    dropSidecars(root);
    restore(root, saved);
    const refused = await record(root, 'Written to a restored backup.');
    expect(refused.error?.code).toBe('REPLICA_RESTORED');
    expect(refused.error?.message).toContain(
      `its sequence is ${atBackup}; this machine saw it reach ${reached}`
    );
  });

  it('a file replaced by a copy of itself, with nothing written since: the inode tells', async () => {
    // The sequence equals the mark, so only the store file's identity can catch it (ADR s96 §9).
    const root = project(tmp, 'same-sequence');
    await share(root, 1);
    expect((await record(root, 'The last write.')).success).toBe(true);
    const saved = path.join(tmp, 'same.sqlite');
    backup(root, saved);
    dropSidecars(root);
    // The old file stays alive while its copy is written, as when a folder is replaced, so the copy
    // cannot be given the old inode. A file deleted first can be, on ext4: an admitted hole.
    const displaced = path.join(tmp, 'displaced.sqlite');
    fs.renameSync(dbOf(root), displaced);
    fs.copyFileSync(saved, dbOf(root));
    fs.rmSync(displaced);
    expect(seq(root)).toBe(mark());
    expect((await record(root, 'Written to the replacement.')).error?.code).toBe(
      'REPLICA_RESTORED'
    );
  });

  it('an unzipped copy in a new folder after the original was deleted is not a move', async () => {
    // The bound folder is gone and the sequence is not behind, so only the inode tells a fresh
    // copy from the same file moved.
    const root = project(tmp, 'original');
    await share(root, 1);
    expect((await record(root, 'Written in the original.')).success).toBe(true);
    const unzipped = path.join(tmp, 'unzipped');
    fs.mkdirSync(path.join(unzipped, 'rbook', 'db'), { recursive: true });
    backup(root, dbOf(unzipped));
    fs.rmSync(root, { recursive: true, force: true });
    expect((await record(unzipped, 'Written in the unzipped copy.')).error?.code).toBe(
      'REPLICA_RESTORED'
    );
    expect(binding().store_path).toBe(root);
  });

  it('leaves a refused copy where it was, however often it tries', async () => {
    // A refused attempt that took a sequence would walk a restored copy up past its mark.
    const root = project(tmp, 'restored');
    await share(root, 1);
    await record(root, 'Before the backup.');
    const saved = path.join(tmp, 'backup.sqlite');
    backup(root, saved);
    const atBackup = seq(root);
    await record(root, 'After the backup.');
    dropSidecars(root);
    fs.rmSync(dbOf(root));
    fs.copyFileSync(saved, dbOf(root));
    for (let attempt = 0; attempt < 3; attempt++)
      expect((await record(root, `Attempt ${attempt}.`)).error?.code).toBe('REPLICA_RESTORED');
    expect(seq(root)).toBe(atBackup);
  });

  it('a damaged identity, a replica id without its block', async () => {
    const root = project(tmp, 'damaged');
    const db = new Database(dbOf(root));
    db.prepare("INSERT INTO metadata (key, value) VALUES ('replica_id', '01DAMAGED')").run();
    db.close();
    expect((await record(root, 'Written to a damaged copy.')).error?.code).toBe(
      'REPLICA_UNCHECKED'
    );
  });

  it('a copy whose project id differs from the one this machine bound it to', async () => {
    const root = project(tmp, 'rekeyed');
    await share(root, 1);
    const db = new Database(dbOf(root));
    // Simulate corruption past the SQL guard; the open check must still catch it.
    db.exec('DROP TRIGGER record_guard_metadata_update');
    db.prepare("UPDATE metadata SET value = 'p-other' WHERE key = 'project_id'").run();
    db.close();
    const refused = await record(root, 'Written under another project id.');
    expect(refused.error?.code).toBe('REPLICA_UNCHECKED');
    expect(refused.error?.message).toContain('this machine bound replica');
  });

  it('a copy that lost its project id is refused, and registration mints it no new one', async () => {
    const root = project(tmp, 'lost-id');
    await share(root, 1);
    const db = new Database(dbOf(root));
    // Simulate corruption past the SQL guard; registration must not manufacture a new id.
    db.exec('DROP TRIGGER record_guard_metadata_delete');
    db.prepare("DELETE FROM metadata WHERE key = 'project_id'").run();
    db.close();
    expect((await record(root, 'Written without a project id.')).error?.code).toBe(
      'REPLICA_UNCHECKED'
    );
    const after = new Database(dbOf(root), { readonly: true });
    const minted = after.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get();
    after.close();
    // A shared record's project id never changes (ADR s96 §4); minting one would re-key the copy.
    expect(minted).toBeUndefined();
  });
});

describe('the check runs before the copy registers', () => {
  it('a stale copy opened first never takes the registry row from the moved live copy', async () => {
    const root = project(tmp, 'live');
    await share(root, 1);
    expect((await record(root, 'Registered here.')).success).toBe(true);
    // An older copy, taken before the live copy moves.
    const stale = path.join(tmp, 'stale');
    fs.cpSync(root, stale, { recursive: true });
    const moved = path.join(tmp, 'moved');
    fs.renameSync(root, moved);
    // The stale copy opens first: refused, and the registry still knows the project by the binding.
    expect((await record(stale, 'Written to the stale copy.')).error?.code).toBe(
      'REPLICA_RESTORED'
    );
    expect(registry().get(PROJECT_ID)?.store_path).not.toBe(stale);
    // The moved copy is the same file, not behind: it rebinds, writes and takes the row.
    expect((await record(moved, 'Written after the move.')).data?.decisionId).toBe(1_000_002);
    expect(binding().store_path).toBe(moved);
    expect(registry().get(PROJECT_ID)?.store_path).toBe(moved);
  });

  it('a bound copy writes by its folder although an unbound duplicate registered first', async () => {
    const root = project(tmp, 'bound');
    await share(root, 1);
    const duplicate = path.join(tmp, 'duplicate');
    fs.cpSync(root, duplicate, { recursive: true });
    // The registry row points at the duplicate, as a registration before this change could leave it.
    (await ProjectGraphRegistry.create()).register({
      project_id: PROJECT_ID,
      store_path: duplicate,
      name: 'shared',
    });
    expect((await record(duplicate, 'Written to the duplicate.')).error?.code).toBe(
      'REPLICA_SECOND_COPY'
    );
    expect((await record(root, 'Written to the bound copy.')).success).toBe(true);
    expect(registry().get(PROJECT_ID)?.store_path).toBe(root);
  });
});

describe('this machine confirms a copy that only moved', () => {
  it('rebinds it when the old folder is gone and the file is the same', async () => {
    const root = project(tmp, 'before-move');
    await share(root, 1);
    expect((await record(root, 'Before the move.')).success).toBe(true);
    const moved = path.join(tmp, 'after-move');
    fs.renameSync(root, moved);
    expect((await record(moved, 'After the move.')).data?.decisionId).toBe(1_000_002);
    expect(binding().store_path).toBe(moved);
  });

  it('rebinds the device when its volume mounts under another number', async () => {
    // Disk images, external drives and network shares are renumbered at mount; the inode stays.
    const root = project(tmp, 'renumbered');
    await share(root, 1);
    expect((await record(root, 'Before the remount.')).success).toBe(true);
    const bound = binding();
    registry().rebindReplica(bound.replica_id, root, {
      device: bound.device + 7,
      inode: bound.inode,
    });
    expect((await record(root, 'After the remount.')).success).toBe(true);
    expect(binding().device).toBe(fileIdentity(dbOf(root)).device);
  });

  it('rebinds a copy whose volume came back under another name and device number', async () => {
    // After an unclean eject, macOS mounts the volume again as "<name> 1", with a new device.
    const root = project(tmp, 'volume');
    await share(root, 1);
    expect((await record(root, 'Before the eject.')).success).toBe(true);
    const bound = binding();
    registry().rebindReplica(bound.replica_id, root, {
      device: bound.device + 7,
      inode: bound.inode,
    });
    const remounted = path.join(tmp, 'volume 1');
    fs.renameSync(root, remounted);
    expect((await record(remounted, 'After the remount.')).data?.decisionId).toBe(1_000_002);
    expect(binding()).toMatchObject({
      store_path: remounted,
      device: fileIdentity(dbOf(remounted)).device,
    });
  });

  itOnMac('knows it by the Data volume spelling its binding holds', async () => {
    // Opening a store by that spelling trips the suite's real-store guard, so the binding holds it.
    const root = project(tmp, 'data-volume');
    await share(root, 1);
    const bound = binding();
    registry().bindReplica({
      replicaId: bound.replica_id,
      projectId: PROJECT_ID,
      storePath: DATA_VOLUME + root,
      device: bound.device,
      inode: bound.inode,
      seqMark: bound.seq_mark,
    });
    expect((await record(root, 'Through /Users.')).data?.decisionId).toBe(1_000_001);
  });
});

describe('one machine keeps one live copy of a shared record', () => {
  it('refuses both of two joined copies of one project on this machine', async () => {
    const first = project(tmp, 'first');
    await share(first, 1);
    const second = path.join(tmp, 'second');
    fs.cpSync(first, second, { recursive: true });
    // A second join on this machine, as s96-m13's join would make one without its own check.
    await share(second, 2);
    expect((await record(first, 'From the first copy.')).error?.code).toBe('REPLICA_SECOND_COPY');
    expect((await record(second, 'From the second copy.')).error?.code).toBe('REPLICA_SECOND_COPY');
    // Archiving one copy leaves the other free to write.
    fs.rmSync(second, { recursive: true, force: true });
    expect((await record(first, 'The one copy left.')).success).toBe(true);
  });
});

describe('a healthy copy is never refused for how two writers interleave', () => {
  it('another process commits between the check reading the mark and the sequence', async () => {
    const root = project(tmp, 'interleaved');
    await share(root, 1);
    expect((await record(root, 'Warm.')).success).toBe(true);
    const checked = (await RbookDatabaseClient.create({ dbPath: dbOf(root), replicaCheck: false }))
      .data!;
    const writer = (await RbookDatabaseClient.create({ dbPath: dbOf(root) })).data!;
    const original = ProjectGraphRegistry.prototype.replicaBinding;
    let fired = false;
    // The other process commits, and raises the mark, at the moment the check begins.
    ProjectGraphRegistry.prototype.replicaBinding = function (this: ProjectGraphRegistry, id) {
      if (!fired) {
        fired = true;
        insertDecision(writer, 'Committed by another process.');
      }
      return original.call(this, id);
    };
    try {
      expect(replicaWriteRefusal(checked)).toBeNull();
    } finally {
      ProjectGraphRegistry.prototype.replicaBinding = original;
      checked.close();
      writer.close();
    }
    expect(fired).toBe(true);
    expect(mark()).toBe(seq(root));
  });
});

describe('a verdict is kept only when it can be trusted', () => {
  it('a check that failed is judged again at the next write', async () => {
    const root = project(tmp, 'flaky');
    await share(root, 1);
    const client = (await RbookDatabaseClient.create({ dbPath: dbOf(root), replicaCheck: false }))
      .data!;
    const original = ProjectGraphRegistry.prototype.replicaBinding;
    let failures = 1;
    ProjectGraphRegistry.prototype.replicaBinding = function (this: ProjectGraphRegistry, id) {
      if (failures-- > 0) throw new Error('the registry is busy');
      return original.call(this, id);
    };
    try {
      expect(replicaWriteRefusal(client)?.code).toBe('REPLICA_UNCHECKED');
      expect(replicaWriteRefusal(client)).toBeNull();
    } finally {
      ProjectGraphRegistry.prototype.replicaBinding = original;
      client.close();
    }
  });

  it("a refusal reached in a deferred transaction's old snapshot is not kept", async () => {
    const root = project(tmp, 'snapshot');
    await share(root, 1);
    expect((await record(root, 'Warm.')).success).toBe(true);
    const reader = (await RbookDatabaseClient.create({ dbPath: dbOf(root), replicaCheck: false }))
      .data!;
    const writer = (await RbookDatabaseClient.create({ dbPath: dbOf(root) })).data!;
    try {
      const inside = reader.transaction(() => {
        // The read pins the snapshot; the other writer then commits and raises the mark.
        reader.getOne('SELECT count(*) AS n FROM strategic_decisions');
        insertDecision(writer, 'Committed after the snapshot.');
        return replicaWriteRefusal(reader);
      });
      expect(inside.data?.code).toBe('REPLICA_RESTORED');
      expect(replicaWriteRefusal(reader)).toBeNull();
    } finally {
      reader.close();
      writer.close();
    }
  });
});

describe('re-identification keeps one live copy per machine', () => {
  it('refuses to re-identify a duplicate of a live copy, and leaves the live copy bound', async () => {
    const root = project(tmp, 'live');
    await share(root, 1);
    expect((await record(root, 'In the live copy.')).success).toBe(true);
    const duplicate = path.join(tmp, 'duplicate');
    fs.cpSync(root, duplicate, { recursive: true });
    await withClient(
      duplicate,
      (client) =>
        expect(() => reidentifyReplica(client, { block: 2, authorityReceived: 0 })).toThrow(
          /already holds a live copy of this shared project at/
        ),
      { replicaCheck: false }
    );
    expect(binding().store_path).toBe(root);
    expect(binding().retired_at).toBeNull();
    expect((await record(root, 'The live copy still writes.')).success).toBe(true);
  });
});

describe('the backstop, for a client that opened without the check', () => {
  it('refuses a new or deleted row of a shared table, and lets an UPDATE and other tables pass', async () => {
    const root = project(tmp, 'zipped');
    await share(root, 0);
    useMachine(tmp, 'studio');
    await withClient(
      root,
      (client) => {
        const before = seq(root);
        // genesisColumns takes nothing for a copy whose write will be refused.
        const g = client.writeTransaction(() =>
          genesisColumns(client, 'strategic_decisions', PROJECT_ID)
        ).data!;
        expect(g.columns).not.toContain('id');
        expect(seq(root)).toBe(before);
        const insert = client.execute(
          `INSERT INTO strategic_decisions (decision_text, created_at, ${g.columns.join(', ')}) VALUES ('refused', datetime('now'), ${g.placeholders})`,
          g.values
        );
        expect(insert.error?.code).toBe('REPLICA_NOT_JOINED');
        expect(client.execute('DELETE FROM strategic_decisions').error?.code).toBe(
          'REPLICA_NOT_JOINED'
        );
        expect(client.raw("DELETE FROM learnings WHERE content = 'x'").error?.code).toBe(
          'REPLICA_NOT_JOINED'
        );
        // A migration's backfill updates rows on any copy; s96-m03's guards cover recorded UPDATEs.
        expect(client.execute("UPDATE strategic_decisions SET status = 'active'").success).toBe(
          true
        );
        expect(
          client.execute(
            "INSERT INTO session_events (ts, agent, action, status, summary, raw_event) VALUES (datetime('now'), 't', 'probe', 'ok', 'not shared', '{}')"
          ).success
        ).toBe(true);
      },
      { replicaCheck: false }
    );
  });
});

describe('stores that are not shared are never judged', () => {
  it('a store too old to have a metadata table opens and writes as it always did', async () => {
    const root = path.join(tmp, 'ancient');
    seedRbookDb(root, { projectId: PROJECT_ID });
    const db = new Database(dbOf(root));
    db.exec('DROP TABLE metadata;');
    db.close();
    const opened = await RbookDatabaseClient.create({ dbPath: dbOf(root) });
    expect(opened.success).toBe(true);
    const client = opened.data!;
    try {
      expect(replicaWriteRefusal(client)).toBeNull();
      // Its rows are numbered by SQLite, as before sharing existed.
      const written = client.execute(
        "INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('an old store writes', datetime('now'))"
      );
      expect(written.success).toBe(true);
      expect(written.data?.lastInsertRowid).toBe(1);
    } finally {
      client.close();
    }
  });

  it('a store whose metadata cannot be read is refused with the real error, not as a shared copy', async () => {
    const root = path.join(tmp, 'unreadable');
    seedRbookDb(root, { projectId: PROJECT_ID });
    const db = new Database(dbOf(root));
    // Reading this view fails at run time, as a damaged page or an I/O error would.
    db.exec(
      'ALTER TABLE metadata RENAME TO metadata_rows; CREATE VIEW metadata AS SELECT key, value FROM metadata_rows WHERE abs(-9223372036854775807 - 1) > 0;'
    );
    db.close();
    const opened = await RbookDatabaseClient.create({ dbPath: dbOf(root) });
    expect(opened.success).toBe(false);
    expect(opened.error?.code).toBe('DB_QUERY_FAILED');
    expect(opened.error?.message).toMatch(/could not be read.*integer overflow/);
    expect(opened.error?.message).not.toMatch(/shared record/);
  });

  it('a loose store is judged and numbered like a strict one', async () => {
    // The fleet's loose stores lack the foreign keys on learnings and some on strategic_decisions,
    // and most declare strategic_decisions.status nullable (fleet-schema README).
    const root = project(tmp, 'loose');
    const db = new Database(dbOf(root));
    const sqlOf = (table: string) =>
      (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string })
        .sql;
    // Drop table-level foreign keys on the named columns, each with its leading comma.
    const dropForeignKeys = (sql: string, columns: string) =>
      sql.replace(
        new RegExp(
          `,\\s*FOREIGN KEY \\((?:${columns})\\) REFERENCES \\w+\\(\\w+\\)(?: ON DELETE (?:SET NULL|CASCADE))?`,
          'g'
        ),
        ''
      );
    expect(sqlOf('strategic_decisions')).toMatch(/status TEXT NOT NULL/);
    const loose = {
      // Three of its six foreign keys, as most loose stores hold, and a nullable status.
      strategic_decisions: dropForeignKeys(
        sqlOf('strategic_decisions'),
        'author_session_id|mission_id|superseded_by'
      ).replace(/status TEXT NOT NULL/, 'status TEXT'),
      learnings: dropForeignKeys(sqlOf('learnings'), '\\w+'),
    };
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    for (const [table, sql] of Object.entries(loose))
      db.prepare('UPDATE sqlite_master SET sql = ? WHERE name = ?').run(sql, table);
    db.pragma('writable_schema = OFF');
    db.close();
    const check = new Database(dbOf(root), { readonly: true });
    expect(check.pragma('foreign_key_list(learnings)')).toEqual([]);
    expect(check.pragma('foreign_key_list(strategic_decisions)')).toHaveLength(3);
    expect(check.pragma('integrity_check', { simple: true })).toBe('ok');
    check.close();
    await share(root, 3);
    expect((await record(root, 'Written to a loose store.')).data?.decisionId).toBe(3_000_001);
    useMachine(tmp, 'studio');
    expect((await record(root, 'Not joined here.')).error?.code).toBe('REPLICA_NOT_JOINED');
  });
});

describe('writers that bypass the record tools respect a shared copy', () => {
  it('init checks the copy first and refuses to seed a sprint or missions into a shared one', async () => {
    const root = project(tmp, 'init-shared');
    // Cross the creation second deterministically: BEFORE INSERT guards run even for OR IGNORE.
    const olderCreatedAt = new Date(Date.now() - 60_000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    const setup = new Database(dbOf(root));
    setup.prepare("UPDATE metadata SET value = ? WHERE key = 'created_at'").run(olderCreatedAt);
    setup.close();
    await share(root, 1);
    useMachine(tmp, 'studio');
    const unjoined = await rbookProjectInit({
      projectRoot: root,
      initialSprint: { id: 'sprint-50', title: 'Seeded' },
    });
    expect(unjoined.error?.code).toBe('REPLICA_NOT_JOINED');
    useMachine(tmp, 'air');
    const healthy = await rbookProjectInit({
      projectRoot: root,
      initialMissions: [{ id: 's50-m01', name: 'Seeded mission' }],
    });
    expect(healthy.error?.code).toBe('INVALID_PARAMETER');
    expect(healthy.error?.field).toBe('initialMissions');
    const db = new Database(dbOf(root), { readonly: true });
    const seeded = db.prepare("SELECT count(*) AS n FROM sprints WHERE id = 'sprint-50'").get() as {
      n: number;
    };
    db.close();
    expect(seeded.n).toBe(0);
    // Without seeding, a healthy shared copy re-inits as before.
    const before = await withClient(root, (client) => ({
      createdAt: client.getOne<{ value: string }>(
        "SELECT value FROM metadata WHERE key = 'created_at'"
      ).data?.value,
      traceLab: client.getOne("SELECT value FROM metadata WHERE key = 'tracelab_project_id'").data,
      changes: client.getOne<{ n: number }>('SELECT count(*) AS n FROM record_changes').data!.n,
    }));
    expect(before.createdAt).toBe(olderCreatedAt);
    expect(before.traceLab).toBeUndefined();
    const reinitialized = await rbookProjectInit({ projectRoot: root });
    if (!reinitialized.success) throw new Error(JSON.stringify(reinitialized.error));
    expect(reinitialized.success).toBe(true);
    expect(
      await withClient(root, (client) => ({
        createdAt: client.getOne<{ value: string }>(
          "SELECT value FROM metadata WHERE key = 'created_at'"
        ).data?.value,
        traceLab: client.getOne("SELECT value FROM metadata WHERE key = 'tracelab_project_id'")
          .data,
        changes: client.getOne<{ n: number }>('SELECT count(*) AS n FROM record_changes').data!.n,
      }))
    ).toEqual(before);
  });

  it('init refuses a damaged shared copy, and a refused init leaves the store as it found it', async () => {
    const root = project(tmp, 'init-damaged');
    const db = new Database(dbOf(root));
    db.pragma('journal_mode = DELETE');
    db.prepare("INSERT INTO metadata (key, value) VALUES ('replica_id', '01DAMAGED')").run();
    db.close();
    dropSidecars(root);
    const refused = await rbookProjectInit({ projectRoot: root });
    expect(refused.error?.code).toBe('REPLICA_UNCHECKED');
    // The check opened the store read-only: no switch to WAL, no new files beside it.
    expect(fs.existsSync(dbOf(root) + '-wal')).toBe(false);
    const after = new Database(dbOf(root), { readonly: true });
    expect(after.pragma('journal_mode', { simple: true })).toBe('delete');
    after.close();
  });

  it('a refused project-id change leaves an unshared rollback-journal store as it found it', async () => {
    const root = path.join(tmp, 'init-journal');
    seedRbookDb(root, { projectId: PROJECT_ID });
    const db = new Database(dbOf(root));
    db.pragma('journal_mode = DELETE');
    db.close();
    dropSidecars(root);
    const refused = await rbookProjectInit({ projectRoot: root, projectId: 'another-id' });
    expect(refused.error?.code).toBe('INVALID_PARAMETER');
    expect(fs.existsSync(dbOf(root) + '-wal')).toBe(false);
    const after = new Database(dbOf(root), { readonly: true });
    expect(after.pragma('journal_mode', { simple: true })).toBe('delete');
    after.close();
  });

  it('registration mints no project id for a shared copy that lost its own', async () => {
    const root = project(tmp, 'register-lost-id');
    await share(root, 1);
    const db = new Database(dbOf(root));
    // Simulate the missing identity despite its SQL guard.
    db.exec('DROP TRIGGER record_guard_metadata_delete');
    db.prepare("DELETE FROM metadata WHERE key = 'project_id'").run();
    db.close();
    const graph = await ProjectGraphRegistry.create();
    // rbook_project register reaches this without opening a client.
    expect(() => graph.registerStore(root, { requireStoredIdentity: true })).toThrow(
      /Unable to persist a project identity/
    );
    const after = new Database(dbOf(root), { readonly: true });
    expect(
      after.prepare("SELECT value FROM metadata WHERE key = 'project_id'").get()
    ).toBeUndefined();
    after.close();
  });

  it('spin-out refuses a shared store on either side', async () => {
    const source = project(tmp, 'spin-source');
    await share(source, 1);
    expect(
      (
        await call('rbook_sprint', {
          action: 'add',
          sprintId: 'sprint-7',
          title: 'Moving',
          status: 'Planned',
          projectRoot: source,
        })
      ).success
    ).toBe(true);
    const target = path.join(tmp, 'spin-target');
    fs.mkdirSync(target);
    const result = await spinOut({
      from: source,
      to: target,
      sprintId: 'sprint-7',
      apply: true,
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/one of these is a copy of a shared record/);
  });
});

describe('a copy takes its identity only once its store is ready to share', () => {
  it('binds the copy where it lies, with its file identity', async () => {
    const root = project(tmp, 'bind');
    await share(root, 4);
    expect(binding()).toMatchObject({
      store_path: root,
      ...fileIdentity(dbOf(root)),
      seq_mark: 1, // The real share step records the baseline.
    });
  });

  it('refuses a store whose migrations have not run, which a create under the lock could not run', async () => {
    const root = project(tmp, 'unprepared');
    await withClient(
      root,
      (client) =>
        expect(() => establishReplica(client, { block: 4 })).toThrow(/not ready to share/),
      { replicaCheck: false }
    );
    expect(registry().liveReplicas(PROJECT_ID)).toEqual([]);
  });
});
