// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real initialized stores exercise concise status, project freshness preferences and first-write answers.
// ABOUTME: Upload history remains visible when meaningful and a pristine local project stays quiet.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { rbookMissionStatus } from '../../../src/tools/rbook/rbook-mission-status';
import { rbookReview } from '../../../src/tools/rbook/rbook-review';
import { rbookSprintComplete } from '../../../src/tools/rbook/rbook-sprint-complete';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { formatSharedProjectForLLM } from '../../../src/tools/rbook/rbook-project-shared';
import {
  resetFirstWriteMaintenance,
  runFirstWriteMaintenance,
} from '../../../src/tools/rbook/first-write-maintenance';
import { readDashboardUploadStatus } from '../../../src/tools/rbook/dashboard-upload-scheduler';

let root: string;
let dbPath: string;
let protocol: Awaited<ReturnType<typeof buildMissionProtocolContext>>;

beforeAll(async () => {
  protocol = await buildMissionProtocolContext();
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-m12-answers-'));
  const initialized = await rbookProjectInit({
    projectRoot: root,
    projectName: 'Answer contracts',
    projectType: 'build',
  });
  expect(initialized.success).toBe(true);
  dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
  resetFirstWriteMaintenance();
});

afterEach(() => {
  resetFirstWriteMaintenance();
  RbookDetector.resetInstance();
  fs.rmSync(root, { recursive: true, force: true });
});

function withDb(work: (db: Database.Database) => void): void {
  const db = new Database(dbPath);
  try {
    work(db);
  } finally {
    db.close();
  }
}

function activeSprint(): void {
  withDb((db) => {
    db.prepare('INSERT INTO sprints(id,title,focus,status) VALUES (?,?,?,?)').run(
      'sprint-answer',
      'Answer sprint',
      'One copy of this focus',
      'Active'
    );
  });
}

async function freshnessPreference(value: unknown): Promise<void> {
  const updated = await executeMissionProtocolTool(
    'rbook_context',
    {
      action: 'update',
      contextType: 'project_identity',
      projectRoot: root,
      fieldUpdates: [{ path: 'type_fields.build_freshness_check', value }],
    },
    protocol
  );
  expect(updated.isError).not.toBe(true);
  expect(updated.structuredContent).toMatchObject({ success: true });
}

function staleSource(): void {
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'export const value = 1;\n');
}

it('status carries the sprint focus once while retaining null in each mission sprint', async () => {
  activeSprint();
  withDb((db) => {
    const add = db.prepare('INSERT INTO missions(id,name,status,sprint_id) VALUES (?,?,?,?)');
    add.run('answer-1', 'First', 'In Progress', 'sprint-answer');
    add.run('answer-2', 'Second', 'Queued', 'sprint-answer');
  });
  const result = await rbookMissionStatus({ projectRoot: root });
  expect(result.success).toBe(true);
  expect(result.data?.activeSprint?.focus).toBe('One copy of this focus');
  for (const mission of [...(result.data?.inProgress ?? []), ...(result.data?.queued ?? [])]) {
    expect(mission.sprint).toHaveProperty('focus', null);
  }
  expect(JSON.stringify(result.data).split('One copy of this focus')).toHaveLength(2);
});

it('review honors a stored opt-out before walking a source-running project', async () => {
  staleSource();
  await freshnessPreference(false);
  const walk = jest.spyOn(fs.promises, 'readdir');
  try {
    const result = await rbookReview({ projectRoot: root }, { offline: true });
    expect(result.success).toBe(true);
    expect(result.data?.buildFreshness).toBeUndefined();
    expect(result.data?.next_actions.some((action) => action.command === 'npm run build')).toBe(
      false
    );
    expect(walk).not.toHaveBeenCalledWith(path.join(root, 'src'));
  } finally {
    walk.mockRestore();
  }
});

it.each([true, null, 'false'])(
  'only explicit boolean false opts out; %p keeps the stale-source warning',
  async (value) => {
    staleSource();
    await freshnessPreference(value);
    const result = await rbookReview({ projectRoot: root }, { offline: true });
    expect(result.success).toBe(true);
    expect(result.data?.buildFreshness?.stale).toBe(true);
  }
);

it('sprint close honors the same stored opt-out without suppressing its runtime receipt', async () => {
  activeSprint();
  staleSource();
  await freshnessPreference(false);
  const result = await rbookSprintComplete({
    projectRoot: root,
    sprintId: 'sprint-answer',
    summary: 'Source runs directly',
  });
  expect(result.success).toBe(true);
  expect(result.data?.buildFreshness).toBeUndefined();
  expect(result.warnings?.join('\n') ?? '').not.toMatch(
    /Build is stale|dist\/ is missing|Server is running stale code/
  );
  expect(result.data).toHaveProperty('startupBuildTime');
  expect(result.data).toHaveProperty('driftMinutes');
});

it('the seed starts current, so its first upkeep has no legacy blob migration to announce', async () => {
  const notes = await runFirstWriteMaintenance(root);
  expect(notes.join('\n')).not.toContain('Migrated the stored master_context');
  withDb((db) => {
    const raw = db
      .prepare("SELECT content FROM contexts WHERE id='master_context'")
      .pluck()
      .get() as string;
    for (const retired of [
      'completed_missions',
      'completed_sprints',
      'decisions_made',
      'learnings',
      'recent_sessions',
    ]) {
      expect(JSON.parse(raw)).not.toHaveProperty(retired);
    }
    expect(
      db.prepare("SELECT value FROM metadata WHERE key='blob_schema_version'").pluck().get()
    ).toBe('1');
  });
});

it('a pristine project has no upload status, but actual upload debt remains visible', async () => {
  const graph = await ProjectGraphRegistry.create();
  const id = graph.getByStorePath(root);
  expect(id).toBeTruthy();
  expect(await readDashboardUploadStatus(root)).toBeNull();
  expect(graph.markUploadOwed(id!)).toBe(true);
  expect(await readDashboardUploadStatus(root)).toContain('pending');
});

it('sharing does not call excluded search/context data nothing when no table rows are omitted', () => {
  const text = formatSharedProjectForLLM('share', {
    success: true,
    data: { plan: { dashboard: 'example.test', up: { missions: 1 }, stays: {} } },
  } as never);
  expect(text).toContain('leaves out the search index and the other context documents');
  expect(text).not.toContain('leaves out nothing');
});

it('moving back names the catch-up and member confirmation before claiming they sync directly', () => {
  const text = formatSharedProjectForLLM('move', {
    success: true,
    data: { dashboard: 'example.test', epoch: 2 },
  } as never);
  expect(text).toMatch(/catch.*up/i);
  expect(text).toContain('reasonbook sync --confirm-owner');
  expect(text).not.toContain('Members sync with this copy directly from now on');
});
