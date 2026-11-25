// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Binds a prompt to current project rows while the private runtime excludes concurrent settlement.
// ABOUTME: A busy project retains a local decline intent and its original showing for a later retry.
import { classifyReply, PLAIN_REPLY_MAX, type ReplyClass } from '../tools/rbook/draft-grammar';
import {
  namedApprovalTarget,
  restatesStandingSetting,
  uniqueStandingSetting,
} from '../tools/rbook/draft-question';
import {
  bindExcerpt,
  bindWindow,
  clearCurrentQuestion,
  closeWindow,
  EXCERPT_TTL_MS,
  forgetShownAnswers,
  pendingDeclines,
  readExcerpt,
  readShown,
  retainDeclines,
  takeKeptWithTimes,
  takeShown,
  type DraftRuntime,
} from '../tools/rbook/draft-runtime';
import {
  markDeclined,
  pendingDrafts,
  rawRunner,
  type DraftRow,
  type SqlRunner,
} from '../tools/rbook/proposals';
import { applyRetainedDeclines } from './drafts-decline';
import { checkDeadline, openStore, storeTimeout, unexpired } from './drafts-hook-runtime';

export interface PromptOptions {
  readonly dbPath: string;
  readonly rawSessionId: string;
  readonly message: string;
  readonly env: NodeJS.ProcessEnv;
  readonly deadlineAtMs: number;
  readonly now?: number;
}

interface PromptBinding {
  readonly live: DraftRow[];
  readonly bound: DraftRow[];
  readonly carried: DraftRow[];
  readonly reply: ReplyClass | null;
  readonly retainedDecline: boolean;
  readonly retryDecline: boolean;
}

/**
 * Preserve discussions of explicit legacy offers. "Yes, but …" amends an offer; a short
 * endorsement followed by a separate question keeps the existing question/nuance rule.
 * Neither is the grammar for a current-message confirmation naming a whole choice.
 */
function triesToNameChoice(message: string): boolean {
  const text = message.trimStart();
  if (!/^(?:yes\s*,|i approve\b)/i.test(text)) return false;
  if (/^yes\s*,\s*but\b/i.test(text)) return false;
  if (text.includes('?')) {
    const opening = /^yes\s*,\s*(?:this\s+|that\s+|it\s+)?([^.!?\r\n]+)[.!]\s/i.exec(
      text.slice(0, PLAIN_REPLY_MAX + 2)
    );
    if (opening && classifyReply(opening[1]) === 'approval') return false;
  }
  return true;
}

function bindCurrentRows(
  run: SqlRunner,
  runtime: DraftRuntime,
  options: PromptOptions,
  session: string,
  now: number,
  previous: ReturnType<typeof readShown>
): PromptBinding {
  checkDeadline(options.deadlineAtMs);
  applyRetainedDeclines(run, runtime);
  const declined = new Set(pendingDeclines(runtime).map((entry) => entry.id));
  const live = unexpired(runtime, pendingDrafts(run), now).filter((row) => !declined.has(row.id));
  const showing = readShown(runtime, session, now);
  const shown = takeShown(runtime, session, now);
  const kept = takeKeptWithTimes(runtime, session, now).filter((row) => !shown.includes(row.id));
  const earlier = new Set(kept.map((row) => row.id));
  const ordinaryQuestion = previous?.currentQuestion ? previous.ids[0] : undefined;
  const standingId = previous?.standingSetting ? previous.ids[0] : ordinaryQuestion;
  const named = namedApprovalTarget(
    options.message,
    live,
    (row) => row.id === ordinaryQuestion || shown.includes(row.id) || row.sourceSession === session
  );
  const shownSetting =
    standingId !== undefined && !kept.length
      ? live.find((row) => row.id === standingId)
      : undefined;
  const setting =
    shownSetting &&
    restatesStandingSetting(options.message, shownSetting) &&
    uniqueStandingSetting(shownSetting, live) === shownSetting
      ? shownSetting
      : undefined;
  // "Yes, …" may simultaneously name a different decision and restate the shown
  // numeric setting. Only an unambiguous affirmative identifies an operation.
  const target = named && setting ? undefined : (named ?? setting);
  const nameRequired =
    named !== undefined ||
    setting !== undefined ||
    ordinaryQuestion !== undefined ||
    triesToNameChoice(options.message) ||
    classifyReply(options.message) === 'approval';
  // Historical ordered showings may still bind a refusal or question. A context-free approval
  // cannot use those arrays, a carried showing, or an old question token as predecessor evidence.
  const bound = nameRequired ? [] : live.filter((row) => shown.includes(row.id));
  if (
    target &&
    target.replacedBy === null &&
    readExcerpt(runtime, session, target.id, now)?.reply !== 'decline'
  )
    bound.push(target);
  const carried = nameRequired ? [] : live.filter((row) => earlier.has(row.id));
  const late = !nameRequired && showing !== null && showing.at <= now - EXCERPT_TTL_MS;
  let reply: ReplyClass | null = carried.length ? 'other' : null;
  if (bound.length) reply = nameRequired ? 'approval' : classifyReply(options.message, bound);
  if (nameRequired && !bound.length) forgetShownAnswers(runtime, session, [...shown, ...earlier]);
  const boundIds = bound.map((row) => row.id);
  checkDeadline(options.deadlineAtMs);
  if (
    reply === 'decline' &&
    markDeclined(run, boundIds, new Date(now).toISOString()) !== boundIds.length
  )
    throw new Error(
      'The shown drafts could not all be declined; retry after checking their state.'
    );
  if (reply) {
    if (late || reply === 'decline') {
      bindExcerpt(runtime, session, boundIds, options.message, reply, now, { late });
    } else
      bindWindow(
        runtime,
        session,
        boundIds,
        options.message,
        setting ? 'standing-setting' : reply,
        now
      );
    const carriedIds = new Set(carried.map((row) => row.id));
    for (const draft of kept.filter((row) => carriedIds.has(row.id)))
      bindExcerpt(runtime, session, [draft.id], options.message, 'other', now, {
        late: draft.at <= now - EXCERPT_TTL_MS,
        windowSize: bound.length + carried.length,
      });
  }
  return { live, bound, carried, reply, retainedDecline: false, retryDecline: false };
}

/** Retain a refusal only for rows still pending in this snapshot. */
function retainUnwrittenDecline(
  run: SqlRunner,
  runtime: DraftRuntime,
  options: PromptOptions,
  session: string,
  now: number,
  busy: boolean
): PromptBinding | null {
  const showing = readShown(runtime, session, now);
  if (!showing) return null;
  const pending = pendingDrafts(run).filter((row) => showing.ids.includes(row.id));
  const retained = new Set(pendingDeclines(runtime).map((row) => row.id));
  const bound = unexpired(runtime, pending, now).filter((row) => !retained.has(row.id));
  if (!bound.length) return null;
  checkDeadline(options.deadlineAtMs);
  const ids = bound.map((row) => row.id);
  retainDeclines(runtime, ids, now);
  bindExcerpt(runtime, session, ids, options.message, 'decline', now, {
    late: showing.at <= now - EXCERPT_TTL_MS,
  });
  return {
    live: bound,
    bound,
    carried: [],
    reply: 'decline',
    retainedDecline: true,
    retryDecline: busy,
  };
}

function recoverFailedBinding(
  error: unknown,
  runtime: DraftRuntime,
  options: PromptOptions,
  session: string,
  now: number
): PromptBinding | null {
  const code = (error as { code?: string }).code ?? '';
  const busy = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
  if (!code.startsWith('SQLITE_')) throw error;
  if (classifyReply(options.message) !== 'decline') {
    if (!busy) throw error;
    process.stderr.write(`drafts unavailable: project busy; answer not saved: ${String(error)}\n`);
    return null;
  }
  process.stderr.write(`drafts unavailable: decline could not be saved: ${String(error)}\n`);
  const reader = openStore(options.dbPath, true, options.deadlineAtMs);
  try {
    return reader.transaction(() =>
      retainUnwrittenDecline(rawRunner(reader), runtime, options, session, now, busy)
    )();
  } finally {
    reader.close();
  }
}

export function bindPrompt(
  runtime: DraftRuntime,
  options: PromptOptions,
  session: string,
  now: number
): PromptBinding | null {
  runtime.db.pragma(`busy_timeout = ${storeTimeout(options.deadlineAtMs)}`);
  const outcome = runtime.db
    .transaction(() => {
      // A new prompt ends the previous turn, even if its Stop or the next offer is lost.
      closeWindow(runtime, session, now);
      // Consume any ordinary showing before opening the project; even failed prompts cannot
      // revive its earlier words or let a retained decline pick up an unverified question.
      const previous = readShown(runtime, session, now);
      if (
        previous &&
        (previous.currentQuestion ||
          previous.standingSetting ||
          classifyReply(options.message) === 'approval')
      )
        forgetShownAnswers(runtime, session, previous.ids);
      clearCurrentQuestion(runtime, session);
      try {
        checkDeadline(options.deadlineAtMs);
        // The savepoint rolls back the runtime changes too if the project commit fails.
        const binding = runtime.db.transaction(() => {
          const writer = openStore(options.dbPath, false, options.deadlineAtMs);
          try {
            return writer
              .transaction(() =>
                bindCurrentRows(rawRunner(writer), runtime, options, session, now, previous)
              )
              .immediate();
          } finally {
            writer.close();
          }
        })();
        return { binding };
      } catch (error) {
        try {
          const binding = runtime.db.transaction(() =>
            recoverFailedBinding(error, runtime, options, session, now)
          )();
          return { binding };
        } catch (failure) {
          return { failure };
        } finally {
          // A current-only question belongs to this prompt even when the project write fails.
          // Commit its invalidation before surfacing a failure. Legacy showings retain their lease.
          clearCurrentQuestion(runtime, session);
        }
      }
    })
    .immediate();
  if ('failure' in outcome) throw outcome.failure;
  return outcome.binding;
}
