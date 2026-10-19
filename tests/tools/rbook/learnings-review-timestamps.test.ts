// ABOUTME: Sprint 52 m03 — last_reviewed_at behavior. Verifies the schema migration,
// staleness exemption for recently-reviewed learnings, update-bump, and reaffirm flow.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import {
  readStaleness,
  repairFlaggerStaleness,
  DEFAULT_STALENESS_THRESHOLD,
} from '../../../src/tools/rbook/staleness-detection';
import { ensureReviewTimestamps } from '../../../src/tools/rbook/schema-migrations';
import { rbookLearningsUpdate } from '../../../src/tools/rbook/rbook-learnings-update';
import { rbookLearningsReaffirm } from '../../../src/tools/rbook/rbook-learnings-reaffirm';

function makeTempDb(): { tempDir: string; dbPath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-review-ts-test-'));
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

describe('ensureReviewTimestamps migration', () => {
  it('adds last_reviewed_at to learnings and strategic_decisions (idempotent)', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const first = ensureReviewTimestamps(client);
      expect(first.columnsAdded).toEqual(
        expect.arrayContaining([
          'learnings.last_reviewed_at',
          'strategic_decisions.last_reviewed_at',
        ])
      );

      // Re-running is a no-op
      const second = ensureReviewTimestamps(client);
      expect(second.alreadyCurrent).toBe(true);
      expect(second.columnsAdded).toEqual([]);

      // Column is actually there
      const db = new Database(dbPath);
      const learningCols = db.pragma('table_info(learnings)') as Array<{ name: string }>;
      const decisionCols = db.pragma('table_info(strategic_decisions)') as Array<{ name: string }>;
      db.close();
      expect(learningCols.some((c) => c.name === 'last_reviewed_at')).toBe(true);
      expect(decisionCols.some((c) => c.name === 'last_reviewed_at')).toBe(true);
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('staleness respects last_reviewed_at', () => {
  it('does not count a learning whose last_reviewed_at is recent as due for review', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      // (threshold + 5) sprints, last is active. Learning in sprint-2 is past the review age.
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
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'active')`
      ).run('Reaffirmed learning', oldCreated, 'sprint-2');
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'active')`
      ).run('Never-reviewed old learning', oldCreated, 'sprint-2');
      db.close();

      // Seed the column + set a recent last_reviewed_at on the first learning
      ensureReviewTimestamps(client);
      const nowIso = new Date().toISOString();
      client.execute(`UPDATE learnings SET last_reviewed_at = ? WHERE id = 1`, [nowIso]);

      const result = readStaleness(client, { threshold: DEFAULT_STALENESS_THRESHOLD });

      // Only the never-reviewed one is due; s93-m11: no row is written either way.
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

  // The reporter's scenario (a stale count stuck at 11 after archiving 2) under the 3.3.0 rules:
  // archiving is an explicit status update that stamps the review, so the repair never restores an
  // archived row, and the rows an older flagger left are restored instead of re-flagged.
  it('an archive stamps the review, and the repair restores only the flagger-written rows', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
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
      // 11 learnings in sprint-2 that an older opener marked stale on its own.
      for (let i = 0; i < 11; i++) {
        db.prepare(
          `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'stale')`
        ).run(`Learning ${i}`, oldCreated, 'sprint-2');
      }
      db.close();
      expect(readStaleness(client).storedStaleLearnings).toBe(11);

      // Operator archives 2 (this bumps last_reviewed_at via rbookLearningsUpdate).
      await rbookLearningsUpdate({ learningId: 1, status: 'archived', projectRoot: tempDir });
      await rbookLearningsUpdate({ learningId: 2, status: 'archived', projectRoot: tempDir });

      const receipt = repairFlaggerStaleness(client);
      expect(receipt.restoredLearningIds).toHaveLength(9);
      expect(readStaleness(client).storedStaleLearnings).toBe(0);

      const db2 = new Database(dbPath);
      const archived = db2
        .prepare("SELECT COUNT(*) AS n FROM learnings WHERE status = 'archived'")
        .get() as { n: number };
      db2.close();
      expect(archived.n).toBe(2);
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('rbookLearningsUpdate bumps last_reviewed_at', () => {
  it('sets last_reviewed_at on status change', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'active')`
      ).run('To archive', '2026-01-01T00:00:00Z', 'sprint-1');
      db.close();

      const before = client.getOne<{ last_reviewed_at: string | null }>(
        `SELECT last_reviewed_at FROM learnings WHERE id = 1`
      );
      // Column doesn't exist yet — update will run the migration
      expect(before.success).toBe(false);

      const result = await rbookLearningsUpdate({
        learningId: 1,
        status: 'archived',
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.previousStatus).toBe('active');
      expect(result.data?.newStatus).toBe('archived');

      const after = client.getOne<{ last_reviewed_at: string | null; status: string }>(
        `SELECT last_reviewed_at, status FROM learnings WHERE id = 1`
      );
      expect(after.success).toBe(true);
      expect(after.data?.status).toBe('archived');
      expect(after.data?.last_reviewed_at).not.toBeNull();
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('bumps last_reviewed_at even when status is unchanged (tacit review)', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'active')`
      ).run('Still active', '2026-01-01T00:00:00Z', 'sprint-1');
      db.close();

      const result = await rbookLearningsUpdate({
        learningId: 1,
        status: 'active', // same as current
        projectRoot: tempDir,
      });
      expect(result.success).toBe(true);
      expect(result.data?.message).toBe('No changes needed');

      const row = client.getOne<{ last_reviewed_at: string | null }>(
        `SELECT last_reviewed_at FROM learnings WHERE id = 1`
      );
      expect(row.data?.last_reviewed_at).not.toBeNull();
    } finally {
      cleanup(tempDir, client);
    }
  });
});

describe('rbookLearningsReaffirm', () => {
  it('bumps last_reviewed_at without changing status', async () => {
    const { tempDir, dbPath } = makeTempDb();
    const client = await openClient(dbPath);
    try {
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO learnings (content, created_at, sprint_id, status) VALUES (?, ?, ?, 'stale')`
      ).run('Evergreen', '2026-01-01T00:00:00Z', 'sprint-1');
      db.close();

      const result = await rbookLearningsReaffirm({ learningId: 1, projectRoot: tempDir });
      expect(result.success).toBe(true);
      expect(result.data?.status).toBe('stale'); // unchanged
      expect(result.data?.reaffirmedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const row = client.getOne<{ last_reviewed_at: string | null; status: string }>(
        `SELECT last_reviewed_at, status FROM learnings WHERE id = 1`
      );
      expect(row.data?.last_reviewed_at).toBe(result.data?.reaffirmedAt);
      expect(row.data?.status).toBe('stale');
    } finally {
      cleanup(tempDir, client);
    }
  });

  it('returns MISSION_NOT_FOUND for unknown learning id', async () => {
    const { tempDir, dbPath } = makeTempDb();
    try {
      const result = await rbookLearningsReaffirm({ learningId: 999, projectRoot: tempDir });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('MISSION_NOT_FOUND');
    } finally {
      cleanup(tempDir);
    }
  });

  it('returns MISSING_PARAMETER when learningId is omitted', async () => {
    const result = await rbookLearningsReaffirm({} as { learningId: number });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
  });
});
