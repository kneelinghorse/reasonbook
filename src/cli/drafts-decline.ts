// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Retries id-only decline intents without depending on retained operator words.
// ABOUTME: Clears an intent only after the project store confirms a terminal draft outcome.
import {
  clearPendingDeclines,
  pendingDeclines,
  type DraftRuntime,
} from '../tools/rbook/draft-runtime';
import { getDraft, markDeclined, rawRunner } from '../tools/rbook/proposals';
import { openStore } from './drafts-hook-runtime';

export function drainDeclines(dbPath: string, runtime: DraftRuntime): void {
  const pending = pendingDeclines(runtime);
  if (!pending.length) return;
  const writer = openStore(dbPath, false);
  try {
    const run = rawRunner(writer);
    const settled = writer
      .transaction(() => {
        const ids: number[] = [];
        for (const entry of pending) {
          markDeclined(run, [entry.id], new Date(entry.at).toISOString());
          const draft = getDraft(run, entry.id);
          if (draft && draft.outcome !== 'pending') ids.push(entry.id);
        }
        return ids;
      })
      .immediate();
    clearPendingDeclines(runtime, settled);
  } finally {
    writer.close();
  }
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
