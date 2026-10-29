// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Forces missing and rejected observations through the failure-evidence collector.
// ABOUTME: Proves raw receipts and owned-child cleanup preserve the original assertion.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import * as telemetry from '../../src/tools/rbook/local-telemetry';
import { withTelemetryFailureEvidence } from './telemetry-failure-evidence';
import { spawn } from 'child_process';

let root: string;
let config: string;
let dbPath: string;
const record = (client = 'parallel-0/1'): telemetry.TelemetryRecord => ({
  ts: new Date().toISOString(),
  session: null,
  surface: 'mcp',
  client,
  tool: 'rbook_review',
  action: null,
  mode: 'read',
  ok: true,
  refused: null,
  failOpen: null,
  ambient: null,
});
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
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-evidence-'));
  config = path.join(root, 'config');
  dbPath = path.join(root, 'project', 'rbook', 'db', 'rbook.sqlite');
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(['missing', 'unattributed', 'corrupt', 'unreadable'])(
  'retains %s evidence and rethrows the exact two-client assertion after owned cleanup',
  async (kind) => {
    store().close();
    telemetry.appendTelemetry(record(), target(), env());
    const directory = telemetry.telemetryDir(target(), env());
    if (kind === 'unattributed')
      telemetry.appendTelemetry(record('parallel-1/1'), unattributed(), env());
    if (kind === 'corrupt')
      fs.appendFileSync(path.join(directory, telemetry.monthFile(new Date())), '{broken\n');
    if (kind === 'unreadable') {
      const previous = new Date();
      previous.setUTCDate(1);
      previous.setUTCMonth(previous.getUTCMonth() - 1);
      fs.mkdirSync(path.join(directory, telemetry.monthFile(previous)));
    }
    const close = jest.fn(async () => 0);
    const retain = jest.fn();
    const stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const responses = [
      { structuredContent: { success: true } },
      { structuredContent: { success: true } },
    ];
    let original: unknown;
    await expect(
      withTelemetryFailureEvidence(
        async () => {
          try {
            expect(
              telemetry
                .readTelemetryReport(target(), env())
                .records.map((r) => r.client)
                .sort()
            ).toEqual(['parallel-0/1', 'parallel-1/1']);
          } catch (error) {
            original = error;
            throw error;
          }
        },
        {
          fixtureRoot: root,
          config,
          dbPath,
          responses,
          children: [{ child: { pid: 123 }, stderr: 'owned stderr', close }],
          retain,
        }
      )
    ).rejects.toBe(original);
    expect(retain).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'telemetry-failure.json'), 'utf8'));
    expect(receipt).toMatchObject({
      fixtureRoot: root,
      responses,
      projectTarget: target(),
      children: [{ pid: 123, stderr: 'owned stderr' }],
      cleanupErrors: [],
      captureErrors: [],
    });
    expect(receipt.projectReport.records).toHaveLength(1);
    expect(receipt.unattributedReport.records).toHaveLength(kind === 'unattributed' ? 1 : 0);
    expect(receipt.raw.entries.some((entry: any) => entry.raw?.includes('parallel-0/1'))).toBe(
      true
    );
    if (kind === 'corrupt') {
      expect(receipt.projectReport.warnings).toEqual([expect.stringContaining('corrupt')]);
      expect(receipt.raw.entries.some((entry: any) => entry.raw?.includes('{broken'))).toBe(true);
    }
    if (kind === 'unreadable')
      expect(receipt.projectReport.warnings).toEqual([expect.stringContaining('unreadable')]);
    expect(stderr.mock.calls.flat().join(' ')).toContain(path.join(root, 'telemetry-failure.json'));
  }
);

it('discloses a null target, all buckets and rejected links without reading their contents', async () => {
  store(false).close();
  telemetry.appendTelemetry(record(), unattributed(), env());
  const bucket = path.join(config, 'telemetry', 'another-bucket');
  fs.mkdirSync(bucket);
  fs.writeFileSync(path.join(bucket, 'extra.jsonl'), 'extra bucket\n');
  const secret = path.join(root, 'never-read');
  fs.writeFileSync(secret, 'secret sentinel');
  fs.symlinkSync(secret, path.join(bucket, 'linked.jsonl'));
  fs.symlinkSync(bucket, path.join(config, 'telemetry', 'linked-bucket'));
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const original = new Error('original assertion');
  await expect(
    withTelemetryFailureEvidence(
      async () => {
        throw original;
      },
      {
        fixtureRoot: root,
        config,
        dbPath,
        responses: [],
        children: [],
        retain: () => undefined,
      }
    )
  ).rejects.toBe(original);
  const raw = fs.readFileSync(path.join(root, 'telemetry-failure.json'), 'utf8');
  const receipt = JSON.parse(raw);
  expect(receipt.projectTarget).toBeNull();
  expect(receipt.projectReport).toBeNull();
  expect(receipt.unattributedReport.records).toHaveLength(1);
  expect(receipt.raw.entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'another-bucket/extra.jsonl', raw: 'extra bucket\n' }),
      expect.objectContaining({ path: 'another-bucket/linked.jsonl', kind: 'symlink' }),
      expect.objectContaining({ path: 'linked-bucket', kind: 'symlink' }),
    ])
  );
  expect(raw).not.toContain('secret sentinel');
});

it('does not hide the assertion when cleanup or evidence capture fails', async () => {
  store().close();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const original = new Error('original assertion');
  const close = jest.fn(async () => {
    throw new Error('cleanup failed');
  });
  await expect(
    withTelemetryFailureEvidence(
      async () => {
        throw original;
      },
      {
        fixtureRoot: root,
        config,
        dbPath,
        responses: [],
        children: [{ child: { pid: 123 }, stderr: '', close }],
        retain: () => undefined,
      }
    )
  ).rejects.toBe(original);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'telemetry-failure.json'), 'utf8'));
  expect(receipt.cleanupErrors).toEqual([expect.objectContaining({ message: 'cleanup failed' })]);
  fs.mkdirSync(path.join(root, 'unwritable'));
  fs.writeFileSync(path.join(root, 'unwritable', 'telemetry-failure.json'), 'occupied');
  await expect(
    withTelemetryFailureEvidence(
      async () => {
        throw original;
      },
      {
        fixtureRoot: path.join(root, 'not-a-directory'),
        config,
        dbPath,
        responses: [],
        children: [],
        retain: () => {
          throw new Error('retain failed');
        },
      }
    )
  ).rejects.toBe(original);
});

it('leaves healthy results and cleanup ownership unchanged and writes no receipt', async () => {
  const result = { success: true };
  const close = jest.fn();
  const retain = jest.fn();
  expect(
    await withTelemetryFailureEvidence(async () => result, {
      fixtureRoot: root,
      config,
      dbPath,
      responses: [],
      children: [{ child: {}, stderr: '', close }],
      retain,
    })
  ).toBe(result);
  expect(close).not.toHaveBeenCalled();
  expect(retain).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(root, 'telemetry-failure.json'))).toBe(false);
});

it('closes its supplied real child and captures stderr after stdio drains', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  const child = spawn(
    process.execPath,
    [
      '-e',
      "process.stdin.resume();process.stdin.on('end',()=>process.stderr.write('final diagnostic',()=>process.exit(0)));",
    ],
    { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  const close = jest.fn(async () => {
    child.stdin.end();
    return await exited;
  });
  const original = new Error('original assertion');
  try {
    await expect(
      withTelemetryFailureEvidence(
        async () => {
          throw original;
        },
        {
          fixtureRoot: root,
          config,
          dbPath,
          responses: [],
          children: [
            {
              child,
              get stderr() {
                return stderr;
              },
              close,
            },
          ],
          retain: () => undefined,
        }
      )
    ).rejects.toBe(original);
    expect(close).toHaveBeenCalledTimes(1);
    expect(child.exitCode).toBe(0);
    expect(child.stderr.closed).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'telemetry-failure.json'), 'utf8'));
    expect(receipt.children).toEqual([{ pid: child.pid, stderr: 'final diagnostic' }]);
    expect(receipt.cleanupErrors).toEqual([]);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await exited;
    }
  }
});
