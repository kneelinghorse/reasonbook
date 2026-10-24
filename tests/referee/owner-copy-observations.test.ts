// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A share must count used owner copies even before their first write reaches this store.
// ABOUTME: Real stores distinguish observation, route, term and successor evidence without hiding read failures.
import { admitSuccessor } from '../../src/tools/rbook/record-admit-successor';
import { confirmOwner, handOver } from '../../src/tools/rbook/record-moves';
import { ownersOtherCopies } from '../../src/tools/rbook/record-owner-copies';
import { recordExchanged, rememberPeer } from '../../src/tools/rbook/record-peers';
import { replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, syncCopies, type Copy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-owner-observation-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

async function pair() {
  const owner = await ownerCopy(fixture.tmp);
  const other = await joinedCopy(fixture.tmp, owner, 'owner-second', 'Owner');
  return { owner, other };
}

const count = (owner: Copy) => onCopy(fixture.tmp, owner, ownersOtherCopies);
const observe = (owner: Copy, replicaId: string) =>
  onCopy(fixture.tmp, owner, (client) => recordExchanged(client, replicaId, { marks: {} }));
const route = (owner: Copy, other: Copy) =>
  onCopy(fixture.tmp, owner, (client) =>
    rememberPeer(client, other.replicaId, { route: { host: 'other.local', root: '/work/project' } })
  );

async function formerOwner() {
  const { owner: former, other: owner } = await pair();
  await syncCopies(fixture.tmp, owner, former);
  expect(
    (await onCopy(fixture.tmp, former, (c) => handOver(c, { to: owner.replicaId }))).success
  ).toBe(true);
  await syncCopies(fixture.tmp, former, owner);
  expect((await onCopy(fixture.tmp, owner, confirmOwner, { replicaCheck: false })).success).toBe(
    true
  );
  await syncCopies(fixture.tmp, former, owner);
  // These scenarios isolate route/exchange evidence from the calls made during handover.
  await onCopy(fixture.tmp, owner, (client) => {
    expect(
      client.execute(
        'UPDATE record_peers SET last_call_at = NULL, last_ok_at = NULL WHERE replica_id = ?',
        [former.replicaId]
      ).success
    ).toBe(true);
  });
  expect(await count(owner)).toEqual([]);
  return { former, owner };
}

it('distinguishes an absent peer table, a NULL peer row, and a completed exchange in the same store', async () => {
  const { owner, other } = await pair();
  await onCopy(fixture.tmp, owner, (client) => {
    expect(client.raw('DROP TABLE IF EXISTS record_peers').success).toBe(true);
    expect(ownersOtherCopies(client)).toEqual([]);
    rememberPeer(client, other.replicaId, { name: 'Owner' });
    expect(
      client.getOne('SELECT route, last_ok_at FROM record_peers WHERE replica_id = ?', [
        other.replicaId,
      ]).data
    ).toEqual({ route: null, last_ok_at: null });
    expect(ownersOtherCopies(client)).toEqual([]);
    recordExchanged(client, other.replicaId, { marks: {} });
    expect(ownersOtherCopies(client)).toEqual([
      { replicaId: other.replicaId, block: other.block, route: null },
    ]);
  });
});

it.each(['route', 'observation'] as const)(
  'counts a former authority with %s evidence despite no post-term write',
  async (evidence) => {
    const { owner, former } = await formerOwner();
    if (evidence === 'route') await route(owner, former);
    else await observe(owner, former.replicaId);
    expect(await count(owner)).toEqual([
      {
        replicaId: former.replicaId,
        block: former.block,
        route: evidence === 'route' ? 'other.local:/work/project' : null,
      },
    ]);
  }
);

it.each([false, true])(
  'excludes a former dashboard authority observation, ended=%s',
  async (ended) => {
    const { owner, former } = await formerOwner();
    await onCopy(fixture.tmp, owner, (client) => {
      rememberPeer(client, former.replicaId, {
        route: {
          kind: 'dashboard',
          url: 'http://127.0.0.1:9',
          projectId: 'old-host',
          ...(ended ? { ended: true as const } : {}),
        },
      });
      recordExchanged(client, former.replicaId, { marks: {} });
    });
    expect(await count(owner)).toEqual([]);
  }
);

it('keeps a predecessor until its unwritten successor calls, ignoring a dashboard-only observation', async () => {
  const { owner, other } = await pair();
  await route(owner, other);
  const admitted = await onCopy(fixture.tmp, owner, (client) =>
    admitSuccessor(client, { replicaId: other.replicaId })
  );
  expect(admitted.success).toBe(true);
  const successor = admitted.data!;
  expect((await count(owner)).map((copy) => copy.replicaId)).toEqual([other.replicaId]);
  await onCopy(fixture.tmp, owner, (client) => {
    rememberPeer(client, successor.replicaId, {
      route: { kind: 'dashboard', url: 'http://127.0.0.1:9', projectId: 'rehearsal' },
    });
    recordExchanged(client, successor.replicaId, { marks: {} });
  });
  expect((await count(owner)).map((copy) => copy.replicaId)).toEqual([other.replicaId]);
  await onCopy(fixture.tmp, owner, (client) => {
    expect(
      client.execute('UPDATE record_peers SET route = NULL WHERE replica_id = ?', [
        successor.replicaId,
      ]).success
    ).toBe(true);
  });
  expect(await count(owner)).toEqual([
    { replicaId: successor.replicaId, block: successor.block, route: null },
  ]);
});

it.each(['table', 'peer', 'changes'] as const)(
  'surfaces a failed %s read instead of permitting a share',
  async (fault) => {
    const { owner, other } = await pair();
    await onCopy(fixture.tmp, owner, (client) => {
      rememberPeer(client, other.replicaId, { name: 'Owner' });
      if (fault === 'changes') {
        // With no call evidence, the write-evidence query must run and fail loudly.
        expect(
          client.execute(
            'UPDATE record_peers SET last_call_at = NULL, last_ok_at = NULL WHERE replica_id = ?',
            [other.replicaId]
          ).success
        ).toBe(true);
      }
      let injected = 0;
      const failure = {
        success: false as const,
        error: { code: 'INJECTED', message: `owner-copy ${fault} read failed` },
      };
      if (fault === 'table') {
        const original = client.getOne.bind(client);
        jest.spyOn(client, 'getOne').mockImplementation((sql, params) => {
          if (sql.includes('sqlite_master') && sql.includes('record_peers')) {
            injected += 1;
            return failure;
          }
          return original(sql, params);
        });
      } else {
        const original = client.getMany.bind(client);
        jest.spyOn(client, 'getMany').mockImplementation((sql, params) => {
          if (
            (fault === 'peer' && /FROM record_peers\b/.test(sql)) ||
            (fault === 'changes' && /SELECT 1 FROM record_changes\b/.test(sql))
          ) {
            injected += 1;
            return failure;
          }
          return original(sql, params);
        });
      }
      expect(() => ownersOtherCopies(client)).toThrow(`owner-copy ${fault} read failed`);
      expect(injected).toBeGreaterThan(0);
    });
  }
);

it('fails loudly on malformed persisted route JSON rather than dropping its observation', async () => {
  const { owner, other } = await pair();
  await observe(owner, other.replicaId);
  await onCopy(fixture.tmp, owner, (client) => {
    expect(
      client.execute('UPDATE record_peers SET route = ? WHERE replica_id = ?', [
        '{broken',
        other.replicaId,
      ]).success
    ).toBe(true);
    expect(() => ownersOtherCopies(client)).toThrow(SyntaxError);
  });
});
