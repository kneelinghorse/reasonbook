// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Evaluates whether an operator's answered draft may become a record and how approval is known.
// ABOUTME: Refusals preserve draft lifecycle rules, late-answer evidence and pending-decline protection.

import * as path from 'path';
import { currentCodexRequest } from '../../codex-request-context';
import { formatCliRemedy } from '../../utils/cli-remedy';
import type { RbookDatabaseClient } from './client';
import { CONTENT_FLOOR, draftCoverage, recordStatesDraft, type ReplyClass } from './draft-grammar';
import { openDraftRuntime, readExcerpt, startsSince, pendingDeclines } from './draft-runtime';
import { RBOOK_ERROR_CODES } from './errors';
import {
  clientRunner,
  draftLabel,
  getDraft,
  isExpired,
  latestRevision,
  newestPending,
  parseDraftId,
  proposalsTableExists,
  type ApprovalMode,
  type DraftRow,
  type SqlRunner,
} from './proposals';
import { currentSessionOwner } from './session-owner';
import { storedTimeMs } from './stored-time';
import type { RbookToolError } from './types';

export interface DraftEvaluation {
  readonly draft: DraftRow;
  readonly label: string;
  readonly mode: ApprovalMode;
  /** The operator's message, for approved and agent-judged. */
  readonly words: string | null;
  /** s97-m12: the share of the draft's own subject the content holds (draftCoverage). */
  readonly coverage: number;
}

/** The recording server's harness session hash, or null when it writes as a process. */
export function harnessSessionOf(dbPath: string): string | null {
  const owner = currentSessionOwner(dbPath);
  return owner.kind === 'external' && owner.key.startsWith('ext:') ? owner.key.slice(4) : null;
}

/** Where a record is, as a person reads it: a profile line has no id of its own. */
const recordedAs = (recordId: string): string =>
  recordId === 'profile' ? 'recorded in the operator profile' : `recorded as ${recordId}`;

function notPending(
  draft: DraftRow,
  label: string,
  run: SqlRunner,
  expired: (row: DraftRow) => boolean
): RbookToolError {
  // s100-m02 (verification rounds 1 and 2): a replaced draft names where its chain ends, which may
  // be recorded already, declined or expired, rather than the next link alone.
  const end =
    draft.outcome === 'replaced' && draft.replacedBy
      ? getDraft(run, latestRevision(run, draft.replacedBy))
      : undefined;
  const live = end?.outcome === 'pending' && !expired(end);
  const endState = !end
    ? ''
    : end.recordId
      ? `, ${recordedAs(end.recordId)}`
      : end.outcome === 'declined'
        ? ', which the operator declined'
        : end.outcome === 'pending' && !live
          ? ', which expired unanswered'
          : '';
  const states: Record<string, string> = {
    approved: `was already approved and ${draft.recordId ? recordedAs(draft.recordId) : 'recorded'}`,
    declined: 'was declined by the operator',
    replaced: end
      ? `was replaced by its revision ${draftLabel(end.id)}${endState}`
      : 'was replaced by a revision',
    answered: `was answered by ${draft.recordId === 'profile' ? 'a line in the operator profile' : `a record (${draft.recordId ?? 'unknown'})`}`,
  };
  // The choice is recorded already: by this draft, by the record that answered it, or at its end.
  const recorded =
    end?.recordId ??
    (draft.outcome === 'approved' || draft.outcome === 'answered' ? draft.recordId : null);
  return {
    code: RBOOK_ERROR_CODES.DRAFT_NOT_PENDING,
    message: `Draft ${label} ${states[draft.outcome] ?? `is ${draft.outcome}`}; nothing was recorded.`,
    suggestion: live
      ? `Record the revision instead, with fromDraft="${draftLabel(end!.id)}", once the operator approves it.`
      : recorded
        ? `Nothing to record from this draft: its choice is ${recordedAs(recorded)}.`
        : 'Nothing to record from this draft. Propose the choice again with a Would record line if it still matters.',
  };
}

const REPLY_WORDS: Readonly<Record<ReplyClass, string>> = {
  approval: 'an approval of several drafts at once',
  decline: 'a decline',
  question: 'a question',
  other: 'not a plain approval',
};

/** The one refusal for a draft the operator has not plainly approved here; its remedy re-proposes. */
function approvalRequired(draft: DraftRow, label: string, why: string): RbookToolError {
  const codexRemedy = currentCodexRequest()
    ? ' Keep one Codex conversation running for both proposal and approval; separate codex exec / codex exec resume runs end the hook session. Re-propose and approve there.'
    : '';
  return {
    code: RBOOK_ERROR_CODES.APPROVAL_REQUIRED,
    message: `Draft ${label} (${draft.kind}) was not recorded: ${why}`,
    suggestion: `End a reply with "Would record${draft.kind === 'decision' ? '' : ` (${draft.kind})`}: ${draft.text.slice(0, 80)}" (revised if needed), and record it after the operator approves it.${codexRemedy}`,
  };
}

/** Which draft, whether it can still be recorded, and how its approval is known. */
export function evaluateDraft(
  client: RbookDatabaseClient,
  fromDraft: unknown,
  content: string,
  env: NodeJS.ProcessEnv,
  now: number
): { ok: true; value: DraftEvaluation } | { ok: false; error: RbookToolError } {
  const id = parseDraftId(
    typeof fromDraft === 'string' || typeof fromDraft === 'number' ? fromDraft : null
  );
  if (id === null)
    return {
      ok: false,
      error: {
        code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
        message: `fromDraft must be a draft id such as "P3"; got ${JSON.stringify(fromDraft)}.`,
        field: 'fromDraft',
        providedValue: fromDraft,
        suggestion: 'Use the id Reasonbook gave the draft (P<n>), or record without fromDraft.',
      },
    };
  const label = draftLabel(id);
  const run = clientRunner(client);
  const draft = proposalsTableExists(run) ? getDraft(run, id) : undefined;
  if (!draft)
    return {
      ok: false,
      error: {
        code: RBOOK_ERROR_CODES.DRAFT_NOT_FOUND,
        message: `No draft ${label} in this project's store; nothing was recorded.`,
        suggestion: `Check the project (projectRoot) and the id with ${formatCliRemedy('drafts list', { projectRoot: path.resolve(client.path, '../../..') })}, or record without fromDraft.`,
      },
    };
  const runtime = openDraftRuntime(client.path, env, { readonly: true });
  try {
    if (draft.outcome !== 'pending') {
      const expired = (row: DraftRow): boolean =>
        isExpired(row, runtime ? startsSince(runtime, storedTimeMs(row.createdAt)) : 0, now);
      return { ok: false, error: notPending(draft, label, run, expired) };
    }
    if (runtime && pendingDeclines(runtime).some((entry) => entry.id === id))
      return {
        ok: false,
        error: {
          code: RBOOK_ERROR_CODES.DRAFT_NOT_PENDING,
          message: `The operator declined draft ${label}; its store write is pending and nothing was recorded.`,
          suggestion: 'Do not record it. A later prompt or reply retries saving the decline.',
        },
      };
    const starts = runtime ? startsSince(runtime, storedTimeMs(draft.createdAt)) : 0;
    if (isExpired(draft, starts, now))
      return {
        ok: false,
        error: {
          code: RBOOK_ERROR_CODES.DRAFT_NOT_PENDING,
          message: `Draft ${label} expired unanswered (7 days or 3 session starts); an expired draft is never recorded.`,
          suggestion: 'Propose the choice again with a Would record line if it still matters.',
        },
      };
    // s97-m12: a revision shown after the operator plainly approved this draft leaves that approval
    // with this draft's own words only (learning #481).
    if (draft.replacedBy !== null && !recordStatesDraft(draft.text, content)) {
      // Its revision may itself have been revised: name the newest still pending (critic round 2),
      // and none when the operator declined them all (s100-m02, verification round).
      const newest = newestPending(run, draft.id);
      return {
        ok: false,
        error: {
          code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
          message: `Draft ${label} was revised by ${draftLabel(draft.replacedBy)} after the operator approved it, so their approval records only ${label}'s own words.`,
          field: 'content',
          suggestion:
            newest === draft.id
              ? `Record ${label} exactly as the operator approved it.`
              : `Record ${label} exactly as the operator approved it, or record ${draftLabel(newest)} once the operator answers it.`,
        },
      };
    }
    // s97-m12: measured on the draft's own subject, so a short content does not stand for all of it.
    const coverage = draftCoverage(draft.text, content);
    if (coverage < CONTENT_FLOOR)
      return {
        ok: false,
        error: {
          code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
          message: `The content does not state draft ${label} ("${draft.text.slice(0, 120)}"); the operator's approval covers only what the draft said.`,
          field: 'content',
          suggestion: `Record ${label}'s decision, with any nuance folded in. If the decision itself changed, end your reply with a revised Would record line so the operator approves the new text, or record it without fromDraft.`,
        },
      };
    const session = harnessSessionOf(client.path);
    const excerpt = session && runtime ? readExcerpt(runtime, session, id, now) : null;
    if (excerpt?.reply === 'decline')
      return {
        ok: false,
        error: {
          code: RBOOK_ERROR_CODES.DRAFT_NOT_PENDING,
          message: `The operator declined draft ${label}; nothing was recorded.`,
          suggestion: 'Do not record it. Propose a different choice with a new Would record line.',
        },
      };
    if (session && !excerpt)
      return {
        ok: false,
        error: approvalRequired(
          draft,
          label,
          'the operator has not answered it in this conversation within the last two hours, and a draft nobody answered is never recorded.'
        ),
      };
    const plain = excerpt?.reply === 'approval' && !excerpt.late;
    if (draft.kind !== 'decision' && !plain)
      return {
        ok: false,
        error: approvalRequired(
          draft,
          label,
          excerpt
            ? `a ${draft.kind} is written only on the operator's plain approval, and their message was ${REPLY_WORDS[excerpt.reply as ReplyClass] ?? 'not one'}.`
            : `a ${draft.kind} needs the operator's approval in a conversation with Reasonbook hooks, and this server has none.`
        ),
      };
    const single = plain && excerpt?.windowSize === 1;
    const mode: ApprovalMode = !excerpt
      ? 'agent-attested'
      : single && (draft.kind !== 'decision' || recordStatesDraft(draft.text, content))
        ? 'approved'
        : 'agent-judged';
    return {
      ok: true,
      value: { draft, label, mode, words: excerpt ? excerpt.message : null, coverage },
    };
  } finally {
    runtime?.close();
  }
}
