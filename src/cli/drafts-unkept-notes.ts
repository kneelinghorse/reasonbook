// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Gives the prompt a complete reason for each lost or qualified line from the last reply.
// ABOUTME: Each compact or full note carries the same Stop position for delivery acknowledgement.

import type { DroppedReason } from '../tools/rbook/draft-grammar';
import { UNKEPT_MAX, unkeptExcerpt, type UnkeptRead } from '../tools/rbook/draft-runtime-unkept';
import type { SettleRefusal } from '../tools/rbook/draft-settle';
import { NOTE_REASONS } from './drafts-settle';

/** Every reason Stop keeps: a line the reader dropped, a Settled line not read, a refusal or a note. */
export type UnkeptReason =
  | DroppedReason
  | 'form'
  | 'place'
  | 'transcript'
  | 'order'
  | SettleRefusal
  | 'low-coverage';

const SETTLE_FORM = 'Settled: P<n> by decision <N>';

const BEFORE = ', recorded before the draft';

/** Why a line took no effect, or the note on one that did; `detail` is the store's, never the operator's. */
const WORDS: Readonly<Record<UnkeptReason, (detail: string) => string>> = {
  kind: () => 'its kind is not decision, constraint, rule or profile',
  text: () => 'its text is a placeholder, "nothing" or too short to propose',
  limit: () => 'a reply keeps at most three Would record lines',
  form: () => `a settle is read only from a plain line, ${SETTLE_FORM}`,
  place: () => "a settle is read only in the reply's last lines, above any Would record lines",
  transcript: () =>
    "the hook had only the transcript, which can hold an earlier turn's reply, so it applied no settle",
  'no-draft': (detail) => detail || 'there is no such draft in this store',
  'not-pending': (detail) => `the draft was already ${detail}`,
  'not-decision': (detail) =>
    `only a decision draft settles; a ${detail} draft needs the operator's plain approval`,
  'same-reply': () =>
    "this reply's own Would record line drafts that draft or one on its chain of revisions, which settling it would answer too",
  expired: () => 'the draft expired unanswered',
  'no-decision': (detail) =>
    detail
      ? 'that decision has not reached this copy of a shared record; sync first'
      : 'there is no such decision in this record',
  superseded: (detail) =>
    detail
      ? `that decision was superseded; its chain ends at ${detail}`
      : 'that decision was superseded',
  autonomous: () => 'that decision was recorded autonomously, so it claims no operator approval',
  'unreadable-time': () => "the draft's or the decision's time cannot be read",
  coverage: (detail) =>
    detail.endsWith(BEFORE)
      ? `that decision, recorded before the draft, states only ${detail.slice(0, -BEFORE.length)} of its subject, and an older decision needs 85%`
      : `that decision states only ${detail} of the draft's subject, below 30%`,
  raced: () => 'another call answered the draft first',
  busy: () => 'the store was busy, so the draft stays pending',
  failed: (detail) => `the settle failed (${detail}), so the draft stays pending`,
  order: () =>
    'it took effect, but put Settled lines above any Would record lines: an older Reasonbook hook drops the Would record lines above one',
  'low-coverage': (detail) =>
    `it took effect, though that decision states only ${detail} of the draft's subject; check that it answers it`,
};

const SHORT: Readonly<Record<UnkeptReason, (detail: string) => string>> = {
  kind: () => 'unsupported draft kind',
  text: () => 'placeholder or too little text',
  limit: () => 'at most three Would record lines',
  form: () => 'settle needs a plain Settled line',
  place: () => 'settle outside the final block',
  transcript: () => 'transcript may be from an earlier turn',
  'no-draft': () => 'draft absent from this store',
  'not-pending': () => 'draft is no longer pending',
  'not-decision': () => 'only decision drafts settle',
  'same-reply': () => 'reply also proposes this draft or revision',
  expired: () => 'draft expired',
  'no-decision': (detail) => (detail ? 'decision absent here; sync first' : 'decision absent'),
  superseded: () => 'decision superseded',
  autonomous: () => 'decision recorded autonomously',
  'unreadable-time': () => 'draft or decision time unreadable',
  coverage: (detail) =>
    detail.endsWith(BEFORE)
      ? 'older decision covers less than 85% of draft'
      : 'decision covers less than 30% of draft',
  raced: () => 'draft already answered by another call',
  busy: () => 'store busy; draft pending',
  failed: () => 'settle failed; draft pending',
  order: () => 'put Settled lines above Would record lines',
  'low-coverage': () => 'low overlap; check that the decision answers the draft',
};

export interface UnkeptNote {
  readonly position: number;
  readonly full: string;
  readonly compact: string;
}

/** The two forms describe the same outcome. Neither needs a heading from an earlier entry. */
export function unkeptNotes(read: UnkeptRead): UnkeptNote[] {
  const notes = read.entries.map(({ position, text, reason, detail }) => {
    const taken = NOTE_REASONS.has(reason);
    const known = Object.prototype.hasOwnProperty.call(WORDS, reason);
    const key = reason as UnkeptReason;
    const why = known ? WORDS[key](unkeptExcerpt(detail)) : unkeptExcerpt(reason);
    const short = known ? SHORT[key](detail) : unkeptExcerpt(reason, 32);
    const heading = taken
      ? 'Lines in your last reply took effect with a note'
      : 'Lines in your last reply took no effect; tell the operator';
    return {
      position,
      full: `${heading}: "${unkeptExcerpt(text)}" (${why}).`,
      compact: `Tell the operator: "${unkeptExcerpt(text, 28)}" ${taken ? 'applied' : 'had no effect'} (${short}).`,
    };
  });
  if (read.more) {
    // Stop kept only the count for these positions; they may be refusals or qualified successes.
    const count = `Tell the operator: ${read.more} more lines had a refusal or note.`;
    notes.push({ position: UNKEPT_MAX, full: count, compact: count });
  }
  return notes;
}
