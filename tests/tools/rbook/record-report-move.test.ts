// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A handover version guard must see the target's freshly validated report before deciding.
// ABOUTME: Use the real SSH handshake while stopping at the existing core move boundary.
import path from 'path';
import { getServerVersion } from '../../../src/server-version';
import { createError } from '../../../src/tools/rbook/errors';
import { handOverRoute } from '../../../src/tools/rbook/record-move-routes';
import * as moves from '../../../src/tools/rbook/record-moves';
import { reportedCopy, rememberCopyReport } from '../../../src/tools/rbook/record-peer-report';
import { replicaFixture } from '../../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy } from '../../helpers/shared-copies';
import { farEndsExited, routeTo, standinSsh } from '../../helpers/standin-ssh';

it('reads the validated target report before the core handover guard', async () => {
  const fixture = replicaFixture('rbook-report-move-');
  try {
    const owner = await ownerCopy(fixture.tmp),
      other = await joinedCopy(fixture.tmp, owner, 'other', 'Owner');
    await onCopy(fixture.tmp, owner, (client) => rememberCopyReport(client, other.replicaId, {}));
    let observed: unknown;
    const move = jest.spyOn(moves, 'handOver').mockImplementation((client) => {
      observed = reportedCopy(client, other.replicaId);
      return createError({
        code: 'TEST_STOP',
        message: 'Stopped at core move guard.',
        suggestion: 'This is a test boundary.',
      });
    });
    const { ssh } = standinSsh(path.join(fixture.tmp, 'ssh'));
    try {
      const result = await handOverRoute(
        (step) => onCopy(fixture.tmp, owner, step),
        routeTo(other.root, path.join(fixture.tmp, `config-${other.machine}`)),
        { ssh }
      );
      expect(result.error?.code).toBe('TEST_STOP');
      expect(observed).toEqual({ libraryVersion: getServerVersion(), reads: 2 });
    } finally {
      move.mockRestore();
    }
  } finally {
    await farEndsExited(fixture.tmp);
    fixture.restore();
  }
});
