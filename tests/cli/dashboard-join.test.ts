// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m11 — the terminal's join through the dashboard keeps init's folder guards: no join, unnamed, into a folder
// ABOUTME: inside another project; --into names a folder as meant, and the dashboard-sharing switch still applies.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCli } from '../../src/cli';
import { seedRbookDb } from '../helpers/seedRbookDb';

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-cli-join-')));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function join(cwd: string, extra: readonly string[] = []) {
  const stderr: string[] = [];
  const code = await runCli(['join', '--dashboard', 'rbook://owner/project', ...extra], {
    env: { ...process.env, RBOOK_CONFIG_DIR: path.join(tmp, 'config') },
    cwd,
    readStdin: async () => '',
    stdout: () => undefined,
    stderr: (text) => {
      stderr.push(text);
    },
  });
  return { code, said: stderr.join('') };
}

it('refuses an unnamed join inside another project, and takes a folder named with --into as meant', async () => {
  const project = path.join(tmp, 'app');
  seedRbookDb(project);
  const inside = path.join(project, 'docs');
  fs.mkdirSync(inside);
  // A shared record nested in another project would sync agent writes made there to every member.
  const refused = await join(inside);
  expect(refused.code).toBe(1);
  expect(refused.said).toMatch(
    /is inside the Reasonbook project at .*app; name the folder to join into with --into/
  );
  expect(fs.existsSync(path.join(inside, 'rbook'))).toBe(false);
  // Named, the folder passes; with the switch off, the join is refused before anything is sent.
  process.env.RBOOK_DASHBOARD_SHARING = 'off';
  const named = await join(tmp, ['--into', inside]);
  delete process.env.RBOOK_DASHBOARD_SHARING;
  expect(named.code).toBe(1);
  expect(named.said).toMatch(/off on this machine/);
  expect(fs.existsSync(path.join(inside, 'rbook'))).toBe(false);
});
