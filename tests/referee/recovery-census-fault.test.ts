// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Host recovery distinguishes definite refusals from failures after membership commits.
// ABOUTME: Real stores and fault injection protect removed-member access and the next share after archival.
import fs from 'fs';
import path from 'path';
import * as engine from '../../src/referee';
import * as routes from '../../src/tools/rbook/record-peers';
import { localCopyReport } from '../../src/tools/rbook/record-copy-report';
import { createHostState } from '../helpers/referee-server-state';
import { replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { recoveryFixture, recoverySnapshot } from '../helpers/recovery-fixture';
import { ask, syncWithReferee } from '../helpers/referee-fixture';
import { dbOf } from '../helpers/replica-fixture';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('recovery-census-fault-');
});
afterEach(() => {
  jest.restoreAllMocks();
  fixture.restore();
});

it.each([false, true])(
  'a post-commit failure refreshes the census or keeps it invalid (refresh fails: %s)',
  async (refreshFails) => {
    const { hosted, extra, input, location } = await recoveryFixture(fixture.tmp, true);
    const root = path.join(fixture.tmp, 'volume');
    const config = {
      root,
      projects: { project: { ownerAccountId: hosted.ownerAccount } },
      accounts: {},
    };
    fs.writeFileSync(
      path.join(root, 'server-state.json'),
      JSON.stringify({
        project: {
          head: hosted.referee.expectedHead,
          shared: true,
          needsRecovery: null,
          grants: [],
          known: [],
          recordProjectId: location.projectId,
          members: input.members,
          membersInvalid: false,
        },
      })
    );
    const host = createHostState(config, {
      ...engine,
      members: refreshFails
        ? async () => {
            throw new Error('refresh failed');
          }
        : engine.members,
    });
    const routeFailure = jest.spyOn(routes, 'forgetRoute').mockImplementationOnce(() => {
      throw new Error('simulated route storage failure after membership commit');
    });
    const outcome = await host.serialized('project', () =>
      engine.remove(host.locate('project'), { accountId: 'acct-erin' })
    );
    routeFailure.mockRestore();
    expect(outcome.result.error?.code).toBe('REFEREE_FAILED');
    expect(outcome.head!.seq).toBeGreaterThan(input.lostHead.seq);
    const actual = await engine.members(host.locate('project'));
    expect(actual.result.data!.find((m) => m.name === 'Erin')!.role).toBe('removed');
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'server-state.json'), 'utf8')).project;
    expect(saved.members.find((m: { name: string }) => m.name === 'Erin').role).toBe(
      refreshFails ? 'editor' : 'removed'
    );
    expect(saved.membersInvalid).toBe(refreshFails);
    if (refreshFails) {
      expect(host.beginRecovery('project')).toBeNull();
      return;
    }
    // Simulate the store becoming unavailable before any later successful refresh.
    const attempt = host.beginRecovery('project');
    expect(attempt).not.toBeNull();
    const supplied = {
      ...input,
      lostHead: attempt!.lostHead,
      recordedHeads: attempt!.recordedHeads,
      members: attempt!.members,
      uploads: [input.uploads[0]],
    };
    const planned = await engine.recoveryPlan(location, supplied);
    expect(planned.result.error).toBeUndefined();
    const final = await engine.finalizeRecovery(location, {
      ...supplied,
      confirmedPlanHash: planned.result.data!.planHash,
      confirmedTailMembershipIds: [],
    });
    expect(final.result.error).toBeUndefined();
    const caller = { accountId: 'acct-erin', replicaId: extra[0].replicaId };
    const hello = await engine.peer(
      { ...location, expectedHead: final.head },
      'hello',
      { ...localCopyReport(), recordProtocol: 2 },
      caller
    );
    const read = await engine.peer(
      { ...location, expectedHead: hello.head },
      'changesSince',
      {},
      caller
    );
    // Must not re-admit the member whose removal committed before the host's failure answer.
    expect({
      censusInvalid: saved.membersInvalid,
      role: final.result.data!.members.find((m) => m.name === 'Erin')!.role,
      readError: read.result.error?.code,
    }).toEqual({ censusInvalid: false, role: 'removed', readError: 'REFEREE_MEMBER_REMOVED' });
  }
);

it('a successful archive-shaped outcome leaves the host able to create the next referee', async () => {
  const { hosted, input, location } = await recoveryFixture(fixture.tmp, true);
  const root = path.join(fixture.tmp, 'volume');
  const config = {
    root,
    projects: { project: { ownerAccountId: hosted.ownerAccount } },
    accounts: {},
  };
  fs.writeFileSync(
    path.join(root, 'server-state.json'),
    JSON.stringify({
      project: {
        head: hosted.referee.expectedHead,
        shared: true,
        needsRecovery: null,
        grants: [],
        known: [],
        recordProjectId: location.projectId,
        members: input.members,
        membersInvalid: false,
      },
    })
  );
  const host = createHostState(config, engine);
  // Model archiveReferee's successful public result after it closes and renames its store.
  const outcome = await host.serialized(
    'project',
    async () => {
      fs.renameSync(host.locate('project').storePath, path.join(fixture.tmp, 'archive.sqlite'));
      return { result: { success: true }, head: null };
    },
    false
  );
  expect(outcome.result.error).toBeUndefined();
  expect(outcome.head).toBeNull();
  const createNext = jest.fn(async () => ({ result: { success: true }, head: null }));
  const next = await host.serialized('project', createNext, false);
  expect({
    called: createNext.mock.calls.length,
    error: next.result.error?.code,
    invalid: host.state.get('project')!.membersInvalid,
  }).toEqual({ called: 1, error: undefined, invalid: false });
});

it('selected tail readmission cannot revive a verified removed member', async () => {
  const { hosted, input, location } = await recoveryFixture(fixture.tmp, true);
  expect(
    (await ask(hosted.referee, (at) => engine.remove(at, { accountId: 'acct-erin' }))).success
  ).toBe(true);
  const removedHead = hosted.referee.expectedHead!;
  const snapshot = recoverySnapshot(fixture.tmp, hosted.referee.storePath, 'removed');
  expect(
    (await ask(hosted.referee, (at) => engine.invite(at, { accountId: 'acct-erin', name: 'Erin' })))
      .success
  ).toBe(true);
  const members = (await ask(hosted.referee, (at) => engine.members(at))).data!.map((m) => ({
    ...m,
    accountId: m.accountId!,
  }));
  await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
  const tail = recoverySnapshot(fixture.tmp, dbOf(hosted.owner.root), 'tail');
  const supplied = {
    ...input,
    lostHead: removedHead,
    recordedHeads: [removedHead],
    members,
    uploads: [{ ...input.uploads[0], file: tail }],
    snapshots: [{ file: snapshot, takenAt: new Date().toISOString() }],
  };
  const plan = (await engine.recoveryPlan(location, supplied)).result.data!;
  expect(plan.memberReconciliation).toContainEqual(
    expect.objectContaining({ name: 'Erin', action: 'keep_removed' })
  );
  expect(plan.tailMembership.length).toBeGreaterThan(0);
  const final = await engine.finalizeRecovery(location, {
    ...supplied,
    confirmedPlanHash: plan.planHash,
    confirmedTailMembershipIds: plan.tailMembership.map((c) => c.change_id),
  });
  expect(final.result.error).toBeUndefined();
  expect(final.result.data!.members.find((m) => m.name === 'Erin')!.role).toBe('removed');
});
