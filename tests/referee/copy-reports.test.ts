// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Retain only authenticated copies' capability reports in referee-local state.
// ABOUTME: Keep old schemas and omitted reports conservative without confusing a join with a completed exchange.
import Database from 'better-sqlite3';
import path from 'path';
import { getServerVersion } from '../../src/server-version';
import { createReferee, peer, peers } from '../../src/referee';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { dbOf, replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import {
  ask,
  callerOf,
  hostProject,
  joinThroughReferee,
  refereeAt,
} from '../helpers/referee-fixture';
import { ownerCopy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-referee-copy-report-');
});
afterEach(() => fixture.restore());
const report = { libraryVersion: '4.3.0', reads: 1 };
function rows(store: string, table: string) {
  const db = new Database(store, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

it('an authenticated hello lazily upgrades both local tables and exposes the report', async () => {
  const hosted = await hostProject(fixture.tmp);
  const legacy = new Database(hosted.referee.storePath);
  for (const column of ['library_version', 'reads']) {
    if (
      (legacy.pragma('table_info(referee_copies)') as { name: string }[]).some(
        (row) => row.name === column
      )
    )
      legacy.exec(`ALTER TABLE referee_copies DROP COLUMN ${column}`);
  }
  legacy.close();
  const caller = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
  const hello = await ask(hosted.referee, (at) =>
    peer(at, 'hello', { recordProtocol: 1, ...report }, caller)
  );
  expect(hello.success).toBe(true);
  expect(hello.data).toMatchObject({
    libraryVersion: getServerVersion(),
    reads: 2,
    recordProtocol: 2,
  });
  expect(
    rows(hosted.referee.storePath, 'referee_copies').find((r) => r.replica_id === caller.replicaId)
  ).toMatchObject({ library_version: report.libraryVersion, reads: 1 });
  expect(
    rows(hosted.referee.storePath, 'record_peers').find((r) => r.replica_id === caller.replicaId)
  ).toMatchObject({ library_version: report.libraryVersion, reads: 1 });
  const copies = await ask(hosted.referee, peers);
  expect(copies.data?.find((copy) => copy.replicaId === caller.replicaId)).toMatchObject(report);
});

it('a missing old hello report clears previous knowledge and an unrelated call retains it', async () => {
  const hosted = await hostProject(fixture.tmp);
  const caller = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
  await ask(hosted.referee, (at) => peer(at, 'hello', { recordProtocol: 1, ...report }, caller));
  await ask(hosted.referee, (at) => peer(at, 'chains', {}, caller));
  expect(
    rows(hosted.referee.storePath, 'referee_copies').find((r) => r.replica_id === caller.replicaId)
  ).toMatchObject({ library_version: report.libraryVersion, reads: 1 });
  await ask(hosted.referee, (at) => peer(at, 'hello', { recordProtocol: 1 }, caller));
  expect(
    rows(hosted.referee.storePath, 'referee_copies').find((r) => r.replica_id === caller.replicaId)
  ).toMatchObject({ library_version: null, reads: null });
});

it('forged identity cannot overwrite another admitted copy capability report', async () => {
  const hosted = await hostProject(fixture.tmp);
  const caller = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
  await ask(hosted.referee, (at) => peer(at, 'hello', { recordProtocol: 1, ...report }, caller));
  const before = rows(hosted.referee.storePath, 'referee_copies');
  const refused = await ask(hosted.referee, (at) =>
    peer(
      at,
      'hello',
      { libraryVersion: '4.5.0', reads: 2 },
      { ...caller, accountId: 'other-account' }
    )
  );
  expect(refused.success).toBe(false);
  expect(rows(hosted.referee.storePath, 'referee_copies')).toEqual(before);
  expect(before.find((r) => r.replica_id === caller.replicaId)).toMatchObject({
    library_version: report.libraryVersion,
    reads: 1,
  });
});

it('an accepted join records capabilities but no completed exchange timestamp', async () => {
  const hosted = await hostProject(fixture.tmp);
  const member = await joinThroughReferee(fixture.tmp, hosted, 'Member', 'member-account');
  const row = rows(hosted.referee.storePath, 'record_peers').find(
    (r) => r.replica_id === member.replicaId
  );
  expect(row).toMatchObject({ library_version: getServerVersion(), reads: 2, last_ok_at: null });
  expect(
    rows(hosted.referee.storePath, 'referee_copies').find((r) => r.replica_id === member.replicaId)
  ).toMatchObject({ library_version: getServerVersion(), reads: 2 });
});

it('a retried unfinished referee join request reports the currently installed engine', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const location = refereeAt(fixture.tmp);
  const copyFile = path.join(fixture.tmp, 'upload.sqlite');
  await buildFreshCopy(dbOf(owner.root), copyFile);
  const first = await createReferee(location, { copyFile, ownerAccountId: 'owner-account' });
  expect(first.result.success).toBe(true);
  const retried = await createReferee(location, { copyFile, ownerAccountId: 'owner-account' });
  expect(retried.result.success).toBe(true);
  expect(retried.result.data?.joinRequest).toMatchObject({
    libraryVersion: getServerVersion(),
    reads: 2,
  });
  expect(retried.result.data?.joinRequest.replicaId).toBe(first.result.data?.joinRequest.replicaId);
});

it('a failed mirrored report write rolls back both capability tables', async () => {
  const hosted = await hostProject(fixture.tmp);
  const caller = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
  await ask(hosted.referee, (at) => peer(at, 'hello', report, caller));
  const before = rows(hosted.referee.storePath, 'referee_copies');
  const { withReferee } = await import('../../src/referee/open');
  const { noteCall } = await import('../../src/referee/accounts');
  const { createSuccess } = await import('../../src/tools/rbook/errors');
  const failed = await ask(hosted.referee, (at) =>
    withReferee(at, ({ client }) => {
      const original = client.execute.bind(client);
      const execute = jest
        .spyOn(client, 'execute')
        .mockImplementation((sql, values) =>
          /UPDATE record_peers SET library_version/.test(sql)
            ? { success: false, error: { code: 'INJECTED', message: 'mirror write failed' } }
            : original(sql, values)
        );
      try {
        noteCall(client, caller.replicaId, { report: { libraryVersion: '4.5.0', reads: 2 } });
      } finally {
        execute.mockRestore();
      }
      return createSuccess(null);
    })
  );
  expect(failed.success).toBe(false);
  expect(failed.error?.message).toContain('mirror write failed');
  expect(rows(hosted.referee.storePath, 'referee_copies')).toEqual(before);
  expect(
    rows(hosted.referee.storePath, 'record_peers').find((r) => r.replica_id === caller.replicaId)
  ).toMatchObject({ library_version: report.libraryVersion, reads: 1 });
});
