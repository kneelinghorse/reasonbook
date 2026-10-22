// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Former-referee eligibility uses bounded admission evidence and skips existing cuts without inventing new ones.
// ABOUTME: Real SQLite queries isolate the shared predicate; full account/handover behavior lives in handover-members.
import Database from 'better-sqlite3';
import path from 'path';
import { createReferee, finalizeRecovery, peer, recoveryPlan } from '../../src/referee';
import { replicaMarks } from '../../src/tools/rbook/record-apply';
import { localCopyReport } from '../../src/tools/rbook/record-copy-report';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { confirmOwner } from '../../src/tools/rbook/record-moves';
import { takeSuccessor, type Successor } from '../../src/tools/rbook/record-successor';
import { dbOf, replicaFixture } from '../helpers/replica-fixture';
import { recoveryFixture } from '../helpers/recovery-fixture';
import { ask, callerOf, refereeAt, syncWithReferee } from '../helpers/referee-fixture';
import { onCopy } from '../helpers/shared-copies';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import type { RbookDatabaseClient } from '../../src/tools/rbook/client';
import * as context from '../../src/tools/rbook/record-context';
import * as membership from '../../src/tools/rbook/record-membership';
import { membersOutsideRefereeTerms } from '../../src/tools/rbook/record-referee-members';
import type { MergeContext } from '../../src/tools/rbook/record-standing';

let db: Database.Database;
let client: RbookDatabaseClient;
let ctx: MergeContext;
const present: membership.MemberView = {
  memberId: 'member',
  name: 'Darryl',
  role: 'editor',
  replicas: [{ replicaId: 'copy', block: 1 }],
};
beforeEach(() => {
  db = new Database(':memory:');
  db.exec(
    'CREATE TABLE record_changes (replica_id TEXT, replica_seq INTEGER, kind TEXT, entity_id TEXT, value TEXT)'
  );
  db.prepare('INSERT INTO record_changes VALUES (?, ?, ?, ?, ?)').run(
    'former',
    2,
    'member',
    'member',
    JSON.stringify({ name: 'Darryl', role: 'editor' })
  );
  db.prepare('INSERT INTO record_changes VALUES (?, ?, ?, ?, ?)').run(
    'former',
    3,
    'replica_joined',
    'copy',
    JSON.stringify({ member: 'member' })
  );
  client = {
    getMany: (sql: string, params: unknown[]) => ({
      success: true,
      data: db.prepare(sql).all(...params),
    }),
  } as RbookDatabaseClient;
  ctx = {
    authority: 'current',
    members: new Map([['copy', { replicaId: 'copy', member: 'member', role: 'editor', block: 1 }]]),
    terms: [
      { replicaId: 'former', cut: 3 },
      { replicaId: 'current', cut: Infinity },
    ],
    prefixes: new Map([
      ['former', 3],
      ['current', 5],
    ]),
    pending: null,
  } as unknown as MergeContext;
  jest.spyOn(context, 'mergeContext').mockImplementation(() => ctx);
  jest.spyOn(membership, 'listMembers').mockReturnValue([present]);
});
afterEach(() => {
  jest.restoreAllMocks();
  db.close();
});

it('requires proven former membership even when no replica ever joined', () => {
  jest.spyOn(membership, 'listMembers').mockReturnValue([{ ...present, replicas: [] }]);
  expect(membersOutsideRefereeTerms(client, ['former'])).toEqual([]);
  db.prepare("DELETE FROM record_changes WHERE kind='member'").run();
  expect(membersOutsideRefereeTerms(client, ['former'])).toEqual([{ ...present, replicas: [] }]);
});

it.each([0, 7])(
  'a present member with an existing cut at %s does not fail because that copy joined directly',
  (cut) => {
    db.prepare("UPDATE record_changes SET replica_id='current' WHERE kind='replica_joined'").run();
    expect(membersOutsideRefereeTerms(client, ['former'])).toEqual([present]);
    (ctx.members as Map<string, unknown>).set('copy', { ...ctx.members.get('copy'), cut });
    expect(membersOutsideRefereeTerms(client, ['former'])).toEqual([]);
  }
);

it('removed members skip membership and replica provenance entirely', () => {
  jest.spyOn(membership, 'listMembers').mockReturnValue([{ ...present, role: 'removed' }]);
  expect(membersOutsideRefereeTerms(client, [])).toEqual([]);
});

it.each(['foreign', 'current'])('a claimed %s referee cannot supply former-term evidence', (id) => {
  expect(membersOutsideRefereeTerms(client, [id])).toEqual([present]);
});

it.each(['term-cut', 'prefix', 'pending'])(
  'evidence past the %s is ignored instead of authorizing an unverified admission',
  (boundary) => {
    if (boundary === 'term-cut')
      ctx = { ...ctx, terms: [{ ...ctx.terms[0], cut: 2 }, ctx.terms[1]] };
    if (boundary === 'prefix')
      ctx = {
        ...ctx,
        prefixes: new Map([
          ['former', 2],
          ['current', 5],
        ]),
      };
    // A pending current term is never treated as a former term merely because it will move.
    if (boundary === 'pending')
      ctx = { ...ctx, authority: 'former', pending: { cut: 2 } as MergeContext['pending'] };
    expect(membersOutsideRefereeTerms(client, ['former'])).toEqual([present]);
  }
);

it('a replica admission for someone else is not this member’s account proof', () => {
  db.prepare("UPDATE record_changes SET value=? WHERE kind='replica_joined'").run(
    JSON.stringify({ member: 'somebody-else' })
  );
  expect(membersOutsideRefereeTerms(client, ['former'])).toEqual([present]);
});

it('a query failure is loud, never an empty eligible member list', () => {
  client = {
    getMany: () => ({ success: false, error: { message: 'admission query failed' } }),
  } as unknown as RbookDatabaseClient;
  expect(() => membersOutsideRefereeTerms(client, ['former'])).toThrow('admission query failed');
});

it('real recovery then move-back carries pre-loss admissions into re-share, but not a new direct SSH invitation', async () => {
  // The preceding cases isolate the predicate; this case uses the real context and member views.
  jest.restoreAllMocks();
  const fixture = replicaFixture('rbook-recovered-reshare-');
  try {
    const { hosted, input, location } = await recoveryFixture(fixture.tmp, true);
    const plan = await recoveryPlan(location, input);
    expect(plan.result.data?.ready).toBe(true);
    const recovered = await finalizeRecovery(location, {
      ...input,
      confirmedPlanHash: plan.result.data!.planHash,
      confirmedTailMembershipIds: [],
    });
    expect(recovered.result.error).toBeUndefined();
    const referee = { ...location, expectedHead: recovered.head };
    const next = { referee };
    await syncWithReferee(fixture.tmp, next, hosted.owner, hosted.ownerAccount);
    expect(
      (await onCopy(fixture.tmp, hosted.owner, (client) => confirmOwner(client))).success
    ).toBe(true);
    await syncWithReferee(fixture.tmp, next, hosted.owner, hosted.ownerAccount);
    const owner = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
    const admitted = await ask(referee, (at) =>
      peer(at, 'admitSuccessor', { replicaId: owner.replicaId }, owner)
    );
    expect(admitted.success).toBe(true);
    const held = await onCopy(
      fixture.tmp,
      hosted.owner,
      (client) => replicaMarks(client)[owner.replicaId] ?? 0
    );
    const taken = await onCopy(fixture.tmp, hosted.owner, (client) =>
      takeSuccessor(client, {
        successor: admitted.data as Successor,
        reason: 'move-back',
        authorityReceived: held,
        cut: held,
      })
    );
    expect(taken.success).toBe(true);
    const successor = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
    const reported = await ask(referee, (at) => peer(at, 'hello', localCopyReport(), successor));
    expect(reported.error).toBeUndefined();
    expect((await ask(referee, (at) => peer(at, 'moveBack', {}, successor))).success).toBe(true);
    await syncWithReferee(fixture.tmp, next, hosted.owner, hosted.ownerAccount);
    expect(
      (await onCopy(fixture.tmp, hosted.owner, (client) => confirmOwner(client))).success
    ).toBe(true);
    await syncWithReferee(fixture.tmp, next, hosted.owner, hosted.ownerAccount);
    const former = [input.lostHead.replicaId, recovered.head!.replicaId];
    await onCopy(fixture.tmp, hosted.owner, (client) => {
      const actual = context.mergeContext(client);
      expect(actual.ownReplica).toBe(actual.authority);
      expect(
        actual.terms.find((term) => term.replicaId === input.lostHead.replicaId)
      ).toMatchObject({ ended: 'recovery', cut: plan.result.data!.adoptedPrefix });
      expect(membersOutsideRefereeTerms(client, former)).toEqual([]);
      expect(
        membersOutsideRefereeTerms(client, [recovered.head!.replicaId]).map((member) => member.name)
      ).toEqual(['Erin']);
    });
    const copyFile = path.join(fixture.tmp, 'after-recovery.sqlite');
    await buildFreshCopy(dbOf(hosted.owner.root), copyFile);
    const where = refereeAt(fixture.tmp, 'reshared-after-recovery');
    const members = input.members.map(({ memberId, accountId }) => ({ memberId, accountId }));
    const made = await createReferee(where, {
      copyFile,
      ownerAccountId: hosted.ownerAccount,
      members,
      formerRefereeReplicaIds: former,
    });
    expect(made.result.error).toBeUndefined();
    const shared = new Database(where.storePath, { readonly: true });
    try {
      expect(
        shared
          .prepare(
            'SELECT member_id AS memberId,account_id AS accountId FROM referee_accounts WHERE account_id=?'
          )
          .get('acct-erin')
      ).toEqual(members.find((member) => member.accountId === 'acct-erin'));
    } finally {
      shared.close();
    }
    const ssh = await onCopy(fixture.tmp, hosted.owner, (client) =>
      membership.inviteMember(client, { name: 'SSH newcomer' })
    );
    expect(ssh.success).toBe(true);
    const direct = path.join(fixture.tmp, 'direct-after-recovery.sqlite');
    await buildFreshCopy(dbOf(hosted.owner.root), direct);
    const refused = await createReferee(refereeAt(fixture.tmp, 'direct-after-recovery'), {
      copyFile: direct,
      ownerAccountId: hosted.ownerAccount,
      members: [...members, { memberId: ssh.data!.memberId, accountId: 'acct-ssh' }],
      formerRefereeReplicaIds: former,
    });
    expect(refused.result.success).toBe(false);
    expect(refused.result.error?.message).toContain('SSH newcomer');
  } finally {
    fixture.restore();
  }
});
