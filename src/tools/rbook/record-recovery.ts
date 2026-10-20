// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Recovering the owner's copy when it is gone (ADR s96 §8): with every member reached and the member list the
// ABOUTME: operator confirmed, a new copy collects every log, takes a fresh block and the next epoch, and says what was lost.

import Database from 'better-sqlite3';
import { monotonicFactory } from 'ulid';
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import type { ReplicaBinding } from '../../intelligence/replica-bindings';
import { validAuthorName } from '../../intelligence/user-author';
import { RbookDatabaseClient } from './client';
import { createError, createSuccess } from './errors';
import { applyRemote, replicaMarks } from './record-apply';
import type { AuthorityValue } from './record-authority';
import { canonicalJson } from './record-capture';
import { PROTOCOL_VERSION, recordOwnChanges } from './record-changes';
import type { Hello, Peer } from './record-exchange';
import type { LoggedChange } from './record-standing';
import { freshBlock, listMembers, OWNER_MEMBER } from './record-membership';
import { judgeUnjudged } from './record-judge';
import { newestProtocol, UPGRADE_COMMAND } from './record-protocol-hold';
import { recomputeEntities } from './record-recompute';
import { mergeContext, REPLICA_ENTITY } from './record-standing';
import { underApplyToken } from './record-token';
import {
  lostChanges,
  reidentifyReplica,
  replicaWriteRefusal,
  type LostChanges,
} from './replica-check';
import { COPY_KEYS, writeCopyKey } from './replica-copy-keys';
import { fileIdentity, REPLICA_ERROR_CODES } from './replica-identity';
import type { RbookToolResult } from './types';
import type { Opener } from './record-sync';

const mintReplicaId = monotonicFactory();

export interface RecoveryInput {
  /** The member names the operator confirms the recovery works from; they must equal the record's. */
  readonly members: readonly string[];
  /** Members the operator drops by their word: their copies are cut where the recovery saw them. */
  readonly drop?: readonly string[];
}

export interface RecoveryReport {
  readonly epoch: number;
  readonly authority: string;
  readonly previous: string;
  readonly block: number;
  /** The old owner copy's highest change the recovery holds with none missing before it. */
  readonly cut: number;
  readonly collected: number;
  /** Transactions judged again, their verdicts lost with the old owner copy. */
  readonly judged: number;
  readonly dropped: Readonly<Record<string, number>>;
  /** The copies reached, by replica id, for the routes a caller remembers. */
  readonly reached: readonly string[];
  /** What the old owner copy wrote that no member received (ADR s96 §8's three registry cases). */
  readonly lost: LostChanges;
}

/** A refusal, its remedy named where it is authored. */
function refuse<T>(refusal: {
  readonly code: string;
  readonly message: string;
  readonly suggestion: string;
}): RbookToolResult<T> {
  return createError<T>({ ...refusal });
}

/** A store's replica id and sequence, read from its file; null when it holds no shared identity. */
function storeReplica(root: string): { replicaId: string; seq: number } | null {
  const dbPath = resolveRecordPaths(root).dbPath;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const value = (key: string) =>
      (db!.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value?: string })
        ?.value;
    const replicaId = value('replica_id');
    return replicaId ? { replicaId, seq: Number(value('replica_seq') ?? 0) } : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Whether the bound folder still holds the live old owner copy: its identity, the file this machine
 * bound (by inode, as the copy check reads it), a sequence not behind this machine's mark, and not
 * behind what its members hold of its stream, which only a restore leaves (ADR s96 §9).
 */
function liveAt(binding: ReplicaBinding, furthest: number): boolean {
  const held = storeReplica(binding.store_path);
  if (held?.replicaId !== binding.replica_id) return false;
  try {
    const file = fileIdentity(resolveRecordPaths(binding.store_path).dbPath);
    return file.inode === binding.inode && held.seq >= binding.seq_mark && held.seq >= furthest;
  } catch {
    return false;
  }
}

/** The replicas a member's copies are now: each admitted replica that no later one succeeds. */
function latestReplicas(client: RbookDatabaseClient, memberId: string): string[] {
  const ctx = mergeContext(client);
  const replicas = [...ctx.members.values()].filter((member) => member.member === memberId);
  const succeeded = new Set(replicas.map((member) => member.previous).filter(Boolean));
  return replicas
    .filter((member) => !succeeded.has(member.replicaId) && member.role !== 'removed')
    .map((member) => member.replicaId);
}

/** The copy a successor no copy took stands for: its predecessor, which still holds that copy. */
function untakenPredecessor(client: RbookDatabaseClient, replicaId: string): string | null {
  const previous = mergeContext(client).members.get(replicaId)?.previous;
  if (!previous) return null;
  const wrote = client.getOne('SELECT 1 FROM record_changes WHERE replica_id = ? LIMIT 1', [
    replicaId,
  ]);
  return wrote.success && !wrote.data ? previous : null;
}

/**
 * Recover the owner's copy on `self`, the restored file or a `reasonbook copy` of a member's copy
 * (ADR s96 §8). It refuses while the old owner copy is live, until every member's copy is reached
 * (or dropped by the operator's word), and unless `members` names exactly the record's members.
 * Then it re-identifies into a block above every block any reached copy knows, collects every log
 * without judging, records the next epoch's `authority` change, and judges what lost its verdict.
 */
export async function recoverAuthority(
  self: Opener,
  peers: readonly Peer[],
  input: RecoveryInput,
  registry: ProjectGraphRegistry = ProjectGraphRegistry.getInstance()
): Promise<RbookToolResult<RecoveryReport>> {
  const before = await self((client) => {
    const ctx = mergeContext(client);
    return {
      ctx: {
        authority: ctx.authority,
        epoch: ctx.epoch,
        own: ctx.ownReplica,
        block: ctx.ownBlock,
        pending: !!ctx.pending,
      },
      members: listMembers(client),
      folder: client.path,
      marks: replicaMarks(client),
    };
  });
  // s100-m01 (critics, rounds 1 and 2): a recovery takes every copy's changes in whole and judges
  // them as this version would. One written in a newer record protocol, in this copy's own carried
  // log or a member copy's, would be left with no verdict or cut off past the recovery's cut, so the
  // recovery stops before it changes anything and runs once this copy upgrades.
  const newerHere = await self((client) => newestLogged(client));
  if (newerHere) return newerRefusal('This copy', newerHere);
  const old = before.ctx.authority;
  const ownerName = validAuthorName(
    before.members.find((member) => member.memberId === OWNER_MEMBER)?.name ?? ''
  );
  if (before.ctx.pending)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'This copy holds a move of the owner copy it has not confirmed, so it cannot recover one.',
      suggestion: 'Confirm that move first: reasonbook sync --confirm-owner.',
    });
  const named = (names: readonly string[]) =>
    new Set(names.map((name) => validAuthorName(name) ?? name));
  const listed = before.members.filter(
    (member) => member.memberId !== OWNER_MEMBER && member.role !== 'removed'
  );
  const confirmed = named(input.members);
  if (listed.length !== confirmed.size || listed.some((member) => !confirmed.has(member.name)))
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `The record lists ${listed.length ? listed.map((member) => member.name).join(', ') : 'no members'}; a recovery works from that list once the operator confirms it.`,
      suggestion: `Confirm the list: members=[${listed.map((member) => JSON.stringify(member.name)).join(', ')}].`,
    });
  const dropped = named(input.drop ?? []);
  const hellos = new Map<string, Hello>();
  for (const peer of peers) {
    const hello = await peer.hello();
    hellos.set(hello.replicaId, hello);
  }
  // The old owner copy is live when it is reached, or bound here, intact and not behind its members.
  const furthest = Math.max(0, ...[...hellos.values()].map((hello) => hello.marks[old] ?? 0));
  const binding = registry.replicaBinding(old);
  const bound = binding && binding.retired_at === null ? storeReplica(binding.store_path) : null;
  const liveHere = Boolean(binding && binding.retired_at === null && liveAt(binding, furthest));
  if (hellos.has(old) || liveHere)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `The owner's copy${binding ? ` at ${binding.store_path}` : ''} is still live, so it is not recovered: a recovery is for a copy that is gone.`,
      suggestion: "Hand over from it instead: reasonbook handover, on the owner's copy.",
    });
  const waiting: string[] = [];
  for (const member of [
    ...listed.filter((member) => !dropped.has(member.name)),
    ...before.members.filter((member) => member.memberId === OWNER_MEMBER),
  ])
    for (const { replicaId, standIn } of await self((client) =>
      latestReplicas(client, member.memberId).map((id) => ({
        replicaId: id,
        standIn: untakenPredecessor(client, id),
      }))
    ))
      if (
        replicaId !== old &&
        replicaId !== before.ctx.own &&
        !hellos.has(replicaId) &&
        !(standIn && hellos.has(standIn))
      )
        waiting.push(`${member.name}'s copy (${replicaId})`);
  if (waiting.length)
    return refuse({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `The recovery waits for ${waiting.join(', ')}: it proceeds only with every member's copy reached.`,
      suggestion:
        'Reach each copy over SSH, or drop a member by your word (drop=[name]); a dropped copy re-identifies when it returns.',
    });
  // Every member copy's changes, fetched before anything changes here, so one that holds a newer
  // protocol's stops the recovery with this copy as it was. Later ones arrive as duplicates.
  const collectedFrom: Array<readonly LoggedChange[]> = [];
  for (const peer of peers) {
    const changes = await peer.changesSince(before.marks);
    const newer = newestProtocol(
      changes.filter((change) => change.protocol_version > PROTOCOL_VERSION)
    );
    if (newer) return newerRefusal(peer.name, newer);
    collectedFrom.push(changes);
  }
  // The lost-changes report reads this machine's mark of the old copy before anything is retired.
  const mark = binding ? binding.seq_mark : null;
  const restoredTogether = bound?.replicaId === old && bound.seq >= (mark ?? Infinity);
  if (binding && binding.retired_at === null && !liveHere) registry.retireReplica(old);
  // Above this copy's own block too: a recovery that stopped after re-identifying is run again.
  const block = Math.max(
    await self((client) => freshBlock(client)),
    before.ctx.block + 1,
    ...[...hellos.values()].flatMap((hello) => Object.values(hello.blocks).map((b) => b + 1))
  );
  const replicaId = mintReplicaId();
  const made = await self((client) => {
    return client.writeTransaction(() => {
      reidentifyReplica(client, { block, authorityReceived: null, replicaId }, registry);
      // The owner's copy writes as the owner, whichever member's copy it was made from.
      if (ownerName) writeCopyKey(client, COPY_KEYS.author, ownerName);
      return replicaWriteRefusal(client);
    });
  });
  if (!made.success) return createError(made.error!);
  if (made.data) return createError(made.data);
  let collected = 0;
  for (const changes of collectedFrom) {
    // Collected whole and unjudged: this copy judges only once it is the authority.
    const applied = await self((client) => importUnjudged(client, changes));
    if (!applied.success) return createError(applied.error!);
    collected += applied.data ?? 0;
  }
  const recorded = await self((client) => {
    return client.writeTransaction(() => {
      const ctx = mergeContext(client);
      const cut = ctx.prefixes.get(old) ?? 0;
      const cuts: Record<string, number> = {};
      for (const member of listed.filter((member) => dropped.has(member.name)))
        for (const latest of latestReplicas(client, member.memberId))
          for (const dropReplica of [latest, untakenPredecessor(client, latest)])
            if (dropReplica) cuts[dropReplica] = replicaMarks(client)[dropReplica] ?? 0;
      const value: AuthorityValue = {
        epoch: ctx.epoch + 1,
        authority: ctx.ownReplica,
        previous: old,
        move: 'recovery',
        block,
        cut,
        ...(Object.keys(cuts).length ? { dropped: cuts } : {}),
        members: listed.map((member) => member.name),
      };
      recordOwnChanges(client, [
        {
          kind: 'authority',
          entity: REPLICA_ENTITY,
          entityId: ctx.ownReplica,
          field: null,
          value: canonicalJson(value),
        },
      ]);
      return underApplyToken(client, () => {
        const judged = judgeUnjudged(client);
        // What a dropped copy wrote past its cut is quarantined now; the rest kept its standing.
        const droppedTxns = client.getMany<{ txn_id: string }>(
          'SELECT DISTINCT txn_id FROM record_changes WHERE replica_id IN (SELECT value FROM json_each(?))',
          [JSON.stringify(Object.keys(cuts))]
        );
        recomputeEntities(
          client,
          mergeContext(client),
          new Set([...judged, ...(droppedTxns.data ?? []).map((row) => row.txn_id)]),
          new Set()
        );
        return { value, judged: judged.length };
      });
    });
  });
  if (!recorded.success || !recorded.data) return createError(recorded.error!);
  const { value, judged } = recorded.data;
  // ADR s96 §8: a mark is trustworthy unless the folder came back with it, as one backup restores both.
  const lost =
    mark !== null && !restoredTogether
      ? lostChanges(mark, value.cut ?? 0)
      : {
          count: null,
          summary: `Changes the owner's copy made after the last one its members received (change ${value.cut}) may be lost.`,
        };
  return createSuccess({
    epoch: value.epoch,
    authority: value.authority,
    previous: old,
    block,
    cut: value.cut ?? 0,
    collected,
    judged,
    dropped: value.dropped ?? {},
    reached: [...hellos.keys()],
    lost,
  });
}

/** The newest record protocol this copy's own log holds a change in, past its own; or 0. */
function newestLogged(client: RbookDatabaseClient): number {
  const row = client.getOne<{ version: number | null }>(
    'SELECT max(protocol_version) AS version FROM record_changes WHERE protocol_version > ?',
    [PROTOCOL_VERSION]
  );
  return row.success ? (row.data?.version ?? 0) : 0;
}

/** Why a recovery stops for a newer record protocol, before it changed anything. */
function newerRefusal(where: string, protocol: number): RbookToolResult<never> {
  return refuse({
    code: REPLICA_ERROR_CODES.WRITE_REFUSED,
    message: `${where} holds changes written in record protocol ${protocol}, newer than this version's ${PROTOCOL_VERSION}, and a recovery takes in every copy's changes whole, so nothing was recovered.`,
    suggestion: `Upgrade Reasonbook here (${UPGRADE_COMMAND}), then run the recovery again.`,
  });
}

/** Store and recompute what a member holds, judging nothing: this copy is not the authority yet. */
function importUnjudged(
  client: RbookDatabaseClient,
  changes: Parameters<typeof applyRemote>[1]
): RbookToolResult<number> {
  const applied = applyRemote(client, changes, { judge: false });
  if (!applied.success || !applied.data) return createError(applied.error!);
  return createSuccess(applied.data.stored);
}
