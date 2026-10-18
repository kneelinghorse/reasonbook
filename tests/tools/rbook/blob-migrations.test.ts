/**
 * Tests for the versioned blob migration system.
 *
 * Covers:
 * - Registry invariants (ordering, version constant)
 * - Migration v1 pure function (dead sections removed, others preserved, no mutation)
 * - applyPendingBlobMigrations runner (version gating, snapshot, write-back, idempotency)
 * - Integration: full rbook_context_view call triggers migration on legacy blob
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  BLOB_MIGRATIONS,
  BLOB_SCHEMA_VERSION,
  BLOB_SCHEMA_VERSION_KEY,
  getBlobSchemaVersion,
  applyPendingBlobMigrations,
} from '../../../src/tools/rbook/blob-migrations';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { rbookContextView } from '../../../src/tools/rbook/rbook-context-view';
import {
  resetFirstWriteMaintenance,
  runFirstWriteMaintenance,
} from '../../../src/tools/rbook/first-write-maintenance';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDb(masterContextContent: Record<string, unknown>, metaVersion?: number): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-blob-migration-test-'));
  const dbDir = path.join(tempDir, 'rbook', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'rbook.sqlite');

  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE contexts (
      id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT
    );
    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_id TEXT NOT NULL,
      session_id TEXT,
      source TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE missions (
      id TEXT PRIMARY KEY,
      sprint_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE sprints (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      focus TEXT,
      status TEXT,
      start_date TEXT,
      end_date TEXT
    );
    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_id TEXT NOT NULL DEFAULT 'master_context',
      decision_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sprint_id TEXT,
      snapshot_id INTEGER,
      project_domain TEXT,
      session_id TEXT,
      mission_id TEXT,
      source_chunk_ids TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      sprint_id TEXT,
      session_id TEXT,
      mission_id TEXT,
      created_at TEXT NOT NULL,
      content_hash TEXT
    );
  `);

  db.prepare(`INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)`).run(
    'master_context',
    'context/MASTER_CONTEXT.json',
    JSON.stringify(masterContextContent),
    new Date().toISOString()
  );

  if (metaVersion !== undefined) {
    db.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)`).run(
      BLOB_SCHEMA_VERSION_KEY,
      String(metaVersion)
    );
  }

  db.close();
  return tempDir;
}

// ---------------------------------------------------------------------------
// Registry invariants
// ---------------------------------------------------------------------------

describe('BLOB_MIGRATIONS registry', () => {
  it('is non-empty', () => {
    expect(BLOB_MIGRATIONS.length).toBeGreaterThan(0);
  });

  it('versions are strictly increasing starting at 1', () => {
    const versions = BLOB_MIGRATIONS.map((m) => m.version);
    for (let i = 0; i < versions.length; i++) {
      expect(versions[i]).toBe(i + 1);
    }
  });

  it('BLOB_SCHEMA_VERSION matches highest migration version', () => {
    const maxVersion = Math.max(...BLOB_MIGRATIONS.map((m) => m.version));
    expect(BLOB_SCHEMA_VERSION).toBe(maxVersion);
  });

  it('every migration has a non-empty description', () => {
    for (const m of BLOB_MIGRATIONS) {
      expect(m.description.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Migration v1 — pure function
// ---------------------------------------------------------------------------

describe('migration v1 — remove dead sections', () => {
  const v1 = BLOB_MIGRATIONS.find((m) => m.version === 1)!;

  const DEAD_SECTIONS = [
    'completed_missions',
    'completed_sprints',
    'decisions_made',
    'learnings',
    'recent_sessions',
  ] as const;

  it('removes all five dead sections', () => {
    const legacy: Record<string, unknown> = {
      completed_missions: [{ id: 'm01' }],
      completed_sprints: [{ id: 'sprint-1' }],
      decisions_made: ['use TypeScript'],
      learnings: ['test everything'],
      recent_sessions: [{ id: 'ps-001' }],
      technical_context: { stack: 'Node.js' },
      ai_instructions: { tone: 'direct' },
    };
    const result = v1.up(legacy);
    for (const key of DEAD_SECTIONS) {
      expect(result).not.toHaveProperty(key);
    }
  });

  it('preserves all non-dead sections', () => {
    const legacy: Record<string, unknown> = {
      completed_missions: [],
      technical_context: { stack: 'Node.js' },
      ai_instructions: { tone: 'direct' },
      context_notes: ['keep it simple'],
      context_health: { size_limit_kb: 100 },
    };
    const result = v1.up(legacy);
    expect(result).toHaveProperty('technical_context');
    expect(result).toHaveProperty('ai_instructions');
    expect(result).toHaveProperty('context_notes');
    expect(result).toHaveProperty('context_health');
  });

  it('is a no-op on blobs that already lack the dead sections', () => {
    const minimal: Record<string, unknown> = {
      technical_context: { stack: 'Node.js' },
      ai_instructions: {},
    };
    const result = v1.up(minimal);
    expect(result).toEqual(minimal);
  });

  it('does not mutate the input blob', () => {
    const input: Record<string, unknown> = {
      completed_missions: [{ id: 'm01' }],
      technical_context: { stack: 'Node.js' },
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    v1.up(input);
    expect(input).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// applyPendingBlobMigrations — runner unit tests
// ---------------------------------------------------------------------------

describe('applyPendingBlobMigrations', () => {
  let tempDir: string;
  let client: RbookDatabaseClient;

  beforeEach(async () => {
    tempDir = makeTempDb({ completed_missions: [{ id: 'm01' }], technical_context: {} });
    const clientResult = await RbookDatabaseClient.create({ projectRoot: tempDir });
    expect(clientResult.success).toBe(true);
    client = clientResult.data!;
  });

  afterEach(() => {
    client.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns migrated=true and applies v1 on legacy blob', () => {
    const blob = { completed_missions: [], decisions_made: ['x'], technical_context: {} };
    const raw = JSON.stringify(blob);
    const result = applyPendingBlobMigrations(client, 'master_context', raw, blob);

    expect(result.migrated).toBe(true);
    expect(result.migrationsApplied).toContain(1);
    expect(result.blob).not.toHaveProperty('completed_missions');
    expect(result.blob).not.toHaveProperty('decisions_made');
    expect(result.blob).toHaveProperty('technical_context');
  });

  it('discloses a missing snapshot table while persisting the legacy blob migration', () => {
    expect(client.execute('DROP TABLE context_snapshots').success).toBe(true);
    const raw = client.getOne<{ content: string }>(
      "SELECT content FROM contexts WHERE id = 'master_context'"
    ).data!.content;

    const result = applyPendingBlobMigrations(client, 'master_context', raw, JSON.parse(raw));

    expect(result.rewritten).toBe(true);
    expect(result.warnings).toEqual([
      expect.stringMatching(
        /context_snapshots pre-migration snapshot.*failed:.*missing project_id/
      ),
    ]);
    expect(
      JSON.parse(
        client.getOne<{ content: string }>(
          "SELECT content FROM contexts WHERE id = 'master_context'"
        ).data!.content
      )
    ).toEqual({ technical_context: {} });
    expect(getBlobSchemaVersion(client)).toBe(BLOB_SCHEMA_VERSION);
    expect(
      client.getOne("SELECT name FROM sqlite_master WHERE name = 'context_snapshots'").data
    ).toBeUndefined();
  });

  it('returns migrated=false when version is already current', () => {
    // Manually set version to current
    client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
      BLOB_SCHEMA_VERSION_KEY,
      String(BLOB_SCHEMA_VERSION),
    ]);
    const blob = { technical_context: {} };
    const result = applyPendingBlobMigrations(client, 'master_context', JSON.stringify(blob), blob);

    expect(result.migrated).toBe(false);
    expect(result.migrationsApplied).toHaveLength(0);
    expect(result.blob).toEqual(blob);
  });

  it('skips migration for non-master_context contexts', () => {
    const blob = { completed_missions: ['should stay'] };
    const result = applyPendingBlobMigrations(
      client,
      'project_context',
      JSON.stringify(blob),
      blob
    );

    expect(result.migrated).toBe(false);
    expect(result.blob).toHaveProperty('completed_missions');
  });

  it('writes blob_schema_version to metadata after migration', () => {
    const blob = { completed_missions: [] };
    applyPendingBlobMigrations(client, 'master_context', JSON.stringify(blob), blob);

    expect(getBlobSchemaVersion(client)).toBe(BLOB_SCHEMA_VERSION);
  });

  it('is idempotent — second call returns migrated=false', () => {
    const blob = { completed_missions: [] };
    const raw = JSON.stringify(blob);

    applyPendingBlobMigrations(client, 'master_context', raw, blob);
    const second = applyPendingBlobMigrations(client, 'master_context', raw, blob);

    expect(second.migrated).toBe(false);
  });

  it('takes a pre-migration snapshot before applying', () => {
    const blob = { completed_missions: [{ id: 'm01' }] };
    applyPendingBlobMigrations(client, 'master_context', JSON.stringify(blob), blob);

    const snapshots = client.getMany<{ source: string }>(
      "SELECT source FROM context_snapshots WHERE context_id = 'master_context'",
      []
    );
    expect(snapshots.success).toBe(true);
    expect(snapshots.data?.some((s) => s.source.startsWith('pre-migration'))).toBe(true);
  });

  it('does not duplicate pre-migration snapshot on repeat calls', () => {
    const blob = { completed_missions: [] };
    const raw = JSON.stringify(blob);

    // First call migrates and snapshots
    applyPendingBlobMigrations(client, 'master_context', raw, blob);
    // Reset version to force re-migration attempt
    client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
      BLOB_SCHEMA_VERSION_KEY,
      '0',
    ]);
    // Second call: same raw content → snapshot dedup kicks in
    applyPendingBlobMigrations(client, 'master_context', raw, blob);

    const snapshots = client.getMany<{ id: number }>(
      "SELECT id FROM context_snapshots WHERE source LIKE 'pre-migration%'",
      []
    );
    expect(snapshots.data?.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: rbook_context_view triggers migration on legacy blob
// ---------------------------------------------------------------------------

describe('rbook_context_view — auto-migration integration', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    RbookDetector.resetInstance();
  });

  it('auto-migrates a legacy blob with all five dead sections', async () => {
    tempDir = makeTempDb({
      completed_missions: [{ id: 'm01', name: 'old mission' }],
      completed_sprints: [{ id: 'sprint-1' }],
      decisions_made: ['use TypeScript'],
      learnings: ['test everything'],
      recent_sessions: [{ id: 'ps-001' }],
      technical_context: { stack: 'Node.js' },
      context_health: { size_limit_kb: 100 },
    });

    const result = await rbookContextView({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    const content = result.data?.masterContext?.content ?? {};
    expect(content).not.toHaveProperty('completed_missions');
    expect(content).not.toHaveProperty('completed_sprints');
    expect(content).not.toHaveProperty('decisions_made');
    expect(content).not.toHaveProperty('learnings');
    expect(content).not.toHaveProperty('recent_sessions');
    expect(content).toHaveProperty('technical_context');
  });

  // s93-m11: the view is a read and never writes the record (decision #1182). It shows the
  // migrated shape and leaves the stored blob, the version and the snapshot table alone.
  it('writes nothing: no version stamp, no rewritten blob, no snapshot', async () => {
    tempDir = makeTempDb({
      completed_missions: [{ id: 'm01' }],
      technical_context: { stack: 'Node.js' },
    });
    const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
    const result = await rbookContextView({ projectRoot: tempDir });

    expect(result.data?.masterContext?.content).not.toHaveProperty('completed_missions');
    const db = new Database(dbPath);
    const version = db
      .prepare(`SELECT value FROM metadata WHERE key = '${BLOB_SCHEMA_VERSION_KEY}'`)
      .get() as { value: string } | undefined;
    const stored = JSON.parse(
      (
        db.prepare("SELECT content FROM contexts WHERE id = 'master_context'").get() as {
          content: string;
        }
      ).content
    ) as Record<string, unknown>;
    const snapshots = db
      .prepare("SELECT COUNT(*) AS n FROM context_snapshots WHERE source LIKE 'pre-migration%'")
      .get() as { n: number };
    db.close();
    expect(version).toBeUndefined();
    expect(stored).toHaveProperty('completed_missions');
    expect(snapshots.n).toBe(0);
  });

  it('the first write persists the migration: version, pruned blob and a snapshot, once', async () => {
    tempDir = makeTempDb({
      completed_missions: [{ id: 'm01' }],
      technical_context: { stack: 'Node.js' },
    });
    resetFirstWriteMaintenance();
    await runFirstWriteMaintenance(tempDir);
    resetFirstWriteMaintenance();
    await runFirstWriteMaintenance(tempDir); // a later process's first write: nothing left to do

    const db = new Database(path.join(tempDir, 'rbook', 'db', 'rbook.sqlite'));
    const version = db
      .prepare(`SELECT value FROM metadata WHERE key = '${BLOB_SCHEMA_VERSION_KEY}'`)
      .get() as { value: string } | undefined;
    const stored = JSON.parse(
      (
        db.prepare("SELECT content FROM contexts WHERE id = 'master_context'").get() as {
          content: string;
        }
      ).content
    ) as Record<string, unknown>;
    const snapshots = db
      .prepare("SELECT source FROM context_snapshots WHERE source LIKE 'pre-migration%'")
      .all() as { source: string }[];
    db.close();

    expect(version?.value).toBe(String(BLOB_SCHEMA_VERSION));
    expect(stored).not.toHaveProperty('completed_missions');
    expect(stored).toHaveProperty('technical_context');
    expect(snapshots).toHaveLength(1);
  });

  it('first-write upkeep discloses a missing snapshot without claiming it was taken', async () => {
    tempDir = makeTempDb({
      completed_missions: [{ id: 'm01' }],
      technical_context: { stack: 'Node.js' },
    });
    const dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');
    const before = new Database(dbPath);
    before.exec('DROP TABLE context_snapshots');
    before.close();
    resetFirstWriteMaintenance();

    const notes = await runFirstWriteMaintenance(tempDir);

    expect(notes).toContainEqual(
      expect.stringMatching(/context_snapshots pre-migration snapshot.*failed:.*missing project_id/)
    );
    expect(notes).toContainEqual(expect.stringMatching(/Migrated the stored master_context/));
    expect(notes.join('\n')).not.toMatch(/snapshot was taken/);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(
        JSON.parse(
          (
            db.prepare("SELECT content FROM contexts WHERE id = 'master_context'").get() as {
              content: string;
            }
          ).content
        )
      ).toEqual({ technical_context: { stack: 'Node.js' } });
      expect(
        db.prepare('SELECT value FROM metadata WHERE key = ?').get(BLOB_SCHEMA_VERSION_KEY)
      ).toEqual({ value: String(BLOB_SCHEMA_VERSION) });
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'context_snapshots'").get()
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('a blob the migrations leave unchanged gets only its version stamp', async () => {
    tempDir = makeTempDb({ technical_context: { stack: 'Node.js' } });
    resetFirstWriteMaintenance();
    await runFirstWriteMaintenance(tempDir);

    const db = new Database(path.join(tempDir, 'rbook', 'db', 'rbook.sqlite'));
    const version = db
      .prepare(`SELECT value FROM metadata WHERE key = '${BLOB_SCHEMA_VERSION_KEY}'`)
      .get() as { value: string } | undefined;
    const snapshots = db.prepare('SELECT COUNT(*) AS n FROM context_snapshots').get() as {
      n: number;
    };
    db.close();
    expect(version?.value).toBe(String(BLOB_SCHEMA_VERSION));
    expect(snapshots.n).toBe(0);
  });

  it('is a no-op for projects already at current schema version', async () => {
    const minimal = { technical_context: { stack: 'Node.js' }, context_health: {} };
    tempDir = makeTempDb(minimal, BLOB_SCHEMA_VERSION);

    const result = await rbookContextView({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    // Content unchanged
    expect(result.data?.masterContext?.content).toEqual(minimal);

    const db = new Database(path.join(tempDir, 'rbook', 'db', 'rbook.sqlite'));
    const snapshots = db
      .prepare("SELECT id FROM context_snapshots WHERE source LIKE 'pre-migration%'")
      .all();
    db.close();
    expect(snapshots.length).toBe(0);
  });

  it('reports accurate (smaller) size after migration', async () => {
    const legacyBlob = {
      completed_missions: Array.from({ length: 50 }, (_, i) => ({ id: `m${i}`, name: 'old' })),
      decisions_made: Array.from({ length: 100 }, (_, i) => `decision ${i}`),
      technical_context: { stack: 'Node.js' },
      context_health: { size_limit_kb: 100 },
    };
    tempDir = makeTempDb(legacyBlob);

    const result = await rbookContextView({ projectRoot: tempDir });

    expect(result.success).toBe(true);
    // Post-migration size should be much smaller than the raw legacy blob
    const postMigrationSizeKb = result.data?.contextSizes?.masterContext?.sizeKb ?? 0;
    const legacySizeKb = Buffer.byteLength(JSON.stringify(legacyBlob)) / 1024;
    expect(postMigrationSizeKb).toBeLessThan(legacySizeKb);
  });
});
