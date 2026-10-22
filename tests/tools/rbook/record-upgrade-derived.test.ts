// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A checked upgrade uses the complete merge path so accepted peer sessions reach local working memory.
// ABOUTME: A table-absent first open cannot cache out replay after the same store becomes shared.
import Database from 'better-sqlite3';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { applyRemote, changesSince } from '../../../src/tools/rbook/record-apply';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  joinedCopy,
  onCopy,
  read,
  shareExisting,
  sync,
  type Copy,
} from '../../helpers/shared-copies';
let fixture: ReplicaFixture;
let restoreProtocol: (() => void) | undefined;
beforeEach(() => {
  fixture = replicaFixture('rbook-upgrade-derived-');
});
afterEach(() => {
  restoreProtocol?.();
  fixture.restore();
});
async function opened(copy: Pick<Copy, 'root' | 'machine'>) {
  useMachine(fixture.tmp, copy.machine);
  const result = await RbookDatabaseClient.create({
    dbPath: dbOf(copy.root),
    registerProject: false,
    loadVec: false,
  });
  result.data?.close();
  return result;
}
it('automatic replay folds a newly completed peer session into local working memory once', async () => {
  restoreProtocol = upgradeRecordProtocolForTesting(1);
  const root = project(fixture.tmp, 'owner');
  expect((await opened({ root, machine: 'machine-owner' })).success).toBe(true);
  expect(read({ root }, "SELECT name FROM sqlite_master WHERE name='record_changes'")).toEqual([]);
  const owner = await shareExisting(fixture.tmp, root);
  const member = await joinedCopy(fixture.tmp, owner, 'member');
  useMachine(fixture.tmp, member.machine);
  const started = await call('rbook_session', {
    action: 'start',
    type: 'planning',
    title: 'Historical peer session',
    projectRoot: member.root,
  });
  expect(started.success).toBe(true);
  await sync(fixture.tmp, member, owner);
  useMachine(fixture.tmp, member.machine);
  expect(
    (
      await call('rbook_session', {
        action: 'complete',
        summary: 'Accepted only after upgrade.',
        projectRoot: member.root,
      })
    ).success
  ).toBe(true);
  const closed = read<{ txn_id: string }>(
    member,
    `SELECT txn_id FROM record_changes WHERE entity='sessions' AND field='status' AND value='"completed"'`
  )[0];
  const incoming = await onCopy(fixture.tmp, member, (client) => changesSince(client, {}));
  expect(
    (
      await onCopy(
        fixture.tmp,
        owner,
        (client) => applyRemote(client, incoming, { judge: false }),
        { replicaCheck: false }
      )
    ).success
  ).toBe(true);
  const db = new Database(dbOf(owner.root));
  try {
    db.prepare('UPDATE record_changes SET protocol_version=2 WHERE txn_id=?').run(closed.txn_id);
  } finally {
    db.close();
  }
  restoreProtocol();
  restoreProtocol = upgradeRecordProtocolForTesting(2);
  expect((await opened(owner)).success).toBe(true);
  expect(read(owner, `SELECT status FROM sessions WHERE title='Historical peer session'`)).toEqual([
    { status: 'completed' },
  ]);
  const folded = () =>
    JSON.parse(
      read<{ content: string }>(owner, "SELECT content FROM contexts WHERE id='project_context'")[0]
        .content
    ).working_memory.session_history.filter(
      (entry: { session: string }) => entry.session === started.data!.sessionId
    );
  expect(folded()).toHaveLength(1);
  expect((await opened(owner)).success).toBe(true);
  expect(folded()).toHaveLength(1);
});
