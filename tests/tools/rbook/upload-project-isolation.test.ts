// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A single real MCP server must hold a deleted project without stopping another project.
// ABOUTME: Manual upload, explicit close and later status all read the same durable per-project hold.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { RawStdioServer } from '../../helpers/raw-stdio-server';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import {
  prepareUploadServerSources,
  uploadServerSourceLoader,
} from '../../helpers/upload-server-source';

it('one shared MCP server stops only the deleted project across manual uploads and closes', async () => {
  const repo = path.resolve(__dirname, '../../..');
  const compiled = prepareUploadServerSources(repo);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-isolation-'));
  let child: RawStdioServer | undefined;
  const posts: string[] = [];
  const projects = ['gone', 'healthy'].map((name) => ({
    id: `remote-${name}`,
    name,
    slug: name,
    owner: 'owner',
    isOwner: true,
  }));
  const dashboard = http.createServer((req, res) => {
    const send = (status: number, data: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    };
    if (req.url === '/api/projects/me')
      return send(200, {
        data: { user: { id: 'owner-id', username: 'owner' }, projects: [projects[1]] },
      });
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      const slug = /name="projectSlug"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? '';
      posts.push(slug);
      if (slug === 'gone') send(410, { error: 'Deleted project', code: 'PROJECT_DELETED' });
      else send(200, { data: { counts: {}, errors: [], durationMs: 1 } });
    });
  });
  try {
    for (const project of projects) {
      const file = seedRbookDb(path.join(directory, project.slug), {
        projectId: project.slug,
        projectName: project.name,
        slug: project.slug,
        dashboardProjectId: project.id,
        owner: 'owner',
        rbookAddress: `rbook://owner/${project.slug}`,
      });
      const db = new Database(file);
      db.prepare("INSERT OR REPLACE INTO metadata VALUES ('dashboard_registered','true')").run();
      db.close();
    }
    await new Promise<void>((resolve) => dashboard.listen(0, '127.0.0.1', resolve));
    const bootstrap = path.join(directory, 'server.cjs');
    fs.writeFileSync(
      bootstrap,
      `${uploadServerSourceLoader(compiled)}\nrequire(${JSON.stringify(path.join(repo, 'src/index.ts'))}).runServer([]);`
    );
    child = new RawStdioServer(bootstrap, directory, {
      PATH: process.env.PATH ?? path.dirname(process.execPath),
      RBOOK_CONFIG_DIR: path.join(directory, 'config'),
      RBOOK_DASHBOARD_URL: `http://127.0.0.1:${(dashboard.address() as { port: number }).port}`,
      RBOOK_DASHBOARD_API_KEY: 'owner-key',
      RBOOK_SHARED_SYNC: 'off',
    });
    await child.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'isolation', version: '1' },
    });
    child.notify('notifications/initialized');
    const call = (project: string, name: string, args: Record<string, unknown>) =>
      child!.request('tools/call', {
        name,
        arguments: { ...args, projectRoot: path.join(directory, project) },
      });
    expect((await call('gone', 'rbook_db', { action: 'backfill' })).structuredContent.success).toBe(
      false
    );
    const healthy = await call('healthy', 'rbook_db', { action: 'backfill' });
    expect(healthy.structuredContent.success).toBe(true);
    expect(
      (await call('gone', 'rbook_db', { action: 'backfill' })).structuredContent.error.code
    ).toBe('UPLOAD_HELD');
    const start = await call('gone', 'rbook_session', {
      action: 'start',
      type: 'check-in',
      title: 'held close',
    });
    const close = await call('gone', 'rbook_session', {
      action: 'complete',
      sessionId: start.structuredContent.data.sessionId,
      summary: 'Local work still closes',
    });
    expect(close.structuredContent.data.dashboardUpload).toMatchObject({
      started: false,
      why: 'deleted',
    });
    await child.close();
    expect(posts).toEqual(['gone', 'healthy']);
  } finally {
    if (child && child.child.exitCode === null && child.child.signalCode === null)
      await child.close('SIGTERM');
    dashboard.closeAllConnections();
    await new Promise<void>((resolve) => dashboard.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(compiled, { recursive: true, force: true });
  }
}, 120000);
