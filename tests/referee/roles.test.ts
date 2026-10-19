// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m11 (design §R1, D4) — setRole on a hosted project: an editor made an owner and back, seen by every copy,
// ABOUTME: and refused for the owner, a removed or unknown account, a role no copy holds, and a referee not yet joined.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { peer, REFEREE_ERROR_CODES, remove, setRole } from '../../src/referee';
import { listMembers } from '../../src/tools/rbook/record-membership';
import { replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { ask, hostProject, joinThroughReferee, syncWithReferee } from '../helpers/referee-fixture';
import { onCopy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-roles-');
});
afterEach(() => fixture.restore());

describe('setRole (s97-m11)', () => {
  it("makes an editor an owner and back, and every copy that syncs sees the member's role", async () => {
    const hosted = await hostProject(fixture.tmp);
    const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
    const made = await ask(hosted.referee, (location) =>
      setRole(location, { accountId: 'acct-darryl', role: 'owner' })
    );
    expect(made.data).toMatchObject({ accountId: 'acct-darryl', name: 'darryl', role: 'owner' });
    for (const copy of [darryl, hosted.owner]) {
      await syncWithReferee(
        fixture.tmp,
        hosted,
        copy,
        copy === darryl ? 'acct-darryl' : hosted.ownerAccount
      );
      const role = await onCopy(
        fixture.tmp,
        copy,
        (client) => listMembers(client).find((member) => member.name === 'darryl')?.role
      );
      expect({ copy: copy.name, role }).toEqual({ copy: copy.name, role: 'owner' });
    }
    const back = await ask(hosted.referee, (location) =>
      setRole(location, { accountId: 'acct-darryl', role: 'editor' })
    );
    expect(back.data?.role).toBe('editor');
    // The same role again changes nothing and is no refusal.
    expect(
      (
        await ask(hosted.referee, (location) =>
          setRole(location, { accountId: 'acct-darryl', role: 'editor' })
        )
      ).data?.role
    ).toBe('editor');
  }, 300000);

  it('refuses the owner, a role no copy holds, an unknown account and a removed member', async () => {
    const hosted = await hostProject(fixture.tmp);
    await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
    const refused = async (accountId: string, role: string) =>
      (await ask(hosted.referee, (location) => setRole(location, { accountId, role }))).error?.code;
    expect({
      owner: await refused(hosted.ownerAccount, 'editor'),
      viewer: await refused('acct-darryl', 'viewer'),
      stranger: await refused('acct-nobody', 'owner'),
    }).toEqual({
      owner: 'RECORD_WRITE_REFUSED',
      viewer: 'RECORD_WRITE_REFUSED',
      stranger: REFEREE_ERROR_CODES.NOT_A_MEMBER,
    });
    await ask(hosted.referee, (location) => remove(location, { accountId: 'acct-darryl' }));
    expect(await refused('acct-darryl', 'owner')).toBe('RECORD_WRITE_REFUSED');
  }, 300000);

  it("moves the project back only for the owner's account: an editor made an owner, presenting its own successor, is refused", async () => {
    const hosted = await hostProject(fixture.tmp);
    const darryl = await joinThroughReferee(fixture.tmp, hosted, 'darryl', 'acct-darryl');
    await ask(hosted.referee, (location) =>
      setRole(location, { accountId: 'acct-darryl', role: 'owner' })
    );
    const asked = await ask(hosted.referee, (location) =>
      peer(
        location,
        'admitSuccessor',
        { replicaId: darryl.replicaId },
        { accountId: 'acct-darryl', replicaId: darryl.replicaId }
      )
    );
    const successor = (asked.data as { replicaId: string } | undefined)?.replicaId;
    expect(successor).toBeDefined();
    const moved = await ask(hosted.referee, (location) =>
      peer(location, 'moveBack', {}, { accountId: 'acct-darryl', replicaId: successor! })
    );
    expect(moved.error?.code).toBe(REFEREE_ERROR_CODES.METHOD_REFUSED);
    expect(moved.error?.message).toMatch(/only the owner's account moves the project back/);
  }, 300000);
});
