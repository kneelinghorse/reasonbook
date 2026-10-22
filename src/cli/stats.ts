// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook stats reports local G1 evidence and sprint-close measurements without changing the store.
// ABOUTME: Explicit extra projects enable pooling; export emits aggregate counts and fixed measurement rules.

import * as path from 'path';
import { oneLine, parseArgs, resolveCliProject, type CliIo } from './core';
import {
  collectTelemetryStats,
  exportTelemetryStats,
  type StatsWindow,
  type TelemetryStatistics,
} from '../tools/rbook/telemetry-stats';
import { storedTimeMs, timeBound } from '../tools/rbook/stored-time';

/** Repeated includes are intentionally not reduced by parseArgs, whose normal flags use last wins. */
function includedProjects(argv: readonly string[]): string[] {
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--include-project=')) roots.push(arg.slice('--include-project='.length));
    else if (arg === '--include-project') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('--include-project needs a folder');
      roots.push(value);
    }
  }
  if (roots.some((root) => !root.trim())) throw new Error('--include-project needs a folder');
  return roots;
}

function readWindow(flags: Readonly<Record<string, string>>): StatsWindow {
  const now = Date.now();
  // September 2026 is G1's ratified production baseline, not a fixture timestamp.
  const values = {
    since: flags.since ?? new Date(now - 14 * 86_400_000).toISOString(),
    until: flags.until ?? new Date(now).toISOString(),
    baselineSince: flags['baseline-since'] ?? '2026-09-01T00:00:00.000Z',
    baselineUntil: flags['baseline-until'] ?? '2026-09-30T23:59:59.999Z',
  };
  const parsed = Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      const bound = timeBound(value, key.toLowerCase().endsWith('since') ? 'since' : 'until');
      if (bound === null)
        throw new Error(`${key}: use a valid ISO timestamp, date, month, or year`);
      return [key, bound];
    })
  ) as unknown as StatsWindow;
  if (
    storedTimeMs(parsed.since) > storedTimeMs(parsed.until) ||
    storedTimeMs(parsed.baselineSince) > storedTimeMs(parsed.baselineUntil)
  )
    throw new Error('Each since bound must precede its until bound');
  return parsed;
}

function humanReport(report: TelemetryStatistics): string {
  const counts = exportTelemetryStats(report);
  const lines = [
    `Reasonbook stats: ${report.window.since} through ${report.window.until}`,
    `Baseline: ${report.window.baselineSince} through ${report.window.baselineUntil}`,
    'Coverage is not established by a best-effort event file; zero observed matches is not a G1 pass.',
    'G1 prompting and rules files, decision timing, prompt cite-through, and friction:',
    JSON.stringify(
      {
        prompting: counts.prompting,
        decisionTiming: counts.decisionTiming,
        citeThrough: counts.citeThrough.prompt,
        friction: counts.friction,
      },
      null,
      2
    ),
    'Sprint-close measures:',
    JSON.stringify(
      {
        proposals: counts.proposals,
        citeThrough: counts.citeThrough,
        repeatedNeverCited: counts.repeatedNeverCited,
        duplicateQuality: counts.duplicateQuality,
        leases: counts.leases,
        staleness: counts.staleness,
        restatement: counts.restatement,
        injection: counts.injection,
        digestOff: counts.digestOff,
        safety: counts.safety,
      },
      null,
      2
    ),
    'Counting rules:',
    ...Object.entries(report.rules).map(([name, rule]) => `${name}: ${rule}`),
  ];
  for (const project of report.projects) {
    lines.push(
      `Project: ${oneLine(project.root)}`,
      `Telemetry: ${project.telemetry.records} window records in ${project.telemetry.files} retained monthly files; ${project.telemetry.available ? 'available' : 'unavailable'}.`
    );
    lines.push(
      `Decision timing: ${JSON.stringify(project.store.timing)}; proposals: ${
        project.store.proposals.status === 'measured'
          ? `${project.store.proposals.created} drafts, acceptance ${project.store.proposals.acceptanceRate ?? 'n/a'}`
          : oneLine(project.store.proposals.reason)
      }.`
    );
    for (const hit of project.rules.hits)
      lines.push(
        `Rules: ${oneLine(hit.path)}: ${hit.patternIds.map((id) => oneLine(id)).join(', ')}`
      );
    for (const item of project.store.friction.items)
      lines.push(`Friction #${item.id} (${oneLine(item.createdAt)}): ${oneLine(item.body)}`);
    for (const warning of [
      ...project.telemetry.warnings,
      ...project.rules.warnings,
      ...project.store.warnings,
    ])
      lines.push(`Unavailable/diagnostic: ${oneLine(warning)}`);
  }
  for (const item of report.events.repeatedNeverCited.items)
    lines.push(
      `Repeated without observed use: store ${oneLine(item.target)}, ${oneLine(item.id)}, ${item.sessions} sessions.`
    );
  for (const session of report.events.injectionSessions)
    lines.push(
      `Injected characters: store ${oneLine(session.target)}, session ${oneLine(session.session)}: ${session.characters}.`
    );
  return `${lines.join('\n')}\n`;
}

export async function runStats(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const { flags } = parseArgs(argv);
    const window = readWindow(flags);
    const resolution = resolveCliProject({
      projectRootArg: flags['project-root'],
      env: io.env,
      cwd: io.cwd,
    });
    if (resolution.kind !== 'store')
      throw new Error('No readable Reasonbook project was selected; pass --project-root <folder>');
    const roots = [
      resolution.projectRoot,
      ...includedProjects(argv).map((root) => path.resolve(io.cwd, root)),
    ];
    const report = await collectTelemetryStats(roots, window, io.env);
    io.stdout(
      flags.export === 'true'
        ? `${JSON.stringify(exportTelemetryStats(report), null, 2)}\n`
        : humanReport(report)
    );
    return 0;
  } catch (error) {
    io.stderr(
      `reasonbook stats: ${oneLine(error instanceof Error ? error.message : String(error))}`
    );
    return 1;
  }
}
