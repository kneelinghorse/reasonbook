import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../../src/tools/rbook/rbook-project-init', () => ({
  rbookProjectInit: jest.fn(),
  formatProjectInitForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-project-register', () => ({
  rbookProjectRegister: jest.fn(),
  formatProjectRegisterForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-project-list', () => ({
  rbookProjectList: jest.fn(),
  formatProjectListForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-project-unregister', () => ({
  rbookProjectUnregister: jest.fn(),
  formatProjectUnregisterForLLM: jest.fn(),
}));
jest.mock('../../../src/tools/rbook/rbook-project-validate', () => ({
  rbookProjectValidate: jest.fn(),
  formatProjectValidateForLLM: jest.fn(),
}));

import {
  RBOOK_PROJECT_ACTIONS,
  rbookProject,
  rbookProjectToolDefinition,
  formatProjectForLLM,
} from '../../../src/tools/rbook/rbook-project';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { rbookProjectRegister } from '../../../src/tools/rbook/rbook-project-register';
import { rbookProjectList } from '../../../src/tools/rbook/rbook-project-list';
import { rbookProjectUnregister } from '../../../src/tools/rbook/rbook-project-unregister';
import { rbookProjectValidate } from '../../../src/tools/rbook/rbook-project-validate';

describe('rbook_project', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes init action', async () => {
    const expected = { success: true, data: { initialized: true } } as any;
    (rbookProjectInit as jest.MockedFunction<typeof rbookProjectInit>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookProject({
      action: 'init',
      projectRoot: '/tmp/test',
      projectName: 'Test Project',
      projectId: 'test-proj',
    });
    expect(rbookProjectInit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/tmp/test',
        projectName: 'Test Project',
        projectId: 'test-proj',
      })
    );
    expect(result).toBe(expected);
  });

  it('routes register action', async () => {
    const expected = { success: true, data: { registered: true } } as any;
    (
      rbookProjectRegister as jest.MockedFunction<typeof rbookProjectRegister>
    ).mockResolvedValueOnce(expected);

    const result = await rbookProject({
      action: 'register',
      projectRoot: '/tmp/test',
      name: 'My Project',
      setAsDefault: true,
    });
    expect(rbookProjectRegister).toHaveBeenCalledWith({
      projectRoot: '/tmp/test',
      name: 'My Project',
      setAsDefault: true,
    });
    expect(result).toBe(expected);
  });

  it('routes list action', async () => {
    const expected = { success: true, data: { projects: [] } } as any;
    (rbookProjectList as jest.MockedFunction<typeof rbookProjectList>).mockResolvedValueOnce(
      expected
    );

    const result = await rbookProject({ action: 'list' });
    expect(rbookProjectList).toHaveBeenCalledWith({});
    expect(result).toBe(expected);
  });

  it('routes list with validate flag to a validate that never prunes', async () => {
    const expected = { success: true, data: { valid: true } } as any;
    (
      rbookProjectValidate as jest.MockedFunction<typeof rbookProjectValidate>
    ).mockResolvedValueOnce(expected);

    const result = await rbookProject({ action: 'list', validate: true });
    expect(rbookProjectValidate).toHaveBeenCalledWith({});
    expect(rbookProjectList).not.toHaveBeenCalled();
    expect(result).toBe(expected);
  });

  // s93-m11 (#606 g): list is read-classified, and a prune archives registry rows.
  it('refuses list with prune and names the actions that prune', async () => {
    const result = await rbookProject({ action: 'list', validate: true, prune: true });
    expect(rbookProjectValidate).not.toHaveBeenCalled();
    expect(rbookProjectList).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error?.suggestion).toContain('rbook_project(action="prune")');
  });

  it('routes unregister action', async () => {
    const expected = { success: true, data: { unregistered: true } } as any;
    (
      rbookProjectUnregister as jest.MockedFunction<typeof rbookProjectUnregister>
    ).mockResolvedValueOnce(expected);

    const result = await rbookProject({ action: 'unregister', projectRoot: '/tmp/test' });
    expect(rbookProjectUnregister).toHaveBeenCalledWith({ projectRoot: '/tmp/test' });
    expect(result).toBe(expected);
  });

  it('routes validate action', async () => {
    const expected = { success: true, data: { valid: true } } as any;
    (
      rbookProjectValidate as jest.MockedFunction<typeof rbookProjectValidate>
    ).mockResolvedValueOnce(expected);

    const result = await rbookProject({ action: 'validate', prune: false });
    expect(rbookProjectValidate).toHaveBeenCalledWith({ prune: false });
    expect(result).toBe(expected);
  });

  it('routes prune action to rbookProjectValidate with prune=true', async () => {
    const expected = { success: true, data: { validations: [], summary: {} } } as any;
    (
      rbookProjectValidate as jest.MockedFunction<typeof rbookProjectValidate>
    ).mockResolvedValueOnce(expected);

    const result = await rbookProject({ action: 'prune' });
    expect(rbookProjectValidate).toHaveBeenCalledWith({ prune: true });
    expect(result).toBe(expected);
  });

  it('returns INVALID_ACTION for unknown action', async () => {
    const result = await rbookProject({ action: 'delete' as any });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_ACTION');
  });

  it('defaults projectRoot for init and register', async () => {
    const expected = { success: true, data: {} } as any;
    (rbookProjectInit as jest.MockedFunction<typeof rbookProjectInit>).mockResolvedValueOnce(
      expected
    );

    await rbookProject({ action: 'init' });
    expect(rbookProjectInit).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: '' }));
  });

  describe('tool definition', () => {
    it('has correct name', () => {
      expect(rbookProjectToolDefinition.name).toBe('rbook_project');
    });
    it('requires action', () => {
      expect(rbookProjectToolDefinition.inputSchema.required).toContain('action');
    });
    it('disallows additional properties', () => {
      expect(rbookProjectToolDefinition.inputSchema.additionalProperties).toBe(false);
    });
  });

  describe('RBOOK_PROJECT_ACTIONS', () => {
    it('contains 14 actions: the registry and level ones, then the shared record (s96-m13)', () => {
      expect(RBOOK_PROJECT_ACTIONS).toHaveLength(14);
      expect([...RBOOK_PROJECT_ACTIONS]).toEqual([
        'init',
        'register',
        'list',
        'unregister',
        'validate',
        'prune',
        'update',
        'sweep',
        'share',
        'invite',
        'join',
        'members',
        'remove',
        'sync',
      ]);
    });
  });

  describe('formatProjectForLLM', () => {
    it('formats INVALID_ACTION errors', () => {
      const result = {
        success: false as const,
        error: {
          code: 'INVALID_ACTION',
          message: 'Action not supported',
          availableActions: ['init', 'register', 'list', 'unregister', 'validate'],
        },
      };
      expect(formatProjectForLLM(undefined, result)).toContain('Failed to execute rbook_project');
    });

    it('returns fallback for unknown action', () => {
      expect(formatProjectForLLM('unknown', { success: true, data: {} } as any)).toContain(
        'Project action completed'
      );
    });
  });
});
