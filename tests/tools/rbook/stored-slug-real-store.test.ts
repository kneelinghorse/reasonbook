// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m01's real-store fires on copies of this project's store: the readers send the stored slug for a
// ABOUTME: dotted and an em-dash name, the address rule holds, and the old address after a rename is refused by name.

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { CredentialStore } from '../../../src/intelligence/credential-store';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { resolveRegisteredAddress } from '../../../src/intelligence/project-address';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookAgentOnboard } from '../../../src/tools/rbook/rbook-agent-onboard';
import { rbookContextUpdateProjectIdentity } from '../../../src/tools/rbook/rbook-context-project-identity';
import {
  identifyPgOrphans,
  rbookDbPurge,
  rbookDbReconcile,
} from '../../../src/tools/rbook/rbook-db-backfill';
import { rbookStatus } from '../../../src/tools/rbook/rbook-status';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore } from '../../helpers/seedRbookDb';

const PRIVATE = requiresPrivateEvidence({
  reason:
    'The fires need temporary SQLite backups of the live project store, whose real metadata, identity and schema they read.',
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

const envKeys = ['RBOOK_', LEGACY.envPrefix].flatMap((prefix) =>
  ['CONFIG_DIR', 'DASHBOARD_URL', 'DASHBOARD_API_KEY', 'DASHBOARD_USER', 'DASHBOARD_PASSWORD'].map(
    (name) => prefix + name
  )
);

PRIVATE.describe('s110-m01 on copies of the live store', () => {
  let tmp: string;
  let server: http.Server;
  let asked: string[];
  let mine: unknown[];
  let saved: Record<string, string | undefined>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        const url = new URL(req.url ?? '', 'http://127.0.0.1');
        res.setHeader('Content-Type', 'application/json');
        const state = /^\/api\/sync\/projects\/([^/]+)\/state$/.exec(url.pathname);
        if (url.pathname === '/api/sync/status') {
          asked.push(url.searchParams.get('projectSlug') ?? '(unscoped)');
          res.end(
            JSON.stringify({
              success: true,
              data: {
                tables: [
                  'cmos_sprints',
                  'cmos_missions',
                  'cmos_sessions',
                  'cmos_decisions',
                  'cmos_learnings',
                  'cmos_mission_dependencies',
                ].map((table) => ({ table, count: 0 })),
                totalSyncLogEntries: 0,
                failedSyncLogEntries: 0,
                lastSyncAt: '2026-11-03T22:14:49.000Z',
              },
            })
          );
        } else if (state) {
          asked.push(decodeURIComponent(state[1]));
          res.end(JSON.stringify({ success: true, data: { missions: [], sessions: [] } }));
        } else if (url.pathname === '/api/sync/purge') {
          const slug = (JSON.parse(body) as { projectSlug: string }).projectSlug;
          asked.push(slug);
          res.end(JSON.stringify({ success: true, data: { projectSlug: slug, purged: {} } }));
        } else if (url.pathname === '/api/projects/mine') {
          res.end(JSON.stringify({ success: true, data: { projects: mine } }));
        } else {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'Not in this double' }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(async () => {
    saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    for (const key of envKeys) delete process.env[key];
    tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s110-m01-live-')));
    process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
    process.env.RBOOK_DASHBOARD_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    CredentialStore.resetInstance();
    ProjectGraphRegistry.resetInstance();
    RbookDetector.resetInstance();
    const credentials = await CredentialStore.create({ configDir: process.env.RBOOK_CONFIG_DIR });
    await credentials.upsertUserScopedKey('fixture-key', {
      key: 'cmk_loopback_live_copy',
      label: 'isolated test',
      issuedAt: new Date().toISOString(),
      lastUsedAt: '',
    });
    asked = [];
    mine = [];
  });
  afterEach(() => {
    RbookDetector.resetInstance();
    ProjectGraphRegistry.resetInstance();
    CredentialStore.resetInstance();
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A backup of the live store in `<tmp>/<name>`, with its own project id and these metadata keys. */
  async function copy(name: string, metadata: Record<string, string | null> = {}): Promise<string> {
    const root = path.join(tmp, name);
    const dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const live = new Database(PRIVATE.paths.liveDb, { readonly: true });
    try {
      await live.backup(dbPath);
    } finally {
      live.close();
    }
    reidentifyRbookTestStore(root, `live-copy-${name}`);
    const db = new Database(dbPath);
    try {
      for (const [key, value] of Object.entries(metadata))
        if (value === null) db.prepare('DELETE FROM metadata WHERE key = ?').run(key);
        else
          db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
    } finally {
      db.close();
    }
    RbookDetector.resetInstance();
    return root;
  }

  function identity(root: string): Record<string, unknown> {
    const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'), { readonly: true });
    try {
      const row = db
        .prepare("SELECT content FROM contexts WHERE id = 'project_identity'")
        .get() as {
        content: string;
      };
      return JSON.parse(row.content) as Record<string, unknown>;
    } finally {
      db.close();
    }
  }

  function setIdentity(root: string, fields: Record<string, unknown>): void {
    const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'));
    try {
      const next = { ...identity(root), ...fields };
      db.prepare("UPDATE contexts SET content = ? WHERE id = 'project_identity'").run(
        JSON.stringify(next)
      );
    } finally {
      db.close();
    }
    RbookDetector.resetInstance();
  }

  it.each([
    ['a dotted name', 'aquex.ai', 'aquex-ai'],
    ['an em-dash name', 'Hive — Design Intelligence Loop', 'hive-design-intelligence-loop'],
  ])(
    'the five readers send the stored slug for %s',
    async (_case, name, slug) => {
      const root = await copy('named', { project_name: name, dashboard_slug: slug });
      expect((await rbookStatus({ projectRoot: root })).success).toBe(true);
      expect((await rbookAgentOnboard({ projectRoot: root })).success).toBe(true);
      expect((await rbookDbReconcile({ projectRoot: root })).success).toBe(true);
      expect((await identifyPgOrphans({ projectRoot: root })).success).toBe(true);
      expect((await rbookDbPurge({ projectRoot: root, confirm: true })).success).toBe(true);
      expect(asked.length).toBeGreaterThanOrEqual(5);
      expect(new Set(asked)).toEqual(new Set([slug]));
    },
    120_000
  );

  it("the address rule accepts this owner's address and refuses a dotted one", async () => {
    const root = await copy('pro');
    const before = identity(root);
    const refused = await rbookContextUpdateProjectIdentity({
      projectRoot: root,
      fieldUpdates: [{ path: 'rbook_address', value: 'rbook://derek/reasonbook.pro' }],
    });
    expect(refused.success).toBe(false);
    expect(identity(root)).toEqual(before);
    const taken = await rbookContextUpdateProjectIdentity({
      projectRoot: root,
      fieldUpdates: [{ path: 'rbook_address', value: 'rbook://derek/reasonbook-pro' }],
    });
    expect(taken.success).toBe(true);
    expect(identity(root)[LEGACY.identityAddressKey]).toBe('cmos://derek/reasonbook-pro');
  });

  it("cmos-handoff-demo's shape (no owner, address '') takes a description and refuses a malformed address", async () => {
    const root = await copy('handoff', { owner: null, dashboard_username: null });
    setIdentity(root, { [LEGACY.identityAddressKey]: '' });
    const description = await rbookContextUpdateProjectIdentity({
      projectRoot: root,
      fieldUpdates: [{ path: 'description', value: 'A handoff demo.' }],
    });
    expect(description.success).toBe(true);
    const malformed = await rbookContextUpdateProjectIdentity({
      projectRoot: root,
      fieldUpdates: [{ path: 'rbook_address', value: 'rbook://Derek/handoff' }],
    });
    expect(malformed.success).toBe(false);
    expect(identity(root)[LEGACY.identityAddressKey]).toBe('');
  });

  it('after a rename the fixture writes, the old address is refused, naming the new one', async () => {
    const root = await copy('renamed', {
      project_name: 'Reasonbook Pro',
      dashboard_slug: 'reasonbook-pro',
      previous_rbook_addresses: JSON.stringify(['rbook://derek/cmos-mcp-pro']),
    });
    setIdentity(root, {
      project_name: 'Reasonbook Pro',
      [LEGACY.identityAddressKey]: 'cmos://derek/reasonbook-pro',
    });
    const registry = await ProjectGraphRegistry.create();
    registry.registerStore(root);
    const old = resolveRegisteredAddress('rbook://derek/cmos-mcp-pro', registry);
    expect('error' in old && old.error).toMatch(
      /previous address: the project is now rbook:\/\/derek\/reasonbook-pro/
    );
    expect(resolveRegisteredAddress('rbook://derek/reasonbook-pro', registry)).toEqual({
      projectRoot: root,
    });
  });

  it('an address a readable copy holds is refused beside a mid-move copy, which is named and skipped', async () => {
    const holder = await copy('holder');
    // The collision belongs to this fixture, regardless of the live project's latest rename.
    setIdentity(holder, { [LEGACY.identityAddressKey]: 'cmos://derek/held-copy' });
    const moving = await copy('moving');
    setIdentity(moving, { [LEGACY.identityAddressKey]: 'cmos://derek/moving-copy' });
    const other = await copy('other');
    setIdentity(other, { [LEGACY.identityAddressKey]: 'cmos://derek/other-copy' });
    const registry = await ProjectGraphRegistry.create();
    for (const root of [holder, moving, other]) registry.registerStore(root);
    fs.writeFileSync(path.join(moving, '.rbook-migration.json'), '{}');

    const taken = await rbookContextUpdateProjectIdentity({
      projectRoot: other,
      fieldUpdates: [{ path: 'rbook_address', value: 'rbook://derek/held-copy' }],
    });
    expect(taken.success).toBe(false);
    expect(taken.error?.message).toContain(holder);
    const free = await rbookContextUpdateProjectIdentity({
      projectRoot: other,
      fieldUpdates: [{ path: 'rbook_address', value: 'rbook://derek/moving-copy' }],
    });
    expect(free.success).toBe(true);
    expect(free.warnings).toContainEqual(expect.stringContaining(moving));
  });

  it("purge takes a derived slug only under /mine's exact path tie", async () => {
    // Fix the derived-name input while retaining the live store's schema and other records.
    const root = await copy('purge', { project_name: 'Purge Fixture', dashboard_slug: null });
    const dbPath = path.join(root, 'rbook', 'db', 'rbook.sqlite');
    mine = [
      {
        id: 'x',
        slug: 'purge-fixture',
        name: 'Purge Fixture',
        localDbPath: path.join(root, 'cmos', 'db', 'cmos.sqlite'),
      },
    ];
    const refused = await rbookDbPurge({ projectRoot: root, confirm: true });
    expect(refused.success).toBe(false);
    expect(refused.error?.code).toBe('PURGE_SLUG_UNCONFIRMED');
    expect(asked).toEqual([]);
    mine = [{ id: 'x', slug: 'purge-fixture', name: 'Purge Fixture', localDbPath: dbPath }];
    const purged = await rbookDbPurge({ projectRoot: root, confirm: true });
    expect(purged.success).toBe(true);
    expect(asked).toEqual(['purge-fixture']);
  }, 120_000);
});
