// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Recovery can preserve only the switch in its adopted authority prefix, never a held tail.
// ABOUTME: Real recovery writes and review agree, including all judges in the publication transaction.
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { recoverAuthorityCore } from '../../../src/tools/rbook/record-recovery-core';
import {
  currentWriteProtocol,
  protocolSwitch,
} from '../../../src/tools/rbook/record-protocol-state';
import { sharedRecordReview } from '../../../src/tools/rbook/record-review';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { onCopy, ownerCopy, read } from '../../helpers/shared-copies';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-recovery-');
});
afterEach(() => fixture.restore());
it.each([1, 2])(
  'the adopted prefix %i determines recovery protocol despite a read2 installation',
  async (cut) => {
    const owner = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, owner, (client) => {
      expect(
        client.writeTransaction(() => {
          recordOwnChanges(client, [
            {
              kind: 'member',
              entity: 'member',
              entityId: 'tail',
              field: null,
              value: JSON.stringify({ name: 'Tail', role: 'editor' }),
            },
          ]);
        }).success
      ).toBe(true);
      expect(protocolSwitch(client)).toMatchObject({ replicaId: owner.replicaId, seq: 2 });
    });
    const before = read(
      owner,
      'SELECT change_id, protocol_version FROM record_changes ORDER BY rowid'
    );
    const recovered = await recoverAuthorityCore(
      (step) => onCopy(fixture.tmp, owner, step, { replicaCheck: false }),
      [],
      {
        previous: owner.replicaId,
        block: 1,
        ownerName: 'Owner',
        members: [],
        cuts: () => ({}),
        cut,
      },
      ProjectGraphRegistry.getInstance()
    );
    expect(recovered.success).toBe(true);
    await onCopy(
      fixture.tmp,
      owner,
      (client) => {
        const ctx = mergeContext(client);
        const rows = client.getMany<{ protocol_version: number }>(
          'SELECT protocol_version FROM record_changes WHERE replica_id = ?',
          [ctx.ownReplica]
        ).data!;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.protocol_version === cut)).toBe(true);
        expect(currentWriteProtocol(client)).toBe(cut);
        const protocol = sharedRecordReview(client)!.protocol!;
        const states = protocol.summary + ' ' + protocol.detail;
        expect(states).toMatch(cut === 1 ? /not switched.*adopted prefix/i : /record protocol 2/i);
        if (cut === 1) expect(protocolSwitch(client)).toBeNull();
        else expect(protocolSwitch(client)).toMatchObject({ replicaId: owner.replicaId, seq: 2 });
      },
      { replicaCheck: false }
    );
    expect(
      read(
        owner,
        'SELECT change_id, protocol_version FROM record_changes WHERE replica_id = ? ORDER BY rowid',
        [owner.replicaId]
      )
    ).toEqual(before);
  }
);
