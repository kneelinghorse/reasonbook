// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises first-prompt delivery through the real hook boundary and its telemetry.
// ABOUTME: Retrieval is controlled here so output caps, retries, state and read context are independent tests.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import { readTelemetry } from '../../src/tools/rbook/local-telemetry';
import { currentToolCallActionMode } from '../../src/tools/rbook/tool-call-context';
import { seedRbookDb } from '../helpers/seedRbookDb';

const recall = jest.fn();
jest.mock('../../src/tools/rbook/first-prompt-recall', () => ({
  recallFirstPrompt: (...args: unknown[]) => recall(...args),
}));

let tmp: string;
let root: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-prompt-recall-'));
  root = path.join(tmp, 'project');
  dbPath = seedRbookDb(root, { projectId: 'prompt-test' });
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(tmp, 'config'), CLAUDE_PROJECT_DIR: '' };
  recall.mockReset();
  recall.mockReturnValue({
    available: true,
    warnings: [],
    localProjectId: 'prompt-test',
    items: Array.from({ length: 5 }, (_, index) => ({
      kind: 'decision',
      id: index + 1,
      status: 'active',
      projectId: null,
      text: `Record ${index + 1} ${'meaningful context '.repeat(30)}`,
      truncated: true,
    })),
  });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function hook(input: Record<string, string> = {}, override: Partial<CliIo> = {}) {
  let stdout = '';
  const stderr: string[] = [];
  const io: CliIo = {
    env,
    cwd: root,
    readStdin: async () =>
      JSON.stringify({
        session_id: 'session-one',
        prompt: 'Explain the previous decisions on database safety',
        ...input,
      }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr.push(text);
    },
    // s98-m08: room load cannot spend (#1558); this test checks what the hook does, not its deadline.
    startedAtMs: Date.now() + 20_000,
    ...override,
  };
  const code = await runCli(['hook', 'prompt', '--format', 'text'], io);
  return { code, stdout, stderr };
}

it('delivers all five complete previews within1500 and measures exactly their typed IDs once', async () => {
  const first = await hook();
  expect(first.code).toBe(0);
  expect(first.stdout.length).toBeLessThanOrEqual(1501);
  for (let id = 1; id <= 5; id++) expect(first.stdout).toContain(`  • d:${id} `);
  expect((await hook()).stdout).toBe('');
  expect(recall).toHaveBeenCalledTimes(1);
  const records = readTelemetry({ projectId: 'prompt-test', dbPath }, env);
  expect(records[0].idsInjected).toEqual(['d:1', 'd:2', 'd:3', 'd:4', 'd:5']);
  expect(records[0].charsInjected).toBe(first.stdout.trimEnd().length);
  expect(records[1].idsInjected).toEqual([]);
});

it('runs retrieval as a read and leaves every store byte unchanged', async () => {
  const original = recall.getMockImplementation()!;
  recall.mockImplementation((...args) => {
    expect(currentToolCallActionMode()).toBe('read');
    return original(...args);
  });
  const before = fs.readFileSync(dbPath);
  expect((await hook()).stdout).toContain('d:1');
  expect(fs.readFileSync(dbPath)).toEqual(before);
});

it('a failed query retries, while an available empty search consumes the attempt', async () => {
  recall.mockReturnValueOnce({
    available: false,
    warnings: ['search index unavailable'],
    localProjectId: 'prompt-test',
    items: [],
  });
  const failed = await hook();
  expect(failed.stdout).toBe('');
  expect(failed.stderr.join(' ')).toContain('search index unavailable');
  expect((await hook()).stdout).toContain('d:1');
  recall.mockReturnValue({
    available: true,
    warnings: [],
    localProjectId: 'prompt-test',
    items: [],
  });
  await hook({ session_id: 'empty-session' });
  await hook({ session_id: 'empty-session' });
  expect(recall).toHaveBeenCalledTimes(3);
});

it('does not consume a blank prompt, missing session or ambient-off request', async () => {
  await hook({ prompt: '' });
  await hook({ session_id: '' });
  await hook({}, { env: { ...env, RBOOK_AMBIENT: 'off' } });
  expect(recall).not.toHaveBeenCalled();
  expect((await hook()).stdout).toContain('d:1');
});

it('rolls back stdout failure and marks timed-out work unavailable without late output', async () => {
  const failed = await hook(
    {},
    {
      stdout: () => {
        throw new Error('output unavailable');
      },
    }
  );
  expect(failed.stderr.join(' ')).toContain('output unavailable');
  expect((await hook()).stdout).toContain('d:1');
  const late = await hook({ session_id: 'late-session' }, { startedAtMs: Date.now() - 900 });
  expect(late.stdout).toBe('');
  expect((await hook({ session_id: 'late-session' })).stdout).toContain('d:1');
});

it('frames foreign preview text and excludes its local-looking id from measurements', async () => {
  recall.mockReturnValue({
    available: true,
    warnings: [],
    localProjectId: 'prompt-test',
    items: [
      {
        kind: 'decision',
        id: 9,
        status: 'active',
        projectId: 'other-project',
        text: 'Foreign text',
        truncated: false,
      },
    ],
  });
  const result = await hook();
  expect(result.stdout).toContain('⟪untrusted, from proj:other-project⟫');
  expect(readTelemetry({ projectId: 'prompt-test', dbPath }, env)[0].idsInjected).toEqual([]);
});

it('unsafe runtime configuration fails visibly without writing a hook failure log into the project', async () => {
  const before = fs.readFileSync(dbPath);
  const result = await hook({}, { env: { ...env, RBOOK_CONFIG_DIR: root } });
  expect(result.stdout).toBe('');
  expect(result.stderr.join(' ')).toMatch(/unsafe|outside|linked/);
  expect(fs.existsSync(path.join(root, 'runtime'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'telemetry'))).toBe(false);
  expect(fs.readFileSync(dbPath)).toEqual(before);
  expect((await hook()).stdout).toContain('d:1');
});

it('uses the synchronous hook writer before recording delivery, leaving async stdout unused', async () => {
  const queued = jest.fn();
  const write = jest.fn(() => {
    throw Object.assign(new Error('broken pipe'), { code: 'EPIPE' });
  });
  const result = await hook({}, { stdout: queued, hookStdout: write });
  expect(write).toHaveBeenCalledTimes(1);
  expect(queued).not.toHaveBeenCalled();
  expect(result.stderr.join(' ')).toContain('broken pipe');
  expect(readTelemetry({ projectId: 'prompt-test', dbPath }, env)[0]).toMatchObject({
    ok: false,
    idsInjected: [],
  });
  expect((await hook()).stdout).toContain('d:1');
});

it('later prompts emit three unseen keyword decisions and skip short approvals after telemetry', async () => {
  const db = new Database(dbPath);
  for (let id = 1; id <= 9; id++)
    db.prepare(
      "INSERT INTO strategic_decisions (id,decision_text,created_at,status) VALUES (?,?,?,'active')"
    ).run(id, `Transactional database safety receipts decision ${id}.`, new Date().toISOString());
  db.close();
  const before = fs.readFileSync(dbPath);
  await hook(); // The approved first-prompt five remain unchanged.
  const later = await hook({
    prompt: 'Explain transactional database safety receipts for this change',
  });
  expect(later.stdout.match(/ {2}• d:/g)).toHaveLength(3);
  for (const id of [1, 2, 3, 4, 5]) expect(later.stdout).not.toContain(`  • d:${id} `);
  expect(later.stdout.length).toBeLessThanOrEqual(1501);
  const rest = await hook({
    prompt: 'Explain transactional database safety receipts for this change',
  });
  expect(rest.stdout.match(/ {2}• d:/g)).toHaveLength(1);
  const approved = await hook({ prompt: 'approved' });
  expect(approved.stdout).toBe('');
  expect(readTelemetry({ projectId: 'prompt-test', dbPath }, env)).toHaveLength(4);
  expect(recall).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(dbPath)).toEqual(before);
});
