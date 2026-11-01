// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s108-m02's six paths for dates and reasons: a store without stable ids or the reasons table, a
// ABOUTME: rebuild after the day, a reason written while another process carries the row, and env unset.

import { fork } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { rbookNextSteps } from '../../../src/tools/rbook/rbook-next-steps';
import { rbookSession } from '../../../src/tools/rbook/rbook-session';
import { rbookSprintComplete } from '../../../src/tools/rbook/rbook-sprint-complete';
import { rbookSprint } from '../../../src/tools/rbook/rbook-sprint';
import { closedSessionLines } from '../../../src/tools/rbook/implicit-session-lifecycle';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { digestWork } from '../../../src/tools/rbook/digest-work';
import { utcDay } from '../../../src/tools/rbook/next-step-dates';

const DAY = 86_400_000;
let project: SeededRbookProject;
let db: Database.Database;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-s108-m02-stores-');
  db = new Database(project.dbPath);
});
afterEach(async () => {
  db.close();
  await project.cleanup();
});
const steps = (args: Record<string, unknown>) =>
  rbookNextSteps({ projectRoot: project.projectRoot, ...args } as Parameters<
    typeof rbookNextSteps
  >[0]);
const tables = () =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>
  ).map((table) => table.name);

describe('a store that predates the reasons', () => {
  it('reads, closes and digests without the table, and never makes it on a read', async () => {
    db.prepare(
      "INSERT INTO next_steps (content, status, created_at) VALUES ('Old row', 'pending', ?)"
    ).run(new Date().toISOString());
    expect(tables()).not.toContain('next_step_reasons');
    expect((await steps({ nextStepAction: 'list' })).data?.items).toHaveLength(1);
    expect((await steps({ nextStepAction: 'show', nextStepIds: [1] })).success).toBe(true);
    const opened = await RbookDatabaseClient.create({ dbPath: project.dbPath });
    try {
      expect(digestWork(opened.data!, 'builder', null, null).nextSteps?.total).toBe(1);
    } finally {
      opened.data!.close();
    }
    expect(tables()).not.toContain('next_step_reasons');
    db.prepare("INSERT INTO sprints (id, title, status) VALUES ('s1', 'S1', 'Active')").run();
    expect(
      (
        await rbookSprintComplete({
          sprintId: 's1',
          summary: 'Close',
          projectRoot: project.projectRoot,
        })
      ).success
    ).toBe(true);
  });

  it('gives next_steps the stable ids a reason needs, when its table was made without them', async () => {
    // A next_steps table ensureNextStepsTable made bare, as Synthesis-Workbench's cmos/ store has.
    db.exec('DROP TABLE next_steps');
    db.exec(`CREATE TABLE next_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', session_id TEXT, sprint_id TEXT, mission_id TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT, carried_to_sprint TEXT, content_hash TEXT)`);
    db.prepare(
      "INSERT INTO next_steps (content, status, created_at) VALUES ('Bare', 'pending', ?)"
    ).run(new Date().toISOString());
    // A dated row too, which the genesis preparation's table rebuild must copy as it stands.
    const day = utcDay(Date.now() + 20 * DAY);
    db.prepare(
      "INSERT INTO next_steps (content, status, created_at, resolved_at) VALUES ('Dated bare', 'carried', ?, ?)"
    ).run(new Date().toISOString(), day);
    expect((await steps({ nextStepAction: 'list' })).data?.items).toHaveLength(2);
    expect(
      (await steps({ nextStepAction: 'show', nextStepIds: [1] })).data?.items?.[0].content
    ).toBe('Bare');
    const opened = await RbookDatabaseClient.create({ dbPath: project.dbPath });
    try {
      expect(digestWork(opened.data!, 'builder', null, null).waiting).toBe(1);
    } finally {
      opened.data!.close();
    }
    // The reason write prepares the genesis schema first, which gives the existing row its stable id.
    const done = await steps({ nextStepAction: 'complete', nextStepIds: [1], reason: 'Kept' });
    expect(done.data?.affected).toBe(1);
    expect(
      (await steps({ nextStepAction: 'show', nextStepIds: [1] })).data?.items?.[0].reason
    ).toBe('Kept');
    expect(
      db.prepare("SELECT resolved_at FROM next_steps WHERE content = 'Dated bare'").get()
    ).toEqual({ resolved_at: day });
    await rbookSprint({
      action: 'add',
      sprintId: 'bare-close',
      title: 'Bare',
      projectRoot: project.projectRoot,
    });
    const closed = await rbookSprintComplete({
      sprintId: 'bare-close',
      summary: 'Bare',
      projectRoot: project.projectRoot,
    });
    expect(closed.success).toBe(true);
  });

  it('refuses, by row, a reason for a row whose stable id column holds NULL, and changes nothing', async () => {
    // The columns exist and event_type is already NOT NULL, so the migration sees nothing behind
    // (firehoseTableBehind) and ensureGenesisSchema checks columns, not values: the NULL stays.
    expect((await steps({ nextStepAction: 'list' })).success).toBe(true);
    db.exec('DROP TABLE next_steps');
    db.exec(`CREATE TABLE next_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', session_id TEXT, sprint_id TEXT, mission_id TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT, carried_to_sprint TEXT, content_hash TEXT,
      project_id TEXT, stable_event_id TEXT, occurred_at INTEGER, origin_seq INTEGER,
      event_type TEXT NOT NULL, schema_version INTEGER, author_session_id TEXT, author_user_id TEXT,
      author_name TEXT)`);
    db.prepare(
      "INSERT INTO next_steps (content, status, created_at, event_type) VALUES ('Keyless', 'pending', ?, 'next_step_created')"
    ).run(new Date().toISOString());
    const done = await steps({ nextStepAction: 'complete', nextStepIds: [1], reason: 'Why' });
    expect(done.error).toMatchObject({ code: 'INVALID_PARAMETER', field: 'reason' });
    expect(done.error?.message).toContain('#1 has none; nothing was changed');
    expect(
      (db.prepare('SELECT status FROM next_steps WHERE id = 1').get() as { status: string }).status
    ).toBe('pending');
    // Without a reason the same call goes ahead, as the refusal says.
    expect((await steps({ nextStepAction: 'complete', nextStepIds: [1] })).data?.affected).toBe(1);
  });
});

describe('an object named next_step_reasons that Reasonbook did not make', () => {
  it.each([
    ['a view', 'CREATE VIEW next_step_reasons AS SELECT 1 AS x'],
    ['a table of another shape', 'CREATE TABLE next_step_reasons (x TEXT)'],
  ])('is skipped by reads and refused by a reason write, when it is %s', async (_shape, sql) => {
    db.prepare(
      "INSERT INTO next_steps (content, status, created_at) VALUES ('Theirs', 'pending', ?)"
    ).run(new Date().toISOString());
    expect((await steps({ nextStepAction: 'complete', nextStepIds: [1] })).data?.affected).toBe(1);
    db.exec(sql);
    const shown = await steps({ nextStepAction: 'show', nextStepIds: [1] });
    expect(shown.success).toBe(true);
    expect(shown.data?.items?.[0].reason).toBeUndefined();
    expect((await steps({ nextStepAction: 'reopen', nextStepIds: [1] })).data?.affected).toBe(1);
    const refused = await steps({ nextStepAction: 'drop', nextStepIds: [1], reason: 'Why' });
    expect(refused.error?.message).toContain('that Reasonbook did not make');
    expect(
      (db.prepare('SELECT status FROM next_steps WHERE id = 1').get() as { status: string }).status
    ).toBe('pending');
  });
});

describe('a dated capture rebuilt by a session close', () => {
  it('is written undated once its day has come, and both closes say so', async () => {
    const started = await rbookSession({
      action: 'start',
      title: 'Rebuild',
      projectRoot: project.projectRoot,
    });
    const sessionId = (started.data as { sessionId: string }).sessionId;
    // A capture whose row was never written, as when its write at capture failed, dated for a day
    // that has since come.
    db.prepare('UPDATE sessions SET captures = ? WHERE id = ?').run(
      JSON.stringify([
        {
          timestamp: new Date(Date.now() - 5 * DAY).toISOString(),
          category: 'next-step',
          content: 'Rebuilt after its day',
          checkAfter: utcDay(Date.now() - 2 * DAY),
        },
        {
          timestamp: new Date().toISOString(),
          category: 'next-step',
          content: 'Rebuilt before its day',
          checkAfter: utcDay(Date.now() + 9 * DAY),
        },
      ]),
      sessionId
    );
    const completed = await rbookSession({
      action: 'complete',
      sessionId,
      summary: 'Rebuild',
      projectRoot: project.projectRoot,
    });
    const data = completed.data as { datesPassed?: Array<{ id: number; checkAfter: string }> };
    const rows = db
      .prepare('SELECT id, content, status, resolved_at FROM next_steps ORDER BY id')
      .all() as Array<{
      id: number;
      content: string;
      status: string;
      resolved_at: string | null;
    }>;
    expect(rows.map(({ content, status, resolved_at }) => [content, status, resolved_at])).toEqual([
      ['Rebuilt after its day', 'pending', null],
      ['Rebuilt before its day', 'carried', utcDay(Date.now() + 9 * DAY)],
    ]);
    expect(data.datesPassed).toEqual([
      { id: rows[0].id, checkAfter: utcDay(Date.now() - 2 * DAY) },
    ]);
    // The automatic close prints the same through its receipt.
    const line = closedSessionLines([
      {
        sessionId,
        title: 'Rebuild',
        implicit: true,
        reason: 'idle',
        idleHours: 9,
        summary: 'Closed',
        closed: true,
        datesPassed: data.datesPassed,
      },
    ])[0];
    expect(line).toContain(`#${rows[0].id} (${utcDay(Date.now() - 2 * DAY)})`);
  });
});

describe('a reason written while another process carries the row', () => {
  it('lands with the status it explains, or not at all', async () => {
    db.prepare(
      "INSERT INTO next_steps (content, status, created_at) VALUES ('Raced', 'pending', ?)"
    ).run(new Date().toISOString());
    const worker = path.join(project.projectRoot, 'carry-lock.cjs');
    // 4.9.0's carry by id, in a second process that holds the write lock for half a second.
    fs.writeFileSync(
      worker,
      `const Database=require(${JSON.stringify(require.resolve('better-sqlite3'))});
      const db=new Database(process.argv[2]);
      db.exec('BEGIN IMMEDIATE');
      db.prepare("UPDATE next_steps SET status = 'carried', resolved_at = ?, carried_to_sprint = NULL WHERE id = 1").run(new Date().toISOString());
      process.send('locked');
      setTimeout(()=>{db.exec('COMMIT');db.close();process.exit(0)},500);`
    );
    const child = fork(worker, [project.dbPath], { silent: true });
    // Listen for the exit before the race, since the child may exit while this process waits on it.
    const exited = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`carry worker exited ${code}`))
      );
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('message', () => resolve());
    });
    const done = await steps({ nextStepAction: 'complete', nextStepIds: [1], reason: 'Finished' });
    await exited;
    const row = db
      .prepare('SELECT status, resolved_at, stable_event_id FROM next_steps WHERE id = 1')
      .get() as {
      status: string;
      resolved_at: string;
      stable_event_id: string;
    };
    const reasons = db.prepare('SELECT * FROM next_step_reasons').all() as Array<
      Record<string, string>
    >;
    if (done.data?.affected === 1) {
      expect(row.status).toBe('completed');
      expect(reasons).toEqual([
        expect.objectContaining({
          stable_event_id: row.stable_event_id,
          reason: 'Finished',
          status: 'completed',
          resolved_at: row.resolved_at,
        }),
      ]);
    } else {
      expect(row.status).toBe('carried');
      expect(reasons).toEqual([]);
    }
  });
});
