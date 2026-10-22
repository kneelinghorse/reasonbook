// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises schema refusals and null preservation through the built server's MCP transport.
// ABOUTME: A null retention setting must preserve snapshots and valid nested nulls must still clear.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { seedRbookDb } from '../helpers/seedRbookDb';
import { connectStdioServer, type StdioHarness } from './stdio-harness';
import { constraintKey, dispatchConstraints, violatingCall } from '../helpers/dispatch-constraints';

let root: string;
let dbPath: string;
let harness: StdioHarness;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-schema-stdio-'));
  dbPath = seedRbookDb(root, { projectId: 'schema-stdio' });
  const db = new Database(dbPath);
  db.prepare('INSERT INTO missions(id,name,status,notes,created_at) VALUES (?,?,?,?,?)').run(
    'm',
    'Mission',
    'Queued',
    'Keep until explicitly cleared.',
    new Date().toISOString()
  );
  db.close();
  harness = await connectStdioServer({
    serverPath: path.resolve(__dirname, '../../dist/index.js'),
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      RBOOK_CONFIG_DIR: path.join(root, 'config'),
      RBOOK_PROJECT_ROOT: root,
      RBOOK_CHECKPOINT_SYNC: 'off',
      RBOOK_SHARED_SYNC: 'off',
      RBOOK_DASHBOARD_URL: 'http://127.0.0.1:9',
    },
  });
});
afterAll(async () => {
  await harness?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

it('refuses a sample of every rejectable constraint kind over real MCP before project resolution', async () => {
  const kinds = new Set<string>();
  const samples = dispatchConstraints().filter((row) => {
    if (row.kind.startsWith('desc-') || kinds.has(row.kind) || violatingCall(row) === undefined)
      return false;
    kinds.add(row.kind);
    return true;
  });
  expect(kinds.size).toBe(10);
  const missing = path.join(root, 'no-project');
  for (const row of samples) {
    const result = await harness.callTool(row.tool, {
      ...violatingCall(row),
      projectRoot: missing,
    });
    expect({ key: constraintKey(row), code: result.structuredContent?.error?.code }).toEqual({
      key: constraintKey(row),
      code: 'INVALID_PARAMETER',
    });
    expect(result.structuredContent?.error?.suggestion).toBeTruthy();
  }
  expect(fs.existsSync(missing)).toBe(false);
});

it('treats maxSnapshots=null as omitted before retention can delete any existing snapshot', async () => {
  const snapshots = path.join(root, 'rbook', 'db', 'snapshots');
  fs.mkdirSync(snapshots, { recursive: true });
  for (let i = 0; i < 3; i++)
    fs.copyFileSync(dbPath, path.join(snapshots, `snapshot-kept-${i}.sqlite`));
  const before = fs.readdirSync(snapshots).filter((file) => file.endsWith('.sqlite'));
  const result = await harness.callTool('rbook_db', {
    action: 'snapshot',
    maxSnapshots: null,
    projectRoot: root,
  });
  expect(result.structuredContent?.success).toBe(true);
  const after = fs.readdirSync(snapshots).filter((file) => file.endsWith('.sqlite'));
  expect(after).toHaveLength(before.length + 1);
  expect(after).toEqual(expect.arrayContaining(before));
});

it('preserves explicit nested note clearing while refusing unsupported nested nulls', async () => {
  const clear = await harness.callTool('rbook_mission', {
    action: 'update',
    missionId: 'm',
    fields: { notes: null },
    projectRoot: root,
  });
  expect(clear.structuredContent?.success).toBe(true);
  const db = new Database(dbPath, { readonly: true });
  try {
    expect(db.prepare('SELECT notes FROM missions WHERE id=?').get('m')).toEqual({ notes: null });
  } finally {
    db.close();
  }
  const refuse = await harness.callTool('rbook_sprint', {
    action: 'update',
    sprintId: 's',
    fields: { focus: null },
    projectRoot: root,
  });
  expect(refuse.structuredContent?.error).toMatchObject({
    code: 'INVALID_PARAMETER',
    field: 'fields.focus',
  });
});
