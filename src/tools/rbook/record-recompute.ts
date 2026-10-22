// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Recomputes after a merge (ADR s96 §5): re-evaluates each touched transaction and every one not yet live,
// ABOUTME: follows a create's dependents when its standing moves, and writes each affected entity, parents first.

import type { RbookDatabaseClient } from './client';
import { TEXT_KEYED } from './record-alias';
import { PROJECT_ENTITY, RECORD_COLUMNS, type SharedTable } from './record-columns';
import { entityState } from './record-merge';
import { materializeEntity, MissingRowError } from './record-materialize';
import { renumberRows } from './record-renumber';
import {
  txnStanding,
  verdictOn,
  type LoggedChange,
  type MergeContext,
  type Standing,
} from './record-standing';

export interface RecomputeOutcome {
  readonly entities: number;
  readonly held: number;
  readonly conflicts: number;
}

const DATA_KINDS: ReadonlySet<string> = new Set([
  'create',
  'set',
  'append',
  'link',
  'unlink',
  'settle',
]);

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): void {
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

/** The other creates that claim a created mission's or sprint's text id (ADR s96 §3). */
function otherClaimants(
  client: RbookDatabaseClient,
  create: LoggedChange
): Array<{ entity: string; entity_id: string }> {
  if (!TEXT_KEYED.has(create.entity)) return [];
  return rows<{ entity: string; entity_id: string }>(
    client,
    `SELECT entity, entity_id FROM record_changes WHERE kind = 'create' AND entity = ?
        AND json_extract(value, '$.id') = json_extract(?, '$.id') AND change_id <> ?`,
    [create.entity, create.value, create.change_id]
  );
}

/** Transactions that name a row or write to it, besides the one that created it. */
function dependentsOf(client: RbookDatabaseClient, stableId: string, creator: string): string[] {
  return rows<{ txn_id: string }>(
    client,
    `SELECT DISTINCT txn_id FROM record_changes
      WHERE txn_id <> ? AND ((entity_id = ? AND kind <> 'create') OR value LIKE ? ESCAPE '\\')`,
    [creator, stableId, `%"ref":"${stableId.replace(/[\\%_]/g, (char) => `\\${char}`)}"%`]
  ).map((row) => row.txn_id);
}

const isEntityChange = (change: LoggedChange): boolean =>
  DATA_KINDS.has(change.kind) &&
  change.entity_id !== null &&
  (change.entity === PROJECT_ENTITY || change.entity in RECORD_COLUMNS);

/**
 * Re-evaluate the touched transactions and every one this copy had not taken as live, follow a
 * create's dependents when its standing moved, record each standing that is not live, and write
 * every entity those transactions change.
 */
export function recomputeEntities(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  touched: ReadonlySet<string>,
  arrived: ReadonlySet<string>
): RecomputeOutcome {
  if (!client.inTransaction) throw new Error('Recompute requires an encompassing transaction.');
  // A claim rename changes a parent id before rewriting its children. Keep foreign keys enabled,
  // but check the finished graph at COMMIT; SQLite resets this flag on commit or rollback.
  client.pragma('defer_foreign_keys = ON');
  const before = new Map(
    rows<{ txn_id: string; state: string }>(
      client,
      'SELECT txn_id, state FROM record_txn_state'
    ).map((row) => [row.txn_id, row.state])
  );
  const queue = [...touched, ...before.keys()];
  const evaluated = new Map<string, Standing>();
  const entities = new Map<string, { entity: string; entityId: string }>();
  while (queue.length) {
    const txnId = queue.pop()!;
    if (evaluated.has(txnId)) continue;
    const standing = txnStanding(client, ctx, txnId);
    evaluated.set(txnId, standing);
    const changes = rows<LoggedChange>(client, 'SELECT * FROM record_changes WHERE txn_id = ?', [
      txnId,
    ]);
    // A transaction that arrived now had no standing here; any other this copy held was live unless
    // it was kept as waiting, even one a verdict touched now, such as this copy's own write.
    const was = before.get(txnId) ?? (arrived.has(txnId) ? null : 'live');
    // Its rows are written when it arrived, a verdict touched it, or its standing moved; a waiting
    // transaction whose standing did not move changes no row (the engine critic's second round).
    if (touched.has(txnId) || was !== standing.state)
      for (const change of changes) {
        if (isEntityChange(change))
          entities.set(`${change.entity}\u0000${change.entity_id}`, {
            entity: change.entity,
            entityId: change.entity_id!,
          });
        // s96-m13: a renumber writes again each row it moves, held here or arriving later.
        for (const moved of renumberRows(change))
          entities.set(`${moved.entity}\u0000${moved.entityId}`, {
            entity: moved.entity,
            entityId: moved.entityId,
          });
      }
    // A create whose standing moved moves its dependents' standing with it, and the alias rule may
    // give another create of the same mission or sprint id back its plain id.
    if (was !== null && was !== standing.state)
      for (const create of changes.filter(
        (change) => change.kind === 'create' && change.entity_id
      )) {
        queue.push(...dependentsOf(client, create.entity_id!, txnId));
        for (const claimant of otherClaimants(client, create))
          entities.set(`${claimant.entity}\u0000${claimant.entity_id}`, {
            entity: claimant.entity,
            entityId: claimant.entity_id,
          });
      }
  }
  for (const [txnId, standing] of evaluated) {
    if (standing.state === 'live') {
      run(client, 'DELETE FROM record_txn_state WHERE txn_id = ?', [txnId]);
      continue;
    }
    const [first] = rows<{ replica_id: string }>(
      client,
      'SELECT replica_id FROM record_changes WHERE txn_id = ? LIMIT 1',
      [txnId]
    );
    run(
      client,
      `INSERT INTO record_txn_state (txn_id, replica_id, state, cause) VALUES (?, ?, ?, ?)
         ON CONFLICT (txn_id) DO UPDATE SET replica_id = excluded.replica_id, state = excluded.state, cause = excluded.cause`,
      [
        txnId,
        first?.replica_id ?? verdictOn(client, ctx, txnId)?.replica ?? '',
        standing.state,
        standing.cause ?? '',
      ]
    );
  }
  writeEntities(client, ctx, [...entities.values()]);
  const [{ held }] = rows<{ held: number }>(
    client,
    "SELECT count(*) AS held FROM record_txn_state WHERE state = 'held'"
  );
  const [{ conflicts }] = rows<{ conflicts: number }>(
    client,
    'SELECT count(*) AS conflicts FROM record_conflicts'
  );
  return { entities: entities.size, held, conflicts };
}

/** Write each entity; one that names a row not written yet waits for the next pass, parents first. */
function writeEntities(
  client: RbookDatabaseClient,
  ctx: MergeContext,
  entities: ReadonlyArray<{ entity: string; entityId: string }>
): void {
  // Links come last: both their ends must be written first.
  let pending = [...entities].sort((a, b) => Number(isLink(a.entity)) - Number(isLink(b.entity)));
  while (pending.length) {
    const waiting: typeof pending = [];
    let lastError: unknown = null;
    for (const item of pending)
      try {
        materializeEntity(client, ctx, entityState(client, ctx, item.entity, item.entityId));
      } catch (error) {
        if (!(error instanceof MissingRowError)) throw error;
        waiting.push(item);
        lastError = error;
      }
    if (waiting.length === pending.length) throw lastError;
    pending = waiting;
  }
}

const isLink = (entity: string): boolean =>
  entity !== PROJECT_ENTITY && Boolean(RECORD_COLUMNS[entity as SharedTable]?.link);
