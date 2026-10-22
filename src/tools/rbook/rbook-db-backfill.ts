// ABOUTME: Dashboard backfill uploads a registered owner store as SQLite; retired event replay and fallback refuse.
// ABOUTME: Reconciliation, orphan reporting and explicit purge remain available through their existing guarded paths.

import { formatToolFailure } from './format-failure';
import { isMembersCopy } from './record-membership';
import { REPLICA_ERROR_CODES } from './replica-identity';
import * as path from 'path';
import { withClientAsync, type RbookDatabaseClient } from './client';
import { DashboardClient } from './dashboard-client';
import { createError, createSuccess, RbookErrors } from './errors';
import type { RbookToolResult } from './types';
import { appendWarnings, attachWarnings } from './format-warnings';
import { checkWrite } from './write-guard';
import { deriveProjectSlug } from './project-identity';
import { registerResolvedProjectStore } from '../../intelligence/project-resolution';
import { legacySyncRefusal } from './legacy-sync-refusal';
import { settingIsOff } from '../../intelligence/legacy-compat';

// ─── Types ───────────────────────────────────────────────────────────────────

// ─── Constants ───────────────────────────────────────────────────────────────

/** Retained public legacy threshold; event replay is retired and no longer uses it. */
export const LARGE_DELTA_THRESHOLD = 50;

/** Per-request HTTP timeout for sync event pushes (ms). */
const PER_REQUEST_TIMEOUT_MS = 30_000;

/** Retained public legacy constant; no event replay path remains to apply this filter. */
export const DASHBOARD_UNSUPPORTED_EVENT_TYPES: ReadonlySet<string> = new Set<string>();

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RbookDbBackfillParams {
  projectRoot?: string;
  /** Retained legacy option; SQLite uploads already include the full store. */
  force?: boolean;
  /** Legacy event-replay preview; returns LEGACY_SYNC_RETIRED. */
  dryRun?: boolean;
  /**
   * Per-request HTTP timeout in ms (default: 30_000). Override in tests for fast abort.
   * @internal Process-lifetime tuning knob with no operator use case — an agent cannot
   * meaningfully choose a socket timeout for a push it does not observe, so it is deliberately
   * not declared on the rbook_db inputSchema and the router does not forward it.
   */
  perRequestTimeoutMs?: number;
  /**
   * Overall wall-clock timeout for the full push loop (ms, default: 120_000).
   * @internal Same class as perRequestTimeoutMs — a process-lifetime tuning knob, not a caller
   * decision. Stated explicitly because this property carries no test-hook language of its own:
   * the grounds for the tag are the absence of an operator use case, not an inference from
   * the sibling comment.
   */
  overallTimeoutMs?: number;
  /**
   * Test hook: inject a replacement for Date.now() to make timeout checks deterministic.
   * Never set this in production code.
   * @internal A Date.now injection point for deterministic timeout tests; publishing a clock
   * override on the MCP boundary would let a caller falsify the push loop's own timing.
   */
  _getNow?: () => number;
}

export interface RbookDbBackfillResult {
  mode: 'backfill';
  dryRun: boolean;
  totalEvents: number;
  pushed: number;
  failed: number;
  skipped: number;
  breakdown: {
    sprints: number;
    missions: number;
    sessions: number;
    decisions: number;
    learnings: number;
    dependencies: number;
  };
  cursor: string | null;
  previousCursor: string | null;
  message: string;
  /** Number of duplicate events skipped by content hash dedup */
  deduped: number;
  /** Warnings about identity repair or other issues */
  warnings?: string[];
}

// ─── DB Row Types ────────────────────────────────────────────────────────────

interface MetadataRow {
  value: string;
}

// ─── Project Identity ────────────────────────────────────────────────────────

interface ProjectIdentity {
  projectId: string;
  projectName: string;
}

/**
 * Resolve a DashboardClient for rbook_db sync operations.
 *
 * Routes through fromEnvForProject so the MCP-tool path authenticates with the
 * Sprint 57 credential-store key (the device-code / project-scoped cmk_ token,
 * used as a permanent Bearer) — no RBOOK_DASHBOARD_* env vars required.
 * fromEnvForProject is a strict superset of fromEnv: it still falls back to the
 * legacy RBOOK_DASHBOARD_API_KEY and USER+PASSWORD env vars (steps 4-5) for
 * standalone script/CI callers that run without a local credential store.
 *
 * s73 review finding: rbook_db backfill/reconcile/identify_orphans/purge were the
 * last sync surface still on env-only auth via fromEnv; every other sync path
 * (rbook_status, sync-pull, sync-mutable-push, sync-locks, checkpoint-backfill,
 * rbook_message) already resolves through the credential store. This closes that
 * gap, so a scrubbed .env (key-only auth) no longer breaks rbook_db.
 */
async function resolveSyncClient(
  projectRoot: string | undefined,
  overrides?: { timeoutMs?: number }
): Promise<RbookToolResult<DashboardClient>> {
  const result = await DashboardClient.fromEnvForProject(projectRoot, overrides);
  if (!result.success || !result.data) {
    return createError(result.error ?? RbookErrors.dashboardNotConfigured());
  }
  return createSuccess(result.data.client);
}

export async function rbookDbBackfill(
  params: RbookDbBackfillParams
): Promise<RbookToolResult<RbookDbBackfillResult>> {
  if (params.dryRun) return legacySyncRefusal('Dashboard event-replay dry run');
  if (settingIsOff('RBOOK_CHECKPOINT_SYNC'))
    return createError({
      code: 'CHECKPOINT_SYNC_DISABLED',
      message: 'Dashboard uploads are disabled by RBOOK_CHECKPOINT_SYNC. Nothing was uploaded.',
      suggestion:
        "Change the server's setting only when a whole-record dashboard upload is intended.",
    });
  return withClientAsync<RbookDbBackfillResult>(
    async (db) => {
      if (isMembersCopy(db))
        return createError<RbookDbBackfillResult>({
          code: REPLICA_ERROR_CODES.WRITE_REFUSED,
          message:
            "This is a member's copy of a shared record, which never uploads: the copy that holds the record, the owner's or the dashboard's, is the one the dashboard shows.",
          suggestion:
            "Sync it (reasonbook sync): this copy's work then reaches the copy that holds the record, and the dashboard shows it from there.",
        });
      const slugResult = db.getOne<MetadataRow>(
        "SELECT value FROM metadata WHERE key = 'dashboard_slug'"
      );
      if (!slugResult.success) return createError<RbookDbBackfillResult>(slugResult.error!);
      const slug = slugResult.data?.value;
      if (!slug) return legacySyncRefusal('Dashboard event replay');
      const clientResult = await resolveSyncClient(params.projectRoot, {
        timeoutMs: params.perRequestTimeoutMs ?? PER_REQUEST_TIMEOUT_MS,
      });
      if (!clientResult.success || !clientResult.data)
        return createError(RbookErrors.dashboardNotConfigured());
      const dashboardClient = clientResult.data;
      // Backfill owns a legacy identity-repair sequence (dashboard_slug before directory). Suppress
      // the generic pre-open UUID mint, perform that authoritative repair first, then register
      // before any dashboard publish. No transaction is open, so the registration connection
      // cannot recreate the lock inversion s88-m08 removes.
      const identity = getProjectIdentity(db);
      const resolvedProjectRoot = path.resolve(db.path, '..', '..', '..');
      try {
        const entry = await registerResolvedProjectStore(resolvedProjectRoot, {
          requireStoredIdentity: true,
        });
        if (entry.project_id !== identity.projectId) {
          throw new Error(
            `registered identity '${entry.project_id}' does not match repaired identity ` +
              `'${identity.projectId}'`
          );
        }
      } catch (error) {
        return createError({
          code: 'DB_CONNECTION_FAILED',
          message: `Failed to register project before backfill: ${error instanceof Error ? error.message : String(error)}`,
          suggestion: 'Resolve the project identity or graph collision, then retry the backfill.',
        });
      }
      const previousCursor = getCursor(db);
      const fileResult = await dashboardClient.syncSqliteFile(
        db.path,
        slug,
        deriveProjectSlug(identity.projectName)
      );
      if (!fileResult.success || !fileResult.data)
        return attachWarnings(
          legacySyncRefusal<RbookDbBackfillResult>(
            'Dashboard event-replay fallback',
            `The SQLite upload failed: ${fileResult.error?.message ?? 'unknown error'}. No events were replayed.`
          ),
          identity.warnings
        );
      const d = fileResult.data;
      const counts = d.counts ?? {};
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return attachWarnings(
        createSuccess<RbookDbBackfillResult>({
          mode: 'backfill',
          dryRun: false,
          totalEvents: total,
          pushed: total,
          failed: d.errors.length,
          skipped: 0,
          deduped: 0,
          breakdown: {
            sprints: counts['sprints'] ?? 0,
            missions: counts['missions'] ?? 0,
            sessions: counts['sessions'] ?? 0,
            decisions: counts['decisions'] ?? 0,
            learnings: counts['learnings'] ?? 0,
            dependencies: counts['dependencies'] ?? 0,
          },
          cursor: null,
          previousCursor,
          message:
            `File-based sync complete (${d.durationMs}ms): ${total} record(s) synced` +
            (d.errors.length > 0 ? `, ${d.errors.length} error(s)` : '') +
            `. Sprints: ${counts['sprints'] ?? 0}, missions: ${counts['missions'] ?? 0}, sessions: ${counts['sessions'] ?? 0}, decisions: ${counts['decisions'] ?? 0}, learnings: ${counts['learnings'] ?? 0}.`,
        }),
        identity.warnings
      );
    },
    { projectRoot: params.projectRoot, registerProject: false }
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Result of getProjectIdentity including repair metadata */
export interface ProjectIdentityResult extends ProjectIdentity {
  /** Whether repair was attempted */
  repaired: boolean;
  /** Source used for repair (if any) */
  repairSource: 'dashboard_slug' | 'directory' | 'master_context' | null;
  /**
   * s86-m02b — DB errors from the metadata writes that PERSIST a repair. `repaired: true`
   * describes the in-memory identity this run pushes with; only an empty `warnings` says
   * the store took it too.
   */
  warnings: string[];
}

function getProjectIdentity(db: RbookDatabaseClient): ProjectIdentityResult {
  const warnings: string[] = [];
  const pidResult = db.getOne<MetadataRow>(`SELECT value FROM metadata WHERE key = 'project_id'`);
  const pnameResult = db.getOne<MetadataRow>(
    `SELECT value FROM metadata WHERE key = 'project_name'`
  );

  let projectId = (pidResult.success && pidResult.data?.value) || '';
  let projectName = (pnameResult.success && pnameResult.data?.value) || '';

  // If both are present, return as-is
  if (projectId && projectName) {
    return { projectId, projectName, repaired: false, repairSource: null, warnings };
  }

  // s81-m02 defect-3: before deriving identity from the directory basename (which a
  // renamed copy gets WRONG) or falling back to 'Unknown' (which pushes into an
  // 'Unknown' dashboard container), prefer the RECONCILED incumbent dashboard identity
  // if the store carries one. dashboard_slug is the stable key resolveAndPersistOwner
  // adopts from the dashboard's incumbent row, so a registered/reconciled store never
  // pushes as 'Unknown' and a renamed copy keeps the incumbent slug over its new folder.
  const dashSlugRow = db.getOne<MetadataRow>(
    `SELECT value FROM metadata WHERE key = 'dashboard_slug'`
  );
  const dashboardSlug = (dashSlugRow.success && dashSlugRow.data?.value) || '';
  if (dashboardSlug) {
    if (!projectId) projectId = dashboardSlug;
    if (!projectName) {
      projectName = dashboardSlug
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    checkWrite(
      db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', ?)`, [
        projectId,
      ]),
      warnings,
      'metadata.project_id repair (from dashboard_slug)'
    );
    checkWrite(
      db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', ?)`, [
        projectName,
      ]),
      warnings,
      'metadata.project_name repair (from dashboard_slug)'
    );
    return { projectId, projectName, repaired: true, repairSource: 'dashboard_slug', warnings };
  }

  // Attempt repair from directory name (db path: {root}/rbook/db/rbook.sqlite)
  const dbPath = db.path;
  const projectRoot = path.resolve(dbPath, '..', '..', '..');
  const dirName = path.basename(projectRoot);

  if (dirName && dirName !== '.' && dirName !== '/') {
    if (!projectName) {
      projectName = dirName
        .split('-')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }
    if (!projectId) {
      projectId = dirName.toLowerCase().replace(/\s+/g, '-');
    }

    // Persist the repair
    checkWrite(
      db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', ?)`, [
        projectId,
      ]),
      warnings,
      'metadata.project_id repair (from directory)'
    );
    checkWrite(
      db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', ?)`, [
        projectName,
      ]),
      warnings,
      'metadata.project_name repair (from directory)'
    );

    return { projectId, projectName, repaired: true, repairSource: 'directory', warnings };
  }

  // Attempt repair from master_context
  const contextResult = db.getOne<{ content: string }>(
    `SELECT content FROM contexts WHERE id = 'master_context'`
  );
  if (contextResult.success && contextResult.data?.content) {
    try {
      const content = JSON.parse(contextResult.data.content);
      const ctxProject = content.project_identity || content.project || {};
      const ctxName = ctxProject.name as string | undefined;
      if (ctxName) {
        if (!projectName) projectName = ctxName;
        if (!projectId) projectId = ctxName.toLowerCase().replace(/\s+/g, '-');

        checkWrite(
          db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_id', ?)`, [
            projectId,
          ]),
          warnings,
          'metadata.project_id repair (from master_context)'
        );
        checkWrite(
          db.execute(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('project_name', ?)`, [
            projectName,
          ]),
          warnings,
          'metadata.project_name repair (from master_context)'
        );

        return { projectId, projectName, repaired: true, repairSource: 'master_context', warnings };
      }
    } catch {
      // JSON parse failure — fall through to fallback
    }
  }

  // Fallback: still unknown
  return {
    projectId: projectId || 'unknown',
    projectName: projectName || 'Unknown',
    repaired: false,
    repairSource: null,
    warnings,
  };
}

function getCursor(db: RbookDatabaseClient): string | null {
  const result = db.getOne<MetadataRow>(`SELECT value FROM metadata WHERE key = 'backfill_cursor'`);
  return (result.success && result.data?.value) || null;
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

export interface ReconciliationTableResult {
  table: string;
  sqliteCount: number;
  pgCount: number;
  match: boolean;
  delta: number;
}

export interface ReconciliationResult {
  tables: ReconciliationTableResult[];
  allMatch: boolean;
  totalSqlite: number;
  totalPg: number;
  /** Whether counts are project-scoped (true) or global (false/fallback) */
  projectScoped: boolean;
  /** Project slug used for project-scoped reconciliation, null if global */
  projectSlug: string | null;
  syncLogEntries: number;
  failedEntries: number;
  lastSyncAt: string | null;
}

/** PG table → SQLite table name mapping (used by global reconciliation fallback) */
const PG_TO_SQLITE_TABLE: Record<string, string> = {
  cmos_sprints: 'sprints',
  cmos_missions: 'missions',
  cmos_sessions: 'sessions',
  cmos_decisions: 'strategic_decisions',
  cmos_learnings: 'learnings',
  cmos_mission_dependencies: 'mission_dependencies',
};

interface CountRow {
  cnt: number;
}

export async function rbookDbReconcile(params: {
  projectRoot?: string;
}): Promise<RbookToolResult<ReconciliationResult>> {
  const clientResult = await resolveSyncClient(params.projectRoot);
  if (!clientResult.success || !clientResult.data) {
    return createError(RbookErrors.dashboardNotConfigured());
  }
  const dashboardClient = clientResult.data;

  return withClientAsync(
    async (db) => {
      // s100-m01 (the build's critics): the dashboard mirror is the owner's, so a member's copy has
      // none of its own to compare with, and asks the dashboard nothing about the project.
      if (isMembersCopy(db))
        return createError<ReconciliationResult>({
          code: REPLICA_ERROR_CODES.WRITE_REFUSED,
          message:
            "This is a member's copy of a shared record, and the dashboard mirrors the copy that holds the record, so there is no mirror of this copy to reconcile with.",
          suggestion:
            "Shared directly, reconcile from the owner's copy; this copy's work reaches it at the next sync. Shared through the dashboard, the dashboard refreshes its mirror from its own copy, and no copy reconciles.",
        });
      // Resolve project slug from metadata
      const identity = getProjectIdentity(db);
      const slug = deriveProjectSlug(identity.projectName);

      // Use project-scoped status endpoint for accurate table counts
      // (project-state endpoint caps entity arrays, e.g. sessions LIMIT 50)
      const statusResult = await dashboardClient.getSyncStatus(slug);
      if (!statusResult.success || !statusResult.data) {
        // Fallback to global endpoint if project-scoped status fails
        return reconcileWithGlobalEndpoint(db, dashboardClient);
      }

      const pgStatus = statusResult.data;
      const tables: ReconciliationTableResult[] = [];

      for (const pgTable of pgStatus.tables) {
        if (!Object.prototype.hasOwnProperty.call(PG_TO_SQLITE_TABLE, pgTable.table)) continue;
        const sqliteTable = PG_TO_SQLITE_TABLE[pgTable.table];

        const countResult = db.getOne<CountRow>(`SELECT COUNT(*) AS cnt FROM ${sqliteTable}`);
        const sqliteCount = countResult.success && countResult.data ? countResult.data.cnt : 0;

        tables.push({
          table: sqliteTable,
          sqliteCount,
          pgCount: pgTable.count,
          match: sqliteCount === pgTable.count,
          delta: sqliteCount - pgTable.count,
        });
      }

      if (tables.length === 0) {
        return createError({
          ...RbookErrors.dashboardError(
            'Reconciliation unavailable: no recognized entity table counts were returned.'
          ),
          suggestion:
            'Check the dashboard sync-status response includes supported entity table counts, then retry reconciliation.',
        });
      }

      const totalSqlite = tables.reduce((sum, t) => sum + t.sqliteCount, 0);
      const totalPg = tables.reduce((sum, t) => sum + t.pgCount, 0);

      return createSuccess<ReconciliationResult>({
        tables,
        allMatch: tables.every((t) => t.match),
        totalSqlite,
        totalPg,
        projectScoped: true,
        projectSlug: slug,
        syncLogEntries: pgStatus.totalSyncLogEntries,
        failedEntries: pgStatus.failedSyncLogEntries,
        lastSyncAt: pgStatus.lastSyncAt,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/**
 * s87-m03 — explicit "no project scope". The three sites this mission fixed were all cases of a
 * scope argument being FORGOTTEN; the one below is a case of it being DECLINED. Spelling the
 * difference makes an unscoped call read as a decision rather than an omission, and it keeps the
 * "every getSyncStatus call states its scope" rule true without pretending this call is scoped.
 */
const PLATFORM_WIDE: string | undefined = undefined;

/**
 * Fallback: reconcile using the UNSCOPED sync-status endpoint (pre-Sprint 34 behavior).
 *
 * s87-m03 — DELIBERATELY NOT SCOPED, and this is the one of the four `getSyncStatus` call sites
 * that keeps its no-argument call. It is reached only when `getSyncStatus(slug)` — the SAME
 * endpoint, scoped — has already failed, so passing the slug again would be a verbatim retry of
 * the call that just failed, and it would delete the degradation path this function exists to be.
 *
 * IT IS ALSO THE ONE SITE THAT WAS ALREADY HONEST ABOUT ITSELF. Its result carries
 * `projectScoped: false` and `projectSlug: null`, and the renderer prints
 * "Reconciliation (global): " — so a reader is told the counts are platform-wide before they read
 * a single delta. That disclosure is the reason no fix is owed here: the defect this mission
 * closes is a surface reporting a platform-wide number AS this project's, and this surface never
 * did.
 */
async function reconcileWithGlobalEndpoint(
  db: RbookDatabaseClient,
  client: DashboardClient
): Promise<RbookToolResult<ReconciliationResult>> {
  const statusResult = await client.getSyncStatus(PLATFORM_WIDE);
  if (!statusResult.success || !statusResult.data) {
    return createError(
      statusResult.error ?? RbookErrors.dashboardError('Failed to fetch sync status')
    );
  }

  const pgStatus = statusResult.data;
  const tables: ReconciliationTableResult[] = [];

  for (const pgTable of pgStatus.tables) {
    if (!Object.prototype.hasOwnProperty.call(PG_TO_SQLITE_TABLE, pgTable.table)) continue;
    const sqliteTable = PG_TO_SQLITE_TABLE[pgTable.table];

    const countResult = db.getOne<CountRow>(`SELECT COUNT(*) AS cnt FROM ${sqliteTable}`);
    const sqliteCount = countResult.success && countResult.data ? countResult.data.cnt : 0;

    tables.push({
      table: sqliteTable,
      sqliteCount,
      pgCount: pgTable.count,
      match: sqliteCount === pgTable.count,
      delta: sqliteCount - pgTable.count,
    });
  }

  if (tables.length === 0) {
    return createError({
      ...RbookErrors.dashboardError(
        'Reconciliation unavailable: no recognized entity table counts were returned.'
      ),
      suggestion:
        'Check the dashboard sync-status response includes supported entity table counts, then retry reconciliation.',
    });
  }

  const totalSqlite = tables.reduce((sum, t) => sum + t.sqliteCount, 0);
  const totalPg = tables.reduce((sum, t) => sum + t.pgCount, 0);

  return createSuccess<ReconciliationResult>({
    tables,
    allMatch: tables.every((t) => t.match),
    totalSqlite,
    totalPg,
    projectScoped: false,
    projectSlug: null,
    syncLogEntries: pgStatus.totalSyncLogEntries,
    failedEntries: pgStatus.failedSyncLogEntries,
    lastSyncAt: pgStatus.lastSyncAt,
  });
}

export function formatReconciliationForLLM(result: RbookToolResult<ReconciliationResult>): string {
  if (!result.success) {
    return formatToolFailure('Reconciliation failed', result.error);
  }

  const d = result.data!;
  const scopeLabel = d.projectScoped
    ? `Reconciliation (project-scoped: ${d.projectSlug}): `
    : 'Reconciliation (global): ';
  const lines = [
    scopeLabel + (d.allMatch ? 'ALL MATCH' : 'MISMATCHES DETECTED'),
    '',
    'Table                    | SQLite | PG   | Match | Delta',
    '-------------------------|--------|------|-------|------',
  ];

  for (const t of d.tables) {
    const status = t.match ? 'YES' : 'NO';
    const delta = t.delta === 0 ? '0' : t.delta > 0 ? `+${t.delta}` : `${t.delta}`;
    lines.push(
      `${t.table.padEnd(25)}| ${String(t.sqliteCount).padEnd(7)}| ${String(t.pgCount).padEnd(5)}| ${status.padEnd(6)}| ${delta}`
    );
  }

  lines.push('');
  lines.push(`Totals: SQLite=${d.totalSqlite}, PG=${d.totalPg}`);
  lines.push(`Sync log: ${d.syncLogEntries} entries, ${d.failedEntries} failed`);
  if (d.lastSyncAt) {
    lines.push(`Last sync: ${d.lastSyncAt}`);
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

// ─── PG Orphan Identification ────────────────────────────────────────────────

export interface PgOrphanEntry {
  table: string;
  id: string;
  /** Secondary ID for composite keys (e.g., dependency to_id) */
  secondaryId?: string;
}

export interface PgOrphanReport {
  orphans: PgOrphanEntry[];
  totalOrphans: number;
  tablesChecked: string[];
  projectSlug: string;
}

/**
 * Identify PG-side orphan entity IDs that don't exist in SQLite.
 * Compares entity IDs from the dashboard project state API against local SQLite.
 *
 * Note: The project state API may cap entity arrays for large tables.
 * When caps are hit, orphan detection for that table is skipped.
 */
export async function identifyPgOrphans(params: {
  projectRoot?: string;
}): Promise<RbookToolResult<PgOrphanReport>> {
  const clientResult = await resolveSyncClient(params.projectRoot);
  if (!clientResult.success || !clientResult.data) {
    return createError(RbookErrors.dashboardNotConfigured());
  }
  const dashboardClient = clientResult.data;

  return withClientAsync(
    async (db) => {
      const identity = getProjectIdentity(db);
      const slug = deriveProjectSlug(identity.projectName);

      // Get full PG state
      const stateResult = await dashboardClient.getSyncProjectState(slug);
      if (!stateResult.success || !stateResult.data) {
        return createError(
          stateResult.error ?? RbookErrors.dashboardError('Failed to fetch PG project state')
        );
      }

      const pgState = stateResult.data;
      const orphans: PgOrphanEntry[] = [];
      const tablesChecked: string[] = [];

      // Compare missions
      if (pgState.missions && Array.isArray(pgState.missions)) {
        tablesChecked.push('missions');
        const sqliteIds = getSqliteIds(db, 'missions', 'id');
        for (const pgMission of pgState.missions) {
          const row = pgMission as unknown as Record<string, unknown>;
          const id = (row.missionId as string) ?? (row.id as string);
          if (id && !sqliteIds.has(id)) {
            orphans.push({ table: 'missions', id });
          }
        }
      }

      // Compare sessions
      if (pgState.sessions && Array.isArray(pgState.sessions)) {
        tablesChecked.push('sessions');
        const sqliteIds = getSqliteIds(db, 'sessions', 'id');
        for (const pgSession of pgState.sessions) {
          const row = pgSession as unknown as Record<string, unknown>;
          const id = (row.sessionId as string) ?? (row.id as string);
          if (id && !sqliteIds.has(id)) {
            orphans.push({ table: 'sessions', id });
          }
        }
      }

      // Compare dependencies (composite key: from_id + to_id)
      if (pgState.dependencies && Array.isArray(pgState.dependencies)) {
        tablesChecked.push('mission_dependencies');
        const sqliteDeps = getSqliteDependencyKeys(db);
        for (const pgDep of pgState.dependencies) {
          const dep = pgDep as unknown as Record<string, unknown>;
          const fromId = (dep.fromId ?? dep.from_id) as string;
          const toId = (dep.toId ?? dep.to_id) as string;
          if (fromId && toId) {
            const key = `${fromId}|${toId}`;
            if (!sqliteDeps.has(key)) {
              orphans.push({ table: 'mission_dependencies', id: fromId, secondaryId: toId });
            }
          }
        }
      }

      return createSuccess<PgOrphanReport>({
        orphans,
        totalOrphans: orphans.length,
        tablesChecked,
        projectSlug: slug,
      });
    },
    { projectRoot: params.projectRoot }
  );
}

/** Get all entity IDs from a SQLite table as a Set */
function getSqliteIds(db: RbookDatabaseClient, table: string, idColumn: string): Set<string> {
  const result = db.getMany<{ id: string }>(`SELECT ${idColumn} as id FROM ${table}`);
  if (!result.success || !result.data) return new Set();
  return new Set(result.data.map((row) => row.id));
}

/** Get all dependency composite keys as a Set */
function getSqliteDependencyKeys(db: RbookDatabaseClient): Set<string> {
  const result = db.getMany<{ from_id: string; to_id: string }>(
    `SELECT from_id, to_id FROM mission_dependencies`
  );
  if (!result.success || !result.data) return new Set();
  return new Set(result.data.map((row) => `${row.from_id}|${row.to_id}`));
}

export function formatPgOrphanReportForLLM(result: RbookToolResult<PgOrphanReport>): string {
  if (!result.success) {
    return formatToolFailure('PG orphan identification failed', result.error);
  }

  const d = result.data!;
  if (d.totalOrphans === 0) {
    const lines = [
      `PG Orphan Check (${d.projectSlug}): No orphans found across ${d.tablesChecked.length} tables.`,
    ];
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const lines = [`PG Orphan Report (${d.projectSlug}): ${d.totalOrphans} orphan(s) found`, ''];

  const byTable = new Map<string, PgOrphanEntry[]>();
  for (const orphan of d.orphans) {
    const existing = byTable.get(orphan.table) ?? [];
    existing.push(orphan);
    byTable.set(orphan.table, existing);
  }

  for (const [table, entries] of byTable) {
    lines.push(`${table} (${entries.length} orphan${entries.length > 1 ? 's' : ''}):`);
    for (const entry of entries) {
      if (entry.secondaryId) {
        lines.push(`  - ${entry.id} → ${entry.secondaryId}`);
      } else {
        lines.push(`  - ${entry.id}`);
      }
    }
    lines.push('');
  }

  lines.push(`Tables checked: ${d.tablesChecked.join(', ')}`);
  appendWarnings(lines, result);

  return lines.join('\n');
}

// ─── Purge ───────────────────────────────────────────────────────────────────

export interface PurgeResult {
  purgedProject: string;
  tablesCleared: string[];
  rowsDeleted: number;
}

export async function rbookDbPurge(params: {
  confirm?: boolean;
  projectRoot?: string;
  expectedSlug?: string;
}): Promise<RbookToolResult<PurgeResult>> {
  if (!params.confirm) {
    return createError({
      code: 'CONFIRMATION_REQUIRED',
      message:
        'Purge requires explicit confirmation. Pass confirm=true to proceed. ' +
        'This will delete ALL mirrored data for this project from the PG mirror.',
      // s89-m08: the oracle executed this remedy from the state that emitted it and it REFUSED
      // with DASHBOARD_NOT_CONFIGURED. The remedy is conditional on a configured dashboard mirror
      // and the string did not say so, so it read as an unconditional instruction (T4).
      suggestion:
        'Call rbook_db(action="purge", confirm=true) to proceed — it only runs if this project ' +
        'has a configured dashboard mirror.',
    });
  }

  const clientResult = await resolveSyncClient(params.projectRoot);
  if (!clientResult.success || !clientResult.data) {
    return createError(RbookErrors.dashboardNotConfigured());
  }
  const dashboardClient = clientResult.data;

  return withClientAsync(
    async (db) => {
      // s96-m13 (design §s96-m13 item 3): the dashboard mirror is the owner's, so only the owner's
      // copy of a shared record purges it. s100-m02: through the dashboard, the owner's copy is a
      // member's too, so the remedy says how the owner gets back a copy that can.
      if (isMembersCopy(db))
        return createError<PurgeResult>({
          code: REPLICA_ERROR_CODES.WRITE_REFUSED,
          message:
            "This is a member's copy of a shared record, and the dashboard mirror is the owner's, so it was not purged.",
          suggestion:
            "Shared directly, purge from the owner's copy, if the owner means to. Shared through the dashboard, no copy purges while it holds the record, the owner's included: the owner moves the project back first (reasonbook move --to owner), then purges from that copy.",
        });
      const identity = getProjectIdentity(db);
      const slug = deriveProjectSlug(identity.projectName);

      const purgeResult = await dashboardClient.purgeMirror(slug, params.expectedSlug ?? undefined);
      if (!purgeResult.success || !purgeResult.data) {
        return createError(
          purgeResult.error ?? RbookErrors.dashboardError('Failed to purge mirror')
        );
      }

      // s95-m08: the client's warnings (an answer that named no tables) reach the answer.
      return createSuccess<PurgeResult>(
        {
          purgedProject: purgeResult.data.purgedProject,
          tablesCleared: purgeResult.data.tablesCleared,
          rowsDeleted: purgeResult.data.rowsDeleted,
        },
        purgeResult.warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
}

export function formatPurgeForLLM(result: RbookToolResult<PurgeResult>): string {
  if (!result.success) {
    return formatToolFailure('Purge failed', result.error);
  }

  const d = result.data!;
  const lines = [
    `Purge Complete: ${d.purgedProject}`,
    '',
    `Tables cleared: ${d.tablesCleared.join(', ')}`,
    `Rows deleted: ${d.rowsDeleted}`,
  ];

  appendWarnings(lines, result);

  return lines.join('\n');
}

// ─── LLM Formatter ───────────────────────────────────────────────────────────

export function formatBackfillForLLM(result: RbookToolResult<RbookDbBackfillResult>): string {
  if (!result.success) {
    return [
      `Backfill failed: ${result.error?.message ?? 'Unknown error'}`,
      result.error?.suggestion,
    ]
      .filter(Boolean)
      .join('\n');
  }

  const d = result.data!;
  const lines = [
    d.dryRun ? 'Backfill Dry Run' : 'Backfill Complete',
    '',
    d.message,
    '',
    `Events: ${d.pushed} pushed, ${d.failed} failed`,
    `Breakdown: ${d.breakdown.sprints} sprint, ${d.breakdown.missions} mission, ${d.breakdown.sessions} session, ${d.breakdown.decisions} decision, ${d.breakdown.learnings} learning, ${d.breakdown.dependencies} dependency`,
  ];

  if (d.previousCursor) {
    lines.push(`Previous cursor: ${d.previousCursor}`);
  }
  if (d.cursor) {
    lines.push(`Current cursor: ${d.cursor}`);
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
