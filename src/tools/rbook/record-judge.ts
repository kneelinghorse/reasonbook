// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The authority's verdict on a transaction it received (ADR s96 §7, §8): accepted, refused, or quarantined past a
// ABOUTME: cut or for an unseen join; none yet for a dependent of a quarantined create; and judging what none reached.

import type { RbookDatabaseClient } from './client';
import { canonicalJson } from './record-capture';
import { PROTOCOL_VERSION, recordOwnChanges } from './record-changes';
import { PROJECT_ENTITY } from './record-columns';
import {
  authoredInTerm,
  createTxnOf,
  mergeContext,
  OWNER_ONLY_KINDS,
  referencedIds,
  TXN_ENTITY,
  txnStanding,
  verdictOn,
  type LoggedChange,
  type MergeContext,
} from './record-standing';

export type Verdict = 'accepted' | 'refused' | 'quarantined';

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

/**
 * The authority's verdict on a transaction it received (ADR s96 §7): it rests only on membership,
 * role, owner-only kinds, cuts, protocol version and the refused-create cascade, never on data state.
 * A removed member's transaction past its cut is quarantined until a re-add or a refusal decides it.
 * A dependent of a quarantined create gets no verdict while it is: it takes that standing (ADR s96
 * §5), and the decision that later accepts the create, a re-add, judges it then (s96-m13).
 */
export function judge(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  txnId: string,
  /** Verdicts this judging reached already, a wait as quarantined: `ctx` predates them. */
  decided: ReadonlyMap<string, Verdict> = new Map()
): { verdict: Verdict | null; reason: string | null } {
  const changes = rows<LoggedChange>(client, 'SELECT * FROM record_changes WHERE txn_id = ?', [
    txnId,
  ]);
  const replica = changes[0].replica_id;
  const member = ctx.members.get(replica);
  if (!member) {
    // s96-m13 (ADR s96 §8): a join only a former authority recorded past its recovery's cut.
    if (ctx.unseen.has(replica))
      return {
        verdict: 'quarantined',
        reason: 'its copy joined after the cut of the recovery that replaced the owner copy',
      };
    return {
      verdict: 'refused',
      reason: `replica ${replica} is not a member of this shared record`,
    };
  }
  const last = Math.max(...changes.map((change) => change.replica_seq));
  if (member.cut !== undefined && last > member.cut)
    return {
      verdict: 'quarantined',
      reason: `${member.cutReason ?? 'its member was removed'}, and it comes after the cut at change ${member.cut}`,
    };
  // s97-m11 (design §Owner-role authoring): a dashboard's referee accepts the project identity and a
  // lineage settle from an owner-role copy too; every other authority, from its own copy alone.
  const byRole = member.role === 'owner' && refereeStore(client);
  const owned = changes.find(
    (change) =>
      OWNER_ONLY_KINDS.has(change.kind) ||
      (!byRole &&
        (change.entity === PROJECT_ENTITY ||
          (change.kind === 'settle' &&
            change.entity === 'strategic_decisions' &&
            change.field === 'superseded_by')))
  );
  if (owned)
    return {
      verdict: 'refused',
      reason: `only the owner's copy may write a ${owned.kind} of ${owned.entity}`,
    };
  const newer = changes.find((change) => change.protocol_version > PROTOCOL_VERSION);
  if (newer)
    return {
      verdict: 'refused',
      reason: `protocol ${newer.protocol_version} is newer than this copy's ${PROTOCOL_VERSION}`,
    };
  let waits: string | null = null;
  for (const change of changes)
    for (const stable of [
      ...referencedIds(change),
      ...(change.kind !== 'create' && change.entity_id ? [change.entity_id] : []),
    ]) {
      const creator = createTxnOf(client, stable);
      if (!creator || creator === txnId) continue;
      const parent = decided.get(creator) ?? txnStanding(client, ctx, creator).state;
      if (parent === 'refused')
        return { verdict: 'refused', reason: `it depends on ${stable}, whose create was refused` };
      if (parent === 'quarantined')
        waits ??= `it depends on ${stable}, whose create is quarantined`;
    }
  return waits ? { verdict: null, reason: waits } : { verdict: 'accepted', reason: null };
}

/** s97-m11: whether this store is a dashboard's referee, which the referee library alone makes. */
function refereeStore(client: RbookDatabaseClient): boolean {
  const found = client.getOne<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'referee_state'"
  );
  return Boolean(found.success && found.data);
}

/**
 * On the authority: judge every transaction no term authored and no counted verdict has reached,
 * such as those whose verdicts were lost with the old authority, the old copy's writes past a
 * handover that reached this copy before it confirmed (ADR s96 §8), or a dependent that waited on
 * a create a decision has now accepted. Under the caller's token.
 */
export function judgeUnjudged(client: RbookDatabaseClient): string[] {
  const ctx = mergeContext(client);
  if (ctx.ownReplica !== ctx.authority) return [];
  const judged: string[] = [];
  const decided = new Map<string, Verdict>();
  for (const txn of rows<{ txn_id: string; replica_id: string; last: number }>(
    client,
    `SELECT txn_id, replica_id, max(replica_seq) AS last FROM record_changes
      WHERE kind NOT IN ('baseline', 'verdict') GROUP BY txn_id ORDER BY min(hlc), txn_id`
  )) {
    if (authoredInTerm(ctx, [{ replica_id: txn.replica_id, replica_seq: txn.last }])) continue;
    if (verdictOn(client, ctx, txn.txn_id)) continue;
    const { verdict, reason } = judge(client, ctx, txn.txn_id, decided);
    decided.set(txn.txn_id, verdict ?? 'quarantined');
    if (!verdict) continue;
    recordOwnChanges(client, [
      {
        kind: 'verdict',
        entity: TXN_ENTITY,
        entityId: txn.txn_id,
        field: null,
        value: canonicalJson({ verdict, reason, epoch: ctx.epoch, replica: txn.replica_id }),
      },
    ]);
    judged.push(txn.txn_id);
  }
  return judged;
}
