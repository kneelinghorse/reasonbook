// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m01 — shared_conflicts fires on copies of a shared record as the merge leaves them: two copies' changes to one
// ABOUTME: field at once are an unsettled conflict on both, and a removal an exchange reported reads as removed.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import { readSignals, type SignalEntry } from '../../src/signals';
import { noteRemoval } from '../../src/tools/rbook/record-peers';
import {
  call,
  dbOf,
  record,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import {
  exchange,
  memberCopy,
  onCopy,
  ownerCopy,
  read,
  sync,
  type Copy,
} from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-signals-shared-');
});
afterEach(() => fixture.restore());

async function on<T>(copy: Copy, run: () => Promise<T>): Promise<T> {
  useMachine(fixture.tmp, copy.machine);
  return run();
}

async function ok(copy: Copy, tool: string, args: Record<string, unknown>): Promise<void> {
  const answer = await on(copy, () => call(tool, { ...args, projectRoot: copy.root }));
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
}

function conflicts(copy: Copy): SignalEntry {
  return readSignals(dbOf(copy.root), { now: Date.now() }).signals.find(
    (entry) => entry.kind === 'shared_conflicts'
  )!;
}

describe('shared_conflicts on copies of a shared record (s97-m01)', () => {
  it('counts the field two copies changed at once, on both copies, as the merge leaves it', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    const made = await on(owner, () => record(owner.root, 'A choice to argue over.'));
    const id = (made.data as { decisionId: number }).decisionId;
    await sync(fixture.tmp, owner, member);
    await ok(owner, 'rbook_decisions', { action: 'update', decisionId: id, status: 'archived' });
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: id, status: 'stale' });
    await exchange(fixture.tmp, owner, member);
    await sync(fixture.tmp, owner, member);
    const rows = read<{ entity: string; entity_id: string; field: string }>(
      owner,
      'SELECT entity, entity_id, field FROM record_conflicts'
    );
    expect(rows).toHaveLength(1);
    const [{ entity, entity_id: entityId, field }] = rows;
    for (const copy of [owner, member])
      expect({ copy: copy.name, entry: conflicts(copy) }).toMatchObject({
        copy: copy.name,
        entry: {
          available: true,
          count: 1,
          ids: [`${entity}:${entityId}/${field}`],
          removed: false,
          // Each copy detected the conflict at its own time.
          oldestAt: new Date(
            read<{ detected_at: string }>(copy, 'SELECT detected_at FROM record_conflicts')[0]
              .detected_at
          ).toISOString(),
        },
      });
  });

  it('says a copy is removed once an exchange has told it so', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await sync(fixture.tmp, owner, member);
    expect(conflicts(member)).toMatchObject({ available: true, count: 0, removed: false });
    // What record-sync.ts notes when an exchange names this copy's member removed.
    await onCopy(fixture.tmp, member, (client) => noteRemoval(client, owner.replicaId, true));
    expect(conflicts(member)).toMatchObject({ available: true, count: 0, removed: true });
  });
});
