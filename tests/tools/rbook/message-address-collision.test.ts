// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m07 — the address-and-inbox surfaces of rbook_message say only what they know:
// ABOUTME: prefix-sibling ambiguity, a real ownership signal, and an unread badge with one scope.

/**
 * Sprint 86 m07 — directory / list / client-shape truth.
 *
 * THE DEFECT THIS SUITE PINS. `rbook_message(action="directory")` listed
 * `rbook://derek/cmos-mcp` (dormant) beside `rbook://derek/cmos-mcp-pro` (live) with nothing
 * distinguishing them, while every naming cue pointed a sibling at the dead one — and a send
 * there SUCCEEDS with no bounce. Two Stage1 defect reports sat unread through an entire sprint
 * for exactly that reason, hidden behind an `unreadCount` that is USER-WIDE while the rows
 * beside it are key-scoped ("0 total, 7 unread" was a header this tool really printed).
 *
 * THE DIRECTORY FIXTURE IS ITS AUGUST 2026 SHAPE. Measured 2026-08-10 against https://reasonbook.ai
 * (37 rows), `/api/projects/directory/public` returned `{id, name, slug, owner, ownerDisplayName,
 * [LEGACY.wireAddressKey], createdAt}` and no `isOwner` or `description`. Measured 2026-11-03
 * (s110-m02, probe O), it sends a boolean `isOwner` on every row and `archivedAt` on archived ones,
 * which tests/tools/rbook/directory-ownership.test.ts holds. A row without `isOwner` is kept here
 * because it exercises `/api/projects/me` filling such a row, the only case it is asked for.
 *
 * WHAT THIS SUITE DOES NOT COVER. The send path and the credential-arm selection are asserted
 * over MCP stdio against the BUILT dist/ in tests/e2e/message-address-collision.e2e.ts — a
 * handler-only test is what let `statusFilter`, `expiresAt` and `agentFeedback` each ship dead.
 */

import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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

import {
  rbookMessage,
  formatMessageForLLM,
  type MessageDirectoryResult,
  type MessageListResult,
} from '../../../src/tools/rbook/rbook-message';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { createSuccess, createError, RbookErrors } from '../../../src/tools/rbook/errors';
import type { KeySource } from '../../../src/intelligence/credential-store';

// ─── Live payload fixtures ───────────────────────────────────────────────────

const PRO_ID = 'c02ea1cb-3db7-40b0-a263-7d17ef2a656f';
const MCP_ID = 'ec2b4987-dbc1-4f16-946e-9843c4080ac1';
const TWIN_ID = '00000000-0000-4000-8000-000000000001';

/** A row in the August 2026 SHAPE of the directory body: no isOwner, no description. */
const DIRECTORY_BODY = {
  projects: [
    {
      id: MCP_ID,
      name: 'cmos-mcp',
      slug: 'cmos-mcp',
      owner: 'derek',
      ownerDisplayName: 'Derek',
      [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/cmos-mcp`,
      createdAt: '2025-11-13T00:01:41.000Z',
    },
    {
      id: PRO_ID,
      name: 'CMOS-MCP Pro',
      slug: 'cmos-mcp-pro',
      owner: 'derek',
      ownerDisplayName: 'Derek',
      [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/cmos-mcp-pro`,
      createdAt: '2026-01-04T18:22:10.000Z',
    },
    // The strictness fixture: an EQUAL slug under the same owner is a duplicate, not an
    // ambiguity. Strict-prefix on both sides must exclude it.
    {
      id: TWIN_ID,
      name: 'cmos-mcp (duplicate registration)',
      slug: 'cmos-mcp',
      owner: 'derek',
      ownerDisplayName: 'Derek',
      [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/cmos-mcp`,
      createdAt: '2026-02-01T00:00:00.000Z',
    },
  ],
  totalCount: 3,
};

/** GET /api/projects/me — asked only for a directory row that carries no isOwner (s110-m02). */
const MY_PROJECTS_BODY = {
  projects: [
    {
      id: PRO_ID,
      name: 'CMOS-MCP Pro',
      slug: 'cmos-mcp-pro',
      [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/cmos-mcp-pro`,
      isOwner: true,
    },
  ],
  totalCount: 1,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = jest.Mock<(...args: any[]) => any>;

function mockClient(keySource: KeySource = 'user-scoped') {
  const client = {
    listMessages: jest.fn() as AnyMock,
    listDirectory: jest.fn() as AnyMock,
    getMyProjects: jest.fn() as AnyMock,
  };

  client.listDirectory.mockResolvedValue(createSuccess(JSON.parse(JSON.stringify(DIRECTORY_BODY))));
  client.getMyProjects.mockResolvedValue(
    createSuccess(JSON.parse(JSON.stringify(MY_PROJECTS_BODY)))
  );

  (
    DashboardClient.fromEnvForProject as jest.MockedFunction<
      typeof DashboardClient.fromEnvForProject
    >
  ).mockResolvedValue(
    createSuccess({
      client: client as unknown as DashboardClient,
      keySource,
      matchedProjectRoot: null,
    })
  );

  return client;
}

/**
 * Run a raw dashboard body through the REAL client normalizer by stubbing fetch and calling
 * the shipped method — no test-only export, so the test cannot pass against a normalizer the
 * server does not use.
 */
async function throughClient<T>(
  body: unknown,
  call: (client: DashboardClient) => Promise<T>
): Promise<T> {
  // The module mock above replaces the class with a plain object (spreading a class does not
  // preserve its constructor), so reach for the REAL one — the point of this helper is that the
  // normalization under test is the shipped one.
  const { DashboardClient: RealDashboardClient } = jest.requireActual(
    '../../../src/tools/rbook/dashboard-client'
  ) as typeof import('../../../src/tools/rbook/dashboard-client');

  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof global.fetch;
  try {
    return await call(
      new RealDashboardClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'cmk_test' })
    );
  } finally {
    global.fetch = originalFetch;
  }
}

/** The directory body as the handler really receives it: raw wire row → client normalizer. */
async function normalizedDirectory(body: unknown) {
  const result = await throughClient(body, (c) => c.listDirectory());
  if (!result.success) throw new Error('fixture normalization failed');
  return result.data!;
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── C1: the client stops discarding what the dashboard sends ────────────────

describe('normalizeDirectoryProject (s86-m07 C1)', () => {
  it('passes createdAt and ownerDisplayName through', async () => {
    const data = await normalizedDirectory(DIRECTORY_BODY);
    const row = data.projects[0]!;

    expect(row.createdAt).toBe('2025-11-13T00:01:41.000Z');
    expect(row.ownerDisplayName).toBe('Derek');
    expect(row.address).toBe('rbook://derek/cmos-mcp');
    expect(row.slug).toBe('cmos-mcp');
  });

  it('omits the keys entirely on a lean row — no null-wall', async () => {
    const data = await normalizedDirectory({
      projects: [
        { id: 'lean', name: 'Lean', [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/lean` },
      ],
      totalCount: 1,
    });
    const row = data.projects[0]!;

    expect('createdAt' in row).toBe(false);
    expect('ownerDisplayName' in row).toBe(false);
    expect(row).toEqual({
      id: 'lean',
      name: 'Lean',
      address: 'rbook://derek/lean',
      owner: 'derek',
    });
  });

  it('carries no description member — the route does not return one', async () => {
    const data = await normalizedDirectory({
      projects: [
        {
          ...DIRECTORY_BODY.projects[0]!,
          // Even if a body carried one, the field is deleted from the type and the whitelist.
          description: 'this must not survive normalization',
        },
      ],
      totalCount: 1,
    });

    expect('description' in data.projects[0]!).toBe(false);
  });
});

// ─── C1(c): the resolve shape ────────────────────────────────────────────────

describe('ResolveAddressResult (s86-m07 C1c)', () => {
  it('surfaces the resolved OBJECT the endpoint really returns', async () => {
    const body = {
      success: true,
      resolved: {
        projectId: MCP_ID,
        projectName: 'cmos-mcp',
        projectSlug: 'cmos-mcp',
      },
    };
    const result = await throughClient(body, (c) =>
      c.resolveAddress({ address: 'rbook://derek/cmos-mcp' })
    );

    expect(result.success).toBe(true);
    // Impossible to express while `resolved` was typed `boolean` (dashboard-client.ts:283) —
    // the pre-fix RED phase of this assertion is a ts-jest compile error, not a failed expect.
    expect(result.data?.resolved.projectName).toBe('cmos-mcp');
    expect(result.data?.resolved.projectId).toBe(MCP_ID);
    expect(result.data?.resolved.projectSlug).toBe('cmos-mcp');
  });
});

// ─── C2: the directory discriminator ─────────────────────────────────────────

describe('rbook_message(directory) — ambiguity + ownership (s86-m07 C2)', () => {
  it('names each prefix sibling on both rows, and never on equal slugs', async () => {
    const client = mockClient();
    client.listDirectory.mockResolvedValue(
      createSuccess(await normalizedDirectory(DIRECTORY_BODY))
    );

    const result = await rbookMessage({ action: 'directory' });
    expect(result.success).toBe(true);

    const projects = (result.data as MessageDirectoryResult).projects;
    const mcp = projects.find((p) => p.id === MCP_ID)!;
    const pro = projects.find((p) => p.id === PRO_ID)!;
    const twin = projects.find((p) => p.id === TWIN_ID)!;

    expect(mcp.ambiguousWith).toEqual(['rbook://derek/cmos-mcp-pro']);
    expect(pro.ambiguousWith).toEqual(['rbook://derek/cmos-mcp']);
    // EQUAL slug under the same owner: a duplicate registration, not an ambiguity.
    // (It is still prefix-ambiguous with cmos-mcp-pro, which is the honest answer —
    // what it must NOT claim is ambiguity with its own equal-slug twin.)
    expect(twin.ambiguousWith).not.toContain('rbook://derek/cmos-mcp');

    const text = formatMessageForLLM('directory', result);
    expect(text).toContain('rbook://derek/cmos-mcp-pro');
    expect(text).toMatch(/AMBIGUOUS with/);
  });

  it('does not pair slugs across owners', async () => {
    const client = mockClient();
    client.listDirectory.mockResolvedValue(
      createSuccess(
        await normalizedDirectory({
          projects: [
            DIRECTORY_BODY.projects[0]!,
            {
              ...DIRECTORY_BODY.projects[1]!,
              owner: 'someone-else',
              [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}someone-else/cmos-mcp-pro`,
            },
          ],
          totalCount: 2,
        })
      )
    );

    const result = await rbookMessage({ action: 'directory' });
    const projects = (result.data as MessageDirectoryResult).projects;

    for (const p of projects) {
      expect(p.ambiguousWith).toBeUndefined();
    }
  });

  it("marks the operator's own project local using /api/projects/me when its directory row carries no isOwner", async () => {
    const client = mockClient();
    client.listDirectory.mockResolvedValue(
      createSuccess(await normalizedDirectory(DIRECTORY_BODY))
    );

    const result = await rbookMessage({ action: 'directory' });
    const projects = (result.data as MessageDirectoryResult).projects;

    const pro = projects.find((p) => p.id === PRO_ID)!;
    const mcp = projects.find((p) => p.id === MCP_ID)!;

    // RED on the pre-fix tree: isOwner was never populated, so this read 'foreign'.
    expect(pro.provenance?.trust).toBe('local');
    expect(pro.isOwner).toBe(true);
    expect(mcp.provenance?.trust).toBe('foreign');
    expect(client.getMyProjects).toHaveBeenCalledTimes(1);
  });

  it('degrades honestly when /api/projects/me fails: rows kept, isOwner unset, exactly one warning', async () => {
    const client = mockClient();
    client.listDirectory.mockResolvedValue(
      createSuccess(await normalizedDirectory(DIRECTORY_BODY))
    );
    client.getMyProjects.mockResolvedValue(
      createError(RbookErrors.dashboardError('Server error 500: boom'))
    );

    const result = await rbookMessage({ action: 'directory' });

    expect(result.success).toBe(true);
    const data = result.data as MessageDirectoryResult;
    expect(data.projects).toHaveLength(3);
    for (const p of data.projects) {
      expect('isOwner' in p).toBe(false);
      expect(p.provenance?.trust).toBe('foreign');
    }

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('/api/projects/me');

    // Rendered exactly once in the channel an agent reads.
    const text = formatMessageForLLM('directory', result);
    expect(text.split('/api/projects/me').length - 1).toBe(1);
  });
});

// ─── C4: the badge ───────────────────────────────────────────────────────────

/** The live contradiction, pinned verbatim: an EMPTY pending inbox that reported 7 unread. */
const CONTRADICTION_BODY = { messages: [], unreadCount: 7, totalCount: 0 };

describe('rbook_message(list) — one scope per number (s86-m07 C4)', () => {
  it('no longer prints "0 total, 7 unread"', async () => {
    const client = mockClient('user-scoped');
    client.listMessages.mockResolvedValue(createSuccess(CONTRADICTION_BODY));

    const result = await rbookMessage({ action: 'list', tab: 'inbox', status: 'pending' });
    const data = result.data as MessageListResult;

    expect(data.unreadCountUserWide).toBe(7);
    expect(data.unreadInThisView).toBe(0);
    expect((data as unknown as { unreadCount?: number }).unreadCount).toBeUndefined();

    const text = formatMessageForLLM('list', result);
    expect(text).not.toContain('0 total, 7 unread');
    expect(text).toContain('0 unread in this view');
    expect(text).toContain('7 unread user-wide');
  });

  it('counts unreadInThisView from the rows actually returned', async () => {
    const client = mockClient('user-scoped');
    client.listMessages.mockResolvedValue(
      createSuccess({
        messages: [
          { id: 'a', type: 'question', status: 'pending', summary: 's', createdAt: 'x' },
          { id: 'b', type: 'question', status: 'accepted', summary: 's', createdAt: 'x' },
          { id: 'c', type: 'question', status: 'pending', summary: 's', createdAt: 'x' },
        ],
        unreadCount: 7,
        totalCount: 3,
      })
    );

    const result = await rbookMessage({ action: 'list', tab: 'inbox' });
    expect((result.data as MessageListResult).unreadInThisView).toBe(2);
  });

  it.each([
    ['user-scoped', true],
    ['legacy-env', true],
    ['password-fallback', true],
    // s87-m07 (#530): `'none'` is gone from KeySource — no producer emitted it. `null` is the
    // shape a caller with no resolved keySource actually presents.
    [null, true],
    ['project-scoped', false],
  ] as Array<[KeySource, boolean]>)(
    'inbox scope warning with a %s credential fires: %s',
    async (keySource, shouldFire) => {
      const client = mockClient(keySource);
      client.listMessages.mockResolvedValue(createSuccess(CONTRADICTION_BODY));

      const result = await rbookMessage({ action: 'list', tab: 'inbox', status: 'pending' });
      const warnings = (result.data as MessageListResult).warnings ?? [];
      const scoped = warnings.filter((w) => w.includes('unreadCountUserWide'));

      expect(scoped).toHaveLength(shouldFire ? 1 : 0);
    }
  );

  it('renders the sent-tab warning and the scope warning as two distinct lines, once each', async () => {
    const client = mockClient('user-scoped');
    client.listMessages.mockResolvedValue(
      createSuccess({ messages: [], unreadCount: 7, totalCount: 0 })
    );

    const result = await rbookMessage({ action: 'list', tab: 'sent' });
    const data = result.data as MessageListResult;

    expect(data.warnings).toHaveLength(2);
    // The list action keeps its published DATA-level channel and puts NOTHING in the envelope,
    // so nothing can render twice (the channel rule, s86-m07).
    expect(result.warnings).toBeUndefined();

    const text = formatMessageForLLM('list', result);
    for (const w of data.warnings!) {
      expect(text.split(w).length - 1).toBe(1);
    }
  });
});
