// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook brief renders the weekly brief over every project this machine registers.
// ABOUTME: Reads with this machine's draft runtime through the reusable library; --format json prints its sections.

import { oneLine, parseArgs, type CliIo } from './core';
import { listRegisteredStoresReadOnly } from '../intelligence/registered-stores-readonly';
import { buildBrief, renderBrief, unreadableReport, type SignalsReport } from '../signals';
import { signalsAcrossProjects } from '../tools/rbook/portfolio-signals';

const USAGE = 'Usage: reasonbook brief [--days <1..365>] [--format md|json]';

export async function runBrief(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  const format = flags.format ?? 'md';
  const days = flags.days === undefined ? 7 : Number(flags.days);
  if (
    (format !== 'md' && format !== 'json') ||
    !Number.isInteger(days) ||
    days <= 0 ||
    days > 365
  ) {
    io.stderr(USAGE);
    return 1;
  }
  try {
    const now = Date.now();
    const stores = listRegisteredStoresReadOnly(io.env);
    const { projects, errors } = await signalsAcrossProjects({
      now,
      env: io.env,
      stores,
      windowDays: days,
    });
    // A store the fan-out could not open is in the brief as unreadable, by its registry id.
    const reports: SignalsReport[] = [
      ...projects.map((project) => project.report),
      ...errors.map((error) => {
        const report = unreadableReport(
          { storePath: error.storePath, now, windowDays: days },
          `store unreadable: ${error.error}`
        );
        return { ...report, project: { id: error.projectId, name: null } };
      }),
    ];
    const options = { now, windowDays: days };
    io.stdout(
      format === 'json'
        ? `${JSON.stringify(buildBrief(reports, options), null, 2)}\n`
        : renderBrief(reports, options)
    );
    return 0;
  } catch (error) {
    io.stderr(
      oneLine(`reasonbook brief: ${error instanceof Error ? error.message : String(error)}`)
    );
    return 1;
  }
}
