// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Applies another copy's changes (ADR s96 §5, §7): stores them once, has the authority judge each transaction
// ABOUTME: it receives, and recomputes every entity whose changes or standing moved, under the merge's token.

import { monotonicFactory } from 'ulid';
import { breaksNameRule } from './author-name';
import type { RbookDatabaseClient } from './client';
import { createError } from './errors';
import { canonicalJson, keepRoot } from './record-capture';
import { advanceClock, recordOwnChanges } from './record-changes';
import { PROJECT_ENTITY, RECORD_COLUMNS, type SharedTable } from './record-columns';
import { APPLY_TOKEN_TABLE, beginMerging, endMerging, isRecordedStore } from './record-guards';
import { currentEncoded } from './record-materialize';
import { crossRecordFindings } from './record-checks';
import { foldPeerSessions, repairMergedLinks, trackMergedSprints } from './record-derived';
import { recomputeEntities } from './record-recompute';
import { mergeRefusal } from './record-token';
import { judge, type Verdict } from './record-judge';
import { keptOut, noteNewerProtocol } from './record-protocol-hold';
import {
  authoredInTerm,
  mergeContext,
  termReach,
  TXN_ENTITY,
  type LoggedChange,
} from './record-standing';
import { recordedProjectId, REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';
import type { RbookToolResult } from './types';

const mintId = monotonicFactory();

export interface ApplyReport {
  readonly stored: number;
  readonly duplicates: number;
  /** Verdicts this copy recorded, as the authority, on the transactions it received. */
  readonly judged: number;
  readonly recomputed: number;
  readonly held: number;
  readonly conflicts: number;
  /** States the cross-record checks find after the merge, for a person to settle (ADR s96 §5). */
  readonly checks: number;
  /** Sessions other copies closed that this copy's resume note and working memory now name. */
  readonly folded: number;
  /**
   * Transactions that became live in this merge, stored now or released from a hold. The sync
   * (s96-m13) embeds the rows their changes name, after the commit (embedMergedRows).
   */
  readonly newlyLive: readonly string[];
  /** What the merge could not do to this copy's own derived context, said rather than hidden. */
  readonly notes: readonly string[];
  /**
   * s100-m01 (settled item 6): changes kept out because one of their replica's stream is written in a
   * newer record protocol: that change and the rest of the stream from its transaction on. They stay
   * on the copy that sent them and are asked for again at every exchange, until this copy upgrades.
   */
  readonly newerProtocol: number;
}

const LOGGED_COLUMNS = [
  'change_id',
  'txn_id',
  'project_id',
  'replica_id',
  'replica_seq',
  'author_name',
  'author_user_id',
  'hlc',
  'protocol_version',
  'kind',
  'entity',
  'entity_id',
  'field',
  'value',
  'base',
] as const;

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): void {
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

/** Per replica, the highest sequence this copy holds with none missing before it. */
export function replicaMarks(client: RbookDatabaseClient): Record<string, number> {
  const marks: Record<string, number> = {};
  for (const { replica_id, replica_seq } of rows<{ replica_id: string; replica_seq: number }>(
    client,
    'SELECT replica_id, replica_seq FROM record_changes ORDER BY replica_id, replica_seq'
  ))
    if (replica_seq === (marks[replica_id] ?? 0) + 1) marks[replica_id] = replica_seq;
  return marks;
}

// s96-m13: in its own module, so a read of peer health loads none of the merge.
export { changesSince } from './record-since';

const txnReplica = (changes: readonly LoggedChange[], txnId: string): string | null =>
  changes.find((change) => change.txn_id === txnId)?.replica_id ?? null;

/** A row the baseline holds has no create in the log; its fields keep their roots at a first change. */
function keepRemoteRoot(client: RbookDatabaseClient, change: LoggedChange): void {
  if (!change.entity_id || !change.field) return;
  if (change.kind !== 'set' && change.kind !== 'append' && change.kind !== 'settle') return;
  if (change.entity !== PROJECT_ENTITY && RECORD_COLUMNS[change.entity as SharedTable]?.link)
    return;
  const earlier = rows(
    client,
    "SELECT 1 FROM record_changes WHERE entity = ? AND entity_id = ? AND (field = ? OR kind = 'create') LIMIT 1",
    [change.entity, change.entity_id, change.field]
  );
  if (!earlier.length)
    keepRoot(
      client,
      change.entity,
      change.entity_id,
      change.field,
      currentEncoded(client, change.entity, change.entity_id, change.field)
    );
}

/** Store each change once; a slot that holds a different change stops the exchange (ADR §7). */
function store(
  client: RbookDatabaseClient,
  incoming: readonly LoggedChange[]
): { stored: LoggedChange[]; duplicates: number; newer: LoggedChange[] } {
  const stored: LoggedChange[] = [];
  let duplicates = 0;
  // ADR s96 §2: one record is one project; a change of another project's record is never merged.
  const projectId = recordedProjectId(client);
  const foreign = incoming.find((change) => change.project_id !== projectId);
  if (foreign)
    throw new ReplicaRefusal({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `What arrived holds changes of project ${foreign.project_id}, and this copy's record is project ${projectId}, so nothing was applied.`,
      suggestion: 'Sync each copy only with copies of its own project.',
    });
  // s100-m01: what this copy keeps out is not held to this version's rules, which a later
  // protocol's may change, so the name rule reads only what it takes in.
  const { taken, held } = keptOut(incoming);
  const misnamed = taken.find(breaksNameRule);
  if (misnamed)
    throw new ReplicaRefusal({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `What arrived holds a change from copy ${misnamed.replica_id} whose author name no copy of Reasonbook records, so nothing was applied.`,
      suggestion:
        "That copy's record was written outside Reasonbook: leave it out of syncs, and give its member a new copy from the owner's.",
    });
  const sorted = [...taken].sort((a, b) =>
    a.replica_id === b.replica_id
      ? a.replica_seq - b.replica_seq
      : a.replica_id < b.replica_id
        ? -1
        : 1
  );
  for (const change of sorted) {
    if (
      rows(client, 'SELECT 1 FROM record_changes WHERE change_id = ?', [change.change_id]).length
    ) {
      duplicates += 1;
      continue;
    }
    const [slot] = rows<{ change_id: string }>(
      client,
      'SELECT change_id FROM record_changes WHERE replica_id = ? AND replica_seq = ?',
      [change.replica_id, change.replica_seq]
    );
    if (slot)
      throw new ReplicaRefusal({
        code: REPLICA_ERROR_CODES.SLOT_CLASH,
        message: `Replica ${change.replica_id}'s change ${change.replica_seq} is ${slot.change_id} here and ${change.change_id} in what arrived, so this exchange stops.`,
        suggestion:
          'The copy that wrote the second one re-identifies into a fresh block and renumbers its own changes.',
      });
    keepRemoteRoot(client, change);
    run(
      client,
      `INSERT INTO record_changes (${LOGGED_COLUMNS.join(', ')}) VALUES (${LOGGED_COLUMNS.map(() => '?').join(', ')})`,
      LOGGED_COLUMNS.map((column) => change[column])
    );
    stored.push(change);
  }
  return { stored, duplicates, newer: held };
}

/**
 * Apply changes from another copy. Each is stored once; on the authority each new transaction from
 * a member is judged, its verdict recorded in the authority's own stream; then every entity whose
 * changes or standing moved is recomputed and written, under the merge's token.
 */
export function applyRemote(
  client: RbookDatabaseClient,
  incoming: readonly LoggedChange[],
  options: { readonly judge?: boolean; readonly catchUp?: boolean } = {}
): RbookToolResult<ApplyReport> {
  if (!isRecordedStore(client))
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: 'Only a copy of a shared record applies changes from another copy.',
      suggestion: 'Share the project, or join it, before syncing.',
    });
  const applied = client.writeTransaction(() => {
    // s96-m13: the write check judges this copy before the merge's token is down, or it would read
    // the token as one a crashed writer left; a copy it refuses takes in nothing but a catch-up
    // (record-token.ts).
    const refused = mergeRefusal(client, options.catchUp === true);
    if (refused) throw new ReplicaRefusal(refused);
    run(client, `INSERT INTO ${APPLY_TOKEN_TABLE} (txn_id) VALUES (?)`, [mintId()]);
    beginMerging(client);
    try {
      client.pragma('defer_foreign_keys = ON');
      const prefixBefore = mergeContext(client).prefixes;
      const { stored, duplicates, newer } = store(client, incoming);
      const latest = stored
        .map((change) => change.hlc)
        .sort()
        .slice(-1)[0];
      if (latest) advanceClock(client, latest);
      let ctx = mergeContext(client);
      const judged: string[] = [];
      // A catch-up between epochs only stores and recomputes (ADR s96 §8): this copy may not be the
      // authority of the stream it is taking in.
      if (ctx.ownReplica === ctx.authority && options.judge !== false) {
        const epoch = ctx.epoch;
        // A term's authority's own writes are live by authorship, so they are never judged.
        const byTxn = new Map<string, LoggedChange[]>();
        for (const change of stored)
          byTxn.set(change.txn_id, [...(byTxn.get(change.txn_id) ?? []), change]);
        // In clock order, so a create is judged before what was written against it (ADR s96 §5).
        const decided = new Map<string, Verdict>();
        const firstHlc = (txn: string) =>
          byTxn.get(txn)!.reduce((low, change) => (change.hlc < low ? change.hlc : low), '\uffff');
        for (const txnId of [...byTxn.keys()]
          .filter((txn) => !authoredInTerm(ctx, byTxn.get(txn)!))
          .sort((a, b) => (firstHlc(a) < firstHlc(b) ? -1 : firstHlc(a) > firstHlc(b) ? 1 : 0))) {
          const { verdict, reason } = judge(client, ctx, txnId, decided);
          decided.set(txnId, verdict ?? 'quarantined');
          // A dependent of a quarantined create waits, unjudged, and takes that standing (ADR s96 §5).
          if (!verdict) continue;
          recordOwnChanges(client, [
            {
              kind: 'verdict',
              entity: TXN_ENTITY,
              entityId: txnId,
              field: null,
              value: canonicalJson({ verdict, reason, epoch, replica: txnReplica(stored, txnId) }),
            },
          ]);
          judged.push(txnId);
        }
        ctx = mergeContext(client);
      }
      const touched = new Set<string>(stored.map((change) => change.txn_id));
      for (const change of stored)
        if (change.kind === 'verdict' && change.entity_id) touched.add(change.entity_id);
      for (const txnId of judged) touched.add(txnId);
      // A verdict stored past a gap in a term's stream counts once the gap fills (ADR §7), so the
      // merge that fills it touches what it judges, this copy's own writes held as live included.
      for (const term of ctx.terms)
        for (const verdict of rows<{ entity_id: string }>(
          client,
          "SELECT entity_id FROM record_changes WHERE kind = 'verdict' AND replica_id = ? AND replica_seq > ? AND replica_seq <= ?",
          [term.replicaId, prefixBefore.get(term.replicaId) ?? 0, termReach(ctx, term)]
        ))
          touched.add(verdict.entity_id);
      const waitingBefore = waitingTxns(client);
      const outcome = recomputeEntities(
        client,
        ctx,
        touched,
        new Set(stored.map((change) => change.txn_id))
      );
      // A transaction that became live in this merge, stored now or released from a hold, reaches
      // this copy's derived data whichever delivery releases it.
      const waitingAfter = waitingTxns(client);
      const newlyLive = [...new Set([...stored.map((c) => c.txn_id), ...waitingBefore])].filter(
        (txnId) => !waitingAfter.has(txnId)
      );
      const live = rows<LoggedChange>(
        client,
        'SELECT * FROM record_changes WHERE txn_id IN (SELECT value FROM json_each(?)) ORDER BY replica_id, replica_seq',
        [JSON.stringify(newlyLive)]
      );
      // ADR s96 §5: this copy's resume note and working memory take in the sessions others closed.
      // They are this copy's own, so a context it cannot read is said, never a reason to refuse.
      const derived = foldPeerSessions(client, live);
      const links = repairMergedLinks(client, live);
      const tracking = trackMergedSprints(client, live);
      return {
        stored: stored.length,
        duplicates,
        judged: judged.length,
        recomputed: outcome.entities,
        held: outcome.held,
        conflicts: outcome.conflicts,
        checks: crossRecordFindings(client).length,
        folded: derived.folded.length,
        newlyLive,
        notes: [
          ...derived.failures.map((failure) => `${failure.op}: ${failure.message}`),
          ...links,
          ...tracking,
        ],
        newerProtocol: newer.length,
      };
    } finally {
      endMerging(client);
      run(client, `DELETE FROM ${APPLY_TOKEN_TABLE}`);
    }
  });
  // s100-m01: what it kept out is kept in mind too, so the review says it until this copy upgrades;
  // the copy that started the exchange words it for whichever side kept it out (record-exchange.ts).
  if (!applied.success || !applied.data) return applied;
  if (applied.data.newerProtocol)
    noteNewerProtocol(client, Math.max(...incoming.map((change) => change.protocol_version)));
  return applied;
}

// s96-m13: the authority's own decisions live in record-decide.ts.
export { admitMember, decideTransactions } from './record-decide';

const waitingTxns = (client: RbookDatabaseClient): Set<string> =>
  new Set(
    rows<{ txn_id: string }>(client, 'SELECT txn_id FROM record_txn_state').map((row) => row.txn_id)
  );
