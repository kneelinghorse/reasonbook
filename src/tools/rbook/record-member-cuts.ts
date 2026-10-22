// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Permanent per-person replica cutoffs stay separate from temporary member-removal cuts.
// ABOUTME: Every projection combines them monotonically and every later member write carries them.
import type { MergeContext } from './record-standing';

export type ReplicaCuts = Readonly<Record<string, number>>;

/** A later member change cannot raise or erase a permanent cutoff it already recorded. */
export function mergeSetAsideCuts(held: ReplicaCuts, added: unknown): ReplicaCuts {
  if (added === undefined) return held;
  if (!added || typeof added !== 'object' || Array.isArray(added))
    throw new Error('A member setAsideCuts value must be a replica-to-sequence object.');
  const cuts = new Map(Object.entries(held));
  for (const [replica, cut] of Object.entries(added)) {
    if (!replica || !Number.isSafeInteger(cut) || (cut as number) < 0)
      throw new Error('A permanent replica cutoff must be a nonnegative safe integer.');
    cuts.set(replica, Math.min(cuts.get(replica) ?? Infinity, cut as number));
  }
  return Object.fromEntries(cuts);
}

/** Payload carried on each later change of a person; old records without any cut keep their shape. */
export function carriedSetAsideCuts(
  ctx: MergeContext,
  memberId: string
): {
  readonly setAsideCuts?: ReplicaCuts;
} {
  const cuts = ctx.setAsideCuts.get(memberId);
  return cuts && Object.keys(cuts).length ? { setAsideCuts: cuts } : {};
}

/** The permanent cutoff for a replica, independently of its member's current role. */
export function setAsideCut(ctx: MergeContext, replicaId: string): number | undefined {
  const member = ctx.members.get(replicaId);
  const person = member?.member ?? (member?.role === 'owner' ? 'owner' : undefined);
  const cuts = person ? ctx.setAsideCuts.get(person) : undefined;
  return cuts && Object.prototype.hasOwnProperty.call(cuts, replicaId)
    ? cuts[replicaId]
    : undefined;
}
