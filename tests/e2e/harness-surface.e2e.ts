// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m08 over stdio: initialize carries the server instructions, and tools/list arrives
// ABOUTME: under its 8K-token ceiling in the declared order, from the built dist/index.js.

import { afterAll, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_LOOP } from '../../src/server-instructions';
import { seedRbookDb } from '../helpers/seedRbookDb';
import { connectStdioServer, type StdioHarness } from './stdio-harness';

const SERVER = path.resolve(__dirname, '../../dist/index.js');

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const step of cleanup.reverse()) await step();
});

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(): Promise<StdioHarness> {
  const projectRoot = mkTmp('rbook-e2e-m08-');
  seedRbookDb(projectRoot, { projectName: 's92-m08 e2e' });
  const harness = await connectStdioServer({
    serverPath: SERVER,
    cwd: projectRoot,
    env: {
      HOME: mkTmp('rbook-e2e-m08-home-'),
      RBOOK_CONFIG_DIR: mkTmp('rbook-e2e-m08-config-'),
      RBOOK_PROJECT_ROOT: projectRoot,
      PATH: process.env.PATH ?? path.dirname(process.execPath),
      NODE_ENV: 'test',
    },
    clientName: 's92-m08-harness-surface',
  });
  cleanup.push(() => harness.close());
  return harness;
}

describe('s92-m08 harness surface over stdio', () => {
  it('initialize returns the instructions, whose first 512 characters state the loop', async () => {
    const harness = await connect();
    const instructions = harness.client.getInstructions();
    expect(instructions).toBe(SERVER_INSTRUCTIONS);
    expect(instructions!.slice(0, 512)).toContain(SERVER_INSTRUCTIONS_LOOP);
  });

  // Decision #1713 raised the ceiling from 24,000 to 32,000 characters for sprint 106.
  it('tools/list arrives under 32,000 characters (8K tokens at four a token), in a stable order', async () => {
    const harness = await connect();
    const first = await harness.client.listTools();
    const second = await harness.client.listTools();
    expect(JSON.stringify(first.tools).length).toBeLessThanOrEqual(32_000);
    expect(second.tools.map((t) => t.name)).toEqual(first.tools.map((t) => t.name));
    expect(first.tools[0].name).toBe('rbook_mission');
    expect(first.tools[first.tools.length - 1].name).toBe('rbook_review');
  });
});
