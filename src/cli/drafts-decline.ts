// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Retries id-only decline intents without depending on retained operator words.
// ABOUTME: Clears an intent only after the project store confirms a terminal draft outcome.
import {
  clearPendingDeclines,
  pendingDeclines,
  type DraftRuntime,
} from '../tools/rbook/draft-runtime';
import { getDraft, markDeclined, rawRunner, type SqlRunner } from '../tools/rbook/proposals';
import { openStore } from './drafts-hook-runtime';

/** Caller holds the runtime lock through the project commit. Already-terminal intents only need clearing. */
export function applyRetainedDeclines(run: SqlRunner, runtime: DraftRuntime): void {
  const pending = pendingDeclines(runtime);
  if (!pending.length) return;
  const settled: number[] = [];
  for (const entry of pending) {
    markDeclined(run, [entry.id], new Date(entry.at).toISOString());
    const draft = getDraft(run, entry.id);
    if (draft && draft.outcome !== 'pending') settled.push(entry.id);
  }
  clearPendingDeclines(runtime, settled);
}

export function drainDeclines(dbPath: string, runtime: DraftRuntime): void {
  if (!pendingDeclines(runtime).length) return;
  runtime.db
    .transaction(() => {
      const writer = openStore(dbPath, false);
      try {
        writer.transaction(() => applyRetainedDeclines(rawRunner(writer), runtime)).immediate();
      } finally {
        writer.close();
      }
    })
    .immediate();
}

export function retryRetainedDeclines(dbPath: string, runtime: DraftRuntime): void {
  try {
    drainDeclines(dbPath, runtime);
  } catch (error) {
    process.stderr.write(
      `drafts unavailable: decline retry failed; intent retained: ${String(error)}\n`
    );
  }
}
