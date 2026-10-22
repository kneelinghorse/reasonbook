// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Persist a copy's capability report separately from successful exchange timestamps.
// ABOUTME: Read old or absent peer tables without migration, while surfacing database failures.
import type { RbookDatabaseClient } from './client';
import { copyReport, type ReportedCopy } from './record-copy-report';
import { rememberPeer } from './record-peers';

/** Missing tables, columns and NULL fields mean unreported; a read never creates or alters them. */
export function reportedCopy(client: RbookDatabaseClient, replicaId: string): ReportedCopy {
  const table = client.getOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'record_peers'"
  );
  if (!table.success) throw new Error(table.error?.message ?? 'could not inspect peer reports');
  if (!table.data) return copyReport(undefined);
  const row = client.getOne<{ library_version?: unknown; reads?: unknown }>(
    'SELECT * FROM record_peers WHERE replica_id = ?',
    [replicaId]
  );
  if (!row.success) throw new Error(row.error?.message ?? 'could not read the copy report');
  return copyReport({ libraryVersion: row.data?.library_version, reads: row.data?.reads });
}

/** Only a validated, admitted direct call adds liveness; no report claims a completed exchange. */
export function rememberCopyReport(
  client: RbookDatabaseClient,
  replicaId: string,
  value: unknown,
  options: { readonly called?: boolean } = {}
): void {
  const report = copyReport(value);
  const saved = client.writeTransaction(() => {
    rememberPeer(client, replicaId, {});
    const updated = client.execute(
      'UPDATE record_peers SET library_version = ?, reads = ?, last_call_at = COALESCE(?, last_call_at) WHERE replica_id = ?',
      [
        report.libraryVersion,
        report.reads,
        options.called ? new Date().toISOString() : null,
        replicaId,
      ]
    );
    if (!updated.success)
      throw new Error(updated.error?.message ?? 'could not save the copy report');
  });
  if (!saved.success) throw new Error(saved.error?.message ?? 'could not save the copy report');
}
