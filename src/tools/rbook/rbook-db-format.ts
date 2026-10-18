// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The text answer of each rbook_db action, kept apart from the tool's dispatch (s96-m12) so each module
// ABOUTME: stays small; the shared record's conflicts and settle answers list what they name.

import { appendWarnings } from './format-warnings';
import type { RbookToolResult } from './types';
import type { RbookDbResult } from './rbook-db';
import { formatHealthForLLM, type RbookDbHealthResult } from './rbook-db-health';
import { formatDbSnapshotForLLM, type RbookDbSnapshotResult } from './rbook-db-snapshot';
import { formatDbRestoreForLLM, type RbookDbRestoreResult } from './rbook-db-restore';
import {
  formatBackfillForLLM,
  formatPgOrphanReportForLLM,
  formatPurgeForLLM,
  formatReconciliationForLLM,
  type PgOrphanReport,
  type PurgeResult,
  type RbookDbBackfillResult,
  type ReconciliationResult,
} from './rbook-db-backfill';
import { formatSyncPullForLLM, type SyncPullResult } from './sync-pull';
import { formatSyncBootstrapForLLM, type SyncBootstrapResult } from './sync-bootstrap';
import {
  formatPruneSnapshotsForLLM,
  type RbookDbPruneSnapshotsResult,
} from './rbook-db-prune-snapshots';
import {
  formatConflictsForLLM,
  formatSettleForLLM,
  type RbookDbConflictsResult,
  type RbookDbSettleResult,
} from './rbook-db-conflicts';

export function formatDbForLLM(
  action: string | undefined,
  result: RbookToolResult<RbookDbResult>
): string {
  if (!result.success && result.error?.code === 'INVALID_ACTION') {
    const availableActions =
      result.error.availableActions ??
      result.error.available_actions ??
      result.error.validValues ??
      [];

    const lines = ['❌ Failed to execute rbook_db', '', `Error: ${result.error.message}`];

    if (availableActions.length > 0) {
      lines.push('');
      lines.push(`Available actions: ${availableActions.join(', ')}`);
    }

    if (result.error.suggestion) {
      lines.push('');
      lines.push(`Suggestion: ${result.error.suggestion}`);
    }

    return lines.join('\n');
  }

  switch (action) {
    case 'health':
      return formatHealthForLLM(result as RbookToolResult<RbookDbHealthResult>);
    case 'snapshot':
      return formatDbSnapshotForLLM(result as RbookToolResult<RbookDbSnapshotResult>);
    case 'restore':
      return formatDbRestoreForLLM(result as RbookToolResult<RbookDbRestoreResult>);
    case 'backfill':
      return formatBackfillForLLM(result as RbookToolResult<RbookDbBackfillResult>);
    case 'reconcile':
      return formatReconciliationForLLM(result as RbookToolResult<ReconciliationResult>);
    case 'purge':
      return formatPurgeForLLM(result as RbookToolResult<PurgeResult>);
    case 'identify_orphans':
      return formatPgOrphanReportForLLM(result as RbookToolResult<PgOrphanReport>);
    case 'pull':
      return formatSyncPullForLLM(result as RbookToolResult<SyncPullResult>);
    case 'clone':
      return formatSyncBootstrapForLLM(result as RbookToolResult<SyncBootstrapResult>);
    case 'prune_snapshots':
      return formatPruneSnapshotsForLLM(result as RbookToolResult<RbookDbPruneSnapshotsResult>);
    case 'conflicts':
      return formatConflictsForLLM(result as RbookToolResult<RbookDbConflictsResult>);
    case 'settle':
      return formatSettleForLLM(result as RbookToolResult<RbookDbSettleResult>);
    default: {
      if (!result.success) return '❌ Failed to execute rbook_db';
      const lines = ['✓ Database action completed'];
      appendWarnings(lines, result);
      return lines.join('\n');
    }
  }
}
