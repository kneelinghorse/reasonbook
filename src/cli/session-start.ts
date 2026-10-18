// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m01 — `hook session-start`: link the harness process to its session and inject the record's
// ABOUTME: digest; in a git repo with no store, offer init until declined. The session opens at its first write.

import { launchSync, sharedSyncEnabled, syncsOnItsOwn } from '../tools/rbook/record-sync-trigger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cliCommand, formatCliRemedy, type CliRemedyTarget } from '../utils/cli-remedy';
import type { HookDelivery, HookVerbContext } from '../cli';
import { isSameDirectory } from '../intelligence/resolution-policy';
import { isDeclined, linkHarness } from '../tools/rbook/harness-session';
import { hookRuntimeIdentity } from './hook-runtime';
import { captureBaseline, consumeCompactMarker } from './lifecycle-runtime';
import { deliverRecallContext } from './recall-runtime';
import { preparedRenderedContext } from './telemetry';
import { processBusyTimeout } from '../tools/rbook/sqlite-busy';
import { assertStoreReadable, hookStore, resolutionDir } from './core';

export { cliCommand } from '../utils/cli-remedy';

/** The one line offered in a git repository that has no Reasonbook record. */
export function initOffer(
  command: string = cliCommand(),
  portable = false,
  target: CliRemedyTarget = { projectRoot: process.cwd(), resolvedBy: 'cwd' }
): string {
  return (
    'No Reasonbook record in this repository. If the user wants decisions, learnings and next steps ' +
    `kept across sessions, ${portable ? `run ${formatCliRemedy('init', target, command)} with their agreement to start one` : '/reasonbook:init starts one'}; if they decline, run ${formatCliRemedy('ambient off', target, command)} ` +
    'here and this offer stops.'
  );
}

/**
 * The root of the git work tree enclosing `start`, or null. The same ceiling as the store walk:
 * `$HOME` is never examined unless the walk started there, so a home directory under version
 * control does not make every folder beneath it a repository.
 */
export function gitWorkTreeRoot(start: string, homeDir: string = os.homedir()): string | null {
  let dir = path.resolve(start);
  const startsAtHome = isSameDirectory(dir, homeDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    if (!startsAtHome && isSameDirectory(parent, homeDir)) return null;
    dir = parent;
  }
}

/**
 * The link comes first and needs no store: it tells the harness's MCP server which conversation it
 * serves, and where (a git repository can gain a store mid-conversation). No session row is written
 * here. The harness session's Reasonbook session opens at its first write, so
 * a conversation that never uses Reasonbook leaves nothing in the record (the m01 build critic).
 */
export async function run(ctx: HookVerbContext): Promise<string | HookDelivery | null> {
  const { input, io, resolution } = ctx;
  const rawId = input.session_id?.trim();
  // The link records the conversation's folder: its key applies only in the store enclosing it.
  if (rawId) linkHarness(rawId, input.source, resolutionDir(resolution), io.env);

  const runtime = hookRuntimeIdentity(input, io.env);
  captureBaseline(runtime, io.env, ctx.deadlineAtMs ?? Date.now() + 1000);
  const store = hookStore(resolution);
  if (!store) {
    if (resolution.kind !== 'none' || resolution.contextless) return null;
    const repo = gitWorkTreeRoot(resolution.workingDir);
    return repo && !isDeclined(repo, io.env)
      ? initOffer(undefined, Boolean(ctx.harness && ctx.harness !== 'claude'), {
          projectRoot: repo,
          // A hook's folder may come from its payload or environment, outside the shell cwd.
          resolvedBy: 'explicit',
        })
      : null;
  }
  // s96-m13 (design §s96-m13 item 4): a shared copy with a route syncs at session start, detached,
  // so the digest shows the previous sync and the hook never waits on the network.
  if (sharedSyncEnabled() && syncsOnItsOwn(store.dbPath)) launchSync(store.projectRoot);
  // s93-m06: a session start counts toward a draft's expiry, outside the store, before any digest
  // choice: digest-off silences the digest, not the approval loop.
  if (rawId)
    (await import('./drafts-hook')).onSessionStart(store.dbPath, rawId, input.source, io.env);
  if (ctx.ambient === 'digest-off') return null;
  assertStoreReadable(store.dbPath, processBusyTimeout() ?? 250);
  const text = await (
    await import('./digest')
  ).buildDigest(store.projectRoot, io, ctx.deadlineAtMs, 'explicit');
  const context = preparedRenderedContext(io);
  return {
    deliver: (emit) => {
      if (rawId && context)
        deliverRecallContext(
          {
            dbPath: store.dbPath,
            rawSessionId: rawId,
            env: io.env,
            deadlineAtMs: ctx.deadlineAtMs ?? Date.now() + 1000,
          },
          context,
          emit
        );
      else emit(text);
      if (input.source === 'compact') consumeCompactMarker(runtime, io.env);
    },
  };
}
