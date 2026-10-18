// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s77-m01 write-time single-current-sprint invariant — demote every OTHER
// open sprint to 'Planned' + the caller's primary write, in ONE atomic transaction.

/**
 * Write-time single-current-sprint invariant (s77-m01).
 *
 * Two Active sprints re-arm the "current sprint" resolver divergence (#853): the
 * naive picker orders `start_date ASC` and the canonical one `DESC`, so they name
 * different sprints the instant a second open sprint exists. The durable fix is
 * two layers — this write-side invariant (keep the store single-open) plus the
 * read-side resolver (heal foreign/legacy stores we don't control, s77-m02).
 *
 * This module is the write half: when a sprint is put into the OPEN set
 * ({@link SPRINT_OPEN_STATUSES}) via rbook_sprint(add|update), every OTHER open
 * sprint is demoted to 'Planned' — resumable, never 'Completed' (Fork 1a) — in
 * the SAME transaction as the primary write, so a forced failure leaves NEITHER
 * applied.
 *
 * @module tools/rbook/sprint-current-invariant
 */

import type { RbookDatabaseClient } from './client';
import { createError, createSuccess, RBOOK_ERROR_CODES } from './errors';
import type { RbookToolResult } from './types';
import { ensureAuthorNamespaceColumns, ensureFirehoseEventColumns } from './schema-migrations';
import { SPRINT_OPEN_STATUSES, statusInSql } from './terminal-status';
import { attachWarnings } from './format-warnings';
import { skipConflicted, skippedConflicts } from './record-conflict-skip';
import { recordedExecute } from './record-changes';

/** A sprint that was auto-demoted to 'Planned' to preserve the single-open invariant. */
export interface DemotedSprint {
  id: string;
  title: string | null;
}

/** Result payload of {@link writeSingleCurrentSprint}: the primary write's data + who was demoted. */
export interface SingleCurrentSprintResult<T> {
  data: T;
  demoted: DemotedSprint[];
}

const openStatusSql = statusInSql('status', SPRINT_OPEN_STATUSES);

/**
 * Run `primaryWrite` (the add INSERT or the status→open UPDATE) together with the
 * demotion of every OTHER open sprint to 'Planned', atomically.
 *
 * Migration ordering (load-bearing): the genesis firehose migration performs a
 * SQLite 12-step rebuild that toggles `foreign_keys`, which is a no-op inside a
 * transaction. `primaryWrite` stamps genesis columns (add) and would otherwise
 * trigger that rebuild lazily mid-transaction, silently corrupting an un-migrated
 * store. So both `ensure…` migrations run BEFORE `BEGIN IMMEDIATE` here — mirror
 * of rbook-sprint-complete.ts. Once ensured, the lazy ensures inside `primaryWrite`
 * are marker-gated no-ops.
 *
 * @param client   open DB client
 * @param keepSprintId  the sprint being made current — excluded from demotion
 * @param primaryWrite  the caller's write; its success/failure drives commit/rollback
 * @returns The write data and demotions, with pre-BEGIN migration warnings on the result envelope.
 */
export function writeSingleCurrentSprint<T>(
  client: RbookDatabaseClient,
  keepSprintId: string,
  primaryWrite: () => RbookToolResult<T>
): RbookToolResult<SingleCurrentSprintResult<T>> {
  const warnings: string[] = [];
  const result = (() => {
    // Pre-BEGIN migrations (see doc comment): the firehose rebuild cannot run inside
    // a transaction, and the author-namespace ALTERs are kept out of it for symmetry.
    warnings.push(...(ensureFirehoseEventColumns(client).warnings ?? []));
    warnings.push(...(ensureAuthorNamespaceColumns(client).warnings ?? []));

    const begin = client.execute('BEGIN IMMEDIATE', []);
    if (!begin.success) {
      return createError<SingleCurrentSprintResult<T>>(
        begin.error ?? {
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: 'Failed to begin single-current-sprint transaction',
          suggestion: 'Retry once the database becomes available.',
        }
      );
    }

    let transactionOpen = true;
    const rollback = (): void => {
      if (!transactionOpen) return;
      client.execute('ROLLBACK', []);
      transactionOpen = false;
    };
    const fail = (
      error: Parameters<typeof createError<SingleCurrentSprintResult<T>>>[0]
    ): RbookToolResult<SingleCurrentSprintResult<T>> => {
      rollback();
      return createError<SingleCurrentSprintResult<T>>(error);
    };

    // Name the sprints we are about to demote (for the warning). BEGIN IMMEDIATE
    // holds the write lock, so no other writer can change the set between this
    // SELECT and the UPDATE below — the two predicates match identically.
    // s96-m12: on a shared record, a sprint whose status is in conflict is skipped and named.
    const skip = skipConflicted(client, 'sprints', ['status']);
    const skipped = skippedConflicts(
      client,
      'sprints',
      ['status'],
      `${openStatusSql} AND id != ?`,
      [keepSprintId]
    );
    if (skipped) warnings.push(skipped);
    const othersResult = client.getMany<DemotedSprint>(
      `SELECT id, title FROM sprints WHERE ${openStatusSql} AND id != ?${skip}`,
      [keepSprintId]
    );
    if (!othersResult.success) {
      return fail(
        othersResult.error ?? {
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: 'Failed to query other open sprints',
        }
      );
    }
    const demoted = othersResult.data ?? [];

    if (demoted.length > 0) {
      const demoteResult = recordedExecute(
        client,
        `UPDATE sprints SET status = 'Planned' WHERE ${openStatusSql} AND id != ?${skip}`,
        [keepSprintId]
      );
      if (!demoteResult.success) {
        return fail(
          demoteResult.error ?? {
            code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
            message: 'Failed to demote other open sprints',
          }
        );
      }
    }

    const writeResult = primaryWrite();
    if (!writeResult.success) {
      return fail(
        writeResult.error ?? {
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: 'Primary sprint write failed',
        }
      );
    }

    const commit = client.execute('COMMIT', []);
    if (!commit.success) {
      return fail(
        commit.error ?? {
          code: RBOOK_ERROR_CODES.DB_QUERY_FAILED,
          message: 'Failed to commit single-current-sprint transaction',
        }
      );
    }
    transactionOpen = false;

    return createSuccess({ data: writeResult.data as T, demoted }, writeResult.warnings);
  })();

  return attachWarnings(result, warnings);
}

/**
 * Build the operator-facing warning naming the demoted sprints, or null when none
 * were demoted (so a single-current add/update stays warning-free).
 */
export function buildDemotionWarning(demoted: DemotedSprint[]): string | null {
  if (demoted.length === 0) return null;
  const names = demoted.map((s) => (s.title ? `${s.id} ("${s.title}")` : s.id)).join(', ');
  return (
    `Demoted ${demoted.length} other open sprint${demoted.length === 1 ? '' : 's'} to ` +
    `'Planned' to preserve a single current sprint: ${names}.`
  );
}
