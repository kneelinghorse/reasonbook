// ABOUTME: Real-DB regression coverage for sender attribution across sibling Reasonbook projects.
// ABOUTME: Verifies rbook_message keeps each store's registered ID without adopting a directory match.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { createSeededRbookProject, type SeededRbookProject } from '../helpers/seedRbookDb';

jest.mock('../../src/tools/rbook/dashboard-client', () => {
  const actual = jest.requireActual(
    '../../src/tools/rbook/dashboard-client'
  ) as typeof import('../../src/tools/rbook/dashboard-client');

  return {
    ...actual,
    DashboardClient: {
      ...actual.DashboardClient,
      fromEnvForProject: jest.fn(),
    },
  };
});

jest.mock('../../src/tools/rbook/owner-resolution', () => ({
  resolveAndPersistOwner: async () => ({ owner: null, source: 'unresolved' }),
}));

import { rbookMessage } from '../../src/tools/rbook/rbook-message';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { createSuccess } from '../../src/tools/rbook/errors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

function createMockDashboardClient() {
  const client = {
    sendMessage: jest.fn() as AnyMock,
    listMessages: jest.fn() as AnyMock,
    respondToMessage: jest.fn() as AnyMock,
    resolveAddress: jest.fn() as AnyMock,
    listDirectory: jest.fn() as AnyMock,
    getMyProjects: jest.fn() as AnyMock,
  };

  client.resolveAddress.mockResolvedValue(
    createSuccess({ resolved: true, projectName: 'oods-foundry' })
  );
  client.getMyProjects.mockResolvedValue(
    createSuccess({
      projects: [
        {
          id: '96ce2349-b7e7-45b1-99e3-23277db407f5',
          name: 'example-project',
          address: 'rbook://derek/example-project',
          owner: 'derek',
        },
        {
          id: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
          name: 'cmos-mcp',
          address: 'rbook://derek/cmos-mcp',
          owner: 'derek',
        },
        {
          id: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
          name: 'stage1',
          address: 'rbook://derek/stage1',
          owner: 'derek',
        },
      ],
      totalCount: 3,
    })
  );

  (
    DashboardClient.fromEnvForProject as jest.MockedFunction<
      typeof DashboardClient.fromEnvForProject
    >
  ).mockResolvedValue(
    createSuccess({
      client: client as unknown as DashboardClient,
      keySource: 'user-scoped',
      matchedProjectRoot: null,
    })
  );

  return client;
}

describe('multi-project attribution', () => {
  let rbookMcpProject: SeededRbookProject;
  let stage1Project: SeededRbookProject;

  beforeEach(async () => {
    jest.clearAllMocks();
    rbookMcpProject = await createSeededRbookProject(
      {
        projectName: 'Reasonbook MCP',
        projectId: 'cmos-mcp',
        slug: 'cmos-mcp',
        dashboardProjectId: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
        rbookAddress: 'rbook://derek/cmos-mcp',
      },
      'multi-project-rbook-'
    );
    stage1Project = await createSeededRbookProject(
      {
        projectName: 'Stage1',
        projectId: 'stage1',
        slug: 'stage1',
        dashboardProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        rbookAddress: 'rbook://derek/stage1',
      },
      'multi-project-stage1-'
    );
  });

  afterEach(async () => {
    await Promise.all([rbookMcpProject.cleanup(), stage1Project.cleanup()]);
  });

  it('different stores keep their registered sender IDs without consulting the dashboard directory', async () => {
    const client = createMockDashboardClient();
    const createdAt = new Date(Date.now() - 60_000).toISOString();

    client.sendMessage
      .mockResolvedValueOnce(
        createSuccess({
          id: 'msg-rbook',
          type: 'question',
          summary: 'First send',
          status: 'pending',
          createdAt,
        })
      )
      .mockResolvedValueOnce(
        createSuccess({
          id: 'msg-stage1',
          type: 'question',
          summary: 'Second send',
          status: 'pending',
          createdAt,
        })
      );

    const first = await rbookMessage({
      action: 'send',
      projectRoot: rbookMcpProject.projectRoot,
      targetAddress: 'rbook://derek/oods-foundry',
      type: 'question',
      summary: 'First send',
    });
    const second = await rbookMessage({
      action: 'send',
      projectRoot: stage1Project.projectRoot,
      targetAddress: 'rbook://derek/oods-foundry',
      type: 'question',
      summary: 'Second send',
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(client.getMyProjects).not.toHaveBeenCalled();
    expect(client.sendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        senderProjectId: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
        senderAddress: 'rbook://derek/cmos-mcp',
      })
    );
    expect(client.sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        senderProjectId: 'ddb34d24-30e3-4eb3-b13c-20b106a75970',
        senderAddress: 'rbook://derek/stage1',
      })
    );
  });
});
