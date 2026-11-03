// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m05 — the message directory calls a project the account's own only when its /api/projects/me
// ABOUTME: row says isOwner true; a shared project, or a row without the field, keeps the foreign descriptor.

import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { createSuccess } from '../../../src/tools/rbook/errors';
import type { MessageDirectoryResult } from '../../../src/tools/rbook/rbook-message';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';

const OWNED = '11111111-1111-4111-8111-111111111111';
const SHARED = '22222222-2222-4222-8222-222222222222';
const UNMARKED = '33333333-3333-4333-8333-333333333333';
const row = (id: string, slug: string, owner: string) => ({
  id,
  name: slug,
  slug,
  owner,
  address: `rbook://${owner}/${slug}`,
});
let server: Server;
let project: SeededRbookProject;

beforeEach(async () => {
  project = await createSeededRbookProject();
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/projects/directory/public') {
      const projects = [
        row(OWNED, 'mine', 'tester'),
        row(SHARED, 'theirs', 'another-owner'),
        row(UNMARKED, 'unmarked', 'another-owner'),
      ];
      res.end(JSON.stringify({ success: true, data: { projects, totalCount: projects.length } }));
      return;
    }
    if (url.pathname === '/api/projects/me') {
      // The account's own project, one shared with it, and one whose row leaves isOwner out.
      const projects = [
        { ...row(OWNED, 'mine', 'tester'), isOwner: true },
        { ...row(SHARED, 'theirs', 'another-owner'), isOwner: false },
        row(UNMARKED, 'unmarked', 'another-owner'),
      ];
      res.end(
        JSON.stringify({
          success: true,
          data: { user: { id: 'user-tester', username: 'tester' }, projects },
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'No such fixture route' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new DashboardClient({
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey: 'fixture-key',
  });
  jest
    .spyOn(DashboardClient, 'fromEnvForProject')
    .mockResolvedValue(
      createSuccess({ client, keySource: 'user-scoped', matchedProjectRoot: project.projectRoot })
    );
});

afterEach(async () => {
  jest.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await project.cleanup();
});

it('a project shared with the account, or one /api/projects/me marks neither way, is not called its own', async () => {
  const answer = await executeMissionProtocolTool(
    'rbook_message',
    { action: 'directory', projectRoot: project.projectRoot },
    await buildMissionProtocolContext()
  );
  const data = (answer.structuredContent as { data: MessageDirectoryResult }).data;
  const byId = new Map(data.projects.map((p) => [p.id, p]));
  expect(byId.get(OWNED)).toMatchObject({ isOwner: true, provenance: { trust: 'local' } });
  // Before s109-m05 every project /me listed read as owned and local, the shared one included.
  expect(byId.get(SHARED)).toMatchObject({ isOwner: false, provenance: { trust: 'foreign' } });
  // An absent isOwner reads as not owned: the fail-safe side.
  expect(byId.get(UNMARKED)).toMatchObject({ isOwner: false, provenance: { trust: 'foreign' } });
});
