// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A mission blocked before work starts returns to the queue only for that blocking episode.
// ABOUTME: Exercises real SQLite writes, stale metadata, explicit choices and failed transition persistence.

import Database from 'better-sqlite3';
import { spawn } from 'child_process';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { rbookMissionBlock } from '../../../src/tools/rbook/rbook-mission-block';
import { rbookMissionUnblock } from '../../../src/tools/rbook/rbook-mission-unblock';
import { rbookMissionUpdate } from '../../../src/tools/rbook/rbook-mission-update';
import { rbookMissionStart } from '../../../src/tools/rbook/rbook-mission-start';
import { VALID_STATE_TRANSITIONS } from '../../../src/tools/rbook/errors';

let project: SeededRbookProject;
let db: Database.Database;
const args = () => ({ projectRoot: project.projectRoot, missionId: 'queued-block' });
const block = () => rbookMissionBlock({ ...args(), reason: 'Waiting on evidence' });
const unblock = () => rbookMissionUnblock(args());
const row = () =>
  db
    .prepare('SELECT status,domain_fields,notes,started_at FROM missions WHERE id=?')
    .get('queued-block') as {
    status: string;
    domain_fields: string | null;
    notes: string | null;
    started_at: string | null;
  };
const fields = () => JSON.parse(row().domain_fields ?? '{}');
function blocked(domainFields: unknown, startedAt: string | null = null) {
  db.prepare('UPDATE missions SET status=?,domain_fields=?,started_at=? WHERE id=?').run(
    'Blocked',
    typeof domainFields === 'string' ? domainFields : JSON.stringify(domainFields),
    startedAt,
    'queued-block'
  );
}

beforeEach(async () => {
  project = await createSeededRbookProject({}, 'queued-block-');
  db = new Database(project.dbPath);
  db.exec("INSERT INTO sprints(id,title,status) VALUES('block-sprint','Block sprint','Active')");
  db.exec(
    "INSERT INTO missions(id,sprint_id,name,status) VALUES('queued-block','block-sprint','Before work','Queued')"
  );
});
afterEach(async () => {
  db.close();
  await project.cleanup();
});

it('records the episode and returns an unstarted mission to its queue', async () => {
  expect((await block()).success).toBe(true);
  expect(fields().blockedFrom).toEqual({ status: 'Queued', blockedSince: fields().blockedSince });
  expect(row().started_at).toBeNull();
  expect((await unblock()).data?.currentStatus).toBe('Queued');
  expect(fields().blockedFrom).toBeNull();
  expect(fields().blockedSince).toBeNull();
  expect(VALID_STATE_TRANSITIONS.Completed).toEqual([]);
});

it.each(['Current', 'In Progress'] as const)(
  'explicit %s overrides the queue origin',
  async (targetStatus) => {
    const at = new Date().toISOString();
    blocked({ blockedSince: at, blockedFrom: { status: 'Queued', blockedSince: at } });
    expect((await rbookMissionUnblock({ ...args(), targetStatus })).data?.currentStatus).toBe(
      targetStatus
    );
    expect(fields().blockedFrom).toBeNull();
  }
);

it.each([
  ['missing', {}],
  ['lost', { blockedSince: new Date().toISOString() }],
  ['malformed JSON', '{broken'],
  ['null JSON', 'null'],
  ['array JSON', '[]'],
  ['scalar marker', { blockedSince: 'current', blockedFrom: 'Queued' }],
  [
    'stale marker',
    { blockedSince: 'current', blockedFrom: { status: 'Queued', blockedSince: 'old' } },
  ],
  ['missing timestamps', { blockedFrom: { status: 'Queued' } }],
  [
    'null timestamps',
    { blockedSince: null, blockedFrom: { status: 'Queued', blockedSince: null } },
  ],
])('falls back to In Progress with %s metadata', async (_label, value) => {
  blocked(value);
  expect((await unblock()).data?.currentStatus).toBe('In Progress');
});

it('never requeues work with a start timestamp even when origin metadata matches', async () => {
  const at = new Date().toISOString();
  blocked({ blockedSince: at, blockedFrom: { status: 'Queued', blockedSince: at } }, at);
  expect((await unblock()).data?.currentStatus).toBe('In Progress');
});

it('binds update-origin metadata after caller fields and clears it on exit', async () => {
  const result = await rbookMissionUpdate({
    ...args(),
    fields: {
      status: 'Blocked',
      domainFields: { kept: 1, blockedFrom: 'forged', blockedSince: 'forged' },
    },
  });
  expect(result.success).toBe(true);
  expect(fields()).toMatchObject({ kept: 1, blockedFrom: { status: 'Queued' } });
  expect(fields().blockedFrom.blockedSince).toBe(fields().blockedSince);
  expect(
    (
      await rbookMissionUpdate({
        ...args(),
        fields: {
          status: 'Current',
          domainFields: { kept: 2, blockedFrom: 'forged', blockedSince: 'forged' },
        },
      })
    ).success
  ).toBe(true);
  expect(fields()).toEqual({ kept: 2, blockedFrom: null, blockedSince: null });
});

it('preserves an existing episode when a status-identical update replaces other fields', async () => {
  const at = new Date(Date.now() - 1000).toISOString();
  blocked({ kept: 1, blockedSince: at, blockedFrom: { status: 'Queued', blockedSince: at } });
  expect(
    (
      await rbookMissionUpdate({
        ...args(),
        fields: {
          status: 'Blocked',
          domainFields: { kept: 2, blockedFrom: 'forged', blockedSince: 'forged' },
        },
      })
    ).success
  ).toBe(true);
  expect(fields()).toEqual({
    kept: 2,
    blockedSince: at,
    blockedFrom: { status: 'Queued', blockedSince: at },
  });
  expect((await unblock()).data?.currentStatus).toBe('Queued');
});

it('does not reuse the first queued origin after work starts and is blocked again', async () => {
  expect((await block()).success).toBe(true);
  expect((await unblock()).data?.currentStatus).toBe('Queued');
  expect((await rbookMissionStart(args())).success).toBe(true);
  expect((await rbookMissionUpdate({ ...args(), fields: { status: 'Blocked' } })).success).toBe(
    true
  );
  expect(fields().blockedFrom.status).toBe('In Progress');
  expect((await unblock()).data?.currentStatus).toBe('In Progress');
});

it.each(['block', 'unblock', 'update'] as const)(
  '%s refuses ignored writes without a success event',
  async (action) => {
    if (action === 'unblock') blocked({});
    const before = row();
    db.exec(
      "CREATE TRIGGER ignore_block BEFORE UPDATE ON missions WHEN OLD.id='queued-block' BEGIN SELECT RAISE(IGNORE); END"
    );
    const result =
      action === 'block'
        ? await block()
        : action === 'unblock'
          ? await unblock()
          : await rbookMissionUpdate({ ...args(), fields: { status: 'Blocked' } });
    expect(result.success).toBe(false);
    expect(row()).toEqual(before);
    expect(
      db.prepare("SELECT count(*) AS n FROM session_events WHERE mission='queued-block'").get()
    ).toEqual({ n: 0 });
  }
);

it.each(['block', 'unblock', 'update'] as const)(
  '%s rolls back reverted writes',
  async (action) => {
    if (action === 'unblock') blocked({});
    const before = row();
    db.exec(
      "CREATE TRIGGER revert_block AFTER UPDATE ON missions WHEN OLD.id='queued-block' BEGIN UPDATE missions SET status=OLD.status,domain_fields=OLD.domain_fields WHERE id=NEW.id; END"
    );
    const result =
      action === 'block'
        ? await block()
        : action === 'unblock'
          ? await unblock()
          : await rbookMissionUpdate({ ...args(), fields: { status: 'Blocked' } });
    expect(result.success).toBe(false);
    expect(row()).toEqual(before);
    expect(
      db.prepare("SELECT count(*) AS n FROM session_events WHERE mission='queued-block'").get()
    ).toEqual({ n: 0 });
  }
);

it('preserves the episode on metadata-only edits as well as status-identical edits', async () => {
  const at = new Date().toISOString();
  blocked({ blockedSince: at, blockedFrom: { status: 'Queued', blockedSince: at } });
  expect(
    (await rbookMissionUpdate({ ...args(), fields: { domainFields: { kept: true } } })).success
  ).toBe(true);
  expect(fields()).toMatchObject({
    kept: true,
    blockedSince: at,
    blockedFrom: { status: 'Queued', blockedSince: at },
  });
  expect((await unblock()).data?.currentStatus).toBe('Queued');
});

it('uses the explicit project with no project-root environment setting', async () => {
  const saved = process.env.RBOOK_PROJECT_ROOT;
  delete process.env.RBOOK_PROJECT_ROOT;
  try {
    expect((await block()).success).toBe(true);
    expect((await unblock()).data?.currentStatus).toBe('Queued');
  } finally {
    if (saved === undefined) delete process.env.RBOOK_PROJECT_ROOT;
    else process.env.RBOOK_PROJECT_ROOT = saved;
  }
});

it('migrates an old timestamp shape before reading the origin eligibility', async () => {
  db.exec('ALTER TABLE missions DROP COLUMN started_at');
  const at = new Date().toISOString();
  db.prepare('UPDATE missions SET status=?,domain_fields=? WHERE id=?').run(
    'Blocked',
    JSON.stringify({ blockedSince: at, blockedFrom: { status: 'Queued', blockedSince: at } }),
    'queued-block'
  );
  expect((await unblock()).data?.currentStatus).toBe('Queued');
  expect(row().started_at).toBeNull();
});

it.each(['block', 'unblock'] as const)(
  '%s still discloses noncritical event failures',
  async (action) => {
    if (action === 'unblock') blocked({});
    db.exec(
      "CREATE TRIGGER refuse_event BEFORE INSERT ON session_events BEGIN SELECT RAISE(ABORT,'event denied'); END"
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const result = action === 'block' ? await block() : await unblock();
      expect(result.success).toBe(true);
      expect(result.warnings?.join(' ')).toContain('event');
      expect(row().status).toBe(action === 'block' ? 'Blocked' : 'In Progress');
    } finally {
      warn.mockRestore();
    }
  }
);

it('rechecks eligibility after a competing process commits under the write lock', async () => {
  const at = new Date().toISOString();
  blocked({ blockedSince: at, blockedFrom: { status: 'Queued', blockedSince: at } });
  const child = spawn(
    process.execPath,
    [
      '-e',
      String.raw`
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
    db.prepare('UPDATE missions SET started_at=? WHERE id=?').run(new Date().toISOString(),'queued-block');
    process.stdout.write('locked\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, 150);
  `,
      project.dbPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const done = new Promise<number | null>((resolve) => child.once('close', resolve));
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve());
      child.once('error', reject);
      child.once('close', (code) => reject(new Error(`Lock child exited ${code}: ${stderr}`)));
    });
    expect((await unblock()).data?.currentStatus).toBe('In Progress');
    expect(await done).toBe(0);
    expect(row().started_at).not.toBeNull();
  } finally {
    clearTimeout(timer);
    child.kill();
    await done;
  }
});
