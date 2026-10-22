// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The host's carried member-account bindings and former referee identity contract for a handover in.
// ABOUTME: Validate exact identities, preserve removed bindings, and compare immutable normalized metadata on retries.
import type { RbookDatabaseClient } from '../tools/rbook/client';
import { listMembers, OWNER_MEMBER } from '../tools/rbook/record-membership';
import { membersOutsideRefereeTerms } from '../tools/rbook/record-referee-members';
import { mergeContext } from '../tools/rbook/record-standing';

export interface CreateRefereeInput {
  readonly copyFile: string;
  readonly ownerAccountId: string;
  /** Authenticated host history for this project, including removed members; never inferred by name. */
  readonly members?: readonly { readonly memberId: string; readonly accountId: string }[];
  /** Authority replicas the host actually ran as this project's referee, not all recorded heads. */
  readonly formerRefereeReplicaIds?: readonly string[];
}

export interface CarriedMembers {
  readonly members: readonly { readonly memberId: string; readonly accountId: string }[];
  readonly formerRefereeReplicaIds: readonly string[];
}

/** Malformed caller input refuses before any file or registry is created. */
export function carriedMembers(input: CreateRefereeInput): CarriedMembers {
  if (typeof input?.ownerAccountId !== 'string' || !input.ownerAccountId.trim())
    throw new Error('createReferee needs the owner account.');
  if (input.members !== undefined && !Array.isArray(input.members))
    throw new Error('The carried members must be a list of member and account ids.');
  if (input.formerRefereeReplicaIds !== undefined && !Array.isArray(input.formerRefereeReplicaIds))
    throw new Error('The former referee replica ids must be a list.');
  const members = new Map<string, string>();
  const accounts = new Set<string>();
  for (const row of input.members ?? []) {
    if (
      !row ||
      typeof row.memberId !== 'string' ||
      !row.memberId.trim() ||
      typeof row.accountId !== 'string' ||
      !row.accountId.trim()
    )
      throw new Error('Each carried member needs a nonempty member id and account id.');
    if (members.has(row.memberId) || accounts.has(row.accountId))
      throw new Error('Carried member ids and account ids must each be unique.');
    if ((row.memberId === OWNER_MEMBER) !== (row.accountId === input.ownerAccountId))
      throw new Error('Only the owner member can be bound to the owner account.');
    members.set(row.memberId, row.accountId);
    accounts.add(row.accountId);
  }
  members.set(OWNER_MEMBER, input.ownerAccountId);
  const former = input.formerRefereeReplicaIds ?? [];
  if (
    former.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(former).size !== former.length
  )
    throw new Error('Former referee replica ids must be nonempty and unique.');
  return {
    members: [...members]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([memberId, accountId]) => ({ memberId, accountId })),
    formerRefereeReplicaIds: [...former].sort(),
  };
}

/** The metadata is well formed; the uploaded record now proves which identities it can bind. */
export function carriedMembersProblem(
  client: RbookDatabaseClient,
  carried: CarriedMembers
): string | null {
  const ctx = mergeContext(client);
  const former = new Set(
    ctx.terms.filter((term) => term.replicaId !== ctx.authority).map((term) => term.replicaId)
  );
  for (const id of carried.formerRefereeReplicaIds)
    if (!former.has(id))
      return `${id} is not a former authority replica in this project's applied record`;
  const members = listMembers(client);
  const known = new Set(members.map((member) => member.memberId));
  for (const row of carried.members)
    if (!known.has(row.memberId))
      return `carried member ${row.memberId} is not in this project's record`;
  const bound = new Set(carried.members.map((row) => row.memberId));
  const missing = members.filter(
    (member) => member.role !== 'removed' && !bound.has(member.memberId)
  );
  if (missing.length)
    return `the dashboard has no carried account binding for ${missing.map((member) => member.name).join(', ')}`;
  const outside = membersOutsideRefereeTerms(client, carried.formerRefereeReplicaIds);
  if (outside.length)
    return `it is shared directly with ${outside.map((member) => member.name).join(', ')}, whose present membership or uncut copies were not admitted during a proven former referee term`;
  return null;
}
