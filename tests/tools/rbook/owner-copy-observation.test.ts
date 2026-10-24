// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A files-joined owner copy must block a dashboard share before its first exchange or write.
// ABOUTME: Real stores preserve separate call/exchange observations and honest, inert set-aside previews.
import { shareThroughDashboard } from '../../../src/tools/rbook/record-dashboard-share';
import { ownersOtherCopies } from '../../../src/tools/rbook/record-owner-copies';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { rememberPeer } from '../../../src/tools/rbook/record-peers';
import { setAsideReplica } from '../../../src/tools/rbook/record-set-aside';
import { storeOpener } from '../../../src/tools/rbook/record-sync';
import {
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { hostProject, joinThroughReferee } from '../../helpers/referee-fixture';
import { joinedCopy, onCopy, ownerCopy, read, type Copy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
let sharingWas: string | undefined;
beforeEach(() => {
  fixture = replicaFixture('rbook-owner-files-observation-');
  sharingWas = process.env.RBOOK_DASHBOARD_SHARING;
  delete process.env.RBOOK_DASHBOARD_SHARING;
});
afterEach(() => {
  if (sharingWas === undefined) delete process.env.RBOOK_DASHBOARD_SHARING;
  else process.env.RBOOK_DASHBOARD_SHARING = sharingWas;
  fixture.restore();
});

const changes = (copy: Copy) => read(copy, 'SELECT * FROM record_changes ORDER BY rowid');
async function pair() {
  const owner = await ownerCopy(fixture.tmp);
  const other = await joinedCopy(fixture.tmp, owner, 'owner-second', 'Owner');
  return { owner, other };
}

it('counts the real files-join call before an owner copy has exchanged or written', async () => {
  const { owner, other } = await pair();
  await onCopy(fixture.tmp, owner, (client) => {
    expect(
      client.getOne(
        'SELECT route, last_ok_at, last_call_at FROM record_peers WHERE replica_id = ?',
        [other.replicaId]
      ).data
    ).toEqual({ route: null, last_ok_at: null, last_call_at: expect.any(String) });
    expect(
      client.getMany('SELECT 1 FROM record_changes WHERE replica_id = ?', [other.replicaId]).data
    ).toEqual([]);
    expect(ownersOtherCopies(client)).toEqual([
      { replicaId: other.replicaId, block: other.block, route: null },
    ]);
  });
});

it('refuses an offline dashboard share and names the files-joined owner copy without cutting it', async () => {
  const { owner, other } = await pair();
  const before = changes(owner);
  useMachine(fixture.tmp, owner.machine);
  const result = await shareThroughDashboard(
    storeOpener(dbOf(owner.root)),
    storeOpener(dbOf(owner.root), { replicaCheck: false }),
    dbOf(owner.root),
    { confirm: false, projectId: 'files-joined-project' }
  );
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain(other.replicaId);
  expect(changes(owner)).toEqual(before);
});

it.each([false, true])(
  'reports the last call separately from a completed exchange, exchanged=%s',
  async (exchanged) => {
    const { owner, other } = await pair();
    const lastCallAt = new Date(Date.now() - 60_000).toISOString();
    const lastExchangeAt = exchanged ? new Date(Date.now() - 120_000).toISOString() : null;
    await onCopy(fixture.tmp, owner, (client) => {
      expect(
        client.execute(
          'UPDATE record_peers SET last_call_at = ?, last_ok_at = ? WHERE replica_id = ?',
          [lastCallAt, lastExchangeAt, other.replicaId]
        ).success
      ).toBe(true);
      const before = client.getMany('SELECT * FROM record_changes ORDER BY rowid');
      const preview = setAsideReplica(client, { replicaId: other.replicaId });
      expect(preview.success).toBe(true);
      expect(preview.data).toMatchObject({ dryRun: true, lastCallAt, lastExchangeAt });
      expect(client.getMany('SELECT * FROM record_changes ORDER BY rowid')).toEqual(before);
    });
  }
);

it.each(['absent', 'old', 'null', 'old-exchanged'] as const)(
  'reads %s peer observations without creating or migrating their table',
  async (schema) => {
    const { owner, other } = await pair();
    await onCopy(fixture.tmp, owner, (client) => {
      expect(client.raw('DROP TABLE record_peers').success).toBe(true);
      const lastExchangeAt =
        schema === 'old-exchanged' ? new Date(Date.now() - 60_000).toISOString() : null;
      if (schema !== 'absent') {
        expect(
          client.execute(`CREATE TABLE record_peers (replica_id TEXT PRIMARY KEY, name TEXT,
            route TEXT, marks TEXT, digest TEXT, last_ok_at TEXT, last_error TEXT, last_error_at TEXT${
              schema === 'null' ? ', last_call_at TEXT' : ''
            })`).success
        ).toBe(true);
        expect(
          client.execute('INSERT INTO record_peers (replica_id, last_ok_at) VALUES (?, ?)', [
            other.replicaId,
            lastExchangeAt,
          ]).success
        ).toBe(true);
      }
      const columns = client.getMany('PRAGMA table_info(record_peers)');
      expect(ownersOtherCopies(client)).toEqual(
        lastExchangeAt ? [{ replicaId: other.replicaId, block: other.block, route: null }] : []
      );
      const preview = setAsideReplica(client, { replicaId: other.replicaId });
      expect(preview.success).toBe(true);
      expect(client.getMany('PRAGMA table_info(record_peers)')).toEqual(columns);
      expect(preview.data).toMatchObject({ lastCallAt: null, lastExchangeAt });
    });
  }
);

it('observes a last call after an absent peer table is created in the same client', async () => {
  const { owner, other } = await pair();
  await onCopy(fixture.tmp, owner, (client) => {
    expect(client.raw('DROP TABLE record_peers').success).toBe(true);
    expect(ownersOtherCopies(client)).toEqual([]);
    rememberCopyReport(
      client,
      other.replicaId,
      { libraryVersion: '4.5.0', reads: 2 },
      { called: true }
    );
    expect(ownersOtherCopies(client)).toEqual([
      { replicaId: other.replicaId, block: other.block, route: null },
    ]);
  });
});

it.each([false, true])('excludes a dashboard last-call observation, ended=%s', async (ended) => {
  const { owner, other } = await pair();
  await onCopy(fixture.tmp, owner, (client) => {
    rememberPeer(client, other.replicaId, {
      route: {
        kind: 'dashboard',
        url: 'http://127.0.0.1:9',
        projectId: 'former-host',
        ...(ended ? { ended: true as const } : {}),
      },
    });
    expect(
      client.getOne('SELECT last_call_at FROM record_peers WHERE replica_id = ?', [other.replicaId])
        .data
    ).toEqual({ last_call_at: expect.any(String) });
    expect(ownersOtherCopies(client)).toEqual([]);
  });
});

it.each([true, false])(
  'refuses a hosted set-aside honestly without cutting the copy, dryRun=%s',
  async (dryRun) => {
    const hosted = await hostProject(fixture.tmp);
    const member = await joinThroughReferee(fixture.tmp, hosted, 'Erin', 'acct-erin');
    await onCopy(fixture.tmp, hosted.owner, (client) =>
      rememberPeer(client, hosted.refereeReplica, {
        route: { kind: 'dashboard', url: 'https://reasonbook.ai', projectId: 'hosted-project' },
      })
    );
    const before = changes(hosted.owner);
    const result = await onCopy(fixture.tmp, hosted.owner, (client) =>
      setAsideReplica(client, { replicaId: member.replicaId, dryRun })
    );
    expect(result.success).toBe(false);
    const said = `${result.error?.message} ${result.error?.suggestion}`;
    expect(said).toMatch(/reasonbook\.ai.*cannot.*set.*copy aside.*yet/i);
    expect(said).toMatch(/only delays protocol 2/i);
    expect(said).not.toMatch(/set aside the copy on the sharing page/i);
    expect(changes(hosted.owner)).toEqual(before);
  }
);
