// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m10 (design fact 24) — a member's forged baseline is ignored by every copy: the record goes by the first
// ABOUTME: baseline it holds that its own value names as written by the replica that wrote it.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { monotonicFactory } from 'ulid';
import { applyRemote } from '../../../src/tools/rbook/record-apply';
import { canonicalJson } from '../../../src/tools/rbook/record-capture';
import { PROJECT_ENTITY } from '../../../src/tools/rbook/record-columns';
import { listMembers } from '../../../src/tools/rbook/record-membership';
import { mergeContext, type LoggedChange } from '../../../src/tools/rbook/record-standing';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import {
  joinedCopy,
  onCopy,
  ownerCopy,
  read,
  replicaOf,
  sync,
  type Copy,
} from '../../helpers/shared-copies';

const mint = monotonicFactory();
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-forged-baseline-');
});
afterEach(() => fixture.restore());

/** A baseline as Darryl's copy would forge one, at `seq` in his own stream. */
function forged(template: LoggedChange, seq: number, authority: string): LoggedChange {
  return {
    ...template,
    change_id: mint(),
    txn_id: mint(),
    replica_seq: seq,
    kind: 'baseline',
    entity: PROJECT_ENTITY,
    field: null,
    base: null,
    value: canonicalJson({ owner: 'darryl', authority, epoch: 1 }),
  } as LoggedChange;
}

/** What a copy makes of the record's start: whose copy it follows, at which move, and the owner's name. */
async function startOf(copy: Copy) {
  return onCopy(fixture.tmp, copy, (client) => {
    const ctx = mergeContext(client);
    const owner = listMembers(client).find((member) => member.role === 'owner');
    return { authority: ctx.authority, epoch: ctx.epoch, owner: owner?.name };
  });
}

describe("a member's forged baseline (s97-m10, design fact 24)", () => {
  it('changes no copy: not the owner copy it follows, its move, or the owner it names', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const darryl = await joinedCopy(fixture.tmp, owner, 'darryl');
    const erin = await joinedCopy(fixture.tmp, owner, 'erin');
    const ownerReplica = await replicaOf(fixture.tmp, owner);
    const [template] = read<LoggedChange>(
      owner,
      "SELECT * FROM record_changes WHERE kind = 'baseline' LIMIT 1"
    );
    const before = await startOf(owner);
    expect(before).toEqual({ authority: ownerReplica, epoch: 1, owner: 'Owner' });
    const [{ next }] = read<{ next: number }>(
      owner,
      'SELECT COALESCE(max(replica_seq), 0) + 1 AS next FROM record_changes WHERE replica_id = ?',
      [darryl.replicaId]
    );
    // Darryl's copy names itself the first owner copy, before his stream and at its next place, and
    // names the owner's copy with his own name; an exchange trusts what it is sent (fact 24).
    const forgeries = [
      forged({ ...template, replica_id: darryl.replicaId }, 0, darryl.replicaId),
      forged({ ...template, replica_id: darryl.replicaId }, next, darryl.replicaId),
      forged({ ...template, replica_id: darryl.replicaId }, next + 1, ownerReplica),
    ];
    await onCopy(fixture.tmp, owner, (client) => {
      const applied = applyRemote(client, forgeries);
      if (!applied.success) throw new Error(applied.error?.message);
    });
    await sync(fixture.tmp, owner, erin);
    for (const copy of [owner, erin])
      expect({ copy: copy.name, ...(await startOf(copy)) }).toEqual({
        copy: copy.name,
        ...before,
      });
    // The copies still exchange as before.
    await sync(fixture.tmp, darryl, owner);
    await sync(fixture.tmp, owner, darryl);
    expect(await startOf(darryl)).toEqual(before);
  }, 240000);
});
