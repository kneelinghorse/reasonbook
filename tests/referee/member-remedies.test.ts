// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Members receive remedies they can follow while the host keeps its store repair instructions.
// ABOUTME: The public peer boundary covers preflight refusals and engine failures without changing codes or diagnostics.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'fs';
import { members, migrate, peer, REFEREE_ERROR_CODES, refereeStatus } from '../../src/referee';
import * as opened from '../../src/referee/open';
import * as applied from '../../src/tools/rbook/record-apply';
import { createError, createSuccess } from '../../src/tools/rbook/errors';
import { localCopyReport } from '../../src/tools/rbook/record-copy-report';
import { ReplicaRefusal, REPLICA_ERROR_CODES } from '../../src/tools/rbook/replica-identity';
import type { RbookToolResult } from '../../src/tools/rbook/types';
import { replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { ask, callerOf, hostProject } from '../helpers/referee-fixture';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-member-remedies-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

const HOST_COMMAND =
  'Run migrate() on /host/private/rbook.sqlite, then restore a snapshot in place.';
const caller = { accountId: 'member', replicaId: 'copy' };
const location = { storePath: '/unused', configDir: '/unused', expectedHead: null };
const head = { replicaId: 'referee', seq: 7, hash: 'kept' };

function answer(code: string): RbookToolResult<unknown> {
  return {
    ...createError({
      code,
      message: 'Useful diagnostic',
      suggestion: HOST_COMMAND,
      currentState: { retained: true },
      field: 'copy',
      validValues: ['a', 'b'],
    }),
    warnings: ['keep this warning'],
  };
}

describe('member-safe peer refusals (s98-m13)', () => {
  it.each([
    REFEREE_ERROR_CODES.NEEDS_RECOVERY,
    REFEREE_ERROR_CODES.MIGRATE_NEEDED,
    REFEREE_ERROR_CODES.FAILED,
    REFEREE_ERROR_CODES.HEAD_REQUIRED,
    REFEREE_ERROR_CODES.NOT_READY,
    ...Object.values(REPLICA_ERROR_CODES),
    'DB_QUERY_FAILED',
    'FUTURE_HOST_FAILURE',
    'constructor',
    'toString',
    '__proto__',
  ])(
    'translates %s after the whole peer call while preserving code, status and diagnostics',
    async (code) => {
      const result = answer(code);
      jest.spyOn(opened, 'withReferee').mockResolvedValue({ result, head });
      const done = await peer(location, 'hello', {}, caller);
      expect(done.head).toBe(head);
      expect(done.result.error?.suggestion).not.toBe(HOST_COMMAND);
      expect(done.result.error?.suggestion).toMatch(/dashboard|owner/i);
      expect(done.result.error?.suggestion).not.toMatch(/migrate\(\)|\/host\/|restore a snapshot/);
      expect({ ...done.result, error: { ...done.result.error, suggestion: HOST_COMMAND } }).toEqual(
        result
      );
      expect(refereeStatus(done.result)).toBe(refereeStatus(result));
      expect(result.error?.suggestion).toBe(HOST_COMMAND);
    }
  );

  it.each([
    REFEREE_ERROR_CODES.NOT_A_MEMBER,
    REFEREE_ERROR_CODES.REMOVED,
    REFEREE_ERROR_CODES.METHOD_REFUSED,
    REFEREE_ERROR_CODES.FORGED_REPLICA,
    REFEREE_ERROR_CODES.OWNER_ONLY,
    REFEREE_ERROR_CODES.FORGED_RENUMBER,
    REFEREE_ERROR_CODES.MALFORMED,
    REFEREE_ERROR_CODES.PROTOCOL_NEWER,
    REFEREE_ERROR_CODES.READS_OLD_PROTOCOL,
    REFEREE_ERROR_CODES.CLOCK_AHEAD,
    REFEREE_ERROR_CODES.NAME_TAKEN,
  ])('keeps the already member-facing %s remedy', async (code) => {
    const result = {
      ...answer(code),
      error: {
        ...answer(code).error!,
        suggestion: 'Ask the owner to share this project with your account.',
      },
    };
    jest.spyOn(opened, 'withReferee').mockResolvedValue({ result, head });
    const done = await peer(location, 'hello', {}, caller);
    expect(done.result).toBe(result);
  });

  it('a moveBack already in progress asks about handover state, without telling the owner to share again', async () => {
    const hosted = await hostProject(fixture.tmp);
    const owner = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
    const admitted = await ask(hosted.referee, (at) =>
      peer(at, 'admitSuccessor', { replicaId: owner.replicaId }, owner)
    );
    expect(admitted.success).toBe(true);
    const successor = { ...owner, replicaId: (admitted.data as { replicaId: string }).replicaId };
    const reported = await ask(hosted.referee, (at) =>
      peer(at, 'hello', localCopyReport(), successor)
    );
    expect(reported.error).toBeUndefined();
    const moving = await ask(hosted.referee, (at) => peer(at, 'moveBack', {}, successor));
    expect(moving.success).toBe(true);
    const refused = await ask(hosted.referee, (at) => peer(at, 'moveBack', {}, successor));
    expect(refused.error).toMatchObject({
      code: REFEREE_ERROR_CODES.NOT_READY,
      message:
        "This project's referee does not hold the record just now, so it moves nothing back.",
      suggestion: expect.stringMatching(/handover state.*dashboard.*sync.*retry/i),
    });
    expect(refused.error?.suggestion).not.toMatch(/finish sharing|share.*again/i);
  });

  it('leaves successful data and warnings untouched', async () => {
    const result = createSuccess({ retained: true }, ['kept']);
    jest.spyOn(opened, 'withReferee').mockResolvedValue({ result, head });
    expect((await peer(location, 'hello', {}, caller)).result).toBe(result);
  });

  it('gives members safe migration and recovery actions while host calls keep their repair steps', async () => {
    const hosted = await hostProject(fixture.tmp);
    const owner = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
    const db = new Database(hosted.referee.storePath);
    try {
      db.exec('DROP TRIGGER record_capture_missions_insert');
    } finally {
      db.close();
    }
    const host = await ask(hosted.referee, (at) => members(at));
    const member = await ask(hosted.referee, (at) => peer(at, 'hello', {}, owner));
    expect(host.error?.suggestion).toContain('Run migrate()');
    expect(member.error).toMatchObject({
      code: REFEREE_ERROR_CODES.MIGRATE_NEEDED,
      suggestion: expect.stringMatching(/dashboard.*operator/i),
    });
    expect(member.error?.suggestion).not.toContain('Run migrate()');
    expect((await ask(hosted.referee, (at) => migrate(at))).success).toBe(true);
    expect((await ask(hosted.referee, (at) => peer(at, 'hello', {}, owner))).success).toBe(true);
    fs.renameSync(hosted.referee.storePath, `${hosted.referee.storePath}.saved`);
    const lostHost = await members(hosted.referee);
    const lostMember = await peer(hosted.referee, 'hello', {}, owner);
    expect(lostHost.result.error?.suggestion).toContain('mark it as needing recovery');
    expect(lostMember.result.error?.code).toBe(REFEREE_ERROR_CODES.NEEDS_RECOVERY);
    expect(lostMember.result.error?.suggestion).toMatch(/owner.*dashboard/i);
    expect(lostMember.result.error?.suggestion).not.toContain('mark it as needing recovery');
  });

  it.each(['returned', 'thrown'])(
    'translates an engine refusal %s from real peer dispatch',
    async (mode) => {
      const hosted = await hostProject(fixture.tmp);
      const owner = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
      const result = answer(REPLICA_ERROR_CODES.EXCHANGE_REFUSED);
      jest.spyOn(applied, 'applyRemote').mockImplementation(() => {
        if (mode === 'thrown') throw new ReplicaRefusal(result.error!);
        return result as ReturnType<typeof applied.applyRemote>;
      });
      const done = await ask(hosted.referee, (at) => peer(at, 'apply', { changes: [] }, owner));
      expect(done.error?.code).toBe(REPLICA_ERROR_CODES.EXCHANGE_REFUSED);
      expect(done.error?.message).toBe('Useful diagnostic');
      expect(done.error?.suggestion).not.toBe(HOST_COMMAND);
      expect(done.error?.suggestion).toMatch(/owner|dashboard/i);
    }
  );
});
