// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Partial renames converge without treating a refused PATCH as an upload.
// ABOUTME: Real SQLite rollback, lock contention and lease exclusion preserve the identity contract.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'child_process';
import { once } from 'events';
import { renameFixture, type RenameFixture } from '../helpers/rename-fixture';

let f: RenameFixture;
let lock: ChildProcess | undefined;
beforeEach(async () => {
  f = await renameFixture();
});
afterEach(async () => {
  if (lock?.exitCode === null) {
    lock.stdin?.end();
    await once(lock, 'exit');
  }
  lock = undefined;
  await f?.close();
});
const metadata = () =>
  f.query((db) =>
    Object.fromEntries(
      (
        db.prepare('SELECT key,value FROM metadata').all() as Array<{ key: string; value: string }>
      ).map((row) => [row.key, row.value])
    )
  );

describe('the remote-first rename recovers', () => {
  it.each([false, true])(
    'converges when the PATCH already committed, with intermediate slug adoption %s',
    async (adopted) => {
      f.remote.name = 'After';
      f.remote.slug = 'after';
      if (adopted) f.metadata('dashboard_slug', 'after');
      const result = await f.run(['--apply']);
      expect(result).toMatchObject({ code: 0 });
      expect(metadata()).toMatchObject({
        project_name: 'After',
        dashboard_project_name: 'After',
        dashboard_slug: 'after',
      });
      expect(f.graph.readUploadState('rename-local')).toMatchObject({
        lastOutcome: 'success',
        leaseToken: null,
      });
    }
  );

  it.each(['commit-disconnect', 'commit-timeout'] as const)(
    'reads back a committed PATCH after %s, then completes locally',
    async (mode) => {
      f.remote.patchMode = mode;
      expect(await f.run(['--apply'])).toMatchObject({ code: 0 });
      expect(f.requests.filter((r) => r.url === '/api/projects/mine')).toHaveLength(2);
      expect(metadata().project_name).toBe('After');
      expect(f.graph.readUploadState('rename-local')?.lastOutcome).toBe('success');
    }
  );

  it('says an unconfirmed outcome is unknown, leaves upload state alone, and converges on retry', async () => {
    f.remote.patchMode = 'disconnect';
    const before = f.snapshot(),
      upload = f.uploadState();
    const failed = await f.run(['--apply']);
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/outcome is unknown/);
    expect(f.requests.filter((r) => r.url === '/api/projects/mine')).toHaveLength(2);
    expect(f.snapshot()).toEqual(before);
    expect(f.uploadState()).toEqual(upload);
    f.remote.patchMode = 'normal';
    expect(await f.run(['--apply'])).toMatchObject({ code: 0 });
  });

  it('rolls back every rename field when the last context write fails, and records the real upload', async () => {
    f.query((db) =>
      db.exec(
        "CREATE TRIGGER rename_failure BEFORE UPDATE ON contexts WHEN NEW.id='master_context' BEGIN SELECT RAISE(ABORT,'injected context failure'); END"
      )
    );
    const before = f.snapshot();
    let duringUpload: ReturnType<RenameFixture['snapshot']> | undefined;
    f.remote.beforeUpload = () => {
      duringUpload = f.snapshot();
    };
    const failed = await f.run(['--apply']);
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/dashboard is renamed.*local rename did not finish/s);
    expect(duringUpload?.contexts).toEqual(before.contexts);
    expect(metadata()).toMatchObject({ project_name: 'Before' });
    expect(metadata().dashboard_project_name).toBeUndefined();
    expect(metadata().previous_rbook_addresses).toBeUndefined();
    expect(f.requests.some((r) => r.url === '/api/sync/sqlite-backfill')).toBe(true);
    expect(f.graph.readUploadState('rename-local')).toMatchObject({
      lastOutcome: 'success',
      leaseToken: null,
    });
    f.query((db) => db.exec('DROP TRIGGER rename_failure'));
    expect(await f.run(['--apply'])).toMatchObject({ code: 0 });
    expect(metadata().project_name).toBe('After');
  });

  it('a held write lock fails the local transaction, then a rerun finishes the renamed dashboard', async () => {
    f.remote.beforePatch = async () => {
      lock = spawn(
        process.execPath,
        [
          '-e',
          `
        const db = new (require(${JSON.stringify(require.resolve('better-sqlite3'))}))(process.argv[1]);
        db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked');
        const done=()=>{if(db.open){db.exec('ROLLBACK');db.close();}process.exit(0);};
        process.stdin.resume(); process.stdin.on('end',done); setTimeout(done,6500);
      `,
          f.file,
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      await once(lock.stdout!, 'data');
    };
    const failed = await f.run(['--apply']);
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/dashboard is renamed/);
    expect(metadata().project_name).toBe('Before');
    expect(f.graph.readUploadState('rename-local')?.leaseToken).toBeNull();
    f.remote.beforePatch = undefined;
    if (lock?.exitCode === null) await once(lock, 'exit');
    expect(await f.run(['--apply'])).toMatchObject({ code: 0 });
  }, 20000);

  it('holds the lease through upload so an automatic sender cannot claim it', async () => {
    let claimed = false;
    f.remote.beforeUpload = () => {
      const state = f.graph.readUploadState('rename-local');
      expect(state?.leaseToken).toBeTruthy();
      expect(f.graph.claimUpload('rename-local', false)).toBeNull();
      claimed = true;
    };
    expect(await f.run(['--apply'])).toMatchObject({ code: 0 });
    expect(claimed).toBe(true);
  });

  it('waits for another process’s lease before writing the local identity', async () => {
    lock = spawn(
      process.execPath,
      [
        '-e',
        `
      const db = new (require(${JSON.stringify(require.resolve('better-sqlite3'))}))(process.argv[1]);
      const now=Date.now(), token='rename-other-process';
      db.prepare("UPDATE projects SET upload_lease_holder=?,upload_lease_token=?,upload_lease_expires_at=? WHERE project_id='rename-local'").run(String(process.pid),token,now+60000);
      const old=db.prepare("SELECT upload_generation AS n FROM projects WHERE project_id='rename-local'").get().n;
      process.stdout.write('ready');
      const poll=setInterval(()=>{
        if(db.prepare("SELECT upload_generation AS n FROM projects WHERE project_id='rename-local'").get().n>old){clearInterval(poll);process.stdout.write('waiting');}
      },20);
      process.stdin.resume(); process.stdin.on('end',()=>{
        db.prepare("UPDATE projects SET upload_lease_holder=NULL,upload_lease_token=NULL,upload_lease_expires_at=NULL WHERE project_id='rename-local' AND upload_lease_token=?").run(token);
        db.close();process.exit(0);
      });
    `,
        f.registryFile,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    await once(lock.stdout!, 'data');
    const before = f.snapshot();
    const waiting = once(lock.stdout!, 'data');
    const run = f.run(['--apply']);
    expect(await Promise.race([waiting.then(() => true), run.then(() => false)])).toBe(true);
    expect(f.remote.slug).toBe('after');
    expect(f.snapshot()).toEqual(before);
    expect(f.graph.claimUpload('rename-local', false)).toBeNull();
    lock.stdin!.end();
    expect(await run).toMatchObject({ code: 0 });
    expect(metadata().project_name).toBe('After');
  });

  it('records an actual failed upload, retaining pending work and ending the lease', async () => {
    f.remote.uploadStatus = 503;
    const result = await f.run(['--apply']);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/dashboard and local store are renamed/);
    expect(metadata().project_name).toBe('After');
    expect(f.graph.readUploadState('rename-local')).toMatchObject({
      lastOutcome: 'failed',
      leaseToken: null,
    });
    expect(f.graph.readUploadState('rename-local')?.firstOwedAt).not.toBeNull();
    f.remote.uploadStatus = 200;
    f.requests.length = 0;
    expect(await f.run(['--apply'])).toMatchObject({ code: 0 });
    expect(f.requests.some((request) => request.url === '/api/sync/sqlite-backfill')).toBe(true);
    expect(f.graph.readUploadState('rename-local')).toMatchObject({
      lastOutcome: 'success',
      firstOwedAt: null,
      leaseToken: null,
    });
  });
});
