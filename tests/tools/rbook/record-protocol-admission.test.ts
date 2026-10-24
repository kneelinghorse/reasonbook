// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A switched record cannot admit or hand authority to an old or unreported reader.
// ABOUTME: Refusals preserve the log and capability rows, including the first unswitched old join.
import { randomUUID } from 'crypto';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import {
  answerJoin,
  JOIN_REQUEST_FORMAT,
  type JoinRequest,
} from '../../../src/tools/rbook/record-join';
import { admitSuccessor } from '../../../src/tools/rbook/record-admit-successor';
import { handOver } from '../../../src/tools/rbook/record-moves';
import { inviteMember } from '../../../src/tools/rbook/record-membership';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, type Copy } from '../../helpers/shared-copies';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { recordedProjectId } from '../../../src/tools/rbook/replica-identity';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-admission-');
});
afterEach(() => fixture.restore());

function switched(client: RbookDatabaseClient) {
  const undo = upgradeRecordProtocolForTesting(2);
  try {
    expect(
      client.writeTransaction(() =>
        recordOwnChanges(client, [
          {
            kind: 'member',
            entity: '__member__',
            entityId: 'another-person',
            field: null,
            value: JSON.stringify({ name: 'Another', role: 'editor' }),
          },
        ])
      ).success
    ).toBe(true);
  } finally {
    undo();
  }
}
function snapshot(client: RbookDatabaseClient) {
  return {
    changes: client.getMany('SELECT * FROM record_changes ORDER BY change_id').data,
    peers: client.getMany('SELECT * FROM record_peers ORDER BY replica_id').data,
  };
}
const request = (client: RbookDatabaseClient, reads?: number | null): JoinRequest => ({
  format: JOIN_REQUEST_FORMAT,
  protocol: 1,
  projectId: recordedProjectId(client),
  replicaId: randomUUID(),
  nonce: randomUUID(),
  marks: {},
  libraryVersion: '4.2.0',
  reads,
});

it.each([undefined, null, 1])(
  'switched join refuses reads=%s by member name with no log/report mutation',
  async (reads) => {
    const owner = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, owner, (client) => {
      expect(inviteMember(client, { name: 'Pat' }).success).toBe(true);
      switched(client);
      const before = snapshot(client);
      const refused = answerJoin(client, request(client, reads), 'Pat');
      expect(refused.success).toBe(false);
      expect(refused.error?.message).toMatch(/Pat.*(?:reads|read).*2/);
      expect(refused.error?.suggestion).toMatch(/upgrade/i);
      expect(refused.error?.suggestion).toMatch(/fresh.*join --request-out/i);
      expect(snapshot(client)).toEqual(before);
    });
  }
);

it.each(['successor', 'handover'])(
  'switched %s refuses the named copy before mutation',
  async (action) => {
    const owner = await ownerCopy(fixture.tmp);
    const other = await joinedCopy(fixture.tmp, owner, 'studio', 'Owner');
    await onCopy(fixture.tmp, owner, (client) => {
      switched(client);
      rememberCopyReport(client, other.replicaId, { libraryVersion: '4.4.0', reads: 1 });
      const before = snapshot(client);
      const refused =
        action === 'successor'
          ? admitSuccessor(client, { replicaId: other.replicaId })
          : handOver(client, { to: other.replicaId });
      expect(refused.success).toBe(false);
      expect(refused.error?.message).toContain(other.replicaId);
      expect(refused.error?.message).toMatch(/(?:reads|read).*2/);
      expect(snapshot(client)).toEqual(before);
    });
  }
);

it.each([undefined, null, 1, 2.5])(
  'accepted old/unusable reader %s holds the unswitched admission and next write at1',
  async (reads) => {
    const back = upgradeRecordProtocolForTesting(1);
    let owner: Copy;
    try {
      owner = await ownerCopy(fixture.tmp);
      await onCopy(fixture.tmp, owner, (client) =>
        expect(inviteMember(client, { name: 'Pat' }).success).toBe(true)
      );
    } finally {
      back();
    }
    await onCopy(fixture.tmp, owner!, (client) => {
      const asked = request(client, reads);
      const answer = answerJoin(client, asked, 'Pat');
      expect(answer.success).toBe(true);
      expect(answer.data?.bundle.changes.every((row) => row.protocol_version === 1)).toBe(true);
      expect(
        client.getOne<{ last_call_at: string; last_ok_at: null }>(
          'SELECT last_call_at,last_ok_at FROM record_peers WHERE replica_id=?',
          [asked.replicaId]
        ).data
      ).toMatchObject({ last_call_at: expect.any(String), last_ok_at: null });
      expect(inviteMember(client, { name: 'Later' }).success).toBe(true);
      expect(
        client.getOne<{ n: number }>(
          'SELECT count(*) AS n FROM record_changes WHERE protocol_version > 1'
        ).data?.n
      ).toBe(0);
    });
  }
);

it('a switch committed by a second writer immediately before BEGIN is checked by the join', async () => {
  const back = upgradeRecordProtocolForTesting(1);
  let owner: Copy;
  try {
    owner = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, owner, (client) =>
      expect(inviteMember(client, { name: 'Pat' }).success).toBe(true)
    );
  } finally {
    back();
  }
  await onCopy(fixture.tmp, owner!, async (client) => {
    const other = await RbookDatabaseClient.create({ dbPath: client.path, registerProject: false });
    expect(other.success).toBe(true);
    const asked = request(client, 1);
    const original = client.writeTransaction.bind(client);
    let afterExternal: ReturnType<typeof snapshot> | undefined;
    const begin = jest.spyOn(client, 'writeTransaction').mockImplementationOnce((fn) => {
      switched(other.data!);
      afterExternal = snapshot(client);
      return original(fn);
    });
    try {
      const refused = answerJoin(client, asked, 'Pat');
      expect(refused.success).toBe(false);
      expect(refused.error?.message).toContain('Pat');
      expect(snapshot(client)).toEqual(afterExternal);
    } finally {
      begin.mockRestore();
      other.data!.close();
    }
  });
});
