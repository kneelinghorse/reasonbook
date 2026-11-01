// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Feedback that a release fixed (s108-m04): published rules that name the Reasonbook release whose change fixed
// ABOUTME: the defect an agent_feedback row reports, by the row's text and filing time. Pure: no clock, state or I/O.

import { REASONBOOK_NAMED } from './feedback-kinds';
import { storedTimeMs } from '../tools/rbook/stored-time';

/**
 * WHY RULES. Most open feedback rows predate the release that fixed what they report: on
 * 2026-10-31, 775 of this Mac's 791 open rows were filed before 4.0.0, and no row records the
 * version it was filed on (the sprint-108 design's probe E3). A row is said to be fixed only by these
 * published rules, so anyone can recompute the count, and a store resolves its own rows only when
 * someone runs `reasonbook feedback resolve-fixed --apply` there (settled item 9). Reads label the
 * matching rows everywhere, so the fleet count stops reading them as open work.
 *
 * THE CLOSING TEST ({@link FEEDBACK_FIXES_RULE}, published beside every count). A row is fixed in a
 * rule's release when it is open or triaged, was filed before the release's npm publish time,
 * every pattern of the rule matches its first 4,000 UTF-16 code units and the first one matches
 * its first sentence, no `unless` pattern matches its first sentence, and the row names no second
 * item (a numbered list or "also"). A row filed in time
 * whose patterns all match, but whose first sentence misses or which names a second item, is
 * partly fixed: labelled, never resolved, because the rest of it may still be open.
 *
 * PRECISION. A rule ships only at 0.9 or better against labels a separate agent gave every row the
 * rule matched (all of them, at 40 or fewer), mixed with as many rows no rule matched, seeing each
 * row's text and the rules' descriptions but never which rule matched (2026-11-01, 339 open or
 * triaged rows in this Mac's 18 registered stores, 100 labelled): completion.decisions-advisory
 * 8/8, decisions.supersession-offers 19/20, reads.fan-out-every-project 17/17. Two of probe E3's
 * rules are left out: 4.9.0's build-freshness warning in a project with no build manifest, 6/7
 * (0.857; one row named build freshness only as an input it wanted), which would also need a
 * condition only the store's own folder can answer; and 3.2.0's sprint-close archive, which no open
 * row matched, so it had nothing to measure. The sample, the labels and the scoring are in
 * rbook/research/2026-10-s108-a-record-that-keeps-itself/m04/.
 */

export interface FeedbackFixRule {
  /** `<surface>.<defect>`, stored on a resolved row as `id@revision`. */
  readonly id: string;
  /** Raised when the rule changes, so a row resolved by an older revision can be reopened. */
  readonly revision: number;
  /** The release whose change fixed the defect. */
  readonly fixedIn: string;
  /** `fixedIn`'s npm publish time: a row filed then or later is never matched. */
  readonly publishedAt: string;
  /** Where the fix is recorded. */
  readonly evidence: string;
  /** What a row the rule matches reports, as the blind labeller read it. */
  readonly description: string;
  /** Every pattern must match the first 4,000 code units, the first within the first sentence. */
  readonly match: readonly RegExp[];
  /** A row whose first sentence matches any of these is never matched. */
  readonly unless?: readonly RegExp[];
}

/**
 * The rules, case-insensitive and never global, so stateless. Their patterns are probe E3's
 * (rbook/research/2026-10-s108-planning/probes/e3/rules.js and rules3.js), unchanged, so its scripts
 * count the same rows; a pattern tuned here is tuned there in the same commit.
 */
export const FEEDBACK_FIX_RULES: readonly FeedbackFixRule[] = [
  {
    id: 'completion.decisions-advisory',
    revision: 1,
    fixedIn: '3.2.0',
    publishedAt: '2026-10-08T00:51:14.690Z',
    evidence:
      'CHANGELOG.md, 3.2.0: mission completion counts the decisions recorded for the mission',
    description:
      'Mission completion warned "No decisions captured" (or reported decisionCount 0) although decisions had been recorded for the mission.',
    match: [
      /no (?:mission |strategic )?decisions? (?:were |was )?(?:captured|recorded)|decisionCount ?=? ?0/i,
      /(?:cmos|rbook)_decisions|\brecord(?:ed)?\b|mission[- ](?:stamped|linked|scoped|tagged)|missionId/i,
    ],
  },
  {
    id: 'decisions.supersession-offers',
    revision: 1,
    fixedIn: '3.2.0',
    publishedAt: '2026-10-08T00:51:14.690Z',
    evidence: 'CHANGELOG.md, 3.2.0: supersession offers no longer come from keyword overlap',
    description:
      'Recording a decision offered to supersede, or suggested superseding, unrelated earlier decisions that only shared words with it.',
    match: [
      /supersession[- ](?:detect(?:or|ion)|candidates?|offers?|heuristic|signal|suggestions?|hints?)|suggest(?:s|ed|ing)? (?:superseding|that [^.]{0,60}supersedes)|propos(?:es|ed|ing) (?:superseding|supersession)|offered [^.]{0,40}as superseding|potential supersession/i,
    ],
  },
  {
    id: 'reads.fan-out-every-project',
    revision: 1,
    fixedIn: '2.1.0',
    publishedAt: '2026-07-09T18:02:11.427Z',
    evidence: 'CHANGELOG.md, 2.1.0: every read is pinned to the resolved project',
    description:
      'A read such as mission show or status walked every registered project, returning other projects’ rows or one "not found" entry per project, instead of answering for the one project meant.',
    match: [
      /MISSION_NOT_FOUND|not-found stubs|fan[- ]?(?:s )?out|walk(?:s|ed)? (?:the )?(?:whole |entire |every )?(?:project )?(?:registry|registered)|(?:every|all|each) (?:registered |sibling )?project(?:'s)? (?:root|DB|queue|store)s?|one entry per (?:registered )?project/i,
    ],
  },
];

/**
 * A row that names a second item: a numbered or lettered list, an enumerated count of issues, "also",
 * or, from s108-m04's critic, "separately", "in addition", "additionally" or "another" before issue,
 * problem, bug, defect, thing or note. A plain second sentence with none of these still passes; the
 * closing test is a heuristic, measured, not proved.
 */
export const FEEDBACK_SECOND_ITEM =
  /\(\s?[1-9a-c]\s?\)|(?:^|\s)[1-9]\)\s|(?:^|[.:]\s)[1-9]\.\s|\b(?:two|three|four|five|several|a few) (?:rough edges|friction points|issues|notes|things|defects|items|gaps|observations|problems)\b|\balso\b|\bseparately\b|\bin addition\b|\badditionally\b|\banother (?:issue|problem|bug|defect|thing|note)\b/i;

/** Published beside every count of fixed rows. */
export const FEEDBACK_FIXES_RULE =
  "a row is fixed in a release when it is open or triaged, was filed before that release's npm publish time, " +
  'that release had shipped by now, the row was not reopened (only a newer revision of the rule its reopen names may ' +
  "claim it again), every pattern of the release's rule in FEEDBACK_FIX_RULES matches its first 4,000 UTF-16 code " +
  'units, no unless pattern matches its first sentence, the first pattern matches its first sentence, and it names ' +
  'no second item (FEEDBACK_SECOND_ITEM: a numbered or lettered list, a count such as "two issues", "also", ' +
  '"separately", "in addition", "additionally", or "another" before issue, problem, bug, defect, thing or note); ' +
  'a row that passes all but those last two tests is partly fixed and stays open; an unreadable filing time ' +
  'matches nothing';

/** The first sentence of a row's text, its whitespace collapsed. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ');
  const end = flat.search(/[.!?](?:\s|$)/);
  return end < 0 ? flat : flat.slice(0, end + 1);
}

export interface FeedbackFixRow {
  readonly body: string | null | undefined;
  readonly status: string | null | undefined;
  /** The filing time as stored; one storedTimeMs cannot read matches nothing. */
  readonly createdAt: string | null | undefined;
  /** The row's fix_rule: a reopen leaves {@link reopenedMarker}, which only a newer revision passes. */
  readonly fixRule?: string | null;
}

/**
 * What a reopen leaves in fix_rule: no rule claims the row again, not even another rule that also
 * fixes it, except a newer revision of the rule the reopen names, which a reopen is for.
 */
export function reopenedMarker(rule: string, revision: number): string {
  return `reopened:${rule}@${revision}`;
}

/** A revision in fix_rule or a reopen's marker: digits only; anything else names none. */
export function parseRevision(text: string | undefined): number {
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

/** Whether a row's fix_rule keeps this rule from claiming it: a reopen, unless the rule is newer. */
function reopenBlocks(fixRule: string | null | undefined, rule: FeedbackFixRule): boolean {
  if (!fixRule?.startsWith('reopened:')) return false;
  const named = fixRule.slice('reopened:'.length);
  const at = named.lastIndexOf('@');
  // s108-m04 (round 3): Number('') is 0, so a blank revision once let its own rule claim the row.
  const revision = parseRevision(named.slice(at + 1));
  return !(at > 0 && named.slice(0, at) === rule.id && rule.revision > revision);
}

export interface FeedbackFixVerdict {
  readonly rule: string;
  readonly revision: number;
  readonly fixedIn: string;
  readonly state: 'fixed' | 'partly';
}

/**
 * One rule's verdict on a row: fixed, partly fixed, or null when the rule does not match. The dry
 * run counts each rule this way, so a row two rules match counts under both, as probe E3 counted.
 */
export function feedbackFixByRule(
  rule: FeedbackFixRule,
  row: FeedbackFixRow,
  /** The instant the rule is applied at: a release not yet published fixes nothing. */
  nowMs: number = Date.now()
): FeedbackFixVerdict | null {
  if (row.status !== 'open' && row.status !== 'triaged') return null;
  if (typeof row.body !== 'string' || typeof row.createdAt !== 'string') return null;
  // A stored time, read as the server reads one: a time without a zone is UTC.
  const filed = storedTimeMs(row.createdAt);
  const published = storedTimeMs(rule.publishedAt);
  if (!Number.isFinite(filed) || !(filed < published) || published > nowMs) return null;
  if (reopenBlocks(row.fixRule, rule)) return null;
  const body = row.body.slice(0, 4000);
  if (!rule.match.every((pattern) => pattern.test(body))) return null;
  const first = firstSentence(row.body);
  if (rule.unless?.some((pattern) => pattern.test(first))) return null;
  const whole = rule.match[0].test(first) && !FEEDBACK_SECOND_ITEM.test(row.body);
  return {
    rule: rule.id,
    revision: rule.revision,
    fixedIn: rule.fixedIn,
    state: whole ? 'fixed' : 'partly',
  };
}

/**
 * Which shipped fix a row reports: the first rule in {@link FEEDBACK_FIX_RULES} that fixes it,
 * else the first that partly fixes it, else null. Deterministic: the same row always gives the same
 * answer.
 */
export function feedbackFixOf(
  row: FeedbackFixRow,
  nowMs: number = Date.now()
): FeedbackFixVerdict | null {
  let partly: FeedbackFixVerdict | null = null;
  for (const rule of FEEDBACK_FIX_RULES) {
    const verdict = feedbackFixByRule(rule, row, nowMs);
    if (verdict?.state === 'fixed') return verdict;
    partly ??= verdict;
  }
  return partly;
}

/** The three groups every open-feedback count splits into (settled item 10). */
export type FeedbackGroup = 'fixed' | 'reasonbook' | 'own';

/** Published beside the three groups' counts. */
export const FEEDBACK_GROUPS_RULE =
  'fixed: a row a shipped rule closes (FEEDBACK_FIXES_RULE); reasonbook: any other row that names Reasonbook ' +
  '(reasonbook, rbook, cmos or one of their tools, drafts, fromDraft or mission status); own: the rest, about the ' +
  "project's own work";

/** Which of the three groups a row counts in. */
export function feedbackGroupOf(row: FeedbackFixRow, nowMs: number = Date.now()): FeedbackGroup {
  if (feedbackFixOf(row, nowMs)?.state === 'fixed') return 'fixed';
  const body = typeof row.body === 'string' ? row.body.slice(0, 4000) : '';
  return REASONBOOK_NAMED.test(body) ? 'reasonbook' : 'own';
}
