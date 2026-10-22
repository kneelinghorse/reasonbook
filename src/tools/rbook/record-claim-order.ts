// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Order text-id claims by their first counted acceptance without renaming claims established before S.
// ABOUTME: Held accepted claims retain their place; local provisional claims wait behind every accepted position.
import type { RbookDatabaseClient } from './client';
import { authoredInTerm, termReach } from './record-context';
import { countedVerdicts } from './record-positions';
import { protocolSwitch } from './record-protocol-state';
import { txnStanding, type LoggedChange, type MergeContext } from './record-standing';

type Key = readonly [number, number | string, number | string, string];
const clockOrder = (a: LoggedChange, b: LoggedChange): number =>
  a.hlc === b.hlc ? (a.change_id < b.change_id ? -1 : 1) : a.hlc < b.hlc ? -1 : 1;

/** Only a term write no verdict judged may take its own authority-stream position. */
function authoredPosition(client: RbookDatabaseClient, ctx: MergeContext, create: LoggedChange) {
  const found = client.getMany<LoggedChange>('SELECT * FROM record_changes WHERE txn_id = ?', [
    create.txn_id,
  ]);
  if (!found.success)
    throw new Error(found.error?.message ?? 'The claim transaction could not be read.');
  const changes = found.data ?? [];
  if (!changes.length) return null;
  const term = authoredInTerm(ctx, changes);
  if (!term || changes.some((change) => change.replica_seq > termReach(ctx, term))) return null;
  return { epoch: term.epoch, seq: create.replica_seq };
}

/** The existing clock rule applies until this copy derives S from the counted authority log. */
export function orderedClaims(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  claims: readonly LoggedChange[]
): LoggedChange[] {
  const switched = protocolSwitch(client, ctx);
  if (!switched)
    return claims
      .filter((claim) => txnStanding(client, ctx, claim.txn_id).state === 'live')
      .sort(clockOrder);
  const ranked: Array<{ change: LoggedChange; key: Key }> = [];
  for (const create of claims) {
    const state = txnStanding(client, ctx, create.txn_id).state;
    if (state === 'refused' || state === 'quarantined') continue;
    const verdicts = countedVerdicts(client, ctx, create.txn_id);
    const latest = verdicts[verdicts.length - 1];
    if (latest && latest.verdict !== 'accepted') continue;
    const first = verdicts.find((verdict) => verdict.verdict === 'accepted');
    const position = first ?? (!verdicts.length ? authoredPosition(client, ctx, create) : null);
    let key: Key;
    if (position) {
      const before =
        position.epoch < switched.epoch ||
        (position.epoch === switched.epoch && position.seq < switched.seq);
      key = before
        ? [0, create.hlc, create.change_id, create.change_id]
        : [1, position.epoch, position.seq, create.change_id];
    } else {
      if (state !== 'live' || create.replica_id !== ctx.ownReplica) continue;
      key = [2, create.hlc, create.change_id, create.change_id];
    }
    ranked.push({ change: create, key });
  }
  ranked.sort((a, b) => {
    for (let index = 0; index < a.key.length; index++) {
      if (a.key[index] === b.key[index]) continue;
      return a.key[index] < b.key[index] ? -1 : 1;
    }
    return 0;
  });
  return ranked.map((item) => item.change);
}
