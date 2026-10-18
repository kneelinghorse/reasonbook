// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The check on a copy of a shared record before it writes (ADR s96 §9): an unjoined copy, a restored
// ABOUTME: backup or replaced folder, and a second live copy on one machine are refused; a move rebinds.

import { ProjectGraphRegistry, readStoreIdentity } from '../../intelligence/project-graph-registry';
import type { ReplicaBinding } from '../../intelligence/replica-bindings';
import type { RbookDatabaseClient } from './client';
import { RBOOK_ERROR_CODES } from './errors';
import {
  guardProblems,
  guardRemedy,
  isRecording,
  readGuardState,
  type GuardRemedy,
} from './record-guards';
import {
  currentSeq,
  establishReplica,
  fileIdentity,
  forgetReplicaIdentity,
  isSharedStore,
  readReplicaIdentity,
  recordedProjectId,
  REPLICA_ERROR_CODES,
  ReplicaRefusal,
  storeFolder,
  StoreUnreadableError,
  type ReplicaIdentity,
} from './replica-identity';
import type { RbookToolError } from './types';

/** One verdict per client, for the replica it judged: a client that re-identifies is judged again. */
const verdicts = new WeakMap<
  RbookDatabaseClient,
  { readonly replicaId: string | null; readonly verdict: RbookToolError | null }
>();

/** One machine keeps one live copy of a shared record (ADR s96 §9). */
function secondCopy(other: string): RbookToolError {
  return {
    code: REPLICA_ERROR_CODES.SECOND_COPY,
    message:
      `This machine already holds a live copy of this shared project at ${other}. ` +
      'One machine keeps one live copy of a shared record, so writes here are refused.',
    suggestion: `Work in the copy at ${other}, or archive one of the two copies.`,
  };
}

function restored(seq: number, mark: number): RbookToolError {
  return {
    code: REPLICA_ERROR_CODES.RESTORED,
    message:
      'This copy is not the store this machine last wrote: it is a restored backup or a replaced ' +
      `folder (its sequence is ${seq}; this machine saw it reach ${mark}). Writes are refused ` +
      'until it re-identifies, and it then numbers its new records in a fresh block.',
    suggestion:
      "Sync the copy so it re-identifies, after confirming any move of the owner's copy it holds (reasonbook sync --confirm-owner); until then it can be read but not written.",
  };
}

function notJoined(): RbookToolError {
  return {
    code: REPLICA_ERROR_CODES.NOT_JOINED,
    message:
      'This is a copy of a shared project that has not joined on this machine, so writes to it ' +
      'are refused. Tools that only read still work.',
    suggestion: "Join this copy to the shared project from the owner's copy before writing to it.",
  };
}

function unchecked(cause: string): RbookToolError {
  return {
    code: REPLICA_ERROR_CODES.UNCHECKED,
    message: `This copy of a shared record could not be checked, so writes to it are refused: ${cause}`,
    suggestion:
      "Retry the write. If it is refused again, the cause lasts: on a member's copy, join a fresh copy (reasonbook copy on the owner's machine, then reasonbook join); the owner's copy is recovered from its members (reasonbook recover).",
  };
}

/** A store whose metadata cannot be read may or may not be shared; the write is not attempted. */
function unreadable(cause: string): RbookToolError {
  return {
    code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
    message: `This store could not be read, so the write was not attempted: ${cause}`,
    suggestion: 'Retry; if it fails again, check that the store file is readable and undamaged.',
  };
}

/**
 * s96-m13: what puts right a copy of a shared record that lost part of itself, on either side. The
 * restore tool is refused on such a copy, so the remedy is the store file or the shared record.
 */
export const DAMAGED_COPY_REMEDY =
  "On a member's copy, restore the store file from a backup or join a fresh copy (reasonbook copy on the owner's machine, then reasonbook join); its next sync puts it right. The owner's copy is recovered from its members: reasonbook recover.";

/** s96-m03 (ADR s96 §6): what puts each kind of broken guard right. */
const GUARD_REMEDIES: Readonly<Record<GuardRemedy, string>> = {
  repair:
    'Run reasonbook repair --guard. It records what was staged, rebuilds the guards, and clears a leftover token once no writer holds the store.',
  restore: `This copy has lost part of its record, which no repair rebuilds. ${DAMAGED_COPY_REMEDY}`,
  upgrade:
    'This copy has columns this version does not know: upgrade with npm install -g @aquex/reasonbook@latest.',
};

/** s96-m03 (ADR s96 §6): a recorded copy whose guards or token table are not whole writes nothing. */
export function guardBroken(problems: readonly string[], remedy: GuardRemedy): RbookToolError {
  return {
    code: REPLICA_ERROR_CODES.GUARD_BROKEN,
    message:
      `This copy of a shared record cannot guard its writes (${problems.join('; ')}), so writes ` +
      'to it are refused until the guard is put right. Tools that only read still work.',
    suggestion: GUARD_REMEDIES[remedy],
  };
}

/**
 * The guard check every open makes: the record's tables and columns, the triggers as recorded,
 * no token and nothing staged. Inside the change helper the token and the stage are its own.
 */
export function guardRefusal(client: RbookDatabaseClient): RbookToolError | null {
  // A surviving identity still denotes a shared copy when damage removed its change log.
  if (!isSharedStore(client)) return null;
  const state = readGuardState(
    <T>(sql: string) => {
      const rows = client.getMany<T>(sql);
      if (!rows.success) throw new StoreUnreadableError(rows.error?.message ?? sql);
      return rows.data ?? [];
    },
    { insideHelper: isRecording(client) }
  );
  const remedy = guardRemedy(state);
  return remedy ? guardBroken(guardProblems(state), remedy) : null;
}

function liveCopyAt(binding: ReplicaBinding, projectId: string): boolean {
  return readStoreIdentity(binding.store_path)?.project_id === projectId;
}

/** A live binding of this project on this machine in another folder that still holds it. */
function liveCopyElsewhere(
  registry: ProjectGraphRegistry,
  projectId: string,
  folder: string,
  except?: string
): ReplicaBinding | undefined {
  return registry
    .liveReplicas(projectId)
    .find(
      (candidate) =>
        candidate.replica_id !== except &&
        !ProjectGraphRegistry.isSameFolder(candidate.store_path, folder) &&
        liveCopyAt(candidate, projectId)
    );
}

function judgeCopy(client: RbookDatabaseClient, identity: ReplicaIdentity): RbookToolError | null {
  const registry = ProjectGraphRegistry.getInstance();
  // The mark first: it only follows a commit, so on a healthy copy a sequence read after it is
  // never behind it, however other processes interleave.
  const binding = registry.replicaBinding(identity.replicaId);
  const projectId = recordedProjectId(client);
  const folder = storeFolder(client.path);
  const file = fileIdentity(client.path);
  const seq = currentSeq(client);

  if (!binding || binding.retired_at !== null) {
    const other = liveCopyElsewhere(registry, projectId, folder, identity.replicaId);
    if (other) return secondCopy(other.store_path);
    return binding ? restored(seq, binding.seq_mark) : notJoined();
  }
  if (binding.project_id !== projectId)
    return unchecked(
      `its project id is ${projectId}, but this machine bound replica ${identity.replicaId} to ${binding.project_id}.`
    );
  const moved = !ProjectGraphRegistry.isSameFolder(binding.store_path, folder);
  if (moved && liveCopyAt(binding, projectId)) return secondCopy(binding.store_path);
  // The inode names the file: a volume can mount under another device number, and under another
  // name when an unclean eject left its old mount point behind. A move is the same file in a new
  // folder, with the bound folder gone; either way it is not behind its mark.
  if (binding.inode !== file.inode || seq < binding.seq_mark)
    return restored(seq, binding.seq_mark);
  // One machine keeps one live copy: another joined copy of this project here refuses both.
  const other = liveCopyElsewhere(registry, projectId, folder, identity.replicaId);
  if (other) return secondCopy(other.store_path);
  if (moved || binding.device !== file.device)
    registry.rebindReplica(identity.replicaId, folder, file);
  if (seq > binding.seq_mark) registry.advanceReplicaMark(identity.replicaId, seq);
  return null;
}

/**
 * The refusal for a write to a shared table of this store, or null when it may write. An unshared
 * store always may, untouched. Judged once per client; a check that cannot run refuses, and is
 * judged again next time. Under the write lock a shared copy's identity is read again, since another
 * process may have re-identified it.
 */
export function replicaWriteRefusal(client: RbookDatabaseClient): RbookToolError | null {
  let replicaId: string | null = null;
  try {
    const cached = readReplicaIdentity(client);
    const identity =
      cached && client.inWriteTransaction ? readReplicaIdentity(client, { fresh: true }) : cached;
    if (!identity) return null;
    replicaId = identity.replicaId;
    const known = verdicts.get(client);
    if (known && known.replicaId === replicaId) return known.verdict;
    const verdict = judgeCopy(client, identity) ?? guardRefusal(client);
    // A deferred transaction may read an old snapshot, so a refusal reached in one is not kept.
    if (!verdict || !client.inTransaction || client.inWriteTransaction)
      verdicts.set(client, { replicaId, verdict });
    return verdict;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return error instanceof StoreUnreadableError ? unreadable(cause) : unchecked(cause);
  }
}

/** What a re-identified copy lost, when its registry mark can say (ADR s96 §9). */
export interface LostChanges {
  /** null when the loss cannot be counted. */
  readonly count: number | null;
  readonly first?: number;
  readonly last?: number;
  readonly summary: string;
}

/** What a copy lost: from the authority's received sequence up to the registry's mark (ADR s96 §9). */
export function lostChanges(mark: number | null, authorityReceived: number | null): LostChanges {
  // An authority holding more than this machine saw the copy write means the mark fell behind.
  if (mark === null || authorityReceived === null || authorityReceived > mark)
    return { count: null, summary: 'Changes this copy made after its last sync may be lost.' };
  const count = mark - authorityReceived;
  if (count === 0)
    return {
      count,
      summary: 'No changes were lost: the authority holds everything this copy wrote.',
    };
  const first = authorityReceived + 1;
  return {
    count,
    first,
    last: mark,
    summary:
      `${count} change${count === 1 ? '' : 's'} (${first} to ${mark}) never reached the authority ` +
      'and were lost; their content went with the folder.',
  };
}

/**
 * Re-identify a copy that a check refused: a new replica in a fresh block, the old binding retired,
 * and the report of what the old replica lost. s96-m13 supplies the block and the authority's
 * received sequence from the exchange; a copy this machine never bound has no mark. A duplicate of
 * a live copy on this machine is never re-identified, so the live copy keeps its binding.
 */
export function reidentifyReplica(
  client: RbookDatabaseClient,
  input: {
    readonly block: number;
    readonly authorityReceived: number | null;
    /** s96-m13: the identity the authority admitted for this copy; minted here when absent. */
    readonly replicaId?: string;
  },
  registry: ProjectGraphRegistry = ProjectGraphRegistry.getInstance()
): { readonly identity: ReplicaIdentity; readonly lost: LostChanges } {
  const old = readReplicaIdentity(client, { fresh: true });
  if (!old) throw new Error('This store is not a copy of a shared record; nothing re-identifies.');
  if (input.block === old.block)
    throw new Error(`A re-identified copy takes a fresh block, not its old block ${old.block}.`);
  const projectId = recordedProjectId(client);
  const live = liveCopyElsewhere(registry, projectId, storeFolder(client.path));
  if (live) throw new ReplicaRefusal(secondCopy(live.store_path));
  const binding = registry.replicaBinding(old.replicaId);
  const lost = lostChanges(binding ? binding.seq_mark : null, input.authorityReceived);
  if (binding) registry.retireReplica(old.replicaId);
  forgetReplicaIdentity(client);
  const identity = establishReplica(
    client,
    {
      block: input.block,
      previous: old.replicaId,
      ...(input.replicaId ? { replicaId: input.replicaId } : {}),
    },
    registry
  );
  return { identity, lost };
}

/**
 * s96-m13 (ADR s96 §9): the refusal for a join on a machine that already holds a live copy of this
 * shared project in another folder, or null. One machine keeps one live copy.
 */
export function secondCopyOnJoin(client: RbookDatabaseClient): RbookToolError | null {
  const other = liveCopyElsewhere(
    ProjectGraphRegistry.getInstance(),
    recordedProjectId(client),
    storeFolder(client.path)
  );
  return other ? secondCopy(other.store_path) : null;
}
