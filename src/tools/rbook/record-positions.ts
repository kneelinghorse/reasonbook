// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read verdict positions that count inside the applied authority terms and their gap-free cuts.
// ABOUTME: Share that ordering between standing, claim arrival and protocol-switch derivation without writing state.
import type { RbookDatabaseClient } from './client';
import { termOf } from './record-authority';
import { termReach } from './record-context';
import type { LoggedChange, MergeContext } from './record-standing';

export interface CountedVerdict {
  readonly epoch: number;
  readonly seq: number;
  readonly change: LoggedChange;
  readonly verdict: string;
  readonly reason: string | null;
  readonly replica: string | null;
}

/** Counted verdicts in authority arrival order; `before` excludes that epoch and every later one. */
export function countedVerdicts(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  txnId: string,
  before = Infinity
): readonly CountedVerdict[] {
  const found = client.getMany<LoggedChange>(
    "SELECT * FROM record_changes WHERE kind = 'verdict' AND entity = 'txn' AND entity_id = ?",
    [txnId]
  );
  if (!found.success)
    throw new Error(found.error?.message ?? 'The counted verdict positions could not be read.');
  const counted: CountedVerdict[] = [];
  for (const change of found.data ?? []) {
    const term = termOf(ctx.terms, change.replica_id);
    if (!term || term.epoch >= before || change.replica_seq > termReach(ctx, term)) continue;
    const value = JSON.parse(change.value ?? 'null') as {
      verdict: string;
      reason?: string;
      replica?: string;
    };
    counted.push({
      epoch: term.epoch,
      seq: change.replica_seq,
      change,
      verdict: value.verdict,
      reason: value.reason ?? null,
      replica: value.replica ?? null,
    });
  }
  return counted.sort((a, b) => a.epoch - b.epoch || a.seq - b.seq);
}
