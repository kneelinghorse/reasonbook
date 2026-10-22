// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Independently interleave a second SQLite writer immediately before handover begins its write transaction.
// ABOUTME: A newly held permanent cut or target downgrade must be checked at the authority publication boundary.
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { handOver } from '../../../src/tools/rbook/record-moves';
import { rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { setAsideReplica } from '../../../src/tools/rbook/record-set-aside';
import { mergeContext } from '../../../src/tools/rbook/record-standing';
import { dbOf, replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('critic-m17-parent-race-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

it.each(['new-cut', 'downgrade'] as const)(
  'refuses authority publication after concurrent %s',
  async (mode) => {
    const owner = await ownerCopy(fixture.tmp);
    const target = await joinedCopy(fixture.tmp, owner, 'target', 'Owner');
    const gone = await joinedCopy(fixture.tmp, owner, 'gone', 'Owner');
    await onCopy(fixture.tmp, owner, (client) => {
      rememberCopyReport(client, target.replicaId, {
        libraryVersion: mode === 'new-cut' ? '4.4.0' : '4.5.0',
        reads: mode === 'new-cut' ? 1 : 2,
      });
      if (mode === 'downgrade')
        expect(setAsideReplica(client, { replicaId: gone.replicaId, dryRun: false }).success).toBe(
          true
        );
    });
    const before = read(
      owner,
      "SELECT change_id FROM record_changes WHERE kind = 'authority' ORDER BY change_id"
    );
    let injected = 0;
    const moved = await onCopy(fixture.tmp, owner, async (client) => {
      const opened = await RbookDatabaseClient.create({
        dbPath: dbOf(owner.root),
        replicaCheck: false,
      });
      expect(opened.success).toBe(true);
      const writer = opened.data!;
      const original = client.writeTransaction.bind(client);
      const seam = jest.spyOn(client, 'writeTransaction').mockImplementation((step) => {
        if (!injected) {
          injected += 1;
          if (mode === 'new-cut')
            expect(
              setAsideReplica(writer, { replicaId: gone.replicaId, dryRun: false }).success
            ).toBe(true);
          else rememberCopyReport(writer, target.replicaId, { libraryVersion: '4.4.0', reads: 1 });
        }
        return original(step);
      });
      try {
        return handOver(client, { to: target.replicaId });
      } finally {
        seam.mockRestore();
        writer.close();
      }
    });
    const after = await onCopy(fixture.tmp, owner, (client) => mergeContext(client), {
      replicaCheck: false,
    });
    expect(injected).toBe(1);
    expect(after.setAsideCuts.size).toBeGreaterThan(0);
    expect({
      success: moved.success,
      error: moved.error?.code,
      authorityRows: read(
        owner,
        "SELECT change_id FROM record_changes WHERE kind = 'authority' ORDER BY change_id"
      ),
    }).toEqual({ success: false, error: 'RECORD_COPY_TOO_OLD', authorityRows: before });
  }
);

it('still publishes a valid handover with a held cut and a current supported report', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const target = await joinedCopy(fixture.tmp, owner, 'target', 'Owner');
  const gone = await joinedCopy(fixture.tmp, owner, 'gone', 'Owner');
  await onCopy(fixture.tmp, owner, (client) => {
    expect(setAsideReplica(client, { replicaId: gone.replicaId, dryRun: false }).success).toBe(
      true
    );
    rememberCopyReport(client, target.replicaId, { libraryVersion: '4.5.0', reads: 2 });
    expect(handOver(client, { to: target.replicaId }).data?.to).toBe(target.replicaId);
  });
});
