// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Registry recovery preserves explicit upload debt across crashes and transient outages.
// ABOUTME: Token-bound holders and probe claims prevent stale processes from overriding newer work.

import Database from 'better-sqlite3';
import * as os from 'os';
import * as state from '../../src/intelligence/project-upload-state';

let db: Database.Database;
let now: number;
beforeEach(() => {
  now = Date.now();
  db = new Database(':memory:');
  db.exec(
    'CREATE TABLE projects(project_id TEXT PRIMARY KEY, archived_at INTEGER, last_synced_at INTEGER)'
  );
  db.prepare('INSERT INTO projects(project_id) VALUES (?)').run('one');
  state.ensureUploadColumns(db);
});
afterEach(() => {
  jest.restoreAllMocks();
  db.close();
});

function deadHolder(token: string): void {
  db.prepare('UPDATE projects SET upload_lease_holder=?').run(
    `${token}:123456789@${os.hostname()}`
  );
  jest.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('No process'), { code: 'ESRCH' });
  });
}

it('ties its process identity to the lease token in the claim', () => {
  const lease = state.claimUpload(db, 'one', now, true)!;
  expect(state.readUploadState(db, 'one')?.leaseHolder).toBe(
    `${lease.token}:${process.pid}@${os.hostname()}`
  );
});

it('recovers a dead local holder immediately without letting the old token complete', () => {
  state.markUploadOwed(db, 'one', now, true);
  const old = state.claimUpload(db, 'one', now, true)!;
  deadHolder(old.token);
  const replacement = state.claimUpload(db, 'one', now + 1, false)!;
  expect(replacement).not.toBeNull();
  expect(state.finishUpload(db, 'one', old, now + 2, { success: true })).toBe(false);
  expect(state.readUploadState(db, 'one')?.leaseToken).toBe(replacement.token);
});

it('does not steal an old-version lease beside a stale new-version holder', () => {
  const lease = state.claimUpload(db, 'one', now, true)!;
  deadHolder(lease.token);
  db.prepare('UPDATE projects SET upload_lease_token=?').run('old-version-token');
  expect(state.claimUpload(db, 'one', now + 1, true)).toBeNull();
  expect(state.uploadLeaseIsLive(state.readUploadState(db, 'one')!, now + 1)).toBe(true);
});

it.each(['EPERM', 'EACCES'])('treats %s as a live holder, never proof of death', (code) => {
  const lease = state.claimUpload(db, 'one', now, true)!;
  db.prepare('UPDATE projects SET upload_lease_holder=?').run(
    `${lease.token}:123456789@${os.hostname()}`
  );
  jest.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(code), { code });
  });
  expect(state.claimUpload(db, 'one', now + 1, true)).toBeNull();
});

it('does not probe a foreign host or an untied holder', () => {
  const lease = state.claimUpload(db, 'one', now, true)!;
  db.prepare('UPDATE projects SET upload_lease_holder=?').run(
    `${lease.token}:123456789@another-host`
  );
  const probe = jest.spyOn(process, 'kill');
  expect(state.claimUpload(db, 'one', now + 1, true)).toBeNull();
  expect(probe).not.toHaveBeenCalled();
});

it('an interrupted explicit upload retains debt that bypasses the quiet window', () => {
  state.markUploadOwed(db, 'one', now, true);
  const lease = state.claimUpload(db, 'one', now, true)!;
  expect(
    state.finishUpload(db, 'one', lease, now + state.UPLOAD_LEASE_MS + 1, {
      success: false,
      interrupted: true,
    })
  ).toBe(true);
  expect(state.readUploadState(db, 'one')).toMatchObject({
    explicitGeneration: 1,
    firstOwedAt: now,
    lastOutcome: 'interrupted',
    blocked: false,
  });
  expect(state.claimUpload(db, 'one', now + state.UPLOAD_LEASE_MS + 2, false)).not.toBeNull();
});

it('success cannot erase a later explicit request at the same timestamp', () => {
  state.markUploadOwed(db, 'one', now, true);
  const lease = state.claimUpload(db, 'one', now, true)!;
  state.markUploadOwed(db, 'one', now, true);
  state.finishUpload(db, 'one', lease, now + 1, { success: true });
  expect(state.readUploadState(db, 'one')?.explicitGeneration).toBe(2);
  const next = state.claimUpload(db, 'one', now + 2, false)!;
  state.finishUpload(db, 'one', next, now + 3, { success: true });
  expect(state.readUploadState(db, 'one')).toMatchObject({
    explicitGeneration: null,
    firstOwedAt: null,
  });
});

it('backs off explicit debt at 1, 5, 15 and 60 minutes, then stays capped', () => {
  state.markUploadOwed(db, 'one', now, true);
  let clock = now;
  for (const minutes of [1, 5, 15, 60, 60]) {
    const lease = state.claimUpload(db, 'one', clock, false)!;
    expect(lease).not.toBeNull();
    state.finishUpload(db, 'one', lease, clock + 1, {
      success: false,
      error: 'HTTP 503',
      retryAfterMs: 30000,
    });
    expect(state.readUploadState(db, 'one')?.nextAttemptAt).toBe(clock + 1 + minutes * 60000);
    expect(state.claimUpload(db, 'one', clock + minutes * 60000, false)).toBeNull();
    clock += 1 + minutes * 60000;
  }
  const success = state.claimUpload(db, 'one', clock, false)!;
  state.finishUpload(db, 'one', success, clock + 1, { success: true });
  expect(state.readUploadState(db, 'one')).toMatchObject({ failureCount: 0, nextAttemptAt: null });
});

it('honors a longer Retry-After while an explicit call can still try once now', () => {
  state.markUploadOwed(db, 'one', now, true);
  const lease = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', lease, now + 1, { success: false, retryAfterMs: 2 * 3600000 });
  expect(state.readUploadState(db, 'one')?.nextAttemptAt).toBe(now + 1 + 2 * 3600000);
  expect(state.claimUpload(db, 'one', now + 2, false)).toBeNull();
  expect(state.claimUpload(db, 'one', now + 2, true)).not.toBeNull();
});

it.each(['deleted', 'replaced'] as const)(
  '%s holds both explicit and automatic attempts',
  (pauseReason) => {
    state.markUploadOwed(db, 'one', now, true);
    const lease = state.claimUpload(db, 'one', now, true)!;
    state.finishUpload(db, 'one', lease, now + 1, { success: false, pauseReason });
    expect(state.claimUpload(db, 'one', now + 3600001, false)).toBeNull();
    expect(state.claimUpload(db, 'one', now + 3600001, true)).toBeNull();
    expect(state.claimUploadProbe(db, 'one', now + 3600001)).toBeNull();
  }
);

it('ignores a stale reason after an old process has cleared blocked', () => {
  db.exec(
    "UPDATE projects SET upload_blocked=0, upload_pause_reason='deleted', upload_paused_at=1"
  );
  expect(state.readUploadState(db, 'one')).toMatchObject({
    blocked: false,
    pauseReason: null,
    pausedAt: null,
  });
  expect(state.claimUpload(db, 'one', now, true)).not.toBeNull();
});

it.each([
  ['HTTP 401 authentication failed', 'auth'],
  ['HTTP 403 forbidden', 'forbidden'],
  ['HTTP 402 upgrade required', 'tier'],
])('classifies a legacy pause from %s', (error, reason) => {
  db.prepare(
    'UPDATE projects SET upload_blocked=1, upload_last_error=?, upload_last_attempt_at=?'
  ).run(error, now);
  expect(state.readUploadState(db, 'one')).toMatchObject({ pauseReason: reason, pausedAt: now });
});

it('a suspect key waits fifteen minutes for a probe without resending a whole store', () => {
  state.markUploadOwed(db, 'one', now, true);
  const lease = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', lease, now + 1, { success: false, authFirstFailedAt: now });
  expect(state.claimUpload(db, 'one', now + 60001, false)).toBeNull();
  expect(state.claimUploadProbe(db, 'one', now + 15 * 60000 - 1)).toBeNull();
  const claim = state.claimUploadProbe(db, 'one', now + 15 * 60000)!;
  expect(claim).not.toBeNull();
  expect(state.finishUploadProbe(db, 'one', claim, now + 15 * 60000 + 1, { recovered: true })).toBe(
    true
  );
  expect(state.claimUpload(db, 'one', now + 15 * 60000 + 2, false)).not.toBeNull();
});

it('only one hourly probe wins, and recovery clears a real pause without clearing debt', () => {
  state.markUploadOwed(db, 'one', now, true);
  const lease = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', lease, now + 1, {
    success: false,
    pauseReason: 'project-key',
    authFirstFailedAt: now - 15 * 60000,
  });
  const claim = state.claimUploadProbe(db, 'one', now + 3600001)!;
  expect(claim).not.toBeNull();
  expect(state.claimUploadProbe(db, 'one', now + 3600001)).toBeNull();
  expect(state.finishUploadProbe(db, 'one', claim, now + 3600002, { recovered: true })).toBe(true);
  expect(state.readUploadState(db, 'one')).toMatchObject({
    blocked: false,
    pauseReason: null,
    authFirstFailedAt: null,
    firstOwedAt: now,
    explicitGeneration: 1,
  });
  expect(state.claimUpload(db, 'one', now + 3600003, false)).not.toBeNull();
});

it('a stale probe cannot clear a later pause or a terminal hold', () => {
  state.markUploadOwed(db, 'one', now, true);
  const first = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', first, now + 1, { success: false, pauseReason: 'auth' });
  const stale = state.claimUploadProbe(db, 'one', now + 3600001)!;
  const current = state.claimUploadProbe(db, 'one', now + 7200001)!;
  expect(state.finishUploadProbe(db, 'one', stale, now + 7200002, { recovered: true })).toBe(false);
  expect(
    state.finishUploadProbe(db, 'one', current, now + 7200002, {
      recovered: false,
      pauseReason: 'replaced',
    })
  ).toBe(true);
  expect(state.finishUploadProbe(db, 'one', current, now + 7200003, { recovered: true })).toBe(
    false
  );
});

it('a transient probe preserves the held pause and waits another hour', () => {
  const lease = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', lease, now + 1, { success: false, pauseReason: 'auth' });
  const claim = state.claimUploadProbe(db, 'one', now + 3600001)!;
  state.finishUploadProbe(db, 'one', claim, now + 3600002, { recovered: false, error: 'HTTP 503' });
  expect(state.readUploadState(db, 'one')).toMatchObject({
    blocked: true,
    pauseReason: 'auth',
    nextCheckAt: now + 7200001,
  });
  expect(state.claimUploadProbe(db, 'one', now + 7200000)).toBeNull();
});

it('the dead-holder CAS cannot steal a replacement written during the liveness probe', () => {
  state.markUploadOwed(db, 'one', now, true);
  const lease = state.claimUpload(db, 'one', now, true)!;
  deadHolder(lease.token);
  jest.spyOn(process, 'kill').mockImplementation(() => {
    db.prepare('UPDATE projects SET upload_lease_token=?').run('older-version-claims-now');
    throw Object.assign(new Error('No process'), { code: 'ESRCH' });
  });
  expect(state.claimUpload(db, 'one', now + 1, false)).toBeNull();
  expect(state.readUploadState(db, 'one')?.leaseToken).toBe('older-version-claims-now');
});

it('a dead holder resumes pending work immediately even after a newer ordinary write', () => {
  state.markUploadOwed(db, 'one', now - state.UPLOAD_QUIET_MS);
  const lease = state.claimUpload(db, 'one', now, false)!;
  state.markUploadOwed(db, 'one', now);
  deadHolder(lease.token);
  expect(state.claimUpload(db, 'one', now + 1, false)).not.toBeNull();
});

it('migration failure before the table exists is loud and can be retried after creation', () => {
  const foreign = new Database(':memory:');
  try {
    expect(() => state.ensureUploadColumns(foreign)).toThrow('no such table');
    foreign.exec(
      'CREATE TABLE projects(project_id TEXT PRIMARY KEY, archived_at INTEGER, last_synced_at INTEGER, upload_generation INTEGER, upload_failure_count INTEGER, upload_blocked INTEGER)'
    );
    foreign.prepare('INSERT INTO projects(project_id) VALUES (?)').run('one');
    state.ensureUploadColumns(foreign);
    expect(state.readUploadState(foreign, 'one')).toMatchObject({
      generation: 0,
      failureCount: 0,
      blocked: false,
      explicitGeneration: null,
    });
    expect(state.markUploadOwed(foreign, 'one', now, true)).toBe(true);
    expect(state.claimUpload(foreign, 'one', now, false)?.generation).toBe(1);
  } finally {
    foreign.close();
  }
});

it('an explicit attempt invalidates a probe so its late answer cannot clear the upload result', () => {
  const first = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', first, now + 1, { success: false, pauseReason: 'auth' });
  const probe = state.claimUploadProbe(db, 'one', now + 3600001)!;
  const upload = state.claimUpload(db, 'one', now + 3600002, true)!;
  state.finishUpload(db, 'one', upload, now + 3600003, {
    success: false,
    pauseReason: 'forbidden',
  });
  expect(state.finishUploadProbe(db, 'one', probe, now + 3600004, { recovered: true })).toBe(false);
  expect(state.readUploadState(db, 'one')?.pauseReason).toBe('forbidden');
});

it('a recovered recheck clears the prior auth hold but retains failed-body debt and backoff', () => {
  state.markUploadOwed(db, 'one', now, true);
  const first = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', first, now + 1, {
    success: false,
    pauseReason: 'project-key',
    authFirstFailedAt: now - 15 * 60000,
  });
  const explicit = state.claimUpload(db, 'one', now + 2, true)!;
  state.finishUpload(db, 'one', explicit, now + 3, { success: false, pauseReason: null });
  expect(state.readUploadState(db, 'one')).toMatchObject({
    blocked: false,
    pauseReason: null,
    authFirstFailedAt: null,
    explicitGeneration: 1,
    failureCount: 2,
    nextAttemptAt: now + 3 + 5 * 60000,
  });
  expect(state.claimUpload(db, 'one', now + 4, false)).toBeNull();
  expect(state.claimUpload(db, 'one', now + 3 + 5 * 60000, false)).not.toBeNull();
});

it.each(['forbidden', 'tier'] as const)(
  'a recovered probe cannot clear a deterministic %s hold after a failed body',
  (pauseReason) => {
    const first = state.claimUpload(db, 'one', now, true)!;
    state.finishUpload(db, 'one', first, now + 1, { success: false, pauseReason });
    const explicit = state.claimUpload(db, 'one', now + 2, true)!;
    state.finishUpload(db, 'one', explicit, now + 3, { success: false, pauseReason: null });
    expect(state.readUploadState(db, 'one')?.pauseReason).toBe(pauseReason);
  }
);

it('a recovered auth probe never advances an outstanding Retry-After body deadline', () => {
  state.markUploadOwed(db, 'one', now, true);
  const lease = state.claimUpload(db, 'one', now, true)!;
  state.finishUpload(db, 'one', lease, now, {
    success: false,
    authFirstFailedAt: now,
    retryAfterMs: 3 * 3600000,
  });
  const probe = state.claimUploadProbe(db, 'one', now + state.UPLOAD_AUTH_RECHECK_MS)!;
  expect(probe).not.toBeNull();
  expect(
    state.finishUploadProbe(db, 'one', probe, now + state.UPLOAD_AUTH_RECHECK_MS + 1, {
      recovered: true,
    })
  ).toBe(true);
  expect(state.readUploadState(db, 'one')).toMatchObject({
    authFirstFailedAt: null,
    nextAttemptAt: now + 3 * 3600000,
  });
  expect(state.claimUpload(db, 'one', now + state.UPLOAD_AUTH_RECHECK_MS + 2, false)).toBeNull();
  expect(state.claimUpload(db, 'one', now + 3 * 3600000, false)).not.toBeNull();
});

it('an old live lease with a NULL holder waits for expiry without probing a PID', () => {
  const lease = state.claimUpload(db, 'one', now, true)!;
  db.prepare('UPDATE projects SET upload_lease_holder=NULL').run();
  const probe = jest.spyOn(process, 'kill');
  expect(state.claimUpload(db, 'one', now + state.UPLOAD_LEASE_MS - 1, true)).toBeNull();
  expect(probe).not.toHaveBeenCalled();
  expect(state.readUploadState(db, 'one')?.leaseToken).toBe(lease.token);
  expect(state.claimUpload(db, 'one', now + state.UPLOAD_LEASE_MS, true)).not.toBeNull();
});
