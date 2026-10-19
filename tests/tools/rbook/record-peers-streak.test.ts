// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m10 critics, round 1 — a copy's failing streak with a peer counts once per failed sync, starts over on a new
// ABOUTME: route, survives a 4.1.0 peer table; a delivery's page reports add up only what each page took in.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { ApplyReport } from '../../../src/tools/rbook/record-apply';
import { mergePageReports, withoutHome } from '../../../src/tools/rbook/record-dashboard-peer';
import {
  nextTryAt,
  peerHealth,
  recordExchanged,
  recordExchangeFailed,
  rememberPeer,
} from '../../../src/tools/rbook/record-peers';
import { dbOf, replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { onCopy, ownerCopy } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-peer-streak-');
});
afterEach(() => fixture.restore());

const route = { kind: 'dashboard' as const, url: 'https://reasonbook.ai', projectId: 'p1' };

describe("a copy's failing streak with a peer (s97-m10)", () => {
  it('counts once per failed sync, waits it out, and clears on a good exchange', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const health = await onCopy(fixture.tmp, owner, (client) => {
      rememberPeer(client, 'referee', { route });
      // The exchange's own note of a clash, then the sync's count of it: one failed sync.
      recordExchangeFailed(client, 'referee', 'the chains differ');
      recordExchangeFailed(client, 'referee', 'the chains differ', { count: true });
      return peerHealth(client).find((peer) => peer.replicaId === 'referee')!;
    });
    expect({ failures: health.failures, error: health.lastError }).toEqual({
      failures: 1,
      error: 'the chains differ',
    });
    expect(nextTryAt(health, Date.parse(health.lastErrorAt!) + 60_000)).toEqual(expect.any(String));
    expect(nextTryAt(health, Date.parse(health.lastErrorAt!) + 5 * 60_000 + 1)).toBeNull();
    const cleared = await onCopy(fixture.tmp, owner, (client) => {
      recordExchanged(client, 'referee', { marks: {} });
      return peerHealth(client).find((peer) => peer.replicaId === 'referee')!;
    });
    expect({ failures: cleared.failures, since: cleared.failingSince }).toEqual({
      failures: 0,
      since: null,
    });
  }, 120000);

  it('starts over on a new route, and keeps its streak when the same route is remembered again', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const [same, moved] = await onCopy(fixture.tmp, owner, (client) => {
      rememberPeer(client, 'referee', { route });
      recordExchangeFailed(client, 'referee', 'down', { count: true });
      rememberPeer(client, 'referee', { route });
      const kept = peerHealth(client).find((peer) => peer.replicaId === 'referee')!;
      rememberPeer(client, 'referee', { route: { ...route, projectId: 'p2' } });
      return [kept, peerHealth(client).find((peer) => peer.replicaId === 'referee')!];
    });
    expect(same.failures).toBe(1);
    expect({
      failures: moved.failures,
      since: moved.failingSince,
      error: moved.lastError,
    }).toEqual({ failures: 0, since: null, error: null });
  }, 120000);

  // s97-m14 (critics, round 1): a removal is this copy's own membership. True keeps when it was first
  // said, false clears it, and undefined, a far side's or a referee's note, leaves it.
  it('keeps when a removal was first said, clears it as a member, and leaves it for a note that says nothing', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const said = (removed?: boolean) =>
      onCopy(fixture.tmp, owner, (client) => {
        recordExchanged(client, 'referee', {
          marks: {},
          ...(removed === undefined ? {} : { removed }),
        });
        return peerHealth(client).find((peer) => peer.replicaId === 'referee')!.removedAt;
      });
    const first = await said(true);
    expect(first).toEqual(expect.any(String));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await said(true)).toBe(first);
    expect(await said(undefined)).toBe(first);
    expect(await said(false)).toBeNull();
    expect(await said(undefined)).toBeNull();
  }, 120000);

  it("takes the new columns into a peer table 4.1.0 made, on the copy's next write", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const db = new Database(dbOf(owner.root));
    db.exec(`CREATE TABLE record_peers (replica_id TEXT PRIMARY KEY, name TEXT, route TEXT, marks TEXT,
      digest TEXT, last_ok_at TEXT, last_error TEXT, last_error_at TEXT)`);
    db.prepare('INSERT INTO record_peers (replica_id, route) VALUES (?, ?)').run(
      'studio',
      JSON.stringify({ host: 'studio', root: '/x' })
    );
    db.close();
    // A read never alters the table; it reads the 4.1.0 row as no streak.
    const before = await onCopy(fixture.tmp, owner, (client) => peerHealth(client)[0]);
    expect({ failures: before.failures, since: before.failingSince }).toEqual({
      failures: 0,
      since: null,
    });
    const after = await onCopy(fixture.tmp, owner, (client) => {
      recordExchangeFailed(client, 'studio', 'unreachable', { count: true });
      return peerHealth(client)[0];
    });
    expect({ failures: after.failures, since: after.failingSince }).toEqual({
      failures: 1,
      since: expect.any(String),
    });
  }, 120000);
});

describe("a delivery's pages, reported as one (s97-m10)", () => {
  const page = (over: Partial<ApplyReport>): ApplyReport => ({
    stored: 2,
    duplicates: 0,
    judged: 2,
    recomputed: 3,
    held: 1,
    conflicts: 1,
    checks: 1,
    folded: 0,
    newlyLive: ['t'],
    notes: [],
    ...over,
  });

  it('adds up what each page took in, and keeps the record-wide counts of the last page', () => {
    expect(mergePageReports(mergePageReports(null, page({})), page({ newlyLive: ['u'] }))).toEqual(
      page({ stored: 4, judged: 4, recomputed: 6, newlyLive: ['t', 'u'] })
    );
  });

  it("names this machine's home folder as ~ in a failure it reports to the dashboard", () => {
    expect(withoutHome('/Users/darryl/work/rbook/db: busy', '/Users/darryl')).toBe(
      '~/work/rbook/db: busy'
    );
    expect(withoutHome('/x: busy', '/')).toBe('/x: busy');
  });
});
