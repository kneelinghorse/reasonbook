// ABOUTME: Carry-forward detection and routing require a registered local sender identity.
// ABOUTME: Real SQLite fixtures verify attribution before dashboard transport is invoked.

/**
 * rbook_sprint carry_forward action tests
 *
 * Tests for carry-forward detection and backlog_request messaging.
 *
 * @module tests/tools/rbook/rbook-sprint-carry-forward
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  rbookSprint,
  formatSprintForLLM,
  RBOOK_SPRINT_ACTIONS,
} from '../../../src/tools/rbook/rbook-sprint';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import type { SprintCarryForwardResult } from '../../../src/tools/rbook/rbook-sprint-carry-forward';
import { LEGACY } from '../../../src/intelligence/legacy-compat';

// Mock the DashboardClient to avoid real HTTP calls
jest.mock('../../../src/tools/rbook/dashboard-client', () => {
  const mockSendMessage = jest.fn().mockResolvedValue({
    success: true,
    data: { id: 'msg-001', status: 'pending' },
  });

  const mockGetMyProjects = jest.fn().mockResolvedValue({
    success: true,
    data: {
      projects: [
        {
          id: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
          name: 'cmos-mcp',
          address: 'rbook://derek/cmos-mcp',
        },
      ],
    },
  });

  return {
    DashboardClient: {
      fromEnv: jest.fn().mockReturnValue({
        success: true,
        data: {
          sendMessage: mockSendMessage,
          getMyProjects: mockGetMyProjects,
        },
      }),
      // s87-m05 — carry_forward now resolves a PROJECT-scoped client. It already received
      // `projectRoot` and threw it away, resolving a user-scoped client instead. Note the
      // different envelope: `fromEnvForProject` resolves to `{ client, ... }`, where `fromEnv`
      // resolves to the client itself.
      fromEnvForProject: jest.fn().mockResolvedValue({
        success: true,
        data: {
          client: {
            sendMessage: mockSendMessage,
            getMyProjects: mockGetMyProjects,
          },
        },
      }),
    },
    __mockSendMessage: mockSendMessage,
    __mockGetMyProjects: mockGetMyProjects,
  };
});

const { __mockSendMessage, __mockGetMyProjects } = jest.requireMock(
  '../../../src/tools/rbook/dashboard-client'
) as {
  __mockSendMessage: jest.Mock;
  __mockGetMyProjects: jest.Mock;
};

describe('rbook_sprint carry_forward action', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-carry-forward-test-'));
    const rbookDbDir = path.join(tempDir, 'rbook', 'db');
    fs.mkdirSync(rbookDbDir, { recursive: true });
    dbPath = path.join(rbookDbDir, 'rbook.sqlite');

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sprints (
        id TEXT PRIMARY KEY,
        title TEXT,
        focus TEXT,
        status TEXT,
        start_date TEXT,
        end_date TEXT,
        total_missions INTEGER,
        completed_missions INTEGER
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        sprint_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        notes TEXT,
        objective TEXT,
        context TEXT,
        success_criteria TEXT,
        deliverables TEXT,
        reference_docs TEXT,
        domain_fields TEXT,
        metadata TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE strategic_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context_id TEXT DEFAULT 'master_context',
        decision_text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sprint_id TEXT,
        category TEXT,
        status TEXT DEFAULT 'active',
        evidence TEXT,
        superseded_by INTEGER,
        snapshot_id INTEGER,
        project_domain TEXT,
        session_id TEXT,
        mission_id TEXT,
        source_chunk_ids TEXT
      );

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT,
        title TEXT,
        status TEXT,
        sprint_id TEXT,
        summary TEXT,
        captures TEXT,
        next_steps TEXT,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE contexts (
        id TEXT PRIMARY KEY,
        source_path TEXT,
        content TEXT,
        updated_at TEXT
      );
    `);

    // Seed the registered local sender identity. Without this stored UUID,
    // resolveLocalSenderProjectId returns undefined and carry_forward refuses
    // publication before transport, even if an account listing reuses the address.
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
      'dashboard_project_id',
      'ec2b4987-dbc1-4f16-946e-9843c4080ac1'
    );
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('owner', 'derek');
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run('dashboard_slug', 'cmos-mcp');

    // Insert sprint
    db.prepare('INSERT INTO sprints (id, title, focus, status) VALUES (?, ?, ?, ?)').run(
      'sprint-36',
      'Intelligence & DX',
      'Developer experience',
      'Active'
    );

    // Insert missions — 3 completed, 1 blocked
    const insertMission = db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, notes) VALUES (?, ?, ?, ?, ?)`
    );
    insertMission.run(
      's36-m01',
      'sprint-36',
      'Server Health',
      'Completed',
      'Build manifest + staleness detection'
    );
    insertMission.run(
      's36-m02',
      'sprint-36',
      'Decision Lifecycle',
      'Completed',
      'Automated review + batch update'
    );
    insertMission.run(
      's36-m03',
      'sprint-36',
      'Sprint Retro',
      'Completed',
      'Auto-generated reports'
    );
    insertMission.run(
      's36-m04',
      'sprint-36',
      'Carry-Forward Routing',
      'Blocked',
      'Waiting on dashboard changes'
    );

    // Insert sessions — some with null sprint_id (sync gap)
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, type, title, status, sprint_id) VALUES (?, ?, ?, ?, ?)`
    );
    insertSession.run('sess-001', 'planning', 'Sprint 36 Planning', 'completed', 'sprint-36');
    insertSession.run('sess-002', 'review', 'Orphaned Session 1', 'completed', null);
    insertSession.run('sess-003', 'check-in', 'Orphaned Session 2', 'completed', null);

    // Insert decisions — some with null session_id (sync gap)
    const insertDecision = db.prepare(
      `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, session_id, status)
       VALUES (?, ?, ?, ?, ?)`
    );
    insertDecision.run(
      'Use build manifest',
      '2026-03-11T10:00:00Z',
      'sprint-36',
      'sess-001',
      'active'
    );
    insertDecision.run('Orphan decision 1', '2026-03-11T11:00:00Z', 'sprint-36', null, 'active');
    insertDecision.run('Orphan decision 2', '2026-03-11T12:00:00Z', 'sprint-36', null, 'active');

    db.close();
    RbookDetector.getInstance().clearCache();

    // Reset mocks
    __mockSendMessage.mockClear();
    __mockSendMessage.mockResolvedValue({
      success: true,
      data: { id: 'msg-001', status: 'pending' },
    });
    __mockGetMyProjects.mockClear();
    __mockGetMyProjects.mockResolvedValue({
      success: true,
      data: {
        projects: [
          {
            id: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
            name: 'cmos-mcp',
            address: 'rbook://derek/cmos-mcp',
          },
        ],
      },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    RbookDetector.getInstance().clearCache();
  });

  it('includes carry_forward in RBOOK_SPRINT_ACTIONS', () => {
    expect(RBOOK_SPRINT_ACTIONS).toContain('carry_forward');
  });

  it.each([
    [LEGACY.addressScheme, false],
    [LEGACY.addressScheme, true],
    ['rbook://', false],
    ['rbook://', true],
  ] as const)('accepts the %s address boundary with send=%s', async (scheme, send) => {
    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: `${scheme}derek/cmos-dashboard`,
      send,
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    const data = result.data as SprintCarryForwardResult;
    expect(data.targetAddress).toBe('rbook://derek/cmos-dashboard');
    expect(data.totalDetected).toBe(2);
    if (send) {
      expect(__mockSendMessage).toHaveBeenCalledTimes(2);
      for (const [request] of __mockSendMessage.mock.calls)
        expect(request.targetAddress).toBe('rbook://derek/cmos-dashboard');
    } else expect(__mockSendMessage).not.toHaveBeenCalled();
  });

  it('detects blocked missions as carry-forwards', async () => {
    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: 'rbook://derek/cmos-dashboard',
      send: false,
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintCarryForwardResult;

    const blockedItems = data.items.filter((i) => i.type === 'blocked_mission');
    expect(blockedItems).toHaveLength(1);
    expect(blockedItems[0].missionId).toBe('s36-m04');
    expect(blockedItems[0].description).toContain('Carry-Forward Routing');
  });

  it('no longer reports sessions with null sprint_id as a carry-forward item', async () => {
    // WHY THIS FLIPPED (s85-m03): the `null_sprint_sessions` item type was REMOVED, not
    // merely re-scoped. It ran a global `SELECT COUNT(*) FROM sessions WHERE sprint_id IS
    // NULL` and described the result as "N session(s) with null sprint_id require dashboard
    // event processor update" — and with send=true it emitted a cross-project
    // backlog_request asking a sibling team to fix a dashboard bug that does not exist.
    //
    // After m03 a NULL sprint_id is the CORRECT record for a session started when no sprint
    // was in an open status, so the item's stated cause became factually false and its count
    // would climb with ordinary use. It was deliberately NOT replaced with a sprint-scoped
    // variant (e.g. inferring the sprint via session_missions): that would reintroduce
    // exactly the guessing m03 removed. The untagged count is surfaced instead as a
    // non-blocking advisory on rbook_sprint(retro), rbook_sprint(complete) and
    // rbook_decisions(review).
    //
    // The two null-sprint_id sessions this fixture seeds are still present — they are simply
    // no longer reported as a defect.
    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: 'rbook://derek/cmos-dashboard',
      send: false,
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintCarryForwardResult;

    expect(data.items.filter((i) => i.type === 'null_sprint_sessions')).toHaveLength(0);
  });

  it('detects decisions with null session_id', async () => {
    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: 'rbook://derek/cmos-dashboard',
      send: false,
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintCarryForwardResult;

    const decisionItems = data.items.filter((i) => i.type === 'null_session_decisions');
    expect(decisionItems).toHaveLength(1);
    expect(decisionItems[0].count).toBe(2);
    expect(decisionItems[0].description).toContain('2 decision(s)');
  });

  it('still detects the decision sync gap AFTER the s69-m04 session_id rename', async () => {
    // Simulate a migrated store: strategic_decisions.session_id is now
    // author_session_id (the values — including the 2 NULLs — are preserved by the
    // in-place RENAME COLUMN). The detector must resolve the new column name.
    const migrated = new Database(dbPath);
    migrated.exec('ALTER TABLE strategic_decisions RENAME COLUMN session_id TO author_session_id');
    migrated.close();
    RbookDetector.resetInstance();

    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: 'rbook://derek/cmos-dashboard',
      send: false,
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintCarryForwardResult;

    const decisionItems = data.items.filter((i) => i.type === 'null_session_decisions');
    expect(decisionItems).toHaveLength(1);
    expect(decisionItems[0].count).toBe(2);
    // The operator-visible string is updated to the new column name in lockstep.
    expect(decisionItems[0].description).toContain('null author_session_id');
  });

  it('dry run does not send messages', async () => {
    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: 'rbook://derek/cmos-dashboard',
      send: false,
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintCarryForwardResult;

    // s85-m03: 3 -> 2, the null_sprint_sessions detector was removed (see above).
    expect(data.totalDetected).toBe(2);
    expect(data.totalSent).toBe(0);
    expect(__mockSendMessage).not.toHaveBeenCalled();
  });

  it('sends backlog_request messages when send=true', async () => {
    // Make each call return a unique ID
    let callCount = 0;
    __mockSendMessage.mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        success: true,
        data: { id: `msg-${String(callCount).padStart(3, '0')}`, status: 'pending' },
      });
    });

    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: 'rbook://derek/cmos-dashboard',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintCarryForwardResult;

    // s85-m03: 3 -> 2, the null_sprint_sessions detector was removed.
    expect(data.totalSent).toBe(2);
    expect(data.totalFailed).toBe(0);
    // s85-m03: one fewer message, because the null_sprint_sessions item no longer exists.
    expect(__mockSendMessage).toHaveBeenCalledTimes(2);

    // Verify message params
    const firstCall = __mockSendMessage.mock.calls[0][0];
    expect(firstCall.targetAddress).toBe('rbook://derek/cmos-dashboard');
    expect(firstCall.type).toBe('backlog_request');
    expect(firstCall.senderProjectId).toBe('ec2b4987-dbc1-4f16-946e-9843c4080ac1');
  });

  it('handles send failures gracefully', async () => {
    __mockSendMessage.mockResolvedValue({
      success: false,
      error: { code: 'DASHBOARD_ERROR', message: 'Server error' },
    });

    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: 'rbook://derek/cmos-dashboard',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintCarryForwardResult;

    expect(data.totalSent).toBe(0);
    // s85-m03: 3 -> 2, the null_sprint_sessions detector was removed.
    expect(data.totalFailed).toBe(2);
    expect(data.sendResults.every((r) => !r.sent)).toBe(true);
    expect(data.sendResults[0].error).toContain('Server error');
  });

  it('returns error for missing sprintId', async () => {
    const result = await rbookSprint({
      action: 'carry_forward',
      targetAddress: 'rbook://derek/cmos-dashboard',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(false);
  });

  it('returns error for missing targetAddress', async () => {
    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(false);
  });

  it('returns error for invalid targetAddress format', async () => {
    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: 'not-a-rbook-address',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
  });

  it('returns error for non-existent sprint', async () => {
    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-999',
      targetAddress: 'rbook://derek/cmos-dashboard',
      send: false,
      projectRoot: tempDir,
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('not found');
    const db = new Database(dbPath, { readonly: true });
    const projectId = db.prepare(`SELECT value FROM metadata WHERE key = 'project_id'`).get() as
      | { value: string }
      | undefined;
    db.close();
    expect(projectId).toBeUndefined();
    const graph = await ProjectGraphRegistry.create();
    expect(graph.getByStorePath(tempDir)).toBeNull();
  });

  it('handles sprint with no carry-forwards', async () => {
    // Create a clean sprint with no issues
    const db = new Database(dbPath);
    db.prepare('INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)').run(
      'sprint-clean',
      'Clean Sprint',
      'Completed'
    );
    db.prepare(`INSERT INTO missions (id, sprint_id, name, status) VALUES (?, ?, ?, ?)`).run(
      'sc-m01',
      'sprint-clean',
      'Done Task',
      'Completed'
    );
    db.close();
    RbookDetector.getInstance().clearCache();

    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-clean',
      targetAddress: 'rbook://derek/cmos-dashboard',
      send: false,
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintCarryForwardResult;

    // Still detects global sync gaps (null sprint_id sessions, null session_id decisions)
    const blockedItems = data.items.filter((i) => i.type === 'blocked_mission');
    expect(blockedItems).toHaveLength(0);
  });

  it('formats carry_forward output for LLM', async () => {
    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: 'rbook://derek/cmos-dashboard',
      send: false,
      projectRoot: tempDir,
    });

    const formatted = formatSprintForLLM('carry_forward', result);
    expect(formatted).toContain('Carry-Forward Routing');
    expect(formatted).toContain('sprint-36');
    expect(formatted).toContain('rbook://derek/cmos-dashboard');
    expect(formatted).toContain('Detected');
  });

  it('resolves senderProjectId from local metadata.dashboard_project_id when sending', async () => {
    // Only send for 1 item by using a clean sprint with just a blocked mission
    const db = new Database(dbPath);
    db.prepare('INSERT INTO sprints (id, title, status) VALUES (?, ?, ?)').run(
      'sprint-single',
      'Single Blocked',
      'Active'
    );
    db.prepare(
      `INSERT INTO missions (id, sprint_id, name, status, notes) VALUES (?, ?, ?, ?, ?)`
    ).run('ss-m01', 'sprint-single', 'Blocked Task', 'Blocked', 'Needs input');
    db.close();
    RbookDetector.getInstance().clearCache();

    await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-single',
      targetAddress: 'rbook://derek/cmos-dashboard',
      projectRoot: tempDir,
    });

    // Sprint 53: canonical dashboard_project_id in local metadata is authoritative,
    // so the resolver short-circuits and does NOT call /api/projects/me. This is the
    // happy path — we already know who we are.
    expect(__mockGetMyProjects).not.toHaveBeenCalled();
    const sendCall = __mockSendMessage.mock.calls[0]?.[0];
    expect(sendCall).toBeDefined();
    expect(sendCall.senderProjectId).toBe('ec2b4987-dbc1-4f16-946e-9843c4080ac1');
  });

  it('refuses every carry-forward when a fresh store reuses an owned canonical address', async () => {
    const db = new Database(dbPath);
    try {
      db.prepare("DELETE FROM metadata WHERE key = 'dashboard_project_id'").run();
      db.prepare(
        'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)'
      ).run(
        'project_identity',
        'rbook/context/project_identity.json',
        JSON.stringify({ [LEGACY.identityAddressKey]: 'rbook://derek/cmos-mcp' }),
        new Date().toISOString()
      );
    } finally {
      db.close();
    }
    RbookDetector.getInstance().clearCache();

    const result = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sprint-36',
      targetAddress: 'rbook://derek/cmos-dashboard',
      projectRoot: tempDir,
    });

    expect(result.success).toBe(true);
    const data = result.data as SprintCarryForwardResult;
    expect(data.totalDetected).toBeGreaterThan(0);
    expect(data.totalSent).toBe(0);
    expect(data.totalFailed).toBe(data.totalDetected);
    for (const item of data.sendResults) {
      expect(item.sent).toBe(false);
      expect(item.error).toContain('Sender attribution incomplete');
    }
    expect(__mockGetMyProjects).not.toHaveBeenCalled();
    expect(__mockSendMessage).not.toHaveBeenCalled();
  });
});
