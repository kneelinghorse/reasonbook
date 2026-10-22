// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Decode peer request positions and derive the authenticated caller standing.
// ABOUTME: Preserve existing input rules while keeping the public dispatcher within its module bound.
import type { RbookDatabaseClient } from '../tools/rbook/client';
import type { RbookToolResult } from '../tools/rbook/types';
import { mergeContext, type LoggedChange, type MergeContext } from '../tools/rbook/record-standing';
import { accountOfReplica, accountsByMember } from './accounts';
import { REFEREE_ERROR_CODES, refuse } from './codes';
import type { Caller } from './peer';

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const malformed = <T>(what: string): RbookToolResult<T> =>
  refuse<T>({
    code: REFEREE_ERROR_CODES.MALFORMED,
    message: `The request is not well formed: ${what}.`,
    suggestion: 'Send the request as a Reasonbook release writes it.',
  });

/** Marks or chain positions: an object of replica ids to whole numbers. */
/**
 * s97-m10 (design §R2): a changesSince asked a page at a time names `{ marks, maxBytes }`; one that
 * names the marks alone takes the whole stream, as 4.1.0's wire asks.
 */
export function pageAsked(
  params: unknown
): { readonly marks: unknown; readonly maxBytes: number } | null {
  const body = object(params);
  // At least a page of a mebibyte, so a caller asking for tiny pages cannot make each one rescan
  // the whole log for one transaction (critics, round 1).
  return typeof body.maxBytes === 'number' && Number.isFinite(body.maxBytes) && body.maxBytes > 0
    ? { marks: body.marks, maxBytes: Math.max(body.maxBytes, MIN_PAGE_BYTES) }
    : null;
}

/** The least a page of the stream holds, whatever a caller asks. */
export const MIN_PAGE_BYTES = 1024 * 1024;

/** The marks a page served, from the marks it was asked from: each replica's last change in it. */
export function servedThrough(
  since: Readonly<Record<string, number>>,
  page: readonly LoggedChange[]
): Record<string, number> {
  const served = { ...since };
  for (const change of page)
    served[change.replica_id] = Math.max(served[change.replica_id] ?? 0, change.replica_seq);
  return served;
}

export function marks(value: unknown): Record<string, number> | null {
  const held = object(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.values(held).every(
    (seq) => typeof seq === 'number' && Number.isInteger(seq) && seq >= 0
  )
    ? (held as Record<string, number>)
    : null;
}

export interface Standing {
  readonly ctx: MergeContext;
  /** The caller's replica is bound to the caller's account. */
  readonly bound: boolean;
  readonly removed: boolean;
  /** The outgoing authority relaying to the referee while the referee is still its member. */
  readonly relay: boolean;
}

export function standingOf(client: RbookDatabaseClient, caller: Caller): Standing {
  const ctx = mergeContext(client);
  const account = accountOfReplica(ctx, accountsByMember(client), caller.replicaId);
  const bound = account !== null && account === caller.accountId;
  return {
    ctx,
    bound,
    removed: ctx.members.get(caller.replicaId)?.role === 'removed',
    relay: bound && ctx.ownReplica !== ctx.authority && caller.replicaId === ctx.authority,
  };
}
