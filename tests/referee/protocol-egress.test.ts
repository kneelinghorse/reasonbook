// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Authenticated old dashboard callers receive only readable stream prefixes and honest receipts.
// ABOUTME: Paging cannot advertise more or served marks for a transaction held by its reader protocol.
import { createSuccess } from '../../src/tools/rbook/errors';
import { recordOwnChanges } from '../../src/tools/rbook/record-changes';
import { upgradeRecordProtocolForTesting } from '../../src/tools/rbook/record-protocol';
import { changesSince } from '../../src/tools/rbook/record-since';
import type { LoggedChange } from '../../src/tools/rbook/record-standing';
import { peer, peers } from '../../src/referee';
import { withReferee } from '../../src/referee/open';
import { replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { ask, callerOf, hostProject } from '../helpers/referee-fixture';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-referee-protocol-egress-');
});
afterEach(() => fixture.restore());

it('legacy paged and unpaged requests hold protocol2 and report only actually served marks', async () => {
  const hosted = await hostProject(fixture.tmp);
  const caller = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
  const changed = await ask(hosted.referee, (at) =>
    withReferee(at, ({ client }) => {
      const back = upgradeRecordProtocolForTesting(2);
      try {
        const saved = client.writeTransaction(() =>
          recordOwnChanges(client, [
            {
              kind: 'member',
              entity: '__member__',
              entityId: 'future-person',
              field: null,
              value: JSON.stringify({ name: 'Future', role: 'editor' }),
            },
          ])
        );
        expect(saved.success).toBe(true);
        return createSuccess(changesSince(client, {}));
      } finally {
        back();
      }
    })
  );
  const full = changed.data!;
  expect(full.some((row) => row.protocol_version === 2)).toBe(true);
  expect((await ask(hosted.referee, (at) => peer(at, 'hello', { reads: 1 }, caller))).success).toBe(
    true
  );
  const page = await ask(hosted.referee, (at) =>
    peer(at, 'changesSince', { marks: {}, maxBytes: 1024 * 1024 }, caller)
  );
  expect(page.success).toBe(true);
  const delivered = page.data as { changes: LoggedChange[]; more: boolean };
  expect(delivered.more).toBe(false);
  expect(delivered.changes.some((row) => row.protocol_version > 1)).toBe(false);
  const expected: Record<string, number> = {};
  for (const row of delivered.changes)
    expected[row.replica_id] = Math.max(expected[row.replica_id] ?? 0, row.replica_seq);
  const copies = await ask(hosted.referee, peers);
  expect(copies.data?.find((copy) => copy.replicaId === caller.replicaId)?.servedThrough).toEqual(
    expected
  );
  const raw = await ask(hosted.referee, (at) => peer(at, 'changesSince', {}, caller));
  expect(raw.data).toEqual(delivered.changes);
  await ask(hosted.referee, (at) => peer(at, 'hello', { reads: 2 }, caller));
  expect((await ask(hosted.referee, (at) => peer(at, 'changesSince', {}, caller))).data).toEqual(
    full
  );
});

it('the authenticated move-back refuses old or missing successor reads without publishing authority', async () => {
  const hosted = await hostProject(fixture.tmp);
  const owner = await callerOf(fixture.tmp, hosted.owner, hosted.ownerAccount);
  await ask(hosted.referee, (at) => peer(at, 'hello', { reads: 2 }, owner));
  const admitted = await ask(hosted.referee, (at) =>
    peer(at, 'admitSuccessor', { replicaId: owner.replicaId }, owner)
  );
  expect(admitted.success).toBe(true);
  const replicaId = (admitted.data as { replicaId: string }).replicaId;
  const caller = { ...owner, replicaId };
  const log = () =>
    ask(hosted.referee, (at) =>
      withReferee(at, ({ client }) => createSuccess(changesSince(client, {})))
    );
  for (const reads of [null, 1]) {
    expect((await ask(hosted.referee, (at) => peer(at, 'hello', { reads }, caller))).success).toBe(
      true
    );
    const before = await log();
    const refused = await ask(hosted.referee, (at) => peer(at, 'moveBack', {}, caller));
    expect(refused.success).toBe(false);
    expect(refused.error?.message).toContain(replicaId);
    expect(refused.error?.message).toMatch(/read.*protocol 2/);
    expect(await log()).toEqual(before);
  }
  await ask(hosted.referee, (at) => peer(at, 'hello', { reads: 2 }, caller));
  expect((await ask(hosted.referee, (at) => peer(at, 'moveBack', {}, caller))).success).toBe(true);
});
