// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A fresh local record gives sharing guidance before any shared-record command can query it.
// ABOUTME: The same real initialized store proves the CLI refusals, MCP boundary and working share step.
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../../src/cli';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import { readReplicaIdentity } from '../../../src/tools/rbook/replica-identity';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  withClient,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';

let fixture: ReplicaFixture;
let root: string;
beforeEach(async () => {
  fixture = replicaFixture('rbook-unshared-refusals-');
  useMachine(fixture.tmp, 'newcomer');
  root = path.join(fixture.tmp, 'fresh-project');
  fs.mkdirSync(root);
  const initialized = await rbookProjectInit({ projectRoot: root });
  expect(initialized.success).toBe(true);
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

async function command(args: readonly string[]) {
  const output = { stdout: '', stderr: '' };
  const code = await runCli(args, {
    cwd: root,
    env: process.env,
    readStdin: async () => '',
    stdout: (text) => {
      output.stdout += text;
    },
    stderr: (text) => {
      output.stderr += text;
    },
  });
  return { code, ...output };
}

it.each([['set-aside', '--replica', 'gone-copy'], ['sync'], ['move', '--to', 'owner']])(
  'the CLI %j names sharing rather than a query failure on a real freshly initialized store',
  async (...args) => {
    const result = await command(args);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/not shared/i);
    expect(result.stderr).toContain('rbook_project(action="share", authorName="<your name>")');
    expect(result.stderr).toContain('reasonbook share --dashboard');
    expect(result.stderr).not.toMatch(/query failed|SQL syntax|no such table/i);
    expect(await withClient(root, (client) => readReplicaIdentity(client))).toBeNull();
  }
);

it.each(['sync', 'move'] as const)(
  'MCP %s names the share step, and executing it removes the unshared refusal',
  async (action) => {
    const params = { action, projectRoot: root, ...(action === 'move' ? { to: 'owner' } : {}) };
    const result = await call('rbook_project', params);
    expect(result.error).toMatchObject({
      code: 'RECORD_WRITE_REFUSED',
      message: expect.stringMatching(/not shared/i),
      suggestion: expect.stringContaining(
        'rbook_project(action="share", authorName="<your name>")'
      ),
    });
    const shared = await call('rbook_project', {
      action: 'share',
      authorName: 'New Owner',
      projectRoot: root,
    });
    expect(shared.success).toBe(true);
    const retry = await call('rbook_project', params);
    expect(retry.error?.message).toMatch(
      action === 'sync' ? /No member.*route/ : /not shared through a dashboard/
    );
    expect(retry.error?.message).not.toMatch(/query failed|SQL syntax/i);
  }
);

it('a missing metadata table and NULL replica id remain unshared, without querying the change log', async () => {
  const db = new Database(dbOf(root));
  db.exec(
    'ALTER TABLE metadata RENAME TO metadata_saved; CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);'
  );
  db.prepare('INSERT INTO metadata (key, value) VALUES (?, NULL)').run('replica_id');
  db.close();
  await withClient(
    root,
    (client) => {
      expect(() => mergeContext(client)).toThrow(/not shared/i);
      expect(client.execute('DROP TABLE metadata').success).toBe(true);
      expect(() => mergeContext(client)).toThrow(/not shared/i);
    },
    { replicaCheck: false }
  );
});

it('an unreadable identity stays an error rather than being called an unshared project', async () => {
  await withClient(root, (client) => {
    jest.spyOn(client, 'getOne').mockReturnValue({
      success: false,
      error: { code: 'DB_QUERY_FAILED', message: 'Identity read unavailable.' },
    });
    expect(() => mergeContext(client)).toThrow(/Identity read unavailable/);
    expect(() => mergeContext(client)).not.toThrow(/not shared/i);
  });
});
