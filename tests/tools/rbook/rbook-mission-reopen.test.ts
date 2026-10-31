// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reopen preserves completion history and only resumes work in a positively open sprint.
// ABOUTME: Real SQLite failures must roll back both mission changes and their shared audit log.
import Database from 'better-sqlite3';
import {
  rbookMissionReopen,
  formatMissionReopenForLLM,
  rbookMissionReopenSchema,
} from '../../../src/tools/rbook/rbook-mission-reopen';
import * as migrations from '../../../src/tools/rbook/schema-migrations';
import { VALID_STATE_TRANSITIONS } from '../../../src/tools/rbook/errors';
import {
  dbOf,
  project,
  replicaFixture,
  share,
  useMachine,
  type ReplicaFixture,
} from '../../helpers/replica-fixture';

let fixture: ReplicaFixture;
let root: string;
let completedAt: string;
let checkpoint: string | undefined;
function sql(statement: string, ...args: unknown[]): unknown[] {
  const db = new Database(dbOf(root));
  try {
    const prepared = db.prepare(statement);
    return prepared.reader ? prepared.all(...args) : [prepared.run(...args)];
  } finally {
    db.close();
  }
}
function mission() {
  return sql("SELECT * FROM missions WHERE id='m1'")[0] as Record<string, unknown>;
}
function events() {
  return sql("SELECT * FROM session_events WHERE action='reopen'");
}
function reopen(reason = 'The verification exposed another case') {
  return rbookMissionReopen({ missionId: 'm1', reason, projectRoot: root });
}
beforeEach(() => {
  fixture = replicaFixture('mission-reopen-');
  useMachine(fixture.tmp, 'solo');
  root = project(fixture.tmp, 'solo');
  checkpoint = process.env.RBOOK_CHECKPOINT_SYNC;
  delete process.env.RBOOK_CHECKPOINT_SYNC;
  completedAt = new Date(Date.now() - 60000).toISOString();
  sql("INSERT INTO sprints(id,title,status) VALUES('s1','One','Active')");
  sql(
    "INSERT INTO missions(id,name,status,sprint_id,completed_at,notes,domain_fields) VALUES('m1','One','Completed','s1',?,'Earlier completion',?)",
    completedAt,
    JSON.stringify({ keep: 'evidence' })
  );
});
afterEach(() => {
  if (checkpoint === undefined) delete process.env.RBOOK_CHECKPOINT_SYNC;
  else process.env.RBOOK_CHECKPOINT_SYNC = checkpoint;
  fixture.restore();
});

test.each(['Active', 'active', 'In Progress', 'Current'])(
  'reopens in %s and retains the old completion with explicit project and ENV unset',
  async (status) => {
    sql("UPDATE sprints SET status=? WHERE id='s1'", status);
    const result = await reopen();
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      previousStatus: 'Completed',
      currentStatus: 'In Progress',
      completedAt,
    });
    const row = mission();
    expect(row.status).toBe('In Progress');
    expect(row.completed_at).toBeNull();
    expect(row.notes).toBe('Earlier completion | [Reopened] The verification exposed another case');
    expect(JSON.parse(row.domain_fields as string)).toEqual({
      keep: 'evidence',
      reopened: [{ at: result.data?.reopenedAt, reason: result.data?.reason, completedAt }],
    });
    expect(events()).toHaveLength(1);
    expect(formatMissionReopenForLLM(result)).toContain('Completed → In Progress');
    expect(VALID_STATE_TRANSITIONS.Completed).toEqual([]);
    const before = mission();
    expect((await reopen()).success).toBe(false);
    expect(mission()).toEqual(before);
    expect(events()).toHaveLength(1);
  }
);

test.each(['complete', 'COMPLETE', 'completed'])(
  'historical %s mission alias can reopen',
  async (status) => {
    sql("UPDATE missions SET status=? WHERE id='m1'", status);
    expect((await reopen()).success).toBe(true);
  }
);

test.each(['Queued', 'In Progress', 'Dropped', 'Deferred', 'unknown'])(
  'refuses %s mission status without modifying history',
  async (status) => {
    sql("UPDATE missions SET status=? WHERE id='m1'", status);
    const before = mission();
    expect((await reopen()).success).toBe(false);
    expect(mission()).toEqual(before);
    expect(events()).toEqual([]);
  }
);

test.each(['Completed', 'completed', 'Archived', 'Failed', 'Dropped', 'Reverted'])(
  'closed sprint %s requires a successor linked with depends',
  async (status) => {
    sql("UPDATE sprints SET status=? WHERE id='s1'", status);
    const before = mission();
    const result = await reopen();
    expect(result.success).toBe(false);
    expect(result.error?.suggestion).toMatch(/successor.*open sprint.*depends/i);
    expect(mission()).toEqual(before);
    expect(events()).toEqual([]);
  }
);

test('Planned requires activation and discloses demotion of another open sprint', async () => {
  sql("UPDATE sprints SET status='Planned' WHERE id='s1'");
  const result = await reopen();
  expect(result.success).toBe(false);
  expect(result.error?.suggestion).toMatch(/activat/i);
  expect(result.error?.suggestion).toMatch(/demot.*other open sprint/i);
  expect(mission().status).toBe('Completed');
});

test.each([null, 'unexpected'])(
  'unknown sprint status %s requires repair, never activates it implicitly',
  async (status) => {
    sql("UPDATE sprints SET status=? WHERE id='s1'", status);
    const result = await reopen();
    expect(result.success).toBe(false);
    expect(result.error?.suggestion).toMatch(/repair/i);
    expect(mission().status).toBe('Completed');
  }
);

test.each([null, 'missing'])(
  'missing sprint association %s is not an open sprint',
  async (sprint) => {
    const db = new Database(dbOf(root));
    db.pragma('foreign_keys=OFF');
    db.prepare("UPDATE missions SET sprint_id=? WHERE id='m1'").run(sprint);
    db.close();
    const result = await reopen();
    expect(result.success).toBe(false);
    expect(result.error?.suggestion).toMatch(/repair/i);
  }
);

test('NULL old completion and lost metadata still preserve the appended shared audit', async () => {
  sql("UPDATE missions SET completed_at=NULL,domain_fields=NULL WHERE id='m1'");
  expect((await reopen()).success).toBe(true);
  expect(JSON.parse(mission().domain_fields as string).reopened[0].completedAt).toBeNull();
  expect(mission().notes).toContain('Earlier completion | [Reopened]');
});

test('retains earlier reopen entries and unrelated fields', async () => {
  const prior = {
    at: new Date(Date.now() - 120000).toISOString(),
    reason: 'Earlier',
    completedAt: null,
  };
  sql(
    "UPDATE missions SET domain_fields=? WHERE id='m1'",
    JSON.stringify({ reopened: [prior], keep: 'x' })
  );
  expect((await reopen()).success).toBe(true);
  const metadata = JSON.parse(mission().domain_fields as string);
  expect(metadata.keep).toBe('x');
  expect(metadata.reopened).toHaveLength(2);
  expect(metadata.reopened[0]).toEqual(prior);
});

test.each(['', '   ', '<parameter name="other">damaged'])(
  'empty sanitized reason %s refuses before writing',
  async (reason) => {
    const before = mission();
    expect((await reopen(reason)).success).toBe(false);
    expect(mission()).toEqual(before);
    expect(events()).toEqual([]);
  }
);

// s106-m02: a blank reason is missing, but one the sanitizer emptied was supplied; saying "missing"
// would send the same text back. The refusal says what happened, and plain text then reopens.
test.each([
  ['a blank reason', '   ', 'MISSING_PARAMETER'],
  ['a reason the sanitizer emptied', '<parameter name="other">damaged', 'INVALID_PARAMETER'],
])('refuses %s with its own code and remedy', async (_case, reason, code) => {
  const refused = await reopen(reason);
  expect(refused.error).toMatchObject({ code, field: 'reason' });
  if (code === 'INVALID_PARAMETER') {
    expect(refused.error?.message).toMatch(/content sanitizer/);
    expect(refused.error?.suggestion).toMatch(/plain text/);
  }
  expect((await reopen('The verification exposed another case')).success).toBe(true);
});

test('sanitizes a reason and reports the stripped input', async () => {
  const result = await reopen('Observed regression <parameter name="other">damaged');
  expect(result.success).toBe(true);
  expect(result.data?.reason).toBe('Observed regression');
  expect(result.sanitizedFields).toEqual(
    expect.arrayContaining([expect.objectContaining({ field: 'reason' })])
  );
  expect(mission().notes).not.toContain('parameter');
  expect(rbookMissionReopenSchema.safeParse({ missionId: 'm1' }).success).toBe(false);
});

test.each(['ABORT', 'IGNORE'])(
  'mandatory audit %s rolls back mission and shared change log',
  async (mode) => {
    await share(root, 0);
    const before = mission();
    const changes = sql('SELECT * FROM record_changes');
    sql(
      `CREATE TRIGGER refuse_reopen BEFORE INSERT ON session_events WHEN NEW.action='reopen' BEGIN SELECT RAISE(${mode}${mode === 'ABORT' ? ", 'audit unavailable'" : ''}); END`
    );
    const result = await reopen();
    expect(result.success).toBe(false);
    expect(result.error?.suggestion).toBeTruthy();
    expect(mission()).toEqual(before);
    expect(sql('SELECT * FROM record_changes')).toEqual(changes);
    expect(events()).toEqual([]);
  }
);

test.each(['ignore', 'revert', 'erase-audit'])(
  'detects a %s trigger instead of claiming success',
  async (mode) => {
    const before = mission();
    if (mode === 'ignore')
      sql('CREATE TRIGGER sabotage BEFORE UPDATE ON missions BEGIN SELECT RAISE(IGNORE); END');
    if (mode === 'revert')
      sql(
        "CREATE TRIGGER sabotage AFTER UPDATE ON missions BEGIN UPDATE missions SET status='Completed' WHERE id=NEW.id; END"
      );
    if (mode === 'erase-audit')
      sql(
        'CREATE TRIGGER sabotage AFTER INSERT ON session_events BEGIN DELETE FROM session_events WHERE id=NEW.id; END'
      );
    const result = await reopen();
    expect(result.success).toBe(false);
    expect(mission()).toEqual(before);
    expect(events()).toEqual([]);
  }
);

test('missing audit table refuses, then succeeds after it is created in the same process', async () => {
  const ddl = (
    sql("SELECT sql FROM sqlite_master WHERE name='session_events'")[0] as { sql: string }
  ).sql;
  sql('DROP TABLE session_events');
  expect((await reopen()).success).toBe(false);
  expect(mission().status).toBe('Completed');
  sql(ddl);
  expect((await reopen()).success).toBe(true);
  expect(events()).toHaveLength(1);
});

test('legacy mission timestamps migrate under the transaction before lookup', async () => {
  sql('ALTER TABLE missions DROP COLUMN updated_at');
  sql('ALTER TABLE missions DROP COLUMN started_at');
  expect((await reopen()).success).toBe(true);
  expect(mission().updated_at).toEqual(expect.any(String));
});

test('foreign mission schema fails loudly without claiming an inactive feature', async () => {
  sql('ALTER TABLE missions RENAME COLUMN completed_at TO foreign_completion');
  const result = await reopen();
  expect(result.success).toBe(false);
  expect(result.error?.suggestion).toBeTruthy();
  expect(mission().status).toBe('Completed');
});

test.each(['not json', 'null', '[]', '{"reopened":"broken"}'])(
  'invalid history %s refuses instead of erasing it',
  async (metadata) => {
    sql("UPDATE missions SET domain_fields=? WHERE id='m1'", metadata);
    const before = mission();
    expect((await reopen()).success).toBe(false);
    expect(mission()).toEqual(before);
    expect(events()).toEqual([]);
  }
);

test('missing mission and empty id produce actionable refusals', async () => {
  for (const missionId of ['', 'missing']) {
    const result = await rbookMissionReopen({ missionId, reason: 'A reason', projectRoot: root });
    expect(result.success).toBe(false);
    expect(result.error?.suggestion).toBeTruthy();
    expect(formatMissionReopenForLLM(result)).toContain('Suggestion:');
  }
});

test.each(['success', 'refusal', 'audit failure'] as const)(
  'preserves migration warnings in the %s answer and rendered text',
  async (outcome) => {
    if (outcome === 'refusal') sql("UPDATE sprints SET status='Completed' WHERE id='s1'");
    if (outcome === 'audit failure') {
      sql(
        "CREATE TRIGGER reject_reopen BEFORE INSERT ON session_events WHEN NEW.action='reopen' BEGIN SELECT RAISE(ABORT, 'audit refused'); END"
      );
    }
    const before = mission();
    const ensureTimestamps = migrations.ensureMissionTimestamps;
    const warning = 'Timestamp migration needs operator attention';
    const spy = jest.spyOn(migrations, 'ensureMissionTimestamps').mockImplementation((client) => {
      const result = ensureTimestamps(client);
      return { ...result, warnings: [...(result.warnings ?? []), warning] };
    });
    try {
      const result = await reopen();
      expect(result.success).toBe(outcome === 'success');
      expect(result.warnings).toContain(warning);
      expect(formatMissionReopenForLLM(result)).toContain(warning);
      if (outcome === 'success') {
        expect(mission().status).toBe('In Progress');
        expect(events()).toHaveLength(1);
      } else {
        expect(mission()).toEqual(before);
        expect(events()).toEqual([]);
      }
    } finally {
      spy.mockRestore();
    }
  }
);
