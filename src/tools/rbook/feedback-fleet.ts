// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read registered feedback stores through the canonical fan-out, without migrations or writes.
// ABOUTME: Full filtered counts accompany capped rows; incomplete coverage stays explicit in lists and digests.

import { queryAcrossStores, type CrossStoreRow } from '../../intelligence/cross-store-query';
import { listRegisteredStoresReadOnly } from '../../intelligence/registered-stores-readonly';
import {
  foreignDescriptor,
  frameForeignText,
  provenanceTag,
} from '../../intelligence/provenance-frame';
import type {
  AgentFeedbackEntry,
  FeedbackRowKind,
  RbookFeedbackListResult,
} from './rbook-feedback';
import type { AgentFeedbackStatus } from './schema-migrations';
import { classifyFeedback, countFeedbackKinds } from '../../signals/feedback-kinds';

export interface FeedbackStoreCount {
  readonly projectId: string;
  readonly totalCount: number | null;
  readonly state: 'read' | 'absent' | 'unavailable';
  readonly error?: string;
}
export interface FeedbackFleetCoverage {
  readonly complete: boolean;
  readonly stores: readonly FeedbackStoreCount[];
}
interface FeedbackCounts {
  totalCount: number;
  countsByTool: Record<string, number>;
  countsByStatus: Record<string, number>;
  /** s97-m07: the store's matching rows by kind; absent from a count-only read. */
  countsByKind?: Record<FeedbackRowKind, number>;
  absent: boolean;
}
interface FeedbackQueryRow extends CrossStoreRow {
  id: number;
  toolName: string;
  body: string;
  status: AgentFeedbackStatus;
  sessionId: string | null;
  sprintId: string | null;
  missionId: string | null;
  projectId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  /** s97-m07: classified from the stored text, before any framing. */
  kind: FeedbackRowKind;
}

/**
 * Counts by kind as one flat record, unclassified beside every kind. It lives here, not in
 * rbook-feedback.ts: the session-start digest reads this module, and a value import from the tool
 * would load zod at every start (tests/e2e/hook-cli.e2e.ts).
 */
export function kindCounts(
  texts: Iterable<string | null | undefined>
): Record<FeedbackRowKind, number> {
  const { counts, unclassified } = countFeedbackKinds(texts);
  return { ...counts, unclassified };
}

export interface FeedbackFleetOptions {
  readonly status?: AgentFeedbackStatus;
  readonly toolName?: string;
  readonly limit?: number;
  readonly countOnly?: boolean;
  readonly deadlineAtMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/** No de-duplication or subject filter: every matching row in each active registered store counts. */
export async function readFeedbackFleet(
  options: FeedbackFleetOptions = {}
): Promise<RbookFeedbackListResult> {
  const stores = listRegisteredStoresReadOnly(options.env);
  const limit = options.limit ?? 50;
  const counts = new Map<string, FeedbackCounts>();
  const result = await queryAcrossStores<FeedbackQueryRow>({
    sql: '',
    stores,
    limit,
    timeoutMs: 0,
    deadlineAtMs: options.deadlineAtMs,
    perStoreQuery: (db, store, cap) =>
      db.transaction(() => {
        const columns = new Set(
          (db.prepare('PRAGMA table_info(agent_feedback)').all() as Array<{ name: string }>).map(
            (row) => row.name
          )
        );
        if (!columns.size) {
          counts.set(store.project_id, {
            totalCount: 0,
            countsByTool: {},
            countsByStatus: {},
            absent: true,
          });
          return [];
        }
        const values: unknown[] = [options.status ?? 'open'];
        let where = 'WHERE status = ?';
        if (options.toolName) {
          where += ' AND tool_name = ?';
          values.push(options.toolName);
        }
        const total = db
          .prepare(`SELECT COUNT(*) AS n FROM agent_feedback ${where}`)
          .get(...values) as { n: number };
        const byTool = db
          .prepare(
            `SELECT tool_name AS key, COUNT(*) AS n FROM agent_feedback ${where} GROUP BY tool_name`
          )
          .all(...values) as Array<{ key: string; n: number }>;
        const byStatus = db
          .prepare(
            `SELECT status AS key, COUNT(*) AS n FROM agent_feedback ${options.toolName ? 'WHERE tool_name = ?' : ''} GROUP BY status`
          )
          .all(...(options.toolName ? [options.toolName] : [])) as Array<{
          key: string;
          n: number;
        }>;
        // Core fields are required; optional historical context columns can be absent or NULL.
        for (const name of ['id', 'body', 'created_at'])
          if (!columns.has(name)) throw new Error(`agent_feedback lacks ${name}`);
        const optional = (name: string): string => (columns.has(name) ? name : 'NULL');
        // s97-m07: the kinds read every matching row's own text; the count-only digest reads none.
        const byKind = options.countOnly
          ? undefined
          : kindCounts(
              (
                db.prepare(`SELECT body FROM agent_feedback ${where}`).all(...values) as Array<{
                  body: string | null;
                }>
              ).map((row) => row.body)
            );
        const rows = options.countOnly
          ? []
          : (
              db
                .prepare(
                  `SELECT id, tool_name AS toolName, body, status,
        ${optional('session_id')} AS sessionId, ${optional('sprint_id')} AS sprintId,
        ${optional('mission_id')} AS missionId, ${optional('project_id')} AS projectId,
        created_at AS createdAt, ${optional('resolved_at')} AS resolvedAt,
        ${optional('resolution_note')} AS resolutionNote,
        COALESCE(ROUND((julianday(created_at)-2440587.5)*86400000),0) AS occurred_at,
        id AS origin_seq, ? AS project_id FROM agent_feedback ${where}
        ORDER BY occurred_at DESC,id DESC LIMIT ?`
                )
                .all(store.project_id, ...values, cap) as FeedbackQueryRow[]
            ).map((row) => ({ ...row, kind: classifyFeedback(row.body).kind }));
        counts.set(store.project_id, {
          totalCount: total.n,
          countsByTool: Object.fromEntries(byTool.map((row) => [row.key, row.n])),
          countsByStatus: Object.fromEntries(byStatus.map((row) => [row.key, row.n])),
          ...(byKind ? { countsByKind: byKind } : {}),
          absent: false,
        });
        return rows;
      })(),
  });
  const errors = new Map(result.errors.map((error) => [error.projectId, error.error]));
  const coverage: FeedbackStoreCount[] = [];
  const countsByTool: Record<string, number> = Object.create(null);
  const countsByStatus: Record<string, number> = Object.create(null);
  // s97-m07: summed only from stores that were read; an unavailable store's rows are not zero.
  const countsByKind = options.countOnly ? undefined : kindCounts([]);
  let totalCount = 0;
  for (const store of stores) {
    const error = errors.get(store.project_id);
    const count = counts.get(store.project_id);
    if (error || !count) {
      coverage.push({
        projectId: store.project_id,
        totalCount: null,
        state: 'unavailable',
        error: error ?? 'No count returned',
      });
      continue;
    }
    totalCount += count.totalCount;
    coverage.push({
      projectId: store.project_id,
      totalCount: count.totalCount,
      state: count.absent ? 'absent' : 'read',
    });
    for (const [key, n] of Object.entries(count.countsByTool))
      countsByTool[key] = (countsByTool[key] ?? 0) + n;
    for (const [key, n] of Object.entries(count.countsByStatus))
      countsByStatus[key] = (countsByStatus[key] ?? 0) + n;
    if (countsByKind && count.countsByKind)
      for (const [key, n] of Object.entries(count.countsByKind) as Array<[FeedbackRowKind, number]>)
        countsByKind[key] += n;
  }
  const entries: AgentFeedbackEntry[] = result.results.map(
    ({ occurred_at: _time, origin_seq: _seq, project_id: source, ...entry }) => ({
      ...entry,
      body: frameForeignText(entry.body, provenanceTag(source)),
      toolName: frameForeignText(entry.toolName, provenanceTag(source)),
      resolutionNote:
        entry.resolutionNote === null
          ? null
          : frameForeignText(entry.resolutionNote, provenanceTag(source)),
      sourceProjectId: source,
      provenance: foreignDescriptor(provenanceTag(source)),
    })
  );
  return {
    entries,
    totalCount,
    countsByTool,
    countsByStatus,
    ...(countsByKind ? { countsByKind } : {}),
    limit,
    fleet: { complete: errors.size === 0, stores: coverage },
  };
}

/** Section 8 has 100 characters; uncertainty is retained before any count or optional detail. */
export async function feedbackDigestLine(
  env: NodeJS.ProcessEnv = process.env,
  deadlineAtMs = Infinity
): Promise<string | null> {
  if (Date.now() >= deadlineAtMs) return 'Fleet feedback unavailable: hook deadline reached.';
  try {
    const result = await readFeedbackFleet({
      countOnly: true,
      deadlineAtMs: Math.min(Date.now() + 100, deadlineAtMs),
      env,
    });
    const coverage = result.fleet!;
    if (!coverage.stores.length) return null;
    if (!coverage.complete)
      return 'Fleet feedback: coverage incomplete. rbook_feedback list acrossProjects=true';
    const read = coverage.stores.filter((store) => store.state !== 'unavailable').length;
    const line = `Fleet feedback: ${result.totalCount} open; ${read}/${coverage.stores.length} stores.`;
    const action = ' rbook_feedback list acrossProjects=true';
    return line.length + action.length <= 100 ? line + action : line;
  } catch {
    return 'Fleet feedback unavailable: registry unreadable. rbook_feedback list acrossProjects=true';
  }
}
