// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m01 (ADR s96 §2) — before a store is shared its schema is current, every shared table exists,
// ABOUTME: and stable ids are present and unique, enforced by unique indexes; a store that fails is refused.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { establishReplica } from '../../../src/tools/rbook/replica-identity';
import { shareBlocker } from '../../../src/tools/rbook/record-share';
import { prepareForSharing } from '../../../src/tools/rbook/sharing-preconditions';
import { FIREHOSE_TABLES } from '../../../src/types/event-types';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The real-store fire prepares this repository's own store, taken from its git history; the public mirror carries neither.",
  revisions: { release: 'v4.0.2' },
});
const REPO = path.resolve(__dirname, '..', '..', '..');

let tmp: string;
let root: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-sharing-'));
  root = path.join(tmp, 'project');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dbOf = (projectRoot: string) => path.join(projectRoot, 'rbook', 'db', 'rbook.sqlite');

async function prepared(projectRoot = root) {
  const client = (await RbookDatabaseClient.create({ dbPath: dbOf(projectRoot) })).data!;
  try {
    return prepareForSharing(client);
  } finally {
    client.close();
  }
}

function columns(table: string): string[] {
  const db = new Database(dbOf(root), { readonly: true });
  try {
    return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map(
      (column) => column.name
    );
  } finally {
    db.close();
  }
}

describe('a store made ready to share', () => {
  it('gets the unique stable-id index on each of the eight logged tables', async () => {
    seedRbookDb(root, { projectId: 'p-share' });
    const readiness = await prepared();
    expect(readiness).toMatchObject({ ready: true, problems: [], tablesCreated: [] });
    expect(readiness.indexesCreated).toHaveLength(FIREHOSE_TABLES.length);
    const db = new Database(dbOf(root));
    try {
      const insert = () =>
        db
          .prepare(
            "INSERT INTO learnings (content, created_at, project_id, stable_event_id, occurred_at, origin_seq, event_type) VALUES ('x', datetime('now'), 'p-share', 'same-id', 1, 1, 'learning_captured')"
          )
          .run();
      insert();
      expect(insert).toThrow(/UNIQUE constraint failed: learnings.stable_event_id/);
    } finally {
      db.close();
    }
    // A second preparation finds the indexes already there.
    expect((await prepared()).indexesCreated).toEqual([]);
  });

  it('makes a missing shared table, as Synthesis Workbench lacks constraints and derekn.com session_missions', async () => {
    seedRbookDb(root, { projectId: 'p-share' });
    const db = new Database(dbOf(root));
    db.exec('DROP TABLE constraints; DROP TABLE session_missions;');
    db.close();
    const readiness = await prepared();
    expect(readiness.ready).toBe(true);
    expect([...readiness.tablesCreated].sort()).toEqual(['constraints', 'session_missions']);
    // Made as new stores make it, with the genesis columns a write stamps.
    expect(columns('constraints')).toEqual(
      expect.arrayContaining(['project_id', 'stable_event_id', 'occurred_at', 'origin_seq'])
    );
  });

  it('refuses duplicate stable ids, and counts them, before any index exists', async () => {
    seedRbookDb(root, { projectId: 'p-share' });
    // Migrate first, so the duplicates sit in a store already at its current shape.
    expect((await prepared()).ready).toBe(true);
    const db = new Database(dbOf(root));
    db.exec('DROP INDEX idx_strategic_decisions_stable_event_id_unique;');
    db.prepare(
      "INSERT INTO strategic_decisions (decision_text, created_at, project_id, stable_event_id, occurred_at, origin_seq, event_type) VALUES ('a', datetime('now'), 'p-share', 'twice', 1, 90, 'decision_captured')"
    ).run();
    db.prepare(
      "INSERT INTO strategic_decisions (decision_text, created_at, project_id, stable_event_id, occurred_at, origin_seq, event_type) VALUES ('b', datetime('now'), 'p-share', 'twice', 1, 91, 'decision_captured')"
    ).run();
    db.close();
    const readiness = await prepared();
    expect(readiness.ready).toBe(false);
    expect(readiness.problems).toContain('strategic_decisions: 1 duplicate stable id.');
    expect(readiness.indexesCreated).toEqual([]);
  });

  it('migrates a table made after the firehose marker was set, as four fleet stores hold', async () => {
    // Writing-and-Strategy, Aquex Mcp and derekn.com made constraints, and Synthesis Workbench
    // next_steps, after their firehose migration ran, so the tables lack its columns
    // (rbook/research/2026-10-s96-probes/fleet-schema/README.md).
    seedRbookDb(root, { projectId: 'p-share' });
    expect((await prepared()).ready).toBe(true);
    const db = new Database(dbOf(root));
    db.exec(`DROP TABLE constraints;
      CREATE TABLE constraints (
        id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, expires_at TEXT, archived_at TEXT, content_hash TEXT);
      INSERT INTO constraints (content, created_at) VALUES ('made before the columns', '2026-01-02T03:04:05Z');`);
    db.close();
    expect(columns('constraints')).not.toContain('stable_event_id');
    const readiness = await prepared();
    expect({ ready: readiness.ready, problems: readiness.problems }).toEqual({
      ready: true,
      problems: [],
    });
    expect(columns('constraints')).toEqual(
      expect.arrayContaining([
        'stable_event_id',
        'occurred_at',
        'origin_seq',
        'author_user_id',
        'author_name',
      ])
    );
    // The migration gave the old row its stable id; this copy is the only one being shared.
    const after = new Database(dbOf(root), { readonly: true });
    const row = after.prepare('SELECT stable_event_id FROM constraints').get() as {
      stable_event_id: string | null;
    };
    after.close();
    expect(row.stable_event_id).toMatch(/^[0-9A-Z]{26}$/);
    expect(readiness.indexesCreated).toContain('idx_constraints_stable_event_id_unique');
  });

  it('requires author_name on every logged table before a copy takes its identity', async () => {
    // s96-m02: a create on a shared store runs the lazy author_name migration under the write lock,
    // so sharing makes it current first, on every table, and a copy refuses an identity without it.
    seedRbookDb(root, { projectId: 'p-share' });
    expect((await prepared()).ready).toBe(true);
    const db = new Database(dbOf(root));
    db.exec('ALTER TABLE constraints DROP COLUMN author_name');
    db.close();
    const client = (await RbookDatabaseClient.create({ dbPath: dbOf(root), replicaCheck: false }))
      .data!;
    try {
      expect(() => establishReplica(client, { block: 0 })).toThrow(
        /not ready to share: the author name column is not on every logged table/
      );
      expect(prepareForSharing(client).ready).toBe(true);
      expect(columns('constraints')).toContain('author_name');
      expect(establishReplica(client, { block: 0 }).block).toBe(0);
    } finally {
      client.close();
    }
  });

  it('refuses a row with no stable id where the column was left nullable', async () => {
    seedRbookDb(root, { projectId: 'p-share' });
    expect((await prepared()).ready).toBe(true);
    const db = new Database(dbOf(root));
    // event_type is NOT NULL, so the migration counts the table as done; stable_event_id is not.
    db.exec(`DROP TABLE constraints;
      CREATE TABLE constraints (
        id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', session_id TEXT, sprint_id TEXT,
        created_at TEXT NOT NULL, expires_at TEXT, archived_at TEXT, content_hash TEXT,
        project_id TEXT NOT NULL, stable_event_id TEXT, occurred_at INTEGER NOT NULL,
        origin_seq INTEGER NOT NULL, event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1, author_user_id TEXT);
      INSERT INTO constraints (content, created_at, project_id, occurred_at, origin_seq, event_type)
        VALUES ('no id', datetime('now'), 'p-share', 1, 1, 'constraint_added');`);
    db.close();
    const readiness = await prepared();
    expect(readiness.ready).toBe(false);
    expect(readiness.problems).toContain('constraints: 1 row has no stable id.');
    expect(readiness.indexesCreated).toEqual([]);
  });

  it('refuses an index of its name that is not unique on the stable id', async () => {
    seedRbookDb(root, { projectId: 'p-share' });
    const db = new Database(dbOf(root));
    db.exec('CREATE INDEX idx_learnings_stable_event_id_unique ON learnings (stable_event_id);');
    db.close();
    const readiness = await prepared();
    expect(readiness.ready).toBe(false);
    expect(readiness.problems).toContain(
      'learnings: an index named idx_learnings_stable_event_id_unique exists but is not unique on stable_event_id.'
    );
  });

  it('gives a table it makes the base schema indexes too', async () => {
    seedRbookDb(root, { projectId: 'p-share' });
    const db = new Database(dbOf(root));
    db.exec('DROP TABLE constraints;');
    db.close();
    expect((await prepared()).tablesCreated).toEqual(['constraints']);
    const after = new Database(dbOf(root), { readonly: true });
    const indexes = (
      after.prepare("PRAGMA index_list('constraints')").all() as Array<{ name: string }>
    ).map((index) => index.name);
    after.close();
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_constraints_status', 'idx_constraints_stable_event_id_unique'])
    );
  });
});

describe('a store from before a recorded column existed (s96-m14)', () => {
  // The import's real-copy run found four real stores the share step refused for decisions'
  // source_chunk_ids, which only the base schema holds: no migration adds it (the build note's class).
  it('takes every recorded column the base schema holds, with its default, so the share step finds none missing', async () => {
    fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
    const db = new Database(dbOf(root));
    try {
      db.exec(
        fs.readFileSync(
          path.join(__dirname, '..', '..', 'fixtures', 'old-schemas', 'schema-2025-12.sql'),
          'utf8'
        )
      );
      db.exec("INSERT INTO metadata (key, value) VALUES ('project_id', 'p-old')");
      db.exec(
        "INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'context.json', '{}'), ('project_identity', 'identity.json', '{\"project_name\":\"old\"}')"
      );
      db.exec(
        "INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Decided in 2025.', '2025-12-01T00:00:00Z')"
      );
    } finally {
      db.close();
    }
    const readiness = await prepared();
    expect(readiness.ready).toBe(true);
    expect(readiness.columnsAdded).toEqual(
      expect.arrayContaining(['strategic_decisions.source_chunk_ids', 'strategic_decisions.status'])
    );
    const client = (await RbookDatabaseClient.create({ dbPath: dbOf(root) })).data!;
    try {
      expect(shareBlocker(client)).toMatch(/author name/);
    } finally {
      client.close();
    }
    // A column added with the base schema's default takes it on every row it gives one.
    const after = new Database(dbOf(root), { readonly: true });
    try {
      expect(after.prepare('SELECT status FROM strategic_decisions').all()).toEqual([
        { status: 'active' },
      ]);
      // It keeps the base schema's NOT NULL too, so a later write cannot leave the column empty.
      expect(
        after
          .prepare(
            "SELECT type, \"notnull\" AS required, dflt_value FROM pragma_table_info('strategic_decisions') WHERE name = 'status'"
          )
          .get()
      ).toEqual({ type: 'TEXT', required: 1, dflt_value: "'active'" });
    } finally {
      after.close();
    }
  });
});

describe('project init', () => {
  it('stamps its first sprint and missions with genesis columns', async () => {
    fs.mkdirSync(root, { recursive: true });
    const init = await rbookProjectInit({
      projectRoot: root,
      projectType: 'build',
      initialSprint: { id: 'sprint-1', title: 'First' },
      initialMissions: [{ id: 's1-m01', name: 'First mission' }],
    });
    expect(init.success).toBe(true);
    reidentifyRbookTestStore(root);
    const db = new Database(dbOf(root), { readonly: true });
    try {
      for (const table of ['sprints', 'missions']) {
        const unstamped = db
          .prepare(
            `SELECT count(*) AS n FROM ${table} WHERE stable_event_id IS NULL OR project_id IS NULL OR event_type IS NULL OR occurred_at IS NULL`
          )
          .get() as { n: number };
        expect({ table, unstamped: unstamped.n }).toEqual({ table, unstamped: 0 });
      }
    } finally {
      db.close();
    }
    expect((await prepared()).ready).toBe(true);
  });
});

PRIVATE.describe("this repository's own store at v4.0.2", () => {
  it('is ready to share: no duplicate or missing stable ids in a loose store', async () => {
    const db = dbOf(root);
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(
      db,
      execFileSync('git', ['show', `${PRIVATE.revisions.release}:rbook/db/rbook.sqlite`], {
        cwd: REPO,
        maxBuffer: 256 * 1024 * 1024,
      })
    );
    reidentifyRbookTestStore(root);
    const readiness = await prepared();
    expect({ ready: readiness.ready, problems: readiness.problems }).toEqual({
      ready: true,
      problems: [],
    });
    expect(readiness.indexesCreated).toHaveLength(FIREHOSE_TABLES.length);
  }, 60000);
});
