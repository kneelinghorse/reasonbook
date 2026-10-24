// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m09 — rbook_db(action="prune_snapshots"): reclaim the content of automatic context
// ABOUTME: snapshot copies. A dry run unless confirm=true; applying snapshots the database first.

/**
 * Requested in msg 738cb21e: 1,192 snapshot rows, 49.2 MB, no supported way to reclaim
 * them, and a local DELETE is unsafe because the table is event-sourced and referenced.
 *
 * WHAT A PRUNE NEVER DOES: delete a row. It empties the content, stamps `content_pruned_at` and
 * prefixes the hash `pruned:` (so no hash lookup, by this server or an older one, can reuse the
 * row). The row, its id, every FK that points at it and its `snapshot_taken` event columns survive.
 * Pull-merge never writes snapshot rows (sync-merge.ts), and the checkpoint upload carries the
 * file, so nothing can bring the content back and the dashboard converges at the next upload.
 *
 * WHAT IT KEEPS: see `selectSnapshotsToPrune` — newest and last-N per context (counting only rows
 * that still hold content), every snapshot a decision or a context's `archived_sprint_summaries`
 * references, sprint milestones, the state each recorded sprint close landed on, anything that is
 * not an automatic copy, recovery copies younger than 30 days, and the caller's keep rules.
 *
 * FAIL CLOSED: a reference or a sprint close that cannot be read cannot be honoured, so an
 * unreadable decisions column, context, event log or sprint table refuses the apply (a dry run
 * reports it). The apply re-reads everything inside its write transaction and empties only rows
 * the database snapshot taken first holds.
 */

import { withClientAsync, type RbookDatabaseClient } from './client';
import { rbookDbSnapshot } from './rbook-db-snapshot';
import {
  DEFAULT_SNAPSHOT_PRUNE_KEEP,
  selectSnapshotsToPrune,
  type PreserveReasons,
  type PruneConfig,
  type PruneSelection,
  type SnapshotReferences,
  type SnapshotRow,
} from './context-snapshot-prune';
import { createError, createSuccess, RBOOK_ERROR_CODES } from './errors';
import { appendWarnings, attachWarnings } from './format-warnings';
import { ensureContentPrunedColumn } from './schema-migrations';
import {
  PRE_MUTATION_KEEP_DAYS,
  PRUNED_HASH_PREFIX,
  snapshotTimeMs,
} from './snapshot-content-policy';
import type { RbookToolResult } from './types';
import { checkWrite } from './write-guard';
import { storedTimeMs } from './stored-time';

export interface RbookDbPruneSnapshotsParams {
  /** true applies the prune; anything else is a dry run. */
  confirm?: boolean;
  keepIds?: number[];
  /** ISO date or timestamp: keep every snapshot created at or after it. */
  keepSince?: string;
  /** Keep every snapshot whose source matches one of these (`*` = anything, case-insensitive). */
  keepSources?: string[];
  /** Snapshots kept per context, newest first (default 30). */
  keepLast?: number;
  projectRoot?: string;
}

export interface PruneSnapshotsContextReport {
  contextId: string;
  rows: number;
  /** Content the context's snapshots held when the call began. */
  bytes: number;
  preserved: number;
  /** Rows a prune would empty (dry run), or rows this call emptied (applied). */
  prunable: number;
  prunableBytes: number;
}

export interface RbookDbPruneSnapshotsResult {
  /** false for a dry run. */
  applied: boolean;
  /** The database snapshot taken before applying; null for a dry run or when nothing was prunable. */
  dbSnapshotId: string | null;
  rows: number;
  /** Content the snapshots hold now: after the prune for an applied call. */
  contentBytes: number;
  preserved: number;
  /**
   * Rows the selection chose. An applied call empties only rows its database snapshot holds, so a
   * row written after that snapshot can be chosen and still left as it is; `tombstoned` counts
   * what was emptied.
   */
  prunable: number;
  /** What the selection would reclaim (dry run) or chose to reclaim (applied). */
  bytesReclaimable: number;
  /** Rows whose content this call emptied (0 for a dry run). */
  tombstoned: number;
  /** Content this call emptied, counted row by row (0 for a dry run). */
  bytesReclaimed: number;
  perContext: PruneSnapshotsContextReport[];
  preserveReasons: PreserveReasons;
  /** Distinct snapshot ids referenced from decisions and from contexts' archived summaries. */
  references: { decisions: number; contexts: number };
  /**
   * The sprint closes whose state the prune keeps. `recorded`: a `sprint_complete` event, or the
   * close's own milestone row. `approximate`: only the sprint's end_date (a planned or date-only
   * end_date reads as the start of that day). `unanchored`: a Completed sprint with neither, whose
   * close state is kept only when another rule keeps it.
   */
  sprintCloses: { recorded: number; approximate: number; unanchored: number };
  rules: {
    keepLast: number;
    keepSince: string | null;
    keepSources: string[];
    keepIds: number[];
    recoveryCopyDays: number;
  };
}

type ColumnPresence =
  | { state: 'present' }
  | { state: 'absent' }
  | { state: 'unreadable'; message: string };

/**
 * Whether `table` has `column`, telling a failed PRAGMA apart from a missing column. A missing
 * table or column is structural (nothing can be stored there); a failed read could hide anything.
 */
function columnPresence(
  client: RbookDatabaseClient,
  table: string,
  column: string
): ColumnPresence {
  const res = client.getMany<{ name: string }>(`PRAGMA table_info('${table}')`, []);
  if (!res.success) {
    return { state: 'unreadable', message: res.error?.message ?? 'PRAGMA table_info failed' };
  }
  return (res.data ?? []).some((c) => c.name === column)
    ? { state: 'present' }
    : { state: 'absent' };
}

/** A snapshot id as a reference may store it: an integer, or a string of digits. */
function snapshotIdFrom(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const id = Number(value.trim());
    return id > 0 ? id : null;
  }
  return null;
}

/** Every context_snapshots row, projected for the selection. Never alters the store. */
export function readSnapshotRows(
  client: RbookDatabaseClient
): { ok: true; rows: SnapshotRow[] } | { ok: false; message: string } {
  const pruned = columnPresence(client, 'context_snapshots', 'content_pruned_at');
  if (pruned.state === 'unreadable') {
    return { ok: false, message: `context_snapshots columns (${pruned.message})` };
  }
  const prunedExpr = pruned.state === 'present' ? 'content_pruned_at' : 'NULL AS content_pruned_at';
  const read = client.getMany<{
    id: number;
    context_id: string;
    source: string | null;
    created_at: string;
    content_bytes: number | null;
    content_pruned_at: string | null;
  }>(
    `SELECT id, context_id, source, created_at, LENGTH(CAST(content AS BLOB)) AS content_bytes,
            ${prunedExpr}
       FROM context_snapshots`,
    []
  );
  if (!read.success) {
    return { ok: false, message: read.error?.message ?? 'Failed to read context_snapshots' };
  }
  return {
    ok: true,
    rows: (read.data ?? []).map((r) => ({
      id: r.id,
      contextId: r.context_id,
      source: r.source,
      createdAt: r.created_at,
      contentLength: r.content_bytes ?? 0,
      contentPrunedAt: r.content_pruned_at,
    })),
  };
}

/**
 * Every snapshot id a decision or a context still points at. `unreadable` names each source that
 * could not be read; while it is non-empty the references are incomplete and nothing may be applied.
 */
export function readSnapshotReferences(client: RbookDatabaseClient): {
  references: SnapshotReferences;
  unreadable: string[];
} {
  const unreadable: string[] = [];
  const decisions = new Set<number>();
  const fkColumn = columnPresence(client, 'strategic_decisions', 'snapshot_id');
  if (fkColumn.state === 'unreadable') {
    unreadable.push(`strategic_decisions columns (${fkColumn.message})`);
  } else if (fkColumn.state === 'present') {
    const fk = client.getMany<{ snapshot_id: unknown }>(
      'SELECT DISTINCT snapshot_id FROM strategic_decisions WHERE snapshot_id IS NOT NULL',
      []
    );
    if (fk.success) {
      for (const row of fk.data ?? []) {
        const id = snapshotIdFrom(row.snapshot_id);
        if (id !== null) decisions.add(id);
      }
    } else {
      unreadable.push(`strategic_decisions.snapshot_id (${fk.error?.message ?? 'read failed'})`);
    }
  }

  const contexts = new Set<number>();
  // A store with no contexts table can hold no context reference (structural absence, like the
  // decisions column above); only a real read failure counts as unreadable.
  const contentColumn = columnPresence(client, 'contexts', 'content');
  if (contentColumn.state === 'unreadable') {
    unreadable.push(`contexts columns (${contentColumn.message})`);
  } else if (contentColumn.state === 'present') {
    const contextRows = client.getMany<{ id: string; content: string | null }>(
      'SELECT id, content FROM contexts',
      []
    );
    if (!contextRows.success) {
      unreadable.push(`contexts (${contextRows.error?.message ?? 'read failed'})`);
    } else {
      for (const row of contextRows.data ?? []) {
        if (!row.content) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.content);
        } catch {
          unreadable.push(`contexts.${row.id} (its content is not valid JSON)`);
          continue;
        }
        const summaries =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)['archived_sprint_summaries']
            : undefined;
        if (!Array.isArray(summaries)) continue;
        for (const entry of summaries) {
          const id =
            entry && typeof entry === 'object'
              ? snapshotIdFrom((entry as Record<string, unknown>)['snapshot_id'])
              : null;
          if (id !== null) contexts.add(id);
        }
      }
    }
  }
  return { references: { decisions, contexts }, unreadable };
}

export interface SprintClose {
  sprintId: string;
  closedAtMs: number;
  /** True when only the sprint's end_date says when it closed. */
  approximate: boolean;
}

/**
 * When each sprint closed. Each `sprint_complete` event in session_events is one close. A
 * Completed sprint with no such event anchors on its own milestone row (`sprint_complete:<id>` in
 * either context, the earliest), else on its end_date when that parses: approximate, since a
 * planned or date-only end_date reads as the start of that day. `unanchored` counts Completed
 * sprints with none of these.
 */
export function readSprintCloses(
  client: RbookDatabaseClient,
  rows: readonly SnapshotRow[] = []
): {
  closes: SprintClose[];
  unanchored: number;
  unreadable: string[];
} {
  const closes: SprintClose[] = [];
  const unreadable: string[] = [];
  const recorded = new Set<string>();
  let unanchored = 0;
  const milestoneMs = new Map<string, number>();
  for (const row of rows) {
    if (!row.source?.startsWith('sprint_complete:')) continue;
    const sprintId = row.source.slice('sprint_complete:'.length);
    const at = snapshotTimeMs(row);
    if (Number.isFinite(at) && at < (milestoneMs.get(sprintId) ?? Infinity)) {
      milestoneMs.set(sprintId, at);
    }
  }
  const parse = (value: string | null): number => storedTimeMs(value);

  const events = columnPresence(client, 'session_events', 'action');
  if (events.state === 'unreadable') {
    unreadable.push(`session_events columns (${events.message})`);
  } else if (events.state === 'present') {
    const read = client.getMany<{ mission: string | null; ts: string | null }>(
      `SELECT mission, ts FROM session_events
        WHERE action = 'sprint_complete' AND mission IS NOT NULL`,
      []
    );
    if (!read.success) {
      unreadable.push(`session_events (${read.error?.message ?? 'read failed'})`);
    } else {
      for (const row of read.data ?? []) {
        const closedAtMs = parse(row.ts);
        if (!row.mission || Number.isNaN(closedAtMs)) continue;
        closes.push({ sprintId: row.mission, closedAtMs, approximate: false });
        recorded.add(row.mission);
      }
    }
  }

  const sprints = columnPresence(client, 'sprints', 'end_date');
  if (sprints.state === 'unreadable') {
    unreadable.push(`sprints columns (${sprints.message})`);
  } else if (sprints.state === 'present') {
    const read = client.getMany<{ id: string; end_date: string | null }>(
      `SELECT id, end_date FROM sprints WHERE status = 'Completed'`,
      []
    );
    if (!read.success) {
      unreadable.push(`sprints (${read.error?.message ?? 'read failed'})`);
    } else {
      for (const row of read.data ?? []) {
        if (recorded.has(row.id)) continue;
        const milestoneAt = milestoneMs.get(row.id);
        if (milestoneAt !== undefined) {
          closes.push({ sprintId: row.id, closedAtMs: milestoneAt, approximate: false });
          continue;
        }
        const closedAtMs = parse(row.end_date);
        if (Number.isNaN(closedAtMs)) unanchored += 1;
        else closes.push({ sprintId: row.id, closedAtMs, approximate: true });
      }
    }
  }
  return { closes, unanchored, unreadable };
}

/** Everything the selection reads, from one moment of the store. */
export interface PruneInputs {
  rows: SnapshotRow[];
  references: SnapshotReferences;
  sprintCloses: SprintClose[];
  unanchoredSprints: number;
  /** Each source that could not be read; while non-empty nothing may be applied. */
  unreadable: string[];
}

export function readPruneInputs(
  client: RbookDatabaseClient
): { ok: true; inputs: PruneInputs } | { ok: false; message: string } {
  const read = readSnapshotRows(client);
  if (!read.ok) return read;
  const { references, unreadable } = readSnapshotReferences(client);
  const closes = readSprintCloses(client, read.rows);
  return {
    ok: true,
    inputs: {
      rows: read.rows,
      references,
      sprintCloses: closes.closes,
      unanchoredSprints: closes.unanchored,
      unreadable: [...unreadable, ...closes.unreadable],
    },
  };
}

/**
 * Empty one snapshot's content: stamp `content_pruned_at` and prefix the hash so no dedup lookup
 * can match the row. Idempotent: a row already emptied is left as it is (`changes` is 0).
 */
export function tombstoneSnapshot(
  client: RbookDatabaseClient,
  id: number,
  prunedAt: string
): ReturnType<RbookDatabaseClient['execute']> {
  return client.execute(
    `UPDATE context_snapshots
        SET content = '',
            content_pruned_at = ?,
            content_hash = CASE WHEN substr(content_hash, 1, ${PRUNED_HASH_PREFIX.length}) = ?
                                THEN content_hash ELSE ? || content_hash END
      WHERE id = ? AND content_pruned_at IS NULL`,
    [prunedAt, PRUNED_HASH_PREFIX, PRUNED_HASH_PREFIX, id]
  );
}

function invalid(field: string, message: string): RbookToolResult<RbookDbPruneSnapshotsResult> {
  return createError({ code: RBOOK_ERROR_CODES.INVALID_PARAMETER, message, field });
}

export async function rbookDbPruneSnapshots(
  params: RbookDbPruneSnapshotsParams
): Promise<RbookToolResult<RbookDbPruneSnapshotsResult>> {
  const keepLast = params.keepLast ?? DEFAULT_SNAPSHOT_PRUNE_KEEP;
  if (!Number.isInteger(keepLast) || keepLast < 0) {
    return invalid('keepLast', 'keepLast must be a whole number of snapshots, 0 or more.');
  }
  let keepSinceMs: number | null = null;
  if (params.keepSince !== undefined) {
    keepSinceMs = storedTimeMs(params.keepSince);
    if (Number.isNaN(keepSinceMs)) {
      return invalid('keepSince', `keepSince "${params.keepSince}" is not a date.`);
    }
  }
  const keepIds = params.keepIds ?? [];
  if (keepIds.some((id) => !Number.isInteger(id) || id < 1)) {
    return invalid('keepIds', 'keepIds must be snapshot ids (whole numbers, 1 or more).');
  }
  const keepSources = params.keepSources ?? [];
  const apply = params.confirm === true;
  const select = (inputs: PruneInputs): PruneSelection => {
    const config: PruneConfig = {
      keepPerContext: keepLast,
      days: 0,
      nowMs: Date.now(),
      keepIds: new Set(keepIds),
      keepSinceMs,
      keepSources,
      recoveryCopyDays: PRE_MUTATION_KEEP_DAYS,
      sprintCloses: inputs.sprintCloses,
    };
    return selectSnapshotsToPrune(inputs.rows, inputs.references, config);
  };
  const unchanged = 'No snapshot content was changed.';

  const warnings: string[] = [];
  const result = await withClientAsync(
    async (client) => {
      const first = readPruneInputs(client);
      if (!first.ok) {
        return createError<RbookDbPruneSnapshotsResult>({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: `Could not read context_snapshots: ${first.message}`,
        });
      }
      let inputs = first.inputs;
      let selection = select(inputs);

      if (inputs.unreadable.length > 0) {
        const named = inputs.unreadable.join('; ');
        if (apply) {
          return createError<RbookDbPruneSnapshotsResult>({
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message:
              `Not applied: ${named} could not be read, so a snapshot that is referenced or ` +
              `that a sprint closed on could be emptied. ${unchanged}`,
            suggestion: 'Repair the named source, then run the dry run again.',
          });
        }
        warnings.push(
          `${named} could not be read; this dry run may count a snapshot that is referenced or ` +
            'that a sprint closed on as prunable, and confirm=true is refused until it is fixed.'
        );
      }

      let dbSnapshotId: string | null = null;
      let tombstoned = 0;
      let bytesReclaimed = 0;
      /** Rows and bytes this call emptied, per context. */
      const emptied = new Map<string, { rows: number; bytes: number }>();
      if (apply && selection.prunableIds.length > 0) {
        // The undo handle, taken before anything changes. No backup, no prune.
        const backup = await rbookDbSnapshot({ projectRoot: params.projectRoot });
        if (!backup.success || !backup.data?.createdSnapshot) {
          return createError<RbookDbPruneSnapshotsResult>({
            code: RBOOK_ERROR_CODES.SNAPSHOT_CREATION_FAILED,
            message: `Not applied: the database snapshot failed (${
              backup.error?.message ?? 'no snapshot was created'
            }). ${unchanged}`,
            suggestion: 'Check disk space and permissions, then retry.',
          });
        }
        dbSnapshotId = backup.data.createdSnapshot.id;
        // Only rows the backup holds may be emptied; a row written after it has no undo.
        const backedUp = new Set(inputs.rows.map((r) => r.id));

        warnings.push(...(ensureContentPrunedColumn(client).warnings ?? []));
        const begin = client.execute('BEGIN IMMEDIATE', []);
        if (!checkWrite(begin, warnings, 'prune_snapshots begin')) {
          return createError<RbookDbPruneSnapshotsResult>({
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Not applied: could not begin the prune transaction. ${unchanged}`,
          });
        }
        const rollback = (): void => {
          client.execute('ROLLBACK', []);
        };

        // The first read ran before the backup; another writer may have changed the store since.
        // Read and select again under the write lock, and apply that selection.
        const locked = readPruneInputs(client);
        if (!locked.ok || locked.inputs.unreadable.length > 0) {
          rollback();
          const why = locked.ok ? locked.inputs.unreadable.join('; ') : locked.message;
          return createError<RbookDbPruneSnapshotsResult>({
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Not applied: re-reading the store inside the prune transaction failed (${why}). ${unchanged}`,
          });
        }
        inputs = locked.inputs;
        selection = select(inputs);
        const rowById = new Map(inputs.rows.map((r) => [r.id, r]));
        const prunedAt = new Date().toISOString();
        for (const id of selection.prunableIds) {
          if (!backedUp.has(id)) continue;
          const update = tombstoneSnapshot(client, id, prunedAt);
          if (!checkWrite(update, warnings, `context_snapshots.tombstone(${id})`)) {
            rollback();
            return createError<RbookDbPruneSnapshotsResult>({
              code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
              message:
                `Not applied: emptying snapshot #${id} failed, and the prune was rolled back. ` +
                `${unchanged} Database snapshot ${dbSnapshotId} was taken first.`,
            });
          }
          const row = rowById.get(id);
          if ((update.data?.changes ?? 0) > 0 && row) {
            tombstoned += 1;
            bytesReclaimed += row.contentLength;
            const counted = emptied.get(row.contextId) ?? { rows: 0, bytes: 0 };
            emptied.set(row.contextId, {
              rows: counted.rows + 1,
              bytes: counted.bytes + row.contentLength,
            });
          }
        }
        const commit = client.execute('COMMIT', []);
        if (!checkWrite(commit, warnings, 'prune_snapshots commit')) {
          rollback();
          return createError<RbookDbPruneSnapshotsResult>({
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `Not applied: the prune could not commit and was rolled back. ${unchanged}`,
          });
        }
      }

      const contentBefore = inputs.rows.reduce((sum, r) => sum + r.contentLength, 0);
      return createSuccess<RbookDbPruneSnapshotsResult>(
        {
          applied: apply,
          dbSnapshotId,
          rows: inputs.rows.length,
          contentBytes: contentBefore - bytesReclaimed,
          preserved: selection.preserveIds.length,
          prunable: selection.prunableIds.length,
          bytesReclaimable: selection.bytesReclaimable,
          tombstoned,
          bytesReclaimed,
          perContext: selection.perContext.map((c) => ({
            contextId: c.contextId,
            rows: c.total,
            bytes: c.bytes,
            preserved: c.preserved,
            prunable: apply ? (emptied.get(c.contextId)?.rows ?? 0) : c.prunable,
            prunableBytes: apply ? (emptied.get(c.contextId)?.bytes ?? 0) : c.prunableBytes,
          })),
          preserveReasons: selection.preserveReasons,
          references: {
            decisions: inputs.references.decisions.size,
            contexts: inputs.references.contexts.size,
          },
          sprintCloses: {
            recorded: inputs.sprintCloses.filter((c) => !c.approximate).length,
            approximate: inputs.sprintCloses.filter((c) => c.approximate).length,
            unanchored: inputs.unanchoredSprints,
          },
          rules: {
            keepLast,
            keepSince: keepSinceMs === null ? null : new Date(keepSinceMs).toISOString(),
            keepSources,
            keepIds,
            recoveryCopyDays: PRE_MUTATION_KEEP_DAYS,
          },
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatPruneSnapshotsForLLM(
  result: RbookToolResult<RbookDbPruneSnapshotsResult>
): string {
  if (!result.success || !result.data) {
    const lines = [
      '❌ Snapshot prune failed',
      '',
      `Error: ${result.error?.message ?? 'Unknown error'}`,
    ];
    if (result.error?.suggestion) lines.push('', `Suggestion: ${result.error.suggestion}`);
    appendWarnings(lines, result);
    return lines.join('\n');
  }
  const d = result.data;
  const lines = [
    d.applied
      ? d.tombstoned > 0
        ? `**Snapshot prune applied**: ${d.tombstoned} snapshot(s) emptied, ${formatBytes(d.bytesReclaimed)} reclaimed`
        : '**Snapshot prune applied**: nothing was prunable, so nothing was changed'
      : `**Snapshot prune — dry run**: ${d.prunable} of ${d.rows} snapshot(s) prunable, ${formatBytes(d.bytesReclaimable)} reclaimable`,
    `Content now: ${formatBytes(d.contentBytes)} in ${d.rows} snapshot(s); ${d.preserved} kept.`,
  ];
  if (d.dbSnapshotId) lines.push(`Database snapshot taken first: ${d.dbSnapshotId}`);
  lines.push('', '**Per context**:');
  for (const c of d.perContext) {
    lines.push(
      `  - ${c.contextId}: ${c.rows} rows, ${formatBytes(c.bytes)} before; ${c.preserved} kept, ` +
        `${c.prunable} ${d.applied ? 'emptied' : 'prunable'} (${formatBytes(c.prunableBytes)})`
    );
  }
  const r = d.preserveReasons;
  lines.push(
    '',
    `**Kept because**: newest ${r.newestPerContext}, decision reference ${r.fkReferenced}, ` +
      `context reference ${r.contextReferenced}, sprint milestone ${r.sprintComplete}, ` +
      `not an automatic copy ${r.notAutomatic}, recovery copy under ${d.rules.recoveryCopyDays} days ` +
      `${r.recentRecoveryCopy}, state a sprint closed on ${r.sprintCloseState}, ` +
      `last ${d.rules.keepLast} ${r.lastN}, keepIds ${r.keepIds}, keepSince ${r.keepSince}, ` +
      `keepSources ${r.keepSources}`
  );
  const closes = d.sprintCloses;
  lines.push(
    `Sprint closes: ${closes.recorded} recorded` +
      (closes.approximate > 0
        ? `, ${closes.approximate} approximate (only an end_date says when the sprint closed)`
        : '') +
      (closes.unanchored > 0
        ? `; ${closes.unanchored} completed sprint(s) have no close time on record, so the ` +
          'state they closed on is kept only when another rule keeps it.'
        : '.')
  );
  lines.push(
    '',
    d.applied
      ? 'Rows, ids, references and sync events are unchanged; only the content was emptied. ' +
          'SQLite reuses the freed pages; the database file itself shrinks only when it is ' +
          'vacuumed (with the server stopped: sqlite3 rbook/db/rbook.sqlite "VACUUM").'
      : 'Nothing was changed. Run again with confirm=true to apply; a database snapshot is taken first.'
  );
  appendWarnings(lines, result);
  return lines.join('\n');
}
