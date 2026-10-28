// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Prove hosted recovery preserves accepted history and quarantines a dropped returning copy.
// ABOUTME: Drive real MCP share/join/write/sync calls through a separate reference server and VACUUM snapshots.
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { afterEach, describe, expect, it } from '@jest/globals';
import path from 'path';
import type { StreamHead } from '../../src/referee';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import { sharedRecordReview } from '../../src/tools/rbook/record-review';
import { dbOf } from '../helpers/replica-fixture';
import { onCopy, read, type Copy } from '../helpers/shared-copies';
import { request } from '../helpers/referee-http';
import { requiresPrivateEvidence } from '../helpers/public-mirror';
import {
  RECOVERY_PROJECT,
  RECOVERY_TOKENS,
  recoveryClients,
  required,
  type RecoveryClientFixture,
} from '../helpers/hosted-recovery-client';

interface RecoveryView {
  recoveryId: string;
  projectId: string;
  state: string;
  lostHead: StreamHead;
  plan: {
    ready: boolean;
    planHash: string;
    adoptedPrefix: number;
    loss: { count: number; lowerBound: boolean };
    waiting: unknown[];
    members: Array<{ name: string; copies: Array<{ replicaId: string }> }>;
    tailMembership: unknown[];
    memberReconciliation: Array<{
      name: string;
      fromRole: string | null;
      role: string;
      action: string;
    }>;
  };
}
interface LogRow {
  change_id: string;
  replica_id: string;
  replica_seq: number;
  kind: string;
  entity_id: string;
}
let h: RecoveryClientFixture | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const refereeFile = () =>
  path.join(h!.fixture.tmp, 'volume/referee', RECOVERY_PROJECT, 'rbook.sqlite');
function log(file: string): LogRow[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        'SELECT change_id,replica_id,replica_seq,kind,entity_id FROM record_changes ORDER BY change_id'
      )
      .all() as LogRow[];
  } finally {
    db.close();
  }
}
const ids = (file: string) => log(file).map((row) => row.change_id);
async function decision(copy: Copy, content: string) {
  required(await h!.tool(copy, 'rbook_decisions', { action: 'record', content }));
}
async function converge(copies: Copy[]) {
  // One pass delivers each copy's local rows; the next lets earlier callers receive later deliveries.
  for (let pass = 0; pass < 2; pass++) for (const copy of copies) required(await h!.sync(copy));
}
async function view(dropMembers: string[] = []) {
  const query = dropMembers.length
    ? `?dropMembers=${encodeURIComponent(JSON.stringify(dropMembers))}`
    : '';
  return required(
    (
      await request<RecoveryView>(
        h!.server,
        `/api/relay/projects/${RECOVERY_PROJECT}/recovery${query}`,
        { token: RECOVERY_TOKENS.owner }
      )
    ).body
  );
}
async function confirm(plan: RecoveryView, dropMembers: string[] = []) {
  return required(
    (
      await request<{ authority: string; cut: number }>(
        h!.server,
        `/api/relay/projects/${RECOVERY_PROJECT}/recovery/confirm`,
        {
          token: RECOVERY_TOKENS.owner,
          json: {
            recoveryId: plan.recoveryId,
            confirmedPlanHash: plan.plan.planHash,
            confirmedTailMembershipIds: [],
            dropMembers,
          },
        }
      )
    ).body
  );
}

describe('hosted recovery across the actual MCP and HTTP boundaries (s98-m15)', () => {
  it('adopts surviving verdicts beyond a VACUUM snapshot and gives every copy every change id', async () => {
    h = await recoveryClients();
    const darryl = await h.join('darryl');
    const erin = await h.join('erin');
    const copies = [h.owner, darryl, erin];
    await converge(copies);
    const snapshot = await h.control<{ head: StreamHead }>('snapshot');
    await decision(darryl, 'The accepted decision survives loss of the referee.');
    await converge(copies);
    const before = log(refereeFile());
    const survivingVerdicts = before.filter(
      (row) =>
        row.kind === 'verdict' &&
        row.replica_id === snapshot.head.replicaId &&
        row.replica_seq > snapshot.head.seq
    );
    expect(survivingVerdicts.length).toBeGreaterThan(0);
    await h.control('lose');
    await decision(h.owner, 'The owner keeps writing while the referee is lost.');
    for (const copy of copies) await h.sync(copy);
    const planned = await view();
    expect(planned.state).toBe('collecting');
    expect(planned.plan).toMatchObject({
      ready: true,
      waiting: [],
      loss: { count: 0, lowerBound: true },
    });
    expect(planned.plan.adoptedPrefix).toBeGreaterThan(snapshot.head.seq);
    const recovered = await confirm(planned);
    expect(recovered.authority).not.toBe(snapshot.head.replicaId);
    await converge(copies);
    const finalLog = log(refereeFile());
    const finalIds = finalLog.map((row) => row.change_id);
    for (const row of before) expect(finalIds).toContain(row.change_id);
    for (const copy of copies) expect(ids(dbOf(copy.root))).toEqual(finalIds);
    // Accepted verdicts survive as authority evidence; a fresh verdict would silently replace the old decision.
    for (const old of survivingVerdicts) {
      expect(
        finalLog
          .filter((row) => row.kind === 'verdict' && row.entity_id === old.entity_id)
          .map((row) => row.change_id)
      ).toEqual([old.change_id]);
    }
    for (const copy of copies) {
      const ctx = await onCopy(h.fixture.tmp, copy, (client) => mergeContext(client));
      expect(ctx.authority).toBe(recovered.authority);
      expect(ctx.pending).toBeNull();
      expect(
        read(copy, 'SELECT decision_text FROM strategic_decisions WHERE decision_text = ?', [
          'The accepted decision survives loss of the referee.',
        ])
      ).toHaveLength(1);
      expect(
        read(copy, 'SELECT decision_text FROM strategic_decisions WHERE decision_text = ?', [
          'The owner keeps writing while the referee is lost.',
        ])
      ).toHaveLength(1);
    }
    // A later loss must use this referee's snapshots and head history, not obsolete term inputs.
    await h.control('lose');
    for (const copy of copies) await h.sync(copy);
    const secondPlan = await view();
    expect(secondPlan.lostHead.replicaId).toBe(recovered.authority);
    expect(secondPlan.plan.ready).toBe(true);
    const second = await confirm(secondPlan);
    expect(second.authority).not.toBe(recovered.authority);
    await converge(copies);
    const twiceRecoveredIds = ids(refereeFile());
    for (const id of finalIds) expect(twiceRecoveredIds).toContain(id);
    for (const copy of copies) expect(ids(dbOf(copy.root))).toEqual(twiceRecoveredIds);
  });

  it('names a missing member and quarantines its returning work even when it holds more of the old stream', async () => {
    h = await recoveryClients();
    const darryl = await h.join('darryl');
    const erin = await h.join('erin');
    await converge([h.owner, darryl, erin]);
    await h.control('snapshot');
    const oldErin = await h.replica(erin);
    const memberId = await onCopy(
      h.fixture.tmp,
      erin,
      (client) => mergeContext(client).members.get(oldErin)!.member!
    );
    await decision(erin, 'Only the missing copy keeps this accepted decision.');
    required(await h.sync(erin));
    const oldPrefix = await onCopy(h.fixture.tmp, erin, (client) => {
      const ctx = mergeContext(client);
      return ctx.prefixes.get(ctx.authority)!;
    });
    await decision(erin, 'This unsynced work must be quarantined after the drop.');
    const returningIds = ids(dbOf(erin.root));
    const returningOwnIds = log(dbOf(erin.root))
      .filter((row) => row.replica_id === oldErin)
      .map((row) => row.change_id);
    await h.control('lose');
    await h.sync(h.owner);
    await h.sync(darryl);
    const waiting = await view();
    const missingMember = waiting.plan.members.find((member) => member.name === 'erin');
    expect(missingMember?.copies.map((copy) => copy.replicaId)).toContain(oldErin);
    expect(waiting.plan.waiting).toContain(oldErin);
    expect(waiting.plan.ready).toBe(false);
    const planned = await view([memberId]);
    expect(planned.plan.ready).toBe(true);
    expect(planned.plan.adoptedPrefix).toBeLessThan(oldPrefix);
    expect(planned.plan.loss.count).toBeGreaterThan(0);
    expect(planned.plan.loss.lowerBound).toBe(true);
    await confirm(planned, [memberId]);
    await converge([h.owner, darryl]);
    await h.sync(erin);
    const held = await onCopy(h.fixture.tmp, erin, (client) => sharedRecordReview(client));
    expect(JSON.stringify(held)).toMatch(/drop|cut|prefix/i);
    expect(await h.replica(erin)).toBe(oldErin);
    // Being dropped is deliberately not an automatic authority confirmation; the person's explicit step follows.
    required(await h.sync(erin, true));
    await converge([h.owner, darryl, erin]);
    expect(await h.replica(erin)).not.toBe(oldErin);
    const recoveredIds = ids(refereeFile());
    for (const id of returningOwnIds) expect(recoveredIds).toContain(id);
    // The returning copy keeps all evidence, but normal exchange forwards only its own lineage.
    const retainedIds = ids(dbOf(erin.root));
    for (const id of returningIds) expect(retainedIds).toContain(id);
    for (const copy of [h.owner, darryl]) {
      expect(
        read(copy, 'SELECT decision_text FROM strategic_decisions WHERE decision_text IN (?,?)', [
          'Only the missing copy keeps this accepted decision.',
          'This unsynced work must be quarantined after the drop.',
        ])
      ).toHaveLength(0);
    }
    const review = await h.tool(erin, 'rbook_review', {});
    expect(review.success).toBe(true);
    expect(JSON.stringify(review)).toMatch(/quarantin|set aside|re-identif/i);
  });
});

const PRIVATE = requiresPrivateEvidence({
  reason:
    'The hosted recovery positive fire uses the private repository record committed in the 4.4.0 release; the mirror excludes that store.',
  paths: { store: 'rbook/db/rbook.sqlite' },
  revisions: { release: 'v4.4.0' },
});
PRIVATE.describe('hosted recovery of the committed real repository record', () => {
  it('recovers the real schema through MCP, retaining its baseline and an accepted later decision', async () => {
    const source = execFileSync(
      'git',
      ['show', `${PRIVATE.revisions.release}:rbook/db/rbook.sqlite`],
      { maxBuffer: 256 * 1024 * 1024 }
    );
    h = await recoveryClients(source);
    const darryl = await h.join('darryl');
    await converge([h.owner, darryl]);
    await h.control('snapshot');
    await decision(darryl, 'Recovery keeps the real repository record usable.');
    await converge([h.owner, darryl]);
    const before = ids(refereeFile());
    // The real historical store activates the new census path: no survivor sees this role change.
    required(
      (
        await request(h.server, `/api/test/projects/${RECOVERY_PROJECT}/shares/acct-darryl/role`, {
          token: RECOVERY_TOKENS.owner,
          json: { role: 'owner' },
        })
      ).body
    );
    await h.control('lose');
    await h.sync(h.owner);
    await h.sync(darryl);
    const planned = await view();
    expect(planned.plan.ready).toBe(true);
    expect(planned.plan.memberReconciliation).toContainEqual(
      expect.objectContaining({
        name: 'darryl',
        fromRole: 'editor',
        role: 'owner',
        action: 'write',
      })
    );
    await confirm(planned);
    await converge([h.owner, darryl]);
    const finalIds = ids(refereeFile());
    for (const id of before) expect(finalIds).toContain(id);
    for (const copy of [h.owner, darryl]) {
      expect(ids(dbOf(copy.root))).toEqual(finalIds);
      expect(
        read<{ n: number }>(copy, 'SELECT count(*) AS n FROM strategic_decisions')[0].n
      ).toBeGreaterThan(1000);
      expect(
        read(copy, 'SELECT decision_text FROM strategic_decisions WHERE decision_text = ?', [
          'Recovery keeps the real repository record usable.',
        ])
      ).toHaveLength(1);
    }
  });
});
