// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Repeated owner listings must not allow a replacement record to receive this store's bytes.
// ABOUTME: Loopback responses also preserve Retry-After when a fresh authentication check recovers.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { attemptDashboardUpload } from '../../../src/tools/rbook/dashboard-upload-attempt';
import { seedRbookDb } from '../../helpers/seedRbookDb';

describe('upload owner reconciliation races', () => {
  let root: string;
  let dbPath: string;
  let server: http.Server;
  let listings: Array<{
    id?: string;
    slug?: string;
    siblingId?: string;
    user?: string;
    status?: number;
    retryAfter?: string;
  }>;
  let gets: number;
  let posts: number;
  const env = { ...process.env };
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-race-'));
    dbPath = seedRbookDb(root, {
      projectId: 'race-test',
      projectName: 'Race Test',
      slug: 'race-test',
      owner: 'tester',
      dashboardProjectId: 'original-id',
      rbookAddress: 'rbook://tester/race-test',
    });
    const db = new Database(dbPath);
    db.prepare("INSERT INTO metadata(key,value) VALUES ('dashboard_registered','true')").run();
    db.close();
    ProjectGraphRegistry.resetInstance();
    process.env.RBOOK_CONFIG_DIR = path.join(root, 'config');
    const graph = await ProjectGraphRegistry.create({
      configDir: process.env.RBOOK_CONFIG_DIR,
      ephemeralRoots: [],
    });
    graph.register({ project_id: 'race-test', store_path: root, name: 'Race Test' });
    CredentialStore.resetInstance();
    listings = [{ id: 'original-id' }, { id: 'original-id' }];
    gets = 0;
    posts = 0;
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/projects/me') {
          const answer = listings[Math.min(gets++, listings.length - 1)];
          res.statusCode = answer.status ?? 200;
          if (answer.retryAfter) res.setHeader('Retry-After', answer.retryAfter);
          res.end(
            JSON.stringify(
              answer.status
                ? { success: false, error: 'temporarily unavailable' }
                : {
                    data: {
                      user: { id: 'user', username: answer.user ?? 'tester' },
                      projects: answer.id
                        ? [
                            {
                              id: answer.id,
                              slug: answer.slug ?? 'race-test',
                              name: answer.slug ? 'New Name' : 'Race Test',
                              isOwner: true,
                              owner: answer.user ?? 'tester',
                            },
                            ...(answer.siblingId
                              ? [
                                  {
                                    id: answer.siblingId,
                                    slug: 'race-test',
                                    name: 'Race Test',
                                    isOwner: true,
                                    owner: answer.user ?? 'tester',
                                  },
                                ]
                              : []),
                          ]
                        : [],
                    },
                  }
            )
          );
        } else {
          posts += 1;
          res.end(
            JSON.stringify({ data: { success: true, counts: {}, errors: [], durationMs: 1 } })
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.RBOOK_DASHBOARD_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.RBOOK_DASHBOARD_API_KEY = 'race-key';
    delete process.env.RBOOK_PROJECT_ROOT;
    delete process.env.RBOOK_AGENT_ROLE;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    CredentialStore.resetInstance();
    ProjectGraphRegistry.resetInstance();
    RbookDetector.resetInstance();
    process.env = { ...env };
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])(
    'blocks a replacement seen on the second listing (manual destination=%s)',
    async (manual) => {
      listings[1] = { id: 'replacement-id' };
      const result = await attemptDashboardUpload(
        root,
        true,
        manual
          ? { sqlitePath: dbPath, projectSlug: 'race-test', expectedSlug: 'race-test' }
          : undefined
      );
      expect(result.outcome).toMatchObject({ success: false, pauseReason: 'replaced' });
      expect(posts).toBe(0);
      const db = new Database(dbPath, { readonly: true });
      try {
        expect(
          db.prepare("SELECT value FROM metadata WHERE key='dashboard_project_id'").get()
        ).toEqual({ value: 'original-id' });
      } finally {
        db.close();
      }
    }
  );

  it.each([{ status: 503 }, { id: 'replacement-id', user: 'another-account' }])(
    'stops on a second-listing safety error without a terminal hold: %j',
    async (second) => {
      listings[1] = second;
      const result = await attemptDashboardUpload(root, true, {
        sqlitePath: dbPath,
        projectSlug: 'race-test',
        expectedSlug: 'race-test',
      });
      expect(result.outcome.success).toBe(false);
      expect(result.outcome.pauseReason).toBeUndefined();
      expect(result.error).toBeDefined();
      expect(posts).toBe(0);
    }
  );

  it('keeps the first Retry-After when the fresh authentication check succeeds', async () => {
    listings[0] = { status: 401, retryAfter: '3600' };
    const result = await attemptDashboardUpload(root, true);
    expect(result.outcome).toMatchObject({
      success: false,
      pauseReason: null,
      retryAfterMs: 3_600_000,
    });
    expect(posts).toBe(0);
    expect(gets).toBe(2);
  });

  it.each(['ABORT', 'IGNORE'])(
    'sends nothing when a %s trigger keeps the old slug now held by a sibling',
    async (action) => {
      listings = [{ id: 'original-id', slug: 'new-name', siblingId: 'sibling-id' }];
      const db = new Database(dbPath);
      try {
        db.exec(`CREATE TRIGGER reject_destination BEFORE UPDATE ON metadata
        WHEN OLD.key = 'dashboard_slug'
        BEGIN SELECT RAISE(${action === 'ABORT' ? "ABORT, 'destination write rejected'" : 'IGNORE'}); END`);
        const result = await attemptDashboardUpload(root, true, {
          sqlitePath: dbPath,
          projectSlug: 'race-test',
          expectedSlug: 'race-test',
        });
        expect(result.outcome.success).toBe(false);
        expect(result.outcome.pauseReason).toBeUndefined();
        expect(result.error?.code).toBe('DASHBOARD_DESTINATION_NOT_SAVED');
        expect(posts).toBe(0);
        expect(db.prepare("SELECT value FROM metadata WHERE key='dashboard_slug'").get()).toEqual({
          value: 'race-test',
        });
      } finally {
        db.close();
      }
    }
  );

  it('keeps an unrelated metadata warning nonfatal after the fresh destination is saved', async () => {
    listings = [{ id: 'original-id', slug: 'new-name', siblingId: 'sibling-id' }];
    const db = new Database(dbPath);
    const logs: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      logs.push(String(chunk));
      return true;
    });
    try {
      db.exec(`CREATE TRIGGER reject_username BEFORE INSERT ON metadata
        WHEN NEW.key = 'dashboard_username'
        BEGIN SELECT RAISE(ABORT, 'username write rejected'); END`);
      const result = await attemptDashboardUpload(root, true);
      expect(result.outcome.success).toBe(true);
      expect(posts).toBe(1);
      expect(db.prepare("SELECT value FROM metadata WHERE key='dashboard_slug'").get()).toEqual({
        value: 'new-name',
      });
      expect(logs.join('\n')).toContain('metadata.dashboard_username failed:');
    } finally {
      db.close();
    }
  });
});
