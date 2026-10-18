// SPDX-License-Identifier: Apache-2.0
// ABOUTME: After a merge, this copy's derived data follows the record (ADR s96 §5): its resume note and working memory
// ABOUTME: name each session another copy closed, once; citation links are repaired; merged rows are embedded.

import {
  decisionEmbeddingInput,
  learningEmbeddingInput,
  missionEmbeddingInput,
  recordEmbedding,
} from '../../intelligence/embedding-pipeline';
import type { RbookDatabaseClient } from './client';
import { decisionTextProjection, type DecisionTextRow } from './decision-fields';
import { aggregateSessionIntoContexts, type CaptureItem } from './rbook-session-complete';
import { inspectRecordLinkSchema } from './record-link-schema';
import { repairRecordLinksBatch } from './record-links';
import type { LoggedChange } from './record-standing';
import { isPeerSession } from './peer-sessions';
import { syncSprintTracking } from './sprint-tracking';
import type { WriteFailure } from './write-guard';

interface ClosedSession {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly sprint_id: string | null;
  readonly captures: string | null;
  readonly summary: string | null;
  readonly completed_at: string;
  readonly agent: string | null;
  readonly next_steps: string | null;
  readonly owner_key: string | null;
}

function rows<T>(client: RbookDatabaseClient, sql: string, params: unknown[] = []): T[] {
  const read = client.getMany<T>(sql, params);
  if (!read.success) throw new Error(read.error?.message ?? `could not read: ${sql}`);
  return read.data ?? [];
}

const parsedArray = (text: string | null): unknown[] => {
  try {
    const parsed: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

/** The sessions this copy's working memory already holds, so a change delivered twice folds once. */
function foldedSessions(client: RbookDatabaseClient): Set<string> {
  const [row] = rows<{ content: string }>(
    client,
    "SELECT content FROM contexts WHERE id = 'project_context'"
  );
  try {
    const content = JSON.parse(row?.content ?? '{}') as {
      working_memory?: { session_history?: Array<{ session?: unknown }> };
    };
    return new Set(
      (content.working_memory?.session_history ?? []).map((entry) => String(entry.session))
    );
  } catch {
    return new Set();
  }
}

/**
 * Fold each session another copy closed, among the changes this merge stored, into this copy's
 * project and master contexts. The contexts are this copy's own, so nothing here is recorded.
 */
export function foldPeerSessions(
  client: RbookDatabaseClient,
  stored: readonly LoggedChange[]
): { folded: string[]; failures: WriteFailure[] } {
  const closed = new Set(
    stored
      .filter(
        (change) =>
          change.entity === 'sessions' &&
          ((change.field === 'status' && change.value === '"completed"') ||
            (change.kind === 'create' &&
              (JSON.parse(change.value ?? '{}') as { status?: unknown }).status === 'completed'))
      )
      .map((change) => String(change.entity_id))
  );
  const sink = { failures: [] as WriteFailure[] };
  const folded: string[] = [];
  if (!closed.size) return { folded, failures: sink.failures };
  const already = foldedSessions(client);
  for (const session of rows<ClosedSession>(
    client,
    `SELECT id, type, title, sprint_id, captures, summary, completed_at, agent, next_steps, owner_key
       FROM sessions WHERE status = 'completed' AND stable_event_id IN (${[...closed].map(() => '?').join(', ')})
      ORDER BY julianday(completed_at), id`,
    [...closed]
  )) {
    if (!isPeerSession(session.owner_key) || already.has(session.id)) continue;
    const nextSteps = parsedArray(session.next_steps).map(String);
    aggregateSessionIntoContexts(
      client,
      {
        sessionId: session.id,
        sprintId: session.sprint_id,
        sessionType: session.type,
        sessionTitle: session.title,
        captures: parsedArray(session.captures) as CaptureItem[],
        summary: session.summary ?? '',
        completedAt: session.completed_at,
        agent: session.agent ?? '',
        nextSteps: nextSteps.length ? nextSteps : null,
      },
      sink
    );
    folded.push(session.id);
  }
  return { folded, failures: sink.failures };
}

/** The local ids of the rows of `table` that these changes name and this copy now holds. */
function mergedIds<T extends number | string>(
  client: RbookDatabaseClient,
  table: 'strategic_decisions' | 'learnings' | 'missions',
  changes: readonly LoggedChange[]
): T[] {
  const stable = [
    ...new Set(changes.filter((change) => change.entity === table).map((c) => c.entity_id)),
  ];
  if (!stable.length) return [];
  return rows<{ id: T }>(
    client,
    `SELECT id FROM ${table} WHERE stable_event_id IN (${stable.map(() => '?').join(', ')}) ORDER BY id`,
    stable
  ).map((row) => row.id);
}

/**
 * Repair the citation links the merged decisions and learnings make or meet, in the merge's own
 * transaction, as a pull's repair does. A store whose link table is not ready reads typed citations
 * from the text instead, so there is nothing to repair.
 */
export function repairMergedLinks(
  client: RbookDatabaseClient,
  stored: readonly LoggedChange[]
): string[] {
  const records = [
    ...mergedIds<number>(client, 'strategic_decisions', stored).map((id) => ({
      kind: 'decision' as const,
      id,
    })),
    ...mergedIds<number>(client, 'learnings', stored).map((id) => ({
      kind: 'learning' as const,
      id,
    })),
  ];
  if (!records.length || inspectRecordLinkSchema(client).marker !== '1') return [];
  const repaired = repairRecordLinksBatch(client, records);
  return repaired.success ? [] : [`citation links: ${repaired.error?.message}`];
}

/**
 * Embed the decisions, learnings and missions a merge wrote, after its transaction commits, since
 * embedding is asynchronous; an unchanged text is skipped by its hash. The sync runs this (s96-m13).
 */
export async function embedMergedRows(
  client: RbookDatabaseClient,
  changes: readonly LoggedChange[]
): Promise<{ embedded: number; warnings: string[] }> {
  const warnings: string[] = [];
  let embedded = 0;
  const embed = async (target: Parameters<typeof recordEmbedding>[1]): Promise<void> => {
    const result = await recordEmbedding(client, target);
    warnings.push(...(result.warnings ?? []));
    if (result.action === 'embedded') embedded += 1;
    if (result.action === 'failed')
      warnings.push(`${target.type} ${target.id} was not embedded: ${result.error}`);
  };
  const columns = new Set(
    rows<{ name: string }>(client, "SELECT name FROM pragma_table_info('strategic_decisions')").map(
      (row) => row.name
    )
  );
  for (const id of mergedIds<number>(client, 'strategic_decisions', changes)) {
    const [row] = rows<DecisionTextRow>(
      client,
      `SELECT decision_text, ${decisionTextProjection(columns)} FROM strategic_decisions WHERE id = ?`,
      [id]
    );
    if (row) await embed({ type: 'decision', id, inputText: decisionEmbeddingInput(row) });
  }
  for (const id of mergedIds<number>(client, 'learnings', changes)) {
    const [row] = rows<{ content: string }>(client, 'SELECT content FROM learnings WHERE id = ?', [
      id,
    ]);
    if (row) await embed({ type: 'learning', id, inputText: learningEmbeddingInput(row.content) });
  }
  for (const id of mergedIds<string>(client, 'missions', changes)) {
    const [row] = rows<{
      name: string;
      objective: string | null;
      notes: string | null;
      success_criteria: string | null;
    }>(client, 'SELECT name, objective, notes, success_criteria FROM missions WHERE id = ?', [id]);
    if (!row) continue;
    const criteria = parsedArray(row.success_criteria).filter(
      (item): item is string => typeof item === 'string'
    );
    await embed({
      type: 'mission',
      id,
      inputText: missionEmbeddingInput({
        name: row.name,
        objective: row.objective,
        notes: row.notes,
        successCriteria: criteria.length ? criteria : null,
      }),
    });
  }
  return { embedded, warnings };
}

/**
 * Keep this copy's sprint pointers in step with the merged record (s91-m07's master_context
 * sprint_tracking), when the merge made a sprint or changed one's status: the open sprint, and the
 * sprint whose close is the latest live one in the log. Returns what could not be written.
 */
export function trackMergedSprints(
  client: RbookDatabaseClient,
  live: readonly LoggedChange[]
): string[] {
  if (
    !live.some(
      (change) =>
        change.entity === 'sprints' && (change.kind === 'create' || change.field === 'status')
    )
  )
    return [];
  const [closed] = rows<{ id: string }>(
    client,
    `SELECT s.id FROM record_changes c JOIN sprints s ON s.stable_event_id = c.entity_id
      WHERE c.entity = 'sprints' AND c.field = 'status' AND c.value = '"Completed"'
        AND UPPER(s.status) = 'COMPLETED' AND c.txn_id NOT IN (SELECT txn_id FROM record_txn_state)
      ORDER BY c.hlc DESC, c.change_id DESC LIMIT 1`
  );
  const warnings: string[] = [];
  syncSprintTracking(client, warnings, closed?.id);
  return warnings;
}
