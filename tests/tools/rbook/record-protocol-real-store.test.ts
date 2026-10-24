// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercise activity, re-admission and stranded review on a backed-up real store when supplied.
// ABOUTME: The source stays read-only; explicit source-row and backup receipts prevent a synthetic run posing as evidence.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { inviteMember, removeMember } from '../../../src/tools/rbook/record-membership';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { handOver, confirmOwner } from '../../../src/tools/rbook/record-moves';
import { upgradeRecordProtocolForTesting } from '../../../src/tools/rbook/record-protocol';
import { currentWriteProtocol } from '../../../src/tools/rbook/record-protocol-state';
import { protocolReview } from '../../../src/tools/rbook/record-protocol-review';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';
import { dbOf, replicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, shareExisting, sync, type Copy } from '../../helpers/shared-copies';

it('a former owner and restored old member hold real recorded writes until both report reads2', async () => {
  const fixture = replicaFixture('rbook-protocol-real-store-');
  const root = path.join(fixture.tmp, 'owner');
  const sourcePath = process.env.RBOOK_UPLOAD_FIXTURE;
  let sourceCount = 0;
  try {
    if (sourcePath) {
      fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
      const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
      try {
        sourceCount = source.prepare('SELECT COUNT(*) FROM missions').pluck().get() as number;
        expect(sourceCount).toBeGreaterThan(0);
        await source.backup(dbOf(root));
      } finally {
        source.close();
      }
      const backup = new Database(dbOf(root), { readonly: true });
      try {
        expect(backup.prepare('SELECT COUNT(*) FROM missions').pluck().get()).toBe(sourceCount);
      } finally {
        backup.close();
      }
      process.stderr.write(
        `[s101-m02 real store] backups=1 sourceMissionRows=${sourceCount} predicate=COUNT(*) FROM missions\n`
      );
      reidentifyRbookTestStore(root);
    } else seedRbookDb(root);
    const undo = upgradeRecordProtocolForTesting(1);
    let owner: Copy;
    let next: Copy;
    let member: Copy;
    try {
      owner = await shareExisting(fixture.tmp, root);
      member = await joinedCopy(fixture.tmp, owner, 'pat', 'Pat');
      next = await joinedCopy(fixture.tmp, owner, 'next', 'Owner');
      await onCopy(fixture.tmp, owner, (client) => {
        expect(removeMember(client, 'Pat').success).toBe(true);
        expect(handOver(client, { to: next.replicaId }).success).toBe(true);
      });
      await sync(fixture.tmp, owner, next);
      await onCopy(fixture.tmp, next, (client) => expect(confirmOwner(client).success).toBe(true));
    } finally {
      undo();
    }
    await onCopy(fixture.tmp, next, (client) => {
      rememberCopyReport(client, owner.replicaId, { reads: 1 }, { called: true });
      expect(inviteMember(client, { name: 'After handover' }).success).toBe(true);
      expect(currentWriteProtocol(client)).toBe(1);
      expect(protocolReview(client).blockers.map((copy) => copy.replicaId)).toContain(
        owner.replicaId
      );
      rememberCopyReport(client, owner.replicaId, { reads: 2 }, { called: true });
      expect(inviteMember(client, { name: 'Pat' }).success).toBe(true);
      expect(currentWriteProtocol(client)).toBe(1);
      expect(removeMember(client, 'Pat').success).toBe(true);
      expect(inviteMember(client, { name: 'Switch witness' }).success).toBe(true);
      expect(currentWriteProtocol(client)).toBe(2);
      expect(inviteMember(client, { name: 'Pat' }).error?.code).toBe('RECORD_COPY_TOO_OLD');
      rememberCopyReport(client, member.replicaId, { reads: 2 }, { called: true });
      expect(inviteMember(client, { name: 'Pat' }).success).toBe(true);
      rememberCopyReport(client, owner.replicaId, { reads: 1 }, { called: true });
      expect(protocolReview(client).stranded.map((copy) => copy.replicaId)).toContain(
        owner.replicaId
      );
    });
  } finally {
    fixture.restore();
  }
}, 60000);
