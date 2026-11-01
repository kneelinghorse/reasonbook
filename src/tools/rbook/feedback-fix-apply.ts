// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m04 — resolving the feedback rows a shipped release fixed, in the store that runs the command only: a dry
// ABOUTME: run by default, an apply in one transaction with a metadata ledger, and a reopen of what a rule resolved.

import type { RbookDatabaseClient } from './client';
import { createError, createSuccess, RBOOK_ERROR_CODES } from './errors';
import type { RbookToolResult } from './types';
import {
  FEEDBACK_FIX_RULES,
  FEEDBACK_FIXES_RULE,
  feedbackFixByRule,
  feedbackFixOf,
  firstSentence,
  parseRevision,
  reopenedMarker,
} from '../../signals/feedback-fixes';
import { ensureAgentFeedbackFixColumns } from './agent-feedback-columns';
import { getServerVersion } from '../../server-version';

/** The metadata key of the ledger every apply and reopen appends to. */
export const FEEDBACK_FIX_LEDGER_KEY = 'feedback_fix_ledger';
/** The ledger keeps its newest entries, each naming at most this many rows, as the staleness ledger does. */
const LEDGER_ENTRIES = 50;
const LEDGER_IDS = 500;

export interface FeedbackFixPlanRow {
  readonly id: number;
  readonly rule: string;
  readonly revision: number;
  readonly fixedIn: string;
  /** The row's first sentence, cut to 160 characters, for the person deciding. */
  readonly firstSentence: string;
}

export interface FeedbackFixPlan {
  /** The closing test the counts below follow (FEEDBACK_FIXES_RULE). */
  readonly rule: string;
  /** Each rule counted alone, so a row two rules match counts under both. */
  readonly perRule: ReadonlyArray<{
    readonly rule: string;
    readonly fixedIn: string;
    readonly fixed: number;
    readonly partly: number;
  }>;
  /** The rows an apply resolves: open and with no note, each by the first rule that fixes it. */
  readonly rows: readonly FeedbackFixPlanRow[];
  /**
   * Rows a rule fixes that an apply leaves for a person: triaged, or carrying a note, which an
   * apply would otherwise overwrite and a reopen could not give back.
   */
  readonly held: readonly FeedbackFixPlanRow[];
}

interface LedgerEntry {
  readonly action: 'apply' | 'reopen';
  readonly at: string;
  readonly by: string;
  readonly rules: readonly string[];
  readonly rows: readonly number[];
  readonly more?: number;
}

/** The note an apply writes; a reopen recognises a row it wrote by it. */
export function fixNote(fixedIn: string, rule: string, revision: number, by: string): string {
  return `Fixed in Reasonbook ${fixedIn} (rule ${rule}@${revision}; applied by ${by})`;
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a note is exactly one an apply wrote for this release and rule, by any version. */
function isFixNote(note: string | null, fixedIn: string, fixRule: string): boolean {
  return new RegExp(
    `^Fixed in Reasonbook ${escaped(fixedIn)} \\(rule ${escaped(fixRule)}; applied by [^()]+\\)$`
  ).test(note ?? '');
}

/** Every store failure here leaves the store as it was, so one remedy fits them all. */
function failure<T>(message: string): RbookToolResult<T> {
  return createError<T>({
    code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
    message,
    suggestion:
      'Nothing was changed; check that the store can be read and written and that no other process holds it, then run it again.',
  });
}

/** What an apply would resolve, read without writing: the dry run, and the apply's own first step. */
export function planFeedbackFixes(client: RbookDatabaseClient): RbookToolResult<FeedbackFixPlan> {
  const columns = client.getMany<{ name: string }>('PRAGMA table_info(agent_feedback)');
  if (!columns.success)
    return failure(
      `Could not read agent_feedback (${columns.error?.message ?? 'the query failed'}).`
    );
  const empty = FEEDBACK_FIX_RULES.map((rule) => ({
    rule: rule.id,
    fixedIn: rule.fixedIn,
    fixed: 0,
    partly: 0,
  }));
  const names = new Set((columns.data ?? []).map((column) => column.name));
  if (!names.size)
    return createSuccess({ rule: FEEDBACK_FIXES_RULE, perRule: empty, rows: [], held: [] });
  const optional = (name: string): string => (names.has(name) ? name : `NULL AS ${name}`);
  const read = client.getMany<{
    id: number;
    body: string | null;
    status: string;
    created_at: string | null;
    resolution_note: string | null;
    fix_rule: string | null;
  }>(
    `SELECT id, body, status, created_at, ${optional('resolution_note')}, ${optional('fix_rule')}
       FROM agent_feedback WHERE status IN ('open', 'triaged') ORDER BY id`
  );
  if (!read.success)
    return failure(
      `Could not read the open feedback (${read.error?.message ?? 'the query failed'}).`
    );
  const rows = (read.data ?? []).map((row) => ({
    id: row.id,
    note: row.resolution_note,
    fix: { body: row.body, status: row.status, createdAt: row.created_at, fixRule: row.fix_rule },
  }));
  const perRule = FEEDBACK_FIX_RULES.map((rule) => {
    let fixed = 0;
    let partly = 0;
    for (const row of rows) {
      const verdict = feedbackFixByRule(rule, row.fix);
      if (verdict?.state === 'fixed') fixed += 1;
      else if (verdict) partly += 1;
    }
    return { rule: rule.id, fixedIn: rule.fixedIn, fixed, partly };
  });
  const resolve: FeedbackFixPlanRow[] = [];
  const held: FeedbackFixPlanRow[] = [];
  for (const row of rows) {
    const verdict = feedbackFixOf(row.fix);
    if (verdict?.state !== 'fixed') continue;
    const planned = {
      id: row.id,
      rule: verdict.rule,
      revision: verdict.revision,
      fixedIn: verdict.fixedIn,
      firstSentence: firstSentence(row.fix.body ?? '').slice(0, 160),
    };
    // A person's triage or note is theirs: an apply leaves the row, so nothing it holds is lost.
    // Blank as the apply's UPDATE reads it: nothing but spaces, tabs and line breaks.
    if (row.fix.status === 'open' && !(row.note ?? '').replace(/[ \t\n\r]/g, ''))
      resolve.push(planned);
    else held.push(planned);
  }
  return createSuccess({ rule: FEEDBACK_FIXES_RULE, perRule, rows: resolve, held });
}

/** The ledger's entries, oldest first; an unreadable ledger reads as none. */
function readLedger(client: RbookDatabaseClient): RbookToolResult<LedgerEntry[]> {
  const current = client.getOne<{ value: string }>('SELECT value FROM metadata WHERE key = ?', [
    FEEDBACK_FIX_LEDGER_KEY,
  ]);
  if (!current.success)
    return failure(
      `Could not read the feedback fix ledger (${current.error?.message ?? 'the query failed'}).`
    );
  try {
    const parsed: unknown = JSON.parse(current.data?.value ?? '[]');
    return createSuccess(Array.isArray(parsed) ? (parsed as LedgerEntry[]) : []);
  } catch {
    // An unreadable ledger starts again; the rows themselves keep fixed_in and fix_rule.
    return createSuccess([]);
  }
}

/** The rule ids a reopen can name here: the shipped rules, and every rule a row was resolved by. */
export function reopenableRules(client: RbookDatabaseClient): RbookToolResult<string[]> {
  const shipped = FEEDBACK_FIX_RULES.map((rule) => rule.id);
  const columns = client.getMany<{ name: string }>('PRAGMA table_info(agent_feedback)');
  if (!columns.success)
    return failure(
      `Could not read agent_feedback (${columns.error?.message ?? 'the query failed'}).`
    );
  if (!(columns.data ?? []).some((column) => column.name === 'fix_rule'))
    return createSuccess(shipped);
  const stored = client.getMany<{ fix_rule: string }>(
    "SELECT DISTINCT fix_rule FROM agent_feedback WHERE fix_rule IS NOT NULL AND fix_rule NOT LIKE 'reopened:%'"
  );
  if (!stored.success)
    return failure(
      `Could not read the rules rows were resolved by (${stored.error?.message ?? 'the query failed'}).`
    );
  // A rule by its id, or by the id@revision a resolved row's fix_rule and note show.
  return createSuccess([
    ...new Set([
      ...shipped,
      ...(stored.data ?? []).flatMap((row) => [row.fix_rule.split('@')[0], row.fix_rule]),
    ]),
  ]);
}

/** Append one entry to the ledger, keeping its newest entries. */
function appendLedger(client: RbookDatabaseClient, entry: LedgerEntry): RbookToolResult<void> {
  const current = readLedger(client);
  if (!current.success) return current as RbookToolResult<never>;
  const entries = current.data!;
  const kept = entry.rows.slice(0, LEDGER_IDS);
  const next = [
    ...entries,
    {
      ...entry,
      rows: kept,
      ...(entry.rows.length > kept.length ? { more: entry.rows.length - kept.length } : {}),
    },
  ].slice(-LEDGER_ENTRIES);
  const written = client.execute(
    'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [FEEDBACK_FIX_LEDGER_KEY, JSON.stringify(next)]
  );
  if (!written.success)
    return failure(
      `Could not write the feedback fix ledger (${written.error?.message ?? 'the write failed'}).`
    );
  return createSuccess(undefined);
}

/** Run `work` in one write transaction, rolling back on any refusal. */
function inTransaction<T>(
  client: RbookDatabaseClient,
  work: () => RbookToolResult<T>
): RbookToolResult<T> {
  const begin = client.execute('BEGIN IMMEDIATE', []);
  if (!begin.success)
    return failure(`Could not start the write (${begin.error?.message ?? 'the store is busy'}).`);
  const result = work();
  const end = client.execute(result.success ? 'COMMIT' : 'ROLLBACK', []);
  if (!end.success) {
    if (!result.success) return result;
    const rollback = client.execute('ROLLBACK', []);
    return failure(
      `Could not commit the write (${end.error?.message ?? 'the commit failed'}); ${rollback.success ? 'it was rolled back' : "its rollback failed too, and the store's journal undoes it"}.`
    );
  }
  return result;
}

/**
 * Resolve what the plan names, in one transaction: each row's status, resolved_at, its note naming
 * the release and the rule, fixed_in and fix_rule, and one ledger entry. A row someone changed
 * between the read and the write is left as it is.
 */
export function applyFeedbackFixes(
  client: RbookDatabaseClient,
  nowIso: string = new Date().toISOString()
): RbookToolResult<FeedbackFixPlan & { readonly resolved: readonly number[] }> {
  // Nothing to resolve, or no table: answer so without altering anything.
  const preview = planFeedbackFixes(client);
  if (!preview.success) return preview as RbookToolResult<never>;
  if (!preview.data!.rows.length) return createSuccess({ ...preview.data!, resolved: [] });
  const columns = ensureAgentFeedbackFixColumns(client);
  if (!columns.present.has('fixed_in') || !columns.present.has('fix_rule'))
    return failure(
      `Could not add agent_feedback's fixed_in and fix_rule columns (${columns.warnings.join(' ') || 'the table is absent'}).`
    );
  const by = getServerVersion();
  return inTransaction(client, () => {
    const plan = planFeedbackFixes(client);
    if (!plan.success) return plan as RbookToolResult<never>;
    const resolved: number[] = [];
    for (const row of plan.data!.rows) {
      const written = client.execute(
        `UPDATE agent_feedback SET status = 'resolved', resolved_at = ?, resolution_note = ?,
           fixed_in = ?, fix_rule = ?
         WHERE id = ? AND status = 'open' AND (resolution_note IS NULL OR TRIM(resolution_note, ' ' || char(9, 10, 13)) = '')`,
        [
          nowIso,
          fixNote(row.fixedIn, row.rule, row.revision, by),
          row.fixedIn,
          `${row.rule}@${row.revision}`,
          row.id,
        ]
      );
      if (!written.success)
        return failure(
          `Could not resolve feedback row ${row.id} (${written.error?.message ?? 'the write failed'}).`
        );
      if ((written.data?.changes ?? 0) > 0) resolved.push(row.id);
    }
    if (resolved.length) {
      const ledger = appendLedger(client, {
        action: 'apply',
        at: nowIso,
        by,
        rules: FEEDBACK_FIX_RULES.map((rule) => `${rule.id}@${rule.revision}`),
        rows: resolved,
      });
      if (!ledger.success) return ledger as RbookToolResult<never>;
    }
    return createSuccess({ ...plan.data!, resolved });
  });
}

/**
 * Reopen the rows a rule resolved that nobody has changed since: still resolved, at the time the
 * ledger's apply gave it, with the note the rule wrote. A rule revised or withdrawn uses this; a row
 * someone triaged, archived, resolved again or noted since keeps what they did, and so does one the
 * ledger no longer names. A reopened row keeps a marker, so no rule claims it again but a newer
 * revision of the rule that resolved it.
 */
export function reopenFeedbackFixes(
  client: RbookDatabaseClient,
  ruleId: string,
  nowIso: string = new Date().toISOString()
): RbookToolResult<{
  readonly rule: string;
  readonly reopened: readonly number[];
  readonly kept: readonly number[];
}> {
  const columns = client.getMany<{ name: string }>('PRAGMA table_info(agent_feedback)');
  if (!columns.success)
    return failure(
      `Could not read agent_feedback (${columns.error?.message ?? 'the query failed'}).`
    );
  const names = new Set((columns.data ?? []).map((column) => column.name));
  if (!names.has('fix_rule') || !names.has('fixed_in'))
    return createSuccess({ rule: ruleId, reopened: [], kept: [] });
  return inTransaction(client, () => {
    const ledger = readLedger(client);
    if (!ledger.success) return ledger as RbookToolResult<never>;
    // When the latest apply naming each row resolved it.
    const appliedAt = new Map<number, string>();
    for (const entry of ledger.data!)
      if (entry?.action === 'apply' && Array.isArray(entry.rows))
        for (const id of entry.rows) appliedAt.set(id, entry.at);
    const read = client.getMany<{
      id: number;
      status: string;
      resolved_at: string | null;
      resolution_note: string | null;
      fixed_in: string | null;
      fix_rule: string;
    }>(
      "SELECT id, status, resolved_at, resolution_note, fixed_in, fix_rule FROM agent_feedback WHERE fix_rule = ? OR fix_rule LIKE ? ESCAPE '\\'",
      [ruleId, `${ruleId.replace(/[\\%_]/g, (c) => `\\${c}`)}@%`]
    );
    if (!read.success)
      return failure(
        `Could not read the rows rule ${ruleId} resolved (${read.error?.message ?? 'the query failed'}).`
      );
    const reopened: number[] = [];
    const kept: number[] = [];
    for (const row of read.data ?? []) {
      const unchanged =
        row.status === 'resolved' &&
        row.fixed_in !== null &&
        row.resolved_at !== null &&
        row.resolved_at === appliedAt.get(row.id) &&
        isFixNote(row.resolution_note, row.fixed_in, row.fix_rule);
      if (!unchanged) {
        kept.push(row.id);
        continue;
      }
      const [rule, revision] = row.fix_rule.split('@');
      const written = client.execute(
        `UPDATE agent_feedback SET status = 'open', resolved_at = NULL, resolution_note = NULL,
           fixed_in = NULL, fix_rule = ?
         WHERE id = ? AND status = 'resolved' AND fix_rule = ? AND resolution_note = ? AND resolved_at = ?`,
        [
          // A revision that is not a plain number leaves a marker every rule respects.
          reopenedMarker(rule, parseRevision(revision)),
          row.id,
          row.fix_rule,
          row.resolution_note,
          row.resolved_at,
        ]
      );
      if (!written.success)
        return failure(
          `Could not reopen feedback row ${row.id} (${written.error?.message ?? 'the write failed'}).`
        );
      if ((written.data?.changes ?? 0) > 0) reopened.push(row.id);
      else kept.push(row.id);
    }
    if (reopened.length) {
      const ledger = appendLedger(client, {
        action: 'reopen',
        at: nowIso,
        by: getServerVersion(),
        rules: [ruleId],
        rows: reopened,
      });
      if (!ledger.success) return ledger as RbookToolResult<never>;
    }
    return createSuccess({ rule: ruleId, reopened, kept });
  });
}
