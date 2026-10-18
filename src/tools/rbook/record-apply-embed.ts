// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A delivery's rows embedded once its merge commits (ADR s96 §5; s96-m13): the decisions, learnings and missions
// ABOUTME: it made live are embedded after the transaction, and the embedding's warnings ride the answer.

import type { RbookDatabaseClient } from './client';
import { attachWarnings } from './format-warnings';
import { applyRemote, type ApplyReport } from './record-apply';
import { embedMergedRows } from './record-derived';
import type { LoggedChange } from './record-standing';
import type { RbookToolResult } from './types';

/** Embed the rows the transactions that became live name, after their merge committed. */
export async function embedLive(
  client: RbookDatabaseClient,
  txnIds: readonly string[]
): Promise<{ readonly embedded: number; readonly warnings: string[] }> {
  if (!txnIds.length) return { embedded: 0, warnings: [] };
  const read = client.getMany<LoggedChange>(
    'SELECT * FROM record_changes WHERE txn_id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(txnIds)]
  );
  if (!read.success)
    return {
      embedded: 0,
      warnings: [`the merged rows were not embedded: ${read.error?.message ?? 'unread'}`],
    };
  return embedMergedRows(client, read.data ?? []);
}

/**
 * Apply another copy's changes, then embed what became live once the merge committed. A failed
 * embedding never undoes the merge; it is a warning on the answer.
 */
export async function applyAndEmbed(
  client: RbookDatabaseClient,
  changes: readonly LoggedChange[],
  options: { readonly judge?: boolean; readonly catchUp?: boolean } = {}
): Promise<RbookToolResult<ApplyReport>> {
  const warnings: string[] = [];
  const result = await (async (): Promise<RbookToolResult<ApplyReport>> => {
    const applied = applyRemote(client, changes, options);
    if (!applied.success || !applied.data) return applied;
    const embedded = await embedLive(client, applied.data.newlyLive);
    warnings.push(...embedded.warnings);
    return applied;
  })();
  return attachWarnings(result, warnings);
}
