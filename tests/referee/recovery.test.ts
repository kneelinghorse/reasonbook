// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Hosted recovery retains every accepted log while host-recorded chain heads bound authority.
// ABOUTME: Real SQLite inputs prove account isolation, explicit confirmation, loss reporting and fresh publication.
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import fs from 'fs';
import {
  finalizeRecovery,
  recoveringAnswer,
  recoveryIntake,
  recoveryPlan,
  refereeStatus,
} from '../../src/referee';
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import type { RbookDatabaseClient } from '../../src/tools/rbook/client';
import { createError } from '../../src/tools/rbook/errors';
import { recoverAuthorityCore } from '../../src/tools/rbook/record-recovery-core';
import type { Opener } from '../../src/tools/rbook/record-sync';
import { readReplicaIdentity } from '../../src/tools/rbook/replica-identity';
import type { RbookToolResult } from '../../src/tools/rbook/types';
import { replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { recoveryFixture } from '../helpers/recovery-fixture';
import { onCopy, ownerCopy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-hosted-recovery-');
});
afterEach(() => fixture.restore());

const inputs = (two = false) => recoveryFixture(fixture.tmp, two);

it.each([1, 2])(
  'preserves transaction %i refusal and stops before later recovery work',
  async (failAt) => {
    const copy = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, copy, async (client) => {
      const before = client.getMany<{ change_id: string }>(
        "SELECT change_id FROM record_changes WHERE kind = 'authority' ORDER BY change_id"
      );
      expect(before.success).toBe(true);
      const error = {
        code: 'RECOVERY_WRITE_REFUSED',
        message: `Recovery transaction ${failAt} could not write.`,
        suggestion: 'Restore access to this recovery store, then retry the confirmed recovery.',
      };
      const real = client.writeTransaction.bind(client);
      let transactions = 0;
      let completed = 0;
      let opened = 0;
      const write = jest.spyOn(client, 'writeTransaction').mockImplementation(function <T>(
        step: () => T
      ): RbookToolResult<T> {
        // Re-identification has nested transactions; inject only at the core's two outer units.
        if (client.inTransaction) return real(step);
        transactions += 1;
        if (transactions === failAt) return createError<T>(error);
        const result = real(step);
        if (result.success) completed += 1;
        return result;
      });
      const self: Opener = async <T>(
        step: (current: RbookDatabaseClient) => T
      ): Promise<Awaited<T>> => {
        opened += 1;
        return await step(client);
      };
      const cuts = jest.fn(() => ({}));
      const beforeJudge = jest.fn();
      try {
        const result = await recoverAuthorityCore(
          self,
          [],
          {
            previous: copy.replicaId,
            block: 1,
            ownerName: 'Owner',
            members: [],
            cuts,
            beforeJudge,
          },
          ProjectGraphRegistry.getInstance()
        );
        expect(result).toEqual({ success: false, error });
        expect(result.data).toBeUndefined();
        expect({ transactions, completed, opened }).toEqual({
          transactions: failAt,
          completed: failAt - 1,
          opened: failAt,
        });
        expect(cuts).not.toHaveBeenCalled();
        expect(beforeJudge).not.toHaveBeenCalled();
        expect(
          client.getMany(
            "SELECT change_id FROM record_changes WHERE kind = 'authority' ORDER BY change_id"
          )
        ).toEqual(before);
        // In case two the first real write committed, so the later refusal cannot be a masked setup failure.
        expect(readReplicaIdentity(client, { fresh: true })?.replicaId === copy.replicaId).toBe(
          failAt === 1
        );
      } finally {
        write.mockRestore();
      }
    });
  }
);

it('answers collecting with an identity-bound state and an upgrade remedy old clients can display', () => {
  const state = {
    recoveryId: 'recovery-1',
    projectId: 'project-1',
    lostHead: { replicaId: 'old', seq: 4, hash: 'a'.repeat(64) },
  };
  const answer = recoveringAnswer(state);
  expect(refereeStatus(answer)).toBe(409);
  expect(answer.error).toMatchObject({
    code: 'REFEREE_RECOVERING',
    currentState: { ...state, state: 'collecting' },
  });
  expect(answer.error?.suggestion).toMatch(/upgrade/i);
  expect(answer.error?.suggestion).toMatch(/locally/i);
});

it('intake validates the project, old authority and claimed replica without changing uploaded bytes', async () => {
  const { input, location } = await inputs();
  const upload = input.uploads[0];
  const bytes = fs.readFileSync(upload.file);
  const accepted = await recoveryIntake(location, { ...upload, lostHead: input.lostHead });
  expect(accepted.head).toBeNull();
  expect(accepted.result.error).toBeUndefined();
  expect(accepted.result.data).toMatchObject({
    replicaId: upload.caller.replicaId,
    memberId: 'owner',
    lostPrefix: input.lostHead.seq,
  });
  for (const [where, supplied] of [
    [
      { ...location, projectId: 'another-project' },
      { ...upload, lostHead: input.lostHead },
    ],
    [
      location,
      {
        ...upload,
        caller: { ...upload.caller, replicaId: 'another-copy' },
        lostHead: input.lostHead,
      },
    ],
    [location, { ...upload, lostHead: { ...input.lostHead, replicaId: 'another-referee' } }],
  ] as const)
    expect((await recoveryIntake(where, supplied)).result.success).toBe(false);
  expect(fs.readFileSync(upload.file)).toEqual(bytes);
  expect(fs.existsSync(location.storePath)).toBe(false);
});

it('a plan authenticates account bindings, reports a missing copy, and binds drop selections', async () => {
  const { input, location } = await inputs(true);
  const wrong = await recoveryPlan(location, {
    ...input,
    uploads: [
      { ...input.uploads[0], caller: { ...input.uploads[0].caller, accountId: 'other-account' } },
      input.uploads[1],
    ],
  });
  expect(wrong.result.success).toBe(false);
  const omitted = await recoveryPlan(location, {
    ...input,
    uploads: [input.uploads[0]],
    members: input.members.filter((member) => member.memberId === 'owner'),
  });
  expect(omitted.result.success).toBe(false);
  const missing = (await recoveryPlan(location, { ...input, uploads: [input.uploads[0]] })).result
    .data!;
  expect(missing.waiting).toContain(input.uploads[1].caller.replicaId);
  expect(missing.ready).toBe(false);
  const dropped = (
    await recoveryPlan(location, {
      ...input,
      uploads: [input.uploads[0]],
      dropCopies: [input.uploads[1].caller.replicaId],
    })
  ).result.data!;
  expect(dropped.waiting).toEqual([]);
  expect(dropped.planHash).not.toBe(missing.planHash);
});

it('a VACUUM snapshot and member uploads recover into a new authority after explicit current-plan confirmation', async () => {
  const { input, location } = await inputs(true);
  const plan = (await recoveryPlan(location, input)).result.data!;
  expect(plan.ready).toBe(true);
  expect(plan.loss).toMatchObject({ count: 0, lowerBound: true });
  const stale = await finalizeRecovery(location, {
    ...input,
    confirmedPlanHash: 'stale',
    confirmedTailMembershipIds: [],
  });
  expect(stale.result.success).toBe(false);
  expect(fs.existsSync(location.storePath)).toBe(false);
  const result = await finalizeRecovery(location, {
    ...input,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: [],
  });
  expect(result.result.error).toBeUndefined();
  expect(result.result.data).toMatchObject({
    previous: input.lostHead.replicaId,
    cut: input.lostHead.seq,
    epoch: 3,
  });
  expect(result.head?.replicaId).not.toBe(input.lostHead.replicaId);
  const db = new Database(location.storePath, { readonly: true });
  try {
    const ids = new Set(
      (
        db.prepare('SELECT change_id FROM record_changes').all() as Array<{ change_id: string }>
      ).map((row) => row.change_id)
    );
    for (const upload of input.uploads) {
      const source = new Database(upload.file, { readonly: true });
      try {
        for (const row of source.prepare('SELECT change_id FROM record_changes').all() as Array<{
          change_id: string;
        }>)
          expect(ids.has(row.change_id)).toBe(true);
      } finally {
        source.close();
      }
    }
  } finally {
    db.close();
  }
});
