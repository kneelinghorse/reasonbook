// ABOUTME: Creates and lists database snapshots with bounded retention.
// ABOUTME: Refuses invalid explicit retention before opening the store or changing snapshot files.
/**
 * rbook_db_snapshot Tool
 *
 * MCP tool for creating and listing SQLite database snapshots.
 * Snapshots are stored in rbook/db/snapshots and can be restored
 * later with rbook_db_restore.
 *
 * @module tools/rbook/rbook-db-snapshot
 */

import { getSetting } from '../../intelligence/legacy-compat';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { withClient } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess } from './errors';
import { appendWarnings } from './format-warnings';
import { compareStoredTimes } from './stored-time';

const SNAPSHOT_FILE_PREFIX = 'snapshot-';
const SNAPSHOT_FILE_EXTENSION = '.sqlite';
const DEFAULT_MAX_SNAPSHOTS = 50;

/**
 * Snapshot metadata.
 */
export interface DbSnapshotMetadata {
  /** Snapshot identifier (filename without extension) */
  id: string;

  /** Snapshot filename */
  filename: string;

  /** Absolute snapshot file path */
  path: string;

  /** Snapshot file size in bytes */
  sizeBytes: number;

  /** Snapshot creation timestamp */
  createdAt: string;
}

/**
 * Result payload for rbook_db_snapshot.
 */
export interface RbookDbSnapshotResult {
  /** Operation mode */
  mode: 'create' | 'list';

  /** Snapshot storage directory */
  snapshotDirectory: string;

  /** Maximum retained snapshots */
  maxSnapshots: number;

  /** Available snapshots (newest first) */
  snapshots: DbSnapshotMetadata[];

  /** Created snapshot (create mode only) */
  createdSnapshot: DbSnapshotMetadata | null;

  /** Mission count captured at snapshot creation */
  missionCount: number | null;

  /** Session count captured at snapshot creation */
  sessionCount: number | null;

  /** Snapshot IDs pruned by retention */
  prunedSnapshotIds: string[];

  /** Human-readable summary */
  message: string;
}

interface DbStats {
  dbPath: string;
  missionCount: number;
  sessionCount: number;
}

/**
 * Input schema for rbook_db_snapshot.
 */
export const rbookDbSnapshotSchema = z.object({
  /** Optional: list snapshots without creating a new one */
  listOnly: z
    .boolean()
    .optional()
    .describe(
      'If true, return existing snapshots only. If false (default), create a new snapshot first.'
    ),

  /** Optional: maximum snapshots to retain (oldest removed first) */
  maxSnapshots: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      'Maximum number of snapshots to keep (default from RBOOK_MAX_SNAPSHOTS env or 50). Oldest snapshots are removed first.'
    ),

  /** Optional: explicit project root to search from */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookDbSnapshotParams = z.infer<typeof rbookDbSnapshotSchema>;

/**
 * MCP Tool Definition for rbook_db_snapshot.
 */
export const rbookDbSnapshotToolDefinition = {
  name: 'rbook_db_snapshot',
  description:
    'Create or list SQLite database snapshots for Reasonbook safety operations. ' +
    'Creates timestamped snapshots in rbook/db/snapshots, returns metadata, and enforces configurable retention.',
  inputSchema: {
    type: 'object',
    properties: {
      listOnly: {
        type: 'boolean',
        description:
          'If true, list existing snapshots only. If false (default), create a new snapshot first.',
      },
      maxSnapshots: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description:
          'Maximum snapshots to keep (default: RBOOK_MAX_SNAPSHOTS env or 50). Oldest are pruned first.',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_db_snapshot tool.
 *
 * @param params - Tool parameters
 * @returns Snapshot metadata or actionable error
 */
export async function rbookDbSnapshot(
  params: RbookDbSnapshotParams = {}
): Promise<RbookToolResult<RbookDbSnapshotResult>> {
  if (
    params.maxSnapshots !== undefined &&
    (!Number.isInteger(params.maxSnapshots) || params.maxSnapshots < 1)
  ) {
    return createError({
      code: 'INVALID_PARAMETER',
      field: 'maxSnapshots',
      providedValue: params.maxSnapshots,
      message: "Invalid value for parameter 'maxSnapshots'",
      suggestion: 'Provide maxSnapshots as an integer of at least 1, or omit it for the default.',
    });
  }
  const maxSnapshots = resolveMaxSnapshots(params.maxSnapshots);
  const listOnly = params.listOnly === true;

  const statsResult = await getDatabaseStats(params.projectRoot);
  if (!statsResult.success || !statsResult.data) {
    return createError(
      statsResult.error ?? {
        code: 'DB_QUERY_FAILED',
        message: 'Failed to gather database statistics for snapshot.',
        suggestion: 'Check database connectivity with rbook_db(action="health") and retry.',
      }
    );
  }

  const stats = statsResult.data;
  const snapshotDirectory = getSnapshotDirectory(stats.dbPath);
  ensureDirectory(snapshotDirectory);

  if (listOnly) {
    const snapshots = listSnapshots(snapshotDirectory);
    return createSuccess({
      mode: 'list',
      snapshotDirectory,
      maxSnapshots,
      snapshots,
      createdSnapshot: null,
      missionCount: null,
      sessionCount: null,
      prunedSnapshotIds: [],
      message: `Found ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}.`,
    });
  }

  const snapshotId = generateSnapshotId();
  const snapshotFilename = `${snapshotId}${SNAPSHOT_FILE_EXTENSION}`;
  const snapshotPath = path.join(snapshotDirectory, snapshotFilename);

  try {
    await backupDatabase(stats.dbPath, snapshotPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown backup failure';
    return createError({
      code: 'SNAPSHOT_CREATION_FAILED',
      message: `Failed to create database snapshot: ${message}`,
      suggestion: 'Check filesystem permissions and available disk space.',
    });
  }

  const prunedSnapshotIds = pruneSnapshots(snapshotDirectory, maxSnapshots);
  const snapshots = listSnapshots(snapshotDirectory);
  const createdSnapshot =
    snapshots.find((snapshot) => snapshot.id === snapshotId) ??
    toSnapshotMetadata(snapshotPath, snapshotFilename);

  return createSuccess({
    mode: 'create',
    snapshotDirectory,
    maxSnapshots,
    snapshots,
    createdSnapshot,
    missionCount: stats.missionCount,
    sessionCount: stats.sessionCount,
    prunedSnapshotIds,
    message:
      prunedSnapshotIds.length > 0
        ? `Snapshot '${snapshotId}' created. Pruned ${prunedSnapshotIds.length} old snapshot${prunedSnapshotIds.length === 1 ? '' : 's'}.`
        : `Snapshot '${snapshotId}' created successfully.`,
  });
}

/**
 * Format snapshot results for LLM readability.
 */
export function formatDbSnapshotForLLM(result: RbookToolResult<RbookDbSnapshotResult>): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to process database snapshot',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];
    if (error?.suggestion) {
      lines.push('', `Suggestion: ${error.suggestion}`);
    }
    return lines.join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  if (data.mode === 'create' && data.createdSnapshot) {
    lines.push('✅ Database snapshot created');
    lines.push('');
    lines.push(`**Snapshot ID**: ${data.createdSnapshot.id}`);
    lines.push(`**Path**: ${data.createdSnapshot.path}`);
    lines.push(`**Created**: ${data.createdSnapshot.createdAt}`);
    lines.push(`**Size**: ${formatBytes(data.createdSnapshot.sizeBytes)}`);
    lines.push(`**Mission Count**: ${data.missionCount ?? 0}`);
    lines.push(`**Session Count**: ${data.sessionCount ?? 0}`);
  } else {
    lines.push('📚 Database snapshot inventory');
    lines.push('');
    lines.push(`**Snapshots Found**: ${data.snapshots.length}`);
  }

  lines.push('');
  lines.push(`**Snapshot Directory**: ${data.snapshotDirectory}`);
  lines.push(`**Retention Max**: ${data.maxSnapshots}`);

  if (data.prunedSnapshotIds.length > 0) {
    lines.push(`**Pruned**: ${data.prunedSnapshotIds.join(', ')}`);
  }

  if (data.snapshots.length === 0) {
    lines.push('');
    lines.push('_No snapshots available._');
  } else {
    lines.push('');
    lines.push('**Snapshots (newest first)**:');
    for (const snapshot of data.snapshots.slice(0, 10)) {
      lines.push(`- ${snapshot.id} (${snapshot.createdAt}, ${formatBytes(snapshot.sizeBytes)})`);
    }
    if (data.snapshots.length > 10) {
      lines.push(`- ... ${data.snapshots.length - 10} more`);
    }
  }

  lines.push('');
  lines.push(data.message);

  appendWarnings(lines, result);

  return lines.join('\n');
}

async function getDatabaseStats(projectRoot?: string): Promise<RbookToolResult<DbStats>> {
  return withClient(
    (client) => {
      const missionCountResult = client.getOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM missions'
      );
      if (!missionCountResult.success) {
        return createError<DbStats>(
          missionCountResult.error ?? {
            code: 'DB_QUERY_FAILED',
            message: 'Failed to count missions.',
          }
        );
      }

      const sessionCountResult = client.getOne<{ count: number }>(
        'SELECT COUNT(*) as count FROM sessions'
      );
      if (!sessionCountResult.success) {
        return createError<DbStats>(
          sessionCountResult.error ?? {
            code: 'DB_QUERY_FAILED',
            message: 'Failed to count sessions.',
          }
        );
      }

      return createSuccess({
        dbPath: client.path,
        missionCount: missionCountResult.data?.count ?? 0,
        sessionCount: sessionCountResult.data?.count ?? 0,
      });
    },
    { projectRoot }
  );
}

function getSnapshotDirectory(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'snapshots');
}

function ensureDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true });
}

function resolveMaxSnapshots(explicit?: number): number {
  if (explicit !== undefined) {
    return explicit;
  }

  const envValue = getSetting('RBOOK_MAX_SNAPSHOTS');
  if (!envValue) {
    return DEFAULT_MAX_SNAPSHOTS;
  }

  const parsed = Number.parseInt(envValue, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SNAPSHOTS;
}

function generateSnapshotId(): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '$1Z');
  const suffix = randomBytes(2).toString('hex');
  return `${SNAPSHOT_FILE_PREFIX}${timestamp}-${suffix}`;
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

function pruneSnapshots(snapshotDirectory: string, maxSnapshots: number): string[] {
  const snapshots = listSnapshots(snapshotDirectory);
  if (snapshots.length <= maxSnapshots) {
    return [];
  }

  const toDelete = snapshots.slice(maxSnapshots);
  const prunedIds: string[] = [];

  for (const snapshot of toDelete) {
    try {
      fs.rmSync(snapshot.path, { force: true });
      prunedIds.push(snapshot.id);
    } catch {
      // Keep operation best-effort; missing file cleanup should not fail snapshot creation.
    }
  }

  return prunedIds;
}

function listSnapshots(snapshotDirectory: string): DbSnapshotMetadata[] {
  if (!fs.existsSync(snapshotDirectory)) {
    return [];
  }

  const entries = fs
    .readdirSync(snapshotDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .filter((entry) => entry.name.startsWith(SNAPSHOT_FILE_PREFIX))
    .filter((entry) => entry.name.endsWith(SNAPSHOT_FILE_EXTENSION));

  const snapshots = entries.map((entry) => {
    const snapshotPath = path.join(snapshotDirectory, entry.name);
    return toSnapshotMetadata(snapshotPath, entry.name);
  });

  snapshots.sort((a, b) => {
    const dateDiff = compareStoredTimes(b.createdAt, a.createdAt);
    if (dateDiff !== 0) {
      return dateDiff;
    }
    return b.filename.localeCompare(a.filename);
  });

  return snapshots;
}

function toSnapshotMetadata(snapshotPath: string, filename: string): DbSnapshotMetadata {
  const stats = fs.statSync(snapshotPath);
  const id = filename.endsWith(SNAPSHOT_FILE_EXTENSION)
    ? filename.slice(0, -SNAPSHOT_FILE_EXTENSION.length)
    : filename;

  return {
    id,
    filename,
    path: snapshotPath,
    sizeBytes: stats.size,
    createdAt: stats.mtime.toISOString(),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}
