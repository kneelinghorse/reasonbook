// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m01 — the five dashboard requests that name a project's slug send metadata.dashboard_slug,
// ABOUTME: deriving one from the name only when none is stored; a failed read is never taken for an absent one.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { CredentialStore } from '../../../src/intelligence/credential-store';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../../src/index';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { rbookAgentOnboard } from '../../../src/tools/rbook/rbook-agent-onboard';
import {
  identifyPgOrphans,
  rbookDbPurge,
  rbookDbReconcile,
} from '../../../src/tools/rbook/rbook-db-backfill';
import { rbookStatus } from '../../../src/tools/rbook/rbook-status';
import { seedRbookDb } from '../../helpers/seedRbookDb';

// Five of this Mac's sixteen stores were named so on 2026-11-03 (probe R, task 1 row 1): the name
// derives one slug, and the dashboard knows the project by another, the one it stored.
const NAME = 'aquex.ai';
const STORED = 'aquex-ai';
const DERIVED = 'aquex.ai';
const ENTITIES = [
  'cmos_sprints',
  'cmos_missions',
  'cmos_sessions',
  'cmos_decisions',
  'cmos_learnings',
  'cmos_mission_dependencies',
];

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly slug: string | null;
}

// PROJECT_ROOT among them: each call names its folder, with the environment naming none (practice 4,
// path 3).
const envKeys = ['RBOOK_', LEGACY.envPrefix].flatMap((prefix) =>
  [
    'CONFIG_DIR',
    'DASHBOARD_URL',
    'DASHBOARD_API_KEY',
    'DASHBOARD_USER',
    'DASHBOARD_PASSWORD',
    'PROJECT_ROOT',
  ].map((name) => prefix + name)
);
let previous: Record<string, string | undefined>;
let root: string;
let dbPath: string;
let server: http.Server;
let seen: Seen[];
let mine: unknown;

function setMetadata(key: string, value: string | null): void {
  const db = new Database(dbPath);
  try {
    if (value === null) db.prepare('DELETE FROM metadata WHERE key = ?').run(key);
    else db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(key, value);
  } finally {
    db.close();
  }
  RbookDetector.resetInstance();
}

/** The slug a request named: its query, its state path, or its purge body. */
function slugOf(url: URL, body: string): string | null {
  const query = url.searchParams.get('projectSlug');
  if (query !== null) return query;
  const state = /^\/api\/sync\/projects\/([^/]+)\/state$/.exec(url.pathname);
  if (state) return decodeURIComponent(state[1]);
  if (url.pathname === '/api/sync/purge' && body) {
    const parsed = JSON.parse(body) as { projectSlug?: unknown };
    return typeof parsed.projectSlug === 'string' ? parsed.projectSlug : null;
  }
  return null;
}

/** The slugs the five readers' requests named, in order: status, project state and purge. */
function slugsAsked(): Array<string | null> {
  return seen
    .filter(
      (request) =>
        request.path === '/api/sync/status' ||
        request.path === '/api/sync/purge' ||
        /^\/api\/sync\/projects\/[^/]+\/state$/.test(request.path)
    )
    .map((request) => request.slug);
}

beforeEach(async () => {
  previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-stored-slug-'));
  process.env.RBOOK_CONFIG_DIR = path.join(root, 'config');
  CredentialStore.resetInstance();
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  const credentials = await CredentialStore.create({ configDir: process.env.RBOOK_CONFIG_DIR });
  await credentials.upsertUserScopedKey('fixture-key', {
    key: 'cmk_loopback_stored_slug',
    label: 'isolated test',
    issuedAt: new Date().toISOString(),
    lastUsedAt: '',
  });
  dbPath = seedRbookDb(path.join(root, 'project'), {
    projectId: 'stored-slug-test',
    projectName: NAME,
    slug: STORED,
    owner: 'derek',
    dashboardProjectId: '0f5f04b2-7e66-4390-a492-c2f5f8f1757f',
  });
  seen = [];
  mine = { success: true, data: { projects: [] } };
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const url = new URL(req.url ?? '', 'http://127.0.0.1');
      seen.push({ method: req.method ?? '', path: url.pathname, slug: slugOf(url, body) });
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/sync/status') {
        res.end(
          JSON.stringify({
            success: true,
            data: {
              tables: ENTITIES.map((table) => ({ table, count: 0 })),
              totalMirrorRows: 0,
              totalSyncLogEntries: 1,
              unprocessedSyncLogEntries: 0,
              failedSyncLogEntries: 0,
              lastSyncAt: '2026-11-03T22:14:49.000Z',
              oldestUnprocessedAt: null,
              projectCount: 1,
            },
          })
        );
      } else if (/^\/api\/sync\/projects\/[^/]+\/state$/.test(url.pathname)) {
        res.end(
          JSON.stringify({
            success: true,
            data: {
              sprints: [],
              missions: [],
              sessions: [],
              decisions: [],
              learnings: [],
              dependencies: [],
            },
          })
        );
      } else if (url.pathname === '/api/sync/purge') {
        const slug = slugOf(url, body);
        res.end(JSON.stringify({ success: true, data: { projectSlug: slug, purged: {} } }));
      } else if (url.pathname === '/api/projects/mine') {
        res.end(JSON.stringify(mine));
      } else if (url.pathname === '/api/messages') {
        res.end(JSON.stringify({ messages: [], unreadCount: 0, totalCount: 0 }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not in this double' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.RBOOK_DASHBOARD_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  RbookDetector.resetInstance();
  ProjectGraphRegistry.resetInstance();
  CredentialStore.resetInstance();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const projectRoot = (): string => path.join(root, 'project');

describe('a stored slug is the one each request names', () => {
  // At 7d7a3c28 every one of these asked for aquex.ai, a slug the dashboard answers 404 (checked live
  // on 2026-11-04 for the five drifted projects), so rbook_status read their last_sync_at as null.
  it("onboard's sync health asks for the stored slug", async () => {
    const result = await rbookAgentOnboard({ projectRoot: projectRoot() });
    expect(result.success).toBe(true);
    expect(slugsAsked().length).toBeGreaterThan(0);
    expect(slugsAsked().every((slug) => slug === STORED)).toBe(true);
    expect(result.data?.syncHealth).not.toBeNull();
  });

  it("rbook_status's last_sync_at asks for the stored slug, so it is not null", async () => {
    const result = await rbookStatus({ projectRoot: projectRoot() });
    expect(result.success).toBe(true);
    expect(slugsAsked()).toEqual([STORED]);
    expect(result.data && 'last_sync_at' in result.data && result.data.last_sync_at).toBe(
      '2026-11-03T22:14:49.000Z'
    );
  });

  it('reconcile asks for the stored slug', async () => {
    const result = await rbookDbReconcile({ projectRoot: projectRoot() });
    expect(result.success).toBe(true);
    expect(slugsAsked()).toEqual([STORED]);
    expect(result.data?.projectSlug).toBe(STORED);
  });

  it('orphans asks for the stored slug', async () => {
    const result = await identifyPgOrphans({ projectRoot: projectRoot() });
    expect(result.success).toBe(true);
    expect(slugsAsked()).toEqual([STORED]);
    expect(result.data?.projectSlug).toBe(STORED);
  });

  it('purge purges the stored slug, and never asks /mine for a stored one', async () => {
    const result = await rbookDbPurge({ projectRoot: projectRoot(), confirm: true });
    expect(result.success).toBe(true);
    expect(slugsAsked()).toEqual([STORED]);
    expect(seen.some((request) => request.path === '/api/projects/mine')).toBe(false);
    expect(result.data?.purgedProject).toBe(STORED);
  });

  it('the same reads through the dispatcher name the stored slug', async () => {
    const context = await buildMissionProtocolContext();
    const status = await executeMissionProtocolTool(
      'rbook_status',
      { projectRoot: projectRoot() },
      context
    );
    expect(status.isError).toBeFalsy();
    const reconcile = await executeMissionProtocolTool(
      'rbook_db',
      { action: 'reconcile', projectRoot: projectRoot() },
      context
    );
    expect(reconcile.isError).toBeFalsy();
    expect(slugsAsked()).toEqual([STORED, STORED]);
  });
});

describe('with no stored slug, a derived one, said to be derived', () => {
  beforeEach(() => setMetadata('dashboard_slug', null));

  it('status, reconcile and orphans ask for the derived slug and say it was derived', async () => {
    const status = await rbookStatus({ projectRoot: projectRoot() });
    const reconcile = await rbookDbReconcile({ projectRoot: projectRoot() });
    const orphans = await identifyPgOrphans({ projectRoot: projectRoot() });
    for (const result of [status, reconcile, orphans]) {
      expect(result.success).toBe(true);
      expect(result.warnings).toContainEqual(
        expect.stringMatching(/derived from the project name/)
      );
    }
    expect(slugsAsked()).toEqual([DERIVED, DERIVED, DERIVED]);
  });

  it("onboard's sync health says its slug was derived", async () => {
    const result = await rbookAgentOnboard({ projectRoot: projectRoot() });
    expect(result.success).toBe(true);
    expect(slugsAsked().every((slug) => slug === DERIVED)).toBe(true);
    expect(result.warnings).toContainEqual(expect.stringMatching(/derived from the project name/));
  });

  // Settled item 1: a derived slug can name another project's mirror (critic A1, N3), so purge
  // takes it only when the account's own listing ties it to this store's file.
  it('purge refuses a derived slug that /mine does not tie to this store, purging nothing', async () => {
    mine = {
      success: true,
      data: {
        projects: [
          {
            id: 'another',
            slug: DERIVED.replace('.', '-'),
            name: NAME,
            localDbPath: dbPath,
            lastSyncAt: null,
          },
          {
            id: 'elsewhere',
            slug: DERIVED,
            name: NAME,
            localDbPath: '/somewhere/else/rbook/db/rbook.sqlite',
            lastSyncAt: null,
          },
        ],
      },
    };
    const result = await rbookDbPurge({ projectRoot: projectRoot(), confirm: true });
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/derived/);
    expect(result.error?.message).toMatch(/Nothing was purged/);
    expect(seen.map((request) => request.path)).toEqual(['/api/projects/mine']);
  });

  // Critic round 1, F3: a record naming this store's file under another slug is this store's mirror,
  // so the refusal names that slug and the step that stores it, not the path it already has.
  it.each([
    [
      'holds that project id',
      '0f5f04b2-7e66-4390-a492-c2f5f8f1757f',
      // Critic round 2, V3: the session calls name this project, or they close another one.
      /rbook_session\(action="start".*projectRoot=.*rbook_session\(action="complete".*projectRoot=/,
    ],
    ['holds another id', 'someone-else', /rbook_project\(action="init".*projectName="aquex-ai"/],
  ])(
    "purge names the slug /mine lists for this store's file when the store %s",
    async (_case, id, remedy) => {
      mine = {
        success: true,
        data: { projects: [{ id, slug: STORED, name: NAME, localDbPath: dbPath }] },
      };
      const result = await rbookDbPurge({ projectRoot: projectRoot(), confirm: true });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('PURGE_SLUG_UNCONFIRMED');
      expect(result.error?.message).toContain(`'${STORED}'`);
      expect(result.error?.suggestion).toMatch(remedy);
      expect(slugsAsked()).toEqual([]);
    }
  );

  // Critic round 2, V3: /mine lists archived projects too, so two records can name this store's file;
  // the one whose id the store holds is the one it uploads to, and the refusal names it.
  it("purge names the record whose id the store holds when two name this store's file", async () => {
    mine = {
      success: true,
      data: {
        projects: [
          { id: 'old-record', slug: 'aquex-ai-old', name: NAME, localDbPath: dbPath },
          {
            id: '0f5f04b2-7e66-4390-a492-c2f5f8f1757f',
            slug: STORED,
            name: NAME,
            localDbPath: dbPath,
          },
        ],
      },
    };
    const result = await rbookDbPurge({ projectRoot: projectRoot(), confirm: true });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(`'${STORED}'`);
    expect(result.error?.message).not.toContain('aquex-ai-old');
    expect(result.error?.suggestion).toMatch(/rbook_session/);
  });

  it('purge refuses when /mine cannot be read, never purging on a guess', async () => {
    mine = { success: true, data: { projects: 'not a list' } };
    const result = await rbookDbPurge({ projectRoot: projectRoot(), confirm: true });
    expect(result.success).toBe(false);
    expect(seen.some((request) => request.path === '/api/sync/purge')).toBe(false);
  });

  it("purge takes a derived slug /mine lists with this store's own file", async () => {
    mine = {
      success: true,
      data: {
        projects: [
          { id: 'mine-id', slug: DERIVED, name: NAME, localDbPath: dbPath, lastSyncAt: null },
        ],
      },
    };
    const result = await rbookDbPurge({ projectRoot: projectRoot(), confirm: true });
    expect(result.success).toBe(true);
    expect(seen.map((request) => request.path)).toEqual(['/api/projects/mine', '/api/sync/purge']);
    expect(slugsAsked()).toEqual([DERIVED]);
    expect(result.warnings).toContainEqual(expect.stringMatching(/derived/));
  });
});

describe('a failed read of the stored slug is never taken for an absent one', () => {
  beforeEach(() => {
    const original = RbookDatabaseClient.prototype.getOne;
    jest.spyOn(RbookDatabaseClient.prototype, 'getOne').mockImplementation(function (
      this: RbookDatabaseClient,
      ...args: Parameters<RbookDatabaseClient['getOne']>
    ) {
      if (/key = 'dashboard_slug'/.test(String(args[0])))
        return { success: false, error: { code: 'DB_QUERY_FAILED', message: 'disk I/O error' } };
      return original.apply(this, args);
    } as RbookDatabaseClient['getOne']);
  });

  it('status answers with last_sync_at null and says why, asking for no derived slug', async () => {
    const result = await rbookStatus({ projectRoot: projectRoot() });
    expect(result.success).toBe(true);
    expect(result.data && 'last_sync_at' in result.data && result.data.last_sync_at).toBeNull();
    expect(result.warnings).toContainEqual(expect.stringMatching(/disk I\/O error/));
    expect(slugsAsked()).toEqual([]);
  });

  it('onboard answers without sync health and says why', async () => {
    const result = await rbookAgentOnboard({ projectRoot: projectRoot() });
    expect(result.success).toBe(true);
    expect(result.data?.syncHealth ?? null).toBeNull();
    expect(result.warnings).toContainEqual(expect.stringMatching(/disk I\/O error/));
    expect(slugsAsked()).toEqual([]);
  });

  it.each([
    ['reconcile', () => rbookDbReconcile({ projectRoot: projectRoot() })],
    ['orphans', () => identifyPgOrphans({ projectRoot: projectRoot() })],
    ['purge', () => rbookDbPurge({ projectRoot: projectRoot(), confirm: true })],
  ])('%s refuses, naming the failed read, and sends nothing', async (_name, run) => {
    const result = await run();
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/disk I\/O error/);
    expect(seen.filter((request) => request.path.startsWith('/api/sync/'))).toEqual([]);
  });
});

describe("the 6-path checklist's other paths", () => {
  // Path 1: a store on the legacy layout, cmos/db/cmos.sqlite, as 21 projects on this Mac were.
  it('a legacy-layout store sends its stored slug, and purge ties a derived one to cmos/db/cmos.sqlite', async () => {
    const legacy = path.join(projectRoot(), LEGACY.recordDirectory);
    fs.renameSync(path.join(projectRoot(), 'rbook'), legacy);
    const legacyDb = path.join(legacy, 'db', LEGACY.databaseFile);
    fs.renameSync(path.join(legacy, 'db', 'rbook.sqlite'), legacyDb);
    RbookDetector.resetInstance();
    expect((await rbookDbReconcile({ projectRoot: projectRoot() })).success).toBe(true);
    expect(slugsAsked()).toEqual([STORED]);

    dbPath = legacyDb;
    setMetadata('dashboard_slug', null);
    seen = [];
    mine = {
      success: true,
      data: { projects: [{ id: 'x', slug: DERIVED, name: NAME, localDbPath: legacyDb }] },
    };
    const purged = await rbookDbPurge({ projectRoot: projectRoot(), confirm: true });
    expect(purged.success).toBe(true);
    expect(slugsAsked()).toEqual([DERIVED]);
  });

  // Path 4: metadata.value is NOT NULL, so an empty stored slug is the nearest thing to a NULL one.
  it('an empty stored slug reads as none stored', async () => {
    setMetadata('dashboard_slug', '');
    const result = await rbookStatus({ projectRoot: projectRoot() });
    expect(result.success).toBe(true);
    expect(slugsAsked()).toEqual([DERIVED]);
    expect(result.warnings).toContainEqual(expect.stringMatching(/derived from the project name/));
  });

  // Path 2: the readers take no upload lease, and a write lock another connection holds leaves their
  // WAL reads of the stored slug untouched.
  it('reads the stored slug while another connection holds the write lock', async () => {
    const holder = new Database(dbPath);
    holder.pragma('journal_mode = WAL');
    holder.exec('BEGIN IMMEDIATE');
    try {
      const result = await rbookStatus({ projectRoot: projectRoot() });
      expect(result.success).toBe(true);
      expect(slugsAsked()).toEqual([STORED]);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});

// #808: a numeric project_name in the identity made rbook_status throw "projectName.toLowerCase is
// not a function" (probe X, §7, verified by run). The fallback reads only a string, and with no slug to
// name status asks nothing: an unscoped request answers every project's latest sync (critic round 1, F1).
it.each([
  ['a numeric', 42],
  ['an empty', ''],
])(
  'rbook_status answers on %s project_name with last_sync_at null, saying why',
  async (_case, name) => {
    setMetadata('dashboard_slug', null);
    const db = new Database(dbPath);
    try {
      const row = db
        .prepare("SELECT content FROM contexts WHERE id = 'project_identity'")
        .get() as {
        content: string;
      };
      const identity = JSON.parse(row.content) as Record<string, unknown>;
      identity.project_name = name;
      db.prepare("UPDATE contexts SET content = ? WHERE id = 'project_identity'").run(
        JSON.stringify(identity)
      );
    } finally {
      db.close();
    }
    const result = await rbookStatus({ projectRoot: projectRoot() });
    expect(result.success).toBe(true);
    expect(result.data && 'last_sync_at' in result.data && result.data.last_sync_at).toBeNull();
    expect(result.warnings).toContainEqual(
      expect.stringMatching(/neither a stored dashboard slug/)
    );
    expect(seen.filter((request) => request.path === '/api/sync/status')).toEqual([]);
  }
);
