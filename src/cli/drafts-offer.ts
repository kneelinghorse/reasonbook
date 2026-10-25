// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Binds operator prompts to shown drafts without upgrading late words into plain approval.
// ABOUTME: Persists declines before recording can use them, retaining their showing across busy-store retries.
import { classifyReply, type ReplyClass } from '../tools/rbook/draft-grammar';
import {
  bindWindow,
  bindExcerpt,
  EXCERPT_TTL_MS,
  readShown,
  retainDeclines,
  pendingDeclines,
  restoreShown,
  bumpOffers,
  closeWindow,
  offerCounts,
  openDraftRuntime,
  sessionStartedAt,
  takeKeptWithTimes,
  takeShown,
} from '../tools/rbook/draft-runtime';
import { harnessSessionHash } from '../tools/rbook/harness-session';
import {
  draftLabel,
  markOffered,
  pendingDrafts,
  rawRunner,
  type DraftRow,
} from '../tools/rbook/proposals';
import { isReadOnlyAgentSession } from '../tools/rbook/read-only-agent-guard';
import { storedTimeMs } from '../tools/rbook/stored-time';
import {
  openStore,
  storeTimeout,
  checkDeadline,
  withRuntime,
  unexpired,
} from './drafts-hook-runtime';

import { drainDeclines, retryRetainedDeclines } from './drafts-decline';

export const OFFERS_PER_START = 3;
export const OFFER_TEXT_MAX = 1000;
const FULL_TEXT_MAX = 300;
const COMPACT_TEXT_MAX = 80;

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export interface PreparedOffer {
  /** The text to inject ahead of recall; empty when nothing is offered. */
  readonly text: string;
  readonly offered: number;
  /** How the operator's message reads, when it answered drafts; else null. */
  readonly reply: ReplyClass | null;
  /** After the output is delivered: count the offers and stamp first offers. Never throws. */
  commit(): void;
}

export const NO_OFFER: PreparedOffer = { text: '', offered: 0, reply: null, commit: () => {} };

const KIND_NOTE: Readonly<Record<string, string>> = {
  constraint: ' It is recorded as a constraint, and only on the operator’s approval.',
  rule: ' It is recorded as a standing rule (an evergreen learning), and only on the operator’s approval.',
  profile: ' It is a line for the operator profile, written only on the operator’s approval.',
};

function fullOffer(draft: DraftRow): string {
  const label = draftLabel(draft.id);
  let text = `Reasonbook draft ${label} (${draft.kind}), which your last reply put to the operator: "${cut(draft.text, FULL_TEXT_MAX)}".`;
  text += KIND_NOTE[draft.kind] ?? '';
  if (draft.evidence.length) text += ` It names ${draft.evidence.slice(0, 3).join(', ')}.`;
  if (draft.outsideContent === 1)
    text +=
      ' This session read outside content (web pages or other projects’ records) before it was drafted.';
  return text;
}

/**
 * s97-m12 (critic round 2): a draft shown before the latest reply. The operator's message answers
 * that reply, so a plain yes or no to it settles nothing here, and a record of this draft reads
 * agent-judged.
 */
function earlierOffer(draft: DraftRow): string {
  const label = draftLabel(draft.id);
  return `Reasonbook draft ${label} (${draft.kind}) was shown before your last reply and not answered since: "${cut(draft.text, FULL_TEXT_MAX)}". Record it with fromDraft="${label}" only if the operator's message plainly speaks to it (it reads agent-judged); a yes or no to your last reply settles nothing about it.`;
}

function instruction(reply: ReplyClass, bound: readonly DraftRow[]): string {
  const labels = bound.map((draft) => draftLabel(draft.id));
  const one = labels.length === 1;
  const standing = bound.some((draft) => draft.kind !== 'decision');
  const call = (label: string) =>
    `rbook_decisions(action="record", content=<${label}'s text as drafted>, fromDraft="${label}")`;
  switch (reply) {
    case 'approval':
      return one
        ? `The operator’s message is a plain approval of ${labels[0]}: record it now with ${call(labels[0])}. A record that adds to the draft reads agent-judged.`
        : `The operator’s message approves ${labels.join(', ')} together: record each with ${call('P<n>')}; several at once read agent-judged. Ask if it is unclear which.`;
    case 'question':
      return `The operator’s message asks about ${labels.join(', ')}: answer, leave it unrecorded, and end with its Would record line again, revised if your answer changes it.`;
    default:
      return (
        `Only if this message approves ${labels.join(', ')}, record it with ${call(one ? labels[0] : 'P<n>')} and the operator's nuance folded in (it reads agent-judged); ask first when the nuance is unclear or conflicts with a record. An amendment gets a revised Would record line; otherwise leave it pending.` +
        (standing
          ? ' A constraint, rule or profile line is recorded only on a plain approval: propose it again instead.'
          : '')
      );
  }
}

function reminder(draft: DraftRow, later: boolean): string {
  const head = `${draftLabel(draft.id)} (${draft.kind}) "${cut(draft.text, COMPACT_TEXT_MAX)}"`;
  return later
    ? `From an earlier session, awaiting the operator: ${head} — name it as "draft ${draftLabel(draft.id)}" with its subject.`
    : `Still pending: ${head} — not answered; if it still matters, end a reply with its Would record line again.`;
}

/**
 * Bind the operator's message to what the reply before it showed, and remind the agent of other
 * eligible drafts (B6–B8, folded). Runs before any skip rule; the caller emits `text`, then calls
 * `commit`. Writes: the session's runtime words and window, and in the store a decline or a first
 * offer's time (the prompt hook's one store write, named in SECURITY.md).
 */
export function prepareOffer(options: {
  readonly dbPath: string;
  readonly rawSessionId: string;
  readonly message: string;
  readonly env: NodeJS.ProcessEnv;
  readonly deadlineAtMs: number;
  readonly now?: number;
}): PreparedOffer {
  if (isReadOnlyAgentSession(options.env)) return NO_OFFER;
  const now = options.now ?? Date.now();
  const session = harnessSessionHash(options.rawSessionId);
  const reader = openStore(options.dbPath, true);
  let pending: DraftRow[];
  try {
    pending = pendingDrafts(rawRunner(reader));
  } finally {
    reader.close();
  }
  // With nothing pending there is nothing to bind or remind, and no runtime is touched: a shown
  // set left behind names no pending draft, and expires with the session's other words.
  if (!pending.length) return NO_OFFER;
  checkDeadline(options.deadlineAtMs);
  const runtime = openDraftRuntime(options.dbPath, options.env, { timeoutMs: storeTimeout() });
  if (!runtime) return NO_OFFER;
  try {
    if (pendingDeclines(runtime).length) {
      retryRetainedDeclines(options.dbPath, runtime);
      const refreshed = openStore(options.dbPath, true);
      try {
        pending = pendingDrafts(rawRunner(refreshed));
      } finally {
        refreshed.close();
      }
    }
    const declined = new Set(pendingDeclines(runtime).map((entry) => entry.id));
    // One message answers one reply: what it showed is taken now, whether or not it binds. Drafts
    // an earlier reply showed, kept when the harness opened a turn itself, are taken with it, and
    // bind only as words the agent judges: this message answers the latest reply (s97-m12).
    const showing = readShown(runtime, session, now);
    const shown = takeShown(runtime, session, now);
    const kept = takeKeptWithTimes(runtime, session, now).filter((row) => !shown.includes(row.id));
    const earlier = kept.map((row) => row.id);
    const late = showing !== null && showing.at <= now - EXCERPT_TTL_MS;
    const startedAtMs = sessionStartedAt(runtime, session);
    const counts = offerCounts(runtime, session);
    const live = unexpired(runtime, pending, now).filter((draft) => !declined.has(draft.id));
    const bound = live.filter((draft) => shown.includes(draft.id));
    const carried = live.filter((draft) => earlier.includes(draft.id));
    const reminders: Array<{ draft: DraftRow; later: boolean }> = [];
    for (const draft of live) {
      // A draft approved and then revised waits to be recorded in its own words, not for an answer.
      if (bound.includes(draft) || carried.includes(draft) || draft.replacedBy !== null) continue;
      const createdMs = storedTimeMs(draft.createdAt);
      const count = counts.get(draft.id) ?? 0;
      const thisStart =
        draft.sourceSession === session && (startedAtMs === null || createdMs >= startedAtMs);
      const later = startedAtMs !== null && startedAtMs > createdMs;
      if ((thisStart && count < OFFERS_PER_START) || (later && count === 0))
        reminders.push({ draft, later: !thisStart });
    }
    if (!bound.length && !carried.length && !reminders.length) return NO_OFFER;
    checkDeadline(options.deadlineAtMs);
    const boundIds = bound.map((draft) => draft.id);
    const carriedIds = carried.map((draft) => draft.id);
    const labels = bound.map((draft) => draftLabel(draft.id));
    const classified = bound.length
      ? classifyReply(options.message)
      : carried.length
        ? 'other'
        : null;
    const reply = late && classified === 'approval' ? 'other' : classified;
    const lines: string[] = [];
    if (reply === 'decline') {
      try {
        retainDeclines(runtime, boundIds, now);
      } catch (error) {
        if (showing) restoreShown(runtime, session, showing);
        throw error;
      }
    }
    // Words survive for two hours; a late answer grants no direct-record window. A decline's
    // excerpt precedes its store write so an older approval cannot remain usable during a lock.
    if (reply) {
      if (late || reply === 'decline') {
        closeWindow(runtime, session);
        bindExcerpt(runtime, session, boundIds, options.message, reply, now, { late });
      } else bindWindow(runtime, session, boundIds, options.message, reply, now);
      for (const draft of kept.filter((row) => carriedIds.includes(row.id)))
        bindExcerpt(runtime, session, [draft.id], options.message, 'other', now, {
          late: draft.at <= now - EXCERPT_TTL_MS,
          windowSize: boundIds.length + carriedIds.length,
        });
    }
    const decline = (): void => {
      withRuntime(options.dbPath, options.env, undefined, (current) =>
        drainDeclines(options.dbPath, current)
      );
    };
    let retryDecline = false;
    if (reply === 'decline') {
      try {
        decline();
        lines.push(
          `The operator declined ${labels.join(', ')}; ${labels.length === 1 ? 'it is' : 'they are'} not recorded.`
        );
      } catch (error) {
        // Delivery can fail before commit runs. Restore now, preserving the original lease and
        // never overwriting a newer Stop; commit retries a busy write once after delivery.
        if (showing) restoreShown(runtime, session, showing);
        retryDecline = ['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(
          (error as { code?: string }).code ?? ''
        );
        lines.push(
          `The operator declined ${labels.join(', ')}, but the decline could not be saved. Do not record it; the shown draft is retained for another prompt.`
        );
        process.stderr.write(
          `drafts unavailable: decline not saved; shown drafts retained: ${String(error)}\n`
        );
      }
    } else if (reply && bound.length) {
      // The instruction leads, so the 1,000-character cut can only shorten offers (the build
      // critic, N5).
      lines.push(instruction(reply, bound), ...bound.map(fullOffer));
    }
    lines.push(...carried.map(earlierOffer));
    lines.push(...reminders.map((item) => reminder(item.draft, item.later)));
    let text = lines.join('\n');
    if (text.length > OFFER_TEXT_MAX) text = `${text.slice(0, OFFER_TEXT_MAX - 1).trimEnd()}…`;
    const offeredIds = [
      ...(reply === 'decline' ? [] : boundIds),
      ...carriedIds,
      ...reminders.map((item) => item.draft.id),
    ];
    return {
      text,
      offered: offeredIds.length,
      reply,
      commit: () => {
        if (retryDecline) {
          retryDecline = false;
          try {
            decline();
          } catch (error) {
            process.stderr.write(
              `drafts unavailable: decline retry failed; shown drafts retained: ${String(error)}\n`
            );
          }
        }
        if (!offeredIds.length) return;
        try {
          withRuntime(options.dbPath, options.env, undefined, (later) =>
            bumpOffers(later, session, offeredIds)
          );
          const writer = openStore(options.dbPath, false);
          try {
            markOffered(rawRunner(writer), offeredIds, new Date(now).toISOString());
          } finally {
            writer.close();
          }
        } catch {
          // The output is already out; a missed count only lengthens the reminders by one message.
        }
      },
    };
  } finally {
    runtime.close();
  }
}
