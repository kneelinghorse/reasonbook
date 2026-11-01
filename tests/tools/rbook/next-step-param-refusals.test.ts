// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02 — checkAfter and reason are refused, at the dispatch boundary, on every action and
// ABOUTME: sub-action that would ignore them; the pairs come from the applicability tables, not a list.

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  buildMissionProtocolContext,
  executeMissionProtocolTool,
  getToolDefinitions,
} from '../../../src/index';
import { RBOOK_ACTION_PARAMS } from '../../../src/tools/rbook/action-params';
import {
  NEXT_STEP_ACTION_PARAMS,
  NEXT_STEP_ACTIONS,
} from '../../../src/tools/rbook/rbook-next-steps';
import { utcDay } from '../../../src/tools/rbook/next-step-dates';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';

const DAY = 86_400_000;
const future = () => utcDay(Date.now() + 30 * DAY);

let project: SeededRbookProject;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-s108-m02-refusals-');
});
afterEach(async () => {
  await project.cleanup();
});

type Answer = {
  isError?: boolean;
  structuredContent?: {
    success: boolean;
    error?: { code?: string; field?: string };
    data?: unknown;
  };
};
async function call(tool: string, args: Record<string, unknown>): Promise<Answer> {
  return (await executeMissionProtocolTool(
    tool,
    { ...args, projectRoot: project.projectRoot },
    await buildMissionProtocolContext()
  )) as Answer;
}
function nextSteps(): unknown[] {
  const db = new Database(project.dbPath, { readonly: true });
  try {
    return db.prepare('SELECT id, status, resolved_at FROM next_steps ORDER BY id').all();
  } finally {
    db.close();
  }
}

/** Every (tool, action, key) the tables say is not taken, for the keys this mission declares. */
const NEW_KEYS: Record<string, string[]> = {
  rbook_session: ['checkAfter'],
  rbook_context: ['reason', 'checkAfter'],
};
const refusedTopLevel = Object.entries(NEW_KEYS).flatMap(([tool, keys]) =>
  Object.entries(RBOOK_ACTION_PARAMS[tool]).flatMap(([action, takes]) =>
    keys.filter((key) => !takes.includes(key)).map((key) => [tool, action, key] as const)
  )
);
const refusedSubActions = NEXT_STEP_ACTIONS.flatMap((sub) =>
  (['reason', 'checkAfter'] as const)
    .filter((key) => !NEXT_STEP_ACTION_PARAMS[sub].includes(key))
    .map((key) => [sub, key] as const)
);

describe('a new key given where it would be ignored', () => {
  it('derives the design’s 18 top-level pairs and 9 sub-action pairs from the tables', () => {
    expect(refusedTopLevel).toHaveLength(18);
    expect(refusedSubActions).toHaveLength(9);
    // Each key is published, so dispatch's unknown-key guard would let it through to any action.
    for (const [tool, keys] of Object.entries(NEW_KEYS)) {
      const definition = getToolDefinitions().find((entry) => entry.name === tool)!;
      for (const key of keys) expect(definition.inputSchema.properties).toHaveProperty(key);
    }
  });

  it.each(refusedTopLevel)(
    '%s(action="%s") refuses %s and writes nothing',
    async (tool, action, key) => {
      const before = nextSteps();
      const value = key === 'checkAfter' ? future() : 'A reason';
      const extra =
        action === 'complete' ? { summary: 'S', nextSteps: ['Would be written undated'] } : {};
      const answer = await call(tool, { action, [key]: value, ...extra });
      expect(answer.isError).toBe(true);
      expect(answer.structuredContent?.error).toMatchObject({
        code: 'INVALID_PARAMETER',
        field: key,
      });
      expect(nextSteps()).toEqual(before);
    }
  );

  it.each(refusedSubActions)('next_steps %s refuses %s', async (sub, key) => {
    const id = Number(
      (
        (
          await call('rbook_session', {
            action: 'capture',
            category: 'next-step',
            content: `Row for ${sub}`,
          })
        ).structuredContent?.data as { nextStepId: number }
      ).nextStepId
    );
    const before = nextSteps();
    const answer = await call('rbook_context', {
      action: 'next_steps',
      nextStepAction: sub,
      nextStepIds: [id],
      [key]: key === 'checkAfter' ? future() : 'A reason',
    });
    expect(answer.structuredContent?.error).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: key,
    });
    expect(nextSteps()).toEqual(before);
  });

  it.each(['since', 'until'])('next_steps refuses %s, which it never read', async (key) => {
    const answer = await call('rbook_context', {
      action: 'next_steps',
      nextStepAction: 'carry',
      [key]: '2026-01-01',
    });
    expect(answer.structuredContent?.error).toMatchObject({
      code: 'INVALID_PARAMETER',
      field: key,
    });
  });

  it('refuses checkAfter on a capture that is not a next step, and on a broad carry', async () => {
    const constraint = await call('rbook_session', {
      action: 'capture',
      category: 'constraint',
      content: 'Not dated',
      checkAfter: future(),
    });
    expect(constraint.structuredContent?.error).toMatchObject({ field: 'checkAfter' });
    for (const ids of [undefined, []]) {
      const broad = await call('rbook_context', {
        action: 'next_steps',
        nextStepAction: 'carry',
        ...(ids ? { nextStepIds: ids } : {}),
        checkAfter: future(),
      });
      expect(broad.structuredContent?.error?.field).toBe('checkAfter');
    }
  });

  it('refuses an unreadable date and one too far ahead before storing anything', async () => {
    for (const checkAfter of ['someday', utcDay(Date.now() + 181 * DAY), utcDay(Date.now())]) {
      const before = nextSteps();
      const answer = await call('rbook_session', {
        action: 'capture',
        category: 'next-step',
        content: `Dated ${checkAfter}`,
        checkAfter,
      });
      expect(answer.structuredContent?.error).toMatchObject({
        code: 'INVALID_PARAMETER',
        field: 'checkAfter',
      });
      expect(nextSteps()).toEqual(before);
    }
  });

  it('treats null, absent and blank keys as not given, so a null-filling client is answered as before', async () => {
    expect((await call('rbook_session', { action: 'start', title: 'Nulls' })).isError).toBeFalsy();
    const answer = await call('rbook_session', {
      action: 'complete',
      summary: 'Nulls',
      checkAfter: null,
      nextSteps: ['Undated, as asked'],
    });
    expect(answer.structuredContent?.error).toBeUndefined();
    expect(answer.isError).toBeFalsy();
    const blank = await call('rbook_context', { action: 'view', reason: '  ', checkAfter: '' });
    expect(blank.isError).toBeFalsy();
  });
});

describe('a client that sends null for every declared key', () => {
  // tests/fixtures/null-sweep-51de697c.json: what 4.9.0 answered, recorded once at 51de697c by
  // rbook/research/2026-10-s108-a-record-that-keeps-itself/m02/record-null-sweep.test.ts.
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../../fixtures/null-sweep-51de697c.json'), 'utf8')
  ) as {
    calls: Array<{
      tool: string;
      args: Record<string, unknown>;
      isError: boolean;
      code: string | null;
      affected?: number;
    }>;
  };

  it('is answered at every action and sub-action as 4.9.0 answered it', async () => {
    const root = fs.mkdtempSync(path.join(path.dirname(project.projectRoot), 'rbook-null-sweep-'));
    const context = await buildMissionProtocolContext();
    const init = await executeMissionProtocolTool(
      'rbook_project',
      { action: 'init', projectRoot: root, projectName: 'null-sweep', projectType: 'build' },
      context
    );
    expect(init.isError).toBeFalsy();
    const definitions = getToolDefinitions();
    const answered = [];
    for (const { tool, args } of fixture.calls) {
      const declared = Object.keys(
        definitions.find((definition) => definition.name === tool)!.inputSchema.properties ?? {}
      );
      const result = (await executeMissionProtocolTool(
        tool,
        { ...Object.fromEntries(declared.map((key) => [key, null])), ...args, projectRoot: root },
        context
      )) as Answer & { structuredContent?: { data?: { affected?: unknown } } };
      const affected = result.structuredContent?.data?.affected;
      answered.push({
        tool,
        args,
        isError: result.isError === true,
        code: result.structuredContent?.error?.code ?? null,
        ...(typeof affected === 'number' ? { affected } : {}),
      });
    }
    expect(answered).toEqual(fixture.calls);
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);
});
