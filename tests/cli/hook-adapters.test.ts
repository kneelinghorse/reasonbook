// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Native harness payloads must reach the shared CLI without invented session or turn identities.
// ABOUTME: Output uses each harness's injection envelope; unsupported prompt injection cannot consume recall.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../src/cli';
import { seedRbookDb } from '../helpers/seedRbookDb';

const verb = jest.fn();
jest.mock('../../src/cli/session-start', () => ({ run: (...args: unknown[]) => verb(...args) }));
jest.mock('../../src/cli/prompt', () => ({ run: (...args: unknown[]) => verb(...args) }));
jest.mock('../../src/cli/stop', () => ({ run: (...args: unknown[]) => verb(...args) }));
let tmp: string;
let root: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-adapters-'));
  root = path.join(tmp, 'project');
  seedRbookDb(root);
  verb.mockReset().mockResolvedValue('The project digest.');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function run(harness: string, event: string, input: object) {
  let stdout = '';
  const stderr: string[] = [];
  const code = await runCli(['hook', event, '--harness', harness], {
    cwd: root,
    env: { RBOOK_CONFIG_DIR: path.join(tmp, 'config') },
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

it('uses the Codex turn_id for retries and does not parse a foreign transcript as Claude JSONL', async () => {
  const input = {
    cwd: root,
    session_id: 'codex-session',
    turn_id: 'codex-turn',
    prompt: 'repeat this',
    transcript_path: '/foreign.jsonl',
  };
  const first = await run('codex', 'prompt', input);
  expect(JSON.parse(first.stdout).hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
  expect(verb.mock.calls[0][0].input).toMatchObject({
    session_id: 'codex-session',
    prompt_id: 'codex-turn',
  });
  expect(verb.mock.calls[0][0].input.transcript_path).toBeUndefined();
  expect((await run('codex', 'prompt', input)).stdout).toBe('');
  expect(verb).toHaveBeenCalledTimes(1);
});

it('maps Cursor conversation and workspace fields and emits its session-start envelope', async () => {
  const result = await run('cursor', 'session-start', {
    conversation_id: 'cursor-session',
    workspace_roots: [root],
    transcript_path: '/foreign.jsonl',
  });
  expect(JSON.parse(result.stdout)).toEqual({ additional_context: 'The project digest.' });
  expect(verb.mock.calls[0][0].input).toMatchObject({ session_id: 'cursor-session', cwd: root });
  expect(verb.mock.calls[0][0].input.transcript_path).toBeUndefined();
});

it('Copilot CLI and VS Code use their own documented session-start envelopes', async () => {
  expect(
    JSON.parse(
      (await run('copilot', 'session-start', { cwd: root, sessionId: 'copilot-session' })).stdout
    )
  ).toEqual({ additionalContext: 'The project digest.' });
  expect(JSON.parse((await run('vscode', 'session-start', { cwd: root })).stdout)).toEqual({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'The project digest.' },
  });
  expect(verb.mock.calls[0][0].input.session_id).toBe('copilot-session');
  expect(verb.mock.calls[1][0].input.session_id).toBeUndefined();
});

it.each(['cursor', 'copilot', 'vscode'])(
  '%s refuses unsupported prompt injection before consuming recall or approval state',
  async (harness) => {
    const result = await run(harness, 'prompt', { cwd: root, session_id: 's', prompt: 'approved' });
    expect(result.stdout).toBe('');
    expect(result.stderr.join('')).toMatch(/session-start only/i);
    expect(verb).not.toHaveBeenCalled();
  }
);

it('Devin cannot invent reply or transcript support that its documented Stop payload lacks', async () => {
  await run('devin', 'stop', {
    cwd: root,
    session_id: 'd',
    last_assistant_message: 'Would record: choice',
    transcript_path: '/foreign.jsonl',
  });
  expect(verb.mock.calls[0][0].input.last_assistant_message).toBeUndefined();
  expect(verb.mock.calls[0][0].input.transcript_path).toBeUndefined();
});

it('a mistyped harness fails open visibly instead of silently selecting the Claude contract', async () => {
  const result = await run('codxe', 'session-start', { cwd: root });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr.join('')).toMatch(/harness/i);
  expect(verb).not.toHaveBeenCalled();
});
