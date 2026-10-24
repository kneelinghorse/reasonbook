// ABOUTME: Closes a session after its decision batch and citation links commit successfully.
// ABOUTME: Required link failures leave the session active; embeddings run outside transactions.
/**
 * rbook_session_complete Tool
 *
 * MCP tool for completing an active session.
 * Captures are aggregated into master context when session completes.
 *
 * @module tools/rbook/rbook-session-complete
 */

import { formatUploadReceipt, type DashboardUploadReceipt } from './dashboard-upload-receipt';
import { ensureDecisionShapeColumns } from './schema-migrations';
import { prepareRecordLinkWrite, requireRecordLinks, recordLinkFailure } from './record-link-write';
import { missionCompletedSql } from './terminal-status';
import { z } from 'zod';
import * as crypto from 'crypto';
import { withClientAsync, type RbookDatabaseClient } from './client';
import { genesisColumns, getProjectId, tableHasColumn } from './genesis-columns';
import { recordedExecute, recordedTransaction, recordedWrite } from './record-changes';
import type { RbookToolResult, Session, Context } from './types';
import { createError, createSuccess, RbookErrors, RBOOK_ERROR_CODES } from './errors';
import {
  absorbedParameterNames,
  sanitizeContentField,
  sanitizeStringArray,
  type SanitizedField,
} from '../../intelligence/content-sanitizer';
import { recordAgentFeedback } from './agent-feedback';
import type { CaptureCategory } from './rbook-session-capture';
import {
  condenseContextForRetention,
  getContextRetentionPolicy,
  type ContextRetentionPolicy,
} from './context-retention';
import {
  ensureContentPrunedColumn,
  ensureNextStepsTable,
  ensureConstraintsTable,
  computeContentHash,
  SAME_TEXT_SQL,
} from './schema-migrations';
import { applyLearningReaffirm, sanitizeLearningIds } from './learning-reaffirm';
import { ensureMissionIdColumn } from './rbook-mission-complete';
import { recordEmbedding, decisionEmbeddingInput } from '../../intelligence/embedding-pipeline';
import { appendWarnings, appendWriteFailures, attachWarnings } from './format-warnings';
import { checkWrite, type WriteFailure } from './write-guard';
import { isOpenStatus } from './terminal-status';
import { resolveOpenSprintIdForWrite } from './current-sprint';
import { ensureImplicitSessionColumns } from './schema-migrations';
import { heldByAnotherProcess, resolveCallerSession, sessionOfAnotherCopy } from './session-owner';
import { isPeerSession } from './peer-sessions';
import { storedTimeMs } from './stored-time';
import {
  findReusableSnapshot,
  ONLY_COPY_SOURCE_SUFFIX,
  snapshotStorage,
} from './snapshot-content-policy';

/**
 * Result of session complete operation.
 */
export interface RbookSessionCompleteResult {
  dashboardUpload?: DashboardUploadReceipt;
  /** Completed session ID */
  sessionId: string;

  /** Session type */
  type: string;

  /** Session title */
  title: string;

  /** Completion summary */
  summary: string;

  /** When the session was completed */
  completedAt: string;

  /** How long the session lasted */
  durationMinutes: number;

  /** Number of captures in the session */
  captureCount: number;

  /** Breakdown of captures by category */
  capturesByCategory: Partial<Record<CaptureCategory, number>>;

  /** Next steps recorded (if any) */
  nextSteps: string[] | null;

  /** Context aggregation results */
  aggregation: {
    /** Captures routed to master_context by category */
    capturesRouted: Record<string, number>;
    /** Whether contexts were updated */
    contextsUpdated: boolean;
    /** Snapshot IDs created (null if none) */
    projectSnapshotId: number | null;
    masterSnapshotId: number | null;
    /** Retention condensation details */
    condensation?: {
      projectArchivedSprints: string[];
      masterArchivedSprints: string[];
      projectArchiveSnapshotId: number | null;
      masterArchiveSnapshotId: number | null;
    };
  };

  /**
   * Number of next steps this close inserted into next_steps: from the `nextSteps[]` parameter, and
   * next-step captures that had no row. s100-m03: a capture writes its row when it is captured, so
   * one made since 4.2.1 is found by the dedup and not counted; one made before it is.
   */
  nextStepsExtracted: number;

  /**
   * Number of decisions from the `decisions[]` parameter or decision-category
   * captures that were inserted into strategic_decisions. Deduped rows
   * (already in the table for this session) are not counted.
   */
  decisionsExtracted: number;

  /** Number of constraints extracted to the constraints table */
  constraintsExtracted: number;

  /** Message describing the result */
  message: string;

  /**
   * s86-m02b — writes this call ATTEMPTED and the database REJECTED. Always present, `[]` on the
   * happy path. The extraction counts above and `aggregation.contextsUpdated` report what
   * actually landed, so a non-empty array here is the gap between intent and outcome.
   */
  writeFailures: WriteFailure[];

  /** Persisted agent_feedback.id when agentFeedback was supplied (Sprint 56 m03). */
  feedbackId?: number;

  /**
   * Learning IDs whose `last_reviewed_at` was bumped because the caller passed
   * them in `citesLearningIds[]`. Sprint 61 m01.
   */
  explicitlyReaffirmedLearningIds?: number[];

  /** @deprecated s92-m04: no longer populated. Implicit reaffirm by content overlap was retired (it hit a cited learning on 20 of 3,973 bumps); cite learnings explicitly with citesLearningIds. Kept declared so 3.2.0 removes no field. */
  implicitlyReaffirmedLearningIds?: number[];

  /**
   * Learning IDs the caller passed in `citesLearningIds[]` that did not
   * resolve to existing rows. Sprint 61 m01.
   */
  missingCitedLearningIds?: number[];
}

/**
 * Input parameters schema for rbook_session_complete tool.
 */
export const rbookSessionCompleteSchema = z.object({
  /** Session ID to complete (optional - uses active session if not provided) */
  sessionId: z
    .string()
    .optional()
    .describe('Session ID to complete (uses active session if not provided)'),

  /** Completion summary */
  summary: z.string().min(1).max(2000).describe('Summary of what was accomplished in the session'),

  /** Optional next steps */
  nextSteps: z.array(z.string()).optional().describe('Optional list of next steps or action items'),

  /**
   * Optional decisions captured at session close. Each entry becomes a
   * strategic_decisions row with sprint_id derived from the session.
   */
  decisions: z
    .array(z.string())
    .optional()
    .describe('Optional list of strategic decisions to materialize into strategic_decisions rows'),

  /**
   * s85-m04: optional mission this session's work belongs to. Stamps `mission_id` on the
   * `decisions[]` and `nextSteps[]` rows this call materializes, so the mission -> row trail
   * is queryable (#487). Per-capture `missionId` still wins for capture-sourced next-steps.
   */
  missionId: z
    .string()
    .optional()
    .describe(
      'Associate the rows this call materializes (decisions[], nextSteps[]) with a mission. A per-capture missionId still wins for capture-sourced next-steps.'
    ),

  /** Optional agent name */
  agent: z
    .string()
    .default('assistant')
    .optional()
    .describe('Agent completing the session (default: "assistant")'),

  /** Optional free-text UX feedback from the agent (Sprint 56 m03). */
  agentFeedback: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'Optional free-text UX feedback. Use this to report rough edges, improvement ideas, or surprising tool behavior you hit during this session. Reviewed periodically via rbook_feedback(action="list").'
    ),

  /**
   * Optional explicit list of learning IDs the session's decisions cite.
   * Bumps `last_reviewed_at` on each — keeps still-true institutional rules
   * out of the staleness pile (Sprint 61 m01).
   */
  citesLearningIds: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      'Learning IDs the session decisions cite. Bumps last_reviewed_at on each — applies to the decisions[] write path.'
    ),

  /** Optional project root */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookSessionCompleteParams = z.infer<typeof rbookSessionCompleteSchema>;

/**
 * MCP Tool Definition for rbook_session_complete.
 */
export const rbookSessionCompleteToolDefinition = {
  name: 'rbook_session_complete',
  description:
    'Complete an active session with a summary. Captures are aggregated into master context. Only active sessions can be completed.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'Session ID to complete (uses active session if not provided)',
      },
      summary: {
        type: 'string',
        description: 'Summary of what was accomplished in the session',
        minLength: 1,
        maxLength: 2000,
      },
      nextSteps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of next steps or action items',
      },
      missionId: {
        type: 'string',
        description:
          'Associate the rows this call materializes (decisions[], nextSteps[]) with a mission. A per-capture missionId still wins for capture-sourced next-steps.',
      },
      decisions: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional list of strategic decisions to materialize into strategic_decisions rows',
      },
      agent: {
        type: 'string',
        description: 'Agent completing the session (default: "assistant")',
      },
      agentFeedback: {
        type: 'string',
        maxLength: 2000,
        description:
          'Optional free-text UX feedback. Use this to report rough edges, improvement ideas, or surprising tool behavior you hit during this session. Reviewed periodically via rbook_feedback(action="list").',
      },
      citesLearningIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'Learning IDs the session decisions cite. Bumps last_reviewed_at on each — applies to the decisions[] write path.',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['summary'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_session_complete tool.
 *
 * Completes an active session and marks it as completed.
 *
 * @param params - Tool parameters
 * @returns RbookToolResult with completion info or actionable error
 */
export async function rbookSessionComplete(
  params: RbookSessionCompleteParams,
  // s93-m01: an automatic close (SessionEnd, reconcile, process exit) registers nothing: a hook in a
  // second checkout of a registered project would otherwise hit the registry's collision refusal
  // (the m01 build critic, B3). Internal and non-schema.
  internalOpts: { registerProject?: boolean } = {}
): Promise<RbookToolResult<RbookSessionCompleteResult>> {
  // Validate parameters
  if (!params.summary || params.summary.trim() === '') {
    return createError(RbookErrors.missingParameter('summary'));
  }

  const sanitizedFields: SanitizedField[] = [];
  const summarySan = sanitizeContentField(params.summary.trim());
  if (summarySan.wasModified) {
    sanitizedFields.push({ field: 'summary', reason: summarySan.reason ?? '' });
  }
  const summary = summarySan.cleaned;

  const trimmedNextSteps = params.nextSteps?.filter((s) => s && s.trim()) ?? null;
  const nextStepsSan = sanitizeStringArray('nextSteps', trimmedNextSteps ?? undefined);
  sanitizedFields.push(...nextStepsSan.sanitizedFields);
  const nextSteps = trimmedNextSteps === null ? null : (nextStepsSan.cleaned as string[]);

  const trimmedDecisions = params.decisions?.map((d) => d.trim()).filter((d) => d.length > 0) ?? [];
  const decisionsSan = sanitizeStringArray('decisions', trimmedDecisions);
  sanitizedFields.push(...decisionsSan.sanitizedFields);
  const decisions = decisionsSan.cleaned as string[];

  const citesLearningIdsSan = sanitizeLearningIds(
    'citesLearningIds',
    params.citesLearningIds as readonly unknown[] | undefined
  );
  sanitizedFields.push(...citesLearningIdsSan.sanitizedFields);
  const citesLearningIds = citesLearningIdsSan.cleaned;

  // s91-m03 — the absorbed-sibling guard, twin of rbook-mission-complete.ts. Completing a session
  // is unrepeatable: when `summary` carried `<parameter name="X">` for a sibling X that did not
  // arrive, refuse BEFORE the transition instead of completing and reporting sanitizedFields.
  const lostSibling = summarySan.wasModified
    ? absorbedParameterNames(params.summary).find(
        (name) =>
          (name === 'decisions' || name === 'nextSteps' || name === 'agentFeedback') &&
          (params as unknown as Record<string, unknown>)[name] === undefined
      )
    : undefined;
  if (lostSibling !== undefined) {
    return {
      ...createError<RbookSessionCompleteResult>({
        code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
        message: `\`summary\` carried <parameter name="${lostSibling}"> and \`${lostSibling}\` did not arrive; the session was not completed`,
        field: lostSibling,
        suggestion: `Retry rbook_session(action="complete") with a short summary and ${lostSibling} as its own parameter; the session is still active.`,
      }),
      sanitizedFields,
    };
  }

  const agent = params.agent ?? 'assistant';

  // s85-m04 — the call-level mission for the rows THIS call materializes (decisions[] and
  // nextSteps[]). Named `callMissionId` to keep it visibly distinct from the per-capture
  // `missionId` read off each capture, which wins where it exists.
  const callMissionId = params.missionId?.trim() || null;

  const warnings: string[] = [];
  const result = await withClientAsync(
    async (client) => {
      // s86-m02b — SINK HOISTING. `warnings` used to be declared ~250 lines below, after the
      // session_events insert and all four extraction loops, so wiring their failures into it
      // would not have compiled and would have tempted a second array into existence. One sink,
      // declared before anything can write to it.
      // Writes this handler attempted and the database rejected. Separate from `warnings`
      // (fork f09): a lost next-step row and a sprint-closeout advisory are different news.
      const writeSink = { failures: [] as WriteFailure[] };

      // Find the session to complete
      let sessionId = params.sessionId;
      warnings.push(...(ensureImplicitSessionColumns(client).warnings ?? []));
      // s92-m09: the content tombstone column, so this close's persist copies can be content-less.
      warnings.push(...(ensureContentPrunedColumn(client).warnings ?? []));

      if (!sessionId) {
        // s92-m03: the caller's session. Its own or a keyless explicit session if one is open,
        // else its own implicit session. Never another caller's implicit session.
        const caller = resolveCallerSession(client, { open: false });
        if (!caller.ok) {
          return createError<RbookSessionCompleteResult>(caller.error);
        }
        warnings.push(...caller.warnings);

        if (!caller.session) {
          return createError<RbookSessionCompleteResult>({
            code: RBOOK_ERROR_CODES.SESSION_NOT_ACTIVE,
            message: 'No active session found',
            suggestion:
              'Start a session first with rbook_session(action="start"), or provide a sessionId',
          });
        }

        sessionId = caller.session.sessionId;
      }

      // Get the session and verify it's active
      const sessionResult = client.getOne<
        Session & { implicit: number | null; owner_key: string | null }
      >(
        'SELECT id, type, title, sprint_id, status, captures, started_at, implicit, owner_key FROM sessions WHERE id = ?',
        [sessionId]
      );

      if (!sessionResult.success) {
        return createError<RbookSessionCompleteResult>(
          sessionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query session' }
        );
      }

      if (!sessionResult.data) {
        return createError<RbookSessionCompleteResult>(RbookErrors.sessionNotFound(sessionId));
      }

      const session = sessionResult.data;

      if (session.status !== 'active') {
        return createError<RbookSessionCompleteResult>({
          code: RBOOK_ERROR_CODES.SESSION_NOT_ACTIVE,
          message: `Session '${sessionId}' is not active (status: ${session.status})`,
          suggestion: 'Only active sessions can be completed',
          currentState: session.status,
        });
      }

      // s92-m03: another running process's implicit session is not this caller's to close. It
      // may be closed once its owner is gone from this host or it has idled past the bound,
      // which is exactly when reconcile closes it.
      const isImplicit = session.implicit === 1;
      if (isPeerSession(session.owner_key))
        return createError<RbookSessionCompleteResult>(sessionOfAnotherCopy(sessionId));
      if (heldByAnotherProcess(client, session, 'complete')) {
        return createError<RbookSessionCompleteResult>(
          RbookErrors.sessionOwnedByAnotherProcess(sessionId)
        );
      }

      // s92-m03: an implicit session carries no sprint (a process outlives sprints), so the rows
      // its close materializes resolve their sprint NOW, as any untagged write does, instead of a
      // sprint fixed when the session opened.
      const closeSprintId: string | null =
        session.sprint_id ?? (isImplicit ? resolveOpenSprintIdForWrite(client) : null);

      // Parse captures and count by category
      let captures: Array<{ category: string; content?: string; missionId?: string }> = [];
      try {
        captures = session.captures ? JSON.parse(session.captures) : [];
      } catch {
        captures = [];
      }

      if (decisions.length > 0 || captures.some((capture) => capture.category === 'decision')) {
        const shape = ensureDecisionShapeColumns(client);
        warnings.push(...(shape.warnings ?? []));
        if (!shape.ready)
          return createError<RbookSessionCompleteResult>({
            code: 'DB_QUERY_FAILED',
            message: 'Decision schema migration failed; the operation was not completed.',
            suggestion: 'Resolve the reported schema or lock problem, then retry.',
          });
      }

      const capturesByCategory: Partial<Record<CaptureCategory, number>> = {};
      for (const capture of captures) {
        const cat = capture.category as CaptureCategory;
        capturesByCategory[cat] = (capturesByCategory[cat] ?? 0) + 1;
      }

      // Calculate duration
      const startedAt = new Date(storedTimeMs(session.started_at));
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const durationMinutes = Math.round(durationMs / 60000);

      const now = completedAt.toISOString();

      // Create every pending extraction table before any genesis/firehose preparation.
      // Its store-wide marker otherwise skips a table created after the decision batch.
      let nextStepsSchemaEnsured = false;
      if (captures.some((capture) => capture.category === 'next-step' && capture.content?.trim())) {
        warnings.push(...(ensureNextStepsTable(client).warnings ?? []));
        nextStepsSchemaEnsured = true;
      }
      if (nextSteps && nextSteps.length > 0 && !nextStepsSchemaEnsured) {
        warnings.push(...(ensureNextStepsTable(client).warnings ?? []));
      }
      if (
        captures.some((capture) => capture.category === 'constraint' && capture.content?.trim())
      ) {
        warnings.push(...(ensureConstraintsTable(client).warnings ?? []));
      }

      const decisionSources: string[] = [...decisions];
      for (const capture of captures) {
        if (capture.category === 'decision' && typeof capture.content === 'string') {
          const trimmed = capture.content.trim();
          if (trimmed && !decisionSources.includes(trimmed)) decisionSources.push(trimmed);
        }
      }
      const pendingEmbeddings: Array<{ id: number; content: string }> = [];
      if (decisionSources.length > 0) {
        warnings.push(...ensureMissionIdColumn(client));
        const ready = prepareRecordLinkWrite(client, warnings);
        if (!ready.success) return createError<RbookSessionCompleteResult>(ready.error!);
      }
      const decisionBatch = recordedTransaction(client, () => {
        let decisionsExtracted = 0;
        if (decisionSources.length > 0) {
          const domainResult = client.getOne<{ value: string }>(
            "SELECT value FROM metadata WHERE key = 'project_domain'",
            []
          );
          const projectDomain = domainResult.success ? (domainResult.data?.value ?? null) : null;
          // Author, mission and citation schema preflights completed before this transaction.
          // Required link failure rolls back every decision in this batch, including repairs.
          for (const decisionText of decisionSources) {
            const existing = client.getOne<{ id: number }>(
              'SELECT id FROM strategic_decisions WHERE decision_text = ? AND author_session_id = ?',
              [decisionText, sessionId]
            );
            // s86-m02b (fork f10, read side): a FAILED dedup SELECT reads as "no duplicate" and falls
            // through to the INSERT. Behaviour is UNCHANGED — a duplicate row is recoverable and
            // detectable, unlike a lost write — but the operator is told rather than left to find out.
            if (!existing.success) {
              warnings.push(
                `decision de-duplication check failed (strategic_decisions); a duplicate row may have been ` +
                  `written: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
              );
            } else if (existing.data) {
              requireRecordLinks(client, 'decision', existing.data.id);
              continue;
            }
            const g = genesisColumns(client, 'strategic_decisions', getProjectId(client));
            // s85-m04: mission_id was omitted from this column list entirely — the second of the
            // two SQL omissions behind #487. The call-level missionId applies UNIFORMLY here and
            // that is correct: decisionSources flattens the decisions[] param and
            // decision-category captures into a plain string[] before this loop, discarding any
            // per-capture missionId. Do NOT restructure decisionSources to recover it — the
            // capture path already promoted and stamped those rows, so they are normally skipped
            // by the dedup SELECT above; this is a defensive second pass.
            const insertResult = client.execute(
              `INSERT INTO strategic_decisions
               (decision_text, created_at, sprint_id, project_domain, author_session_id, mission_id, ${g.columns.join(', ')})
             VALUES (?, ?, ?, ?, ?, ?, ${g.placeholders})`,
              [
                decisionText,
                now,
                closeSprintId,
                projectDomain,
                sessionId,
                callMissionId ?? null,
                ...g.values,
              ]
            );
            if (!checkWrite(insertResult, writeSink, 'strategic_decisions extraction insert'))
              throw new Error(insertResult.error?.message ?? 'Decision extraction failed');
            {
              decisionsExtracted++;
              // Sprint 66 m03 — write-path embedding hook
              const newId = insertResult.data?.lastInsertRowid;
              const numericId =
                typeof newId === 'bigint'
                  ? Number(newId)
                  : typeof newId === 'number'
                    ? newId
                    : null;
              requireRecordLinks(client, 'decision', numericId ?? undefined);
              if (numericId !== null)
                pendingEmbeddings.push({ id: numericId, content: decisionText });
            }
          }
        }

        return decisionsExtracted;
      });
      if (!decisionBatch.success)
        return recordLinkFailure(
          decisionBatch.error?.message ?? 'Session decision batch rolled back'
        );
      const decisionsExtracted = decisionBatch.data ?? 0;
      for (const pending of pendingEmbeddings) {
        const embedded = await recordEmbedding(client, {
          type: 'decision',
          id: pending.id,
          inputText: decisionEmbeddingInput(pending.content),
        });
        warnings.push(...(embedded.warnings ?? []));
      }

      // Update the session
      const updateResult = recordedExecute(
        client,
        `UPDATE sessions
         SET status = 'completed',
             completed_at = ?,
             summary = ?,
             next_steps = ?
         WHERE id = ?`,
        [
          now,
          summary,
          nextSteps && nextSteps.length > 0 ? JSON.stringify(nextSteps) : null,
          sessionId,
        ]
      );

      if (!updateResult.success) {
        return createError<RbookSessionCompleteResult>({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to complete session: ${updateResult.error?.message ?? 'Unknown error'}`,
          suggestion: 'Check database permissions',
        });
      }

      // Insert session event
      const rawEvent = JSON.stringify({
        ts: now,
        agent,
        session: sessionId,
        action: 'complete',
        status: 'completed',
        summary,
        nextSteps,
      });

      checkWrite(
        client.execute(
          `INSERT INTO session_events (ts, agent, mission, action, status, summary, next_hint, raw_event)
           VALUES (?, ?, ?, 'complete', 'completed', ?, ?, ?)`,
          [now, agent, sessionId, summary, nextSteps?.join('; ') ?? null, rawEvent]
        ),
        warnings,
        'session completion event logging'
      );

      // ============================================================
      // Extract next-steps to structured next_steps table
      // ============================================================
      //
      // s85-m04 ORDERING (deliberate, do not swap back). Both loops below dedup on
      // (content_hash, session_id). The capture-sourced loop carries a per-capture
      // `missionId`; the nextSteps[] param loop carries only the call-level one. When the same
      // text arrives through BOTH inputs, whichever loop runs FIRST wins and the other hits
      // `continue`. Previously the unstamped param loop ran first, so identical text let an
      // unstamped row shadow its stamped twin. The mission-bearing loop now runs first.
      //
      // Verified in code; NOT verified as an observed live defect — next_steps has exactly one
      // stamped row in the whole table, so there is nothing to observe it against.
      //
      // Accepted side effect: genesisColumns assigns origin_seq as per-table MAX+1, so
      // reordering changes which row gets which origin_seq within a single call. origin_seq is
      // only a tiebreaker in the cross-store merge key and both orderings are equally valid
      // within one call — noted so a reviewer does not read it as a regression.
      let nextStepsExtracted = 0;

      // (a) capture-sourced next-steps FIRST — these can carry a per-capture missionId.
      // s100-m03: a capture since 4.2.1 wrote its row when captured, and the dedup below finds it; this
      // loop writes captures made before 4.2.1, and any whose write at capture failed.
      for (const capture of captures) {
        if (capture.category === 'next-step' && capture.content) {
          const trimmed = capture.content.trim();
          if (!trimmed) continue;
          const hash = computeContentHash(trimmed, 'next-step');
          // s100-m03: a row that came from another copy has no hash here, so its text is matched.
          const existing = client.getOne<{ id: number }>(
            `SELECT id FROM next_steps WHERE ${SAME_TEXT_SQL} AND session_id = ?`,
            [hash, trimmed, sessionId]
          );
          // s86-m02b (fork f10, read side): a FAILED dedup SELECT reads as "no duplicate" and falls
          // through to the INSERT. Behaviour is UNCHANGED — a duplicate row is recoverable and
          // detectable, unlike a lost write — but the operator is told rather than left to find out.
          if (!existing.success) {
            warnings.push(
              `next-step de-duplication check failed (next_steps); a duplicate row may have been ` +
                `written: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
            );
          } else if (existing.data) {
            continue;
          }
          // Per-capture missionId WINS over the call-level default: the capture stated which
          // mission it belongs to, which is strictly better information.
          const captureMissionId =
            (capture as { missionId?: string }).missionId ?? callMissionId ?? null;
          // s96-m01: on a shared store the id comes from this copy's block, under the write lock.
          const insertResult = recordedWrite(client, () => {
            const g = genesisColumns(client, 'next_steps', getProjectId(client));
            return client.execute(
              `INSERT INTO next_steps (content, status, session_id, sprint_id, mission_id, created_at, content_hash, ${g.columns.join(', ')})
               VALUES (?, 'pending', ?, ?, ?, ?, ?, ${g.placeholders})`,
              [
                trimmed,
                sessionId,
                (capture as { sprintId?: string }).sprintId ?? closeSprintId,
                captureMissionId,
                now,
                hash,
                ...g.values,
              ]
            );
          });
          if (checkWrite(insertResult, writeSink, 'next_steps extraction insert'))
            nextStepsExtracted++;
        }
      }

      // (b) the nextSteps[] param. s85-m04: this INSERT omitted mission_id from its column
      // list ENTIRELY — one of the two literal SQL omissions behind #487. It now stamps the
      // call-level missionId, matching the shape of the capture-sourced insert above.
      if (nextSteps && nextSteps.length > 0) {
        for (const step of nextSteps) {
          const trimmed = step.trim();
          if (!trimmed) continue;
          const hash = computeContentHash(trimmed, 'next-step');
          // Dedup: skip if same content already exists as pending for this session
          const existing = client.getOne<{ id: number }>(
            `SELECT id FROM next_steps WHERE ${SAME_TEXT_SQL} AND session_id = ?`,
            [hash, trimmed, sessionId]
          );
          // s86-m02b (fork f10, read side): a FAILED dedup SELECT reads as "no duplicate" and falls
          // through to the INSERT. Behaviour is UNCHANGED — a duplicate row is recoverable and
          // detectable, unlike a lost write — but the operator is told rather than left to find out.
          if (!existing.success) {
            warnings.push(
              `next-step de-duplication check failed (next_steps); a duplicate row may have been ` +
                `written: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
            );
          } else if (existing.data) {
            continue;
          }
          const insertResult = recordedWrite(client, () => {
            const g = genesisColumns(client, 'next_steps', getProjectId(client));
            return client.execute(
              `INSERT INTO next_steps (content, status, session_id, sprint_id, mission_id, created_at, content_hash, ${g.columns.join(', ')})
               VALUES (?, 'pending', ?, ?, ?, ?, ?, ${g.placeholders})`,
              [trimmed, sessionId, closeSprintId, callMissionId ?? null, now, hash, ...g.values]
            );
          });
          if (checkWrite(insertResult, writeSink, 'next_steps extraction insert'))
            nextStepsExtracted++;
        }
      }

      // ============================================================
      // Extract constraints to structured constraints table
      // ============================================================
      let constraintsExtracted = 0;
      for (const capture of captures) {
        if (capture.category === 'constraint' && capture.content) {
          const trimmed = capture.content.trim();
          if (!trimmed) continue;
          const hash = computeContentHash(trimmed, 'constraint');
          // Dedup: skip if same content already active
          const existing = client.getOne<{ id: number }>(
            `SELECT id FROM constraints WHERE ${SAME_TEXT_SQL} AND status = 'active'`,
            [hash, trimmed]
          );
          // s86-m02b (fork f10, read side): a FAILED dedup SELECT reads as "no duplicate" and falls
          // through to the INSERT. Behaviour is UNCHANGED — a duplicate row is recoverable and
          // detectable, unlike a lost write — but the operator is told rather than left to find out.
          if (!existing.success) {
            warnings.push(
              `constraint de-duplication check failed (constraints); a duplicate row may have been ` +
                `written: ${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
            );
          } else if (existing.data) {
            continue;
          }
          const expiresAt = (capture as { expiresAt?: string }).expiresAt ?? null;
          const insertResult = recordedWrite(client, () => {
            const g = genesisColumns(client, 'constraints', getProjectId(client));
            return client.execute(
              `INSERT INTO constraints (content, status, session_id, sprint_id, created_at, expires_at, content_hash, ${g.columns.join(', ')})
               VALUES (?, 'active', ?, ?, ?, ?, ?, ${g.placeholders})`,
              [
                trimmed,
                sessionId,
                (capture as { sprintId?: string }).sprintId ?? closeSprintId,
                now,
                expiresAt,
                hash,
                ...g.values,
              ]
            );
          });
          if (checkWrite(insertResult, writeSink, 'constraints extraction insert'))
            constraintsExtracted++;
        }
      }

      // ============================================================
      // Sprint 55 m02: Extract decisions to strategic_decisions
      // ============================================================
      // Two sources feed this block:
      //   (1) The `decisions[]` parameter passed to session-complete — the
      //       primary use case. These had no persistence path before the
      //       fix; a sibling project's retros lost entire decision corpora
      //       because rbook_decisions(list) couldn't surface them.
      //   (2) Decision-category captures already on the session. The
      //       capture path eagerly promotes these so the dedup SELECT will
      //       skip them, but the defensive second pass protects against
      //       captures that landed in session.captures without going
      //       through rbook_session_capture (e.g., future synthetic paths).
      //
      // Sprint_id is inherited from the session. project_domain is pulled
      // from the metadata table. Dedup is (decision_text, author_session_id) —
      // the same key rbook_session_capture uses. FTS5 is maintained by the
      // decisions_fts_insert trigger, so no explicit index work is needed.
      // ============================================================
      // Sprint 61 m01 — reaffirm the learnings this call cites. Since s92-m04 only the explicit
      // `citesLearningIds[]` bump; the decisions' text no longer reaffirms by overlap.
      // ============================================================
      const explicitlyReaffirmedSet = new Set<number>();
      const missingCitedSet = new Set<number>();
      if (citesLearningIds.length > 0) {
        const reaffirm = await applyLearningReaffirm(
          client,
          { explicitIds: citesLearningIds, reaffirmedAt: now },
          warnings
        );
        // s86-m02b: see the note in rbook-session-capture.ts — an errored lookup makes these
        // lists incomplete, and the answer must say so rather than imply a clean pass.
        writeSink.failures.push(...reaffirm.writeFailures);
        for (const id of reaffirm.explicitlyReaffirmedIds) explicitlyReaffirmedSet.add(id);
        for (const id of reaffirm.missingIds) missingCitedSet.add(id);
      }

      // ============================================================
      // Context Aggregation (matches Python SessionRuntime behavior)
      // ============================================================
      const aggregation = aggregateSessionIntoContexts(
        client,
        {
          sessionId,
          sprintId: session.sprint_id,
          sessionType: session.type,
          sessionTitle: session.title,
          captures: captures as CaptureItem[],
          summary,
          completedAt: now,
          agent,
          nextSteps: nextSteps && nextSteps.length > 0 ? nextSteps : null,
        },
        writeSink
      );

      // Sprint closeout guardrail
      if (session.sprint_id) {
        const sprintResult = client.getOne<{ status: string }>(
          'SELECT status FROM sprints WHERE id = ?',
          [session.sprint_id]
        );
        const totalResult = client.getOne<{ count: number }>(
          'SELECT COUNT(*) as count FROM missions WHERE sprint_id = ?',
          [session.sprint_id]
        );
        const remainingResult = client.getOne<{ count: number }>(
          `SELECT COUNT(*) as count FROM missions WHERE sprint_id = ? AND NOT (${missionCompletedSql('status')})`,
          [session.sprint_id]
        );
        if (
          sprintResult.success &&
          isOpenStatus(sprintResult.data?.status) &&
          totalResult.success &&
          remainingResult.success &&
          totalResult.data &&
          remainingResult.data &&
          totalResult.data.count > 0 &&
          remainingResult.data.count === 0
        ) {
          warnings.push(
            `All sprint missions are complete. Consider closing the sprint with rbook_sprint(action="complete").`
          );
        }
      }

      let feedbackId: number | undefined;
      if (params.agentFeedback && params.agentFeedback.trim().length > 0) {
        const fbResult = recordAgentFeedback(client, params.agentFeedback, {
          // s86-m03: was 'rbook_session_complete' — a tool name the server no longer publishes
          // (RBOOK_TOOL_DEFINITIONS holds 15 entries and none is rbook_session_complete). Until this
          // sprint the site was unreachable, so no row ever carried it; forwarding agentFeedback
          // from the router without this change would have filed brand-new DURABLE rows stamped
          // with a retired tool — this sprint's own defect class, inside its own fix. The live
          // convention is the REGISTERED name (rbook-mission-complete.ts writes
          // 'rbook_mission_transition'; rbook-agent-onboard.ts writes 'rbook_agent_onboard').
          toolName: 'rbook_session',
          sessionId,
          sprintId: session.sprint_id ?? null,
        });
        if (fbResult.feedbackId !== null) {
          feedbackId = fbResult.feedbackId;
        }
        if (fbResult.sanitizedFields.length > 0) {
          sanitizedFields.push(...fbResult.sanitizedFields);
        }
        // s86-m02b: on a rejected agent_feedback INSERT, `feedbackId` is null and simply OMITTED
        // from the answer — so the caller is told nothing, and reasonably reads that as "recorded".
        // The producer records the DB error; this is the splice that lets it be read.
        warnings.push(...fbResult.warnings);
      }

      const explicitlyReaffirmedLearningIds =
        explicitlyReaffirmedSet.size > 0
          ? Array.from(explicitlyReaffirmedSet).sort((a, b) => a - b)
          : undefined;
      const missingCitedLearningIds =
        missingCitedSet.size > 0 ? Array.from(missingCitedSet).sort((a, b) => a - b) : undefined;

      return createSuccess<RbookSessionCompleteResult>(
        {
          sessionId,
          type: session.type,
          title: session.title,
          summary,
          completedAt: now,
          durationMinutes,
          captureCount: captures.length,
          capturesByCategory,
          nextSteps: nextSteps && nextSteps.length > 0 ? nextSteps : null,
          nextStepsExtracted,
          decisionsExtracted,
          constraintsExtracted,
          aggregation,
          message: `Session '${sessionId}' completed (${captures.length} captures, ${durationMinutes}min, ${nextStepsExtracted} next-steps extracted, ${decisionsExtracted} decisions extracted, ${constraintsExtracted} constraints extracted)`,
          writeFailures: writeSink.failures,
          ...(feedbackId !== undefined ? { feedbackId } : {}),
          ...(explicitlyReaffirmedLearningIds ? { explicitlyReaffirmedLearningIds } : {}),
          ...(missingCitedLearningIds ? { missingCitedLearningIds } : {}),
        },
        warnings,
        sanitizedFields
      );
    },
    {
      projectRoot: params.projectRoot,
      ...(internalOpts.registerProject === false ? { registerProject: false } : {}),
    }
  );
  return attachWarnings(result, warnings);
}

/**
 * Format session complete result for LLM readability.
 */
export function formatSessionCompleteForLLM(
  result: RbookToolResult<RbookSessionCompleteResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to complete session',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];

    if (error?.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${error.suggestion}`);
    }

    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const data = result.data;
  const lines = [
    `✅ **Session Completed**`,
    ...(data.dashboardUpload ? [formatUploadReceipt(data.dashboardUpload)] : []),
    '',
    `**Session**: ${data.sessionId}`,
    `**Type**: ${data.type}`,
    `**Title**: ${data.title}`,
    `**Duration**: ${data.durationMinutes} minutes`,
    `**Captures**: ${data.captureCount}`,
  ];

  // Add capture breakdown if any
  const categories = Object.entries(data.capturesByCategory);
  if (categories.length > 0) {
    lines.push('');
    lines.push('**Capture Breakdown**:');
    for (const [cat, count] of categories) {
      lines.push(`  - ${cat}: ${count}`);
    }
  }

  lines.push('');
  lines.push(`**Summary**: ${data.summary}`);

  if (data.nextSteps && data.nextSteps.length > 0) {
    lines.push('');
    lines.push('**Next Steps**:');
    for (const step of data.nextSteps) {
      lines.push(`  - ${step}`);
    }
  }

  // Aggregation info
  if (data.aggregation?.contextsUpdated) {
    lines.push('');
    lines.push('**Context Aggregation**:');
    const routed = data.aggregation.capturesRouted;
    const routedEntries = Object.entries(routed).filter(([, v]) => v > 0);
    if (routedEntries.length > 0) {
      for (const [cat, count] of routedEntries) {
        lines.push(`  - ${cat}: ${count} routed to master_context`);
      }
    } else {
      lines.push('  - No captures to route');
    }
  }

  appendWriteFailures(lines, data.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}

// ============================================================
// Context Aggregation Helpers
// ============================================================

export interface CaptureItem {
  category: string;
  content: string;
  timestamp?: string;
  context?: string;
}

export interface AggregationParams {
  sessionId: string;
  sprintId: string | null;
  sessionType: string;
  sessionTitle: string;
  captures: CaptureItem[];
  summary: string;
  completedAt: string;
  agent: string;
  nextSteps: string[] | null;
}

interface AggregationResult {
  capturesRouted: Record<string, number>;
  contextsUpdated: boolean;
  projectSnapshotId: number | null;
  masterSnapshotId: number | null;
  condensation: {
    projectArchivedSprints: string[];
    masterArchivedSprints: string[];
    projectArchiveSnapshotId: number | null;
    masterArchiveSnapshotId: number | null;
  };
}

const VALID_CAPTURE_CATEGORIES = ['decision', 'learning', 'constraint', 'context', 'next-step'];

/**
 * Aggregate session captures into both contexts on session completion.
 * Matches Python SessionRuntime.complete_session() behavior. s96-m12: a merge runs it too, for each
 * session another copy closed, so this copy's derived context names that session.
 */
export function aggregateSessionIntoContexts(
  client: RbookDatabaseClient,
  params: AggregationParams,
  sink: { failures: WriteFailure[] }
): AggregationResult {
  const {
    sessionId,
    sprintId,
    sessionType,
    sessionTitle,
    captures,
    summary,
    completedAt,
    agent,
    nextSteps,
  } = params;

  // Load both contexts. s92-m09: a context that could not be read, or is not valid JSON, is left
  // exactly as it is. Building on an empty stand-in and persisting it would overwrite the stored
  // context, and since close copies no longer store content there would be no copy to recover from.
  const projectLoad = loadContext(client, 'project_context');
  const masterLoad = loadContext(client, 'master_context');
  for (const [contextId, load] of [
    ['project_context', projectLoad],
    ['master_context', masterLoad],
  ] as const) {
    if (!load.readable) {
      sink.failures.push({
        op: `contexts.read(${contextId})`,
        code: 'CONTEXT_UNREADABLE',
        message: `${contextId} ${load.problem}, so this close did not condense or overwrite it`,
      });
    }
  }
  const projectContext = projectLoad.content;
  const masterContext = masterLoad.content;
  const retentionPolicy = getContextRetentionPolicy();

  // Step 1: Apply captures to master_context
  const capturesRouted = applyCapturesToMaster(masterContext, captures, sessionId);

  // Step 2: Record session history in project_context
  recordSessionHistory(projectContext, {
    sessionId,
    sprintId,
    sessionType,
    ts: completedAt,
    agent,
    summary,
  });

  // Step 3: Append recent session to both contexts
  appendRecentSession(projectContext, {
    id: sessionId,
    sprintId,
    type: sessionType,
    title: sessionTitle,
    summary,
    completedAt,
    capturesRouted,
    underWorkingMemory: true,
    limit: 25,
  });
  // recent_sessions no longer stored in master_context blob.
  // Sessions are queryable from the sessions table (Sprint 51 blob reduction).

  // Step 4: Record next steps in both contexts
  if (nextSteps && nextSteps.length > 0) {
    recordNextSteps(projectContext, masterContext, sessionId, nextSteps);
  }

  // Step 5: Condense detail for completed sprints (only a context that was read; see above)
  const notCondensed = { archivedSprintIds: [] as string[], archiveSnapshotId: null };
  const projectCondensation = projectLoad.readable
    ? condenseContextForRetention(client, 'project_context', projectContext, {
        source: `session_complete:${sessionId}`,
        policy: retentionPolicy,
      })
    : notCondensed;
  const masterCondensation = masterLoad.readable
    ? condenseContextForRetention(client, 'master_context', masterContext, {
        source: `session_complete:${sessionId}`,
        policy: retentionPolicy,
      })
    : notCondensed;

  // Step 6: Update context health after condensation
  updateContextHealth(projectContext, completedAt, retentionPolicy);
  updateContextHealth(masterContext, completedAt, retentionPolicy);

  // Step 7: Persist both contexts with snapshots (only a context that was read; see above)
  const notPersisted = { snapshotId: null, contextWritten: false };
  const projectPersist = projectLoad.readable
    ? persistContext(
        client,
        'project_context',
        projectContext,
        sessionId,
        `session_complete:${sessionId}`,
        sink
      )
    : notPersisted;
  const masterPersist = masterLoad.readable
    ? persistContext(
        client,
        'master_context',
        masterContext,
        sessionId,
        `session_complete:${sessionId}`,
        sink
      )
    : notPersisted;

  return {
    // s86-m02b: this was a hardcoded `true`. It now reports whether the CONTEXT ROWS were
    // written — not whether their snapshots were, which is a different fact carried by the
    // two snapshot ids beside it. The matching `writeFailures` entry names any failure.
    capturesRouted,
    contextsUpdated: projectPersist.contextWritten && masterPersist.contextWritten,
    projectSnapshotId: projectPersist.snapshotId,
    masterSnapshotId: masterPersist.snapshotId,
    condensation: {
      projectArchivedSprints: projectCondensation.archivedSprintIds,
      masterArchivedSprints: masterCondensation.archivedSprintIds,
      projectArchiveSnapshotId: projectCondensation.archiveSnapshotId,
      masterArchiveSnapshotId: masterCondensation.archiveSnapshotId,
    },
  };
}

/**
 * Load and parse a context from the database.
 */
function loadContext(
  client: RbookDatabaseClient,
  contextId: string
): { content: Record<string, unknown>; readable: boolean; problem?: string } {
  const result = client.getOne<Context>('SELECT id, content FROM contexts WHERE id = ?', [
    contextId,
  ]);

  if (!result.success) {
    return {
      content: {},
      readable: false,
      problem: `could not be read (${result.error?.message ?? 'unknown error'})`,
    };
  }
  // No row yet, or an empty one: this close creates it.
  if (!result.data?.content) return { content: {}, readable: true };
  try {
    const parsed: unknown = JSON.parse(result.data.content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { content: parsed as Record<string, unknown>, readable: true };
    }
    return { content: {}, readable: false, problem: 'is not a JSON object' };
  } catch {
    return { content: {}, readable: false, problem: 'is not valid JSON' };
  }
}

/**
 * Route session captures to appropriate master_context arrays.
 * Matches Python _apply_captures_to_master().
 */
function applyCapturesToMaster(
  masterContext: Record<string, unknown>,
  captures: CaptureItem[],
  sessionId: string
): Record<string, number> {
  if (!captures.length) return {};

  const counts: Record<string, number> = {};
  // decisions_made and learnings are no longer stored in the blob.
  // They are queryable from strategic_decisions and learnings tables (Sprint 51 blob reduction).
  const constraints = ensureArray(masterContext, 'constraints');
  const notes = ensureArray(masterContext, 'context_notes');
  const nextSession = ensureObject(masterContext, 'next_session_context');
  const resume = ensureArray(nextSession, 'when_we_resume');

  for (const capture of captures) {
    const category = (capture.category || '').trim().toLowerCase();
    const content = (capture.content || '').trim();
    if (!content || !VALID_CAPTURE_CATEGORIES.includes(category)) continue;

    counts[category] = (counts[category] ?? 0) + 1;

    if (category === 'constraint') {
      if (!constraintExists(constraints, content)) {
        constraints.push(content);
      }
    } else if (category === 'context') {
      notes.push(content);
    } else if (category === 'next-step') {
      const entry = `${sessionId}: ${content}`;
      if (!resume.includes(entry)) {
        resume.push(entry);
        if (resume.length > 25) resume.splice(0, resume.length - 25);
      }
    }
  }

  return counts;
}

/**
 * Record session in project_context.working_memory.session_history.
 * Matches Python _record_session_history().
 */
function recordSessionHistory(
  projectContext: Record<string, unknown>,
  opts: {
    sessionId: string;
    sprintId: string | null;
    sessionType: string;
    ts: string;
    agent: string;
    summary: string;
  }
): void {
  const working = ensureObject(projectContext, 'working_memory');
  const history = ensureArray(working, 'session_history');

  history.push({
    session: opts.sessionId,
    sprint_id: opts.sprintId,
    session_type: opts.sessionType,
    agent: opts.agent,
    summary: opts.summary,
    action: 'complete',
    ts: opts.ts,
  });

  if (history.length > 50) history.splice(0, history.length - 50);
  working['last_session'] = opts.ts;
}

/**
 * Append session metadata to context.
 * Matches Python _append_recent_session().
 */
function appendRecentSession(
  context: Record<string, unknown>,
  opts: {
    id: string;
    sprintId: string | null;
    type: string;
    title: string;
    summary: string;
    completedAt: string;
    capturesRouted: Record<string, number>;
    underWorkingMemory: boolean;
    targetKey?: string;
    limit: number;
  }
): void {
  const parent = opts.underWorkingMemory ? ensureObject(context, 'working_memory') : context;
  const key = opts.targetKey ?? 'recent_sessions';
  const container = ensureArray(parent, key);

  const captureCount = Object.values(opts.capturesRouted).reduce((a, b) => a + b, 0);
  const sanitizedCaptures: Record<string, number> = {};
  for (const [k, v] of Object.entries(opts.capturesRouted)) {
    if (v > 0) sanitizedCaptures[k] = v;
  }

  const entry: Record<string, unknown> = {
    id: opts.id,
    sprint_id: opts.sprintId,
    session_type: opts.type,
    type: opts.type,
    title: opts.title,
    summary: opts.summary,
    completed_at: opts.completedAt,
    capture_count: captureCount,
  };
  if (Object.keys(sanitizedCaptures).length > 0) {
    entry['captures'] = sanitizedCaptures;
  }

  container.push(entry);
  if (container.length > opts.limit) container.splice(0, container.length - opts.limit);
}

/**
 * Record next steps in both contexts.
 * Matches Python _record_next_steps().
 */
function recordNextSteps(
  projectContext: Record<string, unknown>,
  masterContext: Record<string, unknown>,
  sessionId: string,
  nextSteps: string[]
): void {
  const cleaned = nextSteps.map((s) => s.trim()).filter(Boolean);
  if (!cleaned.length) return;

  // Project context: working_memory.next_steps
  const working = ensureObject(projectContext, 'working_memory');
  const todo = ensureArray(working, 'next_steps');
  for (const note of cleaned) {
    const entry = `${sessionId}: ${note}`;
    if (!todo.includes(entry)) todo.push(entry);
  }
  if (todo.length > 25) todo.splice(0, todo.length - 25);

  // Master context: next_session_context.when_we_resume
  const nextSession = ensureObject(masterContext, 'next_session_context');
  const resume = ensureArray(nextSession, 'when_we_resume');
  for (const note of cleaned) {
    const entry = `${sessionId}: ${note}`;
    if (!resume.includes(entry)) resume.push(entry);
  }
  if (resume.length > 25) resume.splice(0, resume.length - 25);
}

/**
 * Update context health metrics.
 * Matches Python _update_context_health().
 */
function updateContextHealth(
  context: Record<string, unknown>,
  ts: string,
  policy: ContextRetentionPolicy
): void {
  const health = ensureObject(context, 'context_health');
  health['sessions_since_reset'] = (Number(health['sessions_since_reset']) || 0) + 1;
  health['last_update'] = ts;
  const serialized = JSON.stringify(context);
  health['size_kb'] =
    Math.round((new TextEncoder().encode(serialized).byteLength / 1024) * 100) / 100;
  health['size_limit_kb'] = Number(health['size_limit_kb']) || policy.sizeLimitKb;
  health['warning_threshold_percent'] =
    Number(health['warning_threshold_percent']) || policy.warningThresholdPercent;
  health['retention_keep_sprints'] =
    Number(health['retention_keep_sprints']) || policy.keepDetailSprints;
}

/**
 * Persist a context to the database and create a snapshot.
 */
function persistContext(
  client: RbookDatabaseClient,
  contextId: string,
  content: Record<string, unknown>,
  sessionId: string,
  snapshotSource: string,
  sink: { failures: WriteFailure[] }
): { snapshotId: number | null; contextWritten: boolean } {
  const now = new Date().toISOString();
  const contentStr = JSON.stringify(content);

  // Check if context exists
  const existing = client.getOne<{ id: string }>('SELECT id FROM contexts WHERE id = ?', [
    contextId,
  ]);

  // s86-m02b, THE READ HALF (fork f10, non-cuttable): a FAILED existence SELECT used to take the
  // INSERT arm against a row that already exists — turning a transient read error into a
  // constraint violation on a path that then reported success. Read failure is now its own case:
  // we do not guess which arm is right, we decline to write and say so.
  if (!existing.success) {
    sink.failures.push({
      op: `contexts.persist(${contextId})`,
      code: existing.error?.code ?? 'DB_ERROR',
      message:
        `could not determine whether the context row exists, so neither UPDATE nor INSERT was ` +
        `attempted: ${existing.error?.message ?? 'unknown'}`,
    });
    return { snapshotId: null, contextWritten: false };
  }

  // WHETHER THE CONTEXT ROW LANDED IS A SEPARATE QUESTION FROM WHETHER THE SNAPSHOT DID, and
  // conflating them was a false negative in the opposite direction: deriving `contextsUpdated`
  // from the snapshot id reported "contexts not updated" for a run whose contexts WERE durably
  // written and whose snapshot merely failed. Two facts, two fields.
  let contextWritten: boolean;

  if (existing.data) {
    // s86-m02b, THE WRITE HALF: this was a bare execute. On failure the function went on to write
    // a snapshot and return its id, so the answer reported a persisted context and a snapshot id
    // for content that was never stored — the single largest durable-loss site in the class.
    contextWritten = checkWrite(
      client.execute('UPDATE contexts SET content = ?, updated_at = ? WHERE id = ?', [
        contentStr,
        now,
        contextId,
      ]),
      sink,
      `contexts.update(${contextId})`
    );
  } else {
    const sourcePath =
      contextId === 'master_context'
        ? 'context/MASTER_CONTEXT.json'
        : 'context/PROJECT_CONTEXT.json';
    contextWritten = checkWrite(
      client.execute(
        'INSERT INTO contexts (id, source_path, content, updated_at) VALUES (?, ?, ?, ?)',
        [contextId, sourcePath, contentStr, now]
      ),
      sink,
      `contexts.insert(${contextId})`
    );
  }

  // DELIBERATELY NOT AN EARLY RETURN. Before s86-m02b a failed context write still fell through
  // to the snapshot INSERT, and that snapshot was the only durable copy of the aggregated
  // content — recoverable later via rbook_context(history). Returning here would have made the
  // answer honest by DESTROYING data the old code preserved, which is a worse trade. The write
  // failure is already recorded above; the snapshot still gets its chance.

  // Create snapshot with dedup. s92-m09: when the context write failed this snapshot is the only
  // copy of the aggregated content, so it may only reuse a row no prune reclaims, and a new row is
  // marked as the only copy.
  const contentHash = crypto.createHash('sha256').update(contentStr).digest('hex').substring(0, 16);
  const existingSnapshot = findReusableSnapshot(client, {
    contextId,
    contentHash,
    kind: 'close-persist',
    liveCopyWritten: contextWritten,
  });
  const source = contextWritten ? snapshotSource : `${snapshotSource}${ONLY_COPY_SOURCE_SUFFIX}`;

  // The snapshot dedup is the BENIGN direction of the same read defect (noted in fork f10 and
  // deliberately left alone): a failed dedup falls through to INSERT, producing a duplicate
  // snapshot rather than losing one. Disclosed, not "fixed".
  if (!existingSnapshot.ok) {
    sink.failures.push({
      op: `context_snapshots.dedup(${contextId})`,
      code: existingSnapshot.code,
      message: `snapshot de-duplication check failed; a duplicate snapshot may have been written: ${existingSnapshot.message}`,
    });
  } else if (existingSnapshot.row) {
    return { snapshotId: existingSnapshot.row.id, contextWritten };
  }

  const g = genesisColumns(client, 'context_snapshots', getProjectId(client));
  // s92-m09: a close's persist copy stores no content when the context row it copies was written
  // (snapshot-content-policy.ts). When that write failed, this snapshot is the one durable copy of
  // the aggregated content (the note above), so it keeps it. A content-less copy stamps
  // content_pruned_at, so it is never a dedup hit.
  const storage = snapshotStorage('close-persist', contentStr, {
    contentHash,
    liveCopyWritten: contextWritten,
    canStamp: tableHasColumn(client, 'context_snapshots', 'content_pruned_at'),
  });
  const insertResult = client.execute(
    `INSERT INTO context_snapshots (context_id, session_id, source, content_hash, content, created_at, ${[...storage.columns, ...g.columns].join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, ${[...storage.columns.map(() => '?'), g.placeholders].join(', ')})`,
    [
      contextId,
      sessionId,
      source,
      storage.contentHash,
      storage.content,
      now,
      ...storage.values,
      ...g.values,
    ]
  );

  if (!checkWrite(insertResult, sink, `context_snapshots.insert(${contextId})`)) {
    return { snapshotId: null, contextWritten };
  }
  return { snapshotId: Number(insertResult.data?.lastInsertRowid), contextWritten };
}

// ---- Utility helpers ----

function ensureArray(obj: Record<string, unknown>, key: string): unknown[] {
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key] as unknown[];
}

function ensureObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!obj[key] || typeof obj[key] !== 'object' || Array.isArray(obj[key])) {
    obj[key] = {};
  }
  return obj[key] as Record<string, unknown>;
}

function constraintExists(existing: unknown[], candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  return existing.some(
    (item) => typeof item === 'string' && item.trim().toLowerCase() === normalized
  );
}
