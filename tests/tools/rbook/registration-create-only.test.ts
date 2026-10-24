// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Fresh stores register through an atomic create-only dashboard route, never a name-based purge.
// ABOUTME: Real SQLite uploads and optional RBOOK_UPLOAD_FIXTURE copies verify refusal without id adoption.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { uploadFailure } from '../../../src/tools/rbook/dashboard-upload-attempt';
import { formatUploadNotice } from '../../../src/tools/rbook/dashboard-upload-notice';
import { checkAndRegister } from '../../../src/tools/rbook/checkpoint-registration';
import { __drainCheckpointBackfill } from '../../../src/tools/rbook/checkpoint-backfill';
import { __resetDashboardUploadScheduler } from '../../../src/tools/rbook/dashboard-upload-scheduler';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { seedRbookDb } from '../../helpers/seedRbookDb';
import { call } from '../../helpers/replica-fixture';

interface RemoteProject {
  id: string;
  projectName: string;
  slug: string;
  archived: boolean;
  isOwner: boolean;
  snapshot: Buffer;
}
interface LocalProject {
  root: string;
  file: string;
  id: string;
}
let tmp: string;
let server: http.Server;
let client: DashboardClient;
let projects: RemoteProject[];
let requests: string[];
let purges: number;
let missingCreateRoute: boolean;
let handlerErrors: unknown[];
let graph: ProjectGraphRegistry;
const envKeys = [
  'RBOOK_CONFIG_DIR',
  'RBOOK_CHECKPOINT_SYNC',
  'RBOOK_DASHBOARD_URL',
  'RBOOK_DASHBOARD_API_KEY',
  'RBOOK_AGENT_ROLE',
  'RBOOK_PROJECT_ROOT',
] as const;
let saved: Record<string, string | undefined>;

function remote(name: string, fields: Partial<RemoteProject> = {}): RemoteProject {
  const project = {
    id: randomUUID(),
    projectName: name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    archived: false,
    isOwner: true,
    snapshot: Buffer.from('incumbent record must survive'),
    ...fields,
  };
  projects.push(project);
  return project;
}

function multipart(body: Buffer, contentType: string): { name: string; snapshot: Buffer } {
  const boundary = /boundary=(.+)$/.exec(contentType)![1];
  const field = body.indexOf(Buffer.from('name="projectName"\r\n\r\n'));
  const start = field + Buffer.byteLength('name="projectName"\r\n\r\n');
  const end = body.indexOf(Buffer.from(`\r\n--${boundary}`), start);
  const sqliteStart = body.indexOf(Buffer.from('SQLite format 3\0'));
  const sqliteEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), sqliteStart);
  if (field < 0 || sqliteStart < 0 || end < start || sqliteEnd < sqliteStart)
    throw new Error('Registration did not contain a name and a real SQLite upload.');
  return {
    name: body.subarray(start, end).toString().trim(),
    snapshot: body.subarray(sqliteStart, sqliteEnd),
  };
}

beforeEach(async () => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-register-new-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  delete process.env.RBOOK_CHECKPOINT_SYNC;
  delete process.env.RBOOK_AGENT_ROLE;
  delete process.env.RBOOK_PROJECT_ROOT;
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  CredentialStore.resetInstance();
  graph = await ProjectGraphRegistry.create({
    configDir: process.env.RBOOK_CONFIG_DIR,
    ephemeralRoots: [],
  });
  projects = [];
  requests = [];
  purges = 0;
  missingCreateRoute = false;
  handlerErrors = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const url = req.url ?? '';
        requests.push(url);
        res.setHeader('Content-Type', 'application/json');
        const answer = (status: number, data: unknown) => {
          res.statusCode = status;
          res.end(JSON.stringify(data));
        };
        if (url === '/api/projects/me') {
          answer(200, {
            data: {
              user: { id: 'user-tester', username: 'tester' },
              projects: projects
                .filter((p) => !p.archived)
                .map((p) => ({
                  id: p.id,
                  name: p.projectName,
                  slug: p.slug,
                  isOwner: p.isOwner,
                  owner: p.isOwner ? 'tester' : 'another-owner',
                })),
            },
          });
          return;
        }
        if (url !== '/api/projects/register-new' && url !== '/api/projects/register') {
          answer(404, { error: 'Unexpected request' });
          return;
        }
        if (url === '/api/projects/register-new' && missingCreateRoute) {
          answer(404, { error: 'This older dashboard has no create-only route' });
          return;
        }
        const upload = multipart(Buffer.concat(chunks), String(req.headers['content-type']));
        const existing = projects.find((p) => p.isOwner && p.projectName === upload.name);
        if (url === '/api/projects/register') purges += 1;
        if (existing && url === '/api/projects/register-new') {
          answer(409, {
            success: false,
            error: {
              code: 'PROJECT_NAME_CONFLICT',
              message: `You already own "${existing.projectName}".`,
              existingProject: {
                id: existing.id,
                projectName: existing.projectName,
                slug: existing.slug,
                archived: existing.archived,
              },
            },
          });
          return;
        }
        // This synchronous check/insert models the dashboard's unique owner/name transaction.
        // The legacy branch deliberately overwrites, so accidental fallback destroys the witness.
        const slug = upload.name.toLowerCase().replace(/\s+/g, '-');
        const created =
          existing ??
          remote(upload.name, {
            slug: projects.some((p) => p.isOwner && p.slug === slug) ? `${slug}-2` : slug,
          });
        created.snapshot = upload.snapshot;
        answer(201, {
          success: true,
          data: {
            projectId: created.id,
            slug: created.slug,
            reregistered: Boolean(existing),
          },
        });
      } catch (error) {
        handlerErrors.push(error);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.RBOOK_DASHBOARD_URL = baseUrl;
  process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_loopback';
  client = new DashboardClient({ baseUrl, apiKey: 'cmk_loopback' });
});

afterEach(async () => {
  await __drainCheckpointBackfill();
  await __resetDashboardUploadScheduler();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  CredentialStore.resetInstance();
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const key of envKeys)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  expect(handlerErrors).toEqual([]);
});

async function local(folder: string, name = 'Same Name'): Promise<LocalProject> {
  const root = path.join(tmp, folder);
  const id = randomUUID();
  const file = seedRbookDb(root, { projectId: id, projectName: name });
  if (process.env.RBOOK_UPLOAD_FIXTURE) {
    fs.rmSync(file);
    const original = new Database(process.env.RBOOK_UPLOAD_FIXTURE, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      await original.backup(file);
    } finally {
      original.close();
    }
  }
  const db = new Database(file);
  try {
    db.exec(
      "DELETE FROM metadata WHERE key IN ('dashboard_registered','dashboard_project_id','dashboard_slug','owner','dashboard_username')"
    );
    const upsert = db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)');
    upsert.run('project_id', id);
    upsert.run('project_name', name);
    const row = db.prepare("SELECT content FROM contexts WHERE id='project_identity'").get() as {
      content: string;
    };
    db.prepare("UPDATE contexts SET content=? WHERE id='project_identity'").run(
      JSON.stringify({
        ...JSON.parse(row.content),
        project_id: id,
        project_name: name,
        [LEGACY.identityAddressKey]: '',
      })
    );
    db.exec('CREATE TABLE IF NOT EXISTS registration_witness(value TEXT)');
    db.prepare('INSERT INTO registration_witness VALUES (?)').run(folder);
  } finally {
    db.close();
  }
  graph.register({ project_id: id, store_path: root, name });
  return { root, file, id };
}

function metadata(project: LocalProject): Record<string, string> {
  const db = new Database(project.file, { readonly: true });
  try {
    return Object.fromEntries(
      (
        db.prepare('SELECT key,value FROM metadata').all() as Array<{ key: string; value: string }>
      ).map((r) => [r.key, r.value])
    );
  } finally {
    db.close();
  }
}

function assertUnregistered(project: LocalProject): void {
  const rows = metadata(project);
  expect(rows.dashboard_registered).toBeUndefined();
  expect(rows.dashboard_project_id).toBeUndefined();
  expect(rows.project_id).toBe(project.id);
  expect(purges).toBe(0);
  expect(requests).not.toContain('/api/projects/register');
}

it.each([false, true])(
  'refuses an owned exact name (archived=%s) without adopting or purging it',
  async (archived) => {
    const incumbent = remote('Same Name', { archived });
    const before = Buffer.from(incumbent.snapshot);
    const project = await local('new-copy');
    expect(process.env.RBOOK_CHECKPOINT_SYNC).toBeUndefined();
    const result = await checkAndRegister(project.root, client, 'legacy-env');
    expect(result?.error?.code).toBe('PROJECT_NAME_CONFLICT');
    expect(result?.error?.message).toContain('Same Name');
    expect(result?.error?.currentState).toMatchObject({
      existingProject: {
        id: incumbent.id,
        projectName: 'Same Name',
        slug: incumbent.slug,
        archived,
      },
    });
    expect(result?.error?.suggestion).toMatch(/rbook_project\(action="init"/);
    expect(result?.error?.suggestion).toMatch(/delete[\s\S]*close again/i);
    expect(result?.error?.suggestion).toMatch(/old cop[\s\S]*stop/i);
    expect(result?.error?.suggestion).toMatch(/SSH[\s\S]*owner[\s\S]*join/i);
    expect(result?.error?.suggestion).toContain('reasonbook copy --to');
    expect(result?.error?.suggestion).toContain('remoteRoot="<copied project folder>"');
    expect(result?.error?.suggestion).toMatch(/shared[\s\S]*join|join[\s\S]*shared/i);
    expect(result?.error?.suggestion).toContain('rbook_project(action="join", via="dashboard"');
    expect(result?.projectSlug).toBeNull();
    assertUnregistered(project);
    expect(incumbent.snapshot).toEqual(before);
    expect(requests).toContain('/api/projects/register-new');
  }
);

it.each(['shared-with', 'case-distinct'])(
  'does not mistake a %s name for an owned exact collision',
  async (kind) => {
    const incumbent = remote(kind === 'case-distinct' ? 'same name' : 'Same Name', {
      isOwner: kind !== 'shared-with',
    });
    const before = Buffer.from(incumbent.snapshot);
    const project = await local('different-record');
    const result = await checkAndRegister(project.root, client, 'legacy-env');
    expect(result?.error).toBeUndefined();
    expect(metadata(project).dashboard_registered).toBe('true');
    expect(metadata(project).dashboard_project_id).not.toBe(incumbent.id);
    expect(result?.expectedSlug).toBe(result?.projectSlug);
    expect(incumbent.snapshot).toEqual(before);
    expect(purges).toBe(0);
    expect(requests).toContain('/api/projects/register-new');
  }
);

it('two fresh stores racing for one name yield one winner whose uploaded record survives', async () => {
  const stores = await Promise.all([local('first'), local('second')]);
  const results = await Promise.all(
    stores.map((p) => checkAndRegister(p.root, client, 'legacy-env'))
  );
  expect(results.filter((r) => r?.error?.code === 'PROJECT_NAME_CONFLICT')).toHaveLength(1);
  expect(results.filter((r) => r?.projectSlug && !r.error)).toHaveLength(1);
  expect(projects).toHaveLength(1);
  const winner = stores.find((p) => metadata(p).dashboard_project_id === projects[0]!.id)!;
  const loser = stores.find((p) => p !== winner)!;
  expect(winner).toBeDefined();
  assertUnregistered(loser);
  const uploadedFile = path.join(tmp, 'winner.sqlite');
  fs.writeFileSync(uploadedFile, projects[0]!.snapshot);
  const uploaded = new Database(uploadedFile, { readonly: true });
  try {
    expect(uploaded.prepare('SELECT value FROM registration_witness').pluck().get()).toBe(
      path.basename(winner.root)
    );
  } finally {
    uploaded.close();
  }
  expect(requests.filter((url) => url === '/api/projects/register-new')).toHaveLength(2);
});

it('an older dashboard refusing the create-only route never causes a legacy registration fallback', async () => {
  missingCreateRoute = true;
  const project = await local('older-dashboard');
  const result = await client.registerProject({
    projectName: 'Same Name',
    sqlitePath: project.file,
  });
  expect(result.success).toBe(false);
  expect(result.error?.currentState).toMatchObject({ httpStatus: 404 });
  expect(requests).toEqual(['/api/projects/register-new']);
  expect(projects).toHaveLength(0);
  assertUnregistered(project);
});

it('an explicit MCP session close records its local completion while refusing a conflicting first upload', async () => {
  const incumbent = remote('Same Name');
  const before = Buffer.from(incumbent.snapshot);
  const project = await local('mcp-close');
  const started = await call('rbook_session', {
    action: 'start',
    type: 'custom',
    title: 'First upload',
    projectRoot: project.root,
  });
  expect(started.success).toBe(true);
  const closed = await call('rbook_session', {
    action: 'complete',
    sessionId: started.data!.sessionId,
    summary: 'Keep this record separate',
    projectRoot: project.root,
  });
  expect(closed.success).toBe(true);
  await __drainCheckpointBackfill();
  expect(requests).toContain('/api/projects/register-new');
  expect(requests).not.toContain('/api/sync/sqlite-backfill');
  assertUnregistered(project);
  expect(graph.readUploadState(project.id)?.lastError).toContain('Same Name');
  expect(incumbent.snapshot).toEqual(before);
});

it('keeps every collision remedy visible after persisting the failed upload and rendering its notice', async () => {
  const project = await local('conflict-notice');
  const error = {
    code: 'PROJECT_NAME_CONFLICT',
    message: 'Registration refused: You already own "Same Name". Nothing was uploaded.',
    suggestion:
      'Rename this project with rbook_project(action="init", projectRoot="<project folder>", projectName="<different name>"). ' +
      'If the old copy is gone, delete the old project on the dashboard, then close again; old copies stop uploading. ' +
      'If the existing record is shared and reachable, remove only this fresh store, then join the existing shared record with ' +
      'rbook_project(action="join", via="dashboard", projectRoot="<empty project folder>", project="<shared rbook:// address>").',
  };
  const outcome = await uploadFailure(project.root, error);
  graph.markUploadOwed(project.id, Date.now(), true);
  const lease = graph.claimUpload(project.id, true)!;
  expect(lease).toBeTruthy();
  expect(graph.finishUpload(project.id, lease, outcome)).toBe(true);
  const notice = formatUploadNotice(graph.readUploadState(project.id)!);
  expect(notice).toContain(error.message);
  expect(notice).toContain(error.suggestion);
});
