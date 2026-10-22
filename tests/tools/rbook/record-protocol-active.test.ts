// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The switch counts actual use by every member, with explicit exclusions for cuts and successors.
// ABOUTME: Real SQLite metadata proves old schemas, lazy observation, report precedence and query failures.
import Database from 'better-sqlite3';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import {
  protocolBlockers,
  nextWriteProtocol,
} from '../../../src/tools/rbook/record-protocol-state';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { rememberPeer } from '../../../src/tools/rbook/record-peers';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { dbOf, replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, sync, type Copy } from '../../helpers/shared-copies';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-active-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});
async function seeded(previous = false) {
  const undo = upgradeRecordProtocolForTesting(1);
  try {
    const owner = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, owner, (client) =>
      expect(
        client.writeTransaction(() => {
          recordOwnChanges(client, [
            {
              kind: 'member',
              entity: 'member',
              entityId: 'erin',
              field: null,
              value: JSON.stringify({ name: 'Erin', role: 'editor' }),
            },
            ...['old', 'new'].map((id, index) => ({
              kind: 'replica_joined' as const,
              entity: 'replica',
              entityId: id,
              field: null,
              value: JSON.stringify({
                block: index + 1,
                role: 'editor',
                member: 'erin',
                ...(previous && id === 'new' ? { previous: 'old' } : {}),
              }),
            })),
          ]);
        }).success
      ).toBe(true)
    );
    return owner;
  } finally {
    undo();
  }
}
/** A complete received one-row member stream; authority membership comes only from seeded log rows. */
async function wrote(owner: Copy, id: string) {
  await onCopy(fixture.tmp, owner, (client) => {
    expect(
      client.execute(
        `INSERT INTO record_changes(change_id,txn_id,project_id,replica_id,replica_seq,author_name,author_user_id,hlc,protocol_version,kind,entity,entity_id,field,value,base)
      SELECT ?,?,project_id,?,1,NULL,NULL,hlc,1,'member','member','ignored',NULL,'{}','[]' FROM record_changes WHERE kind='baseline' LIMIT 1`,
        ['change-' + id, 'txn-' + id, id]
      ).success
    ).toBe(true);
  });
}
const blockers = (owner: Copy) =>
  onCopy(fixture.tmp, owner, (client) => protocolBlockers(client).map((copy) => copy.replicaId));

it('route-only and imported capability-only metadata do not make an unused admission active; a call does', async () => {
  const owner = await seeded();
  await onCopy(fixture.tmp, owner, (client) => {
    rememberPeer(client, 'old', { route: { host: 'unused', root: '/unused' } });
    rememberCopyReport(client, 'old', { reads: 1 });
    rememberCopyReport(client, 'foreign', { reads: 1 }, { called: true });
  });
  expect(await blockers(owner)).toEqual([]);
  await onCopy(fixture.tmp, owner, (client) =>
    rememberCopyReport(client, 'old', { reads: 1 }, { called: true })
  );
  expect(await blockers(owner)).toEqual(['old']);
});

it('an actual member write activates an unreported copy and a report2 releases it', async () => {
  const owner = await seeded();
  await wrote(owner, 'old');
  expect(await blockers(owner)).toEqual(['old']);
  await onCopy(fixture.tmp, owner, (client) => rememberCopyReport(client, 'old', { reads: 2 }));
  expect(await blockers(owner)).toEqual([]);
});

it.each(['removed', 'set-aside', 'dropped', 'unseen'] as const)(
  'a %s copy is excluded despite old called evidence',
  async (mode) => {
    const owner = await seeded();
    await onCopy(fixture.tmp, owner, (client) => {
      rememberCopyReport(client, 'old', { reads: 1 }, { called: true });
      const ctx = mergeContext(client);
      const member = ctx.members.get('old')!;
      const members = new Map(ctx.members);
      const unseen = new Map(ctx.unseen);
      if (mode === 'unseen') unseen.set('old', member);
      else
        members.set('old', {
          ...member,
          ...(mode === 'removed' ? { role: 'removed' } : { cut: 0, cutReason: mode }),
        });
      expect(protocolBlockers(client, { ...ctx, members, unseen })).toEqual([]);
    });
  }
);

it('a predecessor stays active until its successor actually writes or calls, not merely reports', async () => {
  const owner = await seeded(true);
  await onCopy(fixture.tmp, owner, (client) => {
    rememberCopyReport(client, 'old', { reads: 1 }, { called: true });
    rememberCopyReport(client, 'new', { reads: 2 });
  });
  expect(await blockers(owner)).toEqual(['old']);
  await onCopy(fixture.tmp, owner, (client) =>
    rememberCopyReport(client, 'new', { reads: 2 }, { called: true })
  );
  expect(await blockers(owner)).toEqual([]);
});

it.each([false, true])(
  'a hosted per-call report takes precedence over stale peer metadata, downgrade=%s',
  async (downgrade) => {
    const owner = await seeded();
    await onCopy(fixture.tmp, owner, (client) => {
      rememberCopyReport(client, 'old', { reads: downgrade ? 2 : null });
      expect(
        client.execute('CREATE TABLE referee_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
          .success
      ).toBe(true);
      expect(
        client.execute(
          'CREATE TABLE referee_copies (replica_id TEXT PRIMARY KEY,last_call_at TEXT,library_version TEXT,reads INTEGER)'
        ).success
      ).toBe(true);
      expect(
        client.execute('INSERT INTO referee_copies VALUES (?,?,?,?)', [
          'old',
          new Date().toISOString(),
          '4.5.0',
          downgrade ? null : 2,
        ]).success
      ).toBe(true);
    });
    expect(await blockers(owner)).toEqual(downgrade ? ['old'] : []);
  }
);

it.each(['absent', 'old', 'null'] as const)(
  'reads %s metadata without migration, then observes lazy call persistence',
  async (schema) => {
    const owner = await seeded();
    await wrote(owner, 'old');
    const db = new Database(dbOf(owner.root));
    try {
      if (schema !== 'absent') {
        db.exec(
          `CREATE TABLE record_peers (replica_id TEXT PRIMARY KEY,name TEXT,route TEXT,marks TEXT,digest TEXT,last_ok_at TEXT,last_error TEXT,last_error_at TEXT${schema === 'null' ? ', library_version TEXT, reads INTEGER, last_call_at TEXT' : ''})`
        );
        db.prepare('INSERT INTO record_peers(replica_id) VALUES(?)').run('old');
      }
    } finally {
      db.close();
    }
    await onCopy(fixture.tmp, owner, (client) => {
      const before = client.getMany('PRAGMA table_info(record_peers)');
      expect(protocolBlockers(client).map((copy) => copy.replicaId)).toEqual(['old']);
      expect(client.getMany('PRAGMA table_info(record_peers)')).toEqual(before);
      rememberCopyReport(client, 'old', { reads: 2 }, { called: true });
      expect(nextWriteProtocol(client)).toBe(2);
      expect(
        client.getOne<{ last_call_at: string }>(
          'SELECT last_call_at FROM record_peers WHERE replica_id=?',
          ['old']
        ).data?.last_call_at
      ).toEqual(expect.any(String));
    });
  }
);

it('an activation query failure cannot silently permit protocol2', async () => {
  const owner = await seeded();
  await onCopy(fixture.tmp, owner, (client) => {
    const original = client.getMany.bind(client);
    jest
      .spyOn(client, 'getMany')
      .mockImplementation((sql, params) =>
        sql.includes('sqlite_master')
          ? { success: false, error: { code: 'INJECTED', message: 'activation query failed' } }
          : original(sql, params)
      );
    expect(() => nextWriteProtocol(client)).toThrow('activation query failed');
  });
});

it.each(['row', 'table'] as const)(
  'a hosted missing %s never inherits a stale direct peer2 report',
  async (missing) => {
    const owner = await seeded();
    await wrote(owner, 'old');
    await onCopy(fixture.tmp, owner, (client) => {
      rememberCopyReport(client, 'old', { reads: 2 }, { called: true });
      expect(
        client.execute('CREATE TABLE referee_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
          .success
      ).toBe(true);
      if (missing === 'row')
        expect(
          client.execute(
            'CREATE TABLE referee_copies (replica_id TEXT PRIMARY KEY,last_call_at TEXT,library_version TEXT,reads INTEGER)'
          ).success
        ).toBe(true);
      expect(protocolBlockers(client).map((copy) => copy.replicaId)).toEqual(['old']);
    });
  }
);

it('a former term holder is inactive despite a route/call until it writes past its handover cut', async () => {
  const undo = upgradeRecordProtocolForTesting(1);
  let owner: Copy;
  let next: Copy;
  try {
    owner = await ownerCopy(fixture.tmp);
    next = await joinedCopy(fixture.tmp, owner, 'next-owner', 'Owner');
    await onCopy(fixture.tmp, owner, (client) =>
      expect(handOver(client, { to: next.replicaId }).success).toBe(true)
    );
    await sync(fixture.tmp, owner, next);
    await onCopy(fixture.tmp, next, (client) => expect(confirmOwner(client).success).toBe(true));
  } finally {
    undo();
  }
  await onCopy(fixture.tmp, next!, (client) =>
    rememberCopyReport(client, owner.replicaId, { reads: 1 }, { called: true })
  );
  expect(await blockers(next!)).toEqual([]);
  await onCopy(fixture.tmp, owner!, (client) =>
    expect(
      client.writeTransaction(() => {
        recordOwnChanges(client, [
          {
            kind: 'member',
            entity: 'member',
            entityId: 'after-cut',
            field: null,
            value: '{"name":"After","role":"editor"}',
          },
        ]);
      }).success
    ).toBe(true)
  );
  await sync(fixture.tmp, owner!, next!);
  expect(await blockers(next!)).toEqual([owner!.replicaId]);
});
