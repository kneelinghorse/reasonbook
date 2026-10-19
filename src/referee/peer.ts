// SPDX-License-Identifier: Apache-2.0
// ABOUTME: One peer call on a hosted referee (s97-m09, design §Who may call what): the dashboard names the authenticated
// ABOUTME: caller, and the library allows each method only to the copies its table names, refusing the rest by code.

import { applyRemote, replicaMarks } from '../tools/rbook/record-apply';
import { PROTOCOL_VERSION } from '../tools/rbook/record-changes';
import { chainsAt } from '../tools/rbook/record-chain';
import { hello } from '../tools/rbook/record-exchange';
import { answerJoin, type JoinRequest } from '../tools/rbook/record-join';
import { listMembers, OWNER_MEMBER } from '../tools/rbook/record-membership';
import { confirmOwner, handOver } from '../tools/rbook/record-moves';
import { recordExchanged, recordExchangeFailed } from '../tools/rbook/record-peers';
import { changeProblem } from '../tools/rbook/record-intake';
import { firstPage } from '../tools/rbook/record-pages';
import { changesSince } from '../tools/rbook/record-since';
import { mergeContext, type LoggedChange, type MergeContext } from '../tools/rbook/record-standing';
import { takeSuccessor } from '../tools/rbook/record-successor';
import { admitSuccessor } from '../tools/rbook/record-admit-successor';
import { createSuccess } from '../tools/rbook/errors';
import { recordedProjectId } from '../tools/rbook/replica-identity';
import type { RbookDatabaseClient } from '../tools/rbook/client';
import type { RbookToolResult } from '../tools/rbook/types';
import {
  accountOfReplica,
  accountsByMember,
  memberOfAccount,
  memberOfReplica,
  noteCall,
  readState,
  STATE_KEYS,
  writeState,
} from './accounts';
import { REFEREE_ERROR_CODES, refuse } from './codes';
import { heldOf, intakeRefusal } from './intake';
import { withReferee, type RefereeLocation, type RefereeOutcome } from './open';

/** Who is calling, as the dashboard authenticated them: their account, and the copy they say they are. */
export interface Caller {
  readonly accountId: string;
  readonly replicaId: string;
}

/** The methods a caller may name through peer; every other name is refused by default. */
export const PEER_METHODS = [
  'hello',
  'chains',
  'changesSince',
  'apply',
  'admitSuccessor',
  'takeSuccessor',
  'failed',
  'exchanged',
  'answerJoin',
  'moveBack',
] as const;

/** How much of a copy's own report on an exchange the referee keeps. */
const REPORT_CHARS = 2000;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const malformed = <T>(what: string): RbookToolResult<T> =>
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
function pageAsked(params: unknown): { readonly marks: unknown; readonly maxBytes: number } | null {
  const body = object(params);
  // At least a page of a mebibyte, so a caller asking for tiny pages cannot make each one rescan
  // the whole log for one transaction (critics, round 1).
  return typeof body.maxBytes === 'number' && Number.isFinite(body.maxBytes) && body.maxBytes > 0
    ? { marks: body.marks, maxBytes: Math.max(body.maxBytes, MIN_PAGE_BYTES) }
    : null;
}

/** The least a page of the stream holds, whatever a caller asks. */
const MIN_PAGE_BYTES = 1024 * 1024;

/** The marks a page served, from the marks it was asked from: each replica's last change in it. */
function servedThrough(
  since: Readonly<Record<string, number>>,
  page: readonly LoggedChange[]
): Record<string, number> {
  const served = { ...since };
  for (const change of page)
    served[change.replica_id] = Math.max(served[change.replica_id] ?? 0, change.replica_seq);
  return served;
}

function marks(value: unknown): Record<string, number> | null {
  const held = object(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.values(held).every(
    (seq) => typeof seq === 'number' && Number.isInteger(seq) && seq >= 0
  )
    ? (held as Record<string, number>)
    : null;
}

interface Standing {
  readonly ctx: MergeContext;
  /** The caller's replica is bound to the caller's account. */
  readonly bound: boolean;
  readonly removed: boolean;
  /** The outgoing authority relaying to the referee while the referee is still its member. */
  readonly relay: boolean;
}

function standingOf(client: RbookDatabaseClient, caller: Caller): Standing {
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

const notMember = <T>(): RbookToolResult<T> =>
  refuse<T>({
    code: REFEREE_ERROR_CODES.NOT_A_MEMBER,
    message: "That copy is not one of the calling account's copies of this project.",
    suggestion: 'Join this project from the dashboard first; a copy calls only as itself.',
  });

const refusedMethod = <T>(method: string, why: string): RbookToolResult<T> =>
  refuse<T>({
    code: REFEREE_ERROR_CODES.METHOD_REFUSED,
    message: `${method} is refused: ${why}.`,
    suggestion: 'Sync with a Reasonbook release; the exchange calls only what the referee allows.',
  });

/** After the outgoing authority's catch-up, a move naming the referee is confirmed here (never by a caller). */
function confirmIfNamed(client: RbookDatabaseClient): void {
  const ctx = mergeContext(client);
  if (ctx.pending && ctx.pending.value.authority === ctx.ownReplica) {
    const confirmed = confirmOwner(client, { changeId: ctx.pending.change.change_id });
    if (!confirmed.success)
      throw new Error(confirmed.error?.message ?? 'the move was not confirmed');
  }
}

function apply(
  client: RbookDatabaseClient,
  standing: Standing,
  caller: Caller,
  params: unknown
): RbookToolResult<unknown> {
  const body = object(params);
  if (!Array.isArray(body.changes)) return malformed('apply needs a list of changes');
  const changes = body.changes as LoggedChange[];
  // Shape first: what the store holds of a delivery is read only for changes that are changes.
  const projectId = recordedProjectId(client);
  const shapeless = changes.find((change) => changeProblem(change, projectId) !== null);
  const held = shapeless ? heldOf(client, []) : heldOf(client, changes);
  const names = new Map(listMembers(client).map((member) => [member.memberId, member]));
  const refused = intakeRefusal(
    standing.ctx,
    projectId,
    caller,
    { changes, relay: standing.relay },
    held,
    (replicaId) => {
      // A member's changes carry the name it was shared under, a member given the owner role too;
      // only the owner's own copies keep their own (critics, round 1).
      const member = names.get(memberOfReplica(standing.ctx, replicaId) ?? '');
      return member && member.memberId !== OWNER_MEMBER ? member.name : null;
    }
  );
  if (refused) return refused;
  // Only the outgoing authority's relay chooses whether the referee judges or catches up.
  const options = standing.relay
    ? {
        judge: body.judge === undefined ? undefined : body.judge === true,
        catchUp: body.catchUp === true,
      }
    : {};
  const applied = applyRemote(client, changes, options);
  if (!applied.success) return applied;
  // The move is confirmed once the catch-up is whole: a paged one says `more` on every page but its last.
  if (standing.relay && options.catchUp && body.more !== true) confirmIfNamed(client);
  return applied;
}

function joinFor(
  client: RbookDatabaseClient,
  caller: Caller,
  params: unknown
): RbookToolResult<unknown> {
  const request = object(params) as unknown as JoinRequest;
  if (typeof request.replicaId !== 'string' || request.replicaId !== caller.replicaId)
    return malformed('a join request names the replica the caller asks to join as');
  const memberId = memberOfAccount(client, caller.accountId);
  const member = memberId
    ? listMembers(client).find((known) => known.memberId === memberId)
    : undefined;
  if (!member || member.role === 'removed')
    return refuse({
      code: REFEREE_ERROR_CODES.NOT_A_MEMBER,
      message: 'The calling account holds no active share of this project, so no copy of it joins.',
      suggestion:
        "Ask the project's owner to share it with your account on the dashboard, then join again.",
    });
  return answerJoin(client, request, member.name);
}

function dispatch(
  client: RbookDatabaseClient,
  method: string,
  params: unknown,
  caller: Caller
): RbookToolResult<unknown> {
  if (method === 'answerJoin') return joinFor(client, caller, params);
  const standing = standingOf(client, caller);
  if (!standing.bound) return notMember();
  const body = object(params);
  switch (method) {
    case 'hello': {
      const theirs = body.recordProtocol;
      if (typeof theirs === 'number' && theirs > PROTOCOL_VERSION)
        return refuse({
          code: REFEREE_ERROR_CODES.PROTOCOL_NEWER,
          message: `Your copy speaks record protocol ${theirs}, and this referee speaks ${PROTOCOL_VERSION}, so nothing was exchanged.`,
          suggestion:
            'Your changes stay safe on your copy. The dashboard upgrades its Reasonbook engine; sync again once it has.',
        });
      return createSuccess({ ...hello(client), recordProtocol: PROTOCOL_VERSION });
    }
    case 'chains': {
      const at = marks(params);
      return at ? createSuccess(chainsAt(client, at)) : malformed('chains needs marks by replica');
    }
    case 'changesSince': {
      if (standing.removed)
        return refuse({
          code: REFEREE_ERROR_CODES.REMOVED,
          message: "That copy's member was removed from this project, so it receives nothing new.",
          suggestion:
            'What your copy holds stays with you. Ask the owner to share the project with you again to rejoin.',
        });
      const paged = pageAsked(params);
      const since = marks(paged ? paged.marks : params);
      if (!since) return malformed('changesSince needs marks by replica');
      const stream = changesSince(client, since);
      return paged ? createSuccess(firstPage(stream, paged.maxBytes)) : createSuccess(stream);
    }
    case 'apply':
      return apply(client, standing, caller, params);
    case 'admitSuccessor': {
      if (body.replicaId !== caller.replicaId)
        return refusedMethod(method, 'a copy asks for a new identity only for itself');
      // The same identity at a fresh block is the later holder's way out of a block two copies hold.
      const block = standing.ctx.members.get(caller.replicaId)?.block;
      if (body.sameId === true && (block === undefined || !standing.ctx.clashedBlocks.has(block)))
        return refusedMethod(
          method,
          "a copy moves to a fresh block only when another copy holds its block, and this copy's is its own"
        );
      return admitSuccessor(client, { replicaId: caller.replicaId, sameId: body.sameId === true });
    }
    case 'moveBack': {
      // Only the owner's account, as a successor of the owner's own copy that the referee admitted and
      // that copy has taken (design §Who may call what): the referee hands the record over to it.
      // handOver checks that it is an uncut copy of the owner that never held a term.
      const ctx = standing.ctx;
      if (memberOfAccount(client, caller.accountId) !== OWNER_MEMBER)
        return refusedMethod(method, "only the owner's account moves the project back");
      const successor = ctx.members.get(caller.replicaId);
      if (!successor?.previous || successor.member !== OWNER_MEMBER)
        return refusedMethod(
          method,
          "the project moves back to a successor of the owner's own copy, admitted here and taken on that copy"
        );
      if (ctx.ownReplica !== ctx.authority || ctx.pending)
        return refuse({
          code: REFEREE_ERROR_CODES.NOT_READY,
          message:
            "This project's referee does not hold the record just now, so it moves nothing back.",
          suggestion: 'Sync your copy, then move the project back again.',
        });
      return handOver(client, { to: caller.replicaId });
    }
    case 'takeSuccessor': {
      if (!standing.relay)
        return refusedMethod(
          method,
          'the referee takes a new identity only while it is still a member, during a handover in'
        );
      // Only a successor the outgoing authority admitted for the referee's own replica.
      const successor = object(body.successor);
      const admitted = standing.ctx.members.get(String(successor.replicaId));
      const own = standing.ctx.ownReplica;
      if (
        !admitted ||
        admitted.block !== successor.block ||
        admitted.role !== 'owner' ||
        (admitted.replicaId !== own && admitted.previous !== own)
      )
        return refusedMethod(
          method,
          "the successor it names is not one the owner's copy admitted for the referee"
        );
      return takeSuccessor(client, body as never);
    }
    case 'failed':
    case 'exchanged': {
      if (body.replicaId !== caller.replicaId)
        return refusedMethod(method, 'a copy reports only about itself');
      if (method === 'failed')
        recordExchangeFailed(
          client,
          caller.replicaId,
          String(body.error ?? '').slice(0, REPORT_CHARS)
        );
      else {
        const held = marks(body.marks);
        const digest = object(body.digest);
        const digestWhole =
          body.digest === null ||
          body.digest === undefined ||
          (Number.isInteger(digest.mark) &&
            (digest.hash === null || typeof digest.hash === 'string') &&
            String(digest.hash ?? '').length <= REPORT_CHARS);
        if (!held || !digestWhole)
          return malformed('exchanged needs the marks the copy holds and its digest');
        recordExchanged(client, caller.replicaId, {
          marks: held,
          digest: body.digest ? { mark: digest.mark, hash: digest.hash } : body.digest,
        });
      }
      return createSuccess(null);
    }
    case 'reblockSelf':
      return refusedMethod(
        method,
        'no block clash can name the referee as the later holder, since it takes the freshest block at its join'
      );
    default:
      return refusedMethod(method, 'it is not a call a copy may make on the referee');
  }
}

/**
 * Run one peer call for an authenticated caller (design §R1). The answer is the engine's own result,
 * for the dashboard to send back unchanged; the head is the dashboard's to record and pass back.
 */
export function peer(
  location: RefereeLocation,
  method: string,
  params: unknown,
  caller: Caller
): Promise<RefereeOutcome<unknown>> {
  let movedBack = false;
  const outcome = withReferee(location, ({ client, joining }) => {
    if (joining)
      return refuse({
        code: REFEREE_ERROR_CODES.NOT_READY,
        message: "This project's referee has not finished joining, so it serves no copy yet.",
        suggestion:
          "Finish the handover in from the owner's copy: the referee applies its join answer first.",
      });
    if (typeof caller?.accountId !== 'string' || typeof caller?.replicaId !== 'string')
      return malformed('the caller names an account and a replica');
    const result = dispatch(client, method, params, caller);
    // The sync-state view reads what the referee saw: a call, a delivery taken in, a stream sent,
    // so far as it went: a page with more to follow served only what it held (s97-m10).
    if (result.success && mergeContext(client).members.has(caller.replicaId)) {
      const page = result.data as { changes?: LoggedChange[]; more?: boolean } | undefined;
      const since = marks(pageAsked(params)?.marks);
      noteCall(client, caller.replicaId, {
        received: method === 'apply',
        ...(method === 'changesSince'
          ? {
              served:
                page?.more === true && since && page.changes
                  ? servedThrough(since, page.changes)
                  : replicaMarks(client),
            }
          : {}),
      });
    }
    // The copy this referee handed the record to delivers its stream here only from an exchange it
    // judges, which it runs once it has confirmed the move; a catch-up delivers nothing here. The
    // owner's client holds its sync lock through the move, so no exchange it began before lands after.
    if (
      result.success &&
      method === 'apply' &&
      handedBackTo(client, caller.replicaId) &&
      !readState(client, STATE_KEYS.successorJudged)
    )
      writeState(client, STATE_KEYS.successorJudged, new Date().toISOString());
    // That successor then reports a whole exchange at the new epoch: the host may archive this
    // referee now (D6). A report before it judged, as from a catch-up, archives nothing (critics, round 1).
    if (
      result.success &&
      method === 'exchanged' &&
      handedBackTo(client, caller.replicaId) &&
      readState(client, STATE_KEYS.successorJudged)
    ) {
      if (!readState(client, STATE_KEYS.movedBack))
        writeState(client, STATE_KEYS.movedBack, new Date().toISOString());
      movedBack = true;
    }
    return result;
  });
  return outcome.then((done) => (movedBack ? { ...done, movedBack: true as const } : done));
}

/** Whether this referee handed the record to `replicaId`, the copy that holds it now. */
function handedBackTo(client: RbookDatabaseClient, replicaId: string): boolean {
  const ctx = mergeContext(client);
  const index = ctx.terms.findIndex((term) => term.replicaId === ctx.ownReplica);
  return (
    index >= 0 &&
    ctx.terms[index + 1]?.replicaId === replicaId &&
    ctx.authority === replicaId &&
    !ctx.pending
  );
}
