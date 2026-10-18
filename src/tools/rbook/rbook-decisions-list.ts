/**
 * rbook_decisions_list Tool
 *
 * MCP tool for listing strategic decisions from the Reasonbook database.
 * Supports filtering by domain, sprint, and date range with pagination.
 *
 * @module tools/rbook/rbook-decisions-list
 */

import { spinOutQuery } from '../../intelligence/spin-out-query';
import { withClient } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess } from './errors';
import { readTimeBounds } from './stored-time';
import { loadUnifiedDecisionRecords, type DecisionSource } from './decision-memory';
import { getProjectId } from './genesis-columns';
import { frameForeignText } from '../../intelligence/provenance-frame';
import {
  queryAcrossStores,
  type CrossStoreError,
  type CrossStoreQueryResult,
  type CrossStoreRow,
} from '../../intelligence/cross-store-query';
import { appendWarnings } from './format-warnings';
import { PREVIEW_MAX_CHARS, previewText } from './text-preview';

/**
 * Decision record surfaced to clients.
 */
export interface StrategicDecision {
  /** Decision ID */
  id: number;

  /**
   * s93-m11 (#602): a preview of the decision, at most PREVIEW_MAX_CHARS characters; read it in
   * full with rbook_decisions(action="show", decisionId).
   */
  decision: string;

  /** Whether `decision` was cut. */
  truncated: boolean;

  /** Characters in the full decision text. */
  fullLength: number;

  /** Domain (e.g., 'ai-studio', 'general') */
  domain: string | null;

  /** Associated sprint ID */
  sprintId: string | null;

  /** Associated snapshot ID */
  snapshotId: number | null;

  /** Associated mission ID */
  missionId: string | null;

  /** When the decision was recorded */
  createdAt: string;

  /** Where this decision was sourced from */
  source: DecisionSource;

  /** Decision category (architectural, process, tooling, design, business) */
  category: string | null;

  /** Decision status (active, superseded, archived) */
  status: string | null;

  /** ID of decision that supersedes this one */
  supersededBy: number | null;

  /** JSON array of TraceLab evidence references */
  evidence: string | null;

  /** s69-m06: source project_id — present ONLY on cross-store (acrossProjects) results. */
  projectId?: string | null;

  /**
   * s96-m02 (ADR s96 §10): who wrote it, or "before authors were recorded" / "author not
   * recorded". Absent on the portfolio list, which reads only the columns every store holds.
   */
  author?: string;
}

/** s93-m11 (#602): the list carries a preview of each decision, never the full body. */
function decisionPreview(
  text: string
): Pick<StrategicDecision, 'decision' | 'truncated' | 'fullLength'> {
  const { preview, truncated, fullLength } = previewText(text);
  return { decision: preview, truncated, fullLength };
}

/**
 * Result of decisions list operation.
 */
export interface RbookDecisionsListResult {
  /** List of decisions */
  decisions: StrategicDecision[];

  /** Total count (for pagination) */
  totalCount: number;

  /** Current page */
  page: number;

  /** Page size used */
  pageSize: number;

  /** Whether there are more results */
  hasMore: boolean;

  /** s69-m06: true when results were fanned out across the project portfolio. */
  acrossProjects?: boolean;

  /** s69-m06: per-store failures (isolated) — present only on the cross-store path. */
  errors?: CrossStoreError[];

  /** s69-m06: fan-out instrumentation — present only on the cross-store path. */
  crossStoreMetadata?: CrossStoreQueryResult['metadata'];

  /** s78-m05: the querying store's own project_id. Rows whose projectId differs are
   *  foreign (pull-merged or cross-store) and are framed as untrusted in the render. */
  localProjectId?: string | null;
}

/**
 * Input parameters for rbook_decisions_list tool.
 */
export interface RbookDecisionsListParams {
  /** Optional: filter by project domain */
  domain?: string;

  /** Optional: filter by sprint ID */
  sprintId?: string;

  /** s85-m04: filter to rows stamped with this mission (#487 read surface) */
  missionId?: string;

  /** Optional: filter by date range start (ISO format) */
  since?: string;

  /** Optional: filter by date range end (ISO format) */
  until?: string;

  /** Optional: page number (1-indexed, default: 1) */
  page?: number;

  /** Optional: results per page (1-100, default: 20) */
  pageSize?: number;

  /** Optional: explicit project root to search from */
  projectRoot?: string;

  /**
   * s69-m06: when true, fan out across ALL projects in the project-graph registry
   * (newest-first by the per-row schema keys) instead of querying the single
   * current store. Each returned decision carries its source `projectId`. Chose
   * the recency-ordered `list` action (not FTS5 `search`) for the cross-store hook
   * because the merge key is `(occurred_at, origin_seq, project_id)`, not relevance.
   *
   * Two deliberate divergences from the single-store path (documented, not bugs):
   * - **No offset pagination.** This returns a single bounded top-`pageSize` page;
   *   `page` is ignored (cursor pagination across the k-way merge is a follow-up).
   *   `hasMore` still signals there is more — widen `pageSize` rather than paging.
   * - **`sprintId`/`domain` filter the RAW columns**, not the single-store path's
   *   `effective_sprint_id` (which COALESCEs in the decision's mission/session
   *   sprint). A decision with NULL `sprint_id` whose sprint is only inherited via
   *   its mission/session is NOT matched here. Kept raw on purpose: a cross-store
   *   JOIN to missions/sessions would error-and-DROP any un-migrated/foreign store
   *   (worse than the narrow divergence, which the capture path normally avoids by
   *   persisting `sprint_id` at write time).
   */
  acrossProjects?: boolean;
}

/**
 * MCP Tool Definition for rbook_decisions_list.
 */
export const rbookDecisionsListToolDefinition = {
  name: 'rbook_decisions_list',
  description:
    'List strategic decisions from the Reasonbook database. Supports filtering by domain, sprint ID, and date range. Returns paginated results sorted by most recent first.',
  inputSchema: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        description: 'Filter by project domain (e.g., "ai-studio", "general")',
      },
      sprintId: {
        type: 'string',
        description: 'Filter by sprint ID (e.g., "sprint-14")',
      },
      since: {
        type: 'string',
        description: 'Filter decisions created after this ISO date (e.g., "2024-01-01")',
      },
      until: {
        type: 'string',
        description: 'Filter decisions created before this ISO date',
      },
      page: {
        type: 'number',
        minimum: 1,
        description: 'Page number (1-indexed, default: 1)',
      },
      pageSize: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        description: 'Results per page (1-100, default: 20)',
      },
      projectRoot: {
        type: 'string',
        description: 'Project root directory to search for Reasonbook database (defaults to cwd)',
      },
      acrossProjects: {
        type: 'boolean',
        description:
          'Fan out across ALL registered projects (newest-first), each result tagged with its source projectId. Cross-store portfolio view.',
      },
    },
    additionalProperties: false,
  },
} as const;

/**
 * Execute the rbook_decisions_list tool.
 *
 * Retrieves strategic decisions from the database with optional filtering.
 *
 * @param params - Tool parameters
 * @returns RbookToolResult with decisions list
 */
export async function rbookDecisionsList(
  requested: RbookDecisionsListParams = {}
): Promise<RbookToolResult<RbookDecisionsListResult>> {
  // s93-m11: since/until compare as times; a year or a month covers its period, and a bound no
  // stored time can be compared with is refused rather than matching nothing.
  const bounds = readTimeBounds(requested);
  if ('error' in bounds) return createError<RbookDecisionsListResult>(bounds.error);
  const params: RbookDecisionsListParams = { ...requested, ...bounds };

  // s69-m06 — cross-store fan-out path: discover stores via the project-graph
  // registry and merge decisions newest-first across the whole portfolio. Bypasses
  // the single-store withClient path entirely.
  if (params.acrossProjects) {
    return listAcrossProjects(params);
  }

  const page = params.page ?? 1;
  const pageSize = params.pageSize ?? 20;
  const offset = (page - 1) * pageSize;

  return withClient(
    (client) => {
      const allDecisions = loadUnifiedDecisionRecords(client, {
        domain: params.domain,
        sprintId: params.sprintId,
        // s85-m04: the LOCAL path filters here, not in the cross-store builder below. Adding
        // the predicate to only one of the two branches is exactly the invisible half-fix the
        // round-trip acceptance test exists to catch — and did catch, on the first run.
        missionId: params.missionId,
        since: params.since,
        until: params.until,
      });
      const totalCount = allDecisions.length;
      const decisions: StrategicDecision[] = allDecisions
        .slice(offset, offset + pageSize)
        .map((row) => ({
          id: row.id,
          ...decisionPreview(row.decision),
          domain: row.domain,
          sprintId: row.sprintId,
          snapshotId: row.snapshotId,
          missionId: row.missionId,
          createdAt: row.createdAt,
          source: row.source,
          category: row.category,
          status: row.status,
          supersededBy: row.supersededBy,
          evidence: row.evidence,
          projectId: row.projectId,
          author: row.author,
        }));

      return createSuccess<RbookDecisionsListResult>({
        decisions,
        totalCount,
        page,
        pageSize,
        hasMore: offset + decisions.length < totalCount,
        localProjectId: getProjectId(client),
      });
    },
    { projectRoot: params.projectRoot }
  );
}

interface CrossStoreDecisionRow extends CrossStoreRow {
  id: number;
  decision_text: string;
  project_domain: string | null;
  sprint_id: string | null;
  mission_id: string | null;
  category: string | null;
  status: string | null;
  evidence: string | null;
  created_at: string;
}

/**
 * Cross-store decisions list (s69-m06). Builds a parameterized SELECT honoring the
 * same domain/sprint/date filters, fans it out via {@link queryAcrossStores}
 * (newest-first), and maps each row to a {@link StrategicDecision} carrying its
 * source `projectId`. Per-store failures + fan-out instrumentation ride along on
 * the result.
 */
async function listAcrossProjects(
  params: RbookDecisionsListParams
): Promise<RbookToolResult<RbookDecisionsListResult>> {
  const pageSize = params.pageSize ?? 20;

  const conditions = [`event_type = 'decision_captured'`];
  const sqlParams: unknown[] = [];
  if (params.domain) {
    conditions.push('project_domain = ?');
    sqlParams.push(params.domain);
  }
  if (params.sprintId) {
    conditions.push('sprint_id = ?');
    sqlParams.push(params.sprintId);
  }
  // s85-m04 (#487): make the mission -> row trail queryable. Rows with a NULL mission_id are
  // EXCLUDED by this predicate rather than erroring — the ~342 historical unstamped decisions
  // simply do not match, which is the correct answer to "what did mission X decide?".
  if (params.missionId) {
    conditions.push('mission_id = ?');
    sqlParams.push(params.missionId);
  }
  if (params.since) {
    conditions.push('julianday(created_at) >= julianday(?)');
    sqlParams.push(params.since);
  }
  if (params.until) {
    conditions.push('julianday(created_at) <= julianday(?)');
    sqlParams.push(params.until);
  }

  const sql = `SELECT project_id, id, decision_text, project_domain, sprint_id, mission_id,
                 category, status, evidence, created_at, occurred_at, origin_seq
          FROM strategic_decisions
          WHERE ${conditions.join(' AND ')}`;
  const fanout = await queryAcrossStores<CrossStoreDecisionRow>({
    sql,
    perStoreQuery: spinOutQuery('decision', sql, sqlParams),
    params: sqlParams,
    order: 'desc',
    limit: pageSize,
  });

  const decisions: StrategicDecision[] = fanout.results.map((row) => ({
    id: row.id,
    ...decisionPreview(row.decision_text),
    domain: row.project_domain,
    sprintId: row.sprint_id,
    snapshotId: null,
    missionId: row.mission_id,
    createdAt: row.created_at,
    source: 'strategic' as DecisionSource,
    category: row.category,
    status: row.status,
    supersededBy: null,
    evidence: row.evidence,
    projectId: row.project_id,
  }));

  return createSuccess<RbookDecisionsListResult>({
    decisions,
    totalCount: decisions.length,
    page: 1,
    pageSize,
    hasMore: fanout.metadata.truncated,
    acrossProjects: true,
    errors: fanout.errors,
    crossStoreMetadata: fanout.metadata,
  });
}

/**
 * Format decisions list result for LLM readability.
 *
 * @param result - Decisions list result
 * @returns Human-readable summary
 */
export function formatDecisionsListForLLM(
  result: RbookToolResult<RbookDecisionsListResult>
): string {
  if (!result.success || !result.data) {
    const error = result.error;
    return [
      '❌ Failed to retrieve decisions',
      '',
      `Error: ${error?.message ?? 'Unknown error'}`,
      error?.suggestion ? `Suggestion: ${error.suggestion}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const data = result.data;
  const lines: string[] = [];

  // Header
  lines.push(
    data.acrossProjects ? '🌐 **Strategic Decisions (portfolio)**' : '📝 **Strategic Decisions**'
  );
  lines.push('');
  if (data.acrossProjects && data.crossStoreMetadata) {
    const m = data.crossStoreMetadata;
    lines.push(
      `Across ${m.storesSucceeded}/${m.storesQueried} project(s)` +
        (m.storesFailed > 0 ? ` (${m.storesFailed} unreadable)` : '') +
        ` — ${data.decisions.length} decisions, fan-in ${m.overallMs}ms`
    );
  } else {
    lines.push(
      `Showing ${data.decisions.length} of ${data.totalCount} decisions (page ${data.page})`
    );
  }
  lines.push('');

  if (data.decisions.length === 0) {
    lines.push('No decisions found matching the criteria.');
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  // List decisions
  for (const d of data.decisions) {
    const project = d.projectId ? ` [proj:${d.projectId}]` : '';
    const domain = d.domain ? ` [${d.domain}]` : '';
    const sprint = d.sprintId ? ` (${d.sprintId})` : '';
    const mission = d.missionId ? ` {${d.missionId}}` : '';
    const source = d.source === 'session_capture' ? ' [session capture]' : '';
    const category = d.category ? ` <${d.category}>` : '';
    const status = d.status && d.status !== 'active' ? ` [${d.status}]` : '';
    const author = d.author ? ` — ${d.author}` : '';
    const meta = `${project}${domain}${sprint}${mission}${category}${status}${source}${author}`;
    // s78-m05: a decision from another project (pull-merged or cross-store) is foreign,
    // non-locally-authored content — frame its text as untrusted DATA rather than emitting it
    // as a bare bullet. localProjectId absent (portfolio view) → treat every tagged row as foreign.
    const isForeign =
      d.projectId != null && (data.localProjectId == null || d.projectId !== data.localProjectId);
    if (isForeign) {
      lines.push(`• #${d.id}${meta}`);
      lines.push(frameForeignText(d.decision, `proj:${d.projectId}`));
    } else {
      lines.push(`• #${d.id} ${d.decision}${meta}`);
    }
    lines.push(`  Created: ${d.createdAt}`);
    lines.push('');
  }

  // s93-m11 (#602): previews are cut at PREVIEW_MAX_CHARS; say once how to read one in full. An
  // id from another project names a row in THAT store, so a foreign row is never offered to a
  // local show (the contract critic: a portfolio list pointed show at another store's id).
  const foreign = (d: StrategicDecision): boolean =>
    d.projectId != null && (data.localProjectId == null || d.projectId !== data.localProjectId);
  const cut = data.decisions.find((d) => d.truncated && !foreign(d));
  if (cut) {
    lines.push(
      `Previews are cut at ${PREVIEW_MAX_CHARS} characters. Read one in full with ` +
        `rbook_decisions(action="show", decisionId=${cut.id}).`
    );
  } else if (data.decisions.some((d) => d.truncated)) {
    lines.push(
      `Previews are cut at ${PREVIEW_MAX_CHARS} characters. A row tagged proj:… reads in full ` +
        'with rbook_decisions(action="show") in that project, with its projectRoot: the id is that project\'s.'
    );
  }

  // Pagination info. The cross-store path returns a single bounded top-N page (no
  // offset/cursor — see listAcrossProjects), so do NOT advertise a `page=N+1` that
  // would silently re-return the same rows; tell the operator to widen pageSize.
  if (data.hasMore) {
    lines.push(
      data.acrossProjects
        ? 'More results available — this is a bounded top-N portfolio view; increase pageSize to see more.'
        : `More results available. Use page=${data.page + 1} to see next page.`
    );
  }

  appendWarnings(lines, result);

  return lines.join('\n');
}
