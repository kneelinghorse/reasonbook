// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m02 (#938, design B) — the message directory takes each row's own boolean isOwner, archived rows
// ABOUTME: included; /api/projects/me only fills rows that lack one, and never overturns a directory false.

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
const ARCHIVED = '44444444-4444-4444-8444-444444444444';
const row = (id: string, slug: string, owner: string) => ({
  id,
  name: slug,
  slug,
  owner,
  address: `rbook://${owner}/${slug}`,
});
let server: Server;
let project: SeededRbookProject;
let directory: unknown[];
let me: { status: number; projects: unknown[] };
let paths: string[];

beforeEach(async () => {
  project = await createSeededRbookProject();
  paths = [];
  directory = [];
  me = { status: 200, projects: [] };
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    paths.push(url.pathname);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/projects/directory/public') {
      res.end(
        JSON.stringify({
          success: true,
          data: { projects: directory, totalCount: directory.length },
        })
      );
      return;
    }
    if (url.pathname === '/api/projects/me') {
      res.statusCode = me.status;
      res.end(
        JSON.stringify(
          me.status === 200
            ? {
                success: true,
                data: { user: { id: 'user-tester', username: 'tester' }, projects: me.projects },
              }
            : { error: 'Internal error' }
        )
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

async function directoryAnswer() {
  const answer = await executeMissionProtocolTool(
    'rbook_message',
    { action: 'directory', projectRoot: project.projectRoot },
    await buildMissionProtocolContext()
  );
  const structured = answer.structuredContent as {
    data: MessageDirectoryResult;
    warnings?: string[];
  };
  const text = (answer.content as Array<{ text?: string }>).map((part) => part.text).join('\n');
  return {
    byId: new Map(structured.data.projects.map((p) => [p.id, p])),
    warnings: structured.warnings ?? [],
    text,
  };
}

// The deployed shape (probe O, 2026-11-03): the directory route sends a boolean isOwner on every row
// and archivedAt on archived ones; /me leaves every archived project out. At 7d7a3c28 the account's 10
// archived projects read as someone else's, because ownership came from /me alone.
it("reads an archived project the directory marks owned as the account's own, and says it is archived", async () => {
  directory = [
    { ...row(OWNED, 'mine', 'tester'), isOwner: true, archivedAt: null },
    { ...row(ARCHIVED, 'old', 'tester'), isOwner: true, archivedAt: '2026-10-01T00:00:00.000Z' },
    { ...row(SHARED, 'theirs', 'another-owner'), isOwner: false, archivedAt: null },
  ];
  me.projects = [{ ...row(OWNED, 'mine', 'tester'), isOwner: true }];
  const { byId, warnings, text } = await directoryAnswer();
  expect(byId.get(ARCHIVED)).toMatchObject({
    isOwner: true,
    archivedAt: '2026-10-01T00:00:00.000Z',
    provenance: { trust: 'local' },
  });
  expect(byId.get(OWNED)).toMatchObject({ isOwner: true, provenance: { trust: 'local' } });
  expect((byId.get(OWNED) as { archivedAt?: unknown } | undefined)?.archivedAt).toBeUndefined();
  expect(byId.get(SHARED)).toMatchObject({ isOwner: false, provenance: { trust: 'foreign' } });
  expect(text).toMatch(/rbook:\/\/tester\/old .*, yours, archived/);
  expect(text).not.toMatch(/rbook:\/\/tester\/mine .*archived/);
  expect(warnings).toEqual([]);
});

it('never asks /me when every row carries its own isOwner', async () => {
  directory = [
    { ...row(OWNED, 'mine', 'tester'), isOwner: true },
    { ...row(SHARED, 'theirs', 'another-owner'), isOwner: false },
  ];
  await directoryAnswer();
  expect(paths).not.toContain('/api/projects/me');
});

it("never lets /me overturn the directory's own false", async () => {
  directory = [
    { ...row(SHARED, 'theirs', 'another-owner'), isOwner: false },
    row(UNMARKED, 'u', 'x'),
  ];
  me.projects = [{ ...row(SHARED, 'theirs', 'another-owner'), isOwner: true }];
  const { byId } = await directoryAnswer();
  expect(byId.get(SHARED)).toMatchObject({ isOwner: false, provenance: { trust: 'foreign' } });
});

// A row without the field (the shape the directory route sent before it carried isOwner): /me fills it,
// a shared project stays not owned, and a row neither source marks stays unmarked and foreign.
it('fills only rows without a boolean from /me, never claiming one /me marks neither way', async () => {
  directory = [
    row(OWNED, 'mine', 'tester'),
    row(SHARED, 'theirs', 'another-owner'),
    row(UNMARKED, 'unmarked', 'another-owner'),
  ];
  me.projects = [
    { ...row(OWNED, 'mine', 'tester'), isOwner: true },
    { ...row(SHARED, 'theirs', 'another-owner'), isOwner: false },
    row(UNMARKED, 'unmarked', 'another-owner'),
  ];
  const { byId, warnings } = await directoryAnswer();
  expect(byId.get(OWNED)).toMatchObject({ isOwner: true, provenance: { trust: 'local' } });
  expect(byId.get(SHARED)).toMatchObject({ isOwner: false, provenance: { trust: 'foreign' } });
  expect(byId.get(UNMARKED)?.isOwner).toBeUndefined();
  expect(byId.get(UNMARKED)).toMatchObject({ provenance: { trust: 'foreign' } });
  expect(warnings).toEqual([]);
});

// At 7d7a3c28, with /me failing, rows kept the directory route's isOwner under a warning that said none
// was claimed as yours (s109-m05's critic round 1, finding 1).
it('with /me failing, claims no unmarked row as yours, and its warning covers only those rows', async () => {
  directory = [
    { ...row(OWNED, 'mine', 'tester'), isOwner: true },
    row(UNMARKED, 'unmarked', 'another-owner'),
  ];
  me.status = 500;
  const { byId, warnings } = await directoryAnswer();
  expect(byId.get(OWNED)).toMatchObject({ isOwner: true, provenance: { trust: 'local' } });
  expect(byId.get(UNMARKED)?.isOwner).toBeUndefined();
  expect(byId.get(UNMARKED)).toMatchObject({ provenance: { trust: 'foreign' } });
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toMatch(/\/api\/projects\/me failed/);
  expect(warnings[0]).toContain('rbook://another-owner/unmarked');
  expect(warnings[0]).not.toContain('rbook://tester/mine');
});
