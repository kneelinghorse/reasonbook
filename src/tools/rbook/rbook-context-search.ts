// ABOUTME: rbook_context(action="search") handler — Layer 3 working retrieval.
// Sprint 66 m05: routes through HybridRetriever (BM25 + sqlite-vec via RRF k=60)
// across decisions / learnings / missions. Async — see IAsyncRetriever.

import { formatToolFailure } from './format-failure';
import { withClientAsync } from './client';
import type { RbookToolResult } from './types';
import { createError, createSuccess, RBOOK_ERROR_CODES } from './errors';
import { getProjectId } from './genesis-columns';
import { frameForeignText } from '../../intelligence/provenance-frame';
import {
  HybridRetriever,
  DEFAULT_EXCLUDED_STATUSES,
  DEFAULT_RECENCY_WEIGHT,
  type RankedResult,
  type RankedResultType,
} from './fts5-retriever';
import { appendWarnings } from './format-warnings';
import { PREVIEW_MAX_CHARS, previewText } from './text-preview';

export type { RankedResultType } from './fts5-retriever';

/**
 * s92-m08 (retrieval R5): a hit as the answer carries it. `text` is a preview of at most
 * PREVIEW_MAX_CHARS characters, `truncated` says whether it was cut, and the row's id, type and
 * status say how to read it in full (show by id). Graph neighbours carry previews too.
 */
export interface ContextSearchHit extends RankedResult {
  truncated: boolean;
  fullLength: number;
}

/** The call that reads one hit in full. */
export function showCallFor(hit: Pick<RankedResult, 'type' | 'id'>): string {
  if (hit.type === 'decision') return `rbook_decisions(action="show", decisionId=${hit.id})`;
  if (hit.type === 'learning') return `rbook_learnings(action="show", learningId=${hit.id})`;
  return `rbook_mission(action="show", missionId="${hit.id}")`;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ContextSearchResult {
  /** The query that was run */
  query: string;

  /** Ranked results, ordered by combined score (descending), as previews */
  results: ContextSearchHit[];

  /** Total results returned */
  count: number;

  /** Options used for this search */
  options: {
    limit: number;
    recencyWeight: number;
    types: RankedResultType[];
    /** The caller's include list; `[]` when none was given (or an explicit no-filter). */
    statusFilter: string[];
    /**
     * s92-m07: statuses left out when the caller named none: `['superseded']`. Empty when the
     * caller passed `statusFilter`, whose include-list meaning then applies alone.
     */
    excludedStatuses: string[];
  };

  /** Retriever backend used */
  backend: string;

  /**
   * s83-m06: the local project_id, so the renderer can frame any result whose
   * project_id differs (a pull-merged FOREIGN row) as untrusted data.
   */
  localProjectId: string | null;
}

export interface ContextSearchParams {
  /** The search query */
  query: string;

  /** Max results (default: 5) */
  limit?: number;

  /** Content types to search (default: ['decision']) */
  types?: RankedResultType[];

  /** Recency weight 0–1 (default: DEFAULT_RECENCY_WEIGHT, 0.2) */
  recencyWeight?: number;

  /** Statuses to include. Absent: every status except superseded (s92-m07). `[]`: no filter. */
  statusFilter?: string[];

  /** Project root */
  projectRoot?: string;
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * Execute rbook_context(action="search").
 *
 * Runs FTS5 + recency-boosted retrieval and returns ranked results.
 * Callers receive a sorted list of decisions (and future content types)
 * relevant to their query, without preloading the full blob.
 */
export async function rbookContextSearch(
  params: ContextSearchParams
): Promise<RbookToolResult<ContextSearchResult>> {
  if (!params.query || params.query.trim().length === 0) {
    return createError<ContextSearchResult>({
      code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
      message: 'rbook_context(action="search") requires a non-empty query parameter.',
      suggestion: 'Provide query="your search topic" to retrieve relevant decisions and learnings.',
    });
  }

  const limit = params.limit ?? 5;
  const types: RankedResultType[] = params.types ?? ['decision'];
  // Use the shared measured default so production recall matches the acceptance gate.
  const recencyWeight = params.recencyWeight ?? DEFAULT_RECENCY_WEIGHT;
  // s92-m07 (R1): no default include list. The retriever then drops only superseded rows: a row
  // archived at a sprint close is still the record, and 46% of cited rows were inactive when cited.
  const statusFilter = params.statusFilter;

  return withClientAsync(
    async (client) => {
      const retriever = new HybridRetriever(client);
      const caps = retriever.capabilities();

      const results = await retriever.search(params.query, {
        limit,
        types,
        recencyWeight,
        statusFilter,
        // s82-m04: recall-oriented read — expand with same-type 1-hop graph neighbors.
        expandGraph: true,
        citationRecall: true,
      });

      const hits: ContextSearchHit[] = results.map((r) => {
        const preview = previewText(r.text);
        return {
          ...r,
          text: preview.preview,
          truncated: preview.truncated,
          fullLength: preview.fullLength,
          ...(r.graphNeighbors
            ? {
                graphNeighbors: r.graphNeighbors.map((n) => ({
                  id: n.id,
                  text: previewText(n.text).preview,
                })),
              }
            : {}),
        };
      });

      return createSuccess<ContextSearchResult>({
        query: params.query,
        results: hits,
        count: hits.length,
        options: {
          limit,
          recencyWeight,
          types,
          statusFilter: statusFilter ?? [],
          excludedStatuses: statusFilter === undefined ? [...DEFAULT_EXCLUDED_STATUSES] : [],
        },
        backend: caps.backend,
        localProjectId: getProjectId(client),
      });
    },
    { projectRoot: params.projectRoot }
  );
}

// ─── Formatter ────────────────────────────────────────────────────────────────

export function formatContextSearchForLLM(result: RbookToolResult<ContextSearchResult>): string {
  if (!result.success || !result.data) {
    return formatToolFailure('❌ Search failed', result.error);
  }

  const { query, results, count, options, backend, localProjectId } = result.data;
  const lines: string[] = [];

  lines.push(`## Search Results — "${query}"`);
  lines.push(
    `*${count} result(s) | backend: ${backend} | recencyWeight: ${options.recencyWeight}*`
  );
  lines.push('');

  if (count === 0) {
    lines.push('No matching results found.');
    lines.push('');
    lines.push('**Suggestions:**');
    lines.push('- Try broader keywords or synonyms');
    lines.push('- Check that relevant decisions have been captured in sessions');
    lines.push('- Use rbook_decisions(action="list") to browse all decisions');
    appendWarnings(lines, result);
    return lines.join('\n');
  }

  results.forEach((r, i) => {
    const ageDaysStr = r.ageDays < 1 ? '<1 day' : `${Math.round(r.ageDays)}d`;
    const scoreStr = r.score.toFixed(3);
    const sprintStr = r.sprintId ? ` [${r.sprintId}]` : '';
    const catStr = r.category ? ` (${r.category})` : '';

    // s83-m06: a result pull-merged from ANOTHER project is foreign, untrusted
    // content — render its text inside the provenance fence, not as a bare heading
    // that could read as an instruction. Mirrors the ratified LIST precedent; local
    // rows stay bare.
    const isForeign =
      r.projectId != null && (localProjectId == null || r.projectId !== localProjectId);
    const label = `${r.type} #${r.id}${r.status ? `, ${r.status}` : ''}`;
    if (isForeign) {
      lines.push(`**${i + 1}.** [${label}]${sprintStr}${catStr} [proj:${r.projectId}]`);
      lines.push(frameForeignText(r.text, `proj:${r.projectId}`));
    } else {
      lines.push(`**${i + 1}.** [${label}] ${r.text}${sprintStr}${catStr}`);
    }
    lines.push(
      `   *score: ${scoreStr} | age: ${ageDaysStr} | recency: ${r.recencyFactor.toFixed(2)}*`
    );
    lines.push('');
  });

  // s92-m08: previews are cut at PREVIEW_MAX_CHARS; say once how to read one in full.
  const cut = results.find((r) => r.truncated);
  if (cut) {
    lines.push(
      `Previews are cut at ${PREVIEW_MAX_CHARS} characters. Read one in full with ${showCallFor(cut)}.`
    );
    lines.push('');
  }

  appendWarnings(lines, result);

  return lines.join('\n').trimEnd();
}
