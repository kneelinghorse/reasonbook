// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m04 (#907) — the registered-flag self-heal fires on a copy of this project's store whose flag is
// ABOUTME: removed: a loopback listing naming its real dashboard id as owned heals it without a registration.

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

  it('a copy without its flag, listed as owned, writes the flag and sends no registration', async () => {
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
    const db = new Database(dbPath);
    try {
      db.prepare("DELETE FROM metadata WHERE key = 'dashboard_registered'").run();
    } finally {
      db.close();
    }
    const before = metadata();
    expect(before.dashboard_registered).toBeUndefined();
    expect(before.dashboard_project_id).toEqual(expect.any(String));
    expect(before.dashboard_slug).toEqual(expect.any(String));
    expect(before.owner).toEqual(expect.any(String));

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
                  name: before.project_name,
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
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Unexpected request' }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const client = new DashboardClient({ baseUrl, apiKey: 'cmk_loopback' });

    const result = await checkAndRegister(projectRoot, client, 'project-scoped');
    expect(result?.error).toBeUndefined();
    expect(result?.projectSlug).toBe(before.dashboard_slug);
    expect(result?.healPending).toBe(true);
    expect(requests).toEqual(['/api/projects/me']);
    // The flag is written only once the upload is taken (round 3, NEW-1); here, on the real schema.
    expect(metadata().dashboard_registered).toBeUndefined();
    expect(await markRegistered(projectRoot)).toBeNull();
    expect(metadata().dashboard_registered).toBe('true');
  }, 120_000);
});
