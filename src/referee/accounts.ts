// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Which dashboard account each member of a hosted record is (s97-m09, design §R1, fact 25): kept in the referee
// ABOUTME: store's own tables, never recorded or copied; a replica's account follows its member, never the referee's.

import type { RbookDatabaseClient } from '../tools/rbook/client';
import { OWNER_MEMBER } from '../tools/rbook/record-membership';
import { copyReport } from '../tools/rbook/record-copy-report';
import { rememberCopyReport } from '../tools/rbook/record-peer-report';
import type { MergeContext } from '../tools/rbook/record-standing';
export { predecessorsOf } from '../tools/rbook/record-lineage';

/** The referee's own state and its account bindings: per copy, so no copy of the record carries them. */
export const REFEREE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS referee_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referee_accounts (
  member_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  bound_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS referee_copies (
  replica_id TEXT PRIMARY KEY,
  last_call_at TEXT,
  received_at TEXT,
  served_marks TEXT,
  served_at TEXT,
  library_version TEXT,
  reads INTEGER
);`;

export const STATE_KEYS = {
  /** The folder under configDir that keeps this store's replica bindings (decision #1490). */
  registry: 'registry_key',
  /** The account the project's owner member is bound to at createReferee. */
  owner: 'owner_account',
  createdAt: 'created_at',
  /** Immutable normalized carried member/history contract for retrying an unanswered handover. */
  creationMembers: 'creation_members',
  /** s97-m11: when the owner's successor, holding the record again, first synced with this referee. */
  movedBack: 'moved_back_at',
  /** s97-m11: when that successor first delivered its stream here from an exchange it judged. */
  successorJudged: 'successor_judged_at',
} as const;

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): void {
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

export function writeState(client: RbookDatabaseClient, key: string, value: string): void {
  run(
    client,
    'INSERT INTO referee_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    [key, value]
  );
}

/** A value this referee keeps about itself, or null. */
export function readState(client: RbookDatabaseClient, key: string): string | null {
  const row = client.getOne<{ value: string }>('SELECT value FROM referee_state WHERE key = ?', [
    key,
  ]);
  return row.success && row.data ? row.data.value : null;
}

/** Each member's account, by member id. */
export function accountsByMember(client: RbookDatabaseClient): Map<string, string> {
  return new Map(
    rows<{ member_id: string; account_id: string }>(
      client,
      'SELECT member_id, account_id FROM referee_accounts'
    ).map((row) => [row.member_id, row.account_id])
  );
}

/** The member an account is bound to, or null. */
export function memberOfAccount(client: RbookDatabaseClient, accountId: string): string | null {
  const [row] = rows<{ member_id: string }>(
    client,
    'SELECT member_id FROM referee_accounts WHERE account_id = ?',
    [accountId]
  );
  return row?.member_id ?? null;
}

export function bindAccount(
  client: RbookDatabaseClient,
  memberId: string,
  accountId: string
): void {
  run(client, 'INSERT INTO referee_accounts (member_id, account_id, bound_at) VALUES (?, ?, ?)', [
    memberId,
    accountId,
    new Date().toISOString(),
  ]);
}

/** The member (person) a replica is a copy for, as the record admitted it. */
export function memberOfReplica(ctx: MergeContext, replicaId: string): string | null {
  const member = ctx.members.get(replicaId) ?? ctx.unseen.get(replicaId);
  if (!member) return null;
  return member.member ?? (member.role === 'owner' ? OWNER_MEMBER : null);
}

/**
 * The account a replica is bound to: its member's. The referee's own replica is bound to no one,
 * though it joined as the owner's other copy, so no caller can write as the referee (fact 31).
 */
export function accountOfReplica(
  ctx: MergeContext,
  accounts: ReadonlyMap<string, string>,
  replicaId: string
): string | null {
  if (replicaId === ctx.ownReplica) return null;
  const member = memberOfReplica(ctx, replicaId);
  return member ? (accounts.get(member) ?? null) : null;
}

/** What the referee itself saw of a copy's call, never what the copy reported (the per-call table). */
export function noteCall(
  client: RbookDatabaseClient,
  replicaId: string,
  seen: {
    readonly report?: unknown;
    readonly received?: boolean;
    readonly served?: Readonly<Record<string, number>>;
  }
): void {
  const saved = client.writeTransaction(() => {
    const columns = new Set(
      rows<{ name: string }>(client, 'PRAGMA table_info(referee_copies)').map((row) => row.name)
    );
    for (const [name, type] of [
      ['library_version', 'TEXT'],
      ['reads', 'INTEGER'],
    ])
      if (!columns.has(name)) run(client, `ALTER TABLE referee_copies ADD COLUMN ${name} ${type}`);
    const now = new Date().toISOString();
    run(
      client,
      `INSERT INTO referee_copies (replica_id, last_call_at, received_at, served_marks, served_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (replica_id) DO UPDATE SET last_call_at = excluded.last_call_at,
         received_at = COALESCE(excluded.received_at, referee_copies.received_at),
         served_marks = COALESCE(excluded.served_marks, referee_copies.served_marks),
         served_at = COALESCE(excluded.served_at, referee_copies.served_at)`,
      [
        replicaId,
        now,
        seen.received ? now : null,
        seen.served ? JSON.stringify(seen.served) : null,
        seen.served ? now : null,
      ]
    );
    if ('report' in seen) {
      const report = copyReport(seen.report);
      run(client, 'UPDATE referee_copies SET library_version = ?, reads = ? WHERE replica_id = ?', [
        report.libraryVersion,
        report.reads,
        replicaId,
      ]);
      rememberCopyReport(client, replicaId, seen.report, { called: true });
    }
  });
  if (!saved.success) throw new Error(saved.error?.message ?? 'could not record the copy call');
}
