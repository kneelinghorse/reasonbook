// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Exercise the reference host's recovery lifecycle over real loopback HTTP and restarts.
// ABOUTME: A deterministic engine double isolates host authorization, persistence and immutable upload receipts.
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';
import { request, spawnRefereeServer, type RunningServer } from '../helpers/referee-http';
import { replicaFixture, type ReplicaFixture } from '../helpers/replica-fixture';
import type { RefereeServerConfig } from '../helpers/referee-server';

let fixture: ReplicaFixture;
let server: RunningServer;
let volume: string;
let engine: string;
const projectId = 'registry-project';
const prefix = `/api/relay/projects/${projectId}`;
const controls = `/api/test/projects/${projectId}/recovery`;
const head = { replicaId: 'old-referee', seq: 3, hash: 'head3' };
const tokens = { owner: 'owner-token', member: 'member-token', removed: 'removed-token' };
const recordId = 'record-project';

function config(): RefereeServerConfig & { engineModule: string } {
  return {
    root: volume,
    accounts: {
      [tokens.owner]: 'acct-owner',
      [tokens.member]: 'acct-member',
      [tokens.removed]: 'acct-removed',
    },
    projects: { [projectId]: { ownerAccountId: 'acct-owner' } },
    requestLimit: 1024,
    uploadLimit: 4096,
    engineModule: engine,
  };
}
const start = () => spawnRefereeServer(path.join(fixture.tmp, `process-${Date.now()}`), config());
const peer = (params: unknown = {}) =>
  request(server, `${prefix}/peer`, {
    token: tokens.owner,
    json: { method: 'hello', replicaId: 'owner-copy', params },
  });
async function lose() {
  expect(
    (await request(server, `${controls}/lose`, { token: tokens.owner, json: {} })).status
  ).toBe(200);
  return peer();
}
async function offer() {
  const result = await lose();
  expect(result.body.error?.code).toBe('REFEREE_RECOVERING');
  return result.body.error?.currentState as { recoveryId: string };
}
const upload = (recoveryId: string, body = Buffer.from('first-copy'), token = tokens.member) =>
  request(server, `${prefix}/recovery/copy?recoveryId=${recoveryId}&replicaId=member-copy`, {
    token,
    body,
    headers: { 'content-type': 'application/octet-stream' },
  });

beforeEach(async () => {
  fixture = replicaFixture('rbook-recovery-host-');
  volume = path.join(fixture.tmp, 'volume');
  const store = path.join(volume, 'referee', projectId, 'rbook.sqlite');
  fs.mkdirSync(path.dirname(store), { recursive: true });
  const db = new Database(store);
  db.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('vacuum-positive')");
  db.close();
  fs.writeFileSync(
    path.join(volume, 'server-state.json'),
    JSON.stringify({
      [projectId]: {
        head,
        shared: true,
        needsRecovery: null,
        grants: [['acct-member', 'editor']],
        known: ['acct-member', 'acct-removed'],
        recordProjectId: recordId,
        headHistory: [head],
        members: [
          { memberId: 'owner', name: 'Owner', role: 'owner', accountId: 'acct-owner' },
          { memberId: 'member', name: 'Member', role: 'editor', accountId: 'acct-member' },
        ],
        snapshots: [],
        recovery: null,
      },
    })
  );
  engine = path.join(fixture.tmp, 'installed-engine.cjs');
  fs.writeFileSync(
    engine,
    `
const fs = require('fs');
const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
const api = require(${JSON.stringify(path.resolve(__dirname, '../../src/referee'))});
let head = ${JSON.stringify(head)};
let failMembers = false;
const members = ${JSON.stringify([
      { memberId: 'owner', name: 'Owner', role: 'owner', accountId: 'acct-owner' },
      { memberId: 'member', name: 'Member', role: 'editor', accountId: 'acct-member' },
    ])};
const good = data => ({result:{success:true,data},head});
module.exports = {...api, REFEREE_VERSION:'candidate-fixture', REFEREE_PROTOCOL:{wire:9,record:9},
  members: async () => failMembers ? {result:{success:false,error:{code:'REFEREE_FAILED',message:'member query failed',suggestion:'retry'}},head:null} : good(members),
  peer: async (location, method, params) => {
    if (!fs.existsSync(location.storePath)) return {result:{success:false,error:{code:'REFEREE_NEEDS_RECOVERY',message:'lost',suggestion:'recover'}},head:null};
    if (params?.failMembers) failMembers = true;
    if (params?.seq) head = {replicaId:'old-referee',seq:params.seq,hash:'head'+params.seq};
    return good({projectId:${JSON.stringify(recordId)}});
  },
  recoveringAnswer: state => ({success:false,error:{code:'REFEREE_RECOVERING',message:'Collecting recovery copies.',suggestion:'Upgrade Reasonbook to 4.5.0 or newer; keep writing locally.',currentState:{...state,state:'collecting'}}}),
  recoveryIntake: async (location,input) => {
    if(location.projectId!==${JSON.stringify(recordId)}) throw new Error('Registry id confused with record id');
    fs.appendFileSync(${JSON.stringify(path.join(fixture.tmp, 'intakes'))}, 'intake\\n');
    return {result:{success:true,data:{replicaId:input.caller.replicaId,memberId:input.caller.accountId==='acct-owner'?'owner':'member',marks:{},lostPrefix:3,lostHash:'head3'}},head:null};
  },
  recoveryPlan: async (location,input) => ({result:{success:true,data:{planHash:'plan-'+input.uploads.length,base:null,members,waiting:[],clashes:[],adoptedPrefix:3,loss:{count:0,lowerBound:true,summary:'none'},thirdPartyStreams:[],tailMembership:[],ready:true}},head:null}),
  finalizeRecovery: async (location,input) => {
    if (input.confirmedPlanHash!=='plan-'+input.uploads.length) return {result:{success:false,error:{code:'REFEREE_MALFORMED',message:'stale plan',suggestion:'review again'}},head:null};
    const db = new Database(location.storePath); db.exec("CREATE TABLE marker (value TEXT); INSERT INTO marker VALUES ('recovered')"); db.close();
    head = {replicaId:'new-referee',seq:1,hash:'new-head'};
    return {result:{success:true,data:{epoch:2,members}},head};
  },
};
`
  );
  server = await start();
});
afterEach(async () => {
  await server?.stop();
  fixture.restore();
});

it('records every head, snapshots by VACUUM, and persists one collecting attempt across restart', async () => {
  expect((await peer({ seq: 4 })).status).toBe(200);
  const snapshot = await request<{ file: string }>(server, `${controls}/snapshot`, {
    token: tokens.owner,
    json: {},
  });
  expect(snapshot.status).toBe(200);
  const db = new Database(snapshot.body.data!.file, { readonly: true });
  expect(db.prepare('SELECT value FROM marker').get()).toEqual({ value: 'vacuum-positive' });
  db.close();
  const first = await offer();
  await server.stop();
  server = await start();
  expect((await peer()).body.error?.currentState).toMatchObject({
    recoveryId: first.recoveryId,
    projectId,
    lostHead: { seq: 4 },
  });
  const saved = JSON.parse(fs.readFileSync(path.join(volume, 'server-state.json'), 'utf8'))[
    projectId
  ];
  expect(saved.headHistory).toEqual([head, { replicaId: 'old-referee', seq: 4, hash: 'head4' }]);
  expect(saved.recovery.state).toBe('collecting');
  expect(saved.snapshots).toHaveLength(1);
  const beforeGet = fs.readFileSync(path.join(volume, 'server-state.json'), 'utf8');
  expect((await request(server, `${prefix}/recovery`, { token: tokens.owner })).status).toBe(200);
  expect(fs.readFileSync(path.join(volume, 'server-state.json'), 'utf8')).toBe(beforeGet);
});

it('accepts the first upload only once across lost ACK retries and binds both project identities', async () => {
  const { recoveryId } = await offer();
  const first = await upload(recoveryId);
  expect(first.status).toBe(200);
  expect(first.body.data).toMatchObject({
    recoveryId,
    projectId,
    replicaId: 'member-copy',
    alreadyReceived: false,
  });
  await server.stop();
  server = await start();
  const retry = await upload(recoveryId, Buffer.from('later-local-writes'));
  expect(retry.body.data).toMatchObject({ ...(first.body.data as object), alreadyReceived: true });
  expect(fs.readFileSync(path.join(fixture.tmp, 'intakes'), 'utf8')).toBe('intake\n');
  // Even an owner may not replace or retrieve another account's accepted copy.
  expect((await upload(recoveryId, Buffer.from('claimed member copy'), tokens.owner)).status).toBe(
    404
  );
});

it('uses the file cap, refuses outsiders before reading bodies, and keeps owner confirmation private', async () => {
  const { recoveryId } = await offer();
  expect((await upload(recoveryId, Buffer.alloc(2048))).status).toBe(200);
  expect((await upload(recoveryId, Buffer.alloc(4097))).status).toBe(413);
  const compressed = (size: number) =>
    request(server, `${prefix}/recovery/copy?recoveryId=${recoveryId}&replicaId=gzip-copy`, {
      token: tokens.member,
      body: gzipSync(Buffer.alloc(size)),
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'gzip' },
    });
  expect((await compressed(2048)).status).toBe(200);
  expect((await compressed(4097)).status).toBe(413);
  expect((await upload(recoveryId, Buffer.alloc(4097), tokens.removed)).status).toBe(404);
  expect(
    (
      await request(server, `${prefix}/recovery/confirm`, {
        token: tokens.member,
        body: Buffer.alloc(4097),
      })
    ).status
  ).toBe(404);
  expect(
    (await request(server, `${prefix}/recovery`, { token: tokens.member })).body.data
  ).not.toHaveProperty('plan.members.0.accountId');
});

it('keeps cancellation durable and starts a new attempt only on an intentional owner upload', async () => {
  const { recoveryId } = await offer();
  expect(
    (
      await request(server, `${prefix}/recovery?recoveryId=${recoveryId}`, {
        token: tokens.owner,
        method: 'DELETE',
      })
    ).status
  ).toBe(200);
  await server.stop();
  server = await start();
  expect(
    (await request(server, `${prefix}/recovery`, { token: tokens.owner })).body.data
  ).toMatchObject({ recoveryId, state: 'cancelled' });
  const cancelled = (await peer()).body.error;
  expect(cancelled?.code).toBe('REFEREE_NEEDS_RECOVERY');
  expect(cancelled?.currentState).toMatchObject({
    recoveryId,
    state: 'cancelled',
    projectId,
    lostHead: head,
  });
  expect((await upload(recoveryId)).status).toBe(409);
  const restarted = await upload(recoveryId, Buffer.from('owner starts again'), tokens.owner);
  expect(restarted.status).toBe(200);
  expect(restarted.body.data).not.toMatchObject({ recoveryId });
});

it('refuses a stale confirmation and persists the new head only after confirmed finalization', async () => {
  const { recoveryId } = await offer();
  await upload(recoveryId);
  const confirm = (confirmedPlanHash: string) =>
    request(server, `${prefix}/recovery/confirm`, {
      token: tokens.owner,
      json: { recoveryId, confirmedPlanHash, confirmedTailMembershipIds: [] },
    });
  expect((await confirm('stale')).status).toBe(400);
  expect((await confirm('plan-1')).status).toBe(200);
  const saved = JSON.parse(fs.readFileSync(path.join(volume, 'server-state.json'), 'utf8'))[
    projectId
  ];
  expect(saved.head).toMatchObject({ replicaId: 'new-referee' });
  expect(saved.formerRefereeReplicaIds).toEqual([head.replicaId]);
  expect(saved.needsRecovery).toBeNull();
  expect(saved.recovery.state).toBe('hosted');
  expect(saved.snapshots).toHaveLength(1);
  const snapshot = new Database(saved.snapshots[0].file, { readonly: true });
  expect(snapshot.prepare('SELECT value FROM marker').get()).toEqual({ value: 'recovered' });
  snapshot.close();
  // A later loss starts a distinct attempt; only cancellation prevents automatic collection.
  await server.stop();
  server = await start();
  const later = await lose();
  expect(later.body.error?.code).toBe('REFEREE_RECOVERING');
  expect(later.body.error?.currentState).not.toMatchObject({ recoveryId });
});

it('launches the requested engine and reports its exact path and version', async () => {
  expect((server as RunningServer & { engine: { path: string; version: string } }).engine).toEqual({
    path: fs.realpathSync(engine),
    version: 'candidate-fixture',
    protocol: { wire: 9, record: 9 },
  });
});

it('fails loudly if authenticated membership cannot be cached after an engine mutation', async () => {
  expect((await peer({ seq: 5, failMembers: true })).status).toBe(503);
  const saved = JSON.parse(fs.readFileSync(path.join(volume, 'server-state.json'), 'utf8'))[
    projectId
  ];
  expect(saved.head.seq).toBe(5);
  expect(saved.members).toEqual([
    { memberId: 'owner', name: 'Owner', role: 'owner', accountId: 'acct-owner' },
    { memberId: 'member', name: 'Member', role: 'editor', accountId: 'acct-member' },
  ]);
  expect(saved.membersInvalid).toBe(true);
  expect(saved.recovery).toBeNull();
});

it('refuses corrupt durable state instead of erasing a recovery attempt', async () => {
  await server.stop();
  fs.writeFileSync(path.join(volume, 'server-state.json'), '{broken');
  await expect(start()).rejects.toThrow(/JSON|SyntaxError/);
  expect(fs.readFileSync(path.join(volume, 'server-state.json'), 'utf8')).toBe('{broken');
});

it('refuses a missing explicitly installed engine without falling back to checkout source', async () => {
  await server.stop();
  engine = path.join(fixture.tmp, 'missing-engine.cjs');
  await expect(start()).rejects.toThrow(/Cannot find module/);
});
