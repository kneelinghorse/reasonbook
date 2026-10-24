// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A removed historical member may prove its reader upgrade without receiving the new record.
// ABOUTME: Direct and SSH report saving never grants the same exception to active or permanently cut copies.
import { PassThrough } from 'stream';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { hello } from '../../../src/tools/rbook/record-exchange';
import { removeMember } from '../../../src/tools/rbook/record-membership';
import { handOver, confirmOwner } from '../../../src/tools/rbook/record-moves';
import { rememberCopyReport, reportedCopy } from '../../../src/tools/rbook/record-peer-report';
import { recoverAuthorityCore } from '../../../src/tools/rbook/record-recovery-core';
import { setAsideReplica } from '../../../src/tools/rbook/record-set-aside';
import { serveSync, wirePeer, type NearHello } from '../../../src/tools/rbook/record-wire';
import { replicaFixture, type ReplicaFixture } from '../../helpers/replica-fixture';
import {
  copyPeer,
  joinedCopy,
  onCopy,
  ownerCopy,
  sync,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-historical-removed-report-');
});
afterEach(() => fixture.restore());
async function historical() {
  const owner = await ownerCopy(fixture.tmp);
  const pat = await joinedCopy(fixture.tmp, owner, 'pat', 'Pat');
  const next = await joinedCopy(fixture.tmp, owner, 'next', 'Owner');
  await onCopy(fixture.tmp, owner, (client) =>
    expect(handOver(client, { to: next.replicaId }).success).toBe(true)
  );
  await sync(fixture.tmp, owner, next);
  await onCopy(fixture.tmp, next, (client) => expect(confirmOwner(client).success).toBe(true));
  return { pat, authority: next };
}
async function sshReport(authority: Copy, near: NearHello) {
  const requests = new PassThrough(),
    answers = new PassThrough();
  const serving = serveSync(requests, answers, (step) => onCopy(fixture.tmp, authority, step));
  const remote = await wirePeer(
    'authority',
    answers,
    requests,
    () => requests.end(),
    5000,
    async () => near
  );
  try {
    await remote.hello();
    return await remote.changesSince({});
  } finally {
    remote.close();
    await serving;
  }
}
const cases = (['direct', 'SSH'] as const).flatMap((transport) =>
  (['active', 'removed', 'permanent', 'removed-permanent', 'removed-recovery'] as const).map(
    (mode) => ({ transport, mode })
  )
);
it.each(cases)(
  '$transport saves only a restorable removed historical report: $mode',
  async ({ transport, mode }) => {
    const { pat, authority } = await historical();
    if (mode.includes('permanent'))
      await onCopy(fixture.tmp, authority, (client) =>
        expect(setAsideReplica(client, { replicaId: pat.replicaId, dryRun: false }).success).toBe(
          true
        )
      );
    if (mode.startsWith('removed'))
      await onCopy(fixture.tmp, authority, (client) =>
        expect(removeMember(client, 'Pat').success).toBe(true)
      );
    if (mode === 'removed-recovery') {
      const result = await recoverAuthorityCore(
        (step) => onCopy(fixture.tmp, authority, step, { replicaCheck: false }),
        [],
        {
          previous: authority.replicaId,
          block: 3,
          ownerName: 'Owner',
          members: [],
          cuts: () => ({ [pat.replicaId]: 0 }),
        },
        ProjectGraphRegistry.getInstance()
      );
      expect(result.success).toBe(true);
    }
    await onCopy(fixture.tmp, authority, (client) =>
      rememberCopyReport(client, pat.replicaId, { reads: 1 }, { called: true })
    );
    const near = await onCopy(fixture.tmp, pat, hello);
    if (transport === 'direct') await copyPeer(fixture.tmp, authority).observeHello!(near);
    else {
      const received = await sshReport(authority, near);
      if (mode !== 'active') expect(received).toEqual([]);
    }
    expect({
      mode,
      reads: (await onCopy(fixture.tmp, authority, (client) => reportedCopy(client, pat.replicaId)))
        .reads,
    }).toEqual({ mode, reads: mode === 'removed' ? 2 : 1 });
  }
);
