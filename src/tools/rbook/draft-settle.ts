// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — settling a pending draft by the recorded decision a reply names: the refusals, then the write
// ABOUTME: (answered, settled, by d:N) on the Stop hook's own connection, inside the caller's IMMEDIATE transaction.

import { draftCoverage, ANSWER_COVERAGE } from './draft-grammar';
import type { SettleLine } from './draft-settle-grammar';
import {
  draftLabel,
  getDraft,
  markAnswered,
  markDeclined,
  proposalsTableExists,
  type DraftRow,
  type SqlRunner,
} from './proposals';
import { storedTimeMs } from './stored-time';

/**
 * THE MATRIX (the sprint-109 design, settled items 2 to 4; E2's table, as amended). A settle names
 * a recorded decision as the operator's answer to a draft, so it refuses a decision that claims no
 * operator approval (autonomous), one replaced since (superseded, naming its chain's end), one not in
 * this copy (on a shared copy, until it syncs), and a draft that is not a pending decision draft,
 * that this same reply's Would record lines create, repeat or revise, or that expired. A decision
 * recorded after the draft settles it at 0.3 of the draft's own subject; an older one needs 0.85,
 * since only time and text link it. It ADMITS a decision the agent recorded directly, with no
 * approval mode: #1810's main case, which rests on the agent's naming, shown in its reply.
 */
export const SETTLE_AFTER_FLOOR = 0.3;

export type SettleRefusal =
  | 'no-draft'
  | 'not-pending'
  | 'not-decision'
  | 'same-reply'
  | 'expired'
  | 'no-decision'
  | 'superseded'
  | 'autonomous'
  | 'unreadable-time'
  | 'coverage'
  | 'raced'
  /** The store write failed (src/cli/drafts-settle.ts): busy, or another error, named in detail. */
  | 'busy'
  | 'failed';

export interface SettleOutcome {
  readonly line: SettleLine;
  readonly applied: boolean;
  /** Why it was refused, `low-coverage` for an applied settle below 0.85, or null. */
  readonly reason: SettleRefusal | 'low-coverage' | null;
  /** The draft's state, the chain's end, the share or "sync first"; never the operator's words. */
  readonly detail: string;
}

interface DecisionRow {
  readonly id: number;
  readonly decision_text: string;
  readonly created_at: string;
  readonly status: string | null;
  readonly superseded_by: number | null;
  readonly approval_mode?: string | null;
}

function tableExists(run: SqlRunner, name: string): boolean {
  return Boolean(
    run.get("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?", [name])
  );
}

function readDecision(run: SqlRunner, id: number): DecisionRow | undefined {
  return tableExists(run, 'strategic_decisions')
    ? run.get<DecisionRow>('SELECT * FROM strategic_decisions WHERE id = ?', [id])
    : undefined;
}

/** The newest decision on a superseded one's chain (a cycle or a missing link ends the walk). */
function chainEnd(run: SqlRunner, decision: DecisionRow): number {
  const seen = new Set([decision.id]);
  let end = decision;
  while (end.superseded_by !== null && !seen.has(end.superseded_by)) {
    seen.add(end.superseded_by);
    const next = readDecision(run, end.superseded_by);
    if (!next) return end.superseded_by;
    end = next;
  }
  return end.id;
}

function stateOf(draft: DraftRow): string {
  switch (draft.outcome) {
    case 'answered':
    case 'approved':
      return `${draft.outcome} as ${draft.recordId ?? 'a record'}`;
    case 'declined':
      return 'declined by the operator';
    case 'replaced':
      return draft.replacedBy ? `replaced by ${draftLabel(draft.replacedBy)}` : 'replaced';
    default:
      return draft.outcome;
  }
}

/** Added to a proposals table that predates the column; the guard makes it idempotent. */
export function ensureSettledBy(run: SqlRunner): void {
  const columns = run.all<{ name: string }>('PRAGMA table_info(proposals)');
  if (!columns.some((column) => column.name === 'settled_by'))
    run.exec('ALTER TABLE proposals ADD COLUMN settled_by TEXT');
}

const percent = (share: number): string => `${Math.round(share * 100)}%`;

/**
 * Critic A, build round 1, B1: every draft joined to `id` by replaced_by links, either way. A settle
 * answers the draft's revision chain too (settleRevised), so a chain holding a draft this reply's
 * Would record lines created, repeated or revised is refused as that draft itself is: otherwise the
 * draft the reply just put to the operator is answered unseen, and their next "yes" binds nothing.
 */
function linkedDrafts(run: SqlRunner, id: number): number[] {
  return run
    .all<{ id: number }>(
      `WITH RECURSIVE chain(id) AS (
         SELECT ?
         UNION
         SELECT proposals.replaced_by FROM proposals JOIN chain ON proposals.id = chain.id
           WHERE proposals.replaced_by IS NOT NULL
         UNION
         SELECT proposals.id FROM proposals JOIN chain ON proposals.replaced_by = chain.id
       )
       SELECT id FROM chain`,
      [id]
    )
    .map((row) => row.id);
}

/**
 * Settle each line in order. Call inside an IMMEDIATE transaction on the hook's own connection: the
 * retained declines are applied first, as a record applies them (#1650), and nothing here creates
 * the proposals table.
 */
export function settleDrafts(options: {
  readonly run: SqlRunner;
  readonly lines: readonly SettleLine[];
  /** Drafts this reply's Would record lines created, repeated or revised. */
  readonly sameReply: ReadonlySet<number>;
  /** Declines the prompt hook retained for a store write that has not landed yet. */
  readonly declines: ReadonlyArray<{ readonly id: number; readonly at: number }>;
  readonly isExpired: (draft: DraftRow) => boolean;
  /** The harness session hash of the reply that settles, or null. */
  readonly settledBy: string | null;
  readonly now: number;
}): SettleOutcome[] {
  const { run } = options;
  const refuse = (line: SettleLine, reason: SettleRefusal, detail = ''): SettleOutcome => ({
    line,
    applied: false,
    reason,
    detail,
  });
  if (!proposalsTableExists(run))
    return options.lines.map((line) => refuse(line, 'no-draft', 'no drafts in this store'));
  for (const decline of options.declines)
    markDeclined(run, [decline.id], new Date(decline.at).toISOString());
  const shared = tableExists(run, 'record_peers');
  const at = new Date(options.now).toISOString();
  let columnReady = false;
  return options.lines.map((line): SettleOutcome => {
    const draft = getDraft(run, line.draftId);
    if (!draft) return refuse(line, 'no-draft');
    if (draft.outcome !== 'pending') return refuse(line, 'not-pending', stateOf(draft));
    if (draft.kind !== 'decision') return refuse(line, 'not-decision', draft.kind);
    if (linkedDrafts(run, draft.id).some((id) => options.sameReply.has(id)))
      return refuse(line, 'same-reply');
    // An unreadable time is named as such (critic A, note 4), before expiry would read it expired.
    const draftMs = storedTimeMs(draft.createdAt);
    if (!Number.isFinite(draftMs)) return refuse(line, 'unreadable-time');
    if (options.isExpired(draft)) return refuse(line, 'expired');
    const decision = readDecision(run, line.decisionId);
    if (!decision) return refuse(line, 'no-decision', shared ? 'sync first' : '');
    if (decision.superseded_by !== null || decision.status === 'superseded') {
      // A status with no successor names no chain's end (critic A, note 3).
      const end = chainEnd(run, decision);
      return refuse(line, 'superseded', end === decision.id ? '' : `d:${end}`);
    }
    if (String(decision.approval_mode ?? '').toLowerCase() === 'autonomous')
      return refuse(line, 'autonomous');
    const decisionMs = storedTimeMs(decision.created_at);
    if (!Number.isFinite(decisionMs)) return refuse(line, 'unreadable-time');
    const coverage = draftCoverage(draft.text, decision.decision_text ?? '');
    const after = decisionMs > draftMs;
    if (coverage < (after ? SETTLE_AFTER_FLOOR : ANSWER_COVERAGE))
      return refuse(
        line,
        'coverage',
        `${percent(coverage)}${after ? '' : ', recorded before the draft'}`
      );
    if (!columnReady) ensureSettledBy(run);
    columnReady = true;
    if (!markAnswered(run, [draft.id], `d:${decision.id}`, at)) return refuse(line, 'raced');
    run.run("UPDATE proposals SET approval_mode = 'settled', settled_by = ? WHERE id = ?", [
      options.settledBy,
      draft.id,
    ]);
    return coverage < ANSWER_COVERAGE
      ? { line, applied: true, reason: 'low-coverage', detail: percent(coverage) }
      : { line, applied: true, reason: null, detail: '' };
  });
}
