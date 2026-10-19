// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 (design §What plan time settled, fact 32) — every call checks the store against the head the last call
// ABOUTME: returned: a missing store, one restored behind it or forked from it is refused as needing recovery, changing nothing.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { invite, members, peer, REFEREE_ERROR_CODES, recentChanges } from '../../src/referee';
import { replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { ask, callerOf, hostProject, type Hosted } from '../helpers/referee-fixture';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-head-');
});
afterEach(() => fixture.restore());

/** The referee's store and its whole config folder, kept as a volume snapshot keeps them. */
function snapshotVolume(hosted: Hosted): () => void {
  const store = hosted.referee.storePath;
  const db = new Database(store);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  const bytes = fs.readFileSync(store);
  const config = hosted.referee.configDir;
  const saved = path.join(fixture.tmp, `saved-config-${Date.now()}`);
  fs.cpSync(config, saved, { recursive: true });
  // A restore writes the same files back, inode and all, with the registry beside them.
  return () => {
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${store}${suffix}`, { force: true });
    fs.writeFileSync(store, bytes);
    fs.rmSync(config, { recursive: true, force: true });
    fs.cpSync(saved, config, { recursive: true });
  };
}

const stored = (hosted: Hosted): number => {
  const db = new Database(hosted.referee.storePath, { readonly: true });
  try {
    return (db.prepare('SELECT count(*) AS n FROM record_changes').get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe("the referee's stream head (s97-m09)", () => {
  it('reads a store it cannot open just now as a retry, not as lost, and serves it again once it can', async () => {
    const hosted = await hostProject(fixture.tmp);
    fs.chmodSync(hosted.referee.storePath, 0o000);
    try {
      const busy = await ask(hosted.referee, (location) => members(location));
      expect(busy.error?.code).toBe(REFEREE_ERROR_CODES.FAILED);
    } finally {
      fs.chmodSync(hosted.referee.storePath, 0o644);
    }
    expect((await ask(hosted.referee, (location) => members(location))).error).toBeUndefined();
    // A file that is no database at all is lost, not busy.
    fs.writeFileSync(hosted.referee.storePath, 'not a database');
    for (const suffix of ['-wal', '-shm'])
      fs.rmSync(`${hosted.referee.storePath}${suffix}`, { force: true });
    expect((await ask(hosted.referee, (location) => members(location))).error?.code).toBe(
      REFEREE_ERROR_CODES.NEEDS_RECOVERY
    );
  }, 180000);

  it('moves when the referee writes and stays when a call only reads', async () => {
    const hosted = await hostProject(fixture.tmp);
    const owner = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
    const start = hosted.referee.expectedHead!;
    expect(start).toMatchObject({
      replicaId: hosted.refereeReplica,
      seq: expect.any(Number),
      hash: expect.any(String),
    });
    await ask(hosted.referee, (location) => peer(location, 'hello', {}, owner));
    await ask(hosted.referee, (location) => members(location));
    await ask(hosted.referee, (location) => recentChanges(location));
    expect(hosted.referee.expectedHead).toEqual(start);
    await ask(hosted.referee, (location) =>
      invite(location, { accountId: 'acct-darryl', name: 'darryl' })
    );
    expect(hosted.referee.expectedHead!.seq).toBe(start.seq + 1);
    expect(hosted.referee.expectedHead!.hash).not.toBe(start.hash);
  }, 180000);

  it('refuses a store restored behind the recorded head, with its registry, as needing recovery, and changes nothing', async () => {
    const hosted = await hostProject(fixture.tmp);
    const restore = snapshotVolume(hosted);
    await ask(hosted.referee, (location) =>
      invite(location, { accountId: 'acct-darryl', name: 'darryl' })
    );
    const recorded = hosted.referee.expectedHead!;
    restore();
    const before = stored(hosted);
    const refused = await ask(hosted.referee, (location) => members(location));
    expect(refused.error).toMatchObject({
      code: REFEREE_ERROR_CODES.NEEDS_RECOVERY,
      message: expect.stringMatching(/holds less of its own stream than the last call left/),
    });
    expect(hosted.referee.expectedHead).toEqual(recorded);
    expect(stored(hosted)).toBe(before);
  }, 180000);

  it('refuses a store whose own stream forked from the recorded head', async () => {
    const hosted = await hostProject(fixture.tmp);
    const earlier = hosted.referee.expectedHead!;
    const restore = snapshotVolume(hosted);
    await ask(hosted.referee, (location) =>
      invite(location, { accountId: 'acct-darryl', name: 'darryl' })
    );
    const recorded = hosted.referee.expectedHead!;
    restore();
    // The restored store writes again from the earlier head: the same slot, another change.
    hosted.referee.expectedHead = earlier;
    await ask(hosted.referee, (location) =>
      invite(location, { accountId: 'acct-erin', name: 'erin' })
    );
    expect(hosted.referee.expectedHead!.seq).toBe(recorded.seq);
    hosted.referee.expectedHead = recorded;
    const refused = await ask(hosted.referee, (location) => members(location));
    expect(refused.error).toMatchObject({
      code: REFEREE_ERROR_CODES.NEEDS_RECOVERY,
      message: expect.stringMatching(/differs from the one the last call left/),
    });
  }, 180000);

  it('refuses a missing store, a copied-in file and a call with no head', async () => {
    const hosted = await hostProject(fixture.tmp);
    const recorded = hosted.referee.expectedHead;
    hosted.referee.expectedHead = null;
    expect((await ask(hosted.referee, (location) => members(location))).error?.code).toBe(
      REFEREE_ERROR_CODES.HEAD_REQUIRED
    );
    hosted.referee.expectedHead = recorded;
    // A file copied in place is a new file, which the store's own copy check reads as restored (fact 27).
    const store = hosted.referee.storePath;
    const db = new Database(store);
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    const copied = `${store}.copy`;
    fs.copyFileSync(store, copied);
    fs.rmSync(store);
    fs.renameSync(copied, store);
    const restored = await ask(hosted.referee, (location) => members(location));
    expect(restored.error).toMatchObject({
      code: REFEREE_ERROR_CODES.NEEDS_RECOVERY,
      message: expect.stringMatching(/restored backup or a replaced folder/),
    });
    fs.rmSync(store);
    expect((await ask(hosted.referee, (location) => members(location))).error).toMatchObject({
      code: REFEREE_ERROR_CODES.NEEDS_RECOVERY,
      message: expect.stringMatching(/store file is missing/),
    });
    expect(fs.existsSync(store)).toBe(false);
  }, 180000);
});
