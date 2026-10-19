// SPDX-License-Identifier: Apache-2.0
// ABOUTME: One exchange between two copies of a shared record (ADR s96 §7), whatever carries it: the handshake, the
// ABOUTME: chain and block checks, then the member's changes to the authority and the authority's stream back.

import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { changesSince, replicaMarks, type ApplyReport } from './record-apply';
import { PROTOCOL_VERSION } from './record-changes';
import { applyAndEmbed } from './record-apply-embed';
import { chainClashes, chainsAt, commonMarks, knownBlocks } from './record-chain';
import { catchUp, settleBlocks, settleIdentity } from './record-exchange-steps';
import { recordExchangeFailed } from './record-peers';
import { mergeContext, type LoggedChange } from './record-standing';
import { admitSuccessor } from './record-admit-successor';
import {
  reblockSelf,
  takeSuccessor,
  type Successor,
  type SuccessorReason,
  type SuccessorTaken,
} from './record-successor';
import { replicaWriteRefusal } from './replica-check';
import { recordedProjectId, REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolError, RbookToolResult } from './types';

/** The sync protocol two copies must share; a copy that speaks another is refused, never guessed at. */
export const SYNC_PROTOCOL = 1;

/** What each side says about itself before anything moves. */
export interface Hello {
  readonly protocol: number;
  /** s97-m10 (design §Versions): the record protocol this copy writes; a 4.1.0 copy says none, and writes 1. */
  readonly recordProtocol?: number;
  readonly projectId: string;
  readonly replicaId: string;
  readonly block: number;
  readonly authority: string;
  readonly marks: Readonly<Record<string, number>>;
  readonly blocks: Readonly<Record<string, number>>;
  /** The replicas this copy's record shows as removed (ADR s96 §8): they receive nothing new. */
  readonly removed: readonly string[];
  /** s96-m13 (ADR s96 §8): the epoch this copy applies, and a move it holds unconfirmed. */
  readonly epoch: number;
  readonly pending: {
    readonly epoch: number;
    readonly authority: string;
    readonly changeId: string;
  } | null;
  /** When each replica was admitted, by the hybrid clock: of two in one block, the later renumbers. */
  readonly admitted: Readonly<Record<string, string>>;
  /** Replicas cut but not removed, such as a dropped copy or a replaced owner copy: they re-identify. */
  readonly cuts: Readonly<Record<string, number>>;
  /** Replicas whose join no recovery saw. */
  readonly unseen: readonly string[];
  /** The replicas this copy counts as members, the authority included. */
  readonly members: readonly string[];
  /** This copy's own copy check, when it refuses this copy's writes. */
  readonly refusal: string | null;
  /** That check's own remedy, so another copy can quote it (s96-m13 critics, round 4). */
  readonly remedy?: string | null;
}

/** One side of an exchange, in this process or at the far end of a channel. */
export interface Peer {
  /** How a person knows this copy, for the answer: a path, or a host and path. */
  readonly name: string;
  hello(): Promise<Hello>;
  chains(at: Readonly<Record<string, number>>): Promise<Record<string, string | null>>;
  changesSince(marks: Readonly<Record<string, number>>): Promise<LoggedChange[]>;
  /** Apply what arrived; a catch-up between epochs applies without judging. */
  apply(
    changes: readonly LoggedChange[],
    options?: { readonly judge?: boolean; readonly catchUp?: boolean }
  ): Promise<RbookToolResult<ApplyReport>>;
  /** On the authority: admit a copy's successor (ADR s96 §9), or itself at a fresh block. */
  admitSuccessor(input: {
    readonly replicaId: string;
    readonly sameId?: boolean;
  }): Promise<RbookToolResult<Successor>>;
  reblockSelf(): Promise<RbookToolResult<{ readonly block: number; readonly renumbered: number }>>;
  /** On the copy: take the successor the authority admitted. */
  takeSuccessor(input: {
    readonly successor: Successor;
    readonly reason: SuccessorReason;
    readonly authorityReceived: number | null;
    readonly divergesFrom?: number;
    readonly cut?: number;
  }): Promise<RbookToolResult<SuccessorTaken>>;
  /** Record, on this copy, an exchange the other copy's checks stopped, so its review shows it. */
  failed(input: { readonly replicaId: string; readonly error: string }): Promise<void>;
}

export interface ExchangeReport {
  /** The member's changes the owner's copy received, and how many it judged. */
  readonly sent: number;
  readonly judged: number;
  /** The owner's stream the member received, verdicts included. */
  readonly received: number;
  readonly conflicts: number;
  readonly findings: number;
  /** The owner's stream up to the mark both copies hold, as both hash it (ADR §7's digest). */
  readonly digest: { readonly mark: number; readonly hash: string | null };
  readonly applied: { readonly authority: ApplyReport | null; readonly member: ApplyReport | null };
  /**
   * The member was removed, or is no member: its changes went in, quarantined past its cut or
   * refused, and nothing came back (ADR s96 §8).
   */
  readonly removed: boolean;
  /**
   * s97-m14: which side's member the owner's copy lists as removed, when one is: this copy, or the
   * one it exchanged with. Absent for a copy that is no member at all, whose changes are refused.
   */
  readonly removedCopy?: 'local' | 'remote';
  /** Each side's identity and marks after the exchange: what each records of the other. */
  readonly local: { readonly replicaId: string; readonly marks: Readonly<Record<string, number>> };
  readonly remote: { readonly replicaId: string; readonly marks: Readonly<Record<string, number>> };
  /** s96-m13: the copy behind an epoch received the move, and waits for its operator to confirm it. */
  readonly caughtUp?: {
    readonly copy: 'local' | 'remote';
    readonly epoch: number;
    readonly authority: string;
    /** s97-m10: the copy behind confirmed the move itself, as the dashboard's referee does. */
    readonly confirmed?: boolean;
  };
  /** s96-m13: the member took a new identity or block, and what its review now says. */
  readonly reidentified?: SuccessorTaken;
  /** s96-m13: each replica that renumbered into a fresh block after a block clash. */
  readonly reblocked?: ReadonlyArray<{ readonly replicaId: string; readonly block: number }>;
}

/** This copy's side of an exchange, for any way of opening it. */
export function hello(client: RbookDatabaseClient): Hello {
  const ctx = mergeContext(client);
  const members = [...ctx.members.values()];
  const refused = replicaWriteRefusal(client);
  return {
    protocol: SYNC_PROTOCOL,
    recordProtocol: PROTOCOL_VERSION,
    projectId: recordedProjectId(client),
    replicaId: ctx.ownReplica,
    block: ctx.ownBlock,
    authority: ctx.authority,
    marks: replicaMarks(client),
    blocks: knownBlocks(client),
    removed: members.filter((member) => member.role === 'removed').map((m) => m.replicaId),
    epoch: ctx.epoch,
    pending: ctx.pending
      ? {
          epoch: ctx.pending.value.epoch,
          authority: ctx.pending.value.authority,
          changeId: ctx.pending.change.change_id,
        }
      : null,
    admitted: Object.fromEntries(
      [...ctx.unseen.values(), ...members]
        .filter((member) => member.admittedAt)
        .map((member) => [member.replicaId, member.admittedAt!])
    ),
    cuts: Object.fromEntries(
      members
        .filter((member) => member.cut !== undefined && member.role !== 'removed')
        .map((member) => [member.replicaId, member.cut!])
    ),
    unseen: [...ctx.unseen.keys()],
    members: members.map((member) => member.replicaId),
    refusal: refused?.code ?? null,
    remedy: refused?.suggestion ?? null,
  };
}

/**
 * A copy this process opens itself: `open` runs each step against a client opened for it, and
 * `unchecked` against one its copy check does not refuse, for reads and for the steps that put a
 * refused copy right.
 */
export function clientPeer(
  name: string,
  open: <T>(step: (client: RbookDatabaseClient) => T) => Promise<Awaited<T>>,
  unchecked: <T>(step: (client: RbookDatabaseClient) => T) => Promise<Awaited<T>> = open
): Peer {
  return {
    name,
    // Reads open without the check: a refused copy still says who it is and what it holds.
    hello: () => unchecked((client) => hello(client)),
    chains: (at) => unchecked((client) => chainsAt(client, at)),
    changesSince: (marks) => unchecked((client) => changesSince(client, marks)),
    apply: (changes, options = {}) =>
      // A copy its check refuses takes in nothing: it re-identifies first (ADR s96 §9). A catch-up
      // opens without the check, which the merge makes itself (record-token.ts). What the merge made
      // live is embedded once it commits.
      (options.catchUp ? unchecked : open)((client) => applyAndEmbed(client, changes, options)),
    admitSuccessor: (input) => open((client) => admitSuccessor(client, input)),
    reblockSelf: () => open((client) => reblockSelf(client)),
    takeSuccessor: (input) => unchecked((client) => takeSuccessor(client, input)),
    // Per-copy health, never recorded: a refused copy keeps it too.
    failed: (input) =>
      unchecked((client) => recordExchangeFailed(client, input.replicaId, input.error)),
  };
}

const blockOf = (blocks: Readonly<Record<string, number>>, replicaId: string): string =>
  replicaId in blocks ? `the copy in block ${blocks[replicaId]}` : `copy ${replicaId}`;

/**
 * Why two copies cannot exchange at all, or null: another protocol, another project, one replica on
 * both sides, or neither of them the authority's (ADR s96 §7). Two copies at different epochs pass:
 * the one behind catches up. `them` names the other copy; `outcome` ends each message.
 */
export function pairRefusal(
  ours: Hello,
  theirs: Hello,
  them: string,
  outcome: string
): RbookToolError | null {
  if (ours.protocol !== theirs.protocol)
    return {
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `${them} speaks sync protocol ${theirs.protocol} and this copy speaks ${ours.protocol}, so ${outcome}.`,
      suggestion: 'Install the same Reasonbook release on both machines, then sync again.',
    };
  if (ours.projectId !== theirs.projectId)
    return {
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `${them} holds project ${theirs.projectId} and this copy holds project ${ours.projectId}, so ${outcome}.`,
      suggestion: 'Sync each copy only with copies of its own project.',
    };
  if (ours.replicaId === theirs.replicaId)
    return {
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `${them} and this copy are the same copy of the record, one copied from the other, so ${outcome}.`,
      suggestion:
        "Join the copied one from the owner's copy (reasonbook join), which gives it its own identity.",
    };
  if (ours.epoch === theirs.epoch && ours.authority !== theirs.authority)
    return {
      code: REPLICA_ERROR_CODES.AUTHORITY_DIFFERS,
      message: `${them} and this copy each name a different owner's copy for the same move, so ${outcome}.`,
      suggestion:
        'Two copies each claim to be the owner copy; only one can be. Tell the owner, who keeps one and has the other re-identify.',
    };
  const star = (one: Hello, other: Hello): boolean =>
    one.replicaId === one.authority || one.replicaId === other.authority;
  if (!star(ours, theirs) && !star(theirs, ours))
    return {
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message: `Neither ${them} nor this copy is the owner's copy, and a member syncs only with the owner's (ADR s96 §7), so ${outcome}.`,
      suggestion: "Sync with the owner's copy.",
    };
  return null;
}

/**
 * Why two copies' chains or blocks stop them, or null: the owner's own stream differing, a slot two
 * copies filled differently, or one block two replicas hold (ADR s96 §7). The exchange settles the
 * member's own clashes first, so what reaches here is for a person, or another sync, to settle.
 */
export function clashRefusal(
  ours: Hello,
  theirs: Pick<Hello, 'blocks'>,
  clashes: readonly string[],
  them: string,
  outcome: string,
  blockClashes: ReadonlyArray<{ readonly block: number; readonly replicas: readonly string[] }> = []
): RbookToolError | null {
  const blocks = { ...theirs.blocks, ...ours.blocks };
  if (clashes.includes(ours.authority))
    return {
      code: REPLICA_ERROR_CODES.AUTHORITY_DIFFERS,
      message: `The owner's own stream differs between ${them} and this copy at a change both hold, so ${outcome}.`,
      suggestion:
        "Recover the owner's copy from its members (reasonbook recover), which collects every member's log.",
    };
  if (clashes.length)
    return {
      code: REPLICA_ERROR_CODES.SLOT_CLASH,
      message: `${clashes.map((replicaId) => blockOf(blocks, replicaId)).join(' and ')} wrote different changes at a place both copies hold, so ${outcome}.`,
      suggestion:
        "The copy that wrote them re-identifies at its next direct sync with the owner's copy, which moves its own changes to a fresh block.",
    };
  if (blockClashes.length)
    return {
      code: REPLICA_ERROR_CODES.BLOCK_CLASH,
      message: `${blockClashes.map((clash) => `Block ${clash.block} is held by ${clash.replicas.join(' and ')}`).join('; ')}, so ${outcome}.`,
      suggestion:
        "The copy admitted later renumbers into a fresh block at its next direct sync with the owner's copy.",
    };
  return null;
}

/**
 * s97-m14 (the dashboard's live test; critics, round 1): what an exchange that names a removed
 * member says, as a clause. The cut is where the owner's copy stood in the member's stream when it
 * removed the member (ADR s96 §8), so everything the owner's copy did not hold then is set aside:
 * what the member made after the removal, and what it made before and had not synced. Null when
 * the report names no removal; a copy that is no member at all is said plainly.
 */
export function removalNote(
  report: Pick<ExchangeReport, 'sent' | 'removedCopy'> & { readonly removed?: boolean }
): string | null {
  if (!report.removedCopy)
    return report.removed
      ? "the owner's copy lists this exchange's member copy as no member of the project, so what it sent is refused and it is sent nothing"
      : null;
  const whose = report.removedCopy === 'local' ? "this copy's" : "that copy's";
  const what =
    report.sent > 0
      ? `the ${report.sent} change(s) it sent, and anything else the owner's copy did not hold when it removed the member, are set aside and count`
      : "anything the owner's copy did not hold when it removed the member is set aside and counts";
  return `${whose} member was removed from the project: ${what} only if the owner shares the project with it again, and nothing new is sent to it`;
}

/**
 * Exchange what each copy lacks, in a star: one side must be the authority's copy (ADR s96 §7). A
 * copy behind an epoch only catches up. Otherwise the member's identity is put right first, then
 * any block two replicas hold; the member's changes reach the authority, and the verdicts it records
 * on them come back in the same exchange. Nothing else moves until both chains agree.
 */
export async function exchange(
  local: Peer,
  remote: Peer
): Promise<RbookToolResult<ExchangeReport>> {
  let ours = await local.hello();
  let theirs = await remote.hello();
  const unpaired = pairRefusal(ours, theirs, remote.name, 'nothing was exchanged');
  if (unpaired) return createError<ExchangeReport>(unpaired);
  const stopped = async (error: RbookToolError): Promise<RbookToolResult<ExchangeReport>> => {
    // A clash is damage both operators must see: each side's review keeps it (ADR §7's digest).
    await local.failed({ replicaId: theirs.replicaId, error: error.message });
    await remote.failed({ replicaId: ours.replicaId, error: error.message });
    return createError<ExchangeReport>(error);
  };
  if (ours.epoch !== theirs.epoch) return catchUp(local, remote, ours, theirs, stopped);

  const localJudges = ours.replicaId === ours.authority;
  const [authority, member] = localJudges ? [local, remote] : [remote, local];
  // ADR s96 §9: an owner copy that holds less of its own stream than a member was restored with its
  // registry, so no member re-identifies to put it right: the exchange halts for a recovery.
  const [judgeHello, memberSide] = localJudges ? [ours, theirs] : [theirs, ours];
  if ((memberSide.marks[judgeHello.replicaId] ?? 0) > (judgeHello.marks[judgeHello.replicaId] ?? 0))
    return stopped({
      code: REPLICA_ERROR_CODES.AUTHORITY_DIFFERS,
      message: `The owner's copy holds less of its own record than ${localJudges ? remote.name : 'this copy'} does, as a restore of the owner's machine leaves it, so nothing was exchanged.`,
      suggestion:
        "Recover the owner's copy from its members (reasonbook recover), which collects every member's log.",
    });
  // ADR s96 §7: the owner's own stream is checked before anything moves: a copy given a new identity
  // in a stream that differs would be admitted where no other copy agrees.
  const early = commonMarks(ours.marks, theirs.marks);
  const owner = judgeHello.replicaId;
  if (owner in early) {
    const differs = chainClashes(
      await local.chains({ [owner]: early[owner] }),
      await remote.chains({ [owner]: early[owner] })
    );
    const halted = clashRefusal(ours, theirs, differs, remote.name, 'nothing was exchanged');
    if (halted) return stopped(halted);
  }
  const identity = await settleIdentity(
    authority,
    member,
    localJudges ? ours : theirs,
    localJudges ? theirs : ours
  );
  if (!identity.success) return stopped(identity.error!);
  const blocks = await settleBlocks(authority, member);
  if (!blocks.success) return stopped(blocks.error!);
  ours = await local.hello();
  theirs = await remote.hello();
  const common = commonMarks(ours.marks, theirs.marks);
  const clashes = chainClashes(await local.chains(common), await remote.chains(common));
  const clashed = clashRefusal(ours, theirs, clashes, remote.name, 'nothing was exchanged');
  if (clashed) return stopped(clashed);

  const [authorityHello, memberHello] = localJudges ? [ours, theirs] : [theirs, ours];
  const sent = await member.changesSince(authorityHello.marks);
  const judged = await authority.apply(sent);
  // s97-m10: a transaction too large for the dashboard stays on its copy, which still takes in the
  // stream; the exchange then answers that refusal, so the copy's review shows it (critics, round 1).
  const heldBack =
    !judged.success && judged.error?.code === REPLICA_ERROR_CODES.TRANSACTION_TOO_LARGE
      ? judged.error
      : null;
  if (!heldBack && (!judged.success || !judged.data))
    return createError<ExchangeReport>(judged.error!);
  // A removed member's changes go in, quarantined past its cut, and it receives nothing new (ADR §8);
  // a copy that is no member receives nothing at all.
  const listedRemoved = authorityHello.removed.includes(memberHello.replicaId);
  const removed =
    listedRemoved || !(await authority.hello()).members.includes(memberHello.replicaId);
  const removedCopy = listedRemoved ? (localJudges ? 'remote' : 'local') : undefined;
  let adopted: ApplyReport | null = null;
  let adoptedWarnings: readonly string[] | undefined;
  if (!removed) {
    const received = await authority.changesSince(memberHello.marks);
    const applied = await member.apply(received);
    if (!applied.success || !applied.data) return createError<ExchangeReport>(applied.error!);
    adopted = applied.data;
    adoptedWarnings = applied.warnings;
  }
  // s97-m14 (critics, rounds 1 and 2): a held-back transaction must not hide a removal from its
  // member. The removal leads, so the review's 160-character slice of the error keeps it.
  if (heldBack && removedCopy) {
    const note = removalNote({ sent: 0, removedCopy })!;
    return createError<ExchangeReport>({
      ...heldBack,
      message: `${note.charAt(0).toUpperCase()}${note.slice(1)}. ${heldBack.message}`,
    });
  }
  if (heldBack || !judged.data) return createError<ExchangeReport>(heldBack ?? judged.error!);
  const mark = common[ours.authority] ?? 0;
  return createSuccess<ExchangeReport>(
    {
      sent: judged.data.stored,
      judged: judged.data.judged,
      received: adopted?.stored ?? 0,
      conflicts: (adopted ?? judged.data).conflicts,
      findings: (adopted ?? judged.data).checks,
      removed,
      ...(removedCopy ? { removedCopy } : {}),
      digest: {
        mark,
        hash: mark ? (await local.chains({ [ours.authority]: mark }))[ours.authority] : null,
      },
      applied: { authority: judged.data, member: adopted },
      local: { replicaId: ours.replicaId, marks: (await local.hello()).marks },
      remote: { replicaId: theirs.replicaId, marks: (await remote.hello()).marks },
      ...(identity.data ? { reidentified: identity.data } : {}),
      ...(blocks.data?.length ? { reblocked: blocks.data } : {}),
    },
    // What either copy could not embed after its merge rides the answer (s96-m13).
    [...(judged.warnings ?? []), ...(adoptedWarnings ?? [])]
  );
}
