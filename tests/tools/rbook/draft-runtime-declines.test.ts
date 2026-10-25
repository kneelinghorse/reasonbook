// SPDX-License-Identifier: Apache-2.0
// ABOUTME: An unsettled decline outlives session cleanup without retaining the operator's words.
// ABOUTME: Only explicit settlement clears its store-local draft identifier and first answer time.
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as runtimeApi from '../../../src/tools/rbook/draft-runtime';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

let tmp: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
let runtime: runtimeApi.DraftRuntime;
const session = '0123456789abcdef';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-runtime-decline-'));
  const root = path.join(tmp, 'project');
  fs.mkdirSync(root);
  dbPath = seedRbookDb(root, { projectName: 'declines' });
  reidentifyRbookTestStore(root);
  env = { RBOOK_CONFIG_DIR: path.join(tmp, 'config') };
  runtime = runtimeApi.openDraftRuntime(dbPath, env)!;
});
afterEach(() => {
  runtime.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it('stores only a draft id and first decline time, without session identifiers or words', () => {
  const columns = runtime.db.prepare('PRAGMA table_info(pending_declines)').all() as Array<{
    name: string;
  }>;
  expect(columns.map((row) => row.name)).toEqual(['draft_id', 'at']);
  const at = Date.now();
  runtimeApi.retainDeclines(runtime, [7, 8], at);
  runtimeApi.retainDeclines(runtime, [7], at + 1000);
  expect(runtimeApi.pendingDeclines(runtime)).toEqual([
    { id: 7, at },
    { id: 8, at },
  ]);
});

it.each(['new start', 'SessionEnd', 'two-hour prune', 'seven-day prune'])(
  '%s cannot erase an unsettled decline',
  (action) => {
    const at = Date.now();
    runtimeApi.retainDeclines(runtime, [7], at);
    runtimeApi.bindExcerpt(runtime, session, [7], 'no', 'decline', at, { late: true });
    if (action === 'new start') runtimeApi.recordSessionStart(runtime, session, at + 1);
    if (action === 'SessionEnd') runtimeApi.endDraftSession(runtime, session);
    if (action === 'two-hour prune')
      runtimeApi.pruneAllRuntimes(env, at + runtimeApi.EXCERPT_TTL_MS);
    if (action === 'seven-day prune') runtimeApi.pruneAllRuntimes(env, at + 7 * 86_400_000 + 1);
    expect(runtimeApi.pendingDeclines(runtime)).toEqual([{ id: 7, at }]);
    expect(runtime.db.prepare('SELECT * FROM excerpts').all()).toEqual([]);
  }
);

it('clear settles only the requested draft ids and is idempotent', () => {
  const at = Date.now();
  runtimeApi.retainDeclines(runtime, [7, 8], at);
  runtimeApi.clearPendingDeclines(runtime, [7, 99]);
  runtimeApi.clearPendingDeclines(runtime, [7]);
  expect(runtimeApi.pendingDeclines(runtime)).toEqual([{ id: 8, at }]);
});

it('another session can see the store-local pending decline through a read-only open', () => {
  const at = Date.now();
  runtimeApi.retainDeclines(runtime, [7], at);
  const reader = runtimeApi.openDraftRuntime(dbPath, env, { readonly: true })!;
  try {
    expect(runtimeApi.pendingDeclines(reader)).toEqual([{ id: 7, at }]);
  } finally {
    reader.close();
  }
});

it('an old read-only runtime without the table reads empty and remains unchanged', () => {
  runtime.db.exec('DROP TABLE IF EXISTS pending_declines');
  const hash = () => createHash('sha256').update(fs.readFileSync(runtime.path)).digest('hex');
  const before = hash();
  const reader = runtimeApi.openDraftRuntime(dbPath, env, { readonly: true })!;
  try {
    expect(runtimeApi.pendingDeclines(reader)).toEqual([]);
  } finally {
    reader.close();
  }
  expect(hash()).toBe(before);
});
