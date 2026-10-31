// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Verify that local telemetry preserves measurement metadata without storing operator text.
// ABOUTME: Exercise retention, repository exclusion and readable diagnostics using isolated files.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import * as telemetry from '../../../src/tools/rbook/local-telemetry';
import { TelemetryRecord, TelemetryTarget } from '../../../src/tools/rbook/local-telemetry';

let root: string;
let target: TelemetryTarget;
let env: NodeJS.ProcessEnv;
const now = () => new Date().toISOString();
const record = (extra: Partial<TelemetryRecord> = {}): TelemetryRecord => ({
  ts: now(),
  session: 'ext:1234567890abcdef',
  surface: 'hook',
  client: 'claude-code/1.0',
  tool: 'hook prompt',
  action: null,
  mode: null,
  ok: true,
  refused: null,
  failOpen: null,
  ambient: 'on',
  ...extra,
});
const report = () => (telemetry as any).readTelemetryReport(target, env);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-telemetry-'));
  target = {
    projectId: 'project-id',
    dbPath: path.join(root, 'project', 'rbook', 'db', 'rbook.sqlite'),
  };
  env = { RBOOK_CONFIG_DIR: path.join(root, 'config') };
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it('keeps typed numeric IDs only, deduplicated and capped for bounded record attribution', () => {
  expect(
    telemetry.capIds(['d:1', 'l:2', 'c:3', 'n:4', 'd:1', 'd:secret', 'free text', 'x:1'])
  ).toEqual(['d:1', 'l:2', 'c:3', 'n:4']);
  expect(telemetry.capIds(Array.from({ length: 120 }, (_, i) => `d:${i}`))).toHaveLength(100);
});

it('retains both generations of tool names so measurement history does not become unknown', () => {
  for (const tool of ['rbook_decisions', 'rbook_decisions'])
    telemetry.appendTelemetry(record({ tool }), target, env);
  expect(telemetry.readTelemetry(target, env).map((r) => r.tool)).toEqual([
    'rbook_decisions',
    'rbook_decisions',
  ]);
});

it('keeps telemetry out of a renamed project even without a git directory', () => {
  const project = path.join(root, 'renamed');
  const db = path.join(project, 'rbook', 'db', 'rbook.sqlite');
  fs.mkdirSync(path.dirname(db), { recursive: true });
  fs.writeFileSync(db, 'fixture');
  expect(telemetry.safeDestination(path.join(project, 'logs'))).toBe(false);
});
it('reads a zone-less persisted timestamp as UTC, independent of the host timezone', () => {
  const expected = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  telemetry.appendTelemetry(
    record({ ts: expected.replace('T', ' ').replace('.000Z', '') }),
    target,
    env
  );
  expect(telemetry.readTelemetry(target, env)[0].ts).toBe(expected);
});
it('serializes an explicit allowlist and caps every ID field, excluding raw content', () => {
  const input = {
    ...record(),
    prompt: 'private prompt sentinel',
    content: 'private record sentinel',
    idsReturned: ['d:1', 'private-id'],
    idsInjected: ['c:3'],
    idsCited: ['l:4'],
    restatedRuleIds: ['c:3', 'd:1', 'private-rule'],
    procedurePatternIds: ['P01', 'P13', 'P99', 'private-pattern'],
    charsInjected: 33,
    digestHash: 'abcdef0123456789',
    ruleReadFailed: true,
  };
  telemetry.appendTelemetry(input, target, env);
  const stored = telemetry.readTelemetry(target, env)[0];
  expect(stored).toMatchObject({
    idsReturned: ['d:1'],
    idsInjected: ['c:3'],
    idsCited: ['l:4'],
    restatedRuleIds: ['c:3'],
    procedurePatternIds: ['P01', 'P13'],
    charsInjected: 33,
    ruleReadFailed: true,
  });
  const file = fs.readFileSync(
    path.join(telemetry.telemetryDir(target, env), telemetry.monthFile(new Date())),
    'utf8'
  );
  expect(file).not.toMatch(/private|"content"|"prompt"/);
  const ids = Array.from({ length: 150 }, (_, i) => `c:${i}`);
  telemetry.appendTelemetry(
    record({ idsReturned: ids, idsInjected: ids, idsCited: ids, restatedRuleIds: ids }),
    target,
    env
  );
  for (const key of ['idsReturned', 'idsInjected', 'idsCited', 'restatedRuleIds'])
    expect((telemetry.readTelemetry(target, env)[1] as any)[key]).toHaveLength(100);
});
it('hashes invalid client names and rejects arbitrary technical fields instead of preserving content', () => {
  telemetry.appendTelemetry(
    record({
      session: 'raw session text',
      client: 'private client sentence with spaces',
      action: 'a private action sentence',
      refused: 'private refusal details',
      failOpen: 'private error details',
      ceremony: '/reasonbook:close private arguments',
      digestHash: 'private digest',
      ambient: 'off' as any,
    }),
    target,
    env
  );
  const stored = telemetry.readTelemetry(target, env)[0];
  expect(stored).toMatchObject({
    session: null,
    client: expect.stringMatching(/^hash:[a-f0-9]{16}$/),
    action: null,
    refused: null,
    failOpen: null,
    ceremony: null,
    ambient: 'off',
  });
  expect(JSON.stringify(stored)).not.toContain('private');
});
it('retains only known session-start sources and leaves legacy telemetry unspecified', () => {
  for (const source of ['startup', 'resume', 'clear', 'compact', 'private source', undefined]) {
    telemetry.appendTelemetry(
      Object.assign(record({ tool: 'hook session-start' }), { source }),
      target,
      env
    );
  }
  const rows = telemetry.readTelemetry(target, env) as Array<TelemetryRecord & { source?: string }>;
  expect(rows.map((row) => row.source)).toEqual([
    'startup',
    'resume',
    'clear',
    'compact',
    undefined,
    undefined,
  ]);
  expect(JSON.stringify(rows)).not.toContain('private source');
});
it('retains the newest three months on every append, including backdated appends', () => {
  const dir = telemetry.telemetryDir(target, env);
  fs.mkdirSync(dir, { recursive: true });
  const months = Array.from({ length: 5 }, (_, offset) => {
    const date = new Date();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - offset);
    return date;
  });
  for (const date of months) fs.writeFileSync(path.join(dir, telemetry.monthFile(date)), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'do not delete');
  telemetry.appendTelemetry(record(), target, env);
  expect(
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
  ).toEqual(months.slice(0, 3).map(telemetry.monthFile).sort());
  telemetry.appendTelemetry(record({ ts: months[4].toISOString() }), target, env);
  expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(3);
  expect(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')).toBe('do not delete');
});
it('never lets telemetry failure or an invalid timestamp fail the operation', () => {
  fs.writeFileSync(env.RBOOK_CONFIG_DIR!, 'not a directory');
  expect(() => telemetry.appendTelemetry(record(), target, env)).not.toThrow();
  expect(() => telemetry.appendTelemetry(record({ ts: 'invalid' }), target, env)).not.toThrow();
});
it('uses both identity and canonical store path so scratch copies remain separate', () => {
  fs.mkdirSync(path.dirname(target.dbPath), { recursive: true });
  fs.writeFileSync(target.dbPath, '');
  const alias = path.join(root, 'alias.sqlite');
  fs.symlinkSync(target.dbPath, alias);
  expect(telemetry.telemetryKey({ ...target, dbPath: alias })).toBe(telemetry.telemetryKey(target));
  expect(telemetry.telemetryKey({ ...target, dbPath: path.join(root, 'scratch.sqlite') })).not.toBe(
    telemetry.telemetryKey(target)
  );
  expect(telemetry.telemetryKey({ ...target, projectId: '../../private project text' })).toMatch(
    /^[a-f0-9]{16}$/
  );
});
it('reads alias-written telemetry once through either spelling of the same physical store', () => {
  fs.mkdirSync(path.dirname(target.dbPath), { recursive: true });
  fs.writeFileSync(target.dbPath, '');
  const aliasRoot = path.join(fs.realpathSync.native(root), 'PROJECT');
  if (!fs.existsSync(aliasRoot)) fs.symlinkSync(path.join(root, 'project'), aliasRoot, 'dir');
  const alias = { ...target, dbPath: path.join(aliasRoot, 'rbook', 'db', 'rbook.sqlite') };
  const original = fs.realpathSync;
  // Reproduce macOS's caller-case preservation on every OS; the native resolver stays real.
  const nonNative = jest
    .spyOn(require('fs') as typeof fs, 'realpathSync')
    .mockImplementation((...args) => {
      if (args[0] === alias.dbPath) return alias.dbPath;
      return original(...args);
    });
  Object.assign(nonNative, { native: original.native });
  expect(fs.realpathSync(alias.dbPath)).not.toBe(fs.realpathSync.native(alias.dbPath));
  expect(fs.realpathSync.native(alias.dbPath)).toBe(fs.realpathSync.native(target.dbPath));

  const observed = record({ idsInjected: ['d:42'] });
  telemetry.appendTelemetry(observed, alias, env);
  expect(telemetry.readTelemetryReport(target, env)).toMatchObject({
    available: true,
    files: 1,
    warnings: [],
    records: [observed],
  });
  expect(telemetry.readTelemetry(alias, env)).toEqual([observed]);
  expect(fs.readdirSync(telemetry.telemetryRoot(env))).toHaveLength(1);
});
it.each(['same-project', 'other-repo', 'symlink'])(
  'refuses a destination inside a repository or store (%s)',
  (kind) => {
    const repo = kind === 'same-project' ? path.join(root, 'project') : path.join(root, 'other');
    fs.mkdirSync(repo, { recursive: true });
    if (kind !== 'same-project') fs.writeFileSync(path.join(repo, '.git'), 'gitdir: elsewhere');
    if (kind === 'symlink') {
      fs.symlinkSync(repo, env.RBOOK_CONFIG_DIR!);
    } else env.RBOOK_CONFIG_DIR = path.join(repo, 'config');
    telemetry.appendTelemetry(record(), target, env);
    expect(fs.existsSync(telemetry.telemetryDir(target, env))).toBe(false);
    expect(report()).toMatchObject({
      available: false,
      records: [],
      warnings: [expect.stringContaining('unsafe')],
    });
  }
);
it('rejects a monthly file symlink so append cannot escape into a repository', () => {
  const dir = telemetry.telemetryDir(target, env);
  fs.mkdirSync(dir, { recursive: true });
  const victim = path.join(root, 'private-file');
  fs.writeFileSync(victim, 'unchanged');
  fs.symlinkSync(victim, path.join(dir, telemetry.monthFile(new Date())));
  telemetry.appendTelemetry(record(), target, env);
  expect(fs.readFileSync(victim, 'utf8')).toBe('unchanged');
});
it('separates missing, corrupt and unreadable telemetry from measured zeroes', () => {
  expect(report()).toMatchObject({
    available: false,
    files: 0,
    records: [],
    warnings: [expect.stringContaining('missing')],
  });
  const dir = telemetry.telemetryDir(target, env);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, telemetry.monthFile(new Date()));
  fs.writeFileSync(file, `${JSON.stringify(record())}\n{broken\n{}\n`);
  expect(report()).toMatchObject({
    available: true,
    files: 1,
    records: [expect.objectContaining({ ok: true })],
    warnings: [expect.stringContaining('corrupt')],
  });
  fs.rmSync(file);
  fs.mkdirSync(file);
  expect(report()).toMatchObject({
    available: false,
    files: 1,
    records: [],
    warnings: [expect.stringContaining('unreadable')],
  });
});
it('opens store identity read-only, handles legacy/null metadata, and never creates a missing store', () => {
  const resolve = (telemetry as any).targetForStore as (file: string) => TelemetryTarget | null;
  expect(resolve(target.dbPath)).toBeNull();
  expect(fs.existsSync(target.dbPath)).toBe(false);
  fs.mkdirSync(path.dirname(target.dbPath), { recursive: true });
  const db = new Database(target.dbPath);
  db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)');
  insert.run('project_name', 'Name');
  insert.run('dashboard_slug', 'slug');
  insert.run('project_id', null);
  expect(resolve(target.dbPath)).toEqual({ ...target, projectId: 'slug' });
  insert.run('project_id', 'stable');
  expect(resolve(target.dbPath)?.projectId).toBe('stable');
  db.exec('DELETE FROM metadata');
  expect(resolve(target.dbPath)?.projectId).toBe('unknown-project');
  expect(db.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table')).toEqual([
    { name: 'metadata' },
  ]);
  db.exec('DROP TABLE metadata');
  expect(resolve(target.dbPath)).toBeNull();
  db.close();
});

it('caps restated rules after filtering their type so unrelated IDs cannot hide measured rules', () => {
  const rules = Array.from({ length: 100 }, (_, i) => `c:${i}`);
  telemetry.appendTelemetry(
    record({ restatedRuleIds: [...Array.from({ length: 100 }, (_, i) => `d:${i}`), ...rules] }),
    target,
    env
  );
  expect(telemetry.readTelemetry(target, env)[0].restatedRuleIds).toEqual(rules);
});
it('reports entirely corrupt files as unavailable rather than a measured zero', () => {
  const dir = telemetry.telemetryDir(target, env);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, telemetry.monthFile(new Date())), '{}\nnull\n');
  expect(report()).toMatchObject({
    available: false,
    files: 1,
    records: [],
    warnings: [expect.stringContaining('corrupt')],
  });
});
// s106-m01: an MCP row carries its identity lookup's time and, on a refusal, the parameter the refusal
// named. A row written before either existed has neither key, so a reader can tell an unmeasured row
// from a measured zero; hook and CLI rows never carry them.
it('keeps lookupMs and refusedField on MCP rows only, and leaves a legacy row unmeasured', () => {
  const mcp = {
    surface: 'mcp' as const,
    tool: 'rbook_decisions',
    action: 'record',
    mode: 'write' as const,
  };
  const refusal = { ok: false, refused: 'INVALID_PARAMETER' };
  telemetry.appendTelemetry(
    record({ ...mcp, ...refusal, lookupMs: 4012, refusedField: 'content' }),
    target,
    env
  );
  telemetry.appendTelemetry(record({ ...mcp, lookupMs: null, refusedField: null }), target, env);
  telemetry.appendTelemetry(record({ ...mcp, lookupMs: 0, refusedField: null }), target, env);
  telemetry.appendTelemetry(record({ ...mcp, ...refusal }), target, env);
  telemetry.appendTelemetry(record({ lookupMs: 7, refusedField: 'content' }), target, env);
  telemetry.appendTelemetry(
    record({ surface: 'cli', tool: 'review', lookupMs: 7, refusedField: 'content' }),
    target,
    env
  );
  const rows = telemetry.readTelemetry(target, env);
  expect(rows).toHaveLength(6);
  expect(rows[0]).toMatchObject({ lookupMs: 4012, refusedField: 'content' });
  expect(rows[1]).toMatchObject({ lookupMs: null, refusedField: null });
  expect(rows[2]).toMatchObject({ lookupMs: 0, refusedField: null });
  for (const row of rows.slice(3)) {
    expect(row).not.toHaveProperty('lookupMs');
    expect(row).not.toHaveProperty('refusedField');
  }
});

it.each([
  ['a negative time', { lookupMs: -1 }],
  ['a fractional time', { lookupMs: 1.5 }],
  ['a time as text', { lookupMs: '12' }],
  ['an unsafe integer', { lookupMs: Number.MAX_SAFE_INTEGER + 1 }],
  ['a field holding free text', { refusedField: 'private free text' }],
  ['an overlong field', { refusedField: `a${'b'.repeat(64)}` }],
  ['an empty field', { refusedField: '' }],
  ['a field that is not text', { refusedField: 42 }],
  ['a field on a row that was not refused', { refusedField: 'content', ok: true, refused: null }],
])('drops %s at the boundary instead of storing it', (_case, extra) => {
  telemetry.appendTelemetry(
    record({
      surface: 'mcp',
      tool: 'rbook_decisions',
      action: 'record',
      mode: 'write',
      ok: false,
      refused: 'INVALID_PARAMETER',
      ...(extra as Partial<TelemetryRecord>),
    }),
    target,
    env
  );
  const [row] = telemetry.readTelemetry(target, env);
  for (const key of Object.keys(extra).filter((name) => !['ok', 'refused'].includes(name)))
    expect(row).not.toHaveProperty(key);
  const dir = telemetry.telemetryDir(target, env);
  const raw = fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));
  expect(raw.join('')).not.toContain('private');
});

it('names one anonymous bucket that the writer and every reader share', () => {
  const anonymous = telemetry.unattributedTarget(env);
  expect(anonymous).toEqual({
    projectId: 'unattributed',
    dbPath: path.join(env.RBOOK_CONFIG_DIR!, 'unattributed.sqlite'),
  });
  expect(telemetry.telemetryKey(anonymous)).toMatch(/^[a-f0-9]{16}$/);
});

it('preserves technical pid/session fields and allows unassigned records under the config directory', () => {
  target = {
    projectId: 'unattributed',
    dbPath: path.join(env.RBOOK_CONFIG_DIR!, 'unattributed.sqlite'),
  };
  const session = `pid:1234abcd:${process.pid}:${Date.now()}`;
  telemetry.appendTelemetry(
    record({
      session,
      surface: 'mcp',
      tool: 'rbook_review',
      action: 'list',
      mode: 'read',
      refused: 'PROJECT_NOT_FOUND',
      failOpen: 'store',
      ceremony: '/reasonbook:close',
    }),
    target,
    env
  );
  expect(telemetry.readTelemetry(target, env)[0]).toMatchObject({
    session,
    tool: 'rbook_review',
    refused: 'PROJECT_NOT_FOUND',
    failOpen: 'store',
    ceremony: '/reasonbook:close',
  });
});
