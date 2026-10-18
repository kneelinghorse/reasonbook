/**
 * rbook_decisions batch_update action
 *
 * Updates multiple decisions' status in a single operation.
 * Designed for efficient decision hygiene workflows.
 *
 * @module tools/rbook/rbook-decisions-batch-update
 */

import { withClientValidated } from './client';
import type { RbookToolResult } from './types';
import { createError, RbookErrors, RBOOK_ERROR_CODES } from './errors';
import { appendWarnings, appendWriteFailures, attachWarnings } from './format-warnings';
import { ensureReviewTimestamps } from './schema-migrations';
import { countWrite, type WriteFailure } from './write-guard';
import { recordedExecute } from './record-changes';

export interface RbookDecisionsBatchUpdateResult {
  /** Number of decisions updated */
  updated: number;
  /** Total decisions requested */
  requested: number;
  /** IDs the existence SELECT proved absent — the query RAN and returned no row */
  notFound: number[];
  /** IDs that were already in the target status */
  alreadyInStatus: number[];
  /** IDs whose UPDATE was rejected by the database (s86-m02b) */
  failed: number[];
  /** IDs whose existence SELECT itself errored, so they are neither found nor not-found — their
   *  state is UNKNOWN and nothing was attempted for them (s86-m02b). The DB error for each is in
   *  `writeFailures`. Empty on every path where the lookup ran. */
  lookupFailed: number[];
  /** New status applied */
  status: string;
  /** Confirmation message */
  message: string;
  /** DB errors from the per-id existence SELECTs and UPDATEs; empty when every statement ran
   *  (s86-m02b) */
  writeFailures: WriteFailure[];
}

export interface RbookDecisionsBatchUpdateParams {
  /** Array of decision IDs to update */
  decisionIds: number[];
  /** Target status */
  status: string;
  /** Optional project root */
  projectRoot?: string;
}

const VALID_STATUSES = ['active', 'superseded', 'archived', 'stale'];
const MAX_BATCH_SIZE = 100;

export async function rbookDecisionsBatchUpdate(
  params: RbookDecisionsBatchUpdateParams
): Promise<RbookToolResult<RbookDecisionsBatchUpdateResult>> {
  if (!Array.isArray(params.decisionIds) || params.decisionIds.length === 0) {
    return createError(RbookErrors.missingParameter('decisionIds'));
  }

  if (params.decisionIds.length > MAX_BATCH_SIZE) {
    return createError({
      code: 'INVALID_PARAMETER',
      message: `Batch size ${params.decisionIds.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
      suggestion: `Split into batches of ${MAX_BATCH_SIZE} or fewer`,
    });
  }

  if (!params.status || !VALID_STATUSES.includes(params.status)) {
    return createError(RbookErrors.invalidParameter('status', params.status ?? '', VALID_STATUSES));
  }

  // s93-m11: the review-timestamp migration's warnings reach the answer.
  const warnings: string[] = [];
  const result = await withClientValidated(
    (client) => {
      const notFound: number[] = [];
      const alreadyInStatus: number[] = [];
      const failed: number[] = [];
      const lookupFailed: number[] = [];
      const writeFailures: WriteFailure[] = [];
      let updated = 0;

      // s93-m11: an explicit status update is a review, for every named row, including one already
      // in that status (keeping decisions stale on purpose). Stamping it lets readers and the
      // first-write staleness repair tell a status someone set from one an older Reasonbook wrote.
      warnings.push(...(ensureReviewTimestamps(client).warnings ?? []));
      const reviewColumn = client.getMany<{ name: string }>(
        "PRAGMA table_info('strategic_decisions')",
        []
      );
      const stampReview =
        reviewColumn.success && !!reviewColumn.data?.some((c) => c.name === 'last_reviewed_at');
      if (!stampReview && params.status === 'stale') {
        // Without its stamp an explicit 'stale' looks like the old flagger's, and the repair would
        // undo it at the next first write.
        return createError<RbookDecisionsBatchUpdateResult>({
          code: RBOOK_ERROR_CODES.DB_SCHEMA_MISMATCH,
          message:
            'No decision was set to stale: this store cannot record when they were reviewed (no last_reviewed_at column).',
          suggestion:
            'The column is added on the next write that can migrate this store; retry once the migration warning above is resolved.',
        });
      }
      const reviewedAt = new Date().toISOString();

      for (const id of params.decisionIds) {
        const existing = client.getOne<{ id: number; status: string }>(
          'SELECT id, status FROM strategic_decisions WHERE id = ?',
          [id]
        );

        // s86-m02b: "the query failed" is NOT "the decision is absent" — the same split
        // learning-reaffirm.ts makes non-cuttable. These two arms were one `||`, so an errored
        // SELECT was reported to the operator as `Not found: [id]` and folded into the
        // `N not found` message: a positive claim about the corpus made from a query that never
        // answered. An errored lookup classifies NOTHING; it is disclosed instead.
        if (!existing.success) {
          lookupFailed.push(id);
          writeFailures.push({
            op: `strategic_decisions existence lookup id=${id}`,
            code: existing.error?.code ?? 'DB_ERROR',
            message: existing.error?.message ?? 'unknown',
          });
          continue;
        }

        if (!existing.data) {
          notFound.push(id);
          continue;
        }

        if (existing.data.status === params.status) {
          alreadyInStatus.push(id);
          if (stampReview) {
            countWrite(
              recordedExecute(
                client,
                'UPDATE strategic_decisions SET last_reviewed_at = ? WHERE id = ?',
                [reviewedAt, id]
              ),
              { failures: writeFailures },
              `strategic_decisions.last_reviewed_at id=${id}`
            );
          }
          continue;
        }

        const result = stampReview
          ? recordedExecute(
              client,
              'UPDATE strategic_decisions SET status = ?, last_reviewed_at = ? WHERE id = ?',
              [params.status, reviewedAt, id]
            )
          : recordedExecute(client, 'UPDATE strategic_decisions SET status = ? WHERE id = ?', [
              params.status,
              id,
            ]);

        // s86-m02b: the row was just SELECTed and is not already in the target status, so a
        // failed UPDATE is the only way this id can miss — it belongs in its own bucket, not
        // folded into `updated` and not silently absent from every bucket.
        if (
          countWrite(result, { failures: writeFailures }, `strategic_decisions.status id=${id}`) > 0
        ) {
          updated++;
        } else if (!result.success) {
          failed.push(id);
        }
      }

      const parts: string[] = [`${updated} decision(s) updated to '${params.status}'`];
      if (notFound.length > 0) parts.push(`${notFound.length} not found`);
      if (alreadyInStatus.length > 0)
        parts.push(`${alreadyInStatus.length} already '${params.status}'`);
      if (failed.length > 0) parts.push(`${failed.length} failed to update`);
      if (lookupFailed.length > 0) parts.push(`${lookupFailed.length} not checked (lookup failed)`);

      return {
        success: true as const,
        data: {
          updated,
          requested: params.decisionIds.length,
          notFound,
          alreadyInStatus,
          failed,
          lookupFailed,
          status: params.status,
          message: parts.join(', '),
          writeFailures,
        },
      };
    },
    { projectRoot: params.projectRoot }
  );
  return attachWarnings(result, warnings);
}

export function formatDecisionsBatchUpdateForLLM(
  result: RbookToolResult<RbookDecisionsBatchUpdateResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    const lines = [
      '❌ Failed to batch update decisions',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
    ];
    if (error?.suggestion) lines.push(`Suggestion: ${error.suggestion}`);
    // s93-m11: a refusal after the review-timestamp migration carries that migration's warnings.
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  const d = result.data;
  const lines = ['✓ **Batch Decision Update**', '', d.message];

  if (d.notFound.length > 0) {
    lines.push(`  Not found: [${d.notFound.join(', ')}]`);
  }

  if (d.failed.length > 0) {
    lines.push(`  Failed to update: [${d.failed.join(', ')}]`);
  }

  if (d.lookupFailed.length > 0) {
    // s86-m02b: distinct from "Not found" on purpose — the lookup errored, so these ids were
    // neither confirmed present nor proven absent, and no UPDATE was attempted for them.
    lines.push(`  State unknown, lookup failed: [${d.lookupFailed.join(', ')}]`);
  }

  appendWriteFailures(lines, d.writeFailures);
  appendWarnings(lines, result);

  return lines.join('\n');
}
