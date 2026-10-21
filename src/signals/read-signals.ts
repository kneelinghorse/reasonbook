// SPDX-License-Identifier: Apache-2.0
// ABOUTME: readSignals: one store file in, one signals report out, read-only and deterministic for a file, a now and a
// ABOUTME: runtime; computeSignals runs the same rules on a handle the caller holds, as the client's one fan-out does.

import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';

import { getServerVersion } from '../server-version';
import { storeProjectId } from '../tools/rbook/store-key';
import { storedTimeMs } from '../tools/rbook/stored-time';
import { DRAFT_EXPIRY_DAYS, DRAFT_EXPIRY_STARTS } from '../tools/rbook/proposals';
import { LEASE_LAPSE_AT, LEASE_MIN_AGE_DAYS, LEASE_WARN_AT } from '../tools/rbook/next-step-lease';
import { FEEDBACK_KINDS_RULE } from './feedback-kinds';
import {
  SIGNAL_KINDS,
  SIGNAL_MAX_IDS,
  SIGNALS_DEFAULT_WINDOW_DAYS,
  SIGNALS_LIBRARY_NAME,
  SIGNALS_SCHEMA,
  type ReadSignalsOptions,
  type SignalEntry,
  type SignalKind,
  type SignalsReport,
} from './report';
import {
  draftsPending,
  missionsBlocked,
  nextStepsLapsing,
  reviewsDue,
  SIGNALS_REVIEW_THRESHOLD,
  SIGNALS_REVIEW_WINDOW_MS,
  supersededCited,
  unavailable,
  type RecordsContext,
} from './rules-records';
import {
  CONSTRAINTS_EXPIRING_DAYS,
  constraintsExpiring,
  feedbackOpen,
  QUIET_SILENT_DAYS,
  quietDays,
  sharedConflicts,
  windowCounts,
  windowFeedbackKinds,
} from './rules-activity';
import { columnsOf, DAY_MS } from './store-read';

const DRAFTS_RULE = `proposals with outcome 'pending' and not revised after an approval (replaced_by unset), drafted at or before now and no more than ${DRAFT_EXPIRY_DAYS} days before it`;
const DRAFTS_TAIL =
  "an unreadable draft time counts apart as undated; ids oldest first, and oldestAt is the oldest counted draft's time";

/** Each signal's rule, published in every report beside its count (decisions #1038, #1059). */
export const SIGNAL_RULES: Readonly<Record<SignalKind | 'window' | 'feedbackKinds', string>> =
  Object.freeze({
    drafts_pending: `${DRAFTS_RULE}, with fewer than ${DRAFT_EXPIRY_STARTS} session starts after the draft and at or before now in this machine's draft runtime; a runtime that is not found or cannot be read is named in the reason, and its drafts expire by age only; ${DRAFTS_TAIL}`,
    next_steps_lapsing: `pending or carried next steps whose lease anchor (the last carry, else the creation) is at or before now and has survived ${LEASE_WARN_AT} or more closes: sprints with status exactly 'Completed' whose recorded end_date is at or before now and after the anchor; lapseDue counts those at ${LEASE_LAPSE_AT} or more closes and ${LEASE_MIN_AGE_DAYS} days past the anchor, which the next close drops unless they are carried; an unreadable anchor counts apart as undated; ids most closes first, and oldestAt is the oldest counted anchor`,
    reviews_due: `active decisions and active learnings that are not evergreen, made at or before now, whose review age is ${SIGNALS_REVIEW_THRESHOLD} or more closes (sprints Completed, without regard to case, closed at or before now and after the close of the row's own sprint, else after its creation), not reviewed in the ${SIGNALS_REVIEW_WINDOW_MS / DAY_MS} days before now, and for decisions without evidence and not a replacement in a supersession; the threshold is pinned and RBOOK_STALENESS_THRESHOLD_SPRINTS is not read; becameDue counts the rows due at now that were not due at the window's start; an unreadable anchor counts apart as undated; ids oldest anchor first`,
    superseded_cited:
      "decisions and learnings with status 'active', made at or before now, that cite a decision with status 'superseded', by the project's own citation reader (typed citations only where no persisted citation graph exists), leaving out a decision's citations of a decision it replaced, directly or along the chain; statuses are read as stored, not as of now",
    missions_blocked:
      "missions whose status is 'Blocked', longest blocked first by domain_fields.blockedSince, else the newest session_events block row; sinceUnknown counts those with neither; oldestAt is the longest block's start",
    feedback_open: `agent_feedback rows with status 'open' written at or before now; count is the friction rows, by kind, and unclassified the rest (${FEEDBACK_KINDS_RULE}); an unreadable time counts apart as undated; ids oldest first`,
    quiet_days: `whole days from the newest occurred_at at or before now, across missions, sprints, sessions, learnings, decisions and next steps, to now; the review calls a project silent after more than ${QUIET_SILENT_DAYS} days`,
    constraints_expiring: `active constraints whose expires_at falls after now and within ${CONSTRAINTS_EXPIRING_DAYS} days of it; an unreadable expires_at counts apart as undated`,
    shared_conflicts:
      "on a shared copy, the fields copies set apart that no one has settled (record_conflicts), oldest first, and oldestAt is the oldest one's detection; removed says a peer told this copy its member was removed (record_peers.removed_at), and is false where no peer has told it, including a copy that keeps no peer record, such as the referee's snapshot, where it says nothing",
    window:
      'decisions and learnings created, missions completed and sprints closed (Completed, by end_date) after now minus the window and at or before now; null where the table or its time column is absent',
    feedbackKinds: `agent_feedback rows written after now minus the window and at or before now, by kind (${FEEDBACK_KINDS_RULE}); null when unavailable`,
  });

/**
 * The rules of a report read without this machine's draft runtime, as the dashboard reads an
 * upload: drafts expire by age only, and the rule says so.
 */
export const SIGNAL_RULES_AGE_ONLY: Readonly<
  Record<SignalKind | 'window' | 'feedbackKinds', string>
> = Object.freeze({
  ...SIGNAL_RULES,
  drafts_pending: `${DRAFTS_RULE}, by age only: no draft runtime was given, so session starts were not applied; ${DRAFTS_TAIL}`,
});

function rulesOf(options: ReadSignalsOptions): SignalsReport['rules'] {
  return options.draftRuntimeDir ? SIGNAL_RULES : SIGNAL_RULES_AGE_ONLY;
}

const SIGNAL_RULE_FUNCTIONS: Readonly<Record<SignalKind, (ctx: RecordsContext) => SignalEntry>> = {
  drafts_pending: draftsPending,
  next_steps_lapsing: nextStepsLapsing,
  reviews_due: reviewsDue,
  superseded_cited: supersededCited,
  missions_blocked: missionsBlocked,
  feedback_open: feedbackOpen,
  quiet_days: quietDays,
  constraints_expiring: constraintsExpiring,
  shared_conflicts: sharedConflicts,
};

export interface ComputeSignalsOptions extends ReadSignalsOptions {
  /** The store file the handle reads, which keys this machine's draft runtime. */
  readonly storePath: string;
  /** Only these signals, in report order; the rest are omitted. Default: all nine. */
  readonly only?: readonly SignalKind[];
}

function nowMsOf(now: ReadSignalsOptions['now']): number {
  const value =
    now instanceof Date ? now.getTime() : typeof now === 'number' ? now : storedTimeMs(now);
  if (!Number.isFinite(value)) throw new RangeError('readSignals: now must be a valid time');
  return value;
}

function settings(options: ReadSignalsOptions): { nowMs: number; maxIds: number; days: number } {
  const maxIds = Math.min(
    SIGNAL_MAX_IDS,
    Math.max(0, Math.floor(options.maxIds ?? SIGNAL_MAX_IDS))
  );
  const days = options.windowDays ?? SIGNALS_DEFAULT_WINDOW_DAYS;
  if (!Number.isFinite(days) || days <= 0)
    throw new RangeError('readSignals: windowDays must be a positive number of days');
  return { nowMs: nowMsOf(options.now), maxIds, days };
}

function metadataValue(db: Database.Database): (key: string) => unknown {
  if (!columnsOf(db, 'metadata').has('value')) return () => undefined;
  const query = db.prepare('SELECT value FROM metadata WHERE key = ?');
  return (key) => (query.get(key) as { value: unknown } | undefined)?.value;
}

function contextOf(
  db: Database.Database,
  options: ComputeSignalsOptions,
  value: (key: string) => unknown,
  withWindow = false
): RecordsContext {
  const { nowMs, maxIds, days } = settings(options);
  return {
    db,
    nowMs,
    ...(withWindow ? { windowStartMs: nowMs - days * DAY_MS } : {}),
    maxIds,
    storePath: options.storePath,
    projectId: storeProjectId(value),
    draftRuntimeDir: options.draftRuntimeDir,
  };
}

function failed(kind: SignalKind, reason: string): SignalEntry {
  return { ...unavailable(kind, reason), failed: true };
}

function entriesOf(ctx: RecordsContext, only: ComputeSignalsOptions['only']): SignalEntry[] {
  const kinds = SIGNAL_KINDS.filter((kind) => !only || only.includes(kind));
  return kinds.map((kind) => {
    try {
      return SIGNAL_RULE_FUNCTIONS[kind](ctx);
    } catch (error) {
      // One signal that cannot be read never costs the others, and never reads as a zero.
      return failed(kind, `could not be read: ${(error as Error).message}`);
    }
  });
}

/**
 * Every rule reads one snapshot of the store: a commit lands between none of them. A rule that
 * failed on a damaged page can make SQLite refuse the commit; the reads already made stand, so the
 * transaction is rolled back instead, and the other signals keep what they read.
 */
function inOneRead<T>(db: Database.Database, read: () => T): T {
  if (db.inTransaction) return read();
  db.exec('BEGIN');
  try {
    return read();
  } finally {
    if (db.inTransaction) {
      try {
        db.exec('COMMIT');
      } catch {
        if (db.inTransaction) db.exec('ROLLBACK');
      }
    }
  }
}

/**
 * The signal entries alone, by the same rules as a report, for a caller that needs no window:
 * the review reads four of them on every store its fan-out opens.
 */
export function computeSignalEntries(
  db: Database.Database,
  options: ComputeSignalsOptions
): SignalEntry[] {
  return inOneRead(db, () => entriesOf(contextOf(db, options, metadataValue(db)), options.only));
}

const NO_WINDOW = Object.freeze({
  decisions: null,
  learnings: null,
  missionsCompleted: null,
  sprintsClosed: null,
});

/** The report for a store the caller already holds open (read-only); nothing here writes. */
export function computeSignals(
  db: Database.Database,
  options: ComputeSignalsOptions
): SignalsReport {
  const { days } = settings(options);
  return inOneRead(db, () => {
    const value = metadataValue(db);
    const name = value('project_name');
    const ctx = contextOf(db, options, value, true);
    const signals = entriesOf(ctx, options.only);
    let window: SignalsReport['window'];
    let feedbackKinds: SignalsReport['feedbackKinds'];
    try {
      window = { days, counts: windowCounts(ctx, days) };
    } catch (error) {
      window = {
        days,
        counts: NO_WINDOW,
        reason: `could not be read: ${(error as Error).message}`,
      };
    }
    try {
      feedbackKinds = windowFeedbackKinds(ctx, days);
    } catch (error) {
      feedbackKinds = {
        available: false,
        counts: null,
        unclassified: null,
        reason: `could not be read: ${(error as Error).message}`,
      };
    }
    return {
      schema: SIGNALS_SCHEMA,
      library: { name: SIGNALS_LIBRARY_NAME, version: getServerVersion() },
      computedAt: new Date(ctx.nowMs).toISOString(),
      project: { id: ctx.projectId, name: typeof name === 'string' && name ? name : null },
      rules: rulesOf(options),
      signals,
      window,
      feedbackKinds,
    };
  });
}

/**
 * The report for a store that could not be opened or read: every signal unavailable, with the
 * reason, so a fan-out or an ingest carries on and nothing reads as zero.
 */
export function unreadableReport(options: ComputeSignalsOptions, reason: string): SignalsReport {
  const { nowMs, days } = settings(options);
  const kinds = SIGNAL_KINDS.filter((kind) => !options.only || options.only.includes(kind));
  return {
    schema: SIGNALS_SCHEMA,
    library: { name: SIGNALS_LIBRARY_NAME, version: getServerVersion() },
    computedAt: new Date(nowMs).toISOString(),
    project: { id: storeProjectId(() => undefined), name: null },
    rules: rulesOf(options),
    signals: kinds.map((kind) => failed(kind, reason)),
    window: { days, counts: NO_WINDOW, reason },
    feedbackKinds: { available: false, counts: null, unclassified: null, reason },
    unreadable: reason,
  };
}

/**
 * One store file in, one signals report out. The file is opened read-only and must exist; it is
 * never migrated or written (in WAL mode a read may create the -shm sidecar). The same file, the
 * same `now` and the same draft runtime give the same report, byte for byte.
 */
export function readSignals(
  storePath: string,
  options: ReadSignalsOptions & { readonly only?: readonly SignalKind[] }
): SignalsReport {
  const computeOptions: ComputeSignalsOptions = { ...options, storePath };
  settings(options); // An invalid now or window is the caller's error, not the store's.
  let db: Database.Database | undefined;
  try {
    db = new BetterSqlite3(storePath, { readonly: true, fileMustExist: true, timeout: 250 });
    return computeSignals(db, computeOptions);
  } catch (error) {
    const message = (error as Error).message;
    return unreadableReport(
      computeOptions,
      /busy|locked/i.test(message) ? `store busy: ${message}` : `store unreadable: ${message}`
    );
  } finally {
    db?.close();
  }
}
