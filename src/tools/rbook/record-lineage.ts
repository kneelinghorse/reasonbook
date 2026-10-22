// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A copy's admitted predecessor chain, shared by dashboard delivery and referee intake.
// ABOUTME: Cycles and excessive chains stop at the same bound on both sides of the transport.

import type { MergeContext } from './record-standing';

/** The replicas a copy succeeded, oldest last: its changes may carry their ids (ADR s96 §9). */
export function predecessorsOf(ctx: Pick<MergeContext, 'members'>, replicaId: string): string[] {
  const found: string[] = [];
  let at = ctx.members.get(replicaId)?.previous;
  while (at && !found.includes(at) && found.length < 64) {
    found.push(at);
    at = ctx.members.get(at)?.previous;
  }
  return found;
}
