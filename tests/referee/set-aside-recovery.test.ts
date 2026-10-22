// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Recovery excludes only authority-verified permanent cuts from missing-copy obligations.
// ABOUTME: Real hosted snapshots prove a cut outside the recorded prefix remains untrusted evidence.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { recoveryPlan } from '../../src/referee';
import { withReferee } from '../../src/referee/open';
import { canonicalJson } from '../../src/tools/rbook/record-capture';
import { recordOwnChanges } from '../../src/tools/rbook/record-changes';
import { listMembers } from '../../src/tools/rbook/record-membership';
import { replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { recoveryFixture, recoverySnapshot } from '../helpers/recovery-fixture';
import { ask } from '../helpers/referee-fixture';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('referee-set-aside-recovery-');
});
afterEach(() => fixture.restore());

it.each(['verified', 'unverified'] as const)(
  '%s set-aside controls the missing-copy obligation',
  async (trust) => {
    const { hosted, extra, input, location } = await recoveryFixture(fixture.tmp, true);
    const oldHead = hosted.referee.expectedHead!;
    const cut = await ask(hosted.referee, (at) =>
      withReferee(at, ({ client }) => {
        const member = listMembers(client).find((person) => person.name === 'Erin')!;
        return client.writeTransaction(() => {
          return recordOwnChanges(client, [
            {
              kind: 'member',
              entity: 'member',
              entityId: member.memberId,
              field: null,
              value: canonicalJson({
                name: member.name,
                role: member.role,
                setAsideCuts: { [extra[0].replicaId]: 0 },
              }),
            },
          ]);
        });
      })
    );
    expect(cut.success).toBe(true);
    const head = trust === 'verified' ? hosted.referee.expectedHead! : oldHead;
    const file = recoverySnapshot(fixture.tmp, hosted.referee.storePath, `after-cut-${trust}`);
    const planned = await recoveryPlan(location, {
      ...input,
      lostHead: head,
      recordedHeads: [head],
      uploads: [input.uploads[0]],
      snapshots: [{ file, takenAt: new Date().toISOString() }],
    });
    expect(planned.result.success).toBe(true);
    const erin = planned.result.data!.members.find((person) => person.name === 'Erin')!;
    expect(erin.role).toBe('editor');
    expect(erin.copies.some((copy) => copy.replicaId === extra[0].replicaId)).toBe(
      trust === 'unverified'
    );
    expect(planned.result.data!.waiting.includes(extra[0].replicaId)).toBe(trust === 'unverified');
  }
);
