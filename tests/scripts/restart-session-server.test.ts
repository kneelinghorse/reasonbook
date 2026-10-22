// SPDX-License-Identifier: Apache-2.0
// ABOUTME: scripts/restart-session-server.sh, run for real under fake MCP hosts: it stops the server its
// ABOUTME: own host started from this checkout, leaves another host's alone, and fails loud otherwise.

/**
 * The MCP host starts the Reasonbook server once per session, and that process keeps the code it loaded,
 * so after `npm run build` every Reasonbook call still runs the old build. Sprint-92's build session ran
 * on a server nine and a half hours older than its last build. The script stops the session's own
 * server, and Claude Code starts it again, on the current build, at the next tool call.
 *
 * Each case builds the process shape an agent session has: a host process with the server as its
 * child, and the script run by that same host. Every server path is under a temporary checkout, so
 * no case can match a real Reasonbook server.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'restart-session-server.sh');

/**
 * A fake host. It starts `node $SERVER_ENTRY $SERVER_ARGS` as its child when SERVER_ENTRY is set,
 * and `node $HOOK_ARGS` beside it when HOOK_ARGS is set (a hook running from the same bin), then
 * either holds (another session) or runs the script as its own child and reports what happened.
 * The paths travel in the environment, not argv, so the host's own command line never matches.
 */
const HOST = `
const { spawn, spawnSync } = require('child_process');
const entry = process.env.SERVER_ENTRY;
const args = JSON.parse(process.env.SERVER_ARGS || '[]');
const server = entry ? spawn(process.execPath, [entry, ...args], { stdio: 'ignore' }) : null;
const sibling = entry && process.env.SHARED_HOST === '1'
  ? spawn(process.execPath, [entry, ...args], { stdio: 'ignore' }) : null;
const hookArgs = process.env.HOOK_ARGS ? JSON.parse(process.env.HOOK_ARGS) : null;
const hook = hookArgs ? spawn(process.execPath, hookArgs, { stdio: 'ignore' }) : null;
const exited = server
  ? new Promise((resolve) => server.on('exit', (code, signal) => resolve({ code, signal })))
  : Promise.resolve(null);
setTimeout(async () => {
  if (process.env.MODE === 'hold') {
    process.stdout.write(JSON.stringify({ serverPid: server.pid }) + '\\n');
    return;
  }
  const scriptArgs = process.env.OMIT_PID === '1' ? [] : ['--pid',
    process.env.TARGET_HOOK === '1' ? String(hook.pid) : process.env.TARGET_PID || String(server ? server.pid : process.pid)];
  const run = spawnSync('bash', [process.env.SCRIPT, ...scriptArgs], { encoding: 'utf8' });
  const serverExit = server
    ? await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('alive'), 2000))])
    : null;
  if (server && serverExit === 'alive') server.kill('SIGKILL');
  let siblingAlive = null;
  if (sibling) {
    try { process.kill(sibling.pid, 0); siblingAlive = true; } catch { siblingAlive = false; }
    sibling.kill('SIGKILL');
  }
  let hookAlive = null;
  if (hook) {
    try { process.kill(hook.pid, 0); hookAlive = true; } catch { hookAlive = false; }
  }
  process.stdout.write(JSON.stringify({
    status: run.status, stdout: run.stdout, stderr: run.stderr,
    serverPid: server ? server.pid : null, serverExit,
    hookPid: hook ? hook.pid : null, hookAlive,
    siblingAlive,
  }) + '\\n');
  process.exit(0);
}, 300);
`;

interface HostReport {
  status: number;
  stdout: string;
  stderr: string;
  serverPid: number | null;
  serverExit: { code: number | null; signal: string | null } | 'alive' | null;
  hookPid: number | null;
  hookAlive: boolean | null;
  siblingAlive: boolean | null;
}

let checkout: string;
let entry: string;
let script: string;
const held: ChildProcess[] = [];
const heldServers: number[] = [];

beforeEach(() => {
  checkout = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-session-server-'));
  fs.mkdirSync(path.join(checkout, 'scripts'));
  script = path.join(checkout, 'scripts', 'restart-session-server.sh');
  fs.copyFileSync(SCRIPT, script);
  entry = path.join(checkout, 'dist', 'index.js');
});

afterEach(() => {
  for (const pid of heldServers.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const host of held.splice(0)) host.kill('SIGKILL');
  fs.rmSync(checkout, { recursive: true, force: true });
});

function writeServer(file: string = entry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'setInterval(() => {}, 1000);\n');
}

function runHost(
  withServer: boolean,
  options: {
    entry?: string;
    args?: string[];
    hookArgs?: string[];
    sharedHost?: boolean;
    omitPid?: boolean;
    targetPid?: number;
    targetHook?: boolean;
  } = {}
): Promise<HostReport> {
  return new Promise((resolve, reject) => {
    const host = spawn(process.execPath, ['-e', HOST], {
      env: {
        ...process.env,
        SCRIPT: script,
        ...(withServer ? { SERVER_ENTRY: options.entry ?? entry } : {}),
        ...(options.args ? { SERVER_ARGS: JSON.stringify(options.args) } : {}),
        ...(options.hookArgs ? { HOOK_ARGS: JSON.stringify(options.hookArgs) } : {}),
        ...(options.sharedHost ? { SHARED_HOST: '1' } : {}),
        ...(options.omitPid ? { OMIT_PID: '1' } : {}),
        ...(options.targetPid ? { TARGET_PID: String(options.targetPid) } : {}),
        ...(options.targetHook ? { TARGET_HOOK: '1' } : {}),
      },
    });
    let out = '';
    host.stdout.on('data', (chunk) => (out += String(chunk)));
    host.on('error', reject);
    // s98-m08 (#660 item 7): 'close', not 'exit', which Node documents can fire before stdio closes.
    host.on('close', () => resolve(JSON.parse(out) as HostReport));
  });
}

/** Another session: a host that keeps its own server from the same checkout running. */
function holdOtherSession(): Promise<number> {
  return new Promise((resolve, reject) => {
    const host = spawn(process.execPath, ['-e', HOST], {
      env: { ...process.env, SERVER_ENTRY: entry, MODE: 'hold' },
    });
    held.push(host);
    host.on('error', reject);
    host.stdout.on('data', (chunk) => {
      const { serverPid } = JSON.parse(String(chunk)) as { serverPid: number };
      heldServers.push(serverPid);
      resolve(serverPid);
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('scripts/restart-session-server.sh', () => {
  it('refuses an ambiguous shared host without stopping either chat server', async () => {
    writeServer();
    const report = await runHost(true, { sharedHost: true, omitPid: true });

    expect(report.status).toBe(1);
    expect(report.stderr).toContain('serverHealth.pid');
    expect(report.serverExit).toBe('alive');
    expect(report.siblingAlive).toBe(true);
  });

  it('stops only the explicitly identified chat server under a shared host', async () => {
    writeServer();
    const report = await runHost(true, { sharedHost: true });
    expect(report.status).toBe(0);
    expect(report.serverExit).toEqual({ code: null, signal: 'SIGTERM' });
    expect(report.siblingAlive).toBe(true);
    expect(report.stdout).toContain('reconnection is host-dependent');
  });

  it('requires identification even if only one server happens to share the host', async () => {
    writeServer();
    const report = await runHost(true, { omitPid: true });
    expect(report.status).toBe(1);
    expect(report.serverExit).toBe('alive');
  });

  it('refuses the PID of a matching server owned by an unrelated host', async () => {
    writeServer();
    const otherServer = await holdOtherSession();
    const report = await runHost(true, { targetPid: otherServer });
    expect(report.status).toBe(1);
    expect(report.serverExit).toBe('alive');
    expect(isAlive(otherServer)).toBe(true);
  });

  it('refuses a hook PID even when it belongs to the same host and checkout', async () => {
    writeServer();
    const bin = path.join(checkout, 'dist', 'bin.js');
    writeServer(bin);
    const report = await runHost(true, { hookArgs: [bin, 'hook', 'prompt'], targetHook: true });
    if (report.hookPid) heldServers.push(report.hookPid);
    expect(report.status).toBe(1);
    expect(report.serverExit).toBe('alive');
    expect(report.hookAlive).toBe(true);
  });

  it("stops the server its own host started, and leaves another session's server running", async () => {
    writeServer();
    const otherServer = await holdOtherSession();

    const report = await runHost(true);

    expect(report.status).toBe(0);
    expect(report.stdout).toContain(`Stopped Reasonbook server ${report.serverPid} `);
    expect(report.serverExit).toEqual({ code: null, signal: 'SIGTERM' });
    expect(isAlive(otherServer)).toBe(true);
  });

  it('refuses when the checkout has no build to restart onto', async () => {
    const report = await runHost(false);

    expect(report.status).toBe(1);
    expect(report.stderr).toContain(`No build at ${entry}`);
  });

  it('fails loud when no host above it runs a server from this checkout', async () => {
    writeServer();
    const otherServer = await holdOtherSession();

    const report = await runHost(false);

    expect(report.status).toBe(1);
    expect(report.stderr).toContain(
      `not a Reasonbook server running ${path.join(checkout, 'dist')} under this session.`
    );
    expect(isAlive(otherServer)).toBe(true);
  });

  // s93-m01: the bin moved to dist/bin.js, which also runs the hook verbs. A server started through
  // it (no verb, or `serve`) is stopped; a hook running from it under the same host is not a server.
  it.each([
    ['no verb', []],
    ['serve', ['serve']],
    ['a server flag', ['--project-root', '/tmp']],
  ])(
    'stops a server started through dist/bin.js with %s, and leaves a hook alone',
    async (_, args) => {
      writeServer();
      const bin = path.join(checkout, 'dist', 'bin.js');
      writeServer(bin);

      const report = await runHost(true, {
        entry: bin,
        args: [...args],
        hookArgs: [bin, 'hook', 'session-start'],
      });
      if (report.hookPid) heldServers.push(report.hookPid);

      expect(report.status).toBe(0);
      expect(report.stdout).toContain(`Stopped Reasonbook server ${report.serverPid} `);
      expect(report.serverExit).toEqual({ code: null, signal: 'SIGTERM' });
      expect(report.hookAlive).toBe(true);
    }
  );
});
