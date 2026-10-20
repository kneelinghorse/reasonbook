// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — turning an answered draft into a record: which draft, how its approval is known (approved,
// ABOUTME: agent-judged, agent-attested), and the constraint, rule and profile kinds, claimed before they are written.

import * as path from 'path';
import { formatCliRemedy } from '../../utils/cli-remedy';
import type { RbookDatabaseClient } from './client';
import { withClientAsync } from './client';
import { rbookSessionCapture } from './rbook-session-capture';
import {
  ANSWER_COVERAGE,
  CONTENT_FLOOR,
  draftCoverage,
  recordStatesDraft,
  type DraftKind,
  type ReplyClass,
} from './draft-grammar';
import { openDraftRuntime, openWindow, readExcerpt, startsSince } from './draft-runtime';
import { RBOOK_ERROR_CODES, createError, createSuccess } from './errors';
import { addProfileLine, readProfile } from './operator-profile';
import {
  clientRunner,
  draftLabel,
  getDraft,
  isExpired,
  latestRevision,
  newestPending,
  parseDraftId,
  settleRevised,
  pendingDrafts,
  proposalsTableExists,
  type ApprovalMode,
  type DraftRow,
  type SqlRunner,
} from './proposals';
import { currentSessionOwner } from './session-owner';
import { storedTimeMs } from './stored-time';
import type { RbookToolError, RbookToolResult } from './types';
import { sanitizeContentField } from '../../intelligence/content-sanitizer';
import { computeContentHash, SAME_TEXT_SQL } from './schema-migrations';

/**
 * Build plan B9–B12: hooks bind words by store/session/draft for two hours; subagents share that
 * binding. Hook-less servers attest decisions only. Other kinds need plain approval and use draft
 * text. Approved decisions need one draft and recordStatesDraft (only whitespace may differ);
 * other same-subject wording reads agent-judged, without guessing at equivalent meaning.
 * Decisions approve atomically; other kinds claim first and release on failure.
 */
export interface DraftEvaluation {
  readonly draft: DraftRow;
  readonly label: string;
  readonly mode: ApprovalMode;
  /** The operator's message, for approved and agent-judged. */
  readonly words: string | null;
  /** s97-m12: the share of the draft's own subject the content holds (draftCoverage). */
  readonly coverage: number;
}

export interface ApprovalEcho {
  readonly draft: string;
  readonly kind: DraftKind;
  readonly mode: ApprovalMode;
  readonly words: string | null;
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
  return {
    code: RBOOK_ERROR_CODES.APPROVAL_REQUIRED,
    message: `Draft ${label} (${draft.kind}) was not recorded: ${why}`,
    suggestion: `End a reply with "Would record${draft.kind === 'decision' ? '' : ` (${draft.kind})`}: ${draft.text.slice(0, 80)}" (revised if needed), and record it after the operator approves it.`,
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
    const plain = excerpt?.reply === 'approval';
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

export function approvalEcho(evaluation: DraftEvaluation): ApprovalEcho {
  return {
    draft: evaluation.label,
    kind: evaluation.draft.kind,
    mode: evaluation.mode,
    words: evaluation.words,
  };
}

export interface DirectRecordAnswers {
  /** Window drafts the record covers: marked answered in the record's transaction. */
  readonly answered: readonly number[];
  /** Window drafts it does not: named on the answer so the same choice is not recorded twice. */
  readonly stillPending: readonly number[];
}

/**
 * A record made without fromDraft while the operator's message is open on drafts (B12, folded):
 * the drafts it covers are answered by it; the others stay pending and are named.
 */
export function directRecordAnswers(
  client: RbookDatabaseClient,
  content: string,
  env: NodeJS.ProcessEnv,
  now: number
): DirectRecordAnswers {
  const none = { answered: [], stillPending: [] };
  const session = harnessSessionOf(client.path);
  if (!session) return none;
  const run = clientRunner(client);
  if (!proposalsTableExists(run)) return none;
  const runtime = openDraftRuntime(client.path, env, { readonly: true });
  if (!runtime) return none;
  try {
    const window = openWindow(runtime, session, now);
    if (!window.length) return none;
    const drafts = pendingDrafts(run).filter(
      (row) =>
        window.includes(row.id) &&
        !isExpired(row, startsSince(runtime, storedTimeMs(row.createdAt)), now)
    );
    // s97-m12: only a record holding what the draft itself proposed answers it; one that says
    // part of a longer draft leaves it pending, and named.
    const answered = drafts
      .filter((row) => draftCoverage(row.text, content) >= ANSWER_COVERAGE)
      .map((row) => row.id);
    return {
      answered,
      stillPending: drafts.map((row) => row.id).filter((id) => !answered.includes(id)),
    };
  } finally {
    runtime.close();
  }
}

export interface RbookDraftRecordResult {
  /** What the draft became: a constraint, an evergreen learning (rule) or a profile line. */
  readonly recorded: {
    readonly kind: Exclude<DraftKind, 'decision'>;
    readonly id: number | null;
    readonly typedId: string;
    readonly materialization: 'materialized' | 'existing';
  };
  readonly approval: ApprovalEcho;
  readonly message: string;
}

async function withRun<T>(
  projectRoot: string | undefined,
  action: (client: RbookDatabaseClient) => T
): Promise<RbookToolResult<T>> {
  return withClientAsync(async (client) => createSuccess(action(client)), {
    projectRoot,
    registerProject: false,
  });
}

/** Constraint, rule and profile drafts: claim, write, then name the record (N1). */
export async function recordDraftOfKind(
  params: {
    readonly content: string;
    readonly missionId?: string;
    readonly sprintId?: string;
    readonly projectRoot?: string;
  },
  evaluation: DraftEvaluation,
  env: NodeJS.ProcessEnv = process.env
): Promise<RbookToolResult<RbookDraftRecordResult>> {
  const kind = evaluation.draft.kind as Exclude<DraftKind, 'decision'>;
  const id = evaluation.draft.id;
  const at = new Date().toISOString();
  // Written as drafted: the operator approved the draft's words, and these kinds reach every
  // session (the build critic, B2). Different content is reported, never written.
  const drafted = evaluation.draft.text.trim();
  const ignored = recordStatesDraft(drafted, params.content)
    ? []
    : [
        `The ${kind} was written as drafted (${evaluation.label}); the content passed differs and was not used. Propose a revised line to change it.`,
      ];
  let projectRoot = params.projectRoot ?? process.cwd();
  const claimed = await withRun(params.projectRoot, (client) => {
    projectRoot = path.resolve(client.path, '../../..');
    return clientRunner(client).run(
      `UPDATE proposals SET outcome = 'approved', approval_mode = ?, answered_at = ?
       WHERE id = ? AND outcome = 'pending'`,
      [evaluation.mode, at, id]
    );
  });
  if (!claimed.success) return createError(claimed.error!);
  if (claimed.data!.changes === 0)
    return createError({
      code: RBOOK_ERROR_CODES.DRAFT_NOT_PENDING,
      message: `Draft ${evaluation.label} was answered by another call first; nothing was written.`,
      suggestion: `Read the drafts with ${formatCliRemedy('drafts list', { projectRoot })} before recording again.`,
    });
  const release = async (): Promise<void> => {
    await withRun(params.projectRoot, (client) =>
      clientRunner(client).run(
        `UPDATE proposals SET outcome = 'pending', approval_mode = NULL, answered_at = NULL
         WHERE id = ? AND outcome = 'approved' AND record_id IS NULL`,
        [id]
      )
    );
  };
  let recordId: number | null = null;
  let typedId: string;
  let materialization: 'materialized' | 'existing' = 'materialized';
  try {
    if (kind === 'profile') {
      const line = drafted;
      const existing = readProfile(env)
        ?.text.split('\n')
        .some((row) => row.trim() === line);
      if (existing) materialization = 'existing';
      else
        addProfileLine(
          line,
          { kind: 'profile', status: 'approved', draftId: evaluation.label, line },
          env
        );
      typedId = 'profile';
    } else {
      const captured = await rbookSessionCapture({
        category: kind === 'constraint' ? 'constraint' : 'learning',
        content: drafted,
        missionId: params.missionId,
        sprintId: params.sprintId,
        projectRoot: params.projectRoot,
        ...(kind === 'rule' ? { evergreen: true } : {}),
      });
      if (!captured.success || !captured.data) {
        await release();
        return createError(
          captured.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: `The ${kind} was not written; draft ${evaluation.label} stays pending.`,
          }
        );
      }
      materialization =
        captured.data.structuredMaterialization.outcome === 'existing'
          ? 'existing'
          : 'materialized';
      if (kind === 'rule') {
        recordId = captured.data.learningId ?? null;
        typedId = recordId ? `l:${recordId}` : 'l:unknown';
      } else {
        const text = sanitizeContentField(drafted).cleaned;
        // s100-m03: a constraint that came from another copy has no hash here; its text is matched.
        const row = await withRun(params.projectRoot, (client) =>
          clientRunner(client).get<{ id: number }>(
            `SELECT id FROM constraints WHERE ${SAME_TEXT_SQL} AND status = 'active' ORDER BY id DESC LIMIT 1`,
            [computeContentHash(text, 'constraint'), text]
          )
        );
        recordId = row.success ? (row.data?.id ?? null) : null;
        typedId = recordId ? `c:${recordId}` : 'c:unknown';
      }
    }
  } catch (error) {
    await release();
    return createError({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: `${error instanceof Error ? error.message : String(error)} Draft ${evaluation.label} stays pending.`,
      suggestion: 'Fix the content and record again once the operator has approved it.',
    });
  }
  const named = await withRun(params.projectRoot, (client) => {
    const run = clientRunner(client);
    const done = run.run('UPDATE proposals SET record_id = ? WHERE id = ?', [typedId, id]);
    // s97-m12 (critic round 3): written, it settles the approved drafts its chain revised, and
    // (s100-m02) the revisions after it.
    settleRevised(run, [id], at, typedId);
    return done;
  });
  const warnings = [
    ...ignored,
    ...(named.success
      ? []
      : [
          `The ${kind} was written, but draft ${evaluation.label} could not name it: ${named.error?.message ?? 'unknown'}.`,
        ]),
  ];
  const result = createSuccess<RbookDraftRecordResult>({
    recorded: { kind, id: recordId, typedId, materialization },
    approval: approvalEcho(evaluation),
    message: `Recorded draft ${evaluation.label} as ${kind === 'rule' ? 'a standing rule' : kind === 'profile' ? 'a profile line' : 'a constraint'} (${typedId}), ${evaluation.mode}.`,
  });
  return warnings.length ? { ...result, warnings } : result;
}
