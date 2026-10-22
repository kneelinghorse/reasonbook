// ABOUTME: End-to-end tests for the agentFeedback standing channel (Sprint 56 m03).
// ABOUTME: Covers writes from 3 surfaces + the rbook_feedback list/triage/resolve/archive review tool.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookSessionStart } from '../../../src/tools/rbook/rbook-session-start';
import { rbookSessionComplete } from '../../../src/tools/rbook/rbook-session-complete';
import { rbookMissionTransition } from '../../../src/tools/rbook/rbook-mission-transition';
import { rbookAgentOnboard } from '../../../src/tools/rbook/rbook-agent-onboard';
import {
  rbookFeedback,
  type RbookFeedbackListResult,
  type RbookFeedbackMutationResult,
} from '../../../src/tools/rbook/rbook-feedback';

interface TestDb {
  tempDir: string;
  dbPath: string;
  db: InstanceType<typeof Database>;
}

function createTestDb(): TestDb {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-feedback-'));
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
      snapshot_id INTEGER, project_domain TEXT, session_id TEXT, mission_id TEXT,
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
    VALUES ('s56-seed', 'sprint-56', 'Seed mission', 'In Progress', 'A seeded mission', '2026-04-17T00:00:00Z');

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

function cleanup(t: TestDb): void {
  t.db.close();
  fs.rmSync(t.tempDir, { recursive: true, force: true });
}

describe('agentFeedback write paths', () => {
  let t: TestDb;

  beforeEach(() => {
    t = createTestDb();
    RbookDetector.resetInstance();
  });

  afterEach(() => cleanup(t));

  it('rbook_session_complete persists agentFeedback with session+sprint context', async () => {
    const start = await rbookSessionStart({
      type: 'planning',
      title: 'feedback session',
      sprintId: 'sprint-56',
      projectRoot: t.tempDir,
    });
    const sessionId = start.data!.sessionId;

    const result = await rbookSessionComplete({
      sessionId,
      summary: 'wrapping up',
      agentFeedback: 'The onboard payload was surprisingly slow on a polluted registry.',
      projectRoot: t.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.data?.feedbackId).toBeGreaterThan(0);

    const row = t.db
      .prepare(
        'SELECT tool_name, session_id, sprint_id, status, body FROM agent_feedback WHERE id = ?'
      )
      .get(result.data!.feedbackId) as {
      tool_name: string;
      session_id: string;
      sprint_id: string;
      status: string;
      body: string;
    };
    // s86-m03: was 'rbook_session_complete' — a tool name RBOOK_TOOL_DEFINITIONS no longer publishes.
    // Until m03 this write path was unreachable from any agent (rbook_session declared no
    // `agentFeedback` key and forwarded none), so no row was ever stamped with it; m03 opens the
    // path, and a brand-new DURABLE row naming a retired tool is exactly the defect class s86
    // exists to close. The live convention is the REGISTERED name — rbook-mission-complete.ts
    // writes 'rbook_mission_transition', rbook-agent-onboard.ts writes 'rbook_agent_onboard'.
    expect(row.tool_name).toBe('rbook_session');
    expect(row.session_id).toBe(sessionId);
    expect(row.sprint_id).toBe('sprint-56');
    expect(row.status).toBe('open');
    expect(row.body).toContain('polluted registry');
  });

  it('rbook_session_complete sanitizes XML artifacts in agentFeedback', async () => {
    const start = await rbookSessionStart({
      type: 'planning',
      title: 'dirty feedback',
      sprintId: 'sprint-56',
      projectRoot: t.tempDir,
    });
    const sessionId = start.data!.sessionId;

    const result = await rbookSessionComplete({
      sessionId,
      summary: 'ok',
      agentFeedback:
        'Found an edge case in rbook_context_update.</content>\n<parameter name="missionId">s56-m02',
      projectRoot: t.tempDir,
    });

    expect(result.success).toBe(true);
    expect(result.sanitizedFields?.map((f) => f.field)).toContain('agentFeedback');

    const row = t.db
      .prepare('SELECT body FROM agent_feedback WHERE id = ?')
      .get(result.data!.feedbackId) as { body: string };
    expect(row.body).toBe('Found an edge case in rbook_context_update.');
    expect(row.body).not.toContain('<parameter');
  });

  it('rbook_mission_transition(complete) persists agentFeedback with mission+sprint context', async () => {
    const result = await rbookMissionTransition({
      action: 'complete',
      missionId: 's56-seed',
      notes: 'done',
      agentFeedback: 'Decision-supersession detection fired 3 false positives on this one.',
      projectRoot: t.tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as { feedbackId?: number };
    expect(data.feedbackId).toBeGreaterThan(0);

    const row = t.db
      .prepare('SELECT tool_name, mission_id, sprint_id FROM agent_feedback WHERE id = ?')
      .get(data.feedbackId!) as { tool_name: string; mission_id: string; sprint_id: string };
    expect(row.tool_name).toBe('rbook_mission_transition');
    expect(row.mission_id).toBe('s56-seed');
    expect(row.sprint_id).toBe('sprint-56');
  });

  it('rbook_agent_onboard persists agentFeedback without requiring active session', async () => {
    const result = await rbookAgentOnboard({
      agentFeedback: 'Suggested actions rotated while I was reading them — confusing.',
      projectRoot: t.tempDir,
    });

    expect(result.success).toBe(true);
    const fbId = (result.data as { feedbackId?: number }).feedbackId;
    expect(fbId).toBeGreaterThan(0);

    const row = t.db
      .prepare('SELECT tool_name, body FROM agent_feedback WHERE id = ?')
      .get(fbId!) as { tool_name: string; body: string };
    expect(row.tool_name).toBe('rbook_agent_onboard');
    expect(row.body).toContain('Suggested actions');
  });

  it('omits feedbackId and writes no row when agentFeedback is not provided', async () => {
    const start = await rbookSessionStart({
      type: 'planning',
      title: 'no feedback',
      sprintId: 'sprint-56',
      projectRoot: t.tempDir,
    });
    const sessionId = start.data!.sessionId;
    const result = await rbookSessionComplete({
      sessionId,
      summary: 'nothing to report',
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data?.feedbackId).toBeUndefined();
    // agent_feedback table is lazily created by recordAgentFeedback; when
    // agentFeedback is unset, the table should not even exist yet.
    const tableRow = t.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_feedback'")
      .get();
    expect(tableRow).toBeUndefined();
  });

  it('omits feedbackId when agentFeedback is only whitespace', async () => {
    const result = await rbookAgentOnboard({
      agentFeedback: '   \n  ',
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    expect((result.data as { feedbackId?: number }).feedbackId).toBeUndefined();
  });
});

describe('rbook_feedback(action=list|triage|resolve|archive)', () => {
  let t: TestDb;

  beforeEach(async () => {
    t = createTestDb();
    RbookDetector.resetInstance();
    // Seed 3 rows via the real write path from different tools.
    await rbookAgentOnboard({
      agentFeedback: 'alpha — onboard one',
      projectRoot: t.tempDir,
    });
    await rbookAgentOnboard({
      agentFeedback: 'bravo — onboard two',
      projectRoot: t.tempDir,
    });
    await rbookMissionTransition({
      action: 'complete',
      missionId: 's56-seed',
      notes: 'done',
      agentFeedback: 'charlie — from mission',
      projectRoot: t.tempDir,
    });
  });

  afterEach(() => cleanup(t));

  it('list defaults to status=open, newest-first, with countsByTool', async () => {
    const result = await rbookFeedback({ action: 'list', projectRoot: t.tempDir });
    expect(result.success).toBe(true);
    const data = result.data as RbookFeedbackListResult;
    expect(data.entries.length).toBe(3);
    expect(data.entries[0].body).toContain('charlie');
    expect(data.countsByTool).toEqual({
      rbook_agent_onboard: 2,
      rbook_mission_transition: 1,
    });
    expect(data.countsByStatus.open).toBe(3);
  });

  it('list filters by toolName', async () => {
    const result = await rbookFeedback({
      action: 'list',
      toolName: 'rbook_agent_onboard',
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    const data = result.data as RbookFeedbackListResult;
    expect(data.entries.length).toBe(2);
    expect(data.entries.every((e) => e.toolName === 'rbook_agent_onboard')).toBe(true);
  });

  it('binds the row limit without treating an SQL fragment as query syntax', async () => {
    const result = await rbookFeedback({
      action: 'list',
      limit: '1 OFFSET 1' as unknown as number,
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(false);
  });

  it('limits returned rows while keeping filtered counts over the full matching set', async () => {
    const result = await rbookFeedback({
      action: 'list',
      toolName: 'rbook_agent_onboard',
      limit: 1,
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    const data = result.data as RbookFeedbackListResult;
    expect(data.entries).toHaveLength(1);
    expect(data.totalCount).toBe(2);
    expect(data.countsByTool).toEqual({ rbook_agent_onboard: 2 });
    expect(data.countsByStatus.open).toBe(2);
  });

  it('triage transitions open → triaged', async () => {
    const list = await rbookFeedback({ action: 'list', projectRoot: t.tempDir });
    const firstId = (list.data as RbookFeedbackListResult).entries[0].id;
    const triaged = await rbookFeedback({
      action: 'triage',
      feedbackId: firstId,
      projectRoot: t.tempDir,
    });
    expect(triaged.success).toBe(true);
    const m = triaged.data as RbookFeedbackMutationResult;
    expect(m.previousStatus).toBe('open');
    expect(m.currentStatus).toBe('triaged');

    const listOpen = await rbookFeedback({ action: 'list', projectRoot: t.tempDir });
    expect((listOpen.data as RbookFeedbackListResult).entries.length).toBe(2);
    const listTriaged = await rbookFeedback({
      action: 'list',
      status: 'triaged',
      projectRoot: t.tempDir,
    });
    expect((listTriaged.data as RbookFeedbackListResult).entries.length).toBe(1);
  });

  it('keeps the triage disposition on the feedback row for the next reviewer', async () => {
    const list = await rbookFeedback({ action: 'list', projectRoot: t.tempDir });
    const feedbackId = (list.data as RbookFeedbackListResult).entries[0].id;
    const result = await rbookFeedback({
      action: 'triage',
      feedbackId,
      resolutionNote: 'Confirmed; the next build owns the fix.',
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    expect((result.data as RbookFeedbackMutationResult).resolutionNote).toBe(
      'Confirmed; the next build owns the fix.'
    );
    expect(
      t.db
        .prepare('SELECT resolution_note, resolved_at FROM agent_feedback WHERE id=?')
        .get(feedbackId)
    ).toEqual({ resolution_note: 'Confirmed; the next build owns the fix.', resolved_at: null });
  });

  it('resolve stamps resolved_at + resolution_note', async () => {
    const list = await rbookFeedback({ action: 'list', projectRoot: t.tempDir });
    const firstId = (list.data as RbookFeedbackListResult).entries[0].id;
    const resolved = await rbookFeedback({
      action: 'resolve',
      feedbackId: firstId,
      resolutionNote: 'shipped in s57-m01',
      projectRoot: t.tempDir,
    });
    expect(resolved.success).toBe(true);
    const m = resolved.data as RbookFeedbackMutationResult;
    expect(m.currentStatus).toBe('resolved');
    expect(m.resolutionNote).toBe('shipped in s57-m01');

    const row = t.db
      .prepare('SELECT status, resolved_at, resolution_note FROM agent_feedback WHERE id = ?')
      .get(firstId) as { status: string; resolved_at: string; resolution_note: string };
    expect(row.status).toBe('resolved');
    expect(row.resolved_at).not.toBeNull();
    expect(row.resolution_note).toBe('shipped in s57-m01');
  });

  it('archive moves to archived status', async () => {
    const list = await rbookFeedback({ action: 'list', projectRoot: t.tempDir });
    const firstId = (list.data as RbookFeedbackListResult).entries[0].id;
    const archived = await rbookFeedback({
      action: 'archive',
      feedbackId: firstId,
      projectRoot: t.tempDir,
    });
    expect(archived.success).toBe(true);
    expect((archived.data as RbookFeedbackMutationResult).currentStatus).toBe('archived');
  });

  it('mutations require feedbackId', async () => {
    const result = await rbookFeedback({ action: 'triage', projectRoot: t.tempDir });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MISSING_PARAMETER');
  });

  it('mutations on an unknown feedbackId return FEEDBACK_NOT_FOUND', async () => {
    const result = await rbookFeedback({
      action: 'triage',
      feedbackId: 99999,
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FEEDBACK_NOT_FOUND');
  });
});

describe('rbook_feedback by kind and bulk resolve (s97-m07)', () => {
  let t: TestDb;
  let ids: number[];

  /** The rows as the store holds them, read beside the tool rather than through it. */
  function rows(): Array<{
    id: number;
    status: string;
    resolved_at: string | null;
    resolution_note: string | null;
  }> {
    return t.db
      .prepare('SELECT id, status, resolved_at, resolution_note FROM agent_feedback ORDER BY id')
      .all() as Array<{
      id: number;
      status: string;
      resolved_at: string | null;
      resolution_note: string | null;
    }>;
  }

  beforeEach(async () => {
    t = createTestDb();
    RbookDetector.resetInstance();
    for (const text of [
      'cmos_mission(action="status") returned an 81KB payload past the token cap.',
      'cmos_review build-freshness warning never clears for this repo.',
      'The project tests were flaky; nothing about the tooling.',
    ])
      await rbookAgentOnboard({ agentFeedback: text, projectRoot: t.tempDir });
    ids = rows().map((row) => row.id);
  });

  afterEach(() => cleanup(t));

  it('counts every matching row by kind, past the limit, and names each entry its kind', async () => {
    // The fleet's agents triage by kind; a count over only the returned page would hide the rest.
    const result = await rbookFeedback({ action: 'list', limit: 1, projectRoot: t.tempDir });
    expect(result.success).toBe(true);
    const data = result.data as RbookFeedbackListResult;
    expect(data.entries).toHaveLength(1);
    expect(data.countsByKind).toMatchObject({
      payload: 1,
      ceremony: 1,
      identity: 0,
      unclassified: 1,
    });
    const all = await rbookFeedback({ action: 'list', projectRoot: t.tempDir });
    const kinds = new Map(
      (all.data as RbookFeedbackListResult).entries.map((entry) => [entry.id, entry.kind])
    );
    expect([kinds.get(ids[0]), kinds.get(ids[1]), kinds.get(ids[2])]).toEqual([
      'payload',
      'ceremony',
      'unclassified',
    ]);
  });

  it('resolves every listed row in one call, each from its own status', async () => {
    await rbookFeedback({ action: 'triage', feedbackId: ids[1], projectRoot: t.tempDir });
    const result = await rbookFeedback({
      action: 'resolve',
      feedbackIds: [ids[0], ids[1]],
      resolutionNote: 'Fixed in 4.2.1.',
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      resolved: [
        { feedbackId: ids[0], previousStatus: 'open', currentStatus: 'resolved' },
        { feedbackId: ids[1], previousStatus: 'triaged', currentStatus: 'resolved' },
      ],
      resolutionNote: 'Fixed in 4.2.1.',
    });
    const after = rows();
    expect(after.slice(0, 2).every((row) => row.status === 'resolved' && row.resolved_at)).toBe(
      true
    );
    expect(after.slice(0, 2).map((row) => row.resolution_note)).toEqual([
      'Fixed in 4.2.1.',
      'Fixed in 4.2.1.',
    ]);
    expect(after[2].status).toBe('open');
  });

  it('refuses the whole call when any id is unknown, naming it, and changes nothing', async () => {
    // All or nothing: a typo in one id must not leave the others half-resolved.
    const before = rows();
    const result = await rbookFeedback({
      action: 'resolve',
      feedbackIds: [ids[0], 99999],
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FEEDBACK_NOT_FOUND');
    expect(result.error?.message).toContain('99999');
    expect(result.error?.message).not.toContain(`#${ids[0]}`);
    expect(rows()).toEqual(before);
  });

  it('names the destination project and preserves an already resolved row’s original receipt', async () => {
    await rbookFeedback({
      action: 'resolve',
      feedbackIds: [ids[0]],
      resolutionNote: 'First fix.',
      projectRoot: t.tempDir,
    });
    const first = rows()[0];
    const result = await rbookFeedback({
      action: 'resolve',
      feedbackIds: [ids[0], ids[1]],
      resolutionNote: 'Second fix.',
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      projectId: 'test-project',
      projectName: 'Test Project',
      skipped: [ids[0]],
      resolved: [{ feedbackId: ids[1], previousStatus: 'open', currentStatus: 'resolved' }],
    });
    expect((result.data as { message: string }).message).toMatch(/Test Project.*test-project/);
    expect(rows()[0]).toEqual(first);
    const again = await rbookFeedback({
      action: 'resolve',
      feedbackIds: [ids[0]],
      projectRoot: t.tempDir,
    });
    expect(again.data).toMatchObject({ resolved: [], skipped: [ids[0]] });
    expect(rows()[0]).toEqual(first);
  });

  it.each([
    ['an empty list', []],
    ['a string id', ['1']],
    ['zero', [0]],
    ['a fraction', [1.5]],
    ['not a list', 'all'],
  ])('refuses feedbackIds given %s, before touching the store', async (_label, feedbackIds) => {
    const before = rows();
    const result = await rbookFeedback({
      action: 'resolve',
      feedbackIds,
      projectRoot: t.tempDir,
    } as never);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
    expect(result.error?.suggestion).toMatch(/feedbackIds/);
    expect(rows()).toEqual(before);
  });

  it('refuses more than 200 ids in one call', async () => {
    const result = await rbookFeedback({
      action: 'resolve',
      feedbackIds: Array.from({ length: 201 }, (_, i) => i + 1),
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
  });

  it('refuses feedbackId and feedbackIds together', async () => {
    const result = await rbookFeedback({
      action: 'resolve',
      feedbackId: ids[0],
      feedbackIds: [ids[1]],
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
    expect(rows().every((row) => row.status === 'open')).toBe(true);
  });

  it.each(['triage', 'archive'] as const)(
    'refuses feedbackIds on %s, which takes one row, rather than ignoring it',
    async (action) => {
      const result = await rbookFeedback({
        action,
        feedbackIds: [ids[0]],
        projectRoot: t.tempDir,
      } as never);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_PARAMETER');
      expect(result.error?.message).toContain(action);
      expect(rows().every((row) => row.status === 'open')).toBe(true);
    }
  );

  it('resolves a repeated id once', async () => {
    const result = await rbookFeedback({
      action: 'resolve',
      feedbackIds: [ids[2], ids[2]],
      projectRoot: t.tempDir,
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      resolved: [{ feedbackId: ids[2], previousStatus: 'open', currentStatus: 'resolved' }],
    });
  });
});
