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

describe('unkeptNotes (settled item 5)', () => {
  it('names nothing when nothing was lost', () => {
    expect(unkeptNotes({ entries: [], more: 0 })).toEqual([]);
  });

  it('tells the agent to tell the operator about what took no effect, apart from the notes', () => {
    expect(
      unkeptNotes({
        entries: [entry('autonomous'), entry('low-coverage', '57%'), entry('order')],
        more: 0,
      })
    ).toEqual([
      'Lines in your last reply took no effect; tell the operator: "Settled: P1 by decision 9" (that decision was recorded autonomously, so it claims no operator approval).',
      `Lines in your last reply took effect with a note: "Settled: P1 by decision 9" (it took effect, though that decision states only 57% of the draft's subject; check that it answers it); "Settled: P1 by decision 9" (it took effect, but put Settled lines above any Would record lines: an older Reasonbook hook drops the Would record lines above one).`,
    ]);
  });

  it('words each detail: the chain’s end, the share and its floor, a shared copy, a failure', () => {
    const [line] = unkeptNotes({
      entries: [
        entry('superseded', 'd:1805'),
        entry('coverage', '20%'),
        entry('coverage', '57%, recorded before the draft'),
        entry('no-decision', 'sync first'),
        entry('not-pending', 'declined by the operator'),
        entry('failed', 'disk I/O error'),
      ],
      more: 0,
    });
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
    expect(unkeptNotes({ entries: [entry('a-newer-reason')], more: 3 })).toEqual([
      'Lines in your last reply took no effect; tell the operator: "Settled: P1 by decision 9" (a-newer-reason); and 3 more.',
    ]);
    expect(unkeptNotes({ entries: [], more: 2 })).toEqual([
      'Lines in your last reply took no effect; tell the operator: 2 more.',
    ]);
  });
});
