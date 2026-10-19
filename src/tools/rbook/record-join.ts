// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Joining a shared record (ADR s96 §9): the joiner's copy checks itself and mints its identity, the authority
// ABOUTME: answers with replica_joined and a fresh block, and the answer applies once, to the copy that asked.

import { createHash, randomUUID } from 'crypto';
import { monotonicFactory } from 'ulid';
import { validAuthorName } from '../../intelligence/user-author';
import type { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { replicaMarks } from './record-apply';
import {
  importBundle,
  readBundle,
  writeBundle,
  type Bundle,
  type BundleImport,
} from './record-bundle';
import { canonicalJson } from './record-capture';
import { recordOwnChanges } from './record-changes';
import { SYNC_PROTOCOL } from './record-exchange';
import { freshBlock, memberNamed } from './record-membership';
import { forgetPeers } from './record-peers';
import { BASELINE_QUERY, mergeContext, REPLICA_ENTITY } from './record-standing';
import { replicaWriteRefusal, secondCopyOnJoin } from './replica-check';
import { COPY_KEYS, writeCopyKey } from './replica-copy-keys';
import {
  establishReplica,
  forgetReplicaIdentity,
  recordedProjectId,
  REPLICA_ERROR_CODES,
  ReplicaRefusal,
} from './replica-identity';
import type { RbookToolResult } from './types';

const mintReplicaId = monotonicFactory();

export const JOIN_REQUEST_FORMAT = 'reasonbook-join-request';
export const JOIN_ANSWER_FORMAT = 'reasonbook-join-answer';
/** The joiner's own record of the join it asked for: the id it minted and the request's nonce. */
const PENDING_KEY = COPY_KEYS.joinPending;

export interface JoinRequest {
  readonly format: typeof JOIN_REQUEST_FORMAT;
  readonly protocol: number;
  readonly projectId: string;
  /** The identity the joining copy minted for itself. */
  readonly replicaId: string;
  /** Binds the answer to this one request, so an answer cannot be reused. */
  readonly nonce: string;
  /** How far the joining copy holds each stream: the answer's bundle starts after them. */
  readonly marks: Readonly<Record<string, number>>;
}

export interface JoinAnswer {
  readonly format: typeof JOIN_ANSWER_FORMAT;
  readonly protocol: number;
  readonly projectId: string;
  readonly replicaId: string;
  readonly nonce: string;
  readonly block: number;
  readonly role: string;
  readonly member: { readonly memberId: string; readonly name: string };
  /** The authority's stream since the joiner's marks, its admission of this copy included. */
  readonly bundle: Bundle;
  /** sha256 of everything above, so an answer changed after it was written is refused whole. */
  readonly hash: string;
}

const answerHash = (answer: Omit<JoinAnswer, 'hash'>): string =>
  createHash('sha256').update(canonicalJson(answer)).digest('hex');

export interface JoinApplied {
  readonly replicaId: string;
  readonly block: number;
  readonly member: string;
  readonly imported: BundleImport;
}

/** A refusal, its remedy named where it is authored. */
function refuse<T>(refusal: {
  readonly code: string;
  readonly message: string;
  readonly suggestion: string;
}): RbookToolResult<T> {
  return createError<T>({ ...refusal });
}

function metadata(client: RbookDatabaseClient, key: string): string | null {
  const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [key]);
  if (!row.success) throw new Error(row.error?.message ?? `${key} could not be read`);
  return row.data?.value ?? null;
}

/**
 * The joining copy's side, step 1: check the file is whole and holds the shared record, then mint
 * the identity it will join under and remember the request, which the answer must name.
 */
export function requestJoin(client: RbookDatabaseClient): RbookToolResult<JoinRequest> {
  const integrity = client.getOne<{ integrity_check: string }>('PRAGMA integrity_check');
  if (!integrity.success || integrity.data?.integrity_check !== 'ok')
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: 'This copy failed its integrity check, so it was not joined.',
      suggestion: "Make a new copy on the owner's machine with reasonbook copy, and join that one.",
    });
  const baseline = client.getOne<{ change_id: string }>(BASELINE_QUERY);
  if (!baseline.success || !baseline.data)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'This copy was made before the project was shared, so it holds no shared record to join; the import brings in what such a copy holds of its own.',
      suggestion:
        "Join a copy made after sharing instead (reasonbook copy on the owner's machine makes one); to bring in what this copy holds of its own, run reasonbook import --from <this folder> in the joined copy.",
    });
  const second = secondCopyOnJoin(client);
  if (second) return createError(second);
  // A copy this machine's check passes is a live copy here, the owner's or a joined member's: joining
  // it again would give one copy two identities. A copy carried here and not joined is refused by it.
  if (replicaWriteRefusal(client) === null)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'This copy is a live copy of the shared record on this machine already, so it is not joined again.',
      suggestion:
        "Sync it instead: reasonbook sync here, or the owner's sync, which reaches it once the owner's copy has its route (reasonbook sync --ssh <host> --remote-root <folder> there). A second copy for this machine is refused, and one for another machine joins from a reasonbook copy.",
    });
  const request: JoinRequest = {
    format: JOIN_REQUEST_FORMAT,
    protocol: SYNC_PROTOCOL,
    projectId: recordedProjectId(client),
    replicaId: mintReplicaId(),
    nonce: randomUUID(),
    marks: replicaMarks(client),
  };
  writeCopyKey(
    client,
    PENDING_KEY,
    JSON.stringify({ replicaId: request.replicaId, nonce: request.nonce })
  );
  return createSuccess(request);
}

/**
 * The authority's side, step 2: admit the requesting copy for an invited member, in a fresh block
 * above every block ever issued, and answer with the stream the copy lacks.
 */
export function answerJoin(
  client: RbookDatabaseClient,
  request: JoinRequest,
  memberName: string
): RbookToolResult<JoinAnswer> {
  if (request?.format !== JOIN_REQUEST_FORMAT)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: 'That is not a join request.',
      suggestion: 'Answer the file reasonbook join --request-out wrote.',
    });
  if (request.protocol !== SYNC_PROTOCOL)
    return refuse({
      message: `The request was written in sync protocol ${request.protocol} and this copy speaks ${SYNC_PROTOCOL}.`,
      suggestion: 'Install the same Reasonbook release on both machines, then ask again.',
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
    });
  const ctx = mergeContext(client);
  if (ctx.ownReplica !== ctx.authority)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: "Only the owner's copy answers a join.",
      suggestion: "Answer the join on the owner's copy.",
    });
  if (request.projectId !== recordedProjectId(client))
    return refuse({
      message: `The request is from a copy of project ${request.projectId}, and this is project ${recordedProjectId(client)}.`,
      suggestion: 'Answer each request on the owner copy of its own project.',
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
    });
  const member = memberNamed(client, memberName);
  if (!member || member.role === 'removed')
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${memberName} is not invited to this project, so the copy was not admitted.`,
      suggestion: `Invite them first: rbook_project(action="invite", name="${memberName}").`,
    });
  if (ctx.members.has(request.replicaId))
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'That copy has joined already, so this request was answered before: a join answer cannot be reused.',
      suggestion: 'Sync the copy instead.',
    });
  const block = freshBlock(client);
  const done = client.writeTransaction(() =>
    recordOwnChanges(client, [
      {
        kind: 'replica_joined',
        entity: REPLICA_ENTITY,
        entityId: request.replicaId,
        field: null,
        value: canonicalJson({ block, role: member.role, member: member.memberId }),
      },
    ])
  );
  if (!done.success) return createError(done.error!);
  const body: Omit<JoinAnswer, 'hash'> = {
    format: JOIN_ANSWER_FORMAT,
    protocol: SYNC_PROTOCOL,
    projectId: request.projectId,
    replicaId: request.replicaId,
    nonce: request.nonce,
    block,
    role: member.role,
    member: { memberId: member.memberId, name: member.name },
    bundle: writeBundle(client, request.marks),
  };
  return createSuccess<JoinAnswer>({ ...body, hash: answerHash(body) });
}

/**
 * The joining copy's side, step 3: take the identity the answer admitted, under the invite's name,
 * then import the authority's stream. The answer names the request it answers; one for another
 * request, or one already used, is refused.
 */
export function applyJoin(
  client: RbookDatabaseClient,
  answer: JoinAnswer
): RbookToolResult<JoinApplied> {
  if (answer?.format !== JOIN_ANSWER_FORMAT)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: 'That is not a join answer.',
      suggestion: "Apply the file the owner's reasonbook join --answer wrote.",
    });
  // An answer carried by hand is checked whole, its bundle too, before anything of it applies.
  const { hash, ...body } = answer;
  if (answerHash(body) !== hash)
    return refuse({
      code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED,
      message:
        'The join answer does not match its content hash, so it was changed after it was written, and it was not applied.',
      suggestion:
        "Answer the request again on the owner's machine (reasonbook join --answer), and carry that answer unchanged.",
    });
  const intact = readBundle(JSON.stringify(answer.bundle));
  if (!intact.success) return createError(intact.error!);
  const pending = metadata(client, PENDING_KEY);
  const asked = pending ? (JSON.parse(pending) as { replicaId: string; nonce: string }) : null;
  if (!asked || asked.replicaId !== answer.replicaId || asked.nonce !== answer.nonce)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        "This answer is not for this copy's join request, or it was used already: a join answer cannot be reused.",
      suggestion:
        'Ask again from this copy (reasonbook join --request-out), and apply the answer to that request.',
    });
  // Carried by bundle, the answer can arrive days after the request: one live copy per machine still holds.
  const second = secondCopyOnJoin(client);
  if (second) return createError(second);
  const name = validAuthorName(answer.member.name);
  try {
    const joined = client.writeTransaction(() => {
      forgetReplicaIdentity(client);
      establishReplica(client, { block: answer.block, replicaId: answer.replicaId });
      // ADR s96 §10: the invite names the member, and the joined copy keeps that name for this project.
      if (name) writeCopyKey(client, COPY_KEYS.author, name);
      writeCopyKey(client, PENDING_KEY, null);
      // The file came from another copy, whose routes, health and last new identity are its own.
      forgetPeers(client);
      writeCopyKey(client, COPY_KEYS.successor, null);
    });
    if (!joined.success) return createError(joined.error!);
  } catch (error) {
    if (error instanceof ReplicaRefusal) return createError(error.refusal);
    throw error;
  }
  forgetReplicaIdentity(client);
  const imported = importBundle(client, answer.bundle);
  if (!imported.success || !imported.data) return createError(imported.error!);
  return createSuccess({
    replicaId: answer.replicaId,
    block: answer.block,
    member: answer.member.name,
    imported: imported.data,
  });
}
