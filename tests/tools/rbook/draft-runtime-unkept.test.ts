// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — the draft runtime's unkept table: five lines a reply and the rest counted, cut to 80 characters,
// ABOUTME: unread after two hours, gone at session end and start and in the prune, and empty in an older runtime.

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  closeWindow,
  endDraftSession,
  openDraftRuntime,
  pruneAllRuntimes,
  recordSessionStart,
  type DraftRuntime,
} from '../../../src/tools/rbook/draft-runtime';
import { EXCERPT_TTL_MS } from '../../../src/tools/rbook/draft-runtime-excerpts';
import {
  acknowledgeUnkept,
  readUnkept,
  replaceUnkept,
  UNKEPT_MAX,
} from '../../../src/tools/rbook/draft-runtime-unkept';
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
  it('protects the current Stop from a 4.12.0 prompt prepared before the upgrade', () => {
    closeWindow(runtime, SESSION, NOW); // The current Stop always closes the direct-record window.
    replaceUnkept(runtime, SESSION, [entry(1), entry(2)], NOW);
    const current = readUnkept(runtime, SESSION, NOW);
    // 4.12.0 and cfab889f: prepareOffer.commit → withRuntime → clearUnkept.
    // The callbacks open a new connection and read the table name before their unscoped DELETE.
    const legacy = openDraftRuntime(dbPath, env)!;
    try {
      expect(
        legacy.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='unkept'").get()
      ).toBeDefined();
      expect(legacy.db.prepare('SELECT total_changes() AS writes').get()).toEqual({ writes: 0 });
      legacy.db.prepare('DELETE FROM unkept WHERE session = ?').run(SESSION);
      expect(readUnkept(runtime, SESSION, NOW)).toEqual(current);
    } finally {
      legacy.close();
    }
  });

  it.each([true, false])(
    'a legacy Stop replaces current reasons, even at the same time (empty=%s)',
    (empty) => {
      closeWindow(runtime, SESSION, NOW);
      replaceUnkept(runtime, SESSION, [entry(1)], NOW);
      const previous = readUnkept(runtime, SESSION, NOW);
      const legacy = openDraftRuntime(dbPath, env)!;
      try {
        // The real Stop's setShown UPSERT, including an empty set, precedes replaceUnkept.
        const stamp = legacy.db
          .prepare(`INSERT INTO shown (session, draft_ids, at) VALUES (?, '[]', ?)
        ON CONFLICT(session) DO UPDATE SET draft_ids = excluded.draft_ids, at = excluded.at`);
        stamp.run(SESSION, NOW);
        expect(stamp.run(SESSION, NOW).changes).toBe(1);
        legacy.db.transaction(() => {
          legacy.db.prepare('DELETE FROM unkept WHERE session = ?').run(SESSION);
          if (!empty)
            legacy.db
              .prepare(
                "INSERT INTO unkept(session,position,text,reason,detail,at) VALUES (?,0,'new legacy reason','limit','',?)"
              )
              .run(SESSION, NOW);
        })();
        acknowledgeUnkept(runtime, SESSION, previous.generation, [0]);
        expect(readUnkept(runtime, SESSION, NOW).entries.map((row) => row.text)).toEqual(
          empty ? [] : ['new legacy reason']
        );
      } finally {
        legacy.close();
      }
    }
  );

  it.each(['end', 'start'])(
    'a 4.12.0 %s clears protected reasons even with no other session rows',
    (event) => {
      replaceUnkept(runtime, SESSION, [entry(1)], NOW);
      runtime.db.prepare('DELETE FROM windows WHERE session = ?').run(SESSION);
      const legacy = openDraftRuntime(dbPath, env)!;
      try {
        if (event === 'start') legacy.db.prepare('INSERT INTO starts(at) VALUES (?)').run(NOW);
        for (const table of [
          'session_state',
          'offers',
          'excerpts',
          'windows',
          'shown',
          'kept',
          'scans',
        ])
          expect(
            legacy.db.prepare(`DELETE FROM ${table} WHERE session = ?`).run(SESSION).changes
          ).toBe(0);
        legacy.db.prepare('DELETE FROM unkept WHERE session = ?').run(SESSION);
        expect(readUnkept(runtime, SESSION, NOW).entries).toEqual([]);
      } finally {
        legacy.close();
      }
    }
  );

  it('keeps the owning session visible when a released Stop closed a two-hour-old window', () => {
    replaceUnkept(runtime, SESSION, [], NOW);
    closeWindow(runtime, SESSION, NOW - EXCERPT_TTL_MS);
    // The 4.12.0 Stop sets open=0 on an existing window without refreshing its timestamp.
    runtime.db.prepare('UPDATE windows SET open = 0 WHERE session = ?').run(SESSION);
    runtime.db
      .prepare(
        "INSERT INTO unkept(session,position,text,reason,detail,at) VALUES (?,0,'new release reason','busy','',?)"
      )
      .run(SESSION, NOW);
    expect(pruneAllRuntimes(env, NOW)).toBe(1);
    const legacy = openDraftRuntime(dbPath, env)!;
    try {
      legacy.db.prepare('DELETE FROM unkept WHERE session = ?').run(SESSION);
      expect(readUnkept(runtime, SESSION, NOW).entries.map((row) => row.text)).toEqual([
        'new release reason',
      ]);
    } finally {
      legacy.close();
    }
  });
  it('distinguishes two identical replies delivered in the same millisecond', () => {
    replaceUnkept(runtime, SESSION, [entry(1)], NOW);
    const first = readUnkept(runtime, SESSION, NOW);
    replaceUnkept(runtime, SESSION, [entry(1)], NOW);
    const second = readUnkept(runtime, SESSION, NOW);
    expect(first).toMatchObject({
      generation: expect.any(String),
      entries: [{ ...entry(1), position: 0 }],
    });
    expect(second).not.toEqual(first);
  });

  it('keeps five lines a reply, counts the rest, and replaces the earlier reply’s', () => {
    replaceUnkept(runtime, SESSION, [1, 2, 3, 4, 5, 6, 7].map(entry), NOW);
    const read = readUnkept(runtime, SESSION, NOW);
    expect(read.entries.map((row) => row.text)).toEqual(
      [1, 2, 3, 4, 5].map((n) => `Would record: line ${n}`)
    );
    expect(read.more).toBe(2);
    replaceUnkept(runtime, SESSION, [entry(9)], NOW);
    expect(readUnkept(runtime, SESSION, NOW)).toEqual({
      generation: expect.any(String),
      entries: [{ ...entry(9), position: 0 }],
      more: 0,
    });
    replaceUnkept(runtime, SESSION, [], NOW);
    expect(readUnkept(runtime, SESSION, NOW)).toEqual({ generation: null, entries: [], more: 0 });
  });

  it('acknowledges just the delivered positions and treats the overflow count separately', () => {
    const seven = [1, 2, 3, 4, 5, 6, 7].map(entry);
    replaceUnkept(runtime, SESSION, seven, NOW);
    const read = () => readUnkept(runtime, SESSION, NOW);
    const { generation } = read();
    acknowledgeUnkept(runtime, SESSION, generation, []);
    expect(read().entries).toHaveLength(5);
    acknowledgeUnkept(runtime, SESSION, generation, [0, 2, 4]);
    acknowledgeUnkept(runtime, SESSION, generation, [0, 2, 4]);
    expect(read()).toEqual({
      generation,
      entries: [
        { ...entry(2), position: 1 },
        { ...entry(4), position: 3 },
      ],
      more: 2,
    });
    acknowledgeUnkept(runtime, SESSION, generation, [UNKEPT_MAX]);
    expect(read().entries.map((row) => row.position)).toEqual([1, 3]);
    expect(read().more).toBe(0);
    acknowledgeUnkept(runtime, SESSION, generation, [1, 3]);
    expect(read()).toEqual({ generation: null, entries: [], more: 0 });
  });

  it.each([true, false])('a delayed delivery cannot erase the next Stop (identical=%s)', (same) => {
    const seven = [1, 2, 3, 4, 5, 6, 7].map(entry);
    replaceUnkept(runtime, SESSION, seven, NOW);
    const delayed = readUnkept(runtime, SESSION, NOW);
    const second = openDraftRuntime(dbPath, env, { existingOnly: true })!;
    try {
      replaceUnkept(second, SESSION, same ? seven : [entry(8)], NOW);
      const current = readUnkept(second, SESSION, NOW);
      expect(current.generation).not.toBe(delayed.generation);
      acknowledgeUnkept(runtime, SESSION, delayed.generation, [0, 1, 2, 3, 4, UNKEPT_MAX]);
      expect(readUnkept(second, SESSION, NOW)).toEqual(current);
    } finally {
      second.close();
    }
  });

  it('reads unversioned rows without migrating and never acknowledges a legacy replacement', () => {
    runtime.db.exec(`DROP TABLE unkept;
      CREATE TABLE unkept(session TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL,
        reason TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(session, position));`);
    const writeLegacy = () =>
      runtime.db
        .prepare(
          "INSERT INTO unkept (session, position, text, reason, detail, at) VALUES (?, 0, 'legacy', 'limit', '', ?)"
        )
        .run(SESSION, NOW);
    writeLegacy();
    const reader = openDraftRuntime(dbPath, env, { readonly: true })!;
    try {
      const legacy = readUnkept(reader, SESSION, NOW);
      expect(legacy).toEqual({
        generation: null,
        entries: [{ text: 'legacy', reason: 'limit', detail: '', position: 0 }],
        more: 0,
      });
      acknowledgeUnkept(runtime, SESSION, legacy.generation, [0]);
      expect(readUnkept(reader, SESSION, NOW)).toEqual(legacy);
      expect(reader.db.pragma('table_info(unkept)')).not.toContainEqual(
        expect.objectContaining({ name: 'generation' })
      );
      replaceUnkept(runtime, SESSION, [entry(1)], NOW);
      const current = readUnkept(reader, SESSION, NOW);
      expect(current.generation).toEqual(expect.any(String));
      acknowledgeUnkept(runtime, SESSION, legacy.generation, [0]);
      expect(readUnkept(reader, SESSION, NOW)).toEqual(current);
      runtime.db.prepare('DELETE FROM unkept WHERE session = ?').run(SESSION);
      writeLegacy(); // The previous Stop version omits the new column.
      acknowledgeUnkept(runtime, SESSION, current.generation, [0]);
      const replaced = readUnkept(reader, SESSION, NOW);
      expect(replaced).toEqual({ ...legacy, generation: expect.any(String) });
      expect(replaced.generation).not.toEqual(current.generation);
    } finally {
      reader.close();
    }
  });

  it('cuts the agent’s line to 80 characters, and keeps no other session’s', () => {
    replaceUnkept(runtime, SESSION, [{ text: 'x'.repeat(200), reason: 'text', detail: '' }], NOW);
    expect(readUnkept(runtime, SESSION, NOW).entries[0].text).toHaveLength(80);
    expect(readUnkept(runtime, 'bbbbbbbbbbbbbbbb', NOW).entries).toEqual([]);
  });

  it('retains a printable excerpt when the 80-unit limit falls inside an emoji', () => {
    const text = 'x'.repeat(78) + '😀. This part does not fit.';
    replaceUnkept(runtime, SESSION, [{ text, reason: 'text', detail: '' }], NOW);
    expect(readUnkept(runtime, SESSION, NOW).entries[0].text).toBe('x'.repeat(78) + '…');
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
    expect(readUnkept(runtime, SESSION, NOW)).toEqual({ generation: null, entries: [], more: 0 });
  });
});
