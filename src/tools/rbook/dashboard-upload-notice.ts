// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read dashboard upload notices without registry migration or the MCP server's import graph.
// ABOUTME: The registry owns upload state; only session-start notices count project sessions after a hold.

import Database from 'better-sqlite3';
import {
  boundUploadError,
  normalizeUploadState,
  type StoredUploadState,
} from '../../intelligence/project-upload-reader';
import { existsSync } from 'fs';
import * as path from 'path';
import { resolveConfigDirectory, resolveRecordPaths } from '../../intelligence/legacy-compat';
import { isSameDirectory } from '../../intelligence/resolution-policy';
import {
  legacyUploadPause,
  uploadLeaseIsLive,
  type UploadState,
} from '../../intelligence/project-upload-state';

export interface UploadNoticeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: number;
  readonly sessionStart?: boolean;
  readonly attentionOnly?: boolean;
}

export interface UploadNotice {
  readonly state: UploadState;
  readonly text: string;
}

const FIELDS: Readonly<Record<keyof UploadState, string>> = {
  firstOwedAt: 'upload_first_owed_at',
  latestWriteAt: 'upload_latest_write_at',
  generation: 'upload_generation',
  explicitGeneration: 'upload_explicit_generation',
  leaseToken: 'upload_lease_token',
  leaseHolder: 'upload_lease_holder',
  leaseExpiresAt: 'upload_lease_expires_at',
  lastAttemptAt: 'upload_last_attempt_at',
  lastOutcome: 'upload_last_outcome',
  lastError: 'upload_last_error',
  lastSyncedAt: 'last_synced_at',
  blocked: 'upload_blocked',
  pauseReason: 'upload_pause_reason',
  pausedAt: 'upload_paused_at',
  nextCheckAt: 'upload_next_check_at',
  authFirstFailedAt: 'upload_auth_first_failed_at',
  failureCount: 'upload_failure_count',
  nextAttemptAt: 'upload_next_attempt_at',
};

const instant = (value: number | null | undefined): string =>
  value == null ? 'unknown' : new Date(value).toISOString();

/** All callers use this wording; a lease that lost its holder is never reported as uploading. */
export function formatUploadNotice(state: UploadState, now = Date.now()): string | null {
  if (
    state.lastSyncedAt === null &&
    state.lastAttemptAt === null &&
    state.firstOwedAt === null &&
    state.lastOutcome === null &&
    state.lastError === null &&
    !state.blocked
  )
    return null;
  let text = `Dashboard upload: last success ${state.lastSyncedAt == null ? 'never' : instant(state.lastSyncedAt)}`;
  if (uploadLeaseIsLive(state, now)) {
    const holder = state.leaseHolder?.match(/^(.+):(\d+)@(.+)$/);
    const pid = holder?.[1] === state.leaseToken ? holder[2] : 'unknown';
    text += `; uploading since ${instant(state.lastAttemptAt)} (process ${pid})`;
  } else if (state.lastOutcome === 'uploading' || state.lastOutcome === 'interrupted') {
    text += `; interrupted at ${instant(state.lastAttemptAt)}; the next server retries the pending upload`;
  } else if (state.lastOutcome) text += `; ${state.lastOutcome}`;
  if (state.firstOwedAt != null) text += '; pending';
  if (state.blocked) {
    const reason = state.pauseReason ?? legacyUploadPause(state.lastError);
    text += `; automatic uploads paused since ${instant(state.pausedAt ?? state.lastAttemptAt)}; reason ${reason}`;
    if (reason === 'deleted' || reason === 'replaced')
      text +=
        '; closes and manual uploads are held; restoring this as a new project is not available in this version';
  }
  if (state.nextCheckAt != null) text += `; next check ${instant(state.nextCheckAt)}`;
  else if (state.authFirstFailedAt != null) text += '; credentials awaiting recheck';
  if (!state.blocked && state.authFirstFailedAt == null && state.nextAttemptAt != null)
    text += `; next automatic try ${instant(state.nextAttemptAt)}`;
  if (state.lastError && !state.blocked)
    text += `; ${boundUploadError(state.lastError.replace(/[\r\n\t]+/g, ' '), 120)}`;
  return `${text}.`;
}

function startsAfter(root: string, pausedAt: number): number {
  const file = resolveRecordPaths(root).dbPath;
  if (!existsSync(file))
    throw new Error('Upload notice cannot count session starts: the project store is absent.');
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 50 });
  try {
    // The hook opens the next session at its first write; three already recorded starts exhaust the notice.
    return (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM sessions
      WHERE julianday(started_at) > julianday(?)`
        )
        .get(new Date(pausedAt).toISOString()) as { count: number }
    ).count;
  } finally {
    db.close();
  }
}

/** Missing or pre-upload registries have no notice. Reads never add a column, row or directory. */
export function readUploadNotice(
  root: string,
  options: UploadNoticeOptions = {}
): UploadNotice | null {
  const file = path.join(resolveConfigDirectory(options.env), 'project-graph.sqlite');
  if (!existsSync(file)) return null;
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 50 });
  let state: UploadState;
  try {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(projects)').all() as Array<{ name: string }>).map(
        (row) => row.name
      )
    );
    if (!columns.has('store_path') || ![...columns].some((name) => name.startsWith('upload_')))
      return null;
    const projection = Object.entries(FIELDS)
      .map(([alias, column]) => {
        const fallback = ['generation', 'failureCount', 'blocked'].includes(alias) ? '0' : 'NULL';
        return `${columns.has(column) ? `COALESCE(${column},${fallback})` : fallback} AS ${alias}`;
      })
      .join(', ');
    const stamp = columns.has('upload_recovery_state') ? 'upload_recovery_state' : 'NULL';
    const rows = db
      .prepare(
        `SELECT store_path, ${projection}, ${stamp} AS recoveryStamp FROM projects${columns.has('archived_at') ? ' WHERE archived_at IS NULL' : ''}`
      )
      .all() as Array<StoredUploadState & { store_path: string }>;
    const row = rows.find((entry) => isSameDirectory(entry.store_path, root));
    if (!row) return null;
    state = normalizeUploadState(row);
  } finally {
    db.close();
  }
  const now = options.now ?? Date.now();
  if (
    options.sessionStart &&
    (state.pauseReason === 'deleted' || state.pauseReason === 'replaced') &&
    state.pausedAt !== null &&
    startsAfter(root, state.pausedAt) >= 3
  )
    return null;
  if (
    options.attentionOnly &&
    !state.blocked &&
    state.lastOutcome !== 'failed' &&
    state.lastOutcome !== 'interrupted' &&
    !(state.lastOutcome === 'uploading' && !uploadLeaseIsLive(state, now)) &&
    (state.firstOwedAt === null || now - state.firstOwedAt <= 30 * 60_000)
  )
    return null;
  const text = formatUploadNotice(state, now);
  return text ? { state, text } : null;
}
