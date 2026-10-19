// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 — the referee library's remaining refusals, each reached and, where its remedy is a call, the remedy run:
// ABOUTME: calls before the join, malformed arguments, a taken name, guards needing migrate, a step or folder that fails.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import {
  applyJoinAnswer,
  createReferee,
  discardReferee,
  invite,
  makeFirstCopy,
  members,
  migrate,
  peer,
  recentChanges,
  REFEREE_ERROR_CODES,
  refereeStatus,
  remove,
  type JoinAnswer,
} from '../../src/referee';
import { createError } from '../../src/tools/rbook/errors';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { answerJoin } from '../../src/tools/rbook/record-join';
import { dbOf, replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import {
  ask,
  callerOf,
  hostProject,
  joinedReferee,
  refereeAt,
  syncWithReferee,
} from '../helpers/referee-fixture';
import { handOver } from '../../src/tools/rbook/record-moves';
import { changesSince } from '../../src/tools/rbook/record-since';
import { onCopy, ownerCopy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-remedy-');
});
afterEach(() => fixture.restore());

describe("the referee's remaining remedies (s97-m09)", () => {
  it('before its join, a referee serves nothing; once the owner answers, the same calls run', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const referee = refereeAt(fixture.tmp);
    const upload = path.join(fixture.tmp, 'upload.sqlite');
    await buildFreshCopy(dbOf(owner.root), upload);
    expect(
      (await createReferee(referee, { copyFile: upload, ownerAccountId: '' })).result.error?.code
    ).toBe(REFEREE_ERROR_CODES.MALFORMED);
    const created = await ask(referee, (location) =>
      createReferee(location, { copyFile: upload, ownerAccountId: 'acct-owner' })
    );
    const ownerCaller = { accountId: 'acct-owner', replicaId: owner.replicaId };
    const first = path.join(fixture.tmp, 'first', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(first), { recursive: true });
    const before = [
      await ask(referee, (location) => peer(location, 'hello', {}, ownerCaller)),
      await ask(referee, (location) => members(location)),
      await ask(referee, (location) => recentChanges(location)),
      await ask(referee, (location) => makeFirstCopy(location, first)),
    ];
    expect(before.map((answer) => answer.error?.code)).toEqual(
      Array(4).fill(REFEREE_ERROR_CODES.NOT_READY)
    );
    // An answer that admits the referee as some other member is refused; the owner's own is taken.
    const answer = await onCopy(fixture.tmp, owner, (client) =>
      answerJoin(client, created.data!.joinRequest, 'Owner')
    );
    const asMember = { ...answer.data!, role: 'editor' } as JoinAnswer;
    expect(
      (await ask(referee, (location) => applyJoinAnswer(location, asMember))).error?.code
    ).toBe(REFEREE_ERROR_CODES.MALFORMED);
    expect(
      (await ask(referee, (location) => applyJoinAnswer(location, answer.data!))).error
    ).toBeUndefined();
    expect(
      (await ask(referee, (location) => applyJoinAnswer(location, answer.data!))).error?.code
    ).toBe(REFEREE_ERROR_CODES.METHOD_REFUSED);
    const after = [
      await ask(referee, (location) => peer(location, 'hello', {}, ownerCaller)),
      await ask(referee, (location) => members(location)),
      await ask(referee, (location) => recentChanges(location)),
    ];
    expect(after.map((done) => done.error)).toEqual(Array(3).fill(undefined));
    // Joined but not yet the authority, it hands out no first copy: its member would hold the move
    // unconfirmed (critics, round 2).
    expect((await ask(referee, (location) => makeFirstCopy(location, first))).error?.code).toBe(
      REFEREE_ERROR_CODES.NOT_READY
    );
  }, 180000);

  it('mid-move, between the pages of a catch-up, no first copy is made; after the last page it is', async () => {
    const joined = await joinedReferee(fixture.tmp);
    await syncWithReferee(fixture.tmp, joined, joined.owner, joined.ownerAccount);
    const moved = await onCopy(fixture.tmp, joined.owner, (client) =>
      handOver(client, { to: joined.refereeReplica })
    );
    expect(moved.error).toBeUndefined();
    const relay = await callerOf(fixture.tmp, joined.owner, joined.ownerAccount);
    const said = await ask(joined.referee, (location) => peer(location, 'hello', {}, relay));
    const marks = (said.data as { marks: Record<string, number> }).marks;
    const page = await onCopy(fixture.tmp, joined.owner, (client) => changesSince(client, marks));
    const first = path.join(fixture.tmp, 'mid', 'rbook.sqlite');
    fs.mkdirSync(path.dirname(first), { recursive: true });
    expect(
      (
        await ask(joined.referee, (location) =>
          peer(location, 'apply', { changes: page, judge: false, catchUp: true, more: true }, relay)
        )
      ).error
    ).toBeUndefined();
    expect(
      (await ask(joined.referee, (location) => makeFirstCopy(location, first))).error?.code
    ).toBe(REFEREE_ERROR_CODES.NOT_READY);
    expect(
      (
        await ask(joined.referee, (location) =>
          peer(location, 'apply', { changes: [], judge: false, catchUp: true }, relay)
        )
      ).error
    ).toBeUndefined();
    expect(
      (await ask(joined.referee, (location) => makeFirstCopy(location, first))).error
    ).toBeUndefined();
  }, 180000);

  it('a referee that never joined is discarded, so a lost answer starts the handover in over', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const referee = refereeAt(fixture.tmp);
    const upload = path.join(fixture.tmp, 'upload.sqlite');
    await buildFreshCopy(dbOf(owner.root), upload);
    const created = await ask(referee, (location) =>
      createReferee(location, { copyFile: upload, ownerAccountId: 'acct-owner' })
    );
    // The owner's copy admits it, and the answer is lost before the referee applies it.
    const lost = await onCopy(fixture.tmp, owner, (client) =>
      answerJoin(client, created.data!.joinRequest, 'Owner')
    );
    expect(lost.error).toBeUndefined();
    expect((await ask(referee, (location) => discardReferee(location))).data).toEqual({
      discarded: created.data!.joinRequest.replicaId,
    });
    expect(fs.existsSync(referee.storePath)).toBe(false);
    referee.expectedHead = null;
    const again = await ask(referee, (location) =>
      createReferee(location, { copyFile: upload, ownerAccountId: 'acct-owner' })
    );
    expect(again.data!.joinRequest.replicaId).not.toBe(created.data!.joinRequest.replicaId);
    const answer = await onCopy(fixture.tmp, owner, (client) =>
      answerJoin(client, again.data!.joinRequest, 'Owner')
    );
    expect(
      (await ask(referee, (location) => applyJoinAnswer(location, answer.data!))).error
    ).toBeUndefined();
    // Joined, it is never discarded: it holds the record.
    expect((await ask(referee, (location) => discardReferee(location))).error?.code).toBe(
      REFEREE_ERROR_CODES.METHOD_REFUSED
    );
  }, 180000);

  it('refuses an upload that is no shared record, building nothing, and the owner then sends a real one', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const referee = refereeAt(fixture.tmp);
    const plain = path.join(fixture.tmp, 'plain.sqlite');
    const solo = new Database(dbOf(owner.root));
    try {
      solo.exec(`VACUUM INTO '${plain}'`);
    } finally {
      solo.close();
    }
    const edited = new Database(plain);
    try {
      edited.exec("DELETE FROM metadata WHERE key IN ('replica_id', 'replica_block')");
    } finally {
      edited.close();
    }
    const refused = await createReferee(referee, { copyFile: plain, ownerAccountId: 'acct-owner' });
    expect(refused.result.error?.code).toBe(REFEREE_ERROR_CODES.UPLOAD_REFUSED);
    expect(fs.existsSync(referee.storePath)).toBe(false);
    // An owner whose clock reads past any clock's is refused before the handover, which it could not finish.
    const broken = path.join(fixture.tmp, 'broken-clock.sqlite');
    await buildFreshCopy(dbOf(owner.root), broken);
    const clock = new Database(broken);
    try {
      clock
        .prepare("UPDATE metadata SET value = '9999999999990-000000' WHERE key = 'replica_hlc'")
        .run();
    } finally {
      clock.close();
    }
    const clockRefused = await createReferee(referee, {
      copyFile: broken,
      ownerAccountId: 'acct-owner',
    });
    expect(clockRefused.result.error).toMatchObject({
      code: REFEREE_ERROR_CODES.UPLOAD_REFUSED,
      message: expect.stringMatching(/past the year 2200/),
    });
    expect(fs.existsSync(referee.storePath)).toBe(false);
    const upload = path.join(fixture.tmp, 'upload.sqlite');
    await buildFreshCopy(dbOf(owner.root), upload);
    expect(
      (await createReferee(referee, { copyFile: upload, ownerAccountId: 'acct-owner' })).result
        .error
    ).toBeUndefined();
  }, 180000);

  it('answers a store another writer holds as a busy moment, which the host tries again (503)', () => {
    // The engine's own answer when the store is locked: a host retries a 503 and keeps a 409.
    const locked = createError({
      code: 'DB_CONNECTION_FAILED',
      message: 'Database is locked by another process',
    });
    expect(refereeStatus(locked)).toBe(503);
  });

  it('membership refusals: malformed arguments, a viewer role, a taken name and an unknown account', async () => {
    const hosted = await hostProject(fixture.tmp);
    const { referee } = hosted;
    expect(
      (await ask(referee, (location) => invite(location, { accountId: '', name: 'x' }))).error?.code
    ).toBe(REFEREE_ERROR_CODES.MALFORMED);
    expect(
      (
        await ask(referee, (location) =>
          invite(location, { accountId: 'acct-v', name: 'v', role: 'viewer' })
        )
      ).error?.code
    ).toBe(REFEREE_ERROR_CODES.MALFORMED);
    // The owner's name is taken, and so is one that reads the same, as the published code (the
    // dashboard keeps NAME_TAKEN as a refusal; its s62-m06 ask). The same person under a name
    // that tells them apart is added.
    expect(
      (await ask(referee, (location) => invite(location, { accountId: 'acct-o2', name: 'Owner' })))
        .error?.code
    ).toBe(REFEREE_ERROR_CODES.NAME_TAKEN);
    expect(
      (await ask(referee, (location) => invite(location, { accountId: 'acct-o2', name: 'owner' })))
        .error?.code
    ).toBe(REFEREE_ERROR_CODES.NAME_TAKEN);
    expect(
      (
        await ask(referee, (location) =>
          invite(location, { accountId: 'acct-o2', name: 'Owner B' })
        )
      ).error
    ).toBeUndefined();
    expect(
      (await ask(referee, (location) => remove(location, { accountId: 'acct-nobody' }))).error?.code
    ).toBe(REFEREE_ERROR_CODES.NOT_A_MEMBER);
    const unknownSince = await ask(referee, (location) =>
      recentChanges(location, { sinceChangeId: 'not-a-change' })
    );
    expect(unknownSince.error?.code).toBe(REFEREE_ERROR_CODES.MALFORMED);
    expect((await ask(referee, (location) => recentChanges(location))).error).toBeUndefined();
  }, 180000);

  it('guards this version records differently ask for migrate, which puts them right', async () => {
    const hosted = await hostProject(fixture.tmp);
    const db = new Database(hosted.referee.storePath);
    try {
      db.exec('DROP TRIGGER record_capture_missions_insert');
    } finally {
      db.close();
    }
    const owner = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
    const stale = await ask(hosted.referee, (location) => peer(location, 'hello', {}, owner));
    expect(stale.error?.code).toBe(REFEREE_ERROR_CODES.MIGRATE_NEEDED);
    const migrated = await ask(hosted.referee, (location) => migrate(location));
    expect(migrated.data).toMatchObject({ guardsRebuilt: true });
    expect(
      (await ask(hosted.referee, (location) => peer(location, 'hello', {}, owner))).error
    ).toBeUndefined();
  }, 180000);

  it('a step that fails, a copy asked for with no file named, and a bindings folder that cannot be made', async () => {
    const hosted = await hostProject(fixture.tmp);
    const taken = path.join(fixture.tmp, 'taken.sqlite');
    fs.writeFileSync(taken, 'already here');
    const failed = await ask(hosted.referee, (location) => makeFirstCopy(location, taken));
    expect(failed.error?.code).toBe(REFEREE_ERROR_CODES.FAILED);
    expect((await ask(hosted.referee, (location) => makeFirstCopy(location, ''))).error?.code).toBe(
      REFEREE_ERROR_CODES.MALFORMED
    );
    const blocked = path.join(fixture.tmp, 'blocked-config');
    fs.writeFileSync(blocked, 'a file where the folder goes');
    const outcome = await members({ ...hosted.referee, configDir: blocked });
    expect(outcome.result.error?.code).toBe(REFEREE_ERROR_CODES.FAILED);
    expect((await ask(hosted.referee, (location) => members(location))).error).toBeUndefined();
  }, 180000);
});
