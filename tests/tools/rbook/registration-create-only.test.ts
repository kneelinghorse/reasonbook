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
import { checkAndRegister, markRegistered } from '../../../src/tools/rbook/checkpoint-registration';
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
  /** Absent when the listing leaves the field out (#907: an absent isOwner is not owned). */
  isOwner?: boolean;
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
/** Every sync the double received: the slug it targets and the store bytes it carried (critic A, F6). */
let syncs: Array<{ slug: string; snapshot: Buffer; accepted: boolean }>;
/**
 * The record the stored project key ('project-key') belongs to, or null for any. As the dashboard
 * does (4227aa6, key-scope.ts), a sync signed by it for another record is refused with a 403.
 */
let projectKeyScope: string | null;
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

/** The slug a sync targets and the SQLite bytes it carries. */
function syncUpload(body: Buffer, contentType: string): { slug: string; snapshot: Buffer } {
  const boundary = /boundary=(.+)$/.exec(contentType)![1];
  const field = Buffer.from('name="projectSlug"\r\n\r\n');
  const start = body.indexOf(field) + field.length;
  const end = body.indexOf(Buffer.from(`\r\n--${boundary}`), start);
  const sqliteStart = body.indexOf(Buffer.from('SQLite format 3\0'));
  const sqliteEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), sqliteStart);
  if (start < field.length || end < start || sqliteStart < 0 || sqliteEnd < sqliteStart)
    throw new Error('A sync did not carry a slug and a real SQLite upload.');
  return {
    slug: body.subarray(start, end).toString().trim(),
    snapshot: body.subarray(sqliteStart, sqliteEnd),
  };
}

/** The registration_witness row of the store bytes a request carried: which folder they came from. */
function witness(snapshot: Buffer): string {
  const file = path.join(tmp, `witness-${randomUUID()}.sqlite`);
  fs.writeFileSync(file, snapshot);
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT value FROM registration_witness').pluck().get() as string;
  } finally {
    db.close();
  }
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
  syncs = [];
  projectKeyScope = null;
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
        if (url === '/api/sync/sqlite-backfill') {
          const sync = syncUpload(Buffer.concat(chunks), String(req.headers['content-type']));
          const target = projects.find((p) => p.slug === sync.slug);
          if (
            req.headers.authorization === 'Bearer project-key' &&
            projectKeyScope !== null &&
            target?.id !== projectKeyScope
          ) {
            syncs.push({ ...sync, accepted: false });
            answer(403, {
              success: false,
              error:
                "This key belongs to another project; use that project's key, or your machine's user key.",
            });
            return;
          }
          // An accepted sync replaces the record's contents, so a test can see whose bytes it holds.
          if (target) target.snapshot = sync.snapshot;
          syncs.push({ ...sync, accepted: true });
          answer(200, { data: { success: true, counts: {}, errors: [], durationMs: 1 } });
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

it.each([
  [
    'PROJECT_NAME_CONFLICT',
    'Rename this project with rbook_project(action="init", projectRoot="<project folder>", projectName="<different name>"). ' +
      'If the old copy is gone, delete the old project on the dashboard, then close again; old copies stop uploading. ' +
      'If the existing record is shared and reachable, remove only this fresh store, then join the existing shared record with ' +
      'rbook_project(action="join", via="dashboard", projectRoot="<empty project folder>", project="<shared rbook:// address>").',
  ],
  // s109-m04 (round 3, NEW-2): the project-key and name refusals keep their remedies too.
  [
    'REGISTRATION_NEEDS_USER_KEY',
    'Sign in with rbook_auth(action="login_init"), then login_complete. Then revoke this folder\'s project key with rbook_auth(action="revoke", projectRoot="<project folder>") and close again.',
  ],
  [
    'DASHBOARD_NAME_MISMATCH',
    'If this store is "meridian", give it that name with rbook_project(action="init", projectRoot="<project folder>", projectName="meridian") and close again.',
  ],
])(
  'keeps the %s remedy visible after persisting the failed upload and rendering its notice',
  async (code, suggestion) => {
    const project = await local('conflict-notice');
    const error = {
      code,
      message: 'Registration refused: You already own "Same Name". Nothing was uploaded.',
      suggestion,
    };
    const outcome = await uploadFailure(project.root, error);
    graph.markUploadOwed(project.id, Date.now(), true);
    const lease = graph.claimUpload(project.id, true)!;
    expect(lease).toBeTruthy();
    expect(graph.finishUpload(project.id, lease, outcome)).toBe(true);
    const notice = formatUploadNotice(graph.readUploadState(project.id)!);
    expect(notice).toContain(error.message);
    expect(notice).toContain(error.suggestion);
  }
);

/**
 * s109-m04 (#907; settled item 12). Meridian's store held the dashboard's id, slug and owner but no
 * `dashboard_registered` flag, so every explicit close sent a registration, and with its
 * project-scoped key the dashboard refused each one with a 400: the store never uploaded. A store
 * whose id the listing names as this account's own, with its owner confirmed, now writes its flag and
 * takes the registered path; no registration is ever sent with a project-scoped key.
 */
describe('#907: a store the dashboard lists as owned uploads instead of registering again', () => {
  /** The dashboard's id, slug and owner, and no flag unless one is given. */
  function known(project: LocalProject, incumbent: Pick<RemoteProject, 'id' | 'slug'>): void {
    const db = new Database(project.file);
    try {
      const upsert = db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)');
      upsert.run('dashboard_project_id', incumbent.id);
      upsert.run('dashboard_slug', incumbent.slug);
      upsert.run('owner', 'tester');
      upsert.run('dashboard_username', 'tester');
    } finally {
      db.close();
    }
  }
  const registrations = (): string[] =>
    requests.filter(
      (url) => url === '/api/projects/register-new' || url === '/api/projects/register'
    );

  it('with the folder’s project-scoped key, an owned listing of its id takes the registered path as a heal, its flag left for the upload', async () => {
    const incumbent = remote('Meridian');
    const project = await local('meridian', 'Meridian');
    known(project, incumbent);
    expect(metadata(project).dashboard_registered).toBeUndefined();
    const result = await checkAndRegister(project.root, client, 'project-scoped');
    expect(result?.error).toBeUndefined();
    expect(result?.projectSlug).toBe(incumbent.slug);
    expect(result?.healPending).toBe(true);
    // Round 3, NEW-1: the flag waits until the dashboard has taken this close's upload.
    expect(metadata(project).dashboard_registered).toBeUndefined();
    expect(requests).toContain('/api/projects/me');
    expect(registrations()).toEqual([]);
  });

  it('with a user key, the same store keeps 4.10.0’s registration path: refused as a name conflict, never healed', async () => {
    // Round 2, verifier A, N1: a user key's sync is not held to one project, so a store holding a
    // record's id and name might be another store; only the folder's own project key heals.
    const incumbent = remote('Meridian');
    const before = Buffer.from(incumbent.snapshot);
    const project = await local('meridian', 'Meridian');
    known(project, incumbent);
    const result = await checkAndRegister(project.root, client, 'legacy-env');
    expect(result?.error?.code).toBe('PROJECT_NAME_CONFLICT');
    expect(metadata(project).dashboard_registered).toBeUndefined();
    expect(registrations()).toEqual(['/api/projects/register-new']);
    expect(incumbent.snapshot).toEqual(before);
  });

  it.each([false, undefined])(
    'a listing of its id with isOwner %s writes no flag, and a project-scoped key sends no registration',
    async (isOwner) => {
      const incumbent = remote('Meridian', { isOwner });
      const project = await local('meridian', 'Meridian');
      known(project, incumbent);
      const result = await checkAndRegister(project.root, client, 'project-scoped');
      expect(result?.error?.code).toBe('REGISTRATION_NEEDS_USER_KEY');
      expect(result?.error?.suggestion).toContain('rbook_auth(action="login_init")');
      // Revoke by folder reads the row closes sign with; list can hide it (critic A, F2).
      expect(result?.error?.suggestion).toContain(
        `rbook_auth(action="revoke", projectRoot="${project.root}")`
      );
      expect(metadata(project).dashboard_registered).toBeUndefined();
      expect(registrations()).toEqual([]);
    }
  );

  it.each(['an unlisted id', 'no dashboard id'])(
    'a project-scoped key with %s sends no registration and says to sign in with a user key',
    async (kind) => {
      const project = await local('unlisted', 'Unlisted');
      if (kind === 'an unlisted id') known(project, { id: randomUUID(), slug: 'unlisted' });
      const result = await checkAndRegister(project.root, client, 'project-scoped');
      expect(result?.error?.code).toBe('REGISTRATION_NEEDS_USER_KEY');
      expect(result?.error?.message).toContain('Nothing was uploaded');
      expect(metadata(project).dashboard_registered).toBeUndefined();
      expect(registrations()).toEqual([]);
    }
  );

  it('a second store named like a record and holding its id, closed with a user key, never uploads over it', async () => {
    // Round 2, verifier A, N1: the old matcher's name tier could leave a store in exactly this state.
    const incumbent = remote('Meridian');
    const before = Buffer.from(incumbent.snapshot);
    const project = await local('meridian-second', 'Meridian');
    known(project, incumbent);
    const started = await call('rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'A second store closes',
      projectRoot: project.root,
    });
    expect(started.success).toBe(true);
    const closed = await call('rbook_session', {
      action: 'complete',
      sessionId: started.data!.sessionId,
      summary: 'It must not upload over the record',
      projectRoot: project.root,
    });
    expect(closed.success).toBe(true);
    await __drainCheckpointBackfill();
    expect(syncs).toEqual([]);
    expect(registrations()).toEqual(['/api/projects/register-new']);
    expect(metadata(project).dashboard_registered).toBeUndefined();
    expect(graph.readUploadState(project.id)?.lastError).toContain('Meridian');
    expect(incumbent.snapshot).toEqual(before);
  });

  it('a store listed as owned under another name, with the project key, is refused by name, not as unregistered', async () => {
    // Round 2, verifier A, N2: "meridian" on the dashboard, "Meridian" here.
    const incumbent = remote('meridian');
    const project = await local('meridian-case', 'Meridian');
    known(project, incumbent);
    const result = await checkAndRegister(project.root, client, 'project-scoped');
    expect(result?.error?.code).toBe('DASHBOARD_NAME_MISMATCH');
    expect(result?.error?.message).toContain('"meridian"');
    expect(result?.error?.message).toContain('"Meridian"');
    expect(result?.error?.suggestion).toContain(
      `rbook_project(action="init", projectRoot="${project.root}", projectName="meridian")`
    );
    expect(metadata(project).dashboard_registered).toBeUndefined();
    expect(registrations()).toEqual([]);
  });

  it('an explicit MCP session close with the folder’s project key uploads once and never registers', async () => {
    const incumbent = remote('Meridian');
    const before = Buffer.from(incumbent.snapshot);
    const project = await local('meridian-mcp', 'Meridian');
    known(project, incumbent);
    await useProjectKey(project.root);
    const started = await call('rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'The owed upload',
      projectRoot: project.root,
    });
    expect(started.success).toBe(true);
    const closed = await call('rbook_session', {
      action: 'complete',
      sessionId: started.data!.sessionId,
      summary: 'Upload what is owed',
      projectRoot: project.root,
    });
    expect(closed.success).toBe(true);
    await __drainCheckpointBackfill();
    expect(registrations()).toEqual([]);
    expect(requests.filter((url) => url === '/api/sync/sqlite-backfill')).toHaveLength(1);
    expect(metadata(project).dashboard_registered).toBe('true');
    expect(graph.readUploadState(project.id)?.lastError ?? null).toBeNull();
    // The one sync goes to the listed project and carries this store's own bytes (critic A, F6).
    expect(syncs.map((sync) => sync.slug)).toEqual([incumbent.slug]);
    expect(witness(syncs[0]!.snapshot)).toBe('meridian-mcp');
    // The record now holds this store's bytes: the store is that project, signed by its own key.
    expect(incumbent.snapshot).not.toEqual(before);
    expect(witness(incumbent.snapshot)).toBe('meridian-mcp');
  });

  /** Meridian's credentials: a stored project-scoped key for this folder, which signs its closes. */
  async function useProjectKey(root: string): Promise<void> {
    delete process.env.RBOOK_DASHBOARD_API_KEY;
    const store = await CredentialStore.create();
    const issuedAt = new Date(Date.now() - 1000).toISOString();
    await store.upsertUserScopedKey('parent', {
      key: 'owner-key',
      label: 'test',
      issuedAt,
      lastUsedAt: issuedAt,
    });
    await store.upsertProjectKey(root, {
      key: 'project-key',
      keyId: 'project',
      parentKeyId: 'parent',
      label: 'test',
      issuedAt,
      lastUsedAt: issuedAt,
    });
  }

  async function closeSession(root: string): Promise<void> {
    const started = await call('rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'A close with the project key',
      projectRoot: root,
    });
    expect(started.success).toBe(true);
    const closed = await call('rbook_session', {
      action: 'complete',
      sessionId: started.data!.sessionId,
      summary: 'Upload what is owed',
      projectRoot: root,
    });
    expect(closed.success).toBe(true);
    await __drainCheckpointBackfill();
  }

  it('an MCP close signed by the project-scoped key uploads a listed store once and never registers', async () => {
    const incumbent = remote('Meridian');
    const project = await local('meridian-key', 'Meridian');
    known(project, incumbent);
    await useProjectKey(project.root);
    await closeSession(project.root);
    expect(registrations()).toEqual([]);
    expect(requests.filter((url) => url === '/api/sync/sqlite-backfill')).toHaveLength(1);
    expect(metadata(project).dashboard_registered).toBe('true');
    expect(graph.readUploadState(project.id)?.lastError ?? null).toBeNull();
  });

  it('an MCP close signed by the project-scoped key refuses an unlisted store, and the stored outcome keeps the remedy', async () => {
    const project = await local('unlisted-key', 'Unlisted');
    known(project, { id: randomUUID(), slug: 'unlisted' });
    await useProjectKey(project.root);
    await closeSession(project.root);
    expect(registrations()).toEqual([]);
    expect(requests).not.toContain('/api/sync/sqlite-backfill');
    const lastError = graph.readUploadState(project.id)?.lastError ?? '';
    expect(lastError).toContain("this project's own key cannot register it");
    // The notice reads this outcome, so the way out is shown where the refusal is.
    expect(lastError).toContain('rbook_auth(action="login_init")');
    expect(lastError).toContain('rbook_auth(action="revoke"');
  });

  it('a store holding another project’s id, as the old owner matcher left it, registers its own record, never uploading over that project', async () => {
    // Critic A, F1: until 3f913561 the matcher wrote another project's id and slug into a store.
    const bravo = remote('Bravo');
    const before = Buffer.from(bravo.snapshot);
    const alpha = await local('alpha', 'Alpha');
    known(alpha, bravo);
    // With the project key the listed name is named back; with a user key it registers its own.
    expect((await checkAndRegister(alpha.root, client, 'project-scoped'))?.error?.code).toBe(
      'DASHBOARD_NAME_MISMATCH'
    );
    expect(metadata(alpha).dashboard_registered).toBeUndefined();
    await closeSession(alpha.root);
    expect(syncs.map((sync) => sync.slug)).not.toContain(bravo.slug);
    expect(requests).toContain('/api/projects/register-new');
    const own = projects.find((project) => project.projectName === 'Alpha')!;
    expect(own).toBeDefined();
    expect(syncs.map((sync) => sync.slug)).toEqual([own.slug]);
    expect(witness(syncs[0]!.snapshot)).toBe('alpha');
    expect(metadata(alpha).dashboard_project_id).toBe(own.id);
    expect(bravo.snapshot).toEqual(before);
  });

  it('a store with no recorded owner does not heal on that close; the next close, its owner confirmed, does', async () => {
    const incumbent = remote('Meridian');
    const project = await local('meridian-no-owner', 'Meridian');
    known(project, incumbent);
    const db = new Database(project.file);
    try {
      db.exec("DELETE FROM metadata WHERE key IN ('owner', 'dashboard_username')");
    } finally {
      db.close();
    }
    const first = await checkAndRegister(project.root, client, 'project-scoped');
    expect(first?.error?.code).toBe('REGISTRATION_NEEDS_USER_KEY');
    expect(metadata(project).dashboard_registered).toBeUndefined();
    // The sign-in's identity is now the store's owner, so the next listing confirms it.
    expect(metadata(project).owner).toBe('tester');
    const second = await checkAndRegister(project.root, client, 'project-scoped');
    expect(second?.error).toBeUndefined();
    expect(second?.healPending).toBe(true);
    expect(registrations()).toEqual([]);
  });

  it('a flag of false heals as an absent one does', async () => {
    const incumbent = remote('Meridian');
    const project = await local('meridian-false', 'Meridian');
    known(project, incumbent);
    const db = new Database(project.file);
    try {
      db.prepare(
        "INSERT OR REPLACE INTO metadata(key,value) VALUES ('dashboard_registered','false')"
      ).run();
    } finally {
      db.close();
    }
    const result = await checkAndRegister(project.root, client, 'project-scoped');
    expect(result?.error).toBeUndefined();
    expect(result?.healPending).toBe(true);
    expect(registrations()).toEqual([]);
  });

  it('a flag that cannot be saved after the upload is said, and the next close with the key marks it again', async () => {
    // Critic A, F3, as round 3 (NEW-1) moved the write after the upload.
    const incumbent = remote('Meridian');
    const project = await local('meridian-locked', 'Meridian');
    known(project, incumbent);
    const db = new Database(project.file);
    try {
      db.exec(
        `CREATE TRIGGER flag_refused BEFORE INSERT ON metadata WHEN NEW.key = 'dashboard_registered'
         BEGIN SELECT RAISE(ABORT, 'flag refused'); END`
      );
    } finally {
      db.close();
    }
    const result = await checkAndRegister(project.root, client, 'project-scoped');
    expect(result?.healPending).toBe(true);
    const unsaved = await markRegistered(project.root);
    expect(unsaved).toContain('flag refused');
    expect(metadata(project).dashboard_registered).toBeUndefined();
    expect(registrations()).toEqual([]);
  });

  it('a store in the 2.1 schema, older than Meridian’s 2.4, heals the same way', async () => {
    const incumbent = remote('Meridian');
    const root = path.join(tmp, 'old-schema');
    const file = path.join(root, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = randomUUID();
    const db = new Database(file);
    try {
      db.exec(
        fs.readFileSync(path.join(__dirname, '../../fixtures/old-schemas/schema-2.1.sql'), 'utf8')
      );
      const upsert = db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)');
      upsert.run('project_id', id);
      upsert.run('project_name', 'Meridian');
      db.prepare(
        "INSERT INTO contexts (id, source_path, content) VALUES ('project_identity', 'context/PROJECT_IDENTITY.json', ?)"
      ).run(JSON.stringify({ project_id: id, project_name: 'Meridian' }));
    } finally {
      db.close();
    }
    const project = { root, file, id };
    known(project, incumbent);
    const result = await checkAndRegister(root, client, 'project-scoped');
    expect(result?.error).toBeUndefined();
    expect(result?.projectSlug).toBe(incumbent.slug);
    expect(result?.healPending).toBe(true);
    // After the upload, the flag is written in the old schema's metadata table too.
    expect(await markRegistered(root)).toBeNull();
    expect(metadata(project).dashboard_registered).toBe('true');
    expect(registrations()).toEqual([]);
  });

  it('a heal the dashboard refuses leaves no flag, so a later user-key close cannot upload over the record (round 3, NEW-1)', async () => {
    // A second store named like a record and holding its id, in a folder whose project key belongs
    // to another record: its signed sync is refused, and with the flag written first a user-key
    // close after the key's revoke uploaded over the record.
    const incumbent = remote('Alpha');
    const other = remote('Alpha Two');
    const before = Buffer.from(incumbent.snapshot);
    const project = await local('alpha-second', 'Alpha');
    known(project, incumbent);
    await useProjectKey(project.root);
    projectKeyScope = other.id;
    await closeSession(project.root);
    expect(syncs.map((sync) => [sync.slug, sync.accepted])).toEqual([[incumbent.slug, false]]);
    expect(metadata(project).dashboard_registered).toBeUndefined();
    // The folder's key revoked (its local effect), then a close signed by the user key.
    await (await CredentialStore.create()).removeProjectKey(project.root);
    process.env.RBOOK_DASHBOARD_API_KEY = 'cmk_loopback';
    await closeSession(project.root);
    expect(syncs.filter((sync) => sync.accepted)).toEqual([]);
    expect(registrations()).toEqual(['/api/projects/register-new']);
    expect(graph.readUploadState(project.id)?.lastError).toContain('Alpha');
    expect(incumbent.snapshot).toEqual(before);
  });

  it('a listing that names the id as owned but gives no name offers no rename to "" (round 3, NEW-3)', async () => {
    const incumbent = remote('');
    const project = await local('meridian-unnamed', 'Meridian');
    known(project, incumbent);
    const result = await checkAndRegister(project.root, client, 'project-scoped');
    expect(result?.error?.code).toBe('DASHBOARD_NAME_MISMATCH');
    expect(result?.error?.message).toContain('gives it no name');
    expect(result?.error?.suggestion).not.toContain('projectName=""');
    expect(registrations()).toEqual([]);
  });

  it('a registered flag that cannot be read is said, never taken for a store that is not registered (round 3, NEW-4)', async () => {
    const incumbent = remote('Meridian');
    const project = await local('meridian-unread', 'Meridian');
    known(project, incumbent);
    const { RbookDatabaseClient } = await import('../../../src/tools/rbook/client');
    const original = RbookDatabaseClient.prototype.getOne;
    const spy = jest.spyOn(RbookDatabaseClient.prototype, 'getOne').mockImplementation(function (
      this: unknown,
      ...args: unknown[]
    ) {
      if (args[0] === "SELECT value FROM metadata WHERE key = 'dashboard_registered'")
        return {
          success: false,
          error: { code: 'DB_QUERY_FAILED', message: 'injected read failure' },
        };
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    } as never);
    try {
      const result = await checkAndRegister(project.root, client, 'project-scoped');
      expect(result?.error?.message).toContain('injected read failure');
      expect(result?.error?.code).not.toBe('DASHBOARD_NAME_MISMATCH');
      expect(result?.error?.code).not.toBe('REGISTRATION_NEEDS_USER_KEY');
      expect(registrations()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('a byte copy in another folder, holding the same ids, cannot open to close, so it never heals or uploads', async () => {
    const incumbent = remote('Meridian');
    const original = await local('meridian-original', 'Meridian');
    known(original, incumbent);
    const copyRoot = path.join(tmp, 'meridian-copy');
    const copyFile = path.join(copyRoot, 'rbook', 'db', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(copyFile), { recursive: true });
    fs.copyFileSync(original.file, copyFile);
    const copy = { root: copyRoot, file: copyFile, id: original.id };
    // A guard, not a change: the registry binds the project id to the original's folder, so the copy
    // is refused before any write, and so before the close whose upload could heal it (#907's
    // byte-copy case, E4). A copy on another machine is settled item 12's admitted residual.
    const started = await call('rbook_session', {
      action: 'start',
      type: 'custom',
      title: 'A copy closes',
      projectRoot: copyRoot,
    });
    expect(started.success).toBe(false);
    expect(started.error?.message).toContain('Project identity collision');
    await __drainCheckpointBackfill();
    expect(requests).toEqual([]);
    expect(metadata(copy).dashboard_registered).toBeUndefined();
    expect(metadata(original).dashboard_registered).toBeUndefined();
  });
});
