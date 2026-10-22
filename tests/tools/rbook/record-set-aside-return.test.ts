// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A successor must not rewrite permanent old tails as accepted changes of a fresh identity.
// ABOUTME: Real copy/authority stores cover ordinary returns and a simultaneous divergent-slot repair.
import { afterEach, beforeEach, expect, it } from '@jest/globals';
import { admitSuccessor } from '../../../src/tools/rbook/record-admit-successor';
import { canonicalJson } from '../../../src/tools/rbook/record-capture';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import { listMembers } from '../../../src/tools/rbook/record-membership';
import { mergeContext, type LoggedChange } from '../../../src/tools/rbook/record-standing';
import { exchange } from '../../../src/tools/rbook/record-exchange';
import { takeSuccessor } from '../../../src/tools/rbook/record-successor';
import {
  call,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  backUp,
  copyPeer,
  joinedCopy,
  onCopy,
  ownerCopy,
  read,
  sync,
  syncCopies,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-set-aside-return-');
});
afterEach(() => fixture.restore());

it.each(['cut', 'slot'] as const)(
  '%s successor keeps old cut tails under their original identity',
  async (reason) => {
    const owner = await ownerCopy(fixture.tmp);
    const copy = await joinedCopy(fixture.tmp, owner, 'studio', 'Erin');
    await onCopy(fixture.tmp, owner, (client) => {
      const member = listMembers(client).find((person) => person.name === 'Erin')!;
      const written = client.writeTransaction(() => {
        return recordOwnChanges(client, [
          {
            kind: 'member',
            entity: 'member',
            entityId: member.memberId,
            field: null,
            value: canonicalJson({
              name: 'Erin',
              role: 'editor',
              setAsideCuts: { [copy.replicaId]: 0 },
            }),
          },
        ]);
      });
      expect(written.success).toBe(true);
    });
    useMachine(fixture.tmp, copy.machine);
    expect(
      (
        await call('rbook_decisions', {
          action: 'record',
          content: 'Old permanent tail.',
          projectRoot: copy.root,
        })
      ).success
    ).toBe(true);
    const old = read<LoggedChange>(
      copy,
      'SELECT * FROM record_changes WHERE replica_id = ? ORDER BY replica_seq',
      [copy.replicaId]
    );
    expect(old.length).toBeGreaterThan(0);
    // The boundary receives both the authority's cutoff and a slot-repair request. Neither is a
    // license to relabel the cut tail; ordinary uncut slot repair is covered by record-sync tests.
    const successor = await onCopy(fixture.tmp, owner, (client) =>
      admitSuccessor(client, { replicaId: copy.replicaId })
    );
    expect(successor.success).toBe(true);
    const taken = await onCopy(
      fixture.tmp,
      copy,
      (client) =>
        takeSuccessor(client, {
          successor: successor.data!,
          reason,
          authorityReceived: 0,
          cut: 0,
          ...(reason === 'slot' ? { divergesFrom: old[0].replica_seq } : {}),
        }),
      { replicaCheck: false }
    );
    expect(taken.success).toBe(true);
    expect(taken.data?.moved).toBe(0);
    expect(
      read<LoggedChange>(
        copy,
        'SELECT * FROM record_changes WHERE change_id IN (SELECT value FROM json_each(?)) ORDER BY replica_seq',
        [JSON.stringify(old.map((change) => change.change_id))]
      )
    ).toEqual(old);
    await sync(fixture.tmp, copy, owner);
    await syncCopies(fixture.tmp, owner, copy);
    expect(
      read(owner, 'SELECT decision_text FROM strategic_decisions WHERE decision_text = ?', [
        'Old permanent tail.',
      ])
    ).toEqual([]);
    const states = read<{ state: string }>(
      owner,
      'SELECT state FROM record_txn_state WHERE txn_id IN (SELECT value FROM json_each(?))',
      [JSON.stringify([...new Set(old.map((change) => change.txn_id))])]
    );
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((row) => row.state === 'quarantined')).toBe(true);
    expect(
      (await onCopy(fixture.tmp, owner, (client) => mergeContext(client))).members.get(
        copy.replicaId
      )?.cut
    ).toBe(0);
  }
);

it('a real forked returning stream cannot replay permanent tails under its successor', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const copy = await joinedCopy(fixture.tmp, owner, 'studio', 'Erin');
  const restore = await backUp(fixture.tmp, copy, { machine: true });
  await onCopy(fixture.tmp, owner, (client) => {
    const member = listMembers(client).find((person) => person.name === 'Erin')!;
    const written = client.writeTransaction(() => {
      return recordOwnChanges(client, [
        {
          kind: 'member',
          entity: 'member',
          entityId: member.memberId,
          field: null,
          value: canonicalJson({
            name: member.name,
            role: member.role,
            setAsideCuts: { [copy.replicaId]: 0 },
          }),
        },
      ]);
    });
    expect(written.success).toBe(true);
  });
  useMachine(fixture.tmp, copy.machine);
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'First branch after permanent cut.',
        projectRoot: copy.root,
      })
    ).success
  ).toBe(true);
  await sync(fixture.tmp, copy, owner);
  restore();
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'Forked branch after permanent cut.',
        projectRoot: copy.root,
      })
    ).success
  ).toBe(true);
  const fork = read<LoggedChange>(
    copy,
    'SELECT * FROM record_changes WHERE replica_id = ? ORDER BY replica_seq',
    [copy.replicaId]
  );
  const old = read<LoggedChange>(
    owner,
    'SELECT * FROM record_changes WHERE replica_id = ? ORDER BY replica_seq',
    [copy.replicaId]
  );
  expect(fork[0].replica_seq).toBe(old[0].replica_seq);
  expect(fork[0].change_id).not.toBe(old[0].change_id);
  const answer = await exchange(copyPeer(fixture.tmp, owner), copyPeer(fixture.tmp, copy));
  expect(
    read(owner, 'SELECT decision_text FROM strategic_decisions WHERE decision_text IN (?,?)', [
      'First branch after permanent cut.',
      'Forked branch after permanent cut.',
    ])
  ).toEqual([]);
  expect(
    read<LoggedChange>(
      copy,
      'SELECT * FROM record_changes WHERE change_id IN (SELECT value FROM json_each(?)) ORDER BY replica_seq',
      [JSON.stringify(fork.map((change) => change.change_id))]
    )
  ).toEqual(fork);
  expect(
    read<{ state: string }>(owner, 'SELECT state FROM record_txn_state WHERE replica_id = ?', [
      copy.replicaId,
    ]).every((row) => row.state === 'quarantined')
  ).toBe(true);
  // A pre-existing fork may stop exchange rather than discard either fill. It must explain the
  // retained problem, and neither outcome may revive either permanent tail under a successor.
  if (!answer.success) expect(answer.error?.message).toMatch(/cut|quarantin|differ|clash/i);
});
