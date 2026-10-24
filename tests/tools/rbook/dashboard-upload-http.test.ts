// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercises upload authentication failures against a real loopback HTTP endpoint.
// ABOUTME: Preserved keys and response evidence distinguish outages from permanent upload holds.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';

describe('dashboard upload HTTP evidence', () => {
  let server: http.Server;
  let tempDir: string;
  let baseUrl: string;
  let answer: { status: number; body: string; retryAfter?: string };
  let authorization: Array<string | undefined>;
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-http-'));
    fs.writeFileSync(path.join(tempDir, 'store.sqlite'), 'fixture');
    answer = { status: 200, body: JSON.stringify({ success: true, data: {} }) };
    authorization = [];
    server = http.createServer((req, res) => {
      authorization.push(req.headers.authorization);
      req.resume();
      req.on('end', () => {
        res.writeHead(answer.status, {
          'content-type': 'application/json',
          ...(answer.retryAfter ? { 'retry-after': answer.retryAfter } : {}),
        });
        res.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  const invoke = (client: DashboardClient, operation: string, file: string) =>
    operation === 'register'
      ? client.registerProject({ projectName: 'Record', sqlitePath: file })
      : client.syncSqliteFile(file, 'record');

  it.each(['register', 'sync'])('%s retains the API key through a transient 401', async (op) => {
    const client = new DashboardClient({ baseUrl, apiKey: 'cmk_original' });
    answer = { status: 401, body: 'unauthorized' };
    const failed = await invoke(client, op, path.join(tempDir, 'store.sqlite'));
    expect(failed.error?.currentState).toMatchObject({ httpStatus: 401 });
    answer = { status: 200, body: '{}' };
    await invoke(client, op, path.join(tempDir, 'store.sqlite'));
    expect(authorization).toEqual(['Bearer cmk_original', 'Bearer cmk_original']);
  });

  it('retains the API key from a failed owner GET through the same-client SQLite upload', async () => {
    const client = new DashboardClient({ baseUrl, apiKey: 'cmk_original' });
    answer = {
      status: 401,
      body: JSON.stringify({ success: false, error: 'Temporarily unavailable' }),
    };
    expect((await client.getMyProjects()).error?.code).toBe('DASHBOARD_AUTH_FAILED');
    answer = {
      status: 200,
      body: JSON.stringify({ data: { success: true, counts: {}, errors: [], durationMs: 1 } }),
    };
    expect(
      (await client.syncSqliteFile(path.join(tempDir, 'store.sqlite'), 'record')).success
    ).toBe(true);
    expect(authorization).toEqual(['Bearer cmk_original', 'Bearer cmk_original']);
  });

  it.each(['register', 'sync'])(
    '%s distinguishes a dashboard 403 from an intermediary',
    async (op) => {
      const client = new DashboardClient({ baseUrl, apiKey: 'cmk_original' });
      answer = { status: 403, body: JSON.stringify({ success: false, error: 'Wrong project' }) };
      const forbidden = await invoke(client, op, path.join(tempDir, 'store.sqlite'));
      expect(forbidden.error?.code).toBe('DASHBOARD_FORBIDDEN');
      expect(forbidden.error?.currentState).toMatchObject({
        httpStatus: 403,
        dashboardEnvelope: true,
      });
      answer = { status: 403, body: '<html>Unavailable</html>' };
      const transient = await invoke(client, op, path.join(tempDir, 'store.sqlite'));
      expect(transient.error?.code).toBe('DASHBOARD_ERROR');
      expect(transient.error?.currentState).toMatchObject({
        httpStatus: 403,
        dashboardEnvelope: false,
      });
      expect(authorization).toEqual(['Bearer cmk_original', 'Bearer cmk_original']);
    }
  );

  it.each([410, 503, 429])('preserves HTTP %i and Retry-After evidence', async (status) => {
    const client = new DashboardClient({ baseUrl, apiKey: 'cmk_original' });
    answer = {
      status,
      body: JSON.stringify({ success: false, error: 'Unavailable', code: 'PROJECT_DELETED' }),
      retryAfter: '120',
    };
    const result = await client.syncSqliteFile(path.join(tempDir, 'store.sqlite'), 'record');
    expect(result.error?.currentState).toMatchObject({ httpStatus: status, retryAfterMs: 120_000 });
    expect(result.error?.code).toBe(status === 410 ? 'PROJECT_DELETED' : 'DASHBOARD_ERROR');
  });

  it.each([undefined, 'PROJECT_DELETED'])(
    'a message-route 410 with code %s retains its message failure contract',
    async (code) => {
      const client = new DashboardClient({ baseUrl, apiKey: 'cmk_original' });
      answer = {
        status: 410,
        body: JSON.stringify({
          success: false,
          error: 'The message is no longer available.',
          code,
        }),
      };
      const message = await client.sendMessage({
        targetAddress: 'rbook://recipient/project',
        type: 'notification',
        summary: 'Gone message',
      });
      expect(message.error?.code).toBe('DASHBOARD_ERROR');
      expect(message.error?.currentState).toMatchObject({ httpStatus: 410 });
      answer = {
        status: 200,
        body: JSON.stringify({ data: { success: true, counts: {}, errors: [], durationMs: 1 } }),
      };
      expect(
        (await client.syncSqliteFile(path.join(tempDir, 'store.sqlite'), 'record')).success
      ).toBe(true);
      expect(authorization).toEqual(['Bearer cmk_original', 'Bearer cmk_original']);
    }
  );

  it('the owner listing requires dashboard evidence before an HTTP 403 pauses uploads', async () => {
    const client = new DashboardClient({ baseUrl, apiKey: 'cmk_original' });
    answer = { status: 403, body: '<html>Unavailable</html>' };
    expect((await client.getMyProjects()).error?.code).toBe('DASHBOARD_ERROR');
    answer.body = JSON.stringify({ error: 'Wrong project' });
    expect((await client.getMyProjects()).error?.code).toBe('DASHBOARD_FORBIDDEN');
  });
});
