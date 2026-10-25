// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The one strategic_decisions write path shared by session capture and decisions record:
// ABOUTME: dedup lookup, genesis-stamped INSERT, then supersession detection and embedding.

import type { RbookDatabaseClient } from './client';
import {
  storedDecisionFields,
  type DecisionFieldsParams,
  type DecisionTextRow,
} from './decision-fields';
import { genesisColumns, getProjectId } from './genesis-columns';
import { recordEmbedding, decisionEmbeddingInput } from '../../intelligence/embedding-pipeline';
import { checkWrite, type WriteSink } from './write-guard';
import { requireRecordLinks } from './record-link-write';
import { recordedExecute } from './record-changes';

/**
 * s91-m04 — extracted from the decision arm of `rbookSessionCapture` so `rbook_decisions(record)`
 * writes a decision through the SAME dedup, genesis stamp, detection and embedding as capture.
 *
 * Split into a SYNC half (lookup + INSERT, safe inside `client.transaction`) and an ASYNC half
 * (detection + embedding, which must run after the write commits). Sprint resolution stays with
 * each caller because the two resolve differently (capture: mission -> session -> active work;
 * record: mission -> explicit sprintId -> open-sprint write resolver).
 *
 * Every caller prepares the schema first and owns the transaction containing this row and links.
 */

export interface DecisionRowInput extends DecisionFieldsParams {
  readonly content: string;
  readonly now: string;
  readonly sprintId: string | null;
  /** The authoring session, or `null` when record runs with no active session. */
  readonly authorSessionId: string | null;
  readonly missionId?: string;
  readonly evidence?: ReadonlyArray<{ type: string; id: string }>;
  /** Overrides metadata.project_domain when the caller names a domain (record only). */
  readonly projectDomain?: string;
  /** s93-m06: how the operator's approval of the draft it came from is known (record only). */
  readonly approval?: {
    readonly mode: string;
    readonly draft: string;
    readonly words: string | null;
  };
}

export type DecisionRowOutcome =
  | { readonly kind: 'materialized'; readonly decisionId: number | undefined }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * The id of an identical decision already written by the same author session (NULL matches
 * NULL, so a session-less `record` retry is idempotent), or `undefined`.
 */
export function findExistingDecisionId(
  client: RbookDatabaseClient,
  content: string,
  authorSessionId: string | null,
  fields: DecisionFieldsParams = {},
  allowChangedFields = false
): number | undefined {
  const supplied = storedDecisionFields(fields);
  const names = Object.keys(supplied);
  const existing = client.getMany<{ id: number } & Record<string, unknown>>(
    `SELECT id${names.length ? `, ${names.join(', ')}` : ''} FROM strategic_decisions
     WHERE decision_text = ? AND author_session_id IS ?
     ORDER BY (status = 'active') DESC, id DESC`,
    [content, authorSessionId]
  );
  if (!existing.success)
    throw new Error(existing.error?.message ?? 'Could not compare existing decisions.');
  const rows = existing.data ?? [];
  return (
    rows.find((row) => changedDecisionFields(row, supplied).length === 0)?.id ??
    (allowChangedFields ? rows[0]?.id : undefined)
  );
}

/** Omitted fields match any value; legacy array whitespace does not make a new decision. */
export function changedDecisionFields(
  stored: Record<string, unknown>,
  supplied: Record<string, string>
): string[] {
  return Object.keys(supplied).filter((name) => {
    let original = stored[name];
    if ((name === 'alternatives' || name === 'deciders') && typeof original === 'string') {
      try {
        original = JSON.stringify(JSON.parse(original));
      } catch {
        /* Malformed legacy data differs from a supplied valid array. */
      }
    }
    return original !== supplied[name];
  });
}

/** Genesis-stamped INSERT. A rejected INSERT is recorded into `writeSink` and returned as failed. */
export function insertDecisionRow(
  client: RbookDatabaseClient,
  input: DecisionRowInput,
  writeSink: WriteSink
): DecisionRowOutcome {
  const domainResult = client.getOne<{ value: string }>(
    "SELECT value FROM metadata WHERE key = 'project_domain'",
    []
  );
  const projectDomain =
    input.projectDomain ?? (domainResult.success ? (domainResult.data?.value ?? null) : null);

  const columns = [
    'decision_text',
    'created_at',
    'sprint_id',
    'project_domain',
    'author_session_id',
  ];
  const insertParams: unknown[] = [
    input.content,
    input.now,
    input.sprintId,
    projectDomain,
    input.authorSessionId,
  ];

  if (input.missionId) {
    columns.push('mission_id');
    insertParams.push(input.missionId);
  }

  if (input.evidence && input.evidence.length > 0) {
    columns.push('evidence');
    insertParams.push(JSON.stringify(input.evidence));
  }

  for (const [column, value] of Object.entries(storedDecisionFields(input))) {
    columns.push(column);
    insertParams.push(value);
  }

  if (input.approval) {
    columns.push('approval_mode', 'approval_draft', 'approval_words');
    insertParams.push(input.approval.mode, input.approval.draft, input.approval.words);
  }

  // s69-m03 — stamp the per-row genesis columns into the dynamic list.
  const genesis = genesisColumns(client, 'strategic_decisions', getProjectId(client));
  columns.push(...genesis.columns);
  insertParams.push(...genesis.values);

  const insertColumns = columns.join(', ');
  const insertPlaceholders = columns.map(() => '?').join(', ');
  const insertResult = recordedExecute(
    client,
    `INSERT INTO strategic_decisions (${insertColumns}) VALUES (${insertPlaceholders})`,
    insertParams
  );

  if (!checkWrite(insertResult, writeSink, 'strategic_decisions.insert')) {
    return {
      kind: 'failed',
      message: `${insertResult.error?.code ?? 'DB_ERROR'}: ${insertResult.error?.message ?? 'unknown'}`,
    };
  }

  const lastId = insertResult.data?.lastInsertRowid;
  const decisionId =
    typeof lastId === 'number' ? lastId : typeof lastId === 'bigint' ? Number(lastId) : undefined;
  requireRecordLinks(client, 'decision', decisionId);
  return { kind: 'materialized', decisionId };
}

/**
 * After a committed INSERT: record the decision's embedding.
 *
 * s92-m04 retired the automatic supersession offer that used to run here. Replayed over every
 * historical capture, 69 of 9,035 offers were true, and 28-61% of real supersessions cross sprints,
 * where a same-sprint detector cannot see them (retrieval study §5, R4). A correction names what it
 * replaces at write time: rbook_decisions(action="record", supersedes=[...]).
 */
export async function followDecisionInsert(
  client: RbookDatabaseClient,
  content: string | DecisionTextRow,
  decisionId: number | undefined,
  warnings: string[]
): Promise<void> {
  // Sprint 66 m03 — write-path embedding hook
  if (decisionId !== undefined) {
    const embedResult = await recordEmbedding(client, {
      type: 'decision',
      id: decisionId,
      inputText: decisionEmbeddingInput(content),
    });
    warnings.push(...(embedResult.warnings ?? []));
  }
}
