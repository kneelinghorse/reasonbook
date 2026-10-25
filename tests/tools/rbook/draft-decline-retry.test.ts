// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A busy store cannot consume a decline before it is durable, even if output delivery fails.
// ABOUTME: Real locks and legacy excerpt writes protect retries, original leases and approval provenance.

import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { onStop, prepareOffer } from '../../../src/cli/drafts-hook';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { openDraftRuntime, peekShown, readExcerpt } from '../../../src/tools/rbook/draft-runtime';
import { harnessSessionHash } from '../../../src/tools/rbook/harness-session';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import { setExternalSessionOwner } from '../../../src/tools/rbook/session-owner';
import { seedRbookDb } from '../../helpers/seedRbookDb';

const SESSION = 'decline-retry';
const HASH = harnessSessionHash(SESSION);
const TEXT = 'Keep the scratch store in WAL mode so readers can continue during writes.';
let tmp: string;
let root: string;
let file: string;
let now: number;
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.RBOOK_AGENT_ROLE;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-decline-retry-'));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  root = path.join(tmp, 'project');
  file = seedRbookDb(root, { projectName: 'decline-retry' });
  now = Date.now();
  RbookDetector.resetInstance();
  setExternalSessionOwner(null);
  jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  jest.restoreAllMocks();
  setExternalSessionOwner(null);
  process.env = saved;
  RbookDetector.resetInstance();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function show(at: number, kind = 'decision') {
  expect(
    onStop({
      dbPath: file,
      rawSessionId: SESSION,
      reply: `Would record${kind === 'decision' ? '' : ` (${kind})`}: ${TEXT}`,
      env: process.env,
      deadlineAtMs: Date.now() + 60_000,
      now: at,
    }).created
  ).toBe(1);
}

function no() {
  return prepareOffer({
    dbPath: file,
    rawSessionId: SESSION,
    message: 'no',
    env: process.env,
    deadlineAtMs: Date.now() + 60_000,
    now,
  });
}

function state() {
  const db = new Database(file, { readonly: true });
  const runtime = openDraftRuntime(file, process.env, { readonly: true })!;
  try {
    return {
      proposal: db.prepare('SELECT outcome FROM proposals WHERE id=1').get(),
      shown: peekShown(runtime, HASH, now),
      at: runtime.db.prepare('SELECT at FROM shown WHERE session=?').get(HASH),
      excerpt: readExcerpt(runtime, HASH, 1, now),
    };
  } finally {
    db.close();
    runtime.close();
  }
}

it.each([0, 3 * 60 * 60 * 1000])('retries a decline after a real lock releases (gap %i)', (gap) => {
  show(now - gap);
  const holder = new Database(file);
  holder.exec('BEGIN IMMEDIATE');
  let offer: ReturnType<typeof no>;
  try {
    offer = no();
    expect(offer.text).not.toBe('');
    expect(state()).toMatchObject({
      proposal: { outcome: 'pending' },
      shown: [1],
      at: { at: now - gap },
      excerpt: { reply: 'decline' },
    });
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  offer!.commit();
  expect(state().proposal).toEqual({ outcome: 'declined' });
});

it('keeps the original shown lease after both busy attempts, then accepts the next decline', () => {
  const at = now - 3 * 60 * 60 * 1000;
  show(at);
  const holder = new Database(file);
  holder.exec('BEGIN IMMEDIATE');
  try {
    const offer = no();
    offer.commit();
    expect(state()).toMatchObject({ proposal: { outcome: 'pending' }, shown: [1], at: { at } });
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  no().commit();
  expect(state().proposal).toEqual({ outcome: 'declined' });
});

it('keeps the shown reference when failed output means commit is never called', () => {
  const at = now - 3 * 60 * 60 * 1000;
  show(at);
  const holder = new Database(file);
  holder.exec('BEGIN IMMEDIATE');
  try {
    no();
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  expect(state()).toMatchObject({ proposal: { outcome: 'pending' }, shown: [1], at: { at } });
});

it.each(['decision', 'constraint', 'rule', 'profile'])(
  'a legacy upsert cannot upgrade a stale late flag for a %s',
  async (kind) => {
    show(now, kind);
    const offer = prepareOffer({
      dbPath: file,
      rawSessionId: SESSION,
      message: 'approved',
      env: process.env,
      deadlineAtMs: Date.now() + 60_000,
      now,
    });
    offer.commit();
    const runtime = openDraftRuntime(file, process.env)!;
    try {
      const columns = runtime.db.pragma('table_info(excerpts)') as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'late'))
        runtime.db.exec('ALTER TABLE excerpts ADD COLUMN late INTEGER NOT NULL DEFAULT 0');
      // 4.5.1's upsert updates reply but leaves the new late column intact.
      runtime.db.prepare("UPDATE excerpts SET late=1, reply='approval' WHERE session=?").run(HASH);
    } finally {
      runtime.close();
    }
    setExternalSessionOwner(SESSION);
    const result = await rbookDecisions({
      action: 'record',
      projectRoot: root,
      fromDraft: 'P1',
      content: TEXT,
    });
    if (kind === 'decision') {
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ approval: { mode: 'agent-judged' } });
    } else {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('APPROVAL_REQUIRED');
    }
  }
);
