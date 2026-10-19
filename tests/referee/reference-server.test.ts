// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s97-m09 (design §R4) — the library through the reference server in its own process: the handover in, a join from
// ABOUTME: a downloaded first copy, exchanges, invite and remove, and the contract's status codes and request limit.
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { gzipSync } from 'zlib';
import { writeUserAuthor } from '../../src/intelligence/user-author';
import { exchange } from '../../src/tools/rbook/record-exchange';
import { buildFreshCopy } from '../../src/tools/rbook/record-fresh-copy';
import {
  answerJoin,
  applyJoin,
  requestJoin,
  type JoinAnswer,
  type JoinRequest,
} from '../../src/tools/rbook/record-join';
import { handOver } from '../../src/tools/rbook/record-moves';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import { readReplicaIdentity } from '../../src/tools/rbook/replica-identity';
import {
  call,
  dbOf,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../helpers/replica-fixture';
import { httpPeer, request, spawnRefereeServer, type RunningServer } from '../helpers/referee-http';
import {
  copyPeer,
  onCopy,
  ownerCopy,
  read,
  recordedState,
  type Copy,
} from '../helpers/shared-copies';

const PROJECT = 'proj-1';
const TOKENS = { owner: 'token-owner', darryl: 'token-darryl', erin: 'token-erin' };

let fixture: ReplicaFixture;
let server: RunningServer;
beforeEach(async () => {
  fixture = replicaFixture('rbook-refserver-');
  server = await spawnRefereeServer(path.join(fixture.tmp, 'server'), {
    root: path.join(fixture.tmp, 'volume'),
    accounts: {
      [TOKENS.owner]: 'acct-owner',
      [TOKENS.darryl]: 'acct-darryl',
      [TOKENS.erin]: 'acct-erin',
    },
    projects: { [PROJECT]: { ownerAccountId: 'acct-owner' } },
    requestLimit: 4 * 1024 * 1024,
  });
});
afterEach(async () => {
  await server.stop();
  fixture.restore();
});

async function on(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

const replicaNow = (copy: Copy) => () =>
  onCopy(fixture.tmp, copy, (client) => readReplicaIdentity(client, { fresh: true })!.replicaId, {
    replicaCheck: false,
  });

async function sync(copy: Copy, token: string) {
  const result = await exchange(
    copyPeer(fixture.tmp, copy),
    httpPeer(server, PROJECT, token, replicaNow(copy))
  );
  if (!result.success) throw new Error(`${copy.name}: ${JSON.stringify(result.error)}`);
  return result.data!;
}

/** The handover in, every step over the reference server's routes. */
async function handIn(): Promise<{ owner: Copy; refereeReplica: string }> {
  const owner = await ownerCopy(fixture.tmp);
  await on(owner, 'rbook_decisions', {
    action: 'record',
    content: 'Decided before the dashboard held it.',
  });
  const upload = path.join(fixture.tmp, 'upload.sqlite');
  await buildFreshCopy(dbOf(owner.root), upload);
  const created = await request<{ joinRequest: JoinRequest }>(
    server,
    `/api/relay/projects/${PROJECT}/referee`,
    {
      token: TOKENS.owner,
      body: fs.readFileSync(upload),
      headers: { 'content-type': 'application/octet-stream' },
    }
  );
  expect(created.status).toBe(200);
  const joinRequest = created.body.data!.joinRequest;
  const answer = await onCopy(fixture.tmp, owner, (client) =>
    answerJoin(client, joinRequest, 'Owner')
  );
  const applied = await request(server, `/api/relay/projects/${PROJECT}/referee/answer`, {
    token: TOKENS.owner,
    json: { answer: answer.data },
  });
  expect(applied.status).toBe(200);
  await sync(owner, TOKENS.owner);
  expect(
    (await onCopy(fixture.tmp, owner, (client) => handOver(client, { to: joinRequest.replicaId })))
      .error
  ).toBeUndefined();
  const caught = await sync(owner, TOKENS.owner);
  expect(caught.caughtUp).toMatchObject({ copy: 'remote', authority: joinRequest.replicaId });
  await sync(owner, TOKENS.owner);
  return { owner, refereeReplica: joinRequest.replicaId };
}

async function joinAs(name: string, token: string, accountId: string): Promise<Copy> {
  const shared = await request(server, `/api/test/projects/${PROJECT}/shares`, {
    token: TOKENS.owner,
    json: { accountId, name, role: 'editor' },
  });
  expect(shared.status).toBe(200);
  const response = await fetch(`${server.url}/api/relay/projects/${PROJECT}/first-copy`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const root = path.join(fixture.tmp, name);
  fs.mkdirSync(path.dirname(dbOf(root)), { recursive: true });
  fs.writeFileSync(dbOf(root), Buffer.from(await response.arrayBuffer()));
  const place = { name, root, machine: `machine-${name}`, replicaId: '', block: -1 };
  useMachine(fixture.tmp, place.machine);
  writeUserAuthor(name);
  const asked = await onCopy(fixture.tmp, place, (client) => requestJoin(client), {
    replicaCheck: false,
  });
  expect(asked.error).toBeUndefined();
  const answered = await request<JoinAnswer>(server, `/api/relay/projects/${PROJECT}/peer`, {
    token,
    json: { method: 'answerJoin', params: asked.data, replicaId: asked.data!.replicaId },
  });
  expect(answered.status).toBe(200);
  const applied = await onCopy(
    fixture.tmp,
    place,
    (client) => applyJoin(client, answered.body.data!),
    { replicaCheck: false }
  );
  expect(applied.error).toBeUndefined();
  return { ...place, replicaId: applied.data!.replicaId, block: applied.data!.block };
}

describe('the referee library through the reference server, in its own process (s97-m09)', () => {
  it('hands in, joins a member from a downloaded first copy, exchanges both ways, and removes the member at a cut', async () => {
    const { owner, refereeReplica } = await handIn();
    const ownerView = await onCopy(fixture.tmp, owner, (client) => {
      const ctx = mergeContext(client);
      return { authority: ctx.authority, role: ctx.members.get(ctx.ownReplica)?.role };
    });
    expect(ownerView).toEqual({ authority: refereeReplica, role: 'owner' });
    const darryl = await joinAs('darryl', TOKENS.darryl, 'acct-darryl');
    // The first copy came from the dashboard's copy alone: no SSH, no file carried by hand.
    expect(
      read(
        darryl,
        "SELECT decision_text FROM strategic_decisions WHERE decision_text LIKE 'Decided before%'"
      )
    ).toHaveLength(1);
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl decided this through the reference server.',
    });
    const sent = await sync(darryl, TOKENS.darryl);
    expect(sent.sent).toBeGreaterThan(0);
    expect(sent.judged).toBe(sent.sent);
    await sync(owner, TOKENS.owner);
    expect(recordedState(owner)).toEqual(recordedState(darryl));
    const changes = await request<Array<{ author_name: string; standing: string }>>(
      server,
      `/api/test/projects/${PROJECT}/changes`,
      { token: TOKENS.owner }
    );
    expect(
      changes.body
        .data!.filter((change) => change.author_name === 'darryl')
        .every((change) => change.standing === 'live')
    ).toBe(true);

    const removed = await request(server, `/api/test/projects/${PROJECT}/shares/acct-darryl`, {
      token: TOKENS.owner,
      method: 'DELETE',
    });
    expect(removed.status).toBe(200);
    await on(owner, 'rbook_decisions', {
      action: 'record',
      content: 'Written after Darryl was removed.',
    });
    await sync(owner, TOKENS.owner);
    await on(darryl, 'rbook_decisions', {
      action: 'record',
      content: 'Darryl wrote this after his removal.',
    });
    const cut = await sync(darryl, TOKENS.darryl);
    expect(cut).toMatchObject({ removed: true, received: 0 });
    const waiting = await request<Array<{ state: string; replicaId: string }>>(
      server,
      `/api/test/projects/${PROJECT}/waiting`,
      { token: TOKENS.owner }
    );
    expect(
      waiting.body.data!.filter((txn) => txn.replicaId === darryl.replicaId).map((txn) => txn.state)
    ).toEqual(expect.arrayContaining(['quarantined']));
    expect(
      read(
        darryl,
        "SELECT count(*) AS n FROM strategic_decisions WHERE decision_text = 'Written after Darryl was removed.'"
      )
    ).toEqual([{ n: 0 }]);
    const refused = await request(server, `/api/relay/projects/${PROJECT}/peer`, {
      token: TOKENS.darryl,
      json: { method: 'changesSince', params: {}, replicaId: darryl.replicaId },
    });
    expect({ status: refused.status, code: refused.body.error?.code }).toEqual({
      status: 403,
      code: 'REFEREE_MEMBER_REMOVED',
    });
  }, 300000);

  it('discards an abandoned hand-in: a late answer finds no referee, and the owner hands in again', async () => {
    const owner = await ownerCopy(fixture.tmp);
    const route = `/api/relay/projects/${PROJECT}/referee`;
    const upload = path.join(fixture.tmp, 'upload.sqlite');
    const handInOnce = async () => {
      fs.rmSync(upload, { force: true });
      await buildFreshCopy(dbOf(owner.root), upload);
      const created = await request<{ joinRequest: JoinRequest }>(server, route, {
        token: TOKENS.owner,
        body: fs.readFileSync(upload),
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(created.status).toBe(200);
      const joinRequest = created.body.data!.joinRequest;
      const answer = await onCopy(fixture.tmp, owner, (client) =>
        answerJoin(client, joinRequest, 'Owner')
      );
      return { joinRequest, answer: answer.data! };
    };
    const lost = await handInOnce();
    expect((await request(server, route, { token: TOKENS.owner, method: 'DELETE' })).status).toBe(
      200
    );
    // The first attempt's answer, retried, arrives after the discard: no referee, which is no lost store.
    const late = await request(server, `${route}/answer`, {
      token: TOKENS.owner,
      json: { answer: lost.answer },
    });
    // The server's own answer, in the dashboard's envelope rather than the engine's (contract v1 D2).
    expect({ status: late.status, code: (late.body as unknown as { code?: string }).code }).toEqual(
      {
        status: 404,
        code: 'NOT_SHARED',
      }
    );
    const again = await handInOnce();
    const applied = await request(server, `${route}/answer`, {
      token: TOKENS.owner,
      json: { answer: again.answer },
    });
    expect(applied.status).toBe(200);
    // Arriving now, the old answer is refused by the new referee, and nothing marks it lost.
    expect(
      (
        await request(server, `${route}/answer`, {
          token: TOKENS.owner,
          json: { answer: lost.answer },
        })
      ).status
    ).toBe(403);
    await sync(owner, TOKENS.owner);
    expect(
      (
        await onCopy(fixture.tmp, owner, (client) =>
          handOver(client, { to: again.joinRequest.replicaId })
        )
      ).error
    ).toBeUndefined();
    expect((await sync(owner, TOKENS.owner)).caughtUp).toMatchObject({
      copy: 'remote',
      authority: again.joinRequest.replicaId,
    });
    const me = await request<{
      projects: Array<{ dashboardShared: boolean; needsRecovery: boolean }>;
    }>(server, '/api/projects/me', { token: TOKENS.owner });
    expect(me.body.data!.projects).toEqual([
      expect.objectContaining({ dashboardShared: true, needsRecovery: false }),
    ]);
  }, 300000);

  it('answers 401, 404, 413 and 409 as the contract says, and takes a gzip request', async () => {
    const { owner } = await handIn();
    const ownerReplica = await replicaNow(owner)();
    const hello = { method: 'hello', params: {}, replicaId: ownerReplica };
    const route = `/api/relay/projects/${PROJECT}/peer`;
    expect((await request(server, route, { json: hello })).status).toBe(401);
    expect((await request(server, route, { token: TOKENS.erin, json: hello })).status).toBe(404);
    expect(
      (await request(server, `/api/relay/projects/nope/peer`, { token: TOKENS.owner, json: hello }))
        .status
    ).toBe(404);
    const zipped = await request(server, route, {
      token: TOKENS.owner,
      body: gzipSync(Buffer.from(JSON.stringify(hello))),
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });
    expect(zipped.status).toBe(200);
    const huge = await request(server, route, {
      token: TOKENS.owner,
      body: gzipSync(
        Buffer.from(JSON.stringify({ ...hello, params: { pad: 'x'.repeat(5 * 1024 * 1024) } }))
      ),
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });
    expect({
      status: huge.status,
      limit: (huge.body as unknown as { limit: number }).limit,
    }).toEqual({ status: 413, limit: 4 * 1024 * 1024 });
    const me = await request<{
      projects: Array<{ id: string; dashboardShared: boolean; referee: { protocol: unknown } }>;
    }>(server, '/api/projects/me', { token: TOKENS.owner });
    expect(me.body.data!.projects).toEqual([
      expect.objectContaining({
        id: PROJECT,
        dashboardShared: true,
        referee: expect.objectContaining({ protocol: { wire: 1, record: 1 } }),
      }),
    ]);
    // A restored volume: the store behind the head the server recorded is refused, and stays refused.
    const store = path.join(fixture.tmp, 'volume', 'referee', PROJECT, 'rbook.sqlite');
    const db = new Database(store);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const earlier = fs.readFileSync(store);
    await request(server, `/api/test/projects/${PROJECT}/shares`, {
      token: TOKENS.owner,
      json: { accountId: 'acct-erin', name: 'erin' },
    });
    for (const suffix of ['-wal', '-shm']) fs.rmSync(`${store}${suffix}`, { force: true });
    fs.writeFileSync(store, earlier);
    const lost = await request(server, route, { token: TOKENS.owner, json: hello });
    expect({ status: lost.status, code: lost.body.error?.code }).toEqual({
      status: 409,
      code: 'REFEREE_NEEDS_RECOVERY',
    });
    expect((await request(server, route, { token: TOKENS.owner, json: hello })).status).toBe(409);
  }, 300000);
});
