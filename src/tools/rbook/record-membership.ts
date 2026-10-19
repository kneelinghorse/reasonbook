// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Who belongs to a shared record (ADR s96 §8): the owner the baseline names, each member the authority invited
// ABOUTME: and the replicas that joined for them, each with its block; only the authority invites.

import { monotonicFactory } from 'ulid';
import { validAuthorName } from '../../intelligence/user-author';
import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { decideTransactions, replicaMarks } from './record-apply';
import { forgetPeers } from './record-peers';
import { canonicalJson } from './record-capture';
import { recordOwnChanges } from './record-changes';
import { isRecordedStore } from './record-recording';
import {
  BASELINE_QUERY,
  mergeContext,
  REPLICA_ENTITY,
  termReach,
  type LoggedChange,
} from './record-standing';
import { REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolResult } from './types';

const mintId = monotonicFactory();

/** The entity an invite names: the person, under an id the authority mints. */
export const MEMBER_ENTITY = 'member';
/** The owner's member id: the owner is the person the baseline names, never invited. */
export const OWNER_MEMBER = 'owner';

/** The roles an invite gives under write access; a read-only member waits for proposals (s96-m06). */
export const INVITE_ROLES = ['editor', 'owner'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

export interface MemberView {
  readonly memberId: string;
  readonly name: string;
  readonly role: string;
  readonly replicas: ReadonlyArray<{ readonly replicaId: string; readonly block: number }>;
}

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

const json = (text: string | null): Record<string, unknown> =>
  text === null ? {} : (JSON.parse(text) as Record<string, unknown>);

/** Every member, the owner first, as each authority's term records them (ADR s96 §8). */
export function listMembers(client: RbookDatabaseClient): MemberView[] {
  const ctx = mergeContext(client);
  const [baseline] = rows<LoggedChange>(client, BASELINE_QUERY);
  const members = new Map<string, { name: string; role: string; replicas: Map<string, number> }>([
    [
      OWNER_MEMBER,
      {
        name: String(json(baseline?.value ?? null).owner ?? 'the owner'),
        role: 'owner',
        replicas: new Map([[ctx.terms[0].replicaId, 0]]),
      },
    ],
  ]);
  const changes: LoggedChange[] = [];
  for (const term of ctx.terms) {
    // A recovery's new copy is the owner's; its admission is the authority change itself.
    if (term.change) members.get(OWNER_MEMBER)!.replicas.set(term.replicaId, term.block);
    changes.push(
      ...rows<LoggedChange>(
        client,
        "SELECT * FROM record_changes WHERE replica_id = ? AND kind IN ('member', 'replica_joined') AND replica_seq <= ? ORDER BY replica_seq",
        [term.replicaId, termReach(ctx, term)]
      )
    );
  }
  for (const change of changes) {
    const value = json(change.value);
    if (change.kind === 'member') {
      const known = members.get(String(change.entity_id));
      members.set(String(change.entity_id), {
        name: String(value.name ?? known?.name ?? ''),
        role: String(value.role ?? known?.role ?? 'editor'),
        replicas: known?.replicas ?? new Map(),
      });
    } else {
      const memberId = String(value.member ?? '');
      const member = members.get(memberId);
      if (member) member.replicas.set(String(change.entity_id), Number(value.block));
    }
  }
  return [...members.entries()].map(([memberId, member]) => ({
    memberId,
    name: member.name,
    role: member.role,
    replicas: [...member.replicas.entries()].map(([replicaId, block]) => ({ replicaId, block })),
  }));
}

/**
 * How a name reads to a person: its compatibility forms folded, its case ignored, and the joiners
 * and presentation selectors the name rule lets a name keep left out, since they show little or
 * nothing (s96-m13, #671).
 */
export function readsAs(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/[\p{Join_Control}\p{Variation_Selector}]/gu, '')
    .toLocaleLowerCase('en-US');
}

/** The member a name names, or null; names compare as the name rule keeps them. */
export function memberNamed(client: RbookDatabaseClient, name: string): MemberView | null {
  const wanted = validAuthorName(name);
  return listMembers(client).find((member) => member.name === wanted) ?? null;
}

/** A refusal, its remedy named where it is authored. */
function refuse<T>(refusal: {
  readonly code: string;
  readonly message: string;
  readonly suggestion: string;
}): RbookToolResult<T> {
  return createError<T>({ ...refusal });
}

/**
 * Invite a person to a shared record, from the authority's copy: a `member` change naming them and
 * their role (ADR s96 §8). Under write access the read-only role is refused until proposals exist.
 * Inviting someone already a member answers with that member.
 */
export function inviteMember(
  client: RbookDatabaseClient,
  input: { readonly name: string; readonly role?: string }
): RbookToolResult<MemberView & { readonly invited: boolean; readonly accepted?: number }> {
  const ctx = mergeContext(client);
  if (ctx.ownReplica !== ctx.authority)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: "Only the owner's copy invites a member.",
      suggestion: "Invite from the owner's copy.",
    });
  const role = input.role ?? 'editor';
  if (!(INVITE_ROLES as readonly string[]).includes(role))
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `A shared record gives write access, so an invite cannot make a ${role}: a read-only member waits for proposals, which are not built.`,
      suggestion: 'Invite the person as an editor, who writes everything but the owner-only kinds.',
    });
  const name = validAuthorName(input.name);
  if (!name)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'A member is named as an author is: one line of at most 80 characters with a visible one, and no hidden or control characters.',
      suggestion:
        'Invite the person by the name their records will carry, such as their first name.',
    });
  const known = memberNamed(client, name);
  if (known && known.role !== 'removed') return createSuccess({ ...known, invited: false });
  if (known) return readmit(client, known, role);
  // s96-m13 (#671): two members whose names read the same, case and compatibility forms aside,
  // could not be told apart in the record. Lookalikes across scripts are an admitted hole.
  const alike = listMembers(client).find(
    (member) => member.role !== 'removed' && readsAs(member.name) === readsAs(name)
  );
  if (alike)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${name} reads the same as ${alike.name}, who is a member already, so the two could not be told apart in the record.`,
      suggestion: `Invite them under a name that tells them apart, such as one with a last initial; ${alike.name} is the member already.`,
    });
  const memberId = mintId();
  const done = client.writeTransaction(() =>
    recordOwnChanges(client, [
      {
        kind: 'member',
        entity: MEMBER_ENTITY,
        entityId: memberId,
        field: null,
        value: canonicalJson({ name, role }),
      },
    ])
  );
  if (!done.success) return createError(done.error!);
  return createSuccess({ memberId, name, role, replicas: [], invited: true });
}

/**
 * The block a new replica takes: above every block this record has ever issued, by an admission, a
 * recovery or a renumber, whatever its standing (ADR s96 §3).
 */
export function freshBlock(client: RbookDatabaseClient): number {
  const [highest] = rows<{ block: number | null }>(
    client,
    `SELECT max(CAST(json_extract(value, '$.block') AS INTEGER)) AS block FROM record_changes
      WHERE entity = ? AND kind IN ('replica_joined', 'authority', 'renumber')`,
    [REPLICA_ENTITY]
  );
  return Math.max(0, highest?.block ?? 0) + 1;
}

/**
 * A copy of a shared record that is not the authority's (design §s96-m13 item 3): for its whole life it
 * never registers with the dashboard, never names the dashboard project or its owner, and never
 * uploads; the owner's copy does. A copy whose record cannot be read counts as a member's, so it stays
 * quiet rather than uploading. An unshared store is no copy, and registers as it always has.
 */
export function isMembersCopy(client: RbookDatabaseClient): boolean {
  if (!isRecordedStore(client)) return false;
  try {
    const ctx = mergeContext(client);
    return ctx.ownReplica !== ctx.authority;
  } catch (error) {
    // Fails closed, and says so: a copy whose owner cannot be read never reaches the dashboard.
    process.stderr.write(
      `[SHARED] Could not tell whose copy ${client.path} is, so it is treated as a member's: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return true;
  }
}

function quarantinedOf(client: RbookDatabaseClient, member: MemberView): string[] {
  const replicas = new Set(member.replicas.map((replica) => replica.replicaId));
  return rows<{ txn_id: string; replica_id: string }>(
    client,
    "SELECT txn_id, replica_id FROM record_txn_state WHERE state = 'quarantined' ORDER BY txn_id"
  )
    .filter((txn) => replicas.has(txn.replica_id))
    .map((txn) => txn.txn_id);
}

/** A re-add (ADR s96 §8): the member's role back, and its quarantined changes accepted from now. */
function readmit(
  client: RbookDatabaseClient,
  member: MemberView,
  role: string
): RbookToolResult<MemberView & { readonly invited: boolean; readonly accepted: number }> {
  const done = client.writeTransaction(() =>
    recordOwnChanges(client, [
      {
        kind: 'member',
        entity: MEMBER_ENTITY,
        entityId: member.memberId,
        field: null,
        value: canonicalJson({ name: member.name, role }),
      },
    ])
  );
  if (!done.success) return createError(done.error!);
  const decided = decideTransactions(client, quarantinedOf(client, member), 'accepted', 're-added');
  if (!decided.success) return createError(decided.error!);
  return createSuccess({ ...member, role, invited: true, accepted: decided.data ?? 0 });
}

/**
 * s97-m11 (design §R1): change a member's role, from the authority's copy: an editor made an owner, or
 * back. The owner's own role never changes, a removed member is invited again instead, and the role is
 * one an invite gives.
 */
export function setMemberRole(
  client: RbookDatabaseClient,
  name: string,
  role: string
): RbookToolResult<MemberView> {
  const ctx = mergeContext(client);
  if (ctx.ownReplica !== ctx.authority)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: "Only the owner's copy changes a member's role.",
      suggestion: "Change the role from the owner's copy.",
    });
  if (!(INVITE_ROLES as readonly string[]).includes(role))
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `A shared record gives write access, so no member can be a ${role}: a member is an editor or an owner.`,
      suggestion: 'Name editor or owner.',
    });
  const member = memberNamed(client, name);
  if (!member)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${name} is not a member of this project.`,
      suggestion: 'List the members with rbook_project(action="members").',
    });
  if (member.memberId === OWNER_MEMBER)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        "The owner's role does not change: the owner is the person the project was shared by.",
      suggestion:
        "Make another member an owner instead, if they should edit the project's identity.",
    });
  if (member.role === 'removed')
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${member.name} was removed, so they hold no role to change.`,
      suggestion: 'Invite them again with the role they should have.',
    });
  if (member.role === role) return createSuccess(member);
  const done = client.writeTransaction(() =>
    recordOwnChanges(client, [
      {
        kind: 'member',
        entity: MEMBER_ENTITY,
        entityId: member.memberId,
        field: null,
        value: canonicalJson({ name: member.name, role }),
      },
    ])
  );
  if (!done.success) return createError(done.error!);
  return createSuccess({ ...member, role });
}

/**
 * Remove a member, from the authority's copy (ADR s96 §8): a member change with a cut for each of its
 * replicas, at what this copy holds of each. Its later changes are quarantined until a re-add or a
 * refusal decides them, and it receives nothing new. What its copy holds stays with it (ADR §11).
 */
export function removeMember(
  client: RbookDatabaseClient,
  name: string
): RbookToolResult<MemberView & { readonly cuts: Readonly<Record<string, number>> }> {
  const ctx = mergeContext(client);
  if (ctx.ownReplica !== ctx.authority)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: "Only the owner's copy removes a member.",
      suggestion: "Remove the member from the owner's copy.",
    });
  const member = memberNamed(client, name);
  if (!member || member.memberId === OWNER_MEMBER)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: member
        ? "The owner cannot be removed from the owner's record."
        : `${name} is not a member of this project.`,
      suggestion: 'List the members with rbook_project(action="members").',
    });
  if (member.role === 'removed') return createSuccess({ ...member, cuts: {} });
  const marks = replicaMarks(client);
  const cuts = Object.fromEntries(
    member.replicas.map((replica) => [replica.replicaId, marks[replica.replicaId] ?? 0])
  );
  const done = client.writeTransaction(() =>
    recordOwnChanges(client, [
      {
        kind: 'member',
        entity: MEMBER_ENTITY,
        entityId: member.memberId,
        field: null,
        value: canonicalJson({ name: member.name, role: 'removed', cuts }),
      },
    ])
  );
  if (!done.success) return createError(done.error!);
  // A removed member's copies are synced with no more, so their routes go too (ADR s96 §8).
  forgetPeers(client, Object.keys(cuts));
  return createSuccess({ ...member, role: 'removed', cuts });
}
