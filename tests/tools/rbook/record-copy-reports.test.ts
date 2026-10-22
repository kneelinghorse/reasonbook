// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Report this installed copy's actual capabilities without claiming a future protocol or release.
// ABOUTME: Preserve per-copy observations across old schemas and replace stale capability knowledge on downgrade.
import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';
import { getServerVersion } from '../../../src/server-version';
import { hello } from '../../../src/tools/rbook/record-exchange';
import { writeBundle } from '../../../src/tools/rbook/record-bundle';
import { buildFreshCopy } from '../../../src/tools/rbook/record-fresh-copy';
import { requestJoin } from '../../../src/tools/rbook/record-join';
import { recordExchanged } from '../../../src/tools/rbook/record-peers';
import { dbOf, replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { onCopy, ownerCopy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-copy-reports-');
});
afterEach(() => fixture.restore());
const localReport = () => ({ libraryVersion: getServerVersion(), reads: 2 });

it('hello reports the installed library and current read support independently of its write protocol', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const answer = await onCopy(fixture.tmp, owner, hello);
  expect(answer).toMatchObject({ ...localReport(), recordProtocol: 1 });
});

it('the hashed bundle header carries the writer capability report', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const bundle = await onCopy(fixture.tmp, owner, (client) => writeBundle(client, {}));
  expect(bundle.from).toMatchObject(localReport());
  expect(bundle.protocol).toBe(1);
});

it('an unjoined copy reports its own installed capabilities in its join request', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const joining = { root: path.join(fixture.tmp, 'joining'), machine: 'joining' };
  mkdirSync(path.dirname(dbOf(joining.root)), { recursive: true });
  await buildFreshCopy(dbOf(owner.root), dbOf(joining.root));
  const request = await onCopy(fixture.tmp, joining, requestJoin, { replicaCheck: false });
  expect(request.success).toBe(true);
  expect(request.data).toMatchObject(localReport());
});

it.each([false, true])(
  'persists a completed exchange report with an old peer schema=%s',
  async (old) => {
    const owner = await ownerCopy(fixture.tmp);
    if (old) {
      const db = new Database(dbOf(owner.root));
      try {
        db.exec(`CREATE TABLE record_peers (replica_id TEXT PRIMARY KEY, name TEXT, route TEXT,
        marks TEXT, digest TEXT, last_ok_at TEXT, last_error TEXT, last_error_at TEXT)`);
        db.prepare('INSERT INTO record_peers (replica_id) VALUES (?)').run('remote');
      } finally {
        db.close();
      }
    }
    const row = await onCopy(fixture.tmp, owner, (client) => {
      recordExchanged(client, 'remote', { marks: {}, ...localReport() });
      return client.getOne<Record<string, unknown>>(
        'SELECT * FROM record_peers WHERE replica_id = ?',
        ['remote']
      );
    });
    expect(row.success).toBe(true);
    expect(row.data).toMatchObject({ library_version: getServerVersion(), reads: 2 });
  }
);

it('a subsequent old or unreported exchange replaces previously reported capabilities', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const reports = await onCopy(fixture.tmp, owner, (client) => {
    const row = () =>
      client.getOne<Record<string, unknown>>('SELECT * FROM record_peers WHERE replica_id = ?', [
        'remote',
      ]).data;
    recordExchanged(client, 'remote', { marks: {}, libraryVersion: '4.5.0', reads: 2 } as never);
    const newer = row();
    recordExchanged(client, 'remote', { marks: {}, libraryVersion: '4.2.0', reads: 1 } as never);
    const downgraded = row();
    recordExchanged(client, 'remote', { marks: {} });
    return { newer, downgraded, unreported: row() };
  });
  expect(reports.newer).toMatchObject({ library_version: '4.5.0', reads: 2 });
  expect(reports.downgraded).toMatchObject({ library_version: '4.2.0', reads: 1 });
  expect(reports.unreported).toMatchObject({ library_version: null, reads: null });
});

// Dynamic loading keeps the pre-implementation failure at the missing public helper boundary.
const peerReports = () =>
  require('../../../src/tools/rbook/record-peer-report') as {
    reportedCopy: (
      client: unknown,
      replicaId: string
    ) => { libraryVersion: string | null; reads: number | null };
    rememberCopyReport: (client: unknown, replicaId: string, report: unknown) => void;
  };

it('a capability read leaves an absent table absent, then sees a later capability-only row', async () => {
  const owner = await ownerCopy(fixture.tmp);
  await onCopy(fixture.tmp, owner, (client) => {
    const { reportedCopy, rememberCopyReport } = peerReports();
    expect(reportedCopy(client, 'remote')).toEqual({ libraryVersion: null, reads: null });
    expect(
      client.getOne("SELECT name FROM sqlite_master WHERE name='record_peers'").data
    ).toBeUndefined();
    rememberCopyReport(client, 'remote', localReport());
    expect(reportedCopy(client, 'remote')).toEqual(localReport());
    expect(
      client.getOne<{ last_ok_at: string | null }>('SELECT last_ok_at FROM record_peers').data
        ?.last_ok_at
    ).toBeNull();
  });
});

it.each([false, true])(
  'a read of old/nullable capability columns never migrates: columns=%s',
  async (columns) => {
    const owner = await ownerCopy(fixture.tmp);
    const db = new Database(dbOf(owner.root));
    try {
      db.exec(
        `CREATE TABLE record_peers (replica_id TEXT PRIMARY KEY${columns ? ', library_version TEXT, reads INTEGER' : ''})`
      );
      db.prepare('INSERT INTO record_peers (replica_id) VALUES (?)').run('remote');
    } finally {
      db.close();
    }
    await onCopy(fixture.tmp, owner, (client) => {
      const before = client.getMany('PRAGMA table_info(record_peers)');
      expect(peerReports().reportedCopy(client, 'remote')).toEqual({
        libraryVersion: null,
        reads: null,
      });
      expect(client.getMany('PRAGMA table_info(record_peers)')).toEqual(before);
    });
  }
);

it.each([
  { libraryVersion: null, reads: null },
  { libraryVersion: '4.2.0', reads: 1 },
  { libraryVersion: '\u001b[2K4.5.0', reads: Infinity },
  { libraryVersion: 5, reads: '2' },
])(
  'capability-only observations replace stale knowledge without asserting an exchange: %j',
  async (report) => {
    const owner = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, owner, (client) => {
      const { reportedCopy, rememberCopyReport } = peerReports();
      rememberCopyReport(client, 'remote', { libraryVersion: '4.5.0', reads: 2 });
      rememberCopyReport(client, 'remote', report);
      expect(reportedCopy(client, 'remote')).toEqual(
        report.libraryVersion === '4.2.0'
          ? { libraryVersion: '4.2.0', reads: 1 }
          : { libraryVersion: null, reads: null }
      );
      expect(
        client.getOne<{ last_ok_at: string | null }>('SELECT last_ok_at FROM record_peers').data
          ?.last_ok_at
      ).toBeNull();
    });
  }
);

it('a failed capability query surfaces instead of being interpreted as an old copy', () => {
  expect(() =>
    peerReports().reportedCopy(
      {
        getOne: () => ({ success: false, error: { message: 'injected capability read failure' } }),
      },
      'remote'
    )
  ).toThrow('injected capability read failure');
});

it('a failed capability write surfaces and rolls back its metadata-only row', async () => {
  const owner = await ownerCopy(fixture.tmp);
  await onCopy(fixture.tmp, owner, (client) => {
    const original = client.execute.bind(client);
    const execute = jest.spyOn(client, 'execute');
    execute.mockImplementation((sql, values) =>
      /UPDATE record_peers SET library_version/.test(sql)
        ? {
            success: false,
            error: { code: 'INJECTED', message: 'injected capability write failure' },
          }
        : original(sql, values)
    );
    expect(() => peerReports().rememberCopyReport(client, 'remote', localReport())).toThrow(
      'injected capability write failure'
    );
    execute.mockRestore();
    const table = client.getOne("SELECT name FROM sqlite_master WHERE name='record_peers'");
    if (table.data) expect(client.getMany('SELECT * FROM record_peers').data).toEqual([]);
  });
});
