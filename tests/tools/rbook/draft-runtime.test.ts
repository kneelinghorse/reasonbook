// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s93-m06 — the runtime half of a draft: the operator's words, offer counts, windows and session
// ABOUTME: starts, kept outside every store and repository, keyed by hashes, and gone within two hours.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  bindWindow,
  bumpOffers,
  carryShown,
  closeWindow,
  draftRuntimePath,
  endDraftSession,
  EXCERPT_TTL_MS,
  offerCounts,
  openDraftRuntime,
  openWindow,
  pruneAllRuntimes,
  readExcerpt,
  recordSessionStart,
  sessionStartedAt,
  setShown,
  startsSince,
  takeKept,
  takeShown,
  type DraftRuntime,
} from '../../../src/tools/rbook/draft-runtime';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

let tmp: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
const opened: DraftRuntime[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s93m06-runtime-'));
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(tmp, 'config') };
  const root = path.join(tmp, 'project');
  fs.mkdirSync(root, { recursive: true });
  dbPath = seedRbookDb(root, { projectName: 'runtime' });
  reidentifyRbookTestStore(root);
});

afterEach(() => {
  while (opened.length) opened.pop()!.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const open = (readonly = false): DraftRuntime => {
  const runtime = openDraftRuntime(dbPath, env, { readonly });
  if (!runtime) throw new Error('runtime unavailable');
  opened.push(runtime);
  return runtime;
};

const S1 = '0123456789abcdef';
const S2 = 'fedcba9876543210';

describe('where it lives', () => {
  it('is one file per store under <configDir>/runtime/drafts, outside the project', () => {
    const runtime = open();
    expect(runtime.path).toBe(draftRuntimePath(runtime.storeKey, env));
    expect(runtime.path.startsWith(path.join(tmp, 'config', 'runtime', 'drafts'))).toBe(true);
    expect(fs.existsSync(runtime.path)).toBe(true);
  });

  it('reads as absent, without creating anything, when opened read-only before any write', () => {
    expect(openDraftRuntime(dbPath, env, { readonly: true })).toBeNull();
    expect(fs.existsSync(path.join(tmp, 'config', 'runtime', 'drafts'))).toBe(false);
  });

  it('refuses a config directory inside a repository', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    expect(
      openDraftRuntime(dbPath, { ...env, RBOOK_CONFIG_DIR: path.join(repo, 'cfg') })
    ).toBeNull();
  });
});

describe('session starts', () => {
  it('counts the starts recorded after a moment, so expiry needs no store write', () => {
    const runtime = open();
    const t0 = Date.now();
    recordSessionStart(runtime, S1, t0 - 1000);
    recordSessionStart(runtime, S2, t0 + 1000);
    recordSessionStart(runtime, S1, t0 + 2000);
    expect(startsSince(runtime, t0)).toBe(2);
    expect(sessionStartedAt(runtime, S1)).toBe(t0 + 2000);
  });

  it('starts a session over: its offers, words and window from before are dropped', () => {
    const runtime = open();
    const now = Date.now();
    bumpOffers(runtime, S1, [4]);
    bindWindow(runtime, S1, [4], 'approved', 'approval', now);
    recordSessionStart(runtime, S1, now + 1);
    expect(offerCounts(runtime, S1).get(4)).toBeUndefined();
    expect(readExcerpt(runtime, S1, 4, now + 2)).toBeNull();
    expect(openWindow(runtime, S1, now + 2)).toEqual([]);
  });
});

describe('drafts kept from an earlier reply (s97-m12, critic round 2)', () => {
  it('keeps the drafts no operator message took, with their first showing, and never refreshes it', () => {
    const runtime = open();
    const shownAt = Date.now();
    setShown(runtime, S1, [4], shownAt);
    // Harness turns end: each Stop carries what was shown, and shows nothing of its own.
    carryShown(runtime, S1, shownAt + 1000);
    setShown(runtime, S1, [], shownAt + 1000);
    carryShown(runtime, S1, shownAt + EXCERPT_TTL_MS - 1000);
    setShown(runtime, S1, [], shownAt + EXCERPT_TTL_MS - 1000);
    // Two hours after it was first shown it is gone, however many Stops carried it.
    expect(takeKept(runtime, S1, shownAt + EXCERPT_TTL_MS + 1)).toEqual([]);
  });

  it("an operator message takes the kept drafts with the latest reply's, once", () => {
    const runtime = open();
    const now = Date.now();
    setShown(runtime, S1, [4], now);
    carryShown(runtime, S1, now + 10);
    setShown(runtime, S1, [7], now + 10);
    expect(takeShown(runtime, S1, now + 20)).toEqual([7]);
    expect(takeKept(runtime, S1, now + 20)).toEqual([4]);
    expect(takeKept(runtime, S1, now + 30)).toEqual([]);
  });

  it('binds kept drafts only as words the agent judges, never as a plain answer', () => {
    const runtime = open();
    const now = Date.now();
    bindWindow(runtime, S1, [7], 'no', 'decline', now, [4]);
    expect(readExcerpt(runtime, S1, 7, now)).toMatchObject({ reply: 'decline', windowSize: 1 });
    expect(readExcerpt(runtime, S1, 4, now)).toMatchObject({ reply: 'other' });
    // They are not the operator's window: a later line retires them only at the coverage rule.
    expect(openWindow(runtime, S1, now)).toEqual([7]);
  });
});

describe('the operator words and the window', () => {
  it('keeps the message per draft and session, cut to 1,000 characters, with its class and window size', () => {
    const runtime = open();
    const now = Date.now();
    bindWindow(runtime, S1, [4, 5], `yes ${'x'.repeat(2000)}`, 'other', now);
    const excerpt = readExcerpt(runtime, S1, 5, now);
    expect(excerpt?.message.length).toBe(1000);
    expect(excerpt).toMatchObject({ reply: 'other', windowSize: 2 });
    expect(openWindow(runtime, S1, now)).toEqual([4, 5]);
    // Another session never sees it: the lookup is the session match.
    expect(readExcerpt(runtime, S2, 5, now)).toBeNull();
  });

  it('forgets the words after two hours, and the window with them', () => {
    const runtime = open();
    const now = Date.now();
    bindWindow(runtime, S1, [4], 'approved', 'approval', now);
    expect(readExcerpt(runtime, S1, 4, now + EXCERPT_TTL_MS - 1)).not.toBeNull();
    expect(readExcerpt(runtime, S1, 4, now + EXCERPT_TTL_MS + 1)).toBeNull();
    expect(openWindow(runtime, S1, now + EXCERPT_TTL_MS + 1)).toEqual([]);
  });

  it('closes the window at the end of the turn but keeps the words for the record', () => {
    const runtime = open();
    const now = Date.now();
    bindWindow(runtime, S1, [4], 'approved', 'approval', now);
    closeWindow(runtime, S1);
    expect(openWindow(runtime, S1, now)).toEqual([]);
    expect(readExcerpt(runtime, S1, 4, now)?.message).toBe('approved');
  });

  it('a later message replaces the words: the operator latest word counts', () => {
    const runtime = open();
    const now = Date.now();
    bindWindow(runtime, S1, [4], 'approved', 'approval', now);
    bindWindow(runtime, S1, [4], 'wait, not yet?', 'question', now + 5);
    expect(readExcerpt(runtime, S1, 4, now + 6)).toMatchObject({
      message: 'wait, not yet?',
      reply: 'question',
    });
  });

  it('is deleted for a session at its end, and only for that session', () => {
    const runtime = open();
    const now = Date.now();
    bindWindow(runtime, S1, [4], 'approved', 'approval', now);
    bindWindow(runtime, S2, [4], 'approved', 'approval', now);
    bumpOffers(runtime, S1, [4]);
    endDraftSession(runtime, S1);
    expect(readExcerpt(runtime, S1, 4, now)).toBeNull();
    expect(offerCounts(runtime, S1).size).toBe(0);
    expect(readExcerpt(runtime, S2, 4, now)).not.toBeNull();
  });

  it('is readable by the server read-only once a hook has written it', () => {
    const now = Date.now();
    bindWindow(open(), S1, [7], 'approved', 'approval', now);
    expect(readExcerpt(open(true), S1, 7, now)?.reply).toBe('approval');
  });
});

describe('what a reply showed', () => {
  it('is taken once: one message answers one reply', () => {
    const runtime = open();
    const now = Date.now();
    setShown(runtime, S1, [3, 4], now);
    expect(takeShown(runtime, S2, now)).toEqual([]);
    expect(takeShown(runtime, S1, now)).toEqual([3, 4]);
    expect(takeShown(runtime, S1, now)).toEqual([]);
  });

  it('is forgotten after two hours and at a new start of the session', () => {
    const runtime = open();
    const now = Date.now();
    setShown(runtime, S1, [3], now);
    expect(takeShown(runtime, S1, now + EXCERPT_TTL_MS + 1)).toEqual([]);
    setShown(runtime, S1, [3], now);
    recordSessionStart(runtime, S1, now + 1);
    expect(takeShown(runtime, S1, now + 2)).toEqual([]);
  });
});

describe('pruning every store at a session start', () => {
  it('drops stale words from another store whose sessions never came back', () => {
    const runtime = open();
    const old = Date.now() - EXCERPT_TTL_MS - 60_000;
    bindWindow(runtime, S1, [4], 'approved', 'approval', old);
    expect(
      (runtime.db.prepare('SELECT COUNT(*) AS n FROM excerpts').get() as { n: number }).n
    ).toBe(1);
    expect(pruneAllRuntimes(env, Date.now())).toBe(1);
    expect(
      (runtime.db.prepare('SELECT COUNT(*) AS n FROM excerpts').get() as { n: number }).n
    ).toBe(0);
  });
});

describe('the store key', () => {
  it('finds the same approval words through a symlink alias on every filesystem', () => {
    const alias = path.join(tmp, 'project-alias');
    fs.symlinkSync(path.join(tmp, 'project'), alias, 'dir');
    const original = open();
    const now = Date.now();
    bindWindow(original, S1, [4], 'approved', 'approval', now);
    const linked = openDraftRuntime(path.join(alias, 'rbook', 'db', 'rbook.sqlite'), env, {
      readonly: true,
    });
    try {
      expect(linked).not.toBeNull();
      expect(linked?.storeKey).toBe(original.storeKey);
      expect(linked?.path).toBe(original.path);
      expect(readExcerpt(linked!, S1, 4, now)?.message).toBe('approved');
    } finally {
      linked?.close();
    }
  });

  it('is the same for a hook and a server that spell the folder in another letter case', () => {
    const upper = dbPath.replace(/project/, 'PROJECT');
    const caseInsensitive = fs.existsSync(upper);
    const a = open();
    if (!caseInsensitive) return; // A case-sensitive disk has only one spelling to find.
    const b = openDraftRuntime(upper, env);
    try {
      expect(b?.path).toBe(a.path);
    } finally {
      b?.close();
    }
  });
});

describe('offers', () => {
  it('counts offers per draft within a session', () => {
    const runtime = open();
    bumpOffers(runtime, S1, [4, 5]);
    bumpOffers(runtime, S1, [4]);
    expect([...offerCounts(runtime, S1).entries()].sort()).toEqual([
      [4, 2],
      [5, 1],
    ]);
    expect(offerCounts(runtime, S2).size).toBe(0);
  });
});
