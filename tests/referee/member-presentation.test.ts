// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A hosted owner's member copy gets actionable membership remedies and truthful peer labels.
// ABOUTME: Real shared stores also protect quiet pristine upload status and meaningful past debt.
import { ProjectGraphRegistry } from '../../src/intelligence/project-graph-registry';
import {
  inviteMember,
  listMembers,
  removeMember,
  setMemberRole,
} from '../../src/tools/rbook/record-membership';
import { forgetRoute, noteRemoval, rememberPeer } from '../../src/tools/rbook/record-peers';
import { rbookReviewPresentation } from '../../src/tools/rbook/review-presentation';
import type { RbookToolResult } from '../../src/tools/rbook/types';
import { hostProject, joinThroughReferee } from '../helpers/referee-fixture';
import { call, replicaFixture, useMachine, type ReplicaFixture } from '../helpers/replica-fixture';
import { joinedCopy, onCopy, ownerCopy, type Copy } from '../helpers/shared-copies';

let fixture: ReplicaFixture;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  fixture = replicaFixture('rbook-member-presentation-');
  saved = Object.fromEntries(
    ['RBOOK_SHARED_SYNC', 'RBOOK_CHECKPOINT_SYNC'].map((key) => [key, process.env[key]])
  );
  process.env.RBOOK_SHARED_SYNC = 'off';
  process.env.RBOOK_CHECKPOINT_SYNC = 'off';
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  fixture.restore();
});
const route = {
  kind: 'dashboard' as const,
  url: 'https://sharing.example.test',
  projectId: 'dashboard-id',
};
const label = 'the dashboard (sharing.example.test)';
async function tool(
  copy: Copy,
  name: string,
  args = {}
): Promise<RbookToolResult<Record<string, unknown>>> {
  useMachine(fixture.tmp, copy.machine);
  return call(name, { ...args, projectRoot: copy.root });
}

it('owner-member and editor copies point invite, role and removal to the dashboard owner sharing page without writes', async () => {
  const hosted = await hostProject(fixture.tmp);
  const member = await joinThroughReferee(fixture.tmp, hosted, 'Darryl', 'acct-darryl');
  for (const copy of [hosted.owner, member]) {
    await onCopy(fixture.tmp, copy, (client) =>
      rememberPeer(client, hosted.refereeReplica, { route })
    );
    const before = await onCopy(fixture.tmp, copy, listMembers);
    const results = [
      await tool(copy, 'rbook_project', { action: 'invite', name: 'Erin' }),
      await onCopy(fixture.tmp, copy, (client) => setMemberRole(client, 'Darryl', 'owner')),
      await tool(copy, 'rbook_project', { action: 'remove', name: 'Darryl' }),
    ];
    for (const result of results) {
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('RECORD_WRITE_REFUSED');
      expect(result.error?.suggestion).toMatch(/owner.*sharing page/i);
      expect(`${result.error?.message} ${result.error?.suggestion}`).toContain(label);
      expect(result.error?.suggestion).not.toContain("from the owner's copy");
    }
    expect(await onCopy(fixture.tmp, copy, listMembers)).toEqual(before);
  }
});

it('preserves direct-owner membership changes and the direct-member owner-copy remedy', async () => {
  const owner = await ownerCopy(fixture.tmp);
  const member = await joinedCopy(fixture.tmp, owner, 'Darryl');
  for (const change of [
    (client: Parameters<typeof inviteMember>[0]) => inviteMember(client, { name: 'Erin' }),
    (client: Parameters<typeof inviteMember>[0]) => setMemberRole(client, 'Darryl', 'owner'),
    (client: Parameters<typeof inviteMember>[0]) => removeMember(client, 'Darryl'),
  ]) {
    const refused = await onCopy(fixture.tmp, member, change);
    expect(refused.error?.suggestion).toContain("from the owner's copy");
    expect((await onCopy(fixture.tmp, owner, change)).success).toBe(true);
  }
});

it('status and review keep the dashboard name for active, ended and legacy removed routes', async () => {
  const hosted = await hostProject(fixture.tmp);
  const copy = hosted.owner;
  for (const ended of [false, true]) {
    await onCopy(fixture.tmp, copy, (client) => {
      rememberPeer(client, hosted.refereeReplica, {
        route: { ...route, ...(ended ? { ended: true } : {}) },
      });
      if (ended) noteRemoval(client, hosted.refereeReplica, true);
    });
    const status = await tool(copy, 'rbook_status');
    expect(status.data?.shared_sync).toEqual([expect.objectContaining({ peer: label })]);
    const review = await tool(copy, 'rbook_review');
    expect(review.data?.sharedRecord).toContain(label);
  }
  await onCopy(fixture.tmp, copy, (client) => forgetRoute(client, hosted.refereeReplica, label));
  const status = await tool(copy, 'rbook_status');
  expect(status.data?.shared_sync).toEqual([
    expect.objectContaining({ peer: label, removed_at: expect.any(String) }),
  ]);
});

it('a real joined member has no pristine upload warning, while meaningful past debt remains visible', async () => {
  const hosted = await hostProject(fixture.tmp);
  const member = await joinThroughReferee(fixture.tmp, hosted, 'Darryl', 'acct-darryl');
  useMachine(fixture.tmp, member.machine);
  const graph = await ProjectGraphRegistry.create();
  // The direct library fixture does not run the client's join-registration step (#725(3)).
  // Register its real copy explicitly so absence of a registry row cannot make this pass.
  graph.registerStore(member.root, { requireStoredIdentity: true });
  const id = graph.getByStorePath(member.root);
  expect(id).toBeTruthy();
  for (const name of ['rbook_status', 'rbook_review']) {
    const result = await tool(member, name);
    expect(result.success).toBe(true);
    expect(JSON.stringify(result.warnings ?? [])).not.toContain('Dashboard upload:');
  }
  const pristineReview = await rbookReviewPresentation({ projectRoot: member.root });
  expect(pristineReview.result.success).toBe(true);
  expect(pristineReview.text).not.toContain('Dashboard upload:');
  useMachine(fixture.tmp, member.machine);
  // The digest surfaces pending debt after thirty minutes; status always reports it.
  expect((await ProjectGraphRegistry.create()).markUploadOwed(id!, Date.now() - 31 * 60_000)).toBe(
    true
  );
  const status = await tool(member, 'rbook_status');
  expect(status.success).toBe(true);
  expect((status.warnings ?? []).join(' ')).toMatch(/Dashboard upload:.*pending/);
  const review = await rbookReviewPresentation({ projectRoot: member.root });
  expect(review.result.success).toBe(true);
  expect(review.text).toMatch(/Dashboard upload:.*pending/);
  expect(review.text.match(/Dashboard upload:/g)).toHaveLength(1);
  expect(JSON.stringify(review.result.warnings ?? [])).not.toContain('Dashboard upload:');
});
