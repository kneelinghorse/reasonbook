// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Derive the all-member active copies that can block this record's protocol transition.
// ABOUTME: Actual writes and calls count; route metadata, dead predecessors and ended authority-only streams do not.
import type { RbookDatabaseClient } from './client';
import { copyReport, localCopyReport, type ReportedCopy } from './record-copy-report';
import { BASELINE_QUERY } from './record-baseline';
import { termReach } from './record-context';
import type { MergeContext } from './record-standing';

export interface ProtocolBlockingCopy extends ReportedCopy {
  readonly replicaId: string;
  readonly memberId: string | null;
  readonly memberName: string;
  readonly block: number;
}
interface Observation {
  readonly replica_id: string;
  readonly last_call_at?: unknown;
  readonly last_ok_at?: unknown;
  readonly library_version?: unknown;
  readonly reads?: unknown;
}
function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const found = client.getMany<T>(sql, params);
  if (!found.success) throw new Error(found.error?.message ?? 'Could not read active copies.');
  return found.data ?? [];
}
/** Old and absent tables are unreported; SQL failures must never silently permit the switch. */
function observations(client: RbookDatabaseClient, table: string): Map<string, Observation> {
  const found = rows(client, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [
    table,
  ]);
  return new Map(
    found.length
      ? rows<Observation>(client, `SELECT * FROM ${table}`).map((row) => [row.replica_id, row])
      : []
  );
}

export function activeProtocolCopies(
  client: RbookDatabaseClient,
  ctx: MergeContext
): readonly ProtocolBlockingCopy[] {
  // The same host-local table identifies a referee in record-judge and the library opener.
  const hosted =
    rows(client, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'referee_state'")
      .length > 0;
  const reports = observations(client, hosted ? 'referee_copies' : 'record_peers');
  const wrote = new Map(
    rows<{ replica_id: string; last: number }>(
      client,
      'SELECT replica_id, max(replica_seq) AS last FROM record_changes GROUP BY replica_id'
    ).map((row) => [row.replica_id, row.last])
  );
  const called = (id: string): boolean =>
    reports.get(id)?.last_call_at != null || (!hosted && reports.get(id)?.last_ok_at != null);
  const used = (id: string): boolean => (wrote.get(id) ?? 0) > 0 || called(id);
  const replaced = new Set(
    [...ctx.members.values()]
      .filter((member) => member.previous && used(member.replicaId))
      .map((member) => member.previous!)
  );
  const names = memberNames(client, ctx);
  return [...ctx.members.values()].flatMap((member) => {
    if (
      member.role === 'removed' ||
      member.cut !== undefined ||
      ctx.unseen.has(member.replicaId) ||
      replaced.has(member.replicaId) ||
      !used(member.replicaId)
    )
      return [];
    const term = ctx.terms.find((held) => held.replicaId === member.replicaId);
    if (term && Number.isFinite(term.cut) && (wrote.get(member.replicaId) ?? 0) <= term.cut)
      return [];
    const observed = reports.get(member.replicaId);
    const report =
      member.replicaId === ctx.ownReplica
        ? localCopyReport()
        : copyReport({ libraryVersion: observed?.library_version, reads: observed?.reads });
    return [
      {
        replicaId: member.replicaId,
        memberId: member.member ?? null,
        memberName:
          names.get(member.member ?? '') ??
          (member.role === 'owner' ? 'the owner' : 'unnamed member'),
        block: member.block,
        ...report,
      },
    ];
  });
}

/** Names need only counted membership metadata; importing membership would load the merge engine on review. */
function memberNames(client: RbookDatabaseClient, ctx: MergeContext): ReadonlyMap<string, string> {
  const [baseline] = rows<{ value: string | null }>(client, BASELINE_QUERY);
  const names = new Map<string, string>([
    ['owner', String(JSON.parse(baseline?.value ?? '{}').owner ?? 'the owner')],
  ]);
  for (const term of ctx.terms)
    for (const change of rows<{ entity_id: string; value: string | null }>(
      client,
      "SELECT entity_id, value FROM record_changes WHERE kind = 'member' AND replica_id = ? AND replica_seq <= ? ORDER BY replica_seq",
      [term.replicaId, termReach(ctx, term)]
    )) {
      const value = JSON.parse(change.value ?? '{}') as { name?: unknown };
      names.set(change.entity_id, String(value.name ?? names.get(change.entity_id) ?? ''));
    }
  return names;
}
