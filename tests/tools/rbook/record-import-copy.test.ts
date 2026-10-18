// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m14 — the base and the marker an import reads against: the newest snapshot both folders hold byte for byte,
// ABOUTME: and the newest context snapshot both stores hold, a pruned hash read through its prefix; and where a store lives.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  folderOfStore,
  sharedBase,
  sharedMarker,
  storesOf,
} from '../../../src/tools/rbook/record-import-copy';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-import-copy-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (dir: string, name: string, bytes: string) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), bytes);
};

describe('the base', () => {
  it('is the newest snapshot both folders hold with the same bytes; one of the same size with other bytes is none', () => {
    const [copy, target] = [path.join(tmp, 'copy'), path.join(tmp, 'target')];
    write(copy, 'snapshot-20260101T000000000Z-aaaa.sqlite', 'older, held by both');
    write(target, 'snapshot-20260101T000000000Z-aaaa.sqlite', 'older, held by both');
    write(copy, 'snapshot-20260201T000000000Z-bbbb.sqlite', 'newer, held by both');
    write(target, 'snapshot-20260201T000000000Z-bbbb.sqlite', 'newer, held by both');
    write(copy, 'snapshot-20260301T000000000Z-cccc.sqlite', 'the same size, other bytes: one');
    write(target, 'snapshot-20260301T000000000Z-cccc.sqlite', 'the same size, other bytes: two');
    expect(path.basename(sharedBase(copy, target)!)).toBe(
      'snapshot-20260201T000000000Z-bbbb.sqlite'
    );
    expect(sharedBase(copy, null)).toBeNull();
  });
});

describe('the marker', () => {
  const rows = (entries: Array<[number, string, string | null]>) => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE context_snapshots (id INTEGER, created_at TEXT, content_hash TEXT)');
    for (const entry of entries)
      db.prepare('INSERT INTO context_snapshots VALUES (?, ?, ?)').run(...entry);
    return db;
  };

  it('is the newest context snapshot both stores hold, a pruned hash read through its prefix', () => {
    const copy = rows([
      [1, '2026-01-01T00:00:00Z', 'h1'],
      [2, '2026-02-01T00:00:00Z', 'pruned:h2'],
      [3, '2026-03-01T00:00:00Z', 'h3-copy'],
    ]);
    try {
      expect(
        sharedMarker(copy, [
          { id: 1, created_at: '2026-01-01T00:00:00Z', content_hash: 'h1' },
          { id: 2, created_at: '2026-02-01T00:00:00Z', content_hash: 'h2' },
          { id: 3, created_at: '2026-03-01T00:00:00Z', content_hash: 'h3-record' },
        ])
      ).toEqual({ id: 2, createdAt: '2026-02-01T00:00:00Z' });
    } finally {
      copy.close();
    }
  });
});

describe('where a store lives', () => {
  it('a project folder keeps it under rbook/db or cmos/db; a store file elsewhere is in the folder that holds it', () => {
    const project = path.join(tmp, 'project');
    write(path.join(project, 'rbook', 'db'), 'rbook.sqlite', '');
    write(path.join(project, 'cmos', 'db'), 'cmos.sqlite', '');
    expect(storesOf(project)).toEqual([
      path.join(project, 'rbook', 'db', 'rbook.sqlite'),
      path.join(project, 'cmos', 'db', 'cmos.sqlite'),
    ]);
    expect(folderOfStore(path.join(project, 'cmos', 'db', 'cmos.sqlite'))).toBe(project);
    write(path.join(tmp, 'desk'), 'old.sqlite', '');
    expect(folderOfStore(path.join(tmp, 'desk', 'old.sqlite'))).toBe(path.join(tmp, 'desk'));
  });
});
