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

import { clearUnkept, readUnkept } from '../tools/rbook/draft-runtime-unkept';
import { drainDeclines, retryRetainedDeclines } from './drafts-decline';
import { unkeptNotes } from './drafts-unkept-notes';

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

function fullOffer(draft: DraftRow, compact = false): string {
  const label = draftLabel(draft.id);
  let text = compact
    ? `Draft ${label} (${draft.kind}), from your last reply: "${cut(draft.text, COMPACT_TEXT_MAX)}".`
    : `Reasonbook draft ${label} (${draft.kind}), which your last reply put to the operator: "${cut(draft.text, FULL_TEXT_MAX)}".`;
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

const STANDING =
  ' A constraint, rule or profile line is recorded only on a plain approval: propose it again instead.';

function instruction(reply: ReplyClass, bound: readonly DraftRow[]): string {
  const labels = bound.map((draft) => draftLabel(draft.id));
  const list = labels.join(', ');
  const one = labels.length === 1;
  const them = one ? 'it' : 'them';
  const standing = bound.some((draft) => draft.kind !== 'decision');
  const decides = bound.some((draft) => draft.kind === 'decision');
  // s107-m02 (#877): fromDraft alone records the draft's own words, so a plain approval sends
  // nothing else; content carries only the operator's nuance folded into the draft.
  const call = (label: string) => `rbook_decisions(action="record", fromDraft="${label}")`;
  const nuanced = (label: string) =>
    `rbook_decisions(action="record", content=<${label} with the operator's nuance folded in>, fromDraft="${label}")`;
  switch (reply) {
    case 'approval':
      return one
        ? `The operator’s message is a plain approval of ${labels[0]}: record it now with ${call(labels[0])}. A record that adds to the draft reads agent-judged.`
        : `The operator’s message approves ${labels.join(', ')} together: record each with ${call('P<n>')}; several at once read agent-judged. Ask if it is unclear which.`;
    case 'question': {
      // s109-m03 (settled item 7): a question may be about something else. Answering comes first,
      // and records only when every question is; a standing line still needs a plain approval, so
      // with none but standing lines bound there is nothing to record (critic B, round 1).
      // "As drafted" (round 3, I1): an approval that amends the draft ("yes, but weekly") gets a
      // revised line, never a record of the words it amended.
      const answer = `If the operator’s message asks about ${list} or amends ${them}, answer and end with ${one ? 'its Would record line' : 'their Would record lines'} again, revised if needed, leaving ${them} unrecorded.`;
      const record = decides
        ? ` Only if it approves ${list} as drafted and every question is about something else, record ${one ? 'it' : 'each'} with ${call(one ? labels[0] : 'P<n>')} (it reads agent-judged); otherwise leave ${them} pending.`
        : ` Otherwise leave ${them} pending.`;
      return answer + record + (standing ? STANDING : '');
    }
    default: {
      // s109-m03 (critics A and B, rounds 1 and 2): rule R-c reads some questions about a draft as
      // other, so one asking about any of them records none; kept short, since every message that is
      // not a plain answer gets this instruction, and the lost-line notes follow the offers.
      const record = decides
        ? `Only if this message approves ${list} and asks nothing about ${one ? 'it' : 'any of them'}, record ${one ? 'it' : 'each'} with ${nuanced(one ? labels[0] : 'P<n>')} (it reads agent-judged); ask first when the nuance is unclear or conflicts with a record. `
        : '';
      return `${record}A question about ${them} or an amendment gets an answer and ${one ? 'its Would record line' : 'their Would record lines'} again, revised if needed; otherwise leave ${them} pending.${standing ? STANDING : ''}`;
    }
  }
}

/**
 * s109-m02 (settled item 1): a recorded decision that already answered a decision draft settles it by
 * a reply line. Both clauses are taught everywhere the line is: above any Would record lines, since a
 * 4.10.0 Stop hook stops at it and keeps the lines below, and the draft named only there, since an
 * older hook still binds a draft named "draft P<n>" in prose.
 */
export function settleTeaching(label: string): string {
  return `If a recorded decision already answered it, end your reply with "Settled: ${label} by decision <N>" above any Would record lines instead, and name the draft only in that line.`;
}

function reminder(draft: DraftRow, later: boolean): string {
  const label = draftLabel(draft.id);
  const head = `${label} (${draft.kind}) "${cut(draft.text, COMPACT_TEXT_MAX)}"`;
  const settle = draft.kind === 'decision' ? ` ${settleTeaching(label)}` : '';
  return later
    ? `From an earlier session, awaiting the operator: ${head} — name it as "draft ${label}" with its subject.${settle}`
    : `Still pending: ${head} — not answered; if it still matters, end a reply with its Would record line again.${settle}`;
}

/** The last reply's lost lines alone, read from a runtime opened read-only; nothing is cleared. */
function notesOnly(
  dbPath: string,
  env: NodeJS.ProcessEnv,
  session: string,
  now: number
): PreparedOffer {
  const runtime = openDraftRuntime(dbPath, env, { readonly: true });
  if (!runtime) return NO_OFFER;
  try {
    const text = unkeptNotes(readUnkept(runtime, session, now)).join('\n');
    if (!text) return NO_OFFER;
    return {
      text: text.length > OFFER_TEXT_MAX ? `${text.slice(0, OFFER_TEXT_MAX - 1).trimEnd()}…` : text,
      offered: 0,
      reply: null,
      commit: () => {},
    };
  } finally {
    runtime.close();
  }
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
  // With nothing pending there is nothing to bind or remind: a shown set left behind names no
  // pending draft, and expires with the session's other words. s109-m02: the lines the last reply
  // lost are still named, from a runtime opened read-only, so none appears where none was; the next
  // Stop replaces what this cannot clear.
  if (!pending.length) return notesOnly(options.dbPath, options.env, session, now);
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
    const notes = unkeptNotes(readUnkept(runtime, session, now));
    if (!bound.length && !carried.length && !reminders.length && !notes.length) return NO_OFFER;
    checkDeadline(options.deadlineAtMs);
    const boundIds = bound.map((draft) => draft.id);
    const carriedIds = carried.map((draft) => draft.id);
    const labels = bound.map((draft) => draftLabel(draft.id));
    const classified = bound.length
      ? classifyReply(options.message, bound)
      : carried.length
        ? 'other'
        : null;
    const reply = late && classified === 'approval' ? 'other' : classified;
    const lines: string[] = [];
    let offersFrom = -1;
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
      lines.push(instruction(reply, bound));
      offersFrom = lines.length;
      lines.push(...bound.map((draft) => fullOffer(draft)));
    }
    // s109-m02: after the instruction and the bound offers, so the cut can only shorten what follows.
    lines.push(...notes);
    lines.push(...carried.map(earlierOffer));
    lines.push(...reminders.map((item) => reminder(item.draft, item.later)));
    let text = lines.join('\n');
    // s109-m03: past the limit the bound offers go compact before anything is cut, so less of each
    // draft's notes and of the lines after the offers (lost lines, earlier and pending drafts) is
    // cut; the agent's last reply holds the drafts in full (critic B, round 1; verifier B, round 2).
    if (text.length > OFFER_TEXT_MAX && offersFrom >= 0) {
      lines.splice(offersFrom, bound.length, ...bound.map((draft) => fullOffer(draft, true)));
      text = lines.join('\n');
    }
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
        if (notes.length)
          try {
            withRuntime(options.dbPath, options.env, undefined, (later) =>
              clearUnkept(later, session)
            );
          } catch {
            // Named once already; the next Stop replaces them.
          }
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
