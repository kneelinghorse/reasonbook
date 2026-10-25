// SPDX-License-Identifier: Apache-2.0
// ABOUTME: An un-migrated sibling must advertise runnable local schema upkeep, not dashboard upload.
// ABOUTME: Execute the advertised calls on an old SQLite store and preserve its existing mission.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { FIREHOSE_TABLES } from '../../../src/types/event-types';
import { rbookReview } from '../../../src/tools/rbook/rbook-review';
import {
  rbookSession,
  rbookSessionSchema,
  type RbookSessionParams,
} from '../../../src/tools/rbook/rbook-session';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const GENESIS_COLUMNS = [
  'project_id',
  'stable_event_id',
  'occurred_at',
  'origin_seq',
  'event_type',
  'schema_version',
];

/** Only the flat, JSON-valued argument syntax printed by the hint; never evaluate its text. */
function sessionCalls(hint: string): RbookSessionParams[] {
  const calls = [...hint.matchAll(/rbook_session\(((?:"(?:[^"\\]|\\.)*"|[^")])*)\)/g)];
  return calls.map((call) => {
    const args: Record<string, unknown> = {};
    const remainder = call[1].replace(
      /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false)/g,
      (_match, key: string, value: string) => {
        args[key] = JSON.parse(value);
        return '';
      }
    );
    expect(remainder.replace(/[\s,]/g, '')).toBe('');
    return rbookSessionSchema.parse(args);
  });
}

it('executes the advertised sibling schema remedy, preserves its mission, and closes its session', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-schema-remedy-'));
  const oldConfig = process.env.RBOOK_CONFIG_DIR;
  const oldUploads = process.env.RBOOK_CHECKPOINT_SYNC;
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  try {
    const localRoot = path.join(tmp, 'local');
    seedRbookDb(localRoot, { projectId: 'local', projectName: 'Local' });
    // Full seed shape, with all eight logged tables predating the per-row migration. A two-column
    // "broken" table proves the warning, but cannot prove a real tool can repair the old record.
    const siblingRoot = path.join(tmp, 'Old "sibling" (copy)');
    const dbPath = seedRbookDb(siblingRoot, { projectId: 'sibling', projectName: 'Old sibling' });
    const db = new Database(dbPath);
    let before: Record<string, unknown>;
    try {
      for (const table of FIREHOSE_TABLES) {
        db.exec(`DROP INDEX IF EXISTS idx_${table}_aggkey`);
        for (const column of GENESIS_COLUMNS) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
      db.prepare(
        `INSERT INTO missions (id, name, status, objective, notes, created_at)
         VALUES ('old-mission', 'Keep the existing work', 'In Progress', ?, ?, ?)`
      ).run(
        'The schema repair must preserve prior work',
        'An existing note',
        new Date().toISOString()
      );
      before = db.prepare('SELECT * FROM missions WHERE id = ?').get('old-mission') as Record<
        string,
        unknown
      >;
      const columns = db.prepare('PRAGMA table_info(missions)').all() as { name: string }[];
      for (const name of GENESIS_COLUMNS)
        expect(columns.map((column) => column.name)).not.toContain(name);
    } finally {
      db.close();
    }

    const registry = await ProjectGraphRegistry.create({ configDir: process.env.RBOOK_CONFIG_DIR });
    registry.register({ project_id: 'local', store_path: localRoot, name: 'Local' });
    registry.register({ project_id: 'sibling', store_path: siblingRoot, name: 'Old sibling' });
    const original = await rbookReview({ projectRoot: localRoot }, { registry });
    expect(original.success).toBe(true);
    expect(original.data?.portfolio?.unmigrated).toBe(1);
    const hint = original.data?.portfolio?.drift?.stale.find(
      (project) => project.projectId === 'sibling'
    )?.hint;
    expect(hint).toBeDefined();
    const calls = sessionCalls(hint!);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      action: 'start',
      type: 'custom',
      autoRefreshMasterContext: false,
      projectRoot: siblingRoot,
    });
    expect(calls[1]).toMatchObject({ action: 'complete', projectRoot: siblingRoot });
    expect(calls[1].sessionId).toBe('<returned sessionId>');

    const started = await rbookSession(calls[0]);
    expect(started.success).toBe(true);
    expect(started.data).toHaveProperty('sessionId');
    const sessionId = (started.data as { sessionId: string }).sessionId;
    const migrated = new Database(dbPath, { readonly: true });
    try {
      const columns = migrated.prepare('PRAGMA table_info(missions)').all() as { name: string }[];
      expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(GENESIS_COLUMNS));
      expect(
        migrated.prepare('SELECT * FROM missions WHERE id = ?').get('old-mission')
      ).toMatchObject(before);
    } finally {
      migrated.close();
    }
    const repaired = await rbookReview({ projectRoot: localRoot }, { registry });
    expect(repaired.success).toBe(true);
    expect(repaired.data?.portfolio).toMatchObject({ unmigrated: 0, unreadable: 0 });
    expect(repaired.data?.portfolio?.activeMissions.top).toContainEqual({
      id: 'old-mission',
      name: 'Keep the existing work',
      projectId: 'sibling',
    });

    const completed = await rbookSession({ ...calls[1], sessionId });
    expect(completed.success).toBe(true);
    const finished = new Database(dbPath, { readonly: true });
    try {
      expect(finished.prepare('SELECT id, status FROM sessions').all()).toEqual([
        { id: sessionId, status: 'completed' },
      ]);
    } finally {
      finished.close();
    }
  } finally {
    ProjectGraphRegistry.resetInstance();
    RbookDetector.resetInstance();
    if (oldConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = oldConfig;
    if (oldUploads === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
    else process.env.RBOOK_CHECKPOINT_SYNC = oldUploads;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
