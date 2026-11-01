// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m03 — defer's deferUntil becomes the mission's date when it reads as a future day, and stays a
// ABOUTME: hint otherwise; a later deferral leaves an old date stale; due work reaches review, status and the brief.

import Database from 'better-sqlite3';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { executeMissionProtocolTool } from '../../../src/index';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { rbookMission } from '../../../src/tools/rbook/rbook-mission';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import { utcDay } from '../../../src/tools/rbook/next-step-dates';
import { readDigestV2 } from '../../../src/tools/rbook/digest-v2-store';
import { renderDigestV2 } from '../../../src/tools/rbook/digest-v2';
import { computeSignals, renderBrief } from '../../../src/signals';

const DAY = 86_400_000;
const day = (offset: number) => utcDay(Date.now() + offset * DAY);

/**
 * 4.9.0's defer, copied from src/tools/rbook/rbook-mission-defer.ts:152-158 at v4.9.0: it spreads the
 * existing domain_fields and writes a new deferral, so it leaves any checkAfter in place.
 */
function deferAs490(db: Database.Database, id: string, deferUntil: string | null): void {
  const row = db.prepare('SELECT status, domain_fields FROM missions WHERE id = ?').get(id) as {
    status: string;
    domain_fields: string | null;
  };
  const existing = row.domain_fields ? JSON.parse(row.domain_fields) : {};
  const updated = {
    ...existing,
    deferredReason: null,
    deferredAt: new Date().toISOString(),
    deferUntil,
    deferredFromStatus: row.status,
  };
  db.prepare("UPDATE missions SET status = 'Deferred', domain_fields = ? WHERE id = ?").run(
    JSON.stringify(updated),
    id
  );
}

let project: SeededRbookProject;
let db: Database.Database;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-s108-m03-');
  db = new Database(project.dbPath);
});
afterEach(async () => {
  db.close();
  RbookDetector.resetInstance();
  await project.cleanup();
});
const root = () => project.projectRoot;
async function mission(id: string) {
  const added = await rbookMission({
    action: 'add',
    missionId: id,
    name: `Mission ${id}`,
    projectRoot: root(),
  });
  if (!added.success) throw new Error(JSON.stringify(added.error));
}
async function defer(id: string, deferUntil?: string) {
  const answer = await executeMissionProtocolTool(
    'rbook_mission_transition',
    {
      action: 'defer',
      missionId: id,
      ...(deferUntil === undefined ? {} : { deferUntil }),
      projectRoot: root(),
    },
    {} as never
  );
  return answer.structuredContent as unknown as {
    success: boolean;
    data: { checkAfter: string | null };
  };
}
const fields = (id: string) =>
  JSON.parse(
    (
      db.prepare('SELECT domain_fields FROM missions WHERE id = ?').get(id) as {
        domain_fields: string;
      }
    ).domain_fields
  ) as Record<string, unknown>;
const workDue = () => {
  const read = new Database(project.dbPath, { readonly: true });
  try {
    return computeSignals(read, { now: Date.now(), storePath: project.dbPath, only: ['work_due'] })
      .signals[0];
  } finally {
    read.close();
  }
};

describe('a deferred mission with a date', () => {
  it('stores a future day as checkAfter with its deferral, and keeps anything else a hint', async () => {
    const cases: Array<[string, string, string | null]> = [
      ['d-day', day(20), day(20)],
      ['d-month', day(40).slice(0, 7), `${day(40).slice(0, 7)}-01`],
      ['d-text', 'after sprint 48', null],
      ['d-impossible', '2031-02-30', null],
      ['d-past', day(-2), null],
      ['d-too-far', day(181), null],
    ];
    for (const [id, deferUntil, expected] of cases) {
      await mission(id);
      const answer = await defer(id, deferUntil);
      expect(answer.success).toBe(true);
      const stored = fields(id);
      expect(stored.deferUntil).toBe(deferUntil);
      if (expected && expected > day(0)) {
        expect(answer.data.checkAfter).toBe(expected);
        expect(stored).toMatchObject({
          checkAfter: expected,
          checkAfterDeferredAt: stored.deferredAt,
        });
      } else {
        expect(answer.data.checkAfter).toBeNull();
        expect(stored.checkAfter).toBeUndefined();
      }
    }
  });

  it('is due once its day comes, and reaches review, mission status, the signals and the brief', async () => {
    await mission('d-due');
    await defer('d-due', day(10));
    const step = await rbookSession({
      action: 'capture',
      category: 'next-step',
      content: 'A dated next step',
      checkAfter: day(10),
      projectRoot: root(),
    });
    const stepId = (step.data as { nextStepId: number }).nextStepId;
    // Before the day: neither is due, and nextDueAt names it.
    expect(workDue()).toMatchObject({ count: 0, nextDueAt: `${day(10)}T00:00:00.000Z` });
    // Plant the day as passed, since the tools refuse a past date (the design's round 2's B1).
    const stored = fields('d-due');
    db.prepare('UPDATE missions SET domain_fields = ? WHERE id = ?').run(
      JSON.stringify({ ...stored, checkAfter: day(-1) }),
      'd-due'
    );
    db.prepare('UPDATE next_steps SET resolved_at = ? WHERE id = ?').run(day(-1), stepId);
    expect(workDue()).toMatchObject({
      count: 2,
      ids: expect.arrayContaining(['d-due', `n:${stepId}`]),
    });
    const digest = renderDigestV2(await readDigestV2(root()), {
      projectRoot: root(),
      resolvedBy: 'cwd',
    });
    expect(digest.text).toContain(`1 deferred mission is due: d-due, since ${day(-1)}.`);
    expect(digest.text).toContain(`[due since ${day(-1)}] A dated next step`);
    const status = await rbookMission({ action: 'status', projectRoot: root() });
    expect((status.data as { summary: { nextAction: string } }).summary.nextAction).toContain(
      `Deferred and due: d-due: Mission d-due (since ${day(-1)})`
    );
    const read = new Database(project.dbPath, { readonly: true });
    try {
      const report = computeSignals(read, { now: Date.now(), storePath: project.dbPath });
      const brief = renderBrief([report], { now: Date.now() });
      expect(brief).toMatch(/## Due\n- .*2 items due \(d-due, n:\d+\)/);
    } finally {
      read.close();
    }
  });

  it("leaves an old date stale after a re-defer with free text, an update to Deferred, or 4.9.0's defer", async () => {
    for (const id of ['r-text', 'r-update', 'r-490']) {
      await mission(id);
      await defer(id, day(10));
      const stored = fields(id);
      db.prepare('UPDATE missions SET domain_fields = ? WHERE id = ?').run(
        JSON.stringify({ ...stored, checkAfter: day(-1) }),
        id
      );
    }
    expect(workDue().count).toBe(3);
    // A 4.10.0 re-defer goes through Queued; its unparseable text leaves the old date unpaired.
    for (const id of ['r-text', 'r-update'])
      await rbookMission({
        action: 'update',
        missionId: id,
        fields: { status: 'Queued' },
        projectRoot: root(),
      });
    await defer('r-text', 'when the API ships');
    await rbookMission({
      action: 'update',
      missionId: 'r-update',
      fields: { status: 'Deferred' },
      projectRoot: root(),
    });
    db.prepare("UPDATE missions SET status = 'Queued' WHERE id = 'r-490'").run();
    deferAs490(db, 'r-490', 'later');
    expect(workDue().count).toBe(0);
    for (const id of ['r-text', 'r-update', 'r-490']) expect(fields(id).checkAfter).toBe(day(-1));
  });
});

it('says in the receipt which deferUntil is a date and which only a hint', async () => {
  const text = async (id: string, deferUntil: string) => {
    await mission(id);
    const answer = await executeMissionProtocolTool(
      'rbook_mission_transition',
      { action: 'defer', missionId: id, deferUntil, projectRoot: root() },
      {} as never
    );
    return (answer.content ?? []).map((part) => ('text' in part ? part.text : '')).join('\n');
  };
  expect(await text('t-hint', 'after the review')).toContain(
    `Re-queue when: after the review (a hint: nothing brings the mission back on its own; a day after today, up to 180 days ahead, would; today is ${day(0)} in UTC)`
  );
  expect(await text('t-date', day(12))).toContain(`Due again: ${day(12)}`);
  // A day past the 180-day window is kept as a hint, and says so, rather than being refused.
  expect(await text('t-far', day(200))).toContain(`Re-queue when: ${day(200)} (a hint`);
});

describe('a due Deferred mission in the digest', () => {
  const openWork = (text: string) =>
    text.split('\n\n').find((part) => part.startsWith('Open work:')) ?? '';
  async function dueMission(id: string, name?: string) {
    if (name) {
      const added = await rbookMission({ action: 'add', missionId: id, name, projectRoot: root() });
      if (!added.success) throw new Error(JSON.stringify(added.error));
    } else await mission(id);
    await defer(id, day(10));
    db.prepare('UPDATE missions SET domain_fields = ? WHERE id = ?').run(
      JSON.stringify({ ...fields(id), checkAfter: day(-1) }),
      id
    );
  }
  async function steps(count: number, long = false) {
    for (let index = 0; index < count; index++) {
      const content = `Step ${index}: ${long ? 'a long next step that runs on with no full stop '.repeat(6) : 'short'}`;
      const added = await rbookSession({
        action: 'capture',
        category: 'next-step',
        content,
        projectRoot: root(),
      });
      if (!added.success) throw new Error(JSON.stringify(added.error));
    }
  }

  /** An Active sprint holding a mission In Progress, which the Builder digest's first line names. */
  async function missionInProgress() {
    const sprint = await rbookSprint({
      action: 'add',
      sprintId: 's-now',
      title: 'Now',
      status: 'Active',
      projectRoot: root(),
    });
    if (!sprint.success) throw new Error(JSON.stringify(sprint.error));
    const added = await rbookMission({
      action: 'add',
      missionId: 'm-now',
      name: 'Dates on deferred missions, and work that is due',
      sprintId: 's-now',
      status: 'In Progress',
      projectRoot: root(),
    });
    if (!added.success) throw new Error(JSON.stringify(added.error));
  }
  const digestOpenWork = async () =>
    openWork(
      renderDigestV2(await readDigestV2(root()), { projectRoot: root(), resolvedBy: 'cwd' }).text
    );

  /** Open work as rendered, and as it renders with no due missions, which is m02's rendering. */
  async function openWorkBothWays() {
    const model = await readDigestV2(root());
    const render = (rendered: typeof model) =>
      openWork(renderDigestV2(rendered, { projectRoot: root(), resolvedBy: 'cwd' }).text);
    return { withDue: render(model), without: render({ ...model, dueMissions: undefined }) };
  }
  async function waitingStep() {
    const waiting = await rbookSession({
      action: 'capture',
      category: 'next-step',
      content: 'Waits for its day',
      checkAfter: day(9),
      projectRoot: root(),
    });
    expect(waiting.success).toBe(true);
  }

  it('counts the due ones on a line of their own and names the earliest', async () => {
    await dueMission('b-due-1');
    await dueMission('b-due-2');
    await steps(3);
    const text = await digestOpenWork();
    expect(text).toContain(`  2 deferred missions are due; the first, b-due-1, since ${day(-1)}.`);
    expect(text).toContain('Next steps (3 of 3):');
    expect(text.length).toBeLessThanOrEqual(400);
  });

  // The fresh critics' cases: due rows measured before the mission's line could leave it no room,
  // and a mission framed as another project's text needs 44 to 52 characters more.
  it.each([
    ['this project', 'cmos-mcp-pro-local', 3],
    ['another project', 'acme-corp-tools', 2],
    ['an unattributed row', 'unknown-project', 2],
  ])('keeps the mission line m02 gave it, for a mission from %s', async (_label, owner, count) => {
    await missionInProgress();
    if (owner !== 'cmos-mcp-pro-local')
      db.prepare('UPDATE missions SET project_id = ? WHERE id = ?').run(owner, 'm-now');
    const long = 'with-an-id-that-runs-on-well-past-fifty-five-characters-of-id';
    await dueMission(`first-${long}`);
    await dueMission(`second-${long}`);
    await steps(count, true);
    await waitingStep();
    const { withDue, without } = await openWorkBothWays();
    expect(without.split('\n')[1]).toContain('m-now');
    expect(withDue.split('\n')[1]).toBe(without.split('\n')[1]);
    expect(withDue).toContain(`  2 deferred missions are due; the first, first-with-an-id`);
    expect(withDue).toContain(`since ${day(-1)}.`);
    expect(withDue).toContain('1 more next step waits until a date.');
    expect(withDue.length).toBeLessThanOrEqual(400);
  });

  it('lists a Builder mission, then the due line, when there are no next steps', async () => {
    await missionInProgress();
    for (const id of ['n-due-1', 'n-due-2', 'n-due-3', 'n-due-4', 'n-due-5']) await dueMission(id);
    const lines = (await digestOpenWork()).split('\n');
    expect(lines[1]).toContain('m-now [In Progress]');
    expect(lines[2]).toBe(`  5 deferred missions are due; the first, n-due-1, since ${day(-1)}.`);
    expect(lines).toHaveLength(3);
  });

  it('keeps every Planner row, with the due and waiting lines, inside 400 characters', async () => {
    db.close();
    await project.cleanup();
    project = await createSeededRbookProject({ tier: 'managed' }, 'rbook-s108-m03-planner-');
    db = new Database(project.dbPath);
    await dueMission(`p-due-${'x'.repeat(64)}`);
    await steps(5, true);
    await waitingStep();
    const lines = (await digestOpenWork()).split('\n');
    // No count heading: the five rows are what Ledger and Planner always list.
    expect(lines[0]).toBe('Open work:');
    expect(lines.filter((line) => line.includes('Step '))).toHaveLength(5);
    // The waiting line follows the steps it adds to; then the due line, a Planner's naming a task
    // by its name, cut, never its count or day.
    expect(lines[6]).toBe('  1 more next step waits until a date.');
    expect(lines[7]).toMatch(
      new RegExp(`^  1 deferred task is due: Mission p-due-x+…, since ${day(-1)}\\.$`)
    );
    expect(lines.join('\n').length).toBeLessThanOrEqual(400);
  });

  it('shows no due line to a Ledger, which keeps no missions', async () => {
    db.close();
    await project.cleanup();
    project = await createSeededRbookProject({ tier: 'general' }, 'rbook-s108-m03-ledger-');
    db = new Database(project.dbPath);
    await dueMission('l-due');
    await steps(2);
    const text = await digestOpenWork();
    expect(text).toContain('Step 0');
    expect(text).not.toMatch(/deferred|l-due/);
  });

  // The third critic round's cases: the give-way loop could drop every next step, and the refit
  // that then shrinks the mission's line had no committed test.
  it('keeps one next step, its heading and the mission line when a long mission crowds the section', async () => {
    await missionInProgress();
    db.prepare(
      "UPDATE missions SET project_id = 'unknown-project', name = ? WHERE id = 'm-now'"
    ).run(`In progress ${'with a name that runs on and on '.repeat(5)}`);
    // Two due missions with a long first id and two long steps: the steps must give way, and the
    // last one stays.
    await dueMission(`v-due-${'with-a-long-id-'.repeat(3)}`);
    await dueMission('v-due-2');
    await steps(2, true);
    await waitingStep();
    const text = await digestOpenWork();
    expect(text).toContain('Next steps (1 of 2):');
    // The newest step ranks first and stays; the due tie is broken by id.
    expect(text).toContain('Step 1: a long next step');
    expect(text.split('\n')[1]).toContain('m-now');
    expect(text).toContain(`  2 deferred missions are due; the first, v-due-2, since ${day(-1)}.`);
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it('keeps the step line when no mission line could take its place', () => {
    // The fourth critic round's case: a framed mission whose id is so long that neither m02's line
    // nor a refit fits beside the closing lines; dropping the step would leave neither line.
    const model = {
      project: { name: 'P', level: 'builder' },
      localProjectId: 'local',
      sprint: null,
      profile: null,
      stepUp: null,
      rules: [],
      decisions: { rows: [], total: 0 },
      learnings: { rows: [], total: 0 },
      drafts: [],
      shared: null,
      work: [{ id: 'm'.repeat(120), text: '[In Progress] Short.', projectId: 'f'.repeat(36) }],
      nextSteps: { rows: [{ id: 'n:1', text: 'Do it.', projectId: 'local' }], total: 1 },
      waitingSteps: 99999,
      dueMissions: { count: 99999, first: 'y'.repeat(48), name: 'y', since: day(-1) },
    } as unknown as Parameters<typeof renderDigestV2>[0];
    const text = openWork(renderDigestV2(model, { projectRoot: root(), resolvedBy: 'cwd' }).text);
    expect(text).toContain('Next steps (1 of 1):\n  • n:1 Do it.');
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it('brings the steps back when no mission line can fit at all', () => {
    // The fifth verification round's case: a project id so long that no mission line fits; the
    // steps given way for it come back, rather than leaving one.
    const model = {
      project: { name: 'P', level: 'builder' },
      localProjectId: 'local',
      sprint: null,
      profile: null,
      stepUp: null,
      rules: [],
      decisions: { rows: [], total: 0 },
      learnings: { rows: [], total: 0 },
      drafts: [],
      shared: null,
      work: [{ id: 'm', text: '[In Progress] Short.', projectId: 'f'.repeat(200) }],
      nextSteps: {
        rows: [
          { id: 'n:1', text: 'Do it.', projectId: 'local' },
          { id: 'n:2', text: 'Do it.', projectId: 'local' },
        ],
        total: 2,
      },
      dueMissions: { count: 99999, first: 'y'.repeat(48), name: 'y', since: day(-1) },
    } as unknown as Parameters<typeof renderDigestV2>[0];
    const text = openWork(renderDigestV2(model, { projectRoot: root(), resolvedBy: 'cwd' }).text);
    expect(text).toContain('Next steps (2 of 2):\n  • n:1 Do it.\n  • n:2 Do it.');
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it('brings back m02’s own mission line when the last step line gives way and it then fits', () => {
    // A mission line too long beside one step and the due line, whose refit beside that step cannot
    // render, but which fits once the step line goes: m02's line, not a longer refit, returns.
    const long = 'a long piece of text that runs on and on with no full stop at all '.repeat(5);
    const base = {
      project: { name: 'P', level: 'builder' },
      localProjectId: 'local',
      sprint: null,
      profile: null,
      stepUp: null,
      rules: [],
      decisions: { rows: [], total: 0 },
      learnings: { rows: [], total: 0 },
      drafts: [],
      shared: null,
      work: [{ id: 'm'.repeat(100), text: `[In Progress] ${long}`, projectId: 'f'.repeat(36) }],
      nextSteps: {
        rows: [{ id: 'n:1', text: `Step 0: ${long}`, projectId: 'local' }],
        total: 99999,
      },
      waitingSteps: 99999,
    } as unknown as Parameters<typeof renderDigestV2>[0];
    const render = (model: typeof base) =>
      openWork(renderDigestV2(model, { projectRoot: root(), resolvedBy: 'cwd' }).text).split('\n');
    const m02 = render(base);
    const lines = render({
      ...base,
      dueMissions: { count: 1, first: 'd1', name: 'd1', since: day(-1) },
    });
    expect(lines[1]).toBe(m02[1]);
    expect(lines[2]).toBe('Next steps (0 of 99999):');
    expect(lines.join('\n').length).toBeLessThanOrEqual(400);
  });

  it('keeps the next-step count when even one step line cannot fit beside the mission', () => {
    // One of the sweep's 32 extremes, built as a model: a long step, a framed mission with a long
    // id, and the longest due and waiting lines. The step line gives way; its heading stays.
    const long = 'a long piece of text that runs on and on with no full stop at all '.repeat(5);
    const model = {
      project: { name: 'P', level: 'builder' },
      localProjectId: 'local',
      sprint: null,
      profile: null,
      stepUp: null,
      rules: [],
      decisions: { rows: [], total: 0 },
      learnings: { rows: [], total: 0 },
      drafts: [],
      shared: null,
      work: [
        {
          id: 'z'.repeat(40),
          text: `[In Progress] ${long}`,
          projectId: 'some-other-project-with-a-long-id',
        },
      ],
      nextSteps: {
        rows: [{ id: 'n:1', text: `Step 0: ${long}`, projectId: 'local' }],
        total: 99999,
      },
      waitingSteps: 99999,
      dueMissions: { count: 99999, first: 'y'.repeat(70), name: 'y', since: day(-1) },
    } as unknown as Parameters<typeof renderDigestV2>[0];
    const text = openWork(renderDigestV2(model, { projectRoot: root(), resolvedBy: 'cwd' }).text);
    const lines = text.split('\n');
    expect(lines[1]).toContain('z'.repeat(40));
    expect(lines[2]).toBe('Next steps (0 of 99999):');
    expect(text).toContain(`since ${day(-1)}.`);
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it('refits the mission line to what the rest leaves when one short step cannot make room', async () => {
    await missionInProgress();
    db.prepare('UPDATE missions SET project_id = ?, name = ? WHERE id = ?').run(
      `another-project-${'with-a-long-id-'.repeat(5)}`,
      `In progress ${'with a name that runs on and on '.repeat(5)}`,
      'm-now'
    );
    await dueMission('r-due-1-with-an-id-of-forty-characters--');
    await dueMission('r-due-2');
    await steps(1);
    await waitingStep();
    const { withDue, without } = await openWorkBothWays();
    const lines = withDue.split('\n');
    expect(lines[1]).toContain('m-now');
    // m02's line no longer fits, so this one is shorter, not lost.
    expect(lines[1].length).toBeLessThan(without.split('\n')[1].length);
    expect(lines[2]).toBe('Next steps (1 of 1):');
    expect(withDue.length).toBeLessThanOrEqual(400);
  });
});

it('names at most three due missions in mission status, and those three not again as parked', async () => {
  const sprint = await rbookSprint({
    action: 'add',
    sprintId: 's-now',
    title: 'Now',
    status: 'Active',
    projectRoot: root(),
  });
  expect(sprint.success).toBe(true);
  for (const [index, id] of ['s-due-1', 's-due-2', 's-due-3', 's-due-4'].entries()) {
    await mission(id);
    await defer(id, day(10));
    db.prepare('UPDATE missions SET domain_fields = ? WHERE id = ?').run(
      JSON.stringify({ ...fields(id), checkAfter: day(-1 - index) }),
      id
    );
  }
  await mission('s-hint');
  await defer('s-hint', 'when the API ships');
  const status = await rbookMission({ action: 'status', projectRoot: root() });
  const next = (status.data as { summary: { nextAction: string } }).summary.nextAction;
  // The earliest first: s-due-4 has been due longest.
  expect(next).toContain(
    `Deferred and due: s-due-4: Mission s-due-4 (since ${day(-4)}); s-due-3: Mission s-due-3 (since ${day(-3)}); s-due-2: Mission s-due-2 (since ${day(-2)}); and 1 more.`
  );
  // The fourth due mission is not named among the three, so the parked notice still names it.
  expect(next).toContain('Parked missions: s-due-1: Mission s-due-1; s-hint: Mission s-hint.');
  expect(next.match(/s-due-1:/g)).toHaveLength(1);
});
