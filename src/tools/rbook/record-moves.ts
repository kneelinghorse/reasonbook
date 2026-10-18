// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Moving the authority (ADR s96 §8): a planned handover from the live owner's copy, each copy's confirmation of a
// ABOUTME: move before it applies it, and the new authority judging every transaction no counted verdict has reached.

import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import {
  authorityValue,
  CONFIRMED_KEY,
  confirmedAuthorityChanges,
  termOf,
  type AuthorityValue,
} from './record-authority';
import { canonicalJson } from './record-capture';
import { recordOwnChanges } from './record-changes';
import { judgeUnjudged } from './record-judge';
import { recomputeEntities } from './record-recompute';
import { underApplyToken } from './record-token';
import { mergeContext, REPLICA_ENTITY, type LoggedChange } from './record-standing';
import { writeCopyKey } from './replica-copy-keys';
import { REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolResult } from './types';

export interface Handover {
  readonly epoch: number;
  readonly to: string;
  readonly block: number;
  readonly changeId: string;
}

export interface Confirmed {
  readonly epoch: number;
  readonly authority: string;
  readonly move: AuthorityValue['move'];
  /** This copy is the authority now. */
  readonly isAuthority: boolean;
  /** Transactions this copy judged on becoming the authority. */
  readonly judged: number;
  /** Another move this copy holds for the epoch after, which needs its own confirmation. */
  readonly next: { readonly epoch: number; readonly authority: string } | null;
}

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

/**
 * A planned handover (ADR s96 §8), on the live authority's copy: an `authority` change for the next
 * epoch naming another copy of the owner's, cut at its own sequence. From it on, that copy judges
 * once it confirms; this copy's later writes are a member's.
 */
export function handOver(
  client: RbookDatabaseClient,
  input: { readonly to: string }
): RbookToolResult<Handover> {
  const ctx = mergeContext(client);
  if (ctx.ownReplica !== ctx.authority)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: "Only the owner's copy hands over, and this copy is a member's.",
      suggestion: "Hand over from the owner's copy.",
    });
  if (ctx.pending)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'This copy holds a move of the owner copy it has not confirmed, so it cannot hand over.',
      suggestion: 'Confirm that move first: reasonbook sync --confirm-owner.',
    });
  const target = ctx.members.get(input.to);
  if (!target || target.role !== 'owner' || target.cut !== undefined || input.to === ctx.ownReplica)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        "A handover names another copy of the owner's that has joined, and that copy is not one.",
      suggestion:
        "Join the owner's new copy first (reasonbook join --member <the owner's name>), then hand over to it.",
    });
  if (termOf(ctx.terms, input.to))
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: "That copy was the owner's copy once already, and each copy holds one term.",
      suggestion:
        'Have that copy re-identify first (its next sync does when it is cut), then hand over to the new copy.',
    });
  const value: AuthorityValue = {
    epoch: ctx.epoch + 1,
    authority: input.to,
    previous: ctx.authority,
    move: 'handover',
    block: target.block,
  };
  const done = client.writeTransaction(() =>
    recordOwnChanges(client, [
      {
        kind: 'authority',
        entity: REPLICA_ENTITY,
        entityId: input.to,
        field: null,
        value: canonicalJson(value),
      },
    ])
  );
  if (!done.success) return createError(done.error!);
  const [change] = rows<{ change_id: string }>(
    client,
    "SELECT change_id FROM record_changes WHERE kind = 'authority' AND replica_id = ? ORDER BY replica_seq DESC LIMIT 1",
    [ctx.ownReplica]
  );
  return createSuccess({
    epoch: value.epoch,
    to: input.to,
    block: target.block,
    changeId: change.change_id,
  });
}

/**
 * Confirm, on this copy, the move of the owner copy it holds (ADR s96 §8): the operator's word that
 * the copy it names is the owner's now. It applies from then on, and every transaction it moves is
 * written again; a copy that becomes the authority then judges what no verdict has reached.
 */
export function confirmOwner(
  client: RbookDatabaseClient,
  input: { readonly changeId?: string } = {}
): RbookToolResult<Confirmed> {
  const ctx = mergeContext(client);
  if (!ctx.pending)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: ctx.forks.length
        ? `This copy holds ${ctx.forks.length} move(s) of the owner copy for an epoch it holds already, which it never applies.`
        : 'This copy holds no move of the owner copy to confirm.',
      suggestion: ctx.forks.length
        ? 'Tell the owner: two copies each claim the record, and only one of them can be its owner copy.'
        : "Sync with the owner's copy first; a move reaches this copy there.",
    });
  if (input.changeId && input.changeId !== ctx.pending.change.change_id)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: 'The move this copy holds is not the one named, so nothing was confirmed.',
      suggestion: 'Confirm the move this copy shows: reasonbook sync --confirm-owner.',
    });
  const pending = ctx.pending;
  // A copy that is not to be the owner's writes none of its own changes here, so a restored or
  // replaced one confirms too, and re-identifies under the move at its next sync (record-token.ts).
  const done = client.writeTransaction(() =>
    underApplyToken(
      client,
      () => {
        const confirmed = [...confirmedAuthorityChanges(client), pending.change.change_id];
        writeCopyKey(client, CONFIRMED_KEY, JSON.stringify(confirmed));
        const after = mergeContext(client);
        const judged = judgeUnjudged(client);
        // Everything the two authorities wrote, and every transaction a verdict of theirs names.
        const touched = new Set<string>(judged);
        for (const row of rows<LoggedChange>(
          client,
          'SELECT * FROM record_changes WHERE replica_id IN (?, ?)',
          [ctx.authority, pending.value.authority]
        )) {
          touched.add(row.txn_id);
          if (row.kind === 'verdict' && row.entity_id) touched.add(row.entity_id);
        }
        recomputeEntities(client, mergeContext(client), touched, new Set());
        return { after, judged: judged.length };
      },
      { writesNoneOfItsOwn: pending.value.authority !== ctx.ownReplica }
    )
  );
  if (!done.success || !done.data) return createError(done.error!);
  const { after, judged } = done.data;
  return createSuccess({
    epoch: pending.value.epoch,
    authority: pending.value.authority,
    move: pending.value.move,
    isAuthority: after.authority === after.ownReplica,
    judged,
    next: after.pending
      ? {
          epoch: after.pending.value.epoch,
          authority: authorityValue(after.pending.change).authority,
        }
      : null,
  });
}
