/**
 * rbook_db_restore Tool
 *
 * MCP tool for restoring the active Reasonbook SQLite database from a named snapshot.
 * This operation is destructive and requires explicit confirmation.
 *
 * @module tools/rbook/rbook-db-restore
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { z } from 'zod';
import { withClient } from './client';
import type { RbookToolResult } from './types';
import { RBOOK_ERROR_CODES, RbookErrors, createError, createSuccess } from './errors';
import { REPLICA_ERROR_CODES } from './replica-identity';
import { appendWarnings } from './format-warnings';
import {
  mintProjectId,
  ProjectGraphRegistry,
  readStoreIdentity,
  type ProjectGraphEntry,
} from '../../intelligence/project-graph-registry';
import { registerResolvedProjectStore } from '../../intelligence/project-resolution';

const SNAPSHOT_FILE_EXTENSION = '.sqlite';
const PRE_RESTORE_BACKUP_PREFIX = 'pre-restore-';
const REQUIRED_TABLES = ['missions', 'sessions', 'contexts'] as const;

/**
 * Restore result payload.
 */
export interface RbookDbRestoreResult {
  /** Snapshot ID used for restore */
  snapshotId: string;

  /** Resolved snapshot file path */
  snapshotPath: string;

  /** Auto-backup ID created before restore */
  backupId: string;

  /** Auto-backup file path */
  backupPath: string;

  /** Timestamp when restore finished */
  restoredAt: string;

  /** Post-restore mission count */
  missionCount: number;

  /** Post-restore session count */
  sessionCount: number;

  /** Post-restore context count */
  contextCount: number;

  /** Human-readable summary */
  message: string;
}

interface DbPathResult {
  dbPath: string;
}

interface HealthSummary {
  missionCount: number;
  sessionCount: number;
  contextCount: number;
}

interface PreRestoreGraphState {
  storeIdentity: { project_id: string; name: string } | null;
  entry: ProjectGraphEntry | null;
  defaultProjectId: string | null;
}

interface RollbackResult {
  succeeded: boolean;
  message: string;
}

/**
 * Input schema for rbook_db_restore.
 */
export const rbookDbRestoreSchema = z.object({
  /** Snapshot identifier (from rbook_db_snapshot output) */
  snapshotId: z
    .string()
    .min(1)
    .describe(
      'Snapshot ID to restore from. Use rbook_db(action="snapshot", listOnly=true) to list snapshots.'
    ),

  /** Explicit confirmation required for destructive restore */
  confirm: z
    .boolean()
    .describe(
      'Must be true to proceed. Restore is destructive and replaces the active rbook.sqlite database.'
    ),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookDbRestoreParams = z.infer<typeof rbookDbRestoreSchema>;

/**
 * MCP Tool Definition for rbook_db_restore.
 */
export const rbookDbRestoreToolDefinition = {
  name: 'rbook_db_restore',
  description:
    'Restore the active Reasonbook SQLite database from a named snapshot. ' +
    'Creates an automatic pre-restore backup, validates snapshot schema, and requires explicit confirmation.',
  inputSchema: {
    type: 'object',
    properties: {
      snapshotId: {
        type: 'string',
        description:
          'Snapshot ID to restore from. Use rbook_db(action="snapshot", listOnly=true) to view available snapshots.',
        minLength: 1,
      },
      confirm: {
        type: 'boolean',
        description:
          'Must be true to proceed. Restore is destructive and replaces the active database.',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['snapshotId', 'confirm'],
    additionalProperties: false,
  },
} as const;

/**
 * s96-m13: whether the store file is a copy of a shared record, read without opening a client. A
 * file that cannot be read says no: a damaged store is what a restore is for.
 */
function isSharedStoreFile(dbPath: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const metadata = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'metadata'")
      .get();
    return Boolean(
      metadata &&
      db.prepare("SELECT 1 FROM metadata WHERE key = 'replica_id' AND value <> ''").get()
    );
  } catch (error) {
    process.stderr.write(
      `[RESTORE] Could not read ${dbPath} to see whether it is a copy of a shared record, so the restore goes on: ${error instanceof Error ? error.message : String(error)}\n`
    );
    return false;
  } finally {
    db?.close();
  }
}

/**
 * Execute the rbook_db_restore tool.
 *
 * @param params - Tool parameters
 * @returns Restore status or actionable error
 */
export async function rbookDbRestore(
  params: RbookDbRestoreParams
): Promise<RbookToolResult<RbookDbRestoreResult>> {
  if (params.confirm !== true) {
    return createError({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: 'Restore is destructive and requires confirm=true.',
      field: 'confirm',
      providedValue: params.confirm,
      suggestion: 'Retry with confirm=true after verifying the snapshotId.',
    });
  }

  const snapshotId = params.snapshotId.trim();
  if (!snapshotId) {
    return createError(RbookErrors.missingParameter('snapshotId'));
  }

  if (snapshotId.includes('/') || snapshotId.includes('\\')) {
    return createError({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: 'snapshotId must be a filename or snapshot ID, not a path.',
      field: 'snapshotId',
      providedValue: params.snapshotId,
      suggestion:
        'Use rbook_db(action="snapshot", listOnly=true) and pass one of the listed snapshot IDs.',
    });
  }

  const dbPathResult = await resolveDbPath(params.projectRoot);
  if (!dbPathResult.success || !dbPathResult.data) {
    return createError(
      dbPathResult.error ?? {
        code: 'DB_CONNECTION_FAILED',
        message: 'Failed to resolve active Reasonbook database path.',
        suggestion: 'Check projectRoot or run rbook_db(action="health") for diagnostics.',
      }
    );
  }

  const dbPath = dbPathResult.data.dbPath;
  // s96-m13 (ADR s96 §9): a restore brings back an older file, losing what this copy of a shared
  // record had not synced and leaving a copy the copy check refuses; sync keeps a shared record.
  if (isSharedStoreFile(dbPath))
    return createError({
      code: REPLICA_ERROR_CODES.WRITE_REFUSED,
      message:
        'This store is a copy of a shared record, and a restore would lose the changes it has not synced, so it is refused.',
      suggestion:
        "Sync keeps a shared record up to date: reasonbook sync. A member's copy that is damaged joins afresh (reasonbook copy on the owner's machine, then reasonbook join); the owner's copy is recovered from its members: reasonbook recover.",
    });
  const projectRoot = path.resolve(path.dirname(dbPath), '..', '..');
  const snapshotDirectory = path.join(path.dirname(dbPath), 'snapshots');
  const preRestoreBackupDirectory = path.join(snapshotDirectory, 'pre-restore');
  fs.mkdirSync(preRestoreBackupDirectory, { recursive: true });

  const resolvedSnapshotPath = resolveSnapshotPath(snapshotDirectory, snapshotId);
  if (!resolvedSnapshotPath) {
    return createError(RbookErrors.snapshotNotFound(snapshotId));
  }

  const validationError = validateSnapshotDatabase(resolvedSnapshotPath);
  if (validationError) {
    return createError(validationError);
  }

  // Snapshot validity is known; now capture the live store identity before any destructive step.
  // The database identity is authoritative even when this store has never entered the graph.
  const preRestoreGraphState = await readPreRestoreGraphState(projectRoot);

  const backupId = generatePreRestoreBackupId();
  const backupPath = path.join(preRestoreBackupDirectory, `${backupId}${SNAPSHOT_FILE_EXTENSION}`);

  try {
    await backupDatabase(dbPath, backupPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown backup failure';
    return createError({
      code: RBOOK_ERROR_CODES.SNAPSHOT_RESTORE_FAILED,
      message: `Failed to create pre-restore backup: ${message}`,
      suggestion: 'Check disk space and filesystem permissions before retrying restore.',
    });
  }

  try {
    replaceActiveDatabase(dbPath, resolvedSnapshotPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown restore failure';
    return createError({
      code: RBOOK_ERROR_CODES.SNAPSHOT_RESTORE_FAILED,
      message: `Failed to replace active database: ${message}`,
      suggestion: `Pre-restore backup saved at '${backupPath}'.`,
    });
  }

  const verificationResult = await verifyRestoredDatabase(dbPath);
  if (!verificationResult.success || !verificationResult.data) {
    const rollback = attemptRollback(backupPath, dbPath);
    return createError({
      code: RBOOK_ERROR_CODES.SNAPSHOT_RESTORE_FAILED,
      message:
        verificationResult.error?.message ??
        'Restore verification failed. The database may not be a valid Reasonbook schema.',
      suggestion: `${rollback.message} Inspect snapshot integrity and retry restore.`,
    });
  }

  // The snapshot is now the active store. Preserve the live store's pre-replacement identity
  // before registering THIS post-replacement database: a legacy snapshot may have no project_id,
  // while a foreign snapshot may claim a conflicting id. On failure, put both the database and
  // graph back as they were.
  try {
    reconcileRestoredIdentity(projectRoot, preRestoreGraphState);
    await registerResolvedProjectStore(projectRoot, { requireStoredIdentity: true });
  } catch (error) {
    const registrationMessage = error instanceof Error ? error.message : String(error);
    const rollback = attemptRollback(backupPath, dbPath);
    let graphRecovery = '';
    if (rollback.succeeded) {
      try {
        await restorePreRestoreGraphState(projectRoot, preRestoreGraphState);
      } catch (graphError) {
        const message = graphError instanceof Error ? graphError.message : String(graphError);
        graphRecovery = ` Graph rollback also failed: ${message}.`;
      }
    }
    return createError({
      code: RBOOK_ERROR_CODES.SNAPSHOT_RESTORE_FAILED,
      message: `Restored database could not establish a consistent project identity: ${registrationMessage}`,
      suggestion: `${rollback.message}${graphRecovery} Inspect the snapshot identity before retrying.`,
    });
  }

  const restoredAt = new Date().toISOString();

  return createSuccess({
    snapshotId: normalizeSnapshotId(resolvedSnapshotPath),
    snapshotPath: resolvedSnapshotPath,
    backupId,
    backupPath,
    restoredAt,
    missionCount: verificationResult.data.missionCount,
    sessionCount: verificationResult.data.sessionCount,
    contextCount: verificationResult.data.contextCount,
    message: `Database restored from snapshot '${normalizeSnapshotId(resolvedSnapshotPath)}'.`,
  });
}

/**
 * Format restore result for LLM readability.
 */
export function formatDbRestoreForLLM(result: RbookToolResult<RbookDbRestoreResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to restore database snapshot',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];
    if (error?.suggestion) {
      lines.push('', `Suggestion: ${error.suggestion}`);
    }
    return lines.join('\n');
  }

  const data = result.data;
  const lines = [
    '✅ Database restore complete',
    '',
    `**Snapshot ID**: ${data.snapshotId}`,
    `**Snapshot Path**: ${data.snapshotPath}`,
    `**Pre-Restore Backup**: ${data.backupPath}`,
    `**Restored At**: ${data.restoredAt}`,
    '',
    '**Post-Restore Counts**:',
    `- Missions: ${data.missionCount}`,
    `- Sessions: ${data.sessionCount}`,
    `- Contexts: ${data.contextCount}`,
    '',
    data.message,
  ];

  appendWarnings(lines, result);

  return lines.join('\n');
}

async function resolveDbPath(projectRoot?: string): Promise<RbookToolResult<DbPathResult>> {
  return withClient(
    (client) =>
      createSuccess({
        dbPath: client.path,
      }),
    // Path discovery happens against the database that is about to be replaced. Registering here
    // would mint/touch the pre-restore identity and let the replacement immediately undo it.
    { projectRoot, registerProject: false }
  );
}

async function readPreRestoreGraphState(projectRoot: string): Promise<PreRestoreGraphState> {
  const graph = await ProjectGraphRegistry.create();
  const projectId = graph.getByStorePath(projectRoot);
  return {
    storeIdentity: readStoreIdentity(projectRoot),
    entry: projectId ? (graph.get(projectId) ?? null) : null,
    defaultProjectId: graph.getDefault()?.project_id ?? null,
  };
}

function reconcileRestoredIdentity(projectRoot: string, state: PreRestoreGraphState): void {
  const protectedProjectId = state.storeIdentity?.project_id ?? state.entry?.project_id ?? null;
  if (!protectedProjectId) return;

  const restoredProjectId = readStoreIdentity(projectRoot)?.project_id ?? null;
  if (restoredProjectId && restoredProjectId !== protectedProjectId) {
    throw new Error(
      `Snapshot project identity '${restoredProjectId}' conflicts with active store identity ` +
        `'${protectedProjectId}' for ${projectRoot}`
    );
  }
  if (restoredProjectId === protectedProjectId) return;

  const persistedProjectId = mintProjectId(projectRoot, protectedProjectId);
  if (persistedProjectId !== protectedProjectId) {
    throw new Error(
      `Unable to restore active store identity '${protectedProjectId}' after replacement; ` +
        `persisted '${persistedProjectId ?? 'none'}'`
    );
  }
}

async function restorePreRestoreGraphState(
  projectRoot: string,
  state: PreRestoreGraphState
): Promise<void> {
  const graph = await ProjectGraphRegistry.create();
  const currentProjectId = graph.getByStorePath(projectRoot);
  if (currentProjectId && currentProjectId !== state.entry?.project_id) {
    graph.unregisterStore(projectRoot);
  }
  if (state.entry && graph.getByStorePath(projectRoot) !== state.entry.project_id) {
    const restored = graph.register({
      project_id: state.entry.project_id,
      store_path: state.entry.store_path,
      name: state.entry.name,
    });
    if (
      restored.project_id !== state.entry.project_id ||
      path.resolve(restored.store_path) !== path.resolve(state.entry.store_path)
    ) {
      throw new Error(`Unable to restore graph row '${state.entry.project_id}' after rollback`);
    }
  }

  if (state.defaultProjectId && graph.get(state.defaultProjectId)) {
    graph.setDefault(state.defaultProjectId);
  } else if (!state.defaultProjectId) {
    graph.clearDefault();
  }
}

function resolveSnapshotPath(snapshotDirectory: string, snapshotId: string): string | null {
  const normalized = path.basename(snapshotId);
  const candidates = normalized.endsWith(SNAPSHOT_FILE_EXTENSION)
    ? [normalized]
    : [`${normalized}${SNAPSHOT_FILE_EXTENSION}`, normalized];

  for (const candidate of candidates) {
    const candidatePath = path.join(snapshotDirectory, candidate);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      return candidatePath;
    }
  }

  return null;
}

function normalizeSnapshotId(snapshotPath: string): string {
  const filename = path.basename(snapshotPath);
  return filename.endsWith(SNAPSHOT_FILE_EXTENSION)
    ? filename.slice(0, -SNAPSHOT_FILE_EXTENSION.length)
    : filename;
}

function validateSnapshotDatabase(snapshotPath: string) {
  let db: DatabaseType | null = null;
  try {
    db = new Database(snapshotPath, { readonly: true, fileMustExist: true });

    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const tableSet = new Set(tableRows.map((row) => row.name));
    const missingTables = REQUIRED_TABLES.filter((table) => !tableSet.has(table));

    if (missingTables.length > 0) {
      return {
        code: RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH,
        message: `Snapshot is not a valid Reasonbook database. Missing tables: ${missingTables.join(', ')}`,
        suggestion:
          'Use rbook_db(action="snapshot") to create a valid snapshot from a Reasonbook database.',
      };
    }

    const integrityCheck = db.pragma('integrity_check', { simple: true }) as string;
    if (integrityCheck !== 'ok') {
      return {
        code: RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH,
        message: `Snapshot integrity check failed: ${integrityCheck}`,
        suggestion: 'Select a different snapshot or recreate snapshots from a healthy database.',
      };
    }

    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown SQLite error';
    return {
      code: RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH,
      message: `Snapshot validation failed: ${message}`,
      suggestion: 'Ensure snapshot file exists and is a readable SQLite database.',
    };
  } finally {
    db?.close();
  }
}

async function backupDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  if (fs.existsSync(destinationPath)) {
    fs.rmSync(destinationPath, { force: true });
  }

  const db = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await db.backup(destinationPath);
  } finally {
    db.close();
  }
}

function replaceActiveDatabase(activeDbPath: string, snapshotPath: string): void {
  const tempPath = `${activeDbPath}.restore-${Date.now()}-${randomBytes(2).toString('hex')}`;
  try {
    fs.copyFileSync(snapshotPath, tempPath);
    fs.renameSync(tempPath, activeDbPath);
    cleanupWalFiles(activeDbPath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

async function verifyRestoredDatabase(dbPath: string): Promise<RbookToolResult<HealthSummary>> {
  return withClient(
    (client) => {
      const healthResult = client.health();
      if (!healthResult.success || !healthResult.data) {
        return healthResult as RbookToolResult<HealthSummary>;
      }

      return createSuccess({
        missionCount: healthResult.data.missionCount,
        sessionCount: healthResult.data.sessionCount,
        contextCount: healthResult.data.contextCount,
      });
    },
    { dbPath }
  );
}

function cleanupWalFiles(dbPath: string): void {
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function attemptRollback(backupPath: string, dbPath: string): RollbackResult {
  try {
    fs.copyFileSync(backupPath, dbPath);
    cleanupWalFiles(dbPath);
    return {
      succeeded: true,
      message: `Restore failed; rolled back from '${backupPath}'.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown rollback failure';
    return {
      succeeded: false,
      message: `Restore failed and rollback also failed: ${message}.`,
    };
  }
}

function generatePreRestoreBackupId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '$1Z');
  const suffix = randomBytes(2).toString('hex');
  return `${PRE_RESTORE_BACKUP_PREFIX}${timestamp}-${suffix}`;
}
