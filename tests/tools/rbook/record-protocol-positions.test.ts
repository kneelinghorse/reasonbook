// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Protocol S counts only gap-free authority positions, never a promoted member's already judged transaction.
// ABOUTME: Actual handover log entries ground the term boundary while malformed arrival order is injected as stored evidence.
import type { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { handOver } from '../../../src/tools/rbook/record-moves';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { protocolSwitch } from '../../../src/tools/rbook/record-protocol-state';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy } from '../../helpers/shared-copies';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-positions-');
});
afterEach(() => fixture.restore());
function insert(
  client: RbookDatabaseClient,
  id: string,
  seq: number,
  protocol: number,
  txn: string
) {
  expect(
    client.execute(
      `INSERT INTO record_changes(change_id,txn_id,project_id,replica_id,replica_seq,author_name,author_user_id,hlc,protocol_version,kind,entity,entity_id,field,value,base)
 SELECT ?,?,project_id,?,?,NULL,NULL,hlc,?,'member','member','unapplied',NULL,'{}','[]' FROM record_changes WHERE kind='baseline' LIMIT 1`,
      [id + '-' + seq, txn, id, seq, protocol]
    ).success
  ).toBe(true);
}
it.each(['accepted', 'refused', 'unjudged'] as const)(
  'a promoted member2 transaction %s in an earlier term has the specified S eligibility',
  async (verdict) => {
    const undo = upgradeRecordProtocolForTesting(1);
    let owner: Awaited<ReturnType<typeof ownerCopy>>;
    let member: Awaited<ReturnType<typeof joinedCopy>>;
    try {
      owner = await ownerCopy(fixture.tmp);
      member = await joinedCopy(fixture.tmp, owner, 'next-owner', 'Owner');
      await onCopy(fixture.tmp, owner, (client) => {
        insert(client, member.replicaId, 1, 2, 'member-txn');
        if (verdict !== 'unjudged')
          expect(
            client.writeTransaction(() => {
              recordOwnChanges(client, [
                {
                  kind: 'verdict',
                  entity: 'txn',
                  entityId: 'member-txn',
                  field: null,
                  value: JSON.stringify({ verdict, replica: member.replicaId }),
                },
              ]);
            }).success
          ).toBe(true);
        expect(handOver(client, { to: member.replicaId }).success).toBe(true);
      });
    } finally {
      undo();
    }
    await onCopy(
      fixture.tmp,
      owner!,
      (client) => {
        if (verdict === 'unjudged')
          expect(protocolSwitch(client)).toMatchObject({
            epoch: 2,
            seq: 1,
            replicaId: member!.replicaId,
          });
        else expect(protocolSwitch(client)).toBeNull();
      },
      { replicaCheck: false }
    );
  }
);
it('a protocol2 row beyond a gap is not counted until the complete authority prefix arrives', async () => {
  const undo = upgradeRecordProtocolForTesting(1);
  let owner: Awaited<ReturnType<typeof ownerCopy>>;
  let member: Awaited<ReturnType<typeof joinedCopy>>;
  try {
    owner = await ownerCopy(fixture.tmp);
    member = await joinedCopy(fixture.tmp, owner, 'next-owner', 'Owner');
    await onCopy(fixture.tmp, owner, (client) =>
      expect(handOver(client, { to: member.replicaId }).success).toBe(true)
    );
  } finally {
    undo();
  }
  await onCopy(
    fixture.tmp,
    owner!,
    (client) => {
      insert(client, member.replicaId, 3, 2, 'later');
      expect(protocolSwitch(client)).toBeNull();
      insert(client, member.replicaId, 1, 1, 'first');
      insert(client, member.replicaId, 2, 1, 'second');
      expect(protocolSwitch(client)).toMatchObject({
        epoch: 2,
        seq: 3,
        replicaId: member.replicaId,
      });
    },
    { replicaCheck: false }
  );
});
