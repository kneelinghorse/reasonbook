// ABOUTME: Opens and guards project databases while preserving structured errors and identity checks.
// ABOUTME: Legacy and renamed records share connection behavior, including migration exclusion.
/**
 * RbookDatabaseClient - Core database client wrapper for Reasonbook SQLite operations
 *
 * Provides:
 * - Connection management with auto-close
 * - Standard query patterns (getOne, getMany, execute)
 * - Error translation to structured RbookToolError
 * - Integration with RbookDetector for database path discovery
 *
 * All methods return RbookToolResult<T> for consistent agent-friendly responses.
 *
 * @module tools/rbook/client
 */

import { assertNoRecordMigration, getSetting, LEGACY } from '../../intelligence/legacy-compat';
import path from 'path';
import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';
import { RbookDetector, type RbookDetectionResult } from '../../intelligence/rbook-detector';
import {
  registerResolvedProjectStore,
  resolveProjectRootEnhanced,
  ProjectResolutionError,
} from '../../intelligence/project-resolution';
import type { RbookToolResult, DbHealthResult } from './types';
import { createError, createSuccess, RbookErrors, RBOOK_ERROR_CODES } from './errors';
import { attachWarnings } from './format-warnings';
import { loadVecExtension } from './vec-loader';
import { assertJestDbPathIsolated, RealStoreGuardError } from './real-store-guard';
import { isReadOnlyAgentSession } from './read-only-agent-guard';
import {
  currentToolCallActionMode,
  recordSharedStore,
  recordStoreWrite,
} from './tool-call-context';
import { enableWal, processBusyTimeout } from './sqlite-busy';
import {
  carriedRefusal,
  discardReplicaMark,
  flushReplicaMark,
  isSharedStore,
  REPLICA_ERROR_CODES,
  SHARED_TABLES,
} from './replica-identity';
import { replicaWriteRefusal } from './replica-check';
import { isMerging, refusedWhileRecording } from './record-guards';

// Re-export the resolver for convenience. s80-m01 trimmed the dead JSON
// `ProjectRegistry` / `RegisteredProject` / `ProjectValidation` /
// `resolveProjectRootPath` / `ProjectResolutionResult` re-exports (grep-confirmed
// no importers); the resolver now lives in `intelligence/project-resolution.ts`.
export { resolveProjectRootEnhanced, ProjectResolutionError };

/**
 * Environment variable for Reasonbook project root.
 * When set, tools use this as default instead of process.cwd().
 * Useful for Claude Desktop where cwd may not be the project directory.
 */
export const RBOOK_PROJECT_ROOT_ENV = 'RBOOK_PROJECT_ROOT';

/**
 * Environment variable for project ID validation.
 * Used together with database self-protection: if database has project_id
 * in metadata, this env var MUST match for mutation operations.
 */
export const RBOOK_PROJECT_ID_ENV = 'RBOOK_PROJECT_ID';

/**
 * Resolve the project root directory (synchronous, simple fallback).
 *
 * Priority: explicit param > RBOOK_PROJECT_ROOT env var > process.cwd()
 *
 * s87-m04 — THIS SENTENCE IS TRUE AND IS DELIBERATELY LEFT ALONE. A sweep that corrected the
 * other resolution-order claims in this file would be tempted to "fix" it too, because it names
 * an env step the ENHANCED resolver does not have. But this function is not that resolver: the
 * line below really does read `getSetting(RBOOK_PROJECT_ROOT_ENV)`. The claim describes THIS
 * function's behaviour exactly. `resolveProjectRootEnhanced` dropped its env step in sprint-53
 * m02; the two resolvers genuinely differ, and deleting a true statement to make a directory
 * uniform is its own kind of dishonesty.
 *
 * @deprecated Use resolveProjectRootEnhanced() for full 5-step resolution
 * with auto-discovery and registry fallback. This synchronous version
 * is kept for backward compatibility but doesn't support the registry.
 *
 * @param explicitRoot - Explicitly provided project root
 * @returns Resolved project root path
 */
export function resolveProjectRoot(explicitRoot?: string): string {
  return explicitRoot ?? getSetting(RBOOK_PROJECT_ROOT_ENV) ?? process.cwd();
}

/**
 * Options for creating a RbookDatabaseClient
 */
export interface RbookDatabaseClientOptions {
  /** Explicit database path (overrides detection) */
  dbPath?: string;

  /** Project root for Reasonbook detection (defaults to cwd) */
  projectRoot?: string;

  /** SQLite connection timeout in milliseconds */
  timeout?: number;

  /** Whether to open in read-only mode */
  readonly?: boolean;

  /** Enable verbose mode for debugging */
  verbose?: boolean;

  /** Internal resolver probes can suppress registration even inside a write-classified request. */
  registerProject?: boolean;

  /**
   * s96-m01: false only for a client that opens a refused copy of a shared record on purpose, to
   * re-identify it (s96-m13's sync does the same). Every other client opened to write is checked.
   */
  replicaCheck?: boolean;

  /**
   * s97-m09: false for a client that never searches, such as the referee library's (design §R1),
   * so its connection loads no sqlite-vec. Every other client loads it, as vec0 tables need it.
   */
  loadVec?: boolean;
}

/**
 * Registration is a write precondition, never a side effect of a read.
 *
 * Dispatch supplies the fail-closed action classification through AsyncLocalStorage, because the
 * client is opened several handler layers below the router and concurrent MCP calls must not share
 * a module-level flag. Direct callers have no action context, so their existing writable-client
 * behavior remains registration-capable; `readonly: true` is the explicit no-registration signal.
 * The review role wins over both.
 */
function shouldRegisterProject(options: RbookDatabaseClientOptions): boolean {
  if (options.registerProject === false || options.readonly || isReadOnlyAgentSession()) {
    return false;
  }
  const actionMode = currentToolCallActionMode();
  return actionMode === undefined || actionMode === 'write';
}

/**
 * s96-m01 (ADR s96 §9): a client opened to write, outside a read-classified call, is checked once
 * against this machine's binding of the copy; an unshared store passes at the cost of one read.
 */
function opensToWrite(options: RbookDatabaseClientOptions): boolean {
  return (
    !options.readonly &&
    options.replicaCheck !== false &&
    currentToolCallActionMode() !== 'read' &&
    !isReadOnlyAgentSession()
  );
}

/** A statement that changes rows (not DDL, not a pragma, not a transaction verb). */
const ROW_WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** s96-m01: the transaction verbs a caller may issue itself; see followTransactionVerb. */
const BEGIN_WRITE_SQL = /^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)\b/i;
const END_SQL = /^\s*(?:COMMIT|END)\b/i;

/** s96-m01: the table a row create or delete names, so one to a shared table can be refused. */
const ROW_WRITE_TARGET =
  /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|DELETE\s+FROM)\s+["`[]?(\w+)/i;

/**
 * Query parameters for parameterized queries
 */
export type QueryParams = Record<string, unknown> | unknown[];

/**
 * Result of a database mutation (INSERT, UPDATE, DELETE)
 */
export interface MutationResult {
  /** Number of rows affected */
  changes: number;

  /** Last inserted row ID (for INSERT) */
  lastInsertRowid: number | bigint;
}

/**
 * RbookDatabaseClient - Wrapper around better-sqlite3 for Reasonbook operations
 *
 * Usage:
 * ```typescript
 * // Create client (auto-detects database)
 * const client = await RbookDatabaseClient.create();
 *
 * // Query operations
 * const missions = await client.getMany<Mission>('SELECT * FROM missions WHERE status = ?', ['In Progress']);
 * const mission = await client.getOne<Mission>('SELECT * FROM missions WHERE id = ?', ['s12-m03']);
 *
 * // Mutation operations
 * const result = await client.execute(
 *   'UPDATE missions SET status = ? WHERE id = ?',
 *   ['Completed', 's12-m03']
 * );
 *
 * // Always close when done
 * client.close();
 * ```
 */
export class RbookDatabaseClient {
  private db: DatabaseType | null = null;
  private readonly dbPath: string;
  private readonly options: Required<
    Omit<RbookDatabaseClientOptions, 'dbPath' | 'projectRoot' | 'registerProject' | 'replicaCheck'>
  >;
  private statementCache: Map<string, Statement> = new Map();
  /** Set while the outermost transaction is a writeTransaction, which BEGINs IMMEDIATE. */
  private writeLocked = false;
  /** s96-m03: how many outermost transactions this client has begun; see transactionSerial. */
  private transactions = 0;

  /**
   * Private constructor - use RbookDatabaseClient.create() instead
   */
  private constructor(dbPath: string, options: RbookDatabaseClientOptions = {}) {
    this.dbPath = dbPath;
    this.options = {
      // s93-m01: a hook verb lowers the process-wide default so a held store fails fast.
      timeout: options.timeout ?? processBusyTimeout() ?? 5000,
      readonly: options.readonly ?? false,
      verbose: options.verbose ?? false,
      loadVec: options.loadVec ?? true,
    };
  }

  /**
   * Create a new RbookDatabaseClient
   *
   * Resolution priority, s87-m04 — CORRECTED. This block listed a `RBOOK_PROJECT_ROOT`
   * environment step that `resolveProjectRootEnhanced` has not had since sprint-53 m02, which
   * removed it deliberately (see that function's docblock: the env var is still read at
   * `src/index.ts` for .env bootstrap, and is never consulted during resolution). An operator who
   * set the variable expecting it to steer resolution was reading a step that does not run.
   * 1. Explicit dbPath option
   * 2. Explicit projectRoot option
   * 3. Auto-discover from cwd
   * 4. Registry fallback (default project)
   * 5. Error with actionable guidance
   *
   * NOTE the deliberate difference from {@link resolveProjectRoot} above, which DOES read the env
   * var and whose docblock correctly says so. Two resolvers, two behaviours, two true sentences.
   *
   * @param options - Client options
   * @returns RbookToolResult with the client or an error
   */
  static async create(
    options: RbookDatabaseClientOptions = {}
  ): Promise<RbookToolResult<RbookDatabaseClient>> {
    try {
      let dbPath = options.dbPath;
      let registerRoot: string | null = null;

      // If no explicit dbPath, resolve project root and detect database
      if (!dbPath) {
        let projectRoot: string;

        // If explicit projectRoot provided, use it directly. Registration is performed below,
        // after Reasonbook presence is established, using the same policy as ambient resolution.
        if (options.projectRoot) {
          projectRoot = options.projectRoot;
        } else {
          // Use enhanced resolution (auto-discover → registry → error). s87-m04: this comment
          // used to name an `env` step first. There is none — sprint-53 m02 removed it.
          //
          // s88-m08: resolution itself is non-registering. Once detection succeeds below, a
          // WRITE-classified request registers on this side of the split; a READ-classified,
          // readonly-client, or review-role request merely resolves. This keeps minting before a
          // client/transaction exists without turning discovery into a write.
          try {
            const resolution = await resolveProjectRootEnhanced(undefined, {
              autoRegister: false,
              silent: true,
            });
            projectRoot = resolution.projectRoot;
          } catch (error) {
            if (error instanceof ProjectResolutionError) {
              return createError({
                code: RBOOK_ERROR_CODES.RBOOK_NOT_DETECTED,
                message: error.message,
                suggestion: error.suggestion,
              });
            }
            throw error;
          }
        }

        const detector = RbookDetector.getInstance();
        const detection = await detector.detect(projectRoot);

        if (!detection.hasRbookDirectory) {
          return createError(RbookErrors.rbookNotDetected(projectRoot));
        }

        if (!detection.hasDatabase || !detection.databasePath) {
          return createError(RbookErrors.dbNotFound(detection.rbookDirectory, projectRoot));
        }

        // SPLIT-THE-PATHS (s88-m08): explicit and ambient WRITE opens share one registration
        // point. `registerStore` is the only path here that may mint metadata.project_id, and it
        // runs before this client returns (and therefore before any BEGIN IMMEDIATE). Reads and
        // the review role never enter it. Unlike the old best-effort auto-discovery write, a
        // failed write precondition fails loud rather than letting the handler stamp a fallback.
        if (shouldRegisterProject(options)) {
          // Preserve the Jest real-store fence across the registration write. The ordinary
          // connection checks this again below.
          assertJestDbPathIsolated(detection.databasePath);
          registerRoot = projectRoot;
        }

        dbPath = detection.databasePath;
      }

      const client = new RbookDatabaseClient(dbPath, options);

      // Test connection
      const connectionResult = client.ensureConnection();
      if (!connectionResult.success) {
        return connectionResult as RbookToolResult<RbookDatabaseClient>;
      }
      // s96-m01 (ADR s96 §9): a copy of a shared record is checked before it registers, so a
      // stale copy never takes the project's registry row; this machine's binding, not the row,
      // says which copy is live, and a confirmed copy takes the row from any other folder.
      const refused = client.refusedCopy(options);
      if (refused) return refused;
      const upgradeWarnings: string[] = [];
      if (opensToWrite(options) && isSharedStore(client)) {
        try {
          const { upgradeProtocolJudge } = await import('./record-upgrade-judge');
          const upgraded = await upgradeProtocolJudge(client);
          if (!upgraded.success) {
            client.close();
            return createError(upgraded.error!);
          }
          upgradeWarnings.push(...(upgraded.warnings ?? []));
        } catch (error) {
          client.close();
          throw error;
        }
      }
      // s96-m12: a copy of a shared record this call opened, so its answer can name what a
      // person must know there: fields in conflict, and an id two copies created.
      if (currentToolCallActionMode() !== undefined && isSharedStore(client))
        recordSharedStore(client.path);
      if (registerRoot !== null) {
        const shared = isSharedStore(client);
        if (!shared || opensToWrite(options)) {
          // Registered MCP writes are strict: no handler may continue after an identity write
          // failed. Direct legacy callers have no action context, so retain registerStore's
          // historical unreadable-store basename fallback unless they explicitly opt in.
          const requireStoredIdentity =
            currentToolCallActionMode() === 'write' || options.registerProject === true;
          try {
            await registerResolvedProjectStore(registerRoot, {
              requireStoredIdentity,
              confirmedCopy: shared,
            });
          } catch (error) {
            client.close();
            throw error;
          }
        }
      }

      return createSuccess(client, upgradeWarnings);
    } catch (error) {
      // Sprint 70 m01: never mask the real-store isolation guard. ensureConnection()
      // throws RealStoreGuardError before opening; if we folded it into a
      // DB_CONNECTION_FAILED result a leaking test could silently tolerate it.
      // Re-throw so it fails loud with its stack trace. (decision #754)
      if (error instanceof RealStoreGuardError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return createError({
        code: RBOOK_ERROR_CODES.DB_CONNECTION_FAILED,
        message: `Failed to create database client: ${message}`,
        suggestion: 'Check that the rbook/ directory exists and contains db/rbook.sqlite',
      });
    }
  }

  /**
   * Create a RbookDatabaseClient from a detection result
   *
   * Useful when you've already run detection and want to avoid re-detecting.
   *
   * @param detection - RbookDetectionResult from RbookDetector
   * @param options - Additional client options
   * @returns RbookToolResult with the client or an error
   */
  static fromDetection(
    detection: RbookDetectionResult,
    options: Omit<RbookDatabaseClientOptions, 'dbPath' | 'projectRoot'> = {}
  ): RbookToolResult<RbookDatabaseClient> {
    if (!detection.hasDatabase || !detection.databasePath) {
      return createError(RbookErrors.dbNotFound(detection.rbookDirectory, detection.projectRoot));
    }

    const client = new RbookDatabaseClient(detection.databasePath, options);

    // Test connection
    const connectionResult = client.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as RbookToolResult<RbookDatabaseClient>;
    }
    const refused = client.refusedCopy(options);
    if (refused) return refused;

    return createSuccess(client);
  }

  /**
   * Get the database path
   */
  get path(): string {
    return this.dbPath;
  }

  /**
   * Check if the database connection is open
   */
  get isOpen(): boolean {
    return this.db !== null && this.db.open;
  }

  /** Whether a transaction is open on this client's connection. */
  get inTransaction(): boolean {
    return this.db?.inTransaction ?? false;
  }

  /** s96-m01 (ADR s96 §3): whether the open transaction took the write lock at BEGIN IMMEDIATE. */
  get inWriteTransaction(): boolean {
    return this.writeLocked && this.inTransaction;
  }

  /**
   * s96-m03: a count of this client's outermost transactions, so the change helper names one
   * transaction id for everything one SQLite transaction records (ADR s96 §4).
   */
  get transactionSerial(): number {
    return this.transactions;
  }

  /** s96-m01: a client opened to write a copy this machine cannot confirm closes with the refusal. */
  private refusedCopy(options: RbookDatabaseClientOptions): RbookToolResult<never> | null {
    if (!opensToWrite(options)) return null;
    const refused = replicaWriteRefusal(this);
    if (!refused) return null;
    this.close();
    return createError(refused);
  }

  /**
   * s96-m01: a transaction a caller BEGINs and ends itself through execute or raw holds the write
   * lock from BEGIN IMMEDIATE (or EXCLUSIVE), and its end moves or discards this machine's mark of
   * a shared copy, as writeTransaction's does.
   */
  private followTransactionVerb(sql: string, wasInTransaction: boolean): void {
    const nowInTransaction = this.inTransaction;
    if (!wasInTransaction && nowInTransaction) {
      this.transactions += 1;
      if (BEGIN_WRITE_SQL.test(sql)) this.writeLocked = true;
    } else if (wasInTransaction && !nowInTransaction) {
      this.writeLocked = false;
      if (END_SQL.test(sql)) flushReplicaMark(this);
      else discardReplicaMark(this);
    }
  }

  /**
   * s96-m01: the backstop for a client that opened without the check: a new or deleted row of a
   * shared table on a copy this machine cannot confirm is refused. UPDATEs pass, because a schema
   * migration's backfill must never break a copy; s96-m03's column-scoped guards cover them.
   */
  private refusedWrite(sql: string, via: 'execute' | 'raw'): RbookToolResult<never> | null {
    // s96-m03: while the change helper records, the transaction is its own.
    const verb = refusedWhileRecording(this, sql, via);
    if (verb) return createError(verb);
    const table = ROW_WRITE_TARGET.exec(sql)?.[1]?.toLowerCase();
    if (!table || !SHARED_TABLES.has(table)) return null;
    const refused = replicaWriteRefusal(this);
    if (!refused) return null;
    // s96-m13: a restored copy's catch-up writes under the merge's token, which only a catch-up
    // puts down on such a copy (mergeRefusal, record-token.ts). The merge marks its own client, so a
    // token row that damage left in the file lets nothing through.
    if (refused.code === REPLICA_ERROR_CODES.RESTORED && isMerging(this)) return null;
    return createError(refused);
  }

  /**
   * Ensure database connection is established
   *
   * @returns RbookToolResult indicating success or connection error
   */
  private ensureConnection(): RbookToolResult<void> {
    // Explicit dbPath/fromDetection calls must not bypass the guard through cached discovery.
    const directory = path.dirname(this.dbPath);
    const record = path.dirname(directory);
    if (
      path.basename(directory) === 'db' &&
      [LEGACY.recordDirectory, 'rbook'].includes(path.basename(record))
    ) {
      try {
        assertNoRecordMigration(path.dirname(record));
      } catch (error) {
        return createError({
          code: RBOOK_ERROR_CODES.DB_CONNECTION_FAILED,
          message: error instanceof Error ? error.message : String(error),
          suggestion:
            'Finish or recover the migration with reasonbook migrate --apply before opening the record.',
        });
      }
    }
    if (this.db && this.db.open) {
      return createSuccess(undefined);
    }

    // Sprint 70 m01 (decision #754): real-store isolation guard. Strict no-op
    // outside Jest. Under Jest it throws BEFORE opening — so a stray
    // cwd-resolved open of the real dogfood store fails loud with a stack trace
    // instead of silently running a schema migration against production data.
    assertJestDbPathIsolated(this.dbPath);

    try {
      this.db = new Database(this.dbPath, {
        readonly: this.options.readonly,
        timeout: this.options.timeout,
        verbose: this.options.verbose ? console.log : undefined,
      });

      // Enable foreign keys for referential integrity
      this.db.pragma('foreign_keys = ON');

      // Enable WAL mode for better concurrent access.
      //
      // s87-m03 (#535) — GUARDED, because `journal_mode = WAL` IS A WRITE. On a store that is
      // not already in WAL mode, setting it rewrites the database header, so issuing it
      // unconditionally made `RbookDatabaseClient.create({ readonly: true })` fail outright with
      // `DB_CONNECTION_FAILED: attempt to write a readonly database` — a read-only client that
      // could not open a delete-mode store at all. Read the mode first and only set it when the
      // connection is writable AND the mode actually differs; on an already-WAL store the write
      // never happens either way, which is why this went unnoticed.
      //
      // HONEST SCOPE, so this is not read as a bigger rescue than it is: NO `src/` site currently
      // passes `readonly: true` to this client — all seven read-only opens in the tree are raw
      // `better-sqlite3` calls. Census command (prints 7):
      //   rg -l --glob '*.ts' "import Database.*from 'better-sqlite3'" src |
      //     xargs rg -U --count-matches 'new Database\([^;]*?\{\s*readonly:\s*true\b' |
      //     awk -F: '{ total += $NF } END { print total }'
      // This fix was latent when shipped in s87-m03. s88-m08 now uses that distinction to keep
      // read-classified/readonly client resolution out of project-identity registration; the
      // pragma rule remains independently necessary for a connection that declares it will not
      // write.
      // s96-m10: enableWal reads the mode first, as above, and retries the switch within this
      // client's busy timeout: while another connection holds a write reservation, SQLite refuses
      // the switch at once, without consulting the busy handler.
      if (!this.options.readonly) {
        enableWal(this.db, this.options.timeout);
      }

      // Load sqlite-vec extension so vec0 virtual tables created by
      // ensureVectorStorage (and queried by the hybrid retriever) are available.
      // Idempotent per connection — see vec-loader.ts.
      if (this.options.loadVec) loadVecExtension(this.db);

      return createSuccess(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return createError(RbookErrors.dbConnectionFailed(this.dbPath, message));
    }
  }

  /**
   * Get a single row from the database
   *
   * @param sql - SQL query (should return at most one row)
   * @param params - Query parameters (array for positional, object for named)
   * @returns RbookToolResult with the row or undefined if not found
   */
  getOne<T = Record<string, unknown>>(
    sql: string,
    params?: QueryParams
  ): RbookToolResult<T | undefined> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as RbookToolResult<T | undefined>;
    }

    try {
      const stmt = this.prepareStatement(sql);
      const row = (params ? stmt.get(params) : stmt.get()) as T | undefined;
      return createSuccess(row);
    } catch (error) {
      return this.handleQueryError(error, sql);
    }
  }

  /**
   * Get multiple rows from the database
   *
   * @param sql - SQL query
   * @param params - Query parameters (array for positional, object for named)
   * @returns RbookToolResult with array of rows (empty array if none found)
   */
  getMany<T = Record<string, unknown>>(sql: string, params?: QueryParams): RbookToolResult<T[]> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as RbookToolResult<T[]>;
    }

    try {
      const stmt = this.prepareStatement(sql);
      const rows = (params ? stmt.all(params) : stmt.all()) as T[];
      return createSuccess(rows);
    } catch (error) {
      return this.handleQueryError(error, sql);
    }
  }

  /**
   * Execute a mutation query (INSERT, UPDATE, DELETE)
   *
   * @param sql - SQL mutation query
   * @param params - Query parameters (array for positional, object for named)
   * @returns RbookToolResult with mutation result (changes, lastInsertRowid)
   */
  execute(sql: string, params?: QueryParams): RbookToolResult<MutationResult> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as RbookToolResult<MutationResult>;
    }
    const refused = this.refusedWrite(sql, 'execute');
    if (refused) return refused;

    const wasInTransaction = this.inTransaction;
    try {
      const stmt = this.prepareStatement(sql);
      const result = params ? stmt.run(params) : stmt.run();
      // s93-m11: a row changed in this store during a dispatched call (first-write upkeep runs
      // only for stores a call really wrote).
      if (result.changes > 0 && ROW_WRITE_SQL.test(sql)) recordStoreWrite(this.path);
      return createSuccess({
        changes: result.changes,
        lastInsertRowid: result.lastInsertRowid,
      });
    } catch (error) {
      return this.handleQueryError(error, sql);
    } finally {
      this.followTransactionVerb(sql, wasInTransaction);
    }
  }

  /**
   * Execute multiple statements in a transaction
   *
   * All statements succeed or all fail (atomic).
   *
   * @param fn - Function that performs database operations
   * @returns RbookToolResult with the function's return value
   */
  transaction<T>(fn: () => T): RbookToolResult<T> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as RbookToolResult<T>;
    }

    try {
      const db = this.db!;
      const transaction = db.transaction(fn);
      const result = transaction();
      if (!db.inTransaction) flushReplicaMark(this);
      return createSuccess(result);
    } catch (error) {
      if (!this.inTransaction) discardReplicaMark(this);
      return this.handleQueryError(error, 'TRANSACTION');
    }
  }

  /**
   * Execute raw SQL (for complex operations like PRAGMA)
   *
   * Use with caution - prefer getOne/getMany/execute for standard queries.
   *
   * @param sql - Raw SQL to execute
   * @returns RbookToolResult indicating success or error
   */
  raw(sql: string): RbookToolResult<void> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as RbookToolResult<void>;
    }
    const refused = this.refusedWrite(sql, 'raw');
    if (refused) return refused;

    const wasInTransaction = this.inTransaction;
    try {
      this.db!.exec(sql);
      return createSuccess(undefined);
    } catch (error) {
      return this.handleQueryError(error, sql);
    } finally {
      this.followTransactionVerb(sql, wasInTransaction);
    }
  }

  /**
   * Set or read a PRAGMA via better-sqlite3's dedicated `db.pragma()` API.
   *
   * Use this for connection-state pragmas like `foreign_keys` / `legacy_alter_table`:
   * setting them via `raw()` (i.e. `db.exec('PRAGMA ...')`) is UNRELIABLE — the
   * change may not take effect until the next prepared-statement boundary, which
   * is what made the 12-step rebuild's `foreign_keys = OFF` intermittently a
   * no-op and risked firing ON DELETE actions on children. `db.pragma()` applies
   * the setting immediately. Returns the pragma's result (number for simple
   * pragmas, rows otherwise).
   */
  pragma(pragmaString: string): unknown {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return undefined;
    }
    return this.db!.pragma(pragmaString);
  }

  /**
   * Check database health and return statistics
   *
   * @returns RbookToolResult with database health information
   */
  health(): RbookToolResult<DbHealthResult> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as RbookToolResult<DbHealthResult>;
    }

    try {
      const db = this.db!;

      // Get SQLite version
      const versionRow = db.prepare('SELECT sqlite_version() as version').get() as {
        version: string;
      };

      // Get table list
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        .all() as { name: string }[];

      // Get counts for key tables
      const missionCount = this.safeCount('missions');
      const sessionCount = this.safeCount('sessions');
      const contextCount = this.safeCount('contexts');

      return createSuccess({
        connected: true,
        version: versionRow.version,
        path: this.dbPath,
        tables: tables.map((t) => t.name),
        missionCount,
        sessionCount,
        contextCount,
      });
    } catch (error) {
      return this.handleQueryError(error, 'HEALTH_CHECK');
    }
  }

  /**
   * Close the database connection
   *
   * Clears the statement cache and releases all resources.
   * Safe to call multiple times.
   */
  close(): void {
    this.statementCache.clear();
    if (this.db && this.db.open) {
      this.db.close();
    }
    this.db = null;
    // s96-m01: closing ends any transaction, and with it the write lock.
    this.writeLocked = false;
    discardReplicaMark(this);
  }

  /**
   * Get a prepared statement (cached for performance)
   */
  private prepareStatement(sql: string): Statement {
    let stmt = this.statementCache.get(sql);
    if (!stmt) {
      stmt = this.db!.prepare(sql);
      this.statementCache.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * Safely count rows in a table
   */
  private safeCount(tableName: string): number {
    try {
      const row = this.db!.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as {
        count: number;
      };
      return row.count;
    } catch {
      return 0;
    }
  }

  /**
   * Handle query errors and translate to RbookToolError
   */
  private handleQueryError<T>(error: unknown, _sql: string): RbookToolResult<T> {
    // s96-m01: a shared record's refusal thrown inside a write keeps its own code and remedy.
    const refusal = carriedRefusal(error);
    if (refusal) return createError(refusal);
    // s86-m02b: DUCK-TYPED, not `instanceof Error`. A better-sqlite3 SqliteError that crosses a
    // module-registry / realm boundary (Jest's per-file registry is the everyday case) fails
    // `instanceof`, and the old fallback `String(error)` then produced the class-name-prefixed
    // "SqliteError: <msg>" instead of "<msg>". That text is now DISCLOSED IN ANSWERS via
    // checkWrite/countWrite, so a message that changes shape depending on which realm threw it
    // makes the answer non-deterministic — and made a mission test order-dependent.
    const rawMessage =
      typeof (error as { message?: unknown } | null)?.message === 'string'
        ? (error as { message: string }).message
        : String(error ?? 'Unknown database error');
    const message = rawMessage.toLowerCase();
    const sqliteCode =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof (error as { code: unknown }).code === 'string'
        ? ((error as { code: string }).code ?? '').toUpperCase()
        : '';

    // Check for specific SQLite error patterns
    if (message.includes('no such table')) {
      const tableMatch = rawMessage.match(/no such table:\s*(?:\w+\.)?([\w-]+)/i);
      const tableName = tableMatch?.[1] ?? 'unknown';
      return createError({
        code: RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH,
        message: `Table '${tableName}' does not exist`,
        suggestion: 'Ensure the database schema is up to date. Run migrations if needed.',
      });
    }

    if (message.includes('no such column') || message.includes('has no column named')) {
      const columnMatch = rawMessage.match(
        /(?:no such column|has no column named):?\s*(?:\w+\.)?([\w-]+)/i
      );
      const columnName = columnMatch?.[1] ?? 'unknown';
      return createError({
        code: RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH,
        message: `Column '${columnName}' does not exist`,
        suggestion: 'Ensure the database schema is up to date. Run migrations if needed.',
      });
    }

    if (message.includes('unique constraint failed') || sqliteCode.includes('CONSTRAINT_UNIQUE')) {
      const fieldMatch = rawMessage.match(/UNIQUE constraint failed:\s*(\S+)/i);
      const field = fieldMatch?.[1] ?? 'unknown';
      return createError({
        code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
        message: `Duplicate value for unique field '${field}'`,
        field: field.split('.').pop(),
        suggestion: 'Use a unique value for this field or update the existing record.',
      });
    }

    if (
      message.includes('foreign key constraint failed') ||
      sqliteCode.includes('CONSTRAINT_FOREIGNKEY')
    ) {
      return createError({
        code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
        message: 'Foreign key constraint violation',
        suggestion: 'Ensure referenced records exist before inserting or updating.',
      });
    }

    if (message.includes('database is locked') || sqliteCode === 'SQLITE_BUSY') {
      return createError({
        code: RBOOK_ERROR_CODES.DB_CONNECTION_FAILED,
        message: 'Database is locked by another process',
        suggestion: 'Wait and retry, or close other applications using the database.',
      });
    }

    if (message.includes('sqlite_readonly') || sqliteCode === 'SQLITE_READONLY') {
      return createError({
        code: RBOOK_ERROR_CODES.DB_CONNECTION_FAILED,
        message: 'Database is opened in read-only mode',
        suggestion: 'Reopen the database with readonly: false to perform mutations.',
      });
    }

    // Generic query error
    return createError({
      code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
      message: `Query failed: ${rawMessage}`,
      suggestion: 'Check the SQL syntax and parameters.',
    });
  }

  /**
   * Validate project ID matches expected value from environment.
   *
   * Database self-protection: If the database has a project_id in metadata,
   * the RBOOK_PROJECT_ID env var MUST be set and match. This prevents
   * cross-project contamination when multiple projects use Reasonbook.
   *
   * - Database has project_id + env var matches → success
   * - Database has project_id + env var missing → error (protection active)
   * - Database has project_id + env var mismatch → error
   * - Database has no project_id → success (backward compatible)
   *
   * @returns RbookToolResult indicating success or mismatch error
   */
  validateProjectId(): RbookToolResult<void> {
    const expectedProjectId = getSetting(RBOOK_PROJECT_ID_ENV);

    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as RbookToolResult<void>;
    }

    try {
      // Read project_id from metadata table
      const stmt = this.db!.prepare('SELECT value FROM metadata WHERE key = ?');
      const row = stmt.get('project_id') as { value: string } | undefined;
      const databaseProjectId = row?.value ?? '';

      // If database has no project_id, skip validation (backward compatible)
      if (!databaseProjectId) {
        return createSuccess(undefined);
      }

      // Database has project_id - enforce validation
      if (!expectedProjectId) {
        return createError({
          code: RBOOK_ERROR_CODES.PROJECT_ID_MISMATCH,
          message: `This database requires project ID validation. Database project: "${databaseProjectId}"`,
          suggestion: `Set RBOOK_PROJECT_ID="${databaseProjectId}" environment variable to write to this database.`,
        });
      }

      if (databaseProjectId !== expectedProjectId) {
        return createError({
          code: RBOOK_ERROR_CODES.PROJECT_ID_MISMATCH,
          message: `Project ID mismatch: env has "${expectedProjectId}", database has "${databaseProjectId}"`,
          suggestion: `You may be connected to the wrong database. Set RBOOK_PROJECT_ID="${databaseProjectId}" or check your projectRoot.`,
        });
      }

      return createSuccess(undefined);
    } catch (error) {
      // If metadata table doesn't exist, skip validation (old database)
      const message = error instanceof Error ? error.message : String(error ?? '');
      if (/no such table:\s*(?:\w+\.)?metadata/i.test(message)) {
        // No metadata table = old database, skip validation for backward compatibility
        return createSuccess(undefined);
      }
      return this.handleQueryError(error, 'validateProjectId');
    }
  }

  /**
   * s96-m11: run a write in a transaction that takes the store's write lock at BEGIN (BEGIN
   * IMMEDIATE), waiting within the busy timeout. A deferred transaction that reads before it writes
   * is refused at once, "database is locked", when another process commits in between, and no wait
   * helps it; two processes recording the first decisions of one store hit that on CI. Reads keep
   * `transaction`, so a hook's digest never queues behind a writer.
   */
  writeTransaction<T>(fn: () => T): RbookToolResult<T> {
    const connectionResult = this.ensureConnection();
    if (!connectionResult.success) {
      return connectionResult as RbookToolResult<T>;
    }
    const outermost = !this.inTransaction;
    if (outermost) {
      this.writeLocked = true;
      this.transactions += 1;
    }
    try {
      const result = this.db!.transaction(fn).immediate();
      // s96-m01: this machine's mark of a shared copy follows the outermost commit, never leads it.
      if (!this.inTransaction) flushReplicaMark(this);
      return createSuccess(result);
    } catch (error) {
      if (!this.inTransaction) discardReplicaMark(this);
      return this.handleQueryError(error, 'TRANSACTION');
    } finally {
      if (outermost) this.writeLocked = false;
    }
  }
}

/**
 * Convenience function to create a client and run a single operation
 *
 * Automatically closes the connection after the operation.
 *
 * @param fn - Function that uses the client
 * @param options - Client options
 * @returns Result of the operation
 */
export async function withClient<T>(
  fn: (client: RbookDatabaseClient) => RbookToolResult<T>,
  options?: RbookDatabaseClientOptions
): Promise<RbookToolResult<T>> {
  const clientResult = await RbookDatabaseClient.create(options);
  if (!clientResult.success || !clientResult.data) {
    return clientResult as RbookToolResult<T>;
  }

  const client = clientResult.data;
  try {
    return attachWarnings(fn(client), clientResult.warnings ?? []);
  } finally {
    client.close();
  }
}

/**
 * Convenience function for async operations with automatic cleanup
 *
 * @param fn - Async function that uses the client
 * @param options - Client options
 * @returns Result of the operation
 */
export async function withClientAsync<T>(
  fn: (client: RbookDatabaseClient) => Promise<RbookToolResult<T>>,
  options?: RbookDatabaseClientOptions
): Promise<RbookToolResult<T>> {
  const clientResult = await RbookDatabaseClient.create(options);
  if (!clientResult.success || !clientResult.data) {
    return clientResult as RbookToolResult<T>;
  }

  const client = clientResult.data;
  try {
    return attachWarnings(await fn(client), clientResult.warnings ?? []);
  } finally {
    client.close();
  }
}

/**
 * Convenience function for mutation operations.
 *
 * NOTE: Project ID validation has been removed. The explicit projectRoot
 * requirement (no cwd fallback) provides sufficient protection against
 * cross-project contamination without requiring env var configuration.
 *
 * This function is now identical to withClient but kept for backward
 * compatibility with existing tool implementations.
 *
 * @param fn - Function that uses the client
 * @param options - Client options
 * @returns Result of the operation
 */
export async function withClientValidated<T>(
  fn: (client: RbookDatabaseClient) => RbookToolResult<T>,
  options?: RbookDatabaseClientOptions
): Promise<RbookToolResult<T>> {
  // Simply delegate to withClient - no additional validation needed
  // since projectRoot is now required (no cwd fallback)
  return withClient(fn, options);
}
