// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Drives compact markers, digest delivery and factual session close through real hook entry points.
// ABOUTME: Failed output preserves retry state, successful close cleans only transient state and never invents a session.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';
import * as digest from '../../src/cli/digest';
import { observeRenderedContext } from '../../src/cli/telemetry';
import { hookRuntimeIdentity } from '../../src/cli/hook-runtime';
import { hasCompactMarker, lifecyclePaths } from '../../src/cli/lifecycle-runtime';
import { ensureHarnessSession } from '../../src/cli/harness-ops';
import * as harnessOps from '../../src/cli/harness-ops';
import * as lifecycle from '../../src/cli/lifecycle-runtime';
import { recallStatePath } from '../../src/cli/recall-runtime';
import { setExternalSessionOwner } from '../../src/tools/rbook/session-owner';
import { seedRbookDb } from '../helpers/seedRbookDb';
let tmp: string;
let root: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
const savedConfig = process.env.RBOOK_CONFIG_DIR;
const text = '  • d:7 A concrete delivered decision.';
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-hook-lifecycle-'));
  root = path.join(tmp, 'project');
  dbPath = seedRbookDb(root, { projectId: 'lifecycle' });
  env = {
    ...process.env,
    RBOOK_CONFIG_DIR: path.join(tmp, 'config'),
    CLAUDE_PROJECT_DIR: root,
    CLAUDE_PID: String(process.pid),
    CLAUDE_CODE_SESSION_ID: '',
  };
  process.env.RBOOK_CONFIG_DIR = env.RBOOK_CONFIG_DIR;
  jest.spyOn(digest, 'buildDigest').mockImplementation(async (_root, io) => {
    observeRenderedContext(io, {
      text,
      returnedIds: ['d:7'],
      items: [{ typedId: 'd:7', start: 0, end: text.length }],
    });
    return text;
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  setExternalSessionOwner(null);
  if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});
function key() {
  return hookRuntimeIdentity({ session_id: 'lifecycle-session', cwd: root }, env)!;
}
/**
 * s96-m10 (#645): real Git answers the hook's repository probes, but under a 10 s timeout, so a loaded
 * machine cannot turn "not a Git repository" into "baseline timeout". The production timeout of each
 * probe is returned for the caller to check, as tests/cli/lifecycle-runtime.test.ts does.
 */
function unhurriedGit(): Array<number | undefined> {
  const timeouts: Array<number | undefined> = [];
  const childProcess = require('child_process') as typeof import('child_process');
  const realExecFileSync = childProcess.execFileSync;
  jest.spyOn(childProcess, 'execFileSync').mockImplementation((file, args, options) => {
    if (file !== 'git' || !Array.isArray(args) || args[0] !== '--no-optional-locks')
      return realExecFileSync(file, args, options);
    timeouts.push(options?.timeout);
    return realExecFileSync('git', args, { ...options, timeout: 10_000 });
  });
  return timeouts;
}
async function hook(
  event: string,
  input: Record<string, string> = {},
  override: Partial<CliIo> = {}
) {
  let stdout = '';
  const stderr: string[] = [];
  const code = await runCli(['hook', event, '--format', 'text', '--hook-source', 'rbook-plugin'], {
    cwd: root,
    env,
    readStdin: async () => JSON.stringify({ session_id: 'lifecycle-session', cwd: root, ...input }),
    stdout: (value) => {
      stdout += value;
    },
    stderr: (value) => {
      stderr.push(value);
    },
    // s98-m08: room load cannot spend (#1558); this test checks what the hook does, not its deadline.
    startedAtMs: Date.now() + 20_000,
    ...override,
  });
  setExternalSessionOwner(null);
  return { code, stdout, stderr };
}
it('consumes PreCompact only after successful compact digest output and records its actual typed spans', async () => {
  expect((await hook('pre-compact')).stdout).toBe('');
  expect(hasCompactMarker(key(), env)).toBe(true);
  const failed = await hook(
    'session-start',
    { source: 'compact' },
    {
      stdout: () => {
        throw new Error('broken pipe');
      },
    }
  );
  expect(failed.stderr.join('')).toContain('broken pipe');
  expect(hasCompactMarker(key(), env)).toBe(true);
  expect((await hook('session-start', { source: 'compact' })).stdout).toContain('d:7');
  expect(hasCompactMarker(key(), env)).toBe(false);
  const state = new Database(recallStatePath('lifecycle-session', env), { readonly: true });
  expect(state.prepare('SELECT typed_id FROM seen').all()).toEqual([{ typed_id: 'd:7' }]);
  expect(state.prepare('SELECT * FROM delivery').all()).toEqual([]);
  state.close();
  expect((await hook('session-start', { source: 'compact' })).stdout).toContain('d:7');
});
it('closes only existing owned sessions with honest observations, preserving recall after duplicate end', async () => {
  const gitTimeouts = unhurriedGit();
  await hook('session-start', { source: 'startup' });
  const owned = await ensureHarnessSession(root, 'lifecycle-session');
  expect(owned).not.toBeNull();
  const recallBefore = fs.readFileSync(recallStatePath('lifecycle-session', env));
  expect(await hook('session-end')).toEqual({ code: 0, stdout: '', stderr: [] });
  const db = new Database(dbPath, { readonly: true });
  const row = db
    .prepare('SELECT status, summary FROM sessions WHERE id=?')
    .get(owned!.sessionId) as { status: string; summary: string };
  expect(row.status).toBe('completed');
  expect(row.summary).toContain('Repository observations (not agent authorship)');
  expect(row.summary).toContain('not a Git repository');
  const count = db.prepare('SELECT count(*) AS n FROM sessions').get();
  db.close();
  expect(fs.existsSync(lifecyclePaths(key(), env).baseline)).toBe(false);
  await hook('session-end');
  const after = new Database(dbPath, { readonly: true });
  expect(after.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual(count);
  after.close();
  expect(fs.readFileSync(recallStatePath('lifecycle-session', env))).toEqual(recallBefore);
  // The probe ran, and production still bounds every Git call at 100 ms.
  expect(gitTimeouts.length).toBeGreaterThan(0);
  for (const timeout of gitTimeouts) {
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThanOrEqual(100);
  }
});
it('never creates an empty Reasonbook session solely for exit observations', async () => {
  await hook('session-start', { source: 'startup' });
  expect(await hook('session-end')).toEqual({ code: 0, stdout: '', stderr: [] });
  const db = new Database(dbPath, { readonly: true });
  expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT count(*) AS n FROM session_events').get()).toEqual({ n: 0 });
  db.close();
});

it('does not begin close writes when Git observations exhaust the remaining deadline', async () => {
  await hook('session-start', { source: 'startup' });
  const owned = await ensureHarnessSession(root, 'lifecycle-session');
  expect(owned).not.toBeNull();
  const close = jest.spyOn(harnessOps, 'endHarnessSession');
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  jest.spyOn(lifecycle, 'gitObservations').mockImplementation(() => {
    now += 1001;
    return 'Repository observations: timeout; exit facts unavailable.';
  });
  // This test spends the production deadline, so its clock starts at the call, without the room.
  expect((await hook('session-end', {}, { startedAtMs: now })).stdout).toBe('');
  expect(close).not.toHaveBeenCalled();
  const db = new Database(dbPath, { readonly: true });
  expect(db.prepare('SELECT status FROM sessions WHERE id=?').get(owned!.sessionId)).toEqual({
    status: 'active',
  });
  db.close();
  expect(fs.existsSync(lifecyclePaths(key(), env).baseline)).toBe(true);
});
