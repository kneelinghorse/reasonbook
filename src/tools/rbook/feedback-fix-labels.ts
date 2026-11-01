// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m04 — the feedback fix rules where rows are read: the three groups' counts, and the label a list
// ABOUTME: prints beside a row that a shipped release fixed.

import {
  feedbackGroupOf,
  type FeedbackFixRow,
  type FeedbackFixVerdict,
  type FeedbackGroup,
} from '../../signals/feedback-fixes';

/** Every row in one of the three groups, zeros included. */
export function groupCounts(rows: Iterable<FeedbackFixRow>): Record<FeedbackGroup, number> {
  const counts: Record<FeedbackGroup, number> = { fixed: 0, reasonbook: 0, own: 0 };
  for (const row of rows) counts[feedbackGroupOf(row)] += 1;
  return counts;
}

/** What a list prints beside a row a rule matches; empty when none does. */
export function fixLabel(fix: FeedbackFixVerdict | null | undefined): string {
  if (!fix) return '';
  return fix.state === 'fixed'
    ? `fixed in ${fix.fixedIn} (${fix.rule})`
    : `partly fixed in ${fix.fixedIn} (${fix.rule})`;
}
