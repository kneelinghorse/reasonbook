// ABOUTME: s85-m03 real-store positive-fire — a session started with no OPEN sprint must
// ABOUTME: persist sprint_id NULL on the session AND on every row captured through it.

/**
 * Sprint 85 m03 — write-side sprint tagging, proven against a real store.
 *
 * The defect: `resolveCurrentSprintId` re-admits Completed sprints at Steps 5–6 so that a
 * DISPLAY surface can always name a sprint. Both durable write paths went through it, so on a
 * store whose sprints are all Completed every new session — and every decision, learning,
 * constraint and next-step captured in it — was permanently stamped with a dead sprint. This
 * store had 76 sprints and zero open; six planning sessions carry a sprint completed weeks
 * earlier. Independently reported by another project, whose Managed-tier setup has no sprints by
 * design and therefore mislabels every session by construction.
 *
 * WHY A REAL STORE IS MANDATORY HERE (decision #926 #3): the behavior is gated on a QUERY over
 * sprints/missions, and the live store has zero open sprints. A mock-client test asserting
 * "the resolver was called" would pass against a wrong-column or wrong-table SQL bug — exactly
 * how s80-m07 shipped dead on arrival. These tests drive the real handlers through the
 * CONSOLIDATED `rbookSession` router (so `additionalProperties: false` is exercised too) and
 * assert with raw SELECTs.
 *
 * Stores are seeded under `os.tmpdir()`; `real-store-guard.ts` refuses a write-capable open
 * anywhere else and its allowlist is intentionally empty.
 */

import { describe, expect, it, afterEach } from '@jest/globals';
import Database from 'better-sqlite3';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { seedRbookDb } from '../../helpers/seedRbookDb';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import { rbookAgentOnboard } from '../../../src/tools/rbook/rbook-agent-onboard';
import { rbookMission } from '../../../src/tools/rbook/rbook-mission';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import {
  resolveCurrentSprintId,
  resolveOpenSprintIdForWrite,
} from '../../../src/tools/rbook/current-sprint';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    if (root) await fs.rm(root, { recursive: true, force: true });
  }
});

interface SprintSeed {
  id: string;
  status: string;
  startDate?: string;
  endDate?: string;
}
interface MissionSeed {
  id: string;
  sprintId: string;
  status: string;
}

async function makeStore(sprints: SprintSeed[], missions: MissionSeed[] = []): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbook-m03-'));
  roots.push(root);
  const dbPath = seedRbookDb(root, { projectName: 'm03-fixture', projectId: 'm03-fixture' });

  const db = new Database(dbPath);
  // s86-m01: the local contexts workaround that used to sit here is gone — the WHY
  // it documented now lives on seedRbookDb itself, which writes all three rows.
  const insSprint = db.prepare(
    `INSERT INTO sprints (id, title, focus, status, start_date, end_date)
     VALUES (?, ?, 'fixture', ?, ?, ?)`
  );
  for (const s of sprints) {
    insSprint.run(s.id, `Sprint ${s.id}`, s.status, s.startDate ?? '2026-01-01', s.endDate ?? null);
  }
  const insMission = db.prepare(
    `INSERT INTO missions (id, name, sprint_id, status, created_at)
     VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z')`
  );
  for (const m of missions) {
    insMission.run(m.id, `Mission ${m.id}`, m.sprintId, m.status);
  }
  db.close();
  return root;
}

function rawOne<T>(root: string, sql: string): T | undefined {
  const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'), { readonly: true });
  try {
    return db.prepare(sql).get() as T | undefined;
  } finally {
    db.close();
  }
}

async function withRealClient<T>(root: string, fn: (c: RbookDatabaseClient) => T): Promise<T> {
  const created = await RbookDatabaseClient.create({
    dbPath: path.join(root, 'rbook', 'db', 'rbook.sqlite'),
  });
  const client = created.data!;
  try {
    return fn(client);
  } finally {
    client.close();
  }
}

/** Drive start → capture(decision|learning|constraint) → complete(nextSteps) end to end. */
async function driveFullSession(root: string): Promise<void> {
  const start = await rbookSession({
    action: 'start',
    type: 'planning',
    title: 'm03',
    projectRoot: root,
  });
  expect(start.success).toBe(true);

  for (const [category, content] of [
    ['decision', 'm03 decision row'],
    ['learning', 'm03 learning row'],
    ['constraint', 'm03 constraint row'],
  ] as const) {
    const cap = await rbookSession({ action: 'capture', category, content, projectRoot: root });
    expect(cap.success).toBe(true);
  }

  const done = await rbookSession({
    action: 'complete',
    summary: 'm03 close',
    nextSteps: ['m03 next step row'],
    projectRoot: root,
  });
  expect(done.success).toBe(true);
}

describe('s85-m03 write-side sprint tagging (real store)', () => {
  it('POSITIVE FIRE: an all-Completed store writes sprint_id NULL to every durable table', async () => {
    const root = await makeStore(
      [
        { id: 'sp-old', status: 'Completed', startDate: '2026-01-01', endDate: '2026-01-14' },
        { id: 'sp-new', status: 'Completed', startDate: '2026-02-01', endDate: '2026-02-14' },
      ],
      [{ id: 'm-1', sprintId: 'sp-new', status: 'Completed' }]
    );

    await driveFullSession(root);

    // Raw SELECTs — not the handler's own answer. All five durable tables, including
    // next_steps, which the original scope omitted entirely (it is written by
    // rbook-session-complete's nextSteps[] path and inherits session.sprint_id).
    for (const table of [
      'sessions',
      'strategic_decisions',
      'learnings',
      'constraints',
      'next_steps',
    ]) {
      const row = rawOne<{ total: number; tagged: number }>(
        root,
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN sprint_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS tagged FROM ${table}`
      );
      // Row count first: an empty table would make the tagged=0 assertion vacuous.
      expect({ table, hasRows: (row?.total ?? 0) > 0 }).toEqual({ table, hasRows: true });
      expect({ table, tagged: row?.tagged }).toEqual({ table, tagged: 0 });
    }

    // session_events.next_hint carried the sprint id too — a hint naming a dead sprint is the
    // same lie in a smaller font. Decided in the build plan: it takes NULL.
    const hint = rawOne<{ next_hint: string | null }>(
      root,
      "SELECT next_hint FROM session_events WHERE action = 'start' ORDER BY id DESC LIMIT 1"
    );
    expect(hint?.next_hint).toBeNull();
  });

  it('POSITIVE-FIRE COMPLEMENT: the same store with one Active sprint tags every row', async () => {
    // Proves the fixture BITES. Without this, the NULLs above could come from a broken
    // fixture (no sprints, wrong table) rather than from the resolver doing its job.
    const root = await makeStore([
      { id: 'sp-old', status: 'Completed', startDate: '2026-01-01', endDate: '2026-01-14' },
      { id: 'sp-live', status: 'Active', startDate: '2026-03-01' },
    ]);

    await driveFullSession(root);

    for (const table of [
      'sessions',
      'strategic_decisions',
      'learnings',
      'constraints',
      'next_steps',
    ]) {
      const row = rawOne<{ total: number; wrong: number }>(
        root,
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN sprint_id IS NOT 'sp-live' THEN 1 ELSE 0 END), 0) AS wrong FROM ${table}`
      );
      expect({ table, hasRows: (row?.total ?? 0) > 0 }).toEqual({ table, hasRows: true });
      expect({ table, wrong: row?.wrong }).toEqual({ table, wrong: 0 });
    }
  });

  it("LEG 1: a 'Planned' sprint carrying an In Progress mission is resolved for writes", async () => {
    const root = await makeStore(
      [{ id: 'sp-planned', status: 'Planned' }],
      [{ id: 'm-a', sprintId: 'sp-planned', status: 'In Progress' }]
    );
    const resolved = await withRealClient(root, (c) => resolveOpenSprintIdForWrite(c));
    expect(resolved).toBe('sp-planned');
  });

  it('LEG 2: an Active sprint whose missions are ALL Completed is resolved for writes', async () => {
    // The forge-data-viz-demos S6 case, and the reason leg 2 must NOT reuse
    // getExplicitOpenSprintId: that function's open-work EXISTS clause excludes exactly this
    // sprint, so reusing it would return NULL for a genuinely open sprint — trading the old
    // mis-tagging defect for a new one.
    const root = await makeStore(
      [{ id: 'sp-wrapup', status: 'Active' }],
      [
        { id: 'm-a', sprintId: 'sp-wrapup', status: 'Completed' },
        { id: 'm-b', sprintId: 'sp-wrapup', status: 'Completed' },
      ]
    );
    const resolved = await withRealClient(root, (c) => resolveOpenSprintIdForWrite(c));
    expect(resolved).toBe('sp-wrapup');
  });

  it("DELTA: a 'Planned' sprint with only Queued missions writes NULL while display still names it", async () => {
    // The real, testable behavior change from dropping Steps 3-4. Disclosed in the CHANGELOG:
    // display and write deliberately disagree here.
    const root = await makeStore(
      [{ id: 'sp-planned', status: 'Planned' }],
      [{ id: 'm-q', sprintId: 'sp-planned', status: 'Queued' }]
    );

    const { write, read } = await withRealClient(root, (c) => ({
      write: resolveOpenSprintIdForWrite(c),
      read: resolveCurrentSprintId(c),
    }));
    expect(write).toBeNull();
    expect(read).toBe('sp-planned');

    await driveFullSession(root);
    const s = rawOne<{ sprint_id: string | null }>(root, 'SELECT sprint_id FROM sessions LIMIT 1');
    expect(s?.sprint_id).toBeNull();
  });

  it('DISPLAY IS UNCHANGED: onboard and mission(status) still NAME the most recent Completed sprint', async () => {
    const root = await makeStore(
      [
        { id: 'sp-old', status: 'Completed', startDate: '2026-01-01', endDate: '2026-01-14' },
        { id: 'sp-new', status: 'Completed', startDate: '2026-02-01', endDate: '2026-02-14' },
      ],
      [{ id: 'm-1', sprintId: 'sp-new', status: 'Completed' }]
    );

    const onboard = await rbookAgentOnboard({ projectRoot: root });
    expect(onboard.success).toBe(true);
    expect(onboard.data?.currentSprint?.id).toBe('sp-new');

    const status = await rbookMission({ action: 'status', projectRoot: root });
    expect(status.success).toBe(true);
    const statusData = status.data as { activeSprint?: { id?: string } | null };
    expect(statusData.activeSprint?.id).toBe('sp-new');
  });

  it('ANSWER SHAPE: sprintId null, sprintAutoTagged false, advisorySprintId set, warning present', async () => {
    const root = await makeStore([
      { id: 'sp-done', status: 'Completed', startDate: '2026-01-01', endDate: '2026-01-14' },
    ]);

    const start = await rbookSession({
      action: 'start',
      type: 'planning',
      title: 'shape',
      projectRoot: root,
    });
    expect(start.success).toBe(true);
    const data = start.data as {
      sprintId: string | null;
      sprintAutoTagged: boolean;
      advisorySprintId?: string | null;
    };

    expect(data.sprintId).toBeNull();
    expect(data.sprintAutoTagged).toBe(false);
    // The hint rides a SEPARATE field: {sprintId, sprintAutoTagged:false} is already the
    // signature for "caller passed sprintId explicitly", so overloading sprintId would make
    // the two states indistinguishable on the wire.
    expect(data.advisorySprintId).toBe('sp-done');
    expect((start.warnings ?? []).some((w) => /sprint_id NULL/.test(w))).toBe(true);
  });

  it('an explicitly passed sprintId is still honored and is NOT reported as advisory', async () => {
    const root = await makeStore([
      { id: 'sp-done', status: 'Completed', startDate: '2026-01-01', endDate: '2026-01-14' },
    ]);
    const start = await rbookSession({
      action: 'start',
      type: 'planning',
      title: 'explicit',
      sprintId: 'sp-done',
      projectRoot: root,
    });
    const data = start.data as {
      sprintId: string | null;
      sprintAutoTagged: boolean;
      advisorySprintId?: string | null;
    };
    expect(data.sprintId).toBe('sp-done');
    expect(data.sprintAutoTagged).toBe(false);
    expect(data.advisorySprintId).toBeUndefined();
  });

  it('carry_forward no longer emits a null_sprint_sessions item', async () => {
    // The item claimed untagged sessions "require dashboard event processor update" and, with
    // send=true, emitted a cross-project backlog_request about a dashboard bug that does not
    // exist. After m03 a NULL sprint_id is the correct record, so the claim is false and the
    // count would climb with normal use.
    const root = await makeStore([
      { id: 'sp-done', status: 'Completed', startDate: '2026-01-01', endDate: '2026-01-14' },
    ]);
    await driveFullSession(root);

    const res = await rbookSprint({
      action: 'carry_forward',
      sprintId: 'sp-done',
      targetAddress: 'rbook://tester/sibling-project',
      send: false, // dry run — never actually emits the cross-project backlog_request
      projectRoot: root,
    });
    expect(res.success).toBe(true);
    const items = (res.data as { items?: Array<{ type: string }> })?.items ?? [];
    expect(items.map((i) => i.type)).not.toContain('null_sprint_sessions');
  });

  it('untagged advisories fire on sprint retro and sprint complete', async () => {
    const now = Date.now();
    const date = (days: number) => new Date(now + days * 86_400_000).toISOString();
    const root = await makeStore([
      { id: 'sp-done', status: 'Completed', startDate: date(-40), endDate: date(-30) },
      { id: 'sp-close', status: 'Active', startDate: date(-2) },
    ]);
    // Create an UNTAGGED session directly: the resolver would tag it to sp-close otherwise.
    const db = new Database(path.join(root, 'rbook', 'db', 'rbook.sqlite'));
    db.prepare(
      `INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures)
       VALUES ('PS-UNTAGGED-001', 'planning', 'untagged', NULL, ?, 'a', 'completed', '[]')`
    ).run(date(-1));
    db.prepare(
      `INSERT INTO sessions (id, type, title, sprint_id, started_at, agent, status, captures) VALUES ('PS-OLDER', 'planning', 'older', NULL, ?, 'a', 'completed', '[]')`
    ).run(date(-20));
    db.close();

    const retro = await rbookSprint({ action: 'retro', sprintId: 'sp-close', projectRoot: root });
    expect(retro.success).toBe(true);
    expect((retro.warnings ?? []).some((w) => /carry no sprint tag/.test(w))).toBe(true);

    const close = await rbookSprint({
      action: 'complete',
      sprintId: 'sp-close',
      summary: 'closing',
      projectRoot: root,
    });
    expect(close.success).toBe(true);
    expect((close.warnings ?? []).find((w) => /carry no sprint tag/.test(w))).toMatch(
      /^1 explicit session\(s\).*sprint's window/
    );
    expect((close.warnings ?? []).join(' ')).not.toContain('nor are the decisions');
  });
});
