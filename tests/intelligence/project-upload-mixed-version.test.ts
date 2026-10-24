// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Published 4.5.0 claim and finish SQL cannot leave new recovery metadata authoritative.
// ABOUTME: Real registry rows exercise old success, old auth failure and same-millisecond overlap.

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as state from '../../src/intelligence/project-upload-state';
import { readUploadNotice } from '../../src/tools/rbook/dashboard-upload-notice';

let db: Database.Database;
let directory: string;
let root: string;
let now: number;
beforeEach(() => {
  now = Date.now();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-upload-mixed-'));
  root = path.join(directory, 'project');
  fs.mkdirSync(root);
  db = new Database(path.join(directory, 'project-graph.sqlite'));
  db.exec(
    'CREATE TABLE projects(project_id TEXT PRIMARY KEY, store_path TEXT, archived_at INTEGER, last_synced_at INTEGER)'
  );
  db.prepare('INSERT INTO projects(project_id,store_path) VALUES(?,?)').run('one', root);
  state.ensureUploadColumns(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

/** The published 4.5.0 statements, including fields its success deliberately does not update. */
function oldClaim(clock: number): state.UploadLease {
  const token = randomUUID();
  const row = db
    .prepare(
      `UPDATE projects SET upload_lease_token = ?,
    upload_lease_expires_at = ?, upload_last_attempt_at = ?, upload_last_outcome = 'uploading',
    upload_first_after_claim_at = NULL
    WHERE project_id = ? AND archived_at IS NULL
    AND (upload_lease_token IS NULL OR COALESCE(upload_lease_expires_at,0) <= ?)
    AND (? = 1 OR (COALESCE(upload_blocked,0) = 0 AND upload_first_owed_at IS NOT NULL
      AND (upload_latest_write_at <= ? OR upload_first_owed_at <= ?)))
    RETURNING COALESCE(upload_generation,0) AS generation`
    )
    .get(
      token,
      clock + state.UPLOAD_LEASE_MS,
      clock,
      'one',
      clock,
      1,
      clock - state.UPLOAD_QUIET_MS,
      clock - state.UPLOAD_MAX_WAIT_MS
    ) as { generation: number };
  return { token, generation: row.generation };
}

function oldFinish(
  lease: state.UploadLease,
  clock: number,
  outcome: { success: boolean; error?: string; blocked?: boolean }
): boolean {
  return (
    db
      .prepare(
        `UPDATE projects SET upload_lease_token = NULL,
    upload_lease_expires_at = NULL, upload_last_outcome = ?, upload_last_error = ?,
    upload_blocked = CASE WHEN ? = 1 THEN 0 WHEN ? = 1 THEN 1 ELSE upload_blocked END,
    last_synced_at = CASE WHEN ? = 1 THEN ? ELSE last_synced_at END,
    upload_first_owed_at = CASE WHEN ? = 1 THEN CASE WHEN upload_generation = ? THEN NULL
      ELSE COALESCE(upload_first_after_claim_at,upload_first_owed_at) END ELSE upload_first_owed_at END,
    upload_first_after_claim_at = NULL,
    upload_latest_write_at = CASE WHEN ? = 1 AND upload_generation = ? THEN NULL ELSE upload_latest_write_at END
    WHERE project_id = ? AND upload_lease_token = ? AND upload_lease_expires_at > ?`
      )
      .run(
        outcome.success ? 'success' : 'failed',
        outcome.success ? null : (outcome.error ?? 'Unknown error').slice(0, 500),
        outcome.success ? 1 : 0,
        outcome.blocked ? 1 : 0,
        outcome.success ? 1 : 0,
        clock,
        outcome.success ? 1 : 0,
        lease.generation,
        outcome.success ? 1 : 0,
        lease.generation,
        'one',
        lease.token,
        clock
      ).changes > 0
  );
}

it.each([false, true])(
  'an old success then auth failure discards stale forbidden metadata (same millisecond: %s)',
  (sameTime) => {
    state.markUploadOwed(db, 'one', now, true);
    const candidate = state.claimUpload(db, 'one', now, true)!;
    state.finishUpload(db, 'one', candidate, now, {
      success: false,
      pauseReason: 'forbidden',
      error: 'HTTP 403',
    });
    const clock = sameTime ? now : now + 1000;
    expect(oldFinish(oldClaim(clock), clock, { success: true })).toBe(true);
    expect(state.readUploadState(db, 'one')?.pauseReason).toBeNull();
    state.markUploadOwed(db, 'one', clock);
    expect(
      oldFinish(oldClaim(clock), clock, { success: false, error: 'HTTP 401', blocked: true })
    ).toBe(true);
    expect(state.readUploadState(db, 'one')).toMatchObject({
      blocked: true,
      pauseReason: 'auth',
      nextCheckAt: null,
      authFirstFailedAt: null,
      nextAttemptAt: null,
    });
    expect(
      readUploadNotice(root, { env: { ...process.env, RBOOK_CONFIG_DIR: directory } })?.state
        .pauseReason
    ).toBe('auth');
    const probe = state.claimUploadProbe(db, 'one', clock + 1)!;
    expect(probe).not.toBeNull();
    expect(state.finishUploadProbe(db, 'one', probe, clock + 2, { recovered: true })).toBe(true);
    expect(state.claimUpload(db, 'one', clock + 3, false)).not.toBeNull();
  }
);

it('an old auth failure can replace the legacy verdict without an intervening success', () => {
  const candidate = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', candidate, now, {
    success: false,
    pauseReason: 'forbidden',
    error: 'HTTP 403',
  });
  oldFinish(oldClaim(now), now, { success: false, error: 'HTTP 401', blocked: true });
  expect(state.readUploadState(db, 'one')?.pauseReason).toBe('auth');
  expect(state.claimUploadProbe(db, 'one', now)).not.toBeNull();
});

it('a current deterministic hold survives a candidate transient failure and keeps its authority', () => {
  const first = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', first, now, {
    success: false,
    pauseReason: 'forbidden',
    error: 'HTTP 403',
  });
  const next = state.claimUpload(db, 'one', now + 1, true)!;
  state.finishUpload(db, 'one', next, now + 2, { success: false, error: 'HTTP 503' });
  expect(state.readUploadState(db, 'one')?.pauseReason).toBe('forbidden');
  expect(state.claimUploadProbe(db, 'one', now + 7200000)).toBeNull();
});

it('the additive nullable marker matches actual legacy result columns after a candidate finish', () => {
  const column = db
    .prepare('PRAGMA table_info(projects)')
    .all()
    .find((row: unknown) => (row as { name: string }).name === 'upload_recovery_state');
  expect(column).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null });
  expect(db.prepare('SELECT upload_recovery_state AS stamp FROM projects').get()).toEqual({
    stamp: null,
  });
  const lease = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', lease, now, {
    success: false,
    pauseReason: 'forbidden',
    error: 'HTTP 403: "quoted"\n☀',
  });
  const row = db
    .prepare(
      `SELECT upload_recovery_state AS stamp, upload_last_attempt_at AS attempted,
    upload_last_outcome AS outcome, upload_last_error AS error, last_synced_at AS synced,
    upload_blocked AS blocked FROM projects`
    )
    .get() as {
    stamp: string;
    attempted: number;
    outcome: string;
    error: string;
    synced: null;
    blocked: number;
  };
  expect(JSON.parse(row.stamp)).toEqual([
    row.attempted,
    row.outcome,
    row.error,
    row.synced,
    row.blocked,
  ]);
  expect(state.readUploadState(db, 'one')?.pauseReason).toBe('forbidden');
});

it('an old write during a candidate probe fences that probe from changing the newer result', () => {
  const lease = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', lease, now, {
    success: false,
    pauseReason: 'auth',
    error: 'HTTP 401',
  });
  const probe = state.claimUploadProbe(db, 'one', now + state.UPLOAD_PROBE_MS)!;
  expect(probe).not.toBeNull();
  oldFinish(oldClaim(now + state.UPLOAD_PROBE_MS), now + state.UPLOAD_PROBE_MS, {
    success: false,
    error: 'HTTP 403',
    blocked: true,
  });
  expect(
    state.finishUploadProbe(db, 'one', probe, now + state.UPLOAD_PROBE_MS + 1, { recovered: true })
  ).toBe(false);
  expect(state.readUploadState(db, 'one')?.pauseReason).toBe('forbidden');
});
