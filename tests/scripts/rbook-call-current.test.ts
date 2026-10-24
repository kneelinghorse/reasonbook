// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises the current-build runner through real MCP stdio in a temporary checkout.
// ABOUTME: A mutation reaches the child only after verified build health, and every child is closed.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'rbook-call-current.js');
const SERVER = `
const fs = require('fs');
const { Server } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');
const log = (event) => fs.appendFileSync(process.env.CURRENT_CALL_LOG, JSON.stringify(event) + '\\n');
log({ event: 'start', pid: process.pid });
process.on('exit', () => log({ event: 'exit' }));
if (process.env.CURRENT_CALL_MODE === 'drain') {
  process.on('SIGTERM', () => { log({ event: 'signal' }); process.exit(0); });
  process.stdin.on('end', () => {
    log({ event: 'draining' });
    setTimeout(() => { log({ event: 'drained' }); process.exit(0); }, 3000);
  });
}
serveStdio(() => {
const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler('tools/call', async ({ params }) => {
  log({ event: 'call', name: params.name, args: params.arguments });
  if (params.name === 'rbook_agent_onboard') {
    const mode = process.env.CURRENT_CALL_MODE;
    const health = {
      codeIsCurrent: mode !== 'stale',
      startupBuild: mode === 'missing' ? null : { buildHash: 'current-build' },
      currentBuild: { buildHash: mode === 'mismatch' ? 'other-build' : 'current-build' },
    };
    if (mode === 'empty-hash') health.startupBuild.buildHash = health.currentBuild.buildHash = '';
    if (mode === 'preflight-error') {
      return { isError: true, content: [{ type: 'text', text: 'Onboard refused' }] };
    }
    return { content: [], structuredContent: { success: true, data: { serverHealth: health } } };
  }
  if (process.env.CURRENT_CALL_MODE === 'transport-error') process.exit(0);
  if (process.env.CURRENT_CALL_MODE === 'refusal') {
    return { content: [], structuredContent: { success: false, error: { code: 'REFUSED', message: 'No mutation' } } };
  }
  if (process.env.CURRENT_CALL_MODE === 'unstructured') {
    return { content: [{ type: 'text', text: 'unstructured receipt' }] };
  }
  return { content: [], structuredContent: { success: true, data: { marker: process.env.CURRENT_CALL_MARKER } } };
});
return server;
}, { legacy: 'serve' });
`;

let checkout: string;
let logPath: string;
let script: string;

beforeEach(() => {
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-call-current-'));
  logPath = path.join(checkout, 'calls.jsonl');
  fs.mkdirSync(path.join(checkout, 'scripts'));
  fs.mkdirSync(path.join(checkout, 'dist'));
  script = path.join(checkout, 'scripts', 'rbook-call-current.js');
  fs.copyFileSync(SCRIPT, script);
  fs.writeFileSync(path.join(checkout, 'dist', 'index.js'), SERVER);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(checkout, 'node_modules'), 'dir');
});

afterEach(() => fs.rmSync(checkout, { recursive: true, force: true }));

interface Report {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(request: unknown, mode = 'fresh'): Promise<Report> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        CURRENT_CALL_LOG: logPath,
        CURRENT_CALL_MODE: mode,
        CURRENT_CALL_MARKER: 'preserved environment',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(typeof request === 'string' ? request : JSON.stringify(request));
  });
}

function events(): Array<{ event: string; name?: string; pid?: number; args?: unknown }> {
  return fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
}

function request(): { name: string; arguments: { projectRoot: string; notes: string } } {
  return {
    name: 'rbook_mutation_fixture',
    arguments: { projectRoot: checkout, notes: 'literal $(do-not-execute) `text`' },
  };
}

function expectClosed(): void {
  const recorded = events();
  expect(recorded[recorded.length - 1]?.event).toBe('exit');
  const pid = recorded.find((event) => event.event === 'start')?.pid;
  expect(pid).toBeDefined();
  expect(() => process.kill(pid!, 0)).toThrow();
}

describe('scripts/rbook-call-current.js', () => {
  it('R11 lets the server finish its three-second stdin drain without a termination signal', async () => {
    const report = await run(request(), 'drain');
    expect(report.status).toBe(0);
    expect(events().map((event) => event.event)).toEqual([
      'start',
      'call',
      'call',
      'draining',
      'drained',
      'exit',
    ]);
    expectClosed();
  });

  it('executes exactly once after verified health, preserving arguments and environment', async () => {
    const input = request();
    const report = await run(input);
    expect(report.status).toBe(0);
    expect(JSON.parse(report.stdout)).toEqual({
      success: true,
      data: { marker: 'preserved environment' },
    });
    expect(events().filter((event) => event.event === 'start')).toHaveLength(1);
    expect(events().filter((event) => event.event === 'call')).toEqual([
      { event: 'call', name: 'rbook_agent_onboard', args: { projectRoot: checkout } },
      { event: 'call', name: input.name, args: input.arguments },
    ]);
    expectClosed();
  });

  it.each(['stale', 'mismatch', 'missing', 'empty-hash', 'preflight-error'])(
    'blocks mutation and closes its child when preflight is %s',
    async (mode) => {
      const report = await run(request(), mode);
      expect(report.status).toBe(1);
      expect(JSON.parse(report.stdout).success).toBe(false);
      expect(
        events()
          .filter((event) => event.event === 'call')
          .map((event) => event.name)
      ).toEqual(['rbook_agent_onboard']);
      expectClosed();
    }
  );

  it.each([
    { name: 'rbook_mutation_fixture', arguments: {} },
    { name: 'rbook_mutation_fixture', arguments: { projectRoot: ' ' } },
    { name: 'rbook_mutation_fixture', arguments: [] },
    { arguments: { projectRoot: '/explicit' } },
    '{broken JSON',
  ])('rejects malformed or unscoped input before spawning', async (input) => {
    const report = await run(input);
    expect(report.status).toBe(1);
    expect(JSON.parse(report.stdout).success).toBe(false);
    expect(events()).toEqual([]);
  });

  it('prints a structured tool refusal and returns failure instead of success', async () => {
    const report = await run(request(), 'refusal');
    expect(report.status).toBe(1);
    expect(JSON.parse(report.stdout)).toEqual({
      success: false,
      error: { code: 'REFUSED', message: 'No mutation' },
    });
    expectClosed();
  });

  it('retains the full response when the tool has no structured payload', async () => {
    const report = await run(request(), 'unstructured');
    expect(report.status).toBe(0);
    expect(JSON.parse(report.stdout)).toEqual({
      content: [{ type: 'text', text: 'unstructured receipt' }],
    });
    expectClosed();
  });

  it('fails loudly if the transport closes before a receipt arrives', async () => {
    const report = await run(request(), 'transport-error');
    expect(report.status).toBe(1);
    expect(JSON.parse(report.stdout).success).toBe(false);
    expectClosed();
  });
});
