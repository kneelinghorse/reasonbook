import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/rbook/rbook-db-health', () => ({
  rbookDbHealth: jest.fn(),
  formatHealthForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-db-snapshot', () => ({
  rbookDbSnapshot: jest.fn(),
  formatDbSnapshotForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-db-restore', () => ({
  rbookDbRestore: jest.fn(),
  formatDbRestoreForLLM: jest.fn(),
}));

import {
  RBOOK_DB_ACTIONS,
  rbookDb,
  rbookDbToolDefinition,
  formatDbForLLM,
} from '../../../src/tools/rbook/rbook-db';
import { rbookDbHealth } from '../../../src/tools/rbook/rbook-db-health';
import { rbookDbSnapshot } from '../../../src/tools/rbook/rbook-db-snapshot';
import { rbookDbRestore } from '../../../src/tools/rbook/rbook-db-restore';

describe('rbook_db', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes health action', async () => {
    const expected = { success: true, data: { healthy: true } } as any;
    (rbookDbHealth as jest.MockedFunction<typeof rbookDbHealth>).mockResolvedValueOnce(expected);

    const result = await rbookDb({ action: 'health', projectRoot: '/tmp/test' });
    expect(rbookDbHealth).toHaveBeenCalledWith({ projectRoot: '/tmp/test' });
    expect(result).toBe(expected);
  });

  it('routes snapshot action', async () => {
    const expected = { success: true, data: { snapshots: [] } } as any;
    (rbookDbSnapshot as jest.MockedFunction<typeof rbookDbSnapshot>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookDb({ action: 'snapshot', listOnly: true, maxSnapshots: 5 });
    expect(rbookDbSnapshot).toHaveBeenCalledWith({
      listOnly: true,
      maxSnapshots: 5,
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('routes restore action', async () => {
    const expected = { success: true, data: { restored: true } } as any;
    (rbookDbRestore as jest.MockedFunction<typeof rbookDbRestore>).mockResolvedValueOnce(expected);

    const result = await rbookDb({
      action: 'restore',
      snapshotId: 'snap-001',
      confirm: true,
    });
    expect(rbookDbRestore).toHaveBeenCalledWith({
      snapshotId: 'snap-001',
      confirm: true,
      projectRoot: undefined,
    });
    expect(result).toBe(expected);
  });

  it('defaults snapshotId and confirm for restore', async () => {
    const expected = { success: true, data: {} } as any;
    (rbookDbRestore as jest.MockedFunction<typeof rbookDbRestore>).mockResolvedValueOnce(expected);

    await rbookDb({ action: 'restore' });
    expect(rbookDbRestore).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: '', confirm: false })
    );
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await rbookDb({ action: 'drop' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(rbookDbToolDefinition.name).toBe('rbook_db');
    });
    it('requires action', () => {
      expect(rbookDbToolDefinition.inputSchema.required).toContain('action');
    });
    it('disallows additional properties', () => {
      expect(rbookDbToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('RBOOK_DB_ACTIONS', () => {
    // s92-m09: prune_snapshots, a dry run unless confirm=true. s96-m12: conflicts and settle, on a
    // shared project.
    it('contains 12 actions', () => {
      expect(RBOOK_DB_ACTIONS).toHaveLength(12);
      expect([...RBOOK_DB_ACTIONS]).toEqual([
        'health',
        'snapshot',
        'restore',
        'backfill',
        'reconcile',
        'purge',
        'identify_orphans',
        'pull',
        'clone',
        'prune_snapshots',
        'conflicts',
        'settle',
      ]);
    });
  });

  describe('formatDbForLLM', () => {
    it('formats INVALID_ACTION errors', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action not supported',
          availableActions: ['health', 'snapshot', 'restore'],
        },
      };
      expect(formatDbForLLM(undefined, result)).toContain('Failed to execute rbook_db');
    });

    it('returns fallback for unknown action', () => {
      expect(formatDbForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Database action completed'
      );
    });
  });
});
