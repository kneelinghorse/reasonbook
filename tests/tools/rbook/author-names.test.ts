// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m02 (ADR s96 §10) — every new record names its author, as git does: the copy's name, the user's,
// ABOUTME: or the signed-in account's; reads show it, and a NULL author reads as before or not recorded.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { runCli } from '../../../src/cli';
import type { CliIo } from '../../../src/cli/core';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import {
  credentialFingerprint,
  readDashboardIdentity,
  validAuthorName,
  writeUserAuthor,
} from '../../../src/intelligence/user-author';
import {
  AUTHOR_BEFORE_RECORDED,
  AUTHOR_NOT_RECORDED,
  signedInIdentity,
  writerName,
} from '../../../src/tools/rbook/author-name';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import { resolveAndPersistOwner } from '../../../src/tools/rbook/owner-resolution';
import { rbookProjectInit } from '../../../src/tools/rbook/rbook-project-init';
import { formatReviewForLLM } from '../../../src/tools/rbook/rbook-review';
import { spinOut } from '../../../src/tools/rbook/spin-out';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { rbookAuth } from '../../../src/tools/rbook/rbook-auth';
import { REPLICA_KEYS } from '../../../src/tools/rbook/replica-identity';
import { call, dbOf, record } from '../../helpers/replica-fixture';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const PRIVATE = requiresPrivateEvidence({
  reason:
    "The real-store fire migrates this repository's own store, taken from its git history; the public mirror carries neither.",
  revisions: { release: 'v4.0.2' },
});

let tmp: string;
let saved: string | undefined;
let savedUrl: string | undefined;
beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-authors-')));
  saved = process.env.RBOOK_CONFIG_DIR;
  savedUrl = process.env.RBOOK_DASHBOARD_URL;
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
});
afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  if (saved === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = saved;
  if (savedUrl === undefined) delete process.env.RBOOK_DASHBOARD_URL;
  else process.env.RBOOK_DASHBOARD_URL = savedUrl;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function project(name = 'project'): string {
  const root = path.join(tmp, name);
  seedRbookDb(root, { projectId: 'p-authors', projectName: 'authors' });
  return root;
}

function stored(root: string, sql: string): Record<string, unknown> | undefined {
  const db = new Database(dbOf(root), { readonly: true });
  try {
    return db.prepare(sql).get() as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

/** An account's `/api/projects/me` answer, as the dashboard's sprint 61 gives it (H3). */
function me(id: string, username: string | null, projects: unknown[] = []) {
  return { projects, totalCount: projects.length, user: { id, username } };
}

/**
 * A loopback dashboard answering `/api/projects/me` for each key, made the configured dashboard
 * (RBOOK_DASHBOARD_URL), as a user's own setting would be.
 */
async function dashboard(
  accounts: Record<string, Record<string, unknown>>
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    const key = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    const answer = request.url === '/api/projects/me' ? accounts[key] : undefined;
    response.writeHead(answer ? 200 : 404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ success: Boolean(answer), data: answer ?? null }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  process.env.RBOOK_DASHBOARD_URL = url;
  return { url, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

let credentials: CredentialStore | undefined;
async function store(): Promise<CredentialStore> {
  credentials ??= await CredentialStore.create({ configDir: path.join(tmp, 'config') });
  return credentials;
}
afterEach(() => {
  credentials = undefined;
});

/** Sign in through the device-code completion, which asks the dashboard who signed in. */
async function signIn(key: string, keyId: string): Promise<void> {
  const done = await rbookAuth(
    { action: 'login_complete', deviceCode: `dc-${keyId}` },
    {
      store: await store(),
      dashboardBaseUrl: process.env.RBOOK_DASHBOARD_URL!,
      tokenPoller: async () => ({
        status: 'approved',
        key,
        keyId,
        label: `sign-in ${keyId}`,
        intervalSeconds: 1,
      }),
    }
  );
  expect(done.success).toBe(true);
}

/** Sign one key out, as logout does, with the dashboard's revoke stubbed. */
async function signOut(keyId: string): Promise<void> {
  const out = await rbookAuth(
    { action: 'logout', keyId },
    {
      store: await store(),
      clientResolver: async () =>
        ({
          revokeKey: async () => ({ success: true, data: { revokedAt: new Date().toISOString() } }),
        }) as never,
    }
  );
  expect(out.success).toBe(true);
}

describe('who wrote a record', () => {
  it('a user who never signed in, with a local name: the name', async () => {
    writeUserAuthor('Derek Nelson');
    const root = project();
    const written = await record(root, 'Name the author of every record.');
    expect(written.success).toBe(true);
    const row = stored(root, 'SELECT author_name, author_user_id FROM strategic_decisions');
    expect(row).toEqual({ author_name: 'Derek Nelson', author_user_id: null });
    const shown = await call('rbook_decisions', {
      action: 'show',
      decisionId: written.data?.decisionId,
      projectRoot: root,
    });
    expect(shown.data?.author).toBe('Derek Nelson');
  });

  it('a user who never signed in, without one: NULL, read as author not recorded', async () => {
    const root = project();
    const written = await record(root, 'Written with no name and no sign-in.');
    expect(stored(root, 'SELECT author_name FROM strategic_decisions')).toEqual({
      author_name: null,
    });
    const shown = await call('rbook_decisions', {
      action: 'show',
      decisionId: written.data?.decisionId,
      projectRoot: root,
    });
    expect(shown.data?.author).toBe(AUTHOR_NOT_RECORDED);
  });

  it('the first row written by the call that begins recording authors reads not recorded', async () => {
    // A mission add is the first write: it runs the migration and must not predate its start.
    const root = project();
    expect(
      (
        await call('rbook_mission', {
          action: 'add',
          missionId: 'f-m01',
          name: 'First',
          projectRoot: root,
        })
      ).success
    ).toBe(true);
    const shown = await call('rbook_mission', {
      action: 'show',
      missionId: 'f-m01',
      projectRoot: root,
    });
    expect(shown.data?.author).toBe(AUTHOR_NOT_RECORDED);
  });

  it('a key-only sign-in: the account username and its verified id', async () => {
    const server = await dashboard({
      cmk_derek: me('user-derek', 'derek', [
        { id: 'proj-1', name: 'authors', address: 'rbook://derek/authors', owner: 'derek' },
      ]),
    });
    try {
      await signIn('cmk_derek', 'key-derek');
    } finally {
      await server.close();
    }
    expect(signedInIdentity(null)).toMatchObject({ userId: 'user-derek', username: 'derek' });
    const root = project();
    expect((await record(root, 'Written while signed in.')).success).toBe(true);
    expect(stored(root, 'SELECT author_name, author_user_id FROM strategic_decisions')).toEqual({
      author_name: 'derek',
      author_user_id: 'user-derek',
    });
  });

  it("a joined copy writes under its invite's name, and stamps the sign-in's id only when that account is the member", async () => {
    const server = await dashboard({ cmk_derek: me('user-derek', 'derek') });
    try {
      await signIn('cmk_derek', 'key-derek');
    } finally {
      await server.close();
    }
    // s96-m13 (#671): the join keeps the invite's name in the copy's own metadata.
    const root = project();
    const nameCopy = (as: string) => {
      const db = new Database(dbOf(root));
      try {
        db.prepare(
          "INSERT INTO metadata (key, value) VALUES ('replica_author', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"
        ).run(as);
      } finally {
        db.close();
      }
    };
    nameCopy('Darryl');
    expect((await record(root, 'Darryl wrote this on his copy.')).success).toBe(true);
    nameCopy('derek');
    expect((await record(root, 'Derek wrote this on his own copy.')).success).toBe(true);
    const db = new Database(dbOf(root), { readonly: true });
    try {
      expect(
        db.prepare('SELECT author_name, author_user_id FROM strategic_decisions ORDER BY id').all()
      ).toEqual([
        { author_name: 'Darryl', author_user_id: null },
        { author_name: 'derek', author_user_id: 'user-derek' },
      ]);
    } finally {
      db.close();
    }
    nameCopy('Darryl');
    // The review compares rows with the writer by the copy's name, not the account's.
    expect(writerName(root)).toBe('Darryl');
    expect(writerName(null)).toBe('derek');
  });

  it('an account that owns no project still names its writes', async () => {
    const server = await dashboard({ cmk_darryl: me('user-darryl', 'darryl') });
    try {
      await signIn('cmk_darryl', 'key-darryl');
    } finally {
      await server.close();
    }
    const root = project();
    expect((await record(root, 'Written by a member who owns nothing.')).success).toBe(true);
    expect(stored(root, 'SELECT author_name FROM strategic_decisions')).toEqual({
      author_name: 'darryl',
    });
  });

  it("the user's own name wins over the account's, and the id still comes from the sign-in", async () => {
    const server = await dashboard({ cmk_derek: me('user-derek', 'derek') });
    try {
      await signIn('cmk_derek', 'key-derek');
    } finally {
      await server.close();
    }
    writeUserAuthor('Derek N.');
    const root = project();
    await record(root, 'Written under a chosen name.');
    expect(stored(root, 'SELECT author_name, author_user_id FROM strategic_decisions')).toEqual({
      author_name: 'Derek N.',
      author_user_id: 'user-derek',
    });
  });

  it("the name an invite gave this copy wins over the user's", async () => {
    writeUserAuthor('Derek Nelson');
    const root = project();
    const db = new Database(dbOf(root));
    db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)').run(
      REPLICA_KEYS.author,
      'darryl'
    );
    db.close();
    await record(root, 'Written in a copy an invite named.');
    expect(stored(root, 'SELECT author_name FROM strategic_decisions')).toEqual({
      author_name: 'darryl',
    });
  });
});

describe('an identity belongs to the sign-in that fetched it', () => {
  it('signing one account out leaves the other, and stamps never name the gone one', async () => {
    const server = await dashboard({
      cmk_alice: me('user-alice', 'alice'),
      cmk_bob: me('user-bob', 'bob'),
    });
    try {
      await signIn('cmk_alice', 'key-alice');
      await new Promise((resolve) => setTimeout(resolve, 5));
      await signIn('cmk_bob', 'key-bob');
    } finally {
      await server.close();
    }
    const root = project();
    await record(root, 'Written as the newest sign-in.');
    expect(stored(root, 'SELECT author_name FROM strategic_decisions ORDER BY id DESC')).toEqual({
      author_name: 'bob',
    });
    await signOut('key-bob');
    await record(root, 'Written once bob signed out.');
    expect(
      stored(root, 'SELECT author_name, author_user_id FROM strategic_decisions ORDER BY id DESC')
    ).toEqual({ author_name: 'alice', author_user_id: 'user-alice' });
    await signOut('key-alice');
    expect(fs.existsSync(path.join(tmp, 'config', 'dashboard-identity.json'))).toBe(false);
    await record(root, 'Written signed out.');
    expect(stored(root, 'SELECT author_name FROM strategic_decisions ORDER BY id DESC')).toEqual({
      author_name: null,
    });
  });

  it('a credential removed by hand, or another dashboard configured, takes no identity', async () => {
    const server = await dashboard({ cmk_derek: me('user-derek', 'derek') });
    try {
      await signIn('cmk_derek', 'key-derek');
    } finally {
      await server.close();
    }
    expect(signedInIdentity(null)?.username).toBe('derek');
    // The same dashboard written with a trailing slash is the same dashboard.
    process.env.RBOOK_DASHBOARD_URL = `${server.url}/`;
    expect(signedInIdentity(null)?.username).toBe('derek');
    process.env.RBOOK_DASHBOARD_URL = 'https://staging.example';
    expect(signedInIdentity(null)).toBeNull();
    process.env.RBOOK_DASHBOARD_URL = server.url;
    fs.rmSync(path.join(tmp, 'config', 'credentials.json'));
    expect(signedInIdentity(null)).toBeNull();
  });

  it('revoking a key forgets its identity too', async () => {
    const server = await dashboard({ cmk_derek: me('user-derek', 'derek') });
    try {
      await signIn('cmk_derek', 'key-derek');
    } finally {
      await server.close();
    }
    const revoked = await rbookAuth(
      { action: 'revoke', keyId: 'key-derek' },
      {
        store: await store(),
        clientResolver: async () =>
          ({
            revokeKey: async () => ({
              success: true,
              data: { revokedAt: new Date().toISOString() },
            }),
          }) as never,
      }
    );
    expect(revoked.success).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'config', 'dashboard-identity.json'))).toBe(false);
  });

  it('a sign-in from before this version takes its identity when the owner is next resolved', async () => {
    // A checkpoint and a message send resolve the owner; that write path keeps the identity.
    const issuedAt = new Date().toISOString();
    await (
      await store()
    ).upsertUserScopedKey('key-old', {
      key: 'cmk_old',
      label: 'signed in before authors were recorded',
      issuedAt,
      lastUsedAt: issuedAt,
    });
    const server = await dashboard({ cmk_old: me('user-old', 'olduser') });
    const root = project();
    expect(signedInIdentity(root)).toBeNull();
    const client = (await RbookDatabaseClient.create({ dbPath: dbOf(root) })).data!;
    try {
      await resolveAndPersistOwner(
        client,
        new DashboardClient({ baseUrl: server.url, apiKey: 'cmk_old' })
      );
    } finally {
      client.close();
      await server.close();
    }
    expect(signedInIdentity(root)).toMatchObject({ userId: 'user-old', username: 'olduser' });
  });

  it("a project with its own key takes that key's identity, not the newest sign-in's", async () => {
    // A project key can belong to another account, as when someone else set the project up here
    // with a sign-in this machine no longer holds.
    const server = await dashboard({
      cmk_derek: me('user-derek', 'derek'),
      cmk_ops: me('user-ops', 'ops'),
    });
    const root = project();
    try {
      await signIn('cmk_derek', 'key-derek');
      const issuedAt = new Date().toISOString();
      await (
        await store()
      ).upsertProjectKey(root, {
        key: 'cmk_ops',
        keyId: 'key-ops',
        parentKeyId: 'key-ops-account',
        label: 'project key',
        issuedAt,
        lastUsedAt: issuedAt,
      });
      const client = (await RbookDatabaseClient.create({ dbPath: dbOf(root) })).data!;
      try {
        await resolveAndPersistOwner(
          client,
          new DashboardClient({ baseUrl: server.url, apiKey: 'cmk_ops' })
        );
      } finally {
        client.close();
      }
    } finally {
      await server.close();
    }
    expect(signedInIdentity(root)?.username).toBe('ops');
    expect(signedInIdentity(path.join(tmp, 'elsewhere'))?.username).toBe('derek');
  });

  it('a project registered under this sign-in is named before its own key is first used', async () => {
    // A checkpoint resolves the owner with the user key, then registers the project and keeps the
    // key the dashboard issues; that key belongs to the account whose key registered it.
    const server = await dashboard({ cmk_derek: me('user-derek', 'derek') });
    try {
      await signIn('cmk_derek', 'key-derek');
    } finally {
      await server.close();
    }
    const root = project();
    const issuedAt = new Date().toISOString();
    await (
      await store()
    ).upsertProjectKey(root, {
      key: 'cmk_project',
      keyId: 'key-project',
      parentKeyId: 'key-derek',
      label: 'project key',
      issuedAt,
      lastUsedAt: issuedAt,
    });
    await record(root, 'Written once the project has its own key.');
    expect(
      stored(root, 'SELECT author_name, author_user_id FROM strategic_decisions ORDER BY id DESC')
    ).toEqual({ author_name: 'derek', author_user_id: 'user-derek' });
  });

  it('the one-call sign-in learns who signed in, as the two-call one does', async () => {
    const server = await dashboard({ cmk_one: me('user-one', 'onecall') });
    try {
      const done = await rbookAuth(
        { action: 'login' },
        {
          store: await store(),
          dashboardBaseUrl: server.url,
          deviceCodeFlow: async (options) => {
            options.prompter?.({
              deviceCode: 'dc-one',
              userCode: 'ONE-CALL',
              verificationUri: `${server.url}/device`,
              expiresIn: 600,
              interval: 1,
            });
            const now = new Date().toISOString();
            await options.credentialStore!.upsertUserScopedKey('key-one', {
              key: 'cmk_one',
              label: 'one-call sign-in',
              issuedAt: now,
              lastUsedAt: now,
            });
            return { key: 'cmk_one', keyId: 'key-one', label: 'one-call sign-in' };
          },
        }
      );
      expect(done.success).toBe(true);
    } finally {
      await server.close();
    }
    const root = project();
    await record(root, 'Written after the one-call sign-in.');
    expect(
      stored(root, 'SELECT author_name, author_user_id FROM strategic_decisions ORDER BY id DESC')
    ).toEqual({ author_name: 'onecall', author_user_id: 'user-one' });
  });

  it("revoking a project's own key forgets its identity", async () => {
    process.env.RBOOK_DASHBOARD_URL = 'http://127.0.0.1:9';
    const root = project();
    const issuedAt = new Date().toISOString();
    await (
      await store()
    ).upsertProjectKey(root, {
      key: 'cmk_ops',
      keyId: 'key-ops',
      parentKeyId: 'key-derek',
      label: 'project key',
      issuedAt,
      lastUsedAt: issuedAt,
    });
    new DashboardClient({ baseUrl: 'http://127.0.0.1:9', apiKey: 'cmk_ops' }).rememberIdentity({
      id: 'user-ops',
      username: 'ops',
    });
    expect(signedInIdentity(root)?.username).toBe('ops');
    const revoked = await rbookAuth(
      { action: 'revoke', keyId: 'key-ops' },
      {
        store: await store(),
        clientResolver: async () =>
          ({
            revokeKey: async () => ({
              success: true,
              data: { revokedAt: new Date().toISOString() },
            }),
          }) as never,
      }
    );
    expect(revoked.success).toBe(true);
    expect(readDashboardIdentity('cmk_ops', 'http://127.0.0.1:9')).toBeNull();
  });

  it('a damaged identity file reads as empty, and the next sign-in rewrites it', async () => {
    fs.mkdirSync(path.join(tmp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'config', 'dashboard-identity.json'), '{ not json');
    expect(signedInIdentity(null)).toBeNull();
    const server = await dashboard({ cmk_derek: me('user-derek', 'derek') });
    try {
      await signIn('cmk_derek', 'key-derek');
    } finally {
      await server.close();
    }
    expect(signedInIdentity(null)?.username).toBe('derek');
  });

  it('a username a person could not type as a name is neither kept nor used as one', async () => {
    const server = await dashboard({ cmk_odd: me('user-odd', 'od\u202edd') });
    try {
      await signIn('cmk_odd', 'key-odd');
    } finally {
      await server.close();
    }
    expect(signedInIdentity(null)).toMatchObject({ userId: 'user-odd', username: null });
    const file = path.join(tmp, 'config', 'dashboard-identity.json');
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(kept.identities[credentialFingerprint('cmk_odd')].username).toBeNull();
    // A hand edit that puts it back is checked as it is read.
    kept.identities[credentialFingerprint('cmk_odd')].username = 'od\u202edd';
    fs.writeFileSync(file, JSON.stringify(kept));
    expect(signedInIdentity(null)).toMatchObject({ userId: 'user-odd', username: null });
    for (const name of ['zero\u200bwidth', 'line\u2028break', 'next\u0085line', 'bidi\u202eflip'])
      expect(validAuthorName(name)).toBeNull();
    expect(validAuthorName('  Derek Nelson  ')).toBe('Derek Nelson');
    // The joiners a name can need are kept: Persian spelling's non-joiner, a joined emoji.
    for (const name of [
      '\u0639\u0644\u06cc\u200c\u0631\u0636\u0627',
      '\u{1F469}\u200d\u{1F4BB} Ada',
    ])
      expect(validAuthorName(name)).toBe(name);
    // Beside ASCII, at a name's edge or alone, a hidden mark only hides a difference or the name.
    // A name of nothing but a combining accent shows nothing, so it needs a visible character.
    for (const name of ['der\u200dek', '\u200c', 'derek\u3164', 'a\ufe0f', '\u0301'])
      expect(validAuthorName(name)).toBeNull();
    // An emoji's presentation selector, and a Devanagari half-form's joiner, are kept.
    for (const name of [
      '\u2764\ufe0f\u200d\u{1F525} fan',
      '\u0905\u0928\u0941\u0937\u094d\u200d\u0915\u093e',
    ])
      expect(validAuthorName(name)).toBe(name);
    // No name can pass for a reading of an unnamed record.
    for (const name of [AUTHOR_NOT_RECORDED, 'Before Authors Were Recorded'])
      expect(validAuthorName(name)).toBeNull();
    // s96-m13 (#671): the blank Braille pattern counts as a symbol but shows as nothing, alone or
    // after a name, so it is refused too.
    const blank = String.fromCodePoint(0x2800);
    for (const name of [blank, `Darryl${blank}`]) expect(validAuthorName(name)).toBeNull();
  });
});

describe('writers that copy rows keep their authors', () => {
  it('spin-out copies a row with its original author, whoever runs it', async () => {
    writeUserAuthor('derek');
    const source = project('spin-source');
    expect(
      (
        await call('rbook_sprint', {
          action: 'add',
          sprintId: 'sprint-9',
          title: 'Moving',
          status: 'Planned',
          projectRoot: source,
        })
      ).success
    ).toBe(true);
    expect(
      (
        await call('rbook_mission', {
          action: 'add',
          missionId: 's9-m01',
          name: 'Moving mission',
          sprintId: 'sprint-9',
          projectRoot: source,
        })
      ).success
    ).toBe(true);
    writeUserAuthor('Ada');
    const target = path.join(tmp, 'spin-target');
    fs.mkdirSync(target);
    const result = await spinOut({ from: source, to: target, sprintId: 'sprint-9', apply: true });
    expect(result.success).toBe(true);
    expect(
      stored(target, "SELECT author_name FROM missions WHERE name = 'Moving mission'")
    ).toEqual({
      author_name: 'derek',
    });
  });

  it('init stamps its first rows, and a NULL author there reads not recorded', async () => {
    const root = path.join(tmp, 'fresh');
    fs.mkdirSync(root);
    const init = await rbookProjectInit({
      projectRoot: root,
      projectType: 'build',
      initialSprint: { id: 'sprint-1', title: 'First' },
      initialMissions: [{ id: 's1-m01', name: 'First mission' }],
    });
    expect(init.success).toBe(true);
    reidentifyRbookTestStore(root);
    const shown = await call('rbook_mission', {
      action: 'show',
      missionId: 's1-m01',
      projectRoot: root,
    });
    expect(shown.data?.author).toBe(AUTHOR_NOT_RECORDED);
  });
});

describe('a store from before authors were recorded', () => {
  it('at the author-namespace 1.0 marker, takes the column under its own marker', async () => {
    writeUserAuthor('Derek Nelson');
    const root = project();
    // Bring it to the shape a store had before s96-m02: migrated through the author namespace, no
    // author_name, and an old decision.
    expect((await record(root, 'Recorded before authors were.')).success).toBe(true);
    const db = new Database(dbOf(root));
    for (const table of [
      'strategic_decisions',
      'learnings',
      'missions',
      'sprints',
      'sessions',
      'next_steps',
      'constraints',
      'context_snapshots',
    ])
      db.exec(`ALTER TABLE ${table} DROP COLUMN author_name`);
    db.prepare(
      "DELETE FROM metadata WHERE key IN ('author_name_columns', 'author_names_since')"
    ).run();
    expect(
      (
        db.prepare("SELECT value FROM metadata WHERE key = 'author_namespace_columns'").get() as {
          value: string;
        }
      ).value
    ).toBe('1.0');
    db.close();

    const later = await record(root, 'Recorded once the column exists.');
    expect(later.success).toBe(true);
    expect(stored(root, "SELECT value FROM metadata WHERE key = 'author_name_columns'")).toEqual({
      value: '1.0',
    });
    const list = await call('rbook_decisions', { action: 'list', projectRoot: root });
    const authors = (list.data?.decisions as Array<{ id: number; author: string }>).map(
      (decision) => decision.author
    );
    expect(authors.sort()).toEqual([AUTHOR_BEFORE_RECORDED, 'Derek Nelson'].sort());
  });

  it('reads it without writing: no migration runs, and every row reads as before', async () => {
    const root = project();
    expect((await record(root, 'An old decision.')).success).toBe(true);
    const db = new Database(dbOf(root));
    db.exec('ALTER TABLE strategic_decisions DROP COLUMN author_name');
    db.prepare(
      "DELETE FROM metadata WHERE key IN ('author_name_columns', 'author_names_since')"
    ).run();
    db.close();
    const list = await call('rbook_decisions', { action: 'list', projectRoot: root });
    expect((list.data?.decisions as Array<{ author: string }>)[0].author).toBe(
      AUTHOR_BEFORE_RECORDED
    );
    const review = await call('rbook_review', { projectRoot: root });
    expect(review.success).toBe(true);
    const columns = new Database(dbOf(root), { readonly: true });
    const names = (
      columns.pragma("table_info('strategic_decisions')") as Array<{ name: string }>
    ).map((column) => column.name);
    columns.close();
    expect(names).not.toContain('author_name');
  });
});

describe('reads show the author', () => {
  it('on decisions, missions, sessions and the review', async () => {
    writeUserAuthor('Derek Nelson');
    const root = project();
    expect(
      (
        await call('rbook_mission', {
          action: 'add',
          missionId: 'a-m01',
          name: 'Authored mission',
          projectRoot: root,
        })
      ).success
    ).toBe(true);
    await record(root, 'An authored decision.');
    const mission = await call('rbook_mission', {
      action: 'show',
      missionId: 'a-m01',
      projectRoot: root,
    });
    expect(mission.data?.author).toBe('Derek Nelson');
    const sessions = await call('rbook_session', { action: 'list', projectRoot: root });
    expect((sessions.data?.sessions as Array<{ author: string }>)[0].author).toBe('Derek Nelson');
    fs.rmSync(path.join(tmp, 'config', 'config.json'));
    await record(root, 'A decision written without a name.');
    // Someone else now writes here: the digest names only the decisions another person wrote.
    writeUserAuthor('Ada Lovelace');
    const review = await call('rbook_review', { projectRoot: root });
    const recent = (review.data as { recentDecisions: Array<{ author?: string }> }).recentDecisions;
    expect(recent.slice(0, 2).map((d) => d.author)).toEqual([undefined, 'Derek Nelson']);
    const text = formatReviewForLLM({ success: true, data: review.data } as never);
    expect(text).toContain('An authored decision. — Derek Nelson');
    expect(text).toContain('A decision written without a name.\n');
    // Derek, reading his own project, sees no author on his own decisions.
    writeUserAuthor('Derek Nelson');
    const own = await call('rbook_review', { projectRoot: root });
    expect(
      (own.data as { recentDecisions: Array<{ author?: string }> }).recentDecisions
        .slice(0, 2)
        .map((d) => d.author)
    ).toEqual([undefined, undefined]);
    const unnamed = await call('rbook_decisions', { action: 'list', projectRoot: root });
    expect((unnamed.data?.decisions as Array<{ author: string }>)[0].author).toBe(
      AUTHOR_NOT_RECORDED
    );
  });
});

describe('reasonbook config author', () => {
  function io(): CliIo & { out: string; err: string } {
    const sink = {
      out: '',
      err: '',
      env: process.env,
      cwd: tmp,
      readStdin: async () => '',
      stdout(text: string) {
        sink.out += text;
      },
      stderr(text: string) {
        sink.err += `${text}\n`;
      },
    };
    return sink as unknown as CliIo & { out: string; err: string };
  }

  it('sets the name and keeps the plugin setting beside it', async () => {
    const config = path.join(tmp, 'config', 'config.json');
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, JSON.stringify({ pluginServer: 'off' }));
    const out = io();
    expect(await runCli(['config', 'author', 'Derek', 'Nelson'], out)).toBe(0);
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({
      pluginServer: 'off',
      author: 'Derek Nelson',
    });
    expect(out.out).toContain('Derek Nelson');
  });

  it('shows where the name comes from, and refuses one that is not a name', async () => {
    writeUserAuthor('Derek Nelson');
    const shown = io();
    expect(await runCli(['config', 'author'], shown)).toBe(0);
    expect(shown.out).toContain('Your name (reasonbook config author): Derek Nelson');
    expect(shown.out).toContain('Records written here carry the author Derek Nelson.');
    const refused = io();
    expect(await runCli(['config', 'author', 'x'.repeat(81)], refused)).toBe(1);
    expect(refused.err).toMatch(/1 to 80 visible characters/);
  });
});

describe('the standing fixtures', () => {
  it('a loose store, without its learnings foreign keys, stamps its authors too', async () => {
    writeUserAuthor('Derek Nelson');
    const root = project('loose');
    const db = new Database(dbOf(root));
    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'learnings'").get() as { sql: string }
    ).sql;
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare("UPDATE sqlite_master SET sql = ? WHERE name = 'learnings'").run(
      sql.replace(
        /,\s*FOREIGN KEY \(\w+\) REFERENCES \w+\(\w+\)(?: ON DELETE (?:SET NULL|CASCADE))?/g,
        ''
      )
    );
    db.pragma('writable_schema = OFF');
    db.close();
    const captured = await call('rbook_session', {
      action: 'capture',
      category: 'learning',
      content: 'A loose store names its authors as a strict one does.',
      projectRoot: root,
    });
    expect(captured.success).toBe(true);
    expect(stored(root, 'SELECT author_name FROM learnings')).toEqual({
      author_name: 'Derek Nelson',
    });
  });

  it('two processes adding the column at once both stamp, and no row predates the start', async () => {
    writeUserAuthor('Derek Nelson');
    const root = project('racing');
    const db = new Database(dbOf(root));
    db.exec('ALTER TABLE strategic_decisions DROP COLUMN author_name');
    db.prepare(
      "DELETE FROM metadata WHERE key IN ('author_name_columns', 'author_names_since')"
    ).run();
    db.close();
    const decisions = path.resolve('src/tools/rbook/rbook-decisions.ts');
    const source = String.raw`const fs=require('fs'),ts=require('typescript');require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);const {rbookDecisions}=require(process.argv[1]);process.stdout.write('ready\n');process.stdin.once('data',async()=>{const out=[];for(let n=0;n<4;n++){const r=await rbookDecisions({action:'record',content:'Decision '+n+' from '+process.argv[3],projectRoot:process.argv[2]});out.push(r.success);}process.stdout.write(JSON.stringify(out)+'\n');process.exit(0);});`;
    const children = ['first', 'second'].map((name) => {
      const child = spawn(process.execPath, ['-e', source, decisions, root, name], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });
      let output = '';
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          if (output.includes('ready\n')) resolve();
        });
        child.once('close', (code) => reject(new Error(`child exited ${code} before ready`)));
      });
      const done = new Promise<string>((resolve) => child.once('close', () => resolve(output)));
      return { child, ready, done };
    });
    await Promise.all(children.map((c) => c.ready));
    children.forEach((c) => c.child.stdin.end('go'));
    const results = (await Promise.all(children.map((c) => c.done))).flatMap(
      (out) => JSON.parse(out.trim().split('\n').slice(-1)[0]) as boolean[]
    );
    expect(results).toEqual(Array(8).fill(true));
    // Whichever process began recording, no row either wrote predates that start.
    expect(
      stored(
        root,
        "SELECT count(*) AS n FROM strategic_decisions WHERE occurred_at < (SELECT CAST(value AS INTEGER) FROM metadata WHERE key = 'author_names_since')"
      )
    ).toEqual({ n: 0 });
    expect(
      stored(
        root,
        "SELECT count(*) AS n FROM strategic_decisions WHERE author_name = 'Derek Nelson'"
      )
    ).toEqual({ n: 8 });
  }, 60000);
});

PRIVATE.describe("this repository's own store at v4.0.2", () => {
  it('takes the column on every logged table at its first write, and reads its history as before', async () => {
    writeUserAuthor('Derek Nelson');
    const root = path.join(tmp, 'real');
    fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
    fs.writeFileSync(
      dbOf(root),
      execFileSync('git', ['show', `${PRIVATE.revisions.release}:rbook/db/rbook.sqlite`], {
        cwd: path.resolve(__dirname, '..', '..', '..'),
        maxBuffer: 256 * 1024 * 1024,
      })
    );
    reidentifyRbookTestStore(root);
    const written = await record(root, 'Recorded on a copy of the real store.');
    expect(written.success).toBe(true);
    const db = new Database(dbOf(root), { readonly: true });
    try {
      for (const table of [
        'strategic_decisions',
        'learnings',
        'missions',
        'sprints',
        'sessions',
        'next_steps',
        'constraints',
        'context_snapshots',
      ])
        expect({
          table,
          has: (db.pragma(`table_info('${table}')`) as Array<{ name: string }>).some(
            (column) => column.name === 'author_name'
          ),
        }).toEqual({ table, has: true });
    } finally {
      db.close();
    }
    const shown = await call('rbook_decisions', {
      action: 'show',
      decisionId: written.data?.decisionId,
      projectRoot: root,
    });
    expect(shown.data?.author).toBe('Derek Nelson');
    const oldest = await call('rbook_decisions', {
      action: 'show',
      decisionId: 1,
      projectRoot: root,
    });
    expect(oldest.data?.author).toBe(AUTHOR_BEFORE_RECORDED);
  }, 120000);
});
