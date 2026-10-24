// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Re-admission preserves old readers before switching and names a usable recovery after switching.
// ABOUTME: Real copies, per-call observations and a competing writer prove the gate holds under the write lock.
import { spawnSync } from 'child_process';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { recoverAuthorityCore } from '../../../src/tools/rbook/record-recovery-core';
import { admitSuccessor } from '../../../src/tools/rbook/record-admit-successor';
import { mergeContext } from '../../../src/tools/rbook/record-context';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { inviteMember, removeMember } from '../../../src/tools/rbook/record-membership';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { rememberPeer, routeTo } from '../../../src/tools/rbook/record-peers';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import {
  currentWriteProtocol,
  protocolBlockers,
} from '../../../src/tools/rbook/record-protocol-state';
import { setAsideReplica } from '../../../src/tools/rbook/record-set-aside';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  joinedCopy,
  onCopy,
  ownerCopy,
  read,
  syncCopies,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-readmit-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});
async function removedPair() {
  const undo = upgradeRecordProtocolForTesting(1);
  try {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joinedCopy(fixture.tmp, owner, 'member', 'Pat');
    await onCopy(fixture.tmp, owner, (client) => {
      rememberPeer(client, member.replicaId, { route: { host: 'test-member', root: '/scratch' } });
      expect(removeMember(client, 'Pat').success).toBe(true);
      expect(routeTo(client, member.replicaId)).toBeNull();
    });
    return { owner, member };
  } finally {
    undo();
  }
}
function switchNow(owner: Copy) {
  return onCopy(fixture.tmp, owner, (client) => {
    expect(inviteMember(client, { name: 'Switch witness' }).success).toBe(true);
    expect(currentWriteProtocol(client)).toBe(2);
  });
}
function log(owner: Copy) {
  return read(owner, 'SELECT * FROM record_changes ORDER BY change_id');
}

it.each([1, null])(
  're-add of reads=%s stays at1 and makes its old copy a blocker',
  async (reads) => {
    const { owner, member } = await removedPair();
    await onCopy(fixture.tmp, owner, (client) => {
      rememberCopyReport(client, member.replicaId, { reads }, { called: true });
      expect(inviteMember(client, { name: 'Pat' }).success).toBe(true);
      expect(currentWriteProtocol(client)).toBe(1);
      expect(protocolBlockers(client).map((copy) => copy.replicaId)).toEqual([member.replicaId]);
    });
  }
);

it('after switching, every old copy is named and no membership or report changes; upgraded removed sync makes retry succeed', async () => {
  const { owner, member } = await removedPair();
  await switchNow(owner);
  const before = log(owner);
  useMachine(fixture.tmp, owner.machine);
  const refused = await call('rbook_project', {
    action: 'invite',
    name: 'Pat',
    projectRoot: owner.root,
  });
  expect(refused.error?.code).toBe('RECORD_COPY_TOO_OLD');
  expect(refused.error?.message).toContain(member.replicaId);
  expect(refused.error?.suggestion).toMatch(
    /upgrade.*sync once while still removed.*invite again/i
  );
  expect(log(owner)).toEqual(before);
  const result = await syncCopies(fixture.tmp, member, owner);
  expect(result).toBeDefined();
  await onCopy(fixture.tmp, owner, (client) => {
    expect(inviteMember(client, { name: 'Pat' }).success).toBe(true);
    expect(currentWriteProtocol(client)).toBe(2);
  });
});

it('takes the minimum across used copies and ignores a permanent set-aside', async () => {
  const undo = upgradeRecordProtocolForTesting(1);
  let owner: Copy;
  let old: Copy;
  let fresh: Copy;
  try {
    owner = await ownerCopy(fixture.tmp);
    old = await joinedCopy(fixture.tmp, owner, 'old', 'Pat');
    fresh = await joinedCopy(fixture.tmp, owner, 'fresh', 'Pat');
    await onCopy(fixture.tmp, owner, (client) => {
      expect(setAsideReplica(client, { replicaId: old.replicaId, dryRun: false }).success).toBe(
        true
      );
      expect(removeMember(client, 'Pat').success).toBe(true);
    });
  } finally {
    undo();
  }
  await switchNow(owner!);
  await onCopy(fixture.tmp, owner!, (client) => {
    rememberCopyReport(client, old.replicaId, { reads: 1 }, { called: true });
    rememberCopyReport(client, fresh.replicaId, { reads: 2 }, { called: true });
    expect(inviteMember(client, { name: 'Pat' }).success).toBe(true);
  });
});

it('rechecks a protocol2 switch committed by another process immediately before BEGIN', async () => {
  const { owner, member } = await removedPair();
  await onCopy(fixture.tmp, owner, (client) => {
    rememberCopyReport(client, member.replicaId, { reads: 1 }, { called: true });
    const original = client.writeTransaction.bind(client);
    let afterExternal: unknown;
    jest.spyOn(client, 'writeTransaction').mockImplementationOnce((fn) => {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          `
        const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});
        const d=new D(process.argv[1]);
        d.prepare("UPDATE record_changes SET protocol_version=2 WHERE change_id=(SELECT change_id FROM record_changes WHERE kind='member' ORDER BY replica_seq DESC LIMIT 1)").run();
        d.close();`,
          dbOf(owner.root),
        ],
        { encoding: 'utf8' }
      );
      expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
      afterExternal = log(owner);
      return original(fn);
    });
    expect(inviteMember(client, { name: 'Pat' }).error?.code).toBe('RECORD_COPY_TOO_OLD');
    expect(log(owner)).toEqual(afterExternal);
  });
});

it('uses referee per-call reports instead of a stale direct report on hosted re-add', async () => {
  const { owner, member } = await removedPair();
  await switchNow(owner);
  await onCopy(fixture.tmp, owner, (client) => {
    rememberCopyReport(client, member.replicaId, { reads: 2 }, { called: true });
    expect(
      client.raw(
        'CREATE TABLE referee_state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE referee_copies(replica_id TEXT PRIMARY KEY,last_call_at TEXT,reads INTEGER,library_version TEXT)'
      ).success
    ).toBe(true);
    expect(
      client.execute('INSERT INTO referee_copies VALUES(?,?,?,?)', [
        member.replicaId,
        new Date().toISOString(),
        1,
        null,
      ]).success
    ).toBe(true);
    expect(inviteMember(client, { name: 'Pat' }).error?.code).toBe('RECORD_COPY_TOO_OLD');
  });
});

it('a recovery-dropped copy stays cut when its removed person is invited again', async () => {
  const { owner, member } = await removedPair();
  const recovered = await recoverAuthorityCore(
    (step) => onCopy(fixture.tmp, owner, step, { replicaCheck: false }),
    [],
    {
      previous: owner.replicaId,
      block: 2,
      ownerName: 'Owner',
      members: [],
      cuts: () => ({ [member.replicaId]: 0 }),
    },
    ProjectGraphRegistry.getInstance()
  );
  expect(recovered.success).toBe(true);
  await switchNow(owner);
  await onCopy(fixture.tmp, owner, (client) => {
    rememberCopyReport(client, member.replicaId, { reads: 1 }, { called: true });
    expect(inviteMember(client, { name: 'Pat' }).success).toBe(true);
    expect(mergeContext(client).members.get(member.replicaId)?.cut).toBe(0);
  });
});

it('an actually-used successor releases its unreported predecessor at re-add', async () => {
  const undo = upgradeRecordProtocolForTesting(1);
  let owner: Copy;
  let member: Copy;
  let successor: string;
  try {
    owner = await ownerCopy(fixture.tmp);
    member = await joinedCopy(fixture.tmp, owner, 'pat', 'Pat');
    successor = await onCopy(fixture.tmp, owner, (client) => {
      const admitted = admitSuccessor(client, { replicaId: member.replicaId });
      expect(admitted.success).toBe(true);
      expect(removeMember(client, 'Pat').success).toBe(true);
      return admitted.data!.replicaId;
    });
  } finally {
    undo();
  }
  await switchNow(owner!);
  await onCopy(fixture.tmp, owner!, (client) => {
    rememberCopyReport(client, successor, { reads: 2 }, { called: true });
    expect(inviteMember(client, { name: 'Pat' }).success).toBe(true);
  });
});

it('a removed and re-added copy with no authored rows keeps subsequent authority writes readable', async () => {
  const { owner, member } = await removedPair();
  await onCopy(fixture.tmp, owner, (client) => {
    expect(inviteMember(client, { name: 'Pat' }).success).toBe(true);
    expect(inviteMember(client, { name: 'After re-add' }).success).toBe(true);
    expect(currentWriteProtocol(client)).toBe(1);
    expect(protocolBlockers(client).map((copy) => copy.replicaId)).toContain(member.replicaId);
  });
});

it.each([false, true])(
  'historical removal with missing cuts=%s still blocks after re-add, while later unused admissions do not',
  async (missingCuts) => {
    const { owner, member } = await removedPair();
    await onCopy(fixture.tmp, owner, (client) => {
      expect(
        client.execute('DELETE FROM record_peers WHERE replica_id=?', [member.replicaId]).success
      ).toBe(true);
      if (missingCuts)
        expect(
          client.execute(
            "UPDATE record_changes SET value=json_remove(value,'$.cuts') WHERE kind='member' AND json_extract(value,'$.role')='removed'"
          ).success
        ).toBe(true);
      expect(inviteMember(client, { name: 'Pat' }).success).toBe(true);
      expect(inviteMember(client, { name: 'After historical re-add' }).success).toBe(true);
      expect(currentWriteProtocol(client)).toBe(1);
      expect(protocolBlockers(client).map((copy) => copy.replicaId)).toEqual([member.replicaId]);
      const person = mergeContext(client).members.get(member.replicaId)!.member;
      expect(
        client.writeTransaction(() =>
          recordOwnChanges(client, [
            {
              kind: 'replica_joined',
              entity: 'replica',
              entityId: 'later-unused',
              field: null,
              value: JSON.stringify({ block: 5, role: 'editor', member: person }),
            },
          ])
        ).success
      ).toBe(true);
      rememberCopyReport(client, member.replicaId, { reads: 2 }, { called: true });
      expect(protocolBlockers(client)).toEqual([]);
      expect(inviteMember(client, { name: 'Can finally switch' }).success).toBe(true);
      expect(currentWriteProtocol(client)).toBe(2);
    });
  }
);
