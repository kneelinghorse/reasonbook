// ABOUTME: Learning reaffirm — bumps last_reviewed_at on the learnings a capture or decision cites.
// ABOUTME: Sprint 61 m01. Keeps still-true institutional rules out of the staleness pile.

import type { RbookDatabaseClient } from './client';
import type { SanitizedField } from '../../intelligence/content-sanitizer';
import { ensureReviewTimestamps } from './schema-migrations';
import { checkWrite, type WriteFailure } from './write-guard';
import { recordedExecute } from './record-changes';

/**
 * s92-m04 retired the IMPLICIT reaffirm: a capture whose text overlapped a learning by 15+ keywords
 * used to bump that learning too. Replayed over every historical capture, it hit a learning the
 * author actually cited on 20 of 3,973 bumps (retrieval study §5, R4), so it mostly kept unrelated
 * learnings looking fresh. Reaffirming is explicit now: `citesLearningIds`, or
 * `rbook_learnings(action="reaffirm")`.
 */

/**
 * Result of a reaffirm pass — which learnings actually had their timestamps bumped,
 * and any IDs the caller provided that did not resolve to existing rows.
 */
export interface LearningReaffirmOutcome {
  /** Learning IDs touched by the explicit `citesLearningIds[]` path. */
  explicitlyReaffirmedIds: number[];
  /** Explicit IDs the caller supplied that did not resolve to a learning row. */
  missingIds: number[];
  /**
   * s86-m02b — DB failures from this pass, for the caller's `writeFailures` channel.
   *
   * EMPTY IS THE NORMAL CASE. A non-empty entry means the corpus lists above are INCOMPLETE,
   * not that a learning is missing: an id absent from both `missingIds` and the reaffirmed
   * lists was never classified because the query that would have classified it errored.
   */
  writeFailures: WriteFailure[];
}

/**
 * Sanitize a list of incoming learning IDs.
 *
 * Drops entries that are not finite positive integers and surfaces each dropped
 * entry on `sanitizedFields` so the agent can re-emit cleanly. Mirrors the
 * `sanitizeStringArray` contract from `intelligence/content-sanitizer.ts`.
 */
export function sanitizeLearningIds(
  fieldName: string,
  values: readonly unknown[] | undefined
): { cleaned: number[]; sanitizedFields: SanitizedField[] } {
  if (!values) return { cleaned: [], sanitizedFields: [] };
  const cleaned: number[] = [];
  const sanitizedFields: SanitizedField[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
      if (!seen.has(value)) {
        seen.add(value);
        cleaned.push(value);
      }
      continue;
    }
    sanitizedFields.push({
      field: `${fieldName}[${i}]`,
      reason: `Dropped non-integer learning id ${JSON.stringify(value)} — citesLearningIds entries must be positive integer learning IDs.`,
    });
  }
  return { cleaned, sanitizedFields };
}

/**
 * Bump `last_reviewed_at` on the given learning IDs in a single UPDATE.
 *
 * Returns the IDs that resolved to existing rows alongside any explicit IDs
 * the caller supplied that did not exist (so the caller can surface them).
 * Idempotent — touching the same row repeatedly is a no-op beyond the timestamp.
 *
 * s86-m02b: both halves say only what they know. A failed existence SELECT classifies NOTHING
 * (see below), and a failed UPDATE reports NO id as reaffirmed; either way the DB error travels
 * out on `writeFailures`. The optional `warnings` sink is the enclosing answer's existing
 * migration-warning carrier; standalone helper callers may omit it.
 */
export function reaffirmLearningsByIds(
  client: RbookDatabaseClient,
  ids: readonly number[],
  reaffirmedAt: string,
  warnings: string[] = []
): { reaffirmedIds: number[]; missingIds: number[]; writeFailures: WriteFailure[] } {
  if (ids.length === 0) return { reaffirmedIds: [], missingIds: [], writeFailures: [] };
  // One answer can run this helper repeatedly (explicit cites, implicit cites, and multiple
  // session-close decisions). A persistent DDL failure is still one fact about that answer.
  for (const warning of ensureReviewTimestamps(client).warnings ?? []) {
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  const writeFailures: WriteFailure[] = [];
  const placeholders = ids.map(() => '?').join(', ');
  const existsResult = client.getMany<{ id: number }>(
    `SELECT id FROM learnings WHERE id IN (${placeholders})`,
    [...ids]
  );
  if (!existsResult.success || !existsResult.data) {
    // "The query failed" is NOT "the learning is absent". Folding a failed SELECT into an empty
    // Set put EVERY cited id into missingIds, and the caller renders that as
    // missingCitedLearningIds — a false claim about the corpus. Classify nothing, disclose the
    // error. (The read side is not walked by the no-silent-write gate; this arm is by hand.)
    writeFailures.push({
      op: 'learnings existence lookup',
      code: existsResult.error?.code ?? 'DB_ERROR',
      message: existsResult.error?.message ?? 'unknown',
    });
    return { reaffirmedIds: [], missingIds: [], writeFailures };
  }
  const existingIds = new Set<number>(existsResult.data.map((r) => r.id));
  const reaffirmedIds: number[] = [];
  const missingIds: number[] = [];
  for (const id of ids) {
    if (existingIds.has(id)) {
      reaffirmedIds.push(id);
    } else {
      missingIds.push(id);
    }
  }
  if (reaffirmedIds.length === 0) {
    return { reaffirmedIds: [], missingIds, writeFailures };
  }
  const idPlaceholders = reaffirmedIds.map(() => '?').join(', ');
  const updateResult = recordedExecute(
    client,
    `UPDATE learnings SET last_reviewed_at = ? WHERE id IN (${idPlaceholders})`,
    [reaffirmedAt, ...reaffirmedIds]
  );
  if (!checkWrite(updateResult, { failures: writeFailures }, 'learnings.last_reviewed_at')) {
    // Nothing was bumped, so nothing may be reported as reaffirmed. The rows still exist, so
    // they are not missing either — the failure entry is the only true thing to say about them.
    return { reaffirmedIds: [], missingIds, writeFailures };
  }
  return { reaffirmedIds, missingIds, writeFailures };
}

/**
 * Reaffirm the learnings a capture or decision explicitly cites. Since s92-m04 there is no
 * content-overlap path (see the module note).
 */
export async function applyLearningReaffirm(
  client: RbookDatabaseClient,
  options: {
    explicitIds: readonly number[];
    reaffirmedAt: string;
  },
  warnings: string[] = []
): Promise<LearningReaffirmOutcome> {
  const explicit = reaffirmLearningsByIds(
    client,
    options.explicitIds,
    options.reaffirmedAt,
    warnings
  );
  return {
    explicitlyReaffirmedIds: explicit.reaffirmedIds,
    missingIds: explicit.missingIds,
    writeFailures: explicit.writeFailures,
  };
}
