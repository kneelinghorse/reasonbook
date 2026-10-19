// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Each copy's own view of the copies it syncs with (ADR s96 §7; design §s96-m13 item 5): the route to each,
// ABOUTME: its marks at the last exchange, and that exchange's health. Per copy: never recorded, never sent.

import type { RbookDatabaseClient } from './client';
import { dashboardName, isDashboardRoute, type DashboardRoute } from './record-dashboard-route';
import { changesSince } from './record-since';
import type { SshRoute } from './record-ssh';
import type { MergeContext } from './record-standing';
import { REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';
import { storedTimeMs } from './stored-time';

/** How this copy reaches another: over SSH (4.1.0), or through a dashboard that referees the project (s97-m10). */
export type PeerRoute = SshRoute | DashboardRoute;

/** s97-m10 (design §R2): a dashboard that keeps failing is tried less often by the automatic syncs, up to hourly. */
export const BACKOFF_FIRST_MS = 5 * 60 * 1000;
export const BACKOFF_LONGEST_MS = 60 * 60 * 1000;

const PEERS_SQL = `CREATE TABLE IF NOT EXISTS record_peers (
  replica_id TEXT PRIMARY KEY,
  name TEXT,
  route TEXT,
  marks TEXT,
  digest TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  failing_since TEXT,
  removed_at TEXT
)`;

/** s97-m10: the columns a table made by 4.1.0 lacks, added when this copy next writes a peer. */
const ADDED_COLUMNS: ReadonlyArray<[string, string]> = [
  ['failures', 'failures INTEGER NOT NULL DEFAULT 0'],
  ['failing_since', 'failing_since TEXT'],
  // s97-m14: when the copy at the far end first said this copy's member was removed.
  ['removed_at', 'removed_at TEXT'],
];

export interface PeerRow {
  readonly replica_id: string;
  readonly name: string | null;
  readonly route: string | null;
  readonly marks: string | null;
  readonly digest: string | null;
  readonly last_ok_at: string | null;
  readonly last_error: string | null;
  readonly last_error_at: string | null;
  readonly failures?: number | null;
  readonly failing_since?: string | null;
  readonly removed_at?: string | null;
}

export interface PeerHealth {
  readonly replicaId: string;
  readonly name: string | null;
  readonly route: PeerRoute | null;
  readonly lastOkAt: string | null;
  /** Changes this copy holds that the peer did not hold at the last exchange. */
  readonly pending: number;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  /** s97-m10: exchanges failed in a row since the last good one, and when the first of them failed. */
  readonly failures: number;
  readonly failingSince: string | null;
  /**
   * s97-m14: since when that copy has said this copy's member was removed (ADR s96 §8): what this
   * copy sends past its cut is set aside there, and it receives nothing new. Null while a member.
   */
  readonly removedAt: string | null;
}

function ensure(client: RbookDatabaseClient): void {
  const made = client.execute(PEERS_SQL);
  if (!made.success) throw new Error(made.error?.message ?? 'the peers table could not be made');
  const columns = client.getMany<{ name: string }>('PRAGMA table_info(record_peers)');
  const has = new Set((columns.data ?? []).map((column) => column.name));
  for (const [name, definition] of ADDED_COLUMNS)
    if (!has.has(name)) {
      const added = client.execute(`ALTER TABLE record_peers ADD COLUMN ${definition}`);
      if (!added.success) throw new Error(added.error?.message ?? `could not add ${name}`);
    }
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[]): void {
  ensure(client);
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

/** In an UPDATE of record_peers: the route it sets differs from the one held (SET reads the old row). */
const ROUTE_CHANGED = 'excluded.route IS NOT NULL AND excluded.route IS NOT record_peers.route';

/** Remember how to reach a copy, and the name its member goes by. */
export function rememberPeer(
  client: RbookDatabaseClient,
  replicaId: string,
  peer: { readonly name?: string | null; readonly route?: PeerRoute | null }
): void {
  // s97-m10: a copy reached through the dashboard keeps that route; no other route stands in for it.
  const held = routeTo(client, replicaId);
  if (isDashboardRoute(held) && peer.route && !isDashboardRoute(peer.route))
    throw new ReplicaRefusal({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `This copy reaches ${replicaId} through ${dashboardName(held)}, so it keeps that route, and no other replaces it.`,
      suggestion: 'Sync through the dashboard: reasonbook sync.',
    });
  run(
    client,
    // s97-m10: a new route starts with a clean record, so it never waits out the old one's failures.
    `INSERT INTO record_peers (replica_id, name, route) VALUES (?, ?, ?)
       ON CONFLICT (replica_id) DO UPDATE SET
         name = COALESCE(excluded.name, record_peers.name),
         failures = CASE WHEN ${ROUTE_CHANGED} THEN 0 ELSE record_peers.failures END,
         failing_since = CASE WHEN ${ROUTE_CHANGED} THEN NULL ELSE record_peers.failing_since END,
         last_error = CASE WHEN ${ROUTE_CHANGED} THEN NULL ELSE record_peers.last_error END,
         last_error_at = CASE WHEN ${ROUTE_CHANGED} THEN NULL ELSE record_peers.last_error_at END,
         route = COALESCE(excluded.route, record_peers.route)`,
    [replicaId, peer.name ?? null, peer.route ? JSON.stringify(peer.route) : null]
  );
}

/**
 * An exchange with a copy that finished: its marks and digest now, and no error. s97-m14: `removed`
 * is what the exchange said of this copy's own membership. True keeps when a removal was first said,
 * false (it is a member, as after the owner shares the project with it again) clears it, and
 * undefined leaves it: a note the far side or a referee writes of an exchange this copy started says
 * nothing of this copy's membership (critics, round 1).
 */
export function recordExchanged(
  client: RbookDatabaseClient,
  replicaId: string,
  outcome: {
    readonly marks: Readonly<Record<string, number>>;
    readonly digest?: unknown;
    readonly removed?: boolean;
  }
): void {
  const at = new Date().toISOString();
  const said = outcome.removed === undefined ? null : outcome.removed ? 1 : 0;
  run(
    client,
    `INSERT INTO record_peers (replica_id, marks, digest, last_ok_at, last_error, last_error_at, failures, failing_since, removed_at)
       VALUES (?, ?, ?, ?, NULL, NULL, 0, NULL, ?)
       ON CONFLICT (replica_id) DO UPDATE SET marks = excluded.marks, digest = excluded.digest,
         last_ok_at = excluded.last_ok_at, last_error = NULL, last_error_at = NULL, failures = 0,
         failing_since = NULL,
         removed_at = CASE ? WHEN 1 THEN COALESCE(record_peers.removed_at, excluded.removed_at)
           WHEN 0 THEN NULL ELSE record_peers.removed_at END`,
    [
      replicaId,
      JSON.stringify(outcome.marks),
      outcome.digest === undefined ? null : JSON.stringify(outcome.digest),
      at,
      said === 1 ? at : null,
      said,
    ]
  );
}

/** An exchange with a copy that failed, said as the person will read it. */
export function recordExchangeFailed(
  client: RbookDatabaseClient,
  replicaId: string,
  error: string,
  options: { readonly count?: boolean } = {}
): void {
  // s97-m10: a sync that failed counts once toward the failing streak, where the sync ends; the
  // exchange's own note of the error, and the far end's, only say what it was (critics, round 1).
  const at = new Date().toISOString();
  run(
    client,
    options.count
      ? `INSERT INTO record_peers (replica_id, last_error, last_error_at, failures, failing_since)
           VALUES (?, ?, ?, 1, ?)
           ON CONFLICT (replica_id) DO UPDATE SET last_error = excluded.last_error,
             last_error_at = excluded.last_error_at, failures = record_peers.failures + 1,
             failing_since = COALESCE(record_peers.failing_since, excluded.last_error_at)`
      : `INSERT INTO record_peers (replica_id, last_error, last_error_at) VALUES (?, ?, ?)
           ON CONFLICT (replica_id) DO UPDATE SET last_error = excluded.last_error,
             last_error_at = excluded.last_error_at`,
    options.count ? [replicaId, error, at, at] : [replicaId, error, at]
  );
}

/**
 * s97-m10: an exchange that went through but held back one transaction too large for the dashboard:
 * the dashboard answered, so the failing streak ends, and the error stays for the review to show
 * (critics, round 2). The marks are the last full exchange's.
 */
export function recordHeldBack(
  client: RbookDatabaseClient,
  replicaId: string,
  error: string
): void {
  const at = new Date().toISOString();
  run(
    client,
    `INSERT INTO record_peers (replica_id, last_ok_at, last_error, last_error_at, failures, failing_since)
       VALUES (?, ?, ?, ?, 0, NULL)
       ON CONFLICT (replica_id) DO UPDATE SET last_ok_at = excluded.last_ok_at,
         last_error = excluded.last_error, last_error_at = excluded.last_error_at, failures = 0,
         failing_since = NULL`,
    [replicaId, at, error, at]
  );
}

/**
 * s97-m10 (design §R2): when an automatic sync next tries a dashboard that keeps failing, or null to
 * try it now. The wait doubles from five minutes with each failure in a row, up to an hour; a sync a
 * person starts always tries.
 */
export function nextTryAt(peer: PeerHealth, nowMs: number = Date.now()): string | null {
  if (!isDashboardRoute(peer.route) || peer.failures < 1 || !peer.lastErrorAt) return null;
  const wait = Math.min(BACKOFF_FIRST_MS * 2 ** (peer.failures - 1), BACKOFF_LONGEST_MS);
  const at = storedTimeMs(peer.lastErrorAt) + wait;
  return Number.isFinite(at) && at > nowMs ? new Date(at).toISOString() : null;
}

/**
 * Forget the copies another copy's file remembered (s96-m13): a store carried to a new machine
 * brings that copy's routes and health, which are not this copy's. With `replicaIds`, forget those.
 */
export function forgetPeers(client: RbookDatabaseClient, replicaIds?: readonly string[]): void {
  if (!hasPeers(client)) return;
  if (!replicaIds) return run(client, 'DELETE FROM record_peers', []);
  for (const replicaId of replicaIds)
    run(client, 'DELETE FROM record_peers WHERE replica_id = ?', [replicaId]);
}

/**
 * Whether this copy syncs with `replicaId` (ADR s96 §7): the owner's copy with every member's that is
 * not removed, and a member's copy with the owner's alone. Its health is shown for no other.
 */
export function syncsWith(
  ctx: Pick<MergeContext, 'ownReplica' | 'authority' | 'members'>,
  replicaId: string
): boolean {
  return (
    ctx.members.get(replicaId)?.role !== 'removed' &&
    (ctx.ownReplica === ctx.authority || replicaId === ctx.authority)
  );
}

/** Whether this copy has remembered any peer; a read never makes the table. */
function hasPeers(client: RbookDatabaseClient): boolean {
  const present = client.getOne<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'record_peers'"
  );
  return present.success && Boolean(present.data);
}

/** The copies this copy knows, each with its route, last exchange and pending count. */
export function peerHealth(client: RbookDatabaseClient): PeerHealth[] {
  if (!hasPeers(client)) return [];
  const read = client.getMany<PeerRow>('SELECT * FROM record_peers ORDER BY replica_id');
  if (!read.success) throw new Error(read.error?.message ?? 'the peers could not be read');
  return (read.data ?? []).map((row) => {
    const marks = row.marks ? (JSON.parse(row.marks) as Record<string, number>) : {};
    return {
      replicaId: row.replica_id,
      name: row.name,
      route: row.route ? (JSON.parse(row.route) as PeerRoute) : null,
      lastOkAt: row.last_ok_at,
      pending: changesSince(client, marks).length,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
      failures: row.failures ?? 0,
      failingSince: row.failing_since ?? null,
      removedAt: row.removed_at ?? null,
    };
  });
}

/** The route this copy keeps to `replicaId`, or null; a read never makes the table. */
export function routeTo(client: RbookDatabaseClient, replicaId: string): PeerRoute | null {
  if (!hasPeers(client)) return null;
  const row = client.getOne<{ route: string | null }>(
    'SELECT route FROM record_peers WHERE replica_id = ?',
    [replicaId]
  );
  return row.data?.route ? (JSON.parse(row.data.route) as PeerRoute) : null;
}

/** The marks a copy held at the last exchange, or none: what a bundle for it starts after. */
export function peerMarks(client: RbookDatabaseClient, replicaId: string): Record<string, number> {
  if (!hasPeers(client)) return {};
  const known = client.getOne<{ marks: string | null }>(
    'SELECT marks FROM record_peers WHERE replica_id = ?',
    [replicaId]
  );
  return known.data?.marks ? (JSON.parse(known.data.marks) as Record<string, number>) : {};
}
