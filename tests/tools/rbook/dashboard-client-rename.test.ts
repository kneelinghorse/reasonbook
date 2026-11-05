// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Verifies dashboard rename receipts before the CLI may change the local record.
// ABOUTME: Keeps confirmed HTTP refusals distinct from outcomes requiring an owned-project read.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import type { RbookToolResult } from '../../../src/tools/rbook/types';

interface ExpectedRenameReceipt {
  readonly id: string;
  readonly oldName: string;
  readonly newName: string;
  readonly oldSlug: string;
  readonly newSlug: string;
}

// Keep this contract executable on the pre-rename release: absence must fail at runtime.
type RenameClient = DashboardClient & {
  renameProject(
    projectId: string,
    name: string,
    slug: string
  ): Promise<RbookToolResult<ExpectedRenameReceipt>>;
};

describe('DashboardClient.renameProject', () => {
  let client: RenameClient;
  let fetchMock: jest.SpiedFunction<typeof fetch>;
  const projectId = 'project-001';
  const name = 'Renamed Project';
  const slug = 'renamed-project';
  const updated: ExpectedRenameReceipt = {
    id: projectId,
    oldName: 'Original Project',
    newName: name,
    oldSlug: 'original-project',
    newSlug: slug,
  };

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
    client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test',
      timeoutMs: 100,
    }) as RenameClient;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the combined name-and-slug PATCH and returns its confirmed identity', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ success: true, updated }));

    const result = await client.renameProject(projectId, name, slug);

    expect(result).toEqual({ success: true, data: updated });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://localhost:3100/api/projects/${projectId}`,
      expect.objectContaining({
        method: 'PATCH',
        headers: expect.objectContaining({ Authorization: 'Bearer cmk_test' }),
        body: JSON.stringify({ name, slug }),
      })
    );
  });

  it('accepts an unchanged receipt so a half-done local rename can converge', async () => {
    const unchanged = { ...updated, oldName: name, oldSlug: slug };
    fetchMock.mockResolvedValueOnce(Response.json({ success: true, updated: unchanged }));

    expect(await client.renameProject(projectId, name, slug)).toEqual({
      success: true,
      data: unchanged,
    });
  });

  it.each([
    [400, 'PROJECT_RENAME_INVALID'],
    [401, 'DASHBOARD_AUTH_FAILED'],
    [403, 'DASHBOARD_FORBIDDEN'],
    [404, 'DASHBOARD_NOT_FOUND'],
    [409, 'PROJECT_RENAME_CONFLICT'],
  ])('keeps HTTP %i as a confirmed refusal without a second request', async (status, code) => {
    fetchMock.mockResolvedValueOnce(
      Response.json({ error: 'Rename refused', hint: 'Check the requested project.' }, { status })
    );

    const result = await client.renameProject(projectId, name, slug);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({ code, currentState: { httpStatus: status } });
    expect(result.error?.suggestion).toEqual(expect.any(String));
    expect(result.error?.suggestion?.length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([500, 503])('preserves HTTP %i as an unknown outcome for read-back', async (status) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: 'Server failure' }, { status }));

    const result = await client.renameProject(projectId, name, slug);

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'DASHBOARD_ERROR',
      currentState: { httpStatus: status },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'timeout'])(
    'leaves a %s failure unknown without retrying the mutation',
    async (kind) => {
      const error = new Error(kind === 'timeout' ? 'Aborted' : 'Connection reset');
      if (kind === 'timeout') error.name = 'AbortError';
      fetchMock.mockRejectedValueOnce(error);

      const result = await client.renameProject(projectId, name, slug);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('DASHBOARD_UNREACHABLE');
      expect(result.error?.currentState).toBeUndefined();
      expect(result.error?.suggestion).toEqual(expect.any(String));
      if (kind === 'timeout') expect(result.error?.message).toContain('timed out');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['another project', { success: true, updated: { ...updated, id: 'other-project' } }],
    ['another name', { success: true, updated: { ...updated, newName: 'Other Name' } }],
    ['another slug', { success: true, updated: { ...updated, newSlug: 'other-slug' } }],
    ['no old name', { success: true, updated: { ...updated, oldName: null } }],
    ['no old slug', { success: true, updated: { ...updated, oldSlug: null } }],
    ['no update receipt', { success: true }],
    ['a refusal in a 200', { success: false, updated }],
    ['no success flag', { updated }],
  ])('does not authorize local writes from %s', async (_label, body) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));

    const result = await client.renameProject(projectId, name, slug);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
    expect(result.error?.currentState).toBeUndefined();
    expect(result.error?.suggestion).toContain('name and slug');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
