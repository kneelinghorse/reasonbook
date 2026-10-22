// SPDX-License-Identifier: Apache-2.0
// ABOUTME: HTTP 409 on a message response is an actionable conflict rather than a generic dashboard failure.
// ABOUTME: Mocked transport preserves real client mapping and checks that other routes/statuses retain their contracts.
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import {
  formatMessageForLLM,
  rbookMessageToolDefinition,
} from '../../../src/tools/rbook/rbook-message';

const messageId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const params = { messageId, status: 'accepted' as const };
const client = () =>
  new DashboardClient({ baseUrl: 'http://localhost:3100', apiKey: 'cmk_fixture' });
afterEach(() => {
  jest.restoreAllMocks();
});

describe('message response conflict mapping', () => {
  it('explains the single-response limit before an agent responds', () => {
    expect(rbookMessageToolDefinition.description).toContain('Each message accepts one response');
  });

  it.each([
    JSON.stringify({ error: 'Message already has a response', hint: 'Old dashboard hint' }),
    'Message already has a response',
    '',
  ])('gives HTTP 409 a dedicated code and a read-current-message remedy (%s)', async (body) => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(body, { status: 409 }));
    const result = await client().respondToMessage(params);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('MESSAGE_RESPONSE_CONFLICT');
    expect(result.error?.suggestion).toContain(
      `rbook_message(action="get", messageId="${messageId}")`
    );
    expect(result.error?.suggestion).not.toContain('dashboard logs');
    expect(formatMessageForLLM('respond', result as never)).toContain(result.error!.suggestion);
  });

  it.each([
    ['ack', 409, 'DASHBOARD_ERROR'],
    ['respond', 403, 'DASHBOARD_FORBIDDEN'],
    ['respond', 404, 'DASHBOARD_NOT_FOUND'],
    ['respond', 500, 'DASHBOARD_ERROR'],
  ] as const)('keeps %s HTTP %s mapped to %s', async (action, status, code) => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response('{}', { status }));
    const instance = client();
    const result =
      action === 'ack'
        ? await instance.ackMessage({ messageId })
        : await instance.respondToMessage(params);
    expect(result.error?.code).toBe(code);
  });
});
