// ABOUTME: Retains the retired dashboard pull action and response types until the 5.0 compatibility removal.
// ABOUTME: Every pull refuses before opening stores or resolving credentials; shared records use reasonbook sync.

import type { RbookToolResult } from './types';
import { appendWarnings } from './format-warnings';
import { legacySyncRefusal } from './legacy-sync-refusal';

export const PULL_GENESIS_EVENT_TYPES: ReadonlySet<string> = new Set([
  'decision_captured',
  'learning_captured',
  'mission_added',
  'sprint_added',
  'session_started',
  'dependency_added',
]);

/** Retained public legacy event set; pull no longer consumes or applies these events. */
export const PULL_TRANSITION_EVENT_TYPES: ReadonlySet<string> = new Set([
  'mission_started',
  'mission_completed',
  'mission_blocked',
  'sprint_completed',
  'session_completed',
]);

export interface SyncPullParams {
  projectRoot?: string;
  /** Dashboard slug to pull. Defaults to metadata.dashboard_slug. */
  slug?: string;
  /** Per-page limit (default 500; the broker caps at 1000). */
  limit?: number;
  /** Safety bound on the pagination loop (default 1000 pages). */
  maxPages?: number;
}

export interface SyncPullResult {
  slug: string;
  fromCursor: number;
  toCursor: number;
  pages: number;
  /** Total events the broker returned across all pages. */
  received: number;
  /** Genesis events newly inserted (ON CONFLICT no-op excluded). */
  inserted: number;
  /** Genesis events already present locally (idempotent re-pull / dup). */
  duplicates: number;
  /** Mission-status transitions applied to a local row via LWW (collab store, m04). */
  transitionsApplied: number;
  /** Mission-status transitions that lost LWW to a newer local value, or had no
   *  local mission row yet — counted, not applied (collab store, m04). */
  transitionsSkipped: number;
  /** Transition events deferred (solo store, or not-yet-wired sprint/session). */
  transitionsDeferred: number;
  /** Genesis events skipped because required provenance was missing/malformed. */
  skippedMissingProvenance: number;
  /** Events with an unrecognized type — skipped. */
  skippedUnknownType: number;
  /** Genesis events whose local insert errored (e.g. FK) — isolated + counted. */
  failed: number;
  /** Newly-inserted count keyed by genesis event type. */
  insertedByType: Record<string, number>;
  message: string;
  warnings?: string[];
}

export async function syncPull(_params: SyncPullParams): Promise<RbookToolResult<SyncPullResult>> {
  return legacySyncRefusal('Dashboard event pull');
}

export function formatSyncPullForLLM(result: RbookToolResult<SyncPullResult>): string {
  if (!result.success) {
    const lines = [`PULL failed: ${result.error?.message ?? 'Unknown error'}`];
    if (result.error?.suggestion) lines.push(`Suggestion: ${result.error.suggestion}`);
    appendWarnings(lines, result);
    return lines.join('\n');
  }
  const d = result.data!;
  const lines = [
    `PULL complete (${d.slug})`,
    '',
    d.message,
    '',
    `Inserted: ${d.inserted} (${
      Object.entries(d.insertedByType)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ') || 'none'
    })`,
    `Duplicates: ${d.duplicates} | Transitions: ${d.transitionsApplied} applied, ` +
      `${d.transitionsSkipped} skipped, ${d.transitionsDeferred} deferred`,
  ];
  if (d.skippedMissingProvenance > 0 || d.skippedUnknownType > 0 || d.failed > 0) {
    lines.push(
      `Skipped: ${d.skippedMissingProvenance} no-provenance, ${d.skippedUnknownType} unknown-type, ${d.failed} failed`
    );
  }
  if (d.warnings && d.warnings.length > 0) {
    lines.push('', ...d.warnings.map((w) => `⚠ ${w}`));
  }
  appendWarnings(lines, result);

  return lines.join('\n');
}
