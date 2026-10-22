// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Only the authenticated project owner may set aside a replica through the reference dashboard.
// ABOUTME: A recent live copy needs an explicit confirmation and the resulting cut reaches other copies.
import { afterEach, expect, it, jest } from '@jest/globals';
import * as version from '../../src/server-version';
import { mergeContext } from '../../src/tools/rbook/record-standing';
import { request } from '../helpers/referee-http';
import {
  recoveryClients,
  RECOVERY_PROJECT,
  RECOVERY_TOKENS,
  required,
  type RecoveryClientFixture,
} from '../helpers/hosted-recovery-client';
import { onCopy } from '../helpers/shared-copies';

let active: RecoveryClientFixture | undefined;
afterEach(async () => {
  jest.restoreAllMocks();
  await active?.dispose();
  active = undefined;
});

it('requires the owner and an explicit recent-copy confirmation, then carries the cut to another copy', async () => {
  active = await recoveryClients();
  const fixture = active;
  const member = await fixture.join('darryl');
  const replicaId = await fixture.replica(member);
  const route = `/api/test/projects/${RECOVERY_PROJECT}/set-aside`;
  for (const token of [undefined, RECOVERY_TOKENS.darryl, RECOVERY_TOKENS.erin]) {
    const refused = await request(fixture.server, route, {
      token,
      json: { replicaId, confirmGone: true },
    });
    expect(refused.body.success).toBe(false);
    expect([401, 404]).toContain(refused.status);
  }
  const preview = await request(fixture.server, route, {
    token: RECOVERY_TOKENS.owner,
    json: { replicaId },
  });
  expect(preview.status).toBe(403);
  expect(preview.body.success).toBe(false);
  expect(preview.body.error?.message).toMatch(/recent|seven|7 days/i);
  expect(preview.body.error?.suggestion).toContain('confirmGone');
  const confirmed = await request<{ replicaId: string; cut: number; lastCallAt: string }>(
    fixture.server,
    route,
    { token: RECOVERY_TOKENS.owner, json: { replicaId, confirmGone: true } }
  );
  expect(confirmed.body.success).toBe(true);
  expect(confirmed.body.data).toMatchObject({ replicaId });
  expect(confirmed.body.data?.lastCallAt).toBeTruthy();
  required(await fixture.sync(fixture.owner));
  const ctx = await onCopy(fixture.fixture.tmp, fixture.owner, (client) => mergeContext(client));
  expect(ctx.members.get(replicaId)?.cut).toBe(confirmed.body.data?.cut);
  expect(ctx.members.get(replicaId)?.role).toBe('editor');
});

it('a move-back successor reports its supported library before receiving a record with a cut', async () => {
  // This is a supported-client simulation; the package and separate reference engine stay 4.4.0.
  jest.spyOn(version, 'getServerVersion').mockReturnValue('4.5.0');
  active = await recoveryClients();
  const fixture = active;
  const member = await fixture.join('darryl');
  const replicaId = await fixture.replica(member);
  required(
    (
      await request(fixture.server, `/api/test/projects/${RECOVERY_PROJECT}/set-aside`, {
        token: RECOVERY_TOKENS.owner,
        json: { replicaId, confirmGone: true },
      })
    ).body
  );
  const moved = await fixture.tool(fixture.owner, 'rbook_project', { action: 'move', to: 'owner' });
  expect(moved.error).toBeUndefined();
  expect(moved.success).toBe(true);
  const ctx = await onCopy(fixture.fixture.tmp, fixture.owner, (client) => mergeContext(client));
  expect(ctx.authority).toBe(ctx.ownReplica);
  expect(ctx.members.get(replicaId)?.cut).toBeDefined();
});

it('an older move-back client gets an upgrade remedy and receives no authority over the cut', async () => {
  jest.spyOn(version, 'getServerVersion').mockReturnValue('4.4.0');
  active = await recoveryClients();
  const fixture = active;
  const member = await fixture.join('darryl');
  const replicaId = await fixture.replica(member);
  required(
    (
      await request(fixture.server, `/api/test/projects/${RECOVERY_PROJECT}/set-aside`, {
        token: RECOVERY_TOKENS.owner,
        json: { replicaId, confirmGone: true },
      })
    ).body
  );
  const moved = await fixture.tool(fixture.owner, 'rbook_project', { action: 'move', to: 'owner' });
  expect(moved.success).toBe(false);
  expect(moved.error?.message).toContain('4.4.0');
  expect(moved.error?.suggestion).toMatch(/upgrade.*4\.5\.0/i);
  const ctx = await onCopy(fixture.fixture.tmp, fixture.owner, (client) => mergeContext(client));
  expect(ctx.authority).not.toBe(ctx.ownReplica);
});
