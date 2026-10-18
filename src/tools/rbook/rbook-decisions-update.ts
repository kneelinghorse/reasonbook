// ABOUTME: Updates decision status and supersession while repairing required textual links atomically.
// ABOUTME: Schema readiness precedes the transaction, including idempotent no-change updates.
/**
 * rbook_decisions update action
 *
 * Updates a strategic decision's superseded_by and/or status fields.
 * Automatically sets status='superseded' when superseded_by is set.
 *
 * @module tools/rbook/rbook-decisions-update
 */

import { withClientValidated } from './client';
import { prepareRecordLinkWrite, requireRecordLinks, recordLinkFailure } from './record-link-write';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RbookErrors, RBOOK_ERROR_CODES } from './errors';
import { appendWarnings, attachWarnings } from './format-warnings';
import { ensureReviewTimestamps } from './schema-migrations';
import { recordedExecute, recordedTransaction } from './record-changes';

export interface RbookDecisionsUpdateResult {
  /** ID of the updated decision */
  decisionId: number;

  /** Previous status */
  previousStatus: string;

  /** New status after update */
  newStatus: string;

  /** ID of the superseding decision (if set) */
  supersededBy: number | null;

  /** Confirmation message */
  message: string;
}

export interface RbookDecisionsUpdateParams {
  /** Decision ID to update */
  decisionId: number;

  /** ID of the decision that supersedes this one */
  supersededBy?: number;

  /** New status (auto-set to 'superseded' when supersededBy is provided) */
  status?: string;

  /** Optional project root */
  projectRoot?: string;
}

const VALID_STATUSES = ['active', 'superseded', 'archived', 'stale'];

export async function rbookDecisionsUpdate(
  params: RbookDecisionsUpdateParams
): Promise<RbookToolResult<RbookDecisionsUpdateResult>> {
  if (!params.decisionId || typeof params.decisionId !== 'number') {
    return createError(RbookErrors.missingParameter('decisionId'));
  }

  if (params.status && !VALID_STATUSES.includes(params.status)) {
    return createError(RbookErrors.invalidParameter('status', params.status, VALID_STATUSES));
  }

  // s93-m11: the review-timestamp migration's warnings reach every answer this call gives.
  const warnings: string[] = [];
  const result = await withClientValidated(
    (client) => {
      // Fetch the existing decision
      const existing = client.getOne<{
        id: number;
        status: string;
        superseded_by: number | null;
      }>('SELECT id, status, superseded_by FROM strategic_decisions WHERE id = ?', [
        params.decisionId,
      ]);

      if (!existing.success || !existing.data) {
        return createError<RbookDecisionsUpdateResult>({
          code: RBOOK_ERROR_CODES.MISSION_NOT_FOUND,
          message: `Decision #${params.decisionId} not found`,
          suggestion: 'Use rbook_decisions list to find valid decision IDs',
        });
      }

      const previousStatus = existing.data.status;

      // If supersededBy is provided, validate the target exists
      if (params.supersededBy !== undefined) {
        const target = client.getOne<{ id: number }>(
          'SELECT id FROM strategic_decisions WHERE id = ?',
          [params.supersededBy]
        );

        if (!target.success || !target.data) {
          return createError<RbookDecisionsUpdateResult>({
            code: RBOOK_ERROR_CODES.MISSION_NOT_FOUND,
            message: `Superseding decision #${params.supersededBy} not found`,
            suggestion: 'The supersededBy value must reference an existing decision ID',
          });
        }

        if (params.supersededBy === params.decisionId) {
          return createError<RbookDecisionsUpdateResult>({
            code: 'INVALID_PARAMETER',
            message: 'A decision cannot supersede itself',
          });
        }
      }

      // Determine new status
      let newStatus = params.status ?? previousStatus;
      if (params.supersededBy !== undefined && !params.status) {
        // Auto-set status to 'superseded' when supersededBy is provided
        newStatus = 'superseded';
      }

      // Build update
      const sets: string[] = [];
      const updateParams: (string | number | null)[] = [];

      if (newStatus !== previousStatus) {
        sets.push('status = ?');
        updateParams.push(newStatus);
      }

      // s93-m11: an explicit status update is a review, even when it leaves the status as it was
      // (keeping a decision stale on purpose). Stamping it lets every reader, and the first-write
      // staleness repair, tell a status someone set from one an older Reasonbook wrote on its own.
      if (newStatus !== previousStatus || params.status !== undefined) {
        warnings.push(...(ensureReviewTimestamps(client).warnings ?? []));
        if (hasReviewColumn(client)) {
          sets.push('last_reviewed_at = ?');
          updateParams.push(new Date().toISOString());
        } else if (newStatus === 'stale') {
          // Without its stamp an explicit 'stale' looks like the old flagger's, and the repair
          // would undo it at the next first write.
          return createError<RbookDecisionsUpdateResult>({
            code: RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH,
            message: `Decision #${params.decisionId} was not set to stale: this store cannot record when it was reviewed (no last_reviewed_at column).`,
            suggestion:
              'The column is added on the next write that can migrate this store; retry once the migration warning above is resolved.',
          });
        }
      }

      if (params.supersededBy !== undefined) {
        sets.push('superseded_by = ?');
        updateParams.push(params.supersededBy);
      }

      const ready = prepareRecordLinkWrite(client, warnings);
      if (!ready.success) return createError<RbookDecisionsUpdateResult>(ready.error!);
      const reviewOnly = newStatus === previousStatus && params.supersededBy === undefined;
      const committed = recordedTransaction(client, () => {
        if (sets.length > 0) {
          updateParams.push(params.decisionId);
          const updated = recordedExecute(
            client,
            `UPDATE strategic_decisions SET ${sets.join(', ')} WHERE id = ?`,
            updateParams
          );
          if (!updated.success) throw new Error(updated.error?.message ?? 'Decision update failed');
        }
        requireRecordLinks(client, 'decision', params.decisionId);
      });
      if (!committed.success)
        return recordLinkFailure(committed.error?.message ?? 'Decision update rolled back');

      const finalSupersededBy = params.supersededBy ?? existing.data.superseded_by;

      return createSuccess<RbookDecisionsUpdateResult>({
        decisionId: params.decisionId,
        previousStatus,
        newStatus,
        supersededBy: finalSupersededBy,
        message:
          sets.length === 0
            ? 'No changes needed'
            : reviewOnly
              ? `Decision #${params.decisionId} kept as ${newStatus}; its review time is recorded`
              : `Decision #${params.decisionId} updated: status ${previousStatus} → ${newStatus}${
                  params.supersededBy !== undefined ? `, superseded by #${params.supersededBy}` : ''
                }`,
      });
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

export function formatDecisionsUpdateForLLM(
  result: RbookToolResult<RbookDecisionsUpdateResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to update decision',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];
    if (error?.suggestion) lines.push(`Suggestion: ${error.suggestion}`);
    // s93-m11: a refusal after the review-timestamp migration carries that migration's warnings.
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const d = result.data;
  const lines = [
    '✓ **Decision Updated**',
    '',
    `**Decision**: #${d.decisionId}`,
    // s93-m11: an explicit status equal to the current one is recorded as a review.
    d.previousStatus === d.newStatus
      ? `**Status**: ${d.newStatus} (kept; its review time is recorded)`
      : `**Status**: ${d.previousStatus} → ${d.newStatus}`,
  ];

  if (d.supersededBy !== null) {
    lines.push(`**Superseded By**: #${d.supersededBy}`);
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}

/** Whether strategic_decisions carries last_reviewed_at (the ensure above may have failed). */
function hasReviewColumn(client: Parameters<typeof ensureReviewTimestamps>[0]): boolean {
  const columns = client.getMany<{ name: string }>("PRAGMA table_info('strategic_decisions')", []);
  return columns.success && !!columns.data?.some((c) => c.name === 'last_reviewed_at');
}
