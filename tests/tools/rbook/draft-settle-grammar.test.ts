// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — the "Settled: P<n> by decision <N>" reply line: only a plain line in the trailing block settles,
// ABOUTME: every other form or place is named as not kept, and any draft a Settled line names leaves the shown set.

import { describe, expect, it } from '@jest/globals';

import { readDraftReply } from '../../../src/tools/rbook/draft-grammar';
import { readSettles } from '../../../src/tools/rbook/draft-settle-grammar';

const WOULD = 'Would record: Store decisions as JSON files because they diff cleanly.';
const OTHER = 'Would record: Keep one SQLite store per project because sync expects it.';

describe('readSettles: a plain line in the trailing block settles (settled item 1)', () => {
  it('reads a Settled line above the Would record lines, and the Would record line still drafts', () => {
    const reply = `The operator's yes was recorded as decision 1802.\n\nSettled: P81 by decision 1802\n${WOULD}`;
    expect(readSettles(reply)).toEqual({
      settles: [
        { draftId: 81, decisionId: 1802, text: 'Settled: P81 by decision 1802', misplaced: false },
      ],
      unkept: [],
      named: [81],
    });
    expect(readDraftReply(reply).lines.map((line) => line.text)).toEqual([WOULD.slice(14)]);
  });

  it('accepts a # before the decision id, a trailing period and any letter case in the words', () => {
    expect(readSettles('settled: p81 BY Decision #1802.').settles).toEqual([
      { draftId: 81, decisionId: 1802, text: 'settled: p81 BY Decision #1802.', misplaced: false },
    ]);
  });

  it('reads a reply that is only Settled lines, each in order', () => {
    const reply = 'Done.\n\nSettled: P81 by decision 1802\nSettled: P78 by decision 1801';
    expect(readSettles(reply).settles.map((line) => [line.draftId, line.decisionId])).toEqual([
      [81, 1802],
      [78, 1801],
    ]);
  });

  it('reads any interleaving in full, applying a Settled line below or between Would record lines and naming it (critic B3, note 1)', () => {
    const reply = `Two choices.\n\n${WOULD}\nSettled: P81 by decision 1802\n${OTHER}`;
    expect(readDraftReply(reply).lines).toHaveLength(2);
    expect(readSettles(reply)).toEqual({
      settles: [
        { draftId: 81, decisionId: 1802, text: 'Settled: P81 by decision 1802', misplaced: true },
      ],
      unkept: [],
      named: [81],
    });
    const below = readSettles(`Done.\n\n${WOULD}\nSettled: P81 by decision 1802`);
    expect(below.settles[0].misplaced).toBe(true);
  });
});

describe('readSettles: other forms and places are not kept, and still take the draft out of the shown set', () => {
  it.each([
    ['quote-marked', '> Settled: P81 by decision 1802'],
    ['list-marked', '- Settled: P81 by decision 1802'],
    ['numbered', '1. Settled: P81 by decision 1802'],
    ['bold-labelled', '**Settled:** P81 by decision 1802'],
    ['wholly bold', '**Settled: P81 by decision 1802**'],
    ['inline code', '`Settled: P81 by decision 1802`'],
    ['link text', '[Settled: P81 by decision 1802](https://example.com/d/1802)'],
    ['wrongly worded', 'Settled: P81 by the decision we recorded'],
    ['with words after', 'Settled: P81 by decision 1802, the operator said yes'],
  ])('%s: listed as not kept, form', (_shape, line) => {
    const reply = `Settling it.\n\n${line}\n${WOULD}`;
    expect(readSettles(reply)).toEqual({
      settles: [],
      unkept: [{ text: line, reason: 'form', draftId: 81 }],
      named: [81],
    });
    // A Settled-labelled line of any form does not end the trailing block above it.
    expect(readDraftReply(reply).lines).toHaveLength(1);
  });

  it('finds a Settled line inside a fence, which never settles', () => {
    const reply = `Like this:\n\n\`\`\`\nSettled: P81 by decision 1802\n\`\`\``;
    expect(readSettles(reply)).toEqual({
      settles: [],
      unkept: [{ text: 'Settled: P81 by decision 1802', reason: 'form', draftId: 81 }],
      named: [81],
    });
  });

  it('names a plain Settled line outside the trailing block for its place', () => {
    const reply = `Settled: P81 by decision 1802\n\nThen I fixed the tests.`;
    expect(readSettles(reply)).toEqual({
      settles: [],
      unkept: [{ text: 'Settled: P81 by decision 1802', reason: 'place', draftId: 81 }],
      named: [81],
    });
  });

  it('names a Settled line above an inline-labelled last line for its place (critic B3, note 4)', () => {
    const reply = `Settled: P81 by decision 1802\nShall we keep JSON? Would record: Store decisions as JSON files because they diff cleanly.`;
    expect(readDraftReply(reply).lines).toHaveLength(1);
    expect(readSettles(reply)).toEqual({
      settles: [],
      unkept: [{ text: 'Settled: P81 by decision 1802', reason: 'place', draftId: 81 }],
      named: [81],
    });
  });

  it('names a Settled line in the trailing block that names no draft, and ignores prose elsewhere that starts with Settled', () => {
    expect(readSettles(`Done.\n\nSettled: we keep JSON.`)).toEqual({
      settles: [],
      unkept: [{ text: 'Settled: we keep JSON.', reason: 'form', draftId: null }],
      named: [],
    });
    expect(readSettles(`Settled: we keep JSON.\n\nMore prose follows.`)).toEqual({
      settles: [],
      unkept: [],
      named: [],
    });
  });

  it('names a draft once however many Settled lines name it', () => {
    const reply = `> Settled: P81 by decision 1802\n\nprose\n\nSettled: P81 by decision 1802`;
    expect(readSettles(reply).named).toEqual([81]);
  });
});

describe('critic B, round 1: every leading mark, every draft named, one line, one settle', () => {
  it.each([
    ['heading', '## Settled: P81 by decision 1802'],
    ['emoji first', '✅ Settled: P81 by decision 1802'],
    ['strikethrough', '~~Settled: P81 by decision 1802~~'],
    ['table cell', '| Settled: P81 by decision 1802 |'],
    ['HTML comment', '<!-- Settled: P81 by decision 1802 -->'],
    ['line comment', '// Settled: P81 by decision 1802'],
  ])('B2: a Settled line behind a %s is named as not kept, and names its draft', (_form, line) => {
    expect(readSettles(`Settling it.\n\n${line}`)).toEqual({
      settles: [],
      unkept: [{ text: line, reason: 'form', draftId: 81 }],
      named: [81],
    });
  });

  it('B1: a Settled line naming two drafts takes both out of the shown set', () => {
    expect(readSettles('Done.\n\nSettled: P1 and P2 by decision 9').named).toEqual([1, 2]);
  });

  it('note 2: "Settled: …. Would record: …" as one last line still drafts, as 4.10.0 reads it', () => {
    const reply = `Done.\n\nSettled: P81 by decision 1802. ${WOULD}`;
    expect(readDraftReply(reply).lines.map((line) => line.text)).toEqual([WOULD.slice(14)]);
    expect(readSettles(reply)).toMatchObject({ settles: [], named: [81] });
  });

  it('note 4: the same settle twice is one settle', () => {
    const reply = 'Done.\n\nSettled: P81 by decision 1802\nSettled: P81 by decision 1802';
    expect(readSettles(reply).settles).toHaveLength(1);
    expect(readSettles(reply).unkept).toEqual([]);
  });
});

describe('the inline label stays the last line’s own (decision #1829)', () => {
  it('reads an inline Would record label only on the reply’s last line, even with a Settled line below it', () => {
    const reply = `Shall we? ${WOULD}\nSettled: P81 by decision 1802`;
    expect(readDraftReply(reply).lines).toEqual([]);
    expect(readSettles(reply).settles).toEqual([
      { draftId: 81, decisionId: 1802, text: 'Settled: P81 by decision 1802', misplaced: false },
    ]);
  });
});

describe('readDraftReply: the lines it does not keep, with why (settled item 5, #51)', () => {
  it('names a fourth Would record line, an unpublished kind and a placeholder', () => {
    const lines = [
      'Would record: Store decisions as JSON files because they diff cleanly.',
      'Would record (wish): Ship it on a Friday because the team is in.',
      'Would record: Keep one SQLite store per project because sync expects it.',
      'Would record: <decision and reason>',
      'Would record: Log every hook call because the load gate reads them.',
      'Would record: Cap the digest at four thousand characters for the token budget.',
    ];
    const read = readDraftReply(`Four choices.\n\n${lines.join('\n')}`);
    expect(read.lines).toHaveLength(3);
    expect(read.droppedLines).toEqual([
      { text: lines[1], reason: 'kind' },
      { text: lines[3], reason: 'text' },
      { text: lines[5], reason: 'limit' },
    ]);
    expect(read.dropped).toBe(3);
  });
});
