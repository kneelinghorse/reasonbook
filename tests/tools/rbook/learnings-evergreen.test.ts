// ABOUTME: Sprint 61 m03 — evergreen flag for institutional learnings.
// ABOUTME: Verifies lazy migration on read paths, staleness exclusion, two-way toggle, and FTS5 trigger preservation.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import {
  readStaleness,
  DEFAULT_STALENESS_THRESHOLD,
} from '../../../src/tools/rbook/staleness-detection';
import {
  ensureLearningsTable,
  ensureDecisionsFts5,
} from '../../../src/tools/rbook/schema-migrations';
import { rbookLearningsList } from '../../../src/tools/rbook/rbook-learnings-list';
import { rbookLearningsUpdate } from '../../../src/tools/rbook/rbook-learnings-update';

/**
 * Make a temp DB WITHOUT the evergreen column on the learnings table — simulates
 * a pre-Sprint 61 m03 schema. Read paths must self-heal via ensureLearningsTable.
 */
function makeUnmigratedDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-evergreen-test-'));
  const rbookDbDir = path.join(tempDir, 'rbook', 'db');
  fs.mkdirSync(rbookDbDir, { recursive: true });
  const dbPath = path.join(rbookDbDir, 'rbook.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT,
      end_date TEXT
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      sprint_id TEXT,
      session_id TEXT,
      mission_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sprint_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );

    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.close();
  return { tempDir, dbPath };
}

async function openClient(dbPath: string): Promise<RbookDatabaseClient> {
  const r = await RbookDatabaseClient.create({ dbPath });
  if (!r.success || !r.data) throw new Error('open failed');
  return r.data;
}

function cleanup(tempDir: string, client?: RbookDatabaseClient): void {
  if (client) client.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function hasColumn(dbPath: string, table: string, column: string): boolean {
  const db = new Database(dbPath);
  try {
    const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    return cols.some((c) => c.name === column);
  } finally {
    db.close();
  }
}

function readEvergreen(dbPath: string, learningId: number): number | null {
  const db = new Database(dbPath);
  try {
    const row = db.prepare(`SELECT evergreen FROM learnings WHERE id = ?`).get(learningId) as
      | { evergreen: number | null }
      | undefined;
    return row?.evergreen ?? null;
  } finally {
    db.close();
  }
}

describe('ensureLearningsTable — evergreen lazy migration', () => {
  it('adds the evergreen column to a pre-existing learnings table (idempotent)', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    const client = await openClient(dbPath);
    try {
      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(false);

      const first = ensureLearningsTable(client);
      expect(first.columnsAdded).toContain('learnings.evergreen');
      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(true);

      // Re-running is a no-op — column already there.
      const second = ensureLearningsTable(client);
      expect(second.columnsAdded).not.toContain('learnings.evergreen');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('creates the table with evergreen included on a fresh DB', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-evergreen-fresh-'));
    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    const dbPath = path.join(rbookDbDir, 'rbook.sqlite');

    const db = new Database(dbPath);
    db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    db.close();

    const client = await openClient(dbPath);
    try {
      ensureLearningsTable(client);
      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(true);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('rbook_learnings(action="list") triggers the migration on an un-migrated DB without erroring', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    try {
      // Seed a row before the column exists — verifies that lazy migration
      // back-fills the existing row's `evergreen` value to the DEFAULT 0.
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, status, sprint_id, created_at) VALUES (?, 'active', 'sprint-1', '2026-01-01T00:00:00Z')`
      ).run('Pre-migration learning');
      db.close();

      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(false);

      const result = await rbookLearningsList({ projectRoot: tempDir });
      expect(result.success).toBe(true);

      // Migration should have fired during list.
      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(true);
      expect(result.data?.learnings).toHaveLength(1);
      expect(result.data?.learnings[0].evergreen).toBe(false);
    } finally {
      cleanup(tempDir);
    }
  });
});

describe('staleness gates on evergreen = 0', () => {
  it('counts a non-evergreen old learning as due for review and never an evergreen one', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    const client = await openClient(dbPath);
    try {
      // Seed sprints (threshold + 5).
      const totalSprints = DEFAULT_STALENESS_THRESHOLD + 5;
      const db = new Database(dbPath);
      // s97-m13: closed in label order, two weeks apart; review ages count the closes.
      for (let i = 1; i <= totalSprints; i++) {
        db.prepare(`INSERT INTO sprints (id, title, status, end_date) VALUES (?, ?, ?, ?)`).run(
          `sprint-${i}`,
          `Sprint ${i}`,
          i === totalSprints ? 'Active' : 'Completed',
          i === totalSprints
            ? null
            : new Date(Date.now() - ((totalSprints - i) * 14 + 1) * 86400_000).toISOString()
        );
      }
      const oldCreated = new Date(Date.now() - 365 * 86400_000).toISOString();
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, 'sprint-2', 'active')`
      ).run('Evergreen institutional rule', oldCreated);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, 'sprint-2', 'active')`
      ).run('Old non-evergreen learning', oldCreated);
      db.close();

      // Apply the migration + flag the first learning as evergreen.
      ensureLearningsTable(client);
      client.execute(`UPDATE learnings SET evergreen = 1 WHERE id = 1`, []);

      const result = readStaleness(client);
      // Only the non-evergreen one is due; s93-m11: neither is written.
      expect(result.dueLearnings).toBe(1);

      const db2 = new Database(dbPath);
      const rows = db2.prepare('SELECT id, status FROM learnings ORDER BY id').all() as Array<{
        id: number;
        status: string;
      }>;
      db2.close();
      expect(rows).toEqual([
        { id: 1, status: 'active' },
        { id: 2, status: 'active' },
      ]);
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('the stored stale count excludes evergreen rows', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    const client = await openClient(dbPath);
    try {
      ensureLearningsTable(client);
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status, evergreen) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'stale', 1)`
      ).run('Was-stale, now flagged evergreen');
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status, evergreen) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'stale', 0)`
      ).run('Genuinely stale');
      db.close();

      expect(readStaleness(client).storedStaleLearnings).toBe(1); // evergreen one excluded
    } finally {
      cleanup(tempDir, client);
    }
  });

  // s93-m11: the staleness read runs no migration. On a store without the evergreen column it
  // reads every learning as non-evergreen, and leaves the schema as it found it.
  it('reads an un-migrated DB without adding the column', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    const client = await openClient(dbPath);
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO sprints (id, title, status) VALUES ('sprint-1', 'S1', 'Active')`
      ).run();
      db.close();

      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(false);
      expect(() => readStaleness(client)).not.toThrow();
      expect(hasColumn(dbPath, 'learnings', 'evergreen')).toBe(false);
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('rbook_learnings(action="update", evergreen=true|false) two-way toggle', () => {
  it('persists evergreen=true and back to false', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'active')`
      ).run('Cursor advance-only rule');
      db.close();

      const setTrue = await rbookLearningsUpdate({
        learningId: 1,
        evergreen: true,
        projectRoot: tempDir,
      });
      expect(setTrue.success).toBe(true);
      expect(setTrue.data?.previousEvergreen).toBe(false);
      expect(setTrue.data?.newEvergreen).toBe(true);
      expect(readEvergreen(dbPath, 1)).toBe(1);

      const setFalse = await rbookLearningsUpdate({
        learningId: 1,
        evergreen: false,
        projectRoot: tempDir,
      });
      expect(setFalse.success).toBe(true);
      expect(setFalse.data?.previousEvergreen).toBe(true);
      expect(setFalse.data?.newEvergreen).toBe(false);
      expect(readEvergreen(dbPath, 1)).toBe(0);
    } finally {
      cleanup(tempDir);
    }
  });

  it('combines status + evergreen in a single update', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'stale')`
      ).run('Stale rule that is actually evergreen');
      db.close();

      const result = await rbookLearningsUpdate({
        learningId: 1,
        status: 'active',
        evergreen: true,
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('stale');
      expect(result.data?.newStatus).toBe('active');
      expect(result.data?.newEvergreen).toBe(true);
    } finally {
      cleanup(tempDir);
    }
  });

  it('returns MISSING_PARAMETER when neither status nor evergreen is supplied', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'active')`
      ).run('No-op update');
      db.close();

      const result = await rbookLearningsUpdate({ learningId: 1, projectRoot: tempDir });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSING_PARAMETER');
    } finally {
      cleanup(tempDir);
    }
  });

  it('a redundant evergreen=true call still bumps last_reviewed_at (tacit review)', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, '2026-01-01T00:00:00Z', 'sprint-1', 'active')`
      ).run('Already-evergreen rule');
      db.close();

      // First call: flip to evergreen.
      await rbookLearningsUpdate({ learningId: 1, evergreen: true, projectRoot: tempDir });
      // Second call: redundant evergreen=true with no status change.
      const noOp = await rbookLearningsUpdate({
        learningId: 1,
        evergreen: true,
        projectRoot: tempDir,
      });
      expect(noOp.success).toBe(true);
      expect(noOp.data?.message).toBe('No changes needed');

      const db2 = new Database(dbPath);
      const row = db2
        .prepare(`SELECT last_reviewed_at, evergreen FROM learnings WHERE id = 1`)
        .get() as { last_reviewed_at: string | null; evergreen: number };
      db2.close();
      expect(row.last_reviewed_at).not.toBeNull();
      expect(row.evergreen).toBe(1);
    } finally {
      cleanup(tempDir);
    }
  });
});

describe('FTS5 triggers on strategic_decisions remain unaffected', () => {
  it('decisions_fts is still maintained after the learnings.evergreen migration', async () => {
    const { tempDir, dbPath } = makeUnmigratedDb();
    const client = await openClient(dbPath);
    try {
      ensureDecisionsFts5(client);
      ensureLearningsTable(client);

      // Insert a decision; the FTS5 trigger should index it.
      client.execute(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status)
         VALUES ('Schema choice: snake_case for SQLite columns', '2026-01-01T00:00:00Z', 'sprint-1', 'active')`,
        []
      );

      const ftsHit = client.getOne<{ rowid: number }>(
        `SELECT rowid FROM decisions_fts WHERE decisions_fts MATCH 'snake_case' LIMIT 1`,
        []
      );
      expect(ftsHit.success).toBe(true);
      expect(ftsHit.data?.rowid).toBeGreaterThan(0);
    } finally {
      cleanup(tempDir, client);
    }
  });
});
