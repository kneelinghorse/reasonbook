// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Fits complete draft instructions, warnings and reminders into the prompt's UTF-16 budget.
// ABOUTME: Returns the identities of the drafts and retained lines actually present in that text.
import type { ReplyClass } from '../tools/rbook/draft-grammar';
import { DRAFT_QUESTIONS } from '../tools/rbook/draft-question';
import { draftLabel, type DraftRow } from '../tools/rbook/proposals';
import type { UnkeptNote } from './drafts-unkept-notes';

export const OFFER_TEXT_MAX = 1000;

const KIND_NOTE: Readonly<Partial<Record<DraftRow['kind'], string>>> = {
  constraint: ' It is recorded as a constraint, and only on the operator’s approval.',
  rule: ' It is recorded as a standing rule (an evergreen learning), and only on the operator’s approval.',
  profile: ' It is a line for the operator profile, written only on the operator’s approval.',
};

function excerpt(text: string, max: number): string {
  const sample = text.slice(0, max + 1);
  const flat = sample.replace(/\s+/g, ' ').trim();
  if (sample.length === text.length && flat.length <= max) return flat;
  // Keep a supplementary character whole when the preview ends between its surrogate halves.
  return `${flat
    .slice(0, max - 1)
    .replace(/[\uD800-\uDBFF]$/u, '')
    .trimEnd()}…`;
}

interface Entry {
  readonly id?: number;
  readonly position?: number;
  readonly compact: string;
  readonly expand: (maxExcerpt: number) => string;
}

type Role = 'bound' | 'declined' | 'carried' | 'pending' | 'later';

function draftEntry(draft: DraftRow, role: Role): Entry {
  const label = draftLabel(draft.id);
  const target = `${label} (${draft.kind})`;
  let head: string;
  switch (role) {
    case 'bound':
    case 'declined':
      head = `Draft ${target}:`;
      break;
    case 'carried':
      head = `Draft ${target} was shown before your last reply and not answered since.`;
      break;
    case 'later':
      head = `From an earlier session, awaiting the operator: ${target}`;
      break;
    case 'pending':
      head = `Still pending: ${target}`;
      break;
  }
  const evidence = draft.evidence.length ? ' Evidence attached.' : ' No evidence.';
  const outside =
    draft.outsideContent === 1
      ? ' This session read outside content.'
      : draft.outsideContent === 0
        ? ' No outside content seen.'
        : ' Outside content unknown.';
  if (role === 'declined') {
    const text = head + evidence + outside;
    // The outcome is visible, but a decline is never counted or stamped as an offer.
    return { compact: text, expand: () => text };
  }
  const ask = role === 'bound' ? '' : ' Ask the operator to name the choice they approve.';
  return {
    id: draft.id,
    compact: head + evidence + outside + ask,
    expand: (maxExcerpt) => {
      const names = draft.evidence.slice(0, 3);
      const sources =
        names.length && names.every((name) => name.length <= 300 && !/[\r\n]/u.test(name))
          ? ` It names ${names.join(', ')}.`
          : evidence;
      const prefix = role === 'bound' && maxExcerpt === 300 ? `Reasonbook draft ${target}:` : head;
      let text = `${prefix} "${excerpt(draft.text, maxExcerpt)}".${KIND_NOTE[draft.kind] ?? ''}${sources}${outside}`;
      if (role === 'pending' || role === 'later') {
        if (draft.kind === 'decision')
          text += ` If already answered, privately use drafts settle --draft ${label} --decision N --project-root DIR.`;
        text += ` For an open choice, use drafts list for the full text. Send only that text, a blank line and "${DRAFT_QUESTIONS[draft.kind]}".`;
        text +=
          draft.kind === 'decision'
            ? ' If unbound, require a named choice before recording without fromDraft.'
            : ' If unbound, ask for the kind and full choice again.';
      } else text += ask;
      return text;
    },
  };
}

function instruction(
  reply: ReplyClass | null,
  bound: readonly DraftRow[],
  retained: boolean
): string {
  if (!reply || !bound.length) return '';
  const targets =
    bound.length <= 3 ? bound.map((d) => draftLabel(d.id)).join(', ') : 'the shown drafts';
  if (reply === 'decline')
    return retained
      ? `The decline request for ${targets} is retained until the project can save it. Leave it pending.`
      : `The operator declined ${targets}; ${bound.length === 1 ? 'it is' : 'they are'} not recorded.`;
  if (reply === 'approval' && bound.length === 1) {
    const exact = bound[0].kind === 'decision' ? '' : 'Use the standing draft’s exact words. ';
    return `${exact}The operator’s message is a plain approval of ${targets}: record it now with rbook_decisions(action="record", fromDraft="${targets}").${bound[0].kind === 'decision' ? ' A record that adds to the draft reads agent-judged.' : ''}`;
  }
  const answer = reply === 'question' ? 'Answer the question. ' : '';
  return `${answer}Leave ${targets} pending. If the operator amends a choice, propose the revised wording. Ask the operator to name the choice they approve before you record it.`;
}

/** Reserve the small entries before expanding any one excerpt or evidence list. */
export function renderOffer(
  notes: readonly UnkeptNote[],
  bound: readonly DraftRow[] = [],
  carried: readonly DraftRow[] = [],
  reminders: readonly { draft: DraftRow; later: boolean }[] = [],
  reply: ReplyClass | null = null,
  retainedDecline = false
): { text: string; ids: number[]; positions: number[] } {
  const header = instruction(reply, bound, retainedDecline);
  const entries: Entry[] = notes.map((note) => ({
    position: note.position,
    compact: note.compact,
    expand: () => note.full,
  }));
  for (const draft of bound)
    entries.push(draftEntry(draft, reply === 'decline' ? 'declined' : 'bound'));
  for (const draft of carried) entries.push(draftEntry(draft, 'carried'));
  for (const item of reminders)
    entries.push(draftEntry(item.draft, item.later ? 'later' : 'pending'));

  // Include the newline in the cost of each entry. A missing header needs no leading newline.
  let used = header ? header.length : -1;
  const total = entries.reduce((n, entry) => n + entry.compact.length + 1, used);
  const omittedLine = (n: number) => `${n} more entries omitted.`;
  const limit =
    total > OFFER_TEXT_MAX
      ? OFFER_TEXT_MAX - omittedLine(entries.length).length - 1
      : OFFER_TEXT_MAX;
  const selected: Entry[] = [];
  for (const entry of entries) {
    const cost = entry.compact.length + 1;
    if (used + cost > limit) continue;
    selected.push(entry);
    used += cost;
  }
  const omitted = entries.length - selected.length;
  if (omitted) used += omittedLine(omitted).length + 1;
  const lines = selected.map((entry) => entry.compact);
  // First give each delivered row its sources, kind note and short excerpt where they fit.
  // Spend any remaining room on fuller previews. Never split a structured entry around punctuation.
  for (const size of [80, 300]) {
    selected.forEach((entry, index) => {
      const richer = entry.expand(size);
      const delta = richer.length - lines[index].length;
      if (used + delta <= OFFER_TEXT_MAX) {
        lines[index] = richer;
        used += delta;
      }
    });
  }
  if (header) lines.unshift(header);
  if (omitted) lines.push(omittedLine(omitted));
  return {
    text: lines.join('\n'),
    ids: selected.flatMap((entry) => (entry.id === undefined ? [] : [entry.id])),
    positions: selected.flatMap((entry) => (entry.position === undefined ? [] : [entry.position])),
  };
}
