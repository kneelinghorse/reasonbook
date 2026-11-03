// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — the words the operator's next prompt gives the agent for each line of its last reply that took no
// ABOUTME: effect (#51, a refused or misformed Settled line) or took effect with a note, telling it to say so.

import type { DroppedReason } from '../tools/rbook/draft-grammar';
import type { UnkeptRead } from '../tools/rbook/draft-runtime-unkept';
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

const item = (entry: { text: string; reason: string; detail: string }): string =>
  // A reason from a newer or older Stop than this prompt hook is shown as its code.
  `"${entry.text}" (${(WORDS[entry.reason as UnkeptReason] ?? (() => entry.reason))(entry.detail)})`;

/**
 * The notes for the operator's next prompt: the lines that took no effect, which the agent is told
 * to tell the operator about, then the settles applied with a note. Empty when there are none.
 */
export function unkeptNotes(read: UnkeptRead): string[] {
  const taken = read.entries.filter((entry) => NOTE_REASONS.has(entry.reason));
  const lost = read.entries.filter((entry) => !NOTE_REASONS.has(entry.reason));
  const notes: string[] = [];
  const parts = lost.map(item);
  if (read.more) parts.push(`${parts.length ? 'and ' : ''}${read.more} more`);
  if (parts.length)
    notes.push(`Lines in your last reply took no effect; tell the operator: ${parts.join('; ')}.`);
  if (taken.length)
    notes.push(`Lines in your last reply took effect with a note: ${taken.map(item).join('; ')}.`);
  return notes;
}
