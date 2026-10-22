// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Every projects/me reader bounds untrusted response bytes and keeps credentials off redirects.
// ABOUTME: A response deadline covers the streamed body, including error responses, rather than headers alone.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import http from 'http';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';

let server: http.Server;
let origin: string;
let answer: (request: http.IncomingMessage, response: http.ServerResponse) => void;
let timer: ReturnType<typeof setTimeout> | undefined;
beforeEach(async () => {
  server = http.createServer((request, response) => answer(request, response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  if (timer) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const readers = [
  'getMyProjects',
  'dashboardSharing',
  'refereeProtocol',
  'refereeRequestLimit',
] as const;
const read = (method: (typeof readers)[number], timeoutMs = 2000) => {
  const client = new DashboardClient({ baseUrl: origin, apiKey: 'owned-test-key', timeoutMs });
  return method === 'getMyProjects' ? client.getMyProjects() : client[method]('p');
};

it.each(readers)(
  '%s refuses a redirect instead of forwarding credentials or accepting its body',
  async (method) => {
    const paths: string[] = [];
    answer = (request, response) => {
      paths.push(request.url ?? '');
      if (request.url === '/api/projects/me') {
        response.writeHead(302, { Location: '/different-projects' });
        response.end('moved');
      } else response.end(JSON.stringify({ projects: [] }));
    };
    expect((await read(method)).success).toBe(false);
    expect(paths).toEqual(['/api/projects/me']);
  }
);

it.each(readers)('%s refuses an oversized successful project list', async (method) => {
  answer = (_request, response) =>
    response.end(JSON.stringify({ projects: [], padding: 'x'.repeat(4 * 1024 * 1024) }));
  const result = await read(method);
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/4194304|4 MiB/);
});

it.each(readers)('%s bounds error bodies too', async (method) => {
  answer = (_request, response) => {
    response.writeHead(403);
    response.end(JSON.stringify({ error: 'x'.repeat(4 * 1024 * 1024), hint: 'retry' }));
  };
  const result = await read(method);
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/4194304|4 MiB/);
  expect(result.error!.message.length).toBeLessThan(1000);
});

it.each(readers)('%s times out a stalled body after successful headers', async (method) => {
  answer = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"projects":');
    timer = setTimeout(() => response.end('[]}'), 500);
  };
  const result = await read(method, 100);
  expect(result.success).toBe(false);
  expect(result.error?.message).toMatch(/timed out|aborted/i);
});

it.each(readers)('%s preserves the successful envelope after bounded reading', async (method) => {
  answer = (_request, response) =>
    response.end(
      JSON.stringify({
        success: true,
        data: {
          projects: [
            {
              id: 'p',
              dashboardShared: true,
              referee: { version: '4.5.0', protocol: { record: 1 }, requestLimit: 262144 },
            },
          ],
        },
      })
    );
  expect((await read(method)).success).toBe(true);
});
