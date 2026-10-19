// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m11 — a copy that takes a new identity keeps every move its chain applied: a former owner copy's own
// ABOUTME: handover, which it applied as its own write, stays applied under the new identity instead of turning pending.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { admitSuccessor } from '../../../src/tools/rbook/record-admit-successor';
import { inviteMember } from '../../../src/tools/rbook/record-membership';
import { confirmOwner, handOver } from '../../../src/tools/rbook/record-moves';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import { takeSuccessor } from '../../../src/tools/rbook/record-successor';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, syncCopies } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-successor-moves-');
});
afterEach(() => fixture.restore());

describe('a new identity keeps the moves its copy applied (s97-m11)', () => {
  it('a former owner copy that re-identifies still follows its own handover, not itself at move 1', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, owner, (client) =>
      inviteMember(client, { name: 'Owner Two', role: 'owner' })
    );
    const studio = await joinedCopy(fixture.tmp, owner, 'studio', 'Owner Two');
    const ownerReplica = await onCopy(
      fixture.tmp,
      owner,
      (client) => mergeContext(client).ownReplica
    );
    expect(
      (await onCopy(fixture.tmp, owner, (client) => handOver(client, { to: studio.replicaId })))
        .error
    ).toBeUndefined();
    await syncCopies(fixture.tmp, owner, studio);
    expect(
      (await onCopy(fixture.tmp, studio, (client) => confirmOwner(client))).error
    ).toBeUndefined();
    // The new owner copy admits a successor for the old one, which takes it here.
    const successor = await onCopy(fixture.tmp, studio, (client) =>
      admitSuccessor(client, { replicaId: ownerReplica })
    );
    expect(successor.error).toBeUndefined();
    const taken = await onCopy(
      fixture.tmp,
      owner,
      (client) =>
        takeSuccessor(client, {
          successor: successor.data!,
          reason: 'restored',
          authorityReceived: null,
        }),
      { replicaCheck: false }
    );
    expect(taken.error).toBeUndefined();
    const view = await onCopy(
      fixture.tmp,
      owner,
      (client) => {
        const ctx = mergeContext(client);
        return { authority: ctx.authority, epoch: ctx.epoch, pending: ctx.pending !== null };
      },
      { replicaCheck: false }
    );
    expect(view).toEqual({ authority: studio.replicaId, epoch: 2, pending: false });
  }, 240000);
});
