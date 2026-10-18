// ABOUTME: Project identity edits remain local after legacy dashboard propagation is retired.
// ABOUTME: Collaborative stores disclose retirement; solo and unrelated-field edits stay quiet.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rbookContext } from '../../../src/tools/rbook/rbook-context';
import { maybePropagateProjectIdentity } from '../../../src/tools/rbook/sync-locks';
import { formatProjectIdentityUpdateForLLM } from '../../../src/tools/rbook/rbook-context-project-identity';
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

describe('project identity after legacy sync retirement', () => {
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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-pidsync-test-'));
    fs.mkdirSync(path.join(tempDir, 'rbook', 'db'), { recursive: true });
    dbPath = path.join(tempDir, 'rbook', 'db', 'rbook.sqlite');

    RbookDetector.resetInstance();
    fetchMock.mockReset();
    previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock;
    fetchMock.mockRejectedValue(new Error('Retired propagation must not reach the dashboard.'));
  });

  afterEach(() => {
    globalThis.fetch = previousFetch;
    for (const [k, v] of Object.entries(ENV_BACKUP)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  function createStore(opts: { collab?: boolean; name?: string; extraSql?: string } = {}): void {
    const db = new Database(dbPath);
    db.exec(seedSchema);
    db.exec(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', 'proj-test');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', '${opts.name ?? 'My Project'}');
      INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_slug', '${SLUG}');
      ${opts.collab !== false ? `INSERT OR REPLACE INTO metadata (key, value) VALUES ('collab_role', 'editor');` : ''}
      INSERT INTO contexts (id, source_path, content) VALUES ('master_context', 'm', '{}');
      ${opts.extraSql ?? ''}
    `);
    db.close();
  }

  // ─── maybePropagateProjectIdentity (the dispatcher hook, tested directly) ───────

  it('keeps the successful local result and discloses the retired propagation remedy', async () => {
    createStore({ name: 'My Project' });
    const out = await maybePropagateProjectIdentity(createSuccess({ ok: true }), tempDir);
    expect(out.success).toBe(true);
    expect(out.data).toEqual({ ok: true });
    expectRetired(out.warnings);
  });

  it('is a NO-OP on a SOLO store (no collab_role) — no emit, no warnings, no fetch', async () => {
    createStore({ collab: false, name: 'My Project' });
    const out = await maybePropagateProjectIdentity(createSuccess({ ok: true }), tempDir);
    expect(out.success).toBe(true);
    expect(out.warnings).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discloses retirement even when the old mutable-name cache matches the current name', async () => {
    createStore({
      name: 'My Project',
      extraSql: `INSERT INTO metadata (key, value) VALUES ('mutable_status:project_identity:project', '${JSON.stringify(
        { status: 'My Project', occurredAt: Date.now(), originSeq: 1, authorUserId: null }
      ).replace(/'/g, "''")}');`,
    });
    const out = await maybePropagateProjectIdentity(createSuccess({ ok: true }), tempDir);
    expect(out.success).toBe(true);
    expectRetired(out.warnings);
  });

  it('preserves earlier warnings and does not duplicate retirement on repeated hooks', async () => {
    createStore({ name: 'My Project' });
    const result = createSuccess({ ok: true }, ['Earlier local warning']);
    const first = await maybePropagateProjectIdentity(result, tempDir);
    const repeated = await maybePropagateProjectIdentity(first, tempDir);
    expect(repeated.success).toBe(true);
    expect(repeated.warnings).toContain('Earlier local warning');
    expectRetired(repeated.warnings);
  });

  it('formatProjectIdentityUpdateForLLM renders retirement and its remedy', () => {
    const formatted = formatProjectIdentityUpdateForLLM({
      success: true,
      data: {
        fieldsUpdated: ['project_name'],
        message: 'Updated 1 field(s) in project_identity.',
      } as unknown as Parameters<typeof formatProjectIdentityUpdateForLLM>[0]['data'],
      warnings: [`${RETIRED}: The local edit is kept. Use reasonbook sync.`],
    });
    expect(formatted).toContain('Warnings:');
    expect(formatted).toContain(RETIRED);
    expect(formatted).toContain('reasonbook sync');
  });

  // ─── rbook_context dispatcher wiring ─────────────────────────────────────────────

  it('rbook_context(project_name update) writes locally and warns on a collab store', async () => {
    createStore({ name: 'Old Name' });
    const result = await rbookContext({
      action: 'update',
      contextType: 'project_identity',
      fieldUpdates: [{ path: 'project_name', value: 'Renamed Project' }],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    const identity = JSON.parse(
      String(readRow(dbPath, "SELECT content FROM contexts WHERE id='project_identity'").content)
    );
    expect(identity.project_name).toBe('Renamed Project');
    expectRetired(result.warnings);
  });

  it('rbook_context(update) without project_name keeps the propagation guard', async () => {
    createStore({ name: 'My Project' });
    const result = await rbookContext({
      action: 'update',
      contextType: 'project_identity',
      fieldUpdates: [{ path: 'description', value: 'a new description' }],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    const identity = JSON.parse(
      String(readRow(dbPath, "SELECT content FROM contexts WHERE id='project_identity'").content)
    );
    expect(identity).toMatchObject({
      project_name: 'My Project',
      description: 'a new description',
    });
    expect(result.warnings).toBeUndefined();
  });

  it('rbook_context(project_name update) writes locally without sync warnings on a solo store', async () => {
    createStore({ collab: false, name: 'Old Name' });
    const result = await rbookContext({
      action: 'update',
      contextType: 'project_identity',
      fieldUpdates: [{ path: 'project_name', value: 'Renamed Project' }],
      projectRoot: tempDir,
    });
    expect(result.success).toBe(true);
    const identity = JSON.parse(
      String(readRow(dbPath, "SELECT content FROM contexts WHERE id='project_identity'").content)
    );
    expect(identity.project_name).toBe('Renamed Project');
    expect(result.warnings).toBeUndefined();
  });
});
