// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Stops real stdio server children while their loopback dashboard upload is still pending.
// ABOUTME: Proves closes drain real uploads, interrupted leases recover, and only owned copies are removed.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { RawStdioServer } from '../../helpers/raw-stdio-server';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import {
  prepareUploadServerSources,
  uploadServerSourceLoader,
} from '../../helpers/upload-server-source';

const repo = path.resolve(__dirname, '../../..');
let directory: string;
let child: RawStdioServer | undefined;
let dashboard: http.Server | undefined;
let compiled: string;

const loader = (): string => uploadServerSourceLoader(compiled);

beforeAll(() => {
  compiled = prepareUploadServerSources(repo);
}, 180_000);

afterAll(() => {
  if (compiled) fs.rmSync(compiled, { recursive: true, force: true });
});

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-shutdown-'));
});

afterEach(async () => {
  if (child && child.child.exitCode === null && child.child.signalCode === null) {
    await child.close('SIGTERM');
  }
  child = undefined;
  if (dashboard) {
    dashboard.closeAllConnections();
    await new Promise<void>((resolve) => dashboard!.close(() => resolve()));
  }
  dashboard = undefined;
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

it.each(['SIGINT', 'SIGTERM', 'stdin close'] as const)(
  '%s removes a pending upload copy before exiting, without touching another process or the source',
  async (shutdown) => {
    const project = path.join(directory, 'project');
    seedRbookDb(project, { projectId: 'shutdown-test', projectName: 'Shutdown test' });
    const tmp = path.join(directory, 'tmp');
    fs.mkdirSync(tmp);
    const otherCopy = path.join(tmp, 'rbook-dashboard-upload-other-process');
    fs.mkdirSync(otherCopy);
    fs.writeFileSync(path.join(otherCopy, 'rbook.sqlite'), 'another process owns this copy');
    const source = path.join(directory, 'source.sqlite');
    const db = new Database(source);
    db.exec("CREATE TABLE witness(value TEXT); INSERT INTO witness VALUES ('keep the source');");
    db.close();
    const before = fs.readFileSync(source);

    let received!: () => void;
    const uploading = new Promise<void>((resolve) => {
      received = resolve;
    });
    dashboard = http.createServer((request, response) => {
      if (request.url !== '/api/sync/sqlite-backfill') {
        response.writeHead(404).end();
        return;
      }
      request.resume();
      request.once('end', received);
      // Keep the upload pending until shutdown; finally-based cleanup cannot run yet.
    });
    await new Promise<void>((resolve) => dashboard!.listen(0, '127.0.0.1', resolve));
    const port = (dashboard.address() as { port: number }).port;

    // Load actual TypeScript without writing the real dist or mocking server lifecycle, from the
    // source the warm-up compiled.
    const bootstrap = path.join(directory, 'server.cjs');
    fs.writeFileSync(
      bootstrap,
      `${loader()}
(async () => {
  const server = require(${JSON.stringify(path.join(repo, 'src/index.ts'))}).__test__;
  server.setShutdownBounds({ endMs: 100, signalMs: 100 });
  await server.main(['--project-root', ${JSON.stringify(project)}]);
  const { DashboardClient } = require(${JSON.stringify(path.join(repo, 'src/tools/rbook/dashboard-client.ts'))});
  const { withUploadSnapshot } = require(${JSON.stringify(path.join(repo, 'src/tools/rbook/dashboard-upload.ts'))});
  const resolved = await DashboardClient.fromEnvForProject(${JSON.stringify(project)}, {
    baseUrl: 'http://127.0.0.1:${port}', apiKey: 'test-upload-shutdown'
  });
  if (!resolved.success) throw new Error(JSON.stringify(resolved.error));
  await withUploadSnapshot(${JSON.stringify(source)}, (file) => resolved.data.client.syncSqliteFile(file, 'shutdown-test'));
})().catch((error) => { console.error(error); process.exit(1); });
`
    );
    child = new RawStdioServer(bootstrap, directory, {
      PATH: process.env.PATH ?? path.dirname(process.execPath),
      RBOOK_PROJECT_ROOT: project,
      RBOOK_CONFIG_DIR: path.join(directory, 'config'),
      RBOOK_AGENT_ROLE: 'review',
      RBOOK_CHECKPOINT_SYNC: 'off',
      RBOOK_SHARED_SYNC: 'off',
      TMPDIR: tmp,
      TMP: tmp,
      TEMP: tmp,
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        uploading,
        child.exited.then((code) => {
          throw new Error(`Server exited before uploading (${code}): ${child!.stderr}`);
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Upload did not start: ${child!.stderr}`)),
            25000
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const copies = fs
      .readdirSync(tmp)
      .filter((name) => name.startsWith('rbook-dashboard-upload-'))
      .map((name) => path.join(tmp, name));
    expect(copies).toHaveLength(2);
    const ownCopy = copies.find((copy) => copy !== otherCopy)!;
    expect(fs.existsSync(path.join(ownCopy, LEGACY.databaseFile))).toBe(true);

    const exit = await child.close(shutdown === 'stdin close' ? undefined : shutdown);
    expect({ exit, copyRemains: fs.existsSync(ownCopy) }).toEqual({
      exit: 0,
      copyRemains: false,
    });
    expect(fs.readFileSync(source)).toEqual(before);
    expect(fs.readFileSync(path.join(otherCopy, 'rbook.sqlite'), 'utf8')).toBe(
      'another process owns this copy'
    );
  },
  45000
);

async function closeFixture(
  delay: number | null,
  beforeClaimMs = 0
): Promise<{
  project: string;
  start: () => Promise<void>;
  complete: () => Promise<void>;
  uploaded: Promise<void>;
  recover: () => void;
  posts: () => number;
  state: () => Record<string, unknown>;
}> {
  const project = path.join(directory, 'close-project');
  const dbPath = seedRbookDb(project, {
    projectId: 'close-test',
    projectName: 'Close test',
    dashboardProjectId: 'dashboard-close-test',
    owner: 'shutdown-owner',
    rbookAddress: 'rbook://shutdown-owner/close-test',
  });
  const db = new Database(dbPath);
  db.prepare("INSERT OR REPLACE INTO metadata VALUES ('dashboard_registered','true')").run();
  db.close();
  let uploadDelay = delay;
  let posts = 0;
  let received!: () => void;
  const uploaded = new Promise<void>((resolve) => (received = resolve));
  dashboard = http.createServer((request, response) => {
    if (request.url === '/api/projects/me') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({
          projects: [
            {
              id: 'dashboard-close-test',
              name: 'Close test',
              slug: 'close-test',
              owner: 'shutdown-owner',
            },
          ],
          user: { id: 'shutdown-owner-id', username: 'shutdown-owner' },
        })
      );
    } else if (request.url === '/api/sync/sqlite-backfill') {
      posts++;
      request.resume();
      request.once('end', () => {
        received();
        if (uploadDelay !== null)
          setTimeout(
            () =>
              response
                .writeHead(200, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ counts: {}, errors: [], durationMs: uploadDelay })),
            uploadDelay
          );
      });
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => dashboard!.listen(0, '127.0.0.1', resolve));
  const port = (dashboard.address() as { port: number }).port;
  const bootstrap = path.join(directory, 'close-server.cjs');
  fs.writeFileSync(
    bootstrap,
    `${loader()}
// Keep the accepted close before its lease claim until after stdin ends.
const uploads = require(${JSON.stringify(path.join(repo, 'src/tools/rbook/dashboard-upload.ts'))});
const claim = uploads.withUploadLease;
uploads.withUploadLease = async (...args) => {
  if (${beforeClaimMs}) await new Promise((resolve) => setTimeout(resolve, ${beforeClaimMs}));
  return claim(...args);
};
require(${JSON.stringify(path.join(repo, 'src/index.ts'))}).runServer(['--project-root', ${JSON.stringify(project)}]);
`
  );
  const start = async (): Promise<void> => {
    child = new RawStdioServer(
      bootstrap,
      directory,
      {
        PATH: process.env.PATH ?? path.dirname(process.execPath),
        RBOOK_CONFIG_DIR: path.join(directory, 'config'),
        RBOOK_PROJECT_ROOT: project,
        RBOOK_DASHBOARD_URL: `http://127.0.0.1:${port}`,
        RBOOK_DASHBOARD_API_KEY: 'shutdown-fixture-key',
        RBOOK_SHARED_SYNC: 'off',
      },
      [],
      30_000
    );
    // s102-m13: allow loaded fixture startup to reach the upload scenario; the old
    // 10 s initialize watchdog expired first. Explicit shutdown bounds stay unchanged.
    await child.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'upload-shutdown', version: '1' },
    });
    child.notify('notifications/initialized');
  };
  const complete = async (): Promise<void> => {
    const opened = await child!.request('tools/call', {
      name: 'rbook_session',
      arguments: {
        action: 'start',
        type: 'check-in',
        title: 'Drain witness',
        projectRoot: project,
      },
    });
    expect(opened.structuredContent.success).toBe(true);
    const closed = await child!.request('tools/call', {
      name: 'rbook_session',
      arguments: {
        action: 'complete',
        sessionId: opened.structuredContent.data.sessionId,
        summary: 'Drain witness complete',
        projectRoot: project,
      },
    });
    expect(closed.structuredContent.success).toBe(true);
    expect(closed.structuredContent.data.dashboardUpload).toMatchObject({
      started: true,
      why: null,
    });
    expect(closed.content.map((part: { text?: string }) => part.text ?? '').join('\n')).toContain(
      'Dashboard upload: started for this close'
    );
  };
  await start();
  return {
    project,
    start,
    complete,
    uploaded,
    recover: () => {
      uploadDelay = 0;
    },
    posts: () => posts,
    state: () => {
      const registry = new Database(path.join(directory, 'config', 'project-graph.sqlite'), {
        readonly: true,
      });
      try {
        return registry
          .prepare("SELECT * FROM projects WHERE project_id='close-test'")
          .get() as Record<string, unknown>;
      } finally {
        registry.close();
      }
    },
  };
}

it.each([false, true])(
  'R1 drains the close upload after stdin ends, including a closed stderr pipe (%s)',
  async (closedStderr) => {
    const fixture = await closeFixture(300, 100);
    await fixture.complete();
    if (closedStderr) child!.child.stderr.destroy();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(await child!.close()).toBe(0);
    expect(fixture.posts()).toBe(1);
    expect(fixture.state()).toMatchObject({
      upload_last_outcome: 'success',
      upload_lease_token: null,
    });
  },
  45_000
);

it('manual backfill reports an owned hanging lease and shutdown still releases that holder', async () => {
  const fixture = await closeFixture(null);
  await fixture.complete();
  await fixture.uploaded;
  const heldToken = fixture.state().upload_lease_token;
  const backfill = await child!.request('tools/call', {
    name: 'rbook_db',
    arguments: { action: 'backfill', projectRoot: fixture.project },
  });
  expect(backfill.structuredContent).toMatchObject({
    success: false,
    error: { code: 'UPLOAD_IN_PROGRESS' },
  });
  expect(fixture.posts()).toBe(1);
  expect(fixture.state().upload_lease_token).toBe(heldToken);
  expect(await child!.close('SIGTERM')).toBe(0);
  expect(fixture.state()).toMatchObject({
    upload_last_outcome: 'interrupted',
    upload_lease_token: null,
  });
}, 45_000);

it('stdin drain includes manual backfill whose own lease is still uploading', async () => {
  const fixture = await closeFixture(300);
  // The request may lose its transport response at stdin end; the durable upload must still finish.
  const request = child!
    .request('tools/call', {
      name: 'rbook_db',
      arguments: { action: 'backfill', projectRoot: fixture.project },
    })
    .catch(() => undefined);
  await fixture.uploaded;
  expect(fixture.state().upload_lease_token).not.toBeNull();
  expect(await child!.close()).toBe(0);
  await request;
  expect(fixture.posts()).toBe(1);
  expect(fixture.state()).toMatchObject({
    upload_last_outcome: 'success',
    upload_lease_token: null,
  });
}, 45_000);

it.each(['SIGTERM', 'SIGKILL'] as const)(
  'R2/R3 %s leaves debt recoverable by the next process without waiting for expiry',
  async (signal) => {
    const fixture = await closeFixture(null);
    await fixture.complete();
    await fixture.uploaded;
    const started = Date.now();
    const exit = await child!.close(signal);
    expect(Date.now() - started).toBeLessThan(4_000);
    if (signal === 'SIGTERM') {
      expect(exit).toBe(0);
      expect(fixture.state()).toMatchObject({
        upload_last_outcome: 'interrupted',
        upload_lease_token: null,
      });
    } else expect(child!.child.signalCode).toBe('SIGKILL');
    fixture.recover();
    await fixture.start();
    if (signal === 'SIGKILL') await fixture.complete();
    else
      await child!.request('tools/call', {
        name: 'rbook_status',
        arguments: { projectRoot: fixture.project },
      });
    expect(await child!.close()).toBe(0);
    expect(fixture.posts()).toBeGreaterThanOrEqual(2);
    expect(fixture.state()).toMatchObject({
      upload_last_outcome: 'success',
      upload_lease_token: null,
    });
  },
  45_000
);
