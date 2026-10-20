// ABOUTME: Captures decisions and learnings with their session history and citation links atomically.
// ABOUTME: Migrations precede the synchronous unit; embeddings run only after its commit.
/**
 * rbook_session_capture Tool
 *
 * MCP tool for capturing insights during an active session.
 * Supports categories: decision, learning, constraint, context, next-step.
 *
 * @module tools/rbook/rbook-session-capture
 */

import { ensureDecisionShapeColumns } from './schema-migrations';
import { z } from 'zod';
import { withClientAsync } from './client';
import { prepareRecordLinkWrite, requireRecordLinks, recordLinkFailure } from './record-link-write';
import type { RbookToolResult, Session } from './types';
import { createError, createSuccess, RbookErrors, RBOOK_ERROR_CODES } from './errors';
import { sanitizeContentField, type SanitizedField } from '../../intelligence/content-sanitizer';
import { ensureMissionIdColumn } from './rbook-mission-complete';
import { ensureGenesisSchema, genesisColumns, getProjectId } from './genesis-columns';
import { isRecordedStore } from './record-guards';
import { isReplicaRefusal, isSharedStore, takeReplicaSeq } from './replica-identity';
import { resolveOpenSprintIdForWrite } from './current-sprint';
import {
  ensureImplicitSessionColumns,
  ensureSessionMissionsTable,
  ensureConstraintsTable,
  ensureNextStepsTable,
  computeContentHash,
  SAME_TEXT_SQL,
} from './schema-migrations';
import { type SupersessionCandidate } from './supersession-detection';
import { findExistingDecisionId, insertDecisionRow, followDecisionInsert } from './decision-write';
import { applyLearningReaffirm, sanitizeLearningIds } from './learning-reaffirm';
import { recordEmbedding, learningEmbeddingInput } from '../../intelligence/embedding-pipeline';
import { appendWarnings, appendWriteFailures, attachWarnings } from './format-warnings';
import { checkWrite, type WriteFailure } from './write-guard';
import { heldByAnotherProcess, resolveCallerSession, sessionOfAnotherCopy } from './session-owner';
import { isPeerSession } from './peer-sessions';
import { readProjectLevel } from './project-level';
import {
  closedSessionLines,
  reconcileStoreOnce,
  type ClosedSessionReceipt,
} from './implicit-session-lifecycle';
import { recordedTransaction } from './record-changes';
import { LEASED_STATUS_SQL } from './next-step-lease';

/**
 * Valid capture categories matching the Python session_runtime.
 */
export const VALID_CAPTURE_CATEGORIES = [
  'decision',
  'learning',
  'constraint',
  'context',
  'next-step',
] as const;

export type CaptureCategory = (typeof VALID_CAPTURE_CATEGORIES)[number];

export type CaptureMaterializationTarget =
  | 'strategic_decisions'
  | 'learnings'
  | 'constraints'
  | 'master_context.context_notes'
  | 'next_steps';

export type CaptureMaterializationTiming = 'immediate' | 'session-close';

export type CaptureMaterializationOutcome = 'materialized' | 'existing' | 'deferred' | 'failed';

export interface CaptureStructuredMaterialization {
  /** Durable projection written by this capture category. */
  target: CaptureMaterializationTarget;

  /** Whether the projection is attempted now or when the session closes. */
  timing: CaptureMaterializationTiming;

  /** What happened to the projection during this call. */
  outcome: CaptureMaterializationOutcome;
}

/**
 * Result of session capture operation.
 */
export interface RbookSessionCaptureResult {
  /** Session ID the capture was added to */
  sessionId: string;

  /** Category of the capture */
  category: CaptureCategory;

  /** Content of the capture */
  content: string;

  /** When the capture was recorded */
  timestamp: string;

  /** Total captures in the session after this one */
  captureCount: number;

  /** Message describing the result */
  message: string;

  /** Outcome-aware receipt for the category's durable structured projection. */
  structuredMaterialization: CaptureStructuredMaterialization;

  /**
   * s86-m02b — writes this capture ATTEMPTED and the database REJECTED. Always present, `[]` on
   * the happy path. The extraction flags above report what actually landed.
   */
  writeFailures: WriteFailure[];

  /** Associated mission ID (when missionId was provided) */
  missionId?: string;

  /** Real strategic_decisions row ID for a new or de-duplicated decision capture. */
  decisionId?: number;

  /** Real learnings row ID for a new or de-duplicated learning capture. */
  learningId?: number;

  /** s100-m03: real next_steps row ID for a new or de-duplicated next-step capture. */
  nextStepId?: number;

  /** Number of decisions extracted (present for decision category captures) */
  decisionExtractionCount?: number;

  /** Whether the decision was already extracted (present for decision category captures) */
  decisionAlreadyExtracted?: boolean;

  /**
   * s86-m02b — THE THIRD STATE. Present ONLY when the strategic_decisions INSERT was attempted
   * and the database REJECTED it, carrying the DB error verbatim.
   *
   * There have always been two reported outcomes — "already exists" and "auto-extracted (n)" —
   * and an `else` arm (present since Sprint 20) that set count=0 + alreadyExtracted=false on a
   * FAILED insert. The formatter rendered that pair as "Decision Extraction: Extraction skipped".
   * Nothing was skipped; an INSERT errored, and the answer positively asserted a false event.
   * A third state is the fix — not a new branch, since the branch already existed.
   */
  decisionExtractionFailed?: string;

  /** Source chunk IDs for decision provenance tracking */
  sourceChunkIds?: string[];

  /** Evidence references stored with the decision */
  evidenceStored?: Array<{ type: string; id: string }>;

  /**
   * Whether a learning was extracted to the learnings table.
   * s86-m02b: `false` now means ONLY "a duplicate already existed". A failed INSERT is reported
   * through `writeFailures` instead of collapsing into this flag, which used to mean both.
   */
  learningExtracted?: boolean;

  /**
   * Whether a constraint was extracted to the constraints table.
   * s86-m02b: same split as `learningExtracted` — `false` means duplicate, never "errored".
   */
  constraintExtracted?: boolean;

  /** @deprecated s92-m04: no longer populated. The automatic supersession offer was retired (69 of 9,035 historical offers were true); a correction names what it replaces with rbook_decisions(action="record", supersedes=[...]). Kept declared so 3.2.0 removes no field. */
  supersessionCandidates?: SupersessionCandidate[];

  /** @deprecated s92-m04: no longer populated. The automatic supersession offer was retired (69 of 9,035 historical offers were true); a correction names what it replaces with rbook_decisions(action="record", supersedes=[...]). Kept declared so 3.2.0 removes no field. */
  supersessionMessage?: string;

  /**
   * Learning IDs whose `last_reviewed_at` was bumped because the caller
   * passed them in `citesLearningIds[]`. Sprint 61 m01.
   */
  explicitlyReaffirmedLearningIds?: number[];

  /** @deprecated s92-m04: no longer populated. Implicit reaffirm by content overlap was retired (it hit a cited learning on 20 of 3,973 bumps); cite learnings explicitly with citesLearningIds. Kept declared so 3.2.0 removes no field. */
  implicitlyReaffirmedLearningIds?: number[];

  /**
   * Learning IDs the caller passed in `citesLearningIds[]` that did not
   * resolve to existing rows. Sprint 61 m01.
   */
  missingCitedLearningIds?: number[];

  /**
   * s92-m03: present when the capture landed in this process's IMPLICIT session, because it
   * named no session and no explicit session was open. `opened` is true when this capture
   * opened it.
   */
  implicitSession?: { opened: boolean };

  /**
   * s92-m03: sessions closed after this capture opened an implicit session: implicit sessions
   * whose process is gone, or any idle past 12 h. Absent when nothing was closed.
   */
  closedSessions?: ClosedSessionReceipt[];
}

/**
 * Input parameters schema for rbook_session_capture tool.
 */
export const rbookSessionCaptureSchema = z.object({
  /** Session ID to capture to (optional - uses the caller's session if not provided) */
  sessionId: z
    .string()
    .optional()
    .describe(
      "Session ID to add capture to. Omit it to use the open explicit session, or else this process's implicit session (opened if needed)"
    ),

  /** Capture category */
  category: z
    .enum(VALID_CAPTURE_CATEGORIES)
    .describe('Category: decision, learning, constraint, context, or next-step'),

  /** Content to capture */
  content: z.string().min(1).max(1000).describe('The insight to capture (1-1000 characters)'),

  /** Optional context/reason for the capture */
  context: z.string().max(500).optional().describe('Optional context or reason for this capture'),

  /** Optional mission ID to associate this capture with */
  missionId: z
    .string()
    .optional()
    .describe(
      'Associate this capture with a specific mission (creates strategic_decisions when category=decision)'
    ),

  /** Optional evidence references for decision captures */
  evidence: z
    .array(
      z.object({
        type: z.string().min(1).describe('Evidence type (e.g. "collection", "document", "chunk")'),
        id: z
          .string()
          .min(1)
          .describe('Evidence identifier (e.g. TraceLab collection/document ID)'),
      })
    )
    .optional()
    .describe('Array of TraceLab evidence references [{type, id}] to link with a decision capture'),

  /** Optional expiry date for constraint captures (ISO 8601) */
  expiresAt: z
    .string()
    .optional()
    .describe(
      'Optional expiry date for constraint captures (ISO 8601, e.g. "2026-03-20T00:00:00Z")'
    ),

  /** Optional agent name */
  agent: z
    .string()
    .default('assistant')
    .optional()
    .describe('Agent making the capture (default: "assistant")'),

  /**
   * Optional explicit list of learning IDs this capture cites. When set, those
   * learnings get their `last_reviewed_at` bumped to now — keeping still-true
   * institutional rules out of the staleness pile (Sprint 61 m01).
   */
  citesLearningIds: z
    .array(z.number().int().positive())
    .optional()
    .describe(
      'Learning IDs this capture cites. Bumps last_reviewed_at on each — applies to category=decision|learning.'
    ),

  /** Optional never-stale flag for learning captures. */
  evergreen: z
    .boolean()
    .optional()
    .describe(
      'Whether this learning is exempt from staleness archival. Applies only to learning captures.'
    ),

  /** s92-m03 (#589): an explicit existing sprint for the rows this capture writes. */
  sprintId: z
    .string()
    .optional()
    .describe(
      "Optional existing sprint ID (any status) for the rows this capture writes; a sprint that does not exist is refused by name. A missionId's sprint wins."
    ),

  /** Optional project root */
  projectRoot: z
    .string()
    .optional()
    .describe('Project root directory to search for Reasonbook database (defaults to cwd)'),
});

export type RbookSessionCaptureParams = z.infer<typeof rbookSessionCaptureSchema>;

/**
 * MCP Tool Definition for rbook_session_capture.
 */
export const rbookSessionCaptureToolDefinition = {
  name: 'rbook_session_capture',
  description:
    "Capture an insight. Categories: decision (choices made), learning (what was learned), constraint (limitations discovered), context (background info), next-step (action items). No session is required: without one, the capture lands in the caller's implicit session. Captures are aggregated into master context when the session completes.",
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description:
          "Session ID to add capture to. Omit it to use the open explicit session, or else this process's implicit session (opened if needed)",
      },
      category: {
        type: 'string',
        enum: VALID_CAPTURE_CATEGORIES,
        description: 'Category: decision, learning, constraint, context, or next-step',
      },
      content: {
        type: 'string',
        description: 'The insight to capture (1-1000 characters)',
        minLength: 1,
        maxLength: 1000,
      },
      context: {
        type: 'string',
        description: 'Optional context or reason for this capture',
        maxLength: 500,
      },
      missionId: {
        type: 'string',
        description:
          'Associate this capture with a specific mission (creates strategic_decisions when category=decision)',
      },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: 'Evidence type (e.g. "collection", "document", "chunk")',
            },
            id: {
              type: 'string',
              description: 'Evidence identifier (e.g. TraceLab collection/document ID)',
            },
          },
          required: ['type', 'id'],
        },
        description:
          'Array of TraceLab evidence references [{type, id}] to link with a decision capture',
      },
      expiresAt: {
        type: 'string',
        description:
          'Optional expiry date for constraint captures (ISO 8601, e.g. "2026-03-20T00:00:00Z")',
      },
      agent: {
        type: 'string',
        description: 'Agent making the capture (default: "assistant")',
      },
      citesLearningIds: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        description:
          'Learning IDs this capture cites. Bumps last_reviewed_at on each — applies to category=decision|learning.',
      },
      evergreen: {
        type: 'boolean',
        description:
          'Whether this learning is exempt from staleness archival. Applies only to learning captures.',
      },
      sprintId: {
        type: 'string',
        description:
          "Optional existing sprint ID (any status) for the rows this capture writes; a sprint that does not exist is refused by name. A missionId's sprint wins.",
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
    },
    required: ['category', 'content'],
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_session_capture tool.
 *
 * Adds a capture to an active session. If sessionId is not provided,
 * uses the currently active session.
 *
 * @param params - Tool parameters
 * @returns RbookToolResult with capture info or actionable error
 */
export async function rbookSessionCapture(
  params: RbookSessionCaptureParams
): Promise<RbookToolResult<RbookSessionCaptureResult>> {
  // Validate parameters
  if (!params.content || params.content.trim() === '') {
    return createError(RbookErrors.missingParameter('content'));
  }

  if (params.evergreen !== undefined && params.category !== 'learning') {
    return createError<RbookSessionCaptureResult>({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: "Parameter 'evergreen' applies only to category='learning' captures",
      field: 'evergreen',
      providedValue: params.evergreen,
      suggestion: 'Remove evergreen or capture the content as category="learning"',
    });
  }

  const category = params.category;
  const sanitizedFields: SanitizedField[] = [];
  const contentSan = sanitizeContentField(params.content.trim());
  if (contentSan.wasModified) {
    sanitizedFields.push({ field: 'content', reason: contentSan.reason ?? '' });
  }
  const content = contentSan.cleaned;
  const rawCaptureContext = params.context?.trim() ?? null;
  let captureContext = rawCaptureContext;
  if (rawCaptureContext) {
    const ctxSan = sanitizeContentField(rawCaptureContext);
    if (ctxSan.wasModified) {
      sanitizedFields.push({ field: 'context', reason: ctxSan.reason ?? '' });
      captureContext = ctxSan.cleaned;
    }
  }
  const citesLearningIdsSan = sanitizeLearningIds(
    'citesLearningIds',
    params.citesLearningIds as readonly unknown[] | undefined
  );
  sanitizedFields.push(...citesLearningIdsSan.sanitizedFields);
  const citesLearningIds = citesLearningIdsSan.cleaned;
  const agent = params.agent ?? 'assistant';

  const warnings: string[] = [];
  // s92-m03: the store this call wrote to, for its once-per-store reconcile after the connection.
  let storePath: string | null = null;
  const result = await withClientAsync(
    async (client) => {
      storePath = client.path;
      // s86-m02b — SINK HOISTING. `warnings` was declared ~400 lines below, AFTER the decision
      // INSERT, the learning arm and the constraint arm. Wiring their failures into it required
      // moving the declaration here; the alternative — a second array — is explicitly forbidden.
      // Writes attempted and rejected. Distinct from `warnings` (fork f09): a lost decision must
      // not be buried beside "you forgot missionId".
      const writeSink = { failures: [] as WriteFailure[] };

      // s92-m03 (#589): an explicit sprint must exist. Checked first, so a refused capture opens
      // no session.
      const explicitSprintId = params.sprintId?.trim() || null;
      if (explicitSprintId) {
        const sprint = client.getOne<{ id: string }>('SELECT id FROM sprints WHERE id = ?', [
          explicitSprintId,
        ]);
        if (!sprint.success) {
          return createError<RbookSessionCaptureResult>(
            sprint.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to look up the sprint' }
          );
        }
        if (!sprint.data) {
          return createError<RbookSessionCaptureResult>(
            RbookErrors.sprintNotFound(explicitSprintId)
          );
        }
      }

      // s100-m03: a next step's row references its mission, so a missionId that names none would be
      // refused at capture and again at every close. It is refused by name now, before anything is
      // stored, as a sprint that does not exist is.
      const namedMission = params.missionId?.trim();
      if (category === 'next-step' && namedMission) {
        const mission = client.getOne<{ id: string }>('SELECT id FROM missions WHERE id = ?', [
          namedMission,
        ]);
        if (!mission.success)
          return createError<RbookSessionCaptureResult>(
            mission.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to look up the mission' }
          );
        if (!mission.data)
          return createError<RbookSessionCaptureResult>(RbookErrors.missionNotFound(namedMission));
      }

      // s100-m03 (#712): a next step is written now, with its capture, so the next-step list shows it
      // while the session is open. Its table and genesis columns are prepared before the write lock,
      // since a migration never runs inside that unit, and before the session, so a refused capture
      // opens none.
      if (category === 'next-step') {
        warnings.push(...(ensureNextStepsTable(client).warnings ?? []));
        try {
          ensureGenesisSchema(client, 'next_steps');
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : String(error));
          return createError<RbookSessionCaptureResult>({
            code: 'DB_QUERY_FAILED',
            message: 'Next-step schema preparation failed; the next step was not captured.',
            suggestion: 'Resolve the reported schema or lock problem, then retry the capture.',
          });
        }
      }

      // Find the session to capture to
      let sessionId = params.sessionId;
      let implicitSession: { opened: boolean } | undefined;
      warnings.push(...(ensureImplicitSessionColumns(client).warnings ?? []));

      if (!sessionId) {
        // s92-m03: the caller's session. Its own or a keyless explicit session if one is open,
        // else its own implicit session, opened now if it has none. A capture no longer fails for
        // lack of a session.
        const caller = resolveCallerSession(client, { open: true, agent });
        if (!caller.ok || !caller.session) {
          return createError<RbookSessionCaptureResult>(
            caller.ok
              ? { code: RBOOK_ERROR_CODES.DB_QUERY_FAILED, message: 'Failed to open a session' }
              : caller.error
          );
        }
        warnings.push(...caller.warnings);
        sessionId = caller.session.sessionId;
        if (caller.session.implicit) implicitSession = { opened: caller.session.opened };
      }

      // Get the session and verify it's active
      const sessionResult = client.getOne<
        Session & { implicit: number | null; owner_key: string | null }
      >(
        'SELECT id, status, captures, sprint_id, started_at, implicit, owner_key FROM sessions WHERE id = ?',
        [sessionId]
      );

      if (!sessionResult.success) {
        return createError<RbookSessionCaptureResult>(
          sessionResult.error ?? { code: 'DB_QUERY_FAILED', message: 'Failed to query session' }
        );
      }

      if (!sessionResult.data) {
        return createError<RbookSessionCaptureResult>(RbookErrors.sessionNotFound(sessionId));
      }

      let session = sessionResult.data;

      if (session.status !== 'active') {
        return createError<RbookSessionCaptureResult>(RbookErrors.sessionNotActive(sessionId));
      }

      if (isPeerSession(session.owner_key))
        return createError<RbookSessionCaptureResult>(sessionOfAnotherCopy(sessionId));
      // s92-m03: a named session that another running process is writing to is not this
      // caller's to write into; it would be attributed to that process.
      if (heldByAnotherProcess(client, session, 'write')) {
        return createError<RbookSessionCaptureResult>(
          RbookErrors.sessionOwnedByAnotherProcess(sessionId)
        );
      }

      if (category === 'decision') {
        const shape = ensureDecisionShapeColumns(client);
        warnings.push(...(shape.warnings ?? []));
        if (!shape.ready)
          return createError<RbookSessionCaptureResult>({
            code: 'DB_QUERY_FAILED',
            message: 'Decision schema migration failed; the operation was not completed.',
            suggestion: 'Resolve the reported schema or lock problem, then retry.',
          });
      }

      const now = new Date().toISOString();
      const missionId = params.missionId?.trim() || undefined;
      const linkedCategory = category === 'decision' || category === 'learning';
      if (linkedCategory) {
        if (missionId) {
          warnings.push(...ensureMissionIdColumn(client));
          warnings.push(...(ensureSessionMissionsTable(client).warnings ?? []));
        }
        const ready = prepareRecordLinkWrite(client, warnings, category);
        if (!ready.success) return createError<RbookSessionCaptureResult>(ready.error!);
      }
      if (category === 'next-step' && missionId)
        warnings.push(...(ensureSessionMissionsTable(client).warnings ?? []));
      // A capture that writes its row under the write lock re-reads its session there.
      const lockedCategory = linkedCategory || category === 'next-step';
      const pendingEmbeddings: Array<{ kind: 'decision' | 'learning'; id: number }> = [];
      const captureUnit = (): RbookSessionCaptureResult => {
        if (lockedCategory) {
          const current = client.getOne<
            Session & { implicit: number | null; owner_key: string | null }
          >(
            'SELECT id, status, captures, sprint_id, started_at, implicit, owner_key FROM sessions WHERE id = ?',
            [sessionId]
          );
          if (!current.success || !current.data || current.data.status !== 'active')
            throw new Error(current.error?.message ?? 'Session is no longer active');
          if (heldByAnotherProcess(client, current.data, 'write'))
            throw new Error('Session is owned by another process');
          session = current.data;
        }
        // Parse existing captures
        let captures: Array<{
          timestamp: string;
          category: string;
          content: string;
          context?: string;
        }> = [];
        try {
          captures = session.captures ? JSON.parse(session.captures) : [];
        } catch {
          captures = [];
        }

        // Add new capture
        const newCapture: {
          timestamp: string;
          category: string;
          content: string;
          context?: string;
          missionId?: string;
          expiresAt?: string;
          sprintId?: string;
        } = {
          timestamp: now,
          category,
          content,
        };
        if (captureContext) {
          newCapture.context = captureContext;
        }
        if (missionId) {
          newCapture.missionId = missionId;
        }
        // s86-m03: the SECOND of expiresAt's two independent drops. The direct-write path below
        // already reads `params.expiresAt` into the constraints INSERT, so forwarding the router
        // param alone makes THAT leg work — while rbook-session-complete.ts:589, which extracts
        // `expiresAt` off this stored capture blob to build the constraint at session close, stays
        // permanently undefined. A test exercising only capture would report the bug fixed.
        if (params.expiresAt) {
          newCapture.expiresAt = params.expiresAt;
        }
        // s92-m03: the sprint of a row this capture leaves to its session's close is decided now, by
        // the rule the immediate rows follow: the mission's sprint, else the explicit sprintId. With
        // neither, the close decides. s100-m03: a next step is written now, by the close's rule.
        let deferredSprintId: string | null = null;
        if (missionId) {
          const mission = client.getOne<{ sprint_id: string | null }>(
            'SELECT sprint_id FROM missions WHERE id = ?',
            [missionId]
          );
          deferredSprintId = mission.success ? (mission.data?.sprint_id ?? null) : null;
        }
        deferredSprintId = deferredSprintId ?? explicitSprintId;
        if (deferredSprintId) {
          newCapture.sprintId = deferredSprintId;
        }
        captures.push(newCapture);

        // Update the session
        const updateResult = client.execute('UPDATE sessions SET captures = ? WHERE id = ?', [
          JSON.stringify(captures),
          sessionId,
        ]);

        if (!updateResult.success) {
          throw new Error(
            `Failed to save capture: ${updateResult.error?.message ?? 'Unknown error'}`
          );
        }

        // Insert session event
        const summary = `[${category}] ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`;
        const rawEvent = JSON.stringify({
          ts: now,
          agent,
          session: sessionId,
          action: 'capture',
          category,
          status: 'active',
          summary,
          missionId,
        });

        checkWrite(
          client.execute(
            `INSERT INTO session_events (ts, agent, mission, action, status, summary, next_hint, raw_event)
           VALUES (?, ?, ?, 'capture', 'active', ?, ?, ?)`,
            [now, agent, sessionId, summary, captureContext, rawEvent]
          ),
          warnings,
          'capture event logging'
        );

        // Track session→mission association when missionId is provided
        if (missionId) {
          if (!lockedCategory)
            warnings.push(...(ensureSessionMissionsTable(client).warnings ?? []));
          // INSERT OR IGNORE: idempotent — won't duplicate if already linked
          const linked = client.execute(
            `INSERT OR IGNORE INTO session_missions (session_id, mission_id, linked_at, source)
             VALUES (?, ?, ?, 'capture')`,
            [sessionId, missionId, now]
          );
          // s96-m01: a new link on a shared store takes the copy's next sequence; this unit runs
          // under the write lock there.
          if (
            checkWrite(linked, warnings, 'session-to-mission association') &&
            linked.data?.changes &&
            !isRecordedStore(client)
          )
            takeReplicaSeq(client, 'session_missions');
        }

        // Decision extraction with mission association
        const resultData: RbookSessionCaptureResult = {
          sessionId,
          category,
          content,
          timestamp: now,
          captureCount: captures.length,
          message: `Captured ${category} in session '${sessionId}' (${captures.length} total captures)`,
          structuredMaterialization: initialStructuredMaterialization(category),
          writeFailures: writeSink.failures,
        };

        if (missionId) {
          resultData.missionId = missionId;
        }
        if (implicitSession) {
          resultData.implicitSession = implicitSession;
        }

        if (category === 'decision') {
          // Get sprint_id from session or mission
          let sprintId: string | null = null;
          if (missionId) {
            const missionResult = client.getOne<{ sprint_id: string | null }>(
              'SELECT sprint_id FROM missions WHERE id = ?',
              [missionId]
            );
            sprintId = missionResult.success ? (missionResult.data?.sprint_id ?? null) : null;
          }
          if (!sprintId) {
            sprintId =
              explicitSprintId ?? session.sprint_id ?? inferSprintIdForDecisionCapture(client);
          }

          // s91-m04: the lookup, INSERT, detection and embedding live in decision-write.ts, shared
          // with rbook_decisions(action="record").
          const existingDecisionId = findExistingDecisionId(client, content, sessionId);

          if (existingDecisionId !== undefined) {
            requireRecordLinks(client, 'decision', existingDecisionId);
            resultData.decisionAlreadyExtracted = true;
            resultData.decisionExtractionCount = 0;
            resultData.decisionId = existingDecisionId;
            resultData.structuredMaterialization.outcome = 'existing';
          } else {
            const evidenceArray = params.evidence;
            const written = insertDecisionRow(
              client,
              {
                content,
                now,
                sprintId,
                authorSessionId: sessionId,
                missionId,
                evidence: evidenceArray,
              },
              writeSink
            );

            if (written.kind === 'materialized') {
              resultData.decisionExtractionCount = 1;
              resultData.decisionAlreadyExtracted = false;
              if (evidenceArray && evidenceArray.length > 0) {
                resultData.evidenceStored = evidenceArray;
              }
              if (written.decisionId !== undefined) {
                resultData.decisionId = written.decisionId;
              }
              resultData.structuredMaterialization.outcome = 'materialized';

              // s92-m04: embedding only; the automatic supersession offer is retired.
              if (written.decisionId !== undefined)
                pendingEmbeddings.push({ kind: 'decision', id: written.decisionId });
            } else if (written.kind === 'failed') {
              // s86-m02b — THE FLAGSHIP FIX. This arm has existed since Sprint 20 and set
              // count=0 + alreadyExtracted=false, which the formatter rendered as
              // "Extraction skipped". Nothing was skipped: the INSERT errored and a strategic
              // decision was LOST while the answer reported a clean, uneventful capture.
              resultData.decisionExtractionCount = 0;
              resultData.decisionAlreadyExtracted = false;
              resultData.decisionExtractionFailed = written.message;
            }
          }
        }

        let newlyInsertedLearningId: number | undefined;
        if (category === 'learning') {
          // Get sprint_id from session or mission
          let sprintId: string | null = null;
          if (missionId) {
            const missionResult = client.getOne<{ sprint_id: string | null }>(
              'SELECT sprint_id FROM missions WHERE id = ?',
              [missionId]
            );
            sprintId = missionResult.success ? (missionResult.data?.sprint_id ?? null) : null;
          }
          if (!sprintId) {
            sprintId =
              explicitSprintId ?? session.sprint_id ?? inferSprintIdForDecisionCapture(client);
          }

          // Check for duplicate
          const existingLearning = client.getOne<{ id: number }>(
            'SELECT id FROM learnings WHERE content = ? AND author_session_id = ?',
            [content, sessionId]
          );

          // s86-m02b (fork f10, read side): a FAILED dedup SELECT reads as "no duplicate" and
          // falls through to the INSERT. Behaviour UNCHANGED — a duplicate learning is recoverable
          // and detectable, unlike a lost write — but the operator is told.
          if (!existingLearning.success) {
            warnings.push(
              `learning de-duplication check failed; a duplicate row may have been written: ` +
                `${existingLearning.error?.code ?? 'DB_ERROR'} — ${existingLearning.error?.message ?? 'unknown'}`
            );
          }

          if (!existingLearning.success || !existingLearning.data) {
            const g = genesisColumns(client, 'learnings', getProjectId(client));
            const insertResult = client.execute(
              `INSERT INTO learnings (content, category, status, sprint_id, author_session_id, mission_id, created_at, evergreen, ${g.columns.join(', ')})
             VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ${g.placeholders})`,
              [
                content,
                null,
                sprintId,
                sessionId,
                missionId ?? null,
                now,
                params.evergreen === true ? 1 : 0,
                ...g.values,
              ]
            );
            // s86-m02b: `learningExtracted` used to be the INSERT's success flag, so `false` meant
            // BOTH "a duplicate already existed" (the else arm below) and "the INSERT errored".
            // The error case now has its own channel and the flag means only what it says.
            resultData.learningExtracted = checkWrite(insertResult, writeSink, 'learnings.insert');
            if (resultData.learningExtracted) {
              const lastId = insertResult.data?.lastInsertRowid;
              if (typeof lastId === 'number') {
                newlyInsertedLearningId = lastId;
              } else if (typeof lastId === 'bigint') {
                newlyInsertedLearningId = Number(lastId);
              }

              if (newlyInsertedLearningId !== undefined) {
                resultData.learningId = newlyInsertedLearningId;
              }
              resultData.structuredMaterialization.outcome = 'materialized';

              if (newlyInsertedLearningId !== undefined)
                pendingEmbeddings.push({ kind: 'learning', id: newlyInsertedLearningId });
            }
          } else {
            resultData.learningExtracted = false;
            newlyInsertedLearningId = existingLearning.data.id;
            resultData.learningId = existingLearning.data.id;
            if (params.evergreen === undefined) {
              resultData.structuredMaterialization.outcome = 'existing';
            } else if (
              checkWrite(
                client.execute('UPDATE learnings SET evergreen = ? WHERE id = ?', [
                  params.evergreen ? 1 : 0,
                  existingLearning.data.id,
                ]),
                writeSink,
                'learnings.evergreen.update'
              )
            ) {
              resultData.structuredMaterialization.outcome = 'existing';
            }
          }
        }

        if (category === 'constraint') {
          warnings.push(...(ensureConstraintsTable(client).warnings ?? []));

          // Get sprint_id from session or mission
          let sprintId: string | null = null;
          if (missionId) {
            const missionResult = client.getOne<{ sprint_id: string | null }>(
              'SELECT sprint_id FROM missions WHERE id = ?',
              [missionId]
            );
            sprintId = missionResult.success ? (missionResult.data?.sprint_id ?? null) : null;
          }
          if (!sprintId) {
            sprintId =
              explicitSprintId ?? session.sprint_id ?? inferSprintIdForDecisionCapture(client);
          }

          // Dedup via content hash
          const hash = computeContentHash(content, 'constraint');
          // s100-m03: a row that arrived from another copy has no hash here, so its text is matched.
          const existingConstraint = client.getOne<{ id: number }>(
            `SELECT id FROM constraints WHERE ${SAME_TEXT_SQL} AND status = ?`,
            [hash, content, 'active']
          );

          // s86-m02b (fork f10, read side): same disclosure as the learning arm above.
          if (!existingConstraint.success) {
            warnings.push(
              `constraint de-duplication check failed; a duplicate row may have been written: ` +
                `${existingConstraint.error?.code ?? 'DB_ERROR'} — ${existingConstraint.error?.message ?? 'unknown'}`
            );
          }

          if (!existingConstraint.success || !existingConstraint.data) {
            const expiresAt = params.expiresAt ?? null;
            const g = genesisColumns(client, 'constraints', getProjectId(client));
            const insertResult = client.execute(
              `INSERT INTO constraints (content, status, session_id, sprint_id, created_at, expires_at, content_hash, ${g.columns.join(', ')})
             VALUES (?, 'active', ?, ?, ?, ?, ?, ${g.placeholders})`,
              [content, sessionId, sprintId, now, expiresAt, hash, ...g.values]
            );
            // s86-m02b: same split as `learningExtracted` — `false` now means duplicate only.
            resultData.constraintExtracted = checkWrite(
              insertResult,
              writeSink,
              'constraints.insert'
            );
            if (resultData.constraintExtracted) {
              resultData.structuredMaterialization.outcome = 'materialized';
            }
          } else {
            resultData.constraintExtracted = false;
            resultData.structuredMaterialization.outcome = 'existing';
          }
        }

        if (category === 'next-step') {
          // s100-m03: the row the close would write, written now, by the close's one key: this
          // session's row with this text, whatever its status, is this step. The close finds it and
          // writes only captures without one; a failed write here leaves the capture for the close.
          // A second row for a resolved step would need a second key, and the close could not tell
          // a kept capture from the step it repeats (the write-path critic's round 2).
          const trimmed = content.trim();
          const hash = computeContentHash(trimmed, 'next-step');
          const existing = client.getOne<{ id: number; status: string }>(
            `SELECT n.id, n.status FROM next_steps n
              WHERE n.session_id = ? AND ${SAME_TEXT_SQL}
              ORDER BY CASE WHEN ${LEASED_STATUS_SQL} THEN 0 ELSE 1 END, n.id LIMIT 1`,
            [sessionId, hash, trimmed]
          );
          if (!existing.success) {
            warnings.push(
              `next-step de-duplication check failed; a duplicate row may have been written: ` +
                `${existing.error?.code ?? 'DB_ERROR'} — ${existing.error?.message ?? 'unknown'}`
            );
          }
          if (existing.success && existing.data) {
            const { id, status } = existing.data;
            resultData.nextStepId = id;
            resultData.structuredMaterialization.outcome = 'existing';
            if (status === 'completed' || status === 'dropped')
              warnings.push(
                `Next step #${id} has this text in this session and is ${status}, so this capture opened nothing. ` +
                  `To open it again: rbook_context(action="next_steps", nextStepAction="reopen", nextStepIds=[${id}]).`
              );
          } else if (trimmed) {
            // The close's sprint rule, applied at capture: an implicit session carries no sprint.
            const sprintId =
              deferredSprintId ??
              session.sprint_id ??
              (session.implicit === 1 ? resolveOpenSprintIdForWrite(client) : null);
            const g = genesisColumns(client, 'next_steps', getProjectId(client));
            const insertResult = client.execute(
              `INSERT INTO next_steps (content, status, session_id, sprint_id, mission_id, created_at, content_hash, ${g.columns.join(', ')})
             VALUES (?, 'pending', ?, ?, ?, ?, ?, ${g.placeholders})`,
              [trimmed, sessionId, sprintId, missionId ?? null, now, hash, ...g.values]
            );
            if (checkWrite(insertResult, writeSink, 'next_steps.insert')) {
              const lastId = insertResult.data?.lastInsertRowid;
              if (lastId !== undefined) resultData.nextStepId = Number(lastId);
              resultData.structuredMaterialization.outcome = 'materialized';
            }
          } else {
            warnings.push(
              'This next step was empty once a marshalling artifact was removed from it, so no row was written.'
            );
          }
        }

        if (category === 'decision' && resultData.decisionId === undefined)
          throw new Error(resultData.decisionExtractionFailed ?? 'Decision extraction failed');
        if (category === 'learning') {
          if (writeSink.failures.length)
            throw new Error(writeSink.failures.map((failure) => failure.message).join('; '));
          requireRecordLinks(client, 'learning', resultData.learningId);
        }
        return resultData;
      };
      // s96-m01: a shared store allocates a constraint's id under the write lock too.
      const captured =
        lockedCategory || isSharedStore(client)
          ? recordedTransaction(client, captureUnit)
          : createSuccess(captureUnit());
      // s96-m01: a shared record's refusal (a full number block) keeps its own code and remedy.
      if (isReplicaRefusal(captured.error))
        return createError<RbookSessionCaptureResult>(captured.error!);
      if (!captured.success || !captured.data)
        return recordLinkFailure(captured.error?.message ?? 'Capture rolled back');
      const resultData = captured.data;
      for (const pending of pendingEmbeddings) {
        if (pending.kind === 'decision')
          await followDecisionInsert(client, content, pending.id, warnings);
        else {
          const embedded = await recordEmbedding(client, {
            type: 'learning',
            id: pending.id,
            inputText: learningEmbeddingInput(content),
          });
          warnings.push(...(embedded.warnings ?? []));
        }
      }

      // Sprint 61 m01 — reaffirm the learnings a decision or learning capture cites. Since
      // s92-m04 only the explicit `citesLearningIds[]` bump; content overlap no longer does.
      if (category === 'decision' || category === 'learning') {
        const reaffirm = await applyLearningReaffirm(
          client,
          { explicitIds: citesLearningIds, reaffirmedAt: now },
          warnings
        );
        // s86-m02b: a failed existence lookup classifies NOTHING, so the reaffirmed/missing
        // lists above are INCOMPLETE rather than authoritative. That has to reach the answer, or
        // the caller reads a partial corpus view as a complete one.
        writeSink.failures.push(...reaffirm.writeFailures);
        if (reaffirm.explicitlyReaffirmedIds.length > 0) {
          resultData.explicitlyReaffirmedLearningIds = reaffirm.explicitlyReaffirmedIds;
        }
        if (reaffirm.missingIds.length > 0) {
          resultData.missingCitedLearningIds = reaffirm.missingIds;
        }
      }

      // s85-m04 — THE SUPPLY LEVER. The two SQL omissions explain only 26 of 342 unstamped
      // decisions; the dominant cause is agents simply not passing the OPTIONAL missionId
      // (176/981 captures = 17.9%, and learnings-stamped exactly equals
      // learning-captures-with-missionId). So the lever is asking, not inferring.
      //
      // NEVER silently pick a mission: a wrong mission_id is an unrecoverable false provenance
      // claim with no FK to catch it (verified — pragma_foreign_key_list('learnings') returns
      // zero rows on the migrated store even though the seed declares the FK). Warn instead.
      //
      // Deliberately NOT on the next-step path: 96.4% of next_steps were born at session
      // complete when zero mission was in progress, so it would be pure noise. (Measured when the
      // close wrote them; s100-m03 writes them at capture, where it is not re-measured.)
      //
      // s95-m06: a Ledger keeps no missions, so it is never asked for one; a Planner's are tasks.
      if (!missionId && (category === 'decision' || category === 'learning')) {
        const level = readProjectLevel(client);
        const candidates =
          level === 'ledger'
            ? null
            : client.getMany<{ id: string; status: string }>(
                `SELECT id, status FROM missions
            WHERE status IN ('In Progress', 'Current')
            ORDER BY CASE status WHEN 'In Progress' THEN 0 ELSE 1 END, id ASC
            LIMIT 5`,
                []
              );
        const rows = candidates?.success ? (candidates.data ?? []) : [];
        if (rows.length > 0) {
          const work = level === 'planner' ? 'task' : 'mission';
          const names = rows.map((r) => `${r.id} (${r.status})`).join(', ');
          warnings.push(
            `This ${category} was captured without a missionId while ${rows.length} ${work}(s) ` +
              `are open: ${names}. The row is stored UNSTAMPED, so it will not appear in ` +
              `rbook_${category === 'decision' ? 'decisions' : 'learnings'}(action="list", missionId=…). ` +
              `Pass missionId on the capture to record which ${work} this belongs to — it is not ` +
              `inferred, because a wrong one is an unrecoverable false provenance claim.`
          );
        }
      }

      return createSuccess<RbookSessionCaptureResult>(
        resultData,
        warnings.length > 0 ? warnings : undefined,
        sanitizedFields
      );
    },
    { projectRoot: params.projectRoot }
  );

  // s92-m03: on this process's first write to the store, close orphaned or idle implicit sessions,
  // outside the capture's own connection, even if the capture itself then failed.
  const reconciled = await reconcileStoreOnce(storePath);
  warnings.push(...reconciled.warnings);
  if (reconciled.receipts.length > 0) {
    if (result.success && result.data) result.data.closedSessions = reconciled.receipts;
    else warnings.push(...closedSessionLines(reconciled.receipts));
  }
  return attachWarnings(result, warnings);
}

function inferSprintIdForDecisionCapture(
  client: Parameters<Parameters<typeof withClientAsync>[0]>[0]
): string | null {
  const activeMission = client.getOne<{ sprint_id: string | null }>(
    `SELECT sprint_id
       FROM missions
      WHERE status IN ('In Progress', 'Current')
        AND sprint_id IS NOT NULL
      ORDER BY CASE status
        WHEN 'In Progress' THEN 0
        WHEN 'Current' THEN 1
        ELSE 2
      END, id ASC
      LIMIT 1`,
    []
  );

  if (activeMission.success && activeMission.data?.sprint_id) {
    return activeMission.data.sprint_id;
  }

  // s85-m03: the fallback now resolves through resolveOpenSprintIdForWrite, NOT the display
  // resolver. This MUST ship together with the rbook-session-start.ts swap: fixing only
  // session-start does not shrink the blast radius, it RELOCATES it. Once sessions.sprint_id
  // is NULL, the `session.sprint_id ?? inferSprintIdForDecisionCapture(...)` fallthrough at
  // the decision/learning/constraint call sites fires MORE often, so the dead sprint id would
  // simply land on those three tables instead of on the session.
  //
  // The mission-first leg above is unchanged and still wins: a decision captured mid-work
  // belongs to the active mission's sprint whatever the sprint's own status says.
  return resolveOpenSprintIdForWrite(client);
}

function initialStructuredMaterialization(
  category: CaptureCategory
): CaptureStructuredMaterialization {
  switch (category) {
    case 'decision':
      return { target: 'strategic_decisions', timing: 'immediate', outcome: 'failed' };
    case 'learning':
      return { target: 'learnings', timing: 'immediate', outcome: 'failed' };
    case 'constraint':
      return { target: 'constraints', timing: 'immediate', outcome: 'failed' };
    case 'context':
      return {
        target: 'master_context.context_notes',
        timing: 'session-close',
        outcome: 'deferred',
      };
    case 'next-step':
      return { target: 'next_steps', timing: 'immediate', outcome: 'failed' };
  }
}

/**
 * Format session capture result for LLM readability.
 */
/** s91-m05: the rendered receipt echoes at most this much of the captured content. */
const CONTENT_ECHO_CHARS = 100;

export function formatSessionCaptureForLLM(
  result: RbookToolResult<RbookSessionCaptureResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to capture insight',
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
  const categoryIcon: Record<CaptureCategory, string> = {
    decision: '⚖️',
    learning: '💡',
    constraint: '🚧',
    context: '📋',
    'next-step': '➡️',
  };

  const lines = [
    `${categoryIcon[data.category]} **${data.category.charAt(0).toUpperCase() + data.category.slice(1)} Captured**`,
    '',
    data.implicitSession
      ? `**Session**: ${data.sessionId} (implicit${data.implicitSession.opened ? ', opened for this process' : ''})`
      : `**Session**: ${data.sessionId}`,
    // s91-m05: the caller already holds what it sent; a 9 KB decision was echoed in full.
    data.content.length > CONTENT_ECHO_CHARS
      ? `**Content**: ${data.content.slice(0, CONTENT_ECHO_CHARS)}… (${data.content.length} characters stored)`
      : `**Content**: ${data.content}`,
    `**Capture #${data.captureCount}** in this session`,
  ];

  if (data.missionId) {
    lines.push(`**Mission**: ${data.missionId}`);
  }

  if (data.structuredMaterialization) {
    lines.push(
      `Structured materialization: ${data.structuredMaterialization.outcome} — ` +
        `${data.structuredMaterialization.timing === 'session-close' ? 'session close' : 'immediate'} → ` +
        data.structuredMaterialization.target
    );
  }

  if (data.decisionId !== undefined) {
    lines.push(`Decision ID: #${data.decisionId}`);
  }

  if (data.learningId !== undefined) {
    lines.push(`Learning ID: #${data.learningId}`);
  }

  if (data.nextStepId !== undefined) {
    lines.push(`Next step ID: #${data.nextStepId}`);
  }

  // s100-m03: a rejected row is not a lost next step; the capture holds it for the session's close.
  if (
    data.category === 'next-step' &&
    data.structuredMaterialization?.outcome === 'failed' &&
    data.content.trim() &&
    data.writeFailures.length > 0
  ) {
    lines.push(
      `The capture is kept in session ${data.sessionId}; its close tries the write again.`
    );
  }

  if (data.category === 'decision' && data.decisionExtractionCount !== undefined) {
    lines.push('');

    if (data.decisionExtractionFailed) {
      // s86-m02b: the third state. This branch used to be unreachable-by-omission — a failed
      // INSERT fell into the `else` below and was announced as "Extraction skipped".
      lines.push(`**Decision Extraction**: FAILED — the decision was NOT stored.`);
      lines.push(`  ${data.decisionExtractionFailed}`);
    } else if (data.decisionAlreadyExtracted) {
      lines.push('**Decision Extraction**: Already exists in strategic decisions');
    } else if (data.decisionExtractionCount > 0) {
      lines.push(`**Decision Extraction**: Auto-extracted (${data.decisionExtractionCount})`);
    } else {
      lines.push('**Decision Extraction**: Extraction skipped');
    }
  }

  if (data.evidenceStored?.length) {
    lines.push(`**Evidence**: ${data.evidenceStored.map((e) => `${e.type}:${e.id}`).join(', ')}`);
  }

  if (data.sourceChunkIds?.length) {
    lines.push(`**Source Chunks**: ${data.sourceChunkIds.join(', ')}`);
  }

  if (data.closedSessions && data.closedSessions.length > 0) {
    lines.push('');
    lines.push('**Closed stale sessions**:');
    for (const line of closedSessionLines(data.closedSessions)) lines.push(`  ${line}`);
  }

  appendWriteFailures(lines, data.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}
