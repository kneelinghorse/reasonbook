// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Retry only stored transactions whose protocol an older authority could not understand.
// ABOUTME: Preserve every other refusal and perform replay plus materialization under the existing write guard and token.
import type { RbookDatabaseClient } from './client';
import { createSuccess } from './errors';
import { attachWarnings } from './format-warnings';
import { canonicalJson } from './record-capture';
import { recordOwnChanges } from './record-changes';
import { judge, type Verdict } from './record-judge';
import { PROTOCOL_VERSION } from './record-protocol';
import {
  authoredInTerm,
  mergeContext,
  TXN_ENTITY,
  verdictOn,
  type MergeContext,
} from './record-standing';
import type { RbookToolResult } from './types';

interface Candidate {
  readonly txn_id: string;
  readonly replica_id: string;
  readonly last: number;
  readonly protocol: number;
}

/** The exact refusal written by 4.1/4.2; no other refused transaction is reopened. */
function protocolRefusal(reason: string | null, protocol: number): boolean {
  const matched = /^protocol (\d+) is newer than this copy's (\d+)$/.exec(reason ?? '');
  return Boolean(
    matched &&
    Number(matched[1]) > Number(matched[2]) &&
    Number(matched[1]) <= PROTOCOL_VERSION &&
    Number(matched[1]) <= protocol
  );
}

function candidates(client: RbookDatabaseClient, ctx: MergeContext): Candidate[] {
  if (ctx.ownReplica !== ctx.authority || PROTOCOL_VERSION < 2) return [];
  const found = client.getMany<Candidate>(
    `SELECT txn_id, replica_id, max(replica_seq) AS last, max(protocol_version) AS protocol
      FROM record_changes WHERE kind NOT IN ('baseline', 'verdict') GROUP BY txn_id
      HAVING max(protocol_version) > 1 AND max(protocol_version) <= ? ORDER BY min(hlc), txn_id`,
    [PROTOCOL_VERSION]
  );
  if (!found.success)
    throw new Error(
      found.error?.message ?? 'Stored protocol upgrade transactions could not be read.'
    );
  return (found.data ?? []).filter((txn) => {
    const term = authoredInTerm(ctx, [{ replica_id: txn.replica_id, replica_seq: txn.last }]);
    // Promotion does not turn a previously judged member transaction into an unjudged own write.
    if (term && !verdictOn(client, ctx, txn.txn_id, term.epoch)) return false;
    const prior = verdictOn(client, ctx, txn.txn_id);
    return !prior || (prior.verdict === 'refused' && protocolRefusal(prior.reason, txn.protocol));
  });
}

/** Caller holds the write transaction and apply token; a newly arrived batch is not included yet. */
export function judgeProtocolUpgrade(client: RbookDatabaseClient): string[] {
  const ctx = mergeContext(client);
  const judged: string[] = [];
  const decided = new Map<string, Verdict>();
  for (const txn of candidates(client, ctx)) {
    const result = judge(client, ctx, txn.txn_id, decided);
    decided.set(txn.txn_id, result.verdict ?? 'quarantined');
    if (!result.verdict) continue;
    recordOwnChanges(client, [
      {
        kind: 'verdict',
        entity: TXN_ENTITY,
        entityId: txn.txn_id,
        field: null,
        value: canonicalJson({ ...result, epoch: ctx.epoch, replica: txn.replica_id }),
      },
    ]);
    judged.push(txn.txn_id);
  }
  return judged;
}

/** Checked writable open only; read calls and unauthenticated/unchecked referee opens never invoke it. */
export async function upgradeProtocolJudge(
  client: RbookDatabaseClient
): Promise<RbookToolResult<{ readonly judged: number }>> {
  if (!candidates(client, mergeContext(client)).length) return createSuccess({ judged: 0 });
  // Use the complete merge path for derived contexts, links, sprint pointers and post-commit embeddings.
  // Its inner replay re-reads candidates after BEGIN IMMEDIATE; this outside read is only a hint.
  const { applyAndEmbed } = await import('./record-apply-embed');
  const applied = await applyAndEmbed(client, []);
  return attachWarnings(applied, applied.data?.notes ?? []);
}
