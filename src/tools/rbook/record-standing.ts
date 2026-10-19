// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Each transaction's standing on this copy (ADR s96 §5, §7): live, pending its verdict, held for a gap, a base
// ABOUTME: or a row not yet here, refused or quarantined, and why; and who the authority and the members are.

import { isDashboardRoute } from './record-dashboard-route';
import type { RbookDatabaseClient } from './client';
import { termOf, type AuthorityTerm, type PendingAuthority } from './record-authority';
import {
  IMPORT_BASE,
  PROJECT_ENTITY,
  RECORD_COLUMNS,
  ROOT_HEAD,
  type SharedTable,
} from './record-columns';
import { numberClash } from './record-renumber';
import { REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';

/** One row of `record_changes`, as it travels between copies. */
export interface LoggedChange {
  readonly change_id: string;
  readonly txn_id: string;
  readonly project_id: string;
  readonly replica_id: string;
  readonly replica_seq: number;
  readonly author_name: string | null;
  readonly author_user_id: string | null;
  readonly hlc: string;
  readonly protocol_version: number;
  readonly kind: string;
  readonly entity: string;
  readonly entity_id: string | null;
  readonly field: string | null;
  readonly value: string | null;
  readonly base: string | null;
}

export type StandingState = 'live' | 'pending' | 'held' | 'refused' | 'quarantined';
export interface Standing {
  readonly state: StandingState;
  readonly cause: string | null;
}

/** The kinds only the authority authors (ADR s96 §8); a project identity change is owner-only too. */
export const OWNER_ONLY_KINDS: ReadonlySet<string> = new Set([
  'member',
  'replica_joined',
  'authority',
  'verdict',
]);
/** The entity a verdict names: the transaction it judges. */
export const TXN_ENTITY = 'txn';
/** The entity a membership change names: the replica it admits. */
export const REPLICA_ENTITY = 'replica';

export interface Member {
  readonly replicaId: string;
  readonly block: number;
  readonly role: string;
  /** s96-m13 (ADR s96 §8): a removed member's cut; its changes past this sequence are quarantined. */
  readonly cut?: number;
  /** s96-m13: why its changes past the cut are quarantined. */
  readonly cutReason?: string;
  /** s96-m13: when it was admitted, by the hybrid clock; of two replicas in one block the later renumbers. */
  readonly admittedAt?: string;
  /** s96-m13: the member (person) it is a copy for, and the replica it succeeds after re-identifying. */
  readonly member?: string;
  readonly previous?: string;
}

/** What a recompute needs to know once: this copy, the authority, the members, and each standing so far. */
export interface MergeContext {
  readonly ownReplica: string;
  /** This copy's own block, which it knows before the authority admits it. */
  readonly ownBlock: number;
  readonly authority: string;
  /**
   * How far the authority's stream runs on this copy with no gap. ADR s96 §7 has a copy apply that
   * stream in order, verdicts included, so a verdict counts only inside it; the admission of the
   * member it judges, earlier in the same stream, is then inside it too.
   */
  readonly authorityPrefix: number;
  readonly members: ReadonlyMap<string, Member>;
  readonly standings: Map<string, Standing>;
  /** s96-m13 (ADR s96 §8): the epoch this copy applies, every term up to it, and a move it holds unconfirmed. */
  readonly epoch: number;
  readonly terms: readonly AuthorityTerm[];
  readonly pending: PendingAuthority | null;
  readonly forks: readonly LoggedChange[];
  /** Each term's authority's gap-free prefix on this copy. */
  readonly prefixes: ReadonlyMap<string, number>;
  /**
   * s96-m14: any replica's gap-free prefix on this copy, worked out once per context, so a
   * transaction's gap check costs nothing per transaction however long its replica's stream.
   */
  readonly prefixOf: (replica: string) => number;
  /** Replicas whose only admission a former authority wrote past its recovery cut: unseen joins. */
  readonly unseen: ReadonlyMap<string, Member>;
  /** Blocks two replicas hold, as this copy knows them, until the later-admitted one renumbers. */
  readonly clashedBlocks: ReadonlySet<number>;
}

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

const json = (text: string | null): unknown => (text === null ? null : JSON.parse(text));

// s96-m13: the context is built in record-context.ts, beside the authority chain it reads.
export { authoredInTerm, mergeContext, termReach } from './record-context';
export { BASELINE_QUERY } from './record-baseline';
import { authoredInTerm, mergeContext, termReach } from './record-context';

/**
 * s97-m11 (design §Owner-role authoring): whether this copy writes what only the owner's copy writes,
 * such as the project identity: it is the authority's, or an owner-role copy of a project a dashboard
 * referees (the route it keeps to the authority is a dashboard's), whose referee accepts it by role.
 */
export function writesAsOwner(
  client: RbookDatabaseClient,
  ctx: MergeContext = mergeContext(client)
): boolean {
  if (ctx.ownReplica === ctx.authority) return true;
  if (ctx.members.get(ctx.ownReplica)?.role !== 'owner') return false;
  const peers = client.getOne<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'record_peers'"
  );
  if (!peers.data) return false;
  const row = client.getOne<{ route: string | null }>(
    'SELECT route FROM record_peers WHERE replica_id = ?',
    [ctx.authority]
  );
  try {
    return isDashboardRoute(JSON.parse(row.data?.route ?? 'null'));
  } catch {
    return false;
  }
}

/** ADR s96 §7: a member's copy refuses, before recording it, a change only the authority makes. */
export function refuseUnlessAuthority(client: RbookDatabaseClient, what: string): void {
  const ctx = mergeContext(client);
  if (writesAsOwner(client, ctx)) return;
  throw new ReplicaRefusal({
    code: REPLICA_ERROR_CODES.WRITE_REFUSED,
    message: `Only the owner's copy of a shared record changes ${what}, and this copy is a member's.`,
    suggestion: "Make this change on the owner's copy; it reaches this copy at the next sync.",
  });
}

/** Every stable id a change's value names, as `{ref}`. */
export function referencedIds(change: LoggedChange): string[] {
  const value = json(change.value);
  const found: string[] = [];
  const visit = (item: unknown): void => {
    // A whole captures column is JSON text inside a value, and names rows in its elements.
    if (typeof item === 'string' && item.startsWith('[{')) {
      try {
        visit(JSON.parse(item));
      } catch {
        // Not JSON: plain text names no row.
      }
      return;
    }
    if (!item || typeof item !== 'object') return;
    if (!Array.isArray(item) && typeof (item as { ref?: unknown }).ref === 'string')
      found.push((item as { ref: string }).ref);
    else for (const inner of Object.values(item as Record<string, unknown>)) visit(inner);
  };
  // A create's or set's value, an appended capture, and a link's pair can each name a row.
  if (['create', 'set', 'settle', 'append', 'link', 'unlink'].includes(change.kind)) visit(value);
  return found;
}

/** The stable ids of shared tables, so a reference is found in whichever table holds it. */
function rowPresent(client: RbookDatabaseClient, stableId: string): boolean {
  for (const table of Object.keys(RECORD_COLUMNS) as SharedTable[]) {
    if (RECORD_COLUMNS[table].link) continue;
    if (rows(client, `SELECT 1 FROM ${table} WHERE stable_event_id = ? LIMIT 1`, [stableId]).length)
      return true;
  }
  return false;
}

/** The transaction that created this stable id, if the log holds its create. */
export function createTxnOf(client: RbookDatabaseClient, stableId: string): string | null {
  const [create] = rows<{ txn_id: string }>(
    client,
    "SELECT txn_id FROM record_changes WHERE kind = 'create' AND entity_id = ? LIMIT 1",
    [stableId]
  );
  return create?.txn_id ?? null;
}

/** Why a transaction cannot be applied yet, or null: a gap before it, a base or a row not here. */
function heldBecause(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  changes: readonly LoggedChange[]
): string | null {
  const replica = changes[0].replica_id;
  const last = Math.max(...changes.map((change) => change.replica_seq));
  // A replica's sequences are unique and start at 1, so every earlier one is here exactly when the
  // last falls within its gap-free prefix. Past it, the count says how many are missing, and decides,
  // as it always did, should a context outlive the write that filled the gap.
  if (last > ctx.prefixOf(replica)) {
    const [{ n }] = rows<{ n: number }>(
      client,
      'SELECT count(*) AS n FROM record_changes WHERE replica_id = ? AND replica_seq <= ?',
      [replica, last]
    );
    if (n < last) return `waits for ${last - n} earlier change(s) from replica ${replica}`;
  }
  const own = new Set(changes.map((change) => change.change_id));
  const created = new Set(
    changes.filter((change) => change.kind === 'create').map((change) => change.entity_id)
  );
  for (const change of changes) {
    for (const base of (json(change.base) as string[] | null) ?? [])
      if (
        base !== IMPORT_BASE &&
        base !== ROOT_HEAD &&
        !own.has(base) &&
        !rows(client, 'SELECT 1 FROM record_changes WHERE change_id = ?', [base]).length
      )
        return `waits for change ${base}, which its ${change.field ?? change.kind} names as seen`;
    const needs = [...referencedIds(change)];
    const targets =
      change.entity !== PROJECT_ENTITY &&
      change.entity in RECORD_COLUMNS &&
      !RECORD_COLUMNS[change.entity as SharedTable].link &&
      change.kind !== 'create' &&
      change.entity_id
        ? [change.entity_id]
        : [];
    for (const stable of [...needs, ...targets])
      if (!created.has(stable) && !createTxnOf(client, stable) && !rowPresent(client, stable))
        return `waits for the row ${stable}, which it names`;
  }
  return null;
}

/**
 * The latest counted verdict on a transaction, and the replica it judged (ADR s96 §7, §8). A verdict
 * counts when a term's authority wrote it inside that term's reach on this copy; the latest term's
 * wins, and within a term the latest. `before` counts only the terms before that epoch.
 */
export function verdictOn(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  txnId: string,
  before = Infinity
): { verdict: string; reason: string | null; replica: string | null } | null {
  let best: { epoch: number; change: LoggedChange } | null = null;
  for (const change of rows<LoggedChange>(
    client,
    "SELECT * FROM record_changes WHERE kind = 'verdict' AND entity = ? AND entity_id = ? ORDER BY replica_seq DESC",
    [TXN_ENTITY, txnId]
  )) {
    const term = termOf(ctx.terms, change.replica_id);
    if (!term || term.epoch >= before || change.replica_seq > termReach(ctx, term)) continue;
    if (!best || term.epoch > best.epoch) best = { epoch: term.epoch, change };
  }
  if (!best) return null;
  const value = json(best.change.value) as { verdict: string; reason?: string; replica?: string };
  return { verdict: value.verdict, reason: value.reason ?? null, replica: value.replica ?? null };
}

/**
 * A transaction's standing (ADR s96 §5, §7). Held first, as a whole: a gap before it, or a base or a
 * row it names not here, or named by a create that is not live yet. A dependent of a refused or
 * quarantined create inherits that standing, unless the authority judged it directly. Then the
 * verdict: without one, this copy's own writes and the authority's are live, and another copy's wait.
 */
export function txnStanding(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  txnId: string
): Standing {
  const known = ctx.standings.get(txnId);
  if (known) return known;
  // A transaction under evaluation is taken as live by its own dependents, which cannot cycle.
  ctx.standings.set(txnId, { state: 'live', cause: null });
  const standing = evaluate(client, ctx, txnId);
  ctx.standings.set(txnId, standing);
  return standing;
}

/** The stable ids a transaction needs from other transactions: those it names or writes to. */
function needs(changes: readonly LoggedChange[]): string[] {
  const created = new Set(
    changes.filter((change) => change.kind === 'create').map((change) => change.entity_id)
  );
  const named = new Set<string>();
  for (const change of changes) {
    for (const stable of referencedIds(change)) named.add(stable);
    if (
      change.kind !== 'create' &&
      change.entity_id &&
      change.entity in RECORD_COLUMNS &&
      !RECORD_COLUMNS[change.entity as SharedTable].link
    )
      named.add(change.entity_id);
  }
  return [...named].filter((stable) => !created.has(stable));
}

function evaluate(client: RbookDatabaseClient, ctx: MergeContext, txnId: string): Standing {
  const changes = rows<LoggedChange>(
    client,
    'SELECT * FROM record_changes WHERE txn_id = ? ORDER BY replica_seq',
    [txnId]
  );
  if (!changes.length) {
    // ADR s96 §7: a refused non-member's data is never forwarded, so its verdict arrives alone.
    const verdict = verdictOn(client, ctx, txnId);
    if (verdict?.verdict === 'refused' || verdict?.verdict === 'quarantined')
      return {
        state: verdict.verdict,
        cause: verdict.reason ?? `the authority's ${verdict.verdict} verdict`,
      };
    return { state: 'held', cause: 'not here yet' };
  }
  const held = heldBecause(client, ctx, changes);
  if (held) return { state: 'held', cause: held };
  const replica = changes[0].replica_id;
  // ADR s96 §8: until this copy confirms a move it holds, the new authority's stream and the old
  // one's writes past the move's cut wait. This copy's own writes stay live here, and so does what
  // the new authority wrote as a member that a term this copy applies has judged already.
  if (ctx.pending && replica !== ctx.ownReplica) {
    const last = Math.max(...changes.map((change) => change.replica_seq));
    if (
      (replica === ctx.pending.value.authority && !verdictOn(client, ctx, txnId)) ||
      (replica === ctx.authority && last > ctx.pending.cut)
    )
      return {
        state: 'held',
        cause: "waits for this copy to confirm the owner's copy that a move names",
      };
  }
  // ADR s96 §7: in a block two replicas hold, the later one's create of an id the other's claims
  // waits for the renumber that moves it.
  const clash = numberClash(client, ctx, changes);
  if (clash) return { state: 'held', cause: clash };
  // A term's authority's own write is live by authorship; only an earlier term's verdict judged it.
  const term = authoredInTerm(ctx, changes);
  const verdict = verdictOn(client, ctx, txnId, term ? term.epoch : Infinity);
  for (const stable of needs(changes)) {
    const creator = createTxnOf(client, stable);
    if (!creator) continue;
    const parent = txnStanding(client, ctx, creator);
    if (parent.state === 'pending' || parent.state === 'held')
      return { state: 'held', cause: `waits for ${stable}, whose create is ${parent.state}` };
    if ((parent.state === 'refused' || parent.state === 'quarantined') && !verdict)
      return {
        state: parent.state,
        cause: `depends on ${stable}, whose create is ${parent.state}`,
      };
    // A verdict that accepted it stands, but its row cannot name one that is not written: it waits
    // for its create, as when the authority judged it before that create reached it.
    if (
      (parent.state === 'refused' || parent.state === 'quarantined') &&
      verdict?.verdict === 'accepted'
    )
      return { state: 'held', cause: `waits for ${stable}, whose create is ${parent.state}` };
  }
  if (term && verdict?.verdict !== 'refused' && verdict?.verdict !== 'quarantined')
    return { state: 'live', cause: null };
  if (verdict?.verdict === 'accepted') return { state: 'live', cause: null };
  if (verdict?.verdict === 'refused' || verdict?.verdict === 'quarantined')
    return {
      state: verdict.verdict,
      cause: verdict.reason ?? `the authority's ${verdict.verdict} verdict`,
    };
  if (replica === ctx.ownReplica) return { state: 'live', cause: null };
  return { state: 'pending', cause: "waits for the authority's verdict" };
}
