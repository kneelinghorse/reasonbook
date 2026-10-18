/**
 * rbook_learnings update action
 *
 * Updates a learning's status (active, archived, superseded).
 * Primary use case: archiving stale learnings.
 *
 * @module tools/rbook/rbook-learnings-update
 */

import { withClientValidated } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RbookErrors, RBOOK_ERROR_CODES } from './errors';
import { ensureReviewTimestamps, ensureLearningsTable } from './schema-migrations';
import { appendWarnings, attachWarnings } from './format-warnings';
import { checkWrite } from './write-guard';
import { recordedExecute } from './record-changes';

const VALID_LEARNING_STATUSES = ['active', 'archived', 'superseded'];

/**
 * Result of learnings update operation.
 */
export interface RbookLearningsUpdateResult {
  /** ID of the updated learning */
  learningId: number;

  /** Previous status */
  previousStatus: string;

  /** New status after update */
  newStatus: string;

  /** Previous evergreen flag (Sprint 61 m03). */
  previousEvergreen: boolean;

  /** New evergreen flag after update (Sprint 61 m03). */
  newEvergreen: boolean;

  /** Confirmation message */
  message: string;
}

/**
 * Input parameters for learnings update action.
 */
export interface RbookLearningsUpdateParams {
  /** Learning ID to update */
  learningId: number;

  /** New status (optional when only toggling evergreen). */
  status?: string;

  /**
   * Sprint 61 m03 — evergreen flag. When `true`, marks the learning as a
   * still-true institutional rule and excludes it from the staleness signal.
   * Two-way: pass `false` to clear the flag.
   */
  evergreen?: boolean;

  /** Optional: explicit project root */
  projectRoot?: string;
}

/**
 * Execute the learnings update action.
 */
export async function rbookLearningsUpdate(
  params: RbookLearningsUpdateParams
): Promise<RbookToolResult<RbookLearningsUpdateResult>> {
  if (!params.learningId || typeof params.learningId !== 'number') {
    return createError(RbookErrors.missingParameter('learningId'));
  }

  const hasStatus = params.status !== undefined;
  const hasEvergreen = params.evergreen !== undefined;
  if (!hasStatus && !hasEvergreen) {
    return createError(RbookErrors.missingParameter('status or evergreen'));
  }

  if (hasStatus && !VALID_LEARNING_STATUSES.includes(params.status as string)) {
    return createError(
      RbookErrors.invalidParameter('status', params.status as string, VALID_LEARNING_STATUSES)
    );
  }

  const warnings: string[] = [];
  const result = await withClientValidated(
    (client) => {
      // Sprint 52 m03: ensure last_reviewed_at exists so we can bump it on update.
      // Sprint 61 m03: ensure the evergreen column exists before we read/write it.
      warnings.push(...(ensureReviewTimestamps(client).warnings ?? []));
      warnings.push(...(ensureLearningsTable(client).warnings ?? []));

      const existing = client.getOne<{
        id: number;
        status: string;
        evergreen: number | null;
      }>('SELECT id, status, evergreen FROM learnings WHERE id = ?', [params.learningId]);

      if (!existing.success || !existing.data) {
        return createError<RbookLearningsUpdateResult>({
          code: RBOOK_ERROR_CODES.MISSION_NOT_FOUND,
          message: `Learning #${params.learningId} not found`,
          suggestion: 'Use rbook_learnings list to find valid learning IDs',
        });
      }

      const previousStatus = existing.data.status;
      const previousEvergreen = existing.data.evergreen === 1;
      const newStatus = hasStatus ? (params.status as string) : previousStatus;
      const newEvergreen = hasEvergreen ? (params.evergreen as boolean) : previousEvergreen;
      const nowIso = new Date().toISOString();

      const statusChanged = newStatus !== previousStatus;
      const evergreenChanged = newEvergreen !== previousEvergreen;

      if (!statusChanged && !evergreenChanged) {
        // Idempotent set still counts as a review touch — bump the timestamp so
        // a reviewer can use update(status=current) as a tacit "still valid" ping.
        const touchResult = recordedExecute(
          client,
          'UPDATE learnings SET last_reviewed_at = ? WHERE id = ?',
          [nowIso, params.learningId]
        );
        checkWrite(touchResult, warnings, 'learnings.last_reviewed_at touch');
        return createSuccess<RbookLearningsUpdateResult>(
          {
            learningId: params.learningId,
            previousStatus,
            newStatus,
            previousEvergreen,
            newEvergreen,
            message: 'No changes needed',
          },
          warnings
        );
      }

      const updateResult = recordedExecute(
        client,
        'UPDATE learnings SET status = ?, evergreen = ?, last_reviewed_at = ? WHERE id = ?',
        [newStatus, newEvergreen ? 1 : 0, nowIso, params.learningId]
      );

      if (!updateResult.success) {
        return createError<RbookLearningsUpdateResult>({
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: `Failed to update learning: ${updateResult.error?.message ?? 'Unknown error'}`,
        });
      }

      const messageParts: string[] = [`Learning #${params.learningId} updated`];
      if (statusChanged) messageParts.push(`status ${previousStatus} → ${newStatus}`);
      if (evergreenChanged) {
        messageParts.push(`evergreen ${previousEvergreen} → ${newEvergreen}`);
      }

      return createSuccess<RbookLearningsUpdateResult>(
        {
          learningId: params.learningId,
          previousStatus,
          newStatus,
          previousEvergreen,
          newEvergreen,
          message: messageParts.join(': '),
        },
        warnings
      );
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

/**
 * Format learnings update result for LLM readability.
 */
export function formatLearningsUpdateForLLM(
  result: RbookToolResult<RbookLearningsUpdateResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to update learning',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ].filter(Boolean);
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const d = result.data;
  const lines = ['✓ **Learning Updated**', '', `**Learning**: #${d.learningId}`];
  if (d.previousStatus !== d.newStatus) {
    lines.push(`**Status**: ${d.previousStatus} → ${d.newStatus}`);
  } else {
    lines.push(`**Status**: ${d.newStatus} (unchanged)`);
  }
  if (d.previousEvergreen !== d.newEvergreen) {
    lines.push(`**Evergreen**: ${d.previousEvergreen} → ${d.newEvergreen}`);
  } else if (d.newEvergreen) {
    lines.push(`**Evergreen**: true (unchanged)`);
  }
  appendWarnings(lines, result);

  return lines.join('\n');
}
