// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m11 — a first-write migration that fails part way, or cannot take the store's lock, leaves
// ABOUTME: the store as it found it: nothing rebuilt, no marker, foreign keys on and no transaction open.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { RBOOK_SCHEMA } from '../../../src/tools/rbook/schema';
import { ensureFirehoseEventColumns } from '../../../src/tools/rbook/schema-migrations';

let tmp: string;
let file: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migration-lock-'));
  file = path.join(tmp, 'store.sqlite');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A store in the shape before the firehose migration, as RBOOK_SCHEMA creates it. */
function unmigratedStore(seed?: (db: Database.Database) => void): void {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(RBOOK_SCHEMA);
  seed?.(db);
  db.close();
}

/** What a failed migration must not leave behind. */
function untouched(client: RbookDatabaseClient): void {
  const fk = client.pragma('foreign_keys') as Array<{ foreign_keys: number }> | number;
  expect(Array.isArray(fk) ? fk[0].foreign_keys : fk).toBe(1);
  // A transaction left open would refuse this one.
  expect(client.raw('BEGIN IMMEDIATE').success).toBe(true);
  expect(client.raw('ROLLBACK').success).toBe(true);
  const eventType = client
    .getMany<{ name: string; notnull: number }>("PRAGMA table_info('strategic_decisions')")
    .data?.find((column) => column.name === 'event_type');
  expect(eventType?.notnull ?? 0).toBe(0);
  expect(client.getMany("SELECT name FROM sqlite_master WHERE name LIKE '%mig_tmp%'").data).toEqual(
    []
  );
  expect(
    client.getOne("SELECT value FROM metadata WHERE key = 'firehose_event_columns'").data
  ).toBeUndefined();
}

describe('the firehose migration under its lock', () => {
  it('rolls back the first table when the second one fails', async () => {
    // A learning the rebuilt table's check refuses, so the learnings rebuild fails after the
    // decisions rebuild has run (the build critic's probe, kept here as a fixture).
    unmigratedStore((db) =>
      db
        .prepare(
          "INSERT INTO learnings (content, created_at, event_type) VALUES ('x', datetime('now'), 'bogus')"
        )
        .run()
    );
    const client = (await RbookDatabaseClient.create({ dbPath: file })).data!;
    try {
      expect(() => ensureFirehoseEventColumns(client)).toThrow();
      untouched(client);
    } finally {
      client.close();
    }
  });

  it('changes nothing when another process holds the lock past the busy timeout', async () => {
    unmigratedStore();
    const holder = new Database(file);
    holder.exec('BEGIN IMMEDIATE');
    const client = (await RbookDatabaseClient.create({ dbPath: file, timeout: 100 })).data!;
    try {
      expect(() => ensureFirehoseEventColumns(client)).toThrow(/locked|busy/i);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    try {
      untouched(client);
    } finally {
      client.close();
    }
  });
});
