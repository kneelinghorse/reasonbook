// ABOUTME: Integration-style tests for the rbook_message pipeline.
// ABOUTME: Uses a real seeded SQLite project so sender attribution follows the production DB path.

import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  createSeededRbookProject,
  seedRbookDb,
  type SeedRbookDbOptions,
  type SeededRbookProject,
} from '../../helpers/seedRbookDb';

// Mock DashboardClient.fromEnv before importing rbook-message
jest.mock('../../../src/tools/rbook/dashboard-client', () => {
  const actual = jest.requireActual(
    '../../../src/tools/rbook/dashboard-client'
  ) as typeof import('../../../src/tools/rbook/dashboard-client');

  return {
    ...actual,
    DashboardClient: {
      ...actual.DashboardClient,
      fromEnvForProject: jest.fn(),
    },
  };
});

jest.mock('../../../src/tools/rbook/owner-resolution', () => ({
  resolveAndPersistOwner: async () => ({ owner: null, source: 'unresolved' }),
}));

const DEFAULT_LOCAL_PROJECT: SeedRbookDbOptions = {
  projectName: 'Reasonbook MCP',
  projectId: 'cmos-mcp',
  slug: 'cmos-mcp',
  dashboardProjectId: 'ec2b4987-dbc1-4f16-946e-9843c4080ac1',
  rbookAddress: 'rbook://derek/cmos-mcp',
};

let localProject: SeededRbookProject | null = null;
let _mockLocalRbookAddress: string | null = DEFAULT_LOCAL_PROJECT.rbookAddress ?? null;
let _mockLocalDashboardProjectId: string | null = DEFAULT_LOCAL_PROJECT.dashboardProjectId ?? null;
const originalCwd = process.cwd;

function reseedLocalProject(): void {
  if (!localProject) {
    throw new Error('Local Reasonbook project not initialized');
  }

  seedRbookDb(localProject.projectRoot, {
    ...DEFAULT_LOCAL_PROJECT,
    dashboardProjectId: _mockLocalDashboardProjectId,
    rbookAddress: _mockLocalRbookAddress,
  });
}

function setLocalRbookAddress(addr: string | null): void {
  _mockLocalRbookAddress = addr;
  reseedLocalProject();
}

function setLocalDashboardProjectId(id: string | null): void {
  _mockLocalDashboardProjectId = id;
  reseedLocalProject();
}

import { rbookMessage, formatMessageForLLM } from '../../../src/tools/rbook/rbook-message';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { createSuccess, createError, RbookErrors } from '../../../src/tools/rbook/errors';

// ─── Test Data ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

const DIRECTORY_PROJECTS = [
  {
    id: '01794cfc-c41d-4457-bccb-12edac7c828e',
    name: 'cmos-mcp',
    address: 'rbook://derek/cmos-mcp',
    owner: 'derek',
    description: 'MCP server',
  },
  {
    id: '9566f5ce-f171-4e95-a24e-ad756c2b8807',
    name: 'cmos-dashboard',
    address: 'rbook://derek/cmos-dashboard',
    owner: 'derek',
    description: 'Dashboard',
  },
  {
    id: '7422f5a1-b860-4b85-912d-e934cf6dba1b',
    name: 'tracelab',
    address: 'rbook://derek/tracelab',
    owner: 'derek',
    description: 'TraceLab',
  },
  {
    id: 'b9338ed4-bad7-475b-be02-61efbdbb0731',
    name: 'oods-foundry',
    address: 'rbook://darryl/oods-foundry',
    owner: 'darryl',
    description: 'OODS Foundry',
  },
  {
    id: 'c49caac3-1a47-4f40-bc04-21e88890fcb2',
    name: 'oods-foundry-mcp',
    address: 'rbook://derek/oods-foundry-mcp',
    owner: 'derek',
    description: 'OODS Foundry MCP',
  },
];

function mockClient() {
  const client = {
    sendMessage: jest.fn() as AnyMock,
    listMessages: jest.fn() as AnyMock,
    respondToMessage: jest.fn() as AnyMock,
    resolveAddress: jest.fn() as AnyMock,
    listDirectory: jest.fn() as AnyMock,
    getMyProjects: jest.fn() as AnyMock,
  };

  // Defaults
  client.resolveAddress.mockResolvedValue(
    createSuccess({ resolved: true, projectName: 'cmos-dashboard' })
  );
  // Default: /api/projects/me returns the FULL owned directory (every project derek
  // has). Tests that want to simulate "this cwd is cmos-mcp" must set the local
  // identity via setLocalRbookAddress / setLocalDashboardProjectId — only the stored
  // dashboard UUID identifies the sender; directory entries cannot supply it.
  client.getMyProjects.mockResolvedValue(
    createSuccess({
      projects: DIRECTORY_PROJECTS.filter((p) => p.owner === 'derek'),
      totalCount: DIRECTORY_PROJECTS.filter((p) => p.owner === 'derek').length,
    })
  );
  client.listDirectory.mockResolvedValue(
    createSuccess({ projects: DIRECTORY_PROJECTS, totalCount: 5 })
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

// Sprint 53 m02: integration tests run with a valid seeded identity by default.
// Tests that need to simulate "no local identity" clear both explicitly at the
// top of the test body.
beforeEach(async () => {
  jest.clearAllMocks();
  localProject = await createSeededRbookProject(DEFAULT_LOCAL_PROJECT, 'messaging-integration-');
  const projectRoot = localProject.projectRoot;
  process.cwd = () => projectRoot;
  _mockLocalRbookAddress = DEFAULT_LOCAL_PROJECT.rbookAddress ?? null;
  _mockLocalDashboardProjectId = DEFAULT_LOCAL_PROJECT.dashboardProjectId ?? null;
});

afterEach(async () => {
  process.cwd = originalCwd;
  if (localProject) {
    await localProject.cleanup();
    localProject = null;
  }
});

// ─── E2E: Directory → Resolve → Send → Verify ──────────────────────────────

describe('E2E: discover → resolve → send → verify', () => {
  it('full pipeline: directory, resolve, send with auto-detected sender, then list inbox', async () => {
    // The registered store supplies its own UUID even if a directory entry reuses its address.
    setLocalDashboardProjectId(DEFAULT_LOCAL_PROJECT.dashboardProjectId!);
    setLocalRbookAddress('rbook://derek/cmos-mcp');
    const client = mockClient();

    // Step 1: Discover projects via directory
    const dirResult = await rbookMessage({ action: 'directory' });
    expect(dirResult.success).toBe(true);
    expect((dirResult.data as any).projects).toHaveLength(5);
    expect((dirResult.data as any).totalCount).toBe(5);

    // Verify all 5 known projects are discoverable
    const addresses = (dirResult.data as any).projects.map((p: any) => p.address);
    expect(addresses).toContain('rbook://derek/cmos-mcp');
    expect(addresses).toContain('rbook://derek/cmos-dashboard');
    expect(addresses).toContain('rbook://derek/tracelab');
    expect(addresses).toContain('rbook://darryl/oods-foundry');
    expect(addresses).toContain('rbook://derek/oods-foundry-mcp');

    // Step 2: Send a message (resolveAddress and auto-detect happen internally)
    client.sendMessage.mockResolvedValueOnce(
      createSuccess({
        messageId: 'msg-e2e-001',
        deliveredAt: '2026-08-28T00:00:00Z',
        type: 'backlog_request',
        summary: 'Add sync status endpoint',
        status: 'pending',
        createdAt: '2026-03-10T03:00:00Z',
      })
    );

    const sendResult = await rbookMessage({
      action: 'send',
      targetAddress: 'rbook://derek/cmos-dashboard',
      type: 'backlog_request',
      summary: 'Add sync status endpoint',
      body: 'Need GET /api/sync/status for reconciliation',
    });

    expect(sendResult.success).toBe(true);
    expect((sendResult.data as any).messageId).toBe('msg-e2e-001');
    expect((sendResult.data as any).targetAddress).toBe('rbook://derek/cmos-dashboard');

    // Verify resolveAddress was called (pre-send validation)
    expect(client.resolveAddress).toHaveBeenCalledWith({
      address: 'rbook://derek/cmos-dashboard',
    });

    // Verify senderProjectId was auto-detected
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderProjectId: DEFAULT_LOCAL_PROJECT.dashboardProjectId,
      })
    );

    // Step 3: Verify message appears in sent tab
    client.listMessages.mockResolvedValueOnce(
      createSuccess({
        messages: [
          {
            id: 'msg-e2e-001',
            type: 'backlog_request',
            summary: 'Add sync status endpoint',
            status: 'pending',
            createdAt: '2026-03-10T03:00:00Z',
          },
        ],
        unreadCount: 0,
        totalCount: 1,
      })
    );

    const listResult = await rbookMessage({ action: 'list', tab: 'sent' });
    expect(listResult.success).toBe(true);
    expect((listResult.data as any).messages[0].id).toBe('msg-e2e-001');
  });
});

// ─── Error Paths: Unknown Addresses with Suggestions ─────────────────────────

describe('error paths: unknown addresses', () => {
  it('returns helpful suggestions when target not found', async () => {
    const client = mockClient();
    client.resolveAddress.mockResolvedValueOnce(
      createError(RbookErrors.dashboardNotFound('rbook://derek/rbook-dashbord'))
    );

    const result = await rbookMessage({
      action: 'send',
      targetAddress: 'rbook://derek/rbook-dashbord', // typo
      type: 'question',
      summary: 'Is the API ready?',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_FOUND');
    // Should suggest close matches from directory
    expect(result.error?.suggestion).toContain('rbook://derek/cmos-dashboard');
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('returns directory hint when address owner is completely unknown', async () => {
    const client = mockClient();
    client.resolveAddress.mockResolvedValueOnce(
      createError(RbookErrors.dashboardNotFound('rbook://nobody/unknown'))
    );
    // Return empty suggestions since no close matches exist
    client.listDirectory.mockResolvedValueOnce(
      createSuccess({ projects: DIRECTORY_PROJECTS, totalCount: 5 })
    );

    const result = await rbookMessage({
      action: 'send',
      targetAddress: 'rbook://nobody/unknown',
      type: 'question',
      summary: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_FOUND');
    // No close matches — should suggest using directory
    // (getSuggestedAddresses won't match since neither owner nor slug match)
  });

  it('formats resolution error nicely for agent', async () => {
    const client = mockClient();
    client.resolveAddress.mockResolvedValueOnce(
      createError(RbookErrors.dashboardNotFound('rbook://derek/typo'))
    );

    const result = await rbookMessage({
      action: 'send',
      targetAddress: 'rbook://derek/typo',
      type: 'question',
      summary: 'Test',
    });

    const formatted = formatMessageForLLM('send', result);
    expect(formatted).toContain('Failed to send message');
    expect(formatted).toContain('not found');
  });
});

// ─── Same-Owner Cross-Project Send Without Manual senderProjectId ────────────

describe('same-owner cross-project send', () => {
  it('refuses same-owner address reuse when this store has never registered', async () => {
    // A fresh store may have the same name and canonical address as an older owned record.
    setLocalDashboardProjectId(null);
    setLocalRbookAddress('rbook://derek/cmos-mcp');
    const client = mockClient();
    client.sendMessage.mockResolvedValueOnce(
      createSuccess({
        messageId: 'msg-cross-001',
        deliveredAt: '2026-08-28T00:00:00Z',
        type: 'status_update',
        summary: 'Phase 2 events ready',
        status: 'pending',
        createdAt: '2026-03-10T03:00:00Z',
      })
    );

    const result = await rbookMessage({
      action: 'send',
      targetAddress: 'rbook://derek/cmos-dashboard',
      type: 'status_update',
      summary: 'Phase 2 events ready',
      // No stored or explicit sender ID authorizes publishing under this address.
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SENDER_ATTRIBUTION_INCOMPLETE');
    expect(client.getMyProjects).not.toHaveBeenCalled();
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it('fails closed with SENDER_ATTRIBUTION_INCOMPLETE when local identity is unresolvable', async () => {
    // Sprint 53 m02: replaces the pre-Sprint-53 "succeeds with undefined sender"
    // fail-open behavior. When there is no local UUID and no canonical address,
    // handleSend refuses rather than publishing an anonymous message.
    setLocalRbookAddress(null);
    setLocalDashboardProjectId(null);

    const client = mockClient();
    client.getMyProjects.mockResolvedValueOnce(createSuccess({ projects: [], totalCount: 0 }));

    const result = await rbookMessage({
      action: 'send',
      targetAddress: 'rbook://derek/tracelab',
      type: 'question',
      summary: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SENDER_ATTRIBUTION_INCOMPLETE');
    expect(client.sendMessage).not.toHaveBeenCalled();
  });
});

// ─── Directory Discovery ─────────────────────────────────────────────────────

describe('directory discovery', () => {
  it('returns all 5 known projects with correct addresses and UUIDs', async () => {
    const client = mockClient();

    const result = await rbookMessage({ action: 'directory' });

    expect(result.success).toBe(true);
    const data = result.data as any;
    expect(data.totalCount).toBe(5);

    // Each project has id, name, address, owner
    for (const p of data.projects) {
      expect(p.id).toBeTruthy();
      expect(p.name).toBeTruthy();
      expect(p.address).toMatch(/^rbook:\/\/[a-z]+\/[a-z0-9-]+$/);
      expect(p.owner).toBeTruthy();
    }
  });

  it('formats directory output for LLM', async () => {
    const client = mockClient();

    const result = await rbookMessage({ action: 'directory' });
    const formatted = formatMessageForLLM('directory', result);

    expect(formatted).toContain('Project Directory');
    expect(formatted).toContain('5 addressable project(s)');
    expect(formatted).toContain('rbook://derek/cmos-mcp');
    // s86-m07: the description column is GONE — GET /api/projects/directory/public returns no
    // description for any row, so the renderer that printed one was guarding a dead field.
    expect(formatted).not.toContain('MCP server');
  });
});

// ─── Regression: Sprint 29 Send Pattern ──────────────────────────────────────

describe('regression: Sprint 29 send pattern', () => {
  it('Sprint 29 pattern with explicit senderProjectId still works', async () => {
    const client = mockClient();
    client.sendMessage.mockResolvedValueOnce(
      createSuccess({
        messageId: 'msg-s29-compat',
        deliveredAt: '2026-08-28T00:00:00Z',
        type: 'info_push',
        summary: 'Answers to Phase 2 open questions',
        status: 'pending',
        createdAt: '2026-03-10T02:38:00Z',
      })
    );

    const result = await rbookMessage({
      action: 'send',
      targetAddress: 'rbook://derek/cmos-mcp',
      type: 'info_push',
      summary: 'Answers to Phase 2 open questions',
      body: 'Full content here',
      senderProjectId: '9566f5ce-f171-4e95-a24e-ad756c2b8807', // explicit, like Sprint 29
    });

    expect(result.success).toBe(true);
    expect((result.data as any).messageId).toBe('msg-s29-compat');
    expect((result.data as any).verb).toBe('add');
    expect((result.data as any).object).toBe('reference');

    // Should NOT call getMyProjects when explicit senderProjectId
    expect(client.getMyProjects).not.toHaveBeenCalled();

    // Should pass explicit senderProjectId through
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderProjectId: '9566f5ce-f171-4e95-a24e-ad756c2b8807',
      })
    );
  });

  it('Sprint 29 respond pattern still works', async () => {
    const client = mockClient();
    client.respondToMessage.mockResolvedValueOnce(
      createSuccess({
        id: 'f8df46e5-a3d3-4de2-84a8-8c4ae5120674',
        type: 'info_push',
        summary: 'Answers to Phase 2 open questions',
        status: 'accepted',
        createdAt: '2026-03-10T02:38:00Z',
        updatedAt: '2026-03-10T02:39:00Z',
      })
    );

    const result = await rbookMessage({
      action: 'respond',
      messageId: 'f8df46e5-a3d3-4de2-84a8-8c4ae5120674',
      respondStatus: 'accepted',
      notes: 'All 3 answers received.',
    });

    expect(result.success).toBe(true);
    expect((result.data as any).currentStatus).toBe('accepted');
  });

  it('Sprint 29 list pattern still works', async () => {
    const client = mockClient();
    client.listMessages.mockResolvedValueOnce(
      createSuccess({
        messages: [
          {
            id: 'msg-001',
            type: 'info_push',
            summary: 'Info from dashboard',
            status: 'pending',
            createdAt: '2026-03-10T02:38:00Z',
          },
        ],
        unreadCount: 1,
        totalCount: 1,
      })
    );

    const result = await rbookMessage({ action: 'list', status: 'pending' });
    expect(result.success).toBe(true);
    expect((result.data as any).messages).toHaveLength(1);
    // s86-m07: `unreadCount` is now two separately-named numbers — the dashboard's user-wide
    // total, and the count this view can vouch for.
    expect((result.data as any).unreadCountUserWide).toBe(1);
    expect((result.data as any).unreadInThisView).toBe(1);
  });
});

// ─── Input Normalization Integration ─────────────────────────────────────────

describe('input normalization integration', () => {
  it('normalizes an existing project display name in the full pipeline', async () => {
    const client = mockClient();
    client.sendMessage.mockResolvedValueOnce(
      createSuccess({
        id: 'msg-norm-001',
        type: 'question',
        summary: 'Test normalization',
        status: 'pending',
        createdAt: '2026-03-10T03:00:00Z',
      })
    );

    const result = await rbookMessage({
      action: 'send',
      targetAddress: `rbook://Derek/${LEGACY.proseName} Dashboard`,
      type: 'question',
      summary: 'Test normalization',
    });

    expect(result.success).toBe(true);
    // Resolution should use normalized address
    expect(client.resolveAddress).toHaveBeenCalledWith({
      address: 'rbook://derek/cmos-dashboard',
    });
    // Send should use normalized address
    expect(client.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ targetAddress: 'rbook://derek/cmos-dashboard' })
    );
    // Result should show normalized address
    expect((result.data as any).targetAddress).toBe('rbook://derek/cmos-dashboard');
  });

  it('handles multiple consecutive spaces in address', async () => {
    const client = mockClient();
    client.sendMessage.mockResolvedValueOnce(
      createSuccess({
        id: 'msg-norm-002',
        type: 'question',
        summary: 'Test',
        status: 'pending',
        createdAt: '2026-03-10T03:00:00Z',
      })
    );

    await rbookMessage({
      action: 'send',
      targetAddress: 'rbook://derek/oods  foundry  mcp',
      type: 'question',
      summary: 'Test',
    });

    expect(client.resolveAddress).toHaveBeenCalledWith({
      address: 'rbook://derek/oods-foundry-mcp',
    });
  });
});
