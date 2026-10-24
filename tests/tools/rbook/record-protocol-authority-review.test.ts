// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The authority names stranded copies, while members never diagnose another copy as blocking.
// ABOUTME: Hosted reviews describe upgrading without promising an unavailable set-aside control.
import { inviteMember } from '../../../src/tools/rbook/record-membership';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { rememberPeer } from '../../../src/tools/rbook/record-peers';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { protocolReview } from '../../../src/tools/rbook/record-protocol-review';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, sync, type Copy } from '../../helpers/shared-copies';
let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-authority-review-');
});
afterEach(() => fixture.restore());
async function pair() {
  const undo = upgradeRecordProtocolForTesting(1);
  try {
    const owner = await ownerCopy(fixture.tmp);
    const member = await joinedCopy(fixture.tmp, owner, 'pat', 'Pat');
    return { owner, member };
  } finally {
    undo();
  }
}
it.each([false, true])(
  'member review has no blockers or set-aside remedy, hosted=%s',
  async (hosted) => {
    const { owner, member } = await pair();
    await onCopy(fixture.tmp, member, (client) => {
      rememberCopyReport(client, owner.replicaId, { reads: 1 }, { called: true });
      if (hosted)
        rememberPeer(client, owner.replicaId, {
          route: { kind: 'dashboard', url: 'https://reasonbook.ai', projectId: 'test' },
        });
      const review = protocolReview(client);
      expect(review.blockers).toEqual([]);
      expect(review.detail).not.toMatch(/set.aside/i);
      expect(review.detail).toMatch(
        hosted ? /referee.*every active copy/i : /owner.*every active copy/i
      );
    });
  }
);
it.each([false, true])(
  'authority names an already-stranded old copy without a false hosted remedy, hosted=%s',
  async (hosted) => {
    const { owner, member } = await pair();
    await onCopy(fixture.tmp, owner, (client) => {
      rememberCopyReport(client, member.replicaId, { reads: 2 }, { called: true });
      expect(inviteMember(client, { name: 'Switch' }).success).toBe(true);
      rememberCopyReport(client, member.replicaId, { reads: 1 }, { called: true });
      if (hosted) {
        expect(
          client.raw(
            'CREATE TABLE referee_state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE referee_copies(replica_id TEXT PRIMARY KEY,last_call_at TEXT,reads INTEGER,library_version TEXT)'
          ).success
        ).toBe(true);
        expect(
          client.execute('INSERT INTO referee_copies VALUES(?,?,?,?)', [
            member.replicaId,
            new Date().toISOString(),
            1,
            '4.4.0',
          ]).success
        ).toBe(true);
      }
      const review = protocolReview(client);
      expect(review).toMatchObject({
        writeProtocol: 2,
        blockers: [],
        stranded: [{ replicaId: member.replicaId, memberName: 'Pat', reads: 1 }],
      });
      expect(review.summary).toMatch(/1 stranded/);
      expect(review.detail).toMatch(/receives nothing new since.*term.*sequence/i);
      expect(review.detail).toMatch(/upgrade/i);
      if (hosted) expect(review.detail).not.toMatch(/set.aside/i);
    });
  }
);
