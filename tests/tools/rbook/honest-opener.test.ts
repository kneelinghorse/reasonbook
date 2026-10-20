// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s92-m04 — the opener tells the truth: no onboard-only, whoami or dashboard nags where they
// ABOUTME: do not apply, completion counts recorded decisions, and onboard keeps its documented bound.

/**
 * Each claim is proven against the real handlers on seeded stores, and each "absent" assertion has
 * a positive control beside it: the same nag DOES fire when its condition holds, so an absence is
 * never the vacuous kind (an action that cannot fire at all would also be absent).
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import Database from 'better-sqlite3';

import { executeMissionProtocolTool } from '../../../src/index';
import {
  rbookAgentOnboard,
  rbookAgentOnboardToolDefinition,
  formatAgentOnboardForLLM,
  ONBOARD_SIZE_BOUND_CHARS,
} from '../../../src/tools/rbook/rbook-agent-onboard';
import { rbookDecisions } from '../../../src/tools/rbook/rbook-decisions';
import {
  rbookMissionTransition,
  formatMissionTransitionForLLM,
} from '../../../src/tools/rbook/rbook-mission-transition';
import { rbookReview, formatReviewForLLM } from '../../../src/tools/rbook/rbook-review';
import { PREVIEW_MAX_CHARS } from '../../../src/tools/rbook/text-preview';
import {
  createSeededRbookProject,
  reidentifyRbookTestStore,
  type SeededRbookProject,
} from '../../helpers/seedRbookDb';

const WHOAMI = 'rbook_message(action="whoami")';
// s100-m02: the sign-in remedies agree on login_init, then login_complete.
const LOGIN = 'rbook_auth(action="login_init"), then rbook_auth(action="login_complete")';

const projects: SeededRbookProject[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['RBOOK_DASHBOARD_URL', 'RBOOK_PROJECT_ROOT'] as const;

beforeEach(() => {
  // A local-only user: no dashboard URL chosen, no env-pinned project. The jest setup already
  // strips the dashboard credential env vars and isolates RBOOK_CONFIG_DIR per test file.
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  while (projects.length > 0) await projects.pop()!.cleanup();
});

async function freshProject(): Promise<SeededRbookProject> {
  const project = await createSeededRbookProject({}, 'rbook-s92-m04-fresh-');
  projects.push(project);
  reidentifyRbookTestStore(project.projectRoot);
  return project;
}

const commands = (actions: ReadonlyArray<{ command: string }>): string[] =>
  actions.map((a) => a.command);

describe('s92-m04 — a fresh, local-only project gets an honest review', () => {
  it('leads with the onboard flow and forwards no onboard-only action and no dashboard nag', async () => {
    const { projectRoot } = await freshProject();

    const onboard = await rbookAgentOnboard({ projectRoot, callerProvidedProjectRoot: true });
    expect(onboard.data!.freshProject).toBe(true);
    // The onboard payload keeps its own action: the tierSelectionPrompt it names is right there.
    const onboardOnly = onboard.data!.suggestedActions.filter((a) => a.scope === 'onboard');
    expect(onboardOnly.map((a) => a.command)).toEqual([
      'Follow the tierSelectionPrompt in this payload to start the opening conversation.',
    ]);
    expect(onboard.data!.tierSelectionPrompt).toBeDefined();

    const review = await rbookReview({ projectRoot }, { callerProvidedProjectRoot: true });
    expect(review.success).toBe(true);
    const actions = review.data!.next_actions;
    expect(actions[0]).toEqual({
      action: 'Fresh project: rbook_agent_onboard walks the first-session setup',
      command: 'rbook_agent_onboard()',
      priority: 0,
    });
    const text = formatReviewForLLM(review);
    for (const misleading of ['tierSelectionPrompt', LOGIN, WHOAMI]) {
      expect(commands(actions).join('\n')).not.toContain(misleading);
      expect(text).not.toContain(misleading);
    }
    // No dashboard warning either: the messaging warning used to pass the review's credential filter.
    expect(review.warnings ?? []).toEqual([]);
    expect(text).not.toMatch(/dashboard|credential/i);
  });

  it('POSITIVE CONTROL: once the user opts into the dashboard, the login nag and the warning return', async () => {
    const { projectRoot } = await freshProject();
    process.env.RBOOK_DASHBOARD_URL = 'https://dashboard.example.invalid';

    const onboard = await rbookAgentOnboard({ projectRoot, callerProvidedProjectRoot: true });
    expect(commands(onboard.data!.suggestedActions)).toContain(LOGIN);
    expect(onboard.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('Messaging block omitted')])
    );

    const review = await rbookReview({ projectRoot }, { callerProvidedProjectRoot: true });
    expect(commands(review.data!.next_actions)).toContain(LOGIN);
    expect(review.warnings ?? []).toEqual(
      expect.arrayContaining([expect.stringContaining('no dashboard credential resolved')])
    );
  });
});

describe('s92-m04 — whoami is prescribed only when the project was not named', () => {
  // s93-m11 (#606 a): whoami checks the dashboard's sender identity, so it is prescribed only to a
  // user who has the dashboard in their setup. Every case here opts in, so the negatives below are
  // about naming the project and not about the dashboard.
  beforeEach(() => {
    process.env.RBOOK_DASHBOARD_URL = 'https://dashboard.example.invalid';
  });

  it('a user without the dashboard is never told to run whoami, even with no roots and no name', async () => {
    delete process.env.RBOOK_DASHBOARD_URL;
    const { projectRoot } = await freshProject();
    const onboard = await rbookAgentOnboard({ projectRoot });
    expect(commands(onboard.data!.suggestedActions)).not.toContain(WHOAMI);
    const review = await rbookReview({ projectRoot });
    expect(commands(review.data!.next_actions)).not.toContain(WHOAMI);
  });

  it('POSITIVE CONTROL: no roots and no named project still prescribe whoami', async () => {
    const { projectRoot } = await freshProject();
    const onboard = await rbookAgentOnboard({ projectRoot });
    expect(commands(onboard.data!.suggestedActions)).toContain(WHOAMI);
    // The rendered answers show it too, so the text-only dispatcher test below is not vacuous.
    expect(formatAgentOnboardForLLM(onboard)).toContain(WHOAMI);
    const review = await rbookReview({ projectRoot });
    expect(commands(review.data!.next_actions)).toContain(WHOAMI);
    expect(formatReviewForLLM(review)).toContain(WHOAMI);
  });

  it('a named project, or advertised roots, drop it on onboard and on the review', async () => {
    const { projectRoot } = await freshProject();
    for (const named of [
      { callerProvidedProjectRoot: true },
      { advertisedRoots: [projectRoot] },
    ] as const) {
      const onboard = await rbookAgentOnboard({ projectRoot, ...named });
      expect(commands(onboard.data!.suggestedActions)).not.toContain(WHOAMI);
      const review = await rbookReview({ projectRoot }, named);
      expect(commands(review.data!.next_actions)).not.toContain(WHOAMI);
    }
  });

  it('the dispatcher counts an explicit projectRoot as named, for the review and for onboard', async () => {
    const { projectRoot } = await freshProject();
    for (const tool of ['rbook_review', 'rbook_agent_onboard']) {
      const result = await executeMissionProtocolTool(tool, { projectRoot }, {} as never);
      expect(result.isError).not.toBe(true);
      const text = result.content.map((part) => ('text' in part ? part.text : '')).join('\n');
      expect(text).not.toContain(WHOAMI);
    }
  });
});

describe('s92-m04 — completion counts the decisions the mission recorded', () => {
  async function missionStore(): Promise<SeededRbookProject> {
    const project = await freshProject();
    const db = new Database(project.dbPath);
    try {
      db.prepare(
        `INSERT INTO sprints (id, title, status, start_date) VALUES ('sprint-h', 'H', 'Active', ?)`
      ).run(new Date().toISOString());
      const mission = db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status, started_at) VALUES (?, 'sprint-h', ?, ?, NULL)`
      );
      mission.run('h-record-first', 'Recorded before it started', 'Queued');
      mission.run('h-no-start', 'In Progress with no started_at', 'In Progress');
      mission.run('h-none', 'No decisions at all', 'In Progress');
      mission.run('h-superseded', 'Only a superseded decision', 'In Progress');
    } finally {
      db.close();
    }
    return project;
  }

  async function record(projectRoot: string, missionId: string, content: string): Promise<number> {
    const recorded = await rbookDecisions({ action: 'record', content, missionId, projectRoot });
    expect(recorded.success).toBe(true);
    return (recorded.data as { decisionId: number }).decisionId;
  }

  async function complete(projectRoot: string, missionId: string) {
    const result = await rbookMissionTransition({
      action: 'complete',
      missionId,
      notes: 'done',
      projectRoot,
    });
    expect(result.success).toBe(true);
    return {
      warnings: result.warnings ?? [],
      data: result.data as { decisionCount?: number; missionDecisionCount?: number },
      text: formatMissionTransitionForLLM('complete', result),
    };
  }

  const NO_DECISIONS = 'No decisions captured for this mission';

  it('record, then start, then complete: no warning, and the true count', async () => {
    const { projectRoot } = await missionStore();
    await record(projectRoot, 'h-record-first', 'Keep the opener honest about what applies.');
    await record(projectRoot, 'h-record-first', 'Count recorded decisions with no time window.');
    const started = await rbookMissionTransition({
      action: 'start',
      missionId: 'h-record-first',
      projectRoot,
    });
    expect(started.success).toBe(true);

    const done = await complete(projectRoot, 'h-record-first');
    expect(done.warnings.join('\n')).not.toContain(NO_DECISIONS);
    expect(done.data).toMatchObject({ decisionCount: 0, missionDecisionCount: 2 });
    expect(done.text).toContain('Decisions recorded for this mission: 2');
  });

  it('a mission with no started_at but with recorded decisions completes without the warning', async () => {
    const { projectRoot, dbPath } = await missionStore();
    await record(projectRoot, 'h-no-start', 'Recorded on a mission that never logged a start.');
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare(`SELECT started_at FROM missions WHERE id = 'h-no-start'`).get() as {
        started_at: string | null;
      };
      expect(row.started_at).toBeNull();
    } finally {
      db.close();
    }

    const done = await complete(projectRoot, 'h-no-start');
    expect(done.warnings.join('\n')).not.toContain(NO_DECISIONS);
    expect(done.data.missionDecisionCount).toBe(1);
  });

  it('POSITIVE CONTROL: a mission with nothing recorded, or only superseded rows, still warns', async () => {
    const { projectRoot } = await missionStore();
    const none = await complete(projectRoot, 'h-none');
    expect(none.warnings.join('\n')).toContain(NO_DECISIONS);
    expect(none.data.missionDecisionCount).toBe(0);

    const old = await record(projectRoot, 'h-superseded', 'The first take, later replaced.');
    const replacement = await rbookDecisions({
      action: 'record',
      content: 'The replacement, recorded against another mission.',
      missionId: 'h-none',
      supersedes: [old],
      projectRoot,
    });
    expect(replacement.success).toBe(true);
    const superseded = await complete(projectRoot, 'h-superseded');
    expect(superseded.warnings.join('\n')).toContain(NO_DECISIONS);
    expect(superseded.data.missionDecisionCount).toBe(0);
  });
});

describe('s92-m04 — no automatic supersession offer; explicit supersedes still works', () => {
  it('a near-duplicate decision gets no offer, and supersedes=[id] retires the old row', async () => {
    const { projectRoot, dbPath } = await freshProject();
    const first = await rbookDecisions({
      action: 'record',
      content: 'Use SQLite for persistent storage of capture receipts in the opener tests.',
      projectRoot,
    });
    const firstId = (first.data as { decisionId: number }).decisionId;

    const similar = await rbookDecisions({
      action: 'record',
      content: 'Use PostgreSQL for persistent storage of capture receipts in the opener tests.',
      projectRoot,
    });
    expect(similar.success).toBe(true);
    expect(similar.data).not.toHaveProperty('supersessionCandidates');
    expect(similar.data).not.toHaveProperty('supersessionMessage');

    const correction = await rbookDecisions({
      action: 'record',
      content: 'Use PostgreSQL, replacing the SQLite choice for capture receipts.',
      supersedes: [firstId],
      projectRoot,
    });
    expect(correction.success).toBe(true);
    const correctionId = (correction.data as { decisionId: number }).decisionId;
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(
        db
          .prepare(`SELECT status, superseded_by FROM strategic_decisions WHERE id = ?`)
          .get(firstId)
      ).toEqual({ status: 'superseded', superseded_by: correctionId });
    } finally {
      db.close();
    }
  });
});

describe('s92-m04 — onboard keeps its documented bound; the digest carries learnings', () => {
  const long = (label: string, i: number): string =>
    `${label} ${i}: ${'a long history entry that an opener used to carry in full '.repeat(34)}`;

  /** Every field that grows with history, made long: the raw text alone is far over the bound. */
  async function longHistoryStore(): Promise<{ project: SeededRbookProject; rawChars: number }> {
    const project = await freshProject();
    const db = new Database(project.dbPath);
    let rawChars = 0;
    const count = (text: string): string => {
      rawChars += text.length;
      return text;
    };
    try {
      const now = Date.now();
      const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString();
      db.prepare(
        `INSERT INTO sprints (id, title, status, start_date, focus) VALUES ('sprint-l', 'Long', 'Active', ?, ?)`
      ).run(at(600), 'Prove the opener stays bounded however long the history grows.');
      const mission = db.prepare(
        `INSERT INTO missions (id, sprint_id, name, status) VALUES (?, 'sprint-l', ?, 'Queued')`
      );
      for (let i = 0; i < 12; i += 1) mission.run(`l-m${i}`, `Mission ${i} of the long store`);
      const decision = db.prepare(
        `INSERT INTO strategic_decisions (decision_text, created_at, sprint_id, status) VALUES (?, ?, 'sprint-l', 'active')`
      );
      const learning = db.prepare(
        `INSERT INTO learnings (content, category, created_at, sprint_id, status) VALUES (?, 'process', ?, 'sprint-l', 'active')`
      );
      for (let i = 0; i < 12; i += 1) {
        decision.run(count(long('Decision', i)), at(100 - i));
        learning.run(long('Learning', i), at(100 - i));
      }
      const captures = [] as Array<{ category: string; content: string }>;
      for (let i = 0; i < 30; i += 1) {
        captures.push({ category: 'decision', content: count(long('Session decision', i)) });
        captures.push({ category: 'next-step', content: count(long('Session next-step', i)) });
      }
      db.prepare(
        `INSERT INTO sessions (id, type, title, sprint_id, started_at, completed_at, status, summary, captures)
         VALUES ('PS-LONG-1', 'build', 'A long session', 'sprint-l', ?, ?, 'completed', ?, ?)`
      ).run(at(300), at(200), count(long('Summary', 0).repeat(3)), JSON.stringify(captures));
      const step = db.prepare(
        `INSERT INTO next_steps (content, status, created_at) VALUES (?, 'pending', ?)`
      );
      for (let i = 0; i < 15; i += 1) step.run(count(long('Open item', i)), at(50 + i));
      db.prepare(`UPDATE contexts SET content = ? WHERE id = 'project_context'`).run(
        JSON.stringify({
          working_memory: {
            next_steps: Array.from({ length: 8 }, (_, i) => count(long('Working step', i))),
          },
        })
      );
    } finally {
      db.close();
    }
    return { project, rawChars };
  }

  it(`stays under ${ONBOARD_SIZE_BOUND_CHARS} characters, with previews that keep their ids`, async () => {
    const { project, rawChars } = await longHistoryStore();
    // Non-vacuity: the history this payload summarises is several times the bound.
    expect(rawChars).toBeGreaterThan(4 * ONBOARD_SIZE_BOUND_CHARS);

    const onboard = await rbookAgentOnboard({
      projectRoot: project.projectRoot,
      callerProvidedProjectRoot: true,
    });
    expect(onboard.success).toBe(true);
    const data = onboard.data!;
    const size = JSON.stringify(data).length;
    // eslint-disable-next-line no-console
    console.log(`[s92-m04 onboard] ${size} chars on the long-history fixture`);
    expect(size).toBeLessThanOrEqual(ONBOARD_SIZE_BOUND_CHARS);

    expect(data.recentDecisions.length).toBeGreaterThan(0);
    for (const d of data.recentDecisions) {
      expect(d.decision.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
      expect(d).toMatchObject({ truncated: true, id: expect.any(Number) });
      expect(d.fullLength).toBeGreaterThan(1_900);
    }
    const last = data.lastSession!;
    expect(last.summary!.length).toBeLessThanOrEqual(1_000);
    expect(last.decisions!.length).toBeLessThanOrEqual(5);
    expect(last.decisions![last.decisions!.length - 1]).toContain('Session decision 29');
    for (const text of [...last.decisions!, ...last.nextSteps!, ...last.openItems!]) {
      expect(text.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    }
    for (const step of data.nextSteps) expect(step.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
  }, 60_000);

  it('does not turn a long-history fixture measurement into an unenforced total payload bound', () => {
    const description = rbookAgentOnboardToolDefinition.description;
    expect(description).not.toContain('<4KB');
    expect(description).not.toMatch(/under 28 KB|every field that grows/i);
    expect(description).toContain('no enforced total size cap');
  });

  it('the review digest carries learnings with ids, inside its 4 KB budget, trimmed before decisions', async () => {
    const { project } = await longHistoryStore();
    const review = await rbookReview(
      { projectRoot: project.projectRoot },
      { callerProvidedProjectRoot: true }
    );
    expect(review.success).toBe(true);
    const digest = review.data!;
    expect(digest.digestSizeBytes).toBeLessThanOrEqual(4096);
    expect(digest.recentLearnings.length).toBeGreaterThan(0);
    expect(digest.recentLearnings[0]).toMatchObject({ id: expect.any(Number) });
    expect(digest.recentLearnings[0].text).toContain('Learning 11');
    // Learnings go first when the budget binds: every decision the digest holds survives.
    expect(digest.recentDecisions).toHaveLength(5);
    expect(digest.recentDecisions.every((d) => typeof d.id === 'number')).toBe(true);

    const text = formatReviewForLLM(review);
    expect(text).toContain('Recent learnings:');
    expect(text).toContain(`#${digest.recentLearnings[0].id} Learning 11`);
    expect(text).toContain('rbook_learnings(action="show", learningId=N)');
  }, 60_000);
});
