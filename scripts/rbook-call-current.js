#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Calls one Reasonbook tool through an isolated stdio server from this checkout's current build.
// ABOUTME: Verifies build health before dispatch, waits for a close's own upload, and closes only its transport.

// Usage: node scripts/rbook-call-current.js < request.json
// Input: { "name": "rbook_review", "arguments": { "projectRoot": "/absolute/project" } }
// For hosts that cannot reconnect a stopped MCP server; this does not restart the host's connection.
// A close whose upload started is waited for up to 120 s (RBOOK_CALL_UPLOAD_CAP_MS; a mark must show
// within 30 s, RBOOK_CALL_UPLOAD_MARK_MS), so give the helper a Bash timeout of at least 300 s.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createInterface } = require('readline');
const { Client } = require('@modelcontextprotocol/client');

const checkout = path.resolve(__dirname, '..');

// s109-m04 (#799; settled item 11): a close whose answer says its upload started keeps its server
// alive until the upload it marked is seen delivered, for at most 120 s; a failed or paused upload
// waits out the cap. It is keyed on the registry's upload generations: before the call this reads
// the project's upload_generation, G; the close's explicit mark sets upload_explicit_generation above
// G, and only a success claimed after that mark clears it. The product's 20-second drain and this
// helper's stdout are unchanged; what it saw is one stderr line.
const POLL_MS = 500;
const MARK_MS = Number(process.env.RBOOK_CALL_UPLOAD_MARK_MS) || 30_000;
const CAP_MS = Number(process.env.RBOOK_CALL_UPLOAD_CAP_MS) || 120_000;

const message = (error) => (error instanceof Error ? error.message : String(error));

/**
 * The environment the server will resolve its folders from, for the helper's reads only; the server
 * itself gets the caller's environment unchanged (verifier B, round 2, N1). The server fills it from
 * its .env with the rule both share (N3), and runs in the checkout, where a relative or empty config
 * folder resolves (critic B, F2).
 */
function readEnvironment(compat) {
  const env = { ...process.env };
  if (compat.getSetting('RBOOK_EDITION', env) !== 'directory') {
    const root = path.resolve(checkout, compat.getSetting('RBOOK_PROJECT_ROOT', env) ?? checkout);
    const file = path.join(root, '.env');
    if (fs.existsSync(file)) compat.fillFromEnvFile(env, fs.readFileSync(file, 'utf8'));
  }
  for (const name of ['RBOOK_CONFIG_DIR', 'CMOS_CONFIG_DIR'])
    if (env[name] !== undefined && !path.isAbsolute(env[name]))
      env[name] = path.resolve(checkout, env[name]);
  return env;
}

/**
 * This project's upload state, read-only with the server's own resolvers and the folders its
 * environment names; `state` is null when the project has no registry row. Each failure says which
 * read failed.
 */
function readUpload(projectRoot) {
  let readers;
  let env;
  try {
    const intelligence = path.join(checkout, 'dist', 'intelligence');
    readers = {
      ...require(path.join(intelligence, 'legacy-compat.js')),
      ...require(path.join(intelligence, 'project-upload-reader.js')),
      Database: require('better-sqlite3'),
    };
    env = readEnvironment(readers);
  } catch (error) {
    return { error: `the server's registry readers could not be loaded: ${message(error)}` };
  }
  const open = (file) =>
    new readers.Database(file, { readonly: true, fileMustExist: true, timeout: 250 });
  let id;
  try {
    const store = open(readers.resolveRecordPaths(path.resolve(projectRoot)).dbPath);
    try {
      id = store.prepare("SELECT value FROM metadata WHERE key = 'project_id'").pluck().get();
    } finally {
      store.close();
    }
  } catch (error) {
    return { error: `the project's store could not be read: ${message(error)}` };
  }
  if (!id) return { error: "the project's store names no project id" };
  try {
    const file = path.join(
      readers.resolveConfigDirectory(env, os.homedir(), { quiet: true }),
      'project-graph.sqlite'
    );
    if (!fs.existsSync(file)) return { state: null };
    const registry = open(file);
    try {
      return { state: readers.readUploadState(registry, id) };
    } finally {
      registry.close();
    }
  } catch (error) {
    return { error: `the registry could not be read: ${message(error)}` };
  }
}

/**
 * Waits for the close's own upload and says what was seen. A success any process claimed after the
 * close's mark reads delivered, since that upload carries the close's commit; the last recorded
 * outcome otherwise is information only. Settled item 11 names the residuals the generations cannot
 * tell apart.
 */
async function awaitCloseUpload(projectRoot, before, transport) {
  if (before.error) return `not observed — ${before.error}.`;
  const floor = before.state?.generation ?? 0;
  const started = Date.now();
  let mark = null;
  let state = null;
  let unread = null;
  for (;;) {
    const exited = transport.hasExited();
    const read = readUpload(projectRoot);
    // A read that fails is tried again until the cap: a busy registry is not an outcome.
    unread = read.error ?? null;
    if (!unread) {
      state = read.state;
      if (state && mark === null && (state.explicitGeneration ?? 0) > floor)
        mark = state.explicitGeneration;
      // A cleared marker counts only at the mark's generation or above, and with a success recorded
      // since the call: a row deleted and registered again restarts at 0 with its marker cleared,
      // and ordinary writes can bring it back to the mark's generation; only a success writes
      // last_synced_at (critic B, F1).
      if (
        state &&
        mark !== null &&
        state.explicitGeneration === null &&
        state.generation >= mark &&
        (state.lastSyncedAt ?? 0) >= before.at
      )
        return `delivered — this close's upload (generation ${mark}) succeeded, with the project's registry row at generation ${state.generation}.`;
    }
    const elapsed = Date.now() - started;
    if (mark === null && (exited || elapsed >= MARK_MS)) {
      if (unread) return `not observed — ${unread}.`;
      if (!state) return 'not observed — the registry has no row for this project.';
      return `no upload observed — no upload mark was seen after this call ${exited ? 'before the server exited' : `within ${MARK_MS / 1000} s`}.`;
    }
    if (exited || elapsed >= CAP_MS) {
      const last = unread
        ? `At the last read, ${unread}.`
        : state
          ? `Last recorded outcome, by any process: ${state.lastOutcome ?? 'none'}${state.lastError ? ` (${state.lastError})` : ''}.`
          : 'The registry has no row for this project now.';
      return `not confirmed ${exited ? '— the server exited before the registry showed' : `within ${CAP_MS / 1000} s — the registry did not show`} this close's upload (generation ${mark}) delivered. ${last}`;
    }
    await transport.waitForExit(POLL_MS);
  }
}

// The SDK's close sends SIGTERM after two seconds; a close upload gets twenty seconds to drain.
// This transport owns its child and implements only the SDK's public JSON-lines transport contract.
class DrainingStdioTransport {
  constructor(options) {
    this.options = options;
  }

  async start() {
    if (this.child) throw new Error('The current-build transport is already started.');
    const child = (this.child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    }));
    this.exited = new Promise((resolve) => {
      child.once('exit', () => {
        this.childExited = true;
        resolve();
      });
      child.once('close', () => {
        this.onclose?.();
        resolve();
      });
    });
    child.stdin.on('error', (error) => this.onerror?.(error));
    child.stdout.on('error', (error) => this.onerror?.(error));
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        this.onmessage?.(JSON.parse(line));
      } catch (error) {
        this.onerror?.(error);
      }
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (error) => {
        this.onerror?.(error);
        reject(error);
      });
    });
  }

  send(message) {
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('Server stdin is closed.'));
      this.child.stdin.write(JSON.stringify(message) + '\n', (error) =>
        error ? reject(error) : resolve()
      );
    });
  }

  hasExited() {
    return this.childExited === true;
  }

  async waitForExit(milliseconds) {
    let timer;
    try {
      await Promise.race([
        this.exited,
        new Promise((resolve) => (timer = setTimeout(resolve, milliseconds))),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    if (!this.child) return;
    this.child.stdin.end();
    await this.waitForExit(30_000);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGTERM');
      await this.waitForExit(2_000);
    }
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
    await this.exited;
    // A descendant holding a copied descriptor must not outlive this server's own exit wait.
    this.child.stdout.destroy();
    this.child.stdin.destroy();
  }
}

async function main() {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (
    !request ||
    typeof request.name !== 'string' ||
    !request.name.trim() ||
    !request.arguments ||
    typeof request.arguments !== 'object' ||
    Array.isArray(request.arguments) ||
    typeof request.arguments.projectRoot !== 'string' ||
    !request.arguments.projectRoot.trim()
  ) {
    throw new Error('Input must name a tool and provide arguments.projectRoot explicitly.');
  }

  const transport = new DrainingStdioTransport({
    command: process.execPath,
    args: [path.join(checkout, 'dist', 'index.js')],
    cwd: checkout,
    env: { ...process.env },
  });
  const client = new Client(
    { name: 'rbook-call-current', version: '1.0.0' },
    {
      capabilities: {},
      supportedProtocolVersions: ['2025-11-25'],
      versionNegotiation: { mode: 'legacy' },
    }
  );
  const cancellation = new AbortController();
  const options = { signal: cancellation.signal };

  try {
    await client.connect(transport, options);
    const preflight = await client.callTool(
      {
        name: 'rbook_agent_onboard',
        arguments: { projectRoot: request.arguments.projectRoot },
      },
      options
    );
    const health = preflight.structuredContent?.data?.serverHealth;
    if (
      preflight.isError === true ||
      preflight.structuredContent?.success !== true ||
      health?.codeIsCurrent !== true ||
      typeof health.startupBuild?.buildHash !== 'string' ||
      !health.startupBuild.buildHash.trim() ||
      health.startupBuild.buildHash !== health.currentBuild?.buildHash
    ) {
      throw new Error(
        'Current build could not be verified from onboard health; requested tool was not called.'
      );
    }

    const before = { ...readUpload(request.arguments.projectRoot), at: Date.now() };
    const result = await client.callTool(
      { name: request.name, arguments: request.arguments },
      options
    );
    process.stdout.write(JSON.stringify(result.structuredContent ?? result) + '\n');
    if (result.isError === true || result.structuredContent?.success === false) {
      process.exitCode = 1;
    }
    if (result.structuredContent?.data?.dashboardUpload?.started === true) {
      const seen = await awaitCloseUpload(request.arguments.projectRoot, before, transport);
      process.stderr.write(`Dashboard upload: ${seen}\n`);
    }
  } catch (error) {
    // The SDK can retain a request timer after a broken transport; cancellation releases it.
    cancellation.abort();
    throw error;
  } finally {
    // Close even if initialization failed before the client retained its transport.
    await transport.close();
  }
}

main().catch((error) => {
  process.stdout.write(
    JSON.stringify({
      success: false,
      error: {
        code: 'CURRENT_BUILD_CALL_FAILED',
        message: error instanceof Error ? error.message : String(error),
        suggestion:
          'Check the request and current build before retrying; inspect any prior receipt.',
      },
    }) + '\n'
  );
  process.exitCode = 1;
});
