// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What the review says about a shared record (s96-m12, design item 6): its fields in conflict, the states the
// ABOUTME: checks find, the changes not live with their causes, and who started each mission in progress.

import type { RbookDatabaseClient } from './client';
import { newerProtocolHeld, UPGRADE_COMMAND } from './record-protocol-hold';
import { knownBlocks } from './record-chain';
import { crossRecordFindings } from './record-checks';
import { isRecordedStore } from './record-guards';
import { clientQuery } from './record-conflict-marks';
import { peerHealth, peerMarks, syncsWith, visiblePeerRoutes } from './record-peers';
import { predecessorsOf } from './record-lineage';
import { authorityValue } from './record-authority';
import { changesSince } from './record-since';
import { dashboardName, isActiveDashboardRoute, isDashboardRoute } from './record-dashboard-route';
import { dashboardRecoveryState } from './record-dashboard-recovery';
import { openConflicts } from './record-settle';
import { mergeContext, type StandingState } from './record-standing';
import { COPY_KEYS } from './replica-copy-keys';
import { protocolReview, type RecordProtocolReview } from './record-protocol-review';

export interface SharedRecordReview {
  /** Informational write protocol and complete named blockers, never conflict states. */
  readonly protocol?: RecordProtocolReview;
  /** Each field in conflict, as "missions s96-m12's objective (2 values)". */
  readonly conflicts: readonly string[];
  /** What the cross-record checks find. */
  readonly states: readonly string[];
  /** Transactions that are not live, by standing, each with what to do and its first cause. */
  readonly waiting: readonly string[];
  /** How many transactions are not live. */
  readonly waitingTotal: number;
  /** Structured causes survive compact rendering without parsing the human-readable waiting lines. */
  readonly waitingCounts?: Readonly<Partial<Record<Exclude<StandingState, 'live'>, number>>>;
  /** Each mission in progress, and who started it. */
  readonly started: readonly string[];
  /** s96-m13: each copy this one syncs with: its last exchange, what it lacks, and its last error. */
  readonly peers?: readonly string[];
  /** s96-m13: how many of those copies' last exchange failed. */
  readonly syncErrors?: number;
  /**
   * s96-m13 (ADR s96 §8, §9): a move of the owner copy this copy holds unconfirmed, moves that
   * conflict with the one it follows, and what this copy said when it last took a new identity.
   */
  readonly moves?: readonly string[];
  /** A move of the owner copy waits for this copy's confirmation. */
  readonly movePending?: boolean;
  /** Failed held-recovery conditions must survive the compact review beside its confirmation remedy. */
  readonly recoveryConditions?: readonly string[];
  /** s97-m14: a copy this one syncs with says this copy's member was removed (ADR s96 §8). */
  readonly removed?: boolean;
  /** s100-m01: what this copy keeps out until it upgrades, written in a newer record protocol. */
  readonly upgrade?: string;
}

/** How long ago a time was, as a person says it. */
function ago(iso: string, nowMs: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * Each copy this copy syncs with, said as the review shows it (design §s96-m13 item 5): a former
 * owner copy's rows for the members, which it syncs with no more, are not shown.
 */
function peerLines(client: RbookDatabaseClient): {
  lines: string[];
  errors: number;
  removed: boolean;
} {
  const ctx = mergeContext(client);
  const blocks = knownBlocks(client);
  const health = visiblePeerRoutes(
    peerHealth(client).filter(
      (peer) => syncsWith(ctx, peer.replicaId) || isDashboardRoute(peer.route)
    )
  );
  return {
    lines: health.map((peer) => {
      const own = new Set([ctx.ownReplica, ...predecessorsOf(ctx, ctx.ownReplica)]);
      const marks = peerMarks(client, peer.replicaId);
      const handover = ctx.terms.find(
        (term) =>
          term.replicaId === peer.replicaId &&
          term.change?.replica_id === ctx.ownReplica &&
          authorityValue(term.change).move === 'handover'
      )?.change;
      // Review has only last-observed marks, not the peer's current hello. Until those marks
      // cover our outgoing move, foreign rows may still travel in its handover relay.
      const mayRelay =
        isActiveDashboardRoute(peer.route) &&
        handover !== null &&
        handover !== undefined &&
        (marks[ctx.ownReplica] ?? 0) < handover.replica_seq;
      const foreign =
        isActiveDashboardRoute(peer.route) && ctx.ownReplica !== ctx.authority
          ? changesSince(client, marks).filter((change) => !own.has(change.replica_id)).length
          : 0;
      // s100-m01: a removed copy whose route ended keeps the name it reached that copy by, such as
      // a dashboard that has since archived its referee copy (critics, round 2).
      const who = isDashboardRoute(peer.route)
        ? dashboardName(peer.route)
        : !peer.route && peer.removedAt && peer.name
          ? peer.name
          : peer.replicaId === ctx.authority
            ? "the owner's copy"
            : peer.name
              ? `${peer.name}'s copy`
              : `the copy in block ${blocks[peer.replicaId] ?? '?'}`;
      const last = peer.lastOkAt ? `synced ${ago(peer.lastOkAt)}` : 'never synced';
      // s97-m14 (ADR s96 §8): a removal stays in the review until a sync says otherwise. It leads,
      // so a long error never cuts it from the digest's line (critics, round 1).
      const removed = peer.removedAt
        ? `said this copy's member was removed (first said ${ago(peer.removedAt)}): what this copy sends is set aside, and counts only if the owner shares the project with it again; `
        : '';
      if (isDashboardRoute(peer.route) && peer.route.ended)
        return `${who}: ${removed}route ended; kept for an explicit reasonbook sync or join --dashboard if the same project is shared again; ${peer.pending} changes stay on this copy.`;
      // s97-m10: a sync that keeps failing says since when, and how many tries.
      const failing =
        peer.failures > 0 && peer.failingSince
          ? `; failing since ${ago(peer.failingSince)} (${peer.failures} ${peer.failures === 1 ? 'try' : 'tries'})`
          : '';
      const error = peer.lastError ? `; last error: ${peer.lastError.slice(0, 160)}` : '';
      return `${who}: ${removed}${last}, ${peer.pending - (mayRelay ? 0 : foreign)} pending${foreign ? `; ${foreign} foreign changes ${mayRelay ? 'may relay during handover' : 'kept local (not sent)'}` : ''}${failing}${error}`;
    }),
    errors: health.filter((peer) => peer.lastError).length,
    removed: health.some((peer) => peer.removedAt),
  };
}

/** How long the review repeats what this copy said when it took a new identity. */
const REIDENTIFIED_DAYS = 14;

/** The owner copy's moves this copy must act on, and its own last new identity (ADR s96 §8, §9). */
function moveLines(client: RbookDatabaseClient): {
  lines: string[];
  recoveryConditions: string[];
} {
  const ctx = mergeContext(client);
  const lines: string[] = [];
  let recoveryConditions: string[] = [];
  const recovery = dashboardRecoveryState(client);
  if (
    recovery.held &&
    !ctx.terms.some((term) => term.change?.change_id === recovery.held?.changeId)
  ) {
    const conditions = recovery.held.failures.map((failure) => failure.split(' failed:')[0]);
    recoveryConditions = [...new Set(conditions)];
    lines.push(
      `recovery held: ${conditions.join(', ')} failed; review with the owner, then reasonbook sync --confirm-owner (invalid chains first need correction)`
    );
    lines.push(...recovery.held.failures);
  }
  if (recovery.status) lines.push(recovery.status.detail);
  if (ctx.pending)
    lines.push(
      `the owner's copy moved to the copy in block ${ctx.pending.value.block} by a ${ctx.pending.value.move} (move ${ctx.pending.value.epoch}); this copy holds its changes until you confirm it: reasonbook sync --confirm-owner`
    );
  if (ctx.forks.length)
    lines.push(
      `${ctx.forks.length} move(s) of the owner's copy conflict with the one this copy follows, and only one copy can be the owner's: tell the owner`
    );
  const [row] = clientQuery(client)<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    COPY_KEYS.successor,
  ]);
  if (row)
    try {
      const taken = JSON.parse(row.value) as { at: string; block: number; summary: string };
      if (Date.now() - Date.parse(taken.at) < REIDENTIFIED_DAYS * 86_400_000)
        lines.push(
          `this copy took a new identity in block ${taken.block} on ${taken.at.slice(0, 10)}: ${taken.summary.replace(/\.$/, '')}`
        );
    } catch {
      // A note this copy cannot read says nothing.
    }
  return { lines, recoveryConditions };
}

const ULID = /(replica )?\b([0-9A-HJKMNP-TV-Z]{26})\b/g;
const ROW_NAMES: ReadonlyArray<[string, string]> = [
  ['missions', 'mission'],
  ['sprints', 'sprint'],
  ['strategic_decisions', 'decision'],
  ['learnings', 'learning'],
  ['next_steps', 'next step'],
  ['constraints', 'constraint'],
  ['sessions', 'session'],
];

/** A cause with each replica, row and change named as a person knows it, not by its stable id. */
function readable(client: RbookDatabaseClient, cause: string): string {
  const query = clientQuery(client);
  const ctx = mergeContext(client);
  return cause.replace(ULID, (_match, replica: string | undefined, ulid: string) => {
    if (ulid === ctx.authority) return "the owner's copy";
    const member = ctx.members.get(ulid);
    if (member) return `the copy in block ${member.block}`;
    if (replica) return "an outsider's copy";
    for (const [table, noun] of ROW_NAMES) {
      const [row] = query<{ id: unknown }>(`SELECT id FROM ${table} WHERE stable_event_id = ?`, [
        ulid,
      ]);
      if (row) return `${noun} ${String(row.id)}`;
    }
    const [create] = query<{ entity: string; id: unknown }>(
      "SELECT entity, json_extract(value, '$.id') AS id FROM record_changes WHERE kind = 'create' AND entity_id = ?",
      [ulid]
    );
    if (create)
      return `${ROW_NAMES.find(([table]) => table === create.entity)?.[1] ?? create.entity} ${String(create.id)}`;
    if (query('SELECT 1 FROM record_changes WHERE replica_id = ? LIMIT 1', [ulid]).length)
      return "an outsider's copy";
    return '(one not here yet)';
  });
}

/** What a standing means for a person, and what makes it live. */
const STANDING_TEXT: Readonly<Record<string, (n: number, cause: string) => string>> = {
  held: (n, cause) => `${n} held until what they wait for arrives, which a sync brings (${cause})`,
  pending: (n) => `${n} waiting for the owner's copy to judge them`,
  refused: (n, cause) => `${n} refused by the owner's copy, so never applied (${cause})`,
  quarantined: (n, cause) => `${n} quarantined until the owner's copy decides them (${cause})`,
};

/** What the review shows about a shared record (design §s96-m12, item 6); null off one. */
export function sharedRecordReview(client: RbookDatabaseClient): SharedRecordReview | null {
  if (!isRecordedStore(client)) return null;
  const query = clientQuery(client);
  const conflicts = openConflicts(client).map(
    (conflict) =>
      `${conflict.recordId ? `${conflict.table} ${conflict.recordId}` : 'the project identity'}'s ${conflict.field} (${conflict.candidates.length} values)`
  );
  const standings = query<{ state: string; n: number; cause: string }>(
    'SELECT state, count(*) AS n, min(cause) AS cause FROM record_txn_state GROUP BY state ORDER BY state'
  );
  const waiting = standings.map((row) =>
    (STANDING_TEXT[row.state] ?? ((n: number, cause: string) => `${n} ${row.state} (${cause})`))(
      row.n,
      `${row.n > 1 ? 'the first ' : ''}${readable(client, row.cause)}`
    )
  );
  const waitingTotal = standings.reduce((sum, row) => sum + row.n, 0);
  const starts = new Map<string, string | null>();
  for (const row of query<{ id: string; author: string | null; logged: number }>(
    `SELECT m.id, c.author_name AS author, c.change_id IS NOT NULL AS logged FROM missions m
       LEFT JOIN record_changes c ON c.entity = 'missions' AND c.entity_id = m.stable_event_id
        AND ((c.kind IN ('set', 'settle') AND c.field = 'status' AND c.value = '"In Progress"')
          OR (c.kind = 'create' AND json_extract(c.value, '$.status') = 'In Progress'))
        AND c.txn_id NOT IN (SELECT txn_id FROM record_txn_state)
      WHERE m.status = 'In Progress' ORDER BY m.id, c.hlc DESC, c.change_id DESC`
  ))
    if (!starts.has(row.id)) starts.set(row.id, row.logged ? (row.author ?? '') : null);
  const started = [...starts].map(([id, author]) =>
    author === null
      ? `${id}, started before the record was shared`
      : `${id}, started by ${author || 'an author not recorded'}`
  );
  const peers = peerLines(client);
  const { lines: moves, recoveryConditions } = moveLines(client);
  return {
    conflicts,
    states: crossRecordFindings(client).map((f) => f.detail),
    protocol: protocolReview(client),
    waiting,
    waitingTotal,
    waitingCounts: Object.fromEntries(standings.map((row) => [row.state, row.n])),
    started,
    ...(peers.lines.length ? { peers: peers.lines, syncErrors: peers.errors } : {}),
    ...(peers.removed ? { removed: true } : {}),
    ...(moves.length ? { moves, movePending: Boolean(mergeContext(client).pending) } : {}),
    ...(recoveryConditions.length ? { recoveryConditions } : {}),
    ...upgradeLine(client),
  };
}

/**
 * s100-m01 (settled item 6): changes of a newer record protocol wait on the copies that sent them
 * until this copy upgrades, which no sync a hook or the timer ran ever told anyone.
 */
function upgradeLine(client: RbookDatabaseClient): { readonly upgrade?: string } {
  const newer = newerProtocolHeld(client);
  return newer
    ? {
        upgrade: `this copy keeps out changes written in record protocol ${newer.protocol}, newer than its own (first met ${ago(newer.at)}): they wait on the copies that sent them, with what came after them, until Reasonbook is upgraded here: ${UPGRADE_COMMAND}`,
      }
    : {};
}
