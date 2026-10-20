// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read stats from the existing store without migrations, registration, or lifecycle writes.
// ABOUTME: Missing schemas and failed queries stay unavailable; semantic quality and severity need review.

import { missionCompletedSql } from './terminal-status';
import { RbookDatabaseClient } from './client';
import { openDraftRuntime, startsSince } from './draft-runtime';
import { clientRunner, draftsCreatedBetween, isExpired, proposalsTableExists } from './proposals';
import { readLeaseAges, leaseState, LEASE_COUNTING_RULE } from './next-step-lease';
import { readStaleness, type StalenessRead } from './staleness-detection';
import { storedTimeMs } from './stored-time';

export interface StatsWindow {
  readonly since: string;
  readonly until: string;
  readonly baselineSince: string;
  readonly baselineUntil: string;
}
export interface TimingCount {
  qualified: number;
  endLoaded: number;
}
export interface StoreStatistics {
  warnings: string[];
  timing: { baseline: TimingCount; window: TimingCount } | null;
  duplicates: {
    newDecisions: number | null;
    exactDuplicates: number | null;
    ratio: number | null;
    semanticStatus: 'unmeasured';
    contradictionStatus: 'review-required';
  };
  leases: { ok: number; warning: number; lapsing: number; idle: number } | null;
  staleness: StalenessRead | null;
  friction: {
    status: 'unavailable' | 'review-required';
    count: number | null;
    items: Array<{ id: number; body: string; createdAt: string }>;
  };
  proposals: ProposalStatistics;
}

export type ProposalStatistics =
  | { status: 'unavailable'; reason: 'schema-not-present' | 'unreadable' }
  | {
      status: 'measured';
      created: number;
      outcomes: Record<
        'pending' | 'approved' | 'declined' | 'replaced' | 'answered' | 'expired',
        number
      >;
      modes: Record<'approved' | 'agent-judged' | 'agent-attested', number>;
      /** approved ÷ (approved + declined + expired); null with none of those. */
      acceptanceRate: number | null;
    };

export const STORE_COUNTING_RULES = {
  timing:
    'Completed missions in the period with at least one mission_id decision recorded no later than completion +5 minutes; end-loaded means all such decisions are within ±2 minutes of completion. Earlier decisions are included. Pool only stores with ≥15 qualifying missions in both periods; target is at most half the baseline share.',
  duplicates:
    'Window-new decisions with at least one earlier currently-active decision containing identical decision_text and project_domain. Exact text only; semantic duplicates and contradictions require review.',
  leases: LEASE_COUNTING_RULE,
  staleness:
    'Current stored stale counts and computed due-for-review counts from the existing staleness reader; not reconstructed historical state.',
  friction:
    'Local agent_feedback created in the window, all statuses. Severity is a human judgment; absence of local items cannot establish no severity-3 friction elsewhere.',
  proposals:
    'Drafts created in the window, by outcome; a pending draft past 7 days or 3 later session starts counts as expired (computed, never stored). Acceptance rate = approved / (approved + declined + expired); replaced (a revision) and answered (by a record the draft did not become: one without fromDraft, a record of the same text made earlier, or the record of the draft it revises) are excluded from the denominator. Modes count approved drafts only. A store without the proposals table is unavailable, never zero acceptance.',
} as const;

function rows<T>(client: RbookDatabaseClient, sql: string, values: unknown[] = []): T[] {
  const result = client.getMany<T>(sql, values);
  if (!result.success || !result.data)
    throw new Error(result.error?.message ?? 'The stats query failed');
  return result.data;
}

function columns(client: RbookDatabaseClient, table: string): Set<string> {
  // Table names come only from this module, never from CLI input.
  return new Set(
    rows<{ name: string }>(client, `PRAGMA table_info(${table})`).map((row) => row.name)
  );
}

function requireColumns(client: RbookDatabaseClient, table: string, names: string[]): void {
  const actual = columns(client, table);
  const missing = names.filter((name) => !actual.has(name));
  if (missing.length) throw new Error(`${table}: missing ${missing.join(', ')}`);
}

function timingCount(client: RbookDatabaseClient, since: string, until: string): TimingCount {
  requireColumns(client, 'missions', ['id', 'status', 'completed_at']);
  requireColumns(client, 'strategic_decisions', ['mission_id', 'created_at']);
  // A mission without any linked decision cannot enter this denominator. An undated
  // mission with a decision might, so it must still make timing unavailable in every window.
  const invalid = rows<{ count: number }>(
    client,
    `SELECT COUNT(*) AS count FROM missions m
      WHERE ${missionCompletedSql('m.status')} AND julianday(m.completed_at) IS NULL
        AND EXISTS (SELECT 1 FROM strategic_decisions d WHERE d.mission_id = m.id)`
  )[0].count;
  if (invalid)
    throw new Error(
      `Decision timing unavailable: ${invalid} completed missions with decisions have unreadable completion times`
    );
  const decisions = rows<{ id: string; completed: string; recorded: string | null }>(
    client,
    `SELECT m.id, m.completed_at AS completed, d.created_at AS recorded
       FROM missions m JOIN strategic_decisions d ON d.mission_id = m.id
      WHERE ${missionCompletedSql('m.status')} AND julianday(m.completed_at) BETWEEN julianday(?) AND julianday(?)`,
    [since, until]
  );
  const missions = new Map<string, boolean>();
  for (const row of decisions) {
    const completed = storedTimeMs(row.completed);
    const recorded = storedTimeMs(row.recorded);
    if (!Number.isFinite(recorded))
      throw new Error(
        'Decision timing unavailable: a qualifying mission has an unreadable decision timestamp'
      );
    if (recorded > completed + 300_000) continue;
    missions.set(
      row.id,
      (missions.get(row.id) ?? true) && Math.abs(recorded - completed) <= 120_000
    );
  }
  return { qualified: missions.size, endLoaded: [...missions.values()].filter(Boolean).length };
}

function duplicateCounts(client: RbookDatabaseClient, window: StatsWindow) {
  requireColumns(client, 'strategic_decisions', ['id', 'decision_text', 'created_at', 'status']);
  const domain = columns(client, 'strategic_decisions').has('project_domain');
  const result = rows<{ newDecisions: number; exactDuplicates: number | null }>(
    client,
    `SELECT COUNT(*) AS newDecisions, SUM(CASE WHEN EXISTS (
       SELECT 1 FROM strategic_decisions old WHERE old.id <> d.id
         AND COALESCE(old.status, 'active') = 'active' AND old.decision_text = d.decision_text
         ${domain ? "AND COALESCE(old.project_domain, '') = COALESCE(d.project_domain, '')" : ''}
         AND (julianday(old.created_at) < julianday(d.created_at)
           OR (julianday(old.created_at) = julianday(d.created_at) AND old.id < d.id))
     ) THEN 1 ELSE 0 END) AS exactDuplicates FROM strategic_decisions d
     WHERE julianday(d.created_at) BETWEEN julianday(?) AND julianday(?)`,
    [window.since, window.until]
  )[0];
  const exactDuplicates = result.exactDuplicates ?? 0;
  return {
    newDecisions: result.newDecisions,
    exactDuplicates,
    ratio: result.newDecisions ? exactDuplicates / result.newDecisions : null,
  };
}

/** s93-m06: outcomes of the drafts created in the window, under the published counting rule. */
function proposalStatistics(
  client: RbookDatabaseClient,
  window: StatsWindow,
  env: NodeJS.ProcessEnv
): ProposalStatistics {
  const run = clientRunner(client);
  if (!proposalsTableExists(run)) return { status: 'unavailable', reason: 'schema-not-present' };
  const now = Date.now();
  const runtime = openDraftRuntime(client.path, env, { readonly: true });
  try {
    const outcomes = { pending: 0, approved: 0, declined: 0, replaced: 0, answered: 0, expired: 0 };
    const modes = { approved: 0, 'agent-judged': 0, 'agent-attested': 0 };
    const drafts = draftsCreatedBetween(run, window.since, window.until);
    for (const draft of drafts) {
      const starts = runtime ? startsSince(runtime, storedTimeMs(draft.createdAt)) : 0;
      const outcome =
        draft.outcome === 'pending' && isExpired(draft, starts, now) ? 'expired' : draft.outcome;
      if (outcome in outcomes) outcomes[outcome as keyof typeof outcomes]++;
      if (draft.outcome === 'approved' && draft.approvalMode && draft.approvalMode in modes)
        modes[draft.approvalMode]++;
    }
    const resolved = outcomes.approved + outcomes.declined + outcomes.expired;
    return {
      status: 'measured',
      created: drafts.length,
      outcomes,
      modes,
      acceptanceRate: resolved ? outcomes.approved / resolved : null,
    };
  } finally {
    runtime?.close();
  }
}

/** A fresh read each time: a table absent now may be introduced by the next mission. */
export async function storeStatistics(
  dbPath: string,
  window: StatsWindow,
  env: NodeJS.ProcessEnv = process.env
): Promise<StoreStatistics> {
  const result: StoreStatistics = {
    warnings: [],
    timing: null,
    duplicates: {
      newDecisions: null,
      exactDuplicates: null,
      ratio: null,
      semanticStatus: 'unmeasured',
      contradictionStatus: 'review-required',
    },
    leases: null,
    staleness: null,
    friction: { status: 'unavailable', count: null, items: [] },
    proposals: { status: 'unavailable', reason: 'schema-not-present' },
  };
  const opened = await RbookDatabaseClient.create({
    dbPath,
    readonly: true,
    registerProject: false,
    timeout: 250,
  });
  if (!opened.success || !opened.data) {
    result.warnings.push(opened.error?.message ?? 'The store could not be read');
    return result;
  }
  const client = opened.data;
  const attempt = (label: string, read: () => void): void => {
    try {
      read();
    } catch (error) {
      result.warnings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  try {
    attempt('decision timing', () => {
      result.timing = {
        baseline: timingCount(client, window.baselineSince, window.baselineUntil),
        window: timingCount(client, window.since, window.until),
      };
    });
    attempt('exact duplicates', () => {
      Object.assign(result.duplicates, duplicateCounts(client, window));
    });
    attempt('lease health', () => {
      requireColumns(client, 'next_steps', ['id', 'status', 'created_at', 'resolved_at']);
      requireColumns(client, 'sprints', ['status', 'end_date']);
      const ages = readLeaseAges(client);
      if (ages === null) throw new Error('Lease ages could not be read');
      if (ages.some((age) => age.ageDays === null)) throw new Error('A lease anchor is unreadable');
      result.leases = { ok: 0, warning: 0, lapsing: 0, idle: 0 };
      for (const age of ages) result.leases[leaseState(age.closesSurvived, age.ageDays)]++;
    });
    attempt('staleness', () => {
      requireColumns(client, 'strategic_decisions', ['id', 'status']);
      requireColumns(client, 'learnings', ['id', 'status']);
      requireColumns(client, 'sprints', ['id', 'status']);
      result.staleness = readStaleness(client);
      result.warnings.push(...result.staleness.warnings.map((warning) => `staleness: ${warning}`));
    });
    attempt('friction', () => {
      requireColumns(client, 'agent_feedback', ['id', 'body', 'created_at']);
      const items = rows<{ id: number; body: string; createdAt: string }>(
        client,
        'SELECT id, body, created_at AS createdAt FROM agent_feedback WHERE julianday(created_at) BETWEEN julianday(?) AND julianday(?) ORDER BY julianday(created_at), id',
        [window.since, window.until]
      );
      result.friction = { status: 'review-required', count: items.length, items };
    });
    attempt('proposals', () => {
      result.proposals = proposalStatistics(client, window, env);
    });
  } finally {
    client.close();
  }
  return result;
}
