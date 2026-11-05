// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Migration updates a verified dashboard record's local path, found through /api/projects/mine, without
// ABOUTME: creating a project; s110-m02 gives each reason the update cannot finish its own outcome (#944, #943).
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import http from 'http';
import { once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { migrateProject } from '../../src/cli/migrate';
import { PENDING } from '../../src/cli/migrate-store';
import { readProject } from '../../src/cli/doctor-read-records';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

/** s110-m02 (#944): a migrate answer's pending steps, read so this file also compiles at 7d7a3c28. */
const pendingOf = (result: { data?: unknown }): readonly string[] | undefined =>
  (result.data as { pending?: readonly string[] } | undefined)?.pending;

const ID = 'dashboard-stable-id';
type Answer = { status: number; body?: unknown; location?: string };
interface Account {
  username: string;
  mine: Answer;
  me?: Answer;
  post: Answer;
}

let tmp: string;
let root: string;
let home: string;
let server: http.Server;
let base: string;
let requests: Array<{ url: string; method: string; auth: string | undefined; body: string }>;
let accounts: Record<string, Account>;
let userKey: boolean;
let folderKey: boolean;

const preMove = () => path.join(root, 'cmos', 'db', 'cmos.sqlite');
const postMove = () => path.join(root, 'rbook', 'db', 'rbook.sqlite');
const listed = (localDbPath: string | null, extra: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    success: true,
    data: {
      projects: [
        {
          id: ID,
          slug: 'custom-incumbent-slug',
          name: 'Human display name',
          localDbPath,
          ...extra,
        },
      ],
    },
  },
});
/** A /mine answer listing none of the account's projects. */
const unlistedMine = (): Answer => ({
  status: 200,
  body: { success: true, data: { projects: [] } },
});
const confirmed = (): Answer => ({
  status: 302,
  location: `/projects/${ID}/shares?status=path_updated`,
});

function seed(at: string, metadata: Record<string, string | null>): void {
  const db = new Database(seedLegacyMigrationStore(at));
  const set = db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES (?,?)');
  const drop = db.prepare('DELETE FROM metadata WHERE key = ?');
  for (const [key, value] of Object.entries({
    project_id: 'local-stable-id',
    project_name: 'Human display name',
    dashboard_project_id: ID,
    dashboard_slug: 'custom-incumbent-slug',
    dashboard_registered: 'true',
    owner: 'derek',
    ...metadata,
  }))
    if (value === null) drop.run(key);
    else set.run(key, value);
  db.close();
}

beforeEach(async () => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-dashboard-')));
  root = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  seed(root, {});
  requests = [];
  userKey = true;
  folderKey = true;
  accounts = {
    'Bearer cmk_folder': { username: 'derek', mine: listed(preMove()), post: confirmed() },
    'Bearer cmk_user': { username: 'derek', mine: listed(preMove()), post: confirmed() },
  };
  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (s) => (body += s));
    req.on('end', () => {
      requests.push({ url: req.url!, method: req.method!, auth: req.headers.authorization, body });
      const account = accounts[req.headers.authorization ?? ''];
      const answer: Answer | undefined =
        req.url === '/api/projects/mine'
          ? account?.mine
          : req.url === '/api/projects/me'
            ? (account?.me ?? {
                status: 200,
                body: {
                  success: true,
                  data: { user: { id: 'u', username: account?.username }, projects: [] },
                },
              })
            : req.method === 'POST'
              ? account?.post
              : undefined;
      res.statusCode = answer?.status ?? 404;
      if (answer?.location) res.setHeader('Location', answer.location);
      if (answer?.body !== undefined) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(answer.body));
      } else res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const folder = new DashboardClient({ baseUrl: base, apiKey: 'cmk_folder' });
  const user = new DashboardClient({ baseUrl: base, apiKey: 'cmk_user' });
  // The folder's own project key answers for its folder; with no folder named, the user-key chain.
  jest.spyOn(DashboardClient, 'fromEnvForProject').mockImplementation(async (projectRoot) =>
    projectRoot === undefined
      ? userKey
        ? {
            success: true,
            data: { client: user, keySource: 'user-scoped', matchedProjectRoot: null },
          }
        : {
            success: false,
            error: { code: 'DASHBOARD_NOT_CONFIGURED', message: 'not signed in' },
          }
      : folderKey
        ? {
            success: true,
            data: { client: folder, keySource: 'project-scoped', matchedProjectRoot: root },
          }
        : {
            success: false,
            error: { code: 'DASHBOARD_NOT_CONFIGURED', message: 'no key for this folder' },
          }
  );
});
afterEach(async () => {
  jest.restoreAllMocks();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const options = (projectRoot = root) => ({
  projectRoot,
  env: { HOME: home },
  apply: true,
  checkProcesses: false,
});
const posts = () => requests.filter((r) => r.method === 'POST');
const marker = () =>
  JSON.parse(fs.readFileSync(path.join(root, PENDING), 'utf8')) as {
    steps: string[];
    backup?: string;
    remaining: string;
  };
const caseInsensitive = () => fs.existsSync(tmp.toUpperCase()) && fs.existsSync(tmp.toLowerCase());

describe('the record is repointed only from a file it already names (settled item 9)', () => {
  it('repoints the record /mine lists with the pre-move file, archived projects included (#943)', async () => {
    accounts['Bearer cmk_folder'].mine = listed(preMove(), {
      archivedAt: '2026-10-01T00:00:00.000Z',
    });
    const result = await migrateProject(options());
    expect(result).toMatchObject({ success: true, data: { moved: true } });
    expect(pendingOf(result)).toBeUndefined();
    expect(posts()).toHaveLength(1);
    expect(posts()[0].url).toBe(`/projects/${ID}/local-path`);
    expect(new URLSearchParams(posts()[0].body).get('localDbPath')).toBe(postMove());
    expect(requests.some((r) => r.url === '/api/projects/me')).toBe(false);
    expect(fs.existsSync(path.join(root, PENDING))).toBe(false);
  });

  it('repoints when the root is given through a symlink and the record names the real folder', async () => {
    const link = path.join(tmp, 'linked');
    fs.symlinkSync(root, link);
    expect((await migrateProject(options(link))).success).toBe(true);
    expect(posts()).toHaveLength(1);
  });

  it('repoints a case-variant spelling of the root on a disk that folds case, and only there', async () => {
    accounts['Bearer cmk_folder'].mine = listed(
      path.join(root.toUpperCase(), 'cmos', 'db', 'cmos.sqlite')
    );
    const result = await migrateProject(options());
    expect(result.success).toBe(true);
    expect(posts()).toHaveLength(caseInsensitive() ? 1 : 0);
  });

  // A case-folding disk keeps the folder's upper-case CMOS/ spelling (migrate-git.ts) while
  // registration recorded the lower-case path (legacy-compat.ts); on a disk that does not fold case,
  // a CMOS/ folder is no record at all.
  it('repoints a store kept in an upper-case CMOS/ folder whose record names the lower-case path', async () => {
    fs.renameSync(path.join(root, 'cmos'), path.join(root, 'CMOS-tmp'));
    fs.renameSync(path.join(root, 'CMOS-tmp'), path.join(root, 'CMOS'));
    const result = await migrateProject(options());
    if (caseInsensitive()) {
      expect(result.success).toBe(true);
      expect(new URLSearchParams(posts()[0].body).get('localDbPath')).toBe(postMove());
    } else {
      expect(result.success).toBe(false);
      expect(posts()).toHaveLength(0);
    }
  });

  it("ignores the marker's own folder: a record naming this store's file is repointed", async () => {
    accounts['Bearer cmk_folder'].post = { status: 503 };
    expect(pendingOf(await migrateProject(options()))).toEqual(['the dashboard path update']);
    fs.writeFileSync(
      path.join(root, PENDING),
      JSON.stringify({ ...marker(), folder: '../other/cmos' })
    );
    accounts['Bearer cmk_folder'].post = confirmed();
    const retry = await migrateProject(options());
    expect(retry.success).toBe(true);
    expect(new URLSearchParams(posts()[1].body).get('localDbPath')).toBe(postMove());
    expect(fs.existsSync(path.join(root, PENDING))).toBe(false);
  });

  it.each([
    ['no path', () => null, /names no file as its Local Database Path/],
    ['an upper-case tail', () => path.join(root, 'CMOS', 'db', 'cmos.sqlite'), /not this store's/],
    ['a relative path', () => 'cmos/db/cmos.sqlite', /not this store's/],
    [
      'a folder whose name only starts like the root',
      () => `${root}x/cmos/db/cmos.sqlite`,
      /not this store's/,
    ],
  ])(
    'stays pending for %s, with the form remedy, and sends no path update',
    async (_case, recorded, why) => {
      accounts['Bearer cmk_folder'].mine = listed(recorded());
      const result = await migrateProject(options());
      expect(result).toMatchObject({
        success: true,
        data: { moved: true, pending: ['the dashboard path update'] },
      });
      const line = result.data!.left.find((text) =>
        text.startsWith('Dashboard path update pending')
      )!;
      expect(line).toMatch(why);
      expect(line).toContain(`${base}/projects/${ID}/shares`);
      expect(line).toContain(postMove());
      expect(posts()).toHaveLength(0);
      expect(marker().steps).toEqual(['the dashboard path update']);
    }
  );

  it("calls a store whose record names another store's file a copy that must not take the record", async () => {
    const other = path.join(tmp, 'original');
    seed(other, {});
    accounts['Bearer cmk_folder'].mine = listed(path.join(other, 'cmos', 'db', 'cmos.sqlite'));
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /another store's file, so this store is a copy and must not take that record/
    );
    expect(marker().remaining).toMatch(/this store is a copy/);
    expect(posts()).toHaveLength(0);
  });

  it('reports a listed slug that differs without making it a reason, promising no adoption', async () => {
    accounts['Bearer cmk_folder'].mine = listed(preMove(), { slug: 'renamed-on-the-dashboard' });
    const result = await migrateProject(options());
    expect(result.success).toBe(true);
    expect(pendingOf(result)).toBeUndefined();
    expect(result.data!.left.join('\n')).toMatch(
      /under the slug 'renamed-on-the-dashboard', while this store holds 'custom-incumbent-slug'\./
    );
    expect(result.data!.left.join('\n')).not.toMatch(/adopts/);
    expect(posts()).toHaveLength(1);
  });

  // Critic round 1, F1: a record naming this store's own file in a spelling the tie refuses is never
  // called a copy; it gets the form remedy, which finishes the step.
  it.each([
    ['relative, run from the root', () => 'rbook/db/rbook.sqlite', () => root],
    // Run from another store's folder, a relative path finds that store's file, which says nothing
    // about the file the record names.
    [
      "relative, run from another store's folder",
      () => 'rbook/db/rbook.sqlite',
      () => {
        const other = path.join(tmp, 'elsewhere');
        fs.mkdirSync(path.join(other, 'rbook', 'db'), { recursive: true });
        fs.writeFileSync(path.join(other, 'rbook', 'db', 'rbook.sqlite'), '');
        return other;
      },
    ],
    ['with a ..', () => `${root}/sub/../rbook/db/rbook.sqlite`, () => root],
    // The tie compares the tail case-sensitively; a case-folding disk resolves this to the store's own file.
    ['in upper case', () => path.join(root, 'RBOOK', 'db', 'rbook.sqlite'), () => root],
  ])(
    'never calls this store a copy for a path that may name its own file: %s',
    async (_case, recorded, from) => {
      accounts['Bearer cmk_folder'].mine = listed(recorded());
      const cwd = process.cwd();
      fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
      process.chdir(from());
      try {
        const result = await migrateProject(options());
        const text = result.data!.left.join('\n');
        expect(pendingOf(result)).toEqual(['the dashboard path update']);
        expect(text).not.toMatch(/another store's file/);
        expect(text).toContain(`${base}/projects/${ID}/shares`);
        expect(marker().remaining).not.toMatch(/another store's file/);
      } finally {
        process.chdir(cwd);
      }
    }
  );

  // Critic rounds 2 to 4, R2-2, R3-2 and R4-1: the dashboard stores a Local Database Path as typed, so a
  // record can name a folder, or a file that is no store's database, and neither is a store's file.
  const write = (file: string) => () => fs.writeFileSync(file, 'notes\n');
  it.each([
    ["this store's own folder", () => root, () => undefined],
    ['its rbook/db folder', () => path.join(root, 'rbook', 'db'), () => undefined],
    [
      "a file in this store's folder",
      () => path.join(root, 'notes.txt'),
      () => write(path.join(root, 'notes.txt'))(),
    ],
    // Written before the move, under the folder the move renames.
    [
      'a file beside its database',
      () => path.join(root, 'rbook', 'db', 'notes.txt'),
      () => write(path.join(root, 'cmos', 'db', 'notes.txt'))(),
    ],
    // The store-tail check passes this one, so only the file check keeps it from the copy verdict.
    [
      "a folder whose path ends like a store's database",
      () => path.join(tmp, 'other', 'rbook', 'db', 'rbook.sqlite'),
      () =>
        fs.mkdirSync(path.join(tmp, 'other', 'rbook', 'db', 'rbook.sqlite'), { recursive: true }),
    ],
    [
      'a file outside any store',
      () => path.join(tmp, 'unrelated.txt'),
      () => write(path.join(tmp, 'unrelated.txt'))(),
    ],
    // Critic round 4, R4-1: as text this ends in a store tail, but the system follows L before the
    // `..`, so it names q/rbook.sqlite, a file outside any store. Built by hand: path.join drops a `..`.
    [
      'a file a `..` after a symlink reaches',
      () => path.join(tmp, 'd', 'rbook', 'db', 'L') + '/../rbook.sqlite',
      () => {
        fs.mkdirSync(path.join(tmp, 'q', 'r'), { recursive: true });
        write(path.join(tmp, 'q', 'rbook.sqlite'))();
        fs.mkdirSync(path.join(tmp, 'd', 'rbook', 'db'), { recursive: true });
        fs.symlinkSync(path.join(tmp, 'q', 'r'), path.join(tmp, 'd', 'rbook', 'db', 'L'));
      },
    ],
  ])(
    'gives a record naming %s the form remedy, never the copy verdict',
    async (_case, recorded, make) => {
      make();
      accounts['Bearer cmk_folder'].mine = listed(recorded());
      const result = await migrateProject(options());
      const text = result.data!.left.join('\n');
      expect(pendingOf(result)).toEqual(['the dashboard path update']);
      expect(text).not.toMatch(/another store's file/);
      expect(text).toContain(`${base}/projects/${ID}/shares`);
      expect(posts()).toHaveLength(0);
    }
  );

  // The signed-in account's list holds the record, which names this store's file, so it is repointed
  // through that account, though the folder key is the owner's (critic round 2's probe PX).
  it("repoints through the signed-in account whose list holds the record when the folder key's does not", async () => {
    accounts['Bearer cmk_folder'].mine = unlistedMine();
    accounts['Bearer cmk_user'] = { ...accounts['Bearer cmk_user'], username: 'someone-else' };
    const result = await migrateProject(options());
    expect(result.success).toBe(true);
    expect(pendingOf(result)).toBeUndefined();
    expect(posts().map((post) => post.auth)).toEqual(['Bearer cmk_user']);
  });

  // Critic round 3, R3-1 (probe PX′): when that account's list cannot be read, the step waits for a
  // retry, which repoints. Ending it would leave the record naming the pre-move file for good, since
  // nothing runs the step again once its marker is gone.
  it("waits for a retry when the signed-in account's list cannot be read, and the retry repoints through it", async () => {
    accounts['Bearer cmk_folder'].mine = unlistedMine();
    accounts['Bearer cmk_user'] = {
      ...accounts['Bearer cmk_user'],
      username: 'someone-else',
      mine: { status: 503, body: { error: 'Unavailable' } },
    };
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /for derek, the account this folder's project key belongs to, and the signed-in account's list of its projects could not be read \(.+\)\. Retry later/
    );
    accounts['Bearer cmk_user'].mine = listed(preMove());
    const retry = await migrateProject(options());
    expect(retry.success).toBe(true);
    expect(pendingOf(retry)).toBeUndefined();
    expect(posts().map((post) => post.auth)).toEqual(['Bearer cmk_user']);
    expect(fs.existsSync(path.join(root, PENDING))).toBe(false);
  });
});

describe('a step with no record to repoint ends', () => {
  it("ends when /mine does not list the id and the signed-in account is the store's owner", async () => {
    accounts['Bearer cmk_folder'].mine = {
      status: 200,
      body: { success: true, data: { projects: [] } },
    };
    accounts['Bearer cmk_user'].mine = accounts['Bearer cmk_folder'].mine;
    const result = await migrateProject(options());
    expect(result.success).toBe(true);
    expect(pendingOf(result)).toBeUndefined();
    expect(result.data!.left.join('\n')).toMatch(
      /ended: reasonbook\.ai lists no project dashboard-stable-id for derek/
    );
    expect(result.data!.left.join('\n')).not.toMatch(/shares/);
    expect(fs.existsSync(path.join(root, PENDING))).toBe(false);
  });

  // Critic round 2, R2-1: /mine answers any key with every project its account owns, so the folder
  // key's list is the owner's whole list; another account signed in does not keep the step pending.
  it("ends when the folder key is the owner's and lists no such id, though another account is signed in", async () => {
    accounts['Bearer cmk_folder'].mine = unlistedMine();
    accounts['Bearer cmk_user'] = {
      ...accounts['Bearer cmk_user'],
      username: 'someone-else',
      mine: unlistedMine(),
    };
    const result = await migrateProject(options());
    expect(result.success).toBe(true);
    expect(pendingOf(result)).toBeUndefined();
    expect(result.data!.left.join('\n')).toMatch(
      /ended: reasonbook\.ai lists no project dashboard-stable-id for derek, the account that owns this store/
    );
    expect(posts()).toHaveLength(0);
    expect(fs.existsSync(path.join(root, PENDING))).toBe(false);
  });

  // Both keys are the owner's, so the list that could not be read is the one the folder key read whole.
  it("ends when both keys are the owner's and the folder key lists no such id, though the signed-in list cannot be read", async () => {
    accounts['Bearer cmk_folder'].mine = unlistedMine();
    accounts['Bearer cmk_user'].mine = { status: 503, body: { error: 'Unavailable' } };
    const result = await migrateProject(options());
    expect(pendingOf(result)).toBeUndefined();
    expect(result.data!.left.join('\n')).toMatch(
      /ended: reasonbook\.ai lists no project dashboard-stable-id for derek, the account that owns this store/
    );
  });

  it('ends with no request at all when the store holds no dashboard project id', async () => {
    seed(root + '-null', { dashboard_project_id: null });
    root = root + '-null';
    const result = await migrateProject(options());
    expect(result.success).toBe(true);
    expect(result.data!.left.join('\n')).toMatch(
      /holds no dashboard project id, so migrate cannot tell which record to repoint\. If reasonbook\.ai holds one for this store, save .*rbook\.sqlite under Local Database Path/
    );
    expect(result.data!.left.join('\n')).not.toMatch(/next close registers/);
    expect(requests).toEqual([]);
  });
});

describe('a step that needs another account or credential stays pending, saying which', () => {
  // Critic round 1, F2: a folder key belonging to another account lists that account's projects, so
  // the signed-in account is asked before anyone is told to sign in.
  it("asks the signed-in account when the folder's key belongs to another, and repoints through it", async () => {
    accounts['Bearer cmk_folder'] = {
      ...accounts['Bearer cmk_folder'],
      username: 'someone-else',
      mine: { status: 200, body: { success: true, data: { projects: [] } } },
    };
    const result = await migrateProject(options());
    expect(result.success).toBe(true);
    expect(pendingOf(result)).toBeUndefined();
    expect(posts().map((post) => post.auth)).toEqual(['Bearer cmk_user']);
  });

  // Critic round 2, R2-3: signing in as the owner is enough, since the retry reads the signed-in
  // account's list too; no revoke is asked for, which the dashboard would refuse the owner anyway.
  it("names the folder key's account when no one is signed in, and the owner's sign-in alone finishes it", async () => {
    accounts['Bearer cmk_folder'] = {
      ...accounts['Bearer cmk_folder'],
      username: 'someone-else',
      mine: unlistedMine(),
    };
    userKey = false;
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /for someone-else, the account this folder's project key belongs to, and this store's owner is derek\. Sign in as derek with rbook_auth, then retry/
    );
    expect(result.data!.left.join('\n')).not.toMatch(/revoke/);
    userKey = true;
    const retry = await migrateProject(options());
    expect(retry.success).toBe(true);
    expect(pendingOf(retry)).toBeUndefined();
    expect(posts().map((post) => post.auth)).toEqual(['Bearer cmk_user']);
    expect(fs.existsSync(path.join(root, PENDING))).toBe(false);
  });

  // Critic round 2, R2-4: when the signed-in account's list cannot be read, the verdict waits for a
  // retry rather than falling back to the folder key's account; a refused key adds nothing.
  it("stays pending with a retry when the signed-in account's list cannot be read and the folder key's lacks the id", async () => {
    accounts['Bearer cmk_folder'] = {
      ...accounts['Bearer cmk_folder'],
      username: 'someone-else',
      mine: unlistedMine(),
    };
    accounts['Bearer cmk_user'].mine = { status: 503, body: { error: 'Unavailable' } };
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    const text = result.data!.left.join('\n');
    expect(text).toMatch(
      /for someone-else, the account this folder's project key belongs to, and the signed-in account's list of its projects could not be read \(.+\)\. Retry later/
    );
    expect(text).not.toMatch(/Sign in/);
  });

  it("names the folder key's account when the signed-in account's key is refused on the re-read", async () => {
    accounts['Bearer cmk_folder'] = {
      ...accounts['Bearer cmk_folder'],
      username: 'someone-else',
      mine: unlistedMine(),
    };
    accounts['Bearer cmk_user'].mine = { status: 401, body: { error: 'Invalid API key' } };
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    const text = result.data!.left.join('\n');
    expect(text).toMatch(
      /for someone-else, the account this folder's project key belongs to, and this store's owner is derek\. Sign in as derek with rbook_auth, then retry/
    );
    expect(text).not.toMatch(/Retry later/);
  });

  it('asks for the owner when another account is signed in', async () => {
    accounts['Bearer cmk_folder'].mine = { status: 401, body: { error: 'Invalid API key' } };
    accounts['Bearer cmk_user'] = {
      ...accounts['Bearer cmk_user'],
      username: 'someone-else',
      mine: { status: 200, body: { success: true, data: { projects: [] } } },
    };
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /signed-in account, someone-else, and this store's owner is derek\. Sign in as derek/
    );
  });

  // Critic round 1, F5: each reason's own text.
  it('stays pending, saying so, when both credentials are refused the path update', async () => {
    accounts['Bearer cmk_folder'].post = { status: 302, location: '/' };
    accounts['Bearer cmk_user'].post = { status: 302, location: '/' };
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /refused the path update for its record dashboard-stable-id.*Sign in as the account that owns it, derek/
    );
  });

  it('stays pending with a retry when the path update fails without a refusal', async () => {
    accounts['Bearer cmk_folder'].post = { status: 503 };
    const result = await migrateProject(options());
    expect(result.data!.left.join('\n')).toMatch(
      /did not take the path update for its record dashboard-stable-id.*Retry later: retry reasonbook migrate --apply/
    );
  });

  it('stays pending with the sign-in when no credential answers for the folder', async () => {
    folderKey = false;
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /no dashboard credential answers for this folder \(no key for this folder\)\. Sign in with rbook_auth/
    );
  });

  it("stays pending with a retry when the account's own name cannot be read", async () => {
    accounts['Bearer cmk_folder'].mine = {
      status: 200,
      body: { success: true, data: { projects: [] } },
    };
    accounts['Bearer cmk_folder'].me = { status: 500, body: { error: 'Internal error' } };
    userKey = false;
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /lists no project dashboard-stable-id for the account this folder's project key belongs to, and which account that is could not be read.*Retry later/
    );
  });

  // Critic round 3, W1: with no owner, whose record it is waits on the list that could not be read.
  it("waits for a retry when the store names no owner and the signed-in account's list cannot be read", async () => {
    seed(root + '-ownerless', { owner: null, dashboard_username: null });
    root = root + '-ownerless';
    accounts['Bearer cmk_folder'].mine = unlistedMine();
    accounts['Bearer cmk_user'].mine = { status: 503, body: { error: 'Unavailable' } };
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    const text = result.data!.left.join('\n');
    expect(text).toMatch(
      /for the account this folder's project key belongs to, and the signed-in account's list of its projects could not be read \(.+\)\. Retry later/
    );
    expect(text).not.toMatch(/Sign in/);
  });

  // Critic rounds 3 and 4, W2: /mine lists only an account's own projects, so the account whose list
  // held the record owns it, whoever owns this store, and the refused path update names that account.
  it("names the signed-in account whose list held the record when its path update is refused, not the store's owner", async () => {
    accounts['Bearer cmk_folder'].mine = unlistedMine();
    accounts['Bearer cmk_user'] = {
      ...accounts['Bearer cmk_user'],
      username: 'someone-else',
      post: { status: 302, location: '/' },
    };
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    const text = result.data!.left.join('\n');
    expect(text).toMatch(
      /refused the path update for its record dashboard-stable-id.*Sign in as the account that owns it, someone-else, then retry/
    );
    expect(text).not.toMatch(/derek/);
  });

  // Round 4's W2: the folder key's own list held the record, and that key is another account's.
  it("names the folder key's account when its list held the record and both path updates are refused, or no one when /me cannot say", async () => {
    accounts['Bearer cmk_folder'] = {
      ...accounts['Bearer cmk_folder'],
      username: 'someone-else',
      post: { status: 302, location: '/' },
    };
    accounts['Bearer cmk_user'].post = { status: 302, location: '/' };
    const named = (await migrateProject(options())).data!.left.join('\n');
    expect(named).toMatch(/Sign in as the account that owns it, someone-else, then retry/);
    expect(named).not.toMatch(/derek/);
    accounts['Bearer cmk_folder'].me = { status: 500, body: { error: 'Unavailable' } };
    const unnamed = (await migrateProject(options())).data!.left.join('\n');
    expect(unnamed).toMatch(/Sign in as the account that owns it, then retry/);
    expect(unnamed).not.toMatch(/derek/);
  });

  it('asks for the record owner when the store names none', async () => {
    seed(root + '-ownerless', { owner: null, dashboard_username: null });
    root = root + '-ownerless';
    accounts['Bearer cmk_folder'].mine = {
      status: 200,
      body: { success: true, data: { projects: [] } },
    };
    accounts['Bearer cmk_user'].mine = accounts['Bearer cmk_folder'].mine;
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /for the account this folder's project key belongs to, nor for the signed-in account, and this store names no owner.*Sign in as the account that owns its dashboard record/
    );
  });

  it("re-reads /mine with the user key after the folder key's 401, and ends the step for a deleted project", async () => {
    accounts['Bearer cmk_folder'].mine = { status: 401, body: { error: 'Invalid API key' } };
    accounts['Bearer cmk_user'].mine = {
      status: 200,
      body: { success: true, data: { projects: [] } },
    };
    const result = await migrateProject(options());
    expect(result.success).toBe(true);
    expect(pendingOf(result)).toBeUndefined();
    expect(result.data!.left.join('\n')).toMatch(/ended: reasonbook\.ai lists no project/);
    expect(requests.filter((r) => r.url === '/api/projects/mine').map((r) => r.auth)).toEqual([
      'Bearer cmk_folder',
      'Bearer cmk_user',
    ]);
  });

  it("stays pending after the folder key's 401 with no user key, saying sign-in tells the cases apart", async () => {
    accounts['Bearer cmk_folder'].mine = { status: 401, body: { error: 'Invalid API key' } };
    userKey = false;
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /refused this folder's project key.*deleted project's key and a revoked one.*Sign in with rbook_auth/
    );
  });

  it("re-sends a path update the folder key's redirect refused with the user key", async () => {
    accounts['Bearer cmk_folder'].post = { status: 302, location: '/' };
    const result = await migrateProject(options());
    expect(result.success).toBe(true);
    expect(pendingOf(result)).toBeUndefined();
    expect(posts().map((post) => post.auth)).toEqual(['Bearer cmk_folder', 'Bearer cmk_user']);
  });

  it('asks for the owner when the user key is refused too', async () => {
    accounts['Bearer cmk_folder'].mine = { status: 401, body: { error: 'Invalid API key' } };
    accounts['Bearer cmk_user'].mine = { status: 401, body: { error: 'Invalid API key' } };
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /refused the signed-in account.*Sign in as the account that owns this project's record, derek/
    );
  });

  it('stays pending with a retry when reasonbook.ai answers 5xx', async () => {
    accounts['Bearer cmk_folder'].mine = { status: 503, body: { error: 'Unavailable' } };
    const result = await migrateProject(options());
    expect(pendingOf(result)).toEqual(['the dashboard path update']);
    expect(result.data!.left.join('\n')).toMatch(
      /could not be read.*Retry later: retry reasonbook migrate --apply/
    );
  });
});

describe('#944: a move left with only its dashboard path update answers success', () => {
  it('answers success with the pending step, keeps the backup through a retry, and doctor names the step', async () => {
    accounts['Bearer cmk_folder'].post = { status: 503 };
    const first = await migrateProject(options());
    // At 7d7a3c28 this answered success false, MIGRATION_REFUSED, after the record had moved.
    expect(first).toMatchObject({
      success: true,
      data: { moved: true, pending: ['the dashboard path update'] },
    });
    expect(first.data?.backup).toEqual(expect.any(String));
    expect(marker().steps).toEqual(['the dashboard path update']);
    expect(marker().backup).toBe(first.data?.backup);
    const retry = await migrateProject(options());
    // moved keeps its meaning: this run moved nothing.
    expect(retry).toMatchObject({
      success: true,
      data: { moved: false, pending: ['the dashboard path update'] },
    });
    expect(marker().backup).toBe(first.data?.backup);
    expect(readProject(root).pendingSteps).toEqual(['the dashboard path update']);
  });

  it('keeps the backup in the marker when a retry fails on a registry error', async () => {
    accounts['Bearer cmk_folder'].post = { status: 503 };
    const first = await migrateProject(options());
    const config = path.join(home, '.config/rbook');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'project-graph.sqlite'), 'not a database');
    const retry = await migrateProject(options());
    expect(retry.success).toBe(false);
    expect(retry.error?.suggestion).toMatch(/The new store is intact/);
    expect(marker().backup).toBe(first.data?.backup);
    expect(marker().remaining).toBe(retry.error?.message);
  });

  it('never counts an auth, redirect or non-receipt answer as a path update', async () => {
    const client = new DashboardClient({ baseUrl: base, apiKey: 'cmk_folder' });
    for (const next of [
      { status: 302, location: '/login' },
      { status: 302, location: `https://other.example/projects/${ID}/shares?status=path_updated` },
      { status: 401 },
      { status: 200 },
    ]) {
      accounts['Bearer cmk_folder'].post = next;
      expect((await client.updateLocalProjectPath(ID, '/tmp/record.sqlite')).success).toBe(false);
    }
  });
});
