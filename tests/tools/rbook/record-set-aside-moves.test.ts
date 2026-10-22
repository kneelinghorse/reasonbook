// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Moving authority must not lose permanent cuts to an older or unreported library.
// ABOUTME: Real member changes gate handover; capability downgrades and no-cut controls stay explicit.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { canonicalJson } from '../../../src/tools/rbook/record-capture';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { handOver } from '../../../src/tools/rbook/record-moves';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { currentWriteProtocol } from '../../../src/tools/rbook/record-protocol-state';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-set-aside-moves-');
});
afterEach(() => fixture.restore());

async function setup(cut = true) {
  const owner = await ownerCopy(fixture.tmp);
  const target = await joinedCopy(fixture.tmp, owner, 'target', 'Owner');
  const gone = await joinedCopy(fixture.tmp, owner, 'gone', 'Owner');
  if (cut)
    await onCopy(fixture.tmp, owner, (client) => {
      expect(
        client.writeTransaction(() =>
          recordOwnChanges(client, [
            {
              kind: 'member',
              entity: 'member',
              entityId: 'owner',
              field: null,
              value: canonicalJson({
                name: 'Owner',
                role: 'owner',
                setAsideCuts: { [gone.replicaId]: 0 },
              }),
            },
          ])
        ).success
      ).toBe(true);
    });
  return { owner, target };
}

it.each([undefined, null, '4.4.0', '4.5.0-rc.1', 'unreported'])(
  'refuses a planned move with persistent cuts when the target reports %s, without writing',
  async (version) => {
    const { owner, target } = await setup();
    await onCopy(fixture.tmp, owner, (client) =>
      rememberCopyReport(client, target.replicaId, {
        libraryVersion: version,
        reads: 1,
      })
    );
    const before = read(owner, 'SELECT * FROM record_changes ORDER BY rowid');
    const moved = await onCopy(fixture.tmp, owner, (client) =>
      handOver(client, { to: target.replicaId })
    );
    expect(moved.success).toBe(false);
    expect(moved.error?.message).toContain(target.replicaId);
    expect(moved.error?.message).toMatch(/4\.5\.0/);
    expect(moved.error?.suggestion).toMatch(/upgrade/i);
    expect(read(owner, 'SELECT * FROM record_changes ORDER BY rowid')).toEqual(before);
  }
);

it('permits a 4.5.0 target, but does not keep that permission after an explicit downgrade', async () => {
  const { owner, target } = await setup();
  await onCopy(fixture.tmp, owner, (client) => {
    rememberCopyReport(client, target.replicaId, { libraryVersion: '4.5.0', reads: 2 });
    rememberCopyReport(client, target.replicaId, { libraryVersion: '4.4.0', reads: 1 });
    expect(handOver(client, { to: target.replicaId }).success).toBe(false);
    rememberCopyReport(client, target.replicaId, { libraryVersion: '4.5.0', reads: 2 });
    expect(handOver(client, { to: target.replicaId }).data).toMatchObject({
      epoch: 2,
      to: target.replicaId,
    });
  });
});

it('does not impose the new library floor on records that have no set-aside', async () => {
  // This control predates a protocol switch: an unknown reader is not a library-floor refusal.
  const restore = upgradeRecordProtocolForTesting(1);
  let copies: Awaited<ReturnType<typeof setup>>;
  try {
    copies = await setup(false);
  } finally {
    restore();
  }
  const { owner, target } = copies;
  await onCopy(fixture.tmp, owner, (client) => {
    expect(currentWriteProtocol(client)).toBe(1);
    rememberCopyReport(client, target.replicaId, undefined);
    expect(handOver(client, { to: target.replicaId }).success).toBe(true);
    expect(currentWriteProtocol(client)).toBe(1);
  });
});
