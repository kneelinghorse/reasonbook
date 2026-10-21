// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The signals across this machine's registered projects, through the one fan-out (queryAcrossStores): full reports for
// ABOUTME: reasonbook signals, and the review's count of what needs a person in each other project, on the connection it opens.

import type Database from 'better-sqlite3';

import {
  queryAcrossStores,
  type CrossStoreError,
  type CrossStoreRow,
} from '../../intelligence/cross-store-query';
import type { ProjectGraphEntry } from '../../intelligence/project-graph-registry';
import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import { computeSignals, type SignalKind, type SignalsReport } from '../../signals';
import { computeSignalEntries } from '../../signals/read-signals';
import { draftRuntimeDir } from './draft-runtime';

/**
 * The signals that need a person, which the review shows for every other project (the design's
 * mission 7): drafts awaiting a decision, next steps near their lease, blocked missions and a
 * shared copy's unsettled conflicts.
 */
export const PERSON_SIGNALS = [
  'drafts_pending',
  'next_steps_lapsing',
  'missions_blocked',
  'shared_conflicts',
] as const satisfies readonly SignalKind[];

const PERSON_KEYS: Readonly<Record<(typeof PERSON_SIGNALS)[number], keyof PersonSignals>> = {
  drafts_pending: 'drafts',
  next_steps_lapsing: 'lapsing',
  missions_blocked: 'blocked',
  shared_conflicts: 'conflicts',
};

/** One project's person-needing counts; a signal that is zero or unavailable is left out. */
export interface PersonSignals {
  drafts?: number;
  lapsing?: number;
  blocked?: number;
  conflicts?: number;
}

/** The store file a registered project root holds, which keys the machine's draft runtime. */
function storeFile(store: ProjectGraphEntry): string {
  return resolveRecordPaths(store.store_path).dbPath;
}

/**
 * The person-needing counts of the store the fan-out holds open, with this machine's draft runtime,
 * and whether any of the four could not be read there (a missing table is not a failure).
 */
export function personSignalsOf(
  db: Database.Database,
  store: ProjectGraphEntry,
  nowMs: number,
  env: NodeJS.ProcessEnv
): { counts: PersonSignals; failed: boolean } {
  const entries = computeSignalEntries(db, {
    storePath: storeFile(store),
    now: nowMs,
    maxIds: 0,
    draftRuntimeDir: draftRuntimeDir(env),
    only: PERSON_SIGNALS,
  });
  const counts: PersonSignals = {};
  let failed = false;
  for (const entry of entries) {
    if (entry.failed) failed = true;
    const key = PERSON_KEYS[entry.kind as (typeof PERSON_SIGNALS)[number]];
    if (key && entry.available && entry.count) counts[key] = entry.count;
  }
  return { counts, failed };
}

const counted = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

/** One project's counts as the review prints them, in a fixed order. */
export function personSignalsPhrase(signals: PersonSignals): string {
  const parts: string[] = [];
  if (signals.drafts) parts.push(counted(signals.drafts, 'draft', 'drafts'));
  if (signals.lapsing)
    parts.push(counted(signals.lapsing, 'next step about to lapse', 'next steps about to lapse'));
  if (signals.blocked) parts.push(counted(signals.blocked, 'blocked mission', 'blocked missions'));
  if (signals.conflicts)
    parts.push(counted(signals.conflicts, 'unsettled conflict', 'unsettled conflicts'));
  return parts.join(', ');
}

export interface ProjectSignals {
  readonly projectId: string;
  readonly report: SignalsReport;
}

/**
 * Every given store's full report, in the order the stores are given, with the stores that could
 * not be opened or read named apart. The fan-out opens each store read-only and closes it.
 */
export async function signalsAcrossProjects(options: {
  readonly now: number;
  readonly env: NodeJS.ProcessEnv;
  readonly stores: readonly ProjectGraphEntry[];
  /** The window the reports count, in days (default 7). */
  readonly windowDays?: number;
}): Promise<{ projects: ProjectSignals[]; errors: CrossStoreError[] }> {
  const runtime = draftRuntimeDir(options.env);
  const result = await queryAcrossStores<CrossStoreRow, SignalsReport>({
    sql: '',
    stores: options.stores,
    perStoreQuery: () => [],
    perStoreProbe: (db, store) =>
      computeSignals(db, {
        storePath: storeFile(store),
        now: options.now,
        draftRuntimeDir: runtime,
        ...(options.windowDays === undefined ? {} : { windowDays: options.windowDays }),
      }),
  });
  const order = new Map(options.stores.map((store, index) => [store.project_id, index]));
  const projects = result.probes
    .map((probe) => ({ projectId: probe.projectId, report: probe.value }))
    .sort((a, b) => (order.get(a.projectId) ?? 0) - (order.get(b.projectId) ?? 0));
  return { projects, errors: [...result.errors, ...result.probeErrors] };
}
