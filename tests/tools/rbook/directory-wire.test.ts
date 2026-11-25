// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Pins the directory wire separately and compares shared instruction sentences exactly.
// ABOUTME: Direct MCP refusals must happen before project resolution for every removed operation.
import {
  getToolDefinitions,
  executeMissionProtocolTool,
  type ToolDefinition,
} from '../../../src/index';
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
  // s106-m05: the directory edition gets the full edition's text where its actions exist, so its
  // budget is the design's rule, below the full wire, rather than a fixed count the full text outgrew.
  process.env.RBOOK_EDITION = 'full';
  const full = JSON.stringify(getToolDefinitions()).length;
  process.env.RBOOK_EDITION = 'directory';
  expect(size).toBeLessThan(full);
  expect(size).toMatchSnapshot('directory wire characters');
  for (const tool of tools) expect(tool.annotations?.openWorldHint).toBe(false);
});

/**
 * The tools whose published text, description or any parameter's hint, names an upload, the
 * dashboard or a sync, none of which this edition has. A claim in other words (a hosted service, a
 * remote copy) is not caught; the snapshot and the text's own review cover those.
 */
function claimsUpload(tools: readonly ToolDefinition[]): string[] {
  return tools
    .filter((tool) =>
      /upload|dashboard|\bsync/i.test(JSON.stringify([tool.description, tool.inputSchema]))
    )
    .map((tool) => tool.name);
}

it('claims no upload anywhere, since this edition makes none, and the check finds a planted one (s108-m06)', () => {
  const tools = getToolDefinitions();
  expect(claimsUpload(tools)).toEqual([]);
  // Learning #613: a full-edition sentence reaches this edition unless an entry here replaces it.
  const planted = tools.map((tool) =>
    tool.name === 'rbook_mission_transition'
      ? { ...tool, description: `${tool.description} Any may upload owed checkpoints.` }
      : tool
  );
  expect(claimsUpload(planted)).toEqual(['rbook_mission_transition']);
});

it("states #888's effects, without an upload, and the usage line on its ten multi-action tools (s108-m06)", () => {
  const published = Object.fromEntries(
    getToolDefinitions().map((tool) => [tool.name, tool.description])
  );
  for (const [tool, effect] of [
    ['rbook_sprint', 'drops next steps whose lease lapsed (dated ones wait)'],
    ['rbook_sprint', 'takes two DB snapshots (oldest may be deleted)'],
    ['rbook_mission_transition', 'start may activate its Planned sprint'],
    ['rbook_mission_transition', 'complete writes decisions[], updates and snapshots the context'],
  ])
    expect({ tool, effect, stated: published[tool].includes(effect) }).toEqual({
      tool,
      effect,
      stated: true,
    });
  const multiAction = Object.keys(published).filter(
    (name) => !['rbook_review', 'rbook_agent_onboard', 'rbook_status'].includes(name)
  );
  expect(multiAction).toHaveLength(10);
  expect(multiAction.filter((name) => !published[name].includes(' Calls may log usage.'))).toEqual(
    []
  );
});

it('advertises only available sprint actions in the local edition', () => {
  const sprint = getToolDefinitions().find((tool) => tool.name === 'rbook_sprint');
  expect(sprint?.description).toContain('Except list/analytics, supply sprintId');
  expect(sprint?.description).toContain('complete needs summary');
  expect(sprint?.description).not.toMatch(/carry_forward|targetAddress|send/);
  process.env.RBOOK_EDITION = 'full';
  expect(getToolDefinitions().find((tool) => tool.name === 'rbook_sprint')?.description).toContain(
    'carry_forward sends to targetAddress'
  );
});

it('names no parameter, action or tool the edition removes', () => {
  // s106-m05 round 2: the full edition's "not with fromDraft" reached a tool whose fromDraft this
  // edition deletes. "project" is rbook_project's English noun as well as its removed join input.
  const english: Record<string, readonly string[]> = { rbook_project: ['project'] };
  type Properties = Record<string, { description?: string; enum?: string[] }>;
  const properties = (tool: ToolDefinition) => (tool.inputSchema.properties ?? {}) as Properties;
  const actions = (tool: ToolDefinition) => properties(tool).action?.enum ?? [];
  process.env.RBOOK_EDITION = 'full';
  const full = new Map(getToolDefinitions().map((tool) => [tool.name, tool]));
  process.env.RBOOK_EDITION = 'directory';
  const tools = getToolDefinitions();
  const hidden = [...full.keys()].filter((name) => !tools.some((tool) => tool.name === name));
  const named: string[] = [];
  for (const tool of tools) {
    const before = full.get(tool.name)!;
    const removed = [
      ...Object.keys(properties(before)).filter((name) => !(name in properties(tool))),
      ...actions(before).filter((action) => !actions(tool).includes(action)),
      ...hidden,
    ].filter((word) => !(english[tool.name] ?? []).includes(word));
    const texts = [tool.description, ...Object.values(properties(tool)).map((p) => p.description)];
    for (const text of texts)
      for (const word of removed)
        if (new RegExp(`(^|\\W)${word}(\\W|$)`).test(text ?? ''))
          named.push(`${tool.name}: ${word}`);
  }
  expect(named).toEqual([]);
});

it('changes only the four resolved instruction clauses and the edition disclosure', () => {
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
      )
      .replace(
        'Record their choice, with fromDraft for a linked approval.',
        'Record their choice.'
      ) +
      " This edition keeps this project's record on this machine only; sharing, the dashboard and messages need the full plugin."
  );
  // s106-m05 round 3: the edition deletes fromDraft, so its instructions never name it.
  expect(getServerInstructions()).not.toContain('fromDraft');
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
