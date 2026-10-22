// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Re-add restores a person's role and rejudges only transactions quarantined by their removal.
// ABOUTME: Counted verdict position and removal bounds establish provenance; permanent/recovery cuts still hold.
import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { canonicalJson } from './record-capture';
import { recordOwnChanges } from './record-changes';
import { rejudgeTransactions } from './record-decide';
import { carriedSetAsideCuts, setAsideCut } from './record-member-cuts';
import type { MemberView } from './record-membership';
import { mergeContext, termReach, type LoggedChange, type MergeContext } from './record-standing';
import type { RbookToolResult } from './types';

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

interface Candidate {
  readonly txn_id: string;
  readonly replica_id: string;
  readonly last: number;
}

/** The latest counted quarantine must have been authored while this person was actually removed. */
function removalQuarantines(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  member: MemberView
): Candidate[] {
  const replicas = new Set(member.replicas.map((copy) => copy.replicaId));
  const history = ctx.terms.flatMap((term) =>
    rows<LoggedChange>(
      client,
      "SELECT * FROM record_changes WHERE kind = 'member' AND entity_id = ? AND replica_id = ? AND replica_seq <= ? ORDER BY replica_seq",
      [member.memberId, term.replicaId, termReach(ctx, term)]
    ).map((change) => ({ epoch: term.epoch, change }))
  );
  return rows<Candidate>(
    client,
    `SELECT s.txn_id, s.replica_id, max(c.replica_seq) AS last FROM record_txn_state s
      JOIN record_changes c ON c.txn_id = s.txn_id WHERE s.state = 'quarantined'
      GROUP BY s.txn_id, s.replica_id ORDER BY s.txn_id`
  ).filter((txn) => {
    if (!replicas.has(txn.replica_id)) return false;
    const permanent = setAsideCut(ctx, txn.replica_id);
    if (permanent !== undefined && txn.last > permanent) return false;
    const verdicts = rows<LoggedChange>(
      client,
      "SELECT * FROM record_changes WHERE kind = 'verdict' AND entity = 'txn' AND entity_id = ? ORDER BY replica_seq DESC",
      [txn.txn_id]
    );
    for (const term of [...ctx.terms].reverse()) {
      const verdict = verdicts.find(
        (change) =>
          change.replica_id === term.replicaId && change.replica_seq <= termReach(ctx, term)
      );
      if (!verdict) continue;
      const value = JSON.parse(verdict.value ?? '{}') as { verdict?: string; replica?: string };
      if (value.verdict !== 'quarantined' || value.replica !== txn.replica_id) return false;
      const person = [...history]
        .reverse()
        .find(
          (entry) =>
            entry.epoch < term.epoch ||
            (entry.epoch === term.epoch && entry.change.replica_seq < verdict.replica_seq)
        );
      const state = JSON.parse(person?.change.value ?? '{}') as {
        role?: string;
        cuts?: Record<string, number>;
      };
      return state.role === 'removed' && txn.last > (state.cuts?.[txn.replica_id] ?? 0);
    }
    return false;
  });
}

/** Restore only removal cuts; do not use a human-readable cause as a permission to accept work. */
export function readmit(
  client: RbookDatabaseClient,
  member: MemberView,
  role: string
): RbookToolResult<
  MemberView & { readonly invited: boolean; readonly accepted: number; readonly refused: number }
> {
  const before = mergeContext(client);
  const candidates = removalQuarantines(client, before, member);
  const done = client.writeTransaction(() => {
    return recordOwnChanges(client, [
      {
        kind: 'member',
        entity: 'member',
        entityId: member.memberId,
        field: null,
        value: canonicalJson({
          name: member.name,
          role,
          ...carriedSetAsideCuts(before, member.memberId),
        }),
      },
    ]);
  });
  if (!done.success) return createError(done.error!);
  const after = mergeContext(client);
  const eligible = candidates
    .filter((txn) => {
      const cut = after.members.get(txn.replica_id)?.cut;
      return cut === undefined || txn.last <= cut;
    })
    .map((txn) => txn.txn_id);
  const decided = rejudgeTransactions(client, eligible, 're-added');
  if (!decided.success || !decided.data) return createError(decided.error!);
  return createSuccess({ ...member, role, invited: true, ...decided.data });
}
