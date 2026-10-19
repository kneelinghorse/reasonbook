// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — the published grammar of a drafted record ("Would record: …") and of the operator's reply.
// ABOUTME: Pure and light: the Stop and prompt hooks load it inside their budgets, and the record path reuses it.

import { extractKeywords } from './keyword-extraction';

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
 * THE REPLY. Plain approval and decline are whole messages made only of published phrases and
 * courtesies (at most 60 characters). Anything else, nuance and amendments included, is `other`,
 * or `question` when it asks one; an agent may still judge it, and the record then says so.
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
  /** Up to 600 characters of the reply before the trailing block. */
  readonly excerpt: string;
}

export const MAX_DRAFT_LINES = 3;
export const DRAFT_TEXT_MAX = 1000;
export const DRAFT_EXCERPT_MAX = 600;
const MIN_WORDS = 3;
const MIN_CHARS = 15;

const WRAP = String.raw`(\*\*|__|\*|_|\`)`;
const LABEL = new RegExp(
  String.raw`^${WRAP}?\s*would\s+record(?:\s*\(\s*([a-z]+)\s*\))?\s*${WRAP}?\s*:\s*${WRAP}?\s*(.*?)\s*$`,
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
}

function readLabel(line: string): Labelled | null {
  const match = LABEL.exec(stripMarkers(line));
  if (!match) return null;
  const [, open, kindWord, close1, close2] = match;
  let rest = match[5] ?? '';
  // A wrapper around the label alone (`**Would record:** text`) is closed before the text; one
  // around the whole line (`**Would record: text**`) is closed at its end.
  if (open && close1 !== open && close2 !== open && rest.endsWith(open)) {
    rest = rest.slice(0, rest.length - open.length).trim();
  }
  return { kindWord: kindWord?.toLowerCase(), rest };
}

function kindOf(word: string | undefined): DraftKind | null {
  if (word === undefined || word === 'decision') return 'decision';
  return word === 'constraint' || word === 'rule' || word === 'profile' ? word : null;
}

function usable(text: string): boolean {
  if (text.length < MIN_CHARS || text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return false;
  if (/^<[^>]+>/.test(text)) return false;
  return !/^(?:nothing|none|n\/a|no decision)\b/i.test(text);
}

function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > max / 2 ? room.slice(0, space) : room).trimEnd()}…`;
}

/** The links and documents a line names: URLs, markdown link targets and .md/.html/.pdf paths. */
export function draftEvidence(text: string): string[] {
  const found: string[] = [];
  const add = (value: string): void => {
    const clean = value.replace(/[.,;:]+$/, '');
    if (clean && !found.includes(clean)) found.push(clean);
  };
  for (const match of text.matchAll(/https?:\/\/[^\s)<>\]"'`]+/g)) add(match[0]);
  const withoutUrls = text.replace(/https?:\/\/[^\s)<>\]"'`]+/g, ' ');
  for (const match of withoutUrls.matchAll(
    /(?:^|[\s(`'"[])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:md|html?|pdf))(?=$|[\s)`'".,;:\]])/gi
  ))
    add(match[1]);
  return found.slice(0, 5);
}

/** Split into lines and mark the ones inside a fenced block (an unclosed fence runs to the end). */
function fencedLines(reply: string): Array<{ text: string; fenced: boolean }> {
  let fence: { delimiter: string; quotes: number } | null = null;
  return reply.split(/\r?\n/).map((text) => {
    const quotes = /^(?: {0,3}> ?)+/.exec(text)?.[0] ?? '';
    const depth = quotes.split('>').length - 1;
    const unquoted = text.slice(quotes.length);
    // A list marker may open a fence, but is literal code inside one. A closing fence must
    // stay in the opener's quote container; a quoted example inside plain code cannot close it.
    const container = fence ? unquoted : unquoted.replace(/^ {0,3}(?:[-*+]|\d+[.)]) +/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(container);
    if (marker) {
      if (fence === null) fence = { delimiter: marker[1], quotes: depth };
      else if (
        depth === fence.quotes &&
        marker[1][0] === fence.delimiter[0] &&
        marker[1].length >= fence.delimiter.length &&
        !marker[2].trim()
      )
        fence = null;
      return { text, fenced: true };
    }
    return { text, fenced: fence !== null || /^(?: {4}|\t)/.test(unquoted) };
  });
}

/**
 * A label that starts the last sentence of the reply's final line ("…decide with the numbers?
 * Would record: …"), as a Sonnet replay ended in the build's measurement: the reply still ends
 * with the line. Only after `.`, `?` or `!` and a space, never after an abbreviation (e.g., i.e.)
 * or a colon ("For example: Would record: …" is how this repository explains the convention).
 */
const INLINE_LABEL =
  /^(.*?[.?!]["')\]]*)\s+((?:\*\*|__|\*|_|`)?\s*would\s+record(?:\s*\(\s*[a-z]+\s*\))?\s*(?:\*\*|__|\*|_|`)?\s*:.*)$/i;

/**
 * The reply's prose: lines outside fenced blocks, with inline code, markdown link targets and URLs
 * blanked. Where a draft id counts as named (the build critic, B1): "P1" in a file name, a URL or
 * a code sample names nothing.
 */
export function proseLines(reply: string): string[] {
  return fencedLines(reply ?? '')
    .map((line) => (line.fenced ? '' : line.text))
    .join('\n')
    .replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (code) => code.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/\]\([^)]*\)/g, '] ').replace(/https?:\/\/\S+/g, ' '));
}

/** The drafts a reply proposes, where the rest of its labelled lines sit, and its excerpt. */
export function readDraftReply(reply: string): DraftReply {
  const lines = fencedLines(reply ?? '');
  let at = lines.length - 1;
  while (at >= 0 && lines[at].text.trim() === '') at--;
  const block: Labelled[] = [];
  let start = at + 1;
  let inlinePrefix = '';
  for (; at >= 0; at--) {
    const line = lines[at];
    if (line.text.trim() === '') continue;
    if (line.fenced) break;
    const label = readLabel(line.text);
    if (!label) {
      const inline = block.length === 0 ? INLINE_LABEL.exec(line.text.trim()) : null;
      const abbreviated = inline ? /\b(?:e\.g|i\.e|etc|vs|cf)\.["')\]]*$/i.test(inline[1]) : false;
      const tail = inline && !abbreviated ? readLabel(inline[2]) : null;
      if (inline && tail) {
        block.unshift(tail);
        inlinePrefix = inline[1];
        start = at;
      }
      break;
    }
    block.unshift(label);
    start = at;
  }
  const drafts: DraftLine[] = [];
  let dropped = 0;
  for (const label of block) {
    const kind = kindOf(label.kindWord);
    const text = cutAtWord(label.rest, DRAFT_TEXT_MAX);
    if (!kind || !usable(label.rest) || drafts.length === MAX_DRAFT_LINES) {
      dropped++;
      continue;
    }
    drafts.push({ kind, text, evidence: draftEvidence(label.rest) });
  }
  const before = lines.slice(0, start);
  const elsewhere = before.filter((line) => !line.fenced && readLabel(line.text)).length;
  const prose = [...before.map((line) => line.text), inlinePrefix].join('\n').trim();
  return {
    lines: drafts,
    elsewhere,
    dropped,
    excerpt:
      prose.length > DRAFT_EXCERPT_MAX ? prose.slice(prose.length - DRAFT_EXCERPT_MAX) : prose,
  };
}

export function extractDraftLines(reply: string): DraftLine[] {
  return [...readDraftReply(reply).lines];
}

/** Plain approvals: the operator's own words (#1186) and their everyday equivalents. */
export const APPROVAL_PHRASES: readonly string[] = [
  'approved',
  'approve',
  'approve it',
  'yes',
  'yep',
  'yeah',
  'y',
  'ok',
  'okay',
  'sure',
  'proceed',
  'go ahead',
  'go for it',
  'do it',
  'record it',
  'yes record it',
  "that's good",
  'thats good',
  'that is good',
  'sounds good',
  'looks good',
  'lgtm',
  'agreed',
  'agree',
  'i agree',
  'confirmed',
  'confirm',
  'correct',
];

/** Plain declines. "no, use JSON" is an amendment, not a decline: it carries other words. */
export const DECLINE_PHRASES: readonly string[] = [
  'no',
  'nope',
  'nah',
  "don't",
  'do not',
  "don't record that",
  'do not record that',
  "don't record it",
  'do not record it',
  'skip it',
  'skip that',
  'skip',
  'decline',
  'declined',
  'reject',
  'rejected',
  'drop it',
  'not that',
  'no thanks',
  'no thank you',
  'leave it',
  'never mind',
  'nevermind',
];

const COURTESY: readonly string[] = ['please', 'thanks', 'thank you', 'thx', 'ty'];
export const PLAIN_REPLY_MAX = 60;

export type ReplyClass = 'approval' | 'decline' | 'question' | 'other';

function normalizeReply(message: string): string {
  return message
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const PHRASES: ReadonlyArray<{ words: string[]; type: 'approval' | 'decline' | 'courtesy' }> = [
  ...APPROVAL_PHRASES.map((p) => ({ words: p.split(' '), type: 'approval' as const })),
  ...DECLINE_PHRASES.map((p) => ({ words: p.split(' '), type: 'decline' as const })),
  ...COURTESY.map((p) => ({ words: p.split(' '), type: 'courtesy' as const })),
].sort((a, b) => b.words.length - a.words.length);

/** Cover the words of one part with published phrases, longest first; null when a word is left over. */
function segment(words: readonly string[]): Array<'approval' | 'decline' | 'courtesy'> | null {
  const types: Array<'approval' | 'decline' | 'courtesy'> = [];
  let at = 0;
  while (at < words.length) {
    const phrase = PHRASES.find((p) => p.words.every((word, i) => words[at + i] === word));
    if (!phrase) return null;
    types.push(phrase.type);
    at += phrase.words.length;
  }
  return types;
}

/** How the operator's message answers a draft (build plan B7). */
export function classifyReply(message: string): ReplyClass {
  const text = normalizeReply(message ?? '');
  const asks = text.includes('?');
  if (text === '' || text.length > PLAIN_REPLY_MAX || asks) return asks ? 'question' : 'other';
  const parts = text
    .split(/[,.;!…]|\s[-–—]+\s|[–—]/)
    .map((part) => part.trim())
    .filter(Boolean);
  const types: string[] = [];
  for (const part of parts) {
    const covered = segment(part.split(' '));
    if (!covered) return 'other';
    types.push(...covered);
  }
  const approvals = types.includes('approval');
  const declines = types.includes('decline');
  if (approvals && !declines) return 'approval';
  if (declines && !approvals) return 'decline';
  return 'other';
}

/**
 * Connectors a "decision and reason" line carries whatever its subject; counting them made every
 * two lines share a keyword ("because" scored an unrelated pair 0.14 in the build's calibration).
 */
const CONNECTORS: ReadonlySet<string> = new Set([
  'because',
  'since',
  'therefore',
  'thus',
  'also',
  'would',
  'should',
  'could',
  'will',
]);

function subjectWords(text: string): Set<string> {
  return new Set(extractKeywords(text).filter((word) => !CONNECTORS.has(word)));
}

/** The share of the shorter text's subject keywords the other shares; 0 when either has none. */
export function keywordOverlap(a: string, b: string): number {
  const left = subjectWords(a);
  const right = subjectWords(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

/**
 * The share of the draft's own subject keywords the other text holds; 0 when the draft has none.
 * Unlike keywordOverlap it never measures against the shorter text, so a record that says only part
 * of what a longer draft proposed does not cover it (s97-m12, learning #481).
 */
export function draftCoverage(draft: string, other: string): number {
  const words = subjectWords(draft);
  if (words.size === 0) return 0;
  const held = subjectWords(other);
  let shared = 0;
  for (const word of words) if (held.has(word)) shared++;
  return shared / words.size;
}

/**
 * THE THREE FLOORS (build plan B3, B5, B12; plan critic B2 and B3). Calibrated on the pairs in
 * the build plan's §Calibration, connectors excluded: a revision of the same decision scored 1.00,
 * probe 4's nuanced approval 0.46, a flipped key term (JSON to SQLite, Postgres to DuckDB) 0.30 to
 * 0.33, and unrelated proposals 0.00 to 0.14.
 */
/**
 * Approval covers the text the operator saw (build critic B2). Retrieval keywords discard
 * negation and ordering, so they cannot prove equivalent meaning. Only whitespace may differ;
 * any other same-subject wording is the agent's reading and must be labelled agent-judged.
 */
export function recordStatesDraft(draftText: string, content: string): boolean {
  const normalize = (text: string): string => text.trim().replace(/\s+/g, ' ');
  return normalize(draftText) === normalize(content);
}

/** Among several drafts of a kind the operator answered, a line revises one at this overlap. */
export const REVISION_OVERLAP = 0.5;
/** When the operator answered one draft of a kind, a line revises it at this subject overlap. */
export const SINGLE_REVISION_FLOOR = 0.25;
/** A record made from a draft must share at least this much of its subject with the draft. */
export const CONTENT_FLOOR = 0.3;
/**
 * A record without fromDraft answers an open draft only when it holds this much of the draft's own
 * subject (draftCoverage; s97-m12). Calibrated on this repository's store, counting the ten drafts
 * whose record is a decision: five held 1.00, then 0.95, 0.93 and 0.88 (each recorded as proposed),
 * 0.64 (P9: every choice recorded, reworded) and 0.57 (P23, the defect: part of it recorded).
 * Coverage does not part a reworded record from a partial one cleanly, so a reworded record may
 * leave its draft pending; the answer then names it.
 */
export const ANSWER_COVERAGE = 0.85;
/**
 * A line revises a pending draft at this share of that draft's own subject (draftCoverage; s97-m12)
 * when no operator message is open on drafts, and always for a draft the operator approved, whose
 * link limits it to its own words. Calibrated on this store's same-session pairs of one kind
 * (rbook/research/2026-10-s97-probes/s97-m12-prompt-origin.json, revisionCalibration): the
 * consecutive revisions in the two chains held 0.79 to 1.00, and every other pair 0.52 or less.
 * NAMED RESIDUALS: P19 to P20 (0.35) was a revision the operator's window linked, and one like it
 * with no window stays pending; the openings of the sprint-96 chain (P10 to P11 at 0.35, P11 to P12
 * at 0.13) stay pending too; and a sibling proposal that reuses this much of a draft's words with
 * one key term changed (decisions to learnings) retires it, since subject keywords cannot tell a
 * changed key term from a rewording.
 */
export const REVISION_COVERAGE = 0.75;
