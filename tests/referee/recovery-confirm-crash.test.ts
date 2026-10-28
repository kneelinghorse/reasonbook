// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A committed finalize cannot leave a census that admits a kept-removed member on retry.
// ABOUTME: Real recovery handlers exercise restart, cancellation, and new immutable owner uploads.
import fs from 'fs';
import path from 'path';
import type http from 'http';
import * as engine from '../../src/referee';
import { localCopyReport } from '../../src/tools/rbook/record-copy-report';
import {
  createHostState,
  type HostState,
  type RefereeEngine,
} from '../helpers/referee-server-state';
import { recoveryRoute } from '../helpers/referee-server-recovery';
import { dbOf, replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import { recoveryFixture, recoverySnapshot } from '../helpers/recovery-fixture';
import { ask, syncWithReferee } from '../helpers/referee-fixture';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('recovery-confirm-crash-');
});
afterEach(() => {
  fixture.restore();
});

it('a crash after keep_removed finalization cannot enable a new recovery from the old active census', async () => {
  const { hosted, extra, input, location } = await recoveryFixture(fixture.tmp, true);
  expect(
    (await ask(hosted.referee, (at) => engine.remove(at, { accountId: 'acct-erin' }))).success
  ).toBe(true);
  await syncWithReferee(fixture.tmp, hosted, hosted.owner, hosted.ownerAccount);
  const removedHead = hosted.referee.expectedHead!;
  const removedOwner = recoverySnapshot(fixture.tmp, dbOf(hosted.owner.root), 'removed-owner');
  expect(
    (await ask(hosted.referee, (at) => engine.invite(at, { accountId: 'acct-erin', name: 'Erin' })))
      .success
  ).toBe(true);
  const frozen = (await ask(hosted.referee, (at) => engine.members(at))).data!.map((m) => ({
    ...m,
    accountId: m.accountId!,
  }));
  const root = path.join(fixture.tmp, 'volume');
  const config = {
    root,
    accounts: {},
    projects: { project: { ownerAccountId: hosted.ownerAccount } },
  };
  const stateFile = path.join(root, 'server-state.json');
  fs.writeFileSync(
    stateFile,
    JSON.stringify({
      project: {
        head: hosted.referee.expectedHead,
        headHistory: [input.lostHead, removedHead, hosted.referee.expectedHead],
        shared: true,
        needsRecovery: null,
        grants: [['acct-erin', 'editor']],
        known: ['acct-erin'],
        recordProjectId: location.projectId,
        members: frozen,
        membersInvalid: false,
        snapshots: input.snapshots,
      },
    })
  );
  let host = createHostState(config, engine);
  let firstFinal: Awaited<ReturnType<typeof engine.finalizeRecovery>> | undefined;
  const crashEngine: RefereeEngine = {
    ...engine,
    finalizeRecovery: async (at, supplied) => {
      firstFinal = await engine.finalizeRecovery(at, supplied);
      expect(firstFinal.result.error).toBeUndefined();
      expect(firstFinal.result.data!.members.find((m) => m.name === 'Erin')!.role).toBe('removed');
      throw new Error('simulated process loss after publication before host received result');
    },
  };
  async function route(
    state: HostState,
    api: RefereeEngine,
    rest: string,
    method: string,
    recoveryId: string,
    parsed = {},
    file?: string,
    caller = input.uploads[0].caller
  ) {
    let responseBody: engine.RbookToolResult<{ plan: engine.RecoveryPlan; recoveryId: string }> = {
      success: false,
    };
    let status: number | undefined;
    const url = new URL(
      `http://127.0.0.1/recovery?recoveryId=${recoveryId}&replicaId=${caller.replicaId}`
    );
    await recoveryRoute(
      {
        area: 'relay',
        rest,
        method,
        url,
        projectId: 'project',
        account: caller.accountId,
        owner: caller.accountId === hosted.ownerAccount,
        incoming: file ? fs.readFileSync(file) : Buffer.alloc(0),
        parsed,
        response: {
          writeHead: (s: number) => {
            status = s;
          },
          end: (s: string) => {
            responseBody = JSON.parse(s);
          },
        } as unknown as http.ServerResponse,
      },
      state,
      api,
      config
    );
    return { status, body: responseBody };
  }
  const first = host.beginRecovery('project')!;
  expect(
    (await route(host, engine, 'recovery/copy', 'POST', first.recoveryId, {}, removedOwner)).body
      .success
  ).toBe(true);
  const planned = (await route(host, engine, 'recovery', 'GET', first.recoveryId)).body.data!.plan;
  expect(planned.ready).toBe(true);
  expect(planned.memberReconciliation).toContainEqual(
    expect.objectContaining({ name: 'Erin', action: 'keep_removed' })
  );
  await expect(
    route(host, crashEngine, 'recovery/confirm', 'POST', first.recoveryId, {
      recoveryId: first.recoveryId,
      confirmedPlanHash: planned.planHash,
      confirmedTailMembershipIds: [],
    })
  ).rejects.toThrow('simulated process loss');
  const stale = JSON.parse(fs.readFileSync(stateFile, 'utf8')).project;
  expect(stale.recovery.state).toBe('collecting');
  expect(stale.members.find((m: { name: string }) => m.name === 'Erin').role).toBe('editor');
  expect(stale.membersInvalid).toBe(true);
  // Discard all unsaved process state. Normal owner recovery routes may cancel and restart.
  host = createHostState(config, engine);
  expect((await route(host, engine, 'recovery', 'DELETE', first.recoveryId)).body.success).toBe(
    true
  );
  const nextUpload = await route(
    host,
    engine,
    'recovery/copy',
    'POST',
    first.recoveryId,
    {},
    input.uploads[0].file
  );
  expect(nextUpload.body.success).toBe(false);
  expect(nextUpload.body.error?.code).toBe('REFEREE_NOT_READY');
  expect(nextUpload.body.error?.message).toMatch(/unconfirmed/);
  expect(host.state.get('project')!.recovery!.recoveryId).toBe(first.recoveryId);
  expect(fs.existsSync(host.storeOf('project'))).toBe(true);
  const caller = { accountId: 'acct-erin', replicaId: extra[0].replicaId };
  const hello = await engine.peer(
    { ...host.locate('project'), expectedHead: firstFinal!.head },
    'hello',
    { ...localCopyReport(), recordProtocol: 2 },
    caller
  );
  const read = await engine.peer(
    { ...host.locate('project'), expectedHead: hello.head },
    'changesSince',
    {},
    caller
  );
  expect(read.result.error?.code).toBe('REFEREE_MEMBER_REMOVED');
});
