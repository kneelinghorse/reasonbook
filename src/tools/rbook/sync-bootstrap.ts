// ABOUTME: Retains the retired dashboard clone action and response types until the 5.0 compatibility removal.
// ABOUTME: Cloning an incomplete dashboard snapshot refuses before credentials or writes; shared records use reasonbook sync.

import type { RbookToolResult } from './types';
import { appendWarnings } from './format-warnings';
import { legacySyncRefusal } from './legacy-sync-refusal';

export interface SyncBootstrapParams {
  projectRoot?: string;
  /** Dashboard slug to clone. Defaults to metadata.dashboard_slug. */
  slug?: string;
}

export interface SyncBootstrapResult {
  slug: string;
  /** The project_id stamped onto every cloned row (cross-store aggregation key). */
  projectId: string;
  /** The per-project PULL cursor seeded from the snapshot's syncLog.maxCursor. */
  cursorSeeded: number;
  /** Rows newly inserted (ON CONFLICT no-op excluded). */
  inserted: number;
  /** Rows already present locally (idempotent re-clone). */
  duplicates: number;
  /** Rows whose local insert errored (e.g. NOT NULL on a migrated store) — counted. */
  failed: number;
  /** Newly-inserted count keyed by genesis event type. */
  insertedByType: Record<string, number>;
  /** Context rows created to satisfy FK integrity (bodies NOT cloned from /state). */
  contextsEnsured: number;
  message: string;
  warnings?: string[];
}

export async function syncBootstrap(
  _params: SyncBootstrapParams
): Promise<RbookToolResult<SyncBootstrapResult>> {
  return legacySyncRefusal('Dashboard snapshot clone');
}

export function formatSyncBootstrapForLLM(result: RbookToolResult<SyncBootstrapResult>): string {
  if (!result.success) {
    const lines = [`Clone failed: ${result.error?.message ?? 'Unknown error'}`];
    if (result.error?.suggestion) lines.push(`Suggestion: ${result.error.suggestion}`);
    appendWarnings(lines, result);
    return lines.join('\n');
  }
  const d = result.data!;
  const lines = [
    `Clone complete (${d.slug})`,
    '',
    d.message,
    '',
    `Inserted: ${d.inserted} (${
      Object.entries(d.insertedByType)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ') || 'none'
    })`,
    `Duplicates: ${d.duplicates} | Cursor seeded: ${d.cursorSeeded} | Contexts ensured: ${d.contextsEnsured}`,
  ];
  if (d.failed > 0) {
    lines.push(`Failed: ${d.failed}`);
  }
  if (d.warnings && d.warnings.length > 0) {
    lines.push('', ...d.warnings.map((w) => `⚠ ${w}`));
  }
  appendWarnings(lines, result);

  return lines.join('\n');
}
