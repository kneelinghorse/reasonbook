// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m02 — a merge's session rename rewrites proposals.settled_by where the column exists, and skips it on a
// ABOUTME: store whose proposals table predates it, instead of throwing on a column that is not there (decision #1831).

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { renameRow } from '../../../src/tools/rbook/record-alias';
import { DERIVED_TABLES_SQL } from '../../../src/tools/rbook/record-guards';
import { seedRbookDb } from '../../helpers/seedRbookDb';

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-s109m02-alias-'));
  const projectRoot = path.join(tmp, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
  dbPath = seedRbookDb(projectRoot, { projectName: 'alias' });
  // A shared store's derived state, where the rename notes its alias.
  const db = new Database(dbPath);
  db.exec(DERIVED_TABLES_SQL);
  db.close();
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function rename(from: string, to: string): Promise<void> {
  const client = (await RbookDatabaseClient.create({ dbPath })).data!;
  try {
    renameRow(client, 'sessions', 'no-such-stable-id', from, to);
  } finally {
    client.close();
  }
}

function sql<T>(text: string, ...params: unknown[]): T {
  const db = new Database(dbPath);
  try {
    const statement = db.prepare(text);
    return (statement.reader ? statement.all(...params) : statement.run(...params)) as T;
  } finally {
    db.close();
  }
}

describe('the session rename and proposals.settled_by', () => {
  it('rewrites settled_by beside source_session', async () => {
    sql(
      "INSERT INTO proposals (text, created_at, source_session, settled_by) VALUES ('a draft', '2026-11-02T00:00:00Z', 'PS-a', 'PS-a')"
    );
    await rename('PS-a', 'PS-b');
    expect(sql('SELECT source_session, settled_by FROM proposals')).toEqual([
      { source_session: 'PS-b', settled_by: 'PS-b' },
    ]);
  });

  it('skips a proposals table without the column, and still rewrites the rest', async () => {
    sql('DROP TABLE proposals');
    sql(
      "CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'decision', source_session TEXT, created_at TEXT NOT NULL, outcome TEXT NOT NULL DEFAULT 'pending')"
    );
    sql(
      "INSERT INTO proposals (text, created_at, source_session) VALUES ('a draft', '2026-11-02T00:00:00Z', 'PS-a')"
    );
    await expect(rename('PS-a', 'PS-b')).resolves.toBeUndefined();
    expect(sql('SELECT source_session FROM proposals')).toEqual([{ source_session: 'PS-b' }]);
  });
});
