// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Join per-project telemetry and read-only store measurements for the local stats command.
// ABOUTME: The export is an explicit aggregate projection: no record bodies, ids, paths, or project names.

import { resolveRecordPaths } from '../../intelligence/legacy-compat';
import * as fs from 'fs';
import * as path from 'path';
import { targetForStore, readTelemetryReport, telemetryKey } from './local-telemetry';
import {
  eventStatistics,
  EVENT_COUNTING_RULES,
  type ProjectEvents,
} from './telemetry-stats-events';
import { rulesStatistics, RULE_SCAN_SCOPE, type RulesStatistics } from './telemetry-stats-rules';
import {
  storeStatistics,
  STORE_COUNTING_RULES,
  type StatsWindow,
  type StoreStatistics,
} from './telemetry-stats-store';
import { storedTimeMs } from './stored-time';

export type { StatsWindow } from './telemetry-stats-store';
export interface ProjectStatistics {
  readonly root: string;
  readonly telemetry: {
    available: boolean;
    files: number;
    records: number;
    warnings: readonly string[];
  };
  readonly rules: RulesStatistics;
  readonly store: StoreStatistics;
}

export const STATS_COUNTING_RULES = {
  ...EVENT_COUNTING_RULES,
  ...STORE_COUNTING_RULES,
  rulesFiles: RULE_SCAN_SCOPE,
};

/** Physical store identity de-duplicates aliases; explicit extra roots never trigger registry fan-out. */
export async function collectTelemetryStats(
  roots: readonly string[],
  window: StatsWindow,
  env: NodeJS.ProcessEnv = process.env
) {
  const projects: ProjectStatistics[] = [];
  const streams: ProjectEvents[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const dbPath = resolveRecordPaths(root).dbPath;
    let real = dbPath;
    try {
      real = fs.realpathSync.native(dbPath);
    } catch {
      /* A missing store still gets an unavailable report. */
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const target = targetForStore(dbPath);
    const read = target
      ? readTelemetryReport(target, env)
      : { records: [], files: 0, available: false, warnings: ['target-unavailable'] };
    const records = read.records.filter(
      (record) =>
        storedTimeMs(record.ts) >= storedTimeMs(window.since) &&
        storedTimeMs(record.ts) <= storedTimeMs(window.until)
    );
    streams.push({ target: target ? telemetryKey(target) : real, records });
    projects.push({
      root: path.resolve(root),
      telemetry: {
        available: read.available,
        files: read.files,
        records: records.length,
        warnings: read.warnings,
      },
      rules: rulesStatistics(path.resolve(root)),
      store: await storeStatistics(dbPath, window, env),
    });
  }
  const readable = projects.filter(
    ({ store }) =>
      store.timing && store.timing.baseline.qualified >= 15 && store.timing.window.qualified >= 15
  );
  const baseline = { qualified: 0, endLoaded: 0 };
  const current = { qualified: 0, endLoaded: 0 };
  for (const { store } of readable) {
    baseline.qualified += store.timing!.baseline.qualified;
    baseline.endLoaded += store.timing!.baseline.endLoaded;
    current.qualified += store.timing!.window.qualified;
    current.endLoaded += store.timing!.window.endLoaded;
  }
  const baselineRate = baseline.qualified ? baseline.endLoaded / baseline.qualified : null;
  const windowRate = current.qualified ? current.endLoaded / current.qualified : null;
  return {
    window,
    projects,
    rules: STATS_COUNTING_RULES,
    coverage: {
      status: 'not-established' as const,
      projectsWithTelemetry: projects.filter((project) => project.telemetry.available).length,
      diagnosticCount: projects.reduce(
        (sum, project) =>
          sum +
          project.telemetry.warnings.length +
          project.rules.warnings.length +
          project.store.warnings.length,
        0
      ),
    },
    events: eventStatistics(streams),
    timing: {
      readableProjects: readable.length,
      excludedProjects: projects.length - readable.length,
      baseline,
      window: current,
      baselineRate,
      windowRate,
      passed: baselineRate !== null && windowRate !== null ? windowRate <= baselineRate / 2 : null,
    },
    friction: {
      status: 'review-required' as const,
      measuredProjects: projects.filter((project) => project.store.friction.count !== null).length,
      items: projects.reduce((sum, project) => sum + (project.store.friction.count ?? 0), 0),
    },
  };
}

export type TelemetryStatistics = Awaited<ReturnType<typeof collectTelemetryStats>>;

/** s93-m06: drafts summed over the measured stores; unavailable when none could be measured. */
function proposalTotals(stores: readonly StoreStatistics['proposals'][]) {
  const measured = stores.filter(
    (store): store is Extract<StoreStatistics['proposals'], { status: 'measured' }> =>
      store.status === 'measured'
  );
  if (!measured.length) return { status: 'unavailable' as const, instrumentedProjects: 0 };
  const outcomes = { pending: 0, approved: 0, declined: 0, replaced: 0, answered: 0, expired: 0 };
  const modes = { approved: 0, 'agent-judged': 0, 'agent-attested': 0 };
  let created = 0;
  for (const store of measured) {
    created += store.created;
    for (const key of Object.keys(outcomes) as Array<keyof typeof outcomes>)
      outcomes[key] += store.outcomes[key];
    for (const key of Object.keys(modes) as Array<keyof typeof modes>)
      modes[key] += store.modes[key];
  }
  const resolved = outcomes.approved + outcomes.declined + outcomes.expired;
  return {
    status: 'measured' as const,
    instrumentedProjects: measured.length,
    created,
    outcomes,
    modes,
    acceptanceRate: resolved ? outcomes.approved / resolved : null,
  };
}

/** Counts, ratios and static labels only. Never serialize a report and delete known secrets afterward. */
export function exportTelemetryStats(report: TelemetryStatistics) {
  const e = report.events;
  const sum = (read: (store: StoreStatistics) => number | null): number | null => {
    const values = report.projects
      .map(({ store }) => read(store))
      .filter((v): v is number => v !== null);
    return values.length === report.projects.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  const exact = sum((store) => store.duplicates.exactDuplicates);
  const decisions = sum((store) => store.duplicates.newDecisions);
  return {
    projects: report.projects.length,
    rules: STATS_COUNTING_RULES,
    coverage: { ...report.coverage },
    prompting: {
      ...e.prompting,
      rulesFiles: report.projects.reduce((n, project) => n + project.rules.files, 0),
      matchingRulesFiles: report.projects.reduce(
        (n, project) => n + project.rules.matchingFiles,
        0
      ),
      matchingRulesLines: report.projects.reduce(
        (n, project) => n + project.rules.matchingLines,
        0
      ),
    },
    decisionTiming: report.timing,
    citeThrough: e.citeThrough,
    unjoinableUses: {
      records: e.unjoinableUses.records,
      pidKeyedRecords: e.unjoinableUses.pidKeyedRecords,
      otherUnkeyedRecords: e.unjoinableUses.otherUnkeyedRecords,
      items: e.unjoinableUses.items.length,
    },
    crossSessionReferences: {
      records: e.crossSessionReferences.records,
      items: e.crossSessionReferences.items.length,
    },
    friction: report.friction,
    proposals: proposalTotals(report.projects.map((project) => project.store.proposals)),
    repeatedNeverCited: { minimumSessions: 2, items: e.repeatedNeverCited.items.length },
    duplicateQuality: {
      newDecisions: decisions,
      exactDuplicates: exact,
      ratio: decisions && exact !== null ? exact / decisions : null,
      semanticStatus: 'unmeasured' as const,
      contradictionStatus: 'review-required' as const,
    },
    leases: {
      ok: sum((s) => s.leases?.ok ?? null),
      warning: sum((s) => s.leases?.warning ?? null),
      lapsing: sum((s) => s.leases?.lapsing ?? null),
      idle: sum((s) => s.leases?.idle ?? null),
    },
    staleness: {
      storedStaleDecisions: sum((s) =>
        s.staleness?.warnings.length === 0 ? s.staleness.storedStaleDecisions : null
      ),
      storedStaleLearnings: sum((s) =>
        s.staleness?.warnings.length === 0 ? s.staleness.storedStaleLearnings : null
      ),
      dueDecisions: sum((s) =>
        s.staleness?.warnings.length === 0 ? s.staleness.dueDecisions : null
      ),
      dueLearnings: sum((s) =>
        s.staleness?.warnings.length === 0 ? s.staleness.dueLearnings : null
      ),
    },
    restatement: e.restatement,
    injection: e.injection,
    digestOff: e.digestOff,
    safety: e.safety,
  };
}
