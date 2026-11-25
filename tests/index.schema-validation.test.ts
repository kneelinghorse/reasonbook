// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Every rejectable published constraint must stop at dispatch before project/store access.
// ABOUTME: Pins the predicate census and the data-loss cases that motivated whole-schema checking.

import { executeMissionProtocolTool } from '../src/index';
import * as sender from '../src/intelligence/sender-context';
import { RbookDatabaseClient } from '../src/tools/rbook/client';
import { constraintKey, dispatchConstraints, violatingCall } from './helpers/dispatch-constraints';

const rows = dispatchConstraints();
const schemaRows = rows.filter((row) => !row.kind.startsWith('desc-'));
const cases = schemaRows.map((row) => ({ row, args: violatingCall(row) }));
const rejectable = cases.filter((item) => item.args !== undefined);
const resolutionReached = new Error('Malformed input reached sender resolution');

beforeEach(() => {
  jest.spyOn(sender, 'resolveSenderContext').mockRejectedValue(resolutionReached);
  jest.spyOn(RbookDatabaseClient, 'create').mockImplementation(async () => {
    throw new Error('Malformed input opened a store');
  });
  jest.spyOn(RbookDatabaseClient, 'fromDetection').mockImplementation(() => {
    throw new Error('Malformed input opened a detected store');
  });
});
afterEach(() => jest.restoreAllMocks());

it('accounts for the complete predicate: 214 rejectable schema rows, one universal JSON value, twenty-two handler promises', () => {
  // s104-m03 restores the complete action's existing summary requirement on the wire.
  // s106-m02 (#871) states rbook_mission's missionId requirement on the wire: one more promise.
  // s106-m03 adds page (an integer of at least 1) to rbook_feedback, rbook_mission and
  // rbook_sprint: two rejectable rows each.
  // s106-m05 states seven more requirements on the wire (the search queries of context, decisions,
  // learnings and session; session's title, content and summary); dispatch-description-promises
  // holds each to its handler's refusal.
  // s108-m02 states three bounds on the wire: reason's 500 characters and both checkAfter windows,
  // held to their handlers' refusals there too.
  expect(rows).toHaveLength(237);
  expect(new Set(rows.map(constraintKey)).size).toBe(rows.length);
  expect(schemaRows).toHaveLength(215);
  expect(rejectable).toHaveLength(214);
  expect(
    cases.filter((item) => item.args === undefined).map((item) => constraintKey(item.row))
  ).toEqual(['rbook_context /fieldUpdates/items/properties/value nested-type']);
  expect(rows.filter((row) => row.kind.startsWith('desc-'))).toHaveLength(22);
});

it.each(rejectable.map(({ row, args }) => [constraintKey(row), row, args] as const))(
  '%s refuses before a store opens',
  async (_key, row, args) => {
    const result = await executeMissionProtocolTool(row.tool, args, {} as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      success: false,
      error: { code: 'INVALID_PARAMETER' },
    });
    const error = (result.structuredContent as { error: { field: string; suggestion: string } })
      .error;
    expect(error.field.split(/[.[]/)[0]).toBe(row.param);
    expect(error.suggestion.length).toBeGreaterThan(0);
    expect(sender.resolveSenderContext).not.toHaveBeenCalled();
    expect(RbookDatabaseClient.create).not.toHaveBeenCalled();
    expect(RbookDatabaseClient.fromDetection).not.toHaveBeenCalled();
  }
);

it.each([
  ['rbook_context', { action: 'update', contextType: 'bogus' }],
  [
    'rbook_context',
    { action: 'update', contextType: 'project_identity', fieldUpdates: [{ path: 'project_name' }] },
  ],
  ['rbook_mission', { action: 'update', fields: { name: 123 } }],
  ['rbook_session', { action: 'capture', category: 'Learning', content: 'Must not vanish.' }],
  ['rbook_feedback', { action: 'list', limit: '1 OFFSET 1' }],
  ['rbook_db', { action: 'snapshot', maxSnapshots: 0 }],
  ['rbook_sprint', { action: 'complete', condensation: 'bogus' }],
  ['rbook_decisions', { action: 'list', content: 123 }],
  ['rbook_review', { projectRoot: [] }],
  ['rbook_status', { projectRoot: false }],
  ['rbook_agent_onboard', { agentFeedback: 'x'.repeat(2001) }],
] as const)('blocks destructive or silently ignored malformed input to %s', async (tool, args) => {
  const result = await executeMissionProtocolTool(tool, args, {} as never);
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ error: { code: 'INVALID_PARAMETER' } });
  expect(sender.resolveSenderContext).not.toHaveBeenCalled();
});

it('the no-store witness is live: a valid call reaches sender resolution', async () => {
  await expect(
    executeMissionProtocolTool('rbook_mission', { action: 'list' }, {} as never)
  ).rejects.toBe(resolutionReached);
  expect(sender.resolveSenderContext).toHaveBeenCalledTimes(1);
});

describe('session feedback rejected by the schema', () => {
  const sentinel = 'private-feedback-sentinel';
  const invalidFeedback = [
    {
      label: 'wrong type',
      value: { details: { body: sentinel } },
      expectation: /expected string/i,
    },
    { label: 'over 2000', value: sentinel.padEnd(2001, 'x'), expectation: /2000/ },
  ];

  describe.each(['list', 'start', 'capture', 'search', 'complete'])('%s', (action) => {
    it.each(invalidFeedback)('explains $label without returning the feedback', async (sample) => {
      const result = await executeMissionProtocolTool(
        'rbook_session',
        { action, agentFeedback: sample.value },
        {} as never
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        success: false,
        error: { code: 'INVALID_PARAMETER', field: 'agentFeedback' },
      });
      for (const answer of [result.content, result.structuredContent]) {
        const text = JSON.stringify(answer);
        expect(text).not.toContain(sentinel);
        expect(text).toMatch(sample.expectation);
      }
      const error = (result.structuredContent as { error: { suggestion: string } }).error;
      if (action === 'complete') {
        expect(error.suggestion).not.toContain('rbook_agent_onboard');
      } else {
        expect(error.suggestion).toContain('rbook_agent_onboard(projectRoot=…, agentFeedback=…)');
        expect(JSON.stringify(result.structuredContent)).toContain(action);
      }
      expect(sender.resolveSenderContext).not.toHaveBeenCalled();
    });
  });

  it('keeps action, unknown-key and earlier schema errors ahead of the feedback error', async () => {
    for (const [args, code, field] of [
      [{ action: 'unknown' }, 'INVALID_ACTION', 'action'],
      [{ action: 'capture', unknown: true }, 'INVALID_PARAMETER', 'unknown'],
      [{ action: 'capture', category: 'typo' }, 'INVALID_PARAMETER', 'category'],
    ] as const) {
      const result = await executeMissionProtocolTool(
        'rbook_session',
        { ...args, agentFeedback: { body: sentinel } },
        {} as never
      );
      expect(result.structuredContent).toMatchObject({ error: { code, field } });
      expect(JSON.stringify(result)).not.toContain(sentinel);
    }
  });
});
