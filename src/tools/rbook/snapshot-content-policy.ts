// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m09 — which context snapshots store their content: the nine insert sites and their
// ABOUTME: kinds, the one write-time rule, and the source classes a prune may treat as copies.

import type { RbookDatabaseClient } from './client';
import { snapshotDedupPrunedFilter } from './schema-migrations';

/**
 * Measured before this module existed (24 registered stores, read-only, MB = 2^20 bytes): snapshot
 * content was 367.6 MB of 667.9 MB on disk. The copies a session or mission close writes after
 * persisting its context were 282.7 MB of it (76.9%), and the legacy
 * `session_runtime`/`mission_runtime` copies another 58.8 MB. No query path reads them. Everything else is either a recovery copy taken before
 * content is trimmed, condensed or migrated, a milestone, or something a person asked for.
 *
 * THE RULE: every snapshot stores its content except a close's persist copy, and that copy keeps
 * its content too when the live context row it copies failed to write, because it is then the one
 * durable copy of the aggregated content (s86-m02b). A content-less copy is written with
 * `content_pruned_at` stamped and its hash prefixed `pruned:`, so it is never a dedup hit, for this
 * code or an older server sharing the store: a later identical write stores its own content.
 *
 * DEDUP PROTECTION (the s92-m09 critic's B2): every site deduplicates on (context, content hash),
 * and a site that reuses an existing row records THAT row's id and source, not its own. A named
 * snapshot, a sprint milestone or a recovery copy that landed on an update copy would therefore be
 * classified, and pruned, as an update copy. So a site reuses a row only when a prune will keep
 * that row at least as long as the site's own row (`findReusableSnapshot`); otherwise it stores a
 * new one. A recovery copy's 30 days run from its own creation, so a recovery copy stands only on a
 * row no prune reclaims, or on an identical recovery copy under a minute old (a repeated attempt,
 * whose window is then short by under a minute).
 */

export type SnapshotKind =
  /** A sprint close. */
  | 'milestone'
  /** `rbook_context(action="snapshot")`: someone asked for it. */
  | 'explicit'
  /** A recovery copy taken before content is trimmed, condensed or migrated. */
  | 'pre-mutation'
  /** A copy of content just written by an explicit update or a session-start auto-refresh. */
  | 'post-write'
  /** The copy a session or mission close writes after persisting its context. */
  | 'close-persist';

export interface SnapshotInsertSite {
  /** File under src/tools/rbook/ holding the snapshot insert. */
  file: string;
  kind: SnapshotKind;
  /** The `source` the site writes. */
  source: string;
}

/**
 * THE PUBLISHED CLASSIFICATION (practice 8). Predicate: grep -rln for the literal SQL that inserts
 * into context_snapshots, over src — 9 files, one INSERT each (this note avoids the literal so the
 * predicate does not count it). A census test fails when the predicate finds a file this table does
 * not classify, or when a site's INSERT disagrees with its kind.
 */
export const SNAPSHOT_INSERT_SITES: readonly SnapshotInsertSite[] = [
  { file: 'blob-migrations.ts', kind: 'pre-mutation', source: 'pre-migration: blob-schema-v<N>' },
  {
    file: 'rbook-context-condense.ts',
    kind: 'pre-mutation',
    source: 'context_condense:<strategy>',
  },
  { file: 'rbook-context-snapshot.ts', kind: 'explicit', source: "<the caller's own text>" },
  { file: 'rbook-context-update.ts', kind: 'post-write', source: 'Context update: …' },
  {
    file: 'rbook-mission-complete.ts',
    kind: 'close-persist',
    source: 'mission_complete:<mission>',
  },
  {
    file: 'rbook-session-complete.ts',
    kind: 'close-persist',
    source: 'session_complete:<session>',
  },
  { file: 'rbook-sprint-complete.ts', kind: 'milestone', source: 'sprint_complete:<sprint>' },
  { file: 'context-freshness.ts', kind: 'post-write', source: 'session_start:auto_refresh' },
  {
    file: 'context-retention.ts',
    kind: 'pre-mutation',
    source: 'retention_archive:<caller source>',
  },
];

/** Whether a snapshot of this kind stores its content. See the module note for the rule. */
export function snapshotStoresContent(kind: SnapshotKind, liveCopyWritten = true): boolean {
  return kind !== 'close-persist' || !liveCopyWritten;
}

/** What a site writes for one snapshot: the `content` value and any extra INSERT columns. */
export interface SnapshotStorage {
  content: string;
  stored: boolean;
  /** The `content_hash` to store: the real hash, or `pruned:<hash>` for a content-less row. */
  contentHash: string;
  /** `content_pruned_at` when the content is not stored; empty otherwise. */
  columns: string[];
  values: string[];
}

/** Marks the hash of a row whose content is gone, so no hash lookup can match it. */
export const PRUNED_HASH_PREFIX = 'pruned:';

/**
 * The INSERT values for one snapshot under the rule. `canStamp` is false on a store that lacks
 * `content_pruned_at` (the caller ran the migration and it did not land); the copy then keeps its
 * content rather than write an unmarked empty row that a dedup lookup could hit.
 */
export function snapshotStorage(
  kind: SnapshotKind,
  content: string,
  options: {
    contentHash?: string;
    liveCopyWritten?: boolean;
    canStamp?: boolean;
    now?: string;
  } = {}
): SnapshotStorage {
  const contentHash = options.contentHash ?? '';
  if (snapshotStoresContent(kind, options.liveCopyWritten ?? true) || options.canStamp === false) {
    return { content, stored: true, contentHash, columns: [], values: [] };
  }
  return {
    content: '',
    stored: false,
    contentHash: `${PRUNED_HASH_PREFIX}${contentHash}`,
    columns: ['content_pruned_at'],
    values: [options.now ?? new Date().toISOString()],
  };
}

/**
 * The retention archive's source prefix. A retention archive takes its caller's source (a session
 * close passes `session_complete:<id>`, the same string as that close's persist copy), so without
 * the prefix a prune could not tell the recovery copy from the content-less copy beside it.
 */
export const RETENTION_ARCHIVE_SOURCE_PREFIX = 'retention_archive:';

/**
 * Suffix on a close copy that kept its content because the context write failed: the one durable
 * copy of that aggregated content, so no prune may reclaim it.
 */
export const ONLY_COPY_SOURCE_SUFFIX = ':only_copy';

export type SnapshotSourceClass =
  | 'sprint-milestone'
  | 'only-copy'
  | 'close-persist'
  | 'legacy-close-persist'
  | 'post-write'
  | 'pre-mutation'
  | 'explicit-or-unknown';

/**
 * The class a stored `source` belongs to, for the prune. Rows written before the prefix existed
 * keep their old sources: a retention archive written by a session close reads as a close copy,
 * which is why the prune also preserves every snapshot a context's `archived_sprint_summaries`
 * still references.
 */
export function classifySnapshotSource(source: string | null): SnapshotSourceClass {
  const s = source ?? '';
  if (s.startsWith('sprint_complete')) return 'sprint-milestone';
  // A mission close that completed its sprint wrote `mission_complete:<id>:sprint_complete`: the
  // context as the sprint closed (s84 counted these as copies; s92-m09 keeps them as milestones).
  if (s.endsWith(':sprint_complete')) return 'sprint-milestone';
  if (s.endsWith(ONLY_COPY_SOURCE_SUFFIX)) return 'only-copy';
  if (s.startsWith(RETENTION_ARCHIVE_SOURCE_PREFIX)) return 'pre-mutation';
  if (s.startsWith('pre-migration:') || s.startsWith('context_condense:')) return 'pre-mutation';
  if (s.startsWith('session_complete:') || s.startsWith('mission_complete:')) {
    return 'close-persist';
  }
  if (s === 'session_runtime' || s === 'mission_runtime') return 'legacy-close-persist';
  if (
    s.startsWith('context_update:') ||
    s.startsWith('Context update:') ||
    s.startsWith('session_start:')
  ) {
    return 'post-write';
  }
  return 'explicit-or-unknown';
}

/**
 * Whether a prune may reclaim a snapshot of this class at all. Milestones, only copies, and
 * snapshots someone named (an explicit snapshot's source is free text, so every unrecognised source
 * counts) are never automatic copies.
 */
export function isAutomaticCopy(cls: SnapshotSourceClass): boolean {
  return classProtection(cls) < 3;
}

/** A pre-mutation recovery copy younger than this many days is kept by the prune. */
export const PRE_MUTATION_KEEP_DAYS = 30;

/**
 * How a prune treats a class: 3, never reclaimed by class; 2, a recovery copy kept for
 * PRE_MUTATION_KEEP_DAYS; 1, an automatic copy reclaimed outside the keep rules.
 */
export function classProtection(cls: SnapshotSourceClass): 1 | 2 | 3 {
  if (cls === 'sprint-milestone' || cls === 'only-copy' || cls === 'explicit-or-unknown') return 3;
  if (cls === 'pre-mutation') return 2;
  return 1;
}

/** The protection a site's own new row would get. */
export function kindProtection(kind: SnapshotKind, liveCopyWritten = true): 1 | 2 | 3 {
  if (kind === 'milestone' || kind === 'explicit') return 3;
  if (kind === 'close-persist' && !liveCopyWritten) return 3;
  if (kind === 'pre-mutation') return 2;
  return 1;
}

/**
 * Whether an explicit snapshot's caller-chosen source would be read as an automatic copy (a prefix
 * Reasonbook writes on its own). Such a name is refused, since a prune could otherwise reclaim it.
 */
export function isReservedExplicitSource(source: string): boolean {
  return classProtection(classifySnapshotSource(source)) < 3;
}

/**
 * A row's creation instant (Unix ms). Accepts ISO strings with an offset and SQLite's `YYYY-MM-DD HH:MM:SS` (UTC);
 * an unparseable stamp reads as -Infinity, the oldest possible.
 */
export function snapshotTimeMs(row: { createdAt: string }): number {
  const raw = row.createdAt?.trim() ?? '';
  const sqlite = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(raw);
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(raw);
  if (!sqlite && !iso) return -Infinity;
  const t = Date.parse(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : raw);
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * How recent an identical recovery copy must be for a new recovery copy to stand on it. Its 30
 * days started when it was written, so the new copy's window is short by at most this much; a
 * repeated attempt (a migration retried at once) still writes one row, not one per attempt.
 */
export const RECOVERY_COPY_REUSE_WINDOW_MS = 60_000;

/**
 * The existing row a site may reuse instead of writing its own: same context, same content hash,
 * content still present, and kept by a prune at least as long as the site's own row would be. An
 * automatic copy (protection 1) may reuse any such row. Every other kind reuses a row no prune
 * reclaims (protection 3); a recovery copy may also reuse an identical recovery copy written within
 * RECOVERY_COPY_REUSE_WINDOW_MS, since protection 2 is a window that starts at the row's creation.
 * `row` is null when there is none, and the site then stores a new row.
 */
export function findReusableSnapshot(
  client: RbookDatabaseClient,
  options: {
    contextId: string;
    contentHash: string;
    kind: SnapshotKind;
    liveCopyWritten?: boolean;
    /** Injected clock (Unix ms) for the recovery-copy window; defaults to now. */
    nowMs?: number;
  }
):
  | { ok: true; row: { id: number; createdAt: string } | null }
  | { ok: false; message: string; code: string } {
  const candidates = client.getMany<{ id: number; source: string | null; created_at: string }>(
    `SELECT id, source, created_at FROM context_snapshots
      WHERE context_id = ? AND content_hash = ?${snapshotDedupPrunedFilter(client)}
      ORDER BY id`,
    [options.contextId, options.contentHash]
  );
  if (!candidates.success) {
    return {
      ok: false,
      code: candidates.error?.code ?? 'DB_ERROR',
      message: candidates.error?.message ?? 'snapshot lookup failed',
    };
  }
  const needed = kindProtection(options.kind, options.liveCopyWritten ?? true);
  const nowMs = options.nowMs ?? Date.now();
  const reusable = (candidates.data ?? []).find((row) => {
    const protection = classProtection(classifySnapshotSource(row.source));
    if (needed === 1 || protection === 3) return true;
    return (
      needed === 2 &&
      protection === 2 &&
      nowMs - snapshotTimeMs({ createdAt: row.created_at }) <= RECOVERY_COPY_REUSE_WINDOW_MS
    );
  });
  return {
    ok: true,
    row: reusable ? { id: reusable.id, createdAt: reusable.created_at } : null,
  };
}
