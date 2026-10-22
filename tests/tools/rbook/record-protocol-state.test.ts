// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Protocol2 activation belongs to the record's counted authority history, never a global write bump.
// ABOUTME: Real stores keep old active readers safe, follow the counted switch, and pin one transaction across helper calls.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { localCopyReport } from '../../../src/tools/rbook/record-copy-report';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read, sync, type Copy } from '../../helpers/shared-copies';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-state-');
});
afterEach(() => fixture.restore());
const state = () =>
  require('../../../src/tools/rbook/record-protocol-state') as {
    protocolSwitch: (
      client: unknown,
      ctx?: unknown
    ) => { epoch: number; seq: number; replicaId: string; changeId: string } | null;
    currentWriteProtocol: (client: unknown) => number;
    nextWriteProtocol: (client: unknown) => number;
    protocolBlockers: (
      client: unknown
    ) => Array<{ replicaId: string; memberName: string; reads: number | null }>;
  };
const draft = (name: string) => ({
  kind: 'member' as const,
  entity: 'replica',
  entityId: name,
  field: null,
  value: JSON.stringify({ name, role: 'editor' }),
});
async function write(copy: Copy, name: string, options?: { admittingReads?: number | null }) {
  return onCopy(fixture.tmp, copy, (client) =>
    client.writeTransaction(() => {
      (recordOwnChanges as (...args: unknown[]) => void)(client, [draft(name)], options);
    })
  );
}
async function oldPair() {
  const undo = upgradeRecordProtocolForTesting(1);
  try {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joinedCopy(fixture.tmp, owner, 'member', 'Erin');
    await onCopy(fixture.tmp, owner, (client) => {
      (rememberCopyReport as (...args: unknown[]) => void)(
        client,
        member.replicaId,
        { libraryVersion: '4.4.0', reads: 1 },
        { called: true }
      );
    });
    return { owner, member };
  } finally {
    undo();
  }
}
const protocols = (copy: Copy) =>
  read<{ protocol_version: number }>(
    copy,
    'SELECT protocol_version FROM record_changes WHERE replica_id = ? ORDER BY replica_seq',
    [copy.replicaId]
  ).map((row) => row.protocol_version);

it('reports actual read2 but keeps the bootstrap baseline1 before the authority starts2', async () => {
  expect(localCopyReport().reads).toBe(2);
  const owner = await ownerCopy(fixture.tmp);
  expect(protocols(owner)).toEqual([1]);
  expect((await write(owner, 'start')).success).toBe(true);
  expect(protocols(owner)).toEqual([1, 2]);
});

it('an observed active old member blocks until upgraded; counted S then cannot flap on downgrade', async () => {
  const { owner, member } = await oldPair();
  expect((await write(owner, 'blocked')).success).toBe(true);
  expect(protocols(owner).every((version) => version === 1)).toBe(true);
  const before = await onCopy(fixture.tmp, owner, (client) => ({
    switch: state().protocolSwitch(client),
    blockers: state().protocolBlockers(client),
  }));
  expect(before.switch).toBeNull();
  expect(
    await onCopy(fixture.tmp, owner, (client) =>
      JSON.stringify(sharedRecordReview(client)!.protocol)
    )
  ).toMatch(/Erin/);
  expect(before.blockers).toContainEqual(
    expect.objectContaining({ replicaId: member.replicaId, memberName: 'Erin', reads: 1 })
  );
  await onCopy(fixture.tmp, owner, (client) =>
    rememberCopyReport(client, member.replicaId, { libraryVersion: '4.5.0', reads: 2 })
  );
  expect((await write(owner, 'switched')).success).toBe(true);
  const switched = await onCopy(fixture.tmp, owner, (client) => state().protocolSwitch(client));
  expect(switched).toMatchObject({
    epoch: 1,
    replicaId: owner.replicaId,
    seq: protocols(owner).length,
  });
  await onCopy(fixture.tmp, owner, (client) => rememberCopyReport(client, member.replicaId, {}));
  expect((await write(owner, 'still-switched')).success).toBe(true);
  expect(protocols(owner).slice(-1)[0]).toBe(2);
  expect(await onCopy(fixture.tmp, owner, (client) => state().protocolSwitch(client))).toEqual(
    switched
  );
  expect(
    await onCopy(fixture.tmp, owner, (client) =>
      JSON.stringify(sharedRecordReview(client)!.protocol)
    )
  ).toMatch(/downgraded authority.*members' protocol-2/);
});

it('a member follows counted S rather than its own installed reader version', async () => {
  const { owner, member } = await oldPair();
  expect((await write(member, 'member-before')).success).toBe(true);
  expect(protocols(member).slice(-1)[0]).toBe(1);
  await onCopy(fixture.tmp, owner, (client) =>
    rememberCopyReport(client, member.replicaId, { libraryVersion: '4.5.0', reads: 2 })
  );
  expect((await write(owner, 'authority-switch')).success).toBe(true);
  await sync(fixture.tmp, owner, member);
  expect((await write(member, 'member-after')).success).toBe(true);
  expect(protocols(member).slice(-1)[0]).toBe(2);
  expect(await onCopy(fixture.tmp, member, (client) => state().protocolSwitch(client))).toEqual(
    await onCopy(fixture.tmp, owner, (client) => state().protocolSwitch(client))
  );
});

it('an older prospective admission pins every helper write in its transaction to1', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const done = await onCopy(fixture.tmp, owner, (client) =>
    client.writeTransaction(() => {
      (recordOwnChanges as (...args: unknown[]) => void)(client, [draft('admission')], {
        admittingReads: 1,
      });
      recordOwnChanges(client, [draft('later-helper')]);
    })
  );
  expect(done.success).toBe(true);
  expect(protocols(owner)).toEqual([1, 1, 1]);
  expect(await onCopy(fixture.tmp, owner, (client) => state().protocolSwitch(client))).toBeNull();
  expect((await write(owner, 'next-transaction')).success).toBe(true);
  expect(protocols(owner).slice(-1)[0]).toBe(2);
});

it('a rolled-back nested admission leaves no stale in-memory protocol pin', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const done = await onCopy(fixture.tmp, owner, (client) =>
    client.writeTransaction(() => {
      const aborted = client.writeTransaction(() => {
        (recordOwnChanges as (...args: unknown[]) => void)(client, [draft('aborted-admission')], {
          admittingReads: 1,
        });
        throw new Error('rollback admission');
      });
      expect(aborted.success).toBe(false);
      recordOwnChanges(client, [draft('surviving-write')]);
    })
  );
  expect(done.success).toBe(true);
  expect(protocols(owner)).toEqual([1, 2]);
});

it('preserves the explicit future-release seam instead of stamping its writes2', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const undo = upgradeRecordProtocolForTesting(3);
  try {
    expect((await write(owner, 'future-release')).success).toBe(true);
  } finally {
    undo();
  }
  expect(protocols(owner)).toEqual([1, 3]);
});

it('derivation uses a caller-supplied shortened counted reach rather than a stored switched flag', async () => {
  const owner = await ownerCopy(fixture.tmp);
  expect((await write(owner, 'switch')).success).toBe(true);
  await onCopy(fixture.tmp, owner, (client) => {
    const ctx = mergeContext(client);
    expect(state().protocolSwitch(client, ctx)).not.toBeNull();
    const clipped = {
      ...ctx,
      terms: ctx.terms.map((term) => ({ ...term, cut: 1, ended: 'recovery' as const })),
    };
    expect(state().protocolSwitch(client, clipped)).toBeNull();
  });
});

it('an authenticated observed call is distinct from a capability-only report and completed exchange', async () => {
  const { owner, member } = await oldPair();
  const observed = read<{ last_call_at?: string | null; last_ok_at: string | null }>(
    owner,
    'SELECT * FROM record_peers WHERE replica_id = ?',
    [member.replicaId]
  )[0];
  expect(typeof observed.last_call_at).toBe('string');
  expect(observed.last_ok_at).toBeNull();
  await onCopy(fixture.tmp, owner, (client) =>
    rememberCopyReport(client, 'report-only', { reads: 2 })
  );
  const reportOnly = read<{ last_call_at?: string | null; last_ok_at: string | null }>(
    owner,
    'SELECT * FROM record_peers WHERE replica_id = ?',
    ['report-only']
  )[0];
  expect(reportOnly.last_call_at).toBeNull();
  expect(reportOnly.last_ok_at).toBeNull();
});

it('a later baseline-shaped write cannot reset an already counted switch', async () => {
  const owner = await ownerCopy(fixture.tmp);
  expect((await write(owner, 'switch')).success).toBe(true);
  await onCopy(fixture.tmp, owner, (client) =>
    expect(
      client.writeTransaction(() => {
        recordOwnChanges(client, [
          {
            kind: 'baseline',
            entity: 'replica',
            entityId: owner.replicaId,
            field: null,
            value: JSON.stringify({ authority: owner.replicaId, owner: 'Owner' }),
          },
        ]);
      }).success
    ).toBe(true)
  );
  expect(protocols(owner).slice(-1)[0]).toBe(2);
});
