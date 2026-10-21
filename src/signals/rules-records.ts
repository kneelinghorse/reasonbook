// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Five signals over a store's records, each the project's own rule applied at a given instant: drafts awaiting a
// ABOUTME: decision, next steps near their lease, records due for review, rows citing a replaced decision, blocked missions.

import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import * as fs from 'fs';

import { DRAFT_EXPIRY_DAYS, DRAFT_EXPIRY_STARTS } from '../tools/rbook/proposals';
import { LEASE_WARN_AT, leaseState } from '../tools/rbook/next-step-lease';
import { readRecordLinks } from '../tools/rbook/record-link-reader';
import { draftRuntimeFile, draftStoreKey, plainSqliteFiles } from '../tools/rbook/store-key';
import type { SignalEntry, SignalKind } from './report';
import { closesAfter, closesAtOrBefore, columnsOf, DAY_MS, linkReader, timeOf } from './store-read';

/** The review age, in closed sprints, pinned here whatever RBOOK_STALENESS_THRESHOLD_SPRINTS says. */
export const SIGNALS_REVIEW_THRESHOLD = 20;
/** The review window: a row reviewed within this many sprints of two weeks is not due again. */
export const SIGNALS_REVIEW_WINDOW_MS = SIGNALS_REVIEW_THRESHOLD * 14 * DAY_MS;

export interface RecordsContext {
  readonly db: Database.Database;
  readonly nowMs: number;
  /** The window's start, in a full report: reviews_due then also counts what became due in it. */
  readonly windowStartMs?: number;
  readonly maxIds: number;
  readonly storePath: string;
  readonly projectId: string;
  readonly draftRuntimeDir?: string;
}

export function unavailable(kind: SignalKind, reason: string): SignalEntry {
  return { kind, available: false, count: null, ids: [], reason };
}

/** The earliest readable time of the rows a signal counts, as ISO text; undefined when none. */
export function oldestOf(times: readonly number[]): { oldestAt?: string } {
  const finite = times.filter((at) => Number.isFinite(at) && at < Number.MAX_SAFE_INTEGER);
  return finite.length ? { oldestAt: new Date(Math.min(...finite)).toISOString() } : {};
}

function sameOrder<T extends { at: number; key: string }>(a: T, b: T): number {
  return a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * The session starts at or before now that this machine's draft runtime holds for this store, or
 * why it holds none to read. The file is opened read-only only when it is a plain file with one
 * name, as the server's own open requires (draft-runtime.ts requireSafe), and is closed before
 * this returns: the runtime keeps at most its newest 200 starts (STARTS_KEPT).
 */
function draftStarts(
  ctx: RecordsContext
): { kind: 'none' } | { kind: 'missing'; reason: string } | { kind: 'found'; starts: number[] } {
  if (!ctx.draftRuntimeDir) return { kind: 'none' };
  const file = draftRuntimeFile(
    ctx.draftRuntimeDir,
    draftStoreKey({ projectId: ctx.projectId, dbPath: ctx.storePath })
  );
  try {
    fs.lstatSync(file);
  } catch {
    return { kind: 'missing', reason: `draft runtime not found (${file})` };
  }
  // The plain-file half of the server's own open: the file and each sidecar plain, one name each.
  // The location half (not inside a repository or a project) is the server's alone.
  if (!plainSqliteFiles(file))
    return { kind: 'missing', reason: `draft runtime is not a plain file (${file})` };
  let runtime: Database.Database | undefined;
  try {
    runtime = new BetterSqlite3(file, { readonly: true, fileMustExist: true, timeout: 100 });
    if (!columnsOf(runtime, 'starts').has('at'))
      return { kind: 'missing', reason: `draft runtime has no starts (${file})` };
    const rows = runtime.prepare('SELECT at FROM starts WHERE at <= ?').all(ctx.nowMs) as Array<{
      at: unknown;
    }>;
    return { kind: 'found', starts: rows.map((row) => Number(row.at)).filter(Number.isFinite) };
  } catch (error) {
    return {
      kind: 'missing',
      reason: `draft runtime unreadable (${file}: ${(error as Error).message})`,
    };
  } finally {
    runtime?.close();
  }
}

export function draftsPending(ctx: RecordsContext): SignalEntry {
  const columns = columnsOf(ctx.db, 'proposals');
  if (!columns.size) return unavailable('drafts_pending', 'no proposals table');
  if (!columns.has('outcome') || !columns.has('created_at'))
    return unavailable('drafts_pending', 'proposals has no outcome or created_at column');
  // A draft approved and then revised was answered: it waits only to be recorded (digest-v2-store.ts).
  const answered = columns.has('replaced_by') ? ' AND replaced_by IS NULL' : '';
  const rows = ctx.db
    .prepare(`SELECT id, created_at FROM proposals WHERE outcome = 'pending'${answered}`)
    .all() as Array<{ id: number; created_at: unknown }>;
  // The runtime is opened only when a draft is pending: with none, both rules count zero.
  const starts = rows.length ? draftStarts(ctx) : ({ kind: 'none' } as const);
  let undated = 0;
  const live: Array<{ at: number; key: string; id: number }> = [];
  for (const row of rows) {
    const created = timeOf(row.created_at);
    if (!Number.isFinite(created)) {
      undated += 1;
      continue;
    }
    if (created > ctx.nowMs || ctx.nowMs - created > DRAFT_EXPIRY_DAYS * DAY_MS) continue;
    if (
      starts.kind === 'found' &&
      starts.starts.filter((at) => at > created).length >= DRAFT_EXPIRY_STARTS
    )
      continue;
    live.push({ at: created, key: String(row.id).padStart(12, '0'), id: row.id });
  }
  live.sort(sameOrder);
  return {
    kind: 'drafts_pending',
    available: true,
    count: live.length,
    ids: live.slice(0, ctx.maxIds).map((row) => `P${row.id}`),
    ...oldestOf(live.map((row) => row.at)),
    ...(starts.kind === 'missing' ? { reason: `${starts.reason}; drafts expire by age only` } : {}),
    ...(undated ? { undated } : {}),
  };
}

export function nextStepsLapsing(ctx: RecordsContext): SignalEntry {
  const columns = columnsOf(ctx.db, 'next_steps');
  if (!columns.size) return unavailable('next_steps_lapsing', 'no next_steps table');
  if (!columns.has('status') || !columns.has('created_at'))
    return unavailable('next_steps_lapsing', 'next_steps has no status or created_at column');
  if (!hasCloses(ctx))
    return unavailable('next_steps_lapsing', 'no sprints table with status and end_date columns');
  const closes = closesAtOrBefore(ctx.db, ctx.nowMs, true);
  const resolved = columns.has('resolved_at') ? 'resolved_at' : 'NULL';
  const rows = ctx.db
    .prepare(
      `SELECT id, created_at, ${resolved} AS resolved_at FROM next_steps WHERE status IN ('pending', 'carried')`
    )
    .all() as Array<{ id: number; created_at: unknown; resolved_at: unknown }>;
  let undated = 0;
  let lapseDue = 0;
  const due: Array<{ anchor: number; id: number; closes: number }> = [];
  for (const row of rows) {
    // The lease's anchor: the last carry, else the creation (COALESCE(resolved_at, created_at)).
    const anchor = timeOf(row.resolved_at ?? row.created_at);
    if (!Number.isFinite(anchor)) {
      undated += 1;
      continue;
    }
    if (anchor > ctx.nowMs) continue;
    const survived = closesAfter(closes, anchor);
    if (survived < LEASE_WARN_AT) continue;
    if (leaseState(survived, (ctx.nowMs - anchor) / DAY_MS) === 'lapsing') lapseDue += 1;
    due.push({ anchor, id: row.id, closes: survived });
  }
  // Most closes survived first, then the oldest anchor.
  due.sort((a, b) => b.closes - a.closes || a.anchor - b.anchor || a.id - b.id);
  return {
    kind: 'next_steps_lapsing',
    available: true,
    count: due.length,
    ids: due.slice(0, ctx.maxIds).map((row) => `n:${row.id}`),
    lapseDue,
    ...oldestOf(due.map((row) => row.anchor)),
    ...(undated ? { undated } : {}),
  };
}

function hasCloses(ctx: RecordsContext): boolean {
  const sprints = columnsOf(ctx.db, 'sprints');
  return sprints.has('status') && sprints.has('end_date');
}

function reviewFields(columns: Set<string>, extra: string[]): string {
  return ['id', 'created_at', ...extra]
    .map((name) => (columns.has(name) ? name : `NULL AS ${name}`))
    .join(', ');
}

export function reviewsDue(ctx: RecordsContext): SignalEntry {
  const decisionColumns = columnsOf(ctx.db, 'strategic_decisions');
  const learningColumns = columnsOf(ctx.db, 'learnings');
  const decisionsReadable = decisionColumns.has('status') && decisionColumns.has('created_at');
  const learningsReadable = learningColumns.has('status') && learningColumns.has('created_at');
  if (!decisionsReadable && !learningsReadable)
    return unavailable('reviews_due', 'no decisions or learnings with status and created_at');
  if (!hasCloses(ctx))
    return unavailable('reviews_due', 'no sprints table with status and end_date columns');
  const allCloses = closesAtOrBefore(ctx.db, ctx.nowMs, false);
  // The rows the rule could find due, its exclusions applied once: read once, judged per instant.
  const candidates: Array<{ kind: 'd' | 'l'; row: Record<string, unknown> }> = [];
  if (decisionsReadable) {
    const superseders = new Set(
      decisionColumns.has('superseded_by')
        ? (
            ctx.db
              .prepare(
                'SELECT superseded_by FROM strategic_decisions WHERE superseded_by IS NOT NULL'
              )
              .all() as Array<{ superseded_by: unknown }>
          ).map((row) => String(row.superseded_by))
        : []
    );
    const rows = ctx.db
      .prepare(
        `SELECT ${reviewFields(decisionColumns, ['sprint_id', 'last_reviewed_at', 'evidence'])} FROM strategic_decisions WHERE status = 'active'`
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (superseders.has(String(row.id))) continue;
      if (!(row.evidence == null || row.evidence === '' || row.evidence === '[]')) continue;
      candidates.push({ kind: 'd', row });
    }
  }
  if (learningsReadable) {
    const rows = ctx.db
      .prepare(
        `SELECT ${reviewFields(learningColumns, ['sprint_id', 'last_reviewed_at', 'evergreen'])} FROM learnings WHERE status = 'active'`
      )
      .all() as Array<Record<string, unknown>>;
    for (const row of rows)
      if (!(learningColumns.has('evergreen') && Number(row.evergreen) !== 0))
        candidates.push({ kind: 'l', row });
  }
  const dueAt = (
    atMs: number
  ): { due: Array<{ at: number; key: string; ref: string }>; undated: number } => {
    const closes = allCloses.filter((close) => close.endMs <= atMs);
    const closeOf = new Map(closes.map((close) => [close.id, close.endMs]));
    const cutoff = atMs - SIGNALS_REVIEW_WINDOW_MS;
    let undated = 0;
    const due: Array<{ at: number; key: string; ref: string }> = [];
    for (const { kind, row } of candidates) {
      // A row reviewed in the review window is not due; the rule's exclusions came first, so
      // `undated` counts only rows it applies to.
      if (row.last_reviewed_at != null) {
        const reviewed = timeOf(row.last_reviewed_at);
        if (!(reviewed < cutoff)) continue;
      }
      const created = timeOf(row.created_at);
      const own = row.sprint_id == null ? undefined : closeOf.get(String(row.sprint_id));
      // The review age's anchor: the close of the row's own sprint, else its creation.
      const anchor = own ?? created;
      if (!Number.isFinite(anchor)) {
        undated += 1;
        continue;
      }
      if (Number.isFinite(created) && created > atMs) continue;
      if (closesAfter(closes, anchor) < SIGNALS_REVIEW_THRESHOLD) continue;
      due.push({
        at: anchor,
        key: `${kind}:${String(row.id).padStart(12, '0')}`,
        ref: `${kind}:${row.id}`,
      });
    }
    return { due, undated };
  };
  const { due, undated } = dueAt(ctx.nowMs);
  due.sort(sameOrder);
  let becameDue: number | undefined;
  if (ctx.windowStartMs !== undefined) {
    const before = new Set(dueAt(ctx.windowStartMs).due.map((row) => row.ref));
    becameDue = due.filter((row) => !before.has(row.ref)).length;
  }
  return {
    kind: 'reviews_due',
    available: true,
    count: due.length,
    ids: due.slice(0, ctx.maxIds).map((row) => row.ref),
    ...(becameDue === undefined ? {} : { becameDue }),
    ...(undated ? { undated } : {}),
  };
}

export function supersededCited(ctx: RecordsContext): SignalEntry {
  const decisionColumns = columnsOf(ctx.db, 'strategic_decisions');
  if (!decisionColumns.has('status') || !decisionColumns.has('superseded_by'))
    return unavailable('superseded_cited', 'no decisions with status and superseded_by');
  const decisions = new Map(
    (
      ctx.db
        .prepare('SELECT id, status, superseded_by, created_at FROM strategic_decisions')
        .all() as Array<{
        id: number;
        status: unknown;
        superseded_by: unknown;
        created_at: unknown;
      }>
    ).map((row) => [row.id, row])
  );
  // Statuses match exactly, as the server writes them ('superseded', 'active').
  const superseded = new Set(
    [...decisions.values()].filter((row) => row.status === 'superseded').map((row) => row.id)
  );
  // Only the links to superseded decisions count, so the reader checks only those.
  const read = readRecordLinks(linkReader(ctx.db, ctx.storePath), { toDecisions: superseded });
  if (!read.available)
    return {
      ...unavailable(
        'superseded_cited',
        `the citation graph could not be read: ${read.warnings.join('; ') || read.mode}`
      ),
      failed: true,
    };
  const learningColumns = columnsOf(ctx.db, 'learnings');
  const learnings = new Map(
    learningColumns.has('status')
      ? (
          ctx.db.prepare('SELECT id, status, created_at FROM learnings').all() as Array<{
            id: number;
            status: unknown;
            created_at: unknown;
          }>
        ).map((row) => [row.id, row])
      : []
  );
  /** Does `fromId` stand in the chain of decisions that replaced `toId`? Then it cites its own past. */
  const inChain = (toId: number, fromId: number): boolean => {
    let current: unknown = toId;
    for (let step = 0; step < 64; step += 1) {
      const next = decisions.get(Number(current))?.superseded_by;
      if (next == null) return false;
      if (Number(next) === fromId) return true;
      current = next;
    }
    return false;
  };
  const citing = new Map<string, { kind: number; id: number }>();
  for (const link of read.links) {
    if (link.from_kind !== 'decision' && link.from_kind !== 'learning') continue;
    if (link.to_kind !== 'decision' || decisions.get(link.to_id)?.status !== 'superseded') continue;
    const source =
      link.from_kind === 'decision' ? decisions.get(link.from_id) : learnings.get(link.from_id);
    if (!source || source.status !== 'active') continue;
    const created = timeOf(source.created_at);
    if (Number.isFinite(created) && created > ctx.nowMs) continue;
    if (link.from_kind === 'decision' && inChain(link.to_id, link.from_id)) continue;
    const prefix = link.from_kind === 'decision' ? 'd' : 'l';
    citing.set(`${prefix}:${link.from_id}`, { kind: prefix === 'd' ? 0 : 1, id: link.from_id });
  }
  const ranked = [...citing.entries()].sort(([, a], [, b]) => a.kind - b.kind || a.id - b.id);
  return {
    kind: 'superseded_cited',
    available: true,
    count: ranked.length,
    ids: ranked.slice(0, ctx.maxIds).map(([ref]) => ref),
    ...(read.mode === 'typed-fallback'
      ? { reason: 'no persisted citation graph: typed citations only, bare #N not seen' }
      : {}),
  };
}

export function missionsBlocked(ctx: RecordsContext): SignalEntry {
  const columns = columnsOf(ctx.db, 'missions');
  if (!columns.has('status')) return unavailable('missions_blocked', 'no missions with a status');
  const fields = columns.has('domain_fields') ? 'domain_fields' : 'NULL AS domain_fields';
  // Exactly 'Blocked', as onboard and mission status read it (rbook-agent-onboard.ts).
  const rows = ctx.db
    .prepare(`SELECT id, ${fields} FROM missions WHERE status = 'Blocked'`)
    .all() as Array<{ id: string; domain_fields: unknown }>;
  const events = columnsOf(ctx.db, 'session_events');
  const lastBlock =
    events.has('mission') && events.has('action') && events.has('ts')
      ? ctx.db.prepare(
          "SELECT ts FROM session_events WHERE mission = ? AND action = 'block' ORDER BY id DESC LIMIT 1"
        )
      : null;
  let sinceUnknown = 0;
  const ranked = rows.map((row) => {
    let since = NaN;
    if (typeof row.domain_fields === 'string') {
      try {
        since = timeOf((JSON.parse(row.domain_fields) as { blockedSince?: unknown }).blockedSince);
      } catch {
        // An unreadable domain_fields falls back to the block event.
      }
    }
    if (!Number.isFinite(since) && lastBlock)
      since = timeOf((lastBlock.get(row.id) as { ts?: unknown } | undefined)?.ts);
    if (!Number.isFinite(since)) sinceUnknown += 1;
    // Longest blocked first; a mission blocked since an unknown time last.
    return { at: Number.isFinite(since) ? since : Number.MAX_SAFE_INTEGER, key: String(row.id) };
  });
  ranked.sort(sameOrder);
  return {
    kind: 'missions_blocked',
    available: true,
    count: ranked.length,
    ids: ranked.slice(0, ctx.maxIds).map((row) => row.key),
    ...oldestOf(ranked.map((row) => row.at)),
    ...(sinceUnknown ? { sinceUnknown } : {}),
  };
}
