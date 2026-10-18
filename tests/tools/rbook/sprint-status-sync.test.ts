// ABOUTME: Sprint and mission edits remain local after legacy dashboard propagation is retired.
// ABOUTME: Collaborative stores disclose retirement; solo and unrelated-field edits stay quiet.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import { __drainCheckpointBackfill } from '../../../src/tools/rbook/checkpoint-backfill';
import { maybePropagateSprintStatus } from '../../../src/tools/rbook/sync-locks';
import { formatSprintUpdateForLLM } from '../../../src/tools/rbook/rbook-sprint-update';
import { createSuccess } from '../../../src/tools/rbook/errors';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';

const SLUG = 'test-project';
const RETIRED = 'LEGACY_SYNC_RETIRED';
const fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
let previousFetch: typeof fetch;

function expectRetired(warnings: string[] | undefined): void {
  expect(warnings?.filter((warning) => warning.includes(RETIRED))).toEqual([
    expect.stringContaining('reasonbook sync'),
  ]);
}

function readRow(dbPath: string, sql: string): Record<string, unknown> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare(sql).get() as Record<string, unknown>;
  } finally {
    db.close();
  }
}

describe('sprint status after legacy sync retirement', () => {
  let tempDir: string;
  let dbPath: string;
  const ENV_BACKUP: Record<string, string | undefined> = {};
  const seedSchema = fs.readFileSync(
    path.join(__dirname, '../../../rbook-seed/db/schema.sql'),
    'utf8'
  );

  beforeEach(() => {
    for (const k of [
      'RBOOK_DASHBOARD_URL',
      'RBOOK_DASHBOARD_USER',
      'RBOOK_DASHBOARD_PASSWORD',
      'RBOOK_CHECKPOINT_SYNC',
    ]) {
      ENV_BACKUP[k] = process.env[k];
    }
    process.env.RBOOK_DASHBOARD_URL = 'http://127.0.0.1:1';
    process.env.RBOOK_DASHBOARD_USER = 'me@x.com';
    process.env.RBOOK_DASHBOARD_PASSWORD = 'pw';
    // Supported owner checkpoint uploads are separate from retired event propagation.
    process.env.RBOOK_CHECKPOINT_SYNC = 'off';

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-sprintsync-test-'));
    fs.mkdirSync(path.join(tempDir, 'rbook', 'db'), { recursive: true });
    dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');

    RbookDetector.resetInstance();
    fetchMock.mockReset();
    previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    fetchMock.mockRejectedValue(new Error('Retired propagation must not reach the dashboard.'));
  });

  afterEach(async () => {
    await __drainCheckpointBackfill();

    globalThis.fetch = previousFetch;
    for (const [k, v] of Object.entries(ENV_BACKUP)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  function createStore(
    opts: { collab?: boolean; sprintStatus?: string; extraSql?: string } = {}
  ): void {
    const db = new Database(dbPath);
    db.exec(seedSchema);
    db.exec(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', 'Test Project');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_slug', '${SLUG}');
      ${opts.collab !== false ? `INSERT OR REPLACE INTO metadata (key, value) VALUES ('collab_role', 'editor');` : ''}
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'm', '{}');
      INSERT INTO sprints (id, title, status) VALUES ('s1', 'Sprint 1', '${opts.sprintStatus ?? 'Active'}');
      ${opts.extraSql ?? ''}
    `);
    db.close();
  }

  it('mission start activates parent and mission locally and reports retirement once', async () => {
    createStore({
      sprintStatus: 'Planned',
      extraSql:
        "INSERT INTO missions(id,name,status,sprint_id) VALUES('m1','Start','Queued','s1');",
    });
    const { rbookMissionTransition } =
      await import('../../../src/tools/rbook/rbook-mission-transition');
    const result = await rbookMissionTransition({
      action: 'start',
      missionId: 'm1',
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(readRow(dbPath, "SELECT status FROM sprints WHERE id='s1'")).toEqual({
      status: 'Active',
    });
    expect(readRow(dbPath, "SELECT status FROM missions WHERE id='m1'")).toEqual({
      status: 'In Progress',
    });
    expectRetired(result.warnings);
  });

  // ─── maybePropagateSprintStatus (the dispatcher hook, tested directly) ──────────

  it('keeps the successful local status and discloses the retired propagation remedy', async () => {
    createStore({ sprintStatus: 'Completed' });
    const out = await maybePropagateSprintStatus(createSuccess({ ok: true }), 's1', tempDir);
    expect(out.success).toBe(true);
    expect(out.data).toEqual({ ok: true });
    expectRetired(out.warnings);
    expect(readRow(dbPath, "SELECT status FROM sprints WHERE id='s1'")).toEqual({
      status: 'Completed',
    });
  });

  it('is a NO-OP on a SOLO store (no collab_role) — no emit, no warnings, no fetch', async () => {
    createStore({ collab: false, sprintStatus: 'Completed' });
    const out = await maybePropagateSprintStatus(createSuccess({ ok: true }), 's1', tempDir);
    expect(out.success).toBe(true);
    expect(out.warnings).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discloses retirement even when the old mutable-status cache matches the current status', async () => {
    createStore({
      sprintStatus: 'Completed',
      extraSql: `INSERT INTO metadata (key, value) VALUES ('mutable_status:sprint_status:s1', '${JSON.stringify(
        { status: 'Completed', occurredAt: Date.now(), originSeq: 1, authorUserId: null }
      ).replace(/'/g, "''")}');`,
    });
    const out = await maybePropagateSprintStatus(createSuccess({ ok: true }), 's1', tempDir);
    expect(out.success).toBe(true);
    expectRetired(out.warnings);
  });

  it('preserves earlier warnings and does not duplicate retirement on repeated hooks', async () => {
    createStore({ sprintStatus: 'Completed' });
    const result = createSuccess({ ok: true }, ['Earlier local warning']);
    const first = await maybePropagateSprintStatus(result, 's1', tempDir);
    const repeated = await maybePropagateSprintStatus(first, 's1', tempDir);
    expect(repeated.success).toBe(true);
    expect(repeated.warnings).toContain('Earlier local warning');
    expectRetired(repeated.warnings);
  });

  it('formatSprintUpdateForLLM renders retirement and its remedy', () => {
    const formatted = formatSprintUpdateForLLM({
      success: true,
      data: { sprintId: 's1', updatedFields: ['status'] } as unknown as Parameters<
        typeof formatSprintUpdateForLLM
      >[0]['data'],
      warnings: [`${RETIRED}: The local edit is kept. Use reasonbook sync.`],
    });
    expect(formatted).toContain('Warnings:');
    expect(formatted).toContain(RETIRED);
    expect(formatted).toContain('reasonbook sync');
  });

  // ─── rbook_sprint dispatcher wiring ──────────────────────────────────────────────

  it('rbook_sprint(update, status) writes the new local status and warns on a collab store', async () => {
    createStore({ sprintStatus: 'Active' });
    const result = await rbookSprint({
      action: 'update',
      sprintId: 's1',
      fields: { status: 'In Progress' },
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(readRow(dbPath, "SELECT status FROM sprints WHERE id='s1'")).toEqual({
      status: 'In Progress',
    });
    expectRetired(result.warnings);
  });

  it('rbook_sprint(update) without a status field keeps the propagation guard', async () => {
    createStore({ sprintStatus: 'Active' });
    const result = await rbookSprint({
      action: 'update',
      sprintId: 's1',
      fields: { focus: 'a new focus' },
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(readRow(dbPath, "SELECT status,focus FROM sprints WHERE id='s1'")).toEqual({
      status: 'Active',
      focus: 'a new focus',
    });
    expect(result.warnings).toBeUndefined();
  });

  it('rbook_sprint(update, status) writes locally without sync warnings on a solo store', async () => {
    createStore({ collab: false, sprintStatus: 'Active' });
    const result = await rbookSprint({
      action: 'update',
      sprintId: 's1',
      fields: { status: 'In Progress' },
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(readRow(dbPath, "SELECT status FROM sprints WHERE id='s1'")).toEqual({
      status: 'In Progress',
    });
    expect(result.warnings).toBeUndefined();
  });

  it('rbook_sprint(complete) keeps the completed local status and discloses retirement', async () => {
    createStore({
      sprintStatus: 'Active',
      extraSql: `
        INSERT INTO contexts (id, source_path, content) VALUES ('project_context', 'p', '{}');
        INSERT INTO missions (id, sprint_id, name, status) VALUES ('m1', 's1', 'Mission 1', 'Completed');`,
    });
    const result = await rbookSprint({
      action: 'complete',
      sprintId: 's1',
      summary: 'done',
      forceComplete: true,
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    expect(readRow(dbPath, "SELECT status FROM sprints WHERE id='s1'")).toEqual({
      status: 'Completed',
    });
    expectRetired(result.warnings);
  });
});
