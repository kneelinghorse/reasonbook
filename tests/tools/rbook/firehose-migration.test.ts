/**
 * Sprint 69 m03 — combined firehose per-row schema migration tests.
 *
 * Covers ensureFirehoseEventColumns against: a populated LEGACY store (no genesis
 * columns) including the strategic_decisions self-FK + decisions_fts/learnings_fts
 * (exercising legacy_alter_table + both FTS rebuilds), a GREENFIELD store (fresh
 * RBOOK_SCHEMA carries the columns NULLABLE → migration upgrades to NOT NULL),
 * idempotent + partial-recovery re-runs, CHECK/NOT NULL enforcement, the composite
 * index, and genesisColumns end-to-end (stamp + insert + origin_seq increment).
 *
 * @module tests/tools/rbook/firehose-migration
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import {
  ensureFirehoseEventColumns,
  SchemaMigrationError,
} from '../../../src/tools/rbook/schema-migrations';
import { genesisColumns, getProjectId } from '../../../src/tools/rbook/genesis-columns';
import { FIREHOSE_TABLES, GENESIS_TYPE_BY_TABLE } from '../../../src/types/event-types';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';

describe('ensureFirehoseEventColumns (Sprint 69 m03)', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firehose-mig-test-'));
    const dbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    dbPath = path.join(dbDir, 'rbook.sqlite');
    RbookDetector.resetInstance();
  });

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Build a populated v2.3-style LEGACY store: the 8 firehose tables WITHOUT the
   * genesis columns, the strategic_decisions self-FK + decisions_fts/learnings_fts,
   * metadata.project_id, and a few rows per table with valid created_at.
   */
  function createLegacyDb(): void {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO metadata (key, value) VALUES ('project_id', 'legacy-proj'), ('schema_version', '2.3');

      CREATE TABLE contexts (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT);
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'ctx', '{}');

      CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER);
      CREATE TABLE missions (id TEXT PRIMARY KEY, sprint_id TEXT REFERENCES sprints(id) ON DELETE SET NULL, name TEXT NOT NULL, status TEXT NOT NULL, completed_at TEXT, created_at TEXT, started_at TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT, started_at TEXT NOT NULL, completed_at TEXT, status TEXT NOT NULL DEFAULT 'active');
      CREATE TABLE context_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL, session_id TEXT, source TEXT, content_hash TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY (context_id) REFERENCES contexts(id) ON DELETE CASCADE);
      CREATE TABLE next_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', session_id TEXT, sprint_id TEXT, created_at TEXT NOT NULL, content_hash TEXT);
      CREATE TABLE constraints (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', session_id TEXT, sprint_id TEXT, created_at TEXT NOT NULL, content_hash TEXT);

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        superseded_by INTEGER,
        FOREIGN KEY (superseded_by) REFERENCES strategic_decisions(id) ON DELETE SET NULL
      );
      CREATE INDEX idx_sd_status ON strategic_decisions (status);
      CREATE VIRTUAL TABLE decisions_fts USING fts5(decision_text, content='strategic_decisions', content_rowid='id');
      CREATE TRIGGER decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
        INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
      END;

      CREATE TABLE learnings (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT, created_at TEXT NOT NULL);
      CREATE VIRTUAL TABLE learnings_fts USING fts5(content, content='learnings', content_rowid='id');
      CREATE TRIGGER learnings_fts_insert AFTER INSERT ON learnings BEGIN
        INSERT INTO learnings_fts(rowid, content) VALUES (new.id, new.content);
      END;

      INSERT INTO sprints (id, title, status, start_date) VALUES ('s1', 'Sprint One', 'Completed', '2024-01-01');
      INSERT INTO missions (id, sprint_id, name, status, created_at) VALUES ('s1-m01', 's1', 'Do thing', 'Completed', '2024-01-02');
      INSERT INTO sessions (id, type, title, started_at) VALUES ('sess1', 'build', 'Build session', '2024-01-03');
      INSERT INTO strategic_decisions (decision_text, created_at) VALUES ('Adopt TypeScript everywhere', '2024-01-04'), ('SQLite is the source of truth', '2024-01-05');
      UPDATE strategic_decisions SET superseded_by = 1 WHERE id = 2;
      INSERT INTO learnings (content, category, created_at) VALUES ('FTS triggers must survive rebuilds', 'technical', '2024-01-06');
      INSERT INTO context_snapshots (context_id, content_hash, content, created_at) VALUES ('master_context', 'h1', '{}', '2024-01-07');
      INSERT INTO next_steps (content, created_at) VALUES ('Wire the thing', '2024-01-08');
      INSERT INTO constraints (content, created_at) VALUES ('Must support PG 14+', '2024-01-09');

      INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild');
      INSERT INTO learnings_fts(learnings_fts) VALUES('rebuild');
    `);
    db.close();
  }

  async function getClient(): Promise<RbookDatabaseClient> {
    const result = await RbookDatabaseClient.create({ dbPath });
    if (!result.success || !result.data) throw new Error(`client: ${result.error?.message}`);
    return result.data;
  }

  it('migrates a populated LEGACY store: adds 6 cols + index, backfills, enforces NOT NULL+CHECK', async () => {
    createLegacyDb();
    const client = await getClient();
    try {
      const result = ensureFirehoseEventColumns(client);
      expect(result.columnsAdded.length).toBe(48); // 6 per table × 8 tables
      expect(result.indexesCreated.length).toBe(8);

      for (const table of FIREHOSE_TABLES) {
        const cols = client.getMany<{ name: string; notnull: number }>(
          `PRAGMA table_info('${table}')`,
          []
        ).data!;
        const et = cols.find((c) => c.name === 'event_type');
        expect(et?.notnull).toBe(1); // upgraded to NOT NULL
        expect(cols.some((c) => c.name === 'project_id')).toBe(true);
        // composite index present
        const idx = client.getOne(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_${table}_aggkey'`,
          []
        );
        expect(idx.data).toBeDefined();
      }

      // Backfill values on strategic_decisions: project_id from metadata, event_type
      // = genesis verb, occurred_at from created_at (ms), origin_seq = rowid, ULID set.
      const row = client.getOne<{
        project_id: string;
        event_type: string;
        occurred_at: number;
        origin_seq: number;
        stable_event_id: string;
      }>(
        'SELECT project_id, event_type, occurred_at, origin_seq, stable_event_id FROM strategic_decisions WHERE id = 1',
        []
      ).data!;
      expect(row.project_id).toBe('legacy-proj');
      expect(row.event_type).toBe('decision_captured');
      expect(row.occurred_at).toBe(Date.UTC(2024, 0, 4)); // '2024-01-04' → ms
      expect(row.origin_seq).toBe(1);
      expect(row.stable_event_id).toHaveLength(26);
      expect(GENESIS_TYPE_BY_TABLE.strategic_decisions).toBe('decision_captured');

      // CHECK + NOT NULL enforced on new inserts.
      const badVerb = client.execute(
        "INSERT INTO learnings (content, created_at, project_id, stable_event_id, occurred_at, origin_seq, event_type) VALUES ('x','2024-02-01','p','01J',1,9,'mission_added')",
        []
      );
      expect(badVerb.success).toBe(false);
      const missingVerb = client.execute(
        "INSERT INTO learnings (content, created_at) VALUES ('y','2024-02-02')",
        []
      );
      expect(missingVerb.success).toBe(false);
    } finally {
      client.close();
    }
  });

  it('preserves BOTH decisions_fts AND learnings_fts through the legacy migration', async () => {
    createLegacyDb();
    const client = await getClient();
    try {
      ensureFirehoseEventColumns(client);
      const dHit = client.getMany(
        "SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'TypeScript'",
        []
      );
      expect(dHit.data).toHaveLength(1);
      const lHit = client.getMany(
        "SELECT rowid FROM learnings_fts WHERE learnings_fts MATCH 'rebuilds'",
        []
      );
      expect(lHit.data).toHaveLength(1);
      // The self-FK on strategic_decisions survives the rebuild.
      const fk = client.getMany<{ table: string }>(
        'PRAGMA foreign_key_list(strategic_decisions)',
        []
      );
      expect(fk.data!.some((f) => f.table === 'strategic_decisions')).toBe(true);
    } finally {
      client.close();
    }
  });

  it('upgrades a GREENFIELD store (fresh nullable columns) to NOT NULL', async () => {
    // seedRbookDb uses RBOOK_SCHEMA, which now carries the genesis columns NULLABLE.
    const project = await createSeededRbookProject({ projectName: 'green' }, 'firehose-green-');
    try {
      const client = (await RbookDatabaseClient.create({ dbPath: project.dbPath })).data!;
      try {
        // Pre-migration: event_type exists but is NULLABLE.
        const before = client
          .getMany<{ name: string; notnull: number }>("PRAGMA table_info('missions')", [])
          .data!.find((c) => c.name === 'event_type');
        expect(before?.notnull).toBe(0);

        const result = ensureFirehoseEventColumns(client);
        expect(result.alreadyCurrent).toBe(false);

        const after = client
          .getMany<{ name: string; notnull: number }>("PRAGMA table_info('missions')", [])
          .data!.find((c) => c.name === 'event_type');
        expect(after?.notnull).toBe(1);
      } finally {
        client.close();
      }
    } finally {
      await project.cleanup();
    }
  });

  it('is idempotent (marker fast-path) and recovers from a partial migration', async () => {
    createLegacyDb();
    const client = await getClient();
    try {
      const first = ensureFirehoseEventColumns(client);
      expect(first.alreadyCurrent).toBe(false);
      const second = ensureFirehoseEventColumns(client);
      expect(second.alreadyCurrent).toBe(true);
      expect(second.columnsAdded).toEqual([]);

      // Simulate a partial migration: clear the completion marker. The next run
      // must re-scan, find every table already NOT NULL, (re)ensure indexes, and
      // re-set the marker without corrupting anything.
      client.execute("DELETE FROM metadata WHERE key='firehose_event_columns'", []);
      const third = ensureFirehoseEventColumns(client);
      expect(third.alreadyCurrent).toBe(true); // all tables already migrated
      const marker = client.getOne<{ value: string }>(
        "SELECT value FROM metadata WHERE key='firehose_event_columns'",
        []
      );
      expect(marker.data?.value).toBe('2.4'); // FIREHOSE_SCHEMA_VERSION
    } finally {
      client.close();
    }
  });

  describe('genesisColumns', () => {
    it('stamps all 6 columns and inserts cleanly after migration', async () => {
      createLegacyDb();
      const client = await getClient();
      try {
        ensureFirehoseEventColumns(client); // migration runs at connection in prod; explicit here
        const projectId = getProjectId(client);
        expect(projectId).toBe('legacy-proj');

        const now = Date.UTC(2026, 0, 1);
        const g = genesisColumns(client, 'sprints', projectId, now);
        // The six genesis columns, then s96-m02's author columns (ADR s96 §10), which a write
        // stamps where its table has them.
        expect(g.columns).toEqual([
          'project_id',
          'stable_event_id',
          'occurred_at',
          'origin_seq',
          'event_type',
          'schema_version',
          'author_name',
          'author_user_id',
        ]);
        const ins = client.execute(
          `INSERT INTO sprints (id, title, ${g.columns.join(', ')}) VALUES (?, ?, ${g.placeholders})`,
          ['s2', 'Sprint Two', ...g.values]
        );
        expect(ins.success).toBe(true);

        const row = client.getOne<{
          project_id: string;
          event_type: string;
          occurred_at: number;
          schema_version: number;
        }>(
          "SELECT project_id, event_type, occurred_at, schema_version FROM sprints WHERE id='s2'",
          []
        ).data!;
        expect(row.project_id).toBe('legacy-proj');
        expect(row.event_type).toBe('sprint_added');
        expect(row.occurred_at).toBe(now);
        expect(row.schema_version).toBe(1);
      } finally {
        client.close();
      }
    });

    it('increments origin_seq per table across successive stamps', async () => {
      createLegacyDb();
      const client = await getClient();
      try {
        ensureFirehoseEventColumns(client);
        const projectId = getProjectId(client);
        // Legacy sprints had 1 row (origin_seq=1). Two new stamps → 2, then 3.
        const g1 = genesisColumns(client, 'sprints', projectId, Date.UTC(2026, 0, 1));
        client.execute(
          `INSERT INTO sprints (id, title, ${g1.columns.join(', ')}) VALUES (?, ?, ${g1.placeholders})`,
          ['sa', 'A', ...g1.values]
        );
        const g2 = genesisColumns(client, 'sprints', projectId, Date.UTC(2026, 0, 2));
        client.execute(
          `INSERT INTO sprints (id, title, ${g2.columns.join(', ')}) VALUES (?, ?, ${g2.placeholders})`,
          ['sb', 'B', ...g2.values]
        );
        const seqs = client.getMany<{ origin_seq: number }>(
          'SELECT origin_seq FROM sprints ORDER BY origin_seq',
          []
        ).data!;
        expect(seqs.map((s) => s.origin_seq)).toEqual([1, 2, 3]);
      } finally {
        client.close();
      }
    });

    it('getProjectId falls back (not throw) when project_id is missing, preferring slug then name', async () => {
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO metadata VALUES ('schema_version','2.3'), ('project_name','My Proj');"
      );
      db.close();
      const client = await getClient();
      try {
        // No project_id / slug → falls back to project_name.
        expect(getProjectId(client)).toBe('My Proj');
      } finally {
        client.close();
      }
    });

    it('getProjectId falls back to "unknown-project" when no identifier is available', async () => {
      const db = new Database(dbPath);
      db.exec(
        "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO metadata VALUES ('schema_version','2.3');"
      );
      db.close();
      const client = await getClient();
      try {
        expect(getProjectId(client)).toBe('unknown-project');
      } finally {
        client.close();
      }
    });

    it('backfills a fallback project_id when metadata has no project identity', async () => {
      // A legacy store with firehose rows but NO metadata.project_id: the migration
      // must not fail — it backfills the fallback ('unknown-project') so the NOT NULL
      // column holds a non-empty id (real stores always carry a real project_id).
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO metadata VALUES ('schema_version', '2.3');
        CREATE TABLE sprints (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT, start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER, focus TEXT);
        INSERT INTO sprints (id, title, start_date) VALUES ('s1', 'One', '2024-01-01');
      `);
      db.close();
      const client = await getClient();
      try {
        expect(() => ensureFirehoseEventColumns(client)).not.toThrow();
        const row = client.getOne<{ project_id: string }>(
          "SELECT project_id FROM sprints WHERE id='s1'",
          []
        );
        expect(row.data?.project_id).toBe('unknown-project');
      } finally {
        client.close();
      }
    });
  });
});
