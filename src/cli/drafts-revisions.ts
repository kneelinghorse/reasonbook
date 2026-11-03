// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m12 — which pending draft each of a reply's Would record lines revises, at the window's floors or the
// ABOUTME: coverage rule. Moved from drafts-hook.ts in s109-m02, which keeps the Stop flow under 400 lines.

import {
  draftCoverage,
  keywordOverlap,
  REVISION_COVERAGE,
  REVISION_OVERLAP,
  SINGLE_REVISION_FLOOR,
  type DraftLine,
} from '../tools/rbook/draft-grammar';
import type { DraftRow } from '../tools/rbook/proposals';

/**
 * Which window draft each line revises (B3, folded): when the operator's last message answered one
 * draft of a kind, the reply's best line of that kind revises it if they share a subject (an
 * amendment may flip its key term, which the 0.5 overlap missed); among several of a kind, only a
 * line at the full overlap threshold. A line about something else leaves the draft pending. Without
 * a window (s97-m12), a line must hold REVISION_COVERAGE of the draft's own subject instead: no
 * operator message names the draft, so a line on a neighbouring subject, or one part of a longer
 * draft, does not retire it.
 */
export function revisions(
  lines: readonly DraftLine[],
  candidates: readonly DraftRow[],
  /**
   * s97-m12: whether a draft is one the operator's last message answered, other than by a plain
   * approval; any other candidate (none answered, kept from an earlier reply, or approved, which a
   * link limits to its own words) is revised only at the coverage rule.
   */
  answered: (draft: DraftRow) => boolean
): Map<number, DraftRow> {
  const assigned = new Map<number, DraftRow>();
  for (const draft of candidates) {
    const ofKind = candidates.filter((row) => row.kind === draft.kind && answered(row)).length;
    const covered = !answered(draft);
    let best = -1;
    let bestScore =
      (covered ? REVISION_COVERAGE : ofKind === 1 ? SINGLE_REVISION_FLOOR : REVISION_OVERLAP) -
      Number.EPSILON;
    lines.forEach((line, index) => {
      if (line.kind !== draft.kind || assigned.has(index)) return;
      const score = covered
        ? draftCoverage(draft.text, line.text)
        : keywordOverlap(draft.text, line.text);
      if (score > bestScore) {
        best = index;
        bestScore = score;
      }
    });
    if (best >= 0) assigned.set(best, draft);
  }
  return assigned;
}
