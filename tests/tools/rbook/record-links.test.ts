// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Required citation links are atomic and repair delayed imported endpoints.
// ABOUTME: Read-only graph reads revalidate current eligibility and never cache an absent table.
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import {
  ensureRecordLinks,
  materializeRecordLinks,
  repairRecordLinksBatch,
} from '../../../src/tools/rbook/record-links';
import { captureToolCall } from '../../../src/tools/rbook/tool-call-context';
import { RECORD_LINKS_TABLE_SQL } from '../../../src/tools/rbook/record-link-schema';
import * as linkStore from '../../../src/tools/rbook/record-link-store';

let root: string, client: RbookDatabaseClient;
const t = (offset: number) => new Date(Date.now() + offset).toISOString();
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-record-links-'));
  const dbPath = path.join(root, 'rbook/db/rbook.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO metadata VALUES('project_id','local');
    CREATE TABLE strategic_decisions(id INTEGER PRIMARY KEY,decision_text TEXT,created_at TEXT,project_id TEXT,context_text TEXT,alternatives TEXT,consequences TEXT,deciders TEXT);
    CREATE TABLE learnings(id INTEGER PRIMARY KEY,content TEXT,created_at TEXT,project_id TEXT);
    CREATE TABLE constraints(id INTEGER PRIMARY KEY,created_at TEXT,project_id TEXT);
    CREATE TABLE next_steps(id INTEGER PRIMARY KEY,created_at TEXT,project_id TEXT);
    CREATE TABLE agent_feedback(id INTEGER PRIMARY KEY,created_at TEXT,project_id TEXT);`);
  db.prepare(
    'INSERT INTO strategic_decisions(id,decision_text,created_at,project_id) VALUES(12,?,?,?)'
  ).run('older target', t(-30000), 'local');
  db.prepare(
    'INSERT INTO strategic_decisions(id,decision_text,created_at,project_id) VALUES(20,?,?,?)'
  ).run('decision #12', t(-10000), 'local');
  db.close();
  const opened = await RbookDatabaseClient.create({ dbPath });
  if (!opened.success || !opened.data) throw new Error('open');
  client = opened.data;
});
afterEach(() => {
  jest.restoreAllMocks();
  client?.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const edges = () => client.getMany('SELECT * FROM record_links ORDER BY from_id,to_id').data;
it('backfills the owned table atomically and stamps its version after success', () => {
  expect(ensureRecordLinks(client)).toMatchObject({
    ready: true,
    alreadyCurrent: false,
    warnings: [],
  });
  expect(edges()).toEqual([
    { from_kind: 'decision', from_id: 20, to_kind: 'decision', to_id: 12, resolution: 'typed' },
  ]);
  expect(client.getOne("SELECT value FROM metadata WHERE key='record_links_schema'").data).toEqual({
    value: '1',
  });
  expect(ensureRecordLinks(client)).toMatchObject({ ready: true, alreadyCurrent: true });
});
it('refuses foreign tables and unknown markers without changing their data', () => {
  client.raw("CREATE TABLE record_links(payload TEXT); INSERT INTO record_links VALUES('mine')");
  expect(ensureRecordLinks(client)).toMatchObject({ ready: false });
  expect(client.getMany('SELECT * FROM record_links').data).toEqual([{ payload: 'mine' }]);
  client.raw('DROP TABLE record_links');
  client.execute("INSERT INTO metadata VALUES('record_links_schema','999')");
  expect(ensureRecordLinks(client).warnings?.join(' ')).toMatch(/version/);
});
it.each(["'TYPED', 'BARE'", "'typed ', 'bare'"])(
  'does not normalize different CHECK literal semantics into owned schema: %s',
  (literals) => {
    client.execute('UPDATE strategic_decisions SET decision_text=?', ['no citations']);
    client.raw(RECORD_LINKS_TABLE_SQL.replace("'typed', 'bare'", literals));
    expect(ensureRecordLinks(client)).toMatchObject({ ready: false });
    expect(readRecordLinks(client).mode).toBe('error');
    expect(
      client.getOne("SELECT value FROM metadata WHERE key='record_links_schema'").data
    ).toBeUndefined();
  }
);
it('does not normalize a different quoted column name into owned schema', () => {
  client.execute('UPDATE strategic_decisions SET decision_text=?', ['no citations']);
  client.raw(RECORD_LINKS_TABLE_SQL.replace(/from_kind/g, '"from_ kind"'));
  expect(ensureRecordLinks(client)).toMatchObject({ ready: false });
  expect(readRecordLinks(client).mode).toBe('error');
});
it('rolls back created objects and partial backfill when marker write fails', () => {
  client.raw(
    "CREATE TRIGGER reject_marker BEFORE INSERT ON metadata WHEN NEW.key='record_links_schema' BEGIN SELECT RAISE(ABORT,'marker refused'); END"
  );
  expect(ensureRecordLinks(client).ready).toBe(false);
  expect(
    client.getOne("SELECT name FROM sqlite_master WHERE name='record_links'").data
  ).toBeUndefined();
  client.raw('DROP TRIGGER reject_marker');
  expect(ensureRecordLinks(client).ready).toBe(true);
});
it('defers missing schema under a read-only role without poisoning a later write', async () => {
  const result = await captureToolCall('read', async () => ensureRecordLinks(client));
  expect(result.value.ready).toBe(false);
  expect(ensureRecordLinks(client).ready).toBe(true);
});
it('does not roll back an outer transaction if BEGIN fails', () => {
  client.raw('BEGIN');
  client.execute("INSERT INTO metadata VALUES('outer','retained')");
  expect(ensureRecordLinks(client).ready).toBe(false);
  expect(client.getOne("SELECT value FROM metadata WHERE key='outer'").data).toEqual({
    value: 'retained',
  });
  expect(client.raw('ROLLBACK').success).toBe(true);
});
it('dedup repair uses stored fields and upgrades bare evidence without duplicate endpoints', () => {
  client.execute('UPDATE strategic_decisions SET decision_text=? WHERE id=20', ['#12']);
  expect(ensureRecordLinks(client).ready).toBe(true);
  expect(edges()).toMatchObject([{ resolution: 'bare' }]);
  client.execute('UPDATE strategic_decisions SET decision_text=?,context_text=? WHERE id=20', [
    '#12',
    'decision #12',
  ]);
  const result = client.transaction(() => {
    const r = materializeRecordLinks(client, 'decision', 20);
    if (!r.success) throw new Error(r.error?.message);
    return r.data;
  });
  expect(result.data).toMatchObject({ linkCount: 1 });
  expect(edges()).toMatchObject([{ resolution: 'typed' }]);
  expect(repairRecordLinksBatch(client, [{ kind: 'decision', id: 20 }]).data).toMatchObject({
    linksChanged: 0,
  });
  expect(materializeRecordLinks(client, 'decision', 999).success).toBe(false);
});
it('caller rollback removes its new source and any partial links when required link write fails', () => {
  ensureRecordLinks(client);
  client.raw(
    "CREATE TRIGGER fail_links BEFORE INSERT ON record_links WHEN NEW.from_id=30 BEGIN SELECT RAISE(ABORT,'links refused'); END"
  );
  const result = client.transaction(() => {
    client.execute(
      'INSERT INTO strategic_decisions(id,decision_text,created_at,project_id) VALUES(30,?,?,?)',
      ['d:12', t(0), 'local']
    );
    const r = materializeRecordLinks(client, 'decision', 30);
    if (!r.success) throw new Error(r.error?.message);
  });
  expect(result.success).toBe(false);
  expect(client.getOne('SELECT id FROM strategic_decisions WHERE id=30').data).toBeUndefined();
  expect(edges()).toHaveLength(1);
});
it('repairs an earlier source when a backdated endpoint arrives and invalidates new bare ambiguity', () => {
  client.execute('UPDATE strategic_decisions SET decision_text=? WHERE id=20', ['#13']);
  ensureRecordLinks(client);
  expect(edges()).toEqual([]);
  client.execute('INSERT INTO learnings VALUES(13,?,?,?)', [
    'later imported old learning',
    t(-20000),
    null,
  ]);
  expect(repairRecordLinksBatch(client, [{ kind: 'learning', id: 13 }]).success).toBe(true);
  expect(edges()).toEqual([
    { from_kind: 'decision', from_id: 20, to_kind: 'learning', to_id: 13, resolution: 'bare' },
  ]);
  client.execute(
    'INSERT INTO strategic_decisions(id,decision_text,created_at,project_id) VALUES(13,?,?,?)',
    ['collision', t(-25000), 'local']
  );
  expect(repairRecordLinksBatch(client, [{ kind: 'decision', id: 13 }]).success).toBe(true);
  expect(edges()).toEqual([]);
});
it('does not turn NULL time or foreign origins into local edges', () => {
  client.execute('UPDATE strategic_decisions SET created_at=NULL WHERE id=12');
  expect(ensureRecordLinks(client)).toMatchObject({ ready: true, discarded: { unknownTime: 1 } });
  expect(edges()).toEqual([]);
  client.execute('UPDATE strategic_decisions SET created_at=?,project_id=? WHERE id=12', [
    t(-30000),
    'foreign',
  ]);
  expect(materializeRecordLinks(client, 'decision', 20).data).toMatchObject({
    linkCount: 0,
    discarded: { foreign: 1 },
  });
});

import { readRecordLinks } from '../../../src/tools/rbook/record-links';
it.each([false, true])(
  'indexes the collision inventory once per read (persisted=%s)',
  (persisted) => {
    client.execute(
      'INSERT INTO strategic_decisions(id,decision_text,created_at,project_id) VALUES(21,?,?,?)',
      ['d:12', t(-5000), 'local']
    );
    if (persisted) ensureRecordLinks(client);
    const inventory = linkStore.loadLinkInventory(client);
    let iterations = 0;
    const identities = new Proxy(inventory.identities, {
      get(target, key, receiver) {
        if (key === Symbol.iterator) {
          iterations += 1;
          return target[Symbol.iterator].bind(target);
        }
        return Reflect.get(target, key, receiver);
      },
    });
    jest.spyOn(linkStore, 'loadLinkInventory').mockReturnValue({ ...inventory, identities });
    const read = readRecordLinks(client);
    expect(read.available).toBe(true);
    expect(read.links.map((edge) => edge.from_id).sort()).toEqual([20, 21]);
    // More citing records must not rescan the whole collision inventory for each source/edge.
    expect(iterations).toBe(1);
  }
);
it('readonly fallback is typed-only and absence does not poison a later migrated read', () => {
  client.execute('UPDATE strategic_decisions SET decision_text=? WHERE id=20', ['#12']);
  expect(readRecordLinks(client)).toMatchObject({
    available: true,
    mode: 'typed-fallback',
    links: [],
    warnings: [],
  });
  client.execute('UPDATE strategic_decisions SET decision_text=? WHERE id=20', ['decision #12']);
  expect(readRecordLinks(client).links).toHaveLength(1);
  expect(ensureRecordLinks(client).ready).toBe(true);
  const reader = {
    path: client.path,
    getOne: client.getOne.bind(client),
    getMany: client.getMany.bind(client),
  };
  expect(readRecordLinks(reader)).toMatchObject({
    available: true,
    mode: 'persisted',
    warnings: [],
  });
  expect(readRecordLinks(reader).links).toHaveLength(1);
});
it('rejects a stored bare edge after a later unrelated-table collision, without a writer hook', () => {
  client.execute('UPDATE strategic_decisions SET decision_text=? WHERE id=20', ['#12']);
  ensureRecordLinks(client);
  expect(readRecordLinks(client).links).toHaveLength(1);
  client.execute('INSERT INTO agent_feedback VALUES(12,?,?)', [t(10000), 'foreign']);
  expect(edges()).toHaveLength(1);
  expect(readRecordLinks(client).links).toEqual([]);
  expect(readRecordLinks(client).discarded.ambiguous).toBe(1);
});
it('rechecks endpoint origins and times even for previously valid typed edges', () => {
  ensureRecordLinks(client);
  client.execute('UPDATE strategic_decisions SET project_id=? WHERE id=12', ['foreign']);
  expect(readRecordLinks(client).links).toEqual([]);
  client.execute('UPDATE strategic_decisions SET project_id=NULL,created_at=NULL WHERE id=12');
  expect(readRecordLinks(client).discarded.unknownTime).toBe(1);
});
it('names query failures and retries the real table on the next read', () => {
  ensureRecordLinks(client);
  const getMany = client.getMany.bind(client);
  const spy = jest
    .spyOn(client, 'getMany')
    .mockImplementation((sql, params) =>
      sql === 'SELECT * FROM record_links'
        ? { success: false, error: { code: 'DB_QUERY_FAILED', message: 'injected read' } }
        : getMany(sql, params)
    );
  expect(readRecordLinks(client)).toMatchObject({ available: false, mode: 'error', links: [] });
  expect(readRecordLinks(client).warnings.join(' ')).toMatch(
    /RECORD_LINKS_READ_FAILED.*injected read/
  );
  spy.mockRestore();
  expect(readRecordLinks(client).links).toHaveLength(1);
});
it('rejects forged version claims and foreign schemas in readonly consumers', () => {
  client.raw(
    'CREATE TABLE record_links(from_kind TEXT,from_id INTEGER,to_kind TEXT,to_id INTEGER,resolution TEXT)'
  );
  expect(readRecordLinks(client).mode).toBe('error');
  client.raw('DROP TABLE record_links');
  client.execute("INSERT INTO metadata VALUES('record_links_schema','1')");
  expect(readRecordLinks(client).warnings.join(' ')).toMatch(/disagrees/);
});
