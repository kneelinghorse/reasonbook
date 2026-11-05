// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m02 (feedback #53) — message lists and reads carry the address a reply needs: the directory row for
// ABOUTME: the message's project id, else an address the row carries, never one built from a slug or a name.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { createSuccess } from '../../../src/tools/rbook/errors';
import { __resetDirectoryCacheForTesting } from '../../../src/tools/rbook/rbook-message';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';

const SENDER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
const UNLISTED = '33333333-3333-4333-8333-333333333333';
const MESSAGE = '44444444-4444-4444-8444-444444444444';
const SECOND = '55555555-5555-4555-8555-555555555555';

let server: Server;
let project: SeededRbookProject;
let directoryStatus: number;
let directory: unknown[];
let messages: Array<Record<string, unknown>>;
let byId: Record<string, unknown> | null;
let paths: string[];

/** A message row in the deployed shape (2026-11-04, read-only): ids, slugs and names, no address. */
function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MESSAGE,
    type: 'info_push',
    summary: 'A notice',
    status: 'pending',
    createdAt: '2026-11-04T00:00:00.000Z',
    senderUserId: 'user-a',
    senderProjectId: SENDER,
    senderProject: 'sender-slug',
    senderProjectName: 'Sender Project',
    targetUserId: 'user-b',
    targetProjectId: TARGET,
    targetProject: 'target-slug',
    targetProjectName: 'Target Project',
    ...overrides,
  };
}

beforeEach(async () => {
  __resetDirectoryCacheForTesting();
  project = await createSeededRbookProject();
  paths = [];
  directoryStatus = 200;
  directory = [
    {
      id: SENDER,
      name: 'Sender Project',
      slug: 'sender-slug',
      owner: 'alice',
      address: 'cmos://alice/sender-slug',
      isOwner: false,
    },
    {
      id: TARGET,
      name: 'Target Project',
      slug: 'target-slug',
      owner: 'bob',
      address: 'rbook://bob/target-slug',
      isOwner: true,
    },
  ];
  messages = [message()];
  byId = null;
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    paths.push(url.pathname);
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/api/projects/directory/public') {
      res.statusCode = directoryStatus;
      res.end(
        JSON.stringify(
          directoryStatus === 200
            ? { success: true, data: { projects: directory, totalCount: directory.length } }
            : { error: 'Directory unavailable' }
        )
      );
      return;
    }
    if (url.pathname === '/api/messages') {
      res.end(
        JSON.stringify({ messages, unreadCount: messages.length, totalCount: messages.length })
      );
      return;
    }
    if (url.pathname === `/api/messages/${MESSAGE}`) {
      res.end(JSON.stringify({ success: true, data: { message: byId ?? messages[0] } }));
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

async function call(args: Record<string, unknown>) {
  const answer = await executeMissionProtocolTool(
    'rbook_message',
    { ...args, projectRoot: project.projectRoot },
    await buildMissionProtocolContext()
  );
  const structured = answer.structuredContent as {
    data: Record<string, unknown>;
    warnings?: string[];
  };
  return { data: structured.data, warnings: structured.warnings ?? [] };
}

const listed = async (tab: 'inbox' | 'sent') => {
  const { data, warnings } = await call({ action: 'list', tab });
  const rows = (data.messages ?? []) as Array<Record<string, unknown>>;
  const dataWarnings = (data.warnings ?? []) as string[];
  return { row: rows[0], warnings: [...warnings, ...dataWarnings] };
};

describe('the list (at 7d7a3c28 a summary carried no address; feedback #53)', () => {
  it("gives the inbox the sender's address from its project id's directory row, in rbook:// form", async () => {
    const { row } = await listed('inbox');
    expect(row.senderAddress).toBe('rbook://alice/sender-slug');
    expect(row.targetAddress).toBeUndefined();
  });

  it("gives the sent tab the target's address from its project id's directory row", async () => {
    const { row } = await listed('sent');
    expect(row.targetAddress).toBe('rbook://bob/target-slug');
    expect(row.senderAddress).toBeUndefined();
  });

  // A typed address can resolve to a project it does not name (an alias, fuzzy resolution), so the
  // id's address wins in a summary, where the field is new.
  it("prefers the id's address to a different one the row carries", async () => {
    messages = [
      message({ senderAddress: 'rbook://alice/old-slug', from: 'rbook://alice/old-slug' }),
    ];
    expect((await listed('inbox')).row.senderAddress).toBe('rbook://alice/sender-slug');
    messages = [message({ to: 'cmos://bob/typed-alias' })];
    expect((await listed('sent')).row.targetAddress).toBe('rbook://bob/target-slug');
  });

  it('falls back to a valid address the row carries when the directory does not list the id', async () => {
    messages = [message({ senderProjectId: UNLISTED, senderAddress: 'cmos://carol/carried' })];
    expect((await listed('inbox')).row.senderAddress).toBe('rbook://carol/carried');
    messages = [message({ targetProjectId: UNLISTED, to: 'rbook://dave/typed' })];
    expect((await listed('sent')).row.targetAddress).toBe('rbook://dave/typed');
  });

  it('never builds an address from a slug, a name or an empty id', async () => {
    messages = [message({ senderProjectId: UNLISTED })];
    expect((await listed('inbox')).row.senderAddress).toBeUndefined();
    // The normalizer gives a directory row with no id the id '', which must never match. A second
    // message names a listed id, so the directory is read: with none, nothing could be looked up.
    directory = [
      { name: 'Nameless', slug: 'nameless', owner: 'eve', address: 'rbook://eve/nameless' },
      ...directory,
    ];
    messages = [message({ senderProjectId: '' }), message({ id: SECOND })];
    __resetDirectoryCacheForTesting();
    paths = [];
    const { data } = await call({ action: 'list', tab: 'inbox' });
    const rows = data.messages as Array<Record<string, unknown>>;
    expect(paths).toContain('/api/projects/directory/public');
    expect(rows.map((row) => row.senderAddress)).toEqual([undefined, 'rbook://alice/sender-slug']);
  });

  it("says why when the directory cannot be read, and uses only the row's own address", async () => {
    directoryStatus = 500;
    messages = [message({ senderAddress: 'cmos://alice/carried' })];
    const { row, warnings } = await listed('inbox');
    expect(row.senderAddress).toBe('rbook://alice/carried');
    expect(warnings).toContainEqual(expect.stringMatching(/directory could not be read/));
  });
});

describe('get (at 7d7a3c28 it carried no address from the id)', () => {
  it("fills both parties' addresses from their ids when the dashboard sends none", async () => {
    const { data } = await call({ action: 'get', messageId: MESSAGE });
    const found = data.message as Record<string, unknown>;
    expect(found.senderAddress).toBe('rbook://alice/sender-slug');
    expect(found.targetAddress).toBe('rbook://bob/target-slug');
  });

  // Provenance reads the dashboard's own senderAddress, so get keeps it and warns when the id's differs.
  it("keeps the dashboard's own senderAddress and names both when the id's differs", async () => {
    byId = message({ senderAddress: 'cmos://alice/its-own' });
    const { data, warnings } = await call({ action: 'get', messageId: MESSAGE });
    const found = data.message as Record<string, unknown>;
    expect(found.senderAddress).toBe('rbook://alice/its-own');
    expect(warnings).toContainEqual(expect.stringContaining('rbook://alice/sender-slug'));
    expect(warnings).toContainEqual(expect.stringContaining('rbook://alice/its-own'));
  });
});
