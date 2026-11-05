// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A renamed real-store copy never registers twice, and heals only with its saved dashboard name.
// ABOUTME: The local name differs from the listing so the positive fire cannot pass through the old name arm.

import { afterEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { checkAndRegister, markRegistered } from '../../../src/tools/rbook/checkpoint-registration';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore } from '../../helpers/seedRbookDb';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The self-heal's positive fire needs a temporary SQLite backup of the live project store, whose real metadata and identity it reads.",
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

PRIVATE.describe('the registered-flag self-heal on a copy of the live store (#907)', () => {
  let tmp: string | undefined;
  let server: http.Server | undefined;
  const savedConfig = process.env.RBOOK_CONFIG_DIR;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = savedConfig;
    RbookDetector.resetInstance();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each([false, true])(
    'a renamed copy uses the saved dashboard name only when present (%s)',
    async (savedName) => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-registration-heal-live-copy-'));
      const projectRoot = path.join(tmp, 'project');
      const dbPath = path.join(projectRoot, 'rbook/db/rbook.sqlite');
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const live = new Database(PRIVATE.paths.liveDb, { readonly: true });
      try {
        await live.backup(dbPath);
      } finally {
        live.close();
      }
      process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
      reidentifyRbookTestStore(projectRoot);
      RbookDetector.resetInstance();

      // Meridian's state, established on the copy: the dashboard's id, slug and owner, and no flag.
      const metadata = (): Record<string, string> => {
        const db = new Database(dbPath, { readonly: true });
        try {
          return Object.fromEntries(
            (
              db.prepare('SELECT key, value FROM metadata').all() as Array<{
                key: string;
                value: string;
              }>
            ).map((row) => [row.key, row.value])
          );
        } finally {
          db.close();
        }
      };
      const listedName = metadata().project_name;
      const renamed = listedName === 'Reasonbook Pro' ? 'Reasonbook Pro Renamed' : 'Reasonbook Pro';
      const db = new Database(dbPath);
      try {
        db.prepare(
          "DELETE FROM metadata WHERE key IN ('dashboard_registered', 'dashboard_project_name')"
        ).run();
        const set = db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)');
        set.run('project_name', renamed);
        if (savedName) set.run('dashboard_project_name', listedName);
      } finally {
        db.close();
      }
      const before = metadata();
      expect(before.dashboard_registered).toBeUndefined();
      expect(before.dashboard_project_id).toEqual(expect.any(String));
      expect(before.dashboard_slug).toEqual(expect.any(String));
      expect(before.owner).toEqual(expect.any(String));
      expect(before.project_name).not.toBe(listedName);

      const requests: string[] = [];
      server = http.createServer((req, res) => {
        requests.push(req.url ?? '');
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/projects/me') {
          res.end(
            JSON.stringify({
              data: {
                user: { id: 'user-owner', username: before.owner },
                projects: [
                  {
                    id: before.dashboard_project_id,
                    name: listedName,
                    slug: before.dashboard_slug,
                    isOwner: true,
                    owner: before.owner,
                  },
                ],
              },
            })
          );
          return;
        }
        if (req.url === '/api/projects/mine') {
          res.end(
            JSON.stringify({
              data: {
                projects: [
                  {
                    id: before.dashboard_project_id,
                    name: listedName,
                    slug: before.dashboard_slug,
                  },
                ],
              },
            })
          );
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Unexpected request' }));
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const client = new DashboardClient({ baseUrl, apiKey: 'cmk_loopback' });

      const refused = await checkAndRegister(projectRoot, client, 'user-scoped');
      expect(refused?.error?.code).toBe('DASHBOARD_PROJECT_ALREADY_EXISTS');
      expect(requests).toEqual(['/api/projects/me', '/api/projects/mine']);
      expect(metadata().dashboard_registered).toBeUndefined();
      requests.length = 0;

      const result = await checkAndRegister(projectRoot, client, 'project-scoped');
      expect(requests).toEqual(['/api/projects/me']);
      if (!savedName) {
        expect(result?.error?.code).toBe('DASHBOARD_NAME_MISMATCH');
        expect(metadata().dashboard_registered).toBeUndefined();
        return;
      }
      expect(result?.error).toBeUndefined();
      expect(result?.projectSlug).toBe(before.dashboard_slug);
      expect(result?.healPending).toBe(true);
      // The flag is written only once the upload is taken (round 3, NEW-1); here, on the real schema.
      expect(metadata().dashboard_registered).toBeUndefined();
      expect(await markRegistered(projectRoot)).toBeNull();
      expect(metadata().dashboard_registered).toBe('true');
    },
    120_000
  );
});
