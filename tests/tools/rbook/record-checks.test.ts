// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m12 (ADR s96 §5) — the cross-record checks find what two copies made together and neither made alone,
// ABOUTME: each on a constructed case and never on its near-miss, and every copy finds the same ones.
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { writeUserAuthor } from '../../../src/intelligence/user-author';
import { crossRecordFindings } from '../../../src/tools/rbook/record-checks';
import { shareRecord } from '../../../src/tools/rbook/record-share';
import { prepareForSharing } from '../../../src/tools/rbook/sharing-preconditions';
import {
  call,
  project,
  replicaFixture,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import {
  exchange,
  memberCopy,
  onCopy,
  ownerCopy,
  read,
  sync,
  type Copy,
} from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
beforeEach(() => {
  fixture = replicaFixture('rbook-checks-');
});
afterEach(() => fixture.restore());

async function ok(copy: Copy, tool: string, args: Record<string, unknown>) {
  useMachine(fixture.tmp, copy.machine);
  const answer = await call(tool, { ...args, projectRoot: copy.root });
  if (!answer.success) throw new Error(`${copy.name} ${tool}: ${JSON.stringify(answer.error)}`);
  return answer;
}

async function decide(copy: Copy, content: string, extra: Record<string, unknown> = {}) {
  const made = await ok(copy, 'rbook_decisions', { action: 'record', content, ...extra });
  return made.data!.decisionId!;
}

/** Deliver everything both ways, twice, so each copy holds the other's changes and the verdicts. */
async function deliver(owner: Copy, member: Copy): Promise<void> {
  await exchange(fixture.tmp, owner, member);
  await exchange(fixture.tmp, owner, member);
}

const findings = (copy: Copy) => onCopy(fixture.tmp, copy, (client) => crossRecordFindings(client));

/** The checks both copies find, which must be the same on each. */
async function found(owner: Copy, member: Copy) {
  const onOwner = await findings(owner);
  expect(await findings(member)).toEqual(onOwner);
  return onOwner;
}

const checksOf = (list: ReadonlyArray<{ check: string }>) => list.map((finding) => finding.check);

async function twoCopies() {
  const owner = await ownerCopy(fixture.tmp);
  const member = await memberCopy(fixture.tmp, owner, 'member', 1);
  return { owner, member };
}

describe('two open sprints', () => {
  it('fires when two copies each open a sprint, neither seeing the other', async () => {
    const { owner, member } = await twoCopies();
    await ok(owner, 'rbook_sprint', {
      action: 'add',
      sprintId: 'o-sprint',
      title: 'O',
      status: 'Active',
    });
    await ok(member, 'rbook_sprint', {
      action: 'add',
      sprintId: 'm-sprint',
      title: 'M',
      status: 'Active',
    });
    await sync(fixture.tmp, member, owner);
    const report = await sync(fixture.tmp, owner, member);
    expect(report.checks).toBe(1);
    expect(await found(owner, member)).toEqual([
      expect.objectContaining({ check: 'two_open_sprints', subject: 'm-sprint,o-sprint' }),
    ]);
  }, 60000);

  it('stays silent when the second copy opened its sprint after seeing the first', async () => {
    const { owner, member } = await twoCopies();
    await ok(owner, 'rbook_sprint', {
      action: 'add',
      sprintId: 'o-sprint',
      title: 'O',
      status: 'Active',
    });
    await deliver(owner, member);
    // Opening a sprint on a copy that sees another open one plans the other (s77-m01).
    await ok(member, 'rbook_sprint', {
      action: 'add',
      sprintId: 'm-sprint',
      title: 'M',
      status: 'Active',
    });
    await deliver(owner, member);
    expect(read(owner, "SELECT id FROM sprints WHERE status = 'Active'")).toEqual([
      { id: 'm-sprint' },
    ]);
    expect(await found(owner, member)).toEqual([]);
  }, 60000);
});

describe('a lineage fork', () => {
  it('fires when two copies each supersede one decision', async () => {
    const { owner, member } = await twoCopies();
    const old = await decide(owner, 'The first way.');
    await deliver(owner, member);
    const ours = await decide(owner, 'The owner replaces it.', { supersedes: [old] });
    const theirs = await decide(member, 'The member replaces it.', { supersedes: [old] });
    await deliver(owner, member);
    const fork = (await found(owner, member)).filter((finding) => finding.check === 'lineage_fork');
    expect(fork).toEqual([expect.objectContaining({ subject: String(old) })]);
    expect(fork[0].detail).toContain(`${ours}`);
    expect(fork[0].detail).toContain(`${theirs}`);
    expect(fork[0].detail).toMatch(/only the owner's copy settles it/);
  }, 60000);

  it('stays silent on a chain, where the second copy superseded the first one’s successor', async () => {
    const { owner, member } = await twoCopies();
    const old = await decide(owner, 'The first way.');
    await deliver(owner, member);
    const next = await decide(owner, 'The owner replaces it.', { supersedes: [old] });
    await deliver(owner, member);
    await decide(member, 'The member replaces that.', { supersedes: [next] });
    await deliver(owner, member);
    expect(await found(owner, member)).toEqual([]);
  }, 60000);
});

describe('a supersession cycle', () => {
  it('fires when two copies each point one decision at the other', async () => {
    const { owner, member } = await twoCopies();
    const a = await decide(owner, 'Choice A.');
    const b = await decide(owner, 'Choice B.');
    await deliver(owner, member);
    await ok(owner, 'rbook_decisions', { action: 'update', decisionId: a, supersededBy: b });
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: b, supersededBy: a });
    await deliver(owner, member);
    expect(await found(owner, member)).toEqual([
      expect.objectContaining({ check: 'supersession_cycle', subject: `${a},${b}` }),
    ]);
  }, 60000);

  it('stays silent on a chain the two copies made together', async () => {
    const { owner, member } = await twoCopies();
    const a = await decide(owner, 'Choice A.');
    const b = await decide(owner, 'Choice B.');
    const c = await decide(owner, 'Choice C.');
    await deliver(owner, member);
    await ok(owner, 'rbook_decisions', { action: 'update', decisionId: a, supersededBy: b });
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: b, supersededBy: c });
    await deliver(owner, member);
    expect(await found(owner, member)).toEqual([]);
  }, 60000);
});

describe('a mission both completed and dropped', () => {
  async function started() {
    const copies = await twoCopies();
    await ok(copies.owner, 'rbook_mission', {
      action: 'add',
      missionId: 'y-m01',
      name: 'Contested',
    });
    await ok(copies.owner, 'rbook_mission_transition', { action: 'start', missionId: 'y-m01' });
    await deliver(copies.owner, copies.member);
    return copies;
  }

  it('fires when one copy completes it and the other drops it', async () => {
    const { owner, member } = await started();
    await ok(owner, 'rbook_mission_transition', {
      action: 'complete',
      missionId: 'y-m01',
      notes: 'Done.',
    });
    await ok(member, 'rbook_mission_transition', {
      action: 'drop',
      missionId: 'y-m01',
      reason: 'Not needed.',
    });
    await deliver(owner, member);
    expect(checksOf(await found(owner, member))).toEqual(['mission_completed_and_dropped']);
  }, 60000);

  it('stays silent when the other copy blocked it instead: a conflict, not this state', async () => {
    const { owner, member } = await started();
    await ok(owner, 'rbook_mission_transition', {
      action: 'complete',
      missionId: 'y-m01',
      notes: 'Done.',
    });
    await ok(member, 'rbook_mission_transition', {
      action: 'block',
      missionId: 'y-m01',
      reason: 'Waiting.',
      blockers: ['a review'],
    });
    await deliver(owner, member);
    expect(
      read(owner, "SELECT field FROM record_conflicts WHERE entity = 'missions'")
    ).toContainEqual({
      field: 'status',
    });
    expect(await found(owner, member)).toEqual([]);
  }, 60000);
});

describe('a next step both completed and carried', () => {
  async function stepped() {
    const copies = await twoCopies();
    for (const sprintId of ['n-sprint-1', 'n-sprint-2'])
      await ok(copies.owner, 'rbook_sprint', {
        action: 'add',
        sprintId,
        title: sprintId,
        status: 'Planned',
      });
    await ok(copies.owner, 'rbook_session', {
      action: 'capture',
      category: 'next-step',
      content: 'A step.',
    });
    await ok(copies.owner, 'rbook_session', { action: 'complete', summary: 'Closed.' });
    await deliver(copies.owner, copies.member);
    const [step] = read<{ id: number }>(copies.owner, 'SELECT id FROM next_steps ORDER BY id');
    return { ...copies, step: step.id };
  }
  const carry = (copy: Copy, step: number, to: string) =>
    ok(copy, 'rbook_context', {
      action: 'next_steps',
      nextStepAction: 'carry',
      nextStepIds: [step],
      carryToSprint: to,
    });

  it('fires when one copy completes it and the other carries it', async () => {
    const { owner, member, step } = await stepped();
    await ok(owner, 'rbook_context', {
      action: 'next_steps',
      nextStepAction: 'complete',
      nextStepIds: [step],
    });
    await carry(member, step, 'n-sprint-1');
    await deliver(owner, member);
    expect(await found(owner, member)).toEqual([
      expect.objectContaining({ check: 'next_step_completed_and_carried', subject: String(step) }),
    ]);
  }, 60000);

  it('stays silent when both carry it, to different sprints', async () => {
    const { owner, member, step } = await stepped();
    await carry(owner, step, 'n-sprint-1');
    await carry(member, step, 'n-sprint-2');
    await deliver(owner, member);
    expect(await found(owner, member)).toEqual([]);
  }, 60000);
});

describe('a closed sprint and the work another copy put in it', () => {
  /** A sprint whose one mission is done, on the owner's copy and a member's. */
  async function sprintReady() {
    const owner = await ownerCopy(fixture.tmp);
    await ok(owner, 'rbook_sprint', {
      action: 'add',
      sprintId: 'x-sprint',
      title: 'X',
      status: 'Active',
    });
    await ok(owner, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m01',
      name: 'Done',
      sprintId: 'x-sprint',
    });
    await ok(owner, 'rbook_mission_transition', { action: 'start', missionId: 'x-m01' });
    await ok(owner, 'rbook_mission_transition', {
      action: 'complete',
      missionId: 'x-m01',
      notes: 'Done.',
    });
    // The owner's own choice in the sprint, which an archiving close archives, so it leaves a mark.
    const ownChoice = await decide(owner, 'The owner chose in the sprint.', { missionId: 'x-m01' });
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await deliver(owner, member);
    return { owner, member, ownChoice };
  }
  const close = (owner: Copy, archive: boolean) =>
    ok(owner, 'rbook_sprint', {
      action: 'complete',
      sprintId: 'x-sprint',
      summary: 'Closed.',
      archive,
    });
  const memberDecides = (member: Copy) =>
    decide(member, 'A choice made in the sprint.', { missionId: 'x-m01' });

  it("fires on an active decision a peer's archiving close had not seen", async () => {
    const { owner, member, ownChoice } = await sprintReady();
    const made = await memberDecides(member);
    await close(owner, true);
    await deliver(owner, member);
    expect(
      read(member, 'SELECT status FROM strategic_decisions WHERE id = ?', [ownChoice])
    ).toEqual([{ status: 'archived' }]);
    const left = await found(owner, member);
    expect(left).toEqual([
      expect.objectContaining({ check: 'active_decisions_in_closed_sprint', subject: 'x-sprint' }),
    ]);
    expect(left[0].detail).toContain(`${made}`);
  }, 120000);

  it('stays silent when the close had seen the decision, and archived it', async () => {
    const { owner, member } = await sprintReady();
    const made = await memberDecides(member);
    await deliver(owner, member);
    await close(owner, true);
    await deliver(owner, member);
    expect(read(member, 'SELECT status FROM strategic_decisions WHERE id = ?', [made])).toEqual([
      { status: 'archived' },
    ]);
    expect(await found(owner, member)).toEqual([]);
  }, 120000);

  it('stays silent when the close archived nothing: active decisions in a closed sprint are normal', async () => {
    const { owner, member } = await sprintReady();
    await memberDecides(member);
    await close(owner, false);
    await deliver(owner, member);
    expect(await found(owner, member)).toEqual([]);
  }, 120000);

  it('stays silent on a decision a member made in the closed sprint after it saw the close', async () => {
    const { owner, member } = await sprintReady();
    await close(owner, true);
    await deliver(owner, member);
    await memberDecides(member);
    await deliver(owner, member);
    expect(await found(owner, member)).toEqual([]);
  }, 120000);

  it('stays silent on a decision the close saw stale, which a member made active again after it saw the close', async () => {
    const { owner, member } = await sprintReady();
    const made = await memberDecides(member);
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: made, status: 'stale' });
    await deliver(owner, member);
    await close(owner, true);
    await deliver(owner, member);
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: made, status: 'active' });
    await deliver(owner, member);
    expect(read(owner, 'SELECT status FROM strategic_decisions WHERE id = ?', [made])).toEqual([
      { status: 'active' },
    ]);
    expect(await found(owner, member)).toEqual([]);
  }, 120000);

  it('fires on a decision the close saw stale, which a member made active again before the close reached it', async () => {
    const { owner, member } = await sprintReady();
    // The owner's own decision: only the member's change to it is one the close had not seen.
    const made = await decide(owner, 'A choice that went stale.', { missionId: 'x-m01' });
    await ok(owner, 'rbook_decisions', { action: 'update', decisionId: made, status: 'stale' });
    await deliver(owner, member);
    await ok(member, 'rbook_decisions', { action: 'update', decisionId: made, status: 'active' });
    await close(owner, true);
    await deliver(owner, member);
    expect(read(owner, 'SELECT status FROM strategic_decisions WHERE id = ?', [made])).toEqual([
      { status: 'active' },
    ]);
    const left = await found(owner, member);
    expect(left).toEqual([
      expect.objectContaining({ check: 'active_decisions_in_closed_sprint', subject: 'x-sprint' }),
    ]);
    expect(left[0].detail).toContain(`${made}`);
  }, 120000);

  it("fires on the owner's decision whose mission a member moved into the sprint before the close reached it", async () => {
    const { owner, member } = await sprintReady();
    await ok(owner, 'rbook_sprint', {
      action: 'add',
      sprintId: 'y-sprint',
      title: 'Y',
      status: 'Planned',
    });
    await ok(owner, 'rbook_mission', {
      action: 'add',
      missionId: 'y-m01',
      name: 'Elsewhere',
      sprintId: 'y-sprint',
    });
    const made = await decide(owner, 'A choice in another sprint.', { missionId: 'y-m01' });
    await deliver(owner, member);
    await ok(member, 'rbook_mission', {
      action: 'move',
      missionId: 'y-m01',
      toSprintId: 'x-sprint',
      reason: 'Belongs with X.',
    });
    await close(owner, true);
    await deliver(owner, member);
    expect(read(owner, 'SELECT status FROM strategic_decisions WHERE id = ?', [made])).toEqual([
      { status: 'active' },
    ]);
    const left = (await found(owner, member)).filter(
      (finding) => finding.check === 'active_decisions_in_closed_sprint'
    );
    expect(left).toEqual([expect.objectContaining({ subject: 'x-sprint' })]);
    expect(left[0].detail).toContain(`${made}`);
  }, 120000);

  it('fires on a baseline decision whose mission a member moved into the sprint before the close reached it', async () => {
    // All of it exists before sharing, so the log holds no create of the decision or its mission.
    const before: Copy = {
      name: 'owner',
      root: project(fixture.tmp, 'owner'),
      machine: 'machine-owner',
      replicaId: '',
      block: 0,
    };
    useMachine(fixture.tmp, before.machine);
    writeUserAuthor('Owner');
    for (const [sprintId, status] of [
      ['x-sprint', 'Active'],
      ['y-sprint', 'Planned'],
    ])
      await ok(before, 'rbook_sprint', { action: 'add', sprintId, title: sprintId, status });
    await ok(before, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m01',
      name: 'Done',
      sprintId: 'x-sprint',
    });
    await ok(before, 'rbook_mission_transition', { action: 'start', missionId: 'x-m01' });
    await ok(before, 'rbook_mission_transition', {
      action: 'complete',
      missionId: 'x-m01',
      notes: 'Done.',
    });
    await ok(before, 'rbook_mission', {
      action: 'add',
      missionId: 'y-m01',
      name: 'Elsewhere',
      sprintId: 'y-sprint',
    });
    await decide(before, 'The owner chose in the sprint.', { missionId: 'x-m01' });
    const made = await decide(before, 'A choice in another sprint.', { missionId: 'y-m01' });
    const replicaId = await onCopy(
      fixture.tmp,
      before,
      (client) => {
        const readiness = prepareForSharing(client);
        if (!readiness.ready) throw new Error(readiness.problems.join(' '));
        return shareRecord(client).replicaId;
      },
      { replicaCheck: false }
    );
    const owner: Copy = { ...before, replicaId };
    const member = await memberCopy(fixture.tmp, owner, 'member', 1);
    await deliver(owner, member);
    expect(
      read(owner, "SELECT count(*) AS n FROM record_changes WHERE kind = 'create'", [])
    ).toEqual([{ n: 0 }]);
    await ok(member, 'rbook_mission', {
      action: 'move',
      missionId: 'y-m01',
      toSprintId: 'x-sprint',
      reason: 'Belongs with X.',
    });
    await close(owner, true);
    await deliver(owner, member);
    const left = (await found(owner, member)).filter(
      (finding) => finding.check === 'active_decisions_in_closed_sprint'
    );
    expect(left).toEqual([expect.objectContaining({ subject: 'x-sprint' })]);
    expect(left[0].detail).toContain(`${made}`);
  }, 120000);

  it('stays silent on a decision tied to the sprint by a session the member started before the close', async () => {
    const { owner, member } = await sprintReady();
    await ok(member, 'rbook_session', {
      action: 'start',
      type: 'planning',
      title: 'Open while the sprint was',
      sprintId: 'x-sprint',
    });
    await close(owner, true);
    await deliver(owner, member);
    // Names no mission or sprint: the session ties it to the closed sprint.
    await ok(member, 'rbook_session', {
      action: 'capture',
      category: 'decision',
      content: 'A choice made after the close was seen.',
    });
    await deliver(owner, member);
    expect(await found(owner, member)).toEqual([]);
  }, 120000);

  it("fires on a mission a peer added while the owner's copy closed the sprint", async () => {
    const { owner, member } = await sprintReady();
    await ok(member, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m02',
      name: 'Late',
      sprintId: 'x-sprint',
    });
    await close(owner, false);
    await deliver(owner, member);
    expect(await found(owner, member)).toEqual([
      expect.objectContaining({
        check: 'completed_sprint_with_open_missions',
        subject: 'x-sprint',
      }),
    ]);
  }, 120000);

  it('stays silent on a blocked mission, which a close leaves by design', async () => {
    const { owner, member } = await sprintReady();
    await ok(member, 'rbook_mission', {
      action: 'add',
      missionId: 'x-m02',
      name: 'Late',
      sprintId: 'x-sprint',
      status: 'Blocked',
    });
    await close(owner, false);
    await deliver(owner, member);
    expect(await found(owner, member)).toEqual([]);
  }, 120000);
});

describe('where the findings show', () => {
  it('every answer on a shared copy names them, and rbook_db conflicts lists them; a solo store finds none', async () => {
    const { owner, member } = await twoCopies();
    await ok(owner, 'rbook_sprint', {
      action: 'add',
      sprintId: 'o-sprint',
      title: 'O',
      status: 'Active',
    });
    await ok(member, 'rbook_sprint', {
      action: 'add',
      sprintId: 'm-sprint',
      title: 'M',
      status: 'Active',
    });
    await deliver(owner, member);
    const status = await ok(member, 'rbook_mission', { action: 'list' });
    expect(JSON.stringify((status as { warnings?: string[] }).warnings ?? [])).toMatch(
      /1 state\(s\) of this shared record need a person: m-sprint and o-sprint are all open/
    );
    const listed = await ok(owner, 'rbook_db', { action: 'conflicts' });
    expect((listed.data as { checks: unknown[] }).checks).toEqual([
      expect.objectContaining({ check: 'two_open_sprints' }),
    ]);
    // Once a person plans one of them, the next answer says nothing more.
    await ok(owner, 'rbook_sprint', {
      action: 'update',
      sprintId: 'm-sprint',
      fields: { status: 'Planned' },
    });
    const after = await ok(owner, 'rbook_mission', { action: 'list' });
    expect(JSON.stringify(after)).not.toMatch(/need a person/);
    useMachine(fixture.tmp, 'solo-machine');
    const { project } = await import('../../helpers/replica-fixture');
    const solo = project(fixture.tmp, 'solo');
    const soloList = await call('rbook_db', { action: 'conflicts', projectRoot: solo });
    expect((soloList.data as { checks: unknown[] }).checks).toEqual([]);
  }, 60000);
});
