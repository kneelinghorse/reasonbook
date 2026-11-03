// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m03 (#52, E2's rule R-c) — an approval followed by questions about something else reads `other`
// ABOUTME: (agent-judged), not a question about the drafts; the rule only ever turns `question` into `other`.

import { describe, expect, it, jest } from '@jest/globals';

import {
  APPROVAL_PHRASES,
  classifyReply,
  DECLINE_PHRASES,
  PLAIN_REPLY_MAX,
  type ReplyClass,
} from '../../../src/tools/rbook/draft-grammar';
import * as keywords from '../../../src/tools/rbook/keyword-extraction';
import {
  onlyQuestionToOther,
  releasedReplyClass as released,
} from '../../helpers/released-reply-class';

/**
 * A draft's mode depends only on `approval` and `decline` (critic B1), so R-c may change 4.10.0's
 * `question` to `other` and nothing else: every message below is checked against that release.
 */
function expectOnlyQuestionToOther(message: string, drafts: Parameters<typeof classifyReply>[1]) {
  const before = released(message);
  const after = classifyReply(message, drafts);
  expect([message, before, after, onlyQuestionToOther(before, after)]).toEqual([
    message,
    before,
    after,
    true,
  ]);
}

const P7 = {
  id: 7,
  text: 'Store project decisions as one JSON file per decision, because diffs stay readable.',
};

// #52's shape, in other words: two drafts answered in one message whose only question is about
// renaming the project. Its single shared keyword ("time") gives P83 an overlap of 0.13.
const P83 = {
  id: 83,
  text: 'The next sprint hardens migrate, settles answered drafts and releases the next minor version, because loose ends cost the operator time.',
};
const P84 = {
  id: 84,
  text: 'An agent may settle a pending draft by naming the recorded decision that answered it, so no session asks an answered question again.',
};
const RENAME_ASIDE =
  "yes, this looks good. And I'm good with the agent settling a pending draft by naming the recorded decision it answered already.\n\n" +
  "I'm also wondering if its time to update our folder name and our project name and slug? The dashboard needs to do this as well.\n" +
  "We don't have to do it this sprint, but it's something I'd like to clean up soon.";

describe('#52: an approval and a question about something else (settled item 7)', () => {
  it('reads other with both drafts, where 4.10.0 read a question about them', () => {
    expect(released(RENAME_ASIDE)).toBe('question');
    expect(classifyReply(RENAME_ASIDE, [P83, P84])).toBe('other');
    // E2: the same whether the operator writes "its" or "it's".
    expect(classifyReply(RENAME_ASIDE.replace('if its time', "if it's time"), [P83, P84])).toBe(
      'other'
    );
  });

  it('keeps a question about the draft a question, even after an approval', () => {
    expect(classifyReply('yes, but why one file per decision?', [P7])).toBe('question');
  });

  it('never reads it as an approval, however short: PLAIN_REPLY_MAX stays 60', () => {
    expect(PLAIN_REPLY_MAX).toBe(60);
    expect(classifyReply('yes. Also, can we bump the version?', [P7])).toBe('other');
  });
});

/**
 * E2's 25 hand-labelled messages against P7, with the class E2 measured for R-c
 * (rbook/research/2026-11-s109-planning/probes/e2-drafts.md §2): 13 of 15 questions about the draft
 * stay `question`, 6 of 8 unrelated ones read `other`, and both a code-only and a URL-only "?" read
 * `other`.
 */
const BATTERY: ReadonlyArray<readonly [string, 'about' | 'unrelated' | 'code or URL', ReplyClass]> =
  [
    ['yes, but why one file per decision?', 'about', 'question'],
    ['approved?', 'about', 'question'],
    ['why?', 'about', 'question'],
    ['is that right?', 'about', 'question'],
    ['ok — does this also cover the CLI?', 'about', 'question'],
    ['yes. would SQLite not diff better than JSON files?', 'about', 'question'],
    ['P7?', 'about', 'question'],
    ['what about the readable diffs claim, is it measured?', 'about', 'question'],
    ['hmm, what would superseding look like in practice?', 'about', 'question'],
    ['yes. Also, can you rename the folder and the slug later?', 'unrelated', 'other'],
    ['lgtm. separately, when does the dashboard deploy happen?', 'unrelated', 'other'],
    ['yes please.\n\nUnrelated: should we bump the node version in CI?', 'unrelated', 'other'],
    ['yes — see https://example.com/?q=1', 'code or URL', 'other'],
    ['ok `a?b`', 'code or URL', 'other'],
    // Not approval-led: a decline's question keeps the drafts open.
    ['no. can you rename the folder?', 'unrelated', 'question'],
    ['no, why would we?', 'about', 'question'],
    ['yes.\n\nbut does this cover Codex?', 'about', 'question'],
    ['yes.\n\nAlso, why one file per decision?', 'about', 'question'],
    // E2's measured residual: an approval-led follow-up after "Also", sharing no keyword with P7.
    ['yes.\n\nAlso, would SQLite diff better?', 'about', 'other'],
    ['yes this looks good. Also can we rename the folder later?', 'unrelated', 'other'],
    // E2's measured residual: in the first paragraph with no topic word, so it reads as about P7.
    ['ok so what is the plan for the folder rename?', 'unrelated', 'question'],
    ['Sounds good.\nUnrelated, can you check the CI bill for October?', 'unrelated', 'other'],
    [
      "yes, this looks good.\n\nI'm also wondering if it's time to update our folder name and slug?",
      'unrelated',
      'other',
    ],
    // E2's measured residual: "it" is not read as naming the draft.
    ['yes.\n\nAlso, does it cover the CLI?', 'about', 'other'],
    ['yes.\n\nAlso, does that cover the CLI?', 'about', 'question'],
  ];

describe("E2's battery of 25 messages", () => {
  it.each(BATTERY)('%j (%s) reads %s', (message, _kind, expected) => {
    expect(classifyReply(message, [P7])).toBe(expected);
    expectOnlyQuestionToOther(message, [P7]);
  });

  it('matches the measured counts', () => {
    const count = (kind: string, cls: ReplyClass) =>
      BATTERY.filter(([message, k]) => k === kind && classifyReply(message, [P7]) === cls).length;
    expect([BATTERY.length, count('about', 'question'), count('unrelated', 'other')]).toEqual([
      25, 13, 6,
    ]);
    expect(count('code or URL', 'other')).toBe(2);
  });
});

describe('each part of the rule holds a question about the drafts (one test per clause)', () => {
  it('a question that does not start with a topic word is about the drafts, in any paragraph', () => {
    expect(classifyReply('yes, can we rename the folder later?', [P7])).toBe('question');
    // Critic A, round 1 (B2): a later paragraph is no topic word.
    expect(classifyReply("yes.\n\nWhat's the rationale behind it?", [P7])).toBe('question');
    expect(classifyReply('ok wait\n\nwould SQLite diff better?', [P7])).toBe('question');
    // Lines are read as sentences, so a hard-wrapped question's last line starts no topic
    // (verifier A, round 2: "this" made the first version of this case pass either way).
    expect(classifyReply('yes.\n\nAlso, does it\ncover the CLI?', [P7])).toBe('question');
    expect(classifyReply('yes.\n\nPS\nwould SQLite diff better?', [P7])).toBe('question');
  });

  it('a topic word counts at the start of a sentence, alone or after and, but, so, we, I or I’m', () => {
    expect(classifyReply('ok. By the way, can we rename the folder later?', [P7])).toBe('other');
    expect(classifyReply('ok. PS can we rename the folder later?', [P7])).toBe('other');
    expect(classifyReply('yes.\n\nBut also, can we rename the folder later?', [P7])).toBe('other');
    expect(
      classifyReply("yes.\n\nAnd I'm also wondering whether to rename the folder later?", [P7])
    ).toBe('other');
    // Critic A, round 1 (B3): inside a question, "also" is a focus word.
    for (const message of [
      'yes. Does it also cover the CLI?',
      'Sounds good. Can it also handle Codex?',
      'ok. Will it also run on Windows?',
      "yes. Isn't it one more thing to maintain?",
      'yes, also can we rename the folder later?',
    ])
      expect([message, classifyReply(message, [P7])]).toEqual([message, 'question']);
  });

  it('a question naming a bound draft is about it, however it writes the id', () => {
    const message = 'yes.\n\nAlso, could P7 wait until the dashboard deploy finishes?';
    expect(classifyReply(message, [P7])).toBe('question');
    expect(classifyReply(message.replace('P7', 'P 7'), [P7])).toBe('question');
    expect(classifyReply(message.replace('P7', '#7'), [P7])).toBe('question');
    // P8 is not one of the drafts this message answers.
    expect(classifyReply(message.replace('P7', 'P8'), [P7])).toBe('other');
  });

  it('this, that, these, those, draft, proposal or "the decision" point at the drafts', () => {
    const pointing = ['this', 'that', 'these', 'those', 'the draft', 'your draft', 'both drafts'];
    for (const words of [...pointing, 'the proposal', 'the decision'])
      expect([
        words,
        classifyReply(`yes.\n\nAlso, can ${words} wait until the deploy finishes?`, [P7]),
      ]).toEqual([words, 'question']);
  });

  it('with two drafts bound, a question about either one is about the drafts', () => {
    // Verifier B, round 2 (N-A): naming or sharing the subject of one draft is enough.
    expect(
      classifyReply('yes.\n\nAlso, could P7 wait until the dashboard deploy finishes?', [P7, P83])
    ).toBe('question');
    expect(classifyReply('yes.\n\nAlso, why one file per decision?', [P7, P83])).toBe('question');
    // The id is read in any letter case.
    expect(
      classifyReply('yes.\n\nAlso, could p7 wait until the dashboard deploy finishes?', [P7])
    ).toBe('question');
  });

  it('a question holding a decline word is about the drafts', () => {
    expect(classifyReply('yes.\n\nAlso, no — why Postgres?', [P7])).toBe('question');
    // Read normalized: a curly apostrophe and a capital letter are still "don't".
    expect(classifyReply('yes.\n\nAlso, Don’t we need a migration for it?', [P7])).toBe('question');
    expect(classifyReply('yes.\n\nAlso, should we skip the CLI tests for now?', [P7])).toBe(
      'question'
    );
  });

  it('a question of fewer than two keywords is about the drafts', () => {
    expect(classifyReply('yes.\n\nAlso, why?', [P7])).toBe('question');
    // Words without ASCII letters are not keywords (#894), so such a question keeps 4.10.0's class.
    expect(classifyReply('yes.\n\nAlso, можно ли переименовать папку проекта?', [P7])).toBe(
      'question'
    );
  });

  it("a question sharing a quarter of a draft's subject is about it", () => {
    expect(classifyReply('yes.\n\nAlso, why one file per decision?', [P7])).toBe('question');
    // Two subject words, one of them the draft's.
    expect(classifyReply('yes.\n\nAlso, why JSON?', [P7])).toBe('question');
    expect(classifyReply('yes.\n\nAlso, why one file per decision?', [P83])).toBe('other');
    // The boundary (critic B, round 1): one of four subject words is a quarter, one of five is not.
    expect(classifyReply('yes.\n\nAlso, rename alpha beta json?', [P7])).toBe('question');
    expect(classifyReply('yes.\n\nAlso, rename alpha beta gamma json?', [P7])).toBe('other');
  });

  it('only a message that opens with an approval, with no decline word in that clause, can read other', () => {
    expect(classifyReply('hmm.\n\nAlso, can we rename the folder later?', [P7])).toBe('question');
    // An approval phrase is a whole word: "yesterday" opens with no approval.
    expect(
      classifyReply("yesterday's run failed.\n\nAlso, can we rename the folder later?", [P7])
    ).toBe('question');
    for (const opening of ["ok but don't record it yet", 'ok but dont record it yet', 'yes but no'])
      expect([
        opening,
        classifyReply(`${opening}.\n\nAlso, can we rename the folder later?`, [P7]),
      ]).toEqual([opening, 'question']);
  });

  it('only the first clause is read for a decline word', () => {
    // "no problem" sits in the second clause: the message still opens with an approval.
    expect(classifyReply('Sure, no problem.\n\nAlso, can we rename the folder later?', [P7])).toBe(
      'other'
    );
    // A bare dash does not end the first clause, so a retraction keeps the drafts open.
    expect(classifyReply('yes—no wait.\n\nAlso, can we rename the folder later?', [P7])).toBe(
      'question'
    );
  });

  it('an approval word in code is not the operator opening with one', () => {
    expect(
      classifyReply('`npm test` yes, it passes.\n\nAlso, can we rename the folder later?', [P7])
    ).toBe('question');
    expect(classifyReply('```\nyes\n```\n\nAlso, can we rename the folder later?', [P7])).toBe(
      'question'
    );
  });

  it('every question must be about something else', () => {
    expect(
      classifyReply(
        'yes.\n\nAlso, can we rename the folder later? And why one file per decision?',
        [P7]
      )
    ).toBe('question');
  });

  it('after an approval, a "?" only in code, a link target or a URL asks nothing', () => {
    expect(classifyReply('yes, see [the notes](notes.md?v=2)', [P7])).toBe('other');
    expect(classifyReply('yes\n\n```\nwhy?\n```', [P7])).toBe('other');
    // A link's text is prose: its "?" asks.
    expect(classifyReply('[why?](notes.md)', [P7])).toBe('question');
    // Critic A, round 1: any other message keeps 4.10.0's question, whatever proseLines reads as code.
    expect(classifyReply('hmm `a?b`', [P7])).toBe('question');
    expect(classifyReply('no — see https://x.test/?q=1', [P7])).toBe('question');
  });

  it('a "?" after a URL ends the sentence, not the URL (critic A, round 1: B1)', () => {
    expect(classifyReply('yes, but did you see https://github.com/org/repo/issues/12?', [P7])).toBe(
      'question'
    );
    expect(
      classifyReply(
        'yes.\n\nAlso, can we rename the folder later? And does this clash with https://x.test/y?',
        [P7]
      )
    ).toBe('question');
    expect(classifyReply('ok, is this the same as <https://x.test/y>?', [P7])).toBe('question');
    expect(classifyReply('yes, but (did you see https://x.test/adr?)', [P7])).toBe('question');
    // Verifier A, round 2 (F1, T2): whatever follows the "?", markup, quotes or an emoji included.
    for (const message of [
      'yes. **Did you see https://x.test/y?**',
      'yes. Is this the same as “https://x.test/y?”',
      'yes. _did you check https://x.test/y?_',
      'yes, but did you see https://x.test/issues/12?…',
      'yes, did you see https://x.test/issues/12?*',
      'yes, did you see https://x.test/issues/12?~',
      'yes. Is it «https://x.test/y?»',
      'yes. Is it ‘https://x.test/y?’',
      'yes. Did you see https://x.test/y?🙂',
      'yes. Did you see https://x.test/y?\u200b',
      'yes (see https://x.test/y?)',
      'yes, did you see "https://x.test/y?"',
      'yes, did you see https://x.test/y?.',
    ])
      expect([message, classifyReply(message, [P7])]).toEqual([message, 'question']);
    // Each query character alone keeps the "?" the URL's (round 3, T3).
    for (const tail of ['a?/', 'a?#', 'a?-', 'a?=', 'a?&', 'a?%', 'a?+', 'a?9'])
      expect([tail, classifyReply(`yes — see https://x.test/${tail}`, [P7])]).toEqual([
        tail,
        'other',
      ]);
    // A query or fragment after the "?" is still the URL's.
    for (const tail of [
      '?q=1',
      'notes?v=2',
      'a_b?c=d_',
      '?q=json*',
      'a?b=',
      'a?#frag',
      'a?/b',
      '?q=a+b',
      '?%20',
    ])
      expect([tail, classifyReply(`yes — see https://x.test/${tail}`, [P7])]).toEqual([
        tail,
        'other',
      ]);
  });
});

describe('what the build critic must try (the design, m03)', () => {
  it.each([
    ['yes?', 'question'],
    ['yes!\n\nP7?', 'question'],
    ['yes.\n\nAlso, no — why that?', 'question'],
  ] as const)('%j reads %s', (message, expected) => {
    expect(classifyReply(message, [P7])).toBe(expected);
    expect(classifyReply(message, [])).toBe(expected);
  });

  it('a quoted approval is not the operator opening with one', () => {
    expect(classifyReply('> yes, ship it\n\nAlso, can we rename the folder later?', [P7])).toBe(
      'question'
    );
    expect(classifyReply('> Should I record P7?\n\nyes', [P7])).toBe('question');
  });

  it('a question right after a code block is read', () => {
    expect(
      classifyReply('yes, run this\n```\nnpm test\n```\ncan we rename the folder later?', [P7])
    ).toBe('question');
  });

  it('the opening is the first paragraph, which a blank line inside code does not end', () => {
    // Verifier A, round 2: the "no wait" below the fence is still in the opening's first clause.
    expect(
      classifyReply('yes\n```\ncode\n\n```\nno wait.\nAlso, can we rename the folder later?', [P7])
    ).toBe('question');
    // Blank lines before the message do not hide its opening.
    expect(classifyReply('\n\nyes.\n\nAlso, can we rename the folder later?', [P7])).toBe('other');
    // A blank line is spaces and tabs only, as CommonMark has it: a no-break space or another
    // Unicode space does not end the paragraph, so "no wait" stays in the opening (round 3, O1).
    for (const space of ['\u00a0', '\u3000', '\u2002', '\u202f'])
      expect([
        space,
        classifyReply(`yes\n${space}\nno wait. Also, can we rename the folder later?`, [P7]),
      ]).toEqual([space, 'question']);
  });
});

describe('the rule never makes an approval or a decline (critic B1)', () => {
  const openers = [
    ...APPROVAL_PHRASES,
    ...DECLINE_PHRASES,
    'please',
    'thanks',
    'yes no',
    'no, yes',
    'hmm',
    '> yes',
    '**yes**',
    '`yes`',
    '',
    'Yes!!',
    'OK…',
    'sure —',
    'да',
  ];
  const joins = ['', '?', '.', ', ', '. ', '!\n', '\n\n', ' — ', '?\n\n'];
  const tails = [
    '',
    'why?',
    'P7?',
    'Also, can we rename the folder later?',
    'does that cover the CLI?',
    'record it?',
    'skip it',
    'see https://x.test/?a=1',
    '`a?b`',
    'Также, можно ли?',
    'no?',
    'yes?',
    'approved',
  ];

  it('over every opener, join and tail, with no draft, one or two', () => {
    let checked = 0;
    for (const opener of openers)
      for (const join of joins)
        for (const tail of tails)
          for (const drafts of [[], [P7], [P7, P83]]) {
            expectOnlyQuestionToOther(`${opener}${join}${tail}`, drafts);
            checked++;
          }
    expect(checked).toBe(openers.length * joins.length * tails.length * 3);
  });

  it('over the battery with every draft set', () => {
    for (const [message] of BATTERY)
      for (const drafts of [[], [P7], [P83, P84], [P7, P83, P84]])
        expectOnlyQuestionToOther(message, drafts);
    expectOnlyQuestionToOther(RENAME_ASIDE, [P83, P84]);
  });
});

describe('the prompt hook reads a pasted message inside its budget', () => {
  // A quarter of the prompt hook's 800 ms, which also holds its store reads and writes.
  const BUDGET_MS = 200;
  /**
   * The fastest of up to five runs. A pause another process causes slows one run: the release's
   * load check measured 238 ms for a read that takes 2 ms alone. A cost that grows with the message
   * slows every run.
   */
  const fastestMs = (read: () => void): number => {
    let fastest = Infinity;
    for (let run = 0; run < 5 && fastest >= BUDGET_MS; run++) {
      const started = Date.now();
      read();
      fastest = Math.min(fastest, Date.now() - started);
    }
    return fastest;
  };
  /** Three drafts at the published maximum of 1,000 characters, each of its own words. */
  const FULL = [1, 2, 3].map((n) => ({
    id: 100 + n,
    text: Array.from({ length: 200 }, (_, i) => `w${n}x${i}`)
      .join(' ')
      .slice(0, 1_000),
  }));

  it('reads long runs of punctuation in a question in linear time', () => {
    const run = '-'.repeat(3_000);
    const message = `yes, a${run}b${run}c${run}d?`;
    expect(message.length).toBeLessThanOrEqual(10_000);
    // E2's prototype topic test backtracked cubically here: 1.3 s at runs of 1,000, 78 s at 4,000.
    expect(fastestMs(() => expect(classifyReply(message, [P7])).toBe('question'))).toBeLessThan(
      BUDGET_MS
    );
  });

  it('reads many questions about something else against three full-length drafts', () => {
    const message = `yes.\n\n${'Also, abc def? '.repeat(660)}`;
    expect(message.length).toBeLessThanOrEqual(10_000);
    expect(fastestMs(() => expect(classifyReply(message, FULL)).toBe('other'))).toBeLessThan(
      BUDGET_MS
    );
  });

  it('reads each draft once, however many questions the message asks', () => {
    const extract = jest.spyOn(keywords, 'extractKeywords');
    try {
      const questions = 400;
      expect(classifyReply(`yes.\n\n${'Also, abc def? '.repeat(questions)}`, FULL)).toBe('other');
      // Two reads a question (its keywords, its subject) and one a draft. Reading every draft again
      // for each question made it five a question: 150 ms cold (critic A, round 1: B4).
      expect(extract.mock.calls.length).toBeLessThanOrEqual(2 * questions + FULL.length);
    } finally {
      extract.mockRestore();
    }
  });

  it('a message past 10,000 characters keeps the released class', () => {
    const long = (size: number) =>
      `yes.\n\n${'The background runs on. '.repeat(Math.ceil(size / 23))}\n\nAlso, can we rename the folder later?`;
    expect(long(9_000).length).toBeLessThan(10_000);
    expect(classifyReply(long(9_000), [P7])).toBe('other');
    expect(long(10_500).length).toBeGreaterThan(10_000);
    expect(classifyReply(long(10_500), [P7])).toBe('question');
    // A megabyte of backtick runs of 1,400 lengths took 3 s to read as prose.
    const ticks = `yes ${Array.from({ length: 1_400 }, (_, i) => '`'.repeat(i + 1)).join(' x ')}?`;
    expect(fastestMs(() => expect(classifyReply(ticks, [P7])).toBe('question'))).toBeLessThan(
      BUDGET_MS
    );
  });
});
