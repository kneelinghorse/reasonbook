// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s100-m01 (the sprint-97 review's finding 9): a share through the dashboard refuses, by name, the owner's other
// ABOUTME: copies of a directly shared project, which it would strand, on the client and at the referee.
import path from 'path';
import { createReferee } from '../../src/referee';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import { answerJoin, requestJoin } from '../../src/tools/rbook/record-join';
import { shareThroughDashboard } from '../../src/tools/rbook/record-dashboard-share';
import { confirmOwner, handOver } from '../../src/tools/rbook/record-moves';
import { rememberPeer } from '../../src/tools/rbook/record-peers';
import { storeOpener } from '../../src/tools/rbook/record-sync';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import { ask, refereeAt } from '../helpers/referee-fixture';
import { joinedCopy, onCopy, ownerCopy, syncCopies, type Copy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
let urlWas: string | undefined;
beforeEach(() => {
  fixture = replicaFixture('rbook-stranded-');
  urlWas = process.env.RBOOK_DASHBOARD_URL;
  process.env.RBOOK_DASHBOARD_URL = 'http://127.0.0.1:9';
});
afterEach(() => {
  if (urlWas === undefined) delete process.env.RBOOK_DASHBOARD_URL;
  else process.env.RBOOK_DASHBOARD_URL = urlWas;
  fixture.restore();
});

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

/** The share's dry run on the owner's machine, as rbook_project(action="share", via="dashboard") runs it. */
async function dryRun(owner: Copy) {
  useMachine(fixture.tmp, owner.machine);
  return shareThroughDashboard(
    storeOpener(dbOf(owner.root)),
    storeOpener(dbOf(owner.root), { replicaCheck: false }),
    dbOf(owner.root),
    { confirm: false, projectId: 'proj-dash' }
  );
}

describe("the owner's other copies (s100-m01, settled item 9)", () => {
  it('refuses a share while another copy of the owner has written, naming it, and sends nothing', async () => {
    const owner = await ownerCopy(fixture.tmp);
    // The owner's second machine, joined directly as 4.1.0 allows: the owner's own name, role owner.
    const second = await joinedCopy(fixture.tmp, owner, 'owner-second', 'Owner');
    await on(second, 'rbook_decisions', { action: 'record', content: 'From the second machine.' });
    await syncCopies(fixture.tmp, second, owner);
    for (const confirm of [false, true]) {
      useMachine(fixture.tmp, owner.machine);
      const said = await shareThroughDashboard(
        storeOpener(dbOf(owner.root)),
        storeOpener(dbOf(owner.root), { replicaCheck: false }),
        dbOf(owner.root),
        { confirm, projectId: 'proj-dash' }
      );
      expect(said.success).toBe(false);
      expect(said.error?.message).toMatch(new RegExp(`block ${second.block}`));
      expect(said.error?.message).toMatch(/unable to sync/);
      // The remedy sends no one round in a loop: syncing does not unblock the share, and it says so.
      expect(said.error?.suggestion).toMatch(/does not take your other copies along yet/);
      expect(said.error?.suggestion).toMatch(/Keep sharing it directly/);
    }
  }, 600000);

  it('names a copy this copy keeps a route to by its route, even before it writes', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const second = await joinedCopy(fixture.tmp, owner, 'owner-second', 'Owner');
    // A join over SSH keeps the route (record-sync.ts joinRoute).
    await onCopy(fixture.tmp, owner, (client) =>
      rememberPeer(client, second.replicaId, {
        name: 'Owner',
        route: { host: 'studio.local', root: '/Users/derek/work/project' },
      })
    );
    const said = await dryRun(owner);
    expect(said.success).toBe(false);
    expect(said.error?.message).toMatch(/studio\.local:\/Users\/derek\/work\/project/);
  }, 600000);

  it('names a former owner copy that went on writing as a member after a handover, on the client and at the referee', async () => {
    const first = await ownerCopy(fixture.tmp);
    const next = await joinedCopy(fixture.tmp, first, 'owner-next', 'Owner');
    await syncCopies(fixture.tmp, next, first);
    // The first copy hands the owner's copy to the next one, which confirms it.
    expect(
      (await onCopy(fixture.tmp, first, (c) => handOver(c, { to: next.replicaId }))).success
    ).toBe(true);
    await syncCopies(fixture.tmp, first, next);
    expect(
      (await onCopy(fixture.tmp, next, (c) => confirmOwner(c), { replicaCheck: false })).success
    ).toBe(true);
    await syncCopies(fixture.tmp, first, next);
    // "This copy is a member now": the first copy writes on, and syncs with the next.
    await on(first, 'rbook_decisions', {
      action: 'record',
      content: 'From the former owner copy.',
    });
    await syncCopies(fixture.tmp, first, next);
    await onCopy(fixture.tmp, next, (client) =>
      client.execute(
        "INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', 'proj-dash') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
    );
    const said = await dryRun(next);
    expect(said.success).toBe(false);
    expect(said.error?.message).toMatch(new RegExp(`block ${first.block}`));
    const upload = path.join(fixture.tmp, 'upload.sqlite');
    await buildFreshCopy(dbOf(next.root), upload);
    const created = await ask(refereeAt(fixture.tmp), (location) =>
      createReferee(location, { copyFile: upload, ownerAccountId: 'acct-owner' })
    );
    expect(created.error?.code).toBe('REFEREE_UPLOAD_REFUSED');
  }, 600000);

  it('lets the share go ahead past an admission no copy ever took up, such as a referee thrown away', async () => {
    const owner = await ownerCopy(fixture.tmp);
    // The owner's copy answered a join whose copy never joined, wrote or was routed to.
    const stray = path.join(fixture.tmp, 'stray');
    const place = { name: 'stray', root: stray, machine: 'machine-stray' };
    await joinedCopyRequestOnly(owner, place);
    const said = await dryRun(owner);
    expect(said.error).toBeUndefined();
    expect(said.success).toBe(true);
  }, 600000);

  it("is refused at the referee too: an upload whose record shows another copy of the owner's that wrote", async () => {
    const owner = await ownerCopy(fixture.tmp);
    const second = await joinedCopy(fixture.tmp, owner, 'owner-second', 'Owner');
    await on(second, 'rbook_decisions', { action: 'record', content: 'From the second machine.' });
    await syncCopies(fixture.tmp, second, owner);
    // An older client, which skips the check, uploads anyway.
    const upload = path.join(fixture.tmp, 'upload.sqlite');
    await buildFreshCopy(dbOf(owner.root), upload);
    const created = await ask(refereeAt(fixture.tmp), (location) =>
      createReferee(location, { copyFile: upload, ownerAccountId: 'acct-owner' })
    );
    expect(created.success).toBe(false);
    expect(created.error?.code).toBe('REFEREE_UPLOAD_REFUSED');
    expect(created.error?.message).toMatch(new RegExp(`block ${second.block}`));
  }, 600000);
});

/** The owner answers a join from `place`, which never applies it: an admission no copy took up. */
async function joinedCopyRequestOnly(
  owner: Copy,
  place: { readonly name: string; readonly root: string; readonly machine: string }
): Promise<void> {
  const fs = await import('fs');
  const Database = (await import('better-sqlite3')).default;
  fs.mkdirSync(path.dirname(dbOf(place.root)), { recursive: true });
  const source = new Database(dbOf(owner.root));
  try {
    source.exec(`VACUUM INTO '${dbOf(place.root).replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  useMachine(fixture.tmp, place.machine);
  const request = await onCopy(fixture.tmp, place, (client) => requestJoin(client), {
    replicaCheck: false,
  });
  if (!request.success) throw new Error(request.error?.message);
  const answer = await onCopy(fixture.tmp, owner, (client) =>
    answerJoin(client, request.data!, 'Owner')
  );
  if (!answer.success) throw new Error(answer.error?.message);
}
