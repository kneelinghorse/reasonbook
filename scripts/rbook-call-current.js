#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Calls one Reasonbook tool through an isolated stdio server from this checkout's current build.
// ABOUTME: Verifies build health before dispatch and closes only the transport it created.

// Usage: node scripts/rbook-call-current.js < request.json
// Input: { "name": "rbook_review", "arguments": { "projectRoot": "/absolute/project" } }
// For hosts that cannot reconnect a stopped MCP server; this does not restart the host's connection.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { createInterface } = require('readline');
const { Client } = require('@modelcontextprotocol/client');

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
      child.once('exit', resolve);
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

  const checkout = path.resolve(__dirname, '..');
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

    const result = await client.callTool(
      { name: request.name, arguments: request.arguments },
      options
    );
    process.stdout.write(JSON.stringify(result.structuredContent ?? result) + '\n');
    if (result.isError === true || result.structuredContent?.success === false) {
      process.exitCode = 1;
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
