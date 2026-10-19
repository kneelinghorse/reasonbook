// SPDX-License-Identifier: Apache-2.0
// ABOUTME: One referee call (s97-m09, design §R1): the store opened for one step and closed, its registry pinned to its own
// ABOUTME: folder, a store behind the head the last call returned refused as needing recovery, and the new head returned.

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import path from 'path';
import { ProjectGraphRegistry } from '../intelligence/project-graph-registry';
import { validAuthorName } from '../intelligence/user-author';
import { pinWriteAuthor } from '../tools/rbook/author-name';
import { RbookDatabaseClient } from '../tools/rbook/client';
import { createError } from '../tools/rbook/errors';
import { replicaMarks } from '../tools/rbook/record-apply';
import { chainHash } from '../tools/rbook/record-chain';
import { replicaWriteRefusal } from '../tools/rbook/replica-check';
import { COPY_KEYS } from '../tools/rbook/replica-copy-keys';
import {
  carriedRefusal,
  readReplicaIdentity,
  REPLICA_ERROR_CODES,
  REPLICA_KEYS,
} from '../tools/rbook/replica-identity';
import { guardRemedy, readGuardState } from '../tools/rbook/record-guards';
import type { RbookToolError, RbookToolResult } from '../tools/rbook/types';
import { STATE_KEYS } from './accounts';
import { REFEREE_ERROR_CODES, refuse } from './codes';

/** The referee's own stream at the end of a call: its replica, its last sequence and that sequence's chain hash. */
export interface StreamHead {
  readonly replicaId: string;
  readonly seq: number;
  readonly hash: string | null;
}

/** Where a referee store is, and the head the dashboard recorded after the last call (D1). */
export interface RefereeLocation {
  readonly storePath: string;
  /** The folder the library keeps replica bindings under, one folder per referee store (decision #1490). */
  readonly configDir: string;
  readonly expectedHead: StreamHead | null;
}

/** A call's answer for the caller, and the head for the dashboard to record and pass back. */
export interface RefereeOutcome<T> {
  readonly result: RbookToolResult<T>;
  readonly head: StreamHead | null;
  /**
   * s97-m11 (D6): the project moved back to its owner's copy, which has now synced with this referee
   * at the new epoch, so the host archives the store with archiveReferee().
   */
  readonly movedBack?: true;
}

export interface RefereeStep {
  readonly client: RbookDatabaseClient;
  readonly location: RefereeLocation;
  /** The join this store asked for and has not applied: it is no member of the record yet. */
  readonly joining: { readonly replicaId: string; readonly nonce: string } | null;
}

/**
 * One call at a time per process: the engine keeps one replica registry per process, so a call
 * pins it to its own store's folder for as long as it runs (decision #1490). The dashboard runs
 * several projects at once in several workers, each with its own module state.
 */
let queue: Promise<unknown> = Promise.resolve();
export function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/** A store that is not a database, or is damaged: lost, not merely busy. */
const DAMAGED = /not a database|malformed|corrupt/i;

/**
 * The referee state a store keeps, read as data before anything else opens it: its keys, `null`
 * when it has none (this library did not make it), or why it could not be read just now.
 */
function storeState(storePath: string): Map<string, string> | null | { readonly failed: string } {
  let db: Database.Database | null = null;
  try {
    db = new Database(storePath, { readonly: true, fileMustExist: true });
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'referee_state'")
      .get();
    if (!table) return null;
    const rows = db.prepare('SELECT key, value FROM referee_state').all() as Array<{
      key: string;
      value: string;
    }>;
    return new Map(rows.map((row) => [row.key, row.value]));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return DAMAGED.test(message) ? null : { failed: message };
  } finally {
    db?.close();
  }
}

/** A call that could not run just now, such as a busy or unreadable moment: nothing is lost. */
const failedNow = <T>(why: string): RbookToolResult<T> =>
  refuse<T>({
    code: REFEREE_ERROR_CODES.FAILED,
    message: `The referee store could not be used just now: ${why}. Nothing was changed.`,
    suggestion: 'Retry the call; if it keeps failing, check the volume and the store file.',
  });

/** The folder this store's replica bindings live in. */
export function registryFolder(configDir: string, key: string): string {
  return path.join(path.resolve(configDir), 'referees', key);
}

/** The join a store asked for and has not applied, or null. */
export function pendingJoin(
  client: RbookDatabaseClient
): { readonly replicaId: string; readonly nonce: string } | null {
  const row = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    COPY_KEYS.joinPending,
  ]);
  if (!row.success || !row.data?.value) return null;
  try {
    const pending = JSON.parse(row.data.value) as { replicaId?: unknown; nonce?: unknown };
    return typeof pending.replicaId === 'string' && typeof pending.nonce === 'string'
      ? { replicaId: pending.replicaId, nonce: pending.nonce }
      : null;
  } catch {
    return null;
  }
}

/** The referee's own stream head; before its join, the replica it asked to join as, at nothing yet. */
export function streamHead(client: RbookDatabaseClient): StreamHead {
  const joining = pendingJoin(client);
  if (joining) return { replicaId: joining.replicaId, seq: 0, hash: '' };
  const identity = readReplicaIdentity(client, { fresh: true });
  if (!identity) throw new Error('The referee store has no replica identity.');
  const seq = replicaMarks(client)[identity.replicaId] ?? 0;
  return { replicaId: identity.replicaId, seq, hash: chainHash(client, identity.replicaId, seq) };
}

/** Why a store is behind or apart from the head the last call left, or null (fact 32). */
function behindHead(client: RbookDatabaseClient, expected: StreamHead): string | null {
  const hash = chainHash(client, expected.replicaId, expected.seq);
  if (hash === null)
    return `it holds less of its own stream than the last call left (${expected.seq} change(s) of replica ${expected.replicaId})`;
  if (hash !== (expected.hash ?? ''))
    return 'its own stream differs from the one the last call left, as a restored or replaced file leaves it';
  return null;
}

const needsRecovery = <T>(why: string): RbookToolResult<T> =>
  refuse<T>({
    code: REFEREE_ERROR_CODES.NEEDS_RECOVERY,
    message: `This project's referee copy needs recovery: ${why}. Nothing was changed.`,
    suggestion:
      "Stop sharing through the dashboard for this project and mark it as needing recovery; every member's copy keeps the whole record. Never restore a snapshot in place.",
  });

/** The copy-check refusals that mean the referee store is not the one this volume bound. */
const LOST: ReadonlySet<string> = new Set([
  REPLICA_ERROR_CODES.RESTORED,
  REPLICA_ERROR_CODES.NOT_JOINED,
  REPLICA_ERROR_CODES.SECOND_COPY,
]);

/**
 * What the store's own copy check means for a call, or null when the call may run: a store that is
 * not the one this volume bound, or that lost part of its record, needs recovery; guards this version
 * records differently need migrate (which runs anyway); a check that could not run is retried.
 */
function copyCheckAnswer<T>(
  client: RbookDatabaseClient,
  refused: RbookToolError,
  repairing: boolean
): RbookToolResult<T> | null {
  if (LOST.has(refused.code)) return needsRecovery<T>(refused.message);
  if (refused.code !== REPLICA_ERROR_CODES.GUARD_BROKEN) return failedNow<T>(refused.message);
  const state = readGuardState(<R>(sql: string) => {
    const rows = client.getMany<R>(sql);
    if (!rows.success) throw new Error(rows.error?.message ?? sql);
    return rows.data ?? [];
  });
  if (guardRemedy(state) === 'restore') return needsRecovery<T>(refused.message);
  if (repairing) return null;
  return refuse<T>({
    code: REFEREE_ERROR_CODES.MIGRATE_NEEDED,
    message: `This project's referee store records its changes as an older or newer version did: ${refused.message}`,
    suggestion: 'Run migrate() on the store with this library, then retry the call.',
  });
}

/**
 * Open the referee store at `location` for one step, then close it: refuse a missing store, one
 * this library never created, one its copy check refuses and one behind `expectedHead`, before the
 * step runs. Every write is authored as the copy's own name, never this host's user or sign-in.
 */
export async function withReferee<T>(
  location: RefereeLocation,
  step: (opened: RefereeStep) => RbookToolResult<T> | Promise<RbookToolResult<T>>,
  options: {
    readonly headRequired?: boolean;
    /** migrate repairs guards a new version records differently, so a broken guard does not stop it. */
    readonly repairing?: boolean;
  } = {}
): Promise<RefereeOutcome<T>> {
  return exclusive(async () => {
    if (!existsSync(location.storePath))
      return { result: needsRecovery<T>('its store file is missing'), head: null };
    const state = storeState(location.storePath);
    if (state && !(state instanceof Map)) return { result: failedNow<T>(state.failed), head: null };
    const key = state?.get(STATE_KEYS.registry);
    if (!key)
      return {
        result: needsRecovery<T>(
          'its store holds no referee state, so this library did not make it'
        ),
        head: null,
      };
    if (options.headRequired !== false && !location.expectedHead)
      return {
        result: refuse<T>({
          code: REFEREE_ERROR_CODES.HEAD_REQUIRED,
          message: 'This call needs the stream head the last call on this project returned.',
          suggestion:
            'Pass the head you recorded after the last call as expectedHead; if it is lost, the project needs recovery.',
        }),
        head: null,
      };
    let client: RbookDatabaseClient | null = null;
    try {
      await ProjectGraphRegistry.create({ configDir: registryFolder(location.configDir, key) });
      const opened = await RbookDatabaseClient.create({
        dbPath: location.storePath,
        registerProject: false,
        replicaCheck: false,
        loadVec: false,
      });
      if (!opened.success || !opened.data) {
        const why = opened.error?.message ?? 'its store could not be opened';
        return {
          result: DAMAGED.test(why) ? needsRecovery<T>(why) : failedNow<T>(why),
          head: null,
        };
      }
      client = opened.data;
      const author = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
        REPLICA_KEYS.author,
      ]);
      pinWriteAuthor(client, {
        name: author.data?.value ? validAuthorName(author.data.value) : null,
        userId: null,
        source: 'copy',
      });
      const joining = pendingJoin(client);
      if (!joining) {
        const refused = replicaWriteRefusal(client);
        if (refused) {
          const answer = copyCheckAnswer<T>(client, refused, options.repairing === true);
          if (answer) return { result: answer, head: null };
        }
      }
      if (location.expectedHead) {
        const behind = behindHead(client, location.expectedHead);
        if (behind) return { result: needsRecovery<T>(behind), head: null };
      }
      let result: RbookToolResult<T>;
      try {
        result = await step({ client, location, joining });
      } catch (error) {
        const refusal = carriedRefusal(error);
        result = refusal
          ? createError<T>(refusal)
          : refuse<T>({
              code: REFEREE_ERROR_CODES.FAILED,
              message: `The referee call failed: ${error instanceof Error ? error.message : String(error)}`,
              suggestion:
                'Retry the call; a delivery repeats safely, since the engine keeps each change once.',
            });
      }
      return { result, head: headAfter(client) };
    } catch (error) {
      return {
        result: refuse<T>({
          code: REFEREE_ERROR_CODES.FAILED,
          message: `The referee call failed: ${error instanceof Error ? error.message : String(error)}`,
          suggestion: 'Retry the call; if it fails again, the message names what to put right.',
        }),
        head: client ? headAfter(client) : null,
      };
    } finally {
      client?.close();
      ProjectGraphRegistry.resetInstance();
    }
  });
}

/** The head after a step, or null when the store can no longer say it. */
function headAfter(client: RbookDatabaseClient): StreamHead | null {
  try {
    return client.isOpen ? streamHead(client) : null;
  } catch {
    return null;
  }
}
