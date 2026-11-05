// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Renaming changes one owned record, with a dry run and refusals that write nowhere.
// ABOUTME: The loopback dashboard and upload-state assertions distinguish a rename from a new project.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import path from 'path';
import { renameFixture, type RenameFixture } from '../helpers/rename-fixture';
import { seedRbookDb } from '../helpers/seedRbookDb';
import { storedAddress } from '../../src/intelligence/legacy-compat';

let f: RenameFixture;
beforeEach(async () => {
  f = await renameFixture();
});
afterEach(async () => {
  await f?.close();
});
const writes = () => f.requests.filter((r) => r.method !== 'GET');
const identity = () =>
  f.query((db) =>
    JSON.parse(
      (
        db.prepare("SELECT content FROM contexts WHERE id='project_identity'").get() as {
          content: string;
        }
      ).content
    )
  );

describe('the rename previews before writing', () => {
  it('heals the missing registered flag only after its project key uploads the renamed store', async () => {
    f.metadata('dashboard_registered', null);
    const result = await f.run(['--apply']);
    expect(result).toMatchObject({ code: 0 });
    expect(
      f.query((db) =>
        db.prepare("SELECT value FROM metadata WHERE key='dashboard_registered'").get()
      )
    ).toEqual({ value: 'true' });
    expect(writes().map((row) => row.url)).toEqual([
      '/api/projects/rename-remote',
      '/api/sync/sqlite-backfill',
    ]);
  });
  it('previews from an explicit root and scratch HOME without changing the store, registry or dashboard', async () => {
    const before = f.snapshot(),
      upload = f.uploadState();
    const result = await f.run();
    expect(result).toMatchObject({ code: 0 });
    expect(result.result).toMatchObject({ success: true, data: { dryRun: true } });
    expect(result.out).toContain('rbook://tester/after');
    expect(f.snapshot()).toEqual(before);
    expect(f.uploadState()).toEqual(upload);
    expect(writes()).toEqual([]);
  });

  it('updates the dashboard name and slug, the local identity, the registry and one upload', async () => {
    const result = await f.run(['--apply']);
    expect(result).toMatchObject({ code: 0 });
    expect(f.remote).toMatchObject({ name: 'After', slug: 'after' });
    const values = f.query((db) =>
      Object.fromEntries(
        (
          db.prepare('SELECT key,value FROM metadata').all() as Array<{
            key: string;
            value: string;
          }>
        ).map((x) => [x.key, x.value])
      )
    );
    expect(values).toMatchObject({
      project_id: 'rename-local',
      dashboard_project_id: 'rename-remote',
      project_name: 'After',
      dashboard_slug: 'after',
      dashboard_project_name: 'After',
    });
    expect(JSON.parse(values.previous_rbook_addresses)).toEqual(['rbook://tester/before']);
    expect(identity().project_name).toBe('After');
    expect(storedAddress(identity())).toBe('cmos://tester/after');
    expect(
      f.query((db) =>
        JSON.parse(
          (
            db.prepare("SELECT content FROM contexts WHERE id='master_context'").get() as {
              content: string;
            }
          ).content
        )
      )
    ).toMatchObject({ project_identity: { name: 'After', keep: 'untouched' }, keep: 123 });
    expect(f.graph.get('rename-local')?.name).toBe('After');
    expect(f.graph.readUploadState('rename-local')).toMatchObject({
      lastOutcome: 'success',
      leaseToken: null,
    });
    expect(writes().map((x) => x.url)).toEqual([
      '/api/projects/rename-remote',
      '/api/sync/sqlite-backfill',
    ]);
    expect(f.requests.some((x) => x.url.includes('register'))).toBe(false);
  });

  it('repeats an already completed rename without local writes, another PATCH or an upload', async () => {
    expect((await f.run(['--apply'])).code).toBe(0);
    const before = f.snapshot(),
      upload = f.uploadState();
    f.requests.length = 0;
    const result = await f.run(['--apply']);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/already renamed/i);
    expect(f.snapshot()).toEqual(before);
    expect(f.uploadState()).toEqual(upload);
    expect(writes()).toEqual([]);
  });

  it('uses the legacy layout as its exact path tie without moving the folder', async () => {
    f.legacy();
    expect((await f.run(['--apply'])).code).toBe(0);
    expect(f.file).toBe(path.join(f.root, 'cmos/db/cmos.sqlite'));
    expect(f.remote.localDbPath).toBe(f.file);
  });

  it('warns about a differing display name without refusing its exact id, slug and store path', async () => {
    f.remote.name = 'Older display name';
    const result = await f.run();
    expect(result.code).toBe(0);
    expect(result.out).toContain('Older display name');
    expect(result.out).toContain('Before');
    expect(writes()).toEqual([]);
  });
});

describe('a refusal before the PATCH writes nowhere', () => {
  it.each(['owner', 'dashboard_slug', 'dashboard_project_id'])(
    'refuses a SQL NULL %s before any request',
    async (key) => {
      f.query((db) => {
        // A foreign/older store can lack today's NOT NULL constraint.
        db.exec(
          'ALTER TABLE metadata RENAME TO original_metadata; CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT); INSERT INTO metadata SELECT * FROM original_metadata; DROP TABLE original_metadata;'
        );
        db.prepare('UPDATE metadata SET value=NULL WHERE key=?').run(key);
      });
      const before = f.snapshot(),
        upload = f.uploadState();
      const result = await f.run(['--apply']);
      expect(result.code).toBe(1);
      expect(result.result?.error?.suggestion).toBeTruthy();
      expect(f.snapshot()).toEqual(before);
      expect(f.uploadState()).toEqual(upload);
      expect(f.requests).toEqual([]);
    }
  );
  it.each(['owner', 'dashboard_slug', 'dashboard_project_id'])(
    'refuses missing %s with a remedy',
    async (key) => {
      f.metadata(key, null);
      const before = f.snapshot(),
        upload = f.uploadState();
      const result = await f.run(['--apply']);
      expect(result.code).toBe(1);
      expect(result.result?.error?.suggestion).toBeTruthy();
      expect(f.snapshot()).toEqual(before);
      expect(f.uploadState()).toEqual(upload);
      expect(writes()).toEqual([]);
    }
  );

  it.each(['project_identity', 'master_context'])(
    'requires the existing %s identity before a network write',
    async (context) => {
      f.query((db) =>
        context === 'project_identity'
          ? db.prepare('DELETE FROM contexts WHERE id=?').run(context)
          : db.prepare('UPDATE contexts SET content=? WHERE id=?').run('{}', context)
      );
      const before = f.snapshot(),
        upload = f.uploadState();
      expect((await f.run(['--apply'])).code).toBe(1);
      expect(f.snapshot()).toEqual(before);
      expect(f.uploadState()).toEqual(upload);
      expect(writes()).toEqual([]);
    }
  );

  it.each([
    'wrong account',
    'unlisted id',
    'another file',
    'same-folder other layout',
    'archived',
    'registry at another folder',
    'archived registry at another folder',
    'archived registry at this folder',
    'deleted pause',
    'replaced pause',
    'shared record',
    'taken address',
  ])('%s cannot rename or mark an upload owed', async (reason) => {
    if (reason === 'wrong account') f.remote.username = 'another';
    if (reason === 'unlisted id') f.remote.listed = false;
    if (reason === 'another file')
      f.remote.localDbPath = path.join(f.tmp, 'another/rbook/db/rbook.sqlite');
    if (reason === 'same-folder other layout')
      f.remote.localDbPath = path.join(f.root, 'cmos/db/cmos.sqlite');
    if (reason === 'archived') f.remote.archivedAt = new Date(Date.now() - 1000).toISOString();
    if (reason === 'registry at another folder')
      f.registry((db) =>
        db.prepare("UPDATE projects SET store_path=? WHERE project_id='rename-local'").run(f.tmp)
      );
    if (reason.startsWith('archived registry'))
      f.registry((db) =>
        db
          .prepare("UPDATE projects SET store_path=?,archived_at=? WHERE project_id='rename-local'")
          .run(reason.endsWith('another folder') ? f.tmp : f.root, Date.now())
      );
    if (reason === 'deleted pause' || reason === 'replaced pause') {
      f.graph.markUploadOwed('rename-local', Date.now(), true);
      const lease = f.graph.claimUpload('rename-local', true)!;
      expect(lease).toBeTruthy();
      f.graph.finishUpload('rename-local', lease, {
        success: false,
        pauseReason: reason.startsWith('deleted') ? 'deleted' : 'replaced',
        error: reason,
      });
    }
    if (reason === 'shared record') f.metadata('replica_id', 'damaged-copy');
    if (reason === 'taken address') {
      const other = path.join(f.tmp, 'other');
      seedRbookDb(other, {
        projectId: 'other',
        owner: 'tester',
        rbookAddress: 'rbook://tester/after',
      });
      f.graph.register({ project_id: 'other', store_path: other, name: 'Other' });
    }
    const before = f.snapshot(),
      upload = f.uploadState();
    const result = await f.run(['--apply']);
    expect(result.code).toBe(1);
    expect(result.result?.error?.suggestion).toBeTruthy();
    expect(f.snapshot()).toEqual(before);
    expect(f.uploadState()).toEqual(upload);
    expect(writes()).toEqual([]);
    if (reason === 'shared record') expect(f.requests).toEqual([]);
  });

  it.each([400, 401, 403, 404, 409])(
    'a confirmed HTTP %s refusal never claims the upload lease',
    async (status) => {
      f.remote.patchStatus = status;
      const before = f.snapshot(),
        upload = f.uploadState();
      const result = await f.run(['--apply']);
      expect(result.code).toBe(1);
      expect(f.snapshot()).toEqual(before);
      expect(f.uploadState()).toEqual(upload);
      expect(writes().map((x) => x.url)).toEqual(['/api/projects/rename-remote']);
    }
  );
});
