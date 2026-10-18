// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A session another copy of a shared record started (ADR s96 §5): its owner key never matches a local process,
// ABOUTME: so it is never adopted, written or closed here; a copy that joins marks the sessions it brought along.

import type { RbookDatabaseClient } from './client';

/**
 * s96-m12: a session another copy of a shared record started carries this owner key on every other
 * copy. It never matches a local process, so it is never adopted or closed here; only its own copy
 * writes to it or closes it.
 */
export const PEER_OWNER_PREFIX = 'peer:';

export function isPeerSession(ownerKey: string | null | undefined): boolean {
  return ownerKey?.startsWith(PEER_OWNER_PREFIX) ?? false;
}

/**
 * A copy that takes its identity from another copy's store holds the sessions still open there. Each
 * belongs to the copy that started it: its create's replica, or the authority for a session the
 * baseline holds. So each takes that copy's peer key here, and is never implicit here. A store with
 * no change log yet, as at the share step, has no other copy's sessions. A copy that re-identifies
 * marks none: its sessions were classified when it first took an identity, and a merge marks each
 * session it applies. Returns how many it marked.
 */
export function markPeerSessions(client: RbookDatabaseClient, ownReplica: string): number {
  const log = client.getOne<{ present: number }>(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'record_changes'"
  );
  if (!log.success) throw new Error(log.error?.message ?? 'the change log could not be found');
  if (!log.data) return 0;
  const baseline = client.getOne<{ value: string }>(
    "SELECT value FROM record_changes WHERE kind = 'baseline' ORDER BY replica_seq LIMIT 1"
  );
  if (!baseline.success)
    throw new Error(baseline.error?.message ?? 'the baseline could not be read');
  if (!baseline.data) return 0;
  const authority = String((JSON.parse(baseline.data.value) as { authority?: unknown }).authority);
  const creator = `COALESCE((SELECT c.replica_id FROM record_changes c WHERE c.kind = 'create'
     AND c.entity = 'sessions' AND c.entity_id = sessions.stable_event_id LIMIT 1), ?)`;
  const marked = client.execute(
    `UPDATE sessions SET owner_key = ? || ${creator}, implicit = 0
      WHERE status = 'active' AND ${creator} <> ?`,
    [PEER_OWNER_PREFIX, authority, authority, ownReplica]
  );
  if (!marked.success)
    throw new Error(marked.error?.message ?? 'the open sessions were not marked');
  return marked.data?.changes ?? 0;
}
