// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — reads a reply's "Settled: P<n> by decision <N>" lines: which settle, which are named as not kept,
// ABOUTME: and which drafts they name, so the Stop hook keeps those drafts out of what the operator's next "yes" binds.

import { fencedLines, isDraftLabel, readDraftReply, type DraftReply } from './draft-grammar';
import { settleLabel } from './draft-settle-label';

/**
 * WHERE A SETTLE IS READ (the sprint-109 design, settled items 1 and 5). Only a plain line in the
 * reply's trailing block settles, the block the Would record lines end. The teaching puts it above
 * any Would record lines, because a 4.10.0 Stop hook stops reading at the first line without the
 * Would record label: it keeps the Would record lines below and ignores the Settled line. This
 * reader takes any order in full, and names a Settled line below or between Would record lines even
 * when it applies it, since an older hook would have dropped the Would record lines above it.
 *
 * WHAT IS NOT KEPT. A Settled-labelled line in another form (quoted, listed, bold, in code or a fence,
 * link text, or worded otherwise) is never a settle, and a plain one outside the trailing block is
 * not either. Each is named at the operator's next prompt. Outside the block, only a line that names
 * a draft counts, so prose that happens to begin "Settled:" is left alone.
 *
 * WHAT A SETTLED LINE NAMES. Every draft a Settled-labelled line names, plain or not, settled or
 * not, leaves the shown and kept sets, so a settle that did not take effect never opens a window in
 * which the operator's next "yes" records the draft a second time (critic B3, B1; B4, notes 1 and 3).
 */
export interface SettleLine {
  readonly draftId: number;
  readonly decisionId: number;
  /** The line as written, trimmed. */
  readonly text: string;
  /** Below or between Would record lines: applied, and named. */
  readonly misplaced: boolean;
}

export interface UnkeptSettle {
  readonly text: string;
  readonly reason: 'form' | 'place';
  readonly draftId: number | null;
}

export interface SettleRead {
  /** Plain Settled lines in the trailing block, in reading order. */
  readonly settles: readonly SettleLine[];
  /** Settled-labelled lines that are not read as a settle, in reading order. */
  readonly unkept: readonly UnkeptSettle[];
  /** Every draft a Settled-labelled line names, in first-mention order. */
  readonly named: readonly number[];
}

export function readSettles(reply: string, read: DraftReply = readDraftReply(reply)): SettleRead {
  const settles: SettleLine[] = [];
  const unkept: UnkeptSettle[] = [];
  const named: number[] = [];
  let draftAbove = false;
  const seen = new Set<string>();
  fencedLines(reply ?? '').forEach((line, index) => {
    const inBlock = index >= read.blockStart && !line.fenced;
    const label = settleLabel(line.text);
    if (!label) {
      if (inBlock && isDraftLabel(line.text)) draftAbove = true;
      return;
    }
    if (!inBlock && label.draftId === null) return;
    for (const id of label.draftIds) if (!named.includes(id)) named.push(id);
    const text = line.text.trim();
    if (line.fenced || !label.plain) unkept.push({ text, reason: 'form', draftId: label.draftId });
    else if (!inBlock) unkept.push({ text, reason: 'place', draftId: label.draftId });
    else if (!seen.has(`${label.draftId}:${label.decisionId}`)) {
      // The same settle twice is one settle, not a second line to refuse (critic B, note 4).
      seen.add(`${label.draftId}:${label.decisionId}`);
      settles.push({
        draftId: label.draftId!,
        decisionId: label.decisionId!,
        text,
        misplaced: draftAbove,
      });
    }
  });
  return { settles, unkept, named };
}
