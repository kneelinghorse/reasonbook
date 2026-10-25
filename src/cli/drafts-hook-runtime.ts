// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Shares bounded store and runtime access between draft hooks and prompt offers.
// ABOUTME: Keeps draft expiry and hook busy-timeout semantics identical at both call sites.
import Database from 'better-sqlite3';
import { openDraftRuntime, startsSince, type DraftRuntime } from '../tools/rbook/draft-runtime';
import { isExpired, type DraftRow } from '../tools/rbook/proposals';
import { processBusyTimeout } from '../tools/rbook/sqlite-busy';
import { storedTimeMs } from '../tools/rbook/stored-time';

export function storeTimeout(): number {
  return processBusyTimeout() ?? 250;
}

export function openStore(dbPath: string, readonly: boolean): Database.Database {
  return new Database(dbPath, { readonly, fileMustExist: true, timeout: storeTimeout() });
}

export function checkDeadline(deadlineAtMs: number): void {
  if (Date.now() >= deadlineAtMs) throw new Error('draft handling deadline exceeded');
}

export function withRuntime<T>(
  dbPath: string,
  env: NodeJS.ProcessEnv,
  fallback: T,
  action: (runtime: DraftRuntime) => T
): T {
  const runtime = openDraftRuntime(dbPath, env, { timeoutMs: storeTimeout() });
  if (!runtime) return fallback;
  try {
    return action(runtime);
  } finally {
    runtime.close();
  }
}

export function unexpired(runtime: DraftRuntime | null, rows: DraftRow[], now: number): DraftRow[] {
  return rows.filter(
    (row) => !isExpired(row, runtime ? startsSince(runtime, storedTimeMs(row.createdAt)) : 0, now)
  );
}
