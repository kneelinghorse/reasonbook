// SPDX-License-Identifier: Apache-2.0
// ABOUTME: reasonbook sync and join (ADR s96 §7, §9): a copy of a shared record exchanging with the owner's, over SSH or by
// ABOUTME: bundle, and joining one; --serve is the far end an SSH sync or join runs, on stdin and stdout.

import fs from 'fs';
import path from 'path';
import { parseArgs, resolveCliProject, type CliIo } from './core';
import { createError, createSuccess } from '../tools/rbook/errors';
import {
  importBundleAndEmbed,
  readBundle,
  writeBundle,
  type Bundle,
} from '../tools/rbook/record-bundle';
import {
  applyJoin,
  answerJoin,
  requestJoin,
  type JoinAnswer,
  type JoinRequest,
} from '../tools/rbook/record-join';
import { memberNamed } from '../tools/rbook/record-membership';
import { forgetPeers, peerMarks, recordExchanged } from '../tools/rbook/record-peers';
import { COPY_KEYS, writeCopyKey } from '../tools/rbook/replica-copy-keys';
import { mergeContext } from '../tools/rbook/record-standing';
import type { SshRoute } from '../tools/rbook/record-ssh';
import {
  answered,
  joinRoute,
  storeOpener,
  syncAndRoute,
  syncPeers,
} from '../tools/rbook/record-sync';
import { withSyncLock } from '../tools/rbook/record-sync-trigger';
import { bundleRefusal, serveSync } from '../tools/rbook/record-wire';
import { confirmOwner } from '../tools/rbook/record-moves';
import { confirmedText, exchangeText, handoverMethods } from './sync-moves';
import { REPLICA_ERROR_CODES, storeFolder } from '../tools/rbook/replica-identity';
import type { RbookToolResult } from '../tools/rbook/types';

const SYNC_USAGE = [
  'reasonbook sync [--project-root <root>]: exchange with every copy this one has a route to.',
  "  --confirm-owner: confirm the move of the owner's copy this copy holds, as your word.",
  '  --bundle-out <file> [--for <member>]: write what the owner (or that member) lacks, to carry.',
  '  --bundle-in <file>: import a bundle another copy wrote.',
  '  --ssh <host> --remote-root <folder> [--node <path>] [--bin <path>] [--config-dir <dir>]:',
  '      sync with the copy there, and remember that route for it, as when its machine moved.',
  "  --serve [--join]: answer a sync (or a join) on this process's stdin and stdout; SSH runs it.",
  '  --auto: a sync a hook or the timer started, which waits out a dashboard that keeps failing.',
].join('\n');

const JOIN_USAGE = [
  'reasonbook join --dashboard <address> [--into <folder>]: join a project shared through the dashboard.',
  "reasonbook join, on the owner's machine: --ssh <host> --remote-root <folder> --member <name>",
  '  [--node <path>] [--bin <path>] [--config-dir <dir>]: join that copy over SSH, then sync.',
  'By bundle: --request-out <file> on the joining copy; --answer <file> --member <name> --out <file>',
  "  on the owner's; then --apply <file> on the joining copy.",
].join('\n');

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

/** Say a result: its answer on stdout, or its error and remedy on stderr; the exit code follows. */
function report<T>(io: CliIo, result: RbookToolResult<T>, said: (data: T) => string): number {
  if (result.success && result.data !== undefined) {
    io.stdout(`${said(result.data)}\n`);
    for (const warning of result.warnings ?? []) io.stderr(`Note: ${warning}`);
    return 0;
  }
  io.stderr(
    `${result.error?.message ?? 'It failed.'}${result.error?.suggestion ? ` ${result.error.suggestion}` : ''}`
  );
  return 1;
}

export async function runSync(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  const dbPath = storeOf(flags, io, 'sync');
  if (!dbPath) return 1;
  const open = storeOpener(dbPath);
  if (flags['serve']) {
    // The wire owns stdout: nothing else may write there while it serves.
    const unchecked = storeOpener(dbPath, { replicaCheck: false });
    await serveSync(
      process.stdin,
      process.stdout,
      open,
      {
        exchanged: (params) => {
          const { replicaId, marks, digest } = params as {
            replicaId: string;
            marks: Record<string, number>;
            digest: unknown;
          };
          return unchecked((client) => recordExchanged(client, replicaId, { marks, digest }));
        },
        // s96-m13: a handover's far end confirms the move and takes the routes, as the operator's word.
        ...(flags['confirm-owner'] ? handoverMethods(open, unchecked) : {}),
        ...(flags['join']
          ? {
              // A copy that has not joined is refused by the copy check, so its join steps skip it.
              joinRequest: () => unchecked((client) => requestJoin(client)),
              joinApply: (answer) => unchecked((client) => applyJoin(client, answer as JoinAnswer)),
            }
          : {}),
      },
      unchecked
    );
    return 0;
  }
  if (flags['confirm-owner']) {
    const confirmed = await storeOpener(dbPath, { replicaCheck: false })((client) =>
      confirmOwner(client)
    );
    return report(io, confirmed, confirmedText);
  }
  // s97-m10: a project the dashboard referees moves only through it, never by bundle (critics, round 1).
  if (flags['bundle-out'] || flags['bundle-in']) {
    const refused = await storeOpener(dbPath, { replicaCheck: false })((client) =>
      bundleRefusal(client)
    );
    if (refused) return report(io, createError(refused), () => '');
  }
  if (flags['bundle-out']) {
    const written = await answered(
      open((client): RbookToolResult<Bundle> => {
        // A member's bundle is for the owner's copy; the owner's names the member it is for, or holds all.
        const ctx = mergeContext(client);
        let target = ctx.ownReplica === ctx.authority ? undefined : ctx.authority;
        if (flags['for']) {
          const member = memberNamed(client, flags['for']);
          const replica =
            member && member.role !== 'removed'
              ? member.replicas[member.replicas.length - 1]?.replicaId
              : undefined;
          if (!replica)
            return createError({
              code: REPLICA_ERROR_CODES.WRITE_REFUSED,
              message: !member
                ? `${flags['for']} is not a member of this project, so no bundle was written.`
                : member.role === 'removed'
                  ? `${member.name} was removed, so their copy receives nothing new, and no bundle was written.`
                  : `${member.name} has no copy joined yet, so no bundle was written.`,
              suggestion:
                'List the members with rbook_project(action="members"), and name one whose copy has joined.',
            });
          target = replica;
        }
        return createSuccess(writeBundle(client, target ? peerMarks(client, target) : {}));
      })
    );
    if (!written.success || !written.data) return report(io, written, () => '');
    fs.writeFileSync(flags['bundle-out'], JSON.stringify(written.data));
    io.stdout(
      `Wrote ${written.data.changes.length} change(s) to ${flags['bundle-out']}; import it on the other copy with reasonbook sync --bundle-in.\n`
    );
    return 0;
  }
  if (flags['bundle-in']) {
    const read = readBundle(fs.readFileSync(flags['bundle-in'], 'utf8'));
    if (!read.success || !read.data) return report(io, read, () => '');
    const bundle = read.data;
    const imported = await answered(
      // The import makes the copy check itself, so a restored copy takes in a catch-up bundle.
      storeOpener(dbPath, { replicaCheck: false })(async (client) => {
        const result = await importBundleAndEmbed(client, bundle);
        if (result.success)
          recordExchanged(client, bundle.from.replicaId, { marks: bundle.from.marks });
        return result;
      })
    );
    return report(
      io,
      imported,
      (data) =>
        `Imported ${data.transactions} transaction(s), ${data.stored} new change(s); ${data.judged} judged, ${data.held} held, ${data.conflicts} field(s) in conflict.${data.caughtUp ? ` This copy now holds a move of the owner's copy to ${data.caughtUp.authority}: confirm it with reasonbook sync --confirm-owner.` : ''}`
    );
  }
  if (flags['ssh']) {
    if (!flags['remote-root']) {
      io.stderr(SYNC_USAGE);
      return 1;
    }
    const route: SshRoute = {
      host: flags['ssh'],
      root: flags['remote-root'],
      ...(flags['node'] ? { node: flags['node'] } : {}),
      ...(flags['bin'] ? { bin: flags['bin'] } : {}),
      ...(flags['config-dir'] ? { configDir: flags['config-dir'] } : {}),
    };
    const routed = await withSyncLock(dbPath, () =>
      syncAndRoute(open, route, { unchecked: storeOpener(dbPath, { replicaCheck: false }) })
    );
    if (!routed) {
      io.stdout('A sync of this copy is already running, so this one did nothing.\n');
      return 0;
    }
    return report(io, routed, (data) => `${route.host}:${route.root}: ${exchangeText(data)}`);
  }
  if (Object.keys(flags).some((flag) => flag !== 'project-root' && flag !== 'auto')) {
    io.stderr(SYNC_USAGE);
    return 1;
  }
  // Two triggers at once, such as a session end and the timer, run one sync; the second says so.
  const synced = await withSyncLock(dbPath, () =>
    syncPeers(open, {
      unchecked: storeOpener(dbPath, { replicaCheck: false }),
      projectRoot: storeFolder(dbPath),
      auto: flags['auto'] === 'true',
    })
  );
  if (!synced) {
    io.stdout('A sync of this copy is already running, so this one did nothing.\n');
    return 0;
  }
  return report(io, synced, (data) =>
    data.peers
      .map(
        (peer) =>
          `${peer.name ?? peer.replicaId}: ${
            peer.report
              ? exchangeText(peer.report)
              : peer.nextTryAt
                ? `not tried, since its last syncs failed; next try after ${peer.nextTryAt}`
                : peer.error
          }`
      )
      .join('\n')
  );
}

/** A join step's file, parsed, or null when it is not JSON, said on stderr. */
function readJoinFile<T>(io: CliIo, file: string, what: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    io.stderr(
      `reasonbook join: ${file} is not a ${what} that can be read (${error instanceof Error ? error.message : String(error)}). Carry the file as written, unchanged.`
    );
    return null;
  }
}

export async function runJoin(argv: readonly string[], io: CliIo): Promise<number> {
  // s97-m11: a join through the dashboard runs on the joining machine, into a folder with no store.
  const asked = parseArgs(argv);
  if (asked.flags['dashboard'] !== undefined) {
    const address =
      asked.flags['dashboard'] !== 'true' ? asked.flags['dashboard'] : asked.positional[0];
    if (!address) {
      io.stderr(JOIN_USAGE);
      return 1;
    }
    return (await import('./dashboard')).runJoinDashboard(address, asked.flags, io);
  }
  const { flags } = parseArgs(argv);
  const dbPath = storeOf(flags, io, 'join');
  if (!dbPath) return 1;
  if (flags['ssh']) {
    if (!flags['remote-root'] || !flags['member']) {
      io.stderr(JOIN_USAGE);
      return 1;
    }
    const route: SshRoute = {
      host: flags['ssh'],
      root: flags['remote-root'],
      ...(flags['node'] ? { node: flags['node'] } : {}),
      ...(flags['bin'] ? { bin: flags['bin'] } : {}),
      ...(flags['config-dir'] ? { configDir: flags['config-dir'] } : {}),
    };
    const joined = await joinRoute(storeOpener(dbPath), route, flags['member']);
    return report(
      io,
      joined,
      (data) =>
        `Joined ${data.joined.member}'s copy in block ${data.joined.block}, and synced: ${exchangeText(data.sync)}`
    );
  }
  if (flags['request-out']) {
    const request = await storeOpener(dbPath, { replicaCheck: false })((client) =>
      requestJoin(client)
    );
    if (request.success) fs.writeFileSync(flags['request-out'], JSON.stringify(request.data));
    return report(
      io,
      request,
      () => `Wrote the join request to ${flags['request-out']}; answer it on the owner's machine.`
    );
  }
  if (flags['answer'] && flags['member'] && flags['out']) {
    const request = readJoinFile<JoinRequest>(io, flags['answer'], 'join request');
    if (!request) return 1;
    const answer = await storeOpener(dbPath)((client) =>
      answerJoin(client, request, flags['member'])
    );
    if (answer.success) fs.writeFileSync(flags['out'], JSON.stringify(answer.data));
    return report(
      io,
      answer,
      (data) =>
        `Admitted the copy in block ${data.block}; carry ${flags['out']} back and apply it there.`
    );
  }
  if (flags['apply']) {
    const answer = readJoinFile<JoinAnswer>(io, flags['apply'], 'join answer');
    if (!answer) return 1;
    const applied = await storeOpener(dbPath, { replicaCheck: false })((client) =>
      applyJoin(client, answer)
    );
    return report(
      io,
      applied,
      (data) =>
        `Joined as ${data.member} in block ${data.block}; imported ${data.imported.stored} change(s).`
    );
  }
  io.stderr(JOIN_USAGE);
  return 1;
}

const COPY_USAGE =
  "reasonbook copy --to <folder> [--project-root <root>]: a safe copy of this project's store, made while the server runs, to carry to another machine and join.";

/**
 * reasonbook copy (design §s96-m13 item 6): VACUUM INTO writes one consistent store file while the
 * server and its hooks keep writing. The copy keeps this copy's identity until it joins, so the copy
 * check refuses its writes until then; it never overwrites a store already there.
 */
export async function runCopy(argv: readonly string[], io: CliIo): Promise<number> {
  const { flags } = parseArgs(argv);
  if (!flags['to']) {
    io.stderr(COPY_USAGE);
    return 1;
  }
  const dbPath = storeOf(flags, io, 'copy');
  if (!dbPath) return 1;
  const target = path.join(path.resolve(flags['to']), 'rbook', 'db', 'rbook.sqlite');
  if (fs.existsSync(target)) {
    io.stderr(
      `reasonbook copy: ${target} already holds a store, so nothing was copied. Name an empty folder.`
    );
    return 1;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const failure = await storeOpener(dbPath, { replicaCheck: false })((client) => {
    const copied = client.execute('VACUUM INTO ?', [target]);
    if (!copied.success) return copied.error?.message ?? 'the store could not be copied';
    return null;
  });
  if (failure !== null) {
    io.stderr(`reasonbook copy: ${failure}`);
    return 1;
  }
  // The copy keeps this copy's identity until it joins, but not its routes, health or notes: those
  // are this copy's own, and a copy carried elsewhere that followed them would sync as this one.
  await storeOpener(target, { replicaCheck: false })((client) => {
    forgetPeers(client);
    writeCopyKey(client, COPY_KEYS.successor, null);
    writeCopyKey(client, COPY_KEYS.joinPending, null);
  });
  io.stdout(
    `Copied the store to ${target}. Carry the folder to the other machine; for a shared project, join it from the owner's (reasonbook join).\n`
  );
  return 0;
}
