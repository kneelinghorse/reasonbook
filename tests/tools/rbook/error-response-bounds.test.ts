// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Refusals must not amplify oversized caller input into the MCP conversation.
// ABOUTME: Exercise real preflight, handlers, project stamps and review's internal presentation boundary.

import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildKnownToolErrorResult,
  buildResolvedToolResult,
  executeMissionProtocolTool,
} from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import * as review from '../../../src/tools/rbook/rbook-review';
import * as digestStore from '../../../src/tools/rbook/digest-v2-store';
import { rbookReviewPresentation } from '../../../src/tools/rbook/review-presentation';
import { formatMissionForLLM } from '../../../src/tools/rbook/rbook-mission';
import type { RbookToolError } from '../../../src/tools/rbook/types';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const huge = 'x'.repeat(100_000);
const array = Array.from({ length: 20_000 }, (_, index) => `value-${index}`);
const object = { supplied: huge };
const originalEnv = {
  RBOOK_CONFIG_DIR: process.env.RBOOK_CONFIG_DIR,
  RBOOK_CHECKPOINT_SYNC: process.env.RBOOK_CHECKPOINT_SYNC,
  RBOOK_DASHBOARD_SHARING: process.env.RBOOK_DASHBOARD_SHARING,
};
let temp: string;
let root: string;

beforeAll(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-error-bounds-'));
  root = path.join(temp, 'project');
  process.env.RBOOK_CONFIG_DIR = path.join(temp, 'config');
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  // The real dashboard join refuses locally; no account, remote call or live store is needed.
  process.env.RBOOK_DASHBOARD_SHARING = 'off';
  seedRbookDb(root);
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

const dispatch = (tool: string, args: Record<string, unknown>) =>
  executeMissionProtocolTool(tool, { projectRoot: root, ...args }, {} as never);

function expectBounded(result: ReturnType<typeof buildKnownToolErrorResult>): void {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    success: false,
    error: { code: expect.any(String) },
  });
  const text = result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
  // Check both independently: truncating only the prose leaves the model's structured input huge.
  expect(text.length).toBeLessThan(2000);
  expect(JSON.stringify(result.structuredContent).length).toBeLessThan(2000);
}

it.each([
  ['action string', 'rbook_mission', { action: huge }],
  ['action array', 'rbook_mission', { action: array }],
  ['action object', 'rbook_mission', { action: object }],
  [
    'fromDraft',
    'rbook_decisions',
    { action: 'record', fromDraft: huge, content: 'Approved choice.' },
  ],
  ['missionId', 'rbook_mission', { action: 'show', missionId: huge }],
  ['unknown parameter name', 'rbook_mission', { action: 'list', [huge]: true }],
] as const)('%s stays bounded through the real dispatcher', async (_label, tool, args) => {
  expectBounded(await dispatch(tool, args));
});

it.each(['init', 'register', 'unregister', 'join'] as const)(
  'literal projectRoot refusal for %s bounds the project stamp too',
  async (action) => {
    expectBounded(
      await dispatch('rbook_project', {
        action,
        projectRoot: path.join(temp, huge),
        ...(action === 'join' ? { via: 'dashboard', project: 'rbook://owner/project' } : {}),
      })
    );
  }
);

it('unknown tools retain the protocol error contract while bounding both message and wire shape', async () => {
  let error: unknown;
  try {
    await dispatch(huge, {});
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ProtocolError);
  expect(error).toMatchObject({ code: ProtocolErrorCode.MethodNotFound });
  const protocol = error as ProtocolError;
  expect(protocol.message.length).toBeLessThan(2000);
  expect(JSON.stringify({ code: protocol.code, message: protocol.message }).length).toBeLessThan(
    2000
  );
});

it('review bounds its handler refusal before its own internal formatter runs', async () => {
  jest.spyOn(review, 'rbookReview').mockResolvedValueOnce({
    success: false,
    error: { code: 'DB_QUERY_FAILED', message: huge, suggestion: 'Check the store.' },
  });
  const presentation = await rbookReviewPresentation({ projectRoot: root });
  expect(presentation.result.success).toBe(false);
  expect(presentation.context).toBeNull();
  expect(presentation.text.length).toBeLessThan(2000);
  expect(JSON.stringify(presentation.result).length).toBeLessThan(2000);
});

it('review bounds a digest exception before rendering its fallback refusal', async () => {
  // This success only gets as far as digest loading; no successful review fields are rendered.
  jest.spyOn(review, 'rbookReview').mockResolvedValueOnce({
    success: true,
    data: { projectRoot: root } as review.RbookReviewResult,
  });
  jest.spyOn(digestStore, 'readDigestV2').mockRejectedValueOnce(new Error(huge));
  const presentation = await rbookReviewPresentation({ projectRoot: root });
  expect(presentation.result).toMatchObject({
    success: false,
    error: { code: 'DB_QUERY_FAILED' },
  });
  expect(presentation.context).toBeNull();
  expect(presentation.text.length).toBeLessThan(2000);
  expect(JSON.stringify(presentation.result).length).toBeLessThan(2000);
});

it.each([
  'message',
  'suggestion',
  'field',
  'providedValue',
  'currentState',
  'validValues',
] as const)('the known-error boundary bounds oversized %s independently', (field) => {
  const value = field === 'validValues' ? array : field === 'currentState' ? object : huge;
  expectBounded(
    buildKnownToolErrorResult({
      code: 'INVALID_PARAMETER',
      message: 'The supplied value is invalid.',
      [field]: value,
    } as RbookToolError)
  );
});

it('small errors keep structured field types usable by existing formatters', () => {
  const error: RbookToolError = {
    code: 'INVALID_ACTION',
    message: 'Choose an action.',
    suggestion: 'Use list.',
    field: 'action',
    providedValue: { attempted: true },
    currentState: { state: 'open' },
    validValues: ['list', 'show'],
  };
  const result = buildKnownToolErrorResult(error);
  expect(result.structuredContent).toEqual({ success: false, error });
  expect(formatMissionForLLM(undefined, result.structuredContent as never)).toContain(
    'Available actions: list, show'
  );
  expect(result.content).toEqual([
    {
      type: 'text',
      text:
        `Tool execution error [INVALID_ACTION]: Choose an action.\nSuggestion: Use list.\n\n` +
        JSON.stringify({ success: false, error }, null, 2),
    },
  ]);
});

it('success data and text are outside the refusal-only bound', () => {
  const result = buildResolvedToolResult({ success: true, data: { content: huge } }, huge, {
    projectRoot: null,
    resolvedBy: 'none',
  });
  expect(result.isError).toBe(false);
  expect(result.structuredContent).toMatchObject({ data: { content: huge } });
  expect(result.content).toEqual([{ type: 'text', text: huge }]);
});
