// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The referee library's published refusals (s97-m09, design §R1): each code with the HTTP status the dashboard
// ABOUTME: answers it with, so the reference server and the dashboard map them alike; engine codes pass through.

import { createError, RBOOK_ERROR_CODES } from '../tools/rbook/errors';
import { REPLICA_ERROR_CODES } from '../tools/rbook/replica-identity';
import type { RbookToolResult } from '../tools/rbook/types';

/** Every refusal the referee library adds to the engine's own (design §R1, "a stable error vocabulary"). */
export const REFEREE_ERROR_CODES = {
  /** The host is collecting member uploads before the owner confirms a new referee. */
  RECOVERING: 'REFEREE_RECOVERING',
  /** The store is missing, behind or forked from the head the last call returned, or its copy check refuses it. */
  NEEDS_RECOVERY: 'REFEREE_NEEDS_RECOVERY',
  /** A call that needs the last recorded head came without one. */
  HEAD_REQUIRED: 'REFEREE_HEAD_REQUIRED',
  /** createReferee found a store already there: a store is created only by a handover in. */
  EXISTS: 'REFEREE_EXISTS',
  /** A peer call reached a referee that has not applied its join answer yet. */
  NOT_READY: 'REFEREE_NOT_READY',
  /** The uploaded copy is not the owner's copy of a shared record this version can read. */
  UPLOAD_REFUSED: 'REFEREE_UPLOAD_REFUSED',
  /** The caller's account is no member, or the replica it named is not one of its account's. */
  NOT_A_MEMBER: 'REFEREE_NOT_A_MEMBER',
  /** A removed member asked for what only members receive. */
  REMOVED: 'REFEREE_MEMBER_REMOVED',
  /** The method is not one a caller may run through peer, or not for this caller now. */
  METHOD_REFUSED: 'REFEREE_METHOD_REFUSED',
  /** Changes stamped with a replica not the caller's, or with the referee's own. */
  FORGED_REPLICA: 'REFEREE_FORGED_REPLICA',
  /** A change of a kind only the owner's copy writes, from a member. */
  OWNER_ONLY: 'REFEREE_OWNER_ONLY',
  /** A renumber naming a block other than the one admitted for its replica (fact 34). */
  FORGED_RENUMBER: 'REFEREE_FORGED_RENUMBER',
  /** A change or a request that is not well formed. */
  MALFORMED: 'REFEREE_MALFORMED',
  /** A copy speaking a record protocol newer than this library's: refused, its changes kept on it (fact 28). */
  PROTOCOL_NEWER: 'REFEREE_PROTOCOL_NEWER',
  /** The caller cannot read changes this referee must withhold from its stream. */
  READS_OLD_PROTOCOL: 'REFEREE_READS_OLD_PROTOCOL',
  /** A change whose clock runs more than a week past the referee's: it waits on its copy until it does not. */
  CLOCK_AHEAD: 'REFEREE_CLOCK_AHEAD',
  /** An invite naming someone another member, the owner included, already goes by. */
  NAME_TAKEN: 'REFEREE_NAME_TAKEN',
  /** The store's guards record its changes as another version did: migrate() puts them right. */
  MIGRATE_NEEDED: 'REFEREE_MIGRATE_NEEDED',
  /** The call failed for a reason no refusal names, such as a busy moment; its message says what. */
  FAILED: 'REFEREE_FAILED',
} as const;

const STATUS: Readonly<Record<string, number>> = {
  [REFEREE_ERROR_CODES.RECOVERING]: 409,
  [REFEREE_ERROR_CODES.NEEDS_RECOVERY]: 409,
  [REFEREE_ERROR_CODES.HEAD_REQUIRED]: 400,
  [REFEREE_ERROR_CODES.EXISTS]: 409,
  [REFEREE_ERROR_CODES.NOT_READY]: 409,
  [REFEREE_ERROR_CODES.UPLOAD_REFUSED]: 422,
  [REFEREE_ERROR_CODES.NOT_A_MEMBER]: 404,
  [REFEREE_ERROR_CODES.REMOVED]: 403,
  [REFEREE_ERROR_CODES.METHOD_REFUSED]: 403,
  [REFEREE_ERROR_CODES.FORGED_REPLICA]: 403,
  [REFEREE_ERROR_CODES.OWNER_ONLY]: 403,
  [REFEREE_ERROR_CODES.FORGED_RENUMBER]: 403,
  [REFEREE_ERROR_CODES.MALFORMED]: 400,
  [REFEREE_ERROR_CODES.PROTOCOL_NEWER]: 409,
  [REFEREE_ERROR_CODES.READS_OLD_PROTOCOL]: 409,
  [REFEREE_ERROR_CODES.CLOCK_AHEAD]: 409,
  [REFEREE_ERROR_CODES.NAME_TAKEN]: 409,
  [REFEREE_ERROR_CODES.MIGRATE_NEEDED]: 409,
  [REFEREE_ERROR_CODES.FAILED]: 503,
  // The engine's own refusals: a state one side must put right, or a write the record forbids.
  [REPLICA_ERROR_CODES.EXCHANGE_REFUSED]: 409,
  [REPLICA_ERROR_CODES.AUTHORITY_DIFFERS]: 409,
  [REPLICA_ERROR_CODES.SLOT_CLASH]: 409,
  [REPLICA_ERROR_CODES.BLOCK_CLASH]: 409,
  [REPLICA_ERROR_CODES.WRITE_REFUSED]: 403,
  [REPLICA_ERROR_CODES.COPY_TOO_OLD]: 403,
  // A store another writer holds is a busy moment, which the host tries again (its s62-m06 ask).
  [RBOOK_ERROR_CODES.DB_CONNECTION_FAILED]: 503,
};

/** The HTTP status a refusal is answered with; a success is 200, and an unknown code is 409. */
export function refereeStatus(result: RbookToolResult<unknown>): number {
  if (result.success) return 200;
  return STATUS[result.error?.code ?? ''] ?? 409;
}

/** A refusal with its remedy, named where it is authored, as the engine's own refuse helpers take it. */
export function refuse<T>(refusal: {
  readonly code: (typeof REFEREE_ERROR_CODES)[keyof typeof REFEREE_ERROR_CODES];
  readonly message: string;
  readonly suggestion: string;
}): RbookToolResult<T> {
  return createError<T>({ ...refusal });
}
