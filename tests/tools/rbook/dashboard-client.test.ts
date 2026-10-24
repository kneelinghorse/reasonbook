// ABOUTME: Dashboard requests preserve the deployed wire contract across the public product rename.
// ABOUTME: Legacy response fixtures normalize to current public names without rewriting stored identities.
import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DashboardClient,
  RBOOK_DASHBOARD_URL_ENV,
  RBOOK_DASHBOARD_USER_ENV,
  RBOOK_DASHBOARD_PASSWORD_ENV,
  RBOOK_DASHBOARD_API_KEY_ENV,
} from '../../../src/tools/rbook/dashboard-client';
import type { DashboardClientConfig } from '../../../src/tools/rbook/dashboard-client';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { ADDRESS_SCHEME } from '../../../src/intelligence/product-names';

// ─── Test Helpers ────────────────────────────────────────────────────────────

const TEST_CONFIG: DashboardClientConfig = {
  baseUrl: 'http://localhost:3100',
  email: 'test@example.com',
  password: 'test-password',
  timeoutMs: 5000,
};

const LOGIN_RESPONSE = {
  success: true,
  data: {
    token: 'jwt-token-from-dashboard',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), // 1 hour from now
    user: {
      id: 'user-001',
      email: 'test@example.com',
      projects: [],
    },
  },
};

function createClient(overrides?: Partial<DashboardClientConfig>): DashboardClient {
  return new DashboardClient({ ...TEST_CONFIG, ...overrides });
}

/**
 * Mock fetch globally for each test.
 */
let mockFetch: jest.MockedFunction<typeof global.fetch>;

beforeEach(() => {
  mockFetch = jest.fn() as jest.MockedFunction<typeof global.fetch>;
  global.fetch = mockFetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * Helper: mock a successful login followed by a successful API response.
 */
function mockLoginThenResponse(responseData: unknown, status = 200): void {
  // First call: login
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(LOGIN_RESPONSE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  );
  // Second call: API request
  mockFetch.mockResolvedValueOnce(
    new Response(JSON.stringify(responseData), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  );
}

/**
 * Helper: mock a successful login followed by an error API response.
 */
function mockLoginThenError(status: number, body = ''): void {
  mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_RESPONSE), { status: 200 }));
  mockFetch.mockResolvedValueOnce(new Response(body, { status }));
}

// ─── Authentication Tests ─────────────────────────────────────────────────────

describe('Authentication', () => {
  it('authenticates via POST /api/auth/login before first request', async () => {
    mockLoginThenResponse({ messages: [], unreadCount: 0, totalCount: 0 });

    const client = createClient();
    await client.listMessages();

    // First call should be login
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [loginUrl, loginOptions] = mockFetch.mock.calls[0];
    expect(loginUrl).toBe('http://localhost:3100/api/auth/login');
    expect(loginOptions?.method).toBe('POST');

    const loginBody = JSON.parse(loginOptions?.body as string);
    expect(loginBody.email).toBe('test@example.com');
    expect(loginBody.password).toBe('test-password');
  });

  it('uses cached token for subsequent requests', async () => {
    // Login + first request
    mockLoginThenResponse({ messages: [], unreadCount: 0, totalCount: 0 });
    // Second request (no login needed)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), { status: 200 })
    );

    const client = createClient();
    await client.listMessages();
    await client.listMessages();

    // Should be: login, request1, request2 (no second login)
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3100/api/auth/login');
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:3100/api/messages');
    expect(mockFetch.mock.calls[2][0]).toBe('http://localhost:3100/api/messages');
  });

  it('re-authenticates when token is expired', async () => {
    const expiredLoginResponse = {
      ...LOGIN_RESPONSE,
      data: {
        ...LOGIN_RESPONSE.data,
        expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
      },
    };

    // First login (returns expired token)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(expiredLoginResponse), { status: 200 })
    );
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), { status: 200 })
    );
    // Second call: needs re-auth
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_RESPONSE), { status: 200 }));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), { status: 200 })
    );

    const client = createClient();
    await client.listMessages();
    await client.listMessages();

    // Should have 2 logins + 2 requests = 4 calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3100/api/auth/login');
    expect(mockFetch.mock.calls[2][0]).toBe('http://localhost:3100/api/auth/login');
  });

  it('uses Bearer token from login response on API calls', async () => {
    mockLoginThenResponse({ messages: [], unreadCount: 0, totalCount: 0 });

    const client = createClient();
    await client.listMessages();

    const [, apiOptions] = mockFetch.mock.calls[1];
    const authHeader = (apiOptions?.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toBe('Bearer jwt-token-from-dashboard');
  });

  it('returns auth error on bad credentials', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const client = createClient();
    const result = await client.listMessages();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_AUTH_FAILED');
  });

  it('returns unreachable error when login times out', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    const client = createClient({ timeoutMs: 100 });
    const result = await client.listMessages();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_UNREACHABLE');
    expect(result.error?.message).toContain('timed out');
  });
});

// ─── DashboardClient.fromEnv Tests ───────────────────────────────────────────

describe('DashboardClient.fromEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates client from environment variables', () => {
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'http://localhost:3100';
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'user@test.com';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'password123';

    const result = DashboardClient.fromEnv();
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(DashboardClient);
  });

  // Sprint 62 m02: RBOOK_DASHBOARD_URL has a baked default (https://reasonbook.ai)
  // so the unset-env path no longer fails — it transparently falls back. The
  // dashboardNotConfigured error is now reserved for missing credentials, and
  // its message still surfaces the sign-up pointer (verified separately below).
  it('falls back to baked default URL when RBOOK_DASHBOARD_URL is unset', () => {
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'user@test.com';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'password123';
    delete process.env[RBOOK_DASHBOARD_URL_ENV];

    const result = DashboardClient.fromEnv();
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(DashboardClient);
  });

  it('falls back to baked default URL when RBOOK_DASHBOARD_URL is empty string', () => {
    // IDE spawns sometimes inject empty-string env keys (see memory:
    // feedback_env_loader_empty_string_trap). Empty string must be treated
    // as unset, not as a literal URL.
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'user@test.com';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'password123';
    process.env[RBOOK_DASHBOARD_URL_ENV] = '';

    const result = DashboardClient.fromEnv();
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(DashboardClient);
  });

  it('returns error when email is missing', () => {
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'http://localhost:3100';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'password123';
    delete process.env[RBOOK_DASHBOARD_USER_ENV];

    const result = DashboardClient.fromEnv();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  it('returns error when password is missing', () => {
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'http://localhost:3100';
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'user@test.com';
    delete process.env[RBOOK_DASHBOARD_PASSWORD_ENV];

    const result = DashboardClient.fromEnv();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });

  it('accepts overrides over env vars', () => {
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'http://from-env:3100';
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'env@test.com';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'from-env';

    const result = DashboardClient.fromEnv({
      baseUrl: 'http://override:4000',
      email: 'override@test.com',
      password: 'override-password',
    });
    expect(result.success).toBe(true);
  });

  it('creates client from API key env var (no email/password needed)', () => {
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'http://localhost:3100';
    process.env[RBOOK_DASHBOARD_API_KEY_ENV] = 'cmk_test-api-key-123';
    delete process.env[RBOOK_DASHBOARD_USER_ENV];
    delete process.env[RBOOK_DASHBOARD_PASSWORD_ENV];

    const result = DashboardClient.fromEnv();
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(DashboardClient);
  });

  it('prefers API key over email/password when both are set', () => {
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'http://localhost:3100';
    process.env[RBOOK_DASHBOARD_API_KEY_ENV] = 'cmk_test-api-key-123';
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'user@test.com';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'password123';

    const result = DashboardClient.fromEnv();
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(DashboardClient);
  });

  it('falls back to email/password when no API key is set', () => {
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'http://localhost:3100';
    delete process.env[RBOOK_DASHBOARD_API_KEY_ENV];
    process.env[RBOOK_DASHBOARD_USER_ENV] = 'user@test.com';
    process.env[RBOOK_DASHBOARD_PASSWORD_ENV] = 'password123';

    const result = DashboardClient.fromEnv();
    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(DashboardClient);
  });

  it('returns error when only URL is set (no API key, no email/password)', () => {
    process.env[RBOOK_DASHBOARD_URL_ENV] = 'http://localhost:3100';
    delete process.env[RBOOK_DASHBOARD_API_KEY_ENV];
    delete process.env[RBOOK_DASHBOARD_USER_ENV];
    delete process.env[RBOOK_DASHBOARD_PASSWORD_ENV];

    const result = DashboardClient.fromEnv();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_CONFIGURED');
  });
});

// ─── API Key Authentication Tests ────────────────────────────────────────────

describe('API Key Authentication', () => {
  it('uses API key as Bearer token without login call', async () => {
    // API response (no login needed)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-api-key-123',
    });
    const result = await client.listMessages();

    expect(result.success).toBe(true);
    // Only 1 call — no login call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3100/api/messages');
    const authHeader = (options?.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toBe('Bearer cmk_test-api-key-123');
  });

  it('never re-authenticates with API key (no expiry)', async () => {
    // Two API responses, no login
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), { status: 200 })
    );
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), { status: 200 })
    );

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-api-key-123',
    });
    await client.listMessages();
    await client.listMessages();

    // 2 API calls, 0 login calls
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3100/api/messages');
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:3100/api/messages');
  });

  it('handles 401 response with API key', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_bad-key',
    });
    const result = await client.listMessages();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_AUTH_FAILED');
  });
});

// ─── sendMessage Tests ───────────────────────────────────────────────────────

describe('DashboardClient.sendMessage', () => {
  it.each([LEGACY.addressScheme, 'rbook://'])(
    'emits the current public sender scheme from a %s send receipt',
    async (scheme) => {
      mockLoginThenResponse({ senderAddress: `${scheme}Owner/source`, messageId: 'message' });
      const client = createClient();
      const result = await client.sendMessage({
        targetAddress: 'rbook://Owner/target',
        senderAddress: 'rbook://Owner/source',
        type: 'info_push',
        summary: 'Receipt normalization preserves the selected identity.',
      });
      expect(result.data).toEqual({
        senderAddress: `${ADDRESS_SCHEME}Owner/source`,
        messageId: 'message',
      });
    }
  );
  it('converts new address schemes at the wire boundary without rewriting message prose', async () => {
    mockLoginThenResponse({
      senderAddress: `${LEGACY.addressScheme}operator/source`,
      messageId: 'message',
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createClient();
    await client.sendMessage({
      targetAddress: 'rbook://operator/target',
      senderAddress: 'rbook://operator/source',
      type: 'info_push',
      summary: 'rbook://operator/target is quoted prose',
    });
    const wire = JSON.parse(mockFetch.mock.calls[1][1]?.body as string);
    expect(wire.targetAddress).toBe(`${LEGACY.addressScheme}operator/target`);
    expect(wire.senderAddress).toBe(`${LEGACY.addressScheme}operator/source`);
    expect(wire.summary).toBe('rbook://operator/target is quoted prose');
    expect(warn).not.toHaveBeenCalled();
  });
  it('sends POST to /api/messages with correct body', async () => {
    const responseData = {
      id: 'msg-001',
      type: 'request',
      summary: 'Need help',
      status: 'pending',
      createdAt: '2026-03-09T00:00:00Z',
    };

    mockLoginThenResponse(responseData);

    const client = createClient();
    const result = await client.sendMessage({
      targetAddress: 'rbook://dashboard/user/admin',
      type: 'request',
      summary: 'Need help',
      body: 'Detailed description',
    });

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe('msg-001');

    // Verify API call (second fetch call, after login)
    const [url, options] = mockFetch.mock.calls[1];
    expect(url).toBe('http://localhost:3100/api/messages');
    expect(options?.method).toBe('POST');

    const parsedBody = JSON.parse(options?.body as string);
    expect(parsedBody.targetAddress).toBe(`${LEGACY.addressScheme}dashboard/user/admin`);
    expect(parsedBody.type).toBe('request');
    expect(parsedBody.summary).toBe('Need help');
    expect(parsedBody.body).toBe('Detailed description');
  });

  it('includes evidence array when provided', async () => {
    mockLoginThenResponse({ id: 'msg-003' });

    const evidence = [
      { type: 'collection', id: 'col-001' },
      { type: 'report', id: 'rep-001' },
    ];

    const client = createClient();
    await client.sendMessage({
      targetAddress: 'rbook://test',
      type: 'decision',
      summary: 'Test',
      evidence,
    });

    const [, options] = mockFetch.mock.calls[1];
    const parsedBody = JSON.parse(options?.body as string);
    expect(parsedBody.evidence).toEqual(evidence);
  });

  it('warns when dashboard echoes a different senderAddress than the one sent', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockLoginThenResponse({
      id: 'msg-004',
      type: 'request',
      summary: 'Need help',
      status: 'pending',
      createdAt: '2026-03-09T00:00:00Z',
      senderAddress: `${LEGACY.addressScheme}derek/${LEGACY.command}`,
    });

    const client = createClient();
    const result = await client.sendMessage({
      targetAddress: 'rbook://dashboard/user/admin',
      type: 'request',
      summary: 'Need help',
      senderAddress: 'rbook://derek/stage1',
    });

    expect(result.success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('senderAddress echo mismatch'));

    warnSpy.mockRestore();
  });
});

describe.each(['list', 'get', 'respond'] as const)('public %s message addresses', (operation) => {
  it.each([LEGACY.addressScheme, 'rbook://'])(
    'normalizes typed %s addresses while preserving message content and unrelated fields',
    async (scheme) => {
      const prose = `${LEGACY.addressScheme}Owner/source and rbook://Owner/target are quoted text`;
      const message = {
        id: 'message',
        type: 'request',
        summary: prose,
        body: prose,
        payload: { body: prose, source: `${LEGACY.addressScheme}Owner/source` },
        evidence: [{ type: LEGACY.evidenceType, id: `${LEGACY.addressScheme}Owner/source` }],
        from: `${scheme}Owner/source`,
        to: `${scheme}Owner/target`,
        senderAddress: `${scheme}Owner/source`,
        senderProject: 'unchanged-project-slug',
        from_project_id: 'unchanged-project-id',
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      mockLoginThenResponse(
        operation === 'list'
          ? { messages: [message], unreadCount: 1, totalCount: 1, returnedCount: 1 }
          : message
      );
      const client = createClient();
      const expected = {
        ...message,
        from: `${ADDRESS_SCHEME}Owner/source`,
        to: `${ADDRESS_SCHEME}Owner/target`,
        senderAddress: `${ADDRESS_SCHEME}Owner/source`,
      };
      if (operation === 'list') {
        const result = await client.listMessages();
        expect(result.data).toEqual({
          messages: [expected],
          unreadCount: 1,
          totalCount: 1,
          returnedCount: 1,
        });
      } else {
        const result =
          operation === 'get'
            ? await client.getMessageById('message')
            : await client.respondToMessage({ messageId: 'message', status: 'accepted' });
        expect(result.data).toEqual(expected);
      }
    }
  );
});

// ─── listMessages Tests ──────────────────────────────────────────────────────

describe('DashboardClient.listMessages', () => {
  it('sends GET to /api/messages without query params by default', async () => {
    const responseData = {
      messages: [],
      unreadCount: 0,
      totalCount: 0,
    };

    mockLoginThenResponse(responseData);

    const client = createClient();
    const result = await client.listMessages();

    expect(result.success).toBe(true);
    expect(result.data?.messages).toEqual([]);
    expect(result.data?.unreadCount).toBe(0);

    const [url, options] = mockFetch.mock.calls[1];
    expect(url).toBe('http://localhost:3100/api/messages');
    expect(options?.method).toBe('GET');
  });

  it('includes query params for tab, status, limit', async () => {
    mockLoginThenResponse({ messages: [], unreadCount: 0, totalCount: 0 });

    const client = createClient();
    await client.listMessages({ tab: 'inbox', status: 'pending', limit: 10 });

    const [url] = mockFetch.mock.calls[1];
    expect(url).toContain('tab=inbox');
    expect(url).toContain('status=pending');
    expect(url).toContain('limit=10');
  });

  it('handles sent tab', async () => {
    mockLoginThenResponse({ messages: [], unreadCount: 0, totalCount: 5 });

    const client = createClient();
    const result = await client.listMessages({ tab: 'sent' });

    expect(result.success).toBe(true);
    const [url] = mockFetch.mock.calls[1];
    expect(url).toContain('tab=sent');
  });

  // s84-m02: SQL-side pagination (dashboard m05).
  it('sends offset when provided and echoes returnedCount', async () => {
    mockLoginThenResponse({ messages: [], unreadCount: 0, totalCount: 42, returnedCount: 0 });

    const client = createClient();
    const result = await client.listMessages({ tab: 'inbox', limit: 10, offset: 20 });

    const [url] = mockFetch.mock.calls[1];
    expect(url).toContain('offset=20');
    expect(result.data?.totalCount).toBe(42);
    expect(result.data?.returnedCount).toBe(0);
  });

  it('omits offset from the query when not provided (reproduces 2.3.0 call args)', async () => {
    mockLoginThenResponse({ messages: [], unreadCount: 0, totalCount: 0 });

    const client = createClient();
    await client.listMessages({ tab: 'inbox', limit: 10 });

    const [url] = mockFetch.mock.calls[1];
    expect(url).not.toContain('offset');
  });
});

// ─── getMessageById Tests (s84-m02) ──────────────────────────────────────────

describe('DashboardClient.getMessageById', () => {
  it('sends GET to /api/messages/:id and returns the single row', async () => {
    const msgId = '11111111-2222-3333-4444-555555555555';
    mockLoginThenResponse({ id: msgId, type: 'question', summary: 'q', status: 'pending' });

    const client = createClient();
    const result = await client.getMessageById(msgId);

    expect(result.success).toBe(true);
    expect(result.data?.id).toBe(msgId);
    const [url, options] = mockFetch.mock.calls[1];
    expect(url).toBe(`http://localhost:3100/api/messages/${msgId}`);
    expect(options?.method).toBe('GET');
  });

  it('maps a 404 (route absent or genuine miss) to DASHBOARD_NOT_FOUND', async () => {
    mockLoginThenError(404, JSON.stringify({ error: 'not found' }));

    const client = createClient();
    const result = await client.getMessageById('11111111-2222-3333-4444-555555555555');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_FOUND');
  });
});

// ─── respondToMessage Tests ──────────────────────────────────────────────────

describe('DashboardClient.respondToMessage', () => {
  it('sends POST to /api/messages/:id/respond', async () => {
    const responseData = {
      id: 'msg-001',
      type: 'request',
      summary: 'Need help',
      status: 'accepted',
      createdAt: '2026-03-09T00:00:00Z',
    };

    mockLoginThenResponse(responseData);

    const client = createClient();
    const result = await client.respondToMessage({
      messageId: 'msg-001',
      status: 'accepted',
      notes: 'Will do',
    });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('accepted');

    const [url, options] = mockFetch.mock.calls[1];
    expect(url).toBe('http://localhost:3100/api/messages/msg-001/respond');
    expect(options?.method).toBe('POST');

    const parsedBody = JSON.parse(options?.body as string);
    expect(parsedBody.status).toBe('accepted');
    expect(parsedBody.notes).toBe('Will do');
  });

  it('supports declined status', async () => {
    mockLoginThenResponse({ id: 'msg-002', status: 'declined' });

    const client = createClient();
    const result = await client.respondToMessage({
      messageId: 'msg-002',
      status: 'declined',
    });

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('declined');
  });
});

// ─── resolveAddress Tests ────────────────────────────────────────────────────

describe('DashboardClient.resolveAddress', () => {
  it('sends GET to /api/addresses/resolve with encoded address', async () => {
    mockLoginThenResponse({ resolved: true, projectName: 'my-project', agentId: 'agent-1' });

    const client = createClient();
    const result = await client.resolveAddress({
      address: 'rbook://dashboard/project/my-project',
    });

    expect(result.success).toBe(true);
    expect(result.data?.resolved).toBe(true);

    const [url] = mockFetch.mock.calls[1];
    expect(url).toContain('/api/messages/resolve?address=');
    expect(url).toContain(
      encodeURIComponent(`${LEGACY.addressScheme}dashboard/project/my-project`)
    );
  });
});

// ─── listDirectory Tests ─────────────────────────────────────────────────────

describe('DashboardClient.listDirectory', () => {
  it('sends GET to /api/projects/directory/public', async () => {
    const responseData = {
      projects: [
        {
          id: 'p1',
          name: 'cmos-mcp',
          address: `${LEGACY.addressScheme}derek/${LEGACY.command}`,
          owner: 'derek',
        },
        {
          id: 'p2',
          name: 'dashboard',
          address: `${LEGACY.addressScheme}derek/cmos-dashboard`,
          owner: 'derek',
        },
      ],
      totalCount: 2,
    };

    mockLoginThenResponse(responseData);

    const client = createClient();
    const result = await client.listDirectory();

    expect(result.success).toBe(true);
    expect(result.data?.projects).toHaveLength(2);
    expect(result.data?.totalCount).toBe(2);

    const [url, options] = mockFetch.mock.calls[1];
    expect(url).toBe('http://localhost:3100/api/projects/directory/public');
    expect(options?.method).toBe('GET');
  });

  it('normalizes dashboard project rows that return the legacy address field and a slug', async () => {
    mockLoginThenResponse({
      projects: [
        {
          id: 'p1',
          name: 'stage1',
          slug: 'stage1',
          [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/stage1`,
          isOwner: true,
        },
      ],
      totalCount: 1,
    });

    const client = createClient();
    const result = await client.listDirectory();

    expect(result.success).toBe(true);
    expect(result.data?.projects[0]).toMatchObject({
      id: 'p1',
      name: 'stage1',
      address: `${ADDRESS_SCHEME}derek/stage1`,
      owner: 'derek',
    });
  });
});

// ─── getMyProjects Tests ────────────────────────────────────────────────────

describe('DashboardClient.getMyProjects', () => {
  it('sends GET to /api/projects/me', async () => {
    const responseData = {
      projects: [
        {
          id: 'p1',
          name: 'cmos-mcp',
          address: `${LEGACY.addressScheme}derek/${LEGACY.command}`,
          owner: 'derek',
        },
      ],
      totalCount: 1,
    };

    mockLoginThenResponse(responseData);

    const client = createClient();
    const result = await client.getMyProjects();

    expect(result.success).toBe(true);
    expect(result.data?.projects).toHaveLength(1);
    expect(result.data?.totalCount).toBe(1);

    const [url, options] = mockFetch.mock.calls[1];
    expect(url).toBe('http://localhost:3100/api/projects/me');
    expect(options?.method).toBe('GET');
  });

  it('normalizes modern API-key project rows so sender resolution still sees address + owner', async () => {
    mockLoginThenResponse({
      projects: [
        {
          id: 'p1',
          name: 'stage1',
          slug: 'stage1',
          [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/stage1`,
          isOwner: true,
        },
      ],
    });

    const client = createClient();
    const result = await client.getMyProjects();

    expect(result.success).toBe(true);
    expect(result.data?.totalCount).toBe(1);
    expect(result.data?.projects[0]).toMatchObject({
      id: 'p1',
      name: 'stage1',
      address: `${ADDRESS_SCHEME}derek/stage1`,
      owner: 'derek',
    });
  });
});

// ─── Error Handling Tests ────────────────────────────────────────────────────

describe('Error handling', () => {
  it('returns DASHBOARD_AUTH_FAILED for 401 response on API call', async () => {
    mockLoginThenError(401, 'Unauthorized');

    const client = createClient();
    const result = await client.sendMessage({
      targetAddress: 'rbook://test',
      type: 'info',
      summary: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_AUTH_FAILED');
  });

  // s84-m02: a 403 is now DASHBOARD_FORBIDDEN (authz denial), split out of the 401 arm.
  it('returns DASHBOARD_FORBIDDEN for 403 response (s84-m02 split)', async () => {
    mockLoginThenError(403, JSON.stringify({ error: 'You are not the recipient' }));

    const client = createClient();
    const result = await client.listMessages();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_FORBIDDEN');
    // Unified {error,hint} envelope surfaces in the message.
    expect(result.error?.message).toContain('You are not the recipient');
  });

  // s84-m02 SC4: a 403 must NOT clear the cached token — clearing poisoned apiKey auth
  // (an apiKey client has no re-login path, so the very next call sent `Bearer null`).
  it('403 does NOT clear the cached apiKey — a subsequent same-process call still authenticates', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), {
          status: 200,
        })
      );

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_live-key',
    });
    const first = await client.listMessages();
    expect(first.error?.code).toBe('DASHBOARD_FORBIDDEN');

    const second = await client.listMessages();
    expect(second.success).toBe(true);
    // The KEY assertion: the second call still carries the real apiKey, not `Bearer null`.
    const [, secondOpts] = mockFetch.mock.calls[1];
    expect((secondOpts?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer cmk_live-key'
    );
  });

  // An intermediary's 401 must not destroy the only credential an API-key client has.
  it('401 preserves an API key so a later attempt can recover', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }), {
          status: 200,
        })
      );

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_live-key',
    });
    const first = await client.listMessages();
    expect(first.error?.code).toBe('DASHBOARD_AUTH_FAILED');

    await client.listMessages();
    const [, secondOpts] = mockFetch.mock.calls[1];
    expect((secondOpts?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer cmk_live-key'
    );
  });

  it('returns DASHBOARD_NOT_FOUND for 404 response', async () => {
    mockLoginThenError(404, 'Not Found');

    const client = createClient();
    const result = await client.respondToMessage({
      messageId: 'nonexistent',
      status: 'accepted',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_FOUND');
  });

  // Sprint 62 m05: 402 (Payment Required) must route through the dedicated
  // upgrade-required factory, not the generic HTTP-status bucket — so users
  // hitting a paid-tier feature get a sign-up/upgrade pointer.
  it('returns DASHBOARD_UPGRADE_REQUIRED for 402 response with sign-up pointer', async () => {
    mockLoginThenError(402, 'Cross-user messaging requires a paid tier');

    const client = createClient();
    const result = await client.sendMessage({
      targetAddress: 'rbook://test',
      type: 'info',
      summary: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_UPGRADE_REQUIRED');
    expect(result.error?.message).toContain('https://reasonbook.ai');
    expect(result.error?.suggestion).toContain('https://reasonbook.ai');
    // Dashboard-supplied detail flows through to the user-facing message.
    expect(result.error?.message).toContain('Cross-user messaging requires a paid tier');
  });

  it('returns DASHBOARD_UPGRADE_REQUIRED for 402 response with empty body', async () => {
    mockLoginThenError(402, '');

    const client = createClient();
    const result = await client.listMessages();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_UPGRADE_REQUIRED');
    // Sign-up pointer is still present even when the dashboard sent no body.
    expect(result.error?.message).toContain('https://reasonbook.ai');
  });

  it('returns DASHBOARD_ERROR for 500 response', async () => {
    mockLoginThenError(500, 'Internal Server Error');

    const client = createClient();
    const result = await client.sendMessage({
      targetAddress: 'rbook://test',
      type: 'info',
      summary: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
    expect(result.error?.message).toContain('500');
  });

  it('returns DASHBOARD_ERROR for non-OK non-special status codes', async () => {
    mockLoginThenError(400, 'Bad Request');

    const client = createClient();
    const result = await client.sendMessage({
      targetAddress: 'rbook://test',
      type: 'info',
      summary: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
    expect(result.error?.message).toContain('400');
  });

  it('returns DASHBOARD_UNREACHABLE on network error', async () => {
    // Login succeeds
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_RESPONSE), { status: 200 }));
    // API call fails with network error
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client = createClient();
    const result = await client.sendMessage({
      targetAddress: 'rbook://test',
      type: 'info',
      summary: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_UNREACHABLE');
    expect(result.error?.message).toContain('ECONNREFUSED');
  });

  it('returns DASHBOARD_UNREACHABLE on timeout (AbortError)', async () => {
    // Login succeeds
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_RESPONSE), { status: 200 }));
    // API call times out
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    const client = createClient({ timeoutMs: 100 });
    const result = await client.listMessages();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_UNREACHABLE');
    expect(result.error?.message).toContain('timed out');
  });

  it('returns DASHBOARD_UNREACHABLE on unknown error type', async () => {
    // Login succeeds
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_RESPONSE), { status: 200 }));
    mockFetch.mockRejectedValueOnce('string error');

    const client = createClient();
    const result = await client.listMessages();

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_UNREACHABLE');
    expect(result.error?.message).toContain('Unknown network error');
  });

  it('clears cached token on 401 API response', async () => {
    // First: login + 401 on API
    mockLoginThenError(401);
    // If client retries, it would need to login again
    mockLoginThenResponse({ messages: [], unreadCount: 0, totalCount: 0 });

    const client = createClient();
    const result1 = await client.listMessages();
    expect(result1.success).toBe(false);

    // Second call should re-authenticate (token was cleared)
    const result2 = await client.listMessages();
    expect(result2.success).toBe(true);

    // Should have: login, 401-api, login, success-api = 4 calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

// ─── URL Normalization Tests ─────────────────────────────────────────────────

describe('URL normalization', () => {
  it('strips trailing slash from baseUrl', async () => {
    mockLoginThenResponse({ messages: [], unreadCount: 0, totalCount: 0 });

    const client = createClient({ baseUrl: 'http://localhost:3100/' });
    await client.listMessages();

    // Login URL should be normalized
    const [loginUrl] = mockFetch.mock.calls[0];
    expect(loginUrl).toBe('http://localhost:3100/api/auth/login');

    // API URL should be normalized
    const [apiUrl] = mockFetch.mock.calls[1];
    expect(apiUrl).toBe('http://localhost:3100/api/messages');
    expect(apiUrl).not.toContain('//api');
  });

  it('strips multiple trailing slashes', async () => {
    mockLoginThenResponse({ messages: [], unreadCount: 0, totalCount: 0 });

    const client = createClient({ baseUrl: 'http://localhost:3100///' });
    await client.listMessages();

    const [apiUrl] = mockFetch.mock.calls[1];
    expect(apiUrl).toBe('http://localhost:3100/api/messages');
  });
});

// ─── Sync Status Tests ──────────────────────────────────────────────────────

describe('getSyncStatus', () => {
  it('should call GET /api/sync/status and return typed result', async () => {
    const syncData = {
      tables: [
        { table: 'cmos_sprints', count: 10 },
        { table: 'cmos_missions', count: 25 },
      ],
      totalMirrorRows: 35,
      totalSyncLogEntries: 100,
      unprocessedSyncLogEntries: 0,
      failedSyncLogEntries: 2,
      lastSyncAt: '2026-03-10T05:00:00Z',
      oldestUnprocessedAt: null,
      projectCount: 1,
    };
    mockLoginThenResponse({ success: true, data: syncData });

    const client = createClient();
    const result = await client.getSyncStatus();

    expect(result.success).toBe(true);
    expect(result.data?.tables).toHaveLength(2);
    expect(result.data?.totalMirrorRows).toBe(35);
    expect(result.data?.failedSyncLogEntries).toBe(2);

    const [, apiUrl] = [mockFetch.mock.calls[0], mockFetch.mock.calls[1]];
    expect(apiUrl[0]).toBe('http://localhost:3100/api/sync/status');
  });

  it('should handle sync status server error', async () => {
    mockLoginThenError(500, 'Internal server error');

    const client = createClient();
    const result = await client.getSyncStatus();

    expect(result.success).toBe(false);
  });
});

// ─── Sync Project State Tests ───────────────────────────────────────────────

describe('getSyncProjectState', () => {
  it('should call GET /api/sync/projects/:slug/state', async () => {
    const stateData = {
      project: {
        id: 'proj-uuid',
        slug: 'cmos-mcp',
        name: 'Reasonbook',
        schemaVersion: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-03-10T05:00:00Z',
      },
      sprints: [{ id: 's1' }],
      missions: [],
      sessions: [],
      decisions: [],
      learnings: [],
      dependencies: [],
    };
    mockLoginThenResponse({ success: true, data: stateData });

    const client = createClient();
    const result = await client.getSyncProjectState('cmos-mcp');

    expect(result.success).toBe(true);
    expect(result.data?.project.slug).toBe('cmos-mcp');
    expect(result.data?.sprints).toHaveLength(1);

    const [, apiCall] = [mockFetch.mock.calls[0], mockFetch.mock.calls[1]];
    expect(apiCall[0]).toBe('http://localhost:3100/api/sync/projects/cmos-mcp/state');
  });

  it('should URL-encode slug parameter', async () => {
    mockLoginThenResponse({
      success: true,
      data: {
        project: {},
        sprints: [],
        missions: [],
        sessions: [],
        decisions: [],
        learnings: [],
        dependencies: [],
      },
    });

    const client = createClient();
    await client.getSyncProjectState('special project');

    const [, apiCall] = [mockFetch.mock.calls[0], mockFetch.mock.calls[1]];
    expect(apiCall[0]).toBe('http://localhost:3100/api/sync/projects/special%20project/state');
  });

  it('should handle 404 for unknown project', async () => {
    mockLoginThenError(404, JSON.stringify({ error: 'Project not found' }));

    const client = createClient();
    const result = await client.getSyncProjectState('nonexistent');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_NOT_FOUND');
  });
});

// ─── Purge Mirror Tests ─────────────────────────────────────────────────────

describe('purgeMirror', () => {
  it('should call POST /api/sync/purge with projectSlug', async () => {
    // s95-m08: the dashboard's own answer shape (cmos-dashboard src/routes/sync.ts).
    const purgeData = {
      projectSlug: 'cmos-mcp',
      rbookProjectId: 'c3f1a2e0-0000-4000-8000-000000000002',
      purged: { rbook_sprints: 5, rbook_missions: 20 },
    };
    mockLoginThenResponse({ success: true, data: purgeData });

    const client = createClient();
    const result = await client.purgeMirror('cmos-mcp');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      purgedProject: 'cmos-mcp',
      tablesCleared: ['rbook_sprints', 'rbook_missions'],
      rowsDeleted: 25,
    });

    const [, apiCall] = [mockFetch.mock.calls[0], mockFetch.mock.calls[1]];
    expect(apiCall[0]).toBe('http://localhost:3100/api/sync/purge');
    expect(apiCall[1]?.method).toBe('POST');
    const body = JSON.parse(apiCall[1]?.body as string);
    expect(body.projectSlug).toBe('cmos-mcp');
  });

  it('says the counts are unknown when an accepted purge names no tables', async () => {
    mockLoginThenResponse({ success: true, data: { projectSlug: 'cmos-mcp' } });

    const result = await createClient().purgeMirror('cmos-mcp');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ purgedProject: 'cmos-mcp', tablesCleared: [], rowsDeleted: 0 });
    expect(result.warnings?.join(' ')).toContain('how many rows it deleted is unknown');
  });

  it('should handle purge API errors', async () => {
    mockLoginThenError(500, JSON.stringify({ error: 'Purge failed' }));

    const client = createClient();
    const result = await client.purgeMirror('cmos-mcp');

    expect(result.success).toBe(false);
  });

  it('should refuse purge when expected slug does not match', async () => {
    const client = createClient();
    const result = await client.purgeMirror('cmos-mcp', 'stage1');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXPECTED_SLUG_MISMATCH');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── registerProject Tests ──────────────────────────────────────────────────

describe('registerProject', () => {
  // s95-m09: a per-test folder under os.tmpdir(), not a fixed /tmp path that concurrent runs share.
  let tmpDir: string;
  let tmpFilePath: string;

  beforeEach(() => {
    // Create a small temporary file to simulate a SQLite database
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-test-register-'));
    tmpFilePath = path.join(tmpDir, 'rbook.sqlite');
    fs.writeFileSync(tmpFilePath, 'fake-sqlite-data');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should POST multipart form to /api/projects/register-new with API key', async () => {
    const registerData = {
      slug: 'my-project',
      projectId: 'proj-uuid-123',
      reregistered: false,
      backfill: { counts: { sprints: 5, missions: 10 } },
    };

    // API key auth — no login call, just the register call
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: registerData }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.registerProject({
      projectName: 'My Project',
      sqlitePath: tmpFilePath,
    });

    expect(result.success).toBe(true);
    expect(result.data?.slug).toBe('my-project');
    expect(result.data?.projectId).toBe('proj-uuid-123');
    expect(result.data?.reregistered).toBe(false);

    // Verify the fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3100/api/projects/register-new');
    expect(options?.method).toBe('POST');

    // Verify auth header
    const authHeader = (options?.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toBe('Bearer cmk_test-key');

    // The upload contains the database alone, never local telemetry or another config file.
    expect(options?.body).toBeInstanceOf(FormData);
    const formData = options?.body as FormData;
    expect([...formData.keys()].sort()).toEqual(['database', 'projectName']);
    expect(await (formData.get('database') as Blob).text()).toBe('fake-sqlite-data');
  });

  it('refuses a re-registration response instead of adopting another record', async () => {
    const registerData = {
      slug: 'my-project',
      projectId: 'proj-uuid-123',
      reregistered: true,
      backfill: { counts: { sprints: 5 } },
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: registerData }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.registerProject({
      projectName: 'My Project',
      sqlitePath: tmpFilePath,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNSAFE_REGISTRATION_RESPONSE');
    expect(result.data).toBeUndefined();
  });

  it('should include localDbPath in form data when provided', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: { slug: 'p', projectId: 'id', reregistered: false, backfill: { counts: {} } },
        }),
        { status: 201 }
      )
    );

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    await client.registerProject({
      projectName: 'My Project',
      sqlitePath: tmpFilePath,
      localDbPath: '/home/user/project/rbook/db/rbook.sqlite',
    });

    const [, options] = mockFetch.mock.calls[0];
    const formData = options?.body as FormData;
    expect(formData.get('projectName')).toBe('My Project');
    expect(formData.get('localDbPath')).toBe('/home/user/project/rbook/db/rbook.sqlite');
  });

  it('should refuse registration when expected slug does not match the project name', async () => {
    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.registerProject({
      projectName: 'My Project',
      sqlitePath: tmpFilePath,
      expectedSlug: 'different-project',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXPECTED_SLUG_MISMATCH');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return error when SQLite file does not exist', async () => {
    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.registerProject({
      projectName: 'My Project',
      sqlitePath: '/nonexistent/path/rbook.sqlite',
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
    expect(result.error?.message).toContain('Failed to read SQLite file');
    // Should not have made any fetch calls
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return auth error on 401', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_bad-key',
    });

    const result = await client.registerProject({
      projectName: 'My Project',
      sqlitePath: tmpFilePath,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_AUTH_FAILED');
  });

  it('should return error on server error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.registerProject({
      projectName: 'My Project',
      sqlitePath: tmpFilePath,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
    expect(result.error?.message).toContain('500');
  });

  it('should return unreachable error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.registerProject({
      projectName: 'My Project',
      sqlitePath: tmpFilePath,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_UNREACHABLE');
  });

  it('should return unreachable error on timeout', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
      timeoutMs: 100,
    });

    const result = await client.registerProject({
      projectName: 'My Project',
      sqlitePath: tmpFilePath,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_UNREACHABLE');
    expect(result.error?.message).toContain('timed out');
  });

  it('should authenticate via JWT if no API key is set', async () => {
    // Login first, then register
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_RESPONSE), { status: 200 }));
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: { slug: 'p', projectId: 'id', reregistered: false, backfill: { counts: {} } },
        }),
        { status: 201 }
      )
    );

    const client = createClient();
    const result = await client.registerProject({
      projectName: 'My Project',
      sqlitePath: tmpFilePath,
    });

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3100/api/auth/login');
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:3100/api/projects/register-new');
  });
});

describe('syncSqliteFile', () => {
  // s95-m09: a per-test folder under os.tmpdir(), not a fixed /tmp path that concurrent runs share.
  let tmpDir: string;
  let tmpFilePath: string;

  beforeEach(() => {
    // Create a small temporary file to simulate a SQLite database
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-test-sync-'));
    tmpFilePath = path.join(tmpDir, 'rbook.sqlite');
    fs.writeFileSync(tmpFilePath, 'fake-sqlite-data');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should POST multipart form to /api/sync/sqlite-backfill with API key', async () => {
    const syncData = {
      success: true,
      counts: { sprints: 5, missions: 12, sessions: 8, decisions: 42, learnings: 7 },
      errors: [],
      durationMs: 340,
    };

    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: syncData }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.syncSqliteFile(tmpFilePath, 'my-project');

    expect(result.success).toBe(true);
    expect(result.data?.counts).toEqual(syncData.counts);
    expect(result.data?.errors).toEqual([]);
    expect(result.data?.durationMs).toBe(340);

    // Verify the fetch call
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:3100/api/sync/sqlite-backfill');
    expect(options?.method).toBe('POST');

    // Verify auth header
    const authHeader = (options?.headers as Record<string, string>)['Authorization'];
    expect(authHeader).toBe('Bearer cmk_test-key');

    // Verify body is FormData with projectSlug
    expect(options?.body).toBeInstanceOf(FormData);
    const formData = options?.body as FormData;
    expect(formData.get('projectSlug')).toBe('my-project');
    // Exact keys and exact file bytes reject an added telemetry part or a bundled archive.
    expect([...formData.keys()].sort()).toEqual(['database', 'projectSlug']);
    expect(await (formData.get('database') as Blob).text()).toBe('fake-sqlite-data');
  });

  it('should return error when SQLite file does not exist', async () => {
    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.syncSqliteFile('/nonexistent/path/rbook.sqlite', 'my-project');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
    expect(result.error?.message).toContain('Failed to read SQLite file');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return auth error on 401', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_bad-key',
    });

    const result = await client.syncSqliteFile(tmpFilePath, 'my-project');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_AUTH_FAILED');
  });

  it('should return error on server error', async () => {
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.syncSqliteFile(tmpFilePath, 'my-project');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
    expect(result.error?.message).toContain('500');
    expect(result.error?.message).toContain('SQLite backfill failed');
  });

  it('should return unreachable error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.syncSqliteFile(tmpFilePath, 'my-project');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_UNREACHABLE');
  });

  it('should return unreachable error on timeout', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
      timeoutMs: 100,
    });

    const result = await client.syncSqliteFile(tmpFilePath, 'my-project');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_UNREACHABLE');
    expect(result.error?.message).toContain('timed out');
  });

  it('should authenticate via JWT if no API key is set', async () => {
    const syncData = {
      success: true,
      counts: { sprints: 1 },
      errors: [],
      durationMs: 100,
    };

    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_RESPONSE), { status: 200 }));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: syncData }), { status: 200 })
    );

    const client = createClient();
    const result = await client.syncSqliteFile(tmpFilePath, 'my-project');

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:3100/api/auth/login');
    expect(mockFetch.mock.calls[1][0]).toBe('http://localhost:3100/api/sync/sqlite-backfill');
  });

  it('should refuse sqlite sync when expected slug does not match', async () => {
    const client = new DashboardClient({
      baseUrl: 'http://localhost:3100',
      apiKey: 'cmk_test-key',
    });

    const result = await client.syncSqliteFile(tmpFilePath, 'my-project', 'other-project');

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('EXPECTED_SLUG_MISMATCH');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─── Mutable-surface conflict methods (Sprint 71 m04) ─────────────────────────

describe('DashboardClient mutable-surface methods', () => {
  it('pushMutableEvent returns the top-level conflict (not under data)', async () => {
    // The /api/sync/events route returns {success, conflict?} at the top level — the
    // request() unwrapper passes the whole body through since there is no `data` key.
    mockLoginThenResponse({
      success: true,
      conflict: { id: 'c1', fieldScope: 'mission_active', youWereSuperseded: true },
    });
    const client = createClient();
    const result = await client.pushMutableEvent({ eventType: 'mission_updated', data: {} });
    expect(result.success).toBe(true);
    expect(result.data?.conflict?.id).toBe('c1');
    expect(result.data?.conflict?.youWereSuperseded).toBe(true);
  });

  it('getProjectConflicts unwraps {data:{conflicts}} and builds the query', async () => {
    mockLoginThenResponse({ success: true, data: { conflicts: [{ id: 'c2' }] } });
    const client = createClient();
    const result = await client.getProjectConflicts('platform-uuid', {
      unresolvedOnly: false,
      entityId: 'm1',
    });
    expect(result.success).toBe(true);
    expect(result.data?.conflicts[0].id).toBe('c2');
    const url = String(mockFetch.mock.calls[1][0]);
    expect(url).toContain('/api/projects/platform-uuid/conflicts');
    expect(url).toContain('unresolvedOnly=false');
    expect(url).toContain('entityId=m1');
  });

  it('restoreConflict POSTs to the restore endpoint and unwraps the conflict', async () => {
    mockLoginThenResponse({ success: true, data: { conflict: { id: 'c3', resolved: true } } });
    const client = createClient();
    const result = await client.restoreConflict('platform-uuid', 'c3');
    expect(result.success).toBe(true);
    expect(result.data?.conflict.resolved).toBe(true);
    expect(String(mockFetch.mock.calls[1][0])).toBe(
      'http://localhost:3100/api/projects/platform-uuid/conflicts/c3/restore'
    );
    expect(mockFetch.mock.calls[1][1]?.method).toBe('POST');
  });
});

// ─── Soft-lock methods (Sprint 71 m05) ────────────────────────────────────────

describe('DashboardClient soft-lock methods', () => {
  const LOCK = {
    fieldScope: 'mission_active',
    holderUserId: 'u-other',
    holderDisplayName: 'Other',
    holderEmail: 'other@x.com',
    acquiredAt: '2026-05-31T10:00:00Z',
    expiresAt: '2026-05-31T10:30:00Z',
    expired: false,
  };

  it('acquireLock returns ok:true on 200', async () => {
    mockLoginThenResponse({ success: true, data: { lock: { ...LOCK, holderUserId: 'me' } } });
    const result = await createClient().acquireLock('p1', 'mission_active');
    expect(result.success).toBe(true);
    expect(result.data?.ok).toBe(true);
  });

  it('acquireLock surfaces a 409 held with the holder + reason', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_RESPONSE), { status: 200 }));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, data: { lock: LOCK, reason: 'held' } }), {
        status: 409,
      })
    );
    const result = await createClient().acquireLock('p1', 'mission_active');
    expect(result.success).toBe(true);
    expect(result.data?.ok).toBe(false);
    if (result.data && !result.data.ok) {
      expect(result.data.reason).toBe('held');
      expect(result.data.lock?.holderEmail).toBe('other@x.com');
    }
    // The POST carried the fieldScope in the body.
    expect(JSON.parse(String(mockFetch.mock.calls[1][1]?.body))).toEqual({
      fieldScope: 'mission_active',
    });
  });

  it('acquireLock reports reason:expired so the caller can take over', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_RESPONSE), { status: 200 }));
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: false,
          data: { lock: { ...LOCK, expired: true }, reason: 'expired' },
        }),
        { status: 409 }
      )
    );
    const result = await createClient().acquireLock('p1', 'mission_active');
    expect(result.data?.ok).toBe(false);
    if (result.data && !result.data.ok) expect(result.data.reason).toBe('expired');
  });

  it('takeoverLock returns ok:true on 200 and ok:false on a 409 active lock', async () => {
    mockLoginThenResponse({ success: true, data: { lock: { ...LOCK, holderUserId: 'me' } } });
    const ok = await createClient().takeoverLock('p1', 'mission_active');
    expect(ok.data?.ok).toBe(true);
    expect(String(mockFetch.mock.calls[1][0])).toContain('/locks/mission_active/takeover');

    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(LOGIN_RESPONSE), { status: 200 }));
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, data: { lock: LOCK } }), { status: 409 })
    );
    const active = await createClient().takeoverLock('p1', 'mission_active');
    expect(active.data?.ok).toBe(false);
  });

  it('releaseLock unwraps {released} and queryLocks unwraps {locks}', async () => {
    mockLoginThenResponse({ success: true, data: { released: true } });
    const rel = await createClient().releaseLock('p1', 'mission_active');
    expect(rel.data?.released).toBe(true);
    expect(String(mockFetch.mock.calls[1][0])).toContain('/locks/mission_active/release');

    mockFetch.mockReset();
    mockLoginThenResponse({ success: true, data: { locks: [LOCK] } });
    const q = await createClient().queryLocks('p1');
    expect(q.data?.locks).toHaveLength(1);
    expect(q.data?.locks[0].fieldScope).toBe('mission_active');
  });
});
