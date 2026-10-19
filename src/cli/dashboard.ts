// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The dashboard's verbs at the terminal (s97-m11, design §The client design): share a project through it after a
// ABOUTME: dry run, join one by its address, and move one back to the owner's copy; each says its result or its remedy.

import path from 'path';
import { parseArgs, resolveCliProject, type CliIo } from './core';
import { joinThroughDashboard } from '../tools/rbook/record-dashboard-join';
import { moveBackFromDashboard } from '../tools/rbook/record-dashboard-move';
import { shareThroughDashboard } from '../tools/rbook/record-dashboard-share';
import { answered, storeOpener } from '../tools/rbook/record-sync';
import type { RbookToolResult } from '../tools/rbook/types';

export const SHARE_USAGE = [
  'reasonbook share --dashboard [--yes] [--project-root <root>]: share this project through the dashboard.',
  '  Without --yes it only lists what would go up and what stays on this machine.',
].join('\n');

export const MOVE_USAGE =
  "reasonbook move --to owner [--project-root <root>]: move a project shared through the dashboard back to this copy, the owner's.";

function said<T>(io: CliIo, result: RbookToolResult<T>, line: (data: T) => string): number {
  if (result.success && result.data !== undefined) {
    io.stdout(`${line(result.data)}\n`);
    for (const warning of result.warnings ?? []) io.stderr(`Note: ${warning}`);
    return 0;
  }
  io.stderr(
    `${result.error?.message ?? 'It failed.'}${result.error?.suggestion ? ` ${result.error.suggestion}` : ''}`
  );
  return 1;
}

function storeOf(flags: Record<string, string>, io: CliIo, verb: string): string | null {
  const resolution = resolveCliProject({
    projectRootArg: flags['project-root'],
    env: io.env,
    cwd: io.cwd,
  });
  if (resolution.kind !== 'store') {
    io.stderr(`reasonbook ${verb}: no Reasonbook store found here; pass --project-root <root>.`);
    return null;
  }
  return resolution.dbPath;
}

export async function runShare(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  if (
    flags['dashboard'] !== 'true' ||
    Object.keys(flags).some((flag) => !['dashboard', 'yes', 'project-root'].includes(flag))
  ) {
    io.stderr(SHARE_USAGE);
    return 1;
  }
  const dbPath = storeOf(flags, io, 'share');
  if (!dbPath) return 1;
  const result = await answered(
    shareThroughDashboard(
      storeOpener(dbPath),
      storeOpener(dbPath, { replicaCheck: false }),
      dbPath,
      {
        confirm: flags['yes'] === 'true',
      }
    )
  );
  return said(io, result, (data) => {
    const rows = (counts: Readonly<Record<string, number>>) =>
      Object.entries(counts)
        .map(([table, n]) => `${table} ${n}`)
        .join(', ') || 'nothing';
    if (!('handover' in data)) {
      return [
        `Sharing through ${data.plan.dashboard} sends the shared record: ${rows(data.plan.up)}${'record_changes' in data.plan.up ? '' : ', with the change log sharing starts for it'}.`,
        `It stays on this machine: ${rows(data.plan.stays)}, and the search index and context documents.`,
        'Nothing was sent. Send it with reasonbook share --dashboard --yes.',
      ].join('\n');
    }
    return [
      `Shared through ${data.dashboard}: its copy holds the record from move ${data.handover.epoch}, and this copy syncs through it.`,
      `It sent the shared record: ${rows(data.plan.up)}.`,
    ].join('\n');
  });
}

export async function runJoinDashboard(
  address: string,
  flags: Record<string, string>,
  io: CliIo
): Promise<number> {
  const named = flags['into'] && flags['into'] !== 'true' ? flags['into'] : null;
  const folder = path.resolve(io.cwd, named ?? '.');
  // As init does: no join into a folder that holds no project, or, unnamed, into one inside another.
  const policy = await import('../intelligence/resolution-policy');
  if (policy.isContextlessDirectory(folder)) {
    io.stderr(`reasonbook join: ${folder} is not a project folder; name one with --into <folder>.`);
    return 1;
  }
  const enclosing = named ? null : policy.findEnclosingStore(folder);
  if (enclosing && !policy.isSameDirectory(enclosing.root, folder)) {
    io.stderr(
      `reasonbook join: ${folder} is inside the Reasonbook project at ${enclosing.root}; name the folder to join into with --into <folder>.`
    );
    return 1;
  }
  const result = await answered(joinThroughDashboard({ folder, address }));
  return said(
    io,
    result,
    (data) =>
      `Joined through ${data.dashboard} as ${data.joined.member}, in block ${data.joined.block}, into ${folder}.${data.sync ? '' : ` Sync once more to finish: reasonbook sync --project-root ${folder}`}`
  );
}

export async function runMove(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  if (
    flags['to'] !== 'owner' ||
    Object.keys(flags).some((flag) => !['to', 'project-root'].includes(flag))
  ) {
    io.stderr(MOVE_USAGE);
    return 1;
  }
  const dbPath = storeOf(flags, io, 'move');
  if (!dbPath) return 1;
  const result = await answered(
    moveBackFromDashboard(storeOpener(dbPath), storeOpener(dbPath, { replicaCheck: false }), dbPath)
  );
  return said(
    io,
    result,
    (data) =>
      `Moved back from ${data.dashboard}: this copy holds the record again (move ${data.epoch}), and the dashboard archived its copy.`
  );
}
