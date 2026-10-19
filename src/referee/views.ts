// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What the dashboard shows of a hosted project (s97-m09, design §R1, D7): changes as the referee took them in, with
// ABOUTME: authors and standing, open conflicts, each copy's marks and last exchange as the referee holds them, and waiting.

import type { RbookDatabaseClient } from '../tools/rbook/client';
import { createSuccess } from '../tools/rbook/errors';
import { replicaMarks } from '../tools/rbook/record-apply';
import { crossRecordFindings, type CheckFinding } from '../tools/rbook/record-checks';
import { peerHealth } from '../tools/rbook/record-peers';
import { changesSince } from '../tools/rbook/record-since';
import { openConflicts, type OpenConflict } from '../tools/rbook/record-settle';
import {
  mergeContext,
  txnStanding,
  type LoggedChange,
  type StandingState,
} from '../tools/rbook/record-standing';
import { accountOfReplica, accountsByMember, memberOfReplica } from './accounts';
import { REFEREE_ERROR_CODES, refuse } from './codes';
import { withReferee, type RefereeLocation, type RefereeOutcome } from './open';

export interface RecentChange extends LoggedChange {
  /** Its transaction's standing on the referee, and why when it is not live. */
  readonly standing: StandingState;
  readonly cause: string | null;
}

export interface CopyState {
  readonly replicaId: string;
  readonly memberId: string | null;
  readonly accountId: string | null;
  /** Whether its member was removed: it then receives nothing new. */
  readonly removed: boolean;
  /** How far the referee holds this copy's own stream. */
  readonly received: number;
  /** The referee's own marks when it last sent this copy the record, and when that was. */
  readonly servedThrough: Readonly<Record<string, number>>;
  readonly lastServedAt: string | null;
  /** When the referee last took in this copy's changes, and when it last heard from it at all. */
  readonly lastReceivedAt: string | null;
  readonly lastCallAt: string | null;
  /** The last error the copy itself reported, and when. */
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
  /** Changes the referee holds that it has not sent this copy yet. */
  readonly waitingForIt: number;
}

export interface WaitingTransaction {
  readonly txnId: string;
  readonly replicaId: string;
  readonly state: string;
  readonly cause: string;
}

const PAGE = 500;

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

const notReady = <T>(joining: unknown) =>
  joining
    ? refuse<T>({
        code: REFEREE_ERROR_CODES.NOT_READY,
        message: "This project's referee has not finished joining.",
        suggestion: "Finish the handover in from the owner's copy first.",
      })
    : null;

/**
 * The changes the referee took in after `sinceChangeId`, in the order it took them in, up to
 * `limit`, each with its author and its transaction's standing: the activity feed keys them by change
 * id, so two in one millisecond are two entries (fact 5).
 */
export function recentChanges(
  location: RefereeLocation,
  input: { readonly sinceChangeId?: string | null; readonly limit?: number } = {}
): Promise<RefereeOutcome<RecentChange[]>> {
  return withReferee(location, ({ client, joining }) => {
    const unready = notReady<RecentChange[]>(joining);
    if (unready) return unready;
    const limit = Math.max(1, Math.min(PAGE, Math.floor(input.limit ?? PAGE)));
    const [after] = input.sinceChangeId
      ? rows<{ position: number }>(
          client,
          'SELECT rowid AS position FROM record_changes WHERE change_id = ?',
          [input.sinceChangeId]
        )
      : [{ position: 0 }];
    if (!after)
      return refuse<RecentChange[]>({
        code: REFEREE_ERROR_CODES.MALFORMED,
        message: `The referee holds no change ${input.sinceChangeId}.`,
        suggestion: 'Ask from a change id an earlier answer gave, or from the start.',
      });
    const ctx = mergeContext(client);
    return createSuccess(
      rows<LoggedChange>(
        client,
        'SELECT * FROM record_changes WHERE rowid > ? ORDER BY rowid LIMIT ?',
        [after.position, limit]
      ).map((change) => {
        const standing = txnStanding(client, ctx, change.txn_id);
        return { ...change, standing: standing.state, cause: standing.cause };
      })
    );
  });
}

/** Each field holding values from copies that had not seen each other, and the states needing a person. */
export function conflicts(location: RefereeLocation): Promise<
  RefereeOutcome<{
    readonly conflicts: readonly OpenConflict[];
    readonly checks: readonly CheckFinding[];
  }>
> {
  return withReferee(location, ({ client, joining }) => {
    const unready = notReady<{
      readonly conflicts: readonly OpenConflict[];
      readonly checks: readonly CheckFinding[];
    }>(joining);
    if (unready) return unready;
    return createSuccess({ conflicts: openConflicts(client), checks: crossRecordFindings(client) });
  });
}

/** Each member's copy as the referee holds it: the dashboard's sync-state view reads these marks, not a copy's reports. */
export function peers(location: RefereeLocation): Promise<RefereeOutcome<CopyState[]>> {
  return withReferee(location, ({ client, joining }) => {
    const unready = notReady<CopyState[]>(joining);
    if (unready) return unready;
    const ctx = mergeContext(client);
    const accounts = accountsByMember(client);
    const held = replicaMarks(client);
    // What the referee itself saw of each copy (the per-call table): never a copy's own report of it.
    const seen = new Map(
      rows<{
        replica_id: string;
        last_call_at: string | null;
        received_at: string | null;
        served_marks: string | null;
        served_at: string | null;
      }>(client, 'SELECT * FROM referee_copies').map((row) => [row.replica_id, row])
    );
    // Only a copy's errors come from its own reports, which it may make about itself alone.
    const reported = new Map(peerHealth(client).map((peer) => [peer.replicaId, peer]));
    const copies = [...ctx.members.values()].filter(
      (member) => member.replicaId !== ctx.ownReplica
    );
    return createSuccess(
      copies.map((member) => {
        const saw = seen.get(member.replicaId);
        const served = saw?.served_marks
          ? (JSON.parse(saw.served_marks) as Record<string, number>)
          : {};
        const report = reported.get(member.replicaId);
        return {
          replicaId: member.replicaId,
          memberId: memberOfReplica(ctx, member.replicaId),
          accountId: accountOfReplica(ctx, accounts, member.replicaId),
          removed: member.role === 'removed',
          received: held[member.replicaId] ?? 0,
          servedThrough: served,
          lastServedAt: saw?.served_at ?? null,
          lastReceivedAt: saw?.received_at ?? null,
          lastCallAt: saw?.last_call_at ?? null,
          lastError: report?.lastError ?? null,
          lastErrorAt: report?.lastErrorAt ?? null,
          waitingForIt: member.role === 'removed' ? 0 : changesSince(client, served).length,
        };
      })
    );
  });
}

/** Every transaction the referee holds that is not live: pending, held, refused or quarantined, and why. */
export function waiting(location: RefereeLocation): Promise<RefereeOutcome<WaitingTransaction[]>> {
  return withReferee(location, ({ client, joining }) => {
    const unready = notReady<WaitingTransaction[]>(joining);
    if (unready) return unready;
    return createSuccess(
      rows<{ txn_id: string; replica_id: string; state: string; cause: string }>(
        client,
        'SELECT txn_id, replica_id, state, cause FROM record_txn_state ORDER BY txn_id'
      ).map((row) => ({
        txnId: row.txn_id,
        replicaId: row.replica_id,
        state: row.state,
        cause: row.cause,
      }))
    );
  });
}
