// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Real wire exchange evidence must stop a dashboard share before an unwritten owner copy is stranded.
// ABOUTME: Client and referee refusals offer a preview of setting aside a gone copy rather than retrying unchanged uploads.
import fs from 'fs';
import path from 'path';
import { PassThrough } from 'stream';
import { createReferee } from '../../src/referee';
import { shareThroughDashboard } from '../../src/tools/rbook/record-dashboard-share';
import { exchange } from '../../src/tools/rbook/record-exchange';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { ownersOtherCopies } from '../../src/tools/rbook/record-owner-copies';
import { recordExchanged, rememberPeer } from '../../src/tools/rbook/record-peers';
import { storeOpener } from '../../src/tools/rbook/record-sync';
import { serveSync, wirePeer } from '../../src/tools/rbook/record-wire';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import { ask, refereeAt } from '../helpers/referee-fixture';
import {
  copyPeer,
  joinedCopy,
  onCopy,
  ownerCopy,
  syncCopies,
  type Copy,
} from '../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-owner-wire-');
});
afterEach(() => fixture.restore());

async function wireSync(near: Copy, far: Copy) {
  const requests = new PassThrough(),
    answers = new PassThrough();
  const served = serveSync(
    requests,
    answers,
    (step) => onCopy(fixture.tmp, far, step),
    {
      exchanged: (params) => {
        const { replicaId, marks, digest } = params as {
          replicaId: string;
          marks: Record<string, number>;
          digest: unknown;
        };
        return onCopy(
          fixture.tmp,
          far,
          (client) => recordExchanged(client, replicaId, { marks, digest }),
          { replicaCheck: false }
        );
      },
    },
    (step) => onCopy(fixture.tmp, far, step, { replicaCheck: false })
  );
  const peer = await wirePeer('owner machine', answers, requests, () => requests.end());
  try {
    const result = await exchange(copyPeer(fixture.tmp, near), peer);
    expect(result.success).toBe(true);
    await peer.call('exchanged', {
      replicaId: result.data!.local.replicaId,
      marks: result.data!.local.marks,
      digest: result.data!.digest,
    });
  } finally {
    peer.close();
    await served;
  }
}

it('refuses the exact route-less first-write gap after a successful wire exchange', async () => {
  const owner = await ownerCopy(fixture.tmp),
    other = await joinedCopy(fixture.tmp, owner, 'owner-second', 'Owner');
  await wireSync(other, owner);
  await onCopy(fixture.tmp, owner, (client) => {
    expect(
      client.getOne<{ n: number }>(
        'SELECT count(*) AS n FROM record_changes WHERE replica_id = ?',
        [other.replicaId]
      ).data?.n
    ).toBe(0);
    const observed = client.getOne<{ route: null; last_ok_at: string }>(
      'SELECT route, last_ok_at FROM record_peers WHERE replica_id = ?',
      [other.replicaId]
    ).data;
    expect(observed?.route).toBeNull();
    expect(observed?.last_ok_at).toBeTruthy();
    expect(ownersOtherCopies(client).map((copy) => copy.replicaId)).toEqual([other.replicaId]);
  });
  useMachine(fixture.tmp, owner.machine);
  const refused = await shareThroughDashboard(
    storeOpener(dbOf(owner.root)),
    storeOpener(dbOf(owner.root), { replicaCheck: false }),
    dbOf(owner.root),
    { confirm: false, projectId: 'proj-observed' }
  );
  expect(refused.success).toBe(false);
  expect(refused.error?.message).toContain(other.replicaId);
  expect(refused.error?.suggestion).toMatch(/reasonbook set-aside --replica/);
  expect(refused.error?.suggestion).toMatch(/preview/i);
});

it('referee upload refusal explains how a gone copy can be set aside and leaves no published store', async () => {
  const owner = await ownerCopy(fixture.tmp),
    other = await joinedCopy(fixture.tmp, owner, 'owner-second', 'Owner');
  useMachine(fixture.tmp, other.machine);
  expect(
    (
      await call('rbook_decisions', {
        action: 'record',
        content: 'A real used owner copy.',
        projectRoot: other.root,
      })
    ).success
  ).toBe(true);
  await syncCopies(fixture.tmp, other, owner);
  const upload = path.join(fixture.tmp, 'upload.sqlite'),
    referee = refereeAt(fixture.tmp);
  await buildFreshCopy(dbOf(owner.root), upload);
  const refused = await ask(referee, (location) =>
    createReferee(location, { copyFile: upload, ownerAccountId: 'acct-owner' })
  );
  expect(refused.error?.code).toBe('REFEREE_UPLOAD_REFUSED');
  expect(refused.error?.message).toContain(other.replicaId);
  expect(refused.error?.suggestion).toMatch(/Keep sharing.*directly/i);
  expect(refused.error?.suggestion).toMatch(/reasonbook set-aside --replica/);
  expect(refused.error?.suggestion).toMatch(/preview/i);
  expect(refused.error?.suggestion).not.toMatch(
    /Upload the copy the owner's client builds from its own live store, then hand over again/
  );
  expect(fs.existsSync(referee.storePath)).toBe(false);
});

it('client refusal previews a gone copy without implying that an ordinary sync permits sharing', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const other = await joinedCopy(fixture.tmp, owner, 'owner-second', 'Owner');
  await onCopy(fixture.tmp, owner, (client) =>
    rememberPeer(client, other.replicaId, {
      route: { host: 'second.local', root: '/work/project' },
    })
  );
  useMachine(fixture.tmp, owner.machine);
  const refused = await shareThroughDashboard(
    storeOpener(dbOf(owner.root)),
    storeOpener(dbOf(owner.root), { replicaCheck: false }),
    dbOf(owner.root),
    { confirm: false, projectId: 'proj-observed' }
  );
  expect(refused.success).toBe(false);
  expect(refused.error?.message).toContain('second.local:/work/project');
  expect(refused.error?.suggestion).toMatch(/Keep sharing.*directly/i);
  expect(refused.error?.suggestion).toMatch(/reasonbook set-aside --replica/);
  expect(refused.error?.suggestion).toMatch(/preview/i);
  expect(refused.error?.suggestion).toMatch(/gone/i);
  expect(refused.error?.suggestion).toContain('--yes');
});
