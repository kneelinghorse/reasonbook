/**
 * rbook_db Tool
 *
 * Consolidated database admin tool with action parameter support.
 * Actions: health, snapshot, restore, backfill, reconcile, purge, identify_orphans, pull, clone,
 * prune_snapshots, conflicts, settle.
 * Routes to existing DB handlers without rewriting business logic.
 *
 * @module tools/rbook/rbook-db
 */

import { directoryCallError } from '../../edition';
import { z } from 'zod';
import { createError, RbookErrors } from './errors';
import { findWrongTypedStringParam } from './param-type-guard';
import type { ActionParamMap, RbookToolResult } from './types';
import {
  rbookDbHealth,
  type RbookDbHealthParams,
  type RbookDbHealthResult,
} from './rbook-db-health';
import {
  rbookDbSnapshot,
  type RbookDbSnapshotParams,
  type RbookDbSnapshotResult,
} from './rbook-db-snapshot';
import {
  rbookDbRestore,
  type RbookDbRestoreParams,
  type RbookDbRestoreResult,
} from './rbook-db-restore';
import {
  rbookDbBackfill,
  type RbookDbBackfillParams,
  type RbookDbBackfillResult,
} from './rbook-db-backfill';
import {
  rbookDbReconcile,
  type ReconciliationResult,
  rbookDbPurge,
  type PurgeResult,
  identifyPgOrphans,
  type PgOrphanReport,
} from './rbook-db-backfill';
import { syncPull, type SyncPullResult } from './sync-pull';
import { syncBootstrap, type SyncBootstrapResult } from './sync-bootstrap';
import {
  rbookDbPruneSnapshots,
  type RbookDbPruneSnapshotsParams,
  type RbookDbPruneSnapshotsResult,
} from './rbook-db-prune-snapshots';
import {
  rbookDbConflicts,
  rbookDbSettle,
  type RbookDbConflictsResult,
  type RbookDbSettleResult,
} from './rbook-db-conflicts';

export const RBOOK_DB_ACTIONS = [
  'health',
  'snapshot',
  'restore',
  'backfill',
  'reconcile',
  'purge',
  'identify_orphans',
  'pull',
  'clone',
  'prune_snapshots',
  'conflicts',
  'settle',
] as const;

export type RbookDbAction = (typeof RBOOK_DB_ACTIONS)[number];

/** s86-m04 — which published parameter applies to which action (see action-params.ts). */
export const RBOOK_DB_ACTION_PARAMS: ActionParamMap<RbookDbAction, RbookDbParams> = {
  health: ['action', 'projectRoot'],
  snapshot: ['action', 'listOnly', 'maxSnapshots', 'projectRoot'],
  restore: ['action', 'snapshotId', 'confirm', 'projectRoot'],
  backfill: ['action', 'force', 'dryRun', 'projectRoot'],
  reconcile: ['action', 'projectRoot'],
  purge: ['action', 'confirm', 'expectedSlug', 'projectRoot'],
  identify_orphans: ['action', 'projectRoot'],
  pull: ['action', 'slug', 'limit', 'maxPages', 'projectRoot'],
  clone: ['action', 'slug', 'projectRoot'],
  prune_snapshots: [
    'action',
    'confirm',
    'keepIds',
    'keepSince',
    'keepSources',
    'keepLast',
    'projectRoot',
  ],
  conflicts: ['action', 'projectRoot'],
  settle: ['action', 'table', 'recordId', 'field', 'value', 'projectRoot'],
};

export type RbookDbResult =
  | RbookDbHealthResult
  | RbookDbSnapshotResult
  | RbookDbRestoreResult
  | RbookDbBackfillResult
  | ReconciliationResult
  | PurgeResult
  | PgOrphanReport
  | SyncPullResult
  | SyncBootstrapResult
  | RbookDbPruneSnapshotsResult
  | RbookDbConflictsResult
  | RbookDbSettleResult;

export const rbookDbSchema = z
  .object({
    action: z
      .enum(RBOOK_DB_ACTIONS)
      .describe(
        'Database action: health | snapshot | restore | backfill | reconcile | purge | identify_orphans | pull | clone | prune_snapshots | conflicts | settle'
      ),
    // s96-m12: settle params
    table: z.string().optional().describe('settle: the table, or "project" for the identity'),
    recordId: z.string().optional().describe('settle: the row id as this copy shows it'),
    field: z.string().optional().describe('settle: the conflicted field'),
    value: z.unknown().optional().describe('settle: the value to keep'),
    // pull/clone params (Sprint 71 m02 PULL consumer + m03 clone-from-/state)
    slug: z
      .string()
      .optional()
      .describe('Legacy pull/clone option; both actions are retired. Use reasonbook sync.'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Legacy pull option; pull is retired. Use reasonbook sync.'),
    maxPages: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Legacy pull option; pull is retired. Use reasonbook sync.'),
    // snapshot params
    listOnly: z.boolean().optional().describe('List snapshots instead of creating one'),
    maxSnapshots: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'snapshot: how many database snapshots to keep (default RBOOK_MAX_SNAPSHOTS or 50); taking one deletes the oldest beyond it, automatic ones included'
      ),
    // restore params
    snapshotId: z
      .string()
      .optional()
      .describe('Snapshot ID for restore action (required for restore)'),
    confirm: z
      .boolean()
      .optional()
      .describe(
        'Confirmation flag for restore/purge/prune_snapshots actions (required for restore; prune_snapshots is a dry run without it)'
      ),
    // prune_snapshots params (s92-m09)
    keepIds: z
      .array(z.number().int().positive())
      .optional()
      .describe('prune_snapshots: context snapshot ids to keep, whatever else applies'),
    keepSince: z
      .string()
      .optional()
      .describe('prune_snapshots: keep every snapshot created at or after this date'),
    keepSources: z
      .array(z.string())
      .optional()
      .describe(
        'prune_snapshots: keep every snapshot whose source matches one of these patterns (* = anything, case-insensitive)'
      ),
    keepLast: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'prune_snapshots: snapshots still holding content kept per context, newest first (default 30)'
      ),
    // backfill params
    force: z
      .boolean()
      .optional()
      .describe('Legacy backfill option; SQLite uploads already include the full store.'),
    dryRun: z
      .boolean()
      .optional()
      .describe('Retired event-replay preview; returns LEGACY_SYNC_RETIRED. Use reasonbook sync.'),
    expectedSlug: z
      .string()
      .optional()
      .describe('Expected project slug for guardrail checks on purge (optional)'),
    projectRoot: z
      .string()
      .optional()
      .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
  })
  .strict();

export type RbookDbParams = z.infer<typeof rbookDbSchema>;

export const rbookDbToolDefinition = {
  name: 'rbook_db',
  description:
    'Consolidated database admin tool with action parameter support. ' +
    'Actions: health, snapshot, restore, backfill, reconcile, purge, identify_orphans, pull, clone, prune_snapshots, conflicts, settle. ' +
    'pull and clone are retired and return LEGACY_SYNC_RETIRED; use reasonbook sync. backfill retains registered owner SQLite upload; event replay and its dry run are retired. ' +
    'On a shared project, conflicts lists each field that holds values from copies that had not seen each other, and settle keeps one value for it. ' +
    'prune_snapshots reclaims the content of automatic context-snapshot copies: a dry run unless confirm=true, which takes a database snapshot first and empties content without deleting any row; referenced snapshots, sprint milestones and snapshots someone named are always kept. ' +
    'Routes to the existing DB handlers without changing DB business logic.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: [...RBOOK_DB_ACTIONS],
        description:
          'Database action: health | snapshot | restore | backfill | reconcile | purge | identify_orphans | pull | clone | prune_snapshots | conflicts | settle',
      },
      table: { type: 'string', description: 'settle: the table, or "project" for the identity' },
      recordId: { type: 'string', description: 'settle: the row id as this copy shows it' },
      field: { type: 'string', description: 'settle: the conflicted field' },
      value: { description: 'settle: the value to keep' },
      listOnly: { type: 'boolean', description: 'List snapshots instead of creating one' },
      maxSnapshots: {
        type: 'integer',
        minimum: 1,
        description:
          'snapshot: how many database snapshots to keep (default RBOOK_MAX_SNAPSHOTS or 50); taking one deletes the oldest beyond it, automatic ones included',
      },
      snapshotId: { type: 'string', description: 'Snapshot ID for restore action' },
      confirm: {
        type: 'boolean',
        description:
          'Confirmation flag for restore/purge/prune_snapshots actions (prune_snapshots is a dry run without it)',
      },
      keepIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description: 'prune_snapshots: context snapshot ids to keep, whatever else applies',
      },
      keepSince: {
        type: 'string',
        description: 'prune_snapshots: keep every snapshot created at or after this date',
      },
      keepSources: {
        type: 'array',
        items: { type: 'string' },
        description:
          'prune_snapshots: keep every snapshot whose source matches one of these patterns (* = anything, case-insensitive)',
      },
      keepLast: {
        type: 'integer',
        minimum: 0,
        description:
          'prune_snapshots: snapshots still holding content kept per context, newest first (default 30)',
      },
      force: {
        type: 'boolean',
        description: 'Legacy backfill option; SQLite uploads already include the full store.',
      },
      dryRun: {
        type: 'boolean',
        description:
          'Retired event-replay preview; returns LEGACY_SYNC_RETIRED. Use reasonbook sync.',
      },
      expectedSlug: {
        type: 'string',
        description: 'Expected project slug for guardrail checks on purge',
      },
      slug: {
        type: 'string',
        description: 'Legacy pull/clone option; both actions are retired. Use reasonbook sync.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'Legacy pull option; pull is retired. Use reasonbook sync.',
      },
      maxPages: {
        type: 'integer',
        minimum: 1,
        description: 'Legacy pull option; pull is retired. Use reasonbook sync.',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
} as const;

function isDbAction(value: string): value is RbookDbAction {
  return (RBOOK_DB_ACTIONS as readonly string[]).includes(value);
}

export async function rbookDb(params: RbookDbParams): Promise<RbookToolResult<RbookDbResult>> {
  const editionError = directoryCallError('rbook_db', params);
  if (editionError) return createError(editionError);
  const actionValue =
    typeof (params as { action?: unknown }).action === 'string' ? params.action : '';

  if (!isDbAction(actionValue)) {
    return createError<RbookDbResult>(
      RbookErrors.invalidAction('rbook_db', actionValue, RBOOK_DB_ACTIONS)
    );
  }

  // s89-m08 — ONE schema-driven boundary guard, placed immediately after action normalisation so
  // no handler can be reached with a wrong-typed published string parameter. It reads this tool's
  // OWN shipped inputSchema and its OWN per-action applicability contract, so it can drift from
  // neither, and it is scoped to the parameters THIS action actually uses. See param-type-guard.ts
  // for the 714-triple measurement, the action-scoping evidence, and the null rationale.
  const wrongTypedParam = findWrongTypedStringParam(
    rbookDbToolDefinition.inputSchema,
    RBOOK_DB_ACTION_PARAMS[actionValue],
    params
  );
  if (wrongTypedParam) return createError<RbookDbResult>(wrongTypedParam);

  switch (actionValue) {
    case 'health':
      return rbookDbHealth({
        projectRoot: params.projectRoot,
      } satisfies RbookDbHealthParams);
    case 'snapshot':
      return rbookDbSnapshot({
        listOnly: params.listOnly,
        maxSnapshots: params.maxSnapshots,
        projectRoot: params.projectRoot,
      } satisfies RbookDbSnapshotParams);
    case 'restore':
      return rbookDbRestore({
        snapshotId: params.snapshotId ?? '',
        confirm: params.confirm ?? false,
        projectRoot: params.projectRoot,
      } satisfies RbookDbRestoreParams);
    case 'backfill':
      return rbookDbBackfill({
        force: params.force,
        dryRun: params.dryRun,
        projectRoot: params.projectRoot,
      } satisfies RbookDbBackfillParams);
    case 'reconcile':
      return rbookDbReconcile({
        projectRoot: params.projectRoot,
      });
    case 'purge':
      return rbookDbPurge({
        confirm: params.confirm,
        expectedSlug: params.expectedSlug,
        projectRoot: params.projectRoot,
      });
    case 'identify_orphans':
      return identifyPgOrphans({
        projectRoot: params.projectRoot,
      });
    case 'pull':
      return syncPull({
        slug: params.slug,
        limit: params.limit,
        maxPages: params.maxPages,
        projectRoot: params.projectRoot,
      });
    case 'clone':
      return syncBootstrap({
        slug: params.slug,
        projectRoot: params.projectRoot,
      });
    case 'prune_snapshots':
      return rbookDbPruneSnapshots({
        confirm: params.confirm,
        keepIds: params.keepIds,
        keepSince: params.keepSince,
        keepSources: params.keepSources,
        keepLast: params.keepLast,
        projectRoot: params.projectRoot,
      } satisfies RbookDbPruneSnapshotsParams);
    case 'conflicts':
      return rbookDbConflicts({ projectRoot: params.projectRoot });
    case 'settle':
      return rbookDbSettle({
        table: params.table,
        recordId: params.recordId,
        field: params.field,
        value: params.value,
        projectRoot: params.projectRoot,
      });
  }
}

export { formatDbForLLM } from './rbook-db-format';
