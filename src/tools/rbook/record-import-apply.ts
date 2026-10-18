// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Applying an import (ADR s96 §9) as this copy's own writes: each row brought in created with the ids the plan
// ABOUTME: gave it, a field only the copy changed set, and a raised field set with the import's base, then one recompute.

import type { RbookDatabaseClient } from './client';
import { createSuccess } from './errors';
import { genesisColumns } from './genesis-columns';
import { clearImportSets, markImportSet, recordedWrite } from './record-changes';
import { RECORD_COLUMNS, type SharedTable } from './record-columns';
import type { CopyRow, FieldChange, ImportPlan, TablePlan } from './record-import-plan';
import { NUMBERED } from './record-import-ids';
import { repairMergedLinks } from './record-derived';
import { recomputeEntities } from './record-recompute';
import { mergeContext, type LoggedChange } from './record-standing';
import { underApplyToken } from './record-token';
import {
  readReplicaIdentity,
  recordedProjectId,
  REPLICA_ERROR_CODES,
  ReplicaRefusal,
} from './replica-identity';
import type { RbookToolResult } from './types';
import type { FirehoseTable } from '../../types/event-types';

/** Referenced rows first, so a create names a row this transaction already wrote. */
const ORDER: readonly SharedTable[] = [
  'sprints',
  'missions',
  'sessions',
  'strategic_decisions',
  'learnings',
  'next_steps',
  'constraints',
  'mission_dependencies',
  'session_missions',
];
const AUTHOR_COLUMNS: ReadonlySet<string> = new Set(['author_name', 'author_user_id']);

export interface ImportApplied {
  readonly created: number;
  readonly set: number;
  /** The raised fields whose conflict opened: an added flag, for one, merges without one. */
  readonly conflicts: number;
  /** Each row whose id moved: `<table>:<copy's id>` to its id in this record. */
  readonly renamed: Readonly<Record<string, string>>;
  /** The import's transactions, whose rows are embedded once it commits. */
  readonly txns: readonly string[];
  /** What the citation links' repair could not do, said rather than refused. */
  readonly notes: readonly string[];
}

function run(client: RbookDatabaseClient, sql: string, params: unknown[] = []): void {
  const done = client.execute(sql, params);
  if (!done.success) throw new Error(done.error?.message ?? `could not write: ${sql}`);
}

function create(
  client: RbookDatabaseClient,
  table: SharedTable,
  row: CopyRow,
  projectId: string,
  ownReplica: string
): void {
  const link = RECORD_COLUMNS[table].link;
  const genesis = link ? null : genesisColumns(client, table as FirehoseTable, projectId);
  const columns: string[] = [];
  const params: unknown[] = [];
  genesis?.columns.forEach((column, index) => {
    // The copy's own author, where its schema held one, stays; the stamp names this copy's.
    if (
      AUTHOR_COLUMNS.has(column) &&
      row.values[column] !== null &&
      row.values[column] !== undefined
    )
      return;
    columns.push(column);
    // The stable id the plan derived, so a later plan on any copy finds this row.
    params.push(column === 'stable_event_id' ? row.stable : genesis.values[index]);
  });
  // The plan gave this id; the write gives the next of the block. They differ only if the two disagree.
  if (NUMBERED.has(table) && genesis && String(params[columns.indexOf('id')]) !== row.to)
    throw new ReplicaRefusal({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message: `${table}: the import planned id ${row.to} for the copy's ${row.id}, and the write would give ${String(params[columns.indexOf('id')])}, so it wrote nothing.`,
      suggestion:
        'Run the dry run again and apply what it prints; if this recurs, report it with the dry run, since the plan and the write disagree.',
    });
  for (const [column, value] of Object.entries(row.values)) {
    if (columns.includes(column)) continue;
    columns.push(column);
    params.push(value);
  }
  // A session the copy left open belongs to no process here, so none adopts it.
  if (table === 'sessions' && row.values.status === 'active') {
    columns.push('owner_key');
    params.push(`import:${ownReplica}`);
  }
  run(
    client,
    `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns
      .map(() => '?')
      .join(', ')})`,
    params
  );
}

function set(client: RbookDatabaseClient, change: FieldChange, imported: boolean): void {
  if (imported) markImportSet(client, change.table, change.stable, change.field);
  run(client, `UPDATE ${change.table} SET "${change.field}" = ? WHERE stable_event_id = ?`, [
    change.write,
    change.stable,
  ]);
}

/** A table's rows brought in, numbered ones in the order the plan numbered them. */
const broughtIn = (plan: TablePlan): CopyRow[] => {
  const rows = [...plan.own, ...plan.included];
  return NUMBERED.has(plan.table) ? rows.sort((a, b) => Number(a.to) - Number(b.to)) : rows;
};

/**
 * Apply the plan on this copy of the shared record, in one write transaction: its rows and fields
 * are this copy's changes, judged as any other, and the merge then keeps both values of a field
 * the import raised (ADR s96 §9).
 */
export function applyImport(
  client: RbookDatabaseClient,
  plan: ImportPlan
): RbookToolResult<ImportApplied> {
  const identity = readReplicaIdentity(client, { fresh: true });
  if (!identity) throw new Error('Only a copy of a shared record takes in an import.');
  const projectId = recordedProjectId(client);
  const tables = new Map(plan.tables.map((table) => [table.table, table]));
  let outcome: ImportApplied = {
    created: 0,
    set: 0,
    conflicts: 0,
    renamed: {},
    txns: [],
    notes: [],
  };
  const done = client.writeTransaction(() => {
    const [{ seq }] = client.getMany<{ seq: number }>(
      'SELECT coalesce(max(replica_seq), 0) AS seq FROM record_changes WHERE replica_id = ?',
      [identity.replicaId]
    ).data ?? [{ seq: 0 }];
    let written: RbookToolResult<ImportApplied>;
    try {
      written = recordedWrite(client, () => {
        client.pragma('defer_foreign_keys = ON');
        let created = 0;
        for (const table of ORDER)
          for (const row of broughtIn(tables.get(table)!)) {
            create(client, table, row, projectId, identity.replicaId);
            created += 1;
          }
        let sets = 0;
        for (const table of plan.tables) {
          for (const change of table.copyChanged) set(client, change, false);
          for (const change of table.conflicts) set(client, change, true);
          sets += table.copyChanged.length;
        }
        const renamed: Record<string, string> = {};
        for (const table of plan.tables)
          if (!RECORD_COLUMNS[table.table].link)
            for (const row of broughtIn(table))
              if (row.to !== row.id) renamed[`${table.table}:${row.id}`] = row.to;
        return createSuccess({ created, set: sets, conflicts: 0, renamed, txns: [], notes: [] });
      });
    } finally {
      // A mark no set consumed, as when the capture recorded an addition, must not reach a later write.
      clearImportSets(client);
    }
    // A refusal keeps its own code and remedy, such as a field another write put in conflict.
    if (!written.success) throw new ReplicaRefusal(written.error!);
    const changes =
      client.getMany<LoggedChange>(
        'SELECT * FROM record_changes WHERE replica_id = ? AND replica_seq > ? ORDER BY replica_seq',
        [identity.replicaId, seq]
      ).data ?? [];
    const txns = [...new Set(changes.map((change) => change.txn_id))];
    // The merge's view of what the import wrote: a field it raised keeps both values. This copy's
    // citation links then take in the rows it brought, as every copy that merges them does.
    const notes = underApplyToken(client, () => {
      recomputeEntities(client, mergeContext(client), new Set(txns), new Set());
      return repairMergedLinks(client, changes);
    });
    const opened = plan.tables
      .flatMap((table) => table.conflicts)
      .filter(
        (change) =>
          (
            client.getMany(
              'SELECT 1 FROM record_conflicts WHERE entity = ? AND entity_id = ? AND field = ?',
              [change.table, change.stable, change.field]
            ).data ?? []
          ).length > 0
      ).length;
    outcome = { ...written.data!, conflicts: opened, txns, notes };
  });
  if (!done.success) return done as unknown as RbookToolResult<ImportApplied>;
  return createSuccess(outcome);
}
