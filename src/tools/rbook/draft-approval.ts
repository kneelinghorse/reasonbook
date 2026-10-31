// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — turning an answered draft into a record: which draft, how its approval is known (approved,
// ABOUTME: agent-judged, agent-attested), and the constraint, rule and profile kinds, claimed before they are written.

import * as path from 'path';
import { formatCliRemedy } from '../../utils/cli-remedy';
import type { RbookDatabaseClient } from './client';
import { withClientAsync } from './client';
import { rbookSessionCapture } from './rbook-session-capture';
import { ANSWER_COVERAGE, draftCoverage, recordStatesDraft, type DraftKind } from './draft-grammar';
import { openDraftRuntime, openWindow, startsSince, pendingDeclines } from './draft-runtime';
import { RBOOK_ERROR_CODES, createError, createSuccess } from './errors';
import { addProfileLine, readProfile } from './operator-profile';
import {
  clientRunner,
  markDeclined,
  isExpired,
  settleRevised,
  pendingDrafts,
  proposalsTableExists,
  type ApprovalMode,
} from './proposals';
import { storedTimeMs } from './stored-time';
import type { RbookToolResult } from './types';
import { sanitizeContentField } from '../../intelligence/content-sanitizer';
import { computeContentHash, SAME_TEXT_SQL } from './schema-migrations';
import { harnessSessionOf, type DraftEvaluation } from './draft-evaluation';

export {
  draftOwnText,
  evaluateDraft,
  harnessSessionOf,
  type DraftEvaluation,
} from './draft-evaluation';

/**
 * Build plan B9–B12: hooks bind words by store/session/draft for two hours; subagents share that
 * binding. Hook-less servers attest decisions only. Other kinds need plain approval and use draft
 * text. Approved decisions need one draft and recordStatesDraft (only whitespace may differ);
 * other same-subject wording reads agent-judged, without guessing at equivalent meaning.
 * Decisions approve atomically; other kinds claim first and release on failure.
 */
export interface ApprovalEcho {
  readonly draft: string;
  readonly kind: DraftKind;
  readonly mode: ApprovalMode;
  readonly words: string | null;
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
    const declined = new Set(pendingDeclines(runtime).map((entry) => entry.id));
    const drafts = pendingDrafts(run).filter(
      (row) =>
        window.includes(row.id) &&
        !declined.has(row.id) &&
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

/** Apply retained refusals inside the caller's store write, before settling any revision chain.
 * Keep runtime markers until a hook observes the committed outcome; this transaction may roll back.
 */
export function settlePendingDeclines(client: RbookDatabaseClient, env: NodeJS.ProcessEnv): void {
  const runtime = openDraftRuntime(client.path, env, { readonly: true });
  if (!runtime) return;
  try {
    const run = clientRunner(client);
    for (const entry of pendingDeclines(runtime))
      markDeclined(run, [entry.id], new Date(entry.at).toISOString());
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
    settlePendingDeclines(client, env);
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
    settlePendingDeclines(client, env);
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
