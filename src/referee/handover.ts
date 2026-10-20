// SPDX-License-Identifier: Apache-2.0
// ABOUTME: How the dashboard becomes a project's referee (s97-m09, design §R1, D6): a fresh store built from the owner's
// ABOUTME: upload, joined as the owner's other copy in a fresh block, which then catches up and takes the handover.

import { existsSync, mkdirSync, renameSync, rmSync } from 'fs';
import path, { dirname } from 'path';
import { monotonicFactory } from 'ulid';
import { ProjectGraphRegistry } from '../intelligence/project-graph-registry';
import { RbookDatabaseClient } from '../tools/rbook/client';
import { createError, createSuccess } from '../tools/rbook/errors';
import { buildFreshCopy, FreshCopyRefused } from '../tools/rbook/record-fresh-copy';
import { replicaMarks } from '../tools/rbook/record-apply';
import { SYNC_PROTOCOL } from '../tools/rbook/record-exchange';
import {
  applyJoin,
  JOIN_REQUEST_FORMAT,
  requestJoin,
  type JoinAnswer,
  type JoinRequest,
} from '../tools/rbook/record-join';
import { recordedProjectId } from '../tools/rbook/replica-identity';
import { listMembers, OWNER_MEMBER } from '../tools/rbook/record-membership';
import { namedCopies, ownersOtherCopies } from '../tools/rbook/record-owner-copies';
import { mergeContext } from '../tools/rbook/record-standing';
import type { RbookToolResult } from '../tools/rbook/types';
import { bindAccount, readState, REFEREE_TABLES_SQL, STATE_KEYS, writeState } from './accounts';
import { REFEREE_ERROR_CODES, refuse } from './codes';
import {
  exclusive,
  pendingJoin,
  registryFolder,
  streamHead,
  withReferee,
  type RefereeLocation,
  type RefereeOutcome,
} from './open';

const mintKey = monotonicFactory();

/** Why the uploaded copy cannot become this referee's, or null: it must be the owner's live authority copy. */
function uploadProblem(client: RbookDatabaseClient): string | null {
  const ctx = mergeContext(client);
  if (ctx.ownReplica !== ctx.authority)
    return "it is a member's copy, and only the owner's copy hands the record to the dashboard";
  if (ctx.pending) return 'it holds a move of the owner copy it has not confirmed';
  if (ctx.forks.length) return 'it holds two moves of the owner copy for one epoch';
  const members = listMembers(client).filter(
    (member) => member.memberId !== OWNER_MEMBER && member.role !== 'removed'
  );
  if (members.length)
    return `it is shared directly with ${members.map((member) => member.name).join(', ')}, and moving a directly shared project with members to the dashboard is not built yet`;
  // s100-m01: the owner's other copies would be stranded; an upload carries no routes, so the
  // referee sees those that wrote.
  const copies = ownersOtherCopies(client);
  if (copies.length)
    return `the project is also kept in ${namedCopies(copies)}, which a share through the dashboard would leave unable to sync, and taking the owner's other copies along is not built yet`;
  return null;
}

/**
 * The join request a referee store made for this owner and has not had answered, asked again, so
 * a createReferee whose answer was lost can be retried until the referee joins; otherwise null.
 */
async function askedAgain(
  location: Omit<RefereeLocation, 'expectedHead'>,
  ownerAccountId: string
): Promise<RefereeOutcome<{ readonly joinRequest: JoinRequest }> | null> {
  let client: RbookDatabaseClient | null = null;
  try {
    const opened = await RbookDatabaseClient.create({
      dbPath: location.storePath,
      registerProject: false,
      replicaCheck: false,
      loadVec: false,
    });
    if (!opened.success || !opened.data) return null;
    client = opened.data;
    const state = client.getMany<{ key: string; value: string }>(
      "SELECT key, value FROM referee_state WHERE key IN ('owner_account', 'registry_key')"
    );
    const held = new Map((state.data ?? []).map((row) => [row.key, row.value]));
    const pending = pendingJoin(client);
    if (!pending || held.get(STATE_KEYS.owner) !== ownerAccountId || !held.get(STATE_KEYS.registry))
      return null;
    const joinRequest: JoinRequest = {
      format: JOIN_REQUEST_FORMAT,
      protocol: SYNC_PROTOCOL,
      projectId: recordedProjectId(client),
      replicaId: pending.replicaId,
      nonce: pending.nonce,
      marks: replicaMarks(client),
    };
    return { result: createSuccess({ joinRequest }), head: streamHead(client) };
  } catch {
    return null;
  } finally {
    client?.close();
  }
}

/**
 * Build this project's referee store from the owner's uploaded copy (design §R1): a fresh store with
 * only the shared record, the owner member bound to `ownerAccountId`, no caller bound to the
 * referee's own replica, and the referee's join request, which the owner's copy answers as its own.
 */
export function createReferee(
  location: Omit<RefereeLocation, 'expectedHead'>,
  input: { readonly copyFile: string; readonly ownerAccountId: string }
): Promise<RefereeOutcome<{ readonly joinRequest: JoinRequest }>> {
  return exclusive(async () => {
    if (typeof input?.ownerAccountId !== 'string' || !input.ownerAccountId)
      return {
        result: refuse({
          code: REFEREE_ERROR_CODES.MALFORMED,
          message: 'createReferee needs the owner account.',
          suggestion: "Pass the account id of the project's owner.",
        }),
        head: null,
      };
    if (existsSync(location.storePath)) {
      // A retry after a lost answer: a store made for this owner that has not joined yet asks again.
      const again = await askedAgain(location, input.ownerAccountId);
      if (again) return again;
      return {
        result: refuse({
          code: REFEREE_ERROR_CODES.EXISTS,
          message:
            'This project already has a referee store, and a store is made only by a handover in.',
          suggestion:
            'Use the store that is there; after a move back, archive it before sharing the project again.',
        }),
        head: null,
      };
    }
    mkdirSync(path.dirname(location.storePath), { recursive: true });
    let built = false;
    const warnings: string[] = [];
    let client: RbookDatabaseClient | null = null;
    try {
      const fresh = await buildFreshCopy(input.copyFile, location.storePath, {
        untrusted: true,
        referee: true,
      });
      built = true;
      warnings.push(...fresh.warnings);
      const key = mintKey();
      await ProjectGraphRegistry.create({ configDir: registryFolder(location.configDir, key) });
      const opened = await RbookDatabaseClient.create({
        dbPath: location.storePath,
        registerProject: false,
        replicaCheck: false,
        loadVec: false,
      });
      if (!opened.success || !opened.data)
        throw new Error(opened.error?.message ?? 'the referee store could not be opened');
      client = opened.data;
      const problem = uploadProblem(client);
      if (problem) throw new FreshCopyRefused(`That copy cannot become the referee's: ${problem}.`);
      const ran = client.raw(REFEREE_TABLES_SQL);
      if (!ran.success) throw new Error(ran.error?.message ?? 'the referee tables were not made');
      const done = client.writeTransaction(() => {
        writeState(client!, STATE_KEYS.registry, key);
        writeState(client!, STATE_KEYS.owner, input.ownerAccountId);
        writeState(client!, STATE_KEYS.createdAt, new Date().toISOString());
        bindAccount(client!, OWNER_MEMBER, input.ownerAccountId);
      });
      if (!done.success)
        throw new Error(done.error?.message ?? 'the referee state was not written');
      const asked = requestJoin(client);
      if (!asked.success || !asked.data)
        throw new Error(asked.error?.message ?? 'the referee could not ask to join');
      const head = streamHead(client);
      client.close();
      client = null;
      return { result: createSuccess({ joinRequest: asked.data }, warnings), head };
    } catch (error) {
      client?.close();
      client = null;
      if (built)
        for (const suffix of ['', '-wal', '-shm'])
          rmSync(`${location.storePath}${suffix}`, { force: true });
      const message = error instanceof Error ? error.message : String(error);
      return {
        result:
          error instanceof FreshCopyRefused
            ? refuse({
                code: REFEREE_ERROR_CODES.UPLOAD_REFUSED,
                message: message,
                suggestion:
                  error.remedy ??
                  "Upload the copy the owner's client builds from its own live store, then hand over again.",
              })
            : refuse({
                code: REFEREE_ERROR_CODES.FAILED,
                message: `The referee store was not made: ${message}`,
                suggestion: 'Retry the handover in; nothing was kept from this attempt.',
              }),
        head: null,
      };
    } finally {
      client?.close();
      ProjectGraphRegistry.resetInstance();
    }
  });
}

/**
 * Apply the owner's answer to the referee's join (design §R1): the referee takes the identity and
 * fresh block the owner's copy admitted, as the owner's other copy, and the stream the answer holds.
 */
export function applyJoinAnswer(
  location: RefereeLocation,
  answer: JoinAnswer
): Promise<RefereeOutcome<{ readonly replicaId: string; readonly block: number }>> {
  return withReferee(location, ({ client, joining }) => {
    if (!joining)
      return refuse({
        code: REFEREE_ERROR_CODES.METHOD_REFUSED,
        message: 'This referee has joined already, so a join answer cannot be applied again.',
        suggestion:
          'Carry on with the handover in: exchange with the referee, then hand over to it.',
      });
    if (answer?.role !== 'owner' || answer.member?.memberId !== OWNER_MEMBER)
      return refuse({
        code: REFEREE_ERROR_CODES.MALFORMED,
        message:
          "The referee joins only as the owner's other copy, and this answer admits it as another member.",
        suggestion:
          "Answer the referee's join request on the owner's copy with the owner's own name.",
      });
    const applied = applyJoin(client, answer);
    if (!applied.success || !applied.data) return createError(applied.error!);
    return createSuccess({
      replicaId: applied.data.replicaId,
      block: applied.data.block,
    }) as RbookToolResult<{
      readonly replicaId: string;
      readonly block: number;
    }>;
  });
}

/**
 * Archive a referee whose project moved back to its owner's copy (D6, s97-m11), once that copy has
 * synced with it at the new epoch (a peer outcome said movedBack): the store moves to `archivePath`,
 * kept as the record it held, and its bindings go, so a later share through the dashboard starts fresh.
 */
export function archiveReferee(
  location: RefereeLocation,
  archivePath: string
): Promise<RefereeOutcome<{ readonly archived: string }>> {
  return withReferee(location, ({ client, joining }) => {
    if (joining || !readState(client, STATE_KEYS.movedBack))
      return refuse({
        code: REFEREE_ERROR_CODES.METHOD_REFUSED,
        message:
          "This referee still holds the project's record: it is archived only once the project moved back and the owner's copy synced with it.",
        suggestion:
          "Finish the move back from the owner's copy: it syncs once more after the move, which marks this referee for archiving.",
      });
    const key = readState(client, STATE_KEYS.registry);
    client.close();
    mkdirSync(dirname(archivePath), { recursive: true });
    renameSync(location.storePath, archivePath);
    for (const suffix of ['-wal', '-shm', '-journal'])
      if (existsSync(`${location.storePath}${suffix}`))
        renameSync(`${location.storePath}${suffix}`, `${archivePath}${suffix}`);
    if (key) rmSync(registryFolder(location.configDir, key), { recursive: true, force: true });
    return createSuccess({ archived: archivePath });
  });
}

/**
 * Throw away a referee store that never joined, and its bindings (design D6), so the owner can start
 * the handover in again: as when the owner's answer to its join was lost after the owner's copy
 * admitted it. The owner's record keeps that admission, an owner-role copy that never writes.
 * A referee that joined is never discarded here: it holds the record, and moving back retires it.
 */
export function discardReferee(
  location: RefereeLocation
): Promise<RefereeOutcome<{ readonly discarded: string }>> {
  return withReferee(
    location,
    ({ client, joining }) => {
      if (!joining)
        return refuse({
          code: REFEREE_ERROR_CODES.METHOD_REFUSED,
          message: 'This referee has joined the record, so it is not thrown away.',
          suggestion: "Move the project back to the owner's copy to stop hosting it.",
        });
      const key = client.getOne<{ value: string }>(
        "SELECT value FROM referee_state WHERE key = 'registry_key'"
      ).data?.value;
      client.close();
      for (const suffix of ['', '-wal', '-shm', '-journal'])
        rmSync(`${location.storePath}${suffix}`, { force: true });
      if (key) rmSync(registryFolder(location.configDir, key), { recursive: true, force: true });
      return createSuccess({ discarded: joining.replicaId });
    },
    { headRequired: false }
  );
}
