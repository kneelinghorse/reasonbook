// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Only proven retired referees leave the active census after a term ends.
// ABOUTME: Former human owners, malformed evidence and post-cut writes keep protocol2 from hiding a live copy.
import { rememberPeer } from '../../../src/tools/rbook/record-peers';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { mergeContext } from '../../../src/tools/rbook/record-context';
import { protocolBlockers } from '../../../src/tools/rbook/record-protocol-state';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { handOver, confirmOwner } from '../../../src/tools/rbook/record-moves';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, sync } from '../../helpers/shared-copies';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-retired-referee-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});
async function handed() {
  const undo = upgradeRecordProtocolForTesting(1);
  try {
    const owner = await ownerCopy(fixture.tmp);
    const next = await joinedCopy(fixture.tmp, owner, 'next', 'Owner');
    await onCopy(fixture.tmp, owner, (client) =>
      expect(handOver(client, { to: next.replicaId }).success).toBe(true)
    );
    await sync(fixture.tmp, owner, next);
    await onCopy(fixture.tmp, next, (client) => expect(confirmOwner(client).success).toBe(true));
    return { owner, next };
  } finally {
    undo();
  }
}
it.each([false, true])('client exempts only an ended dashboard route, ended=%s', async (ended) => {
  const { owner, next } = await handed();
  await onCopy(fixture.tmp, next, (client) => {
    rememberCopyReport(client, owner.replicaId, { reads: 1 }, { called: true });
    rememberPeer(client, owner.replicaId, {
      route: {
        kind: 'dashboard',
        url: 'https://reasonbook.ai',
        projectId: 'test',
        ...(ended ? { ended: true } : {}),
      },
    });
    expect(protocolBlockers(client).map((copy) => copy.replicaId)).toEqual(
      ended ? [] : [owner.replicaId]
    );
  });
});
it.each(['absent-table', 'absent-row', 'called-owner', 'known-former', 'null-owner'] as const)(
  'hosted former term uses persisted evidence: %s',
  async (mode) => {
    const { owner, next } = await handed();
    await onCopy(fixture.tmp, next, (client) => {
      expect(
        client.execute('CREATE TABLE referee_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
          .success
      ).toBe(true);
      if (mode !== 'absent-table')
        expect(
          client.execute(
            'CREATE TABLE referee_copies(replica_id TEXT PRIMARY KEY,last_call_at TEXT,reads INTEGER,library_version TEXT)'
          ).success
        ).toBe(true);
      if (['called-owner', 'known-former', 'null-owner'].includes(mode))
        expect(
          client.execute('INSERT INTO referee_copies VALUES(?,?,?,?)', [
            owner.replicaId,
            mode === 'null-owner' ? null : new Date().toISOString(),
            null,
            null,
          ]).success
        ).toBe(true);
      if (mode === 'known-former')
        expect(
          client.execute('INSERT INTO referee_state VALUES(?,?)', [
            'creation_members',
            JSON.stringify({ formerRefereeReplicaIds: [owner.replicaId] }),
          ]).success
        ).toBe(true);
      expect(protocolBlockers(client).map((copy) => copy.replicaId)).toEqual(
        ['called-owner', 'null-owner'].includes(mode) ? [owner.replicaId] : []
      );
    });
  }
);
it('even a known hosted former referee counts when its stream continues past the retired cut', async () => {
  const { owner, next } = await handed();
  await onCopy(fixture.tmp, next, (client) => {
    expect(
      client.raw(
        'CREATE TABLE referee_state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE referee_copies(replica_id TEXT PRIMARY KEY,last_call_at TEXT)'
      ).success
    ).toBe(true);
    expect(
      client.execute('INSERT INTO referee_state VALUES(?,?)', [
        'creation_members',
        JSON.stringify({ formerRefereeReplicaIds: [owner.replicaId] }),
      ]).success
    ).toBe(true);
    const ctx = mergeContext(client);
    const terms = ctx.terms.map((term) =>
      term.replicaId === owner.replicaId ? { ...term, cut: term.cut - 1 } : term
    );
    expect(protocolBlockers(client, { ...ctx, terms }).map((copy) => copy.replicaId)).toEqual([
      owner.replicaId,
    ]);
  });
});
it('invalid creation history and a failed history query never silently exempt a former owner', async () => {
  const { next } = await handed();
  await onCopy(fixture.tmp, next, (client) => {
    expect(
      client.execute('CREATE TABLE referee_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)').success
    ).toBe(true);
    expect(
      client.execute('INSERT INTO referee_state VALUES(?,?)', [
        'creation_members',
        '{"formerRefereeReplicaIds":"bad"}',
      ]).success
    ).toBe(true);
    expect(() => protocolBlockers(client)).toThrow(/list/);
    const original = client.getMany.bind(client);
    jest
      .spyOn(client, 'getMany')
      .mockImplementation((sql, params) =>
        sql.includes("key = 'creation_members'")
          ? { success: false, error: { code: 'INJECTED', message: 'creation history unavailable' } }
          : original(sql, params)
      );
    expect(() => protocolBlockers(client)).toThrow('creation history unavailable');
  });
});
