// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m01 (ADR s96 §3, §9) — a copy of a shared record numbers in its own block under the write lock,
// ABOUTME: its sequence rolls back with a failed create, and this machine's mark follows only commits.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { genesisColumns } from '../../../src/tools/rbook/genesis-columns';
import { recordedTransaction } from '../../../src/tools/rbook/record-changes';
import { shareRecord } from '../../../src/tools/rbook/record-share';
import { moveReplicaBlock } from '../../../src/tools/rbook/replica-copy-keys';
import { lostChanges, reidentifyReplica } from '../../../src/tools/rbook/replica-check';
import { sharedStoreWrite } from '../../../src/tools/rbook/replica-identity';
import { prepareForSharing } from '../../../src/tools/rbook/sharing-preconditions';
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

let fixture: ReplicaFixture;
let tmp: string;
beforeEach(() => {
  fixture = replicaFixture('rbook-replica-');
  tmp = fixture.tmp;
  useMachine(tmp, 'air');
});
afterEach(() => fixture.restore());

/** One decision row written straight into the file, as another copy's merge would leave it. */
function seedDecision(root: string, id: number, text: string): void {
  const db = new Database(dbOf(root));
  try {
    db.prepare(
      "INSERT INTO strategic_decisions (id, decision_text, created_at) VALUES (?, ?, datetime('now'))"
    ).run(id, text);
  } finally {
    db.close();
  }
}

describe('an unshared store', () => {
  it('writes exactly as today: SQLite numbers its rows, and this machine binds nothing', async () => {
    const root = project(tmp, 'solo');
    const first = await record(root, 'Keep one JSON file per decision.');
    expect(first).toMatchObject({ success: true, data: { decisionId: 1 } });
    await withClient(root, (client) => {
      expect(
        client.transaction(() =>
          genesisColumns(client, 'strategic_decisions', PROJECT_ID).columns.includes('id')
        ).data
      ).toBe(false);
    });
    expect(ProjectGraphRegistry.getInstance().liveReplicas(PROJECT_ID)).toEqual([]);
  });

  it('copied to another machine, registers and writes there as a new project does today', async () => {
    const root = project(tmp, 'solo');
    expect((await record(root, 'Written on the Air.')).success).toBe(true);
    useMachine(tmp, 'studio');
    expect((await record(root, 'Written on the Studio.')).success).toBe(true);
  });
});

describe('a shared copy numbers its rows in its own block', () => {
  it('past a row another block wrote, which plain AUTOINCREMENT would have followed', async () => {
    const root = project(tmp, 'member');
    seedDecision(root, 2_000_005, 'from block 2');
    await share(root, 1);
    expect((await record(root, 'First in block 1.')).data?.decisionId).toBe(1_000_001);
    const afterFirst = seq(root);
    expect((await record(root, 'Second in block 1.')).data?.decisionId).toBe(1_000_002);
    // Each create of a shared row takes one sequence; the first call also opened its session.
    expect(seq(root)).toBe(afterFirst + 1);
  });

  it('opens its sessions with the block in their ids', async () => {
    const root = project(tmp, 'member');
    await share(root, 1);
    const started = await call('rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'A session on block 1',
      projectRoot: root,
    });
    expect(started.data?.sessionId).toMatch(/^PS-\d{4}-\d{2}-\d{2}-b1-001$/);
  });

  it('refuses a new row once its block is full, with its own code and remedy', async () => {
    const root = project(tmp, 'member');
    seedDecision(root, 2_000_000, 'the last id of block 1');
    await share(root, 1);
    const full = await record(root, 'One too many.');
    expect(full.success).toBe(false);
    // Not a failed query: retrying the record cannot help, and the answer must not say it can.
    expect(full.error?.code).toBe('REPLICA_BLOCK_FULL');
    expect(full.error?.message).toMatch(/block 1 \(1000001 to 2000000\) is full/);
    expect(full.error?.suggestion).toMatch(/re-identifies/);
  });

  it.each([
    ['learnings', { action: 'capture', category: 'learning', content: 'One learning too many.' }],
    [
      'constraints',
      { action: 'capture', category: 'constraint', content: 'One constraint too many.' },
    ],
  ])('says so for %s too, through the capture that writes them', async (table, args) => {
    const root = project(tmp, 'member');
    const db = new Database(dbOf(root));
    db.prepare(
      `INSERT INTO ${table} (id, content, created_at) VALUES (2000000, 'the last id of block 1', datetime('now'))`
    ).run();
    db.close();
    await share(root, 1);
    const full = await call('rbook_session', { ...args, projectRoot: root });
    expect(full.success).toBe(false);
    expect(full.error?.code).toBe('REPLICA_BLOCK_FULL');
  });

  it('says so for next steps, through the session close that writes them', async () => {
    const root = project(tmp, 'member');
    const db = new Database(dbOf(root));
    db.prepare(
      "INSERT INTO next_steps (id, content, created_at) VALUES (2000000, 'the last id of block 1', datetime('now'))"
    ).run();
    db.close();
    await share(root, 1);
    const started = await call('rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'Closing with a next step',
      projectRoot: root,
    });
    expect(started.success).toBe(true);
    const closed = await call('rbook_session', {
      action: 'complete',
      summary: 'Done.',
      nextSteps: ['One next step too many.'],
      projectRoot: root,
    });
    // A session close is best-effort for what it extracts: it closes, and discloses the refused
    // next step with its code.
    expect(closed.success).toBe(true);
    expect(closed.data?.writeFailures).toEqual([
      expect.objectContaining({ op: 'next_steps extraction insert', code: 'REPLICA_BLOCK_FULL' }),
    ]);
  });

  it('allocates only under BEGIN IMMEDIATE: a deferred transaction is refused too', async () => {
    const root = project(tmp, 'member');
    await share(root, 1);
    await withClient(root, (client) => {
      expect(() => genesisColumns(client, 'strategic_decisions', PROJECT_ID)).toThrow(
        /must run in a write transaction/
      );
      // Text IDs need no block allocation. Their log sequence is taken by the recording helper.
      expect(genesisColumns(client, 'missions', PROJECT_ID).columns).not.toContain('id');
      // A deferred transaction can lose its snapshot to another writer between read and write
      // (decision #1365); ADR s96 §3 numbers under the write lock taken at BEGIN.
      const deferred = client.transaction(() =>
        genesisColumns(client, 'strategic_decisions', PROJECT_ID)
      );
      expect(deferred.error?.message).toMatch(/must run in a write transaction/);
      expect(
        client.writeTransaction(
          () => genesisColumns(client, 'strategic_decisions', PROJECT_ID).columns
        ).data
      ).toContain('id');
    });
  });

  it('forgets the write lock when the client closes, so a reused client is not trusted', async () => {
    const root = project(tmp, 'reused');
    await share(root, 1);
    await withClient(root, (client) => {
      expect(client.execute('BEGIN IMMEDIATE').success).toBe(true);
      client.close();
      // The client reopens on its next statement; a deferred transaction must not number.
      const deferred = client.transaction(() =>
        genesisColumns(client, 'strategic_decisions', PROJECT_ID)
      );
      expect(deferred.error?.message).toMatch(/must run in a write transaction/);
    });
  });

  it('numbers creates inside a transaction its caller BEGINs IMMEDIATE itself', async () => {
    // Adding an open sprint demotes the others under a hand-written BEGIN IMMEDIATE.
    const root = project(tmp, 'member');
    await share(root, 1);
    const before = seq(root);
    const added = await call('rbook_sprint', {
      action: 'add',
      sprintId: 'sprint-b1',
      title: 'Opened on block 1',
      status: 'Active',
      projectRoot: root,
    });
    expect(added.success).toBe(true);
    expect(seq(root)).toBe(before + 1);
    // The mark follows that COMMIT, as it follows writeTransaction's.
    expect(mark()).toBe(seq(root));
  });
});

describe('a create takes its sequence only when it lands', () => {
  it('a failed insert rolls its sequence back, so the sequence has no gaps', async () => {
    const root = project(tmp, 'gapless');
    await share(root, 1);
    expect((await record(root, 'Counted.')).success).toBe(true);
    const before = seq(root);
    const db = new Database(dbOf(root));
    db.exec(
      "CREATE TRIGGER refuse_missions BEFORE INSERT ON missions BEGIN SELECT RAISE(ABORT, 'refused by the fixture'); END;"
    );
    db.close();
    const refused = await call('rbook_mission', {
      action: 'add',
      missionId: 's1-m99',
      name: 'Never lands',
      projectRoot: root,
    });
    expect(refused.success).toBe(false);
    expect(seq(root)).toBe(before);
    expect(mark()).toBe(before);
  });

  it('a mission dependency and a session link each take one', async () => {
    const root = project(tmp, 'links');
    await share(root, 1);
    for (const missionId of ['s1-m01', 's1-m02'])
      expect(
        (
          await call('rbook_mission', {
            action: 'add',
            missionId,
            name: missionId,
            projectRoot: root,
          })
        ).success
      ).toBe(true);
    const before = seq(root);
    expect(
      (
        await call('rbook_mission', {
          action: 'depends',
          fromId: 's1-m02',
          toId: 's1-m01',
          type: 'Requires',
          projectRoot: root,
        })
      ).success
    ).toBe(true);
    expect(seq(root)).toBe(before + 1);
    const linked = await call('rbook_session', {
      action: 'capture',
      category: 'context',
      content: 'Linked to a mission.',
      missionId: 's1-m01',
      projectRoot: root,
    });
    expect(linked.success).toBe(true);
    const db = new Database(dbOf(root), { readonly: true });
    const links = (db.prepare('SELECT count(*) AS n FROM session_missions').get() as { n: number })
      .n;
    const changes = db
      .prepare('SELECT entity, kind FROM record_changes WHERE replica_seq > ? ORDER BY replica_seq')
      .all(before) as Array<{ entity: string; kind: string }>;
    db.close();
    expect(links).toBe(1);
    // The session creation, appended context and both links are logged; the old identity-only
    // fixture counted only creates, missing the appended context's recorded sequence.
    expect(changes).toEqual([
      { entity: 'mission_dependencies', kind: 'link' },
      { entity: 'sessions', kind: 'create' },
      { entity: 'sessions', kind: 'append' },
      { entity: 'session_missions', kind: 'link' },
    ]);
    expect(seq(root)).toBe(before + changes.length);
  });
});

describe("this machine's mark follows the copy's commits", () => {
  it('moves up after a commit and stays put after a rollback', async () => {
    const root = project(tmp, 'marked');
    await share(root, 1);
    await record(root, 'Committed.');
    const committed = seq(root);
    expect(committed).toBeGreaterThan(0);
    expect(mark()).toBe(committed);
    await withClient(root, (client) =>
      client.writeTransaction(() => {
        genesisColumns(client, 'strategic_decisions', PROJECT_ID);
        throw new Error('rolled back');
      })
    );
    expect(seq(root)).toBe(committed);
    expect(mark()).toBe(committed);
  });

  it('is never left ahead of the file by a savepoint that rolled back inside a commit', async () => {
    const root = project(tmp, 'savepoint');
    await share(root, 1);
    await record(root, 'Committed.');
    const committed = seq(root);
    await withClient(root, (client) => {
      const outer = client.writeTransaction(() => {
        const inner = sharedStoreWrite(client, () => {
          genesisColumns(client, 'strategic_decisions', PROJECT_ID);
          return { success: false, error: { code: 'X', message: 'the insert failed' } };
        });
        expect(inner.success).toBe(false);
      });
      expect(outer.success).toBe(true);
    });
    expect(seq(root)).toBe(committed);
    // A mark past the file would refuse this healthy copy as restored at its next open.
    expect(mark()).toBe(committed);
    expect((await record(root, 'Still writes.')).success).toBe(true);
  });

  it('reads the identity again under the write lock, so a client outlives a re-identification', async () => {
    const root = project(tmp, 'long-lived');
    await share(root, 1);
    expect((await record(root, 'In block 1.')).data?.decisionId).toBe(1_000_001);
    await withClient(root, async (early) => {
      // Another process re-identifies the copy into block 5 while this client is open.
      await withClient(
        root,
        (other) => reidentifyReplica(other, { block: 5, authorityReceived: seq(root) }),
        { replicaCheck: false }
      );
      const written = recordedTransaction(early, () => {
        const g = genesisColumns(early, 'strategic_decisions', PROJECT_ID);
        const id = g.values[g.columns.indexOf('id')];
        const inserted = early.execute(
          `INSERT INTO strategic_decisions (decision_text, created_at, ${g.columns.join(', ')}) VALUES (?, datetime('now'), ${g.placeholders})`,
          ['After the re-identification.', ...g.values]
        );
        if (!inserted.success) throw new Error(inserted.error?.message);
        return id;
      });
      expect(written.data).toBe(5_000_001);
    });
  });
});

describe('re-identification reports what the old copy lost', () => {
  /** A copy whose folder is replaced by a backup taken after `synced`, with two later writes lost. */
  async function replacedFolder(): Promise<{ root: string; synced: number; last: number }> {
    const root = project(tmp, 'replaced');
    await share(root, 1);
    await record(root, 'Synced to the authority.');
    const synced = seq(root);
    const saved = path.join(tmp, 'backup.sqlite');
    backup(root, saved);
    await record(root, 'Never synced, one.');
    await record(root, 'Never synced, two.');
    const last = seq(root);
    dropSidecars(root);
    fs.rmSync(dbOf(root));
    fs.copyFileSync(saved, dbOf(root));
    return { root, synced, last };
  }

  it('counts the changes the authority never received, from the intact registry mark', async () => {
    const { root, synced, last } = await replacedFolder();
    // The authority's received sequence is supplied here; s96-m13's exchange supplies it for real.
    const report = await withClient(
      root,
      (client) => reidentifyReplica(client, { block: 2, authorityReceived: synced }),
      { replicaCheck: false }
    );
    expect(report.lost).toEqual({
      count: 2,
      first: synced + 1,
      last,
      summary: `2 changes (${synced + 1} to ${last}) never reached the authority and were lost; their content went with the folder.`,
    });
    // The fresh block writes again.
    expect((await record(root, 'After re-identifying.')).data?.decisionId).toBe(2_000_001);
  });

  it('reports zero when the authority already holds everything the copy wrote', async () => {
    const { root, last } = await replacedFolder();
    const report = await withClient(
      root,
      (client) => reidentifyReplica(client, { block: 2, authorityReceived: last }),
      { replicaCheck: false }
    );
    expect(report.lost.count).toBe(0);
  });

  it('says changes may be lost when this machine never held a mark for the copy', async () => {
    const root = project(tmp, 'unmarked');
    await share(root, 1);
    useMachine(tmp, 'studio');
    const report = await withClient(
      root,
      (client) => reidentifyReplica(client, { block: 2, authorityReceived: 5 }),
      { replicaCheck: false }
    );
    expect(report.lost).toEqual({
      count: null,
      summary: 'Changes this copy made after its last sync may be lost.',
    });
  });

  it('says changes may be lost when the authority holds more than the mark: the mark fell behind', () => {
    // Five seen here, nine at the authority: the copy wrote at least four this machine never
    // marked, so no count from the mark is true.
    expect(lostChanges(5, 9)).toEqual({
      count: null,
      summary: 'Changes this copy made after its last sync may be lost.',
    });
    expect(lostChanges(9, 9).count).toBe(0);
  });
});

describe('a registry named by option, with RBOOK_CONFIG_DIR unset', () => {
  it('binds the copy there, and the check finds it there', async () => {
    const root = project(tmp, 'explicit');
    const folder = path.join(tmp, 'explicit-config');
    delete process.env.RBOOK_CONFIG_DIR;
    ProjectGraphRegistry.resetInstance();
    // An explicit folder pins the graph, so a later call naming none keeps it (s95-m09).
    const registry = await ProjectGraphRegistry.create({ configDir: folder });
    await withClient(root, (client) => {
      prepareForSharing(client);
      // An explicit per-copy author keeps the ENV-unset fixture out of the user's config.
      expect(
        client.execute("INSERT INTO metadata (key, value) VALUES ('replica_author', 'Owner')")
          .success
      ).toBe(true);
      shareRecord(client, registry);
      moveReplicaBlock(client, 1);
    });
    expect(registry.liveReplicas(PROJECT_ID)).toHaveLength(1);
    expect(fs.existsSync(path.join(folder, 'project-graph.sqlite'))).toBe(true);
    expect((await record(root, 'Written with the setting unset.')).data?.decisionId).toBe(
      1_000_001
    );
  });
});
