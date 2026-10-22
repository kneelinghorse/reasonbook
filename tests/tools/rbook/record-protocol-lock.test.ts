// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Protocol activation reads capability evidence inside the SQLite write lock, including competing processes.
// ABOUTME: Explicit-path read-only inspection needs no config environment and foreign stores never activate silently.
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import path from 'path';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import {
  currentWriteProtocol,
  nextWriteProtocol,
} from '../../../src/tools/rbook/record-protocol-state';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read } from '../../helpers/shared-copies';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-protocol-lock-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});
const draft = {
  kind: 'member' as const,
  entity: 'member',
  entityId: 'probe',
  field: null,
  value: '{"name":"Probe","role":"editor"}',
};
async function pair() {
  const undo = upgradeRecordProtocolForTesting(1);
  try {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joinedCopy(fixture.tmp, owner, 'member', 'Erin');
    return { owner, member };
  } finally {
    undo();
  }
}
it('rechecks a second process downgrade committed immediately before BEGIN instead of reusing a predicted protocol', async () => {
  const { owner, member } = await pair();
  await onCopy(fixture.tmp, owner, (client) => {
    rememberCopyReport(client, member.replicaId, { reads: 2 }, { called: true });
    expect(nextWriteProtocol(client)).toBe(2);
    const original = client.writeTransaction.bind(client);
    let calls = 0;
    const seam = jest.spyOn(client, 'writeTransaction').mockImplementation((step) => {
      if (!calls++) {
        const child = spawnSync(
          process.execPath,
          [
            '-e',
            `const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const d=new D(process.argv[1]);d.prepare('UPDATE record_peers SET reads=1 WHERE replica_id=?').run(process.argv[2]);d.close();`,
            dbOf(owner.root),
            member.replicaId,
          ],
          { encoding: 'utf8' }
        );
        expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
      }
      return original(step);
    });
    try {
      expect(
        client.writeTransaction(() => {
          recordOwnChanges(client, [draft]);
        }).success
      ).toBe(true);
    } finally {
      seam.mockRestore();
    }
    expect(calls).toBeGreaterThan(0);
  });
  expect(
    read<{ protocol_version: number }>(
      owner,
      'SELECT protocol_version FROM record_changes WHERE replica_id=? ORDER BY replica_seq DESC LIMIT 1',
      [owner.replicaId]
    )[0].protocol_version
  ).toBe(1);
});
it('a second process cannot downgrade the evidence between its locked read and the first protocol2 row', async () => {
  const { owner, member } = await pair();
  await onCopy(fixture.tmp, owner, (client) => {
    rememberCopyReport(client, member.replicaId, { reads: 2 }, { called: true });
    expect(
      client.writeTransaction(() => {
        expect(nextWriteProtocol(client)).toBe(2);
        const child = spawnSync(
          process.execPath,
          [
            '-e',
            `const D=require(${JSON.stringify(require.resolve('better-sqlite3'))});const d=new D(process.argv[1],{timeout:25});try{d.prepare('UPDATE record_peers SET reads=1').run();process.exitCode=2;}catch(e){if(e.code!=='SQLITE_BUSY')throw e;}finally{d.close();}`,
            dbOf(owner.root),
          ],
          { encoding: 'utf8' }
        );
        expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
        recordOwnChanges(client, [draft]);
      }).success
    ).toBe(true);
    expect(currentWriteProtocol(client)).toBe(2);
  });
});
it('explicit read-only paths work with config ENV unset and a foreign store fails loud', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const foreign = path.join(fixture.tmp, 'foreign.sqlite');
  const db = new Database(foreign);
  db.exec('CREATE TABLE unrelated(value TEXT)');
  db.close();
  const saved = process.env.RBOOK_CONFIG_DIR;
  delete process.env.RBOOK_CONFIG_DIR;
  try {
    for (const file of [dbOf(owner.root), foreign]) {
      const opened = await RbookDatabaseClient.create({
        dbPath: file,
        readonly: true,
        replicaCheck: false,
        registerProject: false,
        loadVec: false,
      });
      expect(opened.success).toBe(true);
      const client = opened.data!;
      try {
        if (file === foreign) expect(() => nextWriteProtocol(client)).toThrow();
        else expect(currentWriteProtocol(client)).toBe(1);
      } finally {
        client.close();
      }
    }
  } finally {
    if (saved === undefined) delete process.env.RBOOK_CONFIG_DIR;
    else process.env.RBOOK_CONFIG_DIR = saved;
  }
});
it('MCP recorded writes use the same active reader gate and then publish protocol2', async () => {
  const { owner, member } = await pair();
  await onCopy(fixture.tmp, owner, (client) =>
    rememberCopyReport(client, member.replicaId, { reads: 1 }, { called: true })
  );
  useMachine(fixture.tmp, owner.machine);
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'Before readers upgrade',
        projectRoot: owner.root,
      })
    ).success
  ).toBe(true);
  expect(await onCopy(fixture.tmp, owner, currentWriteProtocol)).toBe(1);
  await onCopy(fixture.tmp, owner, (client) =>
    rememberCopyReport(client, member.replicaId, { reads: 2 })
  );
  useMachine(fixture.tmp, owner.machine);
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'After readers upgrade',
        projectRoot: owner.root,
      })
    ).success
  ).toBe(true);
  expect(await onCopy(fixture.tmp, owner, currentWriteProtocol)).toBe(2);
});
