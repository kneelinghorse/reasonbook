// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Each copy's own view of the copies it syncs with (ADR s96 §7; design §s96-m13 item 5): the route to each,
// ABOUTME: its marks at the last exchange, and that exchange's health. Per copy: never recorded, never sent.

import type { RbookDatabaseClient } from './client';
import { changesSince } from './record-since';
import type { SshRoute } from './record-ssh';
import type { MergeContext } from './record-standing';

const PEERS_SQL = `CREATE TABLE IF NOT EXISTS record_peers (
  replica_id TEXT PRIMARY KEY,
  name TEXT,
  route TEXT,
  marks TEXT,
  digest TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  last_error_at TEXT
)`;

export interface PeerRow {
  readonly replica_id: string;
  readonly name: string | null;
  readonly route: string | null;
  readonly marks: string | null;
  readonly digest: string | null;
  readonly last_ok_at: string | null;
  readonly last_error: string | null;
  readonly last_error_at: string | null;
}

export interface PeerHealth {
  readonly replicaId: string;
  readonly name: string | null;
  readonly route: SshRoute | null;
  readonly lastOkAt: string | null;
  /** Changes this copy holds that the peer did not hold at the last exchange. */
  readonly pending: number;
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
}

function ensure(client: RbookDatabaseClient): void {
  const made = client.execute(PEERS_SQL);
  if (!made.success) throw new Error(made.error?.message ?? 'the peers table could not be made');
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[]): void {
  ensure(client);
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

/** Remember how to reach a copy, and the name its member goes by. */
export function rememberPeer(
  client: RbookDatabaseClient,
  replicaId: string,
  peer: { readonly name?: string | null; readonly route?: SshRoute | null }
): void {
  run(
    client,
    `INSERT INTO record_peers (replica_id, name, route) VALUES (?, ?, ?)
       ON CONFLICT (replica_id) DO UPDATE SET
         name = COALESCE(excluded.name, record_peers.name),
         route = COALESCE(excluded.route, record_peers.route)`,
    [replicaId, peer.name ?? null, peer.route ? JSON.stringify(peer.route) : null]
  );
}

/** An exchange with a copy that finished: its marks and digest now, and no error. */
export function recordExchanged(
  client: RbookDatabaseClient,
  replicaId: string,
  outcome: { readonly marks: Readonly<Record<string, number>>; readonly digest?: unknown }
): void {
  run(
    client,
    `INSERT INTO record_peers (replica_id, marks, digest, last_ok_at, last_error, last_error_at)
       VALUES (?, ?, ?, ?, NULL, NULL)
       ON CONFLICT (replica_id) DO UPDATE SET marks = excluded.marks, digest = excluded.digest,
         last_ok_at = excluded.last_ok_at, last_error = NULL, last_error_at = NULL`,
    [
      replicaId,
      JSON.stringify(outcome.marks),
      outcome.digest === undefined ? null : JSON.stringify(outcome.digest),
      new Date().toISOString(),
    ]
  );
}

/** An exchange with a copy that failed, said as the person will read it. */
export function recordExchangeFailed(
  client: RbookDatabaseClient,
  replicaId: string,
  error: string
): void {
  run(
    client,
    `INSERT INTO record_peers (replica_id, last_error, last_error_at) VALUES (?, ?, ?)
       ON CONFLICT (replica_id) DO UPDATE SET last_error = excluded.last_error,
         last_error_at = excluded.last_error_at`,
    [replicaId, error, new Date().toISOString()]
  );
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
      route: row.route ? (JSON.parse(row.route) as SshRoute) : null,
      lastOkAt: row.last_ok_at,
      pending: changesSince(client, marks).length,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
    };
  });
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
