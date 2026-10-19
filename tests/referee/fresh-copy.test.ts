// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 (design §R1) — a fresh copy of a shared record keeps what a copy needs to join and be guarded, and
// ABOUTME: nothing private; its source is read as data only, so an upload's own triggers and views never run.
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { writeUserAuthor } from '../../src/intelligence/user-author';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { requestJoin } from '../../src/tools/rbook/record-join';
import { isRecordedStore } from '../../src/tools/rbook/record-recording';
import { guardRefusal } from '../../src/tools/rbook/replica-check';
import {
  ensureAgentFeedbackTable,
  ensureVectorStorage,
} from '../../src/tools/rbook/schema-migrations';
import { PROPOSALS_TABLE_SQL } from '../../src/tools/rbook/proposals';
import { requiresPrivateEvidence } from '../helpers/public-mirror';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import { reidentifyRbookTestStore } from '../helpers/seedRbookDb';
import {
  joinedCopy,
  onCopy,
  ownerCopy,
  read,
  recordedState,
  shareExisting,
  syncCopies,
  type Copy,
} from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-fresh-');
});
afterEach(() => fixture.restore());

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

/** The owner's shared record with a sprint, a mission, decisions, a learning and a member's change. */
async function writtenRecord(): Promise<{ owner: Copy; member: Copy }> {
  const owner = await ownerCopy(fixture.tmp);
  await on(owner, 'rbook_sprint', {
    action: 'add',
    sprintId: 'f-sprint',
    title: 'One',
    status: 'Active',
  });
  await on(owner, 'rbook_mission', {
    action: 'add',
    missionId: 'f-m01',
    name: 'First',
    sprintId: 'f-sprint',
  });
  await on(owner, 'rbook_mission', {
    action: 'add',
    missionId: 'f-m02',
    name: 'Second',
    sprintId: 'f-sprint',
  });
  await on(owner, 'rbook_mission', {
    action: 'depends',
    fromId: 'f-m02',
    toId: 'f-m01',
    type: 'Requires',
  });
  await on(owner, 'rbook_decisions', { action: 'record', content: 'The owner decided this.' });
  await on(owner, 'rbook_session', {
    action: 'capture',
    category: 'learning',
    content: 'A lesson the owner kept.',
  });
  const member = await joinedCopy(fixture.tmp, owner, 'darryl');
  await on(member, 'rbook_decisions', { action: 'record', content: 'A member decided this.' });
  await syncCopies(fixture.tmp, member, owner);
  return { owner, member };
}

const LOG =
  'SELECT change_id, txn_id, replica_id, replica_seq, author_name, hlc, kind, entity, entity_id, field, value, base FROM record_changes ORDER BY rowid';
const STANDINGS = 'SELECT txn_id, replica_id, state, cause FROM record_txn_state ORDER BY txn_id';
const KEYS =
  "SELECT key, value FROM metadata WHERE key IN ('project_id', 'created_at', 'replica_id', 'replica_block', 'replica_seq', 'project_name') ORDER BY key";

function freshPlace(name: string): Copy {
  const root = path.join(fixture.tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  return { name, root, machine: `machine-${name}`, replicaId: '', block: -1 };
}

describe('a fresh copy of a shared record (s97-m09, design §R1)', () => {
  it('keeps the identity keys, the log, each standing and every recorded column, so a joiner and the guards treat it as a shared copy', async () => {
    const { owner } = await writtenRecord();
    const fresh = freshPlace('fresh');
    const built = await buildFreshCopy(dbOf(owner.root), dbOf(fresh.root));
    expect(built).toMatchObject({ projectId: 'p-shared', replicaId: owner.replicaId });
    expect(built.changes).toBe(
      read<{ n: number }>(owner, 'SELECT count(*) AS n FROM record_changes')[0].n
    );
    // Without these a store reads as unshared (fact 33): the joiner would refuse it as a live copy.
    expect(read(fresh, KEYS)).toEqual(read(owner, KEYS));
    expect(read(fresh, LOG)).toEqual(read(owner, LOG));
    expect(read(fresh, STANDINGS)).toEqual(read(owner, STANDINGS));
    expect(recordedState(fresh)).toEqual(recordedState(owner));
    // One self-contained file: nothing beside it to send or forget.
    expect(read(fresh, 'PRAGMA journal_mode')).toEqual([{ journal_mode: 'delete' }]);
    expect(fs.existsSync(`${dbOf(fresh.root)}-wal`)).toBe(false);
    useMachine(fixture.tmp, fresh.machine);
    writeUserAuthor('Newcomer');
    await onCopy(
      fixture.tmp,
      fresh,
      (client) => {
        expect(isRecordedStore(client)).toBe(true);
        expect(guardRefusal(client)).toBeNull();
        const asked = requestJoin(client);
        expect(asked.error).toBeUndefined();
        expect(asked.data).toMatchObject({ projectId: 'p-shared' });
      },
      { replicaCheck: false }
    );
  }, 120000);

  it('carries no feedback, session timeline, usage statistics, proposals, snapshots or search index', async () => {
    const { owner } = await writtenRecord();
    await on(owner, 'rbook_context', { action: 'snapshot', source: 'a private copy' });
    await onCopy(fixture.tmp, owner, (client) => {
      expect(ensureVectorStorage(client).warnings ?? []).toEqual([]);
      expect(ensureAgentFeedbackTable(client).warnings ?? []).toEqual([]);
    });
    const db = new Database(dbOf(owner.root));
    try {
      db.exec(PROPOSALS_TABLE_SQL);
      db.exec(`INSERT INTO proposals (text, created_at) VALUES ('a private draft', datetime('now'));
        INSERT INTO agent_feedback (tool_name, body, created_at) VALUES ('rbook_review', 'private friction', datetime('now'));
        INSERT INTO session_events (raw_event) VALUES ('{"private": true}');
        INSERT INTO telemetry_events (source_path, payload) VALUES ('x', '{"private": true}');
        UPDATE contexts SET content = '{"working_memory": "private"}' WHERE id = 'master_context';`);
    } finally {
      db.close();
    }
    const tables = (copy: Copy) =>
      new Set(
        read<{ name: string }>(copy, "SELECT name FROM sqlite_master WHERE type = 'table'").map(
          (t) => t.name
        )
      );
    expect([...tables(owner)]).toEqual(
      expect.arrayContaining(['decisions_fts', 'decisions_vec', 'proposals'])
    );
    const fresh = freshPlace('fresh');
    await buildFreshCopy(dbOf(owner.root), dbOf(fresh.root));
    const held = tables(fresh);
    for (const name of held) expect(name).not.toMatch(/_fts|_vec|^record_peers$/);
    for (const table of [
      'agent_feedback',
      'session_events',
      'telemetry_events',
      'context_snapshots',
      'sync_event_queue',
      'prompt_mappings',
      'proposals',
    ])
      expect({
        table,
        rows: held.has(table) ? read(fresh, `SELECT count(*) AS n FROM ${table}`)[0] : { n: 0 },
      }).toEqual({ table, rows: { n: 0 } });
    expect(
      read(
        fresh,
        "SELECT id, content FROM contexts WHERE id IN ('master_context', 'project_context') ORDER BY id"
      )
    ).toEqual([
      { id: 'master_context', content: '{}' },
      { id: 'project_context', content: '{}' },
    ]);
    expect(
      read(fresh, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%fts%'")
    ).toEqual([]);
  }, 120000);

  it("never runs the source's own triggers or views, and refuses a view or computed column where a table belongs", async () => {
    const { owner } = await writtenRecord();
    const upload = path.join(fixture.tmp, 'upload.sqlite');
    const make = (sql: string) => {
      fs.rmSync(upload, { force: true });
      const source = new Database(dbOf(owner.root));
      try {
        source.exec(`VACUUM INTO '${upload}'`);
      } finally {
        source.close();
      }
      const edited = new Database(upload);
      try {
        edited.exec(sql);
      } finally {
        edited.close();
      }
    };
    make(`CREATE TABLE canary (hit INTEGER);
      CREATE TRIGGER evil AFTER INSERT ON missions BEGIN INSERT INTO canary VALUES (1); END;
      CREATE TRIGGER evil_read AFTER UPDATE ON metadata BEGIN INSERT INTO canary VALUES (2); END;`);
    const before = fs.readFileSync(upload);
    const fresh = freshPlace('fresh');
    await buildFreshCopy(upload, dbOf(fresh.root));
    expect(fs.readFileSync(upload).equals(before)).toBe(true);
    expect(
      read(fresh, "SELECT name FROM sqlite_master WHERE name IN ('evil', 'evil_read', 'canary')")
    ).toEqual([]);
    expect(recordedState(fresh)).toEqual(recordedState(owner));

    const refusedWith = async (sql: string, pattern: RegExp) => {
      make(sql);
      const dest = freshPlace(`refused-${Math.random().toString(36).slice(2)}`);
      await expect(buildFreshCopy(upload, dbOf(dest.root))).rejects.toThrow(pattern);
      expect(fs.readdirSync(path.dirname(dbOf(dest.root)))).toEqual([]);
    };
    await refusedWith(
      'DROP TABLE next_steps; CREATE VIEW next_steps AS SELECT * FROM learnings;',
      /next_steps is a view/
    );
    // Every table is checked before any is read: a view that would overflow, or run for as long as
    // it likes, is refused for what it is before it runs (critics, round 1).
    const started = Date.now();
    await refusedWith(
      `DROP TABLE strategic_decisions;
       CREATE VIEW strategic_decisions AS
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n)
         SELECT abs(-9223372036854775807 - 1) AS context_id FROM n;`,
      /strategic_decisions is a view/
    );
    expect(Date.now() - started).toBeLessThan(5000);
    await refusedWith(
      'ALTER TABLE missions ADD COLUMN evil AS (abs(1))',
      /missions has computed columns/
    );
  }, 120000);

  it('refuses a store that is no shared record, and a change log that is not whole, building nothing', async () => {
    const { owner } = await writtenRecord();
    const unshared = path.join(fixture.tmp, 'unshared.sqlite');
    const solo = new Database(dbOf(owner.root));
    try {
      solo.exec(`VACUUM INTO '${unshared}'`);
    } finally {
      solo.close();
    }
    const plain = new Database(unshared);
    try {
      plain.exec("DELETE FROM metadata WHERE key IN ('replica_id', 'replica_block')");
    } finally {
      plain.close();
    }
    const dest = freshPlace('dest');
    await expect(buildFreshCopy(unshared, dbOf(dest.root))).rejects.toThrow(/holds no replica_id/);
    const broken = path.join(fixture.tmp, 'broken.sqlite');
    const whole = new Database(dbOf(owner.root));
    try {
      whole.exec(`VACUUM INTO '${broken}'`);
    } finally {
      whole.close();
    }
    const damaged = new Database(broken);
    try {
      damaged.exec(
        "UPDATE record_changes SET value = '{not json' WHERE kind = 'create' AND rowid = (SELECT max(rowid) FROM record_changes WHERE kind = 'create')"
      );
    } finally {
      damaged.close();
    }
    // As an upload, every change is checked before anything is built.
    await expect(buildFreshCopy(broken, dbOf(dest.root), { untrusted: true })).rejects.toThrow(
      /value is not JSON/
    );
    expect(fs.readdirSync(path.dirname(dbOf(dest.root)))).toEqual([]);
  }, 120000);
});

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The real-store fire builds a fresh copy of this repository's own store, shared, at the 4.1.0 release, taken from its git history; the public mirror carries neither.",
  revisions: { release: 'v4.1.0' },
});

PRIVATE.describe("this repository's own store (practice 4's real-store fire)", () => {
  it('shared at v4.1.0, its fresh copy holds every recorded value of every baseline row, the log and the identity', async () => {
    const root = path.join(fixture.tmp, 'cmos-mcp-pro');
    fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
    fs.writeFileSync(
      dbOf(root),
      execFileSync('git', ['show', `${PRIVATE.revisions.release}:rbook/db/rbook.sqlite`], {
        cwd: path.resolve(__dirname, '..', '..'),
        maxBuffer: 256 * 1024 * 1024,
      })
    );
    reidentifyRbookTestStore(root, 'test-real-referee');
    const owner = await shareExisting(fixture.tmp, root, 'cmos-mcp-pro', 'Owner');
    const fresh = freshPlace('fresh');
    const started = Date.now();
    const built = await buildFreshCopy(dbOf(owner.root), dbOf(fresh.root));
    const took = Date.now() - started;
    process.stdout.write(
      `[s97-m09] fresh copy of the v4.1.0 store: ${JSON.stringify(built)} in ${took} ms\n`
    );
    expect(built.rows.strategic_decisions).toBeGreaterThan(1000);
    expect(read(fresh, KEYS)).toEqual(read(owner, KEYS));
    expect(read(fresh, LOG)).toEqual(read(owner, LOG));
    expect(read(fresh, STANDINGS)).toEqual(read(owner, STANDINGS));
    expect(recordedState(fresh)).toEqual(recordedState(owner));
    expect(fs.statSync(dbOf(fresh.root)).size).toBeLessThan(fs.statSync(dbOf(owner.root)).size);
  }, 600000);
});
