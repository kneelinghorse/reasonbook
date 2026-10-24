// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A non-Claude hook launched by Claude must keep the child project's record and identity.
// ABOUTME: Verifies real SessionStart link behavior and telemetry while retaining Claude's native priority.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';
import * as digest from '../../src/cli/digest';
import '../../src/cli/session-start';
import {
  harnessLinkPath,
  harnessSessionHash,
  linkHarness,
  readHarnessLink,
} from '../../src/tools/rbook/harness-session';
import { readTelemetry, targetForStore } from '../../src/tools/rbook/local-telemetry';
import { seedRbookDb } from '../helpers/seedRbookDb';

const PORTABLE = ['codex', 'cursor', 'devin', 'copilot', 'vscode'];
let tmp: string;
let parentRoot: string;
let nativeRoot: string;
let nativeDb: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-hook-isolation-'));
  parentRoot = path.join(tmp, 'parent-claude');
  nativeRoot = path.join(tmp, 'native-project');
  seedRbookDb(parentRoot, { projectId: 'parent-project' });
  nativeDb = seedRbookDb(nativeRoot, { projectId: 'native-project' });
  env = {
    RBOOK_CONFIG_DIR: path.join(tmp, 'config'),
    CLAUDE_PID: String(process.pid),
    CLAUDE_PROJECT_DIR: parentRoot,
    CLAUDE_CODE_SESSION_ID: 'parent-session',
  };
  linkHarness('parent-session', 'startup', parentRoot, env);
  jest.spyOn(digest, 'buildDigest').mockResolvedValue('The native project digest.');
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function run(harness: string, includeCwd: boolean, hookEnv = env) {
  const input = {
    ...(includeCwd ? { cwd: nativeRoot } : {}),
    ...(harness === 'copilot' ? { sessionId: 'native-session' } : { session_id: 'native-session' }),
    source: 'startup',
  };
  let stdout = '';
  const stderr: string[] = [];
  const code = await runCli(['hook', 'session-start', '--harness', harness], {
    env: hookEnv,
    cwd: nativeRoot,
    // s98-m08: room load cannot spend (#1558); this test checks what the hook does, not its deadline.
    startedAtMs: Date.now() + 20_000,
    readStdin: async () => JSON.stringify(input),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr.push(text);
    },
  });
  return { code, stdout, stderr };
}

// Hook folders can come from environment or payload rather than the caller's shell cwd.
// Printed remedies must therefore keep their concrete target even when CLI resolution says cwd.
it.each(PORTABLE)(
  '%s uses its payload project and never rewrites the inherited Claude link',
  async (harness) => {
    const priorLink = fs.readFileSync(harnessLinkPath(process.pid, env), 'utf8');
    const result = await run(harness, true);
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(digest.buildDigest).toHaveBeenCalledWith(
      nativeRoot,
      expect.anything(),
      expect.any(Number),
      'explicit',
      true
    );
    expect(fs.readFileSync(harnessLinkPath(process.pid, env), 'utf8')).toBe(priorLink);
    expect(env.CLAUDE_PROJECT_DIR).toBe(parentRoot);
    expect(env.CLAUDE_PID).toBe(String(process.pid));
  }
);

it.each(PORTABLE)(
  '%s falls back to its own cwd when the payload carries no project',
  async (harness) => {
    const priorLink = fs.readFileSync(harnessLinkPath(process.pid, env), 'utf8');
    await run(harness, false);
    expect(digest.buildDigest).toHaveBeenCalledWith(
      nativeRoot,
      expect.anything(),
      expect.any(Number),
      'explicit',
      true
    );
    expect(fs.readFileSync(harnessLinkPath(process.pid, env), 'utf8')).toBe(priorLink);
  }
);

it.each(PORTABLE)('%s telemetry names the real harness instead of Claude Code', async (harness) => {
  const isolatedEnv = { RBOOK_CONFIG_DIR: env.RBOOK_CONFIG_DIR };
  await run(harness, true, isolatedEnv);
  const records = readTelemetry(targetForStore(nativeDb)!, isolatedEnv);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ client: harness, surface: 'hook', ok: true });
});

it('a refused native event cannot attribute its failure to the parent Claude project', async () => {
  await runCli(['hook', 'prompt', '--harness', 'cursor'], {
    env,
    cwd: nativeRoot,
    // s98-m08: room load cannot spend (#1558); this test checks what the hook does, not its deadline.
    startedAtMs: Date.now() + 20_000,
    readStdin: async () => JSON.stringify({ cwd: nativeRoot, prompt: 'approved' }),
    stdout: () => {},
    stderr: () => {},
  });
  const records = readTelemetry(targetForStore(nativeDb)!, env);
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ client: 'cursor', ok: false });
  const parentDb = path.join(parentRoot, 'rbook', 'db', 'rbook.sqlite');
  expect(readTelemetry(targetForStore(parentDb)!, env)).toEqual([]);
});

it('Claude retains its environment project priority and verified process link', async () => {
  await run('claude', true);
  expect(digest.buildDigest).toHaveBeenCalledWith(
    parentRoot,
    expect.anything(),
    expect.any(Number),
    'explicit',
    true
  );
  expect(readHarnessLink(process.pid, env)).toMatchObject({
    hash: harnessSessionHash('native-session'),
    projectDir: parentRoot,
  });
});

it('review carries the environment-selected root into remedies outside the shell folder', async () => {
  const code = await runCli(['review'], {
    env,
    cwd: nativeRoot,
    readStdin: async () => '',
    stdout: () => {},
    stderr: () => {},
  });
  expect(code).toBe(0);
  expect(digest.buildDigest).toHaveBeenCalledWith(
    parentRoot,
    expect.anything(),
    Infinity,
    'explicit'
  );
});
