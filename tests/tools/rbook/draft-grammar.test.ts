// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — the published grammar of a drafted record and of the operator's reply to it.
// ABOUTME: A draft is only what the agent put to the operator at the end; a reply binds only in plain words.

import { describe, expect, it } from '@jest/globals';

import { sanitizeContentField } from '../../../src/intelligence/content-sanitizer';
import {
  APPROVAL_PHRASES,
  classifyReply,
  DECLINE_PHRASES,
  extractDraftLines,
  keywordOverlap,
  proseLines,
  readDraftReply,
} from '../../../src/tools/rbook/draft-grammar';

describe('extractDraftLines: what becomes a draft', () => {
  it.each(['    ', '\t', '>     '])('keeps over-indented %s fence markers literal', (prefix) => {
    const opening = prefix.startsWith('>') ? '> ```text' : '```text';
    const reply = [
      opening,
      `${prefix}\`\`\``,
      'draft P1 stores decisions as JSON.',
      'Would record: Store decisions as JSON files because they diff.',
    ].join('\n');
    expect(proseLines(reply).join('\n')).not.toContain('draft P1');
    expect(extractDraftLines(reply)).toEqual([]);
  });
  it.each(['    ', '\t'])('does not extract prose or a draft from indented code', (prefix) => {
    const reply = `${prefix}draft P1 stores decisions as JSON.\n${prefix}Would record: Store decisions as JSON files because they diff.`;
    expect(proseLines(reply).join('\n')).not.toContain('draft P1');
    expect(extractDraftLines(reply)).toEqual([]);
  });
  it.each(['- ', '> '])(
    'does not treat literal %s inside a fence as a new closing container',
    (prefix) => {
      const reply = [
        '```text',
        `${prefix}\`\`\``,
        'draft P1 stores decisions as JSON.',
        'Would record: Store decisions as JSON files because they diff.',
      ].join('\n');
      expect(proseLines(reply).join('\n')).not.toContain('draft P1');
      expect(extractDraftLines(reply)).toEqual([]);
    }
  );

  it.each(['> ', '> > ', '- '])(
    'keeps fences inside the %s container out of prose and drafts',
    (prefix) => {
      const reply = `${prefix}\`\`\`text\n${prefix}draft P1 stores decisions as JSON.\n${prefix}Would record: Store decisions as JSON files because they diff.`;
      expect(proseLines(reply).join('\n')).not.toContain('draft P1');
      expect(extractDraftLines(reply)).toEqual([]);
    }
  );

  it('takes the trailing "Would record:" line as a decision draft', () => {
    const reply =
      'I would store them as JSON files: diffable and simple.\n\n' +
      'Would record: Store decisions as one JSON file each, because diffs stay readable.';
    expect(extractDraftLines(reply)).toEqual([
      {
        kind: 'decision',
        text: 'Store decisions as one JSON file each, because diffs stay readable.',
        evidence: [],
      },
    ]);
  });

  it('names the kind in parentheses, and refuses kinds the convention does not publish', () => {
    const reply =
      'Two things to settle.\n' +
      'Would record (constraint): Never push to main without a green CI run on the branch.\n' +
      'Would record (learning): Retries hide flaky fixtures more often than they fix them.\n' +
      'Would record (profile): Ask before running any command that spends money.';
    const lines = extractDraftLines(reply);
    // The unpublished kind is dropped, but it does not end the trailing block above it.
    expect(lines.map((line) => line.kind)).toEqual(['constraint', 'profile']);
    expect(lines[0].text).toBe('Never push to main without a green CI run on the branch.');
  });

  it('accepts an explicit decision kind just as it accepts the default kind', () => {
    const text = 'Store decisions as one JSON file each, because diffs stay readable.';
    expect(extractDraftLines(`Would record (decision): ${text}`)).toEqual([
      { kind: 'decision', text, evidence: [] },
    ]);
  });

  it('keeps at most three lines, in reading order', () => {
    const reply = [
      'Options below.',
      'Would record: Use SQLite for the cache because reads dominate writes.',
      'Would record: Keep the cache under the config directory, never in the repo.',
      'Would record: Expire cache entries after seven days of no reads at all.',
      'Would record: Log cache misses only at debug level to keep output quiet.',
    ].join('\n');
    expect(extractDraftLines(reply).map((line) => line.text)).toEqual([
      'Use SQLite for the cache because reads dominate writes.',
      'Keep the cache under the config directory, never in the repo.',
      'Expire cache entries after seven days of no reads at all.',
    ]);
  });

  it('takes a label that starts the last sentence of the final line (a Sonnet replay ended so)', () => {
    const reply =
      'Here is the tradeoff.\n\nShould I count the flagged learnings first? Would record: Deprecate the ' +
      'evergreen flag on learnings in favour of promote-to-document, because permanent facts belong in documents.';
    const read = readDraftReply(reply);
    expect(read.lines).toEqual([
      expect.objectContaining({
        kind: 'decision',
        text: 'Deprecate the evergreen flag on learnings in favour of promote-to-document, because permanent facts belong in documents.',
      }),
    ]);
    expect(read.excerpt.endsWith('Should I count the flagged learnings first?')).toBe(true);
    // Mid-sentence, or anywhere but the final line, it is a mention.
    expect(extractDraftLines('The line reads Would record: X, Y and Z decided now.')).toEqual([]);
    expect(
      extractDraftLines(
        'Done? Would record: Use one JSON file per decision always.\nThanks for checking.'
      )
    ).toEqual([]);
  });

  it('ignores a mention in the middle of a reply: this repository explains the convention in prose', () => {
    const reply =
      'The agent ends a proposal with a line like\n' +
      'Would record: Store decisions as JSON files because they diff well.\n' +
      'and the hook binds your next message to it.';
    expect(extractDraftLines(reply)).toEqual([]);
    expect(readDraftReply(reply).elsewhere).toBe(1);
  });

  it.each(['For example:', 'For example, e.g.', 'That is, i.e.', 'Other examples, etc.'])(
    'does not turn a convention example after "%s" into a draft',
    (prefix) => {
      expect(
        extractDraftLines(
          `${prefix} Would record: Store decisions as JSON files because they diff well.`
        )
      ).toEqual([]);
    }
  );

  it('never reads a line inside a fenced block, even at the very end', () => {
    const fenced =
      'Example:\n```\nWould record: Store decisions as JSON files because they diff well.\n```';
    expect(extractDraftLines(fenced)).toEqual([]);
    const unclosed =
      'Example:\n```text\nWould record: Store decisions as JSON files, they diff well.';
    expect(extractDraftLines(unclosed)).toEqual([]);
  });

  it.each([
    { opening: '````text', falseClosing: '```' },
    { opening: '~~~~text', falseClosing: '~~~' },
    { opening: '```text', falseClosing: '```typescript' },
    { opening: '~~~text', falseClosing: '~~~typescript' },
  ])('keeps code fenced after $falseClosing inside $opening', ({ opening, falseClosing }) => {
    const reply = [
      'Example:',
      opening,
      falseClosing,
      'draft P1 Store decisions as JSON files because they diff well.',
      'Would record: Store decisions as JSON files because they diff well.',
    ].join('\n');
    expect({
      drafts: extractDraftLines(reply),
      prose: proseLines(reply).join('\n').trim(),
    }).toEqual({
      drafts: [],
      prose: 'Example:',
    });
  });

  it.each(['```', '~~~'])(
    'returns to prose after a longer closing %s fence with whitespace',
    (marker) => {
      const text = 'Store decisions as JSON files because they diff well.';
      const reply = `Example:\n${marker}text\ninside code\n${marker}${marker[0]}  \nWould record: ${text}`;
      expect(extractDraftLines(reply)).toEqual([{ kind: 'decision', text, evidence: [] }]);
    }
  );

  it('accepts the markdown an agent wraps around the line or its label', () => {
    const variants = [
      '**Would record:** Use one AGENTS.md per project as the single rules file.',
      '**Would record: Use one AGENTS.md per project as the single rules file.**',
      '`Would record: Use one AGENTS.md per project as the single rules file.`',
      '- Would record: Use one AGENTS.md per project as the single rules file.',
      '> Would record: Use one AGENTS.md per project as the single rules file.',
      '**Would record**: Use one AGENTS.md per project as the single rules file.',
      'would record: Use one AGENTS.md per project as the single rules file.',
    ];
    for (const line of variants) {
      expect(extractDraftLines(`Done.\n\n${line}`)).toEqual([
        {
          kind: 'decision',
          text: 'Use one AGENTS.md per project as the single rules file.',
          evidence: ['AGENTS.md'],
        },
      ]);
    }
  });

  // s107-m02 (#875): a mark right after the label opens the text unless it closes one opened before
  // the label, so a line that starts with a code span keeps its opening backtick, and the content
  // sanitizer then keeps the tag the span quotes instead of cutting the record there.
  it('keeps the code span or emphasis that opens the text after the label', () => {
    const tag = ['<', 'parameter', '>'].join('');
    const text = `\`${tag}\` tags stay quoted in imported notes, so the record keeps them whole.`;
    const lines = [
      `Would record: ${text}`,
      `Answered both questions. Would record: ${text}`,
      `**Would record:** ${text}`,
      `**Would record**: ${text}`,
    ];
    for (const line of lines) {
      const [draft] = extractDraftLines(`Done.\n\n${line}`);
      expect(draft?.text).toBe(text);
      expect(sanitizeContentField(draft.text)).toEqual({ cleaned: text, wasModified: false });
    }
    const bold = '**Keep** one AGENTS.md per project as the single rules file.';
    expect(extractDraftLines(`Done.\nWould record: ${bold}`)[0]?.text).toBe(bold);
  });

  // s107-m02 (round-2 critic): the words left beside a placeholder are counted in letters of any
  // script, a run of letters or digits being one word.
  it('keeps a choice in any script that quotes a tag, while a placeholder in it still drops', () => {
    const tag = ['<', 'parameter', '>'].join('');
    for (const text of [
      `Удалять лишнюю разметку из импортированных заметок перед записью, например \`${tag}\` теги.`,
      `Αφαιρούμε την περιττή σήμανση από τις σημειώσεις πριν την εγγραφή, όπως τις \`${tag}\`.`,
    ])
      expect(extractDraftLines(`Готово.\nWould record: ${text}`)[0]?.text).toBe(text);
    expect(extractDraftLines('Готово.\nWould record: `<решение и причина>`')).toEqual([]);
  });

  // s107-m02 round 4 (decision #1762): Japanese and Chinese write no spaces between words, so a run
  // of kanji, kana or hanzi between punctuation marks was one "word" and these lines, which drafted
  // before the mission, stopped drafting. Each Han, Hiragana or Katakana character is now a word.
  it('keeps a Japanese or Chinese choice that names a tag and has no mid-sentence comma', () => {
    const tag = ['<', 'parameter', '>'].join('');
    for (const text of [
      `インポートしたメモの \`${tag}\` タグはバッククォートで囲んで記録します。`,
      `导入笔记时保留 \`${tag}\` 标签并用反引号括起来以免记录被截断。`,
    ])
      expect(extractDraftLines(`完了。\nWould record: ${text}`)[0]?.text).toBe(text);
    // A placeholder in those scripts is still one.
    expect(extractDraftLines('完了。\nWould record: `<決定と理由>`')).toEqual([]);
  });

  // s107-m02 round 5 (decision #1762): a tool-call tag, a URL or a generic written onto a name is
  // content, not a placeholder, so lines naming two or four tags draft in every script, and terse
  // lines naming code keep drafting; the minimum and its increments count placeholders only.
  it('keeps lines naming several tags, generics or URLs, in Chinese, Japanese and English', () => {
    const [invoke, parameter, content, calls] = [
      'invoke',
      'parameter',
      'content',
      'function_calls',
    ].map((name) => ['<', name, '>'].join(''));
    for (const text of [
      `保留笔记中的 \`${invoke}\` 和 \`${parameter}\` 标签以免记录被截断。`,
      `记录前把 \`${invoke}\` 和 \`${parameter}\` 标签放进反引号里。`,
      `メモの \`${invoke}\` と \`${parameter}\` タグは必ず引用符で囲む。`,
      `导入笔记时把 \`${content}\`、\`${parameter}\`、\`${invoke}\` 和 \`${calls}\` 标签都放进反引号里以免记录被截断。`,
      `Keep \`${invoke}\` and \`${parameter}\` tags quoted.`,
      'Prefer `ReadonlyArray<T>` over `Array<T>`.',
      'Return `Promise<void>`, never `Promise<boolean>`.',
      'Cite <https://a.example/x> and <https://b.example/y> as sources.',
    ])
      expect(extractDraftLines(`Done.\nWould record: ${text}`)[0]?.text).toBe(text);
  });

  it('asks for both increments beside placeholders: two more words and ten more characters each', () => {
    // Four words and 27 characters beside two placeholders: the word increment drops it.
    expect(
      extractDraftLines('A.\nWould record: `<choice>` beats everything else here: `<reason>`')
    ).toEqual([]);
    // Fifteen Japanese words and fifteen characters beside two placeholders: past the base
    // minimum, so only the character increment drops it.
    expect(
      extractDraftLines('A.\nWould record: `<決定>` を採用した理由は次のとおりです `<理由>`')
    ).toEqual([]);
  });

  it('reads a line of many < and no > in linear time', () => {
    // Words first, so the whole-line check passes and the span matching runs.
    const line = `Would record: Keep these notes ${'<'.repeat(200_000)} quoted.`;
    const started = Date.now();
    extractDraftLines(`A.\n${line}`);
    const elapsed = Date.now() - started;
    // Quadratic span matching took 9.4 s on this line (s107-m02 round-4 critic).
    expect(elapsed).toBeLessThan(2_000);
  });

  // s107-m02 round 4: each further span asks for more words beside it, so slots joined by
  // connectors stay a template, while a real line naming two tags still drafts.
  it('drops a template of two slots and connectors, and keeps a real line naming two tags', () => {
    for (const text of [
      '`<decision>` and the reason: `<reason>`',
      '`<choice>`, chosen over `<alternative>` because `<reason>`',
      '`<решение>` и причина: `<причина>`',
      '`<決定>` とその理由: `<理由>`',
    ])
      expect(extractDraftLines(`Answer.\nWould record: ${text}`)).toEqual([]);
    const [invoke, parameter] = [
      ['<', 'invoke', '>'],
      ['<', 'parameter', '>'],
    ].map((parts) => parts.join(''));
    const real = `Keep \`${invoke}\` and \`${parameter}\` tags in backticks when recording a note.`;
    expect(extractDraftLines(`Answer.\nWould record: ${real}`)[0]?.text).toBe(real);
  });

  // s107-m02 round-5 critic: only an ASCII name written right onto its `<` makes a generic.
  // Chinese, Japanese and Korean write a placeholder onto the word before it, and a code-span
  // mark between a word and its `<` makes a slot, so these templates drafted and recorded.
  it('drops a template whose placeholders are written onto the word before them', () => {
    for (const text of [
      '決定は`<決定>` 理由は`<理由>` です。',
      '决定是`<决定>` 理由是`<理由>` 。',
      '결정은`<결정>` 이유는`<이유>` 입니다.',
      '決定は<決定> 理由は<理由> です。',
      'Adopt`<decision>` because`<reason>` here.',
      // Emphasis opened right on a slot and closed elsewhere (s107-m02 round-6 critic).
      '_<decision>, chosen because <reason>_',
      '__<decision>, chosen because <reason>__',
    ])
      expect(extractDraftLines(`Answer.\nWould record: ${text}`)).toEqual([]);
    for (const text of ['Prefer `ReadonlyArray<T>` over `Array<T>`.', 'Return Promise<void> here.'])
      expect(extractDraftLines(`Answer.\nWould record: ${text}`)[0]?.text).toBe(text);
  });

  // A slot named after a tool-call tag is still a slot: only the bare tag name, or the tag with
  // name="…" attributes as a call writes it, is the tag (s107-m02 round-5 critic).
  it('drops a slot whose name only starts with a tool-call tag name', () => {
    const tag = (inner: string): string => ['<', inner, '>'].join('');
    for (const line of [
      `Would record: \`${tag('content and reason')}\``,
      `Would record (constraint): \`${tag('content of the constraint')}\``,
      `Would record: \`${tag('parameter value')}\` because \`${tag('reason')}\``,
    ])
      expect(extractDraftLines(`Answer.\n${line}`)).toEqual([]);
    for (const quoted of [
      `Quote \`${tag('parameter name="content"')}\` and \`${tag('/parameter')}\` in notes.`,
      // Terse, so it drafts only while both tags with attributes read as tags (round-6 critic).
      `Keep \`${tag('invoke name="a"')}\` and \`${tag('parameter name="b"')}\` quoted.`,
    ])
      expect(extractDraftLines(`Answer.\nWould record: ${quoted}`)[0]?.text).toBe(quoted);
  });

  it('drops placeholders, "nothing", and text too short to be a decision', () => {
    for (const text of [
      '<decision and reason>',
      // s107-m02: a placeholder in a code span or emphasis is still one, now the mark stays.
      '`<decision and reason>`',
      '**<decision and reason>**',
      '*<constraint and its reason>*',
      '_<decision and reason>_.',
      '`<decision>` and `<reason>`',
      '<proposed decision and reason>.',
      'nothing',
      'Nothing to record this time.',
      'none',
      'N/A',
      'no decision here yet',
      'Use JSON.',
      'ok',
    ]) {
      expect(extractDraftLines(`Answer.\nWould record: ${text}`)).toEqual([]);
    }
  });

  it('keeps the links and documents the line names as evidence', () => {
    const [line] = extractDraftLines(
      'See the doc.\nWould record: Adopt the layout in rbook/planning/s94-layout.md and ' +
        '[the mockup](https://example.com/mock.html), because both reviewers preferred it.'
    );
    expect(line.evidence).toEqual([
      'https://example.com/mock.html',
      'rbook/planning/s94-layout.md',
    ]);
  });

  it('cuts text past 1,000 characters at a word', () => {
    const long = `Adopt ${'the very long rationale '.repeat(80)}end.`;
    const [line] = extractDraftLines(`x\nWould record: ${long}`);
    expect(line.text.length).toBeLessThanOrEqual(1000);
    expect(line.text.endsWith('…')).toBe(true);
    // The cut falls between words: what precedes the ellipsis is followed by a space in the source.
    const kept = line.text.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long[kept.length]).toBe(' ');
  });

  it('reports the reply text before the lines, for the draft excerpt', () => {
    const reply = `${'a'.repeat(700)}\nI recommend JSON.\n\nWould record: Store decisions as JSON files because they diff well.`;
    const read = readDraftReply(reply);
    expect(read.lines).toHaveLength(1);
    expect(read.excerpt.endsWith('I recommend JSON.')).toBe(true);
    expect(read.excerpt.length).toBeLessThanOrEqual(600);
  });

  it('treats CRLF and trailing blank lines like any other reply', () => {
    const reply =
      'Answer.\r\n\r\nWould record: Store decisions as JSON files because they diff.\r\n\r\n';
    expect(extractDraftLines(reply)).toHaveLength(1);
  });
});

describe('classifyReply: only plain words bind as approval or decline', () => {
  it('reads every published approval phrase as an approval', () => {
    for (const phrase of APPROVAL_PHRASES)
      expect([phrase, classifyReply(phrase)]).toEqual([phrase, 'approval']);
  });

  it('reads every published decline phrase as a decline', () => {
    for (const phrase of DECLINE_PHRASES)
      expect([phrase, classifyReply(phrase)]).toEqual([phrase, 'decline']);
  });

  it('accepts compounds of plain phrases and courtesies', () => {
    for (const message of [
      'Yes, proceed.',
      'approved — thanks!',
      'ok go ahead',
      'yes please',
      '"approved"',
      'That’s good, proceed',
      'Approved. Thank you',
    ])
      expect([message, classifyReply(message)]).toEqual([message, 'approval']);
    for (const message of ['No thanks.', 'nope, skip it', "Don't record that."])
      expect([message, classifyReply(message)]).toEqual([message, 'decline']);
  });

  it('never reads nuance, an amendment, a mix or a long message as plain', () => {
    // Each of these may still be recorded by an agent that judges it, but never as "approved".
    for (const message of [
      'yes, but only a generated markdown view gets committed',
      'no, use JSON instead',
      'approved, but rename it',
      'yes no',
      'approved and also please rename the folder to drafts before you record it',
      'I agree with your three calls',
    ])
      expect([message, classifyReply(message)]).toEqual([message, 'other']);
  });

  it('marks a question, which keeps the draft pending', () => {
    expect(classifyReply('hmm, what would superseding look like in practice?')).toBe('question');
    expect(classifyReply('approved?')).toBe('question');
  });
});

describe('keywordOverlap: how a revised line finds the draft it revises', () => {
  it('scores shared keywords against the shorter text', () => {
    expect(
      keywordOverlap(
        'Commit the decision record to git as project history',
        'Commit only a generated markdown view of the decision record to git'
      )
    ).toBeGreaterThanOrEqual(0.5);
    expect(
      keywordOverlap('Commit the decision record to git', 'Use SQLite for the local cache')
    ).toBeLessThan(0.5);
    expect(keywordOverlap('', 'anything at all here')).toBe(0);
  });
});
