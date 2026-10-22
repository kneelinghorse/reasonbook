// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Stateless hosted recovery validates file inputs, exposes a confirmation plan and publishes a fresh referee.
// ABOUTME: The host owns authenticated membership and durable lifecycle state; this library owns record trust and cuts.
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import path from 'path';
import { monotonicFactory } from 'ulid';
import { ProjectGraphRegistry } from '../intelligence/project-graph-registry';
import { createError, createSuccess } from '../tools/rbook/errors';
import type { RbookDatabaseClient } from '../tools/rbook/client';
import { buildFreshCopy, FreshCopyRefused } from '../tools/rbook/record-fresh-copy';
import { recordOwnChanges } from '../tools/rbook/record-changes';
import { listMembers, OWNER_MEMBER } from '../tools/rbook/record-membership';
import { recoverAuthorityCore, recoveryCuts } from '../tools/rbook/record-recovery-core';
import type { RecoveryReport } from '../tools/rbook/record-recovery';
import type { Opener } from '../tools/rbook/record-sync';
import { fileIdentity, ReplicaRefusal, storeFolder } from '../tools/rbook/replica-identity';
import type { RbookToolResult } from '../tools/rbook/types';
import { bindAccount, REFEREE_TABLES_SQL, STATE_KEYS, writeState } from './accounts';
import { REFEREE_ERROR_CODES, refuse } from './codes';
import {
  exclusive,
  registryFolder,
  streamHead,
  type RefereeOutcome,
  type StreamHead,
} from './open';
import {
  fileHash,
  invalidRecovery,
  recoveryClient,
  withRecoveryFiles,
  type RecoveryFile,
} from './recovery-inputs';
import { makeRecoveryPlan, recoveryInputs } from './recovery-plan';
import type {
  FinalizeRecoveryInput,
  RecoveryIntake,
  RecoveryIntakeInput,
  RecoveryLocation,
  RecoveryMember,
  RecoveryPlan,
  RecoveryPlanInput,
} from './recovery-types';
export type {
  FinalizeRecoveryInput,
  RecoveryIntake,
  RecoveryIntakeInput,
  RecoveryLocation,
  RecoveryMember,
  RecoveryPlan,
  RecoveryPlanInput,
  RecoverySnapshot,
  RecoveryUpload,
} from './recovery-types';

const mintKey = monotonicFactory();

/** A member-visible collecting answer, also readable by releases predating automatic recovery uploads. */
export function recoveringAnswer(state: {
  readonly recoveryId: string;
  readonly projectId: string;
  readonly lostHead: StreamHead;
}): RbookToolResult<never> {
  return createError({
    code: REFEREE_ERROR_CODES.RECOVERING,
    message: 'This project is collecting member copies to recover its lost referee.',
    suggestion:
      'Keep writing locally. Upgrade Reasonbook to the latest release, then sync to upload your recovery copy; the owner reviews and confirms recovery on the dashboard.',
    currentState: { ...state, state: 'collecting' },
  });
}

function failure<T>(error: unknown): RefereeOutcome<T> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    result: refuse({
      code:
        error instanceof FreshCopyRefused
          ? REFEREE_ERROR_CODES.UPLOAD_REFUSED
          : REFEREE_ERROR_CODES.FAILED,
      message: `Recovery did not complete: ${message}`,
      suggestion:
        error instanceof FreshCopyRefused && error.remedy
          ? error.remedy
          : 'Retry recovery with the same accepted inputs; inspect the current plan before confirming it.',
    }),
    head: null,
  };
}

export function recoveryIntake(
  location: RecoveryLocation,
  input: RecoveryIntakeInput
): Promise<RefereeOutcome<RecoveryIntake>> {
  return exclusive(async () => {
    try {
      return await withRecoveryFiles(location, input.lostHead, [input], async ([file]) => ({
        result: createSuccess({
          replicaId: file.replicaId,
          memberId: file.memberId,
          marks: file.marks,
          lostPrefix: file.lostPrefix,
          lostHash: file.lostHash,
        }),
        head: null,
      }));
    } catch (error) {
      return failure(error);
    }
  });
}

export function recoveryPlan(
  location: RecoveryLocation,
  input: RecoveryPlanInput
): Promise<RefereeOutcome<RecoveryPlan>> {
  return exclusive(async () => {
    try {
      return await withRecoveryFiles(
        location,
        input.lostHead,
        recoveryInputs(input),
        async (files) => ({
          result: createSuccess(makeRecoveryPlan(location, input, files)),
          head: null,
        })
      );
    } catch (error) {
      return failure(error);
    }
  });
}

type Finalized = RecoveryReport & { readonly members: readonly RecoveryMember[] };

async function publishRecovery(
  location: RecoveryLocation,
  input: FinalizeRecoveryInput,
  plan: RecoveryPlan,
  files: readonly RecoveryFile[]
): Promise<RefereeOutcome<Finalized>> {
  if (existsSync(location.storePath))
    invalidRecovery(
      'A referee store already exists; the host must move the lost store aside first.'
    );
  if (!plan.ready)
    invalidRecovery('The plan still has waiting copies or conflicting stream fills.');
  if (plan.planHash !== input.confirmedPlanHash)
    invalidRecovery(
      'The recovery plan changed; the owner must review and confirm its current digest.'
    );
  const selected = new Set(input.confirmedTailMembershipIds);
  if (
    selected.size !== input.confirmedTailMembershipIds.length ||
    [...selected].some((id) => !plan.tailMembership.some((change) => change.change_id === id))
  )
    invalidRecovery(
      'Every confirmed membership change must be a distinct row in the current plan.'
    );
  const tail = plan.tailMembership.filter((change) => selected.has(change.change_id));
  for (const change of tail) {
    const value = JSON.parse(change.value ?? '{}') as {
      member?: string;
      role?: string;
      name?: string;
      block?: number;
    };
    const memberId = change.kind === 'member' ? change.entity_id : value.member;
    if (
      !input.members.some((member) => member.memberId === memberId) ||
      !['owner', 'editor', 'removed'].includes(String(value.role)) ||
      (change.kind === 'replica_joined' &&
        (!Number.isSafeInteger(value.block) || Number(value.block) < 0))
    )
      invalidRecovery(
        `Membership change ${change.change_id} does not name a confirmed member and valid role/block.`
      );
  }
  const base = files.find((file) => file.file === plan.base.file)!;
  const key = mintKey();
  const config = registryFolder(location.configDir, key);
  mkdirSync(path.dirname(location.storePath), { recursive: true });
  const stage = mkdtempSync(path.join(path.dirname(location.storePath), '.recovery-'));
  const store = path.join(stage, 'rbook.sqlite');
  let published = false;
  try {
    await buildFreshCopy(base.scratch, store);
    const registry = await ProjectGraphRegistry.create({ configDir: config });
    const self: Opener = async <T>(
      step: (client: RbookDatabaseClient) => T
    ): Promise<Awaited<T>> => {
      const client = await recoveryClient(store);
      try {
        return await step(client);
      } finally {
        client.close();
      }
    };
    await self((client) => {
      const tables = client.raw(REFEREE_TABLES_SQL);
      if (!tables.success)
        throw new Error(tables.error?.message ?? 'The referee tables were not created.');
      const bound = client.writeTransaction(() => {
        writeState(client, STATE_KEYS.registry, key);
        writeState(client, STATE_KEYS.owner, input.ownerAccountId);
        writeState(client, STATE_KEYS.createdAt, new Date().toISOString());
        for (const member of input.members) bindAccount(client, member.memberId, member.accountId);
      });
      if (!bound.success)
        throw new Error(bound.error?.message ?? 'The recovery accounts were not bound.');
    });
    const copiesToDrop = plan.members.flatMap((member) =>
      member.copies.filter((copy) => copy.dropped).map((copy) => copy.replicaId)
    );
    const block = Math.max(
      1,
      ...files.flatMap((file) => [file.nextBlock, file.context.ownBlock + 1])
    );
    const core = await recoverAuthorityCore(
      self,
      files.filter((file) => file !== base).map((file) => file.changes),
      {
        previous: input.lostHead.replicaId,
        block,
        cut: plan.adoptedPrefix,
        ownerName: input.members.find((member) => member.memberId === OWNER_MEMBER)!.name,
        members: input.members
          .filter((member) => member.memberId !== OWNER_MEMBER && member.role !== 'removed')
          .map((member) => member.name),
        cuts: (client) => recoveryCuts(client, copiesToDrop),
        recomputeAll: true,
        beforeJudge: (client) => {
          for (const change of tail)
            recordOwnChanges(client, [
              {
                kind: change.kind === 'member' ? 'member' : 'replica_joined',
                entity: change.entity,
                entityId: change.entity_id,
                field: change.field,
                value: change.value,
              },
            ]);
          const recovered = new Map(listMembers(client).map((member) => [member.memberId, member]));
          for (const member of input.members) {
            const actual = recovered.get(member.memberId);
            if (actual?.name !== member.name || actual?.role !== member.role)
              throw new ReplicaRefusal({
                code: REFEREE_ERROR_CODES.UPLOAD_REFUSED,
                message: `The confirmed member ${member.name} (${member.memberId}) has role ${member.role}, but the recovered record ${actual ? `names ${actual.name} with role ${actual.role}` : 'has no admission for that member'}.`,
                suggestion:
                  'Select the matching membership rows from the retained tail, or correct the confirmed member list and review a new plan. If admission evidence is missing, recover a copy containing that evidence before finalizing.',
              });
          }
        },
      },
      registry
    );
    if (!core.success || !core.data) return { result: createError(core.error!), head: null };
    for (const file of files)
      if (fileHash(file.file) !== file.sha256)
        invalidRecovery(`Recovery input ${file.file} changed after confirmation.`);
    const { value, collected, judged } = core.data;
    const completed = await self((client) => {
      const head = streamHead(client);
      client.pragma('journal_mode = DELETE');
      return { head, members: input.members };
    });
    registry.rebindReplica(value.authority, storeFolder(location.storePath), fileIdentity(store));
    // A hard link publishes one complete self-contained file and refuses to replace an existing destination.
    linkSync(store, location.storePath);
    published = true;
    return {
      result: createSuccess({
        epoch: value.epoch,
        authority: value.authority,
        previous: value.previous,
        block: value.block,
        cut: value.cut ?? 0,
        collected,
        judged,
        dropped: value.dropped ?? {},
        reached: files.filter((file) => file.caller).map((file) => file.replicaId),
        lost: { count: plan.loss.count, summary: plan.loss.summary },
        members: completed.members,
      }),
      head: completed.head,
    };
  } finally {
    ProjectGraphRegistry.resetInstance();
    rmSync(stage, { recursive: true, force: true });
    if (!published) rmSync(config, { recursive: true, force: true });
  }
}

export function finalizeRecovery(
  location: RecoveryLocation,
  input: FinalizeRecoveryInput
): Promise<RefereeOutcome<Finalized>> {
  return exclusive(async () => {
    try {
      return await withRecoveryFiles(
        location,
        input.lostHead,
        recoveryInputs(input),
        async (files) =>
          publishRecovery(location, input, makeRecoveryPlan(location, input, files), files)
      );
    } catch (error) {
      return failure(error);
    }
  });
}
