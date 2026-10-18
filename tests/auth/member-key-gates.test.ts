// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A shared record's copied dashboard identity never authorizes a member to replace owner keys.
// ABOUTME: Exercises real owner/member stores through dispatch and startup before any credential work.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CredentialStore } from '../../src/intelligence/credential-store';
import { runStartupProjectKeyRecovery } from '../../src/auth/project-key-capture';
import { rbookAuth } from '../../src/tools/rbook/rbook-auth';
import { memberCopy, ownerCopy, shareExisting } from '../helpers/shared-copies';
import { requiresPrivateEvidence } from '../helpers/public-mirror';
import { reidentifyRbookTestStore } from '../helpers/seedRbookDb';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';

let fixture: ReplicaFixture;
const PRIVATE = requiresPrivateEvidence({
  reason: "The ownership gate is also checked on a copy of this repository's historical store.",
  revisions: { release: 'v4.0.2' },
});
beforeEach(() => {
  fixture = replicaFixture('rbook-member-keys-');
});
afterEach(() => fixture.restore());

it.each(['rotate', 'reissue'] as const)(
  '%s refuses a real member copy through dispatch before touching its credentials',
  async (action) => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    useMachine(fixture.tmp, member.machine);
    const store = await CredentialStore.create();
    const now = new Date().toISOString();
    await store.upsertProjectKey(member.root, {
      key: 'cmk_preserve_member_local_key',
      keyId: 'member-key',
      parentKeyId: 'test-user',
      label: 'test',
      issuedAt: now,
      lastUsedAt: now,
    });
    const before = await store.getProjectKey(member.root);
    const result = await call('rbook_auth', { action, projectRoot: member.root });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'DASHBOARD_OWNER_REQUIRED' },
    });
    expect(result.error?.suggestion).toContain("owner's copy");
    expect(await (await CredentialStore.create()).getProjectKey(member.root)).toEqual(before);
  },
  60000
);

it('startup refuses a member before metadata, credentials or network recovery', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const member = await memberCopy(fixture.tmp, owner, 'member', 1);
  useMachine(fixture.tmp, member.machine);
  const metadataReader = jest.fn(async () => ({ registered: true, projectId: 'owner-project' }));
  const result = await runStartupProjectKeyRecovery({
    projectRoot: member.root,
    metadataReader,
  });
  expect(result.status).toBe('skipped-member-copy');
  expect(result.message).toContain("owner's copy");
  expect(metadataReader).not.toHaveBeenCalled();
}, 60000);

it('owner and solo stores still reach the existing credential action', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const solo = project(fixture.tmp, 'solo');
  for (const copy of [owner, { root: solo, machine: 'solo' }]) {
    useMachine(fixture.tmp, copy.machine);
    const reader = jest.fn(async () => null);
    const result = await rbookAuth(
      { action: 'reissue', projectRoot: copy.root },
      { projectIdReader: reader }
    );
    expect(result.error?.code).toBe('PROJECT_NOT_REGISTERED');
    expect(reader).toHaveBeenCalledWith(copy.root);
  }
}, 60000);

it('foreign/NULL metadata remains unshared and a later shared table is re-read', async () => {
  const root = path.join(fixture.tmp, 'foreign');
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  const db = new Database(dbOf(root));
  try {
    const reader = jest.fn(async () => null);
    const check = () =>
      rbookAuth({ action: 'reissue', projectRoot: root }, { projectIdReader: reader });
    expect((await check()).error?.code).toBe('PROJECT_NOT_REGISTERED');
    db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)');
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('project_id', 'foreign');
    db.prepare('INSERT INTO metadata VALUES (?,?)').run('replica_id', null);
    expect((await check()).error?.code).toBe('PROJECT_NOT_REGISTERED');
    reader.mockClear();
    db.prepare("UPDATE metadata SET value='broken-copy' WHERE key='replica_id'").run();
    // A replica id predates the shared-record log. Only a log makes this a recorded copy.
    db.exec('CREATE TABLE record_changes(change_id TEXT)');
    expect((await check()).error?.code).toBe('DASHBOARD_OWNER_REQUIRED');
    expect(reader).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it('an unreadable existing store fails visibly before credential resolution', async () => {
  const root = path.join(fixture.tmp, 'damaged');
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  fs.writeFileSync(dbOf(root), 'not sqlite');
  const reader = jest.fn(async () => 'owner-project');
  const result = await rbookAuth(
    { action: 'reissue', projectRoot: root },
    { projectIdReader: reader }
  );
  expect(result.error?.code).toBe('DASHBOARD_OWNER_UNREADABLE');
  expect(result.error?.suggestion).toBeTruthy();
  expect(reader).not.toHaveBeenCalled();
});

PRIVATE.describe('ownership on a historical project store', () => {
  it('refuses the member copy of the real record before key recovery', async () => {
    const root = path.join(fixture.tmp, 'historical');
    fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
    fs.writeFileSync(
      dbOf(root),
      execFileSync('git', ['show', `${PRIVATE.revisions.release}:rbook/db/rbook.sqlite`], {
        cwd: path.resolve(__dirname, '../..'),
        maxBuffer: 256 * 1024 * 1024,
      })
    );
    reidentifyRbookTestStore(root);
    const owner = await shareExisting(fixture.tmp, root, 'historical-owner');
    const member = await memberCopy(fixture.tmp, owner, 'historical-member', 1);
    useMachine(fixture.tmp, member.machine);
    const result = await call('rbook_auth', { action: 'reissue', projectRoot: member.root });
    expect(result.error?.code).toBe('DASHBOARD_OWNER_REQUIRED');
  }, 120000);
});
