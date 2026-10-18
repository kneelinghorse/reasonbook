// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Prepare citation writers before transactions and make required link failures abort them.
// ABOUTME: Shared by canonical record callers so no successful row is left without required links.

import type { RbookDatabaseClient } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess } from './errors';
import {
  ensureAuthorNamespaceColumns,
  ensureDecisionShapeColumns,
  ensureFirehoseEventColumns,
  ensureLearningsTable,
} from './schema-migrations';
import { ensureRecordLinks, materializeRecordLinks } from './record-links';
import { ensureGenesisSchema } from './genesis-columns';

export function prepareRecordLinkWrite(
  client: RbookDatabaseClient,
  warnings: string[],
  kind: 'decision' | 'learning' = 'decision'
): RbookToolResult<void> {
  const fail = () =>
    createError<void>({
      code: 'DB_QUERY_FAILED',
      message: 'Required record-link schema preparation failed; no record unit was written.',
      suggestion: 'Resolve the reported schema or database lock problem, then retry the record.',
    });
  // Existing migration warnings can concern optional indexes. Keep them advisory;
  // required shape/link readiness and the atomic INSERT remain the refusal gates.
  const author = ensureAuthorNamespaceColumns(client);
  warnings.push(...(author.warnings ?? []));
  const learningColumns = client.getMany<{ name: string }>('PRAGMA table_info(learnings)');
  if (!learningColumns.success) {
    warnings.push(
      `Could not inspect required learnings schema: ${learningColumns.error?.message ?? 'query failed'}`
    );
    return fail();
  }
  if (kind === 'learning' || !learningColumns.data?.length) {
    const learnings = ensureLearningsTable(client);
    warnings.push(...(learnings.warnings ?? []));
  }
  const firehose = ensureFirehoseEventColumns(client);
  warnings.push(...(firehose.warnings ?? []));
  if (kind === 'learning') {
    // This table can be created after the store-wide migration markers. Prepare its
    // required columns before capture takes the lock for its record-and-link unit.
    try {
      ensureGenesisSchema(client, 'learnings');
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      return fail();
    }
  }
  // Author and learning ensures can report the same optional index collision.
  warnings.splice(0, warnings.length, ...new Set(warnings));
  const shape = ensureDecisionShapeColumns(client);
  warnings.push(...(shape.warnings ?? []));
  if (!shape.ready) return fail();
  const links = ensureRecordLinks(client);
  warnings.push(...(links.warnings ?? []));
  return links.ready ? createSuccess(undefined) : fail();
}

/** Throw inside the caller's synchronous transaction; an error envelope alone would commit. */
export function requireRecordLinks(
  client: RbookDatabaseClient,
  kind: 'decision' | 'learning',
  id: number | undefined
): void {
  if (id === undefined || !Number.isSafeInteger(id))
    throw new Error('Required record ID is missing');
  const result = materializeRecordLinks(client, kind, id);
  if (!result.success)
    throw new Error(`record_links ${kind} #${id}: ${result.error?.message ?? 'write failed'}`);
}

export function recordLinkFailure(message: string): RbookToolResult<never> {
  return createError({
    code: 'DB_QUERY_FAILED',
    message,
    suggestion:
      'Resolve the reported record or citation-link database error, then retry; the required unit was rolled back.',
  });
}
