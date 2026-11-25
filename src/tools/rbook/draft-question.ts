// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The question that names the consequence of recording each kind of pending draft.
// ABOUTME: Agents show the complete choice before the question and use record identifiers privately.
import { DRAFT_TEXT_MAX, type DraftKind, type DraftReply } from './draft-grammar';
import { classifyReply, PLAIN_REPLY_MAX } from './draft-reply';
import { EXCERPT_MAX } from './draft-runtime-excerpts';

const QUESTIONS: Readonly<Record<DraftKind, string>> = {
  decision: 'Should I record this decision?',
  constraint: 'Should I record this constraint?',
  rule: 'Should I make this a standing rule?',
  profile: 'Should I add this to your operator profile?',
};

function namedQuestion(kind: DraftKind): string {
  return `Reply “I approve this ${kind}:” followed by the full choice. ${QUESTIONS[kind]}`;
}

export const DRAFT_QUESTIONS: Readonly<Record<DraftKind, string>> = {
  decision: namedQuestion('decision'),
  constraint: namedQuestion('constraint'),
  rule: namedQuestion('rule'),
  profile: namedQuestion('profile'),
};

/** Both generations of the question require the same evidence of approval. */
export function draftQuestionKind(line: string): DraftKind | undefined {
  return (Object.keys(QUESTIONS) as DraftKind[]).find(
    (kind) => line === QUESTIONS[kind] || line === DRAFT_QUESTIONS[kind]
  );
}

// Accept exactly two plain paragraphs in the current reply. A digest headline or a quoted
// example is insufficient evidence of the full choice the operator was asked to approve.
const QUESTION_REPLY_MAX =
  DRAFT_TEXT_MAX + 4 + Math.max(...Object.values(DRAFT_QUESTIONS).map((line) => line.length));

export function visibleQuestion(reply: string | undefined) {
  if (!reply || reply.length > QUESTION_REPLY_MAX) return;
  const parts = reply.trimEnd().split(/\r?\n\r?\n/);
  if (parts.length !== 2) return;
  const [statement, question] = parts;
  // An underscore inside a word is literal in Markdown; preserve the original for the exact match.
  const plainWords = statement.replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, '');
  if (
    !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} ,.;:!()/'’%+–—-]*$/u.test(plainWords) ||
    statement.trimEnd() !== statement
  )
    return;
  const kind = draftQuestionKind(question);
  if (kind) return { kind, statement };
}

/**
 * A typed confirmation identifies both the operation and the choice. The short form identifies
 * a decision; the producer restricts it to this session or a current showing. A message that
 * cannot be retained whole cannot become approval evidence. The prefix must itself be a
 * direct affirmation; quoting a sample confirmation does not approve anything.
 */
export function namedApprovalTarget<T extends { readonly kind: DraftKind; readonly text: string }>(
  message: string,
  candidates: readonly T[],
  shortFormEligible?: (candidate: T) => boolean
): T | undefined {
  if (message.length > EXCERPT_MAX || /[\r\n\u2028\u2029]/u.test(message)) return;
  // Only the affirmative prefix is syntax. Everything after its single separator
  // is the operator's choice, including spaces, technical literals and punctuation.
  const typed = /^I approve this (decision|rule|constraint|profile):[ \t](.+)$/i.exec(message);
  const short = /^(?:yes,[ \t]|i approve[ \t])(.+)$/i.exec(message);
  const text = typed?.[2] ?? short?.[1];
  if (!text || (!typed && classifyReply(message) === 'approval')) return;
  const kind = typed?.[1].toLowerCase();
  const matches = candidates.filter((row) => (!kind || row.kind === kind) && row.text === text);
  if (matches.length !== 1) return;
  const target = matches[0];
  if (kind || (target.kind === 'decision' && (!shortFormEligible || shortFormEligible(target))))
    return target;
}

// A short affirmative followed by a full stop and only the complete numeric setting.
// A single quote inside an approval word (such as "that's good") is not quotation.
// Only these complete count or duration units have a shorthand. A new unit, modifier
// or trailing clause needs a full named choice, even if the operator repeated it exactly.
const SETTING =
  /^(\d+ (?:(?:critic |review )?rounds?|(?:review )?pass(?:es)?|attempts?|retry|retries|(?:second|minute|hour|day|week|month|year)s?))[.!…]*$/;
// The shorthand omits its subject, so only these complete standing-setting labels
// identify a choice. An unfamiliar or qualified label requires the full typed choice.
const SETTING_LABELS = new Set([
  'plan critics',
  'review budget',
  'review rounds',
  'critic rounds',
  'review passes',
  'test budget',
  'meeting budget',
  'stop checks',
  'retry limit',
  'retry delay',
  'timeout',
  'retention period',
]);
const NUMBERED_LABEL = /^(?:[1-9]\d*[.)] )?([a-z]+(?: [a-z]+)*)$/i;

function numericSetting(text: string): string | undefined {
  return SETTING.exec(
    text
      .trim()
      .toLowerCase()
      .replace(/[\t\p{Zs}]+/gu, ' ')
  )?.[1];
}

function proposedSetting(text: string): string | undefined {
  const [subject, setting, extra] = text.split(':');
  const label = NUMBERED_LABEL.exec(subject.trim().replace(/[\t\p{Zs}]+/gu, ' '))?.[1];
  if (
    !label ||
    !SETTING_LABELS.has(label.toLowerCase()) ||
    setting === undefined ||
    extra !== undefined
  )
    return;
  return numericSetting(setting);
}

/** A fallback transcript can contain an old proposal. Only a current, plain, complete
 * standing line supplies the subject omitted by a later restatement of its numeric value. */
export function visibleStandingSetting(reply: string | undefined, read: DraftReply) {
  if (!reply || read.lines.length !== 1 || read.dropped || read.elsewhere) return;
  const [line] = read.lines;
  if (line.kind === 'decision' || !proposedSetting(line.text)) return;
  if (reply.trimEnd() === `Would record (${line.kind}): ${line.text}`) return line;
}

/** The same proposal may have more than one row. Permission to record a setting
 * needs one exact, unrevised target, both when it is shown and when it is answered. */
export function uniqueStandingSetting<
  T extends { kind: DraftKind; text: string; replacedBy: number | null },
>(line: { kind: DraftKind; text: string }, pending: readonly T[]): T | undefined {
  const matches = pending.filter(
    (row) => row.kind === line.kind && row.text === line.text && row.replacedBy === null
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function restatesStandingSetting(
  message: string,
  draft: { readonly kind: DraftKind; readonly text: string }
): boolean {
  if (draft.kind === 'decision' || message.length > PLAIN_REPLY_MAX) return false;
  const parts = /^ {0,3}([a-z][a-z,;!.'’…–—\t\p{Zs}-]*)\.[\t\p{Zs}]*(\d.+)$/iu.exec(message);
  if (!parts || /[\r\n\v\f\u0085\u2028\u2029]/u.test(message)) return false;
  const [, prefix, value] = parts;
  if (/(?<![a-z])['’]|['’](?![a-z])/i.test(prefix) || classifyReply(prefix) !== 'approval')
    return false;
  const expected = proposedSetting(draft.text);
  return expected !== undefined && expected === numericSetting(value);
}
