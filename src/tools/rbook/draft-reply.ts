// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — the published grammar of the operator's reply to a draft: plain approval, decline, question or other.
// ABOUTME: Moved from draft-grammar.ts in s109-m03, which re-exports it, with E2's rule R-c for unrelated questions.

import { fencedLines, proseLines } from './draft-lines';
import { subjectOverlap, subjectWords } from './draft-subject';
import { extractKeywords } from './keyword-extraction';

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

/** A draft the message answers: its id and its text. */
export interface RepliedDraft {
  readonly id: number;
  readonly text: string;
}

function normalizeReply(message: string): string {
  return message
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const CLAUSE = /[,.;!…]|\s[-–—]+\s|[–—]/;

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

/**
 * RULE R-c (s109-m03, #52; E2's probe, settled item 7). 4.10.0 read any "?" as a question about the
 * drafts, so "yes, this looks good" followed by a question about renaming the project held both
 * drafts open. A message that opens with an approval, and whose every "?" sentence is about
 * something else, reads `other` instead: agent-judged, as any other nuance. So does an approval
 * whose only "?" is in code, a link target or a URL. The rule only turns `question` into `other`,
 * and a mode depends only on `approval` and `decline` (critic B1), so it never records anything.
 *
 * A "?" sentence, read in prose with code, link targets and URLs blanked and split after ".",
 * "!", "?" or "…" with a space, and at every line break, is about the drafts unless it starts with
 * a topic word ("also", "separately", "by the way", "PS", …, or "I'm also", "but also"), and even
 * then when it names a draft the message answers (P<n>, P <n>, #<n>), says this, that, these,
 * those, draft, proposal or "the decision", holds a decline word, has fewer than two keywords (one
 * written with neither ASCII letters nor digits has none, #894), or shares a quarter of the subject
 * words of the shorter of it and a draft (keywordOverlap's measure). E2 measured the residuals on
 * its battery: 2 of 15 questions about a draft read `other` (both start "Also,"), and 2 of 8
 * unrelated ones stay `question`. The build critics' rounds keep `question` for every question that
 * starts with no topic word, and name the rest of the topic-led shape in the evidence's README.
 */
const escapeRegExp = (phrase: string): string => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * An approval phrase as the operator's first words, read as written: a quote marker opens someone
 * else's words and a backtick opens code, so neither may come before it.
 */
const APPROVAL_OPENING = new RegExp(
  `^[^\\w>\`]*(?:${APPROVAL_PHRASES.map(escapeRegExp).join('|')})\\b`
);
/** A decline phrase or "dont" without its apostrophe; the plain grammar keeps its own list. */
const DECLINE_WORD = new RegExp(
  `\\b(?:${[...DECLINE_PHRASES, 'dont'].map(escapeRegExp).join('|')})\\b`
);
/** Where the first clause ends, as E2's prototype cut it: not at a bare dash ("yes—no wait"). */
const OPENING_CLAUSE = /[,.;!…]|\s[-–—]+\s/;
/**
 * A topic word that starts a sentence, alone or after "and", "but", "so", "we", "I" or "I'm":
 * inside a question it is a focus word, as in "does it also cover the CLI?" (critic A). Each word
 * and gap matches whole, so the test is linear; E2's prototype let neighbouring gaps share a run of
 * punctuation and backtracked cubically (78 s on three runs of 4,000 dashes).
 */
const TOPIC =
  /^\W*(?:(?:and|but|so|we|i(?:['’]m)?)\W+){0,2}(?:also|separately|unrelated(?:ly)?|aside|btw|by the way|on another note|another thing|side note|p\.?s\.?|one more thing|different topic|off[- ]topic)\b/i;
const POINTS_AT_DRAFTS =
  /\b(?:this|that|these|those|drafts?|proposals?|the (?:decision|record|line)s?)\b/i;
/** The share of a draft's subject a question must hold to be about it (E2: keywordOverlap). */
const SUBJECT_SHARE = 0.25;
/**
 * The longest message R-c reads; a longer one keeps 4.10.0's `question`. Reading prose costs more
 * than linear time on pasted text (proseLines took 373 ms on 50,000 characters of unclosed link
 * targets, 3 s on a megabyte of backtick runs), inside the prompt hook's 800 ms. The longest reply
 * this repository's store kept is 918 characters.
 */
const READ_MAX = 10_000;
const URL_PATTERN = /https?:\/\/\S+/g;
/** A character that makes what follows a URL's last "?" read as its query or fragment. */
const QUERY_CHARACTER = /[A-Za-z0-9=&%+/#-]/;
/** A blank line, as CommonMark has it: spaces and tabs only (round 3, O1: not a no-break space). */
const BLANK = /^[ \t\r]*$/;

/**
 * A URL's last "?" ends the sentence, not the URL, when nothing a query could hold follows it, so
 * "…/issues/12?", "…/y?**", "“…/y?”" and "…/y?🙂" ask and "…/?q=1" does not (critics A, rounds 1-2).
 */
function unglueQuestion(url: string): string {
  const at = url.lastIndexOf('?');
  return at > 0 && !QUERY_CHARACTER.test(url.slice(at + 1))
    ? `${url.slice(0, at)} ${url.slice(at)}`
    : url;
}

interface Read {
  /** The first clause of the first paragraph as written, normalized. */
  readonly opening: string;
  /** The "?" sentences, in prose. */
  readonly questions: readonly string[];
}

function readQuestions(message: string): Read {
  const text = message.replace(URL_PATTERN, unglueQuestion);
  // The first paragraph ends at the first blank line outside code (a fence's own blank lines do not
  // end it, so "yes" above a fence keeps the "no wait" below it in view; verifier A, round 2).
  const lines = fencedLines(text);
  const from = lines.findIndex((line) => !BLANK.test(line.text));
  const to = lines.findIndex((line, at) => at > from && !line.fenced && BLANK.test(line.text));
  const first = lines
    .slice(Math.max(from, 0), to === -1 ? lines.length : to)
    .map((line) => line.text)
    .join('\n');
  const questions = proseLines(text)
    .join('\n')
    .split(/(?<=[.!?…])\s+|\n+/)
    .filter((sentence) => sentence.includes('?'))
    .map((sentence) => sentence.trim());
  return { opening: normalizeReply(first).split(OPENING_CLAUSE)[0], questions };
}

/** Whether a message that holds a "?" asks about the drafts it answers (R-c). */
function asksAboutDrafts(message: string, drafts: readonly RepliedDraft[]): boolean {
  if (message.length > READ_MAX) return true;
  const { opening, questions } = readQuestions(message);
  // Only an approval reads other: any other message keeps 4.10.0's question, even when its "?"
  // sits in what proseLines reads as code (critic A: an indented line, a stray backtick).
  if (!APPROVAL_OPENING.test(opening) || DECLINE_WORD.test(opening)) return true;
  const named = drafts.map((draft) => new RegExp(`(?:\\bP\\s?|#)${draft.id}\\b`, 'i'));
  // Each draft's subject is read once, not once per question (critic A: 150 ms on 1,250 questions).
  const subjects = drafts.map((draft) => subjectWords(draft.text));
  const about = (question: string): boolean => {
    if (!TOPIC.test(question) || named.some((id) => id.test(question))) return true;
    if (POINTS_AT_DRAFTS.test(question) || DECLINE_WORD.test(normalizeReply(question))) return true;
    if (extractKeywords(question).length < 2) return true;
    const words = subjectWords(question);
    return subjects.some((subject) => subjectOverlap(words, subject) >= SUBJECT_SHARE);
  };
  return questions.some(about);
}

/** How the operator's message answers the drafts it was shown (build plan B7; R-c above). */
export function classifyReply(message: string, drafts: readonly RepliedDraft[] = []): ReplyClass {
  const text = normalizeReply(message ?? '');
  const asks = text.includes('?');
  if (asks) return asksAboutDrafts(message ?? '', drafts) ? 'question' : 'other';
  if (text === '' || text.length > PLAIN_REPLY_MAX) return 'other';
  const parts = text
    .split(CLAUSE)
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
