// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Normalize upload recovery only when it belongs to the legacy fields last written.
// ABOUTME: Older clients change those fields without the marker; their errors regain authority.

import type Database from 'better-sqlite3';
import type { UploadPauseReason, UploadState } from './project-upload-state';

export interface StoredUploadState extends Omit<UploadState, 'blocked'> {
  readonly blocked: boolean | number;
  readonly recoveryStamp?: string | null;
}

export const UPLOAD_STAMP_SQL =
  'json_array(upload_last_attempt_at,upload_last_outcome,upload_last_error,last_synced_at,COALESCE(upload_blocked,0))';

export const REGISTRATION_CONFLICT_PREFIX = 'Registration refused: ';

/** A collision needs its three recovery choices after the detached upload has ended. */
export function boundUploadError(error: string, ordinaryLimit = 500): string {
  return error.slice(0, error.startsWith(REGISTRATION_CONFLICT_PREFIX) ? 2000 : ordinaryLimit);
}

export function normalizeUploadState(row: StoredUploadState): UploadState {
  const { recoveryStamp, ...state } = row;
  const blocked = Boolean(state.blocked);
  const current =
    recoveryStamp ===
    JSON.stringify([
      state.lastAttemptAt,
      state.lastOutcome,
      state.lastError,
      state.lastSyncedAt,
      blocked ? 1 : 0,
    ]);
  return {
    ...state,
    blocked,
    pauseReason: blocked
      ? ((current ? state.pauseReason : null) ?? legacyUploadPause(state.lastError))
      : null,
    pausedAt: blocked ? ((current ? state.pausedAt : null) ?? state.lastAttemptAt) : null,
    nextCheckAt: current ? state.nextCheckAt : null,
    authFirstFailedAt: current ? state.authFirstFailedAt : null,
    failureCount: current ? state.failureCount : 0,
    nextAttemptAt: current ? state.nextAttemptAt : null,
  };
}

/** A different cause starts its own notice window; repeated evidence retains the existing one. */
export function pauseStartedAt(
  reason: UploadPauseReason | null,
  state: UploadState,
  now: number
): number | null {
  return reason ? (reason === state.pauseReason ? (state.pausedAt ?? now) : now) : null;
}

export function legacyUploadPause(error: string | null): UploadPauseReason {
  if (/402|upgrade|tier|subscription/i.test(error ?? '')) return 'tier';
  if (/403|forbidden/i.test(error ?? '')) return 'forbidden';
  return 'auth';
}

export function readUploadState(db: Database.Database, id: string): UploadState | null {
  const row = db
    .prepare(
      `SELECT upload_first_owed_at AS firstOwedAt,
    upload_latest_write_at AS latestWriteAt, COALESCE(upload_generation,0) AS generation,
    upload_explicit_generation AS explicitGeneration, upload_lease_holder AS leaseHolder,
    upload_lease_token AS leaseToken, upload_lease_expires_at AS leaseExpiresAt,
    upload_last_attempt_at AS lastAttemptAt, upload_last_outcome AS lastOutcome,
    upload_last_error AS lastError, last_synced_at AS lastSyncedAt,
    COALESCE(upload_blocked,0) AS blocked, upload_pause_reason AS pauseReason,
    upload_paused_at AS pausedAt, upload_next_check_at AS nextCheckAt,
    upload_recovery_state AS recoveryStamp,
    upload_auth_first_failed_at AS authFirstFailedAt,
    COALESCE(upload_failure_count,0) AS failureCount, upload_next_attempt_at AS nextAttemptAt
    FROM projects WHERE project_id = ? AND archived_at IS NULL`
    )
    .get(id) as StoredUploadState | undefined;
  return row ? normalizeUploadState(row) : null;
}
