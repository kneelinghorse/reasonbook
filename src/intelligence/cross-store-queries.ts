// ABOUTME: Sprint 69 m06 — the four named Reasonbook portfolio queries (s68 ADR Section 5.4).
// ABOUTME: Example consumers of queryAcrossStores, each carrying per-project source attribution.

/**
 * Worked implementations of the four named cross-store queries from s68 ADR
 * Section 5.4, built on {@link queryAcrossStores}. Each row carries `project_id`
 * source attribution. These double as the end-to-end exercise of the fan-out API
 * and as ready-made building blocks for the `rbook_decisions(acrossProjects)`
 * integration and any future `rbook_portfolio` surface.
 *
 * @module intelligence/cross-store-queries
 */

import { spinOutQuery } from './spin-out-query';
import {
  queryAcrossStores,
  type CrossStoreQueryResult,
  type CrossStoreRow,
  type CrossStoreQueryOptions,
  type CrossStoreProbeValue,
} from './cross-store-query';

/** Pass-through knobs every named query forwards to queryAcrossStores. */
type NamedQueryOpts = Pick<
  CrossStoreQueryOptions,
  'limit' | 'concurrency' | 'projectFilter' | 'registry'
>;

/**
 * s87-m03 — `perStoreProbe` is added to the ONE named query that forwards it, and to no other.
 *
 * Found by this mission's build-time adversarial critic. The first version widened the shared
 * `NamedQueryOpts` above, which let all four named queries ACCEPT a `perStoreProbe` while only
 * `activeMissionsAcrossProjects` passed it on — three surfaces that take a parameter and silently
 * drop it. That is this sprint's own defect class, introduced by the fix for it. Typing it here
 * instead means a caller that supplies a probe to `decisionsAcrossProjects` gets a compile error
 * rather than silence.
 */
type ProbeableQueryOpts<P> = NamedQueryOpts &
  Pick<CrossStoreQueryOptions<P>, 'perStoreProbe' | 'timeoutMs' | 'deadlineAtMs'>;

export interface PortfolioDecisionRow extends CrossStoreRow {
  id: number;
  decision_text: string;
  sprint_id: string | null;
  stable_event_id: string;
}

/**
 * (a) "Show me all decisions I made across all my projects in the last N days."
 * Newest-first across the portfolio. `now`/`days` are explicit so the time window
 * is deterministic in tests.
 */
export function decisionsAcrossProjects(
  opts: NamedQueryOpts & { days?: number; now?: number } = {}
): Promise<CrossStoreQueryResult<PortfolioDecisionRow>> {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 30;
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const sql = `SELECT project_id, id, decision_text, sprint_id, stable_event_id, occurred_at, origin_seq
          FROM strategic_decisions
          WHERE event_type = 'decision_captured' AND occurred_at > ?`;
  return queryAcrossStores<PortfolioDecisionRow>({
    // Bind the cutoff (don't interpolate) — defense-in-depth against a NaN/Infinity
    // now/days producing a broken or non-numeric SQL literal. The bound `?` precedes
    // queryAcrossStores's own LIMIT `?`, so params order is [cutoff, limit].
    sql,
    perStoreQuery: spinOutQuery('decision', sql, [cutoff]),
    params: [cutoff],
    order: 'desc',
    limit: opts.limit,
    concurrency: opts.concurrency,
    projectFilter: opts.projectFilter,
    registry: opts.registry,
  });
}

export interface PortfolioMissionRow extends CrossStoreRow {
  id: string;
  name: string;
  status: string;
}

/**
 * (b) "What are the active missions across my project portfolio right now?"
 * (status = 'In Progress' OR 'Current').
 */
export function activeMissionsAcrossProjects<P = CrossStoreProbeValue>(
  opts: ProbeableQueryOpts<P> = {}
): Promise<CrossStoreQueryResult<PortfolioMissionRow, P>> {
  return queryAcrossStores<PortfolioMissionRow, P>({
    sql: `SELECT project_id, id, name, status, occurred_at, origin_seq
          FROM missions
          WHERE status IN ('In Progress', 'Current')`,
    order: 'desc',
    limit: opts.limit,
    concurrency: opts.concurrency,
    projectFilter: opts.projectFilter,
    registry: opts.registry,
    // s87-m03: forwarded so `rbook_review` can derive store freshness from CONTENT on the
    // connection this fan-out already holds, instead of from a `-wal` mtime this fan-out itself
    // created. Optional and undefined by default — every other caller is unaffected.
    perStoreProbe: opts.perStoreProbe,
    timeoutMs: opts.timeoutMs,
    deadlineAtMs: opts.deadlineAtMs,
  });
}

export interface PortfolioLearningRow extends CrossStoreRow {
  id: number;
  content: string;
  category: string | null;
}

/**
 * (c) "Show learnings tagged X across N projects." The `tag` maps to the learnings
 * `category` facet (the closest existing tag dimension). Parameterized.
 */
export function learningsTaggedAcrossProjects(
  tag: string,
  opts: NamedQueryOpts = {}
): Promise<CrossStoreQueryResult<PortfolioLearningRow>> {
  const sql = `SELECT project_id, id, content, category, occurred_at, origin_seq
          FROM learnings
          WHERE category = ?`;
  return queryAcrossStores<PortfolioLearningRow>({
    sql,
    perStoreQuery: spinOutQuery('learning', sql, [tag]),
    params: [tag],
    order: 'desc',
    limit: opts.limit,
    concurrency: opts.concurrency,
    projectFilter: opts.projectFilter,
    registry: opts.registry,
  });
}

interface DecisionWithEvidenceRow extends CrossStoreRow {
  id: number;
  decision_text: string;
  evidence: string | null;
}

/** One cross-project co-citation cluster: decisions in ≥2 projects sharing an evidence ref. */
export interface CitationCluster {
  /** The shared evidence reference key (`<type>:<id>`). */
  evidenceRef: string;
  /** The decisions (across projects) that cite it. */
  members: Array<{ projectId: string; decisionId: number; decisionText: string }>;
  /** Distinct project_ids in the cluster (always ≥ 2). */
  projectIds: string[];
}

export interface CitationGraphResult {
  clusters: CitationCluster[];
  errors: CrossStoreQueryResult['errors'];
  metadata: CrossStoreQueryResult['metadata'];
}

/**
 * (d) "Cluster decisions that cite each other across projects." Interpreted as
 * cross-project **co-citation**: decisions in different stores that reference the
 * SAME TraceLab evidence entry (`decision.evidence` is a JSON array of
 * `{type, id}`). A cluster is returned only when the citing decisions span ≥ 2
 * distinct projects — the cross-store signal. (Within-store citation is just the
 * existing `superseded_by` chain and needs no fan-out.)
 *
 * This one post-processes the fan-out rather than relying on the merge order: it
 * gathers decisions-with-evidence across stores, then groups by evidence ref in
 * app code. The `limit` bounds how many decisions-with-evidence are gathered.
 */
export async function citationGraphAcrossProjects(
  opts: NamedQueryOpts = {}
): Promise<CitationGraphResult> {
  const sql = `SELECT project_id, id, decision_text, evidence, occurred_at, origin_seq
          FROM strategic_decisions
          WHERE evidence IS NOT NULL AND evidence != ''`;
  const fanout = await queryAcrossStores<DecisionWithEvidenceRow>({
    sql,
    perStoreQuery: spinOutQuery('decision', sql, []),
    order: 'desc',
    limit: opts.limit ?? 1000,
    concurrency: opts.concurrency,
    projectFilter: opts.projectFilter,
    registry: opts.registry,
  });

  // evidenceRef -> citing decisions (across stores).
  const byRef = new Map<
    string,
    Array<{ projectId: string; decisionId: number; decisionText: string }>
  >();
  for (const row of fanout.results) {
    const refs = parseEvidenceRefs(row.evidence);
    for (const ref of refs) {
      const list = byRef.get(ref) ?? [];
      list.push({
        projectId: row.project_id,
        decisionId: row.id,
        decisionText: row.decision_text,
      });
      byRef.set(ref, list);
    }
  }

  const clusters: CitationCluster[] = [];
  for (const [evidenceRef, members] of byRef) {
    const projectIds = [...new Set(members.map((m) => m.projectId))];
    if (projectIds.length >= 2) {
      clusters.push({ evidenceRef, members, projectIds: projectIds.sort() });
    }
  }
  // Most-cross-cited first.
  clusters.sort(
    (a, b) => b.projectIds.length - a.projectIds.length || b.members.length - a.members.length
  );

  return { clusters, errors: fanout.errors, metadata: fanout.metadata };
}

/** Parse a `strategic_decisions.evidence` JSON array into `<type>:<id>` keys. Tolerant of junk. */
function parseEvidenceRefs(evidence: string | null): string[] {
  if (!evidence) return [];
  try {
    const parsed = JSON.parse(evidence);
    if (!Array.isArray(parsed)) return [];
    const refs: string[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object' && 'type' in item && 'id' in item) {
        refs.push(
          `${String((item as { type: unknown }).type)}:${String((item as { id: unknown }).id)}`
        );
      }
    }
    return refs;
  } catch {
    return [];
  }
}
