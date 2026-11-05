// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m01 — listOwnedProjects() reads GET /api/projects/mine, failing closed on a malformed answer, and
// ABOUTME: the path tie matches a record's Local Database Path to a store by fixed tail and folder identity.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import {
  recordNamesStoreFolder,
  STORE_TAILS,
  storeRecordedAt,
} from '../../../src/tools/rbook/dashboard-path-tie';

describe('listOwnedProjects()', () => {
  let server: http.Server;
  let answer: { status: number; body: string; location?: string };
  let paths: string[];
  let client: DashboardClient;

  beforeEach(async () => {
    paths = [];
    server = http.createServer((req, res) => {
      paths.push(req.url ?? '');
      res.statusCode = answer.status;
      if (answer.location) res.setHeader('Location', answer.location);
      res.setHeader('Content-Type', 'application/json');
      res.end(answer.body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    client = new DashboardClient({
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      apiKey: 'cmk_loopback_owned',
    });
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // The deployed route's shape at cmos-dashboard 4227aa6, routes/projects.ts:1796-1812.
  it('maps each owned project, archived ones included, with its Local Database Path', async () => {
    answer = {
      status: 200,
      body: JSON.stringify({
        success: true,
        data: {
          projects: [
            {
              id: 'c02ea1cb',
              slug: 'cmos-mcp-pro',
              name: 'CMOS-MCP Pro',
              localDbPath: '/projects/cmos-mcp-pro/rbook/db/rbook.sqlite',
              lastSyncAt: '2026-11-03T22:14:49.000Z',
            },
            { id: '6f97522c', slug: 'cmos-handoff-demo', name: 'Demo', localDbPath: null },
          ],
        },
      }),
    };
    const result = await client.listOwnedProjects();
    expect(paths).toEqual(['/api/projects/mine']);
    expect(result.success).toBe(true);
    expect(result.data?.projects).toEqual([
      {
        id: 'c02ea1cb',
        slug: 'cmos-mcp-pro',
        name: 'CMOS-MCP Pro',
        localDbPath: '/projects/cmos-mcp-pro/rbook/db/rbook.sqlite',
        lastSyncAt: '2026-11-03T22:14:49.000Z',
      },
      {
        id: '6f97522c',
        slug: 'cmos-handoff-demo',
        name: 'Demo',
        localDbPath: null,
        lastSyncAt: null,
      },
    ]);
  });

  // A caller deciding whether a record is this store's must not read a malformed answer as "none".
  it.each([
    ['not a list', { success: true, data: { projects: {} } }],
    ['a project with no id', { success: true, data: { projects: [{ slug: 'x' }] } }],
    ['no projects field', { success: true, data: {} }],
  ])('refuses an answer that is %s, never reading it as no projects', async (_case, body) => {
    answer = { status: 200, body: JSON.stringify(body) };
    const result = await client.listOwnedProjects();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DASHBOARD_ERROR');
  });

  it('keeps the HTTP status of a refusal, and never follows a redirect as the list', async () => {
    answer = { status: 401, body: JSON.stringify({ error: 'Invalid API key' }) };
    expect((await client.listOwnedProjects()).error?.code).toBe('DASHBOARD_AUTH_FAILED');
    answer = { status: 302, body: '', location: '/' };
    const redirected = await client.listOwnedProjects();
    expect(redirected.success).toBe(false);
    expect(redirected.error?.currentState).toMatchObject({ httpStatus: 302 });
    expect(paths).toEqual(['/api/projects/mine', '/api/projects/mine']);
  });
});

describe('the path tie', () => {
  let tmp: string;
  let root: string;
  let db: string;
  beforeEach(() => {
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-path-tie-')));
    root = path.join(tmp, 'not');
    db = path.join(root, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(db), { recursive: true });
    fs.writeFileSync(db, '');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("ties a record naming this store's own file", () => {
    expect(storeRecordedAt(db, db)).toBe(true);
    expect(storeRecordedAt(path.join(root, '.', 'rbook', 'db', 'rbook.sqlite'), db)).toBe(true);
  });

  it('ties a symlinked spelling of the folder by its device and inode', () => {
    const link = path.join(tmp, 'link');
    fs.symlinkSync(root, link);
    expect(storeRecordedAt(path.join(link, 'rbook', 'db', 'rbook.sqlite'), db)).toBe(true);
  });

  // A relative path stripped of its tail resolves against the working folder: from the store's own
  // folder, `rbook/db/rbook.sqlite` would name this store, so the tie must refuse it outright.
  it('does not tie a relative path, even one that resolves to this store from the working folder', () => {
    expect(storeRecordedAt(path.relative(process.cwd(), db), db)).toBe(false);
    const cwd = process.cwd();
    try {
      process.chdir(root);
      // The literal: path.join would normalize the './' away, leaving no folder part to refuse.
      expect(storeRecordedAt('./rbook/db/rbook.sqlite', db)).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  // A relative folder with no '..' in it, which only the absolute-folder check refuses: from the
  // folder above the store, `not/rbook/db/rbook.sqlite` names this store's own file.
  it('does not tie a relative folder that names this store from the folder above it', () => {
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      expect(fs.existsSync(path.join('not', 'rbook', 'db', 'rbook.sqlite'))).toBe(true);
      expect(storeRecordedAt(path.join('not', 'rbook', 'db', 'rbook.sqlite'), db)).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  it.each([
    ['a relative path', 'rbook/db/rbook.sqlite'],
    ['a string suffix of another folder', null],
    ['an upper-case tail', 'UPPER'],
    ["the folder's other layout", 'LEGACY'],
    ['no path', ''],
    ['a value that is not a string', 42],
    ['the filesystem root', '/rbook/db/rbook.sqlite'],
    ['another folder', '/somewhere/else/rbook/db/rbook.sqlite'],
  ])('does not tie %s, run from the store folder as a project server runs', (_case, value) => {
    // Critic round 1, F7: from any other folder a missing guard still refuses these by accident.
    const cwd = process.cwd();
    process.chdir(root);
    const recorded =
      value === null
        ? path.join(tmp, 'notrbook', 'db', 'rbook.sqlite')
        : value === 'UPPER'
          ? path.join(root, 'RBOOK', 'db', 'rbook.sqlite')
          : value === 'LEGACY'
            ? path.join(root, 'cmos', 'db', 'cmos.sqlite')
            : value;
    try {
      expect(storeRecordedAt(recorded, db)).toBe(false);
    } finally {
      process.chdir(cwd);
    }
  });

  // Critic round 1, F2: isSameFolder resolves `..` as text, while the system follows a symlink first.
  it("does not tie a '..' that follows a symlink to another store's file", () => {
    const store = path.join(tmp, 'a', 'store');
    const storeDb = path.join(store, 'rbook', 'db', 'rbook.sqlite');
    const other = path.join(tmp, 'b', 'store', 'rbook', 'db', 'rbook.sqlite');
    for (const file of [storeDb, other]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, file === other ? 'other' : 'this');
    }
    fs.mkdirSync(path.join(tmp, 'b', 'deep'));
    fs.symlinkSync(path.join(tmp, 'b', 'deep'), path.join(tmp, 'a', 'link'));
    const recorded = path.join(tmp, 'a', 'link') + '/../store/rbook/db/rbook.sqlite';
    expect(fs.readFileSync(recorded, 'utf8')).toBe('other');
    expect(storeRecordedAt(recorded, storeDb)).toBe(false);
  });

  // m02's either-tail form: migrate's record names the pre-move file on the old layout.
  it('ties either fixed tail when asked for both, and only those', () => {
    const both = [STORE_TAILS.current, STORE_TAILS.legacy];
    expect(recordNamesStoreFolder(path.join(root, 'cmos', 'db', 'cmos.sqlite'), root, both)).toBe(
      true
    );
    expect(recordNamesStoreFolder(path.join(root, 'cmos', 'db', 'rbook.sqlite'), root, both)).toBe(
      false
    );
  });
});
