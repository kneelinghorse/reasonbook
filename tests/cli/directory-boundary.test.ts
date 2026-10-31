// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Directory CLI entrypoints cannot bypass the server's conversation and transport boundaries.
// ABOUTME: Refusal happens before stdin or verb modules can read prompts, profiles, memory or peers.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCli, runHook } from '../../src/cli';
import type { CliIo } from '../../src/cli/core';

let config: string;
beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-directory-cli-'));
});
afterEach(() => fs.rmSync(config, { recursive: true, force: true }));

it.each([
  'hook',
  'drafts',
  'profile',
  'sync',
  'join',
  'copy',
  'handover',
  'recover',
  'share',
  'move',
  'signals',
  'brief',
  'stats',
  'migrate',
  'doctor',
  'spin-out',
  'ambient',
  'import',
  'set-aside',
])('directory refuses %s before reading input', async (verb) => {
  const stderr: string[] = [];
  const readStdin = jest.fn(async () => '{"prompt":"synthetic conversation"}');
  const io: CliIo = {
    env: { RBOOK_EDITION: 'directory', RBOOK_CONFIG_DIR: config, HOME: config },
    cwd: '/intentionally-absent-directory-fixture',
    readStdin,
    stdout: jest.fn(),
    stderr: (line) => stderr.push(line),
  };
  expect(await runCli([verb], io)).toBe(1);
  expect(stderr.join('\n')).toContain('full plugin');
  expect(readStdin.mock.calls.length).toBe(0);
});

it('the directly exported hook refuses before reading a conversation', async () => {
  const stderr: string[] = [];
  const readStdin = jest.fn(async () => '{}');
  const io: CliIo = {
    env: { RBOOK_EDITION: 'directory', RBOOK_CONFIG_DIR: config, HOME: config },
    cwd: '/intentionally-absent-directory-fixture',
    readStdin,
    stdout: jest.fn(),
    stderr: (line) => stderr.push(line),
  };
  expect(await runHook(['prompt'], io)).toBe(1);
  expect(readStdin.mock.calls.length).toBe(0);
  expect(stderr.join('\n')).toContain('full plugin');
});

it('directory init teaches approved recording without offering a memory-file remedy', async () => {
  const saved = { ...process.env };
  try {
    process.env.RBOOK_CONFIG_DIR = path.join(config, 'settings');
    process.env.HOME = config;
    for (const edition of ['directory', 'full']) {
      process.env.RBOOK_EDITION = edition;
      const project = path.join(config, edition);
      fs.mkdirSync(project);
      const output: string[] = [];
      expect(
        await runCli(['init', '--project-root', project, '--no-hooks'], {
          env: process.env,
          cwd: project,
          readStdin: async () => '',
          stdout: (line) => output.push(line),
          stderr: jest.fn(),
        })
      ).toBe(0);
      const text = output.join('');
      if (edition === 'directory') {
        expect(text).toContain('asks for it or approves it');
        expect(text).not.toMatch(/AGENTS\.md|Before you stop, capture|include these steps/);
        expect(fs.existsSync(path.join(project, 'AGENTS.md'))).toBe(false);
      } else {
        expect(text).toContain('include these steps in a new AGENTS.md');
      }
    }
  } finally {
    process.env = saved;
  }
});
