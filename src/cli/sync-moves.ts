// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook handover and recover (ADR s96 §8): moving the owner's copy over SSH, the far end's confirmation as
// ABOUTME: the operator's word, and how the sync commands say a move, a new identity or a renumber.

import fs from 'fs';
import { parseArgs, resolveCliProject, type CliIo } from './core';
import type { RbookDatabaseClient } from '../tools/rbook/client';
import type { ExchangeReport } from '../tools/rbook/record-exchange';
import { handOverRoute, recoverRoutes } from '../tools/rbook/record-move-routes';
import { confirmOwner, type Confirmed } from '../tools/rbook/record-moves';
import { rememberPeer } from '../tools/rbook/record-peers';
import type { SshRoute } from '../tools/rbook/record-ssh';
import { storeOpener } from '../tools/rbook/record-sync';
import type { RbookToolResult } from '../tools/rbook/types';

type Opener = <T>(step: (client: RbookDatabaseClient) => T) => Promise<Awaited<T>>;

const HANDOVER_USAGE =
  "reasonbook handover, on the owner's copy: --ssh <host> --remote-root <folder> [--node <path>] [--bin <path>] [--config-dir <dir>]: hand the owner's copy over to the owner's other copy there.";
const RECOVER_USAGE = [
  "reasonbook recover, on the copy that becomes the owner's: --members <name, name> [--drop <name, name>]",
  '  and --ssh <host> --remote-root <folder> [--node] [--bin] [--config-dir] for one member copy,',
  '  or --routes <file> holding a JSON list of {host, root, node?, bin?, configDir?}, one per member copy.',
].join('\n');

/** What a confirmation says. */
export function confirmedText(data: Confirmed): string {
  return [
    data.isAuthority
      ? `Confirmed: this copy is the owner's copy now (move ${data.epoch}), and judged ${data.judged} change(s) no verdict had reached.`
      : `Confirmed: the owner's copy is ${data.authority} from move ${data.epoch}.`,
    ...(data.next
      ? [
          `Another move waits after it, to ${data.next.authority}: confirm it too once you trust it.`,
        ]
      : []),
  ].join(' ');
}

/** What one exchange says, its move, new identity and renumbers first. */
export function exchangeText(report: ExchangeReport): string {
  const parts: string[] = [];
  if (report.caughtUp)
    parts.push(
      `${report.caughtUp.copy === 'local' ? 'This copy' : 'That copy'} took in a move of the owner's copy to ${report.caughtUp.authority}; confirm it ${report.caughtUp.copy === 'local' ? 'here' : 'there'} with reasonbook sync --confirm-owner, then sync the two copies again.`
    );
  if (report.reidentified)
    parts.push(
      `The member's copy took a new identity in block ${report.reidentified.block}: ${report.reidentified.summary}`
    );
  for (const moved of report.reblocked ?? [])
    parts.push(`Replica ${moved.replicaId} moved to block ${moved.block} after a block clash.`);
  parts.push(
    `${report.caughtUp ? `The copy behind took in ${report.received}` : `The owner's copy took in ${report.sent}, and the member's took in ${report.received}`}${report.conflicts ? `; ${report.conflicts} field(s) in conflict` : ''}.`
  );
  return parts.join(' ');
}

/** The far end's methods a handover calls: the confirmation, and the routes it takes. */
export function handoverMethods(
  open: Opener,
  unchecked: Opener
): Record<string, (params: unknown) => Promise<unknown>> {
  return {
    confirmOwner: (params) =>
      open((client) => confirmOwner(client, params as { changeId?: string })),
    rememberPeers: (params) =>
      unchecked((client) => {
        for (const peer of params as Array<{
          replicaId: string;
          name: string | null;
          route: SshRoute;
        }>)
          rememberPeer(client, peer.replicaId, { name: peer.name, route: peer.route });
      }),
  };
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

function routeOf(flags: Record<string, string>): SshRoute | null {
  if (!flags['ssh'] || !flags['remote-root']) return null;
  return {
    host: flags['ssh'],
    root: flags['remote-root'],
    ...(flags['node'] ? { node: flags['node'] } : {}),
    ...(flags['bin'] ? { bin: flags['bin'] } : {}),
    ...(flags['config-dir'] ? { configDir: flags['config-dir'] } : {}),
  };
}

function said<T>(io: CliIo, result: RbookToolResult<T>, text: (data: T) => string): number {
  if (result.success && result.data !== undefined) {
    io.stdout(`${text(result.data)}\n`);
    return 0;
  }
  io.stderr(
    `${result.error?.message ?? 'It failed.'}${result.error?.suggestion ? ` ${result.error.suggestion}` : ''}`
  );
  return 1;
}

const names = (text: string | undefined): string[] =>
  (text ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

export async function runHandover(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  const route = routeOf(flags);
  if (!route) {
    io.stderr(HANDOVER_USAGE);
    return 1;
  }
  const dbPath = storeOf(flags, io, 'handover');
  if (!dbPath) return 1;
  const moved = await handOverRoute(storeOpener(dbPath), route, {
    unchecked: storeOpener(dbPath, { replicaCheck: false }),
  });
  return said(
    io,
    moved,
    (data) =>
      `Handed the owner's copy over to ${route.host} (move ${data.handover.epoch}); it confirmed and holds this copy's routes. This copy is a member now: ${exchangeText(data.sync)}`
  );
}

export async function runRecover(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  const one = routeOf(flags);
  const routes: SshRoute[] | null = one
    ? [one]
    : flags['routes']
      ? (JSON.parse(fs.readFileSync(flags['routes'], 'utf8')) as SshRoute[])
      : null;
  if (!routes || !flags['members']) {
    io.stderr(RECOVER_USAGE);
    return 1;
  }
  const dbPath = storeOf(flags, io, 'recover');
  if (!dbPath) return 1;
  const recovered = await recoverRoutes(storeOpener(dbPath, { replicaCheck: false }), routes, {
    members: names(flags['members']),
    drop: names(flags['drop']),
  });
  return said(
    io,
    recovered,
    (data) =>
      `This copy is the owner's copy now (move ${data.epoch}, block ${data.block}), with ${data.collected} change(s) collected and ${data.judged} judged again. ${data.lost.summary} Each member confirms at its next sync.`
  );
}
