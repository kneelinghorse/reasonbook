// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — the published grammar of a drafted record ("Would record: …") and of the operator's reply.
// ABOUTME: Pure and light: the Stop and prompt hooks load it inside their budgets, and the record path reuses it.

import { ARTIFACT_TAG_NAMES } from '../../intelligence/content-sanitizer';
import { draftEvidence, fencedLines } from './draft-lines';
import { settleLabel } from './draft-settle-label';

// s109-m02: line reading and subject coverage live in their own modules, re-exported here, as
// s109-m03 does the reply grammar.
export { draftEvidence, fencedLines, proseLines } from './draft-lines';
export {
  APPROVAL_PHRASES,
  classifyReply,
  DECLINE_PHRASES,
  PLAIN_REPLY_MAX,
  type RepliedDraft,
  type ReplyClass,
} from './draft-reply';
export {
  ANSWER_COVERAGE,
  CONTENT_FLOOR,
  draftCoverage,
  keywordOverlap,
  recordStatesDraft,
  REVISION_COVERAGE,
  REVISION_OVERLAP,
  SINGLE_REVISION_FLOOR,
} from './draft-subject';

/**
 * WHY A PUBLISHED GRAMMAR (decisions #1186, #1188; build plan s93-m06 B3, B7). A draft must be
 * something the agent visibly put to the operator, and an approval must be words the operator
 * actually wrote. So both are read by fixed rules published here and in the record skill, never by
 * guessing at decision-shaped prose (that detector is measured in this mission and stays off).
 *
 * THE LINE. One of the reply's TRAILING non-blank lines, read upward from the end while each line
 * carries the label, at most three kept, in reading order:
 *   Would record: <decision and reason>
 *   Would record (constraint|rule|profile): <text>
 * Trailing only, because a mention in the middle of a reply (this repository explains the
 * convention in prose) must not become a draft. A labelled line with an unpublished kind, a
 * placeholder, "nothing" or too little text is dropped but does not end the block above it.
 *
 * THE REPLY (draft-reply.ts). Plain approval and decline are whole messages made only of published
 * phrases and courtesies (at most 60 characters). Anything else, nuance and amendments included, is
 * `other`, or `question` when it holds a question mark, except an approval of at most 10,000
 * characters whose every question is about something else, which stays `other` (rule R-c). An agent
 * may still judge it, and the record then says so.
 */

export type DraftKind = 'decision' | 'constraint' | 'rule' | 'profile';
export const DRAFT_KINDS: readonly DraftKind[] = ['decision', 'constraint', 'rule', 'profile'];

export interface DraftLine {
  readonly kind: DraftKind;
  readonly text: string;
  /** URLs, markdown link targets and .md/.html/.pdf paths the line names, in order of appearance. */
  readonly evidence: readonly string[];
}

export interface DraftReply {
  readonly lines: readonly DraftLine[];
  /** Labelled lines outside the trailing block (a measurement of placement, never drafts). */
  readonly elsewhere: number;
  /** Labelled lines in the trailing block that were dropped (unpublished kind, placeholder…). */
  readonly dropped: number;
  /** s109-m02 (#51): each dropped line as written, with why, named at the operator's next prompt. */
  readonly droppedLines: ReadonlyArray<{ readonly text: string; readonly reason: DroppedReason }>;
  /** s109-m02: where the trailing block starts among the reply's lines (Settled lines read there). */
  readonly blockStart: number;
  /** Up to 600 characters of the reply before the trailing block. */
  readonly excerpt: string;
}

/** An unpublished kind, a placeholder or too little text, or a line past the third. */
export type DroppedReason = 'kind' | 'text' | 'limit';

export const MAX_DRAFT_LINES = 3;
export const DRAFT_TEXT_MAX = 1000;
export const DRAFT_EXCERPT_MAX = 600;
const MIN_WORDS = 3;
const MIN_CHARS = 15;

const WRAP = String.raw`(\*\*|__|\*|_|\`)`;
const LABEL = new RegExp(
  String.raw`^${WRAP}?\s*would\s+record(?:\s*\(\s*([a-z]+)\s*\))?\s*${WRAP}?\s*:\s*${WRAP}?(\s*)(.*?)\s*$`,
  'i'
);

function stripMarkers(line: string): string {
  return line
    .trim()
    .replace(/^>\s*/, '')
    .replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, '')
    .trim();
}

interface Labelled {
  readonly kindWord: string | undefined;
  readonly rest: string;
  /** The line as written, trimmed. */
  readonly line: string;
}

/** s109-m02: whether a line carries the Would record label (the settle reader orders its lines by them). */
export function isDraftLabel(line: string): boolean {
  return readLabel(line) !== null;
}

function readLabel(line: string): Labelled | null {
  const match = LABEL.exec(stripMarkers(line));
  if (!match) return null;
  const [, open, kindWord, close1, after, gap, text] = match;
  // A wrapper around the label alone (`**Would record:** text`) is closed before the text; one
  // around the whole line (`**Would record: text**`) is closed at its end. s107-m02 (#875): a mark
  // right after the colon closes only a wrapper opened before the label and still open; any other
  // opens the text (`Would record: \`<tag>\` …`) and stays with it.
  const closesLabel = open !== undefined && close1 !== open && after === open;
  let rest = after === undefined || closesLabel ? (text ?? '') : `${after}${gap}${text ?? ''}`;
  if (open && close1 !== open && !closesLabel && rest.endsWith(open)) {
    rest = rest.slice(0, rest.length - open.length).trim();
  }
  return { kindWord: kindWord?.toLowerCase(), rest, line: line.trim() };
}

function kindOf(word: string | undefined): DraftKind | null {
  if (word === undefined || word === 'decision') return 'decision';
  return word === 'constraint' || word === 'rule' || word === 'profile' ? word : null;
}

/**
 * A <…> span with the code-span or emphasis marks around it. Its inside holds no `<`, so a line of
 * many `<` and no `>` is read in linear time (s107-m02 round-4 critic: 37 s on 200,000).
 */
const SPAN = /(\*\*|__|\*|_|`)?<([^<>]*)>\1/g;
/**
 * A tag the content sanitizer cuts (src/intelligence/content-sanitizer.ts), opening or closing:
 * the bare name, or with name="…" attributes as a call writes them. A slot only named after one
 * (`<content and reason>`) is still a slot (s107-m02 round-5 critic).
 */
const TOOL_TAG = new RegExp(`^\\/?(?:${ARTIFACT_TAG_NAMES.join('|')})(?:\\s+name="[^"]*")*\\s*$`);
/**
 * A word beside a placeholder: a run of letters or digits in a script that spaces its words, or one
 * Han, Hiragana or Katakana character, since Japanese and Chinese write no spaces between words
 * (s107-m02 round 4, decision #1762).
 */
const WORD =
  /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}]|(?:(?![\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}])[\p{L}\p{N}])+/gu;

/**
 * Whether a span is content rather than a slot to fill in (s107-m02 round 5): a tool-call tag the
 * sanitizer cuts, a URL, or a generic written onto a name (`Array<T>`, `Promise<void>`). `previous`
 * is the character right before the `<`: a generic's is an ASCII letter or digit, never a mark
 * (an underscore may open emphasis), since Chinese, Japanese and Korean write a placeholder onto
 * the word before it (round-5 and round-6 critics).
 */
function contentSpan(inner: string, previous: string): boolean {
  return (
    TOOL_TAG.test(inner) || /^[a-z][a-z0-9+.-]*:\/\//i.test(inner) || /^[A-Za-z0-9]$/.test(previous)
  );
}

function usable(text: string): boolean {
  if (text.length < MIN_CHARS || text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return false;
  if (/^<[^>]+>/.test(text)) return false;
  // s107-m02: a placeholder in a code span or emphasis (`<decision>`, **<decision and reason>**) is
  // still one now that its opening mark stays. So beside placeholders the minimum is counted
  // outside them and their marks, in WORDs, with two more words and ten more characters for each
  // placeholder after the first: slots joined by connectors ("`<decision>` and the reason:
  // `<reason>`") stay a template. A tool-call tag, a URL or a generic is content, not a
  // placeholder, so a line naming two tags drafts in any script (round 5).
  if (text.includes('<')) {
    let placeholders = 0;
    const bare = text
      .replace(SPAN, (span: string, mark: string | undefined, inner: string, at: number) => {
        if (contentSpan(inner, mark ? '' : text.charAt(at - 1))) return span;
        placeholders += 1;
        return ' ';
      })
      .trim();
    const extra = Math.max(0, placeholders - 1);
    if (
      placeholders > 0 &&
      (bare.length < MIN_CHARS + 10 * extra ||
        (bare.match(WORD) ?? []).length < MIN_WORDS + 2 * extra)
    )
      return false;
  }
  return !/^(?:nothing|none|n\/a|no decision)\b/i.test(text);
}

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > max / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}

/**
 * A label that starts the last sentence of the reply's final line ("…decide with the numbers?
 * Would record: …"), as a Sonnet replay ended in the build's measurement: the reply still ends
 * with the line. Only after `.`, `?` or `!` and a space, never after an abbreviation (e.g., i.e.)
 * or a colon ("For example: Would record: …" is how this repository explains the convention).
 */
const INLINE_LABEL =
  /^(.*?[.?!]["')\]]*)\s+((?:\*\*|__|\*|_|`)?\s*would\s+record(?:\s*\(\s*[a-z]+\s*\))?\s*(?:\*\*|__|\*|_|`)?\s*:.*)$/i;

/** The drafts a reply proposes, where the rest of its labelled lines sit, and its excerpt. */
export function readDraftReply(reply: string): DraftReply {
  const lines = fencedLines(reply ?? '');
  let at = lines.length - 1;
  while (at >= 0 && lines[at].text.trim() === '') at--;
  const block: Labelled[] = [];
  const last = at;
  let start = at + 1;
  let inlinePrefix = '';
  for (; at >= 0; at--) {
    const line = lines[at];
    if (line.text.trim() === '') continue;
    if (line.fenced) break;
    const label = readLabel(line.text);
    if (!label) {
      // Only the reply's own last line is read inline, and before a Settled line is read past, so
      // "Settled: …. Would record: …" as one last line still drafts, as 4.10.0 reads it (s109-m02).
      const inline = at === last ? INLINE_LABEL.exec(line.text.trim()) : null;
      const abbreviated = inline ? /\b(?:e\.g|i\.e|etc|vs|cf)\.["')\]]*$/i.test(inline[1]) : false;
      const tail = inline && !abbreviated ? readLabel(inline[2]) : null;
      if (inline && tail) {
        block.unshift(tail);
        inlinePrefix = inline[1];
        start = at;
        break;
      }
      // s109-m02: a Settled line, in any form, does not end the block, so Would record lines above
      // it still draft: any interleaving is read in full.
      if (settleLabel(line.text)) {
        start = at;
        continue;
      }
      break;
    }
    block.unshift(label);
    start = at;
  }
  const drafts: DraftLine[] = [];
  const droppedLines: Array<{ text: string; reason: DroppedReason }> = [];
  for (const label of block) {
    const kind = kindOf(label.kindWord);
    const text = cutAtWord(label.rest, DRAFT_TEXT_MAX);
    const reason: DroppedReason | null = !kind
      ? 'kind'
      : !usable(label.rest)
        ? 'text'
        : drafts.length === MAX_DRAFT_LINES
          ? 'limit'
          : null;
    if (reason) {
      droppedLines.push({ text: label.line, reason });
      continue;
    }
    drafts.push({ kind: kind!, text, evidence: draftEvidence(label.rest) });
  }
  const before = lines.slice(0, start);
  const elsewhere = before.filter((line) => !line.fenced && readLabel(line.text)).length;
  const prose = [...before.map((line) => line.text), inlinePrefix].join('\n').trim();
  return {
    lines: drafts,
    elsewhere,
    dropped: droppedLines.length,
    droppedLines,
    blockStart: start,
    excerpt:
      prose.length > DRAFT_EXCERPT_MAX ? prose.slice(prose.length - DRAFT_EXCERPT_MAX) : prose,
  };
}

export function extractDraftLines(reply: string): DraftLine[] {
  return [...readDraftReply(reply).lines];
}
