// ABOUTME: Persistence helper for the Sprint 56 m03 agentFeedback standing channel.
// ABOUTME: Called by rbook_session, rbook_mission_transition, rbook_agent_onboard when the optional field is set.

import type { RbookDatabaseClient } from './client';
import { ensureAgentFeedbackTable } from './schema-migrations';
import { ensureAgentFeedbackFixColumns } from './agent-feedback-columns';
import { getServerVersion } from '../../server-version';
import { sanitizeContentField } from '../../intelligence/content-sanitizer';
import type { SanitizedFieldReport } from './types';
import { checkWrite } from './write-guard';

/** Context that follows the feedback row so triage can scope by sprint/session/mission. */
export interface AgentFeedbackContext {
  toolName: string;
  sessionId?: string | null;
  sprintId?: string | null;
  missionId?: string | null;
  projectId?: string | null;
}

export interface RecordAgentFeedbackResult {
  feedbackId: number | null;
  sanitizedFields: SanitizedFieldReport[];
  /**
   * Sprint 86 m02b — the DB error when the agent_feedback INSERT failed, which
   * used to be swallowed into a null feedbackId. Callers splice these into their
   * own warnings sink so the answer never implies the feedback was recorded.
   */
  warnings: string[];
}

/**
 * Persist a single agentFeedback entry, sanitizing the body before write so
 * corrupted XML markup cannot land in the feedback channel either.
 *
 * Returns `{feedbackId: null, sanitizedFields: []}` when the trimmed body is
 * empty (the caller passed an empty string) — no row is written. All null
 * context fields are persisted as NULL so the list/triage surface can group
 * cleanly by tool even when session/sprint/mission context is missing.
 */
export function recordAgentFeedback(
  client: RbookDatabaseClient,
  body: string,
  context: AgentFeedbackContext
): RecordAgentFeedbackResult {
  const trimmed = body.trim();
  if (!trimmed) {
    return { feedbackId: null, sanitizedFields: [], warnings: [] };
  }

  const warnings = [...(ensureAgentFeedbackTable(client).warnings ?? [])];

  const sanitizedFields: SanitizedFieldReport[] = [];
  const sanitation = sanitizeContentField(trimmed);
  if (sanitation.wasModified) {
    sanitizedFields.push({
      field: 'agentFeedback',
      reason: sanitation.reason ?? 'Stripped XML marshalling artifact.',
    });
  }

  const cleaned = sanitation.cleaned;
  if (!cleaned) {
    return { feedbackId: null, sanitizedFields, warnings };
  }

  const now = new Date().toISOString();
  // s108-m04: a new row records the release it was filed on, so a later fix rule can compare
  // versions rather than dates; a table the column could not be added to keeps its old shape.
  const columns = ensureAgentFeedbackFixColumns(client);
  warnings.push(...columns.warnings);
  const versioned = columns.present.has('reasonbook_version');
  const insertResult = client.execute(
    `INSERT INTO agent_feedback (
      tool_name, body, status, session_id, sprint_id, mission_id, project_id, created_at${versioned ? ', reasonbook_version' : ''}
    ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?${versioned ? ', ?' : ''})`,
    [
      context.toolName,
      cleaned,
      context.sessionId ?? null,
      context.sprintId ?? null,
      context.missionId ?? null,
      context.projectId ?? null,
      now,
      ...(versioned ? [getServerVersion()] : []),
    ]
  );

  checkWrite(insertResult, warnings, 'agent feedback insert');

  const feedbackId =
    insertResult.success && insertResult.data ? Number(insertResult.data.lastInsertRowid) : null;
  return { feedbackId, sanitizedFields, warnings };
}
