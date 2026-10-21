// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m07 — the feedback kinds: published rules sort a row by its text, only rows that name Reasonbook
// ABOUTME: can be friction, the order is precedence, and a count shows every kind so a zero is a measured zero.

import { describe, expect, it } from '@jest/globals';
import {
  FEEDBACK_KINDS,
  FEEDBACK_KIND_RULES,
  FEEDBACK_KINDS_RULE,
  FOLDED_FEEDBACK_KINDS,
  classifyFeedback,
  countFeedbackKinds,
} from '../../src/signals/feedback-kinds';

describe('the feedback kinds (s97-m07)', () => {
  it('gives every rule a unique id under its own kind, and every kind a rule', () => {
    // A kind no rule can produce would always count zero, which reads as "no friction of that
    // kind" when it means "not measured". Folding a kind removes it from FEEDBACK_KINDS too.
    const ids = FEEDBACK_KIND_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of FEEDBACK_KIND_RULES) expect(rule.id.startsWith(`${rule.kind}.`)).toBe(true);
    for (const { kind } of FEEDBACK_KINDS)
      expect(FEEDBACK_KIND_RULES.some((rule) => rule.kind === kind)).toBe(true);
  });

  it('keeps every pattern stateless, so the same text always gets the same kind', () => {
    // A global or sticky RegExp keeps lastIndex between calls, and its second test of the same
    // text can miss: the kind would depend on what was classified before.
    for (const rule of FEEDBACK_KIND_RULES) expect(rule.pattern.flags).not.toMatch(/[gy]/);
    const text =
      'cmos_mission(action="status") returned an 81KB payload that exceeded the token cap.';
    expect(classifyFeedback(text)).toEqual(classifyFeedback(text));
    expect(classifyFeedback(text)).toEqual({ kind: 'payload', rule: 'payload.oversized-answer' });
  });

  it('never counts a row that names Reasonbook nowhere as friction', () => {
    // About half the fleet's rows are about the project's own code; a size or a "silently" in one
    // of those is not Reasonbook's friction.
    expect(
      classifyFeedback('The build returned an 81KB bundle and silently dropped a chunk.')
    ).toEqual({ kind: 'unclassified', rule: null });
    expect(classifyFeedback('')).toEqual({ kind: 'unclassified', rule: null });
    expect(classifyFeedback(null)).toEqual({ kind: 'unclassified', rule: null });
    expect(classifyFeedback(undefined)).toEqual({ kind: 'unclassified', rule: null });
  });

  it('reads Reasonbook by any of its names', () => {
    for (const text of [
      'cmos_review warned BUILD_STALE on every open.',
      'rbook_review warned BUILD_STALE on every open.',
      'Reasonbook warned BUILD_STALE on every open.',
      'The CMOS digest warned BUILD_STALE on every open.',
    ])
      expect(classifyFeedback(text).rule).toBe('ceremony.build-freshness');
  });

  it('leaves a row about Reasonbook that no rule matches unclassified', () => {
    expect(classifyFeedback('CMOS captured the decision cleanly; nothing to report.')).toEqual({
      kind: 'unclassified',
      rule: null,
    });
  });

  it.each([
    [
      'surfacing',
      'cmos_decisions record suggested superseding three unrelated decisions on shared terms.',
    ],
    [
      'payload',
      'cmos_message(action="list") returned 85KB and overflowed the tool-result token cap.',
    ],
    [
      'identity',
      'cmos_mission(action="show") returned MISSION_NOT_FOUND from ten sibling projects.',
    ],
    ['sync', 'cmos_message(action=send) reported success but returned ID: undefined.'],
    [
      'ceremony',
      'cmos_mission_transition complete warned "No decisions captured" after record calls.',
    ],
  ] as const)('sorts a %s complaint into its kind', (kind, text) => {
    expect(classifyFeedback(text).kind).toBe(kind);
  });

  it('decides by the first matching rule, so a narrow pain outranks a broad one', () => {
    // A supersession complaint often also gives the size of the echo: it is filed under the pain
    // that caused it.
    expect(
      classifyFeedback(
        'The CMOS supersession detector fired again; each receipt echoed about 25 KB of candidate text.'
      ).rule
    ).toBe('surfacing.supersession-noise');
    // A message send that claims success with no id is a messaging defect before a silent loss.
    expect(
      classifyFeedback('cmos_message send reported success but returned ID: undefined.').kind
    ).toBe('sync');
  });

  it('reads a folded kind as unclassified, never as a later kind', () => {
    // Setup (8/20) and silent-loss (5/7) fell short of precision 0.9 and are folded. Their rules
    // keep their place: a stale-binary row that also asks for an explicit projectRoot would
    // otherwise reach identity, whose measured precision never covered such rows.
    expect(FOLDED_FEEDBACK_KINDS).toEqual(['setup', 'silent-loss']);
    for (const kind of FOLDED_FEEDBACK_KINDS) {
      expect(FEEDBACK_KINDS.some((info) => info.kind === (kind as string))).toBe(false);
      expect(FEEDBACK_KIND_RULES.some((rule) => rule.kind === kind)).toBe(true);
    }
    expect(
      classifyFeedback(
        'cmos_session start fails with NOT NULL constraint failed: sessions.project_id, so I had to pass an explicit projectRoot.'
      )
    ).toEqual({ kind: 'unclassified', rule: null });
    expect(classifyFeedback('cmos_decisions(update) silently ignores text parameters.')).toEqual({
      kind: 'unclassified',
      rule: null,
    });
  });

  it('counts every kind, zero included, and the unclassified rows beside them', () => {
    const counts = countFeedbackKinds([
      'cmos_mission status returned 93KB, past the token cap.',
      'cmos_review build-freshness warning never clears.',
      'The project build passed.',
      null,
    ]);
    expect(Object.keys(counts.counts)).toEqual(FEEDBACK_KINDS.map(({ kind }) => kind));
    expect(counts.counts.payload).toBe(1);
    expect(counts.counts.ceremony).toBe(1);
    expect(counts.counts.identity).toBe(0);
    expect(counts.unclassified).toBe(2);
  });

  it('publishes its counting rule beside the counts', () => {
    // Publish the counting rule beside the number (decisions #1038, #1059).
    expect(FEEDBACK_KINDS_RULE).toMatch(/first rule/);
    expect(FEEDBACK_KINDS_RULE).toMatch(/unclassified/);
    expect(FEEDBACK_KINDS_RULE).toMatch(/tool name decides nothing/);
  });
});
