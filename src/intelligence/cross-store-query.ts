// ABOUTME: Sprint 69 m06 — application-level fan-out cross-store read path (s68 ADR Section 4.1).
// ABOUTME: Opens each per-project store read-only, runs one query each, k-way merges by the per-row schema keys.

/**
 * Cross-store fan-out read API (s68 ADR Section 4.1 — application-level fan-out as
 * the PRIMARY path). It discovers stores via the project-graph registry (s69-m05),
 * opens each per-project `rbook.sqlite` READ-ONLY, runs the same parameterized query
 * per store, and merges the results by the m03 per-row schema keys
 * `(occurred_at, origin_seq, project_id)`.
 *
 * Bounded, sorted per-store arrays feed a min-heap merge that stops at the global
 * limit. Opening, querying and closing each store in one task bounds open handles.
 * Readonly connections reject writes; one store's failure is named in errors[]
 * without failing the rest. A custom query supports legacy schemas without merge
 * columns; it must return the same sorted, bounded row shape.
 * ADR §5.5 reserves an eventual App-View dispatch when N>125 or fan-in p95>200ms.
 *
 * @module intelligence/cross-store-query
 */

import { resolveRecordPaths } from './legacy-compat';
import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { ProjectGraphRegistry, type ProjectGraphEntry } from './project-graph-registry';

/** Busy timeout (ms) for the read-only per-store opens. */
const STORE_OPEN_TIMEOUT_MS = 5000;
/** Default global row cap (also pushed down per store). */
const DEFAULT_LIMIT = 100;
/** Default parallel-open ceiling — caps concurrent file handles at large N. */
const DEFAULT_CONCURRENCY = 32;
/** The canonical merge key (ADR §4.1). */
export const DEFAULT_MERGE_KEY = ['occurred_at', 'origin_seq', 'project_id'] as const;

/** A row carrying the per-row schema merge keys plus the caller's other columns. */
export interface CrossStoreRow {
  occurred_at: number;
  origin_seq: number;
  project_id: string;
  [column: string]: unknown;
}

export interface CrossStoreQueryOptions<P = CrossStoreProbeValue> {
  /**
   * The per-store SELECT — must project `occurred_at`, `origin_seq`, and
   * `project_id` (the merge keys). Do NOT include ORDER BY / LIMIT; this API wraps
   * the query and appends them so the per-store sort matches the merge comparator.
   */
  sql: string;
  /** Bound parameters for `sql`. */
  params?: unknown[];
  /** Keep only registry entries matching this predicate (default: all active stores). */
  projectFilter?: (entry: ProjectGraphEntry) => boolean;
  /** Order for the leading `occurred_at`/`origin_seq` keys (default 'desc' — newest first). */
  order?: 'asc' | 'desc';
  /** Global row cap, also pushed down per store (default 100). */
  limit?: number;
  /** Parallel-open ceiling (default 32). */
  concurrency?: number;
  /** Injectable registry (tests); defaults to the singleton via `create()`. */
  registry?: ProjectGraphRegistry;
  /** Existing discovery snapshot; even [] bypasses registry creation and backfills. */
  stores?: readonly ProjectGraphEntry[];
  /** Legacy-schema query. Return at most limitWithSentinel rows sorted by the merge keys. */
  perStoreQuery?: (
    db: Database.Database,
    store: ProjectGraphEntry,
    limitWithSentinel: number
  ) => CrossStoreRow[];
  /** SQLite busy timeout per store; clipped to remaining deadline time when provided. */
  timeoutMs?: number;
  /** Absolute deadline in clock() units. Late and unvisited stores are named failures. */
  deadlineAtMs?: number;

  /**
   * s87-m03 (#529): an extra read ON THE EXISTING CONNECTION. Review drift must read content,
   * not sidecar mtimes its own readonly open creates. Decision #1016's cost fence permits no
   * new opens, connections or network; this callback satisfies it by construction.
   * Results are keyed by registry project_id in probes. Failures stay in probeErrors, never
   * errors: an optional probe failure cannot reclassify a successfully queried store as unreadable.
   */
  perStoreProbe?: (db: Database.Database, store: ProjectGraphEntry) => P;
}

/**
 * What a per-store probe may return: a number, `null` for "found nothing to report", or (s93-m11)
 * `'no-history'` for a store whose domain tables hold no row yet.
 */
export type CrossStoreProbeValue = number | null | 'no-history';

/** A per-store failure, isolated from the rest of the query. */
export interface CrossStoreError {
  projectId: string;
  storePath: string;
  error: string;
}

/** s87-m03 — one store's {@link CrossStoreQueryOptions.perStoreProbe} result. */
export interface CrossStoreProbe<P = CrossStoreProbeValue> {
  projectId: string;
  /** Whatever the probe returned; `null` means "the probe ran and found nothing to report". */
  value: P;
}

/** The fan-out result: merged rows + isolated errors + latency instrumentation. */
export interface CrossStoreQueryResult<
  T extends CrossStoreRow = CrossStoreRow,
  P = CrossStoreProbeValue,
> {
  results: T[];
  errors: CrossStoreError[];

  /**
   * s87-m03 — per-store probe values, present only for stores whose query SUCCEEDED and whose
   * probe did not throw. Empty when no `perStoreProbe` was supplied.
   */
  probes: CrossStoreProbe<P>[];

  /**
   * s87-m03 — separate from errors, which deriveDrift uses to classify store reachability.
   * An optional probe failure degrades drift to unknown, never the store to unreadable.
   */
  probeErrors: CrossStoreError[];
  metadata: {
    storesQueried: number;
    storesSucceeded: number;
    storesFailed: number;
    /** Per-successful-store query latency (ms). */
    perStoreMs: number[];
    /** p95 of `perStoreMs` (null when no store succeeded). Feeds App-View Trigger A. */
    perStoreP95Ms: number | null;
    /** Wall-clock for the whole fan-out (ms). */
    overallMs: number;
    /** True when the global `limit` clipped the merged output. */
    truncated: boolean;
  };
}

/** Absolute path to a store's SQLite DB given the project ROOT. */
export function storeDbPath(storeRoot: string): string {
  return resolveRecordPaths(storeRoot).dbPath;
}

/**
 * Open a per-project store READ-ONLY (OPEN_READONLY). Any write issued on the
 * returned connection throws `SqliteError: attempt to write a readonly database`.
 * Throws if the DB file is absent (caller isolates per-store).
 */
export function openStoreReadOnly(
  storeRoot: string,
  timeoutMs = STORE_OPEN_TIMEOUT_MS
): Database.Database {
  const dbPath = storeDbPath(storeRoot);
  if (!existsSync(dbPath)) {
    throw new Error(`store DB not found: ${dbPath}`);
  }
  return new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: timeoutMs,
  });
}

/**
 * ORDER BY clause matching the merge comparator: occurred_at/origin_seq follow
 * `order`, project_id ASC. **IFNULL(.,0) is load-bearing for merge correctness:**
 * SQLite ranks NULL as a value distinct from 0 (NULLs last in DESC, first in ASC),
 * but {@link compareMergeRows} coerces NULL→0. Without IFNULL, a store whose rows
 * mix NULL and 0 in these columns (an un-migrated/foreign store — the per-row
 * columns are nullable until the m03 Step-5 rebuild) would return an array that is
 * NOT sorted under the comparator, silently corrupting the k-way merge. IFNULL
 * makes the SQL sort agree with the comparator's 0-coercion.
 */
function orderClause(order: 'asc' | 'desc'): string {
  const dir = order === 'asc' ? 'ASC' : 'DESC';
  return `IFNULL(occurred_at, 0) ${dir}, IFNULL(origin_seq, 0) ${dir}, project_id ASC`;
}

/**
 * Compare two merge rows. Negative ⇒ `a` sorts before `b` for the given order.
 * Null occurred_at/origin_seq coerce to 0 (defensive — un-migrated rows).
 */
function compareMergeRows(a: CrossStoreRow, b: CrossStoreRow, order: 'asc' | 'desc'): number {
  const ao = typeof a.occurred_at === 'number' ? a.occurred_at : 0;
  const bo = typeof b.occurred_at === 'number' ? b.occurred_at : 0;
  if (ao !== bo) return order === 'asc' ? ao - bo : bo - ao;
  const as = typeof a.origin_seq === 'number' ? a.origin_seq : 0;
  const bs = typeof b.origin_seq === 'number' ? b.origin_seq : 0;
  if (as !== bs) return order === 'asc' ? as - bs : bs - as;
  // project_id is the final, direction-independent tiebreak (deterministic ASC).
  return a.project_id < b.project_id ? -1 : a.project_id > b.project_id ? 1 : 0;
}

/** A binary min-heap over a caller-supplied "less-than" comparator. */
class BinaryHeap<T> {
  private readonly items: T[] = [];
  constructor(private readonly less: (a: T, b: T) => boolean) {}
  get size(): number {
    return this.items.length;
  }
  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i], items[parent])) {
        [items[i], items[parent]] = [items[parent], items[i]];
        i = parent;
      } else break;
    }
  }
  pop(): T | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop() as T;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      const n = items.length;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && this.less(items[l], items[smallest])) smallest = l;
        if (r < n && this.less(items[r], items[smallest])) smallest = r;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Run `tasks` with at most `concurrency` in flight; preserves input order in the output. */
async function runPooled<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = new Array(Math.min(concurrency, tasks.length)).fill(null).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** p95 of a latency sample (nearest-rank). Null for an empty sample. */
function p95(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

/**
 * Query active stores and merge by (occurred_at, origin_seq, project_id).
 * The injectable clock governs both latency measurements and optional absolute deadlines.
 */
export async function queryAcrossStores<
  T extends CrossStoreRow = CrossStoreRow,
  P = CrossStoreProbeValue,
>(
  options: CrossStoreQueryOptions<P>,
  clock: () => number = Date.now
): Promise<CrossStoreQueryResult<T, P>> {
  const order = options.order ?? 'desc';
  const limit = options.limit ?? DEFAULT_LIMIT;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const params = options.params ?? [];

  const discovered =
    options.stores ?? (options.registry ?? (await ProjectGraphRegistry.create())).list();
  const stores = discovered.filter(options.projectFilter ?? (() => true));

  // Pull `limit + 1` per store so a store holding EXACTLY `limit` rows is
  // distinguishable from one holding more — `capped` is then provable (returned
  // > limit), not merely inferred from a count that equals the pushdown LIMIT.
  const wrapped = `SELECT * FROM (${options.sql}) ORDER BY ${orderClause(order)} LIMIT ?`;

  const overallStart = clock();
  const errors: CrossStoreError[] = [];
  const probes: CrossStoreProbe<P>[] = [];
  const probeErrors: CrossStoreError[] = [];
  const perStoreMs: number[] = [];
  const cappedFlags: boolean[] = [];
  const checkDeadline = (): void => {
    if (options.deadlineAtMs !== undefined && clock() >= options.deadlineAtMs)
      throw new Error('Cross-store read deadline exceeded; this store was not included.');
  };

  // One bounded, read-only, isolated query per store. open → query → CLOSE keeps
  // open file handles ≤ concurrency regardless of N.
  const tasks = stores.map((store) => async (): Promise<T[]> => {
    const start = clock();
    let db: Database.Database | null = null;
    try {
      checkDeadline();
      const timeout = options.timeoutMs ?? STORE_OPEN_TIMEOUT_MS;
      db = openStoreReadOnly(
        store.store_path,
        options.deadlineAtMs === undefined
          ? timeout
          : Math.min(timeout, Math.max(0, Math.floor(options.deadlineAtMs - clock())))
      );
      const raw = (
        options.perStoreQuery
          ? options.perStoreQuery(db, store, limit + 1)
          : db.prepare(wrapped).all(...params, limit + 1)
      ) as T[];
      checkDeadline();

      // s87-m03 (#529) — the optional probe, on THIS connection, inside its OWN try/catch. The
      // inner catch is the whole point: a probe throw must not reach the outer handler, because
      // that one records into `errors` and would reclassify a perfectly readable store as
      // unreadable on the strength of an optional extra read failing.
      if (options.perStoreProbe) {
        try {
          const value = options.perStoreProbe(db, store);
          checkDeadline();
          probes.push({ projectId: store.project_id, value });
        } catch (probeErr) {
          probeErrors.push({
            projectId: store.project_id,
            storePath: store.store_path,
            error: probeErr instanceof Error ? probeErr.message : String(probeErr),
          });
        }
      }
      checkDeadline();

      // Measured AFTER the probe, so the recorded per-store latency includes it. A probe whose
      // cost is invisible to the p95 the cost fence is judged against would make that fence
      // unfalsifiable (#1016 requires the per-store cost to be measured, not asserted).
      perStoreMs.push(clock() - start);
      const capped = raw.length > limit;
      cappedFlags.push(capped);
      return capped ? raw.slice(0, limit) : raw;
    } catch (err) {
      errors.push({
        projectId: store.project_id,
        storePath: store.store_path,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    } finally {
      if (db) db.close();
    }
  });

  const perStoreRows = await runPooled(tasks, concurrency);

  // k-way merge the (already per-store sorted) bounded arrays via a min-heap,
  // emitting the global top-`limit` without sorting all N×limit rows.
  type Cursor = { rows: T[]; idx: number };
  const cursors: Cursor[] = perStoreRows
    .filter((rows) => rows.length > 0)
    .map((rows) => ({
      rows,
      idx: 0,
    }));
  const heap = new BinaryHeap<Cursor>(
    (a, b) => compareMergeRows(a.rows[a.idx], b.rows[b.idx], order) < 0
  );
  for (const c of cursors) heap.push(c);

  const results: T[] = [];
  let totalAvailable = 0;
  for (const c of cursors) totalAvailable += c.rows.length;
  while (results.length < limit && heap.size > 0) {
    const c = heap.pop() as Cursor;
    results.push(c.rows[c.idx]);
    c.idx += 1;
    if (c.idx < c.rows.length) heap.push(c);
  }

  // A store is truly capped only if it returned MORE than `limit` (we pulled
  // limit+1 and sliced back) — so this no longer false-positives on a store that
  // happens to hold exactly `limit` rows.
  const anyStoreCapped = cappedFlags.some(Boolean);
  const overallMs = clock() - overallStart;
  return {
    results,
    errors,
    probes,
    probeErrors,
    metadata: {
      storesQueried: stores.length,
      storesSucceeded: stores.length - errors.length,
      storesFailed: errors.length,
      perStoreMs,
      perStoreP95Ms: p95(perStoreMs),
      overallMs,
      // Truncated only when output was actually clipped: we emitted a full `limit`
      // AND there is provably more — either more rows were gathered than emitted
      // (totalAvailable > limit) or some store hit its own pushdown LIMIT (so more
      // may lie past it). Emitting exactly `limit` rows that were ALL gathered with
      // no store capped is NOT truncated.
      truncated: results.length >= limit && (totalAvailable > limit || anyStoreCapped),
    },
  };
}
