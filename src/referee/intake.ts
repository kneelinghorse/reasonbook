// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What the referee takes in through apply (s97-m09, design §R1 and §Who may call what): every change checked before
// ABOUTME: any is stored, and the whole delivery refused when one is malformed, newer, forged, owner-only or out of place.

import type { RbookDatabaseClient } from '../tools/rbook/client';
import { PROTOCOL_VERSION } from '../tools/rbook/record-changes';
import {
  changeProblem,
  protocolTooNew,
  readingTime,
  runsAhead,
} from '../tools/rbook/record-intake';
import { RECORD_COLUMNS } from '../tools/rbook/record-columns';
import { NUMBERED } from '../tools/rbook/record-renumber';
import { BASELINE_QUERY } from '../tools/rbook/record-baseline';
import {
  REPLICA_ENTITY,
  type LoggedChange,
  type MergeContext,
} from '../tools/rbook/record-standing';
import { blockRange } from '../tools/rbook/replica-identity';
import type { RbookToolResult } from '../tools/rbook/types';
import { predecessorsOf } from './accounts';
import { REFEREE_ERROR_CODES, refuse } from './codes';

/** The kinds a member never delivers: only the authority writes them (ADR s96 §8, the per-call table). */
export const OWNER_ONLY_INTAKE: ReadonlySet<string> = new Set([
  'baseline',
  'authority',
  'member',
  'replica_joined',
  'verdict',
]);

export interface Delivery {
  readonly changes: readonly LoggedChange[];
  /** The outgoing authority's relay in a handover in: its whole stream, flags honoured (the per-call table). */
  readonly relay: boolean;
}

/** What the referee's store already holds of a delivery, read once before the checks. */
export interface Held {
  /** The changes it holds already: a retried delivery's, which the engine keeps once. */
  readonly changeIds: ReadonlySet<string>;
  /** Each transaction of the delivery it holds already, by the replica that wrote it. */
  readonly txnReplicas: ReadonlyMap<string, string>;
  /** Every block the record ever admitted for a replica: its joins, its term and its own moves. */
  blocksOf(replicaId: string): ReadonlySet<number>;
}

const parsed = (change: LoggedChange): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(change.value ?? 'null') as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const inBlocks = (id: unknown, blocks: ReadonlySet<number>): boolean =>
  typeof id === 'number' &&
  Number.isSafeInteger(id) &&
  [...blocks].some((block) => {
    const range = blockRange(block);
    return id >= range.low && id <= range.high;
  });

/** What the store holds of these changes, for the checks: read under the call's own connection. */
export function heldOf(client: RbookDatabaseClient, changes: readonly LoggedChange[]): Held {
  const ids = JSON.stringify(changes.map((change) => change.change_id));
  const txns = JSON.stringify([...new Set(changes.map((change) => change.txn_id))]);
  const read = <T>(sql: string, params: unknown[]): T[] => {
    const rows = client.getMany<T>(sql, params);
    if (!rows.success) throw new Error(rows.error?.message ?? `could not read: ${sql}`);
    return rows.data ?? [];
  };
  const changeIds = new Set(
    read<{ change_id: string }>(
      'SELECT change_id FROM record_changes WHERE change_id IN (SELECT value FROM json_each(?))',
      [ids]
    ).map((row) => row.change_id)
  );
  const txnReplicas = new Map(
    read<{ txn_id: string; replica_id: string }>(
      'SELECT txn_id, min(replica_id) AS replica_id FROM record_changes WHERE txn_id IN (SELECT value FROM json_each(?)) GROUP BY txn_id',
      [txns]
    ).map((row) => [row.txn_id, row.replica_id])
  );
  const blocks = new Map<string, Set<number>>();
  return {
    changeIds,
    txnReplicas,
    blocksOf(replicaId: string): ReadonlySet<number> {
      const known = blocks.get(replicaId);
      if (known) return known;
      const found = new Set<number>(
        read<{ block: number | null }>(
          `SELECT CAST(json_extract(value, '$.block') AS INTEGER) AS block FROM record_changes
            WHERE entity = ? AND kind IN ('replica_joined', 'authority', 'renumber') AND entity_id = ?`,
          [REPLICA_ENTITY, replicaId]
        )
          .map((row) => row.block)
          .filter((block): block is number => Number.isInteger(block))
      );
      // The baseline's authority holds block 0 from the share, with no admission of its own; the
      // baseline is the one every copy goes by (record-baseline.ts, s97-m10).
      const [baseline] = read<{ replica_id: string }>(BASELINE_QUERY, []);
      if (baseline?.replica_id === replicaId) found.add(0);
      blocks.set(replicaId, found);
      return found;
    },
  };
}

const malformed = (problem: string): RbookToolResult<never> =>
  refuse({
    code: REFEREE_ERROR_CODES.MALFORMED,
    message: `The delivery was refused whole: ${problem}.`,
    suggestion:
      "Sync again with a Reasonbook release; a copy whose log holds changes no release writes gives its member a fresh copy from the dashboard's.",
  });

/**
 * Why the referee refuses a delivery, or null. It checks every change before storing any: its shape,
 * its clock and protocol, never the referee's own replica, one replica per transaction and no new
 * change joining a transaction the referee holds. Outside the outgoing authority's relay it also takes
 * only the caller's own replica and its predecessors, each stream continuing where the referee's copy
 * of it ends, no owner-only kind, each renumber and numbered create inside a block admitted for its
 * replica, and an editor's changes under its own member name.
 */
export function intakeRefusal(
  ctx: MergeContext,
  projectId: string,
  caller: { readonly replicaId: string },
  delivery: Delivery,
  held: Held,
  memberName: (replicaId: string) => string | null = () => null
): RbookToolResult<never> | null {
  const { changes } = delivery;
  // A newer protocol first: a change written in it may use kinds this version does not know, and
  // it stays on its copy, so it is never called malformed (fact 28).
  const newer = protocolTooNew(
    changes.filter(
      (change): change is LoggedChange =>
        Boolean(change) &&
        typeof (change as { protocol_version?: unknown }).protocol_version === 'number'
    )
  );
  if (newer)
    return refuse({
      code: REFEREE_ERROR_CODES.PROTOCOL_NEWER,
      message: `Change ${newer.change_id} is written in record protocol ${newer.protocol_version}, and this referee speaks ${PROTOCOL_VERSION}, so nothing was taken in.`,
      suggestion:
        'Your changes stay safe on your copy. The dashboard upgrades its Reasonbook engine; sync again once it has.',
    });
  for (const change of changes) {
    const problem = changeProblem(change, projectId);
    if (problem) return malformed(problem);
  }
  // A reading far past the referee's own clock waits on its copy, the relay's included: every copy
  // takes the latest reading it receives as its clock, so one near the year 2200 would carry them all
  // past it (critics, round 3).
  const now = Date.now();
  const early = changes.find((change) => runsAhead(change.hlc, now));
  if (early)
    return refuse({
      code: REFEREE_ERROR_CODES.CLOCK_AHEAD,
      message: `Change ${early.change_id} says it was made at ${readingTime(early.hlc)}, more than a week past the referee's clock (${new Date(now).toISOString()}), so nothing was taken in yet.`,
      suggestion:
        "Your changes stay safe on your copy and go up on a later sync, once the referee's clock is within a week of them. If this machine's clock runs ahead, set it right.",
    });
  const own = changes.find((change) => change.replica_id === ctx.ownReplica);
  if (own)
    return refuse({
      code: REFEREE_ERROR_CODES.FORGED_REPLICA,
      message: `Change ${own.change_id} is stamped with the referee's own replica, which no other copy writes, so nothing was taken in.`,
      suggestion:
        "A copy holding such a change holds a forged or restored log: give its member a fresh copy from the dashboard's.",
    });
  // A transaction is one copy's, written once: a change cannot join another's, or one already judged.
  const fresh = changes.filter((change) => !held.changeIds.has(change.change_id));
  const writers = new Map<string, string>();
  for (const change of fresh) {
    const writer = writers.get(change.txn_id) ?? held.txnReplicas.get(change.txn_id);
    if (held.txnReplicas.has(change.txn_id) || (writer && writer !== change.replica_id))
      return refuse({
        code: REFEREE_ERROR_CODES.FORGED_REPLICA,
        message: `Change ${change.change_id} joins transaction ${change.txn_id}, which ${writer && writer !== change.replica_id ? 'another copy wrote' : 'the referee holds already'}, so nothing was taken in.`,
        suggestion:
          "Each transaction is written once by one copy; a copy whose log says otherwise needs a fresh copy from the dashboard's.",
      });
    writers.set(change.txn_id, change.replica_id);
  }
  if (delivery.relay) return null;
  const allowed = new Set([caller.replicaId, ...predecessorsOf(ctx, caller.replicaId)]);
  // Only what the referee does not hold yet is checked: a retried page's duplicates change nothing.
  const foreign = fresh.find((change) => !allowed.has(change.replica_id));
  if (foreign)
    return refuse({
      code: REFEREE_ERROR_CODES.FORGED_REPLICA,
      message: `Change ${foreign.change_id} is stamped with replica ${foreign.replica_id}, which is not the calling copy's, so nothing was taken in.`,
      suggestion:
        "A copy sends only its own changes to the referee; one holding another copy's that the referee lacks needs a fresh copy from the dashboard's.",
    });
  const owned = fresh.find((change) => OWNER_ONLY_INTAKE.has(change.kind));
  if (owned)
    return refuse({
      code: REFEREE_ERROR_CODES.OWNER_ONLY,
      message: `Change ${owned.change_id} is a ${owned.kind}, which only the referee writes, so nothing was taken in or forwarded.`,
      suggestion: 'Membership, moves and verdicts are made on the dashboard, not on a member copy.',
    });
  // Each stream continues where the referee's copy of it ends, with nothing skipped.
  const next = new Map<string, number>();
  for (const change of [...fresh].sort((a, b) => a.replica_seq - b.replica_seq)) {
    const expected = next.get(change.replica_id) ?? ctx.prefixOf(change.replica_id) + 1;
    if (change.replica_seq !== expected)
      return malformed(
        `change ${change.change_id} is replica ${change.replica_id}'s change ${change.replica_seq}, and the referee expected its change ${expected} next`
      );
    next.set(change.replica_id, expected + 1);
  }
  for (const change of fresh) {
    const value = parsed(change);
    const blocks = held.blocksOf(change.replica_id);
    // A row's id is the referee's to give, through a create in an admitted block or its renumber.
    if (change.kind !== 'create' && change.field === 'id' && change.entity in RECORD_COLUMNS)
      return refuse({
        code: REFEREE_ERROR_CODES.FORGED_RENUMBER,
        message: `Change ${change.change_id} sets the id of a ${change.entity} row, which no copy records, so nothing was taken in.`,
        suggestion:
          "A copy's records keep the ids they were made with; one whose log changes an id needs a fresh copy from the dashboard's.",
      });
    // A change cannot say it was made before its copy, or the copy it succeeded, was admitted.
    const ancestry = [change.replica_id, ...predecessorsOf(ctx, change.replica_id)];
    const admitted = ancestry
      .map((replica) => ctx.members.get(replica)?.admittedAt)
      .filter((at): at is string => typeof at === 'string')
      .sort()[0];
    if (admitted && change.hlc < admitted)
      return refuse({
        code: REFEREE_ERROR_CODES.FORGED_REPLICA,
        message: `Change ${change.change_id} says it was made at ${change.hlc}, before its copy was admitted at ${admitted}, so nothing was taken in.`,
        suggestion:
          "A copy's changes are made after it joins; one whose log says otherwise needs a fresh copy from the dashboard's.",
      });
    if (change.kind === 'renumber') {
      const block = value?.block;
      const rows = Array.isArray(value?.rows)
        ? (value.rows as Array<{ id?: unknown; entity?: unknown }>)
        : [];
      if (
        typeof block !== 'number' ||
        !blocks.has(block) ||
        !rows.every(
          (row) => NUMBERED.has(String(row?.entity)) && inBlocks(row?.id, new Set([block]))
        )
      )
        return refuse({
          code: REFEREE_ERROR_CODES.FORGED_RENUMBER,
          message: `Renumber ${change.change_id} names block ${String(block)} or rows outside it, and the referee admitted blocks ${[...blocks].join(', ') || 'none'} for replica ${change.replica_id}, so nothing was taken in.`,
          suggestion:
            "A copy renumbers only into the block the referee admitted for it; one that names another needs a fresh copy from the dashboard's.",
        });
    }
    // A create keeps the id it was written with; one a successor moved over keeps its predecessor's.
    const lineage = new Set(
      [change.replica_id, ...predecessorsOf(ctx, change.replica_id)].flatMap((replica) => [
        ...held.blocksOf(replica),
      ])
    );
    if (change.kind === 'create' && NUMBERED.has(change.entity) && !inBlocks(value?.id, lineage))
      return refuse({
        code: REFEREE_ERROR_CODES.FORGED_RENUMBER,
        message: `Change ${change.change_id} creates ${change.entity} ${String(value?.id)}, outside every block the referee admitted for replica ${change.replica_id}, so nothing was taken in.`,
        suggestion:
          "A copy numbers its new records in its own block; one that numbers them elsewhere needs a fresh copy from the dashboard's.",
      });
    // A member's change names the member who made it. A row's own author is the row's content: an
    // import brings rows in under the authors who wrote them, in creates and in sets alike, so the
    // referee cannot tell a false one from those, and refusing one would hold an honest copy's stream
    // for good (critics, round 3).
    const name = memberName(change.replica_id);
    if (name !== null && change.author_name !== null && change.author_name !== name)
      return refuse({
        code: REFEREE_ERROR_CODES.FORGED_REPLICA,
        message: `Change ${change.change_id} names ${change.author_name} as the member who made it, and its copy is ${name}'s, so nothing was taken in.`,
        suggestion:
          "A member's changes carry the name it was shared under; one that carries another's needs a fresh copy from the dashboard's.",
      });
  }
  return null;
}
