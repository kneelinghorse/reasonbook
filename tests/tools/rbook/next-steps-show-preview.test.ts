// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Next-step retrieval stays small until an agent explicitly expands named historical rows.
// ABOUTME: Real-store router checks preserve spin-out pointers and prove reads never change records.
import Database from 'better-sqlite3';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { usedIds } from '../../../src/tools/rbook/telemetry-extract';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookContext } from '../../../src/tools/rbook/rbook-context';
import {
  formatNextStepsForLLM,
  type NextStepsResult,
} from '../../../src/tools/rbook/rbook-next-steps';
import type { RbookToolResult } from '../../../src/tools/rbook/types';

let root: string;
let dbPath: string;
let db: Database.Database;
const long = 'A full account of the remaining work.\n' + 'The rationale matters. '.repeat(40);
const call = (args: Record<string, unknown> = {}) =>
  rbookContext({ action: 'next_steps', projectRoot: root, ...args } as Parameters<
    typeof rbookContext
  >[0]) as Promise<RbookToolResult<NextStepsResult>>;
function add(content: string, status = 'pending'): number {
  return Number(
    db
      .prepare('INSERT INTO next_steps(content,status,created_at) VALUES (?,?,?)')
      .run(content, status, new Date(Date.now() - 1000).toISOString()).lastInsertRowid
  );
}
function snapshot(): string {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as { name: string }[];
  return JSON.stringify(
    tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()])
  );
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-next-show-'));
  dbPath = seedRbookDb(root);
  db = new Database(dbPath);
  RbookDetector.resetInstance();
  await call(); // Existing idempotent migration boundary; the assertion covers record writes.
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
  RbookDetector.resetInstance();
});

test('plain list bounds each content and truthfully marks full length; show expands exact original words', async () => {
  const id = add(long);
  const short = add('Short task.');
  const before = snapshot();
  const listed = await call();
  expect(listed.success).toBe(true);
  expect(listed.data?.items?.find((row) => row.id === id)).toMatchObject({
    truncated: true,
    fullLength: long.length,
  });
  expect(listed.data?.items?.find((row) => row.id === id)?.content.length).toBeLessThanOrEqual(300);
  expect(listed.data?.items?.find((row) => row.id === short)).toMatchObject({
    content: 'Short task.',
    truncated: false,
    fullLength: 11,
  });
  expect(formatNextStepsForLLM(listed)).toContain('nextStepAction="show"');
  const shown = await call({ nextStepAction: 'show', nextStepIds: [id] });
  expect(shown.success).toBe(true);
  expect(shown.data?.items).toEqual([
    expect.objectContaining({ id, content: long, truncated: false, fullLength: long.length }),
  ]);
  expect(formatNextStepsForLLM(shown)).toContain(long);
  expect(snapshot()).toBe(before);
});

test('explicit IDs preserve completed, dropped, carried and spun-out lookup while show ignores list filters', async () => {
  const ids = ['completed', 'dropped', 'carried', 'pending'].map((status) => add(long, status));
  const pointer = {
    operationId: 'op-fixture',
    sourceProjectId: 'source',
    sourceRoot: root,
    sourceId: ids[3],
    targetProjectId: 'target',
    targetRoot: '/scratch/target',
    targetId: 21,
  };
  db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(
    `spin_out_row:next-step:${ids[3]}`,
    JSON.stringify(pointer)
  );
  expect((await call()).data?.items?.map((row) => row.id)).toEqual([ids[2]]);
  const lookup = await call({ nextStepIds: ids });
  expect(lookup.data?.items).toHaveLength(4);
  expect(lookup.data?.items?.find((row) => row.id === ids[3])?.spunOutTo).toEqual(pointer);
  const shown = await call({
    nextStepAction: 'show',
    nextStepIds: ids,
    nextStepStatus: 'pending',
    missionId: 'different',
  });
  expect(shown.success).toBe(true);
  expect(shown.data?.items).toHaveLength(4);
  expect(shown.data?.items?.every((row) => row.content === long)).toBe(true);
  expect(formatNextStepsForLLM(shown)).toContain('Spun out:');
});

test('show names missing IDs in mixed and empty results, without claiming a write failed', async () => {
  const id = add('Known');
  const mixed = await call({ nextStepAction: 'show', nextStepIds: [id, 999, 999] });
  expect(mixed.success).toBe(true);
  expect(mixed.data).toMatchObject({ affected: 1, missingIds: [999] });
  expect(formatNextStepsForLLM(mixed)).toContain('Not found: #999');
  expect(formatNextStepsForLLM(mixed)).not.toContain('WRITE FAILURE');
  const missing = await call({ nextStepAction: 'show', nextStepIds: [999] });
  expect(missing.data).toMatchObject({ items: [], affected: 0, missingIds: [999] });
  expect(formatNextStepsForLLM(missing)).toContain('Not found: #999');
});

test.each([undefined, [], null, '1', [0], [-1], [1.5], ['1'], [Number.MAX_SAFE_INTEGER + 1]])(
  'show refuses invalid IDs %j before any record changes',
  async (nextStepIds) => {
    const before = snapshot();
    const result = await call({ nextStepAction: 'show', nextStepIds });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe(
      nextStepIds === undefined || (Array.isArray(nextStepIds) && nextStepIds.length === 0)
        ? 'MISSING_PARAMETER'
        : 'INVALID_PARAMETER'
    );
    expect(result.error?.suggestion).toBeTruthy();
    expect(snapshot()).toBe(before);
  }
);

test('empty explicit list remains empty and explicit status filters remain effective', async () => {
  const id = add(long, 'completed');
  expect((await call({ nextStepIds: [] })).data?.items).toEqual([]);
  expect((await call({ nextStepIds: [id], nextStepStatus: 'pending' })).data?.items).toEqual([]);
});

test('explicit expansion counts only returned local rows as use; listing and missing IDs do not', () => {
  const result = {
    success: true,
    data: {
      localProjectId: 'here',
      items: [
        { id: 1, projectId: null },
        { id: 2, projectId: 'here' },
        { id: 3, projectId: 'elsewhere' },
      ],
      missingIds: [4],
    },
  };
  const args = { action: 'next_steps', nextStepAction: 'show', nextStepIds: [1, 2, 3, 4] };
  expect(usedIds('rbook_context', args, 'write', result)).toEqual(['n:1', 'n:2']);
  expect(usedIds('rbook_context', { ...args, nextStepAction: 'list' }, 'write', result)).toEqual(
    []
  );
  expect(usedIds('rbook_context', args, 'write', { ...result, success: false })).toEqual([]);
});

test('actual show rows keep origin namespaces so foreign next-step IDs never count as local use', async () => {
  const ids = [add('Local'), add('Foreign'), add('Historical unknown origin')];
  const localProjectId = (
    db.prepare("SELECT value FROM metadata WHERE key='project_id'").get() as { value: string }
  ).value;
  db.prepare('UPDATE next_steps SET project_id=? WHERE id=?').run(localProjectId, ids[0]);
  db.prepare('UPDATE next_steps SET project_id=? WHERE id=?').run('foreign-origin', ids[1]);
  const before = snapshot();
  const args = { action: 'next_steps', nextStepAction: 'show', nextStepIds: [...ids, 999] };
  const result = await call(args);
  expect(result.success).toBe(true);
  expect(usedIds('rbook_context', args, 'write', result)).toEqual([`n:${ids[0]}`, `n:${ids[2]}`]);
  expect(result.data).toMatchObject({
    localProjectId,
    items: [
      { id: ids[0], projectId: localProjectId },
      { id: ids[1], projectId: 'foreign-origin' },
      { id: ids[2], projectId: null },
    ],
  });
  expect(snapshot()).toBe(before);
});

test('a next-step store predating project_id stays readable without adding the column', async () => {
  const id = add('Historical row');
  db.exec('DROP INDEX idx_next_steps_aggkey; ALTER TABLE next_steps DROP COLUMN project_id');
  const before = snapshot();
  const args = { action: 'next_steps', nextStepAction: 'show', nextStepIds: [id] };
  const result = await call(args);
  expect(result.success).toBe(true);
  expect(result.data?.items).toEqual([expect.objectContaining({ id, projectId: null })]);
  expect(usedIds('rbook_context', args, 'write', result)).toEqual([`n:${id}`]);
  expect(
    (db.prepare('PRAGMA table_info(next_steps)').all() as { name: string }[]).map((row) => row.name)
  ).not.toContain('project_id');
  expect(snapshot()).toBe(before);
});

test('failed origin schema inspection is disclosed instead of classifying foreign rows as local', async () => {
  const id = add('Origin must remain known');
  const original = RbookDatabaseClient.prototype.getMany;
  const read = jest.spyOn(RbookDatabaseClient.prototype, 'getMany').mockImplementation(function <T>(
    this: RbookDatabaseClient,
    sql: string,
    params?: Parameters<RbookDatabaseClient['getMany']>[1]
  ): RbookToolResult<T[]> {
    if (sql === 'PRAGMA table_info(next_steps)')
      return {
        success: false,
        error: { code: 'DB_QUERY_FAILED', message: 'forced origin schema failure' },
      };
    return original.call(this, sql, params) as RbookToolResult<T[]>;
  });
  try {
    const args = { action: 'next_steps', nextStepAction: 'show', nextStepIds: [id] };
    const result = await call(args);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('origin metadata');
    expect(result.error?.suggestion).toBeTruthy();
    expect(usedIds('rbook_context', args, 'write', result)).toEqual([]);
  } finally {
    read.mockRestore();
  }
});
