// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Permanent replica cuts survive member administration and never become accepted work on re-add.
// ABOUTME: Real recorded stores distinguish a cut replica from its still-active person and ordinary removal.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { canonicalJson } from '../../../src/tools/rbook/record-capture';
import { recordOwnChanges } from '../../../src/tools/rbook/record-changes';
import fs from 'fs';
import path from 'path';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { recoverAuthority } from '../../../src/tools/rbook/record-recovery';
import { recoverySnapshot } from '../../helpers/recovery-fixture';
import { recomputeEntities } from '../../../src/tools/rbook/record-recompute';
import { underApplyToken } from '../../../src/tools/rbook/record-token';
import { decideTransactions } from '../../../src/tools/rbook/record-decide';
import {
  inviteMember,
  listMembers,
  removeMember,
  setMemberRole,
} from '../../../src/tools/rbook/record-membership';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read, sync, type Copy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-set-aside-cuts-');
});
afterEach(() => fixture.restore());

async function permanentCut(owner: Copy, memberName: string, cuts: Record<string, number>) {
  return onCopy(fixture.tmp, owner, (client) => {
    const member = listMembers(client).find((entry) => entry.name === memberName)!;
    const written = client.writeTransaction(() => {
      return recordOwnChanges(client, [
        {
          kind: 'member',
          entity: 'member',
          entityId: member.memberId,
          field: null,
          value: canonicalJson({ name: member.name, role: member.role, setAsideCuts: cuts }),
        },
      ]);
    });
    expect(written.success).toBe(true);
    return member.memberId;
  });
}

async function decide(copy: Copy, content: string) {
  useMachine(fixture.tmp, copy.machine);
  const done = await call('rbook_decisions', { action: 'record', content, projectRoot: copy.root });
  expect(done.success).toBe(true);
  return read<{ txn_id: string }>(
    copy,
    "SELECT txn_id FROM record_changes WHERE kind = 'create' AND json_extract(value, '$.decision_text') = ?",
    [content]
  )[0].txn_id;
}

function payload(owner: Copy, memberId: string) {
  return JSON.parse(
    read<{ value: string }>(
      owner,
      "SELECT value FROM record_changes WHERE kind = 'member' AND entity_id = ? ORDER BY rowid DESC LIMIT 1",
      [memberId]
    )[0].value
  );
}

function verdicts(owner: Copy, txnId: string) {
  return read<{ value: string }>(
    owner,
    "SELECT value FROM record_changes WHERE kind = 'verdict' AND entity_id = ? ORDER BY rowid",
    [txnId]
  ).map((row) => JSON.parse(row.value).verdict);
}

describe('permanent set-aside cuts (s98-m17)', () => {
  it('projects a present member cut independently of removal and retains it through a role change', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joinedCopy(fixture.tmp, owner, 'studio', 'Erin');
    const memberId = await permanentCut(owner, 'Erin', { [member.replicaId]: 0 });
    const before = await onCopy(fixture.tmp, owner, (client) => mergeContext(client));
    expect(before.members.get(member.replicaId)).toMatchObject({ role: 'editor', cut: 0 });
    expect(
      (
        before as typeof before & { setAsideCuts: ReadonlyMap<string, Record<string, number>> }
      ).setAsideCuts.get(memberId)
    ).toEqual({ [member.replicaId]: 0 });
    expect(
      (await onCopy(fixture.tmp, owner, (client) => setMemberRole(client, 'Erin', 'owner'))).success
    ).toBe(true);
    expect(payload(owner, memberId)).toMatchObject({
      role: 'owner',
      setAsideCuts: { [member.replicaId]: 0 },
    });
    expect(
      (await onCopy(fixture.tmp, owner, (client) => mergeContext(client))).members.get(
        member.replicaId
      )
    ).toMatchObject({ role: 'owner', cut: 0 });
  });

  it('removal and re-add retain every permanent cutoff while ordinary removal still accepts work', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const cutCopy = await joinedCopy(fixture.tmp, owner, 'cut', 'Erin');
    const activeCopy = await joinedCopy(fixture.tmp, owner, 'active', 'Erin');
    const memberId = await permanentCut(owner, 'Erin', { [cutCopy.replicaId]: 0 });
    expect(
      (await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Erin'))).success
    ).toBe(true);
    const cutTxn = await decide(cutCopy, 'Permanent tail must stay quarantined.');
    const removedTxn = await decide(activeCopy, 'Ordinary removal may be restored.');
    await sync(fixture.tmp, cutCopy, owner);
    await sync(fixture.tmp, activeCopy, owner);
    expect(verdicts(owner, cutTxn)).toEqual(['quarantined']);
    expect(verdicts(owner, removedTxn)).toEqual(['quarantined']);
    expect(
      (await onCopy(fixture.tmp, owner, (client) => inviteMember(client, { name: 'Erin' }))).success
    ).toBe(true);
    expect(payload(owner, memberId).setAsideCuts).toEqual({ [cutCopy.replicaId]: 0 });
    expect(verdicts(owner, cutTxn)).toEqual(['quarantined']);
    expect(verdicts(owner, removedTxn)).toEqual(['quarantined', 'accepted']);
    expect(
      (await onCopy(fixture.tmp, owner, (client) => mergeContext(client))).members.get(
        cutCopy.replicaId
      )?.cut
    ).toBe(0);
  });

  it('an explicit accepted verdict cannot bypass a permanent cut', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joinedCopy(fixture.tmp, owner, 'studio', 'Erin');
    await permanentCut(owner, 'Erin', { [member.replicaId]: 0 });
    await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Erin'));
    const txn = await decide(member, 'Cannot be revived by an explicit verdict.');
    await sync(fixture.tmp, member, owner);
    expect(verdicts(owner, txn)).toEqual(['quarantined']);
    const before = read(owner, 'SELECT * FROM record_changes ORDER BY rowid');
    const accepted = await onCopy(fixture.tmp, owner, (client) =>
      decideTransactions(client, [txn], 'accepted', 'manual acceptance')
    );
    expect(accepted.success).toBe(false);
    expect(accepted.error?.suggestion).toMatch(/write.*again|redo/i);
    expect(read(owner, 'SELECT * FROM record_changes ORDER BY rowid')).toEqual(before);
    expect(verdicts(owner, txn)).toEqual(['quarantined']);
  });
  it('re-add leaves a quarantine written before removal untouched, even with removal-like prose', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joinedCopy(fixture.tmp, owner, 'studio', 'Erin');
    const txn = await decide(member, 'Earlier quarantine is not caused by this removal.');
    await sync(fixture.tmp, member, owner);
    await onCopy(fixture.tmp, owner, (client) => {
      const written = client.writeTransaction(() =>
        underApplyToken(client, () => {
          recordOwnChanges(client, [
            {
              kind: 'verdict',
              entity: 'txn',
              entityId: txn,
              field: null,
              value: canonicalJson({
                verdict: 'quarantined',
                reason: 'its member was removed, and it comes after the cut at change 0',
                epoch: mergeContext(client).epoch,
                replica: member.replicaId,
              }),
            },
          ]);
          return recomputeEntities(client, mergeContext(client), new Set([txn]), new Set());
        })
      );
      expect(written.success).toBe(true);
    });
    expect(verdicts(owner, txn)).toEqual(['accepted', 'quarantined']);
    await onCopy(fixture.tmp, owner, (client) => removeMember(client, 'Erin'));
    const before = verdicts(owner, txn);
    const readded = await onCopy(fixture.tmp, owner, (client) =>
      inviteMember(client, { name: 'Erin' })
    );
    expect(readded.success).toBe(true);
    expect(verdicts(owner, txn)).toEqual(before);
  });

  it('direct recovery no longer waits for a missing permanently cut copy of an active member', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const live = await joinedCopy(fixture.tmp, owner, 'live', 'Erin');
    const gone = await joinedCopy(fixture.tmp, owner, 'gone', 'Erin');
    await permanentCut(owner, 'Erin', { [gone.replicaId]: 0 });
    await sync(fixture.tmp, owner, live);
    const root = path.join(fixture.tmp, 'recovered');
    fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
    fs.renameSync(recoverySnapshot(fixture.tmp, dbOf(live.root), 'recovery-base'), dbOf(root));
    const recovered = { ...live, root, machine: 'recovery-machine', name: 'recovered' };
    useMachine(fixture.tmp, recovered.machine);
    writeUserAuthor('Owner');
    const result = await recoverAuthority(
      (step) => onCopy(fixture.tmp, recovered, step, { replicaCheck: false }),
      [],
      { members: ['Erin'] }
    );
    expect(result.error).toBeUndefined();
    expect(result.data?.epoch).toBe(2);
    const ctx = await onCopy(fixture.tmp, recovered, (client) => mergeContext(client), {
      replicaCheck: false,
    });
    expect(ctx.members.get(gone.replicaId)?.cut).toBe(0);
  });
});
