// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — how much of a draft's subject another text holds, and the floors calibrated on it. Moved from
// ABOUTME: draft-grammar.ts in s109-m02, which re-exports it; light, so the hooks load it inside their budgets.

import { extractKeywords } from './keyword-extraction';

/**
 * Connectors a "decision and reason" line carries whatever its subject; counting them made every
 * two lines share a keyword ("because" scored an unrelated pair 0.14 in the build's calibration).
 */
const CONNECTORS: ReadonlySet<string> = new Set([
  'because',
  'since',
  'therefore',
  'thus',
  'also',
  'would',
  'should',
  'could',
  'will',
]);

export function subjectWords(text: string): Set<string> {
  return new Set(extractKeywords(text).filter((word) => !CONNECTORS.has(word)));
}

/**
 * keywordOverlap over subject words already read, so a caller comparing many texts with one draft
 * reads the draft once (s109-m03, critic A: R-c read each draft again for every question).
 */
export function subjectOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

/** The share of the shorter text's subject keywords the other shares; 0 when either has none. */
export function keywordOverlap(a: string, b: string): number {
  return subjectOverlap(subjectWords(a), subjectWords(b));
}

/**
 * The share of the draft's own subject keywords the other text holds; 0 when the draft has none.
 * Unlike keywordOverlap it never measures against the shorter text, so a record that says only part
 * of what a longer draft proposed does not cover it (s97-m12, learning #481).
 */
export function draftCoverage(draft: string, other: string): number {
  const words = subjectWords(draft);
  if (words.size === 0) return 0;
  const held = subjectWords(other);
  let shared = 0;
  for (const word of words) if (held.has(word)) shared++;
  return shared / words.size;
}

/**
 * THE THREE FLOORS (build plan B3, B5, B12; plan critic B2 and B3). Calibrated on the pairs in
 * the build plan's §Calibration, connectors excluded: a revision of the same decision scored 1.00,
 * probe 4's nuanced approval 0.46, a flipped key term (JSON to SQLite, Postgres to DuckDB) 0.30 to
 * 0.33, and unrelated proposals 0.00 to 0.14.
 */
/**
 * Approval covers the text the operator saw (build critic B2). Retrieval keywords discard
 * negation and ordering, so they cannot prove equivalent meaning. Only whitespace may differ;
 * any other same-subject wording is the agent's reading and must be labelled agent-judged.
 */
export function recordStatesDraft(draftText: string, content: string): boolean {
  const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ');
  return normalize(draftText) === normalize(content);
}

/** Among several drafts of a kind the operator answered, a line revises one at this overlap. */
export const REVISION_OVERLAP = 0.5;
/** When the operator answered one draft of a kind, a line revises it at this subject overlap. */
export const SINGLE_REVISION_FLOOR = 0.25;
/** A record made from a draft must share at least this much of its subject with the draft. */
export const CONTENT_FLOOR = 0.3;
/**
 * A record without fromDraft answers an open draft only when it holds this much of the draft's own
 * subject (draftCoverage; s97-m12). Calibrated on this repository's store, counting the ten drafts
 * whose record is a decision: five held 1.00, then 0.95, 0.93 and 0.88 (each recorded as proposed),
 * 0.64 (P9: every choice recorded, reworded) and 0.57 (P23, the defect: part of it recorded).
 * Coverage does not part a reworded record from a partial one cleanly, so a reworded record may
 * leave its draft pending; the answer then names it.
 */
export const ANSWER_COVERAGE = 0.85;
/**
 * A line revises a pending draft at this share of that draft's own subject (draftCoverage; s97-m12)
 * when no operator message is open on drafts, and always for a draft the operator approved, whose
 * link limits it to its own words. Calibrated on this store's same-session pairs of one kind
 * (rbook/research/2026-10-s97-probes/s97-m12-prompt-origin.json, revisionCalibration): the
 * consecutive revisions in the two chains held 0.79 to 1.00, and every other pair 0.52 or less.
 * NAMED RESIDUALS: P19 to P20 (0.35) was a revision the operator's window linked, and one like it
 * with no window stays pending; the openings of the sprint-96 chain (P10 to P11 at 0.35, P11 to P12
 * at 0.13) stay pending too; and a sibling proposal that reuses this much of a draft's words with
 * one key term changed (decisions to learnings) retires it, since subject keywords cannot tell a
 * changed key term from a rewording.
 */
export const REVISION_COVERAGE = 0.75;
