// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A decline blocked by SQLite stays a refusal through later turns and session cleanup.
// ABOUTME: Real lock failures protect every fromDraft caller until a hook saves the original decline.

import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { onSessionEnd, onStop, prepareOffer } from '../../../src/cli/drafts-hook';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import {
  openDraftRuntime,
  pendingDeclines,
  pruneAllRuntimes,
  readExcerpt,
} from '../../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../../src/tools/rbook/harness-session';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { setExternalSessionOwner } from '../../../src/tools/rbook/session-owner';
import { processBusyTimeout, setProcessBusyTimeout } from '../../../src/tools/rbook/sqlite-busy';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const HOUR = 60 * 60 * 1000;
const SESSION = 'decline-lifecycle';
const HASH = harnessSessionHash(SESSION);
const TEXT = 'Keep the scratch store in WAL mode so readers can continue during writes.';
let tmp: string;
let root: string;
let file: string;
let now: number;
let saved: NodeJS.ProcessEnv;
let savedTimeout: number | null;
let holder: Database.Database | undefined;

beforeEach(async () => {
  saved = { ...process.env };
  savedTimeout = processBusyTimeout();
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.RBOOK_AGENT_ROLE;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-decline-lifecycle-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  root = path.join(tmp, 'project');
  file = seedRbookDb(root, { projectName: 'decline-lifecycle' });
  reidentifyRbookTestStore(root);
  RbookDetector.resetInstance();
  setExternalSessionOwner(SESSION);
  // Prepare normal record migrations before holding the lock: refusals must exercise the draft gate.
  expect(
    (
      await rbookDecisions({
        action: 'record',
        projectRoot: root,
        content: 'Use isolated test stores for refusal checks.',
        mode: 'autonomous',
      })
    ).success
  ).toBe(true);
  setExternalSessionOwner(null);
  now = Date.now();
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  // The real lock remains held throughout each attempt; this is not a product timing assertion.
  setProcessBusyTimeout(30);
  expect(stop(`Would record: ${TEXT}`, now - 3 * HOUR).created).toBe(1);
});

afterEach(() => {
  unlock();
  jest.restoreAllMocks();
  setExternalSessionOwner(null);
  setProcessBusyTimeout(savedTimeout);
  process.env = saved;
  RbookDetector.resetInstance();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stop(reply: string, at = now) {
  return onStop({
    dbPath: file,
    rawSessionId: SESSION,
    reply,
    env: process.env,
    deadlineAtMs: Date.now() + 60_000,
    now: at,
  });
}

function answer(message: string, at = now) {
  const offer = prepareOffer({
    dbPath: file,
    rawSessionId: SESSION,
    message,
    env: process.env,
    deadlineAtMs: Date.now() + 60_000,
    now: at,
  });
  offer.commit();
  return offer;
}

function lockAndDecline() {
  holder = new Database(file);
  holder.exec('BEGIN IMMEDIATE');
  expect(answer('no').reply).toBe('decline');
  expect(proposal().outcome).toBe('pending');
}

function unlock() {
  if (!holder) return;
  holder.exec('ROLLBACK');
  holder.close();
  holder = undefined;
}

function proposal() {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare('SELECT outcome, answered_at, record_id FROM proposals WHERE id=1').get() as {
      outcome: string;
      answered_at: string | null;
      record_id: string | null;
    };
  } finally {
    db.close();
  }
}

function runtimeState(at = now) {
  const runtime = openDraftRuntime(file, process.env, { readonly: true })!;
  try {
    return {
      pending: pendingDeclines(runtime),
      excerpt: readExcerpt(runtime, HASH, 1, at),
      words: runtime.db.prepare('SELECT message FROM excerpts').all(),
    };
  } finally {
    runtime.close();
  }
}

async function record(session: string | null) {
  setExternalSessionOwner(session);
  try {
    return await rbookDecisions({
      action: 'record',
      projectRoot: root,
      content: TEXT,
      fromDraft: 'P1',
    });
  } finally {
    setExternalSessionOwner(null);
  }
}

it.each(['what next?', 'no'])(
  'Stop then %s cannot turn two failed decline attempts into approval',
  async (message) => {
    lockAndDecline();
    // Normal Stop runs before the next human message, which caused the original lost refusal.
    stop('Understood. I will leave it unrecorded.', now + 1);
    answer(message, now + 2);
    expect(runtimeState(now + 2).pending).toEqual([{ id: 1, at: now }]);
    expect((await record(SESSION)).error?.code).toBe('DRAFT_NOT_PENDING');
    unlock();
    answer('continue with the build', now + 3);
    expect(proposal()).toMatchObject({
      outcome: 'declined',
      answered_at: new Date(now).toISOString(),
      record_id: null,
    });
    expect(runtimeState().pending).toEqual([]);
  }
);

it.each([
  ['same conversation after pruning', SESSION, false],
  ['sessionless after pruning', null, false],
  ['another conversation after pruning', 'another-session', false],
  ['same conversation after SessionEnd', SESSION, true],
  ['sessionless after SessionEnd', null, true],
  ['another conversation after SessionEnd', 'another-session', true],
] as const)(
  'retains refusal for %s without retaining the operator words',
  async (_name, session, ended) => {
    lockAndDecline();
    const later = now + 2 * HOUR + 1;
    pruneAllRuntimes(process.env, later);
    if (ended) expect(onSessionEnd(file, SESSION, process.env)).toBe(true);
    expect(runtimeState(later)).toEqual({
      pending: [{ id: 1, at: now }],
      excerpt: null,
      words: [],
    });
    expect((await record(session)).error?.code).toBe('DRAFT_NOT_PENDING');
    expect(proposal().outcome).toBe('pending');
    unlock();
    stop('Continuing after the store unlocks.', later + 1);
    expect(proposal()).toMatchObject({
      outcome: 'declined',
      answered_at: new Date(now).toISOString(),
      record_id: null,
    });
    expect(runtimeState(later).pending).toEqual([]);
  }
);

it.each([
  ['linked decision', 'decision', SESSION, false],
  ['sessionless decision', 'decision', null, false],
  ['direct decision window', 'decision', 'direct-window-session', true],
  ['constraint', 'constraint', SESSION, false],
  ['rule', 'rule', SESSION, false],
  ['profile', 'profile', SESSION, false],
] as const)(
  'recording an approved %s ancestor cannot settle its declined revision',
  async (_label, kind, session, direct) => {
    const originalId = kind === 'decision' ? 1 : 2;
    const revisionId = originalId + 1;
    const line = (text: string) =>
      `Would record${kind === 'decision' ? '' : ` (${kind})`}: ${text}`;
    stop(line(TEXT));
    expect(answer('approved', now + 1).reply).toBe('approval');
    if (direct) {
      // A different live conversation still has its direct-record window on the approved ancestor.
      onStop({
        dbPath: file,
        rawSessionId: session!,
        reply: line(TEXT),
        env: process.env,
        deadlineAtMs: Date.now() + 60_000,
        now: now + 2,
      });
      prepareOffer({
        dbPath: file,
        rawSessionId: session!,
        message: 'approved',
        env: process.env,
        deadlineAtMs: Date.now() + 60_000,
        now: now + 3,
      }).commit();
    }
    const revised = `${TEXT} Keep checkpoint files local.`;
    expect(stop(line(revised), now + 4).created).toBe(1);
    const read = new Database(file, { readonly: true });
    try {
      expect(
        read.prepare('SELECT outcome, replaced_by FROM proposals WHERE id=?').get(originalId)
      ).toEqual({ outcome: 'pending', replaced_by: revisionId });
      holder = new Database(file);
      holder.exec('BEGIN IMMEDIATE');
      expect(answer('no', now + 5).reply).toBe('decline');
      expect(runtimeState(now + 5).pending).toEqual([{ id: revisionId, at: now + 5 }]);
      unlock();
      // No hook gets to drain the marker: the record's revision settlement must respect it itself.
      setExternalSessionOwner(session);
      const result = await rbookDecisions({
        action: 'record',
        projectRoot: root,
        content: TEXT,
        ...(direct ? { mode: 'autonomous' as const } : { fromDraft: `P${originalId}` }),
      });
      expect(result.success).toBe(true);
      const revision = read
        .prepare('SELECT outcome, record_id FROM proposals WHERE id=?')
        .get(revisionId) as { outcome: string; record_id: string | null };
      expect(['declined', 'pending']).toContain(revision.outcome);
      expect(revision.record_id).toBeNull();
      if (revision.outcome === 'pending')
        expect(runtimeState().pending).toContainEqual({ id: revisionId, at: now + 5 });
      expect(read.prepare('SELECT outcome FROM proposals WHERE id=?').get(originalId)).toEqual({
        outcome: direct ? 'answered' : 'approved',
      });
    } finally {
      read.close();
      setExternalSessionOwner(null);
    }
  }
);
