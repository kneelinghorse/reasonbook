// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Public hosted recovery derives its protocol switch only from the verified adopted prefix.
// ABOUTME: Both cut positions preserve input history, account binding, current-plan confirmation and chain heads.
import Database from 'better-sqlite3';
import fs from 'fs';
import { finalizeRecovery, peer, recoveryPlan } from '../../src/referee';
import { RbookDatabaseClient } from '../../src/tools/rbook/client';
import { chainHashOf } from '../../src/tools/rbook/record-chain';
import { upgradeRecordProtocolForTesting } from '../../src/tools/rbook/record-protocol';
import { currentWriteProtocol, protocolSwitch } from '../../src/tools/rbook/record-protocol-state';
import { sharedRecordReview } from '../../src/tools/rbook/record-review';
import { mergeContext, type LoggedChange } from '../../src/tools/rbook/record-standing';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import { recoveryFixture, recoverySnapshot } from '../helpers/recovery-fixture';
import { syncWithReferee } from '../helpers/referee-fixture';

let fixture: ReplicaFixture;
let undo: (() => void) | undefined;
beforeEach(() => {
  fixture = replicaFixture('rbook-hosted-protocol-');
});
afterEach(() => {
  undo?.();
  fixture.restore();
});
async function state(file: string) {
  const opened = await RbookDatabaseClient.create({
    dbPath: file,
    readonly: true,
    replicaCheck: false,
    registerProject: false,
    loadVec: false,
  });
  if (!opened.success || !opened.data) throw new Error(JSON.stringify(opened.error));
  const client = opened.data;
  try {
    const log = client.getMany<LoggedChange>('SELECT * FROM record_changes ORDER BY change_id');
    if (!log.success) throw new Error(JSON.stringify(log.error));
    const protocol = sharedRecordReview(client)!.protocol!;
    return {
      context: mergeContext(client),
      write: currentWriteProtocol(client),
      switch: protocolSwitch(client),
      detail: protocol.summary + ' ' + protocol.detail,
      log: log.data!,
    };
  } finally {
    client.close();
  }
}

it.each([false, true])(
  'public finalizeRecovery counts S only when its verified prefix includes it, adopted=%s',
  async (adopted) => {
    undo = upgradeRecordProtocolForTesting(1);
    const { hosted, input, location } = await recoveryFixture(fixture.tmp);
    const beforeHead = input.lostHead;
    expect((await state(hosted.referee.storePath)).switch).toBeNull();
    undo();
    undo = undefined;
    // A real protocol-one owner write is accepted after the owner reports current reader support.
    useMachine(fixture.tmp, hosted.owner.machine);
    expect(
      (
        await call('rbook_decisions', {
          action: 'record',
          content: 'The referee accepts this after its reader upgrades.',
          projectRoot: hosted.owner.root,
        })
      ).success
    ).toBe(true);
    await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
    const after = await state(hosted.referee.storePath);
    expect(after.switch).toMatchObject({ replicaId: beforeHead.replicaId });
    expect(after.switch!.seq).toBeGreaterThan(beforeHead.seq);
    expect(after.write).toBe(2);
    const afterHead = hosted.referee.expectedHead!;
    const upload = recoverySnapshot(fixture.tmp, dbOf(hosted.owner.root), 'after-switch-upload');
    const uploadRows = (await state(upload)).log;
    const bytes = fs.readFileSync(upload);
    // A response lost before the host recorded its head leaves S as retained, unverified tail.
    // The other case supplies that actual later head, so the identical tail is adopted.
    const supplied = {
      ...input,
      lostHead: adopted ? afterHead : beforeHead,
      recordedHeads: adopted ? [beforeHead, afterHead] : [beforeHead],
      uploads: [{ ...input.uploads[0], file: upload }],
    };
    const planned = await recoveryPlan(location, supplied);
    expect(planned.result.error).toBeUndefined();
    const plan = planned.result.data!;
    expect(plan.ready).toBe(true);
    expect(plan.adoptedPrefix).toBe(adopted ? afterHead.seq : beforeHead.seq);
    const stale = await finalizeRecovery(location, {
      ...supplied,
      confirmedPlanHash: 'not-the-reviewed-plan',
      confirmedTailMembershipIds: [],
    });
    expect(stale.result.success).toBe(false);
    expect(fs.existsSync(location.storePath)).toBe(false);
    const finalized = await finalizeRecovery(location, {
      ...supplied,
      confirmedPlanHash: plan.planHash,
      confirmedTailMembershipIds: [],
    });
    expect(finalized.result.error).toBeUndefined();
    expect(finalized.result.data).toMatchObject({
      previous: beforeHead.replicaId,
      cut: plan.adoptedPrefix,
      members: input.members,
    });
    expect(finalized.head?.replicaId).not.toBe(beforeHead.replicaId);
    const recovered = await state(location.storePath);
    expect(recovered.write).toBe(adopted ? 2 : 1);
    expect(recovered.switch).toEqual(adopted ? after.switch : null);
    expect(recovered.detail).toMatch(
      adopted ? /record protocol 2/i : /not switched.*adopted prefix/i
    );
    const own = recovered.log
      .filter((row) => row.replica_id === finalized.head!.replicaId)
      .sort((a, b) => a.replica_seq - b.replica_seq);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((row) => row.protocol_version === (adopted ? 2 : 1))).toBe(true);
    expect(chainHashOf(own, finalized.head!.seq)).toBe(finalized.head!.hash);
    for (const row of uploadRows) expect(recovered.log).toContainEqual(row);
    expect(fs.readFileSync(upload)).toEqual(bytes);
    const db = new Database(location.storePath, { readonly: true });
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.prepare('SELECT member_id,account_id FROM referee_accounts').all()).toEqual(
        input.members.map((member) => ({
          member_id: member.memberId,
          account_id: member.accountId,
        }))
      );
    } finally {
      db.close();
    }
    const authenticated = await peer(
      { ...location, expectedHead: finalized.head },
      'hello',
      { reads: 2, recordProtocol: recovered.write },
      input.uploads[0].caller
    );
    expect(authenticated.result.error).toBeUndefined();
    expect(authenticated.head).toEqual(finalized.head);
  }
);
