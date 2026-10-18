// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m11 — store upkeep that may only run on a write: the staleness repair and a pending blob
// ABOUTME: migration, once per process per store, after that process's first write-classified MCP call.

import * as path from 'path';

import { applyPendingBlobMigrations } from './blob-migrations';
import { withClientAsync, type RbookDatabaseClient } from './client';
import { createSuccess } from './errors';
import {
  ensureDecisionsFts5,
  ensureVectorStorage,
  indexRebuildIsOwed,
  resetIndexRebuildOwed,
  settleIndexRebuild,
} from './schema-migrations';
import { repairFlaggerStaleness } from './staleness-detection';

/**
 * WHY HERE AND WHY EVERY PROCESS. Reads never write the record (Q10, decision #1182), so the lazy
 * repairs reads used to run run here instead: the staleness repair (decision #1191), a pending
 * master_context blob migration, and the rebuild of a search index a read found out of step. They
 * run in the MCP server only, never in a hook verb, after the call's own work so the store is
 * registered first.
 *
 * Once per process per store, not once per store: older Reasonbook servers on the same machine keep
 * re-flagging restored rows until they restart, and a one-time marker would stop the re-repair.
 * Only a store this pass could read counts as done, so an unreadable one is tried again.
 */
const maintainedStores = new Set<string>();

/**
 * Whether this process has yet to run first-write upkeep for the store at `projectRoot`, or owes it
 * an index rebuild a read deferred or a rebuild that failed (schema-migrations.ts).
 */
export function storeNeedsFirstWriteMaintenance(projectRoot: string): boolean {
  return !maintainedStores.has(path.resolve(projectRoot)) || indexRebuildIsOwed(projectRoot);
}

/** Test seam: forget which stores this process maintained and which rebuilds it owes. */
export function resetFirstWriteMaintenance(): void {
  maintainedStores.clear();
  resetIndexRebuildOwed();
}

/**
 * Run the upkeep for one store and return the lines to show on the call's answer: what was
 * restored or migrated, and any failure. Never throws. The store counts as done for this process
 * only when the upkeep completed without a warning, so a lock timeout or a rolled-back repair is
 * tried again at the next write.
 */
export async function runFirstWriteMaintenance(projectRoot: string): Promise<string[]> {
  const key = path.resolve(projectRoot);
  // A store this process already maintained gets only the index rebuild it still owes.
  const fullRun = !maintainedStores.has(key);
  if (!fullRun && !indexRebuildIsOwed(key)) return [];

  const notes: string[] = [];
  let clean = true;
  try {
    const outcome = await withClientAsync(
      async (client) => {
        if (fullRun) {
          const repair = repairFlaggerStaleness(client);
          if (repair.warnings.length > 0) clean = false;
          notes.push(...repair.warnings);
          const restored = repair.restoredDecisionIds.length + repair.restoredLearningIds.length;
          if (restored > 0) {
            notes.push(
              `Restored ${repair.restoredDecisionIds.length} decision(s) and ` +
                `${repair.restoredLearningIds.length} learning(s) to active: they were marked stale ` +
                'with no review stamp, the way Reasonbook before 3.3.0 marked old records on its own, and ' +
                "Reasonbook no longer changes a record's status unasked. To keep one stale on purpose, set " +
                'it with rbook_decisions(action="update", status="stale"), which records the review.' +
                (repair.reflagged > 0
                  ? ` ${repair.reflagged} of them had been restored before, so an older Reasonbook server ` +
                    'is still running; restarting those sessions ends it.'
                  : '')
            );
          }

          const masterContext = client.getOne<{ content: string }>(
            "SELECT content FROM contexts WHERE id = 'master_context'",
            []
          );
          if (masterContext.success && masterContext.data) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(masterContext.data.content);
            } catch {
              parsed = undefined;
            }
            // A blob that is not a JSON object is left exactly as it is; the migrations reshape
            // objects only.
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const migration = applyPendingBlobMigrations(
                client,
                'master_context',
                masterContext.data.content,
                parsed as Record<string, unknown>
              );
              if (migration.warnings.length > 0) clean = false;
              notes.push(...migration.warnings);
              if (migration.migrated && migration.rewritten) {
                notes.push(
                  `Migrated the stored master_context to blob schema v${Math.max(...migration.migrationsApplied)}.`
                );
              }
            }
          }
        }

        // Derived data, so a failure here does not hold the whole upkeep for a retry; the rebuild
        // alone stays owed, and this process tries it again at its next write.
        notes.push(...repairSearchIndexes(client, key));
        return createSuccess(true);
      },
      { projectRoot: key, registerProject: false }
    );
    if (!outcome.success) {
      clean = false;
      notes.push(
        `Store upkeep skipped: ${outcome.error?.message ?? 'the store could not be opened'}; it runs again at the next write.`
      );
    }
  } catch (error) {
    clean = false;
    notes.push(
      `Store upkeep failed: ${error instanceof Error ? error.message : String(error)}; it runs again at the next write.`
    );
  }

  if (clean && fullRun) maintainedStores.add(key);
  return notes;
}

/**
 * Rebuild a search index a read left as it found it: one out of step with its table, or the
 * learnings and missions indexes built before their completion marker (schema-migrations.ts). Only
 * a store that already has the index gets this; a store never searched gets its indexes at its
 * first search. The same migrations a search runs, here on a call that may write.
 */
function repairSearchIndexes(client: RbookDatabaseClient, key: string): string[] {
  const present = client.getMany<{ name: string }>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('decisions_fts', 'learnings_fts', 'missions_fts')`,
    []
  );
  const names = new Set((present.success ? (present.data ?? []) : []).map((row) => row.name));
  const notes: string[] = [];
  let rebuilt = 0;
  let failed = !present.success;
  if (names.has('decisions_fts')) {
    const decisions = ensureDecisionsFts5(client);
    notes.push(...(decisions.warnings ?? []));
    failed = failed || (decisions.warnings ?? []).length > 0;
    rebuilt += decisions.rowsUpdated;
  }
  if (names.has('learnings_fts') || names.has('missions_fts')) {
    const others = ensureVectorStorage(client);
    notes.push(...(others.warnings ?? []));
    failed = failed || (others.warnings ?? []).length > 0;
    rebuilt += others.rowsUpdated;
  }
  if (rebuilt > 0) {
    notes.push(
      `Rebuilt this store's search indexes (${rebuilt} records): a read leaves an index as it ` +
        'finds it, so the rebuild waits for a write.'
    );
  }
  settleIndexRebuild(key, failed);
  return notes;
}
