import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/rbook/rbook-mission-start', () => ({
  rbookMissionStart: jest.fn(),
  formatMissionStartForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-complete', () => ({
  rbookMissionComplete: jest.fn(),
  formatMissionCompleteForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-block', () => ({
  rbookMissionBlock: jest.fn(),
  formatMissionBlockForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-unblock', () => ({
  rbookMissionUnblock: jest.fn(),
  formatMissionUnblockForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-drop', () => ({
  rbookMissionDrop: jest.fn(),
  formatMissionDropForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-defer', () => ({
  rbookMissionDefer: jest.fn(),
  formatMissionDeferForLLM: jest.fn(),
}));

jest.mock('../../../src/tools/rbook/rbook-mission-reopen', () => ({
  rbookMissionReopen: jest.fn(),
  formatMissionReopenForLLM: jest.fn(),
}));

import {
  rbookMissionReopen,
  formatMissionReopenForLLM,
} from '../../../src/tools/rbook/rbook-mission-reopen';

import {
  RBOOK_MISSION_TRANSITION_ACTIONS,
  rbookMissionTransition,
  rbookMissionTransitionToolDefinition,
  formatMissionTransitionForLLM,
} from '../../../src/tools/rbook/rbook-mission-transition';
import {
  rbookMissionStart,
  formatMissionStartForLLM,
} from '../../../src/tools/rbook/rbook-mission-start';
import {
  rbookMissionComplete,
  formatMissionCompleteForLLM,
} from '../../../src/tools/rbook/rbook-mission-complete';
import {
  rbookMissionBlock,
  formatMissionBlockForLLM,
} from '../../../src/tools/rbook/rbook-mission-block';
import {
  rbookMissionUnblock,
  formatMissionUnblockForLLM,
} from '../../../src/tools/rbook/rbook-mission-unblock';
import {
  rbookMissionDrop,
  formatMissionDropForLLM,
} from '../../../src/tools/rbook/rbook-mission-drop';
import {
  rbookMissionDefer,
  formatMissionDeferForLLM,
} from '../../../src/tools/rbook/rbook-mission-defer';

describe('rbook_mission_transition', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes reopen with its reason and uses the audit-aware formatter', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'In Progress' },
    } as any;
    (rbookMissionReopen as jest.MockedFunction<typeof rbookMissionReopen>).mockResolvedValueOnce(
      expected
    );
    const result = await rbookMissionTransition({
      action: 'reopen',
      missionId: 's14-m01',
      reason: 'Missed acceptance case',
      projectRoot: '/tmp/project',
    });
    expect(rbookMissionReopen).toHaveBeenCalledWith({
      missionId: 's14-m01',
      reason: 'Missed acceptance case',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
    (
      formatMissionReopenForLLM as jest.MockedFunction<typeof formatMissionReopenForLLM>
    ).mockReturnValueOnce('Reopened with audit');
    expect(formatMissionTransitionForLLM('reopen', result)).toBe('Reopened with audit');
    expect(formatMissionReopenForLLM).toHaveBeenCalledWith(expected);
  });

  it('routes start action to the existing mission start handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'In Progress' },
    } as any;
    (rbookMissionStart as jest.MockedFunction<typeof rbookMissionStart>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMissionTransition({
      action: 'start',
      missionId: 's14-m01',
      notes: 'Starting work',
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionStart).toHaveBeenCalledWith({
      missionId: 's14-m01',
      notes: 'Starting work',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes complete action to the existing mission complete handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'Completed' },
    } as any;
    (
      rbookMissionComplete as jest.MockedFunction<typeof rbookMissionComplete>
    ).mockResolvedValueOnce(expected);

    const result = await rbookMissionTransition({
      action: 'complete',
      missionId: 's14-m01',
      notes: 'All done',
      decisions: ['Used pattern X'],
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionComplete).toHaveBeenCalledWith({
      missionId: 's14-m01',
      notes: 'All done',
      decisions: ['Used pattern X'],
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes block action to the existing mission block handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'Blocked' },
    } as any;
    (rbookMissionBlock as jest.MockedFunction<typeof rbookMissionBlock>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMissionTransition({
      action: 'block',
      missionId: 's14-m01',
      reason: 'Dependency not ready',
      blockers: ['s14-m02'],
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionBlock).toHaveBeenCalledWith({
      missionId: 's14-m01',
      reason: 'Dependency not ready',
      blockers: ['s14-m02'],
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes unblock action to the existing mission unblock handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'In Progress' },
    } as any;
    (rbookMissionUnblock as jest.MockedFunction<typeof rbookMissionUnblock>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMissionTransition({
      action: 'unblock',
      missionId: 's14-m01',
      resolution: 'Dependency resolved',
      targetStatus: 'In Progress',
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionUnblock).toHaveBeenCalledWith({
      missionId: 's14-m01',
      resolution: 'Dependency resolved',
      targetStatus: 'In Progress',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION error for unknown action', async () => {
    const result = await rbookMissionTransition({
      action: 'archive' as any,
      missionId: 's14-m01',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('defaults missing reason to empty string for block action', async () => {
    const expected = { success: true, data: {} } as any;
    (rbookMissionBlock as jest.MockedFunction<typeof rbookMissionBlock>).mockResolvedValueOnce(
      expected
    );

    await rbookMissionTransition({ action: 'block', missionId: 's14-m01' });

    expect(rbookMissionBlock).toHaveBeenCalledWith({
      missionId: 's14-m01',
      reason: '',
      blockers: undefined,
      projectRoot: undefined,
    });
  });

  it('routes drop action to the mission drop handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'Dropped' },
    } as any;
    (rbookMissionDrop as jest.MockedFunction<typeof rbookMissionDrop>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMissionTransition({
      action: 'drop',
      missionId: 's14-m01',
      reason: 'No longer relevant',
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionDrop).toHaveBeenCalledWith({
      missionId: 's14-m01',
      reason: 'No longer relevant',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  it('routes defer action to the mission defer handler', async () => {
    const expected = {
      success: true,
      data: { missionId: 's14-m01', currentStatus: 'Deferred' },
    } as any;
    (rbookMissionDefer as jest.MockedFunction<typeof rbookMissionDefer>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookMissionTransition({
      action: 'defer',
      missionId: 's14-m01',
      reason: 'Waiting on dependency',
      deferUntil: 'after sprint 49',
      projectRoot: '/tmp/project',
    });

    expect(rbookMissionDefer).toHaveBeenCalledWith({
      missionId: 's14-m01',
      reason: 'Waiting on dependency',
      deferUntil: 'after sprint 49',
      projectRoot: '/tmp/project',
    });
    expect(result).toBe(expected);
  });

  describe('RBOOK_MISSION_TRANSITION_ACTIONS', () => {
    it('publishes reopen separately from ordinary state changes', () => {
      expect(RBOOK_MISSION_TRANSITION_ACTIONS).toHaveLength(7);
      expect([...RBOOK_MISSION_TRANSITION_ACTIONS]).toEqual([
        'start',
        'complete',
        'block',
        'unblock',
        'drop',
        'defer',
        'reopen',
      ]);
    });
  });

  describe('rbookMissionTransitionToolDefinition', () => {
    it('has the correct tool name', () => {
      expect(rbookMissionTransitionToolDefinition.name).toBe('rbook_mission_transition');
    });

    it('requires action and missionId parameters', () => {
      expect(rbookMissionTransitionToolDefinition.inputSchema.required).toContain('action');
      expect(rbookMissionTransitionToolDefinition.inputSchema.required).toContain('missionId');
    });

    it('disallows additional properties', () => {
      expect(rbookMissionTransitionToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('formatMissionTransitionForLLM', () => {
    it('formats INVALID_ACTION errors with available actions', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action "archive" is not supported for rbook_mission_transition.',
          suggestion: 'Use one of the available actions.',
          availableActions: ['start', 'complete', 'block', 'unblock', 'drop', 'defer'],
        },
      };

      const formatted = formatMissionTransitionForLLM(undefined, result);

      expect(formatted).toContain('Failed to execute rbook_mission_transition');
      expect(formatted).toContain('archive');
      expect(formatted).toContain('Available actions');
    });

    it('delegates start formatting to the existing formatter', () => {
      const mockResult = { success: true, data: { missionId: 's14-m01' } } as any;
      (
        formatMissionStartForLLM as jest.MockedFunction<typeof formatMissionStartForLLM>
      ).mockReturnValueOnce('formatted start');

      const result = formatMissionTransitionForLLM('start', mockResult);

      expect(formatMissionStartForLLM).toHaveBeenCalledWith(mockResult);
      expect(result).toBe('formatted start');
    });

    it('delegates complete formatting to the existing formatter', () => {
      const mockResult = { success: true, data: { missionId: 's14-m01' } } as any;
      (
        formatMissionCompleteForLLM as jest.MockedFunction<typeof formatMissionCompleteForLLM>
      ).mockReturnValueOnce('formatted complete');

      const result = formatMissionTransitionForLLM('complete', mockResult);

      expect(formatMissionCompleteForLLM).toHaveBeenCalledWith(mockResult);
      expect(result).toBe('formatted complete');
    });

    it('delegates drop formatting to the existing formatter', () => {
      const mockResult = { success: true, data: { missionId: 's14-m01' } } as any;
      (
        formatMissionDropForLLM as jest.MockedFunction<typeof formatMissionDropForLLM>
      ).mockReturnValueOnce('formatted drop');

      const result = formatMissionTransitionForLLM('drop', mockResult);

      expect(formatMissionDropForLLM).toHaveBeenCalledWith(mockResult);
      expect(result).toBe('formatted drop');
    });

    it('delegates defer formatting to the existing formatter', () => {
      const mockResult = { success: true, data: { missionId: 's14-m01' } } as any;
      (
        formatMissionDeferForLLM as jest.MockedFunction<typeof formatMissionDeferForLLM>
      ).mockReturnValueOnce('formatted defer');

      const result = formatMissionTransitionForLLM('defer', mockResult);

      expect(formatMissionDeferForLLM).toHaveBeenCalledWith(mockResult);
      expect(result).toBe('formatted defer');
    });

    it('returns fallback for unknown action', () => {
      const result = formatMissionTransitionForLLM('unknown', {
        success: true,
        data: {},
      } as any);
      expect(result).toContain('Mission transition completed');
    });
  });
});
