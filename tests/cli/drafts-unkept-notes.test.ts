// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — how the operator's next prompt names the lines of the agent's last reply that took no effect, or
// ABOUTME: took effect with a note: each with its own words, the rest counted, and an unknown reason shown as its code.

import { describe, expect, it } from '@jest/globals';

import { unkeptNotes } from '../../src/cli/drafts-unkept-notes';

const entry = (reason: string, detail = '') => ({
  text: 'Settled: P1 by decision 9',
  reason,
  detail,
});

const notes = (entries: ReturnType<typeof entry>[], more = 0) =>
  unkeptNotes({
    generation: 'shown',
    entries: entries.map((row, position) => ({ ...row, position })),
    more,
  });

describe('unkeptNotes (settled item 5)', () => {
  it('retains each reason as its own deliverable entry before budgeting longer excerpts', () => {
    const read = {
      generation: 'current',
      entries: [
        { ...entry('superseded', 'd:1805'), position: 0 },
        { ...entry('limit'), position: 4 },
      ],
      more: 2,
    };
    expect(unkeptNotes(read)).toEqual([
      expect.objectContaining({ position: 0, compact: expect.stringMatching(/superseded/i) }),
      expect.objectContaining({ position: 4, compact: expect.stringMatching(/three/i) }),
      expect.objectContaining({ position: 5, compact: expect.stringContaining('2 more') }),
    ]);
  });

  it('names nothing when nothing was lost', () => {
    expect(notes([])).toEqual([]);
  });

  it('tells the agent to tell the operator about what took no effect, apart from the notes', () => {
    expect(
      notes([entry('autonomous'), entry('low-coverage', '57%'), entry('order')]).map(
        (note) => note.full
      )
    ).toEqual([
      'Lines in your last reply took no effect; tell the operator: "Settled: P1 by decision 9" (that decision was recorded autonomously, so it claims no operator approval).',
      `Lines in your last reply took effect with a note: "Settled: P1 by decision 9" (it took effect, though that decision states only 57% of the draft's subject; check that it answers it).`,
      `Lines in your last reply took effect with a note: "Settled: P1 by decision 9" (it took effect, but put Settled lines above any Would record lines: an older Reasonbook hook drops the Would record lines above one).`,
    ]);
  });

  it('words each detail: the chain’s end, the share and its floor, a shared copy, a failure', () => {
    const line = notes([
      entry('superseded', 'd:1805'),
      entry('coverage', '20%'),
      entry('coverage', '57%, recorded before the draft'),
      entry('no-decision', 'sync first'),
      entry('not-pending', 'declined by the operator'),
      entry('failed', 'disk I/O error'),
    ])
      .map((note) => note.full)
      .join('\n');
    expect(line).toContain('that decision was superseded; its chain ends at d:1805');
    expect(line).toContain("that decision states only 20% of the draft's subject, below 30%");
    expect(line).toContain(
      'that decision, recorded before the draft, states only 57% of its subject, and an older decision needs 85%'
    );
    expect(line).toContain(
      'that decision has not reached this copy of a shared record; sync first'
    );
    expect(line).toContain('the draft was already declined by the operator');
    expect(line).toContain('the settle failed (disk I/O error), so the draft stays pending');
  });

  it('counts the lines past five, and shows a reason it does not know as its code', () => {
    expect(notes([entry('a-newer-reason')], 3).map((note) => note.full)).toEqual([
      'Lines in your last reply took no effect; tell the operator: "Settled: P1 by decision 9" (a-newer-reason).',
      'Tell the operator: 3 more lines had a refusal or note.',
    ]);
    expect(notes([], 2).map((note) => note.full)).toEqual([
      'Tell the operator: 2 more lines had a refusal or note.',
    ]);
  });

  it('fits five complete reasons even when the line or its diagnostic contains long Unicode text', () => {
    const text = 'x' + '😀。'.repeat(1000);
    const batch = notes(
      ['coverage', 'failed', 'superseded', 'low-coverage', 'limit'].map((reason) => ({
        text,
        detail: text,
        reason,
      })),
      2
    );
    expect(batch.map((note) => note.compact).join('\n').length).toBeLessThan(650);
    expect(batch.every((note) => note.full.length < 350)).toBe(true);
    expect(batch.every((note) => !/[\uD800-\uDFFF]/u.test(note.compact))).toBe(true);
    expect(batch.slice(0, 5).map((note) => note.compact)).toEqual([
      expect.stringMatching(/had no effect \(decision covers less than 30% of draft\)\.$/),
      expect.stringMatching(/had no effect \(settle failed; draft pending\)\.$/),
      expect.stringMatching(/had no effect \(decision superseded\)\.$/),
      expect.stringMatching(
        /applied \(low overlap; check that the decision answers the draft\)\.$/
      ),
      expect.stringMatching(/had no effect \(at most three Would record lines\)\.$/),
    ]);
    expect(notes([entry('constructor')])[0].compact).toContain('(constructor)');
  });
});
