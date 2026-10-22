// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Old readers receive only complete transactions before their first unreadable stream entry.
// ABOUTME: Exercise stored transaction boundaries, partial marks, independent streams and paging.
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { writeBundle } from '../../../src/tools/rbook/record-bundle';
import { firstPage } from '../../../src/tools/rbook/record-pages';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { changesSince, readableChanges } from '../../../src/tools/rbook/record-since';
import type { LoggedChange } from '../../../src/tools/rbook/record-standing';
import type { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { onCopy, ownerCopy, type Copy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
let owner: Copy;
beforeEach(async () => {
  fixture = replicaFixture('rbook-protocol-egress-');
  owner = await ownerCopy(fixture.tmp);
});
afterEach(() => fixture.restore());

// The extra argument is deliberately exercised before production grows it (behavioral red).
const delivered = changesSince as (
  client: RbookDatabaseClient,
  marks: Readonly<Record<string, number>>,
  recipient: { reads?: number | null }
) => LoggedChange[];

async function mixedTransaction(): Promise<LoggedChange[]> {
  return onCopy(fixture.tmp, owner, (client) => {
    const before = changesSince(client, {});
    const done = client.writeTransaction(() => {
      const back = upgradeRecordProtocolForTesting(1);
      try {
        recordOwnChanges(client, [
          {
            kind: 'member',
            entity: '__member__',
            entityId: 'test-reader',
            field: null,
            value: JSON.stringify({ name: 'Reader', role: 'editor' }),
          },
        ]);
      } finally {
        back();
      }
      const newer = upgradeRecordProtocolForTesting(2);
      try {
        recordOwnChanges(client, [
          {
            kind: 'member',
            entity: '__member__',
            entityId: 'test-reader',
            field: null,
            value: JSON.stringify({ name: 'Reader', role: 'removed' }),
          },
        ]);
      } finally {
        newer();
      }
    });
    expect(done.success).toBe(true);
    const written = changesSince(client, {}).slice(before.length);
    // Model historical mixed-version bytes independently of the current writer's txn pin.
    expect(
      client.execute('UPDATE record_changes SET protocol_version = 2 WHERE change_id = ?', [
        written[1].change_id,
      ]).success
    ).toBe(true);
    return changesSince(client, {}).slice(before.length);
  });
}

it.each([{}, { reads: null }, { reads: 1 }])(
  'holds the whole first unreadable transaction for legacy report %j',
  async (recipient) => {
    const txn = await mixedTransaction();
    expect(txn).toHaveLength(2);
    expect(txn[0].txn_id).toBe(txn[1].txn_id);
    expect(txn[1].protocol_version).toBe(2);
    const actual = await onCopy(fixture.tmp, owner, (client) => delivered(client, {}, recipient));
    expect(actual.some((row) => row.txn_id === txn[0].txn_id)).toBe(false);
    expect(actual.length).toBeGreaterThan(0);
  }
);

it('a mark inside the held transaction cannot reveal its remaining protocol1 tail', async () => {
  const txn = await mixedTransaction();
  await onCopy(fixture.tmp, owner, (client) => {
    // This models a historical mixed-version transaction and a resumed reader inside it.
    // Only the transport selection is under test; no merge or hash acceptance is claimed.
    expect(
      client.execute('UPDATE record_changes SET protocol_version = 2 WHERE change_id = ?', [
        txn[0].change_id,
      ]).success
    ).toBe(true);
    expect(
      client.execute('UPDATE record_changes SET protocol_version = 1 WHERE change_id = ?', [
        txn[1].change_id,
      ]).success
    ).toBe(true);
    const actual = delivered(client, { [owner.replicaId]: txn[0].replica_seq }, { reads: 1 });
    expect(actual).toEqual([]);
    expect(firstPage(actual, 1)).toEqual({ changes: [], more: false });
    expect(delivered(client, {}, { reads: 2 })).toEqual(changesSince(client, {}));
  });
});

it('unknown-destination bundles are legacy-safe while explicit reads2 keeps the full record', async () => {
  const txn = await mixedTransaction();
  await onCopy(fixture.tmp, owner, (client) => {
    expect(writeBundle(client, {}).changes.some((row) => row.txn_id === txn[0].txn_id)).toBe(false);
    const bundle = writeBundle as (
      client: RbookDatabaseClient,
      marks: Record<string, number>,
      recipient: { reads: number }
    ) => ReturnType<typeof writeBundle>;
    expect(bundle(client, {}, { reads: 2 }).changes).toEqual(changesSince(client, {}));
  });
});

it('a recovery requiring the complete log refuses a held row after its marks', async () => {
  const txn = await mixedTransaction();
  await onCopy(fixture.tmp, owner, (client) => {
    const complete = { reads: 1, requireComplete: true };
    expect(() => delivered(client, { [owner.replicaId]: txn[0].replica_seq }, complete)).toThrow(
      /protocol 2/
    );
    expect(delivered(client, { [owner.replicaId]: txn[1].replica_seq }, complete)).toEqual([]);
  });
});

it('holding one stream leaves another readable stream eligible for the same page', async () => {
  const txn = await mixedTransaction();
  const all = await onCopy(fixture.tmp, owner, (client) => changesSince(client, {}));
  const other = await ownerCopy(fixture.tmp, 'second');
  const eligible = await onCopy(fixture.tmp, other, (client) => changesSince(client, {}));
  // Selection operates on independent stored streams; no merge/authority adoption is claimed here.
  const selected = readableChanges([...all, ...eligible], { reads: 1 });
  expect(selected.filter((row) => row.replica_id === other.replicaId)).toEqual(eligible);
  expect(selected.some((row) => row.txn_id === txn[0].txn_id)).toBe(false);
  expect(firstPage(selected, 1024 * 1024)).toEqual({ changes: selected, more: false });
});
