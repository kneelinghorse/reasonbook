// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Prepares replies about pending drafts with their conditions and retained Stop notices.
// ABOUTME: After delivery, counts visible offers and acknowledges only the reported reasons.
import type { ReplyClass } from '../tools/rbook/draft-grammar';
import {
  bumpOffers,
  offerCounts,
  openDraftRuntime,
  sessionStartedAt,
} from '../tools/rbook/draft-runtime';
import { harnessSessionHash } from '../tools/rbook/harness-session';
import { markOffered, pendingDrafts, rawRunner, type DraftRow } from '../tools/rbook/proposals';
import { isReadOnlyAgentSession } from '../tools/rbook/read-only-agent-guard';
import { storedTimeMs } from '../tools/rbook/stored-time';
import { openStore, storeTimeout, checkDeadline, withRuntime } from './drafts-hook-runtime';
import { acknowledgeUnkept, readUnkept } from '../tools/rbook/draft-runtime-unkept';
import { drainDeclines } from './drafts-decline';
import { bindPrompt, type PromptOptions } from './drafts-prompt-binding';
import { unkeptNotes } from './drafts-unkept-notes';
import { renderOffer } from './drafts-offer-text';

export { OFFER_TEXT_MAX } from './drafts-offer-text';
export const OFFERS_PER_START = 3;
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

/** A delayed acknowledgement belongs to the runtime, Stop generation and positions it actually delivered. */
function acknowledge(
  dbPath: string,
  env: NodeJS.ProcessEnv,
  session: string,
  generation: string | null,
  positions: readonly number[]
): void {
  if (!generation || !positions.length) return;
  try {
    const runtime = openDraftRuntime(dbPath, env, {
      existingOnly: true,
      timeoutMs: storeTimeout(),
    });
    if (!runtime) return;
    try {
      acknowledgeUnkept(runtime, session, generation, positions);
    } finally {
      runtime.close();
    }
  } catch (error) {
    // The reason remains available to a later prompt when its acknowledgement cannot be saved.
    process.stderr.write(`draft note acknowledgement failed: ${String(error)}\n`);
  }
}

/** With no pending drafts, even a post-delivery write can only open an existing runtime. */
function notesOnly(
  dbPath: string,
  env: NodeJS.ProcessEnv,
  session: string,
  now: number
): PreparedOffer {
  const runtime = openDraftRuntime(dbPath, env, { readonly: true });
  if (!runtime) return NO_OFFER;
  try {
    const read = readUnkept(runtime, session, now);
    const { text, positions } = renderOffer(unkeptNotes(read));
    if (!text) return NO_OFFER;
    return {
      text,
      offered: 0,
      reply: null,
      commit: () => acknowledge(dbPath, env, session, read.generation, positions),
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
export function prepareOffer(options: PromptOptions): PreparedOffer {
  if (isReadOnlyAgentSession(options.env)) return NO_OFFER;
  const now = options.now ?? Date.now();
  const session = harnessSessionHash(options.rawSessionId);
  const reader = openStore(options.dbPath, true, options.deadlineAtMs);
  let pending: DraftRow[];
  try {
    pending = pendingDrafts(rawRunner(reader));
  } finally {
    reader.close();
  }
  // With nothing pending there is nothing to bind or remind: a shown set left behind names no
  // pending draft, and expires with the session's other words. s109-m02: the lines the last reply
  // lost are still named, from a runtime opened read-only, so none appears where none was; each
  // Stop replaces its retained reasons.
  if (!pending.length) return notesOnly(options.dbPath, options.env, session, now);
  checkDeadline(options.deadlineAtMs);
  const runtime = openDraftRuntime(options.dbPath, options.env, {
    timeoutMs: storeTimeout(options.deadlineAtMs),
  });
  if (!runtime) return NO_OFFER;
  try {
    const binding = bindPrompt(runtime, options, session, now);
    if (!binding) return NO_OFFER;
    const { live, bound, carried, reply } = binding;
    const startedAtMs = sessionStartedAt(runtime, session);
    const counts = offerCounts(runtime, session);
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
    const read = readUnkept(runtime, session, now);
    const {
      text,
      ids: offeredIds,
      positions,
    } = renderOffer(unkeptNotes(read), bound, carried, reminders, reply, binding.retainedDecline);
    if (!text) return NO_OFFER;
    checkDeadline(options.deadlineAtMs);
    let committed = false;
    return {
      text,
      offered: offeredIds.length,
      reply,
      commit: () => {
        if (committed) return;
        committed = true;
        acknowledge(options.dbPath, options.env, session, read.generation, positions);
        if (binding.retryDecline) {
          try {
            withRuntime(options.dbPath, options.env, undefined, (later) =>
              drainDeclines(options.dbPath, later)
            );
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
