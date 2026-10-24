// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Preview or record the authority's permanent cutoff on one replica without removing its person.
// ABOUTME: Cutoffs are captured under the write lock and carried on every later member change.
import type { RbookDatabaseClient } from './client';
import { replicaMarks } from './record-apply';
import { canonicalJson } from './record-capture';
import { recordOwnChanges } from './record-changes';
import { dashboardName, isActiveDashboardRoute } from './record-dashboard-route';
import { mergeSetAsideCuts, setAsideCut, type ReplicaCuts } from './record-member-cuts';
import { listMembers } from './record-membership';
import { routeTo } from './record-peers';
import { mergeContext } from './record-standing';
import { REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';
import type { RbookToolResult } from './types';

export interface SetAsideReport {
  readonly memberId: string;
  readonly memberName: string;
  readonly replicaId: string;
  readonly block: number;
  readonly cut: number;
  readonly setAsideCuts: ReplicaCuts;
  readonly lastExchangeAt: string | null;
  readonly lastCallAt: string | null;
  readonly dryRun: boolean;
  readonly alreadySetAside: boolean;
}

/** Read observations without migration; a call report never claims a completed exchange. */
function lastObservations(
  client: RbookDatabaseClient,
  replicaId: string
): Pick<SetAsideReport, 'lastExchangeAt' | 'lastCallAt'> {
  const table = client.getOne(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'record_peers'"
  );
  if (!table.success)
    throw new Error(table.error?.message ?? 'The peer table could not be inspected.');
  if (!table.data) return { lastExchangeAt: null, lastCallAt: null };
  const read = client.getOne<{ last_ok_at?: string | null; last_call_at?: string | null }>(
    'SELECT * FROM record_peers WHERE replica_id = ?',
    [replicaId]
  );
  if (!read.success)
    throw new Error(read.error?.message ?? 'The peer observations could not be read.');
  return {
    lastExchangeAt: read.data?.last_ok_at ?? null,
    lastCallAt: read.data?.last_call_at ?? null,
  };
}

export function setAsideReplica(
  client: RbookDatabaseClient,
  input: { readonly replicaId: string; readonly dryRun?: boolean }
): RbookToolResult<SetAsideReport> {
  return client.writeTransaction(() => {
    if (
      typeof input?.replicaId !== 'string' ||
      !input.replicaId ||
      (input.dryRun !== undefined && typeof input.dryRun !== 'boolean')
    )
      throw new ReplicaRefusal({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: 'Set aside needs one replica id and an optional boolean dryRun.',
        suggestion:
          'Choose a replica from the member list, preview it, then apply with dryRun: false.',
      });
    const ctx = mergeContext(client);
    if (ctx.ownReplica !== ctx.authority) {
      const route = routeTo(client, ctx.authority);
      throw new ReplicaRefusal({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: isActiveDashboardRoute(route)
          ? `This project is refereed by ${dashboardName(route)}, which cannot set a copy aside yet. The copy only delays protocol 2 and keeps its data.`
          : 'Only the current authority copy can set aside another copy.',
        suggestion: isActiveDashboardRoute(route)
          ? "Leave an active owner's other copy in place. For a non-owner member who has left, the owner can remove that member on the sharing page, cutting their copies."
          : "Run the set-aside step on the current owner's copy.",
      });
    }
    if (input.replicaId === ctx.ownReplica)
      throw new ReplicaRefusal({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: 'This copy cannot set itself aside.',
        suggestion: 'Choose the other copy that is gone, after checking its replica id.',
      });
    const replica = ctx.members.get(input.replicaId);
    const member = listMembers(client).find((person) =>
      person.replicas.some((copy) => copy.replicaId === input.replicaId)
    );
    if (!replica || !member)
      throw new ReplicaRefusal({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `Replica ${input.replicaId} has not been admitted for a member.`,
        suggestion: 'List the members and choose an admitted replica id.',
      });
    if (member.role === 'removed')
      throw new ReplicaRefusal({
        code: REPLICA_ERROR_CODES.WRITE_REFUSED,
        message: `${member.name} was removed, so this copy cannot be set aside separately.`,
        suggestion:
          'Re-add the member first if they should participate, then preview the copy to set aside.',
      });
    const held = setAsideCut(ctx, input.replicaId);
    const cut = held ?? replicaMarks(client)[input.replicaId] ?? 0;
    const cuts = mergeSetAsideCuts(ctx.setAsideCuts.get(member.memberId) ?? {}, {
      [input.replicaId]: cut,
    });
    const report: SetAsideReport = {
      memberId: member.memberId,
      memberName: member.name,
      replicaId: input.replicaId,
      block: replica.block,
      cut,
      setAsideCuts: cuts,
      ...lastObservations(client, input.replicaId),
      dryRun: input.dryRun !== false,
      alreadySetAside: held !== undefined,
    };
    if (!report.dryRun && !report.alreadySetAside)
      recordOwnChanges(client, [
        {
          kind: 'member',
          entity: 'member',
          entityId: member.memberId,
          field: null,
          value: canonicalJson({ name: member.name, role: member.role, setAsideCuts: cuts }),
        },
      ]);
    return report;
  });
}
