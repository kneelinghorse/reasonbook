// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m11 (design §The client design) — sharing, joining and moving back through the reference server in its own
// ABOUTME: process: a dry run first, a join by address, owner-role identity edits, the move back and each refusal.
import Database from 'better-sqlite3';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CredentialStore } from '../../src/intelligence/credential-store';
import { RbookDetector } from '../../src/intelligence/rbook-detector';
import { buildMissionProtocolContext, executeMissionProtocolTool } from '../../src/index';
import { DashboardClient } from '../../src/tools/rbook/dashboard-client';
import { createSuccess } from '../../src/tools/rbook/errors';
import { writeUserAuthor } from '../../src/intelligence/user-author';
import { replicaMarks } from '../../src/tools/rbook/record-apply';
import { dashboardPeer } from '../../src/tools/rbook/record-dashboard-peer';
import { listMembers } from '../../src/tools/rbook/record-membership';
import { inviteMember } from '../../src/tools/rbook/record-membership';
import { isRecordedStore } from '../../src/tools/rbook/record-recording';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import { takeSuccessor } from '../../src/tools/rbook/record-successor';
import { COPY_KEYS, writeCopyKey } from '../../src/tools/rbook/replica-copy-keys';
import { readReplicaIdentity } from '../../src/tools/rbook/replica-identity';
import { formatSharedProjectForLLM } from '../../src/tools/rbook/rbook-project-shared';
import { sharedRecordReview } from '../../src/tools/rbook/record-review';
import { exchangeText } from '../../src/cli/sync-moves';
import type { ExchangeReport } from '../../src/tools/rbook/record-exchange';
import { __resetSharedSyncScheduler } from '../../src/tools/rbook/record-sync-scheduler';
import {
  recordNetworkFailures,
  request,
  spawnRefereeServer,
  type RunningServer,
} from '../helpers/referee-http';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, read, type Copy } from '../helpers/shared-copies';
import { farEndsExited, routeTo as sshRouteTo, standinSsh } from '../helpers/standin-ssh';
import { PassThrough } from 'stream';
import { createInterface } from 'readline';
import { hello } from '../../src/tools/rbook/record-exchange';
import { storeOpener, syncAndRoute, syncPeers } from '../../src/tools/rbook/record-sync';
import { handOverRoute } from '../../src/tools/rbook/record-move-routes';
import * as freshCopy from '../../src/tools/rbook/record-fresh-copy';
import { ownersOtherCopies } from '../../src/tools/rbook/record-owner-copies';
import { refereeingDashboard, serveSync } from '../../src/tools/rbook/record-wire';

const PROJECT = 'proj-share';
const ADDRESS = 'rbook://derek/shared';
const TOKENS = { owner: 'tok-owner', darryl: 'tok-darryl', erin: 'tok-erin' } as const;
const ACCOUNTS = { owner: 'acct-owner', darryl: 'acct-darryl', erin: 'acct-erin' } as const;
const LIMIT = 256 * 1024;

let fixture: ReplicaFixture;
let server: RunningServer;
let saved: Record<string, string | undefined>;

function startServer(options: { port?: number; reportedRecordProtocol?: number } = {}) {
  return spawnRefereeServer(path.join(fixture.tmp, `server-${Date.now()}`), {
    root: path.join(fixture.tmp, 'volume'),
    accounts: {
      [TOKENS.owner]: ACCOUNTS.owner,
      [TOKENS.darryl]: ACCOUNTS.darryl,
      [TOKENS.erin]: ACCOUNTS.erin,
    },
    projects: { [PROJECT]: { ownerAccountId: ACCOUNTS.owner } },
    addresses: { 'derek/shared': PROJECT },
    requestLimit: LIMIT,
    ...options,
  });
}

beforeEach(async () => {
  saved = Object.fromEntries(
    ['RBOOK_DASHBOARD_URL', 'RBOOK_SHARED_SYNC', 'RBOOK_DASHBOARD_SHARING'].map((key) => [
      key,
      process.env[key],
    ])
  );
  delete process.env.RBOOK_SHARED_SYNC;
  // The test homes switch dashboard sharing on, as the live test's do (design §What plan time settled).
  process.env.RBOOK_DASHBOARD_SHARING = 'on';
  fixture = replicaFixture('rbook-dash-share-');
  server = await startServer();
  process.env.RBOOK_DASHBOARD_URL = server.url;
});
afterEach(async () => {
  await server.stop();
  __resetSharedSyncScheduler();
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  await farEndsExited(fixture.tmp);
  fixture.restore();
});

async function signIn(machine: string, token: string): Promise<void> {
  useMachine(fixture.tmp, machine);
  const at = new Date().toISOString();
  await (
    await CredentialStore.create()
  ).upsertUserScopedKey(`key-${machine}`, {
    key: token,
    label: machine,
    issuedAt: at,
    lastUsedAt: at,
  });
}

async function on(
  copy: Pick<Copy, 'root' | 'machine'>,
  tool: string,
  args: Record<string, unknown>
) {
  useMachine(fixture.tmp, copy.machine);
  return call(tool, { ...args, projectRoot: copy.root });
}

const decisions = (copy: Pick<Copy, 'root'>, text: string): number =>
  read<{ n: number }>(
    copy,
    'SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = ?',
    [text]
  )[0].n;

const me = async (token: string = TOKENS.owner) =>
  (
    await request<{ projects: Array<{ id: string; dashboardShared: boolean }> }>(
      server,
      '/api/projects/me',
      { token }
    )
  ).body.data!.projects.find((entry) => entry.id === PROJECT);

/** A solo project on its owner's machine, registered with the dashboard, its owner signed in there. */
async function soloOwner(): Promise<Copy> {
  const root = project(fixture.tmp, 'owner');
  const db = new Database(dbOf(root));
  db.prepare(
    "INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(PROJECT);
  db.close();
  const owner = { name: 'owner', root, machine: 'machine-owner', replicaId: '', block: 0 };
  useMachine(fixture.tmp, owner.machine);
  writeUserAuthor('Owner');
  await signIn(owner.machine, TOKENS.owner);
  return owner;
}

/** s98-m08: what the network said when a dashboard call failed (see recordNetworkFailures). */
let network: ReturnType<typeof recordNetworkFailures>;
beforeAll(() => {
  network = recordNetworkFailures();
});
beforeEach(() => {
  network.failures.length = 0;
});
afterAll(() => network.restore());

/** Share the solo project through the dashboard, confirmed; answer its result. */
async function shared(owner: Copy) {
  const answer = await on(owner, 'rbook_project', {
    action: 'share',
    via: 'dashboard',
    confirm: true,
  });
  if (!answer.success)
    throw new Error(
      `${JSON.stringify(answer.error)}; the network said: ${network.failures.join(' | ') || 'nothing'}`
    );
  return answer.data as unknown as { refereeReplica: string; handover: { epoch: number } };
}

/** Share with `name` on the dashboard, and join from a downloaded first copy by the project's address. */
async function joined(name: 'darryl' | 'erin'): Promise<Copy> {
  const invited = await request(server, `/api/test/projects/${PROJECT}/shares`, {
    token: TOKENS.owner,
    json: { accountId: ACCOUNTS[name], name, role: 'editor' },
  });
  expect(invited.status).toBe(200);
  const copy = {
    name,
    root: path.join(fixture.tmp, name),
    machine: `machine-${name}`,
    replicaId: '',
    block: -1,
  };
  await signIn(copy.machine, TOKENS[name]);
  writeUserAuthor(name);
  const answer = await on(copy, 'rbook_project', {
    action: 'join',
    via: 'dashboard',
    project: ADDRESS,
  });
  if (!answer.success) throw new Error(`${name}: ${JSON.stringify(answer.error)}`);
  return copy;
}

const syncNow = (copy: Copy) => on(copy, 'rbook_project', { action: 'sync' });

const keptShare = (copy: Copy) =>
  read<{ n: number }>(copy, 'SELECT count(*) AS n FROM metadata WHERE key = ?', [
    COPY_KEYS.dashboardShare,
  ])[0].n;

/** A move back stopped after the owner copy took its successor: the referee admitted it, the copy took it. */
async function successorTaken(owner: Copy) {
  useMachine(fixture.tmp, owner.machine);
  const route = await onCopy(fixture.tmp, owner, (client) => refereeingDashboard(client)!, {
    replicaCheck: false,
  });
  const peer = await dashboardPeer(route, {
    projectRoot: owner.root,
    replicaIdNow: () =>
      onCopy(
        fixture.tmp,
        owner,
        (client) => readReplicaIdentity(client, { fresh: true })!.replicaId,
        { replicaCheck: false }
      ),
  });
  const own = await onCopy(fixture.tmp, owner, (client) => mergeContext(client).ownReplica, {
    replicaCheck: false,
  });
  const admitted = await peer.admitSuccessor({ replicaId: own });
  expect(admitted.error).toBeUndefined();
  const held = await onCopy(fixture.tmp, owner, (client) => replicaMarks(client)[own] ?? 0, {
    replicaCheck: false,
  });
  const taken = await onCopy(
    fixture.tmp,
    owner,
    (client) =>
      takeSuccessor(client, {
        successor: admitted.data!,
        reason: 'move-back',
        authorityReceived: held,
        cut: held,
      }),
    { replicaCheck: false }
  );
  expect(taken.error).toBeUndefined();
  return { peer, successor: admitted.data!.replicaId };
}

/** Where the owner copy stands: whether it holds the record, at what move, and a move pending to it. */
const standing = (owner: Copy) =>
  onCopy(
    fixture.tmp,
    owner,
    (client) => {
      const ctx = mergeContext(client);
      return {
        holds: ctx.authority === ctx.ownReplica && !ctx.pending,
        epoch: ctx.epoch,
        pendingToIt: ctx.pending?.value.authority === ctx.ownReplica,
      };
    },
    { replicaCheck: false }
  );

describe('sharing through the dashboard (s97-m11)', () => {
  it('shows the dry run first, sends only the shared record, and ends with the referee as the authority', async () => {
    const owner = await soloOwner();
    expect(
      (await on(owner, 'rbook_decisions', { action: 'record', content: 'Before sharing.' })).success
    ).toBe(true);
    const db = new Database(dbOf(owner.root));
    db.prepare(
      "INSERT INTO session_events (ts, agent, action, summary, raw_event) VALUES (datetime('now'), 'agent', 'note', 'Stays here.', '{}')"
    ).run();
    db.close();
    const dry = await on(owner, 'rbook_project', { action: 'share', via: 'dashboard' });
    const plan = (
      dry.data as unknown as { plan: { up: Record<string, number>; stays: Record<string, number> } }
    ).plan;
    expect(plan.up.strategic_decisions).toBeGreaterThanOrEqual(1);
    expect(plan.stays.session_events).toBeGreaterThanOrEqual(1);
    // Nothing was sent: the project is still not shared through the dashboard.
    expect((await me())?.dashboardShared).toBe(false);
    const done = await shared(owner);
    const state = await onCopy(
      fixture.tmp,
      owner,
      (client) => {
        const ctx = mergeContext(client);
        return {
          authority: ctx.authority === done.refereeReplica,
          epoch: ctx.epoch,
          role: ctx.members.get(ctx.ownReplica)?.role,
          routed: refereeingDashboard(client) !== null,
        };
      },
      { replicaCheck: false }
    );
    expect(state).toEqual({ authority: true, epoch: 2, role: 'owner', routed: true });
    expect((await me())?.dashboardShared).toBe(true);
    expect(keptShare(owner)).toBe(0);
    // A share that stopped after its handover, its answer still kept, is finished by sharing again.
    await onCopy(
      fixture.tmp,
      owner,
      (client) =>
        writeCopyKey(
          client,
          COPY_KEYS.dashboardShare,
          JSON.stringify({ projectId: PROJECT, refereeReplica: done.refereeReplica, answer: {} })
        ),
      { replicaCheck: false }
    );
    const finished = await shared(owner);
    expect(finished).toMatchObject({ refereeReplica: done.refereeReplica, handover: { epoch: 2 } });
    expect(keptShare(owner)).toBe(0);
    // The referee holds the decision, and none of what the shared record leaves out.
    const exported = await request<{ file: string }>(
      server,
      `/api/test/projects/${PROJECT}/export`,
      {
        token: TOKENS.owner,
        json: {},
      }
    );
    const copy = new Database(exported.body.data!.file, { readonly: true });
    try {
      expect(
        copy
          .prepare(
            "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'Before sharing.'"
          )
          .get()
      ).toEqual({ n: 1 });
      expect(copy.prepare('SELECT count(*) AS n FROM session_events').get()).toEqual({ n: 0 });
    } finally {
      copy.close();
    }
  }, 600000);

  it('refuses a project shared directly with members, naming them, and one the dashboard runs too old an engine for', async () => {
    const direct = await ownerCopy(fixture.tmp, 'direct');
    await joinedCopy(fixture.tmp, direct, 'studio', 'Darryl');
    const db = new Database(dbOf(direct.root));
    db.prepare(
      "INSERT INTO metadata (key, value) VALUES ('dashboard_project_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(PROJECT);
    db.close();
    await signIn(direct.machine, TOKENS.owner);
    const refused = await on(direct, 'rbook_project', {
      action: 'share',
      via: 'dashboard',
      confirm: true,
    });
    expect(refused.error?.message).toMatch(/shared directly with Darryl/);
    const port = Number(new URL(server.url).port);
    await server.stop();
    server = await startServer({ port, reportedRecordProtocol: 0 });
    const owner = await soloOwner();
    const old = await on(owner, 'rbook_project', {
      action: 'share',
      via: 'dashboard',
      confirm: true,
    });
    expect(old.error?.message).toMatch(/runs an older Reasonbook engine/);
    expect((await me())?.dashboardShared).toBe(false);
  }, 600000);

  it('shares where the switch is unset, since the live test passed (4.2.0), and refuses where it is off before sending anything', async () => {
    // The live test through reasonbook.ai passed its decision rule, so the release default is on.
    delete process.env.RBOOK_DASHBOARD_SHARING;
    const owner = await soloOwner();
    const dry = await on(owner, 'rbook_project', { action: 'share', via: 'dashboard' });
    expect(dry.error).toBeUndefined();
    expect((await me())?.dashboardShared).toBe(false);
    // Switched off on this machine, it says so, and the share, its dry run and a join are refused.
    process.env.RBOOK_DASHBOARD_SHARING = 'off';
    const refused = await on(owner, 'rbook_project', {
      action: 'share',
      via: 'dashboard',
      confirm: true,
    });
    expect(refused.error?.message).toMatch(/off on this machine/);
    expect((await me())?.dashboardShared).toBe(false);
    expect(
      await onCopy(fixture.tmp, owner, (client) => isRecordedStore(client), { replicaCheck: false })
    ).toBe(false);
    expect(
      (await on(owner, 'rbook_project', { action: 'share', via: 'dashboard' })).error?.message
    ).toMatch(/off on this machine/);
    const darryl = {
      name: 'darryl',
      root: path.join(fixture.tmp, 'darryl'),
      machine: 'machine-darryl',
      replicaId: '',
      block: -1,
    };
    await signIn(darryl.machine, TOKENS.darryl);
    const join = await on(darryl, 'rbook_project', {
      action: 'join',
      via: 'dashboard',
      project: ADDRESS,
    });
    expect(join.error?.message).toMatch(/off on this machine/);
    expect(fs.existsSync(dbOf(darryl.root))).toBe(false);
  }, 600000);

  it('a collaborator joins by address from a downloaded first copy, and the owner copy edits the project identity for every copy', async () => {
    const owner = await soloOwner();
    await shared(owner);
    const darryl = await joined('darryl');
    expect(
      (await on(darryl, 'rbook_decisions', { action: 'record', content: 'From Darryl.' })).success
    ).toBe(true);
    expect((await syncNow(darryl)).success).toBe(true);
    expect((await syncNow(owner)).success).toBe(true);
    expect(decisions(owner, 'From Darryl.')).toBe(1);
    // The owner copy, an owner-role member now, changes the identity; the referee takes it by role.
    const updated = await on(owner, 'rbook_project', { action: 'update', projectType: 'managed' });
    expect(updated.error).toBeUndefined();
    expect((await syncNow(owner)).success).toBe(true);
    expect((await syncNow(darryl)).success).toBe(true);
    expect(read(darryl, "SELECT value FROM metadata WHERE key = 'project_type'")).toEqual([
      { value: 'managed' },
    ]);
    // An editor's copy does not.
    expect(
      (await on(darryl, 'rbook_project', { action: 'update', projectType: 'build' })).error?.message
    ).toMatch(/Only the owner's copy of a shared record changes/);
    // A role set on the dashboard reaches every copy.
    const roled = await request(
      server,
      `/api/test/projects/${PROJECT}/shares/${ACCOUNTS.darryl}/role`,
      {
        token: TOKENS.owner,
        json: { role: 'owner' },
      }
    );
    expect(roled.status).toBe(200);
    expect((await syncNow(darryl)).success).toBe(true);
    expect(
      (
        await onCopy(fixture.tmp, darryl, (client) => listMembers(client), { replicaCheck: false })
      ).find((member) => member.name === 'darryl')?.role
    ).toBe('owner');
    // The role set is the one each of darryl's copies writes with: as an owner, it changes the identity.
    const identity = (copy: Copy) =>
      read(copy, "SELECT value FROM metadata WHERE key = 'project_type'")[0];
    expect(
      (await on(darryl, 'rbook_project', { action: 'update', projectType: 'general' })).error
    ).toBeUndefined();
    expect((await syncNow(darryl)).success).toBe(true);
    expect((await syncNow(owner)).success).toBe(true);
    expect(identity(owner)).toEqual({ value: 'general' });
    // Made an editor again before its copy hears of it, the referee refuses its next identity edit...
    const demoted = await request(
      server,
      `/api/test/projects/${PROJECT}/shares/${ACCOUNTS.darryl}/role`,
      { token: TOKENS.owner, json: { role: 'editor' } }
    );
    expect(demoted.status).toBe(200);
    expect(
      (await on(darryl, 'rbook_project', { action: 'update', projectType: 'build' })).error
    ).toBeUndefined();
    await syncNow(darryl);
    expect((await syncNow(owner)).success).toBe(true);
    expect(identity(owner)).toEqual({ value: 'general' });
    // ...and once its copy has heard, it refuses the edit itself.
    expect((await syncNow(darryl)).success).toBe(true);
    expect(
      (await on(darryl, 'rbook_project', { action: 'update', projectType: 'managed' })).error
        ?.message
    ).toMatch(/Only the owner's copy of a shared record changes/);
  }, 600000);

  it('a share and a join name no conflict check on the file each built its copy in (s97-m14 live test)', async () => {
    const owner = await soloOwner();
    const share = await on(owner, 'rbook_project', {
      action: 'share',
      via: 'dashboard',
      confirm: true,
    });
    expect(share.error).toBeUndefined();
    const invited = await request(server, `/api/test/projects/${PROJECT}/shares`, {
      token: TOKENS.owner,
      json: { accountId: ACCOUNTS.darryl, name: 'darryl', role: 'editor' },
    });
    expect(invited.status).toBe(200);
    // The empty folder the member's agent works in, as the dashboard's join sentence names it.
    const darryl = { root: path.join(fixture.tmp, 'darryl'), machine: 'machine-darryl' };
    fs.mkdirSync(darryl.root);
    await signIn(darryl.machine, TOKENS.darryl);
    writeUserAuthor('darryl');
    // A running server has looked the folder up before the join, at its start or on a call before
    // it, and remembers for a minute that it held no store: the live test's server started there.
    RbookDetector.resetInstance();
    expect((await RbookDetector.getInstance().detect(darryl.root)).hasDatabase).toBe(false);
    const join = (
      await executeMissionProtocolTool(
        'rbook_project',
        { action: 'join', via: 'dashboard', project: ADDRESS, projectRoot: darryl.root },
        await buildMissionProtocolContext()
      )
    ).structuredContent as { error?: unknown; warnings?: string[] };
    expect(join.error).toBeUndefined();
    // The live test's fresh agent read the first warning, about a file already renamed into place,
    // as a failed join, and told its person the folder held no copy. The share's upload file drew
    // both: a conflict check on it, and upkeep on the folder above it.
    for (const answer of [share, join])
      for (const warning of [
        /could not be checked for conflicts/,
        /Store upkeep skipped: Reasonbook directory not found/,
      ])
        expect((answer as { warnings?: string[] }).warnings ?? []).not.toContainEqual(
          expect.stringMatching(warning)
        );
  }, 600000);

  it("a member's review names the project and its shared record, and asks it to mint no project key (s97-m14 live test)", async () => {
    const owner = await soloOwner();
    await shared(owner);
    const darryl = await joined('darryl');
    // The structured answer is what Claude Code's model reads: the live test's agent saw a generic
    // name, no sign the copy was shared, and a request to register and mint a project key, which a
    // member's copy never does, and it told its person the join was not finished.
    const review = (await on(darryl, 'rbook_review', {})) as unknown as {
      data: {
        project: { name: string };
        sharedRecord?: string;
        next_actions: Array<{ action: string; command: string }>;
      };
    };
    const name = read<{ value: string }>(
      owner,
      "SELECT value FROM metadata WHERE key = 'project_name'"
    )[0].value;
    expect(review.data.project.name).toBe(name);
    expect(review.data.sharedRecord).toMatch(/^Shared record:[\s\S]*the dashboard/);
    expect(review.data.next_actions.map((a) => a.command).join('\n')).not.toMatch(/reissue/);
    // Nor among every action the onboard suggests, not only the review's top three.
    const onboard = (await on(darryl, 'rbook_agent_onboard', {})) as unknown as {
      data: { suggestedActions: Array<{ command: string }> };
    };
    expect(onboard.data.suggestedActions.map((a) => a.command).join('\n')).not.toMatch(/reissue/);
  }, 600000);

  it('refuses to share a project the dashboard does not know yet, naming a step that puts it there', async () => {
    // A project reaches reasonbook.ai at its first upload from an explicit close; automatic uploads
    // never register one, and register alone records it on this machine only, so the old advice
    // ("register it, then share again") was refused again.
    const root = project(fixture.tmp, 'fresh');
    const fresh = { root, machine: 'machine-fresh' };
    await signIn(fresh.machine, TOKENS.owner);
    writeUserAuthor('Owner');
    // A machine whose close does upload: the suite's default turns uploads off.
    const uploads = process.env.RBOOK_CHECKPOINT_SYNC;
    process.env.RBOOK_CHECKPOINT_SYNC = 'on';
    try {
      const refused = await on(fresh, 'rbook_project', { action: 'share', via: 'dashboard' });
      expect(refused.error?.message).toBe(
        'This project is not on the dashboard yet, so it has no address there.'
      );
      // Each call carries the fields its handler requires: a start's title, a close's summary.
      expect(refused.error?.suggestion).toContain(
        'rbook_session(action="start", type="custom", title="Share through the dashboard")'
      );
      expect(refused.error?.suggestion).toContain(
        'rbook_session(action="complete", summary="Uploaded to share it")'
      );
      expect(refused.error?.suggestion).not.toMatch(/^Register it first/);
    } finally {
      process.env.RBOOK_CHECKPOINT_SYNC = uploads;
    }
  }, 600000);

  it('names the missing sign-in, or uploads switched off, where a session close would upload nothing (s100-m02)', async () => {
    // The s97 review's finding 7: signed out, the close the refusal prescribed uploaded nothing, and
    // the next share was refused the same way, with the sign-in never named as the cause.
    const root = project(fixture.tmp, 'unsigned');
    const unsigned = { root, machine: 'machine-unsigned' };
    useMachine(fixture.tmp, unsigned.machine);
    writeUserAuthor('Owner');
    const uploads = process.env.RBOOK_CHECKPOINT_SYNC;
    process.env.RBOOK_CHECKPOINT_SYNC = 'on';
    try {
      const signedOut = await on(unsigned, 'rbook_project', { action: 'share', via: 'dashboard' });
      expect(signedOut.error?.message).toMatch(/this machine is not signed in to it/);
      expect(signedOut.error?.suggestion).toMatch(
        /^Sign in on this machine first: rbook_auth\(action="login_init"\), then rbook_auth\(action="login_complete"\)\. /
      );
      // Signed in but with uploads off, a close still uploads nothing, and only the person turns
      // uploads on.
      await signIn(unsigned.machine, TOKENS.owner);
      process.env.RBOOK_CHECKPOINT_SYNC = 'off';
      const off = await on(unsigned, 'rbook_project', { action: 'share', via: 'dashboard' });
      expect(off.error?.message).toMatch(
        /uploads are off on this machine \(RBOOK_CHECKPOINT_SYNC=off\)/
      );
      expect(off.error?.suggestion).toMatch(/the person's setting to decide on, not an agent's/);
      expect((await me())?.dashboardShared).toBe(false);
    } finally {
      process.env.RBOOK_CHECKPOINT_SYNC = uploads;
    }
  }, 600000);

  it('refuses a join without a share, and a move back from a copy not the owner, or one not caught up', async () => {
    const owner = await soloOwner();
    await shared(owner);
    const erin = {
      name: 'erin',
      root: path.join(fixture.tmp, 'erin'),
      machine: 'machine-erin',
      replicaId: '',
      block: -1,
    };
    await signIn(erin.machine, TOKENS.erin);
    const stranger = await on(erin, 'rbook_project', {
      action: 'join',
      via: 'dashboard',
      project: ADDRESS,
    });
    expect(stranger.success).toBe(false);
    expect(fs.existsSync(dbOf(erin.root))).toBe(false);
    const darryl = await joined('darryl');
    expect(
      (await on(darryl, 'rbook_project', { action: 'move', to: 'owner' })).error?.message
    ).toMatch(/Only the owner's copy moves the project back/);
    expect(
      (
        await on(owner, 'rbook_decisions', {
          action: 'record',
          content: `Too large: ${'y'.repeat(LIMIT)}`,
        })
      ).success
    ).toBe(true);
    expect(
      (await on(owner, 'rbook_project', { action: 'move', to: 'owner' })).error?.message
    ).toMatch(/have not reached the dashboard/);
  }, 600000);

  it('moves back in one session: the successor holds the record, the referee is archived after it syncs, and a later share starts fresh', async () => {
    const owner = await soloOwner();
    const first = await shared(owner);
    const darryl = await joined('darryl');
    const erin = await joined('erin');
    // The switch gates new shares and joins only: a shared project syncs and moves back with it off.
    delete process.env.RBOOK_DASHBOARD_SHARING;
    expect(
      (await on(darryl, 'rbook_decisions', { action: 'record', content: 'Before the move back.' }))
        .success
    ).toBe(true);
    expect((await syncNow(darryl)).success).toBe(true);
    const moved = await on(owner, 'rbook_project', { action: 'move', to: 'owner' });
    if (!moved.success) throw new Error(JSON.stringify(moved.error));
    const back = moved.data as unknown as {
      successor: { reason: string; count: number };
      epoch: number;
    };
    expect(back.successor).toMatchObject({ reason: 'move-back', count: 0 });
    const state = await onCopy(
      fixture.tmp,
      owner,
      (client) => {
        const ctx = mergeContext(client);
        return {
          holds: ctx.authority === ctx.ownReplica,
          epoch: ctx.epoch,
          routed: refereeingDashboard(client),
        };
      },
      { replicaCheck: false }
    );
    expect(state).toEqual({ holds: true, epoch: 3, routed: null });
    expect(decisions(owner, 'Before the move back.')).toBe(1);
    expect((await me())?.dashboardShared).toBe(false);
    expect(fs.readdirSync(path.join(fixture.tmp, 'volume', 'archive', PROJECT))).toHaveLength(1);
    // A member's next sync hears the project left the dashboard, and its copy is free to sync directly.
    const ended = await syncNow(darryl);
    expect(ended.error?.code).toBe('RECORD_ROUTE_ENDED');
    expect(
      await onCopy(fixture.tmp, darryl, (client) => refereeingDashboard(client), {
        replicaCheck: false,
      })
    ).toBeNull();
    // A 404 in the engine's shape, as the dashboard's relay answers a project it no longer referees
    // (NOT_SHARED), ends the route as well: the dashboard's project list decides, not the body's shape.
    const relay = jest.spyOn(DashboardClient.prototype, 'relayPeerCall').mockResolvedValue(
      createSuccess({
        status: 404,
        body: {
          success: false,
          error: {
            code: 'NOT_SHARED',
            message: 'This project is not shared through the dashboard.',
          },
        },
      })
    );
    try {
      expect((await syncNow(erin)).error?.code).toBe('RECORD_ROUTE_ENDED');
    } finally {
      relay.mockRestore();
    }
    expect(
      await onCopy(fixture.tmp, erin, (client) => refereeingDashboard(client), {
        replicaCheck: false,
      })
    ).toBeNull();
    // A later share starts fresh, with a new referee, once the project has no direct members again.
    for (const name of ['darryl', 'erin'])
      expect((await on(owner, 'rbook_project', { action: 'remove', name })).success).toBe(true);
    // An answer kept for the old referee, as a share that stopped once leaves it, is spent by now.
    expect(keptShare(owner)).toBe(0);
    await onCopy(
      fixture.tmp,
      owner,
      (client) =>
        writeCopyKey(
          client,
          COPY_KEYS.dashboardShare,
          JSON.stringify({ projectId: PROJECT, refereeReplica: first.refereeReplica, answer: {} })
        ),
      { replicaCheck: false }
    );
    process.env.RBOOK_DASHBOARD_SHARING = 'on';
    const again = await shared(owner);
    expect(again.refereeReplica).not.toBe(first.refereeReplica);
    expect(keptShare(owner)).toBe(0);
  }, 600000);

  it('an interrupted move back leaves the referee serving and the successor taken, and asking again, with no sync between, finishes it', async () => {
    const owner = await soloOwner();
    await shared(owner);
    const darryl = await joined('darryl');
    // The move back stops after this copy took its successor, before the referee handed the record over.
    await successorTaken(owner);
    // The referee still serves its members.
    expect(
      (
        await on(darryl, 'rbook_decisions', {
          action: 'record',
          content: 'While the move was pending.',
        })
      ).success
    ).toBe(true);
    expect((await syncNow(darryl)).success).toBe(true);
    expect((await me())?.dashboardShared).toBe(true);
    // Asked again straight away: the move's own first sync tells this copy it is the owner's successor.
    const finished = await on(owner, 'rbook_project', { action: 'move', to: 'owner' });
    if (!finished.success) throw new Error(JSON.stringify(finished.error));
    expect(await standing(owner)).toEqual({ holds: true, epoch: 3, pendingToIt: false });
    expect(decisions(owner, 'While the move was pending.')).toBe(1);
    expect((await me())?.dashboardShared).toBe(false);
  }, 600000);

  it('a sync after the referee handed the record back, before this copy confirmed the move, archives nothing', async () => {
    const owner = await soloOwner();
    await shared(owner);
    const { peer } = await successorTaken(owner);
    // The copy syncs under its new identity, and the move stops once the referee handed the record over.
    expect((await syncNow(owner)).success).toBe(true);
    const handover = (await peer.call('moveBack', {})) as { epoch: number };
    expect(handover.epoch).toBe(3);
    // A sync the timer or a hook runs now catches the move up, unconfirmed: the referee keeps serving.
    expect((await syncNow(owner)).success).toBe(true);
    expect(await standing(owner)).toEqual({ holds: false, epoch: 2, pendingToIt: true });
    expect((await me())?.dashboardShared).toBe(true);
    expect(fs.existsSync(path.join(fixture.tmp, 'volume', 'archive', PROJECT))).toBe(false);
    // Asking again confirms the move, judges at the new epoch, and only then is the referee archived.
    const finished = await on(owner, 'rbook_project', { action: 'move', to: 'owner' });
    if (!finished.success) throw new Error(JSON.stringify(finished.error));
    expect(await standing(owner)).toEqual({ holds: true, epoch: 3, pendingToIt: false });
    expect((await me())?.dashboardShared).toBe(false);
    expect(fs.readdirSync(path.join(fixture.tmp, 'volume', 'archive', PROJECT))).toHaveLength(1);
  }, 600000);

  it("finishes a move back only on the dashboard's word that it no longer shares the project", async () => {
    const owner = await soloOwner();
    await shared(owner);
    // A project list that names no sharing state archives nothing: the last sync still runs.
    const silent = jest
      .spyOn(DashboardClient.prototype, 'dashboardSharing')
      .mockResolvedValue(createSuccess({ listed: true, shared: null }));
    let moved: Awaited<ReturnType<typeof on>>;
    try {
      moved = await on(owner, 'rbook_project', { action: 'move', to: 'owner' });
    } finally {
      silent.mockRestore();
    }
    expect(moved.error?.message).toMatch(
      /does not say whether it still shares the project, so the move back has not finished/
    );
    expect((await me())?.dashboardShared).toBe(false);
    // The route is kept, so asking again finds the referee gone and finishes the move.
    const finished = await on(owner, 'rbook_project', { action: 'move', to: 'owner' });
    if (!finished.success) throw new Error(JSON.stringify(finished.error));
    expect(await standing(owner)).toEqual({ holds: true, epoch: 3, pendingToIt: false });
    expect(
      await onCopy(fixture.tmp, owner, (client) => refereeingDashboard(client), {
        replicaCheck: false,
      })
    ).toBeNull();
  }, 600000);

  it('keeps an identity edit the owner copy writes while the move back waits on the dashboard', async () => {
    const owner = await soloOwner();
    await shared(owner);
    const relay = DashboardClient.prototype.relayPeerCall;
    let wrote = false;
    const spy = jest
      .spyOn(DashboardClient.prototype, 'relayPeerCall')
      .mockImplementation(async function (this: DashboardClient, ...args) {
        if (args[1].method === 'admitSuccessor' && !wrote) {
          // An agent changes the identity between the move's sync and its take.
          wrote = true;
          const edited = await on(owner, 'rbook_project', {
            action: 'update',
            projectType: 'managed',
          });
          expect(edited.error).toBeUndefined();
        }
        return relay.apply(this, args);
      });
    let moved: Awaited<ReturnType<typeof on>>;
    try {
      moved = await on(owner, 'rbook_project', { action: 'move', to: 'owner' });
    } finally {
      spy.mockRestore();
    }
    if (!moved.success) throw new Error(JSON.stringify(moved.error));
    expect(wrote).toBe(true);
    expect((moved.data as unknown as { successor: { count: number } }).successor.count).toBe(0);
    expect(read(owner, "SELECT value FROM metadata WHERE key = 'project_type'")).toEqual([
      { value: 'managed' },
    ]);
  }, 600000);

  it('a share whose kept answer lost its referee to a discard starts again with a new one', async () => {
    const owner = await soloOwner();
    // The answer is lost on its way to the dashboard once: the share stops with it kept.
    const relay = DashboardClient.prototype.relayRefereeCall;
    let lost = false;
    const spy = jest
      .spyOn(DashboardClient.prototype, 'relayRefereeCall')
      .mockImplementation(async function (this: DashboardClient, ...args) {
        if (args[1].kind === 'answer' && !lost) {
          lost = true;
          return createSuccess({ status: 503, body: { success: false, error: 'Busy' } });
        }
        return relay.apply(this, args);
      });
    let stopped: Awaited<ReturnType<typeof on>>;
    try {
      stopped = await on(owner, 'rbook_project', {
        action: 'share',
        via: 'dashboard',
        confirm: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(stopped.success).toBe(false);
    expect(keptShare(owner)).toBe(1);
    const dead = (
      JSON.parse(
        read<{ value: string }>(owner, 'SELECT value FROM metadata WHERE key = ?', [
          COPY_KEYS.dashboardShare,
        ])[0].value
      ) as { refereeReplica: string }
    ).refereeReplica;
    // The owner starts over on the dashboard, which throws the referee that never joined away.
    const discarded = await request(server, `/api/relay/projects/${PROJECT}/referee`, {
      token: TOKENS.owner,
      method: 'DELETE',
    });
    expect(discarded.status).toBe(200);
    const again = await shared(owner);
    expect(again.refereeReplica).not.toBe(dead);
    expect(keptShare(owner)).toBe(0);
    expect((await me())?.dashboardShared).toBe(true);
  }, 600000);

  // s97-m14 (the dashboard's live test, message ba937cbf): a removed editor's sync said only "The
  // owner's copy took in 5" and exited 0, so nothing told the editor those changes would not count.
  // The cut is where the owner's copy stood when it removed the member, so what the member made
  // before the removal and had not synced is set aside too (critics, round 1).
  it('a member removed on the dashboard is told what is set aside, and its review shows it until it is shared with again', async () => {
    const owner = await soloOwner();
    await shared(owner);
    const darryl = await joined('darryl');
    expect((await syncNow(darryl)).success).toBe(true);
    const decide = async (content: string) =>
      expect((await on(darryl, 'rbook_decisions', { action: 'record', content })).success).toBe(
        true
      );
    await decide('Darryl, before his removal, not yet synced.');
    const removed = await request(
      server,
      `/api/test/projects/${PROJECT}/shares/${ACCOUNTS.darryl}`,
      {
        token: TOKENS.owner,
        method: 'DELETE',
      }
    );
    expect(removed.status).toBe(200);
    await decide('Darryl, after his removal.');

    const cut = await syncNow(darryl);
    expect(cut.success).toBe(true);
    const report = (cut.data as unknown as { peers: Array<{ report?: ExchangeReport }> }).peers[0]
      .report!;
    expect(report).toMatchObject({ removed: true, removedCopy: 'local', received: 0 });
    for (const said of [formatSharedProjectForLLM('sync', cut as never), exchangeText(report)]) {
      expect(said).toMatch(/this copy's member was removed from the project/i);
      expect(said).toMatch(
        /it sent, and anything else the owner's copy did not hold when it removed the member, are set aside/
      );
      expect(said).toMatch(/only if the owner shares the project with it again/);
      expect(said).not.toMatch(/took in/);
    }
    // Both of Darryl's decisions are set aside at the referee, the one made before the removal too.
    const waiting = await request<Array<{ state: string; replicaId: string }>>(
      server,
      `/api/test/projects/${PROJECT}/waiting`,
      { token: TOKENS.owner }
    );
    const his = waiting.body.data!.filter((txn) => txn.replicaId === report.local.replicaId);
    expect(his.length).toBeGreaterThanOrEqual(2);
    expect(new Set(his.map((txn) => txn.state))).toEqual(new Set(['quarantined']));
    // The review, its digest line and rbook_status say so, from when the copy was first told.
    const firstSaid = () =>
      read<{ removed_at: string | null }>(darryl, 'SELECT removed_at FROM record_peers')[0]
        .removed_at;
    const told = firstSaid();
    expect(told).toEqual(expect.any(String));
    const review = await onCopy(fixture.tmp, darryl, (client) => sharedRecordReview(client));
    expect(review?.removed).toBe(true);
    expect(review?.peers?.[0]).toMatch(/: said this copy's member was removed \(first said /);
    const status = await on(darryl, 'rbook_status', {});
    expect(
      (status.data as unknown as { shared_sync: Array<{ removed_at?: string }> }).shared_sync[0]
        .removed_at
    ).toBe(told);
    // A second sync while removed keeps when the copy was first told.
    expect((await syncNow(darryl)).success).toBe(true);
    expect(firstSaid()).toBe(told);

    // Shared with again: the sync goes through, says nothing of a removal, and the set-aside
    // decisions count on the owner's copy.
    const again = await request(server, `/api/test/projects/${PROJECT}/shares`, {
      token: TOKENS.owner,
      json: { accountId: ACCOUNTS.darryl, name: 'darryl', role: 'editor' },
    });
    expect(again.status).toBe(200);
    const back = await syncNow(darryl);
    expect(back.success).toBe(true);
    expect(formatSharedProjectForLLM('sync', back as never)).not.toMatch(
      /removed from the project/
    );
    expect(firstSaid()).toBeNull();
    expect(
      (await onCopy(fixture.tmp, darryl, (client) => sharedRecordReview(client)))?.removed
    ).toBeUndefined();
    expect((await syncNow(owner)).success).toBe(true);
    expect(decisions(owner, 'Darryl, before his removal, not yet synced.')).toBe(1);
    expect(decisions(owner, 'Darryl, after his removal.')).toBe(1);
  }, 600000);

  it("a removed member's sync that holds back a transaction too large still says the member was removed", async () => {
    const owner = await soloOwner();
    await shared(owner);
    const darryl = await joined('darryl');
    expect((await syncNow(darryl)).success).toBe(true);
    const removed = await request(
      server,
      `/api/test/projects/${PROJECT}/shares/${ACCOUNTS.darryl}`,
      {
        token: TOKENS.owner,
        method: 'DELETE',
      }
    );
    expect(removed.status).toBe(200);
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: `Too large: ${'y'.repeat(LIMIT)}`,
    });
    const held = await syncNow(darryl);
    expect(held.error?.code).toBe('RECORD_TRANSACTION_TOO_LARGE');
    expect(formatSharedProjectForLLM('sync', held as never)).toMatch(
      /this copy's member was removed from the project/i
    );
    // The removal leads the error, so the review's slice of it keeps the removal (critics, round 2).
    const peers =
      (await onCopy(fixture.tmp, darryl, (client) => sharedRecordReview(client)))?.peers ?? [];
    expect(peers.join('\n')).toMatch(/last error: This copy's member was removed from the project/);
  }, 600000);

  it('joins into no folder that is none, such as the home folder, through the MCP tool too', async () => {
    const home = path.join(fixture.tmp, 'home');
    fs.mkdirSync(home);
    const homedir = jest.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      await signIn('machine-darryl', TOKENS.darryl);
      const refused = await on({ root: home, machine: 'machine-darryl' }, 'rbook_project', {
        action: 'join',
        via: 'dashboard',
        project: ADDRESS,
      });
      expect(refused.error?.message).toMatch(/is not a project folder/);
    } finally {
      homedir.mockRestore();
    }
    expect(fs.existsSync(path.join(home, 'rbook'))).toBe(false);
  }, 600000);
});

describe('the owner copy, invited on a direct share, stays as 4.1.0 left it (s97-m11)', () => {
  it('the owner copy of a directly shared project, its authority, is still asked to mint its project key (s97-m14)', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await signIn(owner.machine, TOKENS.owner);
    // Only a copy that is not the authority's never registers; this one registers and uploads as
    // before, so it keeps the action that mints its key.
    const onboard = (await on(owner, 'rbook_agent_onboard', {})) as unknown as {
      data: { suggestedActions: Array<{ command: string }> };
    };
    expect(onboard.data.suggestedActions.map((a) => a.command).join('\n')).toMatch(/reissue/);
  }, 600000);

  it('an owner-role copy of a directly shared project still may not change the identity', async () => {
    const owner = await ownerCopy(fixture.tmp);
    await onCopy(fixture.tmp, owner, (client) =>
      inviteMember(client, { name: 'Owner Two', role: 'owner' })
    );
    const second = await joinedCopy(fixture.tmp, owner, 'second', 'Owner Two');
    expect(
      (await on(second, 'rbook_project', { action: 'update', projectType: 'managed' })).error
        ?.message
    ).toMatch(/Only the owner's copy of a shared record changes/);
  }, 600000);
});

describe('a member that missed the move back (s100-m01, F7)', () => {
  /** Every logged change of a copy, as two copies that agree both hold it. */
  const logOf = (copy: Pick<Copy, 'root'>) =>
    read(copy, 'SELECT change_id, replica_id, replica_seq FROM record_changes ORDER BY change_id');

  it('is caught up over SSH by the owner copy that moved it back, holds the move until its person confirms it, and then syncs both ways', async () => {
    const owner = await soloOwner();
    await shared(owner);
    const darryl = await joined('darryl');
    expect(
      (await on(darryl, 'rbook_decisions', { action: 'record', content: 'Darryl, synced.' }))
        .success
    ).toBe(true);
    expect((await syncNow(darryl)).success).toBe(true);
    const moved = await on(owner, 'rbook_project', { action: 'move', to: 'owner' });
    if (!moved.success) throw new Error(JSON.stringify(moved.error));
    // darryl misses the move back: it writes again, and its copy still names the dashboard. The
    // owner's copy writes too, which darryl must not take as live before its person confirms.
    expect(
      (await on(darryl, 'rbook_decisions', { action: 'record', content: 'Darryl, unsynced.' }))
        .success
    ).toBe(true);
    expect(
      (await on(owner, 'rbook_decisions', { action: 'record', content: 'The owner, moved back.' }))
        .success
    ).toBe(true);
    const routed = () =>
      onCopy(fixture.tmp, darryl, (client) => refereeingDashboard(client), {
        replicaCheck: false,
      });
    expect(await routed()).not.toBeNull();

    // The owner's copy reaches darryl's over SSH, without darryl first syncing with the dashboard.
    const { ssh } = standinSsh(path.join(fixture.tmp, 'ssh'));
    const toDarryl = sshRouteTo(darryl.root, path.join(fixture.tmp, `config-${darryl.machine}`));
    useMachine(fixture.tmp, owner.machine);
    const open = storeOpener(dbOf(owner.root));
    const unchecked = storeOpener(dbOf(owner.root), { replicaCheck: false });
    const first = await syncAndRoute(open, toDarryl, { ssh, unchecked });
    if (!first.success) throw new Error(JSON.stringify(first.error));
    expect(first.data!.caughtUp).toMatchObject({ copy: 'remote' });
    expect(first.data!.caughtUp!.confirmed).toBeUndefined();
    // A catch-up only stores: darryl holds the move until its person confirms it.
    const pending = () =>
      onCopy(fixture.tmp, darryl, (client) => mergeContext(client).pending !== null, {
        replicaCheck: false,
      });
    expect(await pending()).toBe(true);
    expect(decisions(owner, 'Darryl, unsynced.')).toBe(0);
    expect(decisions(darryl, 'The owner, moved back.')).toBe(0);
    // darryl's person confirms the owner's copy (the live test records whose word this is, #1545).
    const confirmed = await on(darryl, 'rbook_project', { action: 'sync', confirmOwner: true });
    if (!confirmed.success) throw new Error(JSON.stringify(confirmed.error));
    expect(await pending()).toBe(false);
    expect(await routed()).toBeNull();
    expect(decisions(darryl, 'The owner, moved back.')).toBe(1);

    // A second exchange, from the owner's copy, flows both ways.
    expect(
      (await on(owner, 'rbook_decisions', { action: 'record', content: 'The owner, back home.' }))
        .success
    ).toBe(true);
    useMachine(fixture.tmp, owner.machine);
    const second = await syncPeers(open, { ssh, unchecked });
    if (!second.success) throw new Error(JSON.stringify(second.error));
    expect(decisions(owner, 'Darryl, unsynced.')).toBe(1);
    expect(decisions(darryl, 'The owner, back home.')).toBe(1);
    expect(logOf(darryl)).toEqual(logOf(owner));
  }, 600000);

  it('a far end the dashboard referees serves only hello, chains, changesSince and a catch-up apply, and only to an owner copy at a later move', async () => {
    const owner = await soloOwner();
    await shared(owner);
    const darryl = await joined('darryl');
    expect((await syncNow(darryl)).success).toBe(true);
    useMachine(fixture.tmp, darryl.machine);
    const opened = storeOpener(dbOf(darryl.root));
    const unchecked = storeOpener(dbOf(darryl.root), { replicaCheck: false });
    const own = await unchecked((client) => hello(client));
    /** Each request's answer from darryl's far end, opened for one connection. */
    const ask = async (near: unknown, requests: Array<{ method: string; params?: unknown }>) => {
      const input = new PassThrough();
      const output = new PassThrough();
      const lines = createInterface({ input: output });
      const answers: Array<Record<string, unknown>> = [];
      lines.on('line', (line) => answers.push(JSON.parse(line) as Record<string, unknown>));
      const served = serveSync(input, output, opened, { exchanged: async () => null }, unchecked);
      const all = [
        { method: 'hello', params: near === undefined ? undefined : { near } },
        ...requests,
      ];
      all.forEach((request, index) =>
        input.write(`${JSON.stringify({ id: index + 1, ...request })}\n`)
      );
      input.end();
      await served;
      output.end();
      await new Promise((resolve) => lines.once('close', resolve));
      // The banner, then the answer to the hello that named the near end, then each probe's.
      return answers.slice(2);
    };
    const ahead = {
      ...own,
      replicaId: 'r-owner-new',
      authority: 'r-owner-new',
      epoch: own.epoch + 1,
    };
    const probes = [
      { method: 'hello' },
      { method: 'chains', params: {} },
      { method: 'changesSince', params: {} },
      { method: 'apply', params: { changes: [], judge: false, catchUp: true } },
      { method: 'apply', params: { changes: [] } },
      { method: 'admitSuccessor', params: { replicaId: own.replicaId } },
      { method: 'reblockSelf' },
      { method: 'takeSuccessor', params: {} },
      { method: 'failed', params: { replicaId: 'r-owner-new', error: 'x' } },
      { method: 'exchanged', params: {} },
    ];
    const served = await ask(ahead, probes);
    expect(served.map((answer) => 'result' in answer)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
    for (const refused of served.slice(4))
      expect(String((refused.error as { message: string }).message)).toMatch(/catch-up/);
    // A copy at the same move, one that is not the owner copy in its own view, one of another
    // project, or one that says nothing of itself, is refused as before.
    for (const near of [
      { ...ahead, epoch: own.epoch },
      { ...ahead, authority: 'r-someone-else' },
      { ...ahead, projectId: 'another-project' },
      undefined,
    ])
      for (const answer of await ask(near, probes.slice(0, 3)))
        expect(String((answer.error as { message: string }).message)).toMatch(
          /does not sync over SSH/
        );
  }, 600000);
});

describe('a join refused for a first copy it cannot build (s100-m01, critics round 1)', () => {
  it("keeps the refusal's own remedy, such as a newer record protocol's upgrade", async () => {
    const owner = await soloOwner();
    await shared(owner);
    await request(server, `/api/test/projects/${PROJECT}/shares`, {
      token: TOKENS.owner,
      json: { accountId: ACCOUNTS.darryl, name: 'darryl', role: 'editor' },
    });
    const copy = {
      name: 'darryl',
      root: path.join(fixture.tmp, 'darryl'),
      machine: 'machine-darryl',
      replicaId: '',
      block: -1,
    };
    await signIn(copy.machine, TOKENS.darryl);
    const build = jest
      .spyOn(freshCopy, 'buildFreshCopy')
      .mockRejectedValue(
        new freshCopy.FreshCopyRefused(
          "That store's change log is written in record protocol 2, newer than this version's 1, so no copy is built from it.",
          'Upgrade Reasonbook on this machine, then join again: npm install -g @aquex/reasonbook@latest.'
        )
      );
    try {
      const answer = await on(copy, 'rbook_project', {
        action: 'join',
        via: 'dashboard',
        project: ADDRESS,
      });
      expect(answer.success).toBe(false);
      expect(answer.error?.message).toMatch(/record protocol 2/);
      expect(answer.error?.suggestion).toMatch(
        /^Nothing was joined\. Upgrade Reasonbook on this machine/
      );
    } finally {
      build.mockRestore();
    }
  }, 600000);
});

describe('sharing again after a move back (s100-m01, critics round 2)', () => {
  it("names no former identity of the owner's own folder as another copy, before its new one writes", async () => {
    const owner = await soloOwner();
    await shared(owner);
    // The owner's copy writes while the project is shared, as its former identity.
    expect(
      (await on(owner, 'rbook_decisions', { action: 'record', content: 'While shared.' })).success
    ).toBe(true);
    expect((await syncNow(owner)).success).toBe(true);
    const moved = await on(owner, 'rbook_project', { action: 'move', to: 'owner' });
    if (!moved.success) throw new Error(JSON.stringify(moved.error));
    const copies = await onCopy(fixture.tmp, owner, (client) => ownersOtherCopies(client), {
      replicaCheck: false,
    });
    expect(copies).toEqual([]);
    const dry = await on(owner, 'rbook_project', { action: 'share', via: 'dashboard' });
    expect(dry.error?.message ?? '').not.toMatch(/also kept in/);
  }, 600000);
});

describe('a handover to a copy behind a move (s100-m01, critics round 1)', () => {
  it('is refused before the move is written, so the owner copy keeps the record', async () => {
    const owner = await soloOwner();
    await shared(owner);
    // The owner's own second machine, joined through the dashboard: an owner-role copy.
    const second = {
      name: 'owner2',
      root: path.join(fixture.tmp, 'owner2'),
      machine: 'machine-owner2',
      replicaId: '',
      block: -1,
    };
    await signIn(second.machine, TOKENS.owner);
    writeUserAuthor('Owner');
    const joinedSecond = await on(second, 'rbook_project', {
      action: 'join',
      via: 'dashboard',
      project: ADDRESS,
    });
    if (!joinedSecond.success) throw new Error(JSON.stringify(joinedSecond.error));
    expect((await syncNow(second)).success).toBe(true);
    const moved = await on(owner, 'rbook_project', { action: 'move', to: 'owner' });
    if (!moved.success) throw new Error(JSON.stringify(moved.error));
    // The second copy missed the move back; the owner hands the owner's copy to it over SSH.
    const { ssh } = standinSsh(path.join(fixture.tmp, 'ssh'));
    useMachine(fixture.tmp, owner.machine);
    // A handover's far end takes no catch-up, so it refuses as it did before 4.2.1, and nothing
    // is written; a far end that answered would be refused as behind the move (record-routes).
    const handed = await handOverRoute(
      storeOpener(dbOf(owner.root)),
      sshRouteTo(second.root, path.join(fixture.tmp, `config-${second.machine}`)),
      { ssh, unchecked: storeOpener(dbOf(owner.root), { replicaCheck: false }) }
    ).catch((error: Error) => ({ success: false as const, error: { message: error.message } }));
    expect(handed.success).toBe(false);
    expect(handed.error?.message).toMatch(/does not sync over SSH|has not taken the owner copy/);
    const holds = await onCopy(
      fixture.tmp,
      owner,
      (client) => {
        const ctx = mergeContext(client);
        return ctx.authority === ctx.ownReplica && !ctx.pending;
      },
      { replicaCheck: false }
    );
    expect(holds).toBe(true);
  }, 600000);
});

describe('a removed member after a move back (s100-m01, #717 item 2)', () => {
  it('forgets its dashboard route on the 404 the dashboard answers it, as a member does when the project moves back', async () => {
    const owner = await soloOwner();
    await shared(owner);
    const darryl = await joined('darryl');
    expect((await syncNow(darryl)).success).toBe(true);
    const removed = await request(
      server,
      `/api/test/projects/${PROJECT}/shares/${ACCOUNTS.darryl}`,
      { token: TOKENS.owner, method: 'DELETE' }
    );
    expect(removed.status).toBe(200);
    // Told of the removal at its next sync, as the review then keeps it.
    const cut = await syncNow(darryl);
    expect(cut.success).toBe(true);
    expect(
      read<{ removed_at: string | null }>(darryl, 'SELECT removed_at FROM record_peers')[0]
        .removed_at
    ).toEqual(expect.any(String));
    const moved = await on(owner, 'rbook_project', { action: 'move', to: 'owner' });
    if (!moved.success) throw new Error(JSON.stringify(moved.error));
    // The deployed dashboard answers a removed member 404 and lists no row for it (its 44db86bc),
    // where the reference server still lists the project: a double stands in for those two answers.
    const relay = jest
      .spyOn(DashboardClient.prototype, 'relayPeerCall')
      .mockResolvedValue(createSuccess({ status: 404, body: { error: 'Not found' } }));
    const listing = jest
      .spyOn(DashboardClient.prototype, 'dashboardSharing')
      .mockResolvedValue(createSuccess({ listed: false, shared: null }));
    let ended: Awaited<ReturnType<typeof syncNow>>;
    try {
      ended = await syncNow(darryl);
    } finally {
      relay.mockRestore();
      listing.mockRestore();
    }
    expect(ended.error?.code).toBe('RECORD_ROUTE_ENDED');
    expect(ended.error?.message).toMatch(/removed/);
    expect(
      await onCopy(fixture.tmp, darryl, (client) => refereeingDashboard(client), {
        replicaCheck: false,
      })
    ).toBeNull();
    // The removal stays where the review, the digest and rbook_status read it.
    const review = await onCopy(fixture.tmp, darryl, (client) => sharedRecordReview(client), {
      replicaCheck: false,
    });
    expect(review?.removed).toBe(true);
    expect((review?.peers ?? []).join('\n')).toMatch(/said this copy's member was removed/);
    // Named for the dashboard it reached, which no longer holds the record, not as the owner's copy.
    expect((review?.peers ?? []).join('\n')).toMatch(/^the dashboard \(/);
    const status = await on(darryl, 'rbook_status', {});
    expect(
      (status.data as unknown as { shared_sync: Array<{ removed_at?: string }> }).shared_sync[0]
        ?.removed_at
    ).toEqual(expect.any(String));
    // Its next sync says why it syncs with no one, and asks for no route.
    const next = await syncNow(darryl);
    expect(next.error?.message).toMatch(/member was removed from the project/);
    expect(next.error?.suggestion).not.toMatch(/--ssh|bundle/);
  }, 600000);

  it('keeps its route on a 404 while it knows of no removal, as when this machine is signed in to another account', async () => {
    const owner = await soloOwner();
    await shared(owner);
    const darryl = await joined('darryl');
    expect((await syncNow(darryl)).success).toBe(true);
    const relay = jest
      .spyOn(DashboardClient.prototype, 'relayPeerCall')
      .mockResolvedValue(createSuccess({ status: 404, body: { error: 'Not found' } }));
    const listing = jest
      .spyOn(DashboardClient.prototype, 'dashboardSharing')
      .mockResolvedValue(createSuccess({ listed: false, shared: null }));
    try {
      expect((await syncNow(darryl)).error?.code).not.toBe('RECORD_ROUTE_ENDED');
    } finally {
      relay.mockRestore();
      listing.mockRestore();
    }
    expect(
      await onCopy(fixture.tmp, darryl, (client) => refereeingDashboard(client), {
        replicaCheck: false,
      })
    ).not.toBeNull();
  }, 600000);
});

describe('purge while the dashboard holds the record (s100-m02)', () => {
  it("refuses it on the owner's own copy too, and names the move back that lets the owner purge", async () => {
    // The docs-truth critic's round 2: once the share hands the record over, the owner's copy is a
    // member's, so "purge from the owner's copy" names a step no copy can take.
    const owner = await soloOwner();
    await shared(owner);
    const purged = await on(owner, 'rbook_db', { action: 'purge', confirm: true });
    expect(purged.error?.message).toMatch(/member's copy of a shared record/);
    expect(purged.error?.suggestion).toMatch(
      /the owner moves the project back first \(reasonbook move --to owner\), then purges from that copy/
    );
  }, 600000);
});

describe("what a member's agent sees after a dashboard join (s100-m01, the build session's captures)", () => {
  it("names the address it joined by, calls the copy no fresh project, asks the dashboard nothing by slug, and names no account-wide count as the project's", async () => {
    const owner = await soloOwner();
    await shared(owner);
    const darryl = await joined('darryl');
    expect((await syncNow(darryl)).success).toBe(true);
    const bySlug = jest.spyOn(DashboardClient.prototype, 'getSyncStatus');
    const stateBySlug = jest.spyOn(DashboardClient.prototype, 'getSyncProjectState');
    // The machine's user key reads the account's messages, unscoped: what a member's copy holds.
    const inbox = jest.spyOn(DashboardClient.prototype, 'listMessages').mockResolvedValue(
      createSuccess({
        messages: [],
        unreadCount: 64,
        unreadCountScoped: 64,
        unreadScope: 'user' as const,
        totalCount: 64,
      })
    );
    try {
      const review = await on(darryl, 'rbook_review', {});
      const data = review.data as {
        project: { rbook_address: string };
        next_actions: Array<{ action: string }>;
      };
      expect(data.project.rbook_address).toBe(ADDRESS);
      const actions = data.next_actions.map((action) => action.action).join('\n');
      expect(actions).not.toMatch(/Fresh project/);
      expect(actions).not.toMatch(/unread message\(s\) for this project/);
      const status = await on(darryl, 'rbook_status', {});
      expect((status.data as { rbook_address: string }).rbook_address).toBe(ADDRESS);
      const onboard = await on(darryl, 'rbook_agent_onboard', {});
      expect((onboard.data as { freshProject: boolean }).freshProject).toBe(false);
      expect(
        JSON.stringify((onboard as unknown as { warnings?: string[] }).warnings ?? [])
      ).not.toMatch(/projectSlug/);
      const reconciled = await on(darryl, 'rbook_db', { action: 'reconcile' });
      expect(reconciled.error?.message).toMatch(/member's copy of a shared record/);
      const identity = await on(darryl, 'rbook_context', {
        action: 'view',
        contextType: 'project_identity',
      });
      expect((identity.data as { joinedAddress?: string }).joinedAddress).toBe(ADDRESS);
      expect(bySlug).not.toHaveBeenCalled();
      expect(stateBySlug).not.toHaveBeenCalled();
    } finally {
      bySlug.mockRestore();
      stateBySlug.mockRestore();
      inbox.mockRestore();
    }
  }, 600000);
});
