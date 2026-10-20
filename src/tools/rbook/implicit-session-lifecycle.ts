// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m03 — closing the sessions nobody will close by hand: this process's implicit ones at
// ABOUTME: exit, orphaned implicit ones, and an idle explicit blocker. Through the handler; no sync.

import * as fs from 'fs';
import * as path from 'path';

import { withClientAsync, type RbookDatabaseClient } from './client';
import { rbookSessionComplete } from './rbook-session-complete';
import { createSuccess } from './errors';
import {
  automaticCloseSummary,
  explicitSessionsAtStart,
  harnessSessions,
  implicitSessionsToClose,
  markStoreReconciled,
  ownImplicitSession,
  processSessionOwner,
  storeNeedsReconcile,
  storesUsedImplicitly,
  type CloseReason,
  type SessionToClose,
} from './session-owner';

/**
 * WHY THE HANDLER AND NOT THE ROUTER. rbook_session(complete) through the router uploads the whole
 * store as a checkpoint (rbook-session.ts → checkpoint-backfill.ts). A close nobody asked for must not
 * upload anything, so every close here calls rbookSessionComplete directly. The handler is still the
 * right door: it writes the rows of captures that have none yet (s100-m03: a next step captured since
 * 4.2.1 already has its row) and the close event, exactly as a requested complete does.
 *
 * NO NESTED CONNECTIONS. rbookSessionComplete opens its own client. Each function here reads its
 * candidates in one client, lets that client close, and only then calls the handler, once per
 * candidate, so no close runs inside another call's connection or transaction.
 *
 * NO REGISTRATION. A close nobody asked for registers nothing in the project graph: SessionEnd in a
 * second checkout of a registered project would otherwise be refused as a collision and leave the
 * harness session open (the m01 build critic, B3).
 */

export interface ClosedSessionReceipt {
  sessionId: string;
  title: string;
  implicit: boolean;
  reason: CloseReason;
  /** Hours since the session last did anything; null for a close at process exit. */
  idleHours: number | null;
  /** The deterministic summary it was closed with. */
  summary: string;
  closed: boolean;
  /** Why the close failed, when it did. */
  error?: string;
}

export interface LifecycleOutcome {
  receipts: ClosedSessionReceipt[];
  warnings: string[];
}

/** `<root>/rbook/db/rbook.sqlite` → `<root>` */
function projectRootOf(dbPath: string): string {
  return path.dirname(path.dirname(path.dirname(dbPath)));
}

async function closeEach(
  projectRoot: string | undefined,
  candidates: readonly SessionToClose[],
  observations?: string
): Promise<ClosedSessionReceipt[]> {
  const receipts: ClosedSessionReceipt[] = [];
  for (const candidate of candidates) {
    const facts = await withClientAsync(
      async (client) => {
        const row = client.getOne<{ captures: string | null }>(
          'SELECT captures FROM sessions WHERE id = ?',
          [candidate.sessionId]
        );
        const authored = (table: 'strategic_decisions' | 'learnings'): number => {
          const counted = client.getOne<{ c: number }>(
            `SELECT COUNT(*) AS c FROM ${table} WHERE author_session_id = ?`,
            [candidate.sessionId]
          );
          return counted.success && counted.data ? counted.data.c : 0;
        };
        return createSuccess({
          captures: row.success && row.data ? row.data.captures : null,
          decisions: authored('strategic_decisions'),
          learnings: authored('learnings'),
        });
      },
      { projectRoot, registerProject: false }
    );
    const idleHours =
      candidate.reason === 'process-exit' || candidate.reason === 'harness-ended'
        ? null
        : candidate.idleHours;
    const automaticSummary = automaticCloseSummary({
      reason: candidate.reason,
      idleHours,
      captures: facts.data?.captures ?? null,
      decisions: facts.data?.decisions ?? 0,
      learnings: facts.data?.learnings ?? 0,
    });
    const summary = observations ? `${automaticSummary} ${observations}` : automaticSummary;
    const closed = await rbookSessionComplete(
      { sessionId: candidate.sessionId, summary, projectRoot },
      { registerProject: false }
    );
    receipts.push({
      sessionId: candidate.sessionId,
      title: candidate.title,
      implicit: candidate.implicit,
      reason: candidate.reason,
      idleHours,
      summary,
      closed: closed.success,
      ...(closed.success ? {} : { error: closed.error?.message ?? 'unknown error' }),
    });
  }
  return receipts;
}

async function readThenClose(
  projectRoot: string | undefined,
  find: (client: RbookDatabaseClient) => SessionToClose[] | null,
  what: string
): Promise<LifecycleOutcome> {
  // Read-only: the finders never migrate, so this connection writes nothing.
  const read = await withClientAsync(
    async (client) => createSuccess({ candidates: find(client) }),
    { projectRoot, registerProject: false }
  );
  if (!read.success || !read.data) {
    return {
      receipts: [],
      warnings: [`${what} skipped: ${read.error?.message ?? 'the store could not be opened'}`],
    };
  }
  if (read.data.candidates === null) {
    return { receipts: [], warnings: [`${what} skipped: the read failed`] };
  }
  return { receipts: await closeEach(projectRoot, read.data.candidates), warnings: [] };
}

/**
 * Close the implicit sessions whose owner process is gone from this host, and any implicit session
 * idle past the bound. Runs after a call that opened this process's implicit session in a store,
 * and before an explicit start.
 */
export async function reconcileImplicitSessions(
  projectRoot?: string,
  nowMs: number = Date.now()
): Promise<LifecycleOutcome> {
  return readThenClose(
    projectRoot,
    (client) => implicitSessionsToClose(client, nowMs),
    'Implicit-session reconcile'
  );
}

/**
 * Before an explicit start: close explicit sessions idle past the bound (the blocker a forgotten
 * start leaves behind) and reconcile implicit ones, so the start can proceed with a receipt. When a
 * LIVE explicit session is open the start is about to refuse, and a refused start changes nothing,
 * so nothing is closed.
 */
export async function closeStaleSessionsBeforeStart(
  projectRoot?: string,
  nowMs: number = Date.now()
): Promise<LifecycleOutcome> {
  return readThenClose(
    projectRoot,
    (client) => {
      const explicit = explicitSessionsAtStart(client, nowMs);
      if (explicit === null) return null;
      if (explicit.live > 0) return [];
      const implicit = implicitSessionsToClose(client, nowMs);
      return implicit === null ? null : [...explicit.idle, ...implicit];
    },
    'Stale-session close before start'
  );
}

/**
 * Reconcile the store a write call just used, once per process per store. It runs after that
 * call's own connection closed, touches only that call's store (never one a parallel call named),
 * and counts as done only when the pass read the store, so a store it could not read is tried again
 * by the next call.
 */
export async function reconcileStoreOnce(dbPath: string | null): Promise<LifecycleOutcome> {
  if (!dbPath || !storeNeedsReconcile(dbPath) || !fs.existsSync(dbPath)) {
    return { receipts: [], warnings: [] };
  }
  const outcome = await reconcileImplicitSessions(projectRootOf(dbPath));
  // A pass that could not read the store reports a "skipped" warning; anything else read it.
  if (outcome.warnings.length === 0) markStoreReconciled(dbPath);
  return outcome;
}

/**
 * At stdin end, SIGINT or SIGTERM: close this process's own implicit session in every store it used
 * one in. Best effort. A store that cannot be opened is skipped and named in the warnings.
 *
 * s93-m01: only the pid-keyed one. A harness session's sessions (`ext:`) close at SessionEnd; a
 * server restarted mid-conversation must not close the session the conversation still writes into
 * (mechanism critic B2).
 */
export async function closeOwnImplicitSessions(): Promise<LifecycleOutcome> {
  const outcome: LifecycleOutcome = { receipts: [], warnings: [] };
  for (const dbPath of storesUsedImplicitly()) {
    // A store deleted since (a removed project, a scratch copy) has nothing left to close.
    if (!fs.existsSync(dbPath)) continue;
    const projectRoot = projectRootOf(dbPath);
    const read = await withClientAsync(
      async (client) => createSuccess({ own: ownImplicitSession(client, processSessionOwner()) }),
      { projectRoot, registerProject: false }
    );
    if (!read.success || !read.data) {
      outcome.warnings.push(
        `Implicit session in ${projectRoot} left open: ${read.error?.message ?? 'store unavailable'}`
      );
      continue;
    }
    const own = read.data.own;
    if (!own) continue;
    outcome.receipts.push(
      ...(await closeEach(projectRoot, [
        {
          sessionId: own.id,
          title: own.title,
          implicit: true,
          reason: 'process-exit',
          idleHours: 0,
        },
      ]))
    );
  }
  return outcome;
}

/**
 * s93-m01 — SessionEnd: close every session a harness session owns (`ownerKey`, an `ext:` key): its
 * implicit session and an explicit one it started, which belongs to that conversation and would be
 * orphaned by `/clear` (the m01 build critic, B1). Through the same handler as every automatic
 * close, so deferred captures materialize and nothing is uploaded. A session already closed (by
 * reconcile, or by hand) is not a candidate. Throws when the store cannot be read, so the hook
 * reports it instead of leaving the session open silently.
 */
export async function closeHarnessSession(
  projectRoot: string,
  ownerKey: string,
  observations?: string
): Promise<ClosedSessionReceipt[]> {
  const read = await withClientAsync(
    async (client) => createSuccess({ owned: harnessSessions(client, ownerKey) }),
    { projectRoot, registerProject: false }
  );
  if (!read.success || !read.data) {
    throw new Error(read.error?.message ?? 'the store could not be read');
  }
  return closeEach(
    projectRoot,
    read.data.owned.map((session) => ({
      sessionId: session.id,
      title: session.title,
      implicit: session.implicit,
      reason: 'harness-ended' as const,
      idleHours: 0,
    })),
    observations
  );
}

/** One rendered line per closed (or failed) session, for a tool answer's text. */
export function closedSessionLines(receipts: readonly ClosedSessionReceipt[]): string[] {
  return receipts.map((receipt) =>
    receipt.closed
      ? `Closed ${receipt.implicit ? 'implicit' : 'explicit'} session ${receipt.sessionId} (${receipt.title}): ${receipt.summary}`
      : `Could not close ${receipt.implicit ? 'implicit' : 'explicit'} session ${receipt.sessionId}: ${receipt.error}`
  );
}
