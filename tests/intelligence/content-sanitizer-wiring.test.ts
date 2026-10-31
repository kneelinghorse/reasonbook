// ABOUTME: End-to-end wiring tests for the content sanitizer across Reasonbook write-path handlers.
// ABOUTME: Asserts that corrupted input is cleaned before persistence and surfaced via sanitizedFields.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { rbookSessionStart } from '../../src/tools/rbook/rbook-session-start';
import { rbookSessionCapture } from '../../src/tools/rbook/rbook-session-capture';
import { rbookSessionComplete } from '../../src/tools/rbook/rbook-session-complete';
import { rbookMissionAdd } from '../../src/tools/rbook/rbook-mission-add';
import { rbookMissionUpdate } from '../../src/tools/rbook/rbook-mission-update';
import { rbookMissionComplete } from '../../src/tools/rbook/rbook-mission-complete';
import { rbookMissionBlock } from '../../src/tools/rbook/rbook-mission-block';
import { rbookMissionDefer } from '../../src/tools/rbook/rbook-mission-defer';
import { rbookContextUpdate } from '../../src/tools/rbook/rbook-context-update';

interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-sanitizer-wiring-'));
  const rbookDir = path.join(tempDir, 'rbook', 'db');
  fs.mkdirSync(rbookDir, { recursive: true });
  const dbPath = path.join(rbookDir, 'rbook.sqlite');
  const db = new Database(dbPath);

  db.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata (key, value) VALUES ('project_id', 'test-project');
    INSERT INTO metadata (key, value) VALUES ('project_name', 'Test Project');
    INSERT INTO metadata (key, value) VALUES ('schema_version', '2.2');

    CREATE TABLE sprints (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, focus TEXT, status TEXT,
      start_date TEXT, end_date TEXT, total_missions INTEGER, completed_missions INTEGER
    );

    CREATE TABLE missions (
      id TEXT PRIMARY KEY, sprint_id TEXT, name TEXT NOT NULL, status TEXT NOT NULL,
      completed_at TEXT, notes TEXT, objective TEXT, context TEXT,
      success_criteria TEXT, deliverables TEXT, reference_docs TEXT,
      domain_fields TEXT, created_at TEXT, started_at TEXT, updated_at TEXT, metadata TEXT
    );

    CREATE TABLE contexts (
      id TEXT PRIMARY KEY, source_path TEXT NOT NULL, content TEXT NOT NULL, updated_at TEXT
    );

    CREATE TABLE context_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, context_id TEXT NOT NULL, session_id TEXT,
      source TEXT NOT NULL, content_hash TEXT NOT NULL, content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, sprint_id TEXT,
      started_at TEXT NOT NULL, completed_at TEXT, agent TEXT,
      status TEXT NOT NULL DEFAULT 'active', summary TEXT,
      captures TEXT DEFAULT '[]', next_steps TEXT, metadata TEXT
    );

    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, agent TEXT, mission TEXT,
      action TEXT, status TEXT, summary TEXT, next_hint TEXT, raw_event TEXT NOT NULL
    );

    CREATE TABLE strategic_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context_id TEXT NOT NULL DEFAULT 'master_context',
      decision_text TEXT NOT NULL, created_at TEXT NOT NULL, sprint_id TEXT,
      snapshot_id INTEGER, project_domain TEXT, author_session_id TEXT, mission_id TEXT,
      source_chunk_ids TEXT, category TEXT, superseded_by INTEGER,
      status TEXT NOT NULL DEFAULT 'active', evidence TEXT, content_hash TEXT
    );

    CREATE TABLE learnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, category TEXT,
      status TEXT NOT NULL DEFAULT 'active', sprint_id TEXT, session_id TEXT,
      mission_id TEXT, created_at TEXT NOT NULL, content_hash TEXT
    );

    CREATE TABLE constraints (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', session_id TEXT, sprint_id TEXT,
      created_at TEXT NOT NULL, expires_at TEXT, content_hash TEXT
    );

    CREATE TABLE next_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', session_id TEXT, sprint_id TEXT,
      mission_id TEXT, created_at TEXT NOT NULL, updated_at TEXT,
      completed_at TEXT, content_hash TEXT
    );

    CREATE TABLE session_missions (
      session_id TEXT NOT NULL, mission_id TEXT NOT NULL, linked_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'capture', PRIMARY KEY (session_id, mission_id)
    );

    INSERT INTO sprints (id, title, focus, status)
    VALUES ('sprint-56', 'Sprint 56', 'Agent UX', 'Active');

    INSERT INTO missions (id, sprint_id, name, status, objective, started_at)
    VALUES
      ('s56-x01', 'sprint-56', 'Seed mission', 'Queued', 'A seeded mission', NULL),
      ('s60-mc01', 'sprint-56', 'Complete-path mission', 'In Progress', 'For complete sanitizer', '2024-01-10T12:00:00Z'),
      ('s60-mc02', 'sprint-56', 'Complete decisions mission', 'In Progress', 'For decisions[] persistence', '2024-01-10T12:00:00Z'),
      ('s60-mc03', 'sprint-56', 'Complete clean mission', 'In Progress', 'For clean-input regression', '2024-01-10T12:00:00Z'),
      ('s60-mb01', 'sprint-56', 'Block-path mission', 'In Progress', 'For block sanitizer', '2024-01-10T12:00:00Z'),
      ('s60-md01', 'sprint-56', 'Defer-path mission', 'Queued', 'For defer sanitizer', NULL),
      ('s60-mu01', 'sprint-56', 'Update-to-deferred mission', 'Queued', 'For update->Deferred sanitizer', NULL);

    INSERT INTO contexts (id, source_path, content, updated_at)
    VALUES
      ('master_context', 'context/MASTER_CONTEXT.json', '{"project":{"name":"Test"}}', '2024-01-10T12:00:00Z'),
      ('project_context', 'context/PROJECT_CONTEXT.json', '{"working_memory":{"next_steps":[]}}', '2024-01-10T12:00:00Z');

    CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
      decision_text, content='strategic_decisions', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS decisions_fts_insert AFTER INSERT ON strategic_decisions BEGIN
      INSERT INTO decisions_fts(rowid, decision_text) VALUES (new.id, new.decision_text);
    END;
  `);

  return { tempDir, dbPath, db };
}

function cleanup(testDb: TestDb): void {
  testDb.db.close();
  fs.rmSync(testDb.tempDir, { recursive: true, force: true });
}

const CORRUPTED =
  'The real decision we want to persist.</content>\n<parameter name="missionId">s56-m02';
const CLEAN = 'The real decision we want to persist.';

describe('Content sanitizer wiring: rbook_session_capture', () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
    await rbookSessionStart({
      type: 'planning',
      title: 'Test session',
      sprintId: 'sprint-56',
      projectRoot: testDb.tempDir,
    });
  });

  afterEach(() => cleanup(testDb));

  it('strips XML artifact from content and reports sanitizedFields', async () => {
    const result = await rbookSessionCapture({
      category: 'decision',
      content: CORRUPTED,
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields).toBeDefined();
    expect(result.sanitizedFields?.map((f) => f.field)).toContain('content');

    const persisted = testDb.db
      .prepare('SELECT decision_text FROM strategic_decisions ORDER BY id DESC LIMIT 1')
      .get() as { decision_text: string };
    expect(persisted.decision_text).toBe(CLEAN);
    expect(persisted.decision_text).not.toContain('<parameter name=');
  });

  it('leaves clean content untouched and omits sanitizedFields', async () => {
    const result = await rbookSessionCapture({
      category: 'decision',
      content: CLEAN,
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields).toBeUndefined();
  });
});

describe('Content sanitizer wiring: rbook_session_complete', () => {
  let testDb: TestDb;
  let sessionId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
    const start = await rbookSessionStart({
      type: 'planning',
      title: 'Test complete session',
      sprintId: 'sprint-56',
      projectRoot: testDb.tempDir,
    });
    sessionId = start.data!.sessionId;
  });

  afterEach(() => cleanup(testDb));

  it('sanitizes summary, decisions[], and nextSteps[] and reports index-addressed fields', async () => {
    const result = await rbookSessionComplete({
      sessionId,
      summary: `Wrapped up.${''}</content>noise`,
      decisions: ['clean decision', CORRUPTED, 'also clean'],
      nextSteps: [CORRUPTED, 'do the other thing'],
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields).toBeDefined();
    const fields = result.sanitizedFields!.map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['summary', 'decisions[1]', 'nextSteps[0]']));

    const sessionRow = testDb.db
      .prepare('SELECT summary FROM sessions WHERE id = ?')
      .get(sessionId) as { summary: string };
    expect(sessionRow.summary).toBe('Wrapped up.');

    const decisions = testDb.db
      .prepare(
        'SELECT decision_text FROM strategic_decisions WHERE author_session_id = ? ORDER BY id ASC'
      )
      .all(sessionId) as { decision_text: string }[];
    expect(decisions.map((d) => d.decision_text)).toEqual(['clean decision', CLEAN, 'also clean']);
  });
});

describe('Content sanitizer wiring: rbook_mission_add + rbook_mission_update', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => cleanup(testDb));

  it('rbook_mission_add sanitizes objective and notes', async () => {
    const result = await rbookMissionAdd({
      missionId: 's56-new',
      name: 'New mission',
      sprintId: 'sprint-56',
      objective: `Clean objective.${''}</content>garbage`,
      notes: 'Notes are clean.',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields?.map((f) => f.field)).toContain('objective');

    const row = testDb.db
      .prepare('SELECT objective, notes FROM missions WHERE id = ?')
      .get('s56-new') as { objective: string; notes: string };
    expect(row.objective).toBe('Clean objective.');
    expect(row.notes).toBe('Notes are clean.');
  });

  it('rbook_mission_add sanitizes corrupted notes as well', async () => {
    const result = await rbookMissionAdd({
      missionId: 's56-dirty',
      name: 'Dirty mission',
      sprintId: 'sprint-56',
      objective: 'fine',
      notes: CORRUPTED,
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields?.map((f) => f.field)).toContain('notes');

    const row = testDb.db.prepare('SELECT notes FROM missions WHERE id = ?').get('s56-dirty') as {
      notes: string;
    };
    expect(row.notes).toBe(CLEAN);
  });

  it('rbook_mission_update sanitizes fields.notes and arrays', async () => {
    const result = await rbookMissionUpdate({
      missionId: 's56-x01',
      fields: {
        notes: CORRUPTED,
        deliverables: ['clean', CORRUPTED, 'also clean'],
      },
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    const fields = result.sanitizedFields!.map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['fields.notes', 'fields.deliverables[1]']));

    const row = testDb.db
      .prepare('SELECT notes, deliverables FROM missions WHERE id = ?')
      .get('s56-x01') as { notes: string; deliverables: string };
    expect(row.notes).toBe(CLEAN);
    const storedDeliverables = JSON.parse(row.deliverables);
    expect(storedDeliverables).toEqual(['clean', CLEAN, 'also clean']);
  });
});

describe('Content sanitizer wiring: rbook_mission_complete (Sprint 60 m02)', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => cleanup(testDb));

  it('sanitizes notes and decisions[]; surfaces per-field reports; persists clean text', async () => {
    const result = await rbookMissionComplete({
      missionId: 's60-mc01',
      notes: `Wrapped up the work.${''}</content>\n<parameter name="missionId">noise`,
      decisions: ['clean architectural decision', CORRUPTED, 'another clean one'],
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields).toBeDefined();
    const fields = result.sanitizedFields!.map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['notes', 'decisions[1]']));

    // Persisted notes are clean (no XML artifact) and decisionCount matches input.
    const row = testDb.db
      .prepare('SELECT notes, status FROM missions WHERE id = ?')
      .get('s60-mc01') as { notes: string; status: string };
    expect(row.status).toBe('Completed');
    expect(row.notes).not.toContain('<parameter name=');
    expect(row.notes).toContain('Wrapped up the work.');

    const decisions = testDb.db
      .prepare(`SELECT decision_text FROM strategic_decisions WHERE mission_id = ? ORDER BY id ASC`)
      .all('s60-mc01') as { decision_text: string }[];
    expect(decisions.map((d) => d.decision_text)).toEqual([
      'clean architectural decision',
      CLEAN,
      'another clean one',
    ]);
    expect(result.data?.decisionCount).toBe(3);
  });

  it('persists every entry in a clean decisions[] array (decisionCount contract)', async () => {
    const result = await rbookMissionComplete({
      missionId: 's60-mc02',
      notes: 'No surprises here.',
      decisions: ['decision A', 'decision B', 'decision C', 'decision D', 'decision E'],
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields).toBeUndefined();
    expect(result.data?.decisionCount).toBe(5);

    const rows = testDb.db
      .prepare(`SELECT decision_text FROM strategic_decisions WHERE mission_id = ? ORDER BY id ASC`)
      .all('s60-mc02') as { decision_text: string }[];
    expect(rows.map((r) => r.decision_text)).toEqual([
      'decision A',
      'decision B',
      'decision C',
      'decision D',
      'decision E',
    ]);
  });

  // s91-m03 — Stage1 lost the decisions on five completions: the harness absorbed
  // `decisions=[...]` into `notes`, the sanitizer stripped it, `decisions` arrived undefined, and the
  // mission transitioned anyway. The transition is unrepeatable, so the server must refuse FIRST.
  it('refuses to complete when notes absorbed a missing decisions parameter', async () => {
    const result = await rbookMissionComplete({
      missionId: 's60-mc02',
      notes: 'Shipped the thing. <parameter name="decisions">["the lost decision"]',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'decisions' });
    expect(result.error?.message).toContain('was not completed');
    expect(result.error?.suggestion).toContain('rbook_decisions(action="record"');
    expect(result.sanitizedFields?.map((f) => f.field)).toContain('notes');

    const row = testDb.db.prepare('SELECT status FROM missions WHERE id = ?').get('s60-mc02') as {
      status: string;
    };
    expect(row.status).toBe('In Progress');
    const events = testDb.db
      .prepare(
        `SELECT COUNT(*) AS n FROM session_events WHERE mission = ? AND status = 'Completed'`
      )
      .get('s60-mc02') as { n: number };
    expect(events.n).toBe(0);
    const decisions = testDb.db
      .prepare('SELECT COUNT(*) AS n FROM strategic_decisions WHERE mission_id = ?')
      .get('s60-mc02') as { n: number };
    expect(decisions.n).toBe(0);
  });

  it('refuses when notes absorbed a missing agentFeedback parameter', async () => {
    const result = await rbookMissionComplete({
      missionId: 's60-mc02',
      notes: 'Done.\n<parameter name="agentFeedback">rough edge',
      decisions: ['kept decision'],
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'agentFeedback' });
  });

  it('keeps completing when the absorbed tag names no missing sibling (content/invoke)', async () => {
    const result = await rbookMissionComplete({
      missionId: 's60-mc02',
      notes: 'Done. <invoke name="something">',
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields?.map((f) => f.field)).toContain('notes');
  });

  it('names the record remedy on an already-Completed retry that carried decisions', async () => {
    await rbookMissionComplete({ missionId: 's60-mc03', projectRoot: testDb.tempDir });
    const withDecisions = await rbookMissionComplete({
      missionId: 's60-mc03',
      decisions: ['arrived late'],
      projectRoot: testDb.tempDir,
    });
    const without = await rbookMissionComplete({
      missionId: 's60-mc03',
      projectRoot: testDb.tempDir,
    });

    expect(withDecisions.error?.code).toBe('MISSION_ALREADY_COMPLETED');
    expect(withDecisions.error?.suggestion).toContain(
      'rbook_decisions(action="record", missionId="s60-mc03"'
    );
    expect(withDecisions.error?.suggestion).not.toContain('No action needed');
    expect(without.error?.suggestion).toContain('No action needed');
  });

  it('leaves clean inputs untouched and omits sanitizedFields', async () => {
    const result = await rbookMissionComplete({
      missionId: 's60-mc03',
      notes: 'Plain notes, no XML.',
      decisions: ['plain decision'],
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields).toBeUndefined();
    expect(result.data?.decisionCount).toBe(1);
  });
});

describe('Content sanitizer wiring: rbook_mission_block (Sprint 60 m02)', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => cleanup(testDb));

  it('sanitizes reason and blockers[]; persists clean text', async () => {
    const result = await rbookMissionBlock({
      missionId: 's60-mb01',
      reason: `Waiting on dashboard endpoint.${''}</content>noise`,
      blockers: ['dashboard m04 deploy', CORRUPTED],
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields).toBeDefined();
    const fields = result.sanitizedFields!.map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['reason', 'blockers[1]']));

    const row = testDb.db
      .prepare('SELECT status, notes, domain_fields FROM missions WHERE id = ?')
      .get('s60-mb01') as { status: string; notes: string; domain_fields: string };
    expect(row.status).toBe('Blocked');
    expect(row.notes).not.toContain('<parameter name=');
    const dom = JSON.parse(row.domain_fields);
    expect(dom.blockers).toEqual(['dashboard m04 deploy', CLEAN]);
    expect(dom.blocker).toBe('Waiting on dashboard endpoint.');
  });

  // s106-m02: a reason made only of a stray tool-call tag was supplied, then emptied; "missing"
  // would send the same text back. The refusal says what happened, and plain text then blocks.
  it('says a supplied reason was emptied by the sanitizer, and plain text then blocks', async () => {
    const refused = await rbookMissionBlock({
      missionId: 's60-mb01',
      reason: '<parameter name="blockers">',
      projectRoot: testDb.tempDir,
    });
    expect(refused.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'reason' });
    expect(refused.error?.message).toMatch(/content sanitizer/);
    expect(refused.error?.suggestion).toMatch(/plain text/);
    const status = () =>
      (
        testDb.db.prepare('SELECT status FROM missions WHERE id = ?').get('s60-mb01') as {
          status: string;
        }
      ).status;
    expect(status()).toBe('In Progress');
    const blocked = await rbookMissionBlock({
      missionId: 's60-mb01',
      reason: 'Waiting on the dashboard endpoint.',
      projectRoot: testDb.tempDir,
    });
    expect(blocked.success).toBe(true);
    expect(status()).toBe('Blocked');
  });
});

describe('Content sanitizer wiring: rbook_mission_defer (Sprint 60 m02)', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => cleanup(testDb));

  it('sanitizes reason and deferUntil; persists clean values into domain_fields', async () => {
    const result = await rbookMissionDefer({
      missionId: 's60-md01',
      reason: `Parked until partner ships.${''}</content>noise`,
      deferUntil: `after sprint 70${''}</content>more-noise`,
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields).toBeDefined();
    const fields = result.sanitizedFields!.map((f) => f.field);
    expect(fields).toEqual(expect.arrayContaining(['reason', 'deferUntil']));

    const row = testDb.db
      .prepare('SELECT status, notes, domain_fields FROM missions WHERE id = ?')
      .get('s60-md01') as { status: string; notes: string; domain_fields: string };
    expect(row.status).toBe('Deferred');
    expect(row.notes).not.toContain('<parameter name=');
    const dom = JSON.parse(row.domain_fields);
    expect(dom.deferredReason).toBe('Parked until partner ships.');
    expect(dom.deferUntil).toBe('after sprint 70');
  });
});

describe('Content sanitizer wiring: rbook_mission_update -> Deferred status (Sprint 60 m02)', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => cleanup(testDb));

  it('sanitizes notes when transitioning to Deferred via update', async () => {
    const result = await rbookMissionUpdate({
      missionId: 's60-mu01',
      fields: {
        status: 'Deferred',
        notes: CORRUPTED,
      },
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields).toBeDefined();
    expect(result.sanitizedFields!.map((f) => f.field)).toContain('fields.notes');

    const row = testDb.db
      .prepare('SELECT status, notes FROM missions WHERE id = ?')
      .get('s60-mu01') as { status: string; notes: string };
    expect(row.status).toBe('Deferred');
    expect(row.notes).toBe(CLEAN);
  });
});

describe('Content sanitizer wiring: rbook_context_update', () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => cleanup(testDb));

  it('sanitizes string values in arrayUpdates.constraints', async () => {
    const result = await rbookContextUpdate({
      contextType: 'project_context',
      arrayUpdates: {
        constraints: ['must be idempotent', CORRUPTED],
      },
      projectRoot: testDb.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields?.map((f) => f.field)).toContain('arrayUpdates.constraints[1]');
  });
});
