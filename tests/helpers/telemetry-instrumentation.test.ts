// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Forces observation failures through scratch-transpiled production telemetry modules.
// ABOUTME: Proves retained evidence distinguishes lost observations without changing caller outcomes.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import * as telemetry from '../../src/tools/rbook/local-telemetry';
import { instrumentTelemetrySource } from './telemetry-failure-evidence';
import { scratchModules } from './scratch-telemetry-modules';
import { setProcessBusyTimeout } from '../../src/tools/rbook/sqlite-busy';

let root: string;
let config: string;
let dbPath: string;
const target = () => ({ projectId: 'fixture', dbPath });
const env = () => ({ RBOOK_CONFIG_DIR: config });
const unattributed = () => ({
  projectId: 'unattributed',
  dbPath: path.join(config, 'unattributed.sqlite'),
});
function store(metadata = true): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  if (metadata) {
    db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO metadata VALUES (?, ?)').run('project_id', 'fixture');
  }
  return db;
}
function diagnostics(spy: jest.SpyInstance) {
  return spy.mock.calls
    .flatMap(([text]) => String(text).split('\n'))
    .filter((line) => line.startsWith('TELEMETRY_DIAGNOSTIC '))
    .map((line) => JSON.parse(line.slice('TELEMETRY_DIAGNOSTIC '.length)));
}
const observe = (
  modules: ReturnType<typeof scratchModules>,
  result: { structuredContent: unknown }
) =>
  modules.call.withMcpTelemetry(
    {
      name: 'rbook_review',
      args: { projectRoot: path.dirname(path.dirname(path.dirname(dbPath))) },
      mode: 'read',
      client: 'parallel-1/1',
      env: env(),
    },
    async () => result
  );

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-evidence-'));
  config = path.join(root, 'config');
  dbPath = path.join(root, 'project', 'rbook', 'db', 'rbook.sqlite');
});
afterEach(() => {
  jest.restoreAllMocks();
  setProcessBusyTimeout(null);
  fs.rmSync(root, { recursive: true, force: true });
});

it('fails loudly on instrumentation drift and passes unrelated sources through unchanged', () => {
  expect(instrumentTelemetrySource('other.ts', 'untouched')).toBe('untouched');
  expect(() => instrumentTelemetrySource('tools/rbook/local-telemetry.ts', 'changed')).toThrow(
    /instrumentation.*drift/i
  );
});

it.each(['absent', 'null', 'locked'])(
  'distinguishes actual %s store lookup behavior while preserving successful tool result identity',
  async (kind) => {
    const database = store(kind !== 'absent');
    if (kind === 'null') database.prepare('UPDATE metadata SET value = NULL').run();
    // s105-m03: the observation waits its call's budget for a held store, and this store is held
    // by the test's own thread, so only the wait's length can change; keep it at the old 100 ms.
    if (kind === 'locked') {
      database.exec('BEGIN EXCLUSIVE');
      setProcessBusyTimeout(100);
    }
    const modules = scratchModules(root);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = { structuredContent: { success: true, data: {} } };
    try {
      expect(await observe(modules, result)).toBe(result);
      if (kind === 'null') {
        expect(diagnostics(stderr)).toEqual([]);
        expect(
          telemetry.readTelemetry({ projectId: 'unknown-project', dbPath }, env())
        ).toHaveLength(1);
      } else {
        expect(diagnostics(stderr)).toEqual([
          expect.objectContaining({
            phase: 'targetForStore',
            pid: process.pid,
            code: kind === 'locked' ? 'SQLITE_BUSY' : 'SQLITE_ERROR',
            name: 'SqliteError',
          }),
        ]);
        expect(telemetry.readTelemetry(unattributed(), env())).toHaveLength(1);
      }
    } finally {
      if (kind === 'locked') database.exec('ROLLBACK');
      database.close();
    }
  }
);

it.each([
  'serialization',
  'safeDestination',
  'file-rejection',
  'append-open',
  'append-write',
  'append-short-write',
  'telemetry-call',
])('identifies injected %s failure and preserves the original tool result', async (kind) => {
  store().close();
  const fakeFs = { ...require('fs') };
  const overrides: Record<string, unknown> = { fs: fakeFs };
  // s105-m03 contains a throwing session-owner lookup (the row keeps going, without its session),
  // so the observation is made to fail where nothing contains it: extracting the returned ids.
  if (kind === 'telemetry-call')
    overrides['./telemetry-extract'] = {
      returnedIds: () => {
        throw Object.assign(new Error('fault'), { code: 'EXTRACT_FAULT' });
      },
      usedIds: () => [],
    };
  const modules = scratchModules(root, overrides);
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  if (kind === 'safeDestination') config = path.join(path.dirname(dbPath), 'config');
  if (kind === 'file-rejection') fakeFs.fstatSync = () => ({ isFile: () => true, nlink: 2 });
  if (kind === 'append-open')
    fakeFs.openSync = () => {
      throw Object.assign(new Error('fault'), { code: 'EACCES' });
    };
  if (kind === 'append-write')
    fakeFs.writeSync = () => {
      throw Object.assign(new Error('fault'), { code: 'ENOSPC' });
    };
  if (kind === 'append-short-write')
    fakeFs.writeSync = (fd: number, text: string) => fs.writeSync(fd, text.slice(0, 7));
  const result = { structuredContent: { success: true, data: {} } };
  if (kind === 'serialization') {
    expect(
      await modules.call.withMcpTelemetry(
        {
          name: 'rbook_review',
          args: { projectRoot: path.join(root, 'project') },
          mode: 'invalid' as 'read',
          client: 'parallel-1/1',
          env: env(),
        },
        async () => result
      )
    ).toBe(result);
  } else expect(await observe(modules, result)).toBe(result);
  const rows = diagnostics(stderr);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    phase: kind === 'safeDestination' ? 'safeDestination-before' : kind,
    pid: process.pid,
    client: 'parallel-1/1',
  });
  if (kind === 'append-open') expect(rows[0]).toMatchObject({ code: 'EACCES', name: 'Error' });
  if (kind === 'append-write') expect(rows[0]).toMatchObject({ code: 'ENOSPC', name: 'Error' });
  if (kind === 'telemetry-call')
    expect(rows[0]).toMatchObject({ code: 'EXTRACT_FAULT', name: 'Error' });
  if (kind === 'append-short-write') {
    expect(rows[0].writtenBytes).toBe(7);
    expect(rows[0].expectedBytes).toBeGreaterThan(7);
    expect(
      fs.readFileSync(
        path.join(telemetry.telemetryDir(target(), env()), telemetry.monthFile(new Date())),
        'utf8'
      )
    ).toHaveLength(7);
  }
});

it('logs no healthy writes and preserves a thrown tool exception during an observation failure', async () => {
  store().close();
  const modules = scratchModules(root);
  const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const result = { structuredContent: { success: true, data: {} } };
  expect(await observe(modules, result)).toBe(result);
  expect(diagnostics(stderr)).toEqual([]);
  expect(telemetry.readTelemetry(target(), env())).toHaveLength(1);
  // A call with no project files its row under the config directory; failing that lookup makes the
  // observation itself throw, which s105-m03 leaves uncontained.
  const fault = scratchModules(root, {
    './harness-session': {
      rbookConfigDir: () => {
        throw new Error('observation failed');
      },
    },
  });
  const original = Object.assign(new Error('tool exception'), { code: 'TOOL_FAULT' });
  await expect(
    fault.call.withMcpTelemetry(
      { name: 'rbook_review', args: {}, mode: 'read', client: null, env: env() },
      async () => {
        throw original;
      }
    )
  ).rejects.toBe(original);
  expect(diagnostics(stderr)).toEqual([expect.objectContaining({ phase: 'telemetry-call' })]);
});
