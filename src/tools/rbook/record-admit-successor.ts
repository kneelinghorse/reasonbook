// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The owner's copy admitting a copy's successor (ADR s96 §3, §8, §9): a fresh block for its member, the one
// ABOUTME: it admitted before if no copy took it, and a join no recovery saw matched to the member invited again.

import { monotonicFactory } from 'ulid';
import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { canonicalJson } from './record-capture';
import { recordOwnChanges } from './record-changes';
import { readerRefusal } from './record-reader-gate';
import { reportedCopy } from './record-peer-report';
import {
  freshBlock,
  listMembers,
  MEMBER_ENTITY,
  memberNamed,
  OWNER_MEMBER,
} from './record-membership';
import { mergeContext, REPLICA_ENTITY, type MergeContext } from './record-standing';
import type { Successor } from './record-successor';
import { REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolResult } from './types';

const mintReplicaId = monotonicFactory();

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

/** A refusal, its remedy named where it is authored. */
function refuse<T>(refusal: {
  readonly code: string;
  readonly message: string;
  readonly suggestion: string;
}): RbookToolResult<T> {
  return createError<T>({ ...refusal });
}

/** The member (person) a replica is a copy for, from any admission this copy holds. */
function memberOf(ctx: MergeContext, replicaId: string): { member: string; role: string } | null {
  const known = ctx.members.get(replicaId) ?? ctx.unseen.get(replicaId);
  if (!known) return null;
  const member = known.member ?? (known.role === 'owner' ? OWNER_MEMBER : '');
  return member ? { member, role: known.role === 'owner' ? 'owner' : 'editor' } : null;
}

/** The name an invite gave a member, read from its member change wherever it sits in the log. */
function invitedName(client: RbookDatabaseClient, memberId: string): string | null {
  const [change] = rows<{ value: string | null }>(
    client,
    "SELECT value FROM record_changes WHERE kind = 'member' AND entity = ? AND entity_id = ? ORDER BY hlc LIMIT 1",
    [MEMBER_ENTITY, memberId]
  );
  try {
    const name = (JSON.parse(change?.value ?? 'null') as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/**
 * A successor this record admitted for `replicaId` that no copy took, as a channel that dropped
 * between the admission and the copy taking it leaves one: the copy takes that one, so none is left
 * orphaned. Only an admission this copy counts is reused, and never one a removal or a recovery's
 * drop has cut: a copy given that one would have its next write quarantined.
 */
function untakenSuccessor(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  replicaId: string
): Successor | null {
  for (const member of ctx.members.values()) {
    if (member.previous !== replicaId || member.role === 'removed' || member.cut !== undefined)
      continue;
    const taken = rows(client, 'SELECT 1 FROM record_changes WHERE replica_id = ? LIMIT 1', [
      member.replicaId,
    ]);
    if (!taken.length)
      return {
        replicaId: member.replicaId,
        block: member.block,
        role: member.role === 'owner' ? 'owner' : 'editor',
        member: member.member ?? OWNER_MEMBER,
      };
  }
  return null;
}

/**
 * On the authority: admit a successor for a copy of a member, in a fresh block above every block
 * ever issued (ADR s96 §3, §9). A new replica id names its predecessor; `sameId` re-admits the copy
 * itself at the new block, for a block clash it lost. A removed member is never re-admitted here.
 */
export function admitSuccessor(
  client: RbookDatabaseClient,
  input: { readonly replicaId: string; readonly sameId?: boolean }
): RbookToolResult<Successor> {
  const committed = client.writeTransaction(() => admitLocked(client, input));
  if (!committed.success) return createError(committed.error!);
  return committed.data!;
}

function admitLocked(
  client: RbookDatabaseClient,
  input: { readonly replicaId: string; readonly sameId?: boolean }
): RbookToolResult<Successor> {
  const ctx = mergeContext(client);
  if (ctx.ownReplica !== ctx.authority)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: "Only the owner's copy admits a copy's new identity.",
      suggestion: "Sync with the owner's copy.",
    });
  if (ctx.members.get(input.replicaId)?.role === 'removed')
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: "That copy's member was removed, so it takes no new identity.",
      suggestion: 'Invite the member again to re-add them.',
    });
  const known = memberOf(ctx, input.replicaId);
  // ADR s96 §8: a join no recovery saw may be for an invite it never saw either. Its person is the
  // member invited again under that name; until then its copy takes no new identity.
  const unseenName =
    known && ctx.unseen.has(input.replicaId) ? invitedName(client, known.member) : null;
  const person = known
    ? (listMembers(client).find((member) => member.memberId === known.member) ??
      (unseenName ? (memberNamed(client, unseenName) ?? undefined) : undefined))
    : undefined;
  if (unseenName && !person)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${unseenName} was invited after the cut of the recovery that replaced the owner copy, so this record does not know them, and their copy takes no new identity yet.`,
      suggestion: `Invite them again: rbook_project(action="invite", name="${unseenName}"). Their copy then takes a new identity at its next sync.`,
    });
  if (!known || !person || person.role === 'removed')
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'That copy is not one of a member this record knows, so it cannot take a new identity.',
      suggestion:
        "Invite its member, then join a fresh copy from the owner's: reasonbook copy and reasonbook join.",
    });
  const report = reportedCopy(client, input.replicaId);
  const oldReader = readerRefusal(client, input.replicaId, report, person.name, ctx);
  if (oldReader) return createError(oldReader);
  if (!input.sameId) {
    const earlier = untakenSuccessor(client, ctx, input.replicaId);
    if (earlier) return createSuccess(earlier);
  }
  const role =
    person.memberId === known.member ? known.role : person.role === 'owner' ? 'owner' : 'editor';
  const replicaId = input.sameId ? input.replicaId : mintReplicaId();
  const block = freshBlock(client);
  const done = client.writeTransaction(() =>
    recordOwnChanges(
      client,
      [
        {
          kind: 'replica_joined',
          entity: REPLICA_ENTITY,
          entityId: replicaId,
          field: null,
          value: canonicalJson({
            block,
            role,
            member: person.memberId,
            ...(input.sameId ? {} : { previous: input.replicaId }),
          }),
        },
      ],
      { admittingReads: report.reads }
    )
  );
  if (!done.success) return createError(done.error!);
  return createSuccess({ replicaId, block, role, member: person.memberId });
}
