// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Recovery reads only fresh sanitized scratch copies, retaining source hashes and every log stream.
// ABOUTME: Every call closes its clients and removes its scratch files, including refused or failed inputs.
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { RbookDatabaseClient } from '../tools/rbook/client';
import { replicaMarks } from '../tools/rbook/record-apply';
import { chainHash } from '../tools/rbook/record-chain';
import { buildFreshCopy, FreshCopyRefused } from '../tools/rbook/record-fresh-copy';
import {
  freshBlock,
  listMembers,
  OWNER_MEMBER,
  type MemberView,
} from '../tools/rbook/record-membership';
import { mergeContext, type LoggedChange, type MergeContext } from '../tools/rbook/record-standing';
import { recordedProjectId } from '../tools/rbook/replica-identity';
import type { RecoveryIntake, RecoveryLocation, RecoveryUpload } from './recovery-types';
import type { StreamHead } from './open';

export interface RecoveryFile extends RecoveryIntake {
  readonly file: string;
  readonly scratch: string;
  readonly sha256: string;
  readonly caller: RecoveryUpload['caller'] | null;
  readonly takenAt: string | null;
  readonly changes: readonly LoggedChange[];
  readonly context: MergeContext;
  readonly members: readonly MemberView[];
  readonly nextBlock: number;
}

export function invalidRecovery(message: string): never {
  throw new FreshCopyRefused(
    message,
    'Check the recovery plan and its member/account bindings, then confirm the current plan again.'
  );
}

export function validateHead(head: StreamHead): void {
  if (
    !head ||
    typeof head.replicaId !== 'string' ||
    !head.replicaId ||
    !Number.isSafeInteger(head.seq) ||
    head.seq < 0 ||
    !(
      head.hash === null ||
      (head.seq === 0 && head.hash === '') ||
      (typeof head.hash === 'string' && /^[a-f0-9]{64}$/.test(head.hash))
    )
  )
    invalidRecovery('The recovery needs a valid host-recorded stream head.');
}

export async function recoveryClient(file: string): Promise<RbookDatabaseClient> {
  const opened = await RbookDatabaseClient.create({
    dbPath: file,
    registerProject: false,
    replicaCheck: false,
    loadVec: false,
  });
  if (!opened.success || !opened.data)
    throw new Error(opened.error?.message ?? 'The recovery copy could not be opened.');
  return opened.data;
}

/** Uploaded files are self-contained: a sidecar must not silently escape the byte fingerprint. */
export function fileHash(file: string): string {
  for (const suffix of ['-wal', '-journal'])
    if (existsSync(file + suffix) && statSync(file + suffix).size > 0)
      invalidRecovery(
        `Recovery input ${file} has a live journal; upload a self-contained SQLite snapshot.`
      );
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export async function withRecoveryFiles<T>(
  location: RecoveryLocation,
  lostHead: StreamHead,
  inputs: ReadonlyArray<{
    readonly file: string;
    readonly caller?: RecoveryUpload['caller'];
    readonly takenAt?: string;
  }>,
  use: (files: readonly RecoveryFile[]) => Promise<T>
): Promise<T> {
  validateHead(lostHead);
  if (typeof location.projectId !== 'string' || !location.projectId)
    invalidRecovery('The host must name the recorded project id.');
  const scratch = mkdtempSync(path.join(tmpdir(), 'rbook-recovery-'));
  const files: RecoveryFile[] = [];
  try {
    for (const [index, input] of inputs.entries()) {
      if (!input || typeof input.file !== 'string' || !input.file)
        invalidRecovery('Every recovery input needs a file.');
      const digest = fileHash(input.file);
      const clean = path.join(scratch, `${index}.sqlite`);
      await buildFreshCopy(input.file, clean, { untrusted: true, referee: true });
      if (fileHash(input.file) !== digest)
        invalidRecovery(`Recovery input ${input.file} changed while it was read.`);
      const client = await recoveryClient(clean);
      try {
        const context = mergeContext(client);
        if (recordedProjectId(client) !== location.projectId)
          invalidRecovery(`Recovery input ${input.file} belongs to another project.`);
        if (context.authority !== lostHead.replicaId || context.pending || context.forks.length)
          invalidRecovery(
            `Recovery input ${input.file} does not apply only the lost referee's authority.`
          );
        if (
          input.caller &&
          (!input.caller.accountId ||
            input.caller.replicaId !== context.ownReplica ||
            context.ownReplica === lostHead.replicaId)
        )
          invalidRecovery(`Recovery input ${input.file} does not belong to the calling copy.`);
        const member =
          context.members.get(context.ownReplica) ?? context.unseen.get(context.ownReplica);
        const memberId = member?.member ?? (member?.role === 'owner' ? OWNER_MEMBER : '');
        if (!memberId) invalidRecovery(`Recovery input ${input.file} has no member identity.`);
        const held = client.getMany<LoggedChange>(
          'SELECT * FROM record_changes ORDER BY replica_id, replica_seq'
        );
        if (!held.success)
          throw new Error(held.error?.message ?? 'The recovery log could not be read.');
        const marks = replicaMarks(client);
        const lostPrefix = marks[lostHead.replicaId] ?? 0;
        files.push({
          file: input.file,
          scratch: clean,
          sha256: digest,
          caller: input.caller ?? null,
          takenAt: input.takenAt ?? null,
          replicaId: context.ownReplica,
          memberId,
          marks,
          lostPrefix,
          lostHash: chainHash(client, lostHead.replicaId, lostPrefix),
          changes: held.data ?? [],
          context,
          members: listMembers(client),
          nextBlock: freshBlock(client),
        });
      } finally {
        client.close();
      }
    }
    return await use(files);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
