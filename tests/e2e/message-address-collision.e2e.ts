// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m07 — rbook_message send/list/directory over real MCP stdio against the BUILT dist/,
// ABOUTME: driven by a loopback stub serving the dashboard's verbatim recorded bodies.

/**
 * Sprint 86 m07 — the address-and-inbox surfaces, proven through the transport they ship over.
 *
 * WHY THIS EXISTS ALONGSIDE tests/tools/rbook/message-address-collision.test.ts. A handler-only
 * test is exactly what let `statusFilter`, `expiresAt` and `agentFeedback` each ship
 * declared-but-dead: the handler was right and nothing reached it. Three of this mission's
 * claims are only true if they survive the MCP dispatch boundary AND the formatter:
 *
 *   - the send advisory must appear in `content[0].text` — the channel an agent actually reads —
 *     and appear EXACTLY once, which no handler-level assertion about `result.warnings` can show;
 *   - `targetProjectId` / `targetProjectName` must reach `structuredContent`;
 *   - the inbox scope warning is gated on which CREDENTIAL ARM fired, and the arm is chosen by
 *     `DashboardClient.fromEnvForProject` reading the real CredentialStore off disk. Stubbing
 *     that predicate would assert the gate against itself, so instead each leg selects its arm
 *     hermetically via RBOOK_CONFIG_DIR + RBOOK_DASHBOARD_API_KEY and lets resolution really run.
 *
 * NO NETWORK, NO OPERATOR CREDENTIALS. Every leg binds an HTTP stub to 127.0.0.1 on an ephemeral
 * port and writes its own RBOOK_CONFIG_DIR under os.tmpdir(). The real
 * ~/.config/rbook/credentials.json holds live `cmk_` secrets and is never read or written.
 *
 * NO SILENT FAIL-OPEN. A missing dist/ or live store FAILS in the private tree. Only a
 * structurally identified public mirror skips, and the shared helper prints why.
 */

import { LEGACY } from '../../src/intelligence/legacy-compat';
import { afterAll, beforeAll, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { requiresPrivateEvidence } from '../helpers/public-mirror';
import { connectStdioServer, type StdioHarness } from './stdio-harness';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const PRIVATE = requiresPrivateEvidence({
  reason:
    'This built-server messaging E2E derives its scratch project from the private live Reasonbook store.',
  paths: { liveDb: 'rbook/db/rbook.sqlite' },
});

const PRO_ID = 'c02ea1cb-3db7-40b0-a263-7d17ef2a656f';
const MCP_ID = 'ec2b4987-dbc1-4f16-946e-9843c4080ac1';

const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/**
 * A scratch project whose store is a COPY of the live one, with its dashboard registration
 * metadata forced to known values so sender attribution resolves instead of failing closed.
 */
function scratchProject(prefix: string): string {
  const projectRoot = mkTmp(prefix);
  const dbDir = path.join(projectRoot, 'rbook', 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${PRIVATE.paths.liveDb}${suffix}`;
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dbDir, `rbook.sqlite${suffix}`));
  }
  const db = new Database(path.join(dbDir, 'rbook.sqlite'));
  db.prepare(
    `INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_registered', 'true')`
  ).run();
  db.prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_project_id', ?)`).run(
    PRO_ID
  );
  db.close();
  return projectRoot;
}

/** A credentials.json in a fresh scratch config dir, at the real file's mode. */
function scratchConfigDir(
  prefix: string,
  seed: {
    userScopedKeys?: Record<string, { key: string }>;
    projectKeys?: Record<string, { key: string; keyId: string; parentKeyId: string }>;
  }
): string {
  const configDir = mkTmp(prefix);
  const now = new Date().toISOString();
  fs.writeFileSync(
    path.join(configDir, 'credentials.json'),
    JSON.stringify(
      {
        version: 1,
        userScopedKeys: Object.fromEntries(
          Object.entries(seed.userScopedKeys ?? {}).map(([keyId, v]) => [
            keyId,
            { key: v.key, label: `e2e ${keyId}`, issuedAt: now, lastUsedAt: now },
          ])
        ),
        projectKeys: Object.fromEntries(
          Object.entries(seed.projectKeys ?? {}).map(([root, v]) => [
            path.resolve(root),
            {
              key: v.key,
              keyId: v.keyId,
              parentKeyId: v.parentKeyId,
              label: `e2e project ${v.keyId}`,
              issuedAt: now,
              lastUsedAt: now,
            },
          ])
        ),
        updatedAt: now,
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  return configDir;
}

// ─── The stub dashboard: verbatim recorded bodies ────────────────────────────

/** GET /api/projects/directory/public in its August 2026 shape: no isOwner, no description. */
const DIRECTORY_BODY = {
  projects: [
    {
      id: MCP_ID,
      name: 'cmos-mcp',
      slug: 'cmos-mcp',
      owner: 'derek',
      ownerDisplayName: 'Derek',
      [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/cmos-mcp`,
      createdAt: '2025-11-13T00:01:41.000Z',
    },
    {
      id: PRO_ID,
      name: 'CMOS-MCP Pro',
      slug: 'cmos-mcp-pro',
      owner: 'derek',
      ownerDisplayName: 'Derek',
      [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/cmos-mcp-pro`,
      createdAt: '2026-01-04T18:22:10.000Z',
    },
    {
      id: '9566f5ce-f171-4e95-a24e-ad756c2b8807',
      name: `${LEGACY.proseName} Dashboard`,
      slug: 'cmos-dashboard',
      owner: 'derek',
      ownerDisplayName: 'Derek',
      [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/cmos-dashboard`,
      createdAt: '2025-12-01T00:00:00.000Z',
    },
  ],
  totalCount: 3,
};

/** GET /api/projects/me — asked only for a directory row that carries no isOwner (s110-m02). */
const MY_PROJECTS_BODY = {
  projects: [
    {
      id: PRO_ID,
      name: 'CMOS-MCP Pro',
      slug: 'cmos-mcp-pro',
      [LEGACY.wireAddressKey]: `${LEGACY.addressScheme}derek/cmos-mcp-pro`,
      isOwner: true,
    },
  ],
  totalCount: 1,
};

/** GET /api/messages (inbox, pending) — the live contradiction: an empty page, 7 unread. */
const EMPTY_PENDING_INBOX = { messages: [], unreadCount: 7, totalCount: 0 };

interface StubServer {
  port: number;
  posts: Array<{ url: string; body: unknown }>;
  close(): Promise<void>;
}

async function startStub(): Promise<StubServer> {
  const posts: Array<{ url: string; body: unknown }> = [];

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.startsWith('/api/messages')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          /* a malformed body is still a recorded POST */
        }
        posts.push({ url, body: parsed });
        send(200, { success: true, data: { id: 'msg-e2e-001', status: 'pending' } });
      });
      return;
    }

    if (url.startsWith('/api/messages/resolve')) {
      // The verbatim recorded shape: `resolved` is an OBJECT.
      const address = decodeURIComponent(url.split('address=')[1] ?? '');
      const slug = address.replace(LEGACY.addressScheme, '').split('/')[1] ?? '';
      const row = DIRECTORY_BODY.projects.find((p) => p.slug === slug);
      if (!row) return send(404, { error: 'not found' });
      return send(200, {
        success: true,
        resolved: { projectId: row.id, projectName: row.name, projectSlug: row.slug },
      });
    }

    if (url.startsWith('/api/messages')) return send(200, EMPTY_PENDING_INBOX);
    if (url.startsWith('/api/projects/directory/public')) return send(200, DIRECTORY_BODY);
    if (url.startsWith('/api/projects/me')) return send(200, MY_PROJECTS_BODY);

    // Anything else (startup key-recovery probes, sync) is out of scope for this suite.
    return send(404, { error: `unstubbed route ${url}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    posts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function connect(opts: {
  projectRoot: string;
  configDir: string;
  port: number;
  apiKeyEnv?: string;
  clientName: string;
}): Promise<StdioHarness> {
  return connectStdioServer({
    serverPath: DIST_ENTRY,
    cwd: opts.projectRoot,
    env: {
      ...(process.env as Record<string, string>),
      RBOOK_PROJECT_ROOT: opts.projectRoot,
      RBOOK_CONFIG_DIR: opts.configDir,
      RBOOK_DASHBOARD_URL: `http://127.0.0.1:${opts.port}`,
      RBOOK_CHECKPOINT_SYNC: 'off',
      RBOOK_DASHBOARD_API_KEY: opts.apiKeyEnv ?? '',
      RBOOK_DASHBOARD_USER: '',
      RBOOK_DASHBOARD_PASSWORD: '',
    },
    clientName: opts.clientName,
  });
}

PRIVATE.describe('rbook_message address collision + unread badge over stdio (s86-m07)', () => {
  beforeAll(() => {
    if (!fs.existsSync(DIST_ENTRY)) {
      throw new Error(
        `dist/index.js not found at ${DIST_ENTRY}. This suite drives the BUILT server; run ` +
          `\`npm run build\` first. It must not skip — a skipped transport test proves nothing.`
      );
    }
    if (!fs.existsSync(PRIVATE.paths.liveDb)) {
      throw new Error(
        `private live store not found at ${PRIVATE.paths.liveDb}; absence fails here unless the shared helper identified a structural public mirror.`
      );
    }
  });

  afterAll(() => {
    for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  // ─── send: the advisory reaches the text, exactly once, and never blocks ──

  it('sends to the ambiguous address, SUCCEEDS, and names the sibling once in the rendered text', async () => {
    const projectRoot = scratchProject('rbook-m07-send-');
    const configDir = scratchConfigDir('rbook-m07-send-cfg-', {
      userScopedKeys: { 'user-1': { key: 'cmk_user_live' } },
    });
    const stub = await startStub();
    let harness: StdioHarness | undefined;

    try {
      harness = await connect({
        projectRoot,
        configDir,
        port: stub.port,
        clientName: 'rbook-m07-send',
      });

      const res = await harness.callTool('rbook_message', {
        action: 'send',
        targetAddress: 'rbook://derek/cmos-mcp',
        type: 'question',
        summary: 'is this the project I meant?',
        projectRoot,
      });
      const text = harness.textOf(res);

      // The message was really delivered — the collision check may never block a send.
      expect(res.isError).not.toBe(true);
      expect(stub.posts).toHaveLength(1);
      expect(text).toContain('Message sent successfully');

      // The resolved project name AND the prefix sibling reach the channel an agent reads.
      expect(text).toContain("target resolves to project 'cmos-mcp'");
      expect(text).toContain('rbook://derek/cmos-mcp-pro');

      // EXACTLY once — a count, not a presence. One channel renders it; nothing renders it twice.
      expect(text.split('shares a slug prefix with').length - 1).toBe(1);

      // s86-m07 C3: who the address actually resolved to, on the wire.
      const data = harness.dataOf(res) as { targetProjectId?: string; targetProjectName?: string };
      expect(data.targetProjectId).toBe(MCP_ID);
      expect(data.targetProjectName).toBe('cmos-mcp');
    } finally {
      if (harness) await harness.close();
      await stub.close();
    }
  }, 120000);

  it('adds no warning line to an unambiguous send', async () => {
    const projectRoot = scratchProject('rbook-m07-clean-');
    const configDir = scratchConfigDir('rbook-m07-clean-cfg-', {
      userScopedKeys: { 'user-1': { key: 'cmk_user_live' } },
    });
    const stub = await startStub();
    let harness: StdioHarness | undefined;

    try {
      harness = await connect({
        projectRoot,
        configDir,
        port: stub.port,
        clientName: 'rbook-m07-clean',
      });

      const res = await harness.callTool('rbook_message', {
        action: 'send',
        targetAddress: 'rbook://derek/cmos-dashboard',
        type: 'question',
        summary: 'no collision here',
        projectRoot,
      });
      const text = harness.textOf(res);

      expect(text).toContain('Message sent successfully');
      expect(text).not.toContain('Warnings:');
      expect(text).not.toContain('shares a slug prefix with');
    } finally {
      if (harness) await harness.close();
      await stub.close();
    }
  }, 120000);

  // ─── directory: ambiguity + a real ownership signal ───────────────────────

  it('renders the ambiguity pair and marks the operator’s own project', async () => {
    const projectRoot = scratchProject('rbook-m07-dir-');
    const configDir = scratchConfigDir('rbook-m07-dir-cfg-', {
      userScopedKeys: { 'user-1': { key: 'cmk_user_live' } },
    });
    const stub = await startStub();
    let harness: StdioHarness | undefined;

    try {
      harness = await connect({
        projectRoot,
        configDir,
        port: stub.port,
        clientName: 'rbook-m07-dir',
      });

      const res = await harness.callTool('rbook_message', { action: 'directory', projectRoot });
      const text = harness.textOf(res);

      expect(text).toContain('AMBIGUOUS with rbook://derek/cmos-mcp-pro');
      expect(text).toContain('AMBIGUOUS with rbook://derek/cmos-mcp');
      // The dashboard row for cmos-dashboard has no prefix sibling and must not claim one.
      const dashboardLine = text
        .split('\n')
        .find((l) => l.includes('rbook://derek/cmos-dashboard'))!;
      expect(dashboardLine).not.toContain('AMBIGUOUS');

      const data = harness.dataOf(res) as {
        projects: Array<{ id: string; isOwner?: boolean; provenance?: { trust: string } }>;
      };
      expect(data.projects.find((p) => p.id === PRO_ID)?.provenance?.trust).toBe('local');
      expect(data.projects.find((p) => p.id === MCP_ID)?.provenance?.trust).toBe('foreign');
    } finally {
      if (harness) await harness.close();
      await stub.close();
    }
  }, 120000);

  // ─── list: the badge, per credential arm ──────────────────────────────────

  /**
   * The arm is NOT stubbed: each leg shapes the credential store and env so
   * `DashboardClient.fromEnvForProject` really selects arm 2 (project-scoped), arm 3
   * (user-scoped) or arm 4 (legacy-env), and the warning is read off the resulting answer.
   */
  async function listWith(
    leg: string,
    seed: { configDir: string; projectRoot: string; apiKeyEnv?: string }
  ): Promise<{ text: string; data: { warnings?: string[]; [k: string]: unknown } }> {
    const stub = await startStub();
    let harness: StdioHarness | undefined;
    try {
      harness = await connect({
        projectRoot: seed.projectRoot,
        configDir: seed.configDir,
        port: stub.port,
        apiKeyEnv: seed.apiKeyEnv,
        clientName: `rbook-m07-list-${leg}`,
      });
      const res = await harness.callTool('rbook_message', {
        action: 'list',
        tab: 'inbox',
        status: 'pending',
        projectRoot: seed.projectRoot,
      });
      return {
        text: harness.textOf(res),
        data: harness.dataOf(res) as { warnings?: string[] },
      };
    } finally {
      if (harness) await harness.close();
      await stub.close();
    }
  }

  it('user-scoped: warns, and the header no longer contradicts itself', async () => {
    const projectRoot = scratchProject('rbook-m07-user-');
    const configDir = scratchConfigDir('rbook-m07-user-cfg-', {
      userScopedKeys: { 'user-1': { key: 'cmk_user_live' } },
    });

    const { text, data } = await listWith('user', { configDir, projectRoot });

    // The live contradiction is gone: 0 rows can no longer be reported as "7 unread".
    expect(text).not.toContain('0 total, 7 unread');
    expect(text).toContain('0 unread in this view');
    expect(text).toContain('7 unread user-wide');
    expect(data.unreadCountUserWide).toBe(7);
    expect(data.unreadInThisView).toBe(0);
    expect((data as { unreadCount?: number }).unreadCount).toBeUndefined();

    const scoped = (data.warnings ?? []).filter((w) => w.includes('unreadCountUserWide'));
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toContain('user-scoped');
    // Rendered once, in the DATA channel this action owns.
    expect(text.split(scoped[0]!).length - 1).toBe(1);
  }, 120000);

  it('legacy-env: warns too — the predicate is a rule over KeySource, not an equality test', async () => {
    const projectRoot = scratchProject('rbook-m07-legacy-');
    // An EMPTY credential store, so arms 2 and 3 miss and the env key is what fires.
    const configDir = scratchConfigDir('rbook-m07-legacy-cfg-', {});

    const { data } = await listWith('legacy', {
      configDir,
      projectRoot,
      apiKeyEnv: 'cmk_legacy_env_key',
    });

    const scoped = (data.warnings ?? []).filter((w) => w.includes('unreadCountUserWide'));
    expect(scoped).toHaveLength(1);
    expect(scoped[0]).toContain('legacy-env');
  }, 120000);

  it('project-scoped: does NOT warn — this view really is scoped to one project', async () => {
    const projectRoot = scratchProject('rbook-m07-proj-');
    const configDir = scratchConfigDir('rbook-m07-proj-cfg-', {
      userScopedKeys: { 'user-1': { key: 'cmk_user_live' } },
      projectKeys: {
        [projectRoot]: { key: 'cmk_project_live', keyId: 'p-1', parentKeyId: 'user-1' },
      },
    });

    const { data } = await listWith('project', { configDir, projectRoot });

    const scoped = (data.warnings ?? []).filter((w) => w.includes('unreadCountUserWide'));
    expect(scoped).toHaveLength(0);
  }, 120000);
});
