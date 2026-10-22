// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The shared record's internal share step (ADR s96 §4): one transaction gives the copy its identity in block 0
// ABOUTME: and the record tables, token, stage, guards and baseline; VACUUM INTO then saves the replay base.

import { mkdirSync, rmSync } from 'fs';
import path from 'path';
import { monotonicFactory } from 'ulid';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import { authorForWrite } from './author-name';
import type { RbookDatabaseClient } from './client';
import { canonicalJson } from './record-capture';
import { recordChanges } from './record-changes';
import { PROJECT_ENTITY, RECORD_COLUMNS, RECORDED_TABLES } from './record-columns';
import {
  forgetRecordedStore,
  identityInvalid,
  identityUnreadable,
  installRecordGuards,
  unclassifiedColumns,
} from './record-guards';
import { establishReplica, readReplicaIdentity, recordedProjectId } from './replica-identity';
import { hasStableIdIndex } from './sharing-preconditions';

const mintId = monotonicFactory();

export interface SharedRecord {
  readonly replicaId: string;
  /** The copy right after its baseline, which the replay check replays the log onto (ADR §4). */
  readonly replayBase: string;
}

/**
 * Where a copy's replay base is kept: beside the registry that binds the copy, so a pinned
 * registry keeps both in one folder, and never in the project folder.
 */
export function replayBasePath(
  replicaId: string,
  registry: ProjectGraphRegistry = ProjectGraphRegistry.getInstance()
): string {
  return path.join(registry.configDirectory, 'replay-bases', `${replicaId}.sqlite`);
}

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `${sql} could not be read.`);
  return read.data ?? [];
}

/** Why this store cannot share yet, or null when it can. */
export function shareBlocker(client: RbookDatabaseClient): string | null {
  if (readReplicaIdentity(client)) return 'it is already a copy of a shared record';
  const row = client.getOne<{ problem: 'unreadable' | 'doubled' | null }>(
    `SELECT CASE WHEN ${identityUnreadable('content')} THEN 'unreadable' WHEN ${identityInvalid('content')} THEN 'doubled' END AS problem FROM contexts WHERE id = 'project_identity'`
  );
  if (!row.success || !row.data) return 'it has no project identity row';
  // The guard holds every later write to this rule (ADR s96 §6), so the stored row must meet it too.
  if (row.data.problem === 'unreadable')
    return 'its project identity is not a plain JSON object, which no tool writes: restore it from a backup';
  if (row.data.problem === 'doubled')
    return 'its project identity names a key twice, which SQLite and the app read differently; an identity update through rbook_context rewrites it';
  for (const table of RECORDED_TABLES) {
    const present = new Set(
      rows<{ name: string }>(client, 'SELECT name FROM pragma_table_info(?)', [table]).map(
        (column) => column.name
      )
    );
    if (!present.size) return `it has no ${table} table`;
    const missing = RECORD_COLUMNS[table].recorded.filter((column) => !present.has(column));
    if (missing.length) return `${table} lacks recorded columns: ${missing.join(', ')}`;
  }
  // A column in no class would be neither guarded nor recorded (ADR §4).
  const unknown = unclassifiedColumns((sql) => rows(client, sql));
  if (unknown.length) return `it has columns no class names: ${unknown.join(', ')}`;
  const unindexed = RECORDED_TABLES.filter(
    (table) => !RECORD_COLUMNS[table].link && !hasStableIdIndex(client, table)
  );
  if (unindexed.length) return `its stable ids are not held unique in ${unindexed.join(', ')}`;
  // ADR §4: the baseline names the owner by author name.
  if (!authorForWrite(client).name)
    return 'it has no author name to name its owner: set one with reasonbook config author <name>, or sign in with rbook_auth(action="login_init"), then rbook_auth(action="login_complete")';
  return null;
}

/**
 * Save the copy's replay base: VACUUM INTO cannot run inside a transaction (fact 30), so it runs
 * right after the share step, and again on its own if that failed.
 */
export function saveReplayBase(
  client: RbookDatabaseClient,
  replicaId: string,
  registry: ProjectGraphRegistry = ProjectGraphRegistry.getInstance()
): string {
  const replayBase = replayBasePath(replicaId, registry);
  mkdirSync(path.dirname(replayBase), { recursive: true });
  rmSync(replayBase, { force: true });
  const saved = client.execute('VACUUM INTO ?', [replayBase]);
  if (!saved.success)
    throw new Error(
      `The replay base was not saved: ${saved.error?.message ?? 'unknown error'}. saveReplayBase retries it.`
    );
  return replayBase;
}

/**
 * Make this store the first authority copy of a shared record. Internal: s96-m13 wraps it in
 * `share`, after prepareForSharing has made the store ready.
 */
export function shareRecord(
  client: RbookDatabaseClient,
  registry: ProjectGraphRegistry = ProjectGraphRegistry.getInstance()
): SharedRecord {
  const blocker = shareBlocker(client);
  if (blocker)
    throw new Error(`This store cannot be shared: ${blocker}. prepareForSharing makes it ready.`);
  let replicaId = '';
  const done = client.writeTransaction(() => {
    replicaId = establishReplica(client, { block: 0 }, registry).replicaId;
    installRecordGuards((sql) => {
      const ran = client.raw(sql);
      if (!ran.success) throw new Error(ran.error?.message ?? 'the record tables were not created');
    });
    forgetRecordedStore(client);
    // ADR §4: the baseline names the owner's author name, the first authority and epoch 1.
    recordChanges(client, mintId(), [
      {
        kind: 'baseline',
        entity: PROJECT_ENTITY,
        entityId: recordedProjectId(client),
        field: null,
        value: canonicalJson({
          owner: authorForWrite(client).name,
          authority: replicaId,
          epoch: 1,
        }),
      },
    ]);
  });
  forgetRecordedStore(client);
  if (!done.success) {
    if (replicaId) registry.retireReplica(replicaId);
    throw new Error(done.error?.message ?? 'The store could not be shared.');
  }
  return { replicaId, replayBase: saveReplayBase(client, replicaId, registry) };
}
