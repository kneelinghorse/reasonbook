// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read exact stores and selection snapshots without ambient routing or identity fallbacks.
// ABOUTME: Schema preparation runs before reservations and validates cached migration claims.
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { realpathSync, statSync } from 'fs';
import path from 'path';
import { RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import type { SpinOutOptions } from './spin-out';
import type {
  SpinOutIdentity,
  SpinOutKind,
  SpinOutSourceSnapshot,
  SpinOutSqlValue,
} from './spin-out-types';
import { SPIN_OUT_TABLES } from './spin-out-columns';
import { loadLinkInventory } from './record-link-store';
import { listRegisteredStoresReadOnly } from '../../intelligence/registered-stores-readonly';
import {
  ensureAuthorNameColumns,
  ensureAuthorNamespaceColumns,
  ensureReviewTimestamps,
  ensureConstraintsTable,
  ensureDecisionShapeColumns,
  ensureFirehoseEventColumns,
  ensureLearningsTable,
  ensureMissionTimestamps,
  ensureNextStepsTable,
  ensureStrategicDecisionsSchema,
} from './schema-migrations';
import { GENESIS_COLUMN_NAMES } from './genesis-columns';
import { ensureRecordLinks } from './record-links';

export interface BoundSpinOutIdentity extends SpinOutIdentity {
  readonly realPath: string;
  readonly device: number;
  readonly inode: number;
  readonly address: string;
}
export function requireSpinOut<T>(result: RbookToolResult<T>, step: string): T {
  if (!result.success)
    throw new Error(
      `${step}: ${result.error?.code ?? 'DB_ERROR'}: ${result.error?.message ?? 'unknown failure'}`
    );
  return result.data as T;
}
export async function openSpinOut(root: string, readonly: boolean): Promise<RbookDatabaseClient> {
  return requireSpinOut(
    await RbookDatabaseClient.create({
      dbPath: resolveRecordPaths(root).dbPath,
      readonly,
      registerProject: false,
      timeout: 1000,
    }),
    'Open exact spin-out store'
  );
}
export function spinOutIdentity(client: RbookDatabaseClient, root: string): BoundSpinOutIdentity {
  const id = requireSpinOut(
    client.getOne<{ value: string }>("SELECT value FROM metadata WHERE key='project_id'"),
    'Canonical project identity'
  )?.value;
  if (typeof id !== 'string' || !id.trim() || id !== id.trim())
    throw new Error(
      'Canonical metadata.project_id must be nonempty and unambiguous; re-key/register the store before retrying.'
    );
  const labels = requireSpinOut(
    client.getMany<{ key: string; value: string }>(
      "SELECT key,value FROM metadata WHERE key IN ('owner','dashboard_username','dashboard_slug')"
    ),
    'Read source-scoped project address'
  );
  const named = (key: string) => labels.find((row) => row.key === key)?.value?.trim();
  const owner = named('owner') || named('dashboard_username');
  const address = owner
    ? `rbook://${encodeURIComponent(owner)}/${encodeURIComponent(named('dashboard_slug') || id)}`
    : `rbook://${encodeURIComponent(id)}`;
  const actual = realpathSync(client.path);
  const st = statSync(actual);
  return {
    projectId: id,
    root: path.resolve(root),
    storePath: client.path,
    realPath: actual,
    device: st.dev,
    inode: st.ino,
    address,
  };
}
export function validateSpinOutPair(
  source: BoundSpinOutIdentity,
  target?: BoundSpinOutIdentity,
  env?: NodeJS.ProcessEnv
): void {
  const entry = listRegisteredStoresReadOnly(env).find(
    (row) => row.project_id === source.projectId
  );
  if (!entry)
    throw new Error(
      'The source canonical identity is not registered; register its exact root before retrying.'
    );
  const registered = statSync(realpathSync(resolveRecordPaths(entry.store_path).dbPath));
  if (registered.dev !== source.device || registered.ino !== source.inode)
    throw new Error(
      'Project graph source identity resolves to another database; repair registration before retrying.'
    );
  if (
    target &&
    (source.projectId === target.projectId ||
      source.realPath === target.realPath ||
      (source.device === target.device && source.inode === target.inode))
  )
    throw new Error(
      'Source and target must have different canonical project identities and physical databases; re-key/register an unintended duplicate.'
    );
}
export function spinOutSelection(options: SpinOutOptions): Record<string, unknown> {
  if (!!options.sprintId === !!options.missionIds?.length)
    throw new Error('Supply exactly one sprintId or a nonempty missionIds selection.');
  const strings = (values: readonly string[]) => [...new Set(values.map((s) => s.trim()))].sort();
  const ids = (values: readonly number[] = []) => {
    if (values.some((n) => !Number.isSafeInteger(n) || n < 1))
      throw new Error('Record IDs must be positive safe integers.');
    return [...new Set(values)].sort((a, b) => a - b);
  };
  const missions = strings(options.missionIds ?? []);
  if (missions.includes('') || (options.sprintId !== undefined && !options.sprintId.trim()))
    throw new Error('Mission and sprint IDs must be nonempty.');
  return {
    sprintId: options.sprintId?.trim() ?? null,
    missionIds: missions,
    decisionIds: ids(options.decisionIds),
    learningIds: ids(options.learningIds),
    nextStepIds: ids(options.nextStepIds),
  };
}
export function readSpinOutSnapshot(
  client: RbookDatabaseClient,
  projectId: string,
  selection: Record<string, unknown>
): SpinOutSourceSnapshot {
  const missionIds = selection.missionIds as string[];
  const missions = requireSpinOut(
    client.getMany<Record<string, SpinOutSqlValue>>(
      selection.sprintId
        ? 'SELECT * FROM missions WHERE sprint_id=? ORDER BY id'
        : `SELECT * FROM missions WHERE id IN (${missionIds.map(() => '?').join(',')}) ORDER BY id`,
      selection.sprintId ? [selection.sprintId] : missionIds
    ),
    'Select missions'
  );
  if (!missions.length || (!selection.sprintId && missions.length !== missionIds.length))
    throw new Error('Selection contains no missions or missing mission IDs.');
  for (const row of missions)
    if (!['Queued', 'Blocked', 'Deferred', 'Completed', 'Dropped'].includes(String(row.status)))
      throw new Error(
        `Mission ${row.id} has status ${row.status}; settle current work before spin-out.`
      );
  const selected = missions.map((row) => row.id);
  const localMissions = missions
    .filter((row) => row.project_id == null || row.project_id === projectId)
    .map((row) => row.id);
  const snapshot: SpinOutSourceSnapshot = {
    sourceProjectId: projectId,
    selectionDescriptor: selection,
    columns: {} as SpinOutSourceSnapshot['columns'],
    rows: [],
    dependencies: [],
    collisionInventory: loadLinkInventory(client).identities,
  };
  const rows: SpinOutSourceSnapshot['rows'][number][] = [];
  const columns = {} as Record<SpinOutKind, string[]>;
  for (const kind of Object.keys(SPIN_OUT_TABLES) as SpinOutKind[]) {
    const table = SPIN_OUT_TABLES[kind];
    columns[kind] = requireSpinOut(
      client.getMany<{ name: string }>(`PRAGMA table_info(${table})`),
      `${table} columns`
    ).map((row) => row.name);
    const explicit = selection[
      kind === 'decision' ? 'decisionIds' : kind === 'learning' ? 'learningIds' : 'nextStepIds'
    ] as number[];
    if (!columns[kind].length) {
      if (kind === 'mission' || explicit?.length) throw new Error(`Required ${table} is absent`);
      continue;
    }
    const linked = columns[kind].includes('mission_id');
    const localScope = columns[kind].includes('project_id');
    const predicates = [
      linked
        ? `(mission_id IN (${localMissions.map(() => '?').join(',')})${localScope ? ' AND (project_id IS NULL OR project_id=?)' : ''})`
        : '0',
      ...(explicit?.length ? [`id IN (${explicit.map(() => '?').join(',')})`] : []),
    ];
    const found =
      kind === 'mission'
        ? missions
        : requireSpinOut(
            client.getMany<Record<string, SpinOutSqlValue>>(
              `SELECT * FROM ${table} WHERE ${predicates.join(' OR ')} ORDER BY id`,
              [
                ...(linked ? [...localMissions, ...(localScope ? [projectId] : [])] : []),
                ...explicit,
              ]
            ),
            `Select ${table}`
          );
    if (kind !== 'mission' && explicit.some((id) => !found.some((row) => row.id === id)))
      throw new Error(`Explicit ${kind} IDs contain missing records`);
    for (const values of found)
      rows.push({
        key: kind === 'mission' ? { kind, id: String(values.id) } : { kind, id: Number(values.id) },
        values,
      });
  }
  const dependencies = requireSpinOut(
    client.getMany<SpinOutSourceSnapshot['dependencies'][number]>(
      `SELECT from_id,to_id,type FROM mission_dependencies WHERE from_id IN (${selected.map(() => '?').join(',')}) OR to_id IN (${selected.map(() => '?').join(',')}) ORDER BY from_id,to_id,type`,
      [...selected, ...selected]
    ),
    'Read incident dependencies'
  );
  return { ...snapshot, columns, rows, dependencies };
}
export function prepareSpinOutStore(client: RbookDatabaseClient, warnings: string[]): void {
  // Pending tables must precede the firehose marker; cached markers do not prove column presence.
  for (const ensure of [
    ensureStrategicDecisionsSchema,
    ensureMissionTimestamps,
    ensureLearningsTable,
    ensureNextStepsTable,
    ensureConstraintsTable,
    ensureReviewTimestamps,
  ])
    warnings.push(...(ensure(client).warnings ?? []));
  for (const table of ['missions', 'strategic_decisions', 'learnings']) {
    const columns = requireSpinOut(
      client.getMany<{ name: string }>(`PRAGMA table_info(${table})`),
      'Inspect embedding cache column'
    );
    if (!columns.some((column) => column.name === 'last_embedded_hash'))
      requireSpinOut(
        client.execute(`ALTER TABLE ${table} ADD COLUMN last_embedded_hash TEXT`),
        'Prepare nullable embedding cache'
      );
  }
  const missingGenesis = Object.values(SPIN_OUT_TABLES).some((table) => {
    const cols = requireSpinOut(
      client.getMany<{ name: string }>(`PRAGMA table_info(${table})`),
      'Preflight columns'
    );
    return GENESIS_COLUMN_NAMES.some((name) => !cols.some((c) => c.name === name));
  });
  if (missingGenesis)
    requireSpinOut(
      client.execute("DELETE FROM metadata WHERE key='firehose_event_columns'"),
      'Invalidate incomplete firehose marker'
    );
  warnings.push(
    ...(ensureFirehoseEventColumns(client).warnings ?? []),
    ...(ensureAuthorNamespaceColumns(client).warnings ?? []),
    ...(ensureAuthorNameColumns(client).warnings ?? [])
  );
  const shape = ensureDecisionShapeColumns(client);
  warnings.push(...(shape.warnings ?? []));
  if (!shape.ready) throw new Error('Required decision shape migration failed');
  for (const table of Object.values(SPIN_OUT_TABLES)) {
    const cols = requireSpinOut(
      client.getMany<{ name: string }>(`PRAGMA table_info(${table})`),
      'Verify spin-out columns'
    );
    for (const name of [...GENESIS_COLUMN_NAMES, 'author_user_id', 'author_name'])
      if (!cols.some((c) => c.name === name))
        throw new Error(
          `${table}.${name} is missing despite migration marker; repair the schema before retrying.`
        );
  }
  if (
    !requireSpinOut(
      client.getOne("SELECT id FROM contexts WHERE id='master_context'"),
      'Verify master context'
    )
  )
    throw new Error('Required target master_context is missing');
  const links = ensureRecordLinks(client);
  warnings.push(...(links.warnings ?? []));
  if (!links.ready) throw new Error('Required record links migration failed');
}
