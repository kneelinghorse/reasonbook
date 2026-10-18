// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Writing a shared record's rows under the merge's token (ADR s96 §6): the copy is judged first, so the write
// ABOUTME: check never reads the token as one a crashed writer left, then the token is held only while the work runs.

import { monotonicFactory } from 'ulid';
import type { RbookDatabaseClient } from './client';
import { APPLY_TOKEN_TABLE, beginMerging, endMerging } from './record-guards';
import { guardRefusal, replicaWriteRefusal } from './replica-check';
import { REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';
import type { RbookToolError } from './types';

const mintId = monotonicFactory();

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): void {
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

/**
 * Why this copy may not merge: its copy check's refusal. A restored or replaced copy still merges
 * work that writes none of its own changes, a catch-up or its confirming a move to another copy:
 * each brings it to the move it then re-identifies under, which it could not reach refused them
 * (s96-m13 critics, round 3). Only such work puts the token down on such a copy, and only while its
 * guards hold: a broken one keeps every write out (ADR s96 §6; critics, round 4).
 */
export function mergeRefusal(
  client: RbookDatabaseClient,
  writesNoneOfItsOwn: boolean
): RbookToolError | null {
  const refused = replicaWriteRefusal(client);
  if (!refused || !writesNoneOfItsOwn || refused.code !== REPLICA_ERROR_CODES.RESTORED)
    return refused;
  // Guards that cannot be read fail closed, with the copy's own refusal.
  try {
    return guardRefusal(client);
  } catch {
    return refused;
  }
}

/**
 * Run `work` under the merge's token, inside the caller's write transaction. The write check judges
 * this copy, under its current identity, before the token is down; a copy it refuses writes nothing.
 */
export function underApplyToken<T>(
  client: RbookDatabaseClient,
  work: () => T,
  options: { readonly writesNoneOfItsOwn?: boolean } = {}
): T {
  const refused = mergeRefusal(client, options.writesNoneOfItsOwn === true);
  if (refused) throw new ReplicaRefusal(refused);
  run(client, `INSERT INTO ${APPLY_TOKEN_TABLE} (txn_id) VALUES (?)`, [mintId()]);
  beginMerging(client);
  try {
    return work();
  } finally {
    endMerging(client);
    run(client, `DELETE FROM ${APPLY_TOKEN_TABLE}`);
  }
}
