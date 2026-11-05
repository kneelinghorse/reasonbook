// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A scratch store, home and loopback dashboard for the rename command's identity contract.
// ABOUTME: Records remote writes and registry upload state so refusals cannot silently change either.

import { jest } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { once } from 'events';
import { runCli } from '../../src/cli';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { seedRbookDb } from './seedRbookDb';

export async function renameFixture() {
  const saved = { ...process.env };
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-rename-')));
  const home = path.join(tmp, 'home');
  const root = path.join(tmp, 'project');
  fs.mkdirSync(home);
  process.env.HOME = home;
  // Jest virtualizes process.env; Node's native homedir otherwise still sees the real HOME.
  jest.spyOn(os, 'homedir').mockReturnValue(home);
  for (const key of [
    'RBOOK_CONFIG_DIR',
    'CMOS_CONFIG_DIR',
    'RBOOK_PROJECT_ROOT',
    'CMOS_PROJECT_ROOT',
    'RBOOK_PROJECT_ID',
    'CMOS_PROJECT_ID',
    'RBOOK_AGENT_ROLE',
  ])
    delete process.env[key];
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  let file = seedRbookDb(root, {
    projectId: 'rename-local',
    projectName: 'Before',
    slug: 'before',
    owner: 'tester',
    dashboardProjectId: 'rename-remote',
    rbookAddress: 'rbook://tester/before',
  });
  const query = <T>(fn: (db: Database.Database) => T): T => {
    const db = new Database(file);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const metadata = (key: string, value: string | null) =>
    query((db) =>
      value === null
        ? db.prepare('DELETE FROM metadata WHERE key=?').run(key)
        : db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)').run(key, value)
    );
  metadata('dashboard_registered', 'true');
  query((db) =>
    db
      .prepare("UPDATE contexts SET content=? WHERE id='master_context'")
      .run(JSON.stringify({ project_identity: { name: 'Before', keep: 'untouched' }, keep: 123 }))
  );
  const graph = await ProjectGraphRegistry.create({ ephemeralRoots: [] });
  graph.register({ project_id: 'rename-local', store_path: root, name: 'Before' });
  const registryFile = path.join(graph.configDirectory, 'project-graph.sqlite');
  if (registryFile !== path.join(home, '.config/rbook/project-graph.sqlite'))
    throw new Error(`Unexpected fixture registry: ${registryFile}`);
  const registry = <T>(fn: (db: Database.Database) => T): T => {
    const db = new Database(registryFile);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };
  const uploadState = () =>
    registry((db) => {
      const row = db
        .prepare("SELECT * FROM projects WHERE project_id='rename-local'")
        .get() as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(row).filter(([key]) => key.startsWith('upload_') || key === 'last_synced_at')
      );
    });
  const snapshot = () =>
    query((db) => ({
      metadata: db.prepare('SELECT key,value FROM metadata ORDER BY key').all(),
      contexts: db.prepare('SELECT id,content,updated_at FROM contexts ORDER BY id').all(),
    }));
  const remote = {
    id: 'rename-remote',
    name: 'Before',
    slug: 'before',
    localDbPath: file,
    username: 'tester',
    archivedAt: null as string | null,
    listed: true,
    patchStatus: 200,
    patchMode: 'normal' as 'normal' | 'commit-disconnect' | 'commit-timeout' | 'disconnect',
    uploadStatus: 200,
    beforePatch: undefined as (() => void | Promise<void>) | undefined,
    beforeUpload: undefined as (() => void | Promise<void>) | undefined,
  };
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks).toString();
        const url = req.url ?? '';
        requests.push({ method: req.method ?? '', url, body });
        const reply = (status: number, value: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        const project = {
          id: remote.id,
          name: remote.name,
          slug: remote.slug,
          localDbPath: remote.localDbPath,
          isOwner: true,
          owner: remote.username,
          address: `rbook://${remote.username}/${remote.slug}`,
          archivedAt: remote.archivedAt,
        };
        if (url === '/api/projects/me')
          return reply(200, {
            data: {
              user: { id: 'user-tester', username: remote.username },
              projects: remote.listed ? [project] : [],
            },
          });
        if (url === '/api/projects/mine')
          return reply(200, { data: { projects: remote.listed ? [project] : [] } });
        if (url === '/api/projects/directory/public') return reply(200, { projects: [project] });
        if (url.startsWith('/api/sync/status'))
          return reply(200, {
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
              totalMirrorRows: 0,
              totalSyncLogEntries: 0,
              unprocessedSyncLogEntries: 0,
              failedSyncLogEntries: 0,
              lastSyncAt: new Date(Date.now() - 1000).toISOString(),
              oldestUnprocessedAt: null,
              projectCount: 1,
            },
          });
        if (/^\/api\/sync\/projects\/[^/]+\/state$/.test(url))
          return reply(200, {
            success: true,
            data: {
              sprints: [],
              missions: [],
              sessions: [],
              decisions: [],
              learnings: [],
              dependencies: [],
            },
          });
        if (url === '/api/sync/purge')
          return reply(200, {
            success: true,
            data: { projectSlug: JSON.parse(body).projectSlug, purged: {} },
          });
        if (req.method === 'PATCH' && url === `/api/projects/${remote.id}`) {
          await remote.beforePatch?.();
          if (remote.patchStatus !== 200)
            return reply(remote.patchStatus, { error: 'Rename refused' });
          if (remote.patchMode === 'disconnect') return req.socket.destroy();
          const next = JSON.parse(body) as { name: string; slug: string };
          const updated = {
            id: remote.id,
            oldName: remote.name,
            newName: next.name,
            oldSlug: remote.slug,
            newSlug: next.slug,
          };
          remote.name = next.name;
          remote.slug = next.slug;
          if (remote.patchMode === 'commit-disconnect') return req.socket.destroy();
          if (remote.patchMode === 'commit-timeout') return;
          return reply(200, { success: true, updated });
        }
        if (url === '/api/sync/sqlite-backfill') {
          await remote.beforeUpload?.();
          return reply(
            remote.uploadStatus,
            remote.uploadStatus === 200
              ? { data: { success: true, counts: {}, errors: [], durationMs: 1 } }
              : { error: 'Upload unavailable' }
          );
        }
        return reply(404, { error: `Unexpected ${req.method} ${url}` });
      })().catch((error) => {
        res.writeHead(500);
        res.end(String(error));
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new DashboardClient({
    baseUrl: base,
    apiKey: 'rename-project-key',
    timeoutMs: 1000,
  });
  jest.spyOn(DashboardClient, 'fromEnvForProject').mockResolvedValue({
    success: true,
    data: { client, keySource: 'project-scoped', matchedProjectRoot: root },
  });
  const run = async (args: string[] = []) => {
    let out = '',
      err = '';
    const code = await runCli(
      ['rename', '--name', 'After', '--slug', 'after', '--project-root', root, ...args],
      {
        env: process.env,
        cwd: tmp,
        readStdin: async () => '',
        stdout: (text) => {
          out += text;
        },
        stderr: (text) => {
          err += text;
        },
      }
    );
    return { code, out, err, result: out.trim().startsWith('{') ? JSON.parse(out) : undefined };
  };
  return {
    tmp,
    home,
    root,
    base,
    remote,
    requests,
    graph,
    registryFile,
    client,
    query,
    metadata,
    registry,
    uploadState,
    snapshot,
    run,
    get file() {
      return file;
    },
    legacy() {
      fs.renameSync(path.join(root, 'rbook'), path.join(root, 'cmos'));
      fs.renameSync(
        path.join(root, 'cmos/db/rbook.sqlite'),
        path.join(root, 'cmos/db/cmos.sqlite')
      );
      file = path.join(root, 'cmos/db/cmos.sqlite');
      remote.localDbPath = file;
      RbookDetector.resetInstance();
    },
    async close() {
      jest.restoreAllMocks();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      ProjectGraphRegistry.resetInstance();
      RbookDetector.resetInstance();
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export type RenameFixture = Awaited<ReturnType<typeof renameFixture>>;
