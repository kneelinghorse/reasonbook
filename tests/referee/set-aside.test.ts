// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Only the host administration API may permanently set aside a replica, with recent-call consent.
// ABOUTME: Real referee tables and peer dispatch prove NULL/error behavior and preserve active member access.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import { members, peer, remove, setAside, PEER_METHODS } from '../../src/referee';
import { rememberPeer } from '../../src/tools/rbook/record-peers';
import { setAsideReplica } from '../../src/tools/rbook/record-set-aside';
import { replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import {
  ask,
  hostProject,
  joinThroughReferee,
  syncWithReferee,
  type Referee,
} from '../helpers/referee-fixture';
import { onCopy } from '../helpers/shared-copies';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('referee-set-aside-');
});
afterEach(() => fixture.restore());
function dbStep<T>(referee: Referee, step: (db: Database.Database) => T): T {
  const db = new Database(referee.storePath);
  try {
    return step(db);
  } finally {
    db.close();
  }
}
const changes = (referee: Referee) =>
  dbStep(referee, (db) => db.prepare('SELECT * FROM record_changes ORDER BY rowid').all());

it('recent observed calls need consent, then the member stays active and a repeat holds the cut', async () => {
  const hosted = await hostProject(fixture.tmp);
  const copy = await joinThroughReferee(fixture.tmp, hosted, 'Erin', 'acct-erin');
  await syncWithReferee(fixture.tmp, hosted, copy, 'acct-erin');
  const lastCallAt = dbStep(
    hosted.referee,
    (db) =>
      (
        db
          .prepare('SELECT last_call_at FROM referee_copies WHERE replica_id = ?')
          .get(copy.replicaId) as { last_call_at: string }
      ).last_call_at
  );
  const before = changes(hosted.referee);
  const refused = await ask(hosted.referee, (at) => setAside(at, { replicaId: copy.replicaId }));
  expect(refused.success).toBe(false);
  expect(refused.error?.suggestion).toMatch(/confirmGone|confirm/i);
  expect(refused.error?.message).toContain(lastCallAt);
  expect(changes(hosted.referee)).toEqual(before);
  const applied = await ask(hosted.referee, (at) =>
    setAside(at, { replicaId: copy.replicaId, confirmGone: true })
  );
  expect(applied.success).toBe(true);
  expect(applied.data).toMatchObject({
    replicaId: copy.replicaId,
    memberName: 'Erin',
    dryRun: false,
    lastCallAt: expect.any(String),
  });
  const listed = await ask(hosted.referee, (at) => members(at));
  expect(listed.data?.find((person) => person.name === 'Erin')?.role).toBe('editor');
  const again = await ask(hosted.referee, (at) =>
    setAside(at, { replicaId: copy.replicaId, confirmGone: true })
  );
  expect(again.data).toMatchObject({ alreadySetAside: true, cut: applied.data!.cut });
});

it.each(['old', 'boundary', 'null', 'future', 'invalid', 'missing-table'] as const)(
  '%s observation is handled explicitly',
  async (mode) => {
    const hosted = await hostProject(fixture.tmp);
    const copy = await joinThroughReferee(fixture.tmp, hosted, 'Erin', 'acct-erin');
    const time =
      mode === 'old'
        ? new Date(Date.now() - 8 * 86400000).toISOString()
        : mode === 'boundary'
          ? new Date(Date.now() - 7 * 86400000).toISOString()
          : mode === 'future'
            ? new Date(Date.now() + 86400000).toISOString()
            : mode === 'invalid'
              ? 'not-a-time'
              : null;
    dbStep(hosted.referee, (db) => {
      if (mode === 'missing-table') db.exec('DROP TABLE referee_copies');
      else
        db.prepare(
          'INSERT INTO referee_copies(replica_id,last_call_at) VALUES(?,?) ON CONFLICT(replica_id) DO UPDATE SET last_call_at=excluded.last_call_at'
        ).run(copy.replicaId, time);
    });
    const before = changes(hosted.referee);
    const answer = await ask(hosted.referee, (at) => setAside(at, { replicaId: copy.replicaId }));
    expect(answer.success).toBe(['old', 'boundary', 'null'].includes(mode));
    if (!answer.success) {
      expect(answer.error?.suggestion).toEqual(expect.any(String));
      expect(changes(hosted.referee)).toEqual(before);
    }
  }
);

it.each(['own', 'unknown', 'removed', 'peer', 'local-dashboard-owner'] as const)(
  'refuses %s at the correct boundary',
  async (mode) => {
    const hosted = await hostProject(fixture.tmp);
    const copy = await joinThroughReferee(fixture.tmp, hosted, 'Erin', 'acct-erin');
    if (mode === 'removed')
      expect(
        (await ask(hosted.referee, (at) => remove(at, { accountId: 'acct-erin' }))).success
      ).toBe(true);
    if (mode === 'local-dashboard-owner')
      await onCopy(fixture.tmp, hosted.owner, (client) =>
        rememberPeer(client, hosted.refereeReplica, {
          route: {
            kind: 'dashboard',
            url: 'https://dashboard.example',
            projectId: 'hosted-project',
          },
        })
      );
    const target =
      mode === 'own'
        ? hosted.refereeReplica
        : mode === 'unknown'
          ? 'unknown-replica'
          : copy.replicaId;
    const before = changes(hosted.referee);
    const answer =
      mode === 'peer'
        ? await ask(hosted.referee, (at) =>
            peer(
              at,
              'setAside',
              { replicaId: target, confirmGone: true },
              { replicaId: copy.replicaId, accountId: 'acct-erin' }
            )
          )
        : mode === 'local-dashboard-owner'
          ? await onCopy(fixture.tmp, hosted.owner, (client) =>
              setAsideReplica(client, { replicaId: copy.replicaId, dryRun: false })
            )
          : await ask(hosted.referee, (at) =>
              setAside(at, { replicaId: target, confirmGone: true })
            );
    expect(answer.success).toBe(false);
    expect(answer.error?.suggestion).toEqual(expect.any(String));
    expect(PEER_METHODS).not.toContain('setAside');
    if (mode === 'local-dashboard-owner')
      expect(answer.error?.suggestion).toMatch(/sharing page|dashboard/i);
    expect(changes(hosted.referee)).toEqual(before);
  }
);
