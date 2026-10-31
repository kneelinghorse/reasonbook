// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real-store and loopback checks prevent upload holds based on another account's projects.
// ABOUTME: Auth pauses need sustained failure; deletion needs a subsequent owner-authenticated upload.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { CredentialStore } from '../../../src/intelligence/credential-store';
import { DashboardClient } from '../../../src/tools/rbook/dashboard-client';
import {
  inspectUploadOwner,
  recheckUploadAuth,
} from '../../../src/tools/rbook/dashboard-upload-auth';

describe('upload owner evidence and fresh auth checks', () => {
  let root: string;
  let db: Database.Database;
  let store: CredentialStore;
  let server: http.Server;
  let responses: Record<
    string,
    { status?: number; username?: string; projects?: unknown[]; code?: string; retryAfter?: string }
  >;
  let seen: string[];
  const env = { ...process.env };
  const row = { id: 'stored-id', name: 'Record', slug: 'record', owner: 'owner', isOwner: true };
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-auth-'));
    fs.mkdirSync(path.join(root, 'rbook', 'db'), { recursive: true });
    db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'));
    db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT)');
    for (const [key, value] of Object.entries({
      owner: 'owner',
      dashboard_project_id: 'stored-id',
      dashboard_slug: 'record',
      project_name: 'Record',
    }))
      db.prepare('INSERT INTO metadata VALUES (?,?)').run(key, value);
    responses = {
      project: { username: 'owner', projects: [row] },
      parent: { username: 'owner', projects: [row] },
    };
    seen = [];
    server = http.createServer((req, res) => {
      const key = (req.headers.authorization ?? '').replace('Bearer ', '');
      seen.push(key);
      const reply = responses[key] ?? { status: 401 };
      const status = reply.status ?? 200;
      res.writeHead(status, {
        'content-type': 'application/json',
        ...(reply.retryAfter ? { 'retry-after': reply.retryAfter } : {}),
      });
      res.end(
        JSON.stringify(
          status === 200
            ? {
                success: true,
                data: {
                  user: { id: `id-${reply.username}`, username: reply.username },
                  projects: reply.projects ?? [],
                },
              }
            : { success: false, error: 'Refused', code: reply.code }
        )
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    process.env.RBOOK_DASHBOARD_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.RBOOK_CONFIG_DIR = path.join(root, 'config');
    delete process.env.RBOOK_DASHBOARD_API_KEY;
    delete process.env.RBOOK_DASHBOARD_USER;
    delete process.env.RBOOK_DASHBOARD_PASSWORD;
    CredentialStore.resetInstance();
    store = await CredentialStore.create();
    const issuedAt = new Date(Date.now() - 1000).toISOString();
    await store.upsertUserScopedKey('parent-id', {
      key: 'parent',
      label: 'parent',
      issuedAt,
      lastUsedAt: issuedAt,
    });
    await store.upsertProjectKey(root, {
      key: 'project',
      keyId: 'project-key-id',
      parentKeyId: 'parent-id',
      label: 'project',
      issuedAt,
      lastUsedAt: issuedAt,
    });
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    CredentialStore.resetInstance();
    process.env = { ...env };
    fs.rmSync(root, { recursive: true, force: true });
  });
  const inspect = async () => {
    const resolved = await DashboardClient.fromEnvForProject(root);
    return inspectUploadOwner(root, resolved.data!);
  };

  it('holds replaced only on the owner account and never writes a replacement id', async () => {
    responses.project.projects = [{ ...row, id: 'new-id' }];
    const result = await inspect();
    expect(result).toMatchObject({ ownerConfirmed: true, projectListed: false, replaced: true });
    expect(db.prepare("SELECT value FROM metadata WHERE key='dashboard_project_id'").get()).toEqual(
      { value: 'stored-id' }
    );
  });
  it('a shared same-name project does not count as an owned replacement', async () => {
    responses.project.projects = [{ ...row, id: 'shared-id', isOwner: false }];
    expect(await inspect()).toMatchObject({
      ownerConfirmed: true,
      projectListed: false,
      replaced: false,
    });
  });
  it('another account cannot hold the store even when it owns the same name', async () => {
    responses.project = { username: 'other', projects: [{ ...row, id: 'other-id' }] };
    expect(await inspect()).toMatchObject({
      ownerConfirmed: false,
      replaced: false,
      error: { code: 'DASHBOARD_OWNER_MISMATCH' },
    });
  });
  it('a rename retains the stored id; missing ids retain the documented legacy skip', async () => {
    responses.project.projects = [{ ...row, name: 'Renamed', slug: 'renamed' }];
    expect(await inspect()).toMatchObject({ projectListed: true, replaced: false });
    db.prepare("UPDATE metadata SET value=NULL WHERE key='dashboard_project_id'").run();
    expect(await inspect()).toMatchObject({ skipped: true, replaced: false });
  });
  it('schema errors are reported rather than silently disabling the replacement guard', async () => {
    db.exec('DROP TABLE metadata');
    expect((await inspect()).error?.message).toMatch(/metadata/);
  });
  it('rechecks a fresh resolved project client and recovers after a transient 401', async () => {
    const result = await recheckUploadAuth(root, { authFirstFailedAt: Date.now() - 20 * 60_000 });
    expect(result).toMatchObject({ recovered: true, authFirstFailedAt: null });
    expect(seen).toEqual(['project']);
  });
  it('requires a second failure at least fifteen minutes later before project-key pause', async () => {
    responses.project = { status: 401 };
    const now = Date.now();
    expect(await recheckUploadAuth(root, { now })).toMatchObject({
      recovered: false,
      authFirstFailedAt: now,
    });
    const early = await recheckUploadAuth(root, {
      now: now + 15 * 60_000 - 1,
      authFirstFailedAt: now,
    });
    expect(early.pauseReason).toBeUndefined();
    expect(
      await recheckUploadAuth(root, { now: now + 15 * 60_000, authFirstFailedAt: now })
    ).toMatchObject({ recovered: false, pauseReason: 'project-key' });
  });
  it('uses the parent before a newer account and a same-owner fallback after parent sign-out', async () => {
    responses.project = { status: 401 };
    // s107-m01 (#886): every key's instant comes from this one reading, so the order under test
    // never depends on how long the awaits take. 'other' is newer than the parent (beforeEach
    // issues it at now - 1 s), which keeps "parent first" under test; 'fallback' is older still.
    const now = Date.now();
    const issuedAt = new Date(now).toISOString();
    await store.upsertUserScopedKey('newest', {
      key: 'other',
      label: 'other',
      issuedAt,
      lastUsedAt: issuedAt,
    });
    responses.other = { username: 'other', projects: [{ ...row, id: 'replacement' }] };
    const prior = now - 15 * 60_000;
    expect((await recheckUploadAuth(root, { authFirstFailedAt: prior })).pauseReason).toBe(
      'project-key'
    );
    expect(seen).toEqual(['project', 'parent']);
    await store.removeUserScopedKey('parent-id');
    // A slow machine: more than 2 s pass between the two keys (s106-m04's run got project, fallback).
    const clock = Date.now.bind(Date);
    const slow = jest.spyOn(Date, 'now').mockImplementation(() => clock() + 5_000);
    try {
      await store.upsertUserScopedKey('same-owner', {
        key: 'fallback',
        label: 'fallback',
        issuedAt: new Date(now - 20_000).toISOString(),
        lastUsedAt: issuedAt,
      });
      responses.fallback = { username: 'owner', projects: [row] };
      expect((await recheckUploadAuth(root, { authFirstFailedAt: prior })).pauseReason).toBe(
        'project-key'
      );
    } finally {
      slow.mockRestore();
    }
    expect(seen.slice(2)).toEqual(['project', 'other', 'fallback']);
  });
  it('tries owner fallback keys by issuance instant even when ISO offsets sort differently', async () => {
    responses.project = { status: 401 };
    await store.removeUserScopedKey('parent-id');
    const now = Date.now();
    const newer = new Date(now).toISOString();
    const older = new Date(now - 60_000 + 2 * 60 * 60_000).toISOString().replace('Z', '+02:00');
    await store.upsertUserScopedKey('older-id', {
      key: 'older',
      label: 'older',
      issuedAt: older,
      lastUsedAt: newer,
    });
    await store.upsertUserScopedKey('newer-id', {
      key: 'newer',
      label: 'newer',
      issuedAt: newer,
      lastUsedAt: newer,
    });
    responses.older = { username: 'owner', projects: [row] };
    responses.newer = { username: 'owner', projects: [] };
    const result = await recheckUploadAuth(root, { authFirstFailedAt: now - 15 * 60_000 });
    expect(seen).toEqual(['project', 'newer']);
    expect(result.confirmingClient).toBeInstanceOf(DashboardClient);
    expect(result.pauseReason).toBeUndefined();
  });

  it('the user resolver selects the saved key by id and retains its wire attribution', async () => {
    const issuedAt = new Date(Date.now() + 1000).toISOString();
    await store.upsertUserScopedKey('newest-id', {
      key: 'newest',
      label: 'newest',
      issuedAt,
      lastUsedAt: issuedAt,
    });
    const options = { credentialStore: store, userScopedKeyId: 'parent-id' };
    const resolved = await DashboardClient.fromEnvForUser(options);
    expect(resolved.data?.client.authenticatingKeyId).toBe('parent-id');
    await resolved.data?.client.getMyProjects();
    expect(seen).toEqual(['parent']);
  });

  it('an absent selected user key cannot silently use another saved, override or environment key', async () => {
    process.env.RBOOK_DASHBOARD_API_KEY = 'environment';
    const options = { credentialStore: store, userScopedKeyId: 'removed-id', apiKey: 'override' };
    const resolved = await DashboardClient.fromEnvForUser(options);
    expect(resolved.success).toBe(false);
    expect(resolved.error?.message).toContain('selected saved user key');
    expect(seen).toEqual([]);
    await store.removeUserScopedKey('parent-id');
    expect((await DashboardClient.fromEnvForUser(options)).success).toBe(false);
  });

  it('missing stored id yields one owner confirming client and never claims deletion', async () => {
    responses.project = { status: 401 };
    responses.parent.projects = [];
    const result = await recheckUploadAuth(root, {});
    expect(result.confirmingClient).toBeInstanceOf(DashboardClient);
    expect(result.confirmingClient?.authenticatingKeyId).toBe('parent-id');
    expect(result.ownerConfirmed).toBe(true);
    expect(result.pauseReason).toBeUndefined();
    responses.parent.projects = [{ ...row, id: 'replacement' }];
    expect(await recheckUploadAuth(root, {})).toMatchObject({ pauseReason: 'replaced' });
  });
  it('wrong-account listing never concludes project-key, replaced or deleted', async () => {
    responses.project = { status: 401 };
    responses.parent = { username: 'other', projects: [{ ...row, id: 'replacement' }] };
    const result = await recheckUploadAuth(root, { authFirstFailedAt: Date.now() - 60 * 60_000 });
    expect(result.pauseReason).toBeUndefined();
    expect(result.confirmingClient).toBeUndefined();
    expect(result.error).toMatch(/owner/);
  });
  it('both keys failing remains suspect before fifteen minutes and auth thereafter', async () => {
    responses.project = { status: 401 };
    responses.parent = { status: 401 };
    const now = Date.now();
    expect((await recheckUploadAuth(root, { now })).pauseReason).toBeUndefined();
    expect(
      (await recheckUploadAuth(root, { now: now + 15 * 60_000, authFirstFailedAt: now }))
        .pauseReason
    ).toBe('auth');
  });
  it('outage probes stay transient and preserve Retry-After without starting suspicion', async () => {
    responses.project = { status: 503, retryAfter: '180' };
    expect(await recheckUploadAuth(root, {})).toMatchObject({
      recovered: false,
      retryAfterMs: 180_000,
    });
    expect((await recheckUploadAuth(root, {})).authFirstFailedAt).toBeUndefined();
  });

  it('a store without its registered id cannot conclude that a project key was revoked', async () => {
    responses.project = { status: 401 };
    db.prepare("DELETE FROM metadata WHERE key='dashboard_project_id'").run();
    const result = await recheckUploadAuth(root, { authFirstFailedAt: Date.now() - 60 * 60_000 });
    expect(result.pauseReason).toBeUndefined();
    expect(result.confirmingClient).toBeUndefined();
  });

  it('an unregistered ownerless store can recover from a transient authentication failure', async () => {
    db.prepare("DELETE FROM metadata WHERE key IN ('dashboard_project_id','owner')").run();
    expect(await recheckUploadAuth(root, {})).toMatchObject({
      recovered: true,
      ownerConfirmed: false,
    });
  });

  it('user-key-only failures require the same fifteen-minute confirmation', async () => {
    await store.removeProjectKey(root);
    responses.parent = { status: 401 };
    const now = Date.now();
    expect((await recheckUploadAuth(root, { now })).pauseReason).toBeUndefined();
    expect(
      (await recheckUploadAuth(root, { now: now + 15 * 60_000, authFirstFailedAt: now }))
        .pauseReason
    ).toBe('auth');
  });

  it('uses an environment user key only after confirming the stored owner account', async () => {
    await store.removeUserScopedKey('parent-id');
    responses.project = { status: 401 };
    process.env.RBOOK_DASHBOARD_API_KEY = 'environment';
    responses.environment = { username: 'owner', projects: [] };
    expect((await recheckUploadAuth(root, {})).confirmingClient).toBeInstanceOf(DashboardClient);
    responses.environment = { username: 'other', projects: [{ ...row, id: 'replacement' }] };
    const wrong = await recheckUploadAuth(root, { authFirstFailedAt: Date.now() - 60 * 60_000 });
    expect(wrong.pauseReason).toBeUndefined();
    expect(wrong.confirmingClient).toBeUndefined();
  });
});
