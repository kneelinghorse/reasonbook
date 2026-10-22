// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A copied record slot must be an ordinary SQLite table before a first copy reads it.
// ABOUTME: Real FTS replacements refuse at the upload boundary while unrelated search indexes remain harmless.
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { createReferee, REFEREE_ERROR_CODES } from '../../src/referee';
import { RECORDED_TABLES } from '../../src/tools/rbook/record-columns';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { LOG_TABLES } from '../../src/tools/rbook/record-guards';
import { dbOf, replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { refereeAt } from '../helpers/referee-fixture';
import { ownerCopy, type Copy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
let owner: Copy;
let serial = 0;
beforeAll(async () => {
  fixture = replicaFixture('rbook-source-tables-');
  owner = await ownerCopy(fixture.tmp);
});
afterAll(() => fixture.restore());

function uploaded(edit?: (db: Database.Database) => void): string {
  const file = path.join(fixture.tmp, `source-${++serial}.sqlite`);
  const live = new Database(dbOf(owner.root));
  try {
    live.prepare('VACUUM INTO ?').run(file);
  } finally {
    live.close();
  }
  const db = new Database(file);
  try {
    edit?.(db);
  } finally {
    db.close();
  }
  return file;
}

function virtualSlot(db: Database.Database, table: string): void {
  const columns = db.pragma(`table_info("${table}")`) as Array<{ name: string }>;
  expect(columns.length).toBeGreaterThan(0);
  db.pragma('foreign_keys = OFF');
  db.exec(`DROP TABLE "${table}"`);
  // SQLite normalizes this spelling in sqlite_master; keyword-shaped strings in ordinary DDL
  // must not confuse the source check. Missing external content also detects a premature row read.
  db.exec(
    `create /* upload */ virtual\ntable "${table}" USING fts5(${columns.map((column) => `"${column.name}"`).join(', ')}, content='missing_content')`
  );
}

describe('only ordinary source slots are copied (s98-m13)', () => {
  it.each(['metadata', 'contexts', ...RECORDED_TABLES, ...LOG_TABLES, 'record_aliases'])(
    'refuses virtual %s before reading its rows, leaving source bytes and destination untouched',
    async (table) => {
      const source = uploaded((db) => virtualSlot(db, table));
      const before = fs.readFileSync(source);
      const dest = path.join(fixture.tmp, `dest-${++serial}`);
      fs.mkdirSync(dest);
      await expect(
        buildFreshCopy(source, path.join(dest, 'rbook.sqlite'), { untrusted: true })
      ).rejects.toThrow(`${table} is a virtual table`);
      expect(fs.readFileSync(source)).toEqual(before);
      expect(fs.readdirSync(dest)).toEqual([]);
    }
  );

  it('refuses the same source for a local copy and through createReferee without admitting an upload', async () => {
    const source = uploaded((db) => virtualSlot(db, 'record_aliases'));
    await expect(buildFreshCopy(source, path.join(fixture.tmp, 'local.sqlite'))).rejects.toThrow(
      'record_aliases is a virtual table'
    );
    const referee = refereeAt(fixture.tmp);
    const refused = await createReferee(referee, { copyFile: source, ownerAccountId: 'owner' });
    expect(refused.result.error).toMatchObject({
      code: REFEREE_ERROR_CODES.UPLOAD_REFUSED,
      message: expect.stringContaining('record_aliases is a virtual table'),
      suggestion: expect.stringContaining("Upload the copy the owner's client builds"),
    });
    expect(refused.head).toBeNull();
    expect(fs.readdirSync(path.dirname(referee.storePath))).toEqual([]);
  });

  it('refuses a virtual slot even when stored SQL has comments and names an unavailable module', async () => {
    const source = uploaded((db) => {
      virtualSlot(db, 'record_aliases');
      // A hostile file can carry non-normalized SQL; classify SQLite objects, not SQL spellings.
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      db.prepare("UPDATE sqlite_master SET sql = ? WHERE name = 'record_aliases'").run(
        'CREATE /* hidden */ VIRTUAL TABLE record_aliases USING unavailable_module(entity)'
      );
    });
    await expect(
      buildFreshCopy(source, path.join(fixture.tmp, 'hostile.sqlite'), { untrusted: true })
    ).rejects.toThrow('record_aliases is a virtual table');
  });

  it('copies ordinary tables despite virtual-table words and unused FTS indexes, leaving no index in the copy', async () => {
    const source = uploaded((db) => {
      db.exec("ALTER TABLE record_aliases ADD COLUMN note TEXT DEFAULT 'CREATE VIRTUAL TABLE'");
      db.exec('CREATE VIRTUAL TABLE unused_search USING fts5(body)');
      db.prepare('INSERT INTO unused_search VALUES (?)').run('not part of the shared record');
    });
    const before = fs.readFileSync(source);
    const dest = path.join(fixture.tmp, 'positive.sqlite');
    expect((await buildFreshCopy(source, dest, { untrusted: true })).projectId).toBe('p-shared');
    expect(fs.readFileSync(source)).toEqual(before);
    const db = new Database(dest, { readonly: true });
    try {
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE sql LIKE 'CREATE VIRTUAL TABLE%'").all()
      ).toEqual([]);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'unused_search'").all()
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
