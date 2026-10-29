// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s105 — forces every telemetry leaf the observation instruments can see, on the committed lookup.
// ABOUTME: Each record names its leaf's outcome and code while the call's result stays the same object.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import Database from 'better-sqlite3';
import * as telemetry from '../../src/tools/rbook/local-telemetry';
import { withCodexRequest } from '../../src/codex-request-context';
import { openDraftRuntime, recordSessionStart } from '../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../src/tools/rbook/harness-session';
import { setProcessBusyTimeout } from '../../src/tools/rbook/sqlite-busy';
import { UNKNOWN_STORE_PROJECT } from '../../src/tools/rbook/store-key';
import { instrumentTelemetrySource, writeScratchPackage } from './telemetry-failure-evidence';
import { scratchModules } from './scratch-telemetry-modules';
import { holdStore } from './store-lock-holder';
import {
  armPause,
  isBusyCode,
  readObservationRecords,
  releasePause,
  timedTargetForStore,
  type TelemetryInstrumentation,
} from './telemetry-observation-records';

const repo = path.resolve(__dirname, '../..');

// P57's instrumentTelemetrySource, frozen as sprint 104 committed it (only renamed). With no options
// the scratch package must stay exactly what the selected two-process test has run since then.
const P57_DIAGNOSTIC = `
function telemetryDiagnostic(phase: string, error: unknown, client: unknown = null, extra: object = {}): void {
  try {
    const value = error as { code?: unknown; name?: unknown } | null;
    process.stderr.write('TELEMETRY_DIAGNOSTIC ' + JSON.stringify({
      phase, pid: process.pid,
      code: typeof value?.code === 'string' ? value.code : null,
      name: typeof value?.name === 'string' ? value.name : null,
      client: typeof client === 'string' ? client : null, ...extra,
    }) + '\\n');
  } catch { /* Diagnostic output cannot change the observed operation. */ }
}
`;

function p57InstrumentTelemetrySource(relative: string, source: string): string {
  const normalized = relative.replace(/\\/g, '/');
  if (!['tools/rbook/local-telemetry.ts', 'tools/rbook/telemetry-call.ts'].includes(normalized))
    return source;
  const replace = (before: string, after: string, count = 1): void => {
    const found = source.split(before).length - 1;
    if (found !== count)
      throw new Error(
        `Telemetry instrumentation drift in ${relative}: expected ${count}, found ${found}: ${before}`
      );
    source = source.split(before).join(after);
  };
  if (normalized.endsWith('/telemetry-call.ts')) {
    replace(
      '      } catch {\n        // Best-effort instrumentation must never break an otherwise valid call.',
      "      } catch (diagnosticError) {\n        telemetryDiagnostic('telemetry-call', diagnosticError, observation.client);\n        // Best-effort instrumentation must never break an otherwise valid call."
    );
  } else {
    replace(
      '  } catch {\n    return null;\n  } finally {',
      "  } catch (diagnosticError) {\n    telemetryDiagnostic('targetForStore', diagnosticError);\n    return null;\n  } finally {"
    );
    replace(
      '  let fd: number | undefined;\n  try {\n    const safe = serializable(record);',
      "  let fd: number | undefined;\n  let diagnosticPhase = 'append-prepare';\n  try {\n    const safe = serializable(record);"
    );
    replace(
      '    if (!safe) return;',
      "    if (!safe) { telemetryDiagnostic('serialization', null, record?.client); return; }"
    );
    replace(
      '    if (!safeDestination(dir, target)) return;\n    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });\n    if (!safeDestination(dir, target)) return;',
      "    if (!safeDestination(dir, target)) { telemetryDiagnostic('safeDestination-before', null, record.client); return; }\n    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });\n    if (!safeDestination(dir, target)) { telemetryDiagnostic('safeDestination-after', null, record.client); return; }"
    );
    replace(
      '    fd = fs.openSync(\n',
      "    diagnosticPhase = 'append-open';\n    fd = fs.openSync(\n"
    );
    replace(
      '    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) return;',
      "    diagnosticPhase = 'append-file';\n    if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) { telemetryDiagnostic('file-rejection', null, record.client); return; }"
    );
    replace(
      '    fs.writeSync(fd, `${JSON.stringify(safe)}\\n`);\n    enforceRetention(dir);',
      "    diagnosticPhase = 'append-write';\n    const diagnosticLine = `${JSON.stringify(safe)}\\n`;\n    const diagnosticWritten = fs.writeSync(fd, diagnosticLine);\n    if (diagnosticWritten !== Buffer.byteLength(diagnosticLine)) telemetryDiagnostic('append-short-write', null, record.client, { writtenBytes: diagnosticWritten, expectedBytes: Buffer.byteLength(diagnosticLine) });\n    diagnosticPhase = 'append-retention';\n    enforceRetention(dir);"
    );
    replace(
      '  } catch {\n    // Telemetry never fails the call that writes it.',
      '  } catch (diagnosticError) {\n    telemetryDiagnostic(diagnosticPhase, diagnosticError, record?.client);\n    // Telemetry never fails the call that writes it.'
    );
  }
  return source + P57_DIAGNOSTIC;
}

const savedConfig = process.env.RBOOK_CONFIG_DIR;
let root: string;
let config: string;
let project: string;
let dbPath: string;
let records: string;
const env = () => ({ RBOOK_CONFIG_DIR: config });
const result = () => ({ structuredContent: { success: true, data: {} } });

function seedStore(
  options: { at?: string; wal?: boolean; metadata?: boolean; projectId?: string | null } = {}
): string {
  const file = options.at ?? dbPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    if (options.metadata === false) db.exec('CREATE TABLE other (value TEXT)');
    else db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
    if (options.metadata !== false && options.projectId !== null)
      db.prepare('INSERT INTO metadata VALUES (?, ?)').run(
        'project_id',
        options.projectId ?? 'fixture'
      );
    if (options.wal !== false) db.pragma('journal_mode = WAL');
  } finally {
    db.close();
  }
  return file;
}
const load = (options: TelemetryInstrumentation, overrides: Record<string, unknown> = {}) =>
  scratchModules(root, overrides, { records, ...options });
async function observe(
  modules: ReturnType<typeof load>,
  options: { client?: string; mode?: string; operation?: () => Promise<unknown> } = {}
): Promise<{ value: unknown; returned: unknown }> {
  const value = result();
  const returned = await modules.call.withMcpTelemetry(
    {
      name: 'rbook_review',
      args: { projectRoot: project },
      mode: (options.mode ?? 'read') as 'read',
      client: options.client ?? 'parallel-1/1',
      env: env(),
    },
    (options.operation ?? (async () => value)) as () => Promise<typeof value>
  );
  return { value, returned };
}
function onlyRecord(): Record<string, any> {
  const all = readObservationRecords(records);
  expect(all).toHaveLength(1);
  return all[0];
}
const quietStderr = () => jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
function diagnostics(spy: jest.SpyInstance) {
  return spy.mock.calls
    .flatMap(([text]) => String(text).split('\n'))
    .filter((line) => line.startsWith('TELEMETRY_DIAGNOSTIC '))
    .map((line) => JSON.parse(line.slice('TELEMETRY_DIAGNOSTIC '.length)));
}
const rows = (projectId: string, file = dbPath) =>
  telemetry.readTelemetry({ projectId, dbPath: file }, env());
const unattributedRows = () => rows('unattributed', path.join(config, 'unattributed.sqlite'));
/** Every monthly file in any bucket, so "no row anywhere" is a measured empty listing. */
function telemetryFiles(): string[] {
  const top = path.join(config, 'telemetry');
  if (!fs.existsSync(top)) return [];
  return fs
    .readdirSync(top)
    .flatMap((bucket) => fs.readdirSync(path.join(top, bucket)).map((name) => `${bucket}/${name}`));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-observation-'));
  config = path.join(root, 'config');
  project = path.join(root, 'project');
  dbPath = path.join(project, 'rbook', 'db', 'rbook.sqlite');
  records = path.join(root, 'records');
});
afterEach(() => {
  jest.restoreAllMocks();
  setProcessBusyTimeout(null);
  if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfig;
  fs.rmSync(root, { recursive: true, force: true });
});

it('keeps the scratch package without options byte-identical to P57 for every source file', () => {
  const output = path.join(root, 'package');
  writeScratchPackage(repo, output);
  const walk = (base: string, relative: string, suffix: RegExp, found: string[]): string[] => {
    const full = path.join(base, relative);
    if (fs.statSync(full).isDirectory())
      for (const name of fs.readdirSync(full)) walk(base, path.join(relative, name), suffix, found);
    else if (suffix.test(full) && !full.endsWith('.d.ts')) found.push(relative);
    return found;
  };
  const sources = walk(path.join(repo, 'src'), '', /\.ts$/, []);
  const differs: string[] = [];
  let instrumented = 0;
  for (const relative of sources) {
    const source = fs.readFileSync(path.join(repo, 'src', relative), 'utf8');
    const frozen = p57InstrumentTelemetrySource(relative, source);
    if (frozen !== source) instrumented += 1;
    const expected = ts.transpileModule(frozen, {
      fileName: path.join(repo, 'src', relative),
      compilerOptions: {
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
      },
    }).outputText;
    const emitted = path.join(output, 'dist', relative.replace(/\.ts$/, '.js'));
    if (
      instrumentTelemetrySource(relative, source) !== frozen ||
      instrumentTelemetrySource(relative, source, {}) !== frozen ||
      fs.readFileSync(emitted, 'utf8') !== expected
    )
      differs.push(relative);
  }
  expect(differs).toEqual([]);
  // Only P57's two telemetry modules carry diagnostics, and the package holds every source and no more.
  expect(instrumented).toBe(2);
  expect(walk(path.join(output, 'dist'), '', /\.js$/, []).sort()).toEqual(
    sources.map((relative) => relative.replace(/\.ts$/, '.js')).sort()
  );
});

it('refuses options it cannot honor, and fails loudly when one of its own anchors drifts', () => {
  const file = 'tools/rbook/telemetry-call.ts';
  const source = fs.readFileSync(path.join(repo, 'src', file), 'utf8');
  expect(() => instrumentTelemetrySource(file, source, { pause: true })).toThrow(
    /absolute records/
  );
  expect(() => instrumentTelemetrySource(file, source, { records: 'relative' })).toThrow(
    /absolute records/
  );
  // s105-m03 retired arm B with the repair it stood for: a stale caller fails, never runs arm A twice.
  const stale = { records, armB: true } as unknown as TelemetryInstrumentation;
  expect(() => instrumentTelemetrySource(file, source, stale)).toThrow(/retired/);
  // P57 does not anchor on the identity lookup's line, but the records do.
  const edited = source.replace('processBusyTimeout() ?? 5000)', 'processBusyTimeout() ?? 7000)');
  expect(edited).not.toBe(source);
  expect(() => instrumentTelemetrySource(file, edited)).not.toThrow();
  expect(() => instrumentTelemetrySource(file, edited, { records })).toThrow(
    /instrumentation drift/
  );
});

it('records a healthy observation and returns the same result', async () => {
  seedStore();
  const stderr = quietStderr();
  const { value, returned } = await observe(load({}));
  expect(returned).toBe(value);
  const record = onlyRecord();
  expect(record).toMatchObject({
    pid: process.pid,
    client: 'parallel-1/1',
    root: project,
    config,
    lookup: { outcome: 'ok', code: null, projectId: 'fixture', budgetMs: 5000 },
    bucket: { projectId: 'fixture', key: telemetry.telemetryKey({ projectId: 'fixture', dbPath }) },
    ok: true,
    append: { outcome: 'written' },
    observation: { outcome: 'completed' },
  });
  expect(record.append.bytes).toBe(record.append.expectedBytes);
  for (const field of ['callStartedAt', 'observationStartedAt', 'observationEndedAt'])
    expect(Number.isFinite(Date.parse(record[field]))).toBe(true);
  // The lookup's time is recorded; its presence is checked, never a bound on it.
  expect(Number.isFinite(record.lookup.elapsedMs)).toBe(true);
  expect(record.ownerLookup).toBeUndefined();
  expect(diagnostics(stderr)).toEqual([]);
  expect(rows('fixture')).toHaveLength(1);
});

it('leaf 1: a store another process holds until 1,000 ms after the lookup starts keeps its row', async () => {
  seedStore();
  const files = armPause(config, 'parallel-1/1');
  // Released already, so the pause passes straight through and writes the marker the hold counts from.
  releasePause(files);
  const hold = holdStore(dbPath, { marker: files.marker, afterMarkerMs: 1000 });
  try {
    await hold.held;
    const modules = load({ pause: true });
    const stderr = quietStderr();
    const { value, returned } = await observe(modules);
    expect(returned).toBe(value);
    expect(await hold.released).toMatchObject({ sawMarker: true });
    const record = onlyRecord();
    expect(record.pause).toMatchObject({ released: true });
    // s105-m03: the lookup waits its call's budget, so the held store costs time, not the row.
    expect(record.lookup).toMatchObject({
      outcome: 'ok',
      code: null,
      projectId: 'fixture',
      budgetMs: 5000,
    });
    expect(record.bucket.projectId).toBe('fixture');
    expect(rows('fixture')).toHaveLength(1);
    expect(unattributedRows()).toHaveLength(0);
    expect(diagnostics(stderr)).toEqual([]);
  } finally {
    await hold.stop();
  }
});

it("leaf 1: a hold that outlasts the call's budget files the row as unattributed, reported once", async () => {
  seedStore({ wal: false });
  const holder = new Database(dbPath);
  holder.exec('BEGIN EXCLUSIVE');
  setProcessBusyTimeout(300);
  const stderr = quietStderr();
  try {
    const { value, returned } = await observe(load({}));
    expect(returned).toBe(value);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  const record = onlyRecord();
  expect(record.lookup).toMatchObject({ outcome: 'failed', code: 'SQLITE_BUSY', budgetMs: 300 });
  expect(record.bucket.projectId).toBe('unattributed');
  expect(unattributedRows()).toHaveLength(1);
  expect(diagnostics(stderr)).toEqual([
    expect.objectContaining({ phase: 'targetForStore', code: 'SQLITE_BUSY' }),
  ]);
});

it('a lookup that fails without a busy code is filed as unattributed and reported once', async () => {
  seedStore({ metadata: false });
  const stderr = quietStderr();
  const { value, returned } = await observe(load({}));
  expect(returned).toBe(value);
  const record = onlyRecord();
  expect(record.lookup).toMatchObject({ outcome: 'failed', code: 'SQLITE_ERROR', budgetMs: 5000 });
  expect(isBusyCode(record.lookup.code)).toBe(false);
  expect(record.bucket.projectId).toBe('unattributed');
  expect(unattributedRows()).toHaveLength(1);
  expect(diagnostics(stderr)).toEqual([
    expect.objectContaining({ phase: 'targetForStore', code: 'SQLITE_ERROR' }),
  ]);
});

it('leaf 2: a store that names no project id', async () => {
  seedStore({ projectId: null });
  const { value, returned } = await observe(load({}));
  expect(returned).toBe(value);
  const record = onlyRecord();
  expect(record.lookup).toMatchObject({ outcome: 'ok', projectId: UNKNOWN_STORE_PROJECT });
  expect(record.bucket).toEqual({
    projectId: UNKNOWN_STORE_PROJECT,
    key: telemetry.telemetryKey({ projectId: UNKNOWN_STORE_PROJECT, dbPath }),
  });
  expect(rows(UNKNOWN_STORE_PROJECT)).toHaveLength(1);
});

it('leaf 3: a realpath error keys the row by the unresolved path', async () => {
  // The store is reached through a link, so its unresolved path keys a different bucket.
  const real = path.join(root, 'real-project');
  seedStore({ at: path.join(real, 'rbook', 'db', 'rbook.sqlite') });
  fs.symlinkSync(real, project, 'dir');
  const native = fs.realpathSync.native;
  const fakeFs = {
    ...require('fs'),
    realpathSync: Object.assign((file: fs.PathLike) => fs.realpathSync(file), {
      native: (file: string) => {
        if (path.resolve(file) === path.resolve(dbPath))
          throw Object.assign(new Error('injected'), { code: 'ENOENT' });
        return native(file);
      },
    }),
  };
  const { value, returned } = await observe(load({}, { fs: fakeFs }));
  expect(returned).toBe(value);
  const fallback = createHash('sha256')
    .update(`fixture\0${path.resolve(dbPath)}`)
    .digest('hex')
    .slice(0, 16);
  expect(fallback).not.toBe(telemetry.telemetryKey({ projectId: 'fixture', dbPath }));
  expect(onlyRecord().bucket).toEqual({ projectId: 'fixture', key: fallback });
  expect(telemetryFiles()).toEqual([`${fallback}/${telemetry.monthFile(new Date())}`]);
});

it('leaf 4: the record names the root the dispatcher resolved', async () => {
  seedStore();
  const other = path.join(root, 'other');
  seedStore({ at: path.join(other, 'rbook', 'db', 'rbook.sqlite'), projectId: 'other' });
  const modules = load({});
  const value = result();
  const { returned } = await observe(modules, {
    operation: async () => {
      modules.call.noteTelemetryProject(other);
      return value;
    },
  });
  expect(returned).toBe(value);
  expect(onlyRecord()).toMatchObject({
    root: other,
    lookup: { outcome: 'ok', projectId: 'other' },
    bucket: { projectId: 'other' },
  });
});

it('leaf 5: a session-owner lookup that throws costs the row its session, not the row', async () => {
  seedStore();
  const owner = {
    currentSessionOwner: () => {
      throw Object.assign(new Error('fault'), { code: 'OWNER_FAULT' });
    },
  };
  const stderr = quietStderr();
  const { value, returned } = await observe(load({}, { './session-owner': owner }));
  expect(returned).toBe(value);
  expect(onlyRecord()).toMatchObject({
    ownerLookup: { outcome: 'threw', code: 'OWNER_FAULT' },
    append: { outcome: 'written' },
    observation: { outcome: 'completed' },
  });
  expect(rows('fixture')).toEqual([
    expect.objectContaining({ client: 'parallel-1/1', session: null }),
  ]);
  expect(diagnostics(stderr)).toEqual([]);
});

it('leaf 5: an observation that throws anywhere else before the append keeps no row anywhere', async () => {
  seedStore();
  const extract = {
    returnedIds: () => {
      throw Object.assign(new Error('fault'), { code: 'EXTRACT_FAULT' });
    },
    usedIds: () => [],
  };
  const stderr = quietStderr();
  const { value, returned } = await observe(load({}, { './telemetry-extract': extract }));
  expect(returned).toBe(value);
  expect(onlyRecord()).toMatchObject({
    lookup: { outcome: 'ok' },
    observation: { outcome: 'threw', code: 'EXTRACT_FAULT' },
    append: { outcome: 'not-attempted' },
  });
  expect(telemetryFiles()).toEqual([]);
  expect(diagnostics(stderr)).toEqual([
    expect.objectContaining({ phase: 'telemetry-call', code: 'EXTRACT_FAULT' }),
  ]);
});

it('leaf 5: a Codex owner lookup held busy in its draft runtime keeps the row with a null session', async () => {
  seedStore();
  // The owner lookup finds the draft runtime through the process environment.
  process.env.RBOOK_CONFIG_DIR = config;
  const runtime = openDraftRuntime(dbPath, process.env)!;
  recordSessionStart(runtime, harnessSessionHash('codex-session'), Date.now());
  const file = runtime.path;
  runtime.close();
  const holder = new Database(file);
  holder.exec('BEGIN EXCLUSIVE');
  const stderr = quietStderr();
  try {
    const modules = load({});
    const value = result();
    const meta = {
      'x-codex-turn-metadata': {},
      sessionId: 'codex-session',
      'codex/sandbox-state-meta': { sandboxCwd: pathToFileURL(project).href },
    };
    const returned = await withCodexRequest(meta, () =>
      modules.call.withMcpTelemetry(
        {
          name: 'rbook_review',
          args: { projectRoot: project },
          mode: 'read',
          client: 'codex/test',
          env: env(),
        },
        async () => value
      )
    );
    expect(returned).toBe(value);
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  expect(onlyRecord()).toMatchObject({
    client: 'codex/test',
    lookup: { outcome: 'ok' },
    ownerLookup: { outcome: 'threw', code: 'SQLITE_BUSY' },
    append: { outcome: 'written' },
  });
  expect(rows('fixture')).toEqual([
    expect.objectContaining({ client: 'codex/test', session: null }),
  ]);
  expect(diagnostics(stderr)).toEqual([]);
});

it('leaf 6: a record the serializer refuses', async () => {
  seedStore();
  quietStderr();
  const { value, returned } = await observe(load({}), { mode: 'invalid' });
  expect(returned).toBe(value);
  expect(onlyRecord().append).toMatchObject({ outcome: 'serialization' });
  expect(telemetryFiles()).toEqual([]);
});

it('leaf 6: a telemetry folder linked into the project is refused', async () => {
  seedStore();
  fs.mkdirSync(config, { recursive: true });
  fs.symlinkSync(path.join(project, 'rbook'), path.join(config, 'telemetry'), 'dir');
  quietStderr();
  const { value, returned } = await observe(load({}));
  expect(returned).toBe(value);
  expect(onlyRecord().append).toMatchObject({ outcome: 'safeDestination-before' });
  expect(fs.readdirSync(path.join(project, 'rbook'))).toEqual(['db']);
});

it('leaf 7: an unwritable bucket folder', async () => {
  seedStore();
  const bucket = telemetry.telemetryDir({ projectId: 'fixture', dbPath }, env());
  fs.mkdirSync(bucket, { recursive: true });
  fs.chmodSync(bucket, 0o500);
  try {
    // A superuser writes anyway; this case needs the refusal to be real.
    expect(() => fs.accessSync(bucket, fs.constants.W_OK)).toThrow();
    quietStderr();
    const { value, returned } = await observe(load({}));
    expect(returned).toBe(value);
    expect(onlyRecord().append).toMatchObject({ outcome: 'append-open', code: 'EACCES' });
  } finally {
    fs.chmodSync(bucket, 0o700);
  }
});

it('leaf 7: a linked monthly file is never appended through', async () => {
  seedStore();
  const bucket = telemetry.telemetryDir({ projectId: 'fixture', dbPath }, env());
  fs.mkdirSync(bucket, { recursive: true });
  const elsewhere = path.join(root, 'elsewhere.jsonl');
  fs.writeFileSync(elsewhere, '');
  fs.symlinkSync(elsewhere, path.join(bucket, telemetry.monthFile(new Date())));
  quietStderr();
  const { value, returned } = await observe(load({}));
  expect(returned).toBe(value);
  expect(onlyRecord().append).toMatchObject({ outcome: 'append-open', code: 'ELOOP' });
  expect(fs.readFileSync(elsewhere, 'utf8')).toBe('');
});

it('leaf 7: a hard-linked monthly file is rejected', async () => {
  seedStore();
  const bucket = telemetry.telemetryDir({ projectId: 'fixture', dbPath }, env());
  fs.mkdirSync(bucket, { recursive: true });
  const elsewhere = path.join(root, 'elsewhere.jsonl');
  fs.writeFileSync(elsewhere, '');
  fs.linkSync(elsewhere, path.join(bucket, telemetry.monthFile(new Date())));
  quietStderr();
  const { value, returned } = await observe(load({}));
  expect(returned).toBe(value);
  const append = onlyRecord().append;
  expect(append).toMatchObject({ outcome: 'file-rejection' });
  expect(append.bytes).toBeUndefined();
  expect(fs.readFileSync(elsewhere, 'utf8')).toBe('');
});

it('leaf 7: a short write records the bytes written', async () => {
  seedStore();
  const fakeFs = {
    ...require('fs'),
    writeSync: (fd: number, text: string) => fs.writeSync(fd, text.slice(0, 7)),
  };
  quietStderr();
  const { value, returned } = await observe(load({}, { fs: fakeFs }));
  expect(returned).toBe(value);
  const append = onlyRecord().append;
  expect(append).toMatchObject({ outcome: 'append-short-write', bytes: 7 });
  expect(append.expectedBytes).toBeGreaterThan(7);
});

it("leaf 9: the reader's own lookup is recorded failing while the store is held", () => {
  seedStore({ wal: false });
  const holder = new Database(dbPath);
  holder.exec('BEGIN EXCLUSIVE');
  try {
    expect(timedTargetForStore(dbPath)).toMatchObject({
      target: null,
      reader: { outcome: 'failed' },
    });
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  expect(timedTargetForStore(dbPath)).toMatchObject({
    target: { projectId: 'fixture', dbPath },
    reader: { outcome: 'ok' },
  });
});

it('pauses only an armed client, only once, and writes its marker before the lookup', async () => {
  seedStore();
  const files = armPause(config, 'parallel-1/1');
  releasePause(files);
  // Whether the marker existed at the moment each lookup opened the store: the order fork 1 needs.
  const markerAtOpen: boolean[] = [];
  function WatchedDatabase(file: string, settings: Database.Options) {
    markerAtOpen.push(fs.existsSync(files.marker));
    return new Database(file, settings);
  }
  const modules = load({ pause: true }, { 'better-sqlite3': WatchedDatabase });
  await observe(modules, { client: 'parallel-0/1' });
  expect(fs.existsSync(files.marker)).toBe(false);
  await observe(modules);
  expect([files.arm, files.paused, files.marker].map((file) => fs.existsSync(file))).toEqual([
    false,
    true,
    true,
  ]);
  fs.rmSync(files.marker);
  await observe(modules);
  expect(fs.existsSync(files.marker)).toBe(false);
  expect(markerAtOpen).toEqual([false, true, false]);
  const [unarmed, armed, again] = readObservationRecords(records);
  expect(unarmed.pause).toBeUndefined();
  expect(armed.pause).toMatchObject({ released: true });
  expect(armed.lookup).toMatchObject({ outcome: 'ok' });
  expect(again.pause).toBeUndefined();
});

it('goes on without a release once the pause cap passes, and says so', async () => {
  seedStore();
  const files = armPause(config, 'parallel-1/1');
  await observe(load({ pause: true, pauseCapMs: 50 }));
  expect(onlyRecord().pause).toMatchObject({ released: false });
  expect(fs.existsSync(files.marker)).toBe(true);
  expect(rows('fixture')).toHaveLength(1);
});

it('reports a record it cannot write, and still returns the result and keeps the row', async () => {
  seedStore();
  fs.writeFileSync(records, 'occupied');
  const stderr = quietStderr();
  const { value, returned } = await observe(load({}));
  expect(returned).toBe(value);
  expect(diagnostics(stderr)).toEqual([
    expect.objectContaining({ phase: 's105-record', client: 'parallel-1/1' }),
  ]);
  expect(rows('fixture')).toHaveLength(1);
});
