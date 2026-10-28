// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Pins the directory wire separately and compares shared instruction sentences exactly.
// ABOUTME: Direct MCP refusals must happen before project resolution for every removed operation.
import { getToolDefinitions, executeMissionProtocolTool } from '../../../src/index';
import { getServerInstructions, SERVER_INSTRUCTIONS } from '../../../src/server-instructions';

const saved = process.env.RBOOK_EDITION;
beforeEach(() => {
  process.env.RBOOK_EDITION = 'directory';
});
afterEach(() => {
  if (saved === undefined) delete process.env.RBOOK_EDITION;
  else process.env.RBOOK_EDITION = saved;
});

it('pins all thirteen local tools with a separate measured wire budget', () => {
  const tools = getToolDefinitions();
  expect(tools).toHaveLength(13);
  expect(tools).toMatchSnapshot('directory tools/list');
  const size = JSON.stringify(tools).length;
  expect(size).toBeLessThanOrEqual(23836);
  expect(size).toMatchSnapshot('directory wire characters');
  for (const tool of tools) expect(tool.annotations?.openWorldHint).toBe(false);
});

it('changes only the three resolved instruction clauses and the edition disclosure', () => {
  expect(getServerInstructions()).toBe(
    SERVER_INSTRUCTIONS.replace(
      'When you make a choice someone will later ask about, record it with',
      'Record a decision when the user asks for it or approves it, using'
    )
      .replace(
        'Every call may write telemetry, delete expired transient records or upload owed checkpoints',
        'Every call may write local telemetry or delete expired transient records'
      )
      .replace(
        'Record choices in your own remit directly.',
        'Record a decision when the user asks for it or approves it.'
      ) +
      " This edition keeps this project's record on this machine only; sharing, the dashboard and messages need the full plugin."
  );
  process.env.RBOOK_EDITION = 'full';
  expect(getServerInstructions()).toBe(SERVER_INSTRUCTIONS);
});

it.each<[string, Record<string, unknown>]>([
  ...['share', 'invite', 'join', 'members', 'remove', 'sync', 'move', 'sweep'].map(
    (action) => ['rbook_project', { action }] as [string, Record<string, unknown>]
  ),
  ...[
    'backfill',
    'purge',
    'conflicts',
    'settle',
    'pull',
    'clone',
    'reconcile',
    'identify_orphans',
  ].map((action) => ['rbook_db', { action }] as [string, Record<string, unknown>]),
  ['rbook_sprint', { action: 'carry_forward' }],
  ['rbook_decisions', { action: 'record', fromDraft: 'P1' }],
  ...['rbook_decisions', 'rbook_mission', 'rbook_learnings', 'rbook_feedback'].map(
    (name) => [name, { action: 'list', acrossProjects: true }] as [string, Record<string, unknown>]
  ),
])('refuses %s %j without opening the deliberately absent project', async (name, args) => {
  const result = await executeMissionProtocolTool(
    name as string,
    { ...(args as object), projectRoot: '/directory-absent-fixture' },
    {} as never
  );
  expect(result.structuredContent).toMatchObject({
    success: false,
    error: {
      code: 'DIRECTORY_EDITION_UNAVAILABLE',
      suggestion: expect.stringContaining('full plugin'),
    },
  });
});
