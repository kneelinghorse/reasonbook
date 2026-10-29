// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real-store dispatch observations remain once-per-call and scoped under concurrent requests.
// ABOUTME: Refusals and thrown errors still count, while telemetry failures cannot change tool results.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import Database from 'better-sqlite3';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import { holdStore } from '../../helpers/store-lock-holder';
import { withMcpTelemetry, noteTelemetryProject } from '../../../src/tools/rbook/telemetry-call';
import { readTelemetry, targetForStore } from '../../../src/tools/rbook/local-telemetry';
import { setProcessBusyTimeout } from '../../../src/tools/rbook/sqlite-busy';
import { openDraftRuntime, recordSessionStart } from '../../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../../src/tools/rbook/harness-session';
import { withCodexRequest } from '../../../src/codex-request-context';

let dir: string;
let project: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-call-telemetry-'));
  project = path.join(dir, 'project');
  dbPath = seedRbookDb(project);
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(dir, 'config') };
});
afterEach(() => {
  setProcessBusyTimeout(null);
  fs.rmSync(dir, { recursive: true, force: true });
});
const unattributed = () =>
  readTelemetry(
    { projectId: 'unattributed', dbPath: path.join(env.RBOOK_CONFIG_DIR!, 'unattributed.sqlite') },
    env
  );
/**
 * Another process holds the store exclusively from before the call's observation until `afterMs`
 * after the call's last step, which is immediately before the observation's identity lookup.
 */
async function callWhileHeld(afterMs: number, client = 'held/1') {
  const marker = path.join(dir, 'lookup-marker');
  const hold = holdStore(dbPath, { marker, afterMarkerMs: afterMs });
  try {
    await hold.held;
    const result = { structuredContent: { success: true } };
    const value = await withMcpTelemetry(
      { name: 'rbook_review', args: { projectRoot: project }, mode: 'read', client, env },
      async () => {
        fs.writeFileSync(marker, '');
        return result;
      }
    );
    expect(value).toBe(result);
  } finally {
    await hold.stop();
  }
}

it.each([null, 'scalar', 42, ['array']])(
  'preserves SDK v2 structured content %p without assuming an object',
  async (payload) => {
    const result = { structuredContent: payload };
    expect(
      await withMcpTelemetry(
        { name: 'rbook_review', args: { projectRoot: project }, mode: 'read', client: null, env },
        async () => result
      )
    ).toBe(result);
    expect(readTelemetry(targetForStore(dbPath)!, env)).toHaveLength(1);
  }
);

it('records one successful read, including returned typed IDs, without changing the store', async () => {
  const before = fs.readFileSync(dbPath);
  const result = { structuredContent: { success: true, data: { id: 7 } }, isError: false };
  const value = await withMcpTelemetry(
    {
      name: 'rbook_learnings',
      args: { action: 'show', learningId: 7 },
      mode: 'read',
      client: 'codex/1',
      env,
    },
    async () => {
      noteTelemetryProject(project);
      return result;
    }
  );
  expect(value).toBe(result);
  const records = readTelemetry(targetForStore(dbPath)!, env);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    surface: 'mcp',
    mode: 'read',
    ok: true,
    idsReturned: ['l:7'],
    idsCited: ['l:7'],
  });
  expect(fs.readFileSync(dbPath)).toEqual(before);
});

it('records refusal and exception once each and never counts their intended citations', async () => {
  const options = {
    name: 'rbook_decisions',
    args: { projectRoot: project, action: 'record', content: 'private #7' },
    mode: 'write' as const,
    client: 'codex/1',
    env,
  };
  await withMcpTelemetry(options, async () => ({
    isError: true,
    structuredContent: { success: false, error: { code: 'REFUSED' } },
  }));
  const error = new Error('private failure');
  await expect(
    withMcpTelemetry(options, async () => {
      throw error;
    })
  ).rejects.toBe(error);
  const records = readTelemetry(targetForStore(dbPath)!, env);
  expect(records).toHaveLength(2);
  expect(records.map((r) => r.refused)).toEqual(['REFUSED', 'TOOL_EXECUTION_ERROR']);
  expect(records.every((r) => !r.ok && r.idsCited?.length === 0)).toBe(true);
  expect(JSON.stringify(records)).not.toContain('private');
});

it('does not leak a concurrent request target into another project', async () => {
  const other = path.join(dir, 'other');
  const otherDb = seedRbookDb(other);
  const result = { structuredContent: { success: true } };
  await Promise.all(
    [project, other].map((root) =>
      withMcpTelemetry(
        { name: 'rbook_review', args: {}, mode: 'read', client: null, env },
        async () => {
          noteTelemetryProject(root);
          await new Promise((resolve) => setImmediate(resolve));
          return result;
        }
      )
    )
  );
  expect(readTelemetry(targetForStore(dbPath)!, env)).toHaveLength(1);
  expect(readTelemetry(targetForStore(otherDb)!, env)).toHaveLength(1);
});

it('does not change the result when the configured telemetry location is unwritable', async () => {
  const file = path.join(dir, 'not-a-directory');
  fs.writeFileSync(file, 'occupied');
  const result = { structuredContent: { success: true } };
  expect(
    await withMcpTelemetry(
      {
        name: 'rbook_review',
        args: { projectRoot: project },
        mode: 'read',
        client: null,
        env: { RBOOK_CONFIG_DIR: file },
      },
      async () => result
    )
  ).toBe(result);
});

it.each([
  ['number', 12345],
  ['object', { private: 'not a folder' }],
  ['array', ['not a folder']],
  ['boolean', true],
])(
  'observes a %s projectRoot without validating or changing the tool response',
  async (_type, projectRoot) => {
    const before = fs.readFileSync(dbPath);
    const result = {
      structuredContent: { success: true, data: { unchanged: 'operation result' } },
    };
    const operation = jest.fn(async () => result);
    const value = await withMcpTelemetry(
      { name: 'rbook_review', args: { projectRoot }, mode: 'read', client: null, env },
      operation
    );
    expect(operation).toHaveBeenCalledTimes(1);
    expect(value).toBe(result);
    expect(value).toEqual({
      structuredContent: { success: true, data: { unchanged: 'operation result' } },
    });
    expect(readTelemetry(targetForStore(dbPath)!, env)).toEqual([]);
    const anonymous = readTelemetry(
      {
        projectId: 'unattributed',
        dbPath: path.join(env.RBOOK_CONFIG_DIR!, 'unattributed.sqlite'),
      },
      env
    );
    expect(anonymous).toEqual([
      expect.objectContaining({ tool: 'rbook_review', ok: true, refused: null }),
    ]);
    expect(fs.readFileSync(dbPath)).toEqual(before);
  }
);

// s105-m03. An observation must be as tolerant of a held store as the call it observes: the call's
// own client waits processBusyTimeout() ?? 5000 ms for a held store, but the identity lookup in the
// telemetry finally gave up after 100 ms, so a call that succeeded had its row filed as unattributed.
// This reproduces, end to end, the symptom of the 4.7.1 gate's missing row; that it caused that
// failure is not established.
it("waits out a store held for 1 s after the call, and keeps the call's row in its project", async () => {
  await callWhileHeld(1000);
  expect(readTelemetry(targetForStore(dbPath)!, env)).toEqual([
    expect.objectContaining({ client: 'held/1', ok: true }),
  ]);
  expect(unattributed()).toEqual([]);
});

it.each([
  ['above the hold, so the row stays in its project', 4000, 1000, 'project'],
  [
    'below a hold that outlasts the lookup, so the row is unattributed',
    250,
    30_000,
    'unattributed',
  ],
] as const)(
  'takes its budget from the process busy timeout when one is set: %s',
  async (_case, budgetMs, holdMs, bucket) => {
    // Where a process budget is set the observation keeps to it; in the server none is set, so it
    // is 5,000 ms. Past the budget the row is best-effort, filed as unattributed, and the call's
    // result is unchanged. Only the first case fails a fixed 100 ms lookup; neither tells a set
    // budget from the 5,000 ms default, which the instruments' anchor and `budgetMs: 300` pin.
    setProcessBusyTimeout(budgetMs);
    await callWhileHeld(holdMs);
    setProcessBusyTimeout(null);
    expect(readTelemetry(targetForStore(dbPath)!, env)).toHaveLength(bucket === 'project' ? 1 : 0);
    expect(unattributed()).toHaveLength(bucket === 'unattributed' ? 1 : 0);
  }
);

it("keeps a Codex call's row with a null session when its draft runtime is held", async () => {
  // The Codex owner lookup keeps its own 100 ms budget; its failure now costs the row only its
  // session, where before the whole append was skipped and the row was lost from every bucket.
  const saved = process.env.RBOOK_CONFIG_DIR;
  process.env.RBOOK_CONFIG_DIR = env.RBOOK_CONFIG_DIR;
  const runtime = openDraftRuntime(dbPath, process.env)!;
  recordSessionStart(runtime, harnessSessionHash('codex-session'), Date.now());
  const file = runtime.path;
  runtime.close();
  const holder = new Database(file);
  holder.exec('BEGIN EXCLUSIVE');
  const result = { structuredContent: { success: true } };
  try {
    const meta = {
      'x-codex-turn-metadata': {},
      sessionId: 'codex-session',
      'codex/sandbox-state-meta': { sandboxCwd: pathToFileURL(project).href },
    };
    const value = await withCodexRequest(meta, () =>
      withMcpTelemetry(
        {
          name: 'rbook_review',
          args: { projectRoot: project },
          mode: 'read',
          client: 'codex/1',
          env,
        },
        async () => result
      )
    );
    expect(value).toBe(result);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
    if (saved === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = saved;
  }
  expect(readTelemetry(targetForStore(dbPath)!, env)).toEqual([
    expect.objectContaining({ client: 'codex/1', ok: true, session: null }),
  ]);
});

// s105-m03, the six-path checklist on the real module: the call's budget only lengthens a wait for a
// held store. A store that names no project, or one the lookup cannot read as a Reasonbook store,
// is filed exactly as before, and the read-only lookup changes none of them.
it('files a call against a store whose metadata names no project under unknown-project', async () => {
  // The real schema forbids a NULL metadata value, so a store that names no project has no row.
  const db = new Database(dbPath);
  db.prepare(
    "DELETE FROM metadata WHERE key IN ('project_id', 'dashboard_slug', 'project_name')"
  ).run();
  db.close();
  const before = fs.readFileSync(dbPath);
  const result = { structuredContent: { success: true } };
  expect(
    await withMcpTelemetry(
      { name: 'rbook_review', args: { projectRoot: project }, mode: 'read', client: 'null/1', env },
      async () => result
    )
  ).toBe(result);
  expect(readTelemetry({ projectId: 'unknown-project', dbPath }, env)).toEqual([
    expect.objectContaining({ client: 'null/1' }),
  ]);
  expect(fs.readFileSync(dbPath)).toEqual(before);
});

it.each([
  ['an un-migrated store with no metadata table', 'CREATE TABLE legacy (value TEXT)'],
  ['a file that is not a database', null],
])('files a call against %s as unattributed, opening it read-only', async (_case, schema) => {
  fs.rmSync(dbPath);
  if (schema) {
    const db = new Database(dbPath);
    db.exec(schema);
    db.close();
  } else fs.writeFileSync(dbPath, 'not a database');
  const before = fs.readFileSync(dbPath);
  const result = { structuredContent: { success: true } };
  expect(
    await withMcpTelemetry(
      {
        name: 'rbook_review',
        args: { projectRoot: project },
        mode: 'read',
        client: 'foreign/1',
        env,
      },
      async () => result
    )
  ).toBe(result);
  expect(unattributed()).toEqual([expect.objectContaining({ client: 'foreign/1' })]);
  expect(fs.readFileSync(dbPath)).toEqual(before);
});
