// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Directory mode must remove remote and conversation-derived operations before any I/O.
// ABOUTME: Full mode remains a separate immutable contract, including clients created before a mode change.

import { getToolDefinitions, executeMissionProtocolTool } from '../../../src/index';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { rbookProject } from '../../../src/tools/rbook/rbook-project';
import { rbookDb } from '../../../src/tools/rbook/rbook-db';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { rbookMission } from '../../../src/tools/rbook/rbook-mission';
import { rbookLearnings } from '../../../src/tools/rbook/rbook-learnings';
import { rbookFeedback } from '../../../src/tools/rbook/rbook-feedback';

const absent = '/directory-edition-intentionally-absent';

describe('directory edition boundaries', () => {
  const saved = process.env.RBOOK_EDITION;
  afterEach(() => {
    if (saved === undefined) delete process.env.RBOOK_EDITION;
    else process.env.RBOOK_EDITION = saved;
    jest.restoreAllMocks();
  });

  it('filters a copy of the full wire and never leaks removed actions or their parameters', () => {
    delete process.env.RBOOK_EDITION;
    const full = getToolDefinitions();
    const before = JSON.stringify(full);
    process.env.RBOOK_EDITION = 'directory';
    const local = getToolDefinitions();
    for (const name of ['rbook_auth', 'rbook_message'])
      expect(local.map((tool) => tool.name)).not.toContain(name);
    expect(local).toHaveLength(13);
    for (const tool of local) {
      expect(tool.inputSchema.properties).not.toHaveProperty('acrossProjects');
      expect(tool.inputSchema.properties).not.toHaveProperty('fromDraft');
    }
    const find = (name: string) =>
      local.find((tool) => tool.name === name)!.inputSchema.properties!;
    for (const action of [
      'share',
      'invite',
      'join',
      'members',
      'remove',
      'sync',
      'move',
      'sweep',
    ]) {
      expect(find('rbook_project').action).toMatchObject({
        enum: expect.not.arrayContaining([action]),
      });
    }
    expect(find('rbook_project')).not.toHaveProperty('inviteCode');
    expect(find('rbook_sprint').action).toMatchObject({
      enum: expect.not.arrayContaining(['carry_forward']),
    });
    expect(find('rbook_db').action).toMatchObject({
      enum: ['health', 'snapshot', 'restore', 'prune_snapshots'],
    });
    expect(JSON.stringify(local).length).toBeLessThanOrEqual(before.length);
    expect(JSON.stringify(full)).toBe(before);
    delete process.env.RBOOK_EDITION;
    expect(JSON.stringify(getToolDefinitions())).toBe(before);
  });

  it('fails closed for an unknown launch mode instead of silently using the full product', () => {
    process.env.RBOOK_EDITION = 'direcotry';
    expect(() => getToolDefinitions()).toThrow(/RBOOK_EDITION/);
  });

  it.each([
    ['project share', () => rbookProject({ action: 'share', projectRoot: absent })],
    ['project sweep', () => rbookProject({ action: 'sweep', projectRoot: absent })],
    ['database backfill', () => rbookDb({ action: 'backfill', projectRoot: absent })],
    [
      'sprint transfer',
      () => rbookSprint({ action: 'carry_forward', sprintId: 's', projectRoot: absent }),
    ],
    [
      'draft approval',
      () =>
        rbookDecisions({
          action: 'record',
          content: 'Approved record',
          fromDraft: 'P1',
          projectRoot: absent,
        }),
    ],
    [
      'mission federation',
      () => rbookMission({ action: 'list', acrossProjects: true, projectRoot: absent }),
    ],
    [
      'learning federation',
      () =>
        rbookLearnings({
          action: 'list',
          acrossProjects: true,
          category: 'process',
          projectRoot: absent,
        }),
    ],
    [
      'feedback federation',
      () => rbookFeedback({ action: 'list', acrossProjects: true, projectRoot: absent }),
    ],
  ])('refuses %s before resolving or opening a project', async (_name, call) => {
    process.env.RBOOK_EDITION = 'directory';
    const result = await call();
    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: 'DIRECTORY_EDITION_UNAVAILABLE',
      suggestion: expect.stringContaining('full plugin'),
    });
  });

  it.each(['rbook_auth', 'rbook_message'])(
    'refuses a direct hidden %s call with the full-plugin remedy',
    async (name) => {
      process.env.RBOOK_EDITION = 'directory';
      const result = await executeMissionProtocolTool(
        name,
        { action: 'list', projectRoot: absent },
        {} as never
      );
      expect(result.structuredContent).toMatchObject({
        success: false,
        error: { code: 'DIRECTORY_EDITION_UNAVAILABLE' },
      });
      expect(JSON.stringify(result)).toContain('full plugin');
    }
  );

  it('refuses all client factories before reading credentials, including override getters', async () => {
    process.env.RBOOK_EDITION = 'directory';
    const credentials = jest.spyOn(CredentialStore, 'create');
    const read = jest.fn(() => 'synthetic-never-read-key');
    const config = {
      baseUrl: 'http://127.0.0.1:1',
      get apiKey() {
        return read();
      },
    };
    expect(() => new DashboardClient(config)).toThrow(/full plugin/);
    for (const result of [
      DashboardClient.fromEnv(config),
      await DashboardClient.fromEnvForProject(absent, config),
      await DashboardClient.fromEnvForUser(config),
    ]) {
      expect(result.error?.code).toBe('DIRECTORY_EDITION_UNAVAILABLE');
    }
    expect(read).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });

  it('refuses an already-created client before a request or cached credential can be used', async () => {
    delete process.env.RBOOK_EDITION;
    const client = new DashboardClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic' });
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('forbidden request'));
    process.env.RBOOK_EDITION = 'directory';
    expect((await client.getSyncStatus()).error?.code).toBe('DIRECTORY_EDITION_UNAVAILABLE');
    expect(fetch).not.toHaveBeenCalled();
  });
});
