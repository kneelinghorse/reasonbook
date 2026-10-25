// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Mission transitions retain the caller's session as evidence in the same atomic write.
// ABOUTME: Retros count implicit sessions through sprint-scoped links without assigning a sprint to them.
import Database from 'better-sqlite3';
import { rbookMissionStart } from '../../../src/tools/rbook/rbook-mission-start';
import { rbookMissionComplete } from '../../../src/tools/rbook/rbook-mission-complete';
import { buildUntaggedSessionAdvisory } from '../../../src/tools/rbook/untagged-advisory';
import { rbookSprintRetro } from '../../../src/tools/rbook/rbook-sprint-retro';
import { setSessionOwnerForTesting, processOwnerKey } from '../../../src/tools/rbook/session-owner';
import {
  call,
  dbOf,
  project,
  replicaFixture,
  useMachine,
  withClient,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';
import { memberCopy, shareExisting, sync, read } from '../../helpers/shared-copies';

let fixture: ReplicaFixture;
let root: string;
let checkpoint: string | undefined;
function raw(sql: string): void {
  const db = new Database(dbOf(root));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
function rows(sql: string): unknown[] {
  return read({ root }, sql);
}
async function start() {
  return rbookMissionStart({ missionId: 'm1', projectRoot: root });
}
async function complete() {
  return rbookMissionComplete({ missionId: 'm1', projectRoot: root });
}

beforeEach(() => {
  fixture = replicaFixture('mission-session-links-');
  useMachine(fixture.tmp, 'solo');
  root = project(fixture.tmp, 'solo');
  checkpoint = process.env.RBOOK_CHECKPOINT_SYNC;
  delete process.env.RBOOK_CHECKPOINT_SYNC;
  setSessionOwnerForTesting({ key: 'ext:mission-links', kind: 'external', pid: process.pid });
  raw(`INSERT INTO sprints(id,title,status) VALUES('s1','One','Active'),('s2','Two','Planned');
    INSERT INTO missions(id,name,status,sprint_id) VALUES('m1','One','Queued','s1'),('m2','Two','Queued','s2');`);
});
afterEach(() => {
  setSessionOwnerForTesting(null);
  if (checkpoint === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = checkpoint;
  fixture.restore();
});

test('start and complete share one implicit link and retro counts it with checkpoint sync unset', async () => {
  expect((await start()).success).toBe(true);
  expect((await complete()).success).toBe(true);
  expect(rows('SELECT mission_id FROM session_missions')).toEqual([{ mission_id: 'm1' }]);
  expect(rows('SELECT sprint_id, implicit, owner_key FROM sessions')).toEqual([
    { sprint_id: null, implicit: 1, owner_key: 'ext:mission-links' },
  ]);
  const retro = await rbookSprintRetro({ sprintId: 's1', projectRoot: root });
  expect(retro.data?.kpis).toMatchObject({ totalSessions: 1, linkedSessions: 1 });
  expect(retro.data?.sessions[0].linkedMissionIds).toEqual(['m1']);
});

test('one implicit session spanning two sprints counts once in each with only that sprint links', async () => {
  await start();
  await rbookMissionStart({ missionId: 'm2', projectRoot: root });
  for (const [sprintId, missionId] of [
    ['s1', 'm1'],
    ['s2', 'm2'],
  ]) {
    const retro = await rbookSprintRetro({ sprintId, projectRoot: root });
    expect(retro.data?.kpis).toMatchObject({ totalSessions: 1, linkedSessions: 1 });
    expect(retro.data?.sessions[0].linkedMissionIds).toEqual([missionId]);
  }
});

test('a keyless explicit session absorbs the caller without inventing a link or implicit session', async () => {
  const db = new Database(dbOf(root));
  db.prepare(
    "INSERT INTO sessions(id,type,title,status,started_at,sprint_id,owner_key,implicit) VALUES('explicit','build','Explicit','active',?,'s1',NULL,0)"
  ).run(new Date().toISOString());
  db.close();
  expect((await start()).success).toBe(true);
  expect((await complete()).success).toBe(true);
  expect(rows('SELECT * FROM session_missions')).toEqual([]);
  expect(rows('SELECT id FROM sessions')).toEqual([{ id: 'explicit' }]);
});

test('different process callers link their own sessions at start and completion', async () => {
  setSessionOwnerForTesting({
    key: processOwnerKey(process.pid, 1),
    kind: 'process',
    pid: process.pid,
  });
  expect((await start()).success).toBe(true);
  setSessionOwnerForTesting({
    key: processOwnerKey(process.pid, 2),
    kind: 'process',
    pid: process.pid,
  });
  expect((await complete()).success).toBe(true);
  expect(rows('SELECT DISTINCT session_id FROM session_missions')).toHaveLength(2);
});

test('promotion to Current does not count as starting work', async () => {
  expect(
    (await rbookMissionStart({ missionId: 'm1', targetStatus: 'Current', projectRoot: root }))
      .success
  ).toBe(true);
  expect(rows('SELECT * FROM session_missions')).toEqual([]);
  expect(rows('SELECT * FROM sessions')).toEqual([]);
});

test.each(['start', 'complete'] as const)(
  '%s rolls back status, session and sprint changes when linking fails',
  async (action) => {
    if (action === 'complete') raw("UPDATE missions SET status='In Progress' WHERE id='m1'");
    raw("UPDATE sprints SET status='Planned' WHERE id='s1'");
    raw(
      "CREATE TRIGGER refuse_link BEFORE INSERT ON session_missions BEGIN SELECT RAISE(ABORT, 'link refused'); END;"
    );
    const answer = await (action === 'start' ? start() : complete());
    expect(answer.success).toBe(false);
    expect(answer.error?.message).toContain('link refused');
    expect(answer.error?.suggestion).toBeTruthy();
    expect(rows("SELECT status FROM sprints WHERE id='s1'")).toEqual([{ status: 'Planned' }]);
    expect(rows("SELECT status FROM missions WHERE id='m1'")).toEqual([
      { status: action === 'start' ? 'Queued' : 'In Progress' },
    ]);
    expect(rows('SELECT * FROM sessions')).toEqual([]);
  }
);

test('missing junction table is created before linking and remains readable by retro', async () => {
  raw('DROP TABLE session_missions');
  expect((await start()).success).toBe(true);
  expect(rows('SELECT mission_id FROM session_missions')).toEqual([{ mission_id: 'm1' }]);
});

test('retro tolerates a missing junction table but refuses malformed link queries', async () => {
  raw('DROP TABLE session_missions');
  expect((await rbookSprintRetro({ sprintId: 's1', projectRoot: root })).success).toBe(true);
  raw('CREATE TABLE session_missions(session_id TEXT)');
  const result = await rbookSprintRetro({ sprintId: 's1', projectRoot: root });
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain('session');
});

test('MCP dispatch records the resolved caller without a sessionId argument', async () => {
  expect(
    (
      await call('rbook_mission_transition', {
        action: 'start',
        missionId: 'm1',
        projectRoot: root,
      })
    ).success
  ).toBe(true);
  expect(
    (
      await call('rbook_mission_transition', {
        action: 'complete',
        missionId: 'm1',
        projectRoot: root,
      })
    ).success
  ).toBe(true);
  expect(rows('SELECT mission_id FROM session_missions')).toEqual([{ mission_id: 'm1' }]);
});

test('a shared copy transports the link with its session and mission changes', async () => {
  const owner = await shareExisting(fixture.tmp, root);
  const member = await memberCopy(fixture.tmp, owner, 'member', 1);
  useMachine(fixture.tmp, owner.machine);
  expect((await start()).success).toBe(true);
  expect((await complete()).success).toBe(true);
  await sync(fixture.tmp, owner, member);
  expect(read(member, 'SELECT mission_id FROM session_missions')).toEqual([{ mission_id: 'm1' }]);
  expect(read(member, "SELECT status FROM missions WHERE id='m1'")).toEqual([
    { status: 'Completed' },
  ]);
  expect(read(member, 'SELECT owner_key FROM sessions')).toEqual([
    { owner_key: expect.stringMatching(/^peer:/) },
  ]);
});

test('a sprint-tagged session gets no linked credit from another sprint mission', async () => {
  const db = new Database(dbOf(root));
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO sessions(id,type,title,status,started_at,sprint_id) VALUES('explicit','build','Explicit','active',?,'s1')"
  ).run(now);
  db.prepare(
    "INSERT INTO session_missions(session_id,mission_id,linked_at) VALUES('explicit','m2',?)"
  ).run(now);
  db.close();
  const retro = await rbookSprintRetro({ sprintId: 's1', projectRoot: root });
  expect(retro.data?.kpis).toMatchObject({ totalSessions: 1, linkedSessions: 0 });
  expect(retro.data?.sessions[0].linkedMissionIds).toEqual([]);
});

test('pre-owner schema is migrated before the session lookup, including a missing junction', async () => {
  const db = new Database(dbOf(root));
  const original = db.prepare("SELECT sql FROM sqlite_master WHERE name='sessions'").get() as {
    sql: string;
  };
  const legacy = original.sql
    .replace(/--[^\n]*/g, '')
    .replace(/,\s*implicit INTEGER NOT NULL DEFAULT 0,\s*owner_key TEXT/, '');
  db.exec('DROP TABLE session_missions; DROP TABLE sessions;');
  db.exec(legacy);
  db.close();
  expect((await start()).success).toBe(true);
  expect(rows('SELECT mission_id FROM session_missions')).toEqual([{ mission_id: 'm1' }]);
  expect(rows('SELECT owner_key, implicit FROM sessions')).toEqual([
    { owner_key: 'ext:mission-links', implicit: 1 },
  ]);
});

test('a malformed sessions table refuses the transition instead of silently omitting its link', async () => {
  raw('DROP TABLE sessions; CREATE TABLE sessions(id TEXT PRIMARY KEY);');
  const result = await start();
  expect(result.success).toBe(false);
  expect(result.error?.message).toContain('session');
  expect(rows("SELECT status FROM missions WHERE id='m1'")).toEqual([{ status: 'Queued' }]);
});

test('an owner-keyed explicit session links once and retro does not double-count its sprint membership', async () => {
  const db = new Database(dbOf(root));
  db.prepare(
    "INSERT INTO sessions(id,type,title,status,started_at,sprint_id,owner_key,implicit) VALUES('explicit','build','Explicit','active',?,'s1','ext:mission-links',0)"
  ).run(new Date().toISOString());
  db.close();
  expect((await start()).success).toBe(true);
  expect((await complete()).success).toBe(true);
  expect(rows('SELECT session_id, mission_id FROM session_missions')).toEqual([
    { session_id: 'explicit', mission_id: 'm1' },
  ]);
  const retro = await rbookSprintRetro({ sprintId: 's1', projectRoot: root });
  expect(retro.data?.kpis).toMatchObject({ totalSessions: 1, linkedSessions: 1 });
});

test.each(['start', 'complete'] as const)(
  '%s refuses an ignored link insert and rolls back the transition and new session',
  async (action) => {
    if (action === 'complete') raw("UPDATE missions SET status='In Progress' WHERE id='m1'");
    raw("UPDATE sprints SET status='Planned' WHERE id='s1'");
    raw(
      'CREATE TRIGGER ignore_link BEFORE INSERT ON session_missions BEGIN SELECT RAISE(IGNORE); END;'
    );
    const answer = await (action === 'start' ? start() : complete());
    expect(answer.success).toBe(false);
    expect(answer.error?.message).toMatch(/link.*not persisted/i);
    expect(answer.error?.suggestion).toBeTruthy();
    expect(rows("SELECT status FROM missions WHERE id='m1'")).toEqual([
      { status: action === 'start' ? 'Queued' : 'In Progress' },
    ]);
    expect(rows("SELECT status FROM sprints WHERE id='s1'")).toEqual([{ status: 'Planned' }]);
    expect(rows('SELECT * FROM sessions')).toEqual([]);
    expect(rows('SELECT * FROM session_missions')).toEqual([]);
  }
);

test('an ignored duplicate insert succeeds when the caller already has the required link', async () => {
  expect((await start()).success).toBe(true);
  const before = rows('SELECT * FROM session_missions');
  expect(before).toHaveLength(1);
  raw(
    'CREATE TRIGGER ignore_link BEFORE INSERT ON session_missions BEGIN SELECT RAISE(IGNORE); END;'
  );
  expect((await complete()).success).toBe(true);
  expect(rows('SELECT * FROM session_missions')).toEqual(before);
  expect(rows("SELECT status FROM missions WHERE id='m1'")).toEqual([{ status: 'Completed' }]);
});

test('retro explains why an untagged explicit session with a sprint mission link is counted', async () => {
  const db = new Database(dbOf(root));
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO sessions(id,type,title,status,started_at,sprint_id,implicit) VALUES('untagged','build','Unscheduled','completed',?,NULL,0)"
  ).run(now);
  db.prepare(
    "INSERT INTO session_missions(session_id,mission_id,linked_at) VALUES('untagged','m1',?)"
  ).run(now);
  db.close();
  const retro = await rbookSprintRetro({ sprintId: 's1', projectRoot: root });
  expect(retro.data?.kpis).toMatchObject({ totalSessions: 1, linkedSessions: 1 });
  const advisory = retro.warnings?.find((warning) => warning.includes('carry no sprint tag'));
  expect(advisory).toContain('1 explicit session(s)');
  expect(advisory).toContain('linked to one of its missions');
  expect(advisory).toContain('Decisions and learnings are counted by their own sprint tags');
  expect(advisory).not.toContain('are therefore NOT counted here');
  // Sprint completion keeps the default tag-only advisory and its existing counting policy.
  const closeAdvisory = await withClient(root, (client) => buildUntaggedSessionAdvisory(client));
  expect(closeAdvisory).toContain('are therefore NOT counted here');
});
