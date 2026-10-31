// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Feedback classification has a bounded input and avoids repeated unbounded searches.
// ABOUTME: Guards the F5 structural defect, cap boundary and phrase ordering without changing the frozen labels.

import { describe, expect, it, jest } from '@jest/globals';
import { performance } from 'perf_hooks';
import {
  classifyFeedback,
  FEEDBACK_KIND_RULES,
  FEEDBACK_KINDS_RULE,
  REASONBOOK_NAMED,
} from '../../src/signals/feedback-kinds';
import { multipleUnboundedAlternatives, regexAlternatives } from '../helpers/feedback-regex';

const patterns = [{ id: 'REASONBOOK_NAMED', pattern: REASONBOOK_NAMED }, ...FEEDBACK_KIND_RULES];

describe('feedback regex cost contract', () => {
  it('finds nested and sequential repeats without mistaking escaped characters for quantifiers', () => {
    expect(regexAlternatives('a[|]b|(?:c|d)\\|e')).toEqual(['a[|]b', '(?:c|d)\\|e']);
    expect(multipleUnboundedAlternatives(/(a+)+|a*b+|a{1,}b+/)).toHaveLength(3);
    expect(multipleUnboundedAlternatives(/a\+b*|[+*]+|a{1,4000}b*/)).toEqual([]);
  });

  it('has no alternative with two unbounded quantifiers across all 21 patterns', () => {
    expect(patterns).toHaveLength(21);
    expect(
      patterns.flatMap(({ id, pattern }) =>
        multipleUnboundedAlternatives(pattern).map((alternative) => ({ id, alternative }))
      )
    ).toEqual([]);
  });

  it('uses only the first 4,000 UTF-16 code units for both the name gate and kind rules', () => {
    const unnamed = ' '.repeat(4000) + 'Reasonbook BUILD_STALE';
    const lateKind = 'Reasonbook '.padEnd(4000, ' ') + 'BUILD_STALE';
    expect(classifyFeedback(unnamed)).toEqual({ kind: 'unclassified', rule: null });
    expect(classifyFeedback(lateKind)).toEqual({ kind: 'unclassified', rule: null });
    expect(classifyFeedback('Reasonbook '.padEnd(3989, ' ') + 'BUILD_STALE')).toEqual({
      kind: 'ceremony',
      rule: 'ceremony.build-freshness',
    });
    expect(FEEDBACK_KINDS_RULE).toMatch(/first 4,000/);
  });

  it('sends the bounded row through every rule and completes that row within 50 ms', () => {
    const text = ('Reasonbook ' + 'hosted connector '.repeat(4000)).slice(0, 4000);
    // s102-m13: measure the product call alone. Jest's spies and deep-equality
    // matcher were inside the old 50 ms sample (68.8 ms in the failed load run).
    // Keep the same single-call wall-clock bound, then verify rule coverage separately.
    // s107-m06: the fastest of five calls, since one call can stall behind the load
    // gate's spinners (82.1 ms on 4.9.0's candidate; the call itself takes about
    // 0.13 ms), while a rule that turned super-linear would slow every call.
    let elapsed = Infinity;
    for (let sample = 0; sample < 5; sample += 1) {
      const started = performance.now();
      const result = classifyFeedback(text);
      elapsed = Math.min(elapsed, performance.now() - started);
      expect(result).toEqual({ kind: 'unclassified', rule: null });
    }
    expect(elapsed).toBeLessThan(50);
    const spies = patterns.map(({ pattern }) => jest.spyOn(pattern, 'test'));
    try {
      expect(classifyFeedback(text)).toEqual({ kind: 'unclassified', rule: null });
      for (const spy of spies) expect(spy).toHaveBeenCalledWith(text);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it.each([
    [
      'surfacing.supersession-noise',
      'supersed superseded shared vocabulary',
      'shared vocabulary supersed',
    ],
    ['payload.oversized-answer', '12.75KB ' + 'x '.repeat(900) + 'payload', '12.75KB. payload'],
    ['payload.repeated-focus', 'focus focus every queued mission', 'focus. every queued mission'],
    ['sync.messaging', 'rbook_message rbook_message fails', 'rbook_message. fails'],
    [
      'silent-loss.false-success',
      'returns success returns success without an id',
      'returns success. without an id',
    ],
    [
      'surfacing.next-action-order',
      'next action picks despite dependency',
      'next action. despite dependency',
    ],
    ['surfacing.stale-counts', 'capped at 200 while 500 were', 'capped at 200. while 500 were'],
    ['sync.hosted-wrapper', 'hosted connector hosted connector failed', 'hosted connector. failed'],
  ])('preserves the in-cap phrase order for %s', (id, positive, negative) => {
    const rule = FEEDBACK_KIND_RULES.find((candidate) => candidate.id === id)!;
    expect(rule.pattern.test(`Earlier sentence. Reasonbook ${positive}`)).toBe(true);
    expect(rule.pattern.test(`Reasonbook ${negative}`)).toBe(false);
  });
});
