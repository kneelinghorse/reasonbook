// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A hosted project's members by dashboard account (s97-m09, design §R1, D4): invite binds an account to a member,
// ABOUTME: a name another member goes by is refused, and remove records the cuts; never callable through peer.

import { validAuthorName } from '../intelligence/user-author';
import type { RbookDatabaseClient } from '../tools/rbook/client';
import { createError, createSuccess } from '../tools/rbook/errors';
import {
  INVITE_ROLES,
  inviteMember,
  listMembers,
  memberNamed,
  OWNER_MEMBER,
  readsAs,
  removeMember,
  setMemberRole,
} from '../tools/rbook/record-membership';
import { mergeContext } from '../tools/rbook/record-standing';
import type { RbookToolResult } from '../tools/rbook/types';
import { accountsByMember, bindAccount, memberOfAccount } from './accounts';
import { REFEREE_ERROR_CODES, refuse } from './codes';
import { withReferee, type RefereeLocation, type RefereeOutcome } from './open';

export interface HostedMember {
  readonly memberId: string;
  /** The dashboard account the member is; null for one no account was bound to. */
  readonly accountId: string | null;
  readonly name: string;
  readonly role: string;
  /** The member's copies, the referee's own replica left out. */
  readonly replicas: ReadonlyArray<{ readonly replicaId: string; readonly block: number }>;
}

function hosted(client: RbookDatabaseClient): HostedMember[] {
  const accounts = accountsByMember(client);
  const own = mergeContext(client).ownReplica;
  return listMembers(client).map((member) => ({
    memberId: member.memberId,
    accountId: accounts.get(member.memberId) ?? null,
    name: member.name,
    role: member.role,
    replicas: member.replicas.filter((replica) => replica.replicaId !== own),
  }));
}

const ready = <T>(joining: unknown): RbookToolResult<T> | null =>
  joining
    ? refuse<T>({
        code: REFEREE_ERROR_CODES.NOT_READY,
        message: "This project's referee has not finished joining.",
        suggestion: "Finish the handover in from the owner's copy first.",
      })
    : null;

/**
 * Invite an account (D4): a direct share as it is made, a team share as it is accepted. The name is
 * the account's username and the role editor or owner. An account already a member answers with
 * its member; a name another member goes by, the owner's included, is refused (fact 25).
 */
export function invite(
  location: RefereeLocation,
  input: { readonly accountId: string; readonly name: string; readonly role?: string }
): Promise<RefereeOutcome<HostedMember & { readonly invited: boolean }>> {
  return withReferee(location, ({ client, joining }) => {
    const unready = ready<HostedMember & { readonly invited: boolean }>(joining);
    if (unready) return unready;
    if (typeof input?.accountId !== 'string' || !input.accountId || typeof input.name !== 'string')
      return refuse({
        code: REFEREE_ERROR_CODES.MALFORMED,
        message: 'An invite names an account and its username.',
        suggestion: 'Pass accountId and name.',
      });
    const role = input.role ?? 'editor';
    if (!(INVITE_ROLES as readonly string[]).includes(role))
      return refuse({
        code: REFEREE_ERROR_CODES.MALFORMED,
        message: `A member is an editor or an owner, not a ${role}; a read-only share is a dashboard viewer, with no copy.`,
        suggestion: 'Invite editors and owners only; show viewers the project on the dashboard.',
      });
    const name = validAuthorName(input.name);
    const bound = memberOfAccount(client, input.accountId);
    if (bound) {
      const member = listMembers(client).find((known) => known.memberId === bound);
      if (member && member.role !== 'removed')
        return createSuccess({
          ...hosted(client).find((known) => known.memberId === bound)!,
          invited: false,
        });
      // A removed member shared with again is re-added under the name it had (ADR s96 §8).
      const readded = inviteMember(client, { name: member?.name ?? input.name, role });
      if (!readded.success) return createError(readded.error!);
      return createSuccess({
        ...hosted(client).find((known) => known.memberId === bound)!,
        invited: true,
      });
    }
    // A name a member goes by, or one that reads the same as a present member's, is taken: both
    // answer the published code, as the dashboard keeps it (its s62-m06 ask).
    const taken = name
      ? (memberNamed(client, name) ??
        listMembers(client).find(
          (member) => member.role !== 'removed' && readsAs(member.name) === readsAs(name)
        ) ??
        null)
      : null;
    if (taken)
      return refuse({
        code: REFEREE_ERROR_CODES.NAME_TAKEN,
        message: `${taken.name} is already ${taken.memberId === OWNER_MEMBER ? "the owner's" : "another member's"} name in this project, so this account was not added.`,
        suggestion:
          'Share with the account under a name that tells it apart, such as one with a last initial.',
      });
    // The member and its account are written together, so a crash between them leaves neither.
    let refused: RbookToolResult<unknown> | null = null;
    const added = client.writeTransaction(() => {
      const invited = inviteMember(client, { name: input.name, role });
      if (!invited.success || !invited.data) {
        refused = invited;
        throw new Error('the invite was refused');
      }
      bindAccount(client, invited.data.memberId, input.accountId);
      return invited.data.memberId;
    });
    if (refused) return createError((refused as RbookToolResult<unknown>).error!);
    if (!added.success || !added.data) return createError(added.error!);
    return createSuccess({
      ...hosted(client).find((known) => known.memberId === added.data)!,
      invited: true,
    });
  });
}

/** Remove an account's member (D4): the cuts are recorded, and its copies receive nothing new (ADR s96 §8). */
export function remove(
  location: RefereeLocation,
  input: { readonly accountId: string }
): Promise<RefereeOutcome<HostedMember & { readonly cuts: Readonly<Record<string, number>> }>> {
  return withReferee(location, ({ client, joining }) => {
    const unready = ready<HostedMember & { readonly cuts: Readonly<Record<string, number>> }>(
      joining
    );
    if (unready) return unready;
    const bound =
      typeof input?.accountId === 'string' ? memberOfAccount(client, input.accountId) : null;
    const member = bound
      ? listMembers(client).find((known) => known.memberId === bound)
      : undefined;
    if (!member)
      return refuse({
        code: REFEREE_ERROR_CODES.NOT_A_MEMBER,
        message: 'That account is no member of this project.',
        suggestion: 'List the members with members(), and remove one of theirs.',
      });
    const removed = removeMember(client, member.name);
    if (!removed.success || !removed.data) return createError(removed.error!);
    return createSuccess({
      ...hosted(client).find((known) => known.memberId === bound)!,
      cuts: removed.data.cuts,
    });
  });
}

/**
 * Change an account's member's role (D4, s97-m11): an editor made an owner, or back. The owner's own
 * role never changes, and a removed member is invited again instead.
 */
export function setRole(
  location: RefereeLocation,
  input: { readonly accountId: string; readonly role: string }
): Promise<RefereeOutcome<HostedMember>> {
  return withReferee(location, ({ client, joining }) => {
    const unready = ready<HostedMember>(joining);
    if (unready) return unready;
    const bound =
      typeof input?.accountId === 'string' ? memberOfAccount(client, input.accountId) : null;
    const member = bound
      ? listMembers(client).find((known) => known.memberId === bound)
      : undefined;
    if (!member)
      return refuse({
        code: REFEREE_ERROR_CODES.NOT_A_MEMBER,
        message: 'That account is no member of this project.',
        suggestion: 'List the members with members(), and change the role of one of theirs.',
      });
    const changed = setMemberRole(client, member.name, String(input.role));
    if (!changed.success) return createError(changed.error!);
    return createSuccess(hosted(client).find((known) => known.memberId === bound)!);
  });
}

/** Every member, the owner first, with the account each is and its copies. */
export function members(location: RefereeLocation): Promise<RefereeOutcome<HostedMember[]>> {
  return withReferee(
    location,
    ({ client, joining }) => ready<HostedMember[]>(joining) ?? createSuccess(hosted(client))
  );
}
