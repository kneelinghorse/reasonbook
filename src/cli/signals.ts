// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook signals: the nine signals for every project this machine registers, or one with --project-root, read
// ABOUTME: read-only through the signals library with this machine's draft runtime; --format json prints the reports whole.

import { oneLine, parseArgs, resolveCliProject, type CliIo } from './core';
import { frameForeignInline } from '../intelligence/provenance-frame';
import { listRegisteredStoresReadOnly } from '../intelligence/registered-stores-readonly';
import { readSignals, type SignalEntry, type SignalsReport } from '../signals';
import { draftRuntimeDir } from '../tools/rbook/draft-runtime';
import { signalsAcrossProjects } from '../tools/rbook/portfolio-signals';

/** Row ids shown per signal in the text; the JSON carries up to the library's 20. */
const TEXT_IDS = 5;

interface Unreadable {
  readonly projectId: string;
  readonly storePath: string;
  readonly error: string;
}

/** What one signal says, on one line: its count or why it has none, then what limits it. */
function entryLine(entry: SignalEntry): string {
  if (!entry.available) {
    const reason = oneLine(entry.reason ?? '');
    if (!entry.failed) return `  ${entry.kind}: unavailable — ${reason}`;
    const bare = reason.replace(/^could not be read: /, '');
    return /could not be read/.test(bare)
      ? `  ${entry.kind}: ${bare}`
      : `  ${entry.kind}: could not be read — ${bare}`;
  }
  const notes: string[] = [];
  if (entry.lapseDue) notes.push(`${entry.lapseDue} lapse at the next close`);
  if (entry.byKind) {
    for (const [kind, n] of Object.entries(entry.byKind))
      if (n > 0) notes.push(`${oneLine(kind)} ${n}`);
    if (entry.unclassified) notes.push(`${entry.unclassified} unclassified`);
  }
  if (entry.undated) notes.push(`${entry.undated} undated`);
  if (entry.sinceUnknown) notes.push(`${entry.sinceUnknown} blocked since an unknown time`);
  if (entry.removed) notes.push('a peer reported this copy removed');
  if (entry.reason) notes.push(oneLine(entry.reason));
  const ids = entry.ids
    .slice(0, TEXT_IDS)
    .map((id) => oneLine(id, 100))
    .join(', ');
  const more = entry.ids.length > TEXT_IDS || (entry.count ?? 0) > entry.ids.length ? ', …' : '';
  return (
    `  ${entry.kind}: ${entry.count}` +
    (notes.length ? ` (${notes.join('; ')})` : '') +
    (ids ? ` — ${ids}${more}` : '')
  );
}

function reportText(report: SignalsReport): string[] {
  const name = report.project.name ?? report.project.id;
  return [
    `${frameForeignInline(oneLine(name, 60), `proj:${oneLine(report.project.id, 100)}`)}`,
    ...report.signals.map(entryLine),
  ];
}

function render(
  io: CliIo,
  format: string | undefined,
  now: number,
  reports: SignalsReport[],
  unreadable: Unreadable[]
): number {
  if (format === 'json') {
    io.stdout(`${JSON.stringify({ reports, unreadable }, null, 2)}\n`);
    return 0;
  }
  const lines = [
    `Reasonbook signals at ${new Date(now).toISOString()}, ${reports.length} project(s); each rule: --format json.`,
  ];
  for (const report of reports) lines.push('', ...reportText(report));
  for (const store of unreadable)
    lines.push(
      '',
      `Unreadable: proj:${oneLine(store.projectId, 100)} (${oneLine(store.storePath)}): ${oneLine(store.error)}`
    );
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}

export async function runSignals(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  if (flags.format !== undefined && flags.format !== 'json' && flags.format !== 'text') {
    io.stderr('Usage: reasonbook signals [--project-root <dir>] [--format text|json]');
    return 1;
  }
  const now = Date.now();
  const runtime = draftRuntimeDir(io.env);
  const root = flags['project-root'];
  try {
    if (root !== undefined) {
      // An empty --project-root= would otherwise fall through to the working folder.
      if (!root.trim() || root === 'true') throw new Error('--project-root needs a folder');
      const resolution = resolveCliProject({ projectRootArg: root, env: io.env, cwd: io.cwd });
      if (resolution.kind !== 'store') throw new Error(`no Reasonbook store at ${root}`);
      const report = readSignals(resolution.dbPath, { now, draftRuntimeDir: runtime });
      // The one store asked for could not be read at all: say so and fail, not nine lines and 0.
      if (report.unreadable || report.signals.every((entry) => entry.failed))
        throw new Error(
          report.unreadable ?? report.signals[0]?.reason ?? 'the store could not be read'
        );
      return render(io, flags.format, now, [report], []);
    }
    const stores = listRegisteredStoresReadOnly(io.env);
    const { projects, errors } = await signalsAcrossProjects({ now, env: io.env, stores });
    const unreadable = errors.map(({ projectId, storePath, error }) => ({
      projectId,
      storePath,
      error,
    }));
    return render(
      io,
      flags.format,
      now,
      projects.map((project) => project.report),
      unreadable
    );
  } catch (error) {
    io.stderr(
      oneLine(`reasonbook signals: ${error instanceof Error ? error.message : String(error)}`)
    );
    return 1;
  }
}
