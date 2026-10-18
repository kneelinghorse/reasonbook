// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Registry-owned bindings of each copy of a shared record to this machine: its folder, its store
// ABOUTME: file's device and inode, and how far it has written (ADR s96 §9), so a copy or restore is caught.

import type Database from 'better-sqlite3';

/** One copy of a shared project as this machine knows it. */
export interface ReplicaBinding {
  readonly replica_id: string;
  readonly project_id: string;
  /** The project ROOT the copy lives in, as it was last bound. */
  readonly store_path: string;
  /** The store file's device and inode when it was last bound or moved. */
  readonly device: number;
  readonly inode: number;
  /** The highest replica sequence this machine saw the copy issue. */
  readonly seq_mark: number;
  readonly bound_at: number;
  readonly updated_at: number;
  /** Set when the copy re-identified; the row stays for its lost-range report. */
  readonly retired_at: number | null;
}

export interface BindReplicaInput {
  readonly replicaId: string;
  readonly projectId: string;
  readonly storePath: string;
  readonly device: number;
  readonly inode: number;
  readonly seqMark: number;
}

const prepared = new WeakSet<Database.Database>();

/** Create the bindings table when absent. Idempotent, and additive for older servers. */
export function ensureReplicaTable(db: Database.Database): void {
  if (prepared.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS replicas (
      replica_id  TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL,
      store_path  TEXT NOT NULL,
      device      INTEGER NOT NULL,
      inode       INTEGER NOT NULL,
      seq_mark    INTEGER NOT NULL DEFAULT 0,
      bound_at    INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      retired_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_replicas_project ON replicas (project_id);
  `);
  prepared.add(db);
}

export function replicaBinding(db: Database.Database, replicaId: string): ReplicaBinding | null {
  ensureReplicaTable(db);
  return (
    (db.prepare('SELECT * FROM replicas WHERE replica_id = ?').get(replicaId) as
      | ReplicaBinding
      | undefined) ?? null
  );
}

/** The copies of one project this machine still holds bindings for, in minting order (ULIDs). */
export function liveReplicas(db: Database.Database, projectId: string): ReplicaBinding[] {
  ensureReplicaTable(db);
  return db
    .prepare(
      'SELECT * FROM replicas WHERE project_id = ? AND retired_at IS NULL ORDER BY replica_id'
    )
    .all(projectId) as ReplicaBinding[];
}

export function bindReplica(db: Database.Database, input: BindReplicaInput, now: number): void {
  ensureReplicaTable(db);
  db.prepare(
    `INSERT INTO replicas (replica_id, project_id, store_path, device, inode, seq_mark, bound_at, updated_at, retired_at)
     VALUES (@replicaId, @projectId, @storePath, @device, @inode, @seqMark, @now, @now, NULL)
     ON CONFLICT(replica_id) DO UPDATE SET
       project_id = excluded.project_id,
       store_path = excluded.store_path,
       device     = excluded.device,
       inode      = excluded.inode,
       seq_mark   = MAX(replicas.seq_mark, excluded.seq_mark),
       updated_at = excluded.updated_at,
       retired_at = NULL`
  ).run({ ...input, now });
}

/**
 * The same copy, found again: moved to another folder with its file, or in its folder on a volume
 * that was given another device number when it mounted.
 */
export function rebindReplica(
  db: Database.Database,
  replicaId: string,
  location: { readonly storePath: string; readonly device: number; readonly inode: number },
  now: number
): void {
  ensureReplicaTable(db);
  db.prepare(
    'UPDATE replicas SET store_path = ?, device = ?, inode = ?, updated_at = ? WHERE replica_id = ?'
  ).run(location.storePath, location.device, location.inode, now, replicaId);
}

/** Raise the mark; it never moves down, so a late writer cannot hide a later one's changes. */
export function advanceReplicaMark(
  db: Database.Database,
  replicaId: string,
  seq: number,
  now: number
): void {
  ensureReplicaTable(db);
  db.prepare(
    'UPDATE replicas SET seq_mark = ?, updated_at = ? WHERE replica_id = ? AND seq_mark < ?'
  ).run(seq, now, replicaId, seq);
}

export function retireReplica(db: Database.Database, replicaId: string, now: number): void {
  ensureReplicaTable(db);
  db.prepare(
    'UPDATE replicas SET retired_at = ?, updated_at = ? WHERE replica_id = ? AND retired_at IS NULL'
  ).run(now, now, replicaId);
}
