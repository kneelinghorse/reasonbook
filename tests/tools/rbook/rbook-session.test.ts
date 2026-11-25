import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/rbook/rbook-session-list', () => ({
  rbookSessionList: jest.fn(),
  formatSessionListForLLM: jest.fn(),
  VALID_SESSION_STATUSES: ['active', 'completed', 'canceled'],
}));
jest.mock('../../../src/tools/rbook/rbook-session-start', () => ({
  rbookSessionStart: jest.fn(),
  formatSessionStartForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-session-capture', () => ({
  rbookSessionCapture: jest.fn(),
  formatSessionCaptureForLLM: jest.fn(),
  VALID_CAPTURE_CATEGORIES: ['decision', 'learning', 'constraint', 'context', 'next-step'],
}));
jest.mock('../../../src/tools/rbook/rbook-session-complete', () => ({
  rbookSessionComplete: jest.fn(),
  formatSessionCompleteForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-session-search', () => ({
  rbookSessionSearch: jest.fn(),
  formatSessionSearchForLLM: jest.fn(),
}));

import {
  RBOOK_SESSION_ACTIONS,
  rbookSession,
  rbookSessionToolDefinition,
  formatSessionForLLM,
} from '../../../src/tools/rbook/rbook-session';
import { rbookSessionList } from '../../../src/tools/rbook/rbook-session-list';
import { rbookSessionStart } from '../../../src/tools/rbook/rbook-session-start';
import { rbookSessionCapture } from '../../../src/tools/rbook/rbook-session-capture';
import { rbookSessionComplete } from '../../../src/tools/rbook/rbook-session-complete';
import { rbookSessionSearch } from '../../../src/tools/rbook/rbook-session-search';

describe('rbook_session', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes list action', async () => {
    const expected = { success: true, data: { sessions: [] } } as any;
    (rbookSessionList as jest.MockedFunction<typeof rbookSessionList>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookSession({ action: 'list', status: 'active', page: 1 });
    expect(rbookSessionList).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', page: 1 })
    );
    expect(result).toBe(expected);
  });

  it('routes start action', async () => {
    const expected = { success: true, data: { sessionId: 'PS-123' } } as any;
    (rbookSessionStart as jest.MockedFunction<typeof rbookSessionStart>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookSession({
      action: 'start',
      type: 'planning',
      title: 'Test Session',
      projectRoot: '/tmp',
    });
    expect(rbookSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'planning', title: 'Test Session' })
    );
    expect(result).toBe(expected);
  });

  it('routes capture action', async () => {
    const expected = { success: true, data: {} } as any;
    (rbookSessionCapture as jest.MockedFunction<typeof rbookSessionCapture>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookSession({
      action: 'capture',
      category: 'decision',
      content: 'Decided X',
      missionId: 's14-m01',
    });
    expect(rbookSessionCapture).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'decision', content: 'Decided X', missionId: 's14-m01' })
    );
    expect(result).toBe(expected);
  });

  it('routes complete action', async () => {
    const expected = { success: true, data: {} } as any;
    (
      rbookSessionComplete as jest.MockedFunction<typeof rbookSessionComplete>
    ).mockResolvedValueOnce(expected);

    const result = await rbookSession({
      action: 'complete',
      summary: 'Session done',
      nextSteps: ['Step 1'],
    });
    expect(rbookSessionComplete).toHaveBeenCalledWith(
      expect.objectContaining({ summary: 'Session done', nextSteps: ['Step 1'] })
    );
    expect(result).toBe(expected);
  });

  it('routes search action', async () => {
    const expected = { success: true, data: { query: 'sqlite', results: [] } } as any;
    (rbookSessionSearch as jest.MockedFunction<typeof rbookSessionSearch>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookSession({
      action: 'search',
      query: 'sqlite',
      type: 'planning',
      limit: 5,
      projectRoot: '/tmp',
    });
    expect(rbookSessionSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'sqlite', type: 'planning', limit: 5 })
    );
    expect(result).toBe(expected);
  });

  it('routes search action with a missing query as empty string (handler emits MISSING_PARAMETER)', async () => {
    const expected = { success: false, error: { code: 'MISSING_PARAMETER' } } as any;
    (rbookSessionSearch as jest.MockedFunction<typeof rbookSessionSearch>).mockResolvedValueOnce(
      expected
    );

    await rbookSession({ action: 'search', projectRoot: '/tmp' });
    // `?? ''` mirrors start/capture: the router forwards '' so the handler owns the error.
    expect(rbookSessionSearch).toHaveBeenCalledWith(expect.objectContaining({ query: '' }));
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await rbookSession({ action: 'archive' as any, agentFeedback: 'feedback' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  describe('feedback sent to a session action', () => {
    const sentinel = 'private-session-feedback';
    const remedy = 'rbook_agent_onboard(projectRoot=…, agentFeedback=…)';
    const handlers = [
      rbookSessionList,
      rbookSessionStart,
      rbookSessionCapture,
      rbookSessionSearch,
      rbookSessionComplete,
    ];
    const unsupported = ['list', 'start', 'capture', 'search'] as const;

    it.each(unsupported)('%s refuses before it can discard valid feedback', async (action) => {
      const result = await rbookSession({ action, agentFeedback: sentinel });
      for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
      expect(result.error).toMatchObject({
        code: 'INVALID_PARAMETER',
        field: 'agentFeedback',
        message: expect.stringContaining(`action="${action}"`),
        suggestion: expect.stringContaining(remedy),
      });
      expect(result.error).not.toHaveProperty('providedValue');
      expect(JSON.stringify(result)).not.toContain(sentinel);
    });

    it.each([...unsupported, 'complete'] as const)(
      '%s reports malformed feedback without quoting it',
      async (action) => {
        for (const [value, expectation] of [
          [{ nested: sentinel }, /string/i],
          [sentinel.padEnd(2001, 'x'), /2000/],
        ] as const) {
          const result = await rbookSession({ action, agentFeedback: value as string });
          for (const handler of handlers) expect(handler).not.toHaveBeenCalled();
          expect(result.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'agentFeedback' });
          expect(result.error).not.toHaveProperty('providedValue');
          expect(JSON.stringify(result)).not.toContain(sentinel);
          expect(result.error?.message).toContain(`action="${action}"`);
          expect([result.error?.message, result.error?.suggestion].join(' ')).toMatch(expectation);
          expect(result.error?.suggestion?.includes(remedy)).toBe(action !== 'complete');
        }
      }
    );

    it.each([undefined, null, '', '  '])(
      'keeps omitted or blank feedback optional',
      async (value) => {
        await rbookSession({ action: 'list', agentFeedback: value as string });
        expect(rbookSessionList).toHaveBeenCalledTimes(1);
      }
    );
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(rbookSessionToolDefinition.name).toBe('rbook_session');
    });
    it('requires action', () => {
      expect(rbookSessionToolDefinition.inputSchema.required).toContain('action');
    });
  });

  describe('RBOOK_SESSION_ACTIONS', () => {
    it('contains 5 actions (incl. search)', () => {
      expect(RBOOK_SESSION_ACTIONS).toHaveLength(5);
      expect(RBOOK_SESSION_ACTIONS).toContain('search');
    });
  });

  describe('formatSessionForLLM', () => {
    it('formats INVALID_ACTION errors', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action not supported',
          availableActions: ['list', 'start'],
        },
      };
      expect(formatSessionForLLM(undefined, result)).toContain('Failed to execute rbook_session');
    });

    it('returns fallback for unknown action', () => {
      expect(formatSessionForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Session action completed'
      );
    });
  });
});
