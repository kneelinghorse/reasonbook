// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m12 — whether a prompt the hook receives is the operator's own message or one the harness sent itself:
// ABOUTME: a background task's notice, another session's message, a summary or injected context binds no draft.

import { scheduledPrompt } from './transcript-scan';

/**
 * WHY (learning #481, decision #1511). Claude Code runs the prompt hook for prompts it sends
 * itself, and passes the hook only their text: 2.1.301's hook input carries no origin, and the hook
 * runs before the prompt is written to the transcript. Such a prompt is no answer from the
 * operator, so it binds no draft, and the shown drafts wait for the operator's next message.
 * THE PREDICATE, published before the first edit
 * (rbook/research/2026-10-s97-probes/s97-m12-prompt-origin.json):
 *   - the trimmed text opens with one of HARNESS_OPENINGS (a task notification, another session's
 *     message, a compaction summary, an item Codex injects, an SDK host's polled event), or has
 *     the shape of a declared event (its kind, then an ISO time, on the first two lines); or
 *   - the transcript's recent part holds a ScheduleWakeup or CronCreate call whose prompt is this
 *     text: a scheduled wakeup, which has no opening of its own.
 * FALSE NEGATIVES, NAMED. A wakeup scheduled further back than the transcript tail read, an
 * autonomous loop's wakeup (its prompt is resolved when it fires), a cloud session's notice from
 * another session (its raw text, not seen here), and a harness prompt in a form not seen yet, read
 * as the operator's. FALSE POSITIVES, NAMED: an operator who types a recognized harness opening
 * or a scheduled prompt's exact text binds nothing with it, and answers again.
 */
const HARNESS_OPENINGS = [
  '<task-notification>',
  'Another Claude session sent a message:',
  '<cross-session-message',
  'This session is being continued from a previous conversation',
  '<environment_context>',
  '<external_codex_apps_open_page>',
  '<recommended_plugins>',
  '# AGENTS.md instructions for',
  '<event kind="',
  '[Browser disconnected:',
] as const;

/** A declared event's plain form: its kind, then its ISO time, on the first two lines. */
const DECLARED_EVENT = /^[a-z][a-z0-9_.-]*\n\d{4}-\d{2}-\d{2}T/;

/** What sent the prompt: null for the operator, else the kind of message the harness sent. */
export function harnessPrompt(prompt: string, transcriptPath?: string): string | null {
  const text = prompt.trim();
  const opening = HARNESS_OPENINGS.find((marker) => text.startsWith(marker));
  if (opening) return opening;
  if (DECLARED_EVENT.test(text)) return 'event';
  return transcriptPath && scheduledPrompt(transcriptPath, text) ? 'scheduled' : null;
}
