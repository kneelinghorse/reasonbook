// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Links mission work to the resolved caller's owner-keyed session under the transition lock.
// ABOUTME: Keyless explicit sessions still absorb callers but never gain automatic mission links.
import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { recordedExecute, isRecordedStore } from './record-changes';
import { takeReplicaSeq } from './replica-identity';
import { resolveCallerSession } from './session-owner';
import type { RbookToolResult } from './types';

/** The caller ensured session columns and the junction table before entering its transaction. */
export function linkCallerMission(
  client: RbookDatabaseClient,
  missionId: string,
  source: 'start' | 'complete',
  now: string,
  warnings: string[]
): RbookToolResult<void> {
  const failure = (message: string): RbookToolResult<void> =>
    createError({
      code: 'DB_QUERY_FAILED',
      message: `Could not link mission '${missionId}' to its caller session: ${message}`,
      suggestion:
        'Check the sessions and session_missions schema or write permissions, then retry the transition.',
    });
  const caller = resolveCallerSession(client, { open: true, now });
  if (!caller.ok) return failure(caller.error.message);
  warnings.push(...caller.warnings);
  if (!caller.session) return failure('the caller session was not resolved');
  const owner = client.getOne<{ owner_key: string | null }>(
    'SELECT owner_key FROM sessions WHERE id = ?',
    [caller.session.sessionId]
  );
  if (!owner.success || !owner.data)
    return failure(owner.error?.message ?? 'the resolved session is missing');
  if (owner.data.owner_key === null) return createSuccess(undefined);
  const linked = recordedExecute(
    client,
    `INSERT INTO session_missions (session_id, mission_id, linked_at, source)
     VALUES (?, ?, ?, ?) ON CONFLICT (session_id, mission_id) DO NOTHING`,
    [caller.session.sessionId, missionId, now, source]
  );
  if (!linked.success) return failure(linked.error?.message ?? 'the link write failed');
  // Zero changes can mean an existing link or a trigger that ignored the INSERT. Only the
  // persisted junction is evidence that this transition belongs to the caller's session.
  const persisted = client.getOne<{ session_id: string }>(
    'SELECT session_id FROM session_missions WHERE session_id = ? AND mission_id = ?',
    [caller.session.sessionId, missionId]
  );
  if (!persisted.success)
    return failure(persisted.error?.message ?? 'the link could not be verified');
  if (!persisted.data) return failure('the session link was not persisted');
  if (linked.data?.changes && !isRecordedStore(client)) takeReplicaSeq(client, 'session_missions');
  return createSuccess(undefined);
}
