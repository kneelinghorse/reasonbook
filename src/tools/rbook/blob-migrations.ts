// ABOUTME: Migrate legacy context blobs on writes and report partial persistence through warnings.
// ABOUTME: Snapshot preparation failures follow the same disclosure contract as snapshot INSERT failures.
/**
 * Versioned blob migration system for master_context.
 *
 * Migrations are registered once in BLOB_MIGRATIONS. A read applies them in memory only
 * (migrateBlobForRead); the stored blob is migrated at the store's first write in each server
 * process (first-write-maintenance.ts, s93-m11), because reads never write the record. Each
 * project self-heals — no manual script, no per-project bookkeeping required.
 *
 * To add a future migration:
 *   1. Append a new entry to BLOB_MIGRATIONS with the next version number.
 *   2. Bump BLOB_SCHEMA_VERSION to match.
 *   Done. Reads show the new shape at once; the stored blob migrates at the next write.
 *
 * Old migration entries are never removed — they are the changelog.
 * The version gate (`currentVersion >= migration.version`) makes them free
 * after they have applied.
 *
 * @module tools/rbook/blob-migrations
 */

import * as crypto from 'crypto';
import type { RbookDatabaseClient } from './client';
import { genesisColumns, getProjectId } from './genesis-columns';
import { checkWrite } from './write-guard';
import { findReusableSnapshot, snapshotStorage } from './snapshot-content-policy';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** Current latest blob schema version. Must match the highest version in BLOB_MIGRATIONS. */
export const BLOB_SCHEMA_VERSION = 1;

/** Metadata table key that stores the applied blob schema version per project. */
export const BLOB_SCHEMA_VERSION_KEY = 'blob_schema_version';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlobMigration {
  /** Monotonically increasing version number. Never reuse or skip. */
  version: number;
  /** Human-readable description used in logs and snapshot source labels. */
  description: string;
  /**
   * Pure transformation: blob in → blob out. No side effects.
   * Must not mutate the input — return a new object.
   */
  up: (blob: Record<string, unknown>) => Record<string, unknown>;
}

export interface BlobMigrationResult {
  /** Whether any migrations were applied. */
  migrated: boolean;
  /** Version numbers of each migration that ran, in order. */
  migrationsApplied: number[];
  /** The post-migration blob (equals input blob when migrated=false). */
  blob: Record<string, unknown>;
  /**
   * s86-m02b — DB errors from the migration's own writes (snapshot, blob write-back,
   * version bump). A half-applied migration must reach the caller's answer instead of
   * being inferred from `migrated: true`, which reports intent, not a persisted row.
   */
  warnings: string[];
  /**
   * s93-m11 — whether the stored blob was rewritten. False when the pending migrations left the
   * blob unchanged: only the version is stamped then, with no snapshot and no rewrite.
   */
  rewritten?: boolean;
}

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------

/**
 * Ordered list of all blob migrations.
 *
 * Rules:
 * - Append only. Never edit or remove an existing entry.
 * - version must be 1-indexed and strictly increasing.
 * - `up` must be a pure function (no side effects, no mutation of input).
 */
export const BLOB_MIGRATIONS: BlobMigration[] = [
  {
    version: 1,
    description:
      'Remove five duplicated sections from the master_context blob. ' +
      'completed_missions, completed_sprints, decisions_made, learnings, and recent_sessions ' +
      'are fully queryable from structured tables via HybridRetriever or direct SQL.',
    up: (blob) => {
      const {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        completed_missions,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        completed_sprints,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        decisions_made,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        learnings,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        recent_sessions,
        ...rest
      } = blob;
      return rest;
    },
  },
  // Future migrations go here. Example:
  // {
  //   version: 2,
  //   description: 'Rename technical_context → stack_context (Sprint NN)',
  //   up: (blob) => {
  //     const { technical_context, ...rest } = blob;
  //     return { ...rest, stack_context: technical_context };
  //   },
  // },
];

// ---------------------------------------------------------------------------
// Metadata helpers
// ---------------------------------------------------------------------------

/**
 * Read the current blob schema version from the metadata table.
 * Returns 0 (unversioned / legacy) if the key is absent or the table is missing.
 */
export function getBlobSchemaVersion(client: RbookDatabaseClient): number {
  const result = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    BLOB_SCHEMA_VERSION_KEY,
  ]);
  if (!result.success || !result.data) return 0;
  const parsed = parseInt(result.data.value, 10);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Persist the blob schema version in the metadata table.
 *
 * A failed bump leaves the store's blob transformed but its version stale, so the next
 * read re-runs the migration — the error is recorded into `warnings` rather than dropped.
 */
function setBlobSchemaVersion(
  client: RbookDatabaseClient,
  version: number,
  warnings: string[]
): void {
  checkWrite(
    client.execute('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', [
      BLOB_SCHEMA_VERSION_KEY,
      String(version),
    ]),
    warnings,
    `metadata.${BLOB_SCHEMA_VERSION_KEY} bump to v${version}`
  );
}

// ---------------------------------------------------------------------------
// Snapshot helper
// ---------------------------------------------------------------------------

/**
 * Take a pre-migration snapshot of the raw blob content.
 * Skips silently if an identical snapshot already exists (content-hash dedup).
 */
function takePreMigrationSnapshot(
  client: RbookDatabaseClient,
  contextId: string,
  rawContent: string,
  migrationVersion: number,
  warnings: string[]
): void {
  const contentHash = crypto.createHash('sha256').update(rawContent).digest('hex').substring(0, 16);

  // Skip if an identical snapshot already exists and is at least as protected as this recovery
  // copy (s92-m09: never reuse an automatic copy a prune could empty). s84-m04's tombstone filter
  // lives inside findReusableSnapshot.
  const reusable = findReusableSnapshot(client, { contextId, contentHash, kind: 'pre-mutation' });
  if (reusable.ok && reusable.row) return;

  const now = new Date().toISOString();
  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  // s92-m09: a recovery copy taken before the blob migrates; it always stores its content.
  const storage = snapshotStorage('pre-mutation', rawContent, { contentHash });
  checkWrite(
    client.execute(
      `INSERT INTO context_snapshots (context_id, session_id, source, content_hash, content, created_at, ${[...storage.columns, ...g.columns].join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, ${[...storage.columns.map(() => '?'), g.placeholders].join(', ')})`,
      [
        contextId,
        null,
        `pre-migration: blob-schema-v${migrationVersion}`,
        storage.contentHash,
        storage.content,
        now,
        ...storage.values,
        ...g.values,
      ]
    ),
    warnings,
    `context_snapshots pre-migration snapshot (blob-schema-v${migrationVersion})`
  );
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Apply any pending blob migrations to master_context.
 *
 * Behaviour:
 * - Only runs for contextId === 'master_context'. All other contexts are no-ops.
 * - Reads blob_schema_version from metadata. If current, returns immediately.
 * - If migrations are pending:
 *     1. Takes a pre-migration snapshot (snapshot-protected, hash-deduped).
 *     2. Applies each pending migration's `up()` in version order.
 *     3. Writes the pruned blob back to the contexts table.
 *     4. Bumps blob_schema_version in metadata.
 * - Idempotent: a second call on the same DB is always a no-op.
 *
 * @param client   Open database client (write access required)
 * @param contextId  Context row ID (e.g. 'master_context')
 * @param rawContent Raw JSON string from the contexts table (pre-parse)
 * @param parsedBlob Already-parsed blob object
 * @returns BlobMigrationResult — includes the (possibly updated) blob
 */
export function applyPendingBlobMigrations(
  client: RbookDatabaseClient,
  contextId: string,
  rawContent: string,
  parsedBlob: Record<string, unknown>
): BlobMigrationResult {
  // Only master_context carries the dead sections
  if (contextId !== 'master_context') {
    return { migrated: false, migrationsApplied: [], blob: parsedBlob, warnings: [] };
  }

  const currentVersion = getBlobSchemaVersion(client);
  const pending = BLOB_MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pending.length === 0) {
    return { migrated: false, migrationsApplied: [], blob: parsedBlob, warnings: [] };
  }

  // s86-m02b: every write below reports through this sink, so a half-applied migration
  // is disclosed rather than reported as a clean `migrated: true`.
  const warnings: string[] = [];

  const targetVersion = Math.max(...pending.map((m) => m.version));

  // Apply each pending migration in version order
  let result = parsedBlob;
  const applied: number[] = [];
  for (const migration of pending) {
    result = migration.up(result);
    applied.push(migration.version);
  }

  // s93-m11: a blob the migrations leave unchanged needs no snapshot and no rewrite; only the
  // version is stamped. This now runs at a store's first write (first-write-maintenance.ts), so a
  // fresh store pays one metadata row for it instead of a snapshot.
  if (JSON.stringify(result) === JSON.stringify(parsedBlob)) {
    setBlobSchemaVersion(client, targetVersion, warnings);
    return { migrated: true, migrationsApplied: applied, blob: result, warnings, rewritten: false };
  }

  // Snapshot failures are advisory, including schema preparation before the checked INSERT.
  try {
    takePreMigrationSnapshot(client, contextId, rawContent, targetVersion, warnings);
  } catch (error) {
    warnings.push(
      `context_snapshots pre-migration snapshot (blob-schema-v${targetVersion}) failed: ` +
        (error instanceof Error ? error.message : String(error))
    );
  }

  // Write pruned blob back to contexts table
  const newContent = JSON.stringify(result);
  const now = new Date().toISOString();
  checkWrite(
    client.execute('UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?', [
      newContent,
      now,
      contextId,
    ]),
    warnings,
    `contexts.content blob write-back (${contextId}, blob-schema-v${targetVersion})`
  );

  // Bump version in metadata
  setBlobSchemaVersion(client, targetVersion, warnings);

  return { migrated: true, migrationsApplied: applied, blob: result, warnings, rewritten: true };
}

/**
 * s93-m11 — the pending migrations applied in memory only, for a read. Reads never write the
 * record (Q10, decision #1182), so a read shows the migrated shape and the stored blob is migrated
 * at the store's next first write (first-write-maintenance.ts). Every `up` is pure, so the shape
 * shown is the shape that will be stored.
 */
export function migrateBlobForRead(
  client: RbookDatabaseClient,
  contextId: string,
  parsedBlob: Record<string, unknown>
): Record<string, unknown> {
  if (contextId !== 'master_context') return parsedBlob;
  const currentVersion = getBlobSchemaVersion(client);
  let result = parsedBlob;
  for (const migration of BLOB_MIGRATIONS) {
    if (migration.version > currentVersion) result = migration.up(result);
  }
  return result;
}
