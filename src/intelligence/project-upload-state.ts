// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Registry-owned dashboard upload debt, leases and recovery shared by server processes.
// ABOUTME: Token-bound holders fence completion; generations preserve raced writes and explicit debt.

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { legacyUploadPause, readUploadState, UPLOAD_STAMP_SQL } from './project-upload-reader';
import { boundUploadError, pauseStartedAt } from './project-upload-reader';
export { legacyUploadPause, readUploadState } from './project-upload-reader';

export const UPLOAD_QUIET_MS = 5 * 60_000;
export const UPLOAD_MAX_WAIT_MS = 30 * 60_000;
export const UPLOAD_LEASE_MS = 5 * 60_000;
export const UPLOAD_PROBE_MS = 60 * 60_000;
export const UPLOAD_AUTH_RECHECK_MS = 15 * 60_000;
export type UploadPauseReason =
  | 'auth'
  | 'project-key'
  | 'forbidden'
  | 'tier'
  | 'deleted'
  | 'replaced';

export interface UploadState {
  readonly firstOwedAt: number | null;
  readonly latestWriteAt: number | null;
  readonly generation: number;
  readonly explicitGeneration: number | null;
  readonly leaseToken: string | null;
  readonly leaseHolder: string | null;
  readonly leaseExpiresAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly lastOutcome: string | null;
  readonly lastError: string | null;
  readonly lastSyncedAt: number | null;
  readonly blocked: boolean;
  readonly pauseReason: UploadPauseReason | null;
  readonly pausedAt: number | null;
  readonly nextCheckAt: number | null;
  readonly authFirstFailedAt: number | null;
  readonly failureCount: number;
  readonly nextAttemptAt: number | null;
}

export interface UploadLease {
  readonly token: string;
  readonly generation: number;
}

export interface UploadOutcome {
  readonly success: boolean;
  readonly error?: string;
  readonly blocked?: boolean;
  readonly pauseReason?: UploadPauseReason | null;
  readonly interrupted?: boolean;
  readonly retryAfterMs?: number;
  readonly authFirstFailedAt?: number | null;
}

export interface UploadProbeOutcome {
  readonly recovered: boolean;
  readonly pauseReason?: UploadPauseReason;
  readonly authFirstFailedAt?: number | null;
  readonly retryAfterMs?: number;
  readonly error?: string;
}

const COLUMNS: Readonly<Record<string, string>> = {
  upload_first_owed_at: 'INTEGER',
  upload_latest_write_at: 'INTEGER',
  upload_first_after_claim_at: 'INTEGER',
  upload_generation: 'INTEGER NOT NULL DEFAULT 0',
  upload_explicit_generation: 'INTEGER',
  upload_lease_token: 'TEXT',
  upload_lease_holder: 'TEXT',
  upload_lease_expires_at: 'INTEGER',
  upload_last_attempt_at: 'INTEGER',
  upload_last_outcome: 'TEXT',
  upload_last_error: 'TEXT',
  upload_blocked: 'INTEGER NOT NULL DEFAULT 0',
  upload_pause_reason: 'TEXT',
  upload_recovery_state: 'TEXT',
  upload_paused_at: 'INTEGER',
  upload_next_check_at: 'INTEGER',
  upload_auth_first_failed_at: 'INTEGER',
  upload_failure_count: 'INTEGER NOT NULL DEFAULT 0',
  upload_next_attempt_at: 'INTEGER',
};

/** Race-safe additive migration: only a proved concurrent addition may suppress an ALTER error. */
export function ensureUploadColumns(db: Database.Database): void {
  const names = (): Set<string> =>
    new Set(
      (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    );
  const existing = names();
  for (const [name, type] of Object.entries(COLUMNS)) {
    if (existing.has(name)) continue;
    try {
      db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${type}`);
    } catch (error) {
      if (!names().has(name)) throw error;
    }
  }
}

export function markUploadOwed(
  db: Database.Database,
  id: string,
  now: number,
  explicit = false
): boolean {
  return (
    db
      .prepare(
        `UPDATE projects SET
    upload_first_owed_at = COALESCE(upload_first_owed_at, ?), upload_latest_write_at = ?,
    upload_first_after_claim_at = CASE WHEN upload_lease_token IS NOT NULL
      THEN COALESCE(upload_first_after_claim_at, ?) ELSE upload_first_after_claim_at END,
    upload_explicit_generation = CASE WHEN ? = 1 THEN COALESCE(upload_generation,0) + 1
      ELSE upload_explicit_generation END,
    upload_generation = COALESCE(upload_generation,0) + 1
    WHERE project_id = ? AND archived_at IS NULL`
      )
      .run(now, now, now, explicit ? 1 : 0, id).changes > 0
  );
}

/** Only ESRCH for the token's own local process proves death; old and foreign leases wait out. */
export function uploadLeaseIsLive(state: UploadState, now: number): boolean {
  if (!state.leaseToken || (state.leaseExpiresAt ?? 0) <= now) return false;
  const holder = state.leaseHolder?.match(/^(.+):(\d+)@(.+)$/);
  if (!holder || holder[1] !== state.leaseToken || holder[3] !== hostname()) return true;
  const pid = Number(holder[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function claimUpload(
  db: Database.Database,
  id: string,
  now: number,
  explicit: boolean
): UploadLease | null {
  return db
    .transaction(() => {
      const seen = readUploadState(db, id);
      const deadToken = seen && !uploadLeaseIsLive(seen, now) ? seen.leaseToken : null;
      if (!seen) return null;
      const token = randomUUID();
      // The holder and token change together; the dead-holder branch is a compare-and-swap.
      const row = db
        .prepare(
          `UPDATE projects SET upload_lease_token = @token,
    upload_lease_holder = @holder, upload_lease_expires_at = @expiry,
    upload_last_attempt_at = @now, upload_last_outcome = 'uploading',
    upload_first_after_claim_at = NULL, upload_next_check_at = NULL,
    upload_pause_reason = @reason, upload_paused_at = @paused,
    upload_auth_first_failed_at = @auth, upload_next_attempt_at = @nextAttempt,
    upload_failure_count = @failures,
    upload_recovery_state = json_array(CAST(@now AS INTEGER),'uploading',upload_last_error,last_synced_at,COALESCE(upload_blocked,0))
    WHERE project_id = @id AND archived_at IS NULL
    AND (upload_lease_token IS NULL OR COALESCE(upload_lease_expires_at,0) <= @now
      OR (upload_lease_token = @deadToken AND upload_lease_holder IS @seenHolder))
    AND COALESCE(@reason,'') NOT IN ('deleted','replaced')
    AND (@explicit = 1 OR (COALESCE(upload_blocked,0) = 0 AND upload_first_owed_at IS NOT NULL
      AND @auth IS NULL AND COALESCE(@nextAttempt,0) <= @now
      AND (upload_lease_token = @deadToken OR upload_explicit_generation IS NOT NULL OR upload_latest_write_at <= @quiet
        OR upload_first_owed_at <= @ceiling)))
    RETURNING COALESCE(upload_generation,0) AS generation`
        )
        .get({
          token,
          reason: seen.pauseReason,
          paused: seen.pausedAt,
          auth: seen.authFirstFailedAt,
          nextAttempt: seen.nextAttemptAt,
          failures: seen.failureCount,
          holder: `${token}:${process.pid}@${hostname()}`,
          expiry: now + UPLOAD_LEASE_MS,
          now,
          id,
          deadToken,
          seenHolder: seen?.leaseHolder ?? null,
          explicit: explicit ? 1 : 0,
          quiet: now - UPLOAD_QUIET_MS,
          ceiling: now - UPLOAD_MAX_WAIT_MS,
        }) as { generation: number } | undefined;
      return row ? { token, generation: row.generation } : null;
    })
    .immediate();
}

export function renewUploadLease(
  db: Database.Database,
  id: string,
  token: string,
  now: number
): boolean {
  const result = db
    .prepare(
      `UPDATE projects SET upload_lease_expires_at = ?
    WHERE project_id = ? AND upload_lease_token = ? AND upload_lease_expires_at > ?
    AND archived_at IS NULL`
    )
    .run(now + UPLOAD_LEASE_MS, id, token, now);
  return result.changes > 0;
}

function retryDelay(failureCount: number, retryAfterMs = 0): number {
  const step = [1, 5, 15, 60][Math.min(failureCount, 3)] * 60_000;
  return Math.max(step, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
}

/** Failure preserves debt; interruption may release an expired lease but never a replacement. */
export function finishUpload(
  db: Database.Database,
  id: string,
  lease: UploadLease,
  now: number,
  outcome: UploadOutcome
): boolean {
  return db
    .transaction(() => {
      const previous = readUploadState(db, id);
      if (
        !previous ||
        previous.leaseToken !== lease.token ||
        (!outcome.interrupted && (previous.leaseExpiresAt ?? 0) <= now)
      )
        return false;
      const reset = outcome.success || outcome.interrupted;
      const recovered =
        outcome.pauseReason === null &&
        (!previous.pauseReason || ['auth', 'project-key'].includes(previous.pauseReason));
      const reason =
        reset || recovered
          ? null
          : (outcome.pauseReason ??
            (outcome.blocked ? legacyUploadPause(outcome.error ?? null) : previous.pauseReason));
      const auth =
        reset || recovered
          ? null
          : outcome.authFirstFailedAt === undefined
            ? previous.authFirstFailedAt
            : outcome.authFirstFailedAt;
      const nextCheck =
        reason === 'auth' || reason === 'project-key'
          ? now + UPLOAD_PROBE_MS
          : reason || auth === null
            ? null
            : auth + UPLOAD_AUTH_RECHECK_MS;
      return (
        db
          .prepare(
            `UPDATE projects SET upload_lease_token = NULL, upload_lease_holder = NULL,
      upload_lease_expires_at = NULL, upload_last_outcome = @outcome, upload_last_error = @error,
      upload_blocked = @blocked, upload_pause_reason = @reason, upload_paused_at = @paused,
      upload_auth_first_failed_at = @auth, upload_next_check_at = @nextCheck,
      upload_failure_count = @failures, upload_next_attempt_at = @nextAttempt,
      upload_recovery_state = json_array(upload_last_attempt_at,@outcome,@error,CASE WHEN @success=1 THEN CAST(@now AS INTEGER) ELSE last_synced_at END,CAST(@blocked AS INTEGER)),
      last_synced_at = CASE WHEN @success = 1 THEN @now ELSE last_synced_at END,
      upload_first_owed_at = CASE WHEN @success = 1 THEN CASE WHEN upload_generation = @generation THEN NULL
        ELSE COALESCE(upload_first_after_claim_at,upload_first_owed_at) END ELSE upload_first_owed_at END,
      upload_first_after_claim_at = NULL,
      upload_explicit_generation = CASE WHEN @success = 1 AND upload_explicit_generation <= @generation
        THEN NULL ELSE upload_explicit_generation END,
      upload_latest_write_at = CASE WHEN @success = 1 AND upload_generation = @generation THEN NULL ELSE upload_latest_write_at END
      WHERE project_id = @id AND upload_lease_token = @token`
          )
          .run({
            outcome: outcome.success ? 'success' : outcome.interrupted ? 'interrupted' : 'failed',
            error: outcome.success
              ? null
              : boundUploadError(
                  outcome.error ?? (outcome.interrupted ? 'Upload interrupted.' : 'Unknown error')
                ),
            blocked: reason ? 1 : 0,
            reason,
            paused: pauseStartedAt(reason, previous, now),
            auth,
            nextCheck,
            failures: reset ? 0 : previous.failureCount + 1,
            nextAttempt: reset
              ? null
              : now + retryDelay(previous.failureCount, outcome.retryAfterMs),
            success: outcome.success ? 1 : 0,
            now,
            generation: lease.generation,
            id,
            token: lease.token,
          }).changes > 0
      );
    })
    .immediate();
}

/** The returned claim time fences completion; the next-check CAS admits only one hourly prober. */
export function claimUploadProbe(db: Database.Database, id: string, now: number): number | null {
  return db
    .transaction(() => {
      const state = readUploadState(db, id);
      if (
        !state ||
        uploadLeaseIsLive(state, now) ||
        (state.pauseReason !== null && !['auth', 'project-key'].includes(state.pauseReason)) ||
        (!state.blocked && state.authFirstFailedAt === null) ||
        (state.nextCheckAt ?? 0) > now
      )
        return null;
      return db
        .prepare(
          `UPDATE projects SET upload_next_check_at = @nextCheck, upload_pause_reason = @reason,
      upload_paused_at = @paused, upload_auth_first_failed_at = @auth,
      upload_next_attempt_at = @nextAttempt, upload_failure_count = @failures,
      upload_recovery_state = ${UPLOAD_STAMP_SQL}
      WHERE project_id = @id AND (upload_next_check_at IS @previousCheck
        OR upload_recovery_state IS NOT ${UPLOAD_STAMP_SQL}) AND archived_at IS NULL`
        )
        .run({
          nextCheck: now + UPLOAD_PROBE_MS,
          id,
          previousCheck: state.nextCheckAt,
          reason: state.pauseReason,
          paused: state.pausedAt,
          auth: state.authFirstFailedAt,
          nextAttempt: state.nextAttemptAt,
          failures: state.failureCount,
        }).changes
        ? now
        : null;
    })
    .immediate();
}

/** A successful probe clears only recoverable auth holds; terminal holds cannot be revived. */
export function finishUploadProbe(
  db: Database.Database,
  id: string,
  claimedAt: number,
  now: number,
  outcome: UploadProbeOutcome
): boolean {
  return db
    .transaction(() => {
      const state = readUploadState(db, id);
      if (
        !state ||
        state.nextCheckAt !== claimedAt + UPLOAD_PROBE_MS ||
        (state.pauseReason !== null && !['auth', 'project-key'].includes(state.pauseReason))
      )
        return false;
      const reason = outcome.recovered ? null : (outcome.pauseReason ?? state.pauseReason);
      const auth = outcome.recovered
        ? null
        : outcome.authFirstFailedAt === undefined
          ? state.authFirstFailedAt
          : outcome.authFirstFailedAt;
      const nextCheck =
        outcome.recovered || (reason && !['auth', 'project-key'].includes(reason))
          ? null
          : Math.max(claimedAt + UPLOAD_PROBE_MS, now + (outcome.retryAfterMs ?? 0));
      return (
        db
          .prepare(
            `UPDATE projects SET upload_blocked = @blocked, upload_pause_reason = @reason,
      upload_paused_at = @paused, upload_next_check_at = @nextCheck,
      upload_auth_first_failed_at = @auth, upload_last_error = @error,
      upload_recovery_state = json_array(upload_last_attempt_at,upload_last_outcome,@error,last_synced_at,CAST(@blocked AS INTEGER)),
      upload_next_attempt_at = CASE WHEN @recovered = 1 AND upload_next_attempt_at <= @now
        THEN NULL ELSE upload_next_attempt_at END
      WHERE project_id = @id AND upload_next_check_at = @claim`
          )
          .run({
            blocked: reason ? 1 : 0,
            reason,
            paused: pauseStartedAt(reason, state, now),
            nextCheck,
            auth,
            error: outcome.recovered
              ? null
              : boundUploadError(outcome.error ?? state.lastError ?? '') || null,
            recovered: outcome.recovered ? 1 : 0,
            now,
            id,
            claim: claimedAt + UPLOAD_PROBE_MS,
          }).changes > 0
      );
    })
    .immediate();
}
