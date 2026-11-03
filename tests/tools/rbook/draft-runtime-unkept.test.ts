// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — the draft runtime's unkept table: five lines a reply and the rest counted, cut to 80 characters,
// ABOUTME: unread after two hours, gone at session end and start and in the prune, and empty in an older runtime.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  endDraftSession,
  openDraftRuntime,
  pruneAllRuntimes,
  recordSessionStart,
  type DraftRuntime,
} from '../../../src/tools/rbook/draft-runtime';
import { EXCERPT_TTL_MS } from '../../../src/tools/rbook/draft-runtime-excerpts';
import { readUnkept, replaceUnkept } from '../../../src/tools/rbook/draft-runtime-unkept';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

const NOW = Date.now();
const SESSION = 'aaaaaaaaaaaaaaaa';
let tmp: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
let runtime: DraftRuntime;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s109m02-unkept-'));
  const projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedRbookDb(projectRoot, { projectName: 'unkept' });
  reidentifyRbookTestStore(projectRoot);
  env = { ...process.env, RBOOK_CONFIG_DIR: path.join(tmp, 'config') };
  runtime = openDraftRuntime(dbPath, env)!;
});

afterEach(() => {
  runtime.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const entry = (n: number) => ({ text: `Would record: line ${n}`, reason: 'limit', detail: '' });

describe('the unkept table (settled item 5)', () => {
  it('keeps five lines a reply, counts the rest, and replaces the earlier reply’s', () => {
    replaceUnkept(runtime, SESSION, [1, 2, 3, 4, 5, 6, 7].map(entry), NOW);
    const read = readUnkept(runtime, SESSION, NOW);
    expect(read.entries.map((row) => row.text)).toEqual(
      [1, 2, 3, 4, 5].map((n) => `Would record: line ${n}`)
    );
    expect(read.more).toBe(2);
    replaceUnkept(runtime, SESSION, [entry(9)], NOW);
    expect(readUnkept(runtime, SESSION, NOW)).toEqual({ entries: [entry(9)], more: 0 });
    replaceUnkept(runtime, SESSION, [], NOW);
    expect(readUnkept(runtime, SESSION, NOW)).toEqual({ entries: [], more: 0 });
  });

  it('cuts the agent’s line to 80 characters, and keeps no other session’s', () => {
    replaceUnkept(runtime, SESSION, [{ text: 'x'.repeat(200), reason: 'text', detail: '' }], NOW);
    expect(readUnkept(runtime, SESSION, NOW).entries[0].text).toHaveLength(80);
    expect(readUnkept(runtime, 'bbbbbbbbbbbbbbbb', NOW).entries).toEqual([]);
  });

  it('reads nothing two hours on, and the prune deletes it', () => {
    replaceUnkept(runtime, SESSION, [entry(1)], NOW - EXCERPT_TTL_MS);
    expect(readUnkept(runtime, SESSION, NOW).entries).toEqual([]);
    runtime.close();
    expect(pruneAllRuntimes(env, NOW)).toBe(1);
    runtime = openDraftRuntime(dbPath, env)!;
    expect(runtime.db.prepare('SELECT COUNT(*) AS n FROM unkept').get()).toEqual({ n: 0 });
  });

  it('is deleted at session end and at a non-compact session start', () => {
    replaceUnkept(runtime, SESSION, [entry(1)], NOW);
    endDraftSession(runtime, SESSION);
    expect(readUnkept(runtime, SESSION, NOW).entries).toEqual([]);
    replaceUnkept(runtime, SESSION, [entry(2)], NOW);
    recordSessionStart(runtime, SESSION, NOW);
    expect(readUnkept(runtime, SESSION, NOW).entries).toEqual([]);
  });

  it('reads as empty from a runtime an older Stop wrote, opened read-only', () => {
    runtime.db.exec('DROP TABLE unkept');
    runtime.close();
    runtime = openDraftRuntime(dbPath, env, { readonly: true })!;
    expect(readUnkept(runtime, SESSION, NOW)).toEqual({ entries: [], more: 0 });
  });
});
