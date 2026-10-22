// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The steps an exchange takes before its main transfer (ADR s96 §7–§9): a copy behind an epoch catches up, a
// ABOUTME: member whose identity a check refused takes a successor, and of two replicas in one block the later moves.

import { createError, createSuccess } from './errors';
import { chainClashes, commonMarks } from './record-chain';
import type { ApplyReport } from './record-apply';
import type { ExchangeReport, Hello, Peer } from './record-exchange';
import { clashRefusal } from './record-exchange';
import type { SuccessorReason, SuccessorTaken } from './record-successor';
import { receivedMove } from './record-move-receipt';
import { copyReport } from './record-copy-report';
import { REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolError, RbookToolResult } from './types';

/**
 * Two copies at different epochs (ADR s96 §8): the one behind receives everything it lacks from the
 * one ahead, without judging, once the chains agree; nothing moves the other way. The copy ahead
 * must be the authority in one of the two views. The one behind then holds the move to confirm.
 */
export async function catchUp(
  local: Peer,
  remote: Peer,
  ours: Hello,
  theirs: Hello,
  stopped: (error: RbookToolError) => Promise<RbookToolResult<ExchangeReport>>,
  keptOutBy: (side: Peer, report: ApplyReport) => readonly string[] = () => []
): Promise<RbookToolResult<ExchangeReport>> {
  const localAhead = ours.epoch > theirs.epoch;
  const [ahead, behind] = localAhead ? [local, remote] : [remote, local];
  const [aheadHello, behindHello] = localAhead ? [ours, theirs] : [theirs, ours];
  if (
    aheadHello.replicaId !== aheadHello.authority &&
    aheadHello.replicaId !== behindHello.authority
  )
    return createError({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `${behind.name} has not taken the owner copy's latest move, and ${ahead.name} is not the owner's copy in either view, so nothing was exchanged.`,
      suggestion: "Sync the copy that is behind with the owner's copy.",
    });
  const common = commonMarks(ours.marks, theirs.marks);
  const clashes = chainClashes(await local.chains(common), await remote.chains(common));
  const clashed = clashRefusal(ours, theirs, clashes, remote.name, 'nothing was exchanged');
  if (clashed) return stopped(clashed);
  // ADR s96 §8, §11: a copy the copy ahead shows as removed receives nothing new. One it does not
  // know yet, such as a join no recovery saw, takes the move, and its own changes then say who it is.
  if (aheadHello.removed.includes(behindHello.replicaId))
    return createSuccess<ExchangeReport>({
      sent: 0,
      judged: 0,
      received: 0,
      conflicts: 0,
      findings: 0,
      removed: true,
      // s97-m14 (critics, round 2): the copy behind is a removed member, not a copy that is no member.
      removedCopy: localAhead ? 'remote' : 'local',
      digest: { mark: 0, hash: null },
      applied: { authority: null, member: null },
      local: { replicaId: ours.replicaId, marks: ours.marks },
      remote: { replicaId: theirs.replicaId, marks: theirs.marks },
    });
  const applied = await behind.apply(
    await ahead.changesSince(behindHello.marks, { ...behindHello, catchUp: true }),
    { judge: false, catchUp: true }
  );
  if (!applied.success || !applied.data) return createError(applied.error!);
  const after = await behind.hello();
  // s100-m01: a move the copy behind kept out, written in a newer record protocol, did not arrive:
  // there is nothing to confirm until it upgrades, and the sync says why instead. A move that came
  // as a fork of one the copy holds did arrive, and is shown as one.
  const arrived = receivedMove(after, aheadHello);
  const reads = copyReport(behindHello).reads;
  const incompatible = reads !== null && (aheadHello.recordProtocol ?? 1) > reads;
  return createSuccess<ExchangeReport>(
    {
      sent: 0,
      judged: 0,
      received: applied.data.stored,
      conflicts: applied.data.conflicts,
      findings: applied.data.checks,
      removed: false,
      digest: { mark: 0, hash: null },
      applied: { authority: null, member: applied.data },
      local: { replicaId: ours.replicaId, marks: localAhead ? ours.marks : after.marks },
      remote: { replicaId: theirs.replicaId, marks: localAhead ? after.marks : theirs.marks },
      ...(arrived
        ? {
            caughtUp: {
              copy: localAhead ? ('remote' as const) : ('local' as const),
              ...arrived,
              // s97-m10: a copy that confirms the move itself, as a dashboard's referee does, needs no word.
              ...(after.pending === null &&
              after.epoch === aheadHello.epoch &&
              after.authority === aheadHello.authority
                ? { confirmed: true }
                : {}),
            },
          }
        : {}),
    },
    [
      ...(applied.warnings ?? []),
      ...keptOutBy(behind, applied.data),
      ...(!arrived && !applied.data.newerProtocol
        ? [
            `${behind.name} does not report holding the advertised owner's move; unreadable changes may be held back by the sender. Inspect this copy's current owner state and sync again before confirming a move.${incompatible ? " Upgrade that copy: its reported reader is below the owner's write protocol." : ''}`,
          ]
        : []),
    ]
  );
}

/** The first sequence of `replicaId` where two copies' chains differ, below `upTo` where they do. */
async function firstDifference(
  one: Peer,
  other: Peer,
  replicaId: string,
  upTo: number
): Promise<number> {
  let low = 1;
  let high = upTo;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const [a, b] = await Promise.all([
      one.chains({ [replicaId]: middle }),
      other.chains({ [replicaId]: middle }),
    ]);
    if (a[replicaId] !== b[replicaId]) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Why the member must take a successor before the exchange, or null (ADR s96 §7, §9). */
export function memberProblem(
  member: Hello,
  authority: Hello,
  ownClash: boolean
): SuccessorReason | null {
  if (authority.removed.includes(member.replicaId)) return null;
  // A cutoff holds even when a restored/duplicated stream also clashes: its tail is never replayed.
  if (member.replicaId in authority.cuts) return 'cut';
  if (ownClash) return 'slot';
  if (
    member.refusal === REPLICA_ERROR_CODES.RESTORED ||
    member.refusal === REPLICA_ERROR_CODES.NOT_JOINED
  )
    return 'restored';
  if ((authority.marks[member.replicaId] ?? 0) > (member.marks[member.replicaId] ?? 0))
    return 'whole-machine';
  if (authority.unseen.includes(member.replicaId)) return 'unseen';
  return null;
}

/**
 * Put the member's identity right before anything else moves: its changes reach the authority first,
 * except those of its own stream from where it differs, then the authority admits its successor in a
 * fresh block and the member takes it. A member the authority does not know yet is asked again after
 * its changes arrive, since they may hold the old authority's record of its join.
 */
export async function settleIdentity(
  authority: Peer,
  member: Peer,
  authorityHello: Hello,
  memberHello: Hello
): Promise<RbookToolResult<SuccessorTaken | null>> {
  const own = memberHello.replicaId;
  const common = commonMarks(authorityHello.marks, memberHello.marks);
  const clashes =
    own in common
      ? chainClashes(
          await member.chains({ [own]: common[own] }),
          await authority.chains({ [own]: common[own] })
        )
      : [];
  let reason = memberProblem(memberHello, authorityHello, clashes.includes(own));
  const unknown =
    !reason &&
    !authorityHello.members.includes(own) &&
    !authorityHello.removed.includes(own) &&
    memberHello.refusal === null;
  if (!reason && !unknown) return createSuccess(null);
  const divergesFrom =
    reason === 'slot' ? await firstDifference(member, authority, own, common[own]) : undefined;
  const sent = (await member.changesSince(authorityHello.marks, authorityHello)).filter(
    (change) =>
      divergesFrom === undefined || change.replica_id !== own || change.replica_seq < divergesFrom
  );
  const judged = await authority.apply(sent);
  if (!judged.success) return createError(judged.error!);
  const after = await authority.hello();
  if (unknown) reason = memberProblem(memberHello, after, false);
  if (!reason) return createSuccess(null);
  // The applied rows may first prove an unseen join; bind its report before testing a successor.
  await authority.observeHello?.(memberHello);
  const successor = await authority.admitSuccessor({ replicaId: own });
  if (!successor.success || !successor.data) return createError(successor.error!);
  const taken = await member.takeSuccessor({
    successor: successor.data,
    reason,
    // A successful authority read with no prefix means zero received changes.
    authorityReceived: after.marks[own] ?? 0,
    ...(divergesFrom !== undefined ? { divergesFrom } : {}),
    ...(own in after.cuts ? { cut: after.cuts[own] } : {}),
  });
  if (!taken.success || !taken.data) return createError(taken.error!);
  return createSuccess(taken.data);
}

/**
 * One block held by two replicas, as the two copies know them together, the authority's view of a
 * replica winning (ADR s96 §7): the one admitted later renumbers its own creates into a fresh block,
 * the authority itself included. A clash between two replicas neither side is stops the exchange.
 */
export async function settleBlocks(
  authority: Peer,
  member: Peer
): Promise<RbookToolResult<ReadonlyArray<{ readonly replicaId: string; readonly block: number }>>> {
  const moved: Array<{ replicaId: string; block: number }> = [];
  for (let round = 0; round < 4; round += 1) {
    const [authorityHello, memberHello] = await Promise.all([authority.hello(), member.hello()]);
    const blocks = { ...memberHello.blocks, ...authorityHello.blocks };
    blocks[memberHello.replicaId] = memberHello.block;
    const admitted = { ...memberHello.admitted, ...authorityHello.admitted };
    const holders = new Map<number, string[]>();
    for (const [replicaId, block] of Object.entries(blocks))
      holders.set(block, [...(holders.get(block) ?? []), replicaId]);
    const clash = [...holders.entries()].find(([, replicas]) => replicas.length > 1);
    if (!clash) return createSuccess(moved);
    const [block, replicas] = clash;
    const later = [...replicas].sort((a, b) =>
      (admitted[a] ?? '') === (admitted[b] ?? '')
        ? a < b
          ? 1
          : -1
        : (admitted[a] ?? '') < (admitted[b] ?? '')
          ? 1
          : -1
    )[0];
    if (later === authorityHello.replicaId) {
      const reblocked = await authority.reblockSelf();
      if (!reblocked.success || !reblocked.data) return createError(reblocked.error!);
      moved.push({ replicaId: later, block: reblocked.data.block });
      continue;
    }
    if (later === memberHello.replicaId) {
      const successor = await authority.admitSuccessor({ replicaId: later, sameId: true });
      if (!successor.success || !successor.data) return createError(successor.error!);
      const taken = await member.takeSuccessor({
        successor: successor.data,
        reason: 'block',
        authorityReceived: null,
      });
      if (!taken.success) return createError(taken.error!);
      moved.push({ replicaId: later, block: successor.data.block });
      continue;
    }
    return createError(
      clashRefusal(memberHello, authorityHello, [], member.name, 'nothing was exchanged', [
        { block, replicas: [...replicas].sort() },
      ])!
    );
  }
  return createError({
    code: REPLICA_ERROR_CODES.BLOCK_CLASH,
    message: 'Blocks kept clashing after four moves, so nothing was exchanged.',
    suggestion: 'Sync again; if it repeats, tell the owner.',
  });
}
