// SPDX-License-Identifier: Apache-2.0
// ABOUTME: rbook_decisions(action="record") — write a decision with no session required, and supersede
// ABOUTME: the rows it corrects in the same transaction so the pointer exists when the correction does.

import { isDirectoryEdition, directoryCallError } from '../../edition';
import * as path from 'path';
import { formatCliRemedy } from '../../utils/cli-remedy';
import {
  prepareDecisionFields,
  storedDecisionFields,
  type DecisionFieldsParams,
} from './decision-fields';

import { withClientAsync } from './client';
import { prepareRecordLinkWrite, requireRecordLinks } from './record-link-write';
import { createError, createSuccess, RbookErrors, RBOOK_ERROR_CODES } from './errors';
import { sanitizeContentField, type SanitizedField } from '../../intelligence/content-sanitizer';
import { ensureMissionIdColumn } from './rbook-mission-complete';
import { resolveOpenSprintIdForWrite } from './current-sprint';
import {
  ensureAuthorNamespaceColumns,
  ensureDecisionShapeColumns,
  ensureFirehoseEventColumns,
  ensureImplicitSessionColumns,
} from './schema-migrations';
import {
  approvalEcho,
  directRecordAnswers,
  draftOwnText,
  evaluateDraft,
  settlePendingDeclines,
  recordDraftOfKind,
  type ApprovalEcho,
  type RbookDraftRecordResult,
  type DraftEvaluation,
} from './draft-approval';
import { clientRunner, draftLabel, markAnswered, markApproved } from './proposals';
import { ANSWER_COVERAGE } from './draft-grammar';
import { insertDecisionRow, followDecisionInsert } from './decision-write';
import {
  prepareDecisionCorrection,
  applyDecisionCorrection,
  type SupersededEcho,
} from './decision-correction';
export type { SupersededEcho } from './decision-correction';
import { applyLearningReaffirm, sanitizeLearningIds } from './learning-reaffirm';
import type { SupersessionCandidate } from './supersession-detection';
import { appendWarnings, appendWriteFailures, attachWarnings } from './format-warnings';
import type { WriteFailure } from './write-guard';
import { isReplicaRefusal } from './replica-identity';
import type { RbookToolError, RbookToolResult } from './types';
import { resolveCallerSession } from './session-owner';
import { readProjectLevel } from './project-level';
import type { ProjectLevel } from './rules-files';
import {
  closedSessionLines,
  reconcileStoreOnce,
  type ClosedSessionReceipt,
} from './implicit-session-lifecycle';
import { recordedTransaction } from './record-changes';

/**
 * s91-m04 — policy 3 (decisions keep the ADR lifecycle), made writable. A decision is born
 * `active`; archival is the sprint close's job and supersession is the pointer's job, so there is
 * no `status` parameter. Text is never amended in place: a correction is a new row that names the
 * rows it supersedes, and each named row gets `status='superseded', superseded_by=<new id>` in the
 * SAME transaction as the INSERT, so there is no window where the correction exists without its
 * pointer.
 *
 * SPRINT: the mission's sprint when `missionId` is given, else an explicit existing `sprintId`,
 * else `resolveOpenSprintIdForWrite` — which is `null` when no sprint is open (s85-m03), and that
 * null is disclosed on the answer rather than replaced by a guess.
 *
 * AUTHOR (s92-m03): the caller's session. The project's open explicit session, else this
 * process's own implicit session, opened if it has none, so every recorded row is attributed to the
 * process that wrote it. Retries compare text, author_session_id and supplied reasoning fields;
 * omitted fields match any value. Corrections with supersedes create a fresh row when fields
 * differ, while no-supersedes field changes retain the warning/no-write behavior. Evidence and
 * missionId do not participate in this comparison.
 */

export interface RbookDecisionsRecordParams extends DecisionFieldsParams {
  content: string;
  /** s93-m06: the draft (P<n>) the operator answered; its kind decides what is written. */
  fromDraft?: string;
  missionId?: string;
  sprintId?: string;
  supersedes?: number[];
  evidence?: Array<{ type: string; id: string }>;
  citesLearningIds?: number[];
  domain?: string;
  projectRoot?: string;
}

export interface RbookDecisionsRecordResult {
  decisionId: number;
  /** `existing` when an identical decision by the same author was already recorded. */
  materialization: 'materialized' | 'existing';
  /** The sprint the row carries; `null` when no mission, sprintId, or open sprint named one. */
  sprintId: string | null;
  missionId?: string;
  authorSessionId: string | null;
  superseded: SupersededEcho[];
  /** The end of a returned historical decision's existing successor chain. */
  currentSuccessorId?: number;
  /** @deprecated s92-m04: no longer populated. The automatic supersession offer was retired (69 of 9,035 historical offers were true); a correction names what it replaces with rbook_decisions(action="record", supersedes=[...]). Kept declared so 3.2.0 removes no field. */
  supersessionCandidates?: SupersessionCandidate[];
  /** @deprecated s92-m04: no longer populated. The automatic supersession offer was retired (69 of 9,035 historical offers were true); a correction names what it replaces with rbook_decisions(action="record", supersedes=[...]). Kept declared so 3.2.0 removes no field. */
  supersessionMessage?: string;
  explicitlyReaffirmedLearningIds?: number[];
  missingCitedLearningIds?: number[];
  /** s92-m03: present when the author is this process's implicit session; `opened` by this call. */
  implicitSession?: { opened: boolean };
  /** s92-m03: stale implicit sessions closed after this call opened one. */
  closedSessions?: ClosedSessionReceipt[];
  writeFailures: WriteFailure[];
  message: string;
  /** s93-m06: how the operator's approval of the draft is known; present only with fromDraft. */
  approval?: ApprovalEcho;
  /** s93-m06: drafts this direct record answered (it covered them) inside the operator's turn. */
  answeredDrafts?: string[];
  /** s93-m06: drafts the operator's message is still open on that this record did not cover. */
  stillPendingDrafts?: string[];
  /**
   * s95-m06: the project's level. The answer names a sprint only at Builder; a Planner's is its cycle,
   * when one is open, and a Ledger keeps none. An unknown or missing tier is Builder.
   */
  projectLevel?: ProjectLevel;
}

/** Thrown inside the transaction so better-sqlite3 rolls the INSERT back with the UPDATEs. */
class RecordRollback extends Error {}

/** Without fromDraft a record is always a decision; with it, the draft's kind decides (s93-m06). */
export async function rbookDecisionsRecord(
  params: RbookDecisionsRecordParams & { fromDraft?: undefined }
): Promise<RbookToolResult<RbookDecisionsRecordResult>>;
export async function rbookDecisionsRecord(
  params: RbookDecisionsRecordParams
): Promise<RbookToolResult<RbookDecisionsRecordResult | RbookDraftRecordResult>>;
export async function rbookDecisionsRecord(
  params: RbookDecisionsRecordParams
): Promise<RbookToolResult<RbookDecisionsRecordResult | RbookDraftRecordResult>> {
  const editionError = directoryCallError('rbook_decisions', params);
  if (editionError) return createError(editionError);
  const prepared = prepareDecisionFields(params);
  if (!prepared.success || !prepared.data) return createError(prepared.error!);
  const fields = prepared.data.fields;
  // A wrong-typed `content` is refused by the router's boundary guard (param-type-guard.ts).
  let rawContent = (params.content ?? '').trim();
  const fromDraft = params.fromDraft !== undefined && params.fromDraft !== null;
  // s106-m02 (#870, design settled item 1): fromDraft without content records the draft in its own
  // words. The text is taken before sanitizing, so every later check sees what a verbatim
  // restatement gives. An id that is malformed or names no draft is refused by the evaluation below.
  if (rawContent === '' && fromDraft) {
    const own = await withClientAsync(
      async (client) => createSuccess(draftOwnText(client, params.fromDraft)),
      { projectRoot: params.projectRoot }
    );
    if (!own.success) return createError(own.error!);
    rawContent = (own.data ?? '').trim();
  }
  if (rawContent === '' && !fromDraft) {
    return createError(RbookErrors.missingParameter('content'));
  }

  const sanitizedFields: SanitizedField[] = [...prepared.data.sanitizedFields];
  const sanitized = sanitizeContentField(rawContent);
  if (sanitized.wasModified) {
    sanitizedFields.push({ field: 'content', reason: sanitized.reason ?? '' });
  }
  const content = sanitized.cleaned;

  // s93-m06: a draft's approval is read first, on its own connection. A constraint, rule or
  // profile draft is written by its own path; a decision draft continues here and is approved in
  // the same transaction as its row (draft-approval.ts).
  let draft: DraftEvaluation | null = null;
  if (params.fromDraft !== undefined && params.fromDraft !== null) {
    const evaluated = await withClientAsync(
      async (client) =>
        createSuccess(evaluateDraft(client, params.fromDraft, content, process.env, Date.now())),
      { projectRoot: params.projectRoot }
    );
    if (!evaluated.success || !evaluated.data) return createError(evaluated.error!);
    if (!evaluated.data.ok) return createError(evaluated.data.error);
    draft = evaluated.data.value;
    if (draft.draft.kind !== 'decision') {
      return recordDraftOfKind(
        {
          content,
          missionId: params.missionId,
          sprintId: params.sprintId,
          projectRoot: params.projectRoot,
        },
        draft
      );
    }
  }

  const supersedes = [...new Set(params.supersedes ?? [])];
  const missionId = params.missionId?.trim() || undefined;
  const cited = sanitizeLearningIds('citesLearningIds', params.citesLearningIds);
  sanitizedFields.push(...cited.sanitizedFields);

  const warnings: string[] = [];
  const writeSink = { failures: [] as WriteFailure[] };

  // s92-m03: the store this call wrote to, for its once-per-store reconcile after the connection.
  let storePath: string | null = null;
  const result = await withClientAsync<RbookDecisionsRecordResult>(
    async (client) => {
      const shape = ensureDecisionShapeColumns(client);
      warnings.push(...(shape.warnings ?? []));
      if (!shape.ready)
        return createError<RbookDecisionsRecordResult>({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: 'Decision schema migration failed; no decision was recorded.',
          suggestion: 'Resolve the reported schema or lock problem, then retry this record.',
        });
      storePath = client.path;
      // Sprint resolution, in the order the module docblock publishes.
      let sprintId: string | null;
      if (missionId) {
        const mission = client.getOne<{ sprint_id: string | null }>(
          'SELECT sprint_id FROM missions WHERE id = ?',
          [missionId]
        );
        if (!mission.success || !mission.data) {
          return createError<RbookDecisionsRecordResult>(RbookErrors.missionNotFound(missionId));
        }
        sprintId = mission.data.sprint_id;
        warnings.push(...ensureMissionIdColumn(client));
      } else if (params.sprintId?.trim()) {
        const explicit = params.sprintId.trim();
        const sprint = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
          explicit,
        ]);
        if (!sprint.success || !sprint.data) {
          return createError<RbookDecisionsRecordResult>(RbookErrors.sprintNotFound(explicit));
        }
        sprintId = explicit;
      } else {
        sprintId = resolveOpenSprintIdForWrite(client);
      }
      // s95-m06: a Ledger keeps no sprints and a Planner's cycles are optional, so neither is warned.
      const projectLevel = readProjectLevel(client);
      if (sprintId === null && projectLevel === 'builder') {
        warnings.push(
          'Recorded with sprint_id NULL (unscheduled); mission attribution is retained when supplied. ' +
            'Assign a sprint only if scheduling is intended.'
        );
      }

      // s92-m03: the caller's session, never another process's implicit session.
      warnings.push(...(ensureImplicitSessionColumns(client).warnings ?? []));
      const caller = resolveCallerSession(client, { open: true });
      if (!caller.ok) {
        return createError<RbookDecisionsRecordResult>(caller.error);
      }
      warnings.push(...caller.warnings);
      const authorSessionId = caller.session?.sessionId ?? null;

      // Migrations that toggle foreign_keys are no-ops inside a transaction: run them first.
      warnings.push(...(ensureFirehoseEventColumns(client).warnings ?? []));
      warnings.push(...(ensureAuthorNamespaceColumns(client).warnings ?? []));

      // s93-m06 (B12): a direct record inside the operator's turn answers the drafts it covers.
      const linkReady = prepareRecordLinkWrite(client, warnings);
      if (!linkReady.success) return createError<RbookDecisionsRecordResult>(linkReady.error!);
      let direct: ReturnType<typeof directRecordAnswers> = { answered: [], stillPending: [] };

      if (!draft && content.length > 600)
        warnings.push(
          `Decision headline is ${content.length} UTF-16 units (budget 600). Split it, move reasons and effects into context/consequences, or cite evidence for supporting detail. To change an existing decision, supersede it.`
        );
      const now = new Date().toISOString();
      let draftRaced = false;
      let existingId: number | undefined;
      let successorId: number | undefined;
      let correctionError: RbookToolError | undefined;
      let superseded: SupersededEcho[] = [];
      const committed = recordedTransaction(client, () => {
        if (!isDirectoryEdition()) {
          settlePendingDeclines(client, process.env);
          if (!draft) direct = directRecordAnswers(client, content, process.env, Date.now());
        }
        if (draft) {
          const current = clientRunner(client).get<{ outcome: string }>(
            'SELECT outcome FROM proposals WHERE id = ?',
            [draft.draft.id]
          );
          if (current?.outcome !== 'pending') {
            draftRaced = true;
            throw new RecordRollback('proposals.approve');
          }
        }
        const correction = prepareDecisionCorrection(
          client,
          content,
          authorSessionId,
          fields,
          supersedes,
          warnings
        );
        if (!correction.success || !correction.data) {
          correctionError = correction.error;
          throw new RecordRollback('strategic_decisions.correction');
        }
        existingId = correction.data.existingId;
        successorId = correction.data.successorId;
        let decisionId = existingId;
        if (decisionId === undefined) {
          const written = insertDecisionRow(
            client,
            {
              content,
              ...fields,
              now,
              sprintId,
              authorSessionId,
              missionId,
              evidence: params.evidence,
              projectDomain: params.domain?.trim() || undefined,
              approval: draft
                ? { mode: draft.mode, draft: draft.label, words: draft.words }
                : undefined,
            },
            writeSink
          );
          if (written.kind === 'failed' || written.decisionId === undefined) {
            throw new RecordRollback('strategic_decisions.insert');
          }
          decisionId = written.decisionId;
          if (draft) {
            const approved = markApproved(clientRunner(client), draft.draft.id, {
              recordId: `d:${decisionId}`,
              mode: draft.mode,
              at: now,
            });
            if (approved === 0) {
              draftRaced = true;
              throw new RecordRollback('proposals.approve');
            }
          }
        } else {
          requireRecordLinks(client, 'decision', decisionId);
          if (draft) {
            // Already recorded directly with this text (the plan critic, N2): the draft is answered
            // by that row, which keeps no approval it never had.
            markAnswered(clientRunner(client), [draft.draft.id], `d:${decisionId}`, now);
          }
        }
        if (direct?.answered.length) {
          markAnswered(clientRunner(client), direct.answered, `d:${decisionId}`, now);
        }
        superseded = applyDecisionCorrection(
          client,
          decisionId,
          correction.data.targets,
          writeSink
        );
        return decisionId;
      });

      if (!committed.success && correctionError) return createError(correctionError);
      if (draft && !committed.success && draftRaced) {
        return createError<RbookDecisionsRecordResult>({
          code: RBOOK_ERROR_CODES.DRAFT_NOT_PENDING,
          message: `Draft ${draft.label} was answered by another call first; nothing was recorded.`,
          suggestion: `Read the drafts with ${formatCliRemedy('drafts list', { projectRoot: path.resolve(client.path, '../../..') })} before recording again.`,
        });
      }
      // s96-m01: a shared record's refusal (a full number block) keeps its own code and remedy.
      if (isReplicaRefusal(committed.error)) return createError(committed.error!);
      if (!committed.success || committed.data === undefined) {
        return createError<RbookDecisionsRecordResult>({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message:
            'The decision was not recorded and no supersedes pointer was written; the ' +
            `transaction rolled back (${writeSink.failures.map((f) => `${f.op}: ${f.message}`).join('; ') || committed.error?.message || 'unknown'}).`,
          suggestion:
            'Resolve the reported database or citation-link error, then retry the record.',
        });
      }

      const decisionId = committed.data;
      const answer: RbookDecisionsRecordResult = {
        decisionId,
        materialization: existingId === undefined ? 'materialized' : 'existing',
        sprintId,
        authorSessionId,
        superseded,
        writeFailures: writeSink.failures,
        message:
          existingId === undefined
            ? `Recorded decision #${decisionId}`
            : `Decision #${decisionId} was already recorded with this text`,
      };
      if (missionId) answer.missionId = missionId;
      if (caller.session?.implicit) answer.implicitSession = { opened: caller.session.opened };
      if (draft && existingId === undefined) answer.approval = approvalEcho(draft);
      // s97-m12: a record holding part of its draft says so, rather than retiring the rest unseen.
      if (draft && existingId === undefined && draft.coverage < ANSWER_COVERAGE)
        warnings.push(
          `This decision holds ${Math.round(draft.coverage * 100)}% of draft ${draft.label}'s subject; anything ${draft.label} proposed beyond it is not recorded.`
        );
      if (draft && existingId !== undefined) {
        answer.message = `Decision #${decisionId} was already recorded directly with this text; draft ${draft.label} is marked answered by it.`;
      }
      if (successorId !== undefined) {
        answer.currentSuccessorId = successorId;
        answer.message += `; its current successor is decision #${successorId}`;
      }
      answer.projectLevel = projectLevel;
      if (direct?.answered.length) answer.answeredDrafts = direct.answered.map(draftLabel);
      if (direct?.stillPending.length)
        answer.stillPendingDrafts = direct.stillPending.map(draftLabel);

      if (existingId === undefined) {
        // s92-m04: embedding only; the automatic supersession offer is retired.
        await followDecisionInsert(
          client,
          { decision_text: content, ...storedDecisionFields(prepared.data!.fields) },
          decisionId,
          warnings
        );
      }

      if (cited.cleaned.length > 0) {
        const reaffirm = await applyLearningReaffirm(
          client,
          { explicitIds: cited.cleaned, reaffirmedAt: now },
          warnings
        );
        writeSink.failures.push(...reaffirm.writeFailures);
        if (reaffirm.explicitlyReaffirmedIds.length > 0) {
          answer.explicitlyReaffirmedLearningIds = reaffirm.explicitlyReaffirmedIds;
        }
        if (reaffirm.missingIds.length > 0) {
          answer.missingCitedLearningIds = reaffirm.missingIds;
        }
      }

      return createSuccess(answer, undefined, sanitizedFields);
    },
    { projectRoot: params.projectRoot }
  );

  // s92-m03: on this process's first write to the store, close orphaned or idle implicit sessions,
  // outside the record's own connection, even if the record itself then failed.
  const reconciled = await reconcileStoreOnce(storePath);
  warnings.push(...reconciled.warnings);
  if (reconciled.receipts.length > 0) {
    if (result.success && result.data) result.data.closedSessions = reconciled.receipts;
    else warnings.push(...closedSessionLines(reconciled.receipts));
  }
  // Every exit after a migration carries its warnings, including the refusals.
  return attachWarnings(result, warnings);
}

function approvalLines(approval: ApprovalEcho | undefined): string[] {
  if (!approval) return [];
  const how = {
    approved: 'approved: the operator answered this draft alone with a plain approval',
    'agent-judged':
      'agent-judged: the record wording changed, or the words were not a plain approval of this draft alone',
    'agent-attested': 'agent-attested: no operator words were found for this session',
  }[approval.mode];
  return [
    `**From draft**: ${approval.draft} (${approval.kind}) — ${how}`,
    ...(approval.words ? [`**Operator’s words**: "${approval.words.slice(0, 200)}"`] : []),
  ];
}

export function formatDecisionsRecordForLLM(
  result: RbookToolResult<RbookDecisionsRecordResult | RbookDraftRecordResult>
): string {
  if (result.success && result.data && 'recorded' in result.data) {
    const lines = [
      '✓ **Draft Recorded**',
      '',
      result.data.message,
      ...approvalLines(result.data.approval),
    ];
    appendWarnings(lines, result);
    return lines.join('\n');
  }
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to record decision',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];
    if (error?.suggestion) lines.push('', `Suggestion: ${error.suggestion}`);
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const d = result.data as RbookDecisionsRecordResult;
  const lines = [
    d.materialization === 'existing'
      ? '✓ **Decision Already Recorded**'
      : '✓ **Decision Recorded**',
    '',
    `**Decision**: #${d.decisionId}`,
  ];
  // s95-m06: in the project's own words; a Ledger's answer names no sprint.
  const level = d.projectLevel ?? 'builder';
  if (level === 'builder') lines.push(`**Sprint**: ${d.sprintId ?? '(none — no open sprint)'}`);
  else if (level === 'planner' && d.sprintId) lines.push(`**Cycle**: ${d.sprintId}`);
  if (d.missionId) lines.push(`**${level === 'planner' ? 'Task' : 'Mission'}**: ${d.missionId}`);
  if (d.currentSuccessorId !== undefined)
    lines.push(`**Current successor**: #${d.currentSuccessorId}`);
  lines.push(...approvalLines(d.approval));
  if (d.approval === undefined && /marked answered/.test(d.message)) lines.push(d.message);
  if (d.answeredDrafts?.length)
    lines.push(`**Answered drafts**: ${d.answeredDrafts.join(', ')} (this record covers them)`);
  if (d.stillPendingDrafts?.length)
    lines.push(
      `**Still pending**: ${d.stillPendingDrafts.join(', ')} — not covered by this record; record one with fromDraft only if the operator approved it`
    );
  if (d.superseded.length > 0) {
    lines.push('**Superseded**:');
    for (const s of d.superseded) {
      lines.push(`  - #${s.id}: ${s.previousStatus} → ${s.newStatus}`);
    }
  }
  if (d.closedSessions && d.closedSessions.length > 0) {
    lines.push('**Closed stale sessions**:');
    for (const line of closedSessionLines(d.closedSessions)) lines.push(`  ${line}`);
  }
  appendWriteFailures(lines, d.writeFailures);
  appendWarnings(lines, result);
  return lines.join('\n');
}
