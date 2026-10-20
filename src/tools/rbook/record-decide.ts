// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The authority's own decisions about membership and standing (ADR s96 §7, §8): admitting a replica in its block,
// ABOUTME: and deciding transactions it judged before, such as a re-added member's quarantined ones.

import type { RbookDatabaseClient } from './client';
import { canonicalJson } from './record-capture';
import { recordOwnChanges } from './record-changes';
import { judge, judgeUnjudged, type Verdict } from './record-judge';
import { recomputeEntities } from './record-recompute';
import { underApplyToken } from './record-token';
import { mergeContext, REPLICA_ENTITY, TXN_ENTITY } from './record-standing';
import { REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';
import type { RbookToolResult } from './types';

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

/** Admit a member's replica in its block (ADR s96 §8): an owner-only change, on the authority's copy. */
export function admitMember(
  client: RbookDatabaseClient,
  member: {
    readonly replicaId: string;
    readonly block: number;
    readonly role: 'owner' | 'editor';
    /** s96-m13: the invited member (person) the replica is a copy for. */
    readonly member?: string;
  }
): RbookToolResult<void> {
  return client.writeTransaction(() => {
    const ctx = mergeContext(client);
    if (ctx.ownReplica !== ctx.authority)
      throw new ReplicaRefusal({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: "Only the owner's copy admits a member.",
        suggestion: "Admit the member from the owner's copy.",
      });
    recordOwnChanges(client, [
      {
        kind: 'replica_joined',
        entity: REPLICA_ENTITY,
        entityId: member.replicaId,
        field: null,
        value: canonicalJson({
          block: member.block,
          role: member.role,
          ...(member.member ? { member: member.member } : {}),
        }),
      },
    ]);
  });
}

/**
 * s96-m13 (ADR s96 §7, §8): the authority decides transactions it judged before, such as a re-added
 * member's quarantined ones: a new verdict on each, taking effect from this decision, with their rows
 * recomputed under the merge's token. Within an epoch an accepted verdict is never revised.
 */
export function decideTransactions(
  client: RbookDatabaseClient,
  txnIds: readonly string[],
  verdict: 'accepted' | 'refused',
  reason: string
): RbookToolResult<number> {
  // Under the merge's token, the copy judged before the token is down: the write check never reads
  // this decision's own token as one a crashed writer left (s96-m13).
  return client.writeTransaction(() =>
    underApplyToken(client, () => {
      const ctx = mergeContext(client);
      if (ctx.ownReplica !== ctx.authority)
        throw new ReplicaRefusal({
          code: REPLICA_ERROR_CODES.WRITE_REFUSED,
          message: "Only the owner's copy decides a transaction.",
          suggestion: "Decide it on the owner's copy.",
        });
      const epoch = ctx.epoch;
      for (const txnId of txnIds) {
        const [first] = rows<{ replica_id: string }>(
          client,
          'SELECT replica_id FROM record_changes WHERE txn_id = ? LIMIT 1',
          [txnId]
        );
        recordOwnChanges(client, [
          {
            kind: 'verdict',
            entity: TXN_ENTITY,
            entityId: txnId,
            field: null,
            value: canonicalJson({ verdict, reason, epoch, replica: first?.replica_id ?? null }),
          },
        ]);
      }
      // A decision that accepts a create a dependent waited on, unjudged, judges that dependent too.
      const dependents = judgeUnjudged(client);
      recomputeEntities(
        client,
        mergeContext(client),
        new Set([...txnIds, ...dependents]),
        new Set()
      );
      return txnIds.length;
    })
  );
}

/**
 * s100-m01 (the sprint-97 review's finding 8): the authority judges again transactions it set aside,
 * such as a re-added member's quarantined ones. Each is judged as its replica's change would be now,
 * under the merge context the re-add made, in clock order so a create is judged before what was
 * written against it. A new verdict takes effect from this decision; a transaction this judging
 * reaches no verdict on, or quarantines again, keeps the standing it had.
 */
export function rejudgeTransactions(
  client: RbookDatabaseClient,
  txnIds: readonly string[],
  reason: string
): RbookToolResult<{ readonly accepted: number; readonly refused: number }> {
  return client.writeTransaction(() =>
    underApplyToken(client, () => {
      const ctx = mergeContext(client);
      if (ctx.ownReplica !== ctx.authority)
        throw new ReplicaRefusal({
          code: REPLICA_ERROR_CODES.WRITE_REFUSED,
          message: "Only the owner's copy decides a transaction.",
          suggestion: "Decide it on the owner's copy.",
        });
      const ordered = rows<{ txn_id: string; replica_id: string }>(
        client,
        `SELECT txn_id, min(replica_id) AS replica_id FROM record_changes
          WHERE txn_id IN (SELECT value FROM json_each(?)) GROUP BY txn_id ORDER BY min(hlc), txn_id`,
        [JSON.stringify(txnIds)]
      );
      const decided = new Map<string, Verdict>();
      const counts = { accepted: 0, refused: 0 };
      for (const txn of ordered) {
        const judged = judge(client, ctx, txn.txn_id, decided);
        decided.set(txn.txn_id, judged.verdict ?? 'quarantined');
        if (judged.verdict !== 'accepted' && judged.verdict !== 'refused') continue;
        recordOwnChanges(client, [
          {
            kind: 'verdict',
            entity: TXN_ENTITY,
            entityId: txn.txn_id,
            field: null,
            value: canonicalJson({
              verdict: judged.verdict,
              reason: judged.reason ?? reason,
              epoch: ctx.epoch,
              replica: txn.replica_id,
            }),
          },
        ]);
        counts[judged.verdict] += 1;
      }
      const dependents = judgeUnjudged(client);
      recomputeEntities(
        client,
        mergeContext(client),
        new Set([...ordered.map((txn) => txn.txn_id), ...dependents]),
        new Set()
      );
      return counts;
    })
  );
}
