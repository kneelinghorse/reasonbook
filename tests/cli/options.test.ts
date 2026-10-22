// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Every public non-hook CLI route rejects unknown options before telemetry or handler effects.
// ABOUTME: Help is inert, while accepted options reach existing handlers with their original argv intact.

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { runCli } from '../../src/cli';
import { CLI_VERBS } from '../../src/bin';
import type { CliIo } from '../../src/cli/core';
import { CliTelemetry } from '../../src/cli/telemetry';
import { runCommand } from '../../src/cli/commands';
import { runMigrate } from '../../src/cli/migrate';
import { runSpinOut } from '../../src/cli/spin-out';
import { runFeedback } from '../../src/cli/feedback';
import { runStats } from '../../src/cli/stats';
import { runConfig } from '../../src/cli/config';
import { runRepair } from '../../src/cli/repair';
import { runSync, runJoin, runCopy } from '../../src/cli/sync';
import { runHandover, runRecover } from '../../src/cli/sync-moves';
import { runShare, runMove } from '../../src/cli/dashboard';
import { runImport } from '../../src/cli/import';
import { runDrafts } from '../../src/cli/drafts';
import { runSignals } from '../../src/cli/signals';
import { runBrief } from '../../src/cli/brief';

jest.mock('../../src/cli/telemetry', () => ({
  CliTelemetry: jest.fn(() => ({ resolve: jest.fn(), patch: jest.fn(), finish: jest.fn() })),
}));
jest.mock('../../src/cli/commands', () => ({ runCommand: jest.fn(async () => 0) }));
jest.mock('../../src/cli/migrate', () => ({ runMigrate: jest.fn(async () => 0) }));
jest.mock('../../src/cli/spin-out', () => ({ runSpinOut: jest.fn(async () => 0) }));
jest.mock('../../src/cli/feedback', () => ({ runFeedback: jest.fn(async () => 0) }));
jest.mock('../../src/cli/stats', () => ({ runStats: jest.fn(async () => 0) }));
jest.mock('../../src/cli/config', () => ({ runConfig: jest.fn(async () => 0) }));
jest.mock('../../src/cli/repair', () => ({ runRepair: jest.fn(async () => 0) }));
jest.mock('../../src/cli/sync', () => ({
  runSync: jest.fn(async () => 0),
  runJoin: jest.fn(async () => 0),
  runCopy: jest.fn(async () => 0),
}));
jest.mock('../../src/cli/sync-moves', () => ({
  runHandover: jest.fn(async () => 0),
  runRecover: jest.fn(async () => 0),
}));
jest.mock('../../src/cli/dashboard', () => ({
  runShare: jest.fn(async () => 0),
  runMove: jest.fn(async () => 0),
}));
jest.mock('../../src/cli/import', () => ({ runImport: jest.fn(async () => 0) }));
jest.mock('../../src/cli/drafts', () => ({ runDrafts: jest.fn(async () => 0) }));
jest.mock('../../src/cli/signals', () => ({ runSignals: jest.fn(async () => 0) }));
jest.mock('../../src/cli/brief', () => ({ runBrief: jest.fn(async () => 0) }));

// Independent inventory from the actual handlers, including less visible transport and array options.
const routes = [
  ['init', runCommand, ['--level=ledger', '--no-hooks', '--name', '-quoted name']],
  ['review', runCommand, ['--format=context']],
  ['relevant', runCommand, ['--query', 'a\nraw query', '--limit=3', '--format=json']],
  [
    'decisions',
    runCommand,
    [
      'record',
      '--session-id=s',
      '--content=headline',
      '--context=why',
      '--consequences=effect',
      '--mode=autonomous',
      '--domain=design',
      '--alternatives=[]',
      '--deciders=[]',
      '--mission=m',
      '--sprint=s',
      '--format=json',
    ],
  ],
  [
    'capture',
    runCommand,
    [
      '--session-id=s',
      '--category=learning',
      '--content',
      '-literal text',
      '--mission=m',
      '--format=json',
    ],
  ],
  ['session', runCommand, ['ensure', '--session-id=s']],
  ['ambient', runCommand, ['off']],
  ['profile', runCommand, ['show']],
  ['config', runConfig, ['author', 'Several', 'Words']],
  ['repair', runRepair, ['--guard']],
  [
    'stats',
    runStats,
    [
      '--export',
      '--since=a',
      '--until=b',
      '--baseline-since=c',
      '--baseline-until=d',
      '--include-project',
      'first root',
      '--include-project=second root',
    ],
  ],
  ['feedback', runFeedback, ['--content=feedback', '--dry-run', '--format=json']],
  ['drafts', runDrafts, ['list', '--all', '--format=json']],
  ['migrate', runMigrate, ['--apply', '--docs-only', '--project=/a', '--config']],
  [
    'sync',
    runSync,
    [
      '--serve',
      '--confirm-owner',
      '--join',
      '--bundle-out=o',
      '--bundle-in=i',
      '--for=member',
      '--ssh=host',
      '--remote-root=/remote',
      '--node=node',
      '--bin=bin',
      '--config-dir=config',
      '--auto',
    ],
  ],
  [
    'join',
    runJoin,
    [
      '--dashboard=address',
      '--into=/into',
      '--ssh=host',
      '--remote-root=/remote',
      '--member=name',
      '--node=node',
      '--bin=bin',
      '--config-dir=config',
      '--request-out=request',
      '--answer=answer',
      '--out=out',
      '--apply=answer',
    ],
  ],
  ['copy', runCopy, ['--to=/copy']],
  [
    'handover',
    runHandover,
    ['--ssh=host', '--remote-root=/remote', '--node=node', '--bin=bin', '--config-dir=config'],
  ],
  [
    'recover',
    runRecover,
    [
      '--ssh=host',
      '--remote-root=/remote',
      '--node=node',
      '--bin=bin',
      '--config-dir=config',
      '--members=a,b',
      '--routes=routes',
      '--drop=c',
    ],
  ],
  ['share', runShare, ['--dashboard', '--yes']],
  ['move', runMove, ['--to=owner']],
  [
    'import',
    runImport,
    ['--from', 'raw $folder', '--include', 'decisions:1', '--include=learnings:2', '--apply'],
  ],
  ['signals', runSignals, ['--format=json']],
  ['brief', runBrief, ['--days=7', '--format=md']],
  [
    'spin-out',
    runSpinOut,
    [
      '--from=/a',
      '--to=/b',
      '--sprint=s',
      '--missions=m',
      '--decisions=1',
      '--learnings=2',
      '--next-steps=3',
      '--apply',
    ],
  ],
] as const;

function io() {
  return {
    env: {},
    cwd: '/nonexistent-cli-contract-fixture',
    readStdin: jest.fn<CliIo['readStdin']>(async () => {
      throw new Error('stdin must stay unread');
    }),
    stdout: jest.fn<CliIo['stdout']>(),
    stderr: jest.fn<CliIo['stderr']>(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('F9 public option boundary', () => {
  it('accounts for every routed CLI verb, including the hook exemption', () => {
    expect([...CLI_VERBS].sort()).toEqual([...routes.map(([verb]) => verb), 'hook'].sort());
    expect(routes).toHaveLength(25);
  });

  it.each(routes.map(([verb]) => verb))(
    '%s refuses an unknown long option before any handler or telemetry',
    async (verb) => {
      for (const unknown of ['--f9-unknown', '--f9-unknown=value', '-Z']) {
        const output = io();
        expect(await runCli([verb, unknown], output)).toBe(1);
        expect(output.stderr).toHaveBeenCalledWith(
          expect.stringMatching(/unknown option.*--help/i)
        );
        expect(output.stdout).not.toHaveBeenCalled();
        expect(output.readStdin).not.toHaveBeenCalled();
        expect(CliTelemetry).not.toHaveBeenCalled();
        for (const [, handler] of routes) expect(handler).not.toHaveBeenCalled();
      }
    }
  );

  it.each(routes)(
    '%s forwards all accepted options without rewriting raw argv',
    async (verb, handler, options) => {
      const argv = [
        ...options,
        ...(['brief', 'spin-out'].includes(verb) ? [] : ['--project-root=/project']),
      ];
      const output = io();
      expect(await runCli([verb, ...argv], output)).toBe(0);
      expect(handler).toHaveBeenCalledWith(
        ...(handler === runCommand ? [verb, argv, output] : [argv, output])
      );
      expect(output.stderr).not.toHaveBeenCalled();
    }
  );

  it.each([...routes.map(([verb]) => verb), 'hook', ''])(
    '%s help is usage without any command effects',
    async (verb) => {
      for (const help of ['--help', '-h']) {
        const output = io();
        expect(await runCli([...(verb ? [verb] : []), help], output)).toBe(0);
        expect(output.stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: reasonbook'));
        expect(output.stderr).not.toHaveBeenCalled();
        expect(output.readStdin).not.toHaveBeenCalled();
        expect(CliTelemetry).not.toHaveBeenCalled();
        for (const [, handler] of routes) expect(handler).not.toHaveBeenCalled();
      }
    }
  );

  it('refuses an unknown option after a boolean instead of treating it as that flag value', async () => {
    const output = io();
    expect(await runCli(['init', '--no-hooks', '-Z'], output)).toBe(1);
    expect(runCommand).not.toHaveBeenCalled();
    expect(CliTelemetry).not.toHaveBeenCalled();
  });

  it('does not silently scope the portfolio brief to an ignored project root', async () => {
    const output = io();
    expect(await runCli(['brief', '--project-root=/project'], output)).toBe(1);
    expect(output.stderr).toHaveBeenCalledWith(expect.stringContaining('--project-root'));
    expect(runBrief).not.toHaveBeenCalled();
  });
});
