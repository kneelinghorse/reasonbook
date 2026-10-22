// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A copy that must take a new identity or block in an exchange (ADR s96 §7, §9): the copy takes the successor
// ABOUTME: the authority admitted, moving the changes that clashed and renumbering its creates; the authority's own move.

import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { canonicalJson } from './record-capture';
import { recordOwnChanges } from './record-changes';
import { freshBlock } from './record-membership';
import { setAsideCut } from './record-member-cuts';
import { recomputeEntities } from './record-recompute';
import { underApplyToken } from './record-token';
import { NUMBERED, numberedId, planRenumber } from './record-renumber';
import {
  mergeContext,
  REPLICA_ENTITY,
  type LoggedChange,
  type MergeContext,
} from './record-standing';
import { reidentifyReplica } from './replica-check';
import { confirmedAuthorityChanges } from './record-authority';
import { COPY_KEYS, moveReplicaBlock, writeCopyKey } from './replica-copy-keys';
import {
  blockRange,
  readReplicaIdentity,
  REPLICA_ERROR_CODES,
  takeReplicaSeqs,
} from './replica-identity';
import type { RbookToolResult } from './types';

/** Why a copy takes a successor: what its exchange with the authority found. */
export type SuccessorReason =
  | 'restored'
  | 'whole-machine'
  | 'cut'
  | 'unseen'
  | 'slot'
  | 'block'
  /** s97-m11: the owner's copy taking the record back from the dashboard's referee. */
  | 'move-back';

/** The identity or block the authority admitted for a copy. */
export interface Successor {
  readonly replicaId: string;
  readonly block: number;
  readonly role: string;
  readonly member: string;
}

/** What a copy reports after taking its successor; its review keeps it (ADR s96 §9). */
export interface SuccessorTaken {
  readonly from: string;
  readonly to: string;
  readonly block: number;
  readonly reason: SuccessorReason;
  /** Changes lost with a replaced folder, or held back from the owner's copy, by count and range. */
  readonly count: number | null;
  readonly first?: number;
  readonly last?: number;
  readonly summary: string;
  readonly moved: number;
  readonly renumbered: number;
}

/** Per-copy metadata: the last time this copy took a successor, and what it said. Never recorded. */
export const SUCCESSOR_KEY = COPY_KEYS.successor;

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): void {
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

/** A refusal, its remedy named where it is authored. */
function refuse<T>(refusal: {
  readonly code: string;
  readonly message: string;
  readonly suggestion: string;
}): RbookToolResult<T> {
  return createError<T>({ ...refusal });
}

/** This replica's creates of the numbered tables whose ids sit in `block`. */
function createsInBlock(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  replicaId: string,
  block: number
): LoggedChange[] {
  const { low, high } = blockRange(block);
  return rows<LoggedChange>(
    client,
    "SELECT * FROM record_changes WHERE kind = 'create' AND replica_id = ? ORDER BY replica_seq",
    [replicaId]
  ).filter((create) => {
    if (!NUMBERED.has(create.entity)) return false;
    const id = numberedId(client, ctx, create);
    return id >= low && id <= high;
  });
}

/** Record a renumber of `creates` into `block` in this copy's stream, and write their rows. */
function renumber(client: RbookDatabaseClient, block: number, creates: LoggedChange[]): number {
  const plan = planRenumber(client, { block, creates });
  recordOwnChanges(client, [
    {
      kind: 'renumber',
      entity: REPLICA_ENTITY,
      entityId: mergeContext(client).ownReplica,
      field: null,
      value: canonicalJson(plan),
    },
  ]);
  return plan.rows.length;
}

/**
 * On the authority, after a block clash it lost (ADR s96 §7): take a fresh block itself and renumber
 * its own creates in the old one there, recorded in its own stream.
 */
export function reblockSelf(
  client: RbookDatabaseClient
): RbookToolResult<{ readonly block: number; readonly renumbered: number }> {
  const ctx = mergeContext(client);
  if (ctx.ownReplica !== ctx.authority)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: "Only the owner's copy moves itself to a new block.",
      suggestion: 'Sync again.',
    });
  const block = freshBlock(client);
  const done = client.writeTransaction(() =>
    underApplyToken(client, () => {
      const creates = createsInBlock(client, ctx, ctx.ownReplica, ctx.ownBlock);
      moveReplicaBlock(client, block);
      const renumbered = renumber(client, block, creates);
      recomputeEntities(
        client,
        mergeContext(client),
        new Set(creates.map((create) => create.txn_id)),
        new Set()
      );
      return renumbered;
    })
  );
  if (!done.success) return createError(done.error!);
  return createSuccess({ block, renumbered: done.data ?? 0 });
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * On the copy: take the successor the authority admitted (ADR s96 §7, §9). The same replica id is a
 * new block, and its creates in the old one are renumbered. A new id re-identifies the copy: from
 * `divergesFrom` on, its own changes that the authority never took move to the new identity behind a
 * renumber of their creates. Its review keeps what it lost, or what the owner's copy holds back.
 */
export function takeSuccessor(
  client: RbookDatabaseClient,
  input: {
    readonly successor: Successor;
    readonly reason: SuccessorReason;
    readonly authorityReceived: number | null;
    readonly divergesFrom?: number;
    readonly cut?: number;
  }
): RbookToolResult<SuccessorTaken> {
  const old = readReplicaIdentity(client, { fresh: true });
  if (!old)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: 'This store is not a copy of a shared record.',
      suggestion: 'Join it first.',
    });
  const { successor } = input;
  const cutoff = input.cut ?? setAsideCut(mergeContext(client), old.replicaId);
  const reason =
    cutoff !== undefined && input.reason !== 'move-back' && input.reason !== 'block'
      ? 'cut'
      : input.reason;
  const done = client.writeTransaction(() => {
    if (successor.replicaId === old.replicaId) {
      return underApplyToken(client, () => {
        const ctx = mergeContext(client);
        const creates = createsInBlock(client, ctx, old.replicaId, old.block);
        moveReplicaBlock(client, successor.block);
        const renumbered = renumber(client, successor.block, creates);
        recomputeEntities(
          client,
          mergeContext(client),
          new Set(creates.map((create) => create.txn_id)),
          new Set()
        );
        return {
          count: 0,
          summary: `Block ${old.block} was held by another copy too, so this copy moved to block ${successor.block} and renumbered its ${plural(renumbered, 'record')} there.`,
          moved: 0,
          renumbered,
        };
      });
    }
    const divergent =
      input.divergesFrom && cutoff === undefined
        ? rows<LoggedChange>(
            client,
            'SELECT * FROM record_changes WHERE replica_id = ? AND replica_seq >= ? ORDER BY replica_seq',
            [old.replicaId, input.divergesFrom]
          )
        : [];
    const ownSeq = rows<{ last: number | null }>(
      client,
      'SELECT max(replica_seq) AS last FROM record_changes WHERE replica_id = ?',
      [old.replicaId]
    )[0]?.last;
    // s97-m11: a move back takes the old identity's place only where the referee holds every change
    // it made. One written since the move's last sync, read here under the write lock, keeps the old
    // identity: the move syncs it to the referee, which takes it by role, and asks again (critics,
    // round 2). Its successor would judge an identity edit among them as no owner's copy, and refuse it.
    if (input.reason === 'move-back' && (ownSeq ?? 0) > (input.cut ?? 0))
      return { ahead: (ownSeq ?? 0) - (input.cut ?? 0) };
    // s97-m11: the moves this copy's chain applies stay applied under its new identity. A copy
    // applies a move it confirmed or wrote itself, and those its old identity wrote, such as an owner
    // copy's own handover, are no longer its own: they are kept as confirmed instead.
    const applied = mergeContext(client).terms.flatMap((term) =>
      term.change ? [term.change.change_id] : []
    );
    if (applied.length)
      writeCopyKey(
        client,
        COPY_KEYS.confirmedMoves,
        JSON.stringify([...new Set([...confirmedAuthorityChanges(client), ...applied])])
      );
    const { lost } = reidentifyReplica(client, {
      block: successor.block,
      authorityReceived: input.authorityReceived,
      replicaId: successor.replicaId,
    });
    // The new identity is judged before the merge's token is down (underApplyToken).
    return underApplyToken(client, () => {
      let renumbered = 0;
      if (divergent.length) {
        renumbered = renumber(
          client,
          successor.block,
          divergent.filter((change) => change.kind === 'create')
        );
        const first = takeReplicaSeqs(client, divergent.length);
        divergent.forEach((change, index) =>
          run(
            client,
            'UPDATE record_changes SET replica_id = ?, replica_seq = ? WHERE change_id = ?',
            [successor.replicaId, first + index, change.change_id]
          )
        );
        run(
          client,
          'UPDATE record_txn_state SET replica_id = ? WHERE replica_id = ? AND txn_id IN (SELECT value FROM json_each(?))',
          [
            successor.replicaId,
            old.replicaId,
            JSON.stringify([...new Set(divergent.map((change) => change.txn_id))]),
          ]
        );
        const [renumbering] = rows<LoggedChange>(
          client,
          "SELECT * FROM record_changes WHERE kind = 'renumber' AND replica_id = ? ORDER BY replica_seq DESC LIMIT 1",
          [successor.replicaId]
        );
        recomputeEntities(
          client,
          mergeContext(client),
          new Set([...divergent.map((change) => change.txn_id), renumbering.txn_id]),
          new Set()
        );
      }
      if (input.reason === 'move-back')
        // s97-m11: the old identity ends where the referee holds every change it made (above).
        return {
          count: 0,
          summary: `This copy took a new identity, in block ${successor.block}, to move the project back from the dashboard; the referee held every change its old identity made.`,
          moved: 0,
          renumbered,
        };
      if (reason === 'cut' || reason === 'unseen') {
        const cut = cutoff ?? 0;
        const count = Math.max(0, (ownSeq ?? 0) - cut);
        return {
          count,
          ...(count ? { first: cut + 1, last: ownSeq ?? cut } : {}),
          summary: count
            ? `${plural(count, 'change')} (${cut + 1} to ${ownSeq}) this copy made that the owner's copy never took are quarantined, and nothing in this release accepts them later: write again what still matters.`
            : "The owner's copy holds every change this copy made.",
          moved: 0,
          renumbered,
        };
      }
      return {
        count: lost.count,
        ...(lost.first !== undefined ? { first: lost.first, last: lost.last } : {}),
        summary: divergent.length
          ? `From change ${input.divergesFrom}, this copy's own record differed from what the owner's copy holds, as a restored or cloned machine leaves it: its ${plural(divergent.length, 'change')} from there moved to its new identity, renumbered into block ${successor.block}. ${lost.summary}`
          : lost.summary,
        moved: divergent.length,
        renumbered,
      };
    });
  });
  if (!done.success || !done.data) return createError(done.error!);
  if ('ahead' in done.data)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `This copy wrote ${plural(done.data.ahead, 'change')} after the dashboard's last mark of it, so it took no new identity.`,
      suggestion:
        'Sync (reasonbook sync), then move the project back again: the dashboard takes those changes first.',
    });
  const taken: SuccessorTaken = {
    from: old.replicaId,
    to: successor.replicaId,
    block: successor.block,
    reason,
    ...done.data,
  };
  writeCopyKey(client, SUCCESSOR_KEY, JSON.stringify({ ...taken, at: new Date().toISOString() }));
  return createSuccess(taken);
}
