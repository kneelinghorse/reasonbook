// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — Stop's settle step: the reply's Settled lines in their own IMMEDIATE transaction, after its drafts
// ABOUTME: and shown set are written, and the lines that took no effect, kept for the operator's next prompt to name.

import type { DraftReply } from '../tools/rbook/draft-grammar';
import { pendingDeclines, type DraftRuntime } from '../tools/rbook/draft-runtime';
import type { UnkeptEntry } from '../tools/rbook/draft-runtime-unkept';
import { settleDrafts, type SettleOutcome } from '../tools/rbook/draft-settle';
import type { SettleLine, SettleRead } from '../tools/rbook/draft-settle-grammar';
import { rawRunner } from '../tools/rbook/proposals';
import { checkDeadline, openStore, unexpired } from './drafts-hook-runtime';

/**
 * ORDER (the sprint-109 design, m02 item 1; critic B2, note 3; B3, note 2). Stop writes the reply's
 * Would record drafts first, so a line that revises a draft replaces it; then the shown and kept sets,
 * which leave out every draft a Settled line names whatever the settle's outcome; then the settles
 * here. A busy store or a failed settle therefore loses neither the reply's drafts nor its shown set,
 * and a deadline throw at this step leaves no earlier shown set for the operator's next "yes" to bind.
 */
export function applySettles(options: {
  readonly dbPath: string;
  readonly runtime: DraftRuntime | null;
  readonly session: string;
  readonly lines: readonly SettleLine[];
  readonly sameReply: ReadonlySet<number>;
  readonly now: number;
  readonly deadlineAtMs: number;
}): SettleOutcome[] {
  if (!options.lines.length) return [];
  checkDeadline(options.deadlineAtMs);
  const { runtime, now } = options;
  let db: ReturnType<typeof openStore> | undefined;
  try {
    db = openStore(options.dbPath, false);
    const run = rawRunner(db);
    return db
      .transaction(() =>
        settleDrafts({
          run,
          lines: options.lines,
          sameReply: options.sameReply,
          declines: runtime ? pendingDeclines(runtime) : [],
          isExpired: (draft) => unexpired(runtime, [draft], now).length === 0,
          settledBy: options.session,
          now,
        })
      )
      .immediate();
  } catch (error) {
    // The settle fails into the runtime table: the draft stays pending and Stop still exits 0.
    const code = (error as { code?: string }).code ?? '';
    const busy = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
    const detail = busy
      ? ''
      : (error instanceof Error ? error.message : String(error)).slice(0, 80);
    return options.lines.map((line) => ({
      line,
      applied: false,
      reason: busy ? 'busy' : 'failed',
      detail,
    }));
  } finally {
    db?.close();
  }
}

/** Reasons for a line that took effect with a note; every other reason took no effect. */
export const NOTE_REASONS: ReadonlySet<string> = new Set(['order', 'low-coverage']);

/**
 * What the next prompt names: the Would record lines the reply's reader dropped (#51), the Settled
 * lines not read as a settle, every settle read only from the transcript (which may be an earlier
 * turn's reply, so none is applied), each refusal, and each settle applied with a note.
 */
export function unkeptEntries(
  read: DraftReply,
  settles: SettleRead,
  outcomes: readonly SettleOutcome[],
  fromReply: boolean
): UnkeptEntry[] {
  const entries: UnkeptEntry[] = [
    // From the transcript fallback, which can hold an earlier turn's reply, only Settled lines are
    // named, as the design's false-negative profile says (critic B, round 1, note 10).
    ...(fromReply
      ? read.droppedLines.map((line) => ({ text: line.text, reason: line.reason, detail: '' }))
      : []),
    ...settles.unkept.map((line) => ({ text: line.text, reason: line.reason, detail: '' })),
  ];
  if (!fromReply)
    for (const line of settles.settles)
      entries.push({ text: line.text, reason: 'transcript', detail: '' });
  for (const outcome of outcomes) {
    if (outcome.reason)
      entries.push({ text: outcome.line.text, reason: outcome.reason, detail: outcome.detail });
    if (outcome.applied && outcome.line.misplaced)
      entries.push({ text: outcome.line.text, reason: 'order', detail: '' });
  }
  return entries;
}
