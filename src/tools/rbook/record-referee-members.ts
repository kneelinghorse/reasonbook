// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Which present members a re-share cannot carry from proven former dashboard referee terms.
// ABOUTME: An invite needs former-term evidence even without copies; each uncut admission must have that provenance too.
import type { RbookDatabaseClient } from './client';
import { listMembers, OWNER_MEMBER, type MemberView } from './record-membership';
import { mergeContext, termReach, type LoggedChange } from './record-standing';

/** The caller proves which former authority replicas ran on this dashboard; a record alone cannot. */
export function membersOutsideRefereeTerms(
  client: RbookDatabaseClient,
  formerRefereeReplicaIds: readonly string[]
): MemberView[] {
  const ctx = mergeContext(client);
  const former = new Set(formerRefereeReplicaIds);
  const people = new Set<string>();
  const copies = new Map<string, string>();
  for (const term of ctx.terms) {
    if (term.replicaId === ctx.authority || !former.has(term.replicaId)) continue;
    const read = client.getMany<Pick<LoggedChange, 'kind' | 'entity_id' | 'value'>>(
      "SELECT kind, entity_id, value FROM record_changes WHERE replica_id = ? AND kind IN ('member', 'replica_joined') AND replica_seq <= ? ORDER BY replica_seq",
      [term.replicaId, termReach(ctx, term)]
    );
    if (!read.success)
      throw new Error(read.error?.message ?? 'former referee admissions could not be read');
    for (const change of read.data ?? []) {
      const value = JSON.parse(change.value ?? '{}') as { member?: string; role?: string };
      if (change.kind === 'member' && value.role !== 'removed')
        people.add(String(change.entity_id));
      if (change.kind === 'replica_joined')
        copies.set(String(change.entity_id), String(value.member ?? ''));
    }
  }
  return listMembers(client).filter(
    (member) =>
      member.memberId !== OWNER_MEMBER &&
      member.role !== 'removed' &&
      (!people.has(member.memberId) ||
        member.replicas.some(
          (replica) =>
            ctx.members.get(replica.replicaId)?.cut === undefined &&
            copies.get(replica.replicaId) !== member.memberId
        ))
  );
}
